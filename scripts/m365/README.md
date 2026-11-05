# Registering a bank's Microsoft 365 tenant for deal discovery

The admin runbook for the read-only Graph reader (ADR-005 in
`docs/handoff/deal-discovery-demo/adr/`). It is written for any bank tenant.
The first one is the Conductia-owned test tenant with synthetic mail, and
switching to a bank's tenant repeats the same steps and writes one new
registration row. No code changes.

## What the reader can and cannot do

| | The discovery reader | The existing send flow |
|---|---|---|
| Identity | One app per bank tenant, single-tenant, created in that tenant | Delegated, multi-tenant (`common`) |
| Credential | Certificate. The private key never leaves Azure Key Vault (the worker asks Key Vault to sign) | Client secret |
| Mail | `Mail.Read`, only for the members of one mail-enabled security group (RBAC for Applications) | `Mail.Send` as the signed-in user |
| SharePoint | `Sites.Selected`, then `read` on each listed site | none |
| Directory | The scope group's membership, to compare it with Conductia's allowlist on every pass (#275; see "Permissions for the group read") | none |
| Who uses it | The classification worker only. No web route ever holds a reader token | The web app |

The Entra `Mail.Read` application permission is never granted: it would
reach every mailbox in the tenant. `register-reader.ps1` refuses to continue if
it finds that permission.

## What you need before you start

- **The bank tenant:** its Entra tenant id, and an administrator who holds
  Application Administrator, Privileged Role Administrator (for the admin
  consent), Exchange Administrator, and SharePoint admin rights (or
  `Sites.FullControl.All` consent) to grant per-site access.
- **A mail-enabled security group** holding exactly the in-scope mailboxes,
  shared mailboxes (team inboxes) included, as direct members. See "The scope
  group mirrors Conductia".
- **The SharePoint sites:** their Graph site ids (`host,siteGuid,webGuid`).
- **Conductia:** the Conductia tenant uuid, and the Conductia user who owns
  each mailbox. Ownership is explicit and never inferred from an address. The
  mailbox guard (#262) refuses a mailbox source with no owner, so
  `write-registration.ts` refuses one too, unless you pass `--allow-ownerless`
  (step 3). A SharePoint site has no per-person owner, so `null` is normal for
  a site.
- **Azure:** a Key Vault, and the worker's managed identity (Azure Container
  Apps).
- PowerShell 7 with `Microsoft.Graph` and `ExchangeOnlineManagement` 3.x.

## 1. Create the certificate in Key Vault (non-exportable)

```bash
az keyvault certificate get-default-policy \
  | jq '.keyProperties.exportable = false | .keyProperties.keyType = "RSA" | .keyProperties.keySize = 2048
        | .x509CertificateProperties.subject = "CN=conductia-discovery-reader"
        | .x509CertificateProperties.validityInMonths = 12' > reader-policy.json
az keyvault certificate create --vault-name <vault> --name conductia-reader --policy @reader-policy.json
az keyvault certificate download --vault-name <vault> --name conductia-reader --file conductia-reader.cer --encoding DER
az keyvault certificate show --vault-name <vault> --name conductia-reader --query kid -o tsv   # the key id, with its version
```

Give the worker's managed identity the **Key Vault Crypto User** role on the
vault (it signs, and it cannot export). `conductia-reader.cer` is the public
half only.

A role assignment takes effect only when the vault uses the Azure RBAC
permission model. Check first:

```bash
az keyvault show --name <vault> --query properties.enableRbacAuthorization
```

- `true`: assign the role.

  ```bash
  az role assignment create --role "Key Vault Crypto User" \
    --assignee-object-id <identity principal id> --assignee-principal-type ServicePrincipal \
    --scope "$(az keyvault show --name <vault> --query id -o tsv)"
  ```

- `false` or `null` (vault access policies): the role is ignored, so grant an
  access policy instead.

  ```bash
  az keyvault set-policy --name <vault> --object-id <identity principal id> --key-permissions get sign
  ```

The principal id is the identity's object id, not its client id:
`az identity show --ids <identity resource id> --query principalId -o tsv`.

**Fallback while Azure is procured (test tenant only).** Generate a key pair
with `openssl`, keep the PEM in the worker host's secret store as
`GRAPH_READER_CERT_PEM`, and reference it as `env:GRAPH_READER_CERT_PEM`.
Never do this for a bank's tenant. `write-registration.ts` requires
`--allow-env-pem` for it.

## 2. Register the app in the bank tenant

```powershell
./scripts/m365/register-reader.ps1 -TenantId <bank tenant id> `
  -CertificatePath ./conductia-reader.cer `
  -ScopeGroupEmail <scope group address> `
  -SiteIds '<host,siteGuid,webGuid>' `
  -OutputPath <outside the repo>/registration.json -WhatIf
```

Read the `-WhatIf` output, then run the command again without `-WhatIf`.

If the interactive sign-in fails (the Windows broker closes before MFA, refuses a
passkey, or device code is blocked by policy), connect first with
`Connect-MgGraph -AccessToken` for this tenant and pass `-DisableWam` for
Exchange: the script reuses a session for this tenant and disconnects only what
it opened. A tenant never customized stops before any Exchange change with
"needs Enable-OrganizationCustomization": run it, wait about an hour, re-run.
The script also reads the Exchange role assignment back and writes no config
unless it is scoped.

The script:

- creates the app with the certificate;
- consents `Sites.Selected`;
- consents the group-membership read: `-GroupReadRole`, default
  `GroupMember.ReadBasic.All`, and `User.ReadBasic.All`, which is required
  (see "Permissions for the group read");
- registers the service principal in Exchange Online;
- scopes `Application Mail.Read` to the group;
- lists the group's mailbox members (`RecipientType -eq 'UserMailbox'`, which
  keeps user, shared, room and equipment mailboxes) with a count per type;
- grants `read` on each site;
- writes a starting config that names the group by its Entra object id
  (`scopeGroupId`, the group's `ExternalDirectoryObjectId`).

Each permission is consented only when the service principal lacks it, so a
re-run against an existing app (Tidewell's included) proposes only the missing
grants. Run it with `-WhatIf` first and check that the printed member count
includes the shared mailbox.

RBAC for Applications can take up to two hours to propagate.
`Test-ServicePrincipalAuthorization` should report `InScope: True` for a
member mailbox before you continue.

## 3. Record the registration in Conductia

Complete every `FILL IN` value in the config:

- the Conductia tenant uuid;
- `firmCompany`, the bank's company in Conductia, by id or by name. It must be
  the tenant's own company of type `bank`; the script refuses anything else;
- `mailboxDomains`, the mail domains the registration reads (for example
  `["bank.example"]`). The script writes them lower-cased;
- the owner of each mailbox (a Conductia user's email) and `null` for each site;
- `certSecretRef` as `keyvault:<key id>`, using the versioned kid from step 1;
- `scopeGroupId`, if the script could not read it: the scope group's Entra
  object id (`(Get-DistributionGroup <scope group address>).ExternalDirectoryObjectId`).
  The script refuses anything that is not a GUID, such as the group's address.

Then set `"status": "active"`. Keep the file outside the repo.

```bash
node --env-file=<env> --import tsx scripts/m365/write-registration.ts --config <path>/registration.json --dry-run
node --env-file=<env> --import tsx scripts/m365/write-registration.ts --config <path>/registration.json
```

A mailbox with `"ownerEmail": null` is refused, because the guard never reads
a mailbox source with no owner. `--allow-ownerless` writes it anyway and prints
a warning: nothing is read from that mailbox until its member opts in on their
profile, and the opt-in adopts the source. Use it only when the member is not
yet a Conductia user. A re-run that lists a mailbox with no owner keeps the
owner the source already has, so a certificate rotation never takes an adopted
mailbox back from its member. The update leaves the owner column out, so the
database keeps the value it holds at that moment: a member who opts in while the
script runs keeps the mailbox too.
The same holds if an opt-in archives the source while the script runs: the script
never writes the archived row (it is renamed `<address>~xyz` and paused), and applies
the listing to the live source of the address, or creates it.

This writes `graph_reader_registrations` and `content_sources` and nothing
else. It never contacts Microsoft. The list is authoritative:

- a source missing from it is paused, never deleted;
- re-registering keeps every checkpoint, so a backfill does not restart.

**Why the firm and the domains are required (#262).** A mailbox is read only
when its address is on one of `mailboxDomains` and its owner holds a seat in
`firmCompany` from an accepted invitation and has opted in. A registration that
names no firm or no domain reads nothing, and the control room shows no firm
admin or CCO for it.

**A tenant registered before #262** has neither column set. Either run
`write-registration.ts` again with the two new fields, or set them once in SQL:

```sql
update graph_reader_registrations
   set firm_company_id = '<the bank company id>',
       mailbox_domains = array['bank.example']
 where tenant_id = '<Conductia tenant uuid>';
```

`firm_company_id` must be a company of type `bank` in the same tenant. Nothing
backfills it, because the bank's firm is the operator's statement and is never
inferred.

**The scope group (#275).** `write-registration.ts` writes `scopeGroupId` to
`graph_reader_registrations.scope_group_id`. With no group recorded, the
Exchange group mirror fails closed: health shows `Group unreadable` and no
Microsoft mailbox is read. A config without `scopeGroupId` records none, so
every re-run (a certificate rotation included) must keep naming it. A tenant
registered before #275 has none. Run `write-registration.ts` again with the
field, or set it once in SQL:

```sql
update graph_reader_registrations
   set scope_group_id = '<the scope group Entra object id>'
 where tenant_id = '<Conductia tenant uuid>';
```

## 4. Prove the scope before reading anything

```bash
node --env-file=<env> --import tsx scripts/m365/probe-out-of-scope.ts --tenant <Conductia tenant uuid> \
  --out-of-scope <a mailbox NOT in the group> --in-scope <a member mailbox> \
  --site-out-of-scope <a site that was not granted>
```

The probe must print `PASS` for every line:

- 403 for the mailbox outside the scope;
- 200 for the member;
- 403 for the site that was not granted.

It reads message ids only and prints statuses and error codes only. If any
line fails, do not start the worker.

Then prove the group read with `npm run m365:probe-group`, preflight first
("Prove the group read" below). Do not start the worker until it prints
`Q1: yes`.

## 5. Run the worker

One image, two entrypoints (`worker/Dockerfile`). `classify` is this phase;
`extract` lands with the milestone extractor.

| Variable | Value |
|---|---|
| `GRAPH_READER_PROVIDER` | `graph` |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` | the Conductia project (service role; the worker never serves a user) |
| `DISCOVERY_QUEUE_DATABASE_URL` | the Supabase **session pooler** connection string (IPv4), logged in as `discovery_queue` (below). Not the transaction pooler, and never the `postgres` owner |
| `AZURE_CLIENT_ID` | the managed identity's client id, if it is user-assigned |
| `NEXT_PUBLIC_APP_ENV` | `prod` in production (refuses the fixture reader) |

The job queue lives in the `pgboss` schema, created by migration
`20260925140000_pgboss_schema.sql`. The worker never migrates it.

**The queue's database role.** The queue connection logs in as
`discovery_queue` (migration `20260925160000_discovery_queue_role.sql`), never
as `postgres`. The role has DML on the `pgboss` schema and nothing else: no
grant in `public`, no DDL, and it cannot alter or disable a trigger, so it
cannot touch `audit_log`. The migration creates it without a password. Set one
from the worker host's secret store, as the project owner:

```sql
alter role discovery_queue with password '<generated, 32+ characters>';
```

Then build the session pooler URL with the role as the user (Supavisor
appends the project ref):

```text
DISCOVERY_QUEUE_DATABASE_URL=postgresql://discovery_queue.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

In production (`NEXT_PUBLIC_APP_ENV=prod`) the worker refuses to start without
`DISCOVERY_QUEUE_DATABASE_URL`; it never falls back to `DATABASE_URL`. To
rotate, set a new password and restart the worker.

**Outbound traffic.** The worker's container may reach these hosts on 443 and
nothing else:

| Host | Why |
|---|---|
| `graph.microsoft.com` | the reader |
| `login.microsoftonline.com` | Entra sign-in (the certificate assertion) |
| `<vault>.vault.azure.net` | Key Vault signs the assertion |
| `<project-ref>.supabase.co` | the service client's writes |
| `aws-0-<region>.pooler.supabase.com` (5432) | the job queue |

The two Supabase hosts are the worker's own database; without them it can
read nothing into Conductia. The managed identity's token endpoint is local to
the container. On Azure Container Apps, run the worker in a workload-profiles
environment on your own VNet, route `0.0.0.0/0` through Azure Firewall with a
user-defined route, and allow only these FQDNs in an application rule.

This is the network boundary for the attachment extractor as well. The
extractor child runs under Node's `--permission`, which blocks file writes,
child processes and workers, but **does not restrict the network** in Node 22.

Turn on `discovery_worker_enabled` (`feature_flags`) to start ingestion:

- every five minutes, the worker queues one sync per active source;
- each sync reads Graph pages from the source's checkpoint and saves the
  checkpoint after every page;
- a killed or redeployed worker resumes where it stopped, and reads nothing
  twice;
- throttling is waited out (`Retry-After`), then retried by the queue with
  backoff.

Turning the flag off pauses ingestion within one page, without a deploy.

## 6. Watch it

A firm `admin` (or the control room, `cco`) opens `/discovery` and sees
ingestion health:

- per source: sync state, last sync, items read, routed and skipped, and the
  last error;
- per registration, after the first pass: the scope group's state (`Group in
  sync`, `Group drift` with the counts missing from and extra in the group, or
  `Group unreadable`), and per mailbox why the group holds it back (`Waiting
  to join the group`, `Group unreadable`);
- totals.

It never shows a subject, a participant, a party or a codename.

## The scope group mirrors Conductia

The mail-enabled security group that scopes the reader's `Application
Mail.Read` is the bank's half of a two-part check (#275). Conductia's half is
the allowlist: a seated user's accepted invitation on a registered mail domain,
plus that user's own opt-in (#262). On every pass the worker lists the group's
direct members through Graph, compares them with the allowlist, and reads a
mailbox only when both agree. The difference is recorded as drift, shown in
ingestion health and notified once per change to the firm's admin and CCO
(counts only).

**Keep the group in step with Conductia's invitations and opt-ins.**

- **Shared mailboxes (team inboxes) are members like any other**, and so are
  room and equipment mailboxes. A team inbox is read only when its address is
  also on the allowlist, which today means an accepted invitation to that
  address, a seat and an opt-in. Without one it shows only as extra in the
  group.
- **When health shows `Group drift`,** add each mailbox missing from the group
  as a direct member, and remove each member listed as extra (or invite its
  owner, if it should be read). An extra member is never read.
- **Check an extra member before removing it.** An address that binds as
  ambiguous (see "Binding" below) is listed as missing, and the members it
  matched are bound to no address, so they are listed as extra too. Before
  removing an extra member, check its mail and UPN against the binding table:
  if one of them is a missing address, fix the ambiguity instead, or the
  mailbox that invitation should reach leaves the group.
- **Which addresses.** Health shows counts only. The addresses are in
  `mailbox_allowlist_drift` (service role); a firm admin or CCO can also read
  them through `discovery_allowlist_health()` from their own session. Keep them
  out of tickets and chat.

  ```sql
  select provider, status, missing_in_group, extra_in_group, checked_at
    from mailbox_allowlist_drift
   where tenant_id = '<Conductia tenant uuid>';
  ```

- **Direct members only.** Exchange admits only direct members to the scope,
  and the mirror skips nested groups, contacts and devices. A nested group's
  members are never read.
- **Propagation.** A group change takes 30 minutes to 2 hours to reach the
  Exchange scope, while Conductia sees it on the next pass. A mailbox just added
  can therefore show `Group unreadable` on its source until Exchange admits it
  (`Test-ServicePrincipalAuthorization` reports `InScope: True`). A mailbox just
  removed stops being read on the next pass, even while Exchange still admits
  it.
- **Aliases do not count.** Binding compares the invitation address with each
  member's primary address and UPN only. An invitation sent to a secondary
  (proxy) address shows as missing from the group and is never read. Invite the
  primary address.

### Binding: one address, exactly one mailbox

An allowlisted address is read only when exactly one group member has it as
its mail (the primary SMTP address) and no other member has it as its UPN.
Otherwise it is not read:

| Match | Result | Health |
|---|---|---|
| One member by mail, and no other member by UPN | Bound: read | |
| No member by mail or UPN | Missing from the group | `Waiting to join the group` |
| Only a member's UPN, another member's UPN, or two members' mail | Ambiguous: never read, counted with the missing | `Waiting to join the group` (no separate label yet) |

A shared mailbox binds by its mail even when its UPN differs, for example a
UPN on the tenant's `onmicrosoft.com` domain.

**When a member shows as missing,** check, in order:

1. The invitation address is the mailbox's primary SMTP address, not an alias.
2. The mailbox is a direct member of the group, not a member of a nested group.
3. No other member has that address as its UPN, and no two members share it as
   their primary address. List the members' addresses with:

   ```powershell
   Get-DistributionGroupMember -Identity <scope group address> -ResultSize Unlimited |
     ? RecipientType -eq 'UserMailbox' | % { Get-Mailbox -Identity $_.Identity } |
     Select-Object PrimarySmtpAddress, UserPrincipalName, RecipientTypeDetails
   ```

**The check before each read.** Before the first page of a live mailbox read,
the reader asks for the bound member's inbox twice, once by its object id and
once by its UPN, and reads only when both name the same folder. It then reads
by the bound UPN: the invitation address never reaches Graph as the mailbox
key. The guard decides first: the reader asks its read-only verdict and makes
the two inbox requests only when it allows, so no Graph request comes before a
guard decision. A failed check refuses the source (`Group unreadable`), and the
guard records and audits the refusal (`discovery.mailbox_refused`,
`mirror_unavailable`) once, not again on every retry while it lasts. A
throttled or failing inbox request is a sync error, not a refusal. SharePoint sites have no group and no binding check:
they are read live under the site guard (R23) and their own `Sites.Selected`
grants.

**`Checkpoint unreadable` after #275.** A mailbox checkpoint stores Graph's
own links, and a resume follows them. A checkpoint whose links name any key
other than the bound UPN or object id is refused, and the source's Last error
reads `Checkpoint unreadable`. A mailbox whose address is its UPN keeps its
checkpoint; one read under another key before #275 (for example a shared
mailbox whose UPN differs from its mail) does not. Live Microsoft passes were
refused before #275 (D68), so few such checkpoints exist. The admin's Restart
reading control is offered only for a halted source today, so it does not
appear for this error. Until it does, an operator clears the stored cursor on
the test tenant, as the restart does, and the next pass reads the mailbox again
from the start (dedupe drops what is already stored). For a bank's tenant, ask
engineering first.

```sql
update content_sources
   set delta_checkpoint = null, last_error = null, last_error_at = null,
       backfill_started_at = null, backfill_completed_at = null, history_expiry_streak = 0
 where tenant_id = '<Conductia tenant uuid>' and provider = 'microsoft'
   and kind = 'mailbox' and lower(address) = lower('<the mailbox address>');
```

**What fails closed.** Each of these reads no Microsoft mailbox, and health
shows `Group unreadable`:

- no `scope_group_id` on the registration, or no active registration;
- the group read refused (the permission is not granted, a 403);
- a member returned without a UPN;
- a group in which no member has mail, which means the role returns ids only
  (grant `User.ReadBasic.All`, below);
- a timeout or any other failure of the group read.

### Permissions for the group read

The group read uses the reader app's own certificate and token. No second app
is involved. `register-reader.ps1` grants, least privileged first (design R1):

| Permission (application) | When | What it reads |
|---|---|---|
| `GroupMember.ReadBasic.All` | The default (`-GroupReadRole`) | Every group's memberships, basic properties only |
| `GroupMember.Read.All` | Instead, if `ReadBasic` cannot be granted in the tenant, or the listing still returns 403 under it after the 10-minute wait and one rerun | Every group's memberships and basic properties |
| `User.ReadBasic.All` | Always. On the 2026-10-19 rehearsal the group read alone returned members with no UPN, and the guard refused every mailbox | Every user's basic profile (tenant-wide; read-only; it reaches no mail) |

**Confirmed on the 2026-10-19 rehearsal** (Conductias test tenant):
`GroupMember.ReadBasic.All` lists the members, and `User.ReadBasic.All` is needed
for their UPNs. `GroupMember.Read.All` was not needed there.

**Why not Directory Readers.** It is an Entra role over the whole directory,
not only group memberships, and directory read access cannot be scoped to an
administrative unit. `Group.Read.All` and `Directory.Read.All` are broader too.
None of the options can be limited to one group, and none reads mail. Google
keeps its group read on a separate directory identity; a bank's security review
may ask for the same here, which is a follow-up.

## Prove the group read (owner checklist)

Run before any live Microsoft pass. On Tidewell this is the Oct 19 check; the
output is pending. Steps 2 and 5 grant app roles and step 8 writes to
Conductia; every other step only reads. Paste back only what each step
prints. The PowerShell variables match `register-reader.ps1` (`$graphSp`,
`$sp`, `$group`).

0. **Preflight, before anything is signed.**
   - (a) The shell profile may export hosted Supabase variables, and
     `--env-file` never overrides a variable that is already set. Unset them
     for the run, so `.env.local` (pointing at the project that holds the
     registration) is what the probe reads:

     ```bash
     env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
       npm run m365:probe-group -- --tenant <Conductia tenant uuid> --confirm-ms-tenant <Entra tenant id> --preflight-only
     ```

     Use the same `env -u …` prefix in step 4.
   - (b) Confirm the host it prints (`registration read from <host>`) is the
     project that holds the registration.
   - (c) It prints `cert scheme env` and `Preflight passed`, or stops with
     `STOP cert scheme keyvault` (exit 1). On a stop, go no further and report
     it: a `keyvault:` certificate signs only where the worker runs, so the
     probe must run there. A preflight never signs a token or calls Graph.
1. **Is `GroupMember.ReadBasic.All` grantable?** In a Graph PowerShell session
   with `AppRoleAssignment.ReadWrite.All`:

   ```powershell
   $graphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
   $sp      = Get-MgServicePrincipal -Filter "appId eq '<reader client id>'"
   @($graphSp.AppRoles | ? { $_.Value -eq 'GroupMember.ReadBasic.All' -and $_.AllowedMemberTypes -contains 'Application' }).Count   # 1 = grantable
   ```

2. **Grant the group role.** `GroupMember.ReadBasic.All` if step 1 printed 1,
   else `GroupMember.Read.All`:

   ```powershell
   $role = '<role from step 1>'
   $r = $graphSp.AppRoles | ? { $_.Value -eq $role -and $_.AllowedMemberTypes -contains 'Application' }
   New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $r.Id
   ```

   Re-running `register-reader.ps1 -GroupReadRole <role>` does the same, and
   grants only what is missing. A new grant can take several minutes to reach
   Graph: wait about 10 minutes before step 4.
3. **Export the Exchange member ids and types**, shared, room and equipment
   mailboxes included, to a path outside any repo. The group must hold at
   least one shared mailbox (the team inbox shape): the probe fails a run
   whose export has none.

   ```powershell
   $group = Get-DistributionGroup <scope group address>; $group.ExternalDirectoryObjectId   # the --group value
   Get-DistributionGroupMember -Identity $group.Identity -ResultSize Unlimited | ? RecipientType -eq 'UserMailbox' |
     % { "$($_.ExternalDirectoryObjectId),$($_.RecipientTypeDetails)" } | Set-Content <path outside repo>/exchange-ids.txt
   ```

   The file holds one `<ExternalDirectoryObjectId>,<RecipientTypeDetails>`
   line per mailbox, for example
   `0f8fad5b-d9cb-469f-a165-70867728950e,SharedMailbox`. Blank lines are
   ignored; the probe refuses any other line.
4. **Run the probe.**

   ```bash
   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
     npm run m365:probe-group -- --tenant <Conductia tenant uuid> --confirm-ms-tenant <Entra tenant id> \
     --group <group object id> --exchange-ids <path>/exchange-ids.txt --out-of-scope <a mailbox outside the group> \
     [--alias-in-scope <secondary smtp of a member>] [--alias-out-of-scope <secondary smtp of a non-member>]
   ```

   `--out-of-scope` is required. The probe prints only statuses, Graph error
   codes, counts, yes/no answers, Exchange mailbox types, the Supabase host and
   the certificate scheme, never an address, a name or an id. A failure prints
   a fixed category with its codes (for a refused token, the MSAL code and the
   `AADSTS` code), never the message behind it. Graph, MSAL and `AADSTS` codes
   print only from a fixed list of known codes; any other prints as `other`.
   It refuses production, a
   `--confirm-ms-tenant` that differs from the registration, a `--group` that
   is not a GUID, and a missing, empty or malformed export, all before any
   Graph call. It exits 1 when any answer needs attention.

   - **`Q1: yes`** means the group line shows `status 200` and `only in
     Exchange 0` for every type, `SharedMailbox` included: no mailbox member
     Exchange admits is missing from Graph's listing, compared by object id.
     It is coverage, not an exact match. Members only Graph lists show on the
     `only in Graph N` line, with a `WARN only in Graph N` line when N is
     above 0; they do not change Q1, since the Exchange scope still decides
     what is read.
   - **`Q1: yes` is not enough on its own.** The group mirror reads no mailbox
     when any member has no UPN, or no member has mail, and the probe then
     prints `WARN with UPN N of M users` and exits 1. Go on only when `with
     UPN` equals `users` and `with mail` is above 0 (step 5).
   - **`Q1: not answered (listing status N)`** means Graph refused or failed
     the member listing, so there is no answer yet. After a new grant, wait
     about 10 minutes and rerun once. A 403 that persists under `ReadBasic`
     means: redo step 2 with `GroupMember.Read.All`, wait, and rerun.
   - **`Q1: no`**: stop and report it. The Graph mirror cannot stand in for the
     Exchange group on this tenant.
5. **Only if the probe prints `WARN with UPN N of M users`** (some member has
   no UPN, so `with UPN` is below `users`, or `with mail` is 0), redo step 2
   with `$role = 'User.ReadBasic.All'` (an app registered before 2026-10-21 may
   lack it; a re-run of `register-reader.ps1` grants it), wait about 10 minutes,
   then rerun step 4. Do not go
   on until `with UPN` equals `users`. Record which roles were needed.
6. **Check the remaining probe lines.** The three checks run on members in
   both lists: a shared mailbox whose UPN differs from its mail when there is
   one, which the `checked member` line names by type.

   | Probe line | Expected | If not |
   |---|---|---|
   | `checked member` | `SharedMailbox, UPN differs from mail` when the group holds such a mailbox | `none`: no member in both lists has mail and a UPN; report it |
   | `same mailbox by UPN and id` | yes | Report it: the read key must switch to the object id |
   | `different members differ` | yes | Report it: the check before each read relies on it |
   | `link key form` | `upn` or `id` | `other`: report it; the checkpoint check must accept that form |
   | `out-of-scope by address` | 403 | |
   | `alias of non-member` | 403 or 404 | Stop and report: an alias bypasses the scope |
   | `alias of member` | informational | |
   | `binding hazards` | informational | Non-zero means some addresses bind as ambiguous. A shared mailbox whose UPN differs from its mail counts here, and still binds by mail |
   | `WARN only in Graph N` | absent | Informational: Q1 is unchanged, since the Exchange scope still decides what is read. Check the export was taken from the same group just now, and report the count |

7. **The Exchange role that holds `Get-DistributionGroupMember`** (only for a
   later Exchange-side mirror): `Get-ManagementRole -Cmdlet
   Get-DistributionGroupMember | Select-Object -ExpandProperty Name`.
8. **Before any live Microsoft pass or capture** (these write to Conductia):
   - record `scopeGroupId` with `write-registration.ts` (step 3);
   - store an exclusion-policy version (`scripts/discovery/set-exclusion-policy.ts`).
     A live tenant needs one audited write before any mailbox is read, and
     until #272 the Graph mail reader refuses a policy with any rule, so for
     Microsoft mail it must be the empty policy `[]`.

Documents the reader cannot read into text are ledgered as `skipped` with a
reason:

- `image_only`: images, and PDFs without a text layer. There is no OCR in
  the demo;
- `unsupported_type`;
- `too_large` (over 25 MB);
- `extraction_failed`;
- `extraction_timeout`.

## Revoking

To stop immediately, set the registration's `status` to `disabled`, or pause
a source. To revoke at the bank:

- remove the management role assignment;
- remove the site permissions;
- delete the app in the bank tenant.

To rotate the certificate:

1. Create a new version in Key Vault.
2. Add its `.cer` to the app in the bank tenant.
3. Update `certThumbprint` and `certSecretRef` with `write-registration.ts`,
   keeping `scopeGroupId` in the config (a config without it records no group).
4. Remove the old credential from the app.

The worker builds a new token client as soon as the thumbprint or the
reference changes.

## Record and replay (test tenant only)

The Conductia-owned test tenant (Tidewell Pike Advisors) expires on
**2026-10-24**, and its reader certificate on 2026-10-31. Recording its Graph
traffic once lets the demo and CI run the whole discovery pass offline
afterwards (CDT-277). A cassette holds the scrubbed responses of one full read:
no token, no certificate, no request header, no tenant id, no client id and no
thumbprint.

**Never record a real bank's tenant.** A cassette of a real tenant is bank
content under ADR-0017 (#270): it belongs in that bank's data plane, never on
a laptop.

**Live capture (#318).** The guarded recorder replaces the pause that D68 (C)
put on live recording (D101). `npm run m365:record-graph -- --live` reads
Tidewell only through the mailbox guard (#262) and the provider-group check
(#275), at the strength of the worker, and writes the cassette outside the
repo. The injected-transport path (`--config`, the synthetic cassette, the
tests) is unchanged and cannot reach a live tenant.

**Who, where, when.** The owner runs it, on a laptop, with the current `env:`
PEM, before the PEM moves to Key Vault (Owner checklist step 3), from a clean
checkout of the top of the #318 stack (`[318 5/6]`, `feat/318-5-live-capture`,
or `develop` once it holds the stack), set up with `npm ci` (not `npm install`:
a lockfile change makes the tree unclean, and the recorder refuses it). An agent
never runs `--preflight` or a capture: both sign in to the tenant, and both
write to the target database (below). Two runs, on two dates:

| When | Run | Why |
|---|---|---|
| **2026-10-19 to 2026-10-20**, with #275's group probe | **Rehearsal**: the whole procedure (before, preflight, record, after) into a fresh `--out` that is then deleted | Any surprise in Graph's link shape, a permission or the group read shows with days left to fix it |
| **2026-10-22 to 2026-10-23** (owner, 2026-10-17: capture by Oct 23) | **The capture** kept as the evidence | The tenant expires on 2026-10-24 |

The rehearsal is the real procedure in every step but the last: after the
"After" checks pass, delete its `--out` directory (it is a full cassette of the
tenant, and never the one kept). Note in the [318 6/6] PR that it passed, or
the line it stopped on.

**Inputs the owner provides.** None is committed, and none goes into a PR, an
issue or a chat.

| Input | What it is |
|---|---|
| `--tenant` | The Conductia tenant uuid that holds the Tidewell registration |
| `--ms-tenant-id` | Tidewell's tenant id, read from the Entra admin center. Do not copy it from the Conductia row: the recorder compares the two and refuses a mismatch |
| `--confirm-domains` | Every mail domain of the registration, comma-separated. The set must equal the registration's `mailbox_domains` |
| `--out` | A new directory outside the repo, beside the eval's `ground-truth.json` |
| `--allow-env-pem` | Confirms the registration's `env:` certificate is the test tenant's |
| `--allow-remote-supabase <host>` | Only when the registration lives in a Supabase that is not local: its exact hostname, reached over https |
| The PEM | The environment variable that the registration's `cert_secret_ref` names (`GRAPH_READER_CERT_PEM` for Tidewell). `--preflight` needs it too, because the readiness check reads the provider group with the registration's token. The recorder checks that it is set and never prints it |
| Supabase URL and key | `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` of the project that holds the registration, in `.env.local` (the npm script loads it) |
| The group read | The reader app's group-read permission, proved by #275's `m365:probe-group` (below). `M365_GROUP_SNAPSHOT_FILE` belongs to the snapshot mirror ([275 C]), which was not built; if it is, this table gains that input |

**Before you run it.** Owner items, in order.

1. **The checkout holds #275's live unlock and this recorder, and is clean.**
   A content check, which still holds once either stack is squash-merged
   (Proposed):

   ```bash
   test -f supabase/migrations/20261018120000_graph_reader_scope_group.sql \
     && grep -q 'export function createGuardedRecording' src/lib/mailboxAccess/readers.ts \
     && test -z "$(git status --porcelain)" && echo ok
   ```

   It prints `ok`.
2. **#275's migration is applied to the hosted dev project, `sqyjqdjazefceixkjtdp`**
   (ADR-0007, 2026-09-25 update: the only active projects are dev
   `sqyjqdjazefceixkjtdp` and prod `fsaucpwponmzajupvsey`). That is the project
   that holds the Tidewell registration (Proposed, from the code: the
   registration's certificate is `env:`, and an `env:` reference is refused in
   production, so it cannot live in prod). If the owner placed it elsewhere,
   every check below applies to that project instead. `.env.local` must name
   the same project, and may still name the deprecated `Conductia-dev`
   (`lknjzkvvhmqdmhdnnmwb`). Confirm the ref it names, which prints the project
   ref only, never a key:

   ```bash
   env -u NEXT_PUBLIC_SUPABASE_URL \
     node --env-file=.env.local -e 'console.log(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0])'
   ```

   It prints `sqyjqdjazefceixkjtdp`. The policy dry run in item 3 prints the same
   ref as `Target: supabase <ref>`, a second check. A hosted project here has no
   migration history table, so `supabase db push` does not apply to it. Apply
   the one file with that project's direct connection string (Supabase
   dashboard, project `sqyjqdjazefceixkjtdp`, Connect; its host is
   `db.sqyjqdjazefceixkjtdp.supabase.co`). Keep the string in the shell, never
   in a file in the repo or a message, then check the column:

   ```bash
   psql -X "<direct connection string>" -v ON_ERROR_STOP=1 --single-transaction \
     -f supabase/migrations/20261018120000_graph_reader_scope_group.sql
   psql -X "<direct connection string>" -Atc "select column_name from information_schema.columns
     where table_name = 'graph_reader_registrations' and column_name = 'scope_group_id'"
   ```

   The second prints `scope_group_id`. Then the registration records the scope
   group: `scopeGroupId` in the config, written by `npm run m365:write-registration`.
3. **A stored exclusion-policy version exists.** The empty policy `[]` is fine;
   a live pass has no version-0 default, and the Graph mail reader refuses a
   policy with any rule. Write `[]` to a file outside the repo, then run the dry
   run with `--expected-version 0`. Its first line names the target project
   (`Target: supabase <ref>`, which must be the project in item 2). It shows the
   diff, or, when a version already exists, `stale: the tenant's current version
   is N`: rerun with `--expected-version N`. A current version whose diff to `[]`
   is empty needs no write. Otherwise add `--confirm`:

   ```bash
   echo '[]' > <outside the repo>/empty-policy.json

   # 1. Dry run: prints the target ref and the diff (or the current version), writes nothing.
   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
     npm run discovery:set-exclusion-policy -- --tenant <Conductia tenant uuid> \
     --requested-by "<owner name>, #318 Tidewell capture" --expected-version 0 \
     --rules <outside the repo>/empty-policy.json

   # 2. Write: the same arguments, with N the current version (0 when the dry run
   #    printed no `stale:` line, else the N it printed) and --confirm.
   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
     npm run discovery:set-exclusion-policy -- --tenant <Conductia tenant uuid> \
     --requested-by "<owner name>, #318 Tidewell capture" --expected-version <N> \
     --rules <outside the repo>/empty-policy.json --confirm
   ```

   The write prints `Wrote version <N+1>.`, and the preflight's `run blocked`
   line no longer names an exclusion policy.
4. **Every Tidewell mailbox owner is seated and opted in.** Each has an accepted
   invitation, an active internal seat and a deal membership (MD or deal team),
   and has opted in on `/profile` under their own session (D68). The service role
   cannot opt in for them.
5. **The tenant is quiet.** The seeder has finished the demo corpus (438 mailbox
   copies, 31 files), so nothing writes to the tenant during the recording.
6. **The scope is proved.** `probe-out-of-scope` prints `PASS` on every line
   (registration step 4 above), and `npm run m365:probe-group` prints `Q1: yes`. The group
   steps are #275's owner steps: see "Prove the group read (owner checklist)" in
   this file, and "Binding: one address, exactly one mailbox" for the scope
   group's binding rules.
7. **The preflight passes** (next).

**Preflight.** It runs every gate and the readiness check the capture uses, reads
no mail and writes no file. It does read the provider group, which records any
drift in the target database, and it asks the mailbox guard about every source,
which records any change of refusal state and its audit row under the caller
`m365-recorder`. `--out` is not needed.

```bash
env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
  npm run m365:record-graph -- --live --preflight --tenant <Conductia tenant uuid> \
  --ms-tenant-id <Entra tenant id> --confirm-domains <domain[,domain]> \
  --allow-env-pem [--allow-remote-supabase <host>]
```

The `env -u` prefix is #275's: `--env-file` never overrides a variable that is
already set, and a shell profile may export a hosted project, so unset both and
let `.env.local` name the project.

It prints fixed words and counts, never an address, a subject, an id, a token or
a URL:

```text
provider group <in_sync | drift | unavailable | not read>
run blocked: <code>                (only when the run is blocked)
sources ready N
sources not ready N
  <reason> N                       (one line per reason)
mailboxes recorded under their UPN N
```

Go only when the group is `in_sync`, no `run blocked` line appears, and `sources
not ready` is 0 (Proposed). `sources ready` is what the capture will read.

- **`run blocked`** reads nothing. `no_scope_group`: record `scopeGroupId` (item
  2). `no_exclusion_policy` or `invalid_exclusion_policy`: store the empty policy
  (item 3). `exclusion_policy_not_empty`: the reader enforces no rule, so a rule
  would be ignored; the owner decides whether to store an empty version.
  `group_unavailable`: the group read failed; repeat the group steps in item 6.
- **A reason under `sources not ready`** is the guard's own (`not_in_provider_group`,
  `mirror_unavailable`, `no_consent`, `no_invite`, `seat_inactive`, `owner_mismatch`
  and the rest of D68's vocabulary) or `halted` (history window exceeded). The
  allowlist reasons are fixed in item 4; the group reasons in the group
  (membership propagates in 30 minutes to 2 hours). Rerun the preflight.
- **`mailboxes recorded under their UPN N`** is information, not a refusal. A
  mailbox whose directory UPN differs from its stored address (a shared mailbox
  on the tenant's `onmicrosoft.com` domain, for example) is read by its UPN (#275)
  and recorded under it. The manifest names the UPN, so replay asks the same
  URLs. N counts those mailboxes, and is 0 when every UPN equals its address.

**Record**

```bash
env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
  npm run m365:record-graph -- --live --tenant <Conductia tenant uuid> \
  --ms-tenant-id <Entra tenant id> --confirm-domains <domain[,domain]> \
  --out <path outside the repo>/tidewell-cassette-2026-10-xx --allow-env-pem \
  [--allow-remote-supabase <host>]
```

`--out` must not exist yet. The recorder prints the readiness lines above, then
`sources skipped N` with a reason per line (only when it skipped a source), then
counts, the cassette id (`cassette sha256:<id>`), the reader commit, the number
of orphaned download hops it dropped, and the names of the response headers it
removed. It never prints an address, a subject, a token or a config value. Every
refusal is fixed text, never a value.

Before any Graph call it refuses:

- `--config` with `--live`, a malformed `--tenant`, `--ms-tenant-id` or
  `--confirm-domains`, and an `--out` inside the repository (symlinks are
  followed) or one that exists;
- a production `NEXT_PUBLIC_APP_ENV`, and a checkout with any uncommitted change
  (the whole tree, not only the reader);
- a Supabase URL that is not loopback, or not an https host that
  `--allow-remote-supabase` names exactly;
- a tenant with no active registration, a `--ms-tenant-id` that differs from the
  registration's, and `--confirm-domains` that is not the registration's full set;
- a certificate that is not `env:`, a missing `--allow-env-pem`, and an
  environment variable that the `env:` reference names but that is not set;
- a blocked run (the `run blocked` codes above).

During the capture, a source the guard refuses before anything of it is recorded
is skipped and counted. These stop the run with nothing written:

- the guard refuses a source after part of it was recorded;
- `a collection page had no value array`, or a backfill or delta that `did not
  complete every folder or library`;
- `a request addressed a user other than the bound mailbox by object id;
  nothing was sent`. The readers address a mailbox by its UPN, and the paging
  links they follow (`@odata.nextLink`, `@odata.deltaLink`) come from Graph.
  When Graph returns a link under the bound mailbox's own object id, the
  recorder sends it under the UPN (the binding check has shown both reach the
  same mailbox) and records the link that way, so the cassette stays keyed by
  UPN and replays as recorded: nothing to do. A link that names any other user
  by object id stops the run before it is sent. The rehearsal is where this
  shows: stop and send engineering the line. `a read addressed a user by object
  id` is the same rule's backstop in the cassette writer;
- `no source was recorded`;
- a tenant that changed while it was recording (`the tenant changed during the
  recording (N keys); re-record`): the seeder or a user wrote to the tenant
  mid-run, so record again once it is quiet;
- a cassette that fails its credential check. It writes nothing and prints the
  rule and the location, for example `tempauth at
  interactions[12].headers.location`. Send engineering that rule and location.
  Never send the value.

The recorder checks the checkout that holds the script, found from the script's
own location, so the answer does not depend on the directory you run it from.
Any other failure prints a fixed line: the error class, plus a status code for a
Graph error. It never prints the error's own text, which can hold a request id or
an address. The files are written mode 0600, and `digest.json` is written last.

**After**

1. **The count matches.** The recorder's `sources N` equals the preflight's
   `sources ready N`, less `sources skipped`.
2. **Replay it offline** with the cassette-agnostic test ([318 2/6],
   `tests/integration/discovery-replay-cassette.test.ts`) on a local throwaway
   Supabase, with the reader that recorded the cassette. The test is on
   `feat/318-2-replay-cassette-test`, not in the `[318 5/6]` stack, so until
   `develop` holds both, put its two commits on a throwaway local branch of the
   capture checkout (Proposed):

   ```bash
   git switch -c replay-check
   git cherry-pick origin/feat/318-2-replay-cassette-test~2..origin/feat/318-2-replay-cassette-test
   ```

   Without `M365_REPLAY_CASSETTE_DIR` the Tidewell case is skipped, with a
   message.

   ```bash
   supabase start && supabase db reset --local
   eval "$(supabase status -o env)"
   M365_REPLAY_CASSETTE_DIR=<path outside the repo>/tidewell-cassette-2026-10-xx \
   NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" \
   SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
     npm run test:integration -- tests/integration/discovery-replay-cassette.test.ts
   ```

   It must pass with 0 misses and 0 unrequested interactions. It prints the
   cassette id and counts, never an address, a subject or a text.
3. **Owner evidence.** Paste into the `[318 6/6]` PR description, and nowhere
   else: the recorder's counts (`sources`, `interactions`, `bodies`) and
   `cassette sha256:<id>`, and the replay test's printed counts and its cassette
   id, which must equal the recorder's. Not filled in until the capture has run.
4. **Keep the cassette** where "Backing up the cassette" says, and never commit
   it (#277 Q1). Then continue the Owner checklist: the PEM moves to Key Vault.

**Replay** into a local, throwaway Supabase:

1. `supabase start && supabase db reset --local`, then
   `eval "$(supabase status -o env)"`.
2. Map the local stack's names to the ones the script reads, and run it:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
     npm run m365:replay-discovery -- --cassette <dir> --tenant <tenant uuid> \
       --owners <registration.json> --firm-company <bank company id or name> \
       --mailbox-domains bank.example
   ```

   The replay reads through the mailbox guard like any other pass (#262), so the
   tenant needs what the guard needs. `--firm-company` and `--mailbox-domains`
   name the firm and the domains on the replay registration, as
   `write-registration.ts` does. `--owners` names a seated user for every
   source. Each owner needs an accepted invitation to the bank company and their
   own opt-in, and the site needs the firm admin's registration. A source
   without them is refused, and each run prints how many. `--no-owners` still
   works, and reads nothing for that reason.

   **Opt-in: `--activate-for-optin` opens the window only.** An opt-in is the
   owner's own act, and it needs an active registration, which the replay one is
   not at rest (`disabled`). The flag holds the replay registration `active`,
   prints each seeded owner who has no open consent on their seated invitation
   (the mailbox address and the `/profile` URL), and waits while the owners opt
   in themselves: each signs in as the account that accepted that invitation,
   opens `/profile` and selects "Connect my mailbox". The script never opens a
   session for an owner and never writes a consent: it polls the consent
   status read-only with the service role, every two seconds. The window
   closes, and the registration goes back to `disabled`, when:

   - every listed owner has opted in;
   - `--optin-timeout <seconds>` passes (whole seconds, default 600, at most
     86400);
   - you press Enter (only when stdin is a terminal; the end of piped input is
     not Enter);
   - you press Ctrl-C or send SIGTERM. That ends the wait and closes the window;
     it does not kill the script mid-state;
   - something fails.

   The wait does not depend on the database answering. The deadline is fixed
   before the first poll and enforced by a timer, and each request the window
   makes (the activation, every poll, the final disable) is abandoned after 10
   seconds. The deadline, Enter and Ctrl-C or SIGTERM abort a poll that is in
   flight and close the window at once. A poll that merely takes longer than 10
   seconds is a failure: the window closes and the script reports it. If the
   activation itself reports an error, the update may still have committed, so
   the script sets the registration back with a conditional disable (only where
   it is `active`, for the `replay` registration alone), reads it back to check,
   retries up to three times, and then exits with the activation's own error.
   If it cannot verify the registration is not `active` it says so: use the
   fix-up below.

   The replay pass runs only if at least one owner opted in, so a window nobody
   answered exits 1 and reads nothing. An owner with no seated invitation cannot
   opt in; the script says so and does not wait for that owner. After the pass it
   prints one line per owner: whether they consented, how many items their
   sources' ledger holds (`read`) and how many times the guard refused one of
   their sources across the two runs (`refused`). The flag touches a registration
   whose `ms_tenant_id` is `replay` and no other. `--app-url <origin>` (default
   `http://localhost:3000`) is only used to print the `/profile` URL; no request
   is made to it. The flag runs on a loopback Supabase only:
   `--allow-remote-supabase` does not lift that, and it refuses `--no-owners`.
   The guard is unchanged. It needs no publishable key. A tenant that an
   earlier replay already filled still needs `--reset-replay-tenant`.

   ```bash
   NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
     npm run m365:replay-discovery -- --cassette <dir> --tenant <tenant uuid> \
       --owners <registration.json> --firm-company <bank company id or name> \
       --mailbox-domains bank.example --activate-for-optin --app-url http://localhost:3000
   ```

   In a second shell, after the same `eval "$(supabase status -o env)"`, run the
   app against the same stack so that `/profile` exists while the window is open.
   The inline values win over the profile's hosted ones and over `.env.local`:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" \
   SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
     npm run dev
   ```

   The script loads no `.env.local`, because that file names a hosted project.
3. Paste the printed cassette id, the reader commit and the counts into the PR.

It prints the cassette id, the reader commit, one line per run and the counts.
It never prints a subject or text. It prints no address either, with one
exception: with `--activate-for-optin` the opt-in prompt names each pending
owner's mailbox address, so the owner knows which invitation to open `/profile`
for. That flag runs on a loopback Supabase only, from the operator's own owners
file. The per-owner results after the pass use owner numbers, not addresses.

**Replay limits**

- A cassette holds exactly one backfill and one delta round, so every run of
  the script starts again from the backfill.
- It refuses `NEXT_PUBLIC_APP_ENV=prod`.
- It refuses a Supabase host that is not `127.0.0.1`, `localhost` or `[::1]`.
  `--allow-remote-supabase <host>` names an exact host, and is for the one
  environment the demo owner chooses (T3), passed by that environment's
  operator. A named remote host must also be reached over `https:`.
- It refuses a tenant with a live reader registration.
- It leaves the replay registration `disabled`. The registration is written
  `disabled`, made `active` only while the two runs execute (and, with
  `--activate-for-optin`, while the opt-in window is open), and set back to
  `disabled` when they finish, including when they fail. The worker selects
  only `active` registrations, so a worker running with
  `GRAPH_READER_PROVIDER=fixture` against the same database never picks up the
  replay tenant. Ctrl-C (SIGINT) and SIGTERM during a replay set it back to
  `disabled` first, then exit 130 and 143.
- **A replay killed by SIGKILL, or one that crashes before it can clean up, can
  leave the replay registration `active`** until the next `seedReplayTenant`
  (any later replay into that tenant writes it `disabled` again). A worker
  sharing the database can pick it up in that time. Fix it by hand:

  ```sql
  update graph_reader_registrations set status = 'disabled'
   where tenant_id = '<tenant id>' and ms_tenant_id = 'replay';
  ```

  The `ms_tenant_id = 'replay'` condition is deliberate: it never touches a
  live registration.
- It refuses a tenant that already holds discovery data. Replay into a fresh
  `--tenant`, or pass `--reset-replay-tenant` for a tenant that a replay
  created. The reset deletes that tenant's candidates, items and ledger rows;
  the audit log is append-only, so earlier `discovery.candidate_proposed`
  rows stay.

**After the tenant is gone.** A replay only works against reader code that
asks for the URLs the reader asked for at recording time. If a replay misses
after a reader change, the error names the commit the cassette was recorded
with. Check that commit out in a separate worktree
(`git worktree add ../reader-<sha> <sha>`) and replay from there.

## Backing up the cassette

- The cassette lives outside the repo, beside the eval answer key
  (`ground-truth.json`). Its files stay mode 0600.
- It never goes into the repository, a gist or any chat (owner decision #277
  Q1, 2026-09-29: eval contamination, reaffirmed 2026-10-17). The repository's
  tests fail on any cassette they find, other than the committed synthetic
  one.
- Check a copy by its id: the sha256 of `digest.json`, printed by both
  commands. The loader refuses a copy with a missing, extra or altered file.

## The seeder app (test tenant only)

The seeder wrote the demo corpus into the Tidewell Pike test tenant. Its app
holds two tenant-wide application permissions: `Mail.ReadWrite` (every mailbox
in the tenant) and `Sites.ReadWrite.All` (every site). The corpus is complete,
so the seeder needs neither outside a seeding window. These grants are the
tenant's widest, and nothing in the repository records them until now. They
belong to the seeder's app; leave the reader's own grants alone.

**Revoke both now** (owner action, step 1 of the checklist below):

- In the Entra admin center, open the seeder's enterprise application, then
  Permissions, and Revoke each of the two admin-consented application
  permissions; or
- run `Remove-MgServicePrincipalAppRoleAssignedTo` for each of the two
  app-role assignments on the seeder's service principal.

Revocation does not cut off a token that was already issued. An access token
stays valid for its own lifetime, typically 60 to 90 minutes, so treat the
tenant as exposed until that window has passed. Then confirm that the seeder's
service principal lists neither role.

**Reseeding.** Re-grant by admin consent only for a reseeding window, and
revoke again when it ends. If reseeding becomes routine, scope the seeder
permanently instead:

- Exchange RBAC for Applications: assign `Application Mail.ReadWrite` to the
  seeder's service principal over a management scope that holds only the demo
  mailboxes (a group of them);
- grant `Sites.Selected` with the write role on the corpus site only;
- then remove the Entra `Mail.ReadWrite` and `Sites.ReadWrite.All` grants.
  RBAC grants are a union with the Entra ones, so leaving the tenant-wide grant
  in place makes the scoping void.

## Retire the PEM

The test tenant's reader certificate is held as a PEM, referenced as
`env:GRAPH_READER_CERT_PEM`. The reader loads a certificate only through the
registration's `cert_secret_ref`. There is no file scheme and no default path,
and the loader refuses `file:`, a raw PEM in the reference, and `env:` in prod
(`tests/graph/certificate-source.test.ts`). No PEM is tracked in the
repository, and `.gitignore` now refuses `*.pem`, `*.key`, `*.pfx` and `*.p12`, as
`.dockerignore` does.

Move the key into Key Vault **after the #277 capture** and **before the
certificate expires on 2026-10-31**. The order matters: the Key Vault signer
authenticates through a managed identity only, and a laptop has none, so a
laptop capture needs the PEM.

1. **Create a non-exportable Key Vault certificate** (step 1 above), and give
   the worker's managed identity the Key Vault Crypto User role on the vault,
   or, when the vault uses access policies rather than Azure RBAC, the `get`
   and `sign` key permissions (step 1 shows the check and both commands).
   Note the versioned key id (`kid`) that step 1 prints, and compute the new
   certificate's SHA-256 thumbprint from its public half:

   ```bash
   openssl x509 -inform DER -in conductia-reader.cer -noout -fingerprint -sha256 \
     | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'
   ```

2. **Add the `.cer` to the existing app as a second credential.**
   `register-reader.ps1` does not do this: for an app that already exists it
   leaves the credentials as they are. Use one of these, both of which keep the
   PEM's credential:

   - Entra admin center: App registrations, the reader app, Certificates &
     secrets, Certificates, Upload certificate, then choose
     `conductia-reader.cer`. An upload adds a credential and removes none.
   - PowerShell (`Microsoft.Graph`, `Application.ReadWrite.All`).
     `-KeyCredentials` replaces the whole list, so read the current list with
     its key data first and send it back together with the new certificate:

     ```powershell
     $app = Get-MgApplication -Filter "displayName eq 'Conductia Deal Discovery Reader'" | Select-Object -First 1
     # Key data is returned only when keyCredentials is selected on a single application.
     $current = (Get-MgApplication -ApplicationId $app.Id -Property keyCredentials).KeyCredentials
     if ($current | Where-Object { -not $_.Key }) { throw 'A current credential came back without its key data; stop, or it would be dropped.' }
     $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path ./conductia-reader.cer).Path)
     $keep = @($current | ForEach-Object {
       @{ KeyId = $_.KeyId; Type = $_.Type; Usage = $_.Usage; Key = $_.Key; DisplayName = $_.DisplayName }
     })
     $new = @{ Type = 'AsymmetricX509Cert'; Usage = 'Verify'; Key = $cert.RawData
               DisplayName = "Conductia reader $($cert.NotAfter.ToString('yyyy-MM-dd'))" }
     Update-MgApplication -ApplicationId $app.Id -KeyCredentials ($keep + $new)
     ```

   **Check before step 3:** the app lists both certificates.

   ```powershell
   (Get-MgApplication -ApplicationId $app.Id -Property keyCredentials).KeyCredentials |
     Select-Object DisplayName, KeyId, StartDateTime, EndDateTime
   ```

   There must be two entries: the PEM's certificate, which ends on 2026-10-31,
   and the new one. The portal's Certificates tab shows each SHA-1 thumbprint;
   the new one must equal
   `openssl x509 -inform DER -in conductia-reader.cer -noout -fingerprint -sha1`.
   With only one entry, stop: writing the registration would cut the reader off.

3. **Pre-flight before steps 4 and 5.** All of it runs while the PEM
   registration is still in force, so a failure here costs nothing.

   - **The worker's identity must be user-assigned.** The probe runs under the
     worker's managed identity from a separate host, and only a user-assigned
     identity can be attached to a second resource:

     ```bash
     az containerapp identity show --name <worker app> --resource-group <resource group>
     ```

     `type` must include `UserAssigned`, and the identity the worker uses
     (its `AZURE_CLIENT_ID`) must be listed under `userAssignedIdentities`.
     Note its resource id and client id for the probe job. If the worker runs
     only under a system-assigned identity, stop here and do not write the
     `keyvault:` registration: nothing else can carry that identity, so
     there is no way to probe the new credential before the worker depends
     on it. Continue only once a probe path under the worker's identity
     exists.
   - **The Supabase project.** `npm run m365:write-registration` loads
     `--env-file=.env.local` on your machine. Confirm which Supabase project
     that file's URL and service key target, so the registration lands in the
     database the test tenant's worker reads. The probe job does not use
     `.env.local`; it reads the same project through its own runtime
     environment. Note the project URL for the probe job.
   - **The probe job, created and smoke-tested now.** After step 4 the
     registration signs through Key Vault, and the Key Vault signer gets its
     token from a managed identity (Azure Container Apps provides
     `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`; `AZURE_CLIENT_ID` selects a
     user-assigned identity). A laptop has no managed identity, so the probe
     fails there whatever the state of the credential. The worker container
     cannot run it either: its image holds only the bundled worker, with no
     `scripts/`, no `tsx` and no repo `package.json`, and no environment file
     may enter it.

     Create a one-off host that has both the identity and the repo tooling: an
     Azure Container Apps job (or a VM) that

     - is assigned the **same user-assigned managed identity** as the worker
       (the resource id noted above), and has `AZURE_CLIENT_ID` set to that
       identity's client id;
     - has a checkout of the repository at the commit you are deploying, with
       `npm ci --include=dev` run so `tsx` and the dependencies are installed
       (`tsx` is a devDependency, and a plain `npm ci` skips it when
       `NODE_ENV=production`);
     - receives `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` for the
       **same Supabase project** the registration lives in (the URL noted
       above), and `GRAPH_READER_CERT_PEM` so the probe can sign with the
       credential in force, all injected at runtime from the secret store, for
       example as Container Apps secrets referenced by environment variables,
       written to a runtime env file outside the checkout. Never copy
       `.env.local` to the host, and never bake a secret into an image.

     Then smoke-test it on that host:

     - **A Key Vault token under the identity.** This prints the status and
       whether a token came back, never the token:

       ```bash
       node -e '
       const u = new URL(process.env.IDENTITY_ENDPOINT);
       u.search = new URLSearchParams({ "api-version": "2019-08-01", resource: "https://vault.azure.net", client_id: process.env.AZURE_CLIENT_ID });
       fetch(u, { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER } })
         .then(async (r) => console.log(r.status, r.ok && Boolean((await r.json()).access_token)));
       '
       ```

       It must print `200 true`.
     - **`tsx` loads.** `node --import tsx -e 1` must exit 0.
     - **The probe passes on the current credential.** Without the `npm run`
       script (it hardcodes `.env.local`):

       ```bash
       node --env-file=<runtime env file> --import tsx scripts/m365/probe-out-of-scope.ts \
         --tenant <Conductia tenant uuid> \
         --out-of-scope <a mailbox NOT in the scope group> --in-scope <a member mailbox> \
         --site-out-of-scope <a site that was not granted>
       ```

       When the variables are already in the job's environment, drop
       `--env-file` and run `node --import tsx scripts/m365/probe-out-of-scope.ts`
       with the same flags. Every line must print `PASS`.

     If any check fails, fix the job before step 4. The registration has not
     changed, so nothing is at risk yet. Keep the job for step 5.
   - **The rollback.** Keep a copy of the registration config currently in
     force (its `env:` reference and SHA-1 or SHA-256 thumbprint).

4. **Write the `keyvault:` registration.** Copy the config in force and change
   exactly two fields together: `certSecretRef` to the new key id and
   `certThumbprint` to the new certificate's thumbprint from step 1. The
   assertion header carries the registration's thumbprint, so changing only the
   reference would sign with the new key while naming the old certificate, and
   every token request would fail. Keep `sources` exactly as it is: the list is
   authoritative, and a source left out is paused. Keep `scopeGroupId` too: a
   config without it records no group, and no Microsoft mailbox is read. The
   complete config:

   ```json
   {
     "tenantId": "<Conductia tenant uuid>",
     "msTenantId": "<the test tenant's Entra tenant id>",
     "clientId": "<the reader app's application id>",
     "certThumbprint": "<new SHA-256 thumbprint, 64 hex, from step 1>",
     "certSecretRef": "keyvault:https://<vault>.vault.azure.net/keys/conductia-reader/<version>",
     "status": "active",
     "consentedAt": "<unchanged from the config in force>",
     "firmCompany": "<unchanged>",
     "mailboxDomains": ["<unchanged>"],
     "scopeGroupId": "<unchanged>",
     "sources": [
       { "kind": "mailbox", "address": "<unchanged>", "ownerEmail": "<unchanged>" },
       { "kind": "sharepoint_site", "address": "<unchanged>", "ownerEmail": null }
     ]
   }
   ```

   ```bash
   npm run m365:write-registration -- --config <outside the repo>/registration-keyvault.json --dry-run
   npm run m365:write-registration -- --config <outside the repo>/registration-keyvault.json
   ```

   `--allow-env-pem` is no longer needed: the reference is `keyvault:`. The
   worker builds a new token client as soon as the reference changes.

5. **Run the probe job again, right after step 4.** Run the step 3 probe
   command on the probe job, unchanged. The registration now names the Key
   Vault key, so this run signs through Key Vault under the worker's identity.

   Every line must print `PASS`, which proves the Key Vault credential signs and
   the scope holds. If any line fails, restore the previous registration at
   once by running `npm run m365:write-registration -- --config <the copy from
   step 3> --allow-env-pem` from the machine that ran step 4, and stop. The
   PEM's credential is still on the app, so the restored registration signs
   again. Delete the probe job, its secrets and its runtime env file when it is
   done.

6. **Delete the PEM** from the worker host's secret store and from any laptop
   that holds a copy, then **remove the old key credential** from the app
   (portal: delete the certificate that ends on 2026-10-31; or the step 2
   PowerShell, sending back only the new entry).

## Owner checklist

An agent never performs these. Each step is a live tenant, Azure or host
change, listed in order with the reason for the order. Tracking: T3 (the
capture) and T4 (this list) in the W3 hardening threads, issue #278.

1. **Revoke the seeder's `Mail.ReadWrite` and `Sites.ReadWrite.All`**
   (portal Revoke, or `Remove-MgServicePrincipalAppRoleAssignedTo`). Why first:
   it is independent of everything else, the corpus is complete, and it
   removes the widest grant now. Wait out the 60 to 90 minute token lifetime
   before treating it as closed.
2. **Decide the #277 capture** (T3). Choose one: run the guarded recorder
   ("Record and replay", "Live capture") before 2026-10-24; convert or extend
   the test tenant; or accept no live capture.
   Why before the PEM move: the capture needs the PEM, because a laptop cannot
   sign through Key Vault.
3. **Take the capture** if one is wanted, by the procedure in "Record and
   replay" ("Live capture": preflight, record, after), with the current
   `env:GRAPH_READER_CERT_PEM` and `--allow-env-pem`: the throwaway rehearsal on
   2026-10-19 to 2026-10-20, with #275's group probe, then the kept capture on
   2026-10-22 to 2026-10-23.
   Why before step 4: after the move, the laptop has no way to sign.
4. **Create the non-exportable Key Vault certificate** and give the worker's
   managed identity the Key Vault Crypto User role (on an access-policy vault,
   the `get` and `sign` key permissions instead; "Retire the PEM" step 1 has
   the check). Why after the capture: the certificate is unusable from a
   laptop.
5. **Add the Key Vault certificate's `.cer` to the existing app** as a second
   credential, through the portal upload or the PowerShell in "Retire the PEM"
   step 2 (`register-reader.ps1` leaves an existing app's credentials as they
   are). Then check the app lists both certificates. Why before deleting
   anything: two credentials overlap, so the reader never loses access.
6. **Pre-flight.** Confirm the worker's managed identity is user-assigned
   (`az containerapp identity show`); if it is system-assigned only, stop and
   do not write the `keyvault:` registration until a probe path under that
   identity exists. Confirm which Supabase project `.env.local` targets, since
   `m365:write-registration` loads it. Create the one-off probe Container Apps
   job (or VM): the worker's user-assigned identity, `AZURE_CLIENT_ID` set to
   its client id, a checkout with `npm ci --include=dev` run (`tsx` is a
   devDependency), and the Supabase URL, secret key and
   `GRAPH_READER_CERT_PEM` injected at runtime from the secret store. On it,
   require a managed-identity token for `vault.azure.net`, a clean
   `node --import tsx -e 1`, and `PASS` on every probe line with the current
   PEM credential ("Retire the PEM" step 3). Keep a copy of the registration
   config in force. Why before step 7: the probe host is proven while nothing
   depends on it, the registration must land in the database the worker
   reads, and the copy is the rollback.
7. **Write the `keyvault:` registration** with `m365:write-registration`,
   changing `certSecretRef` and `certThumbprint` together and keeping
   `sources` as they are. Why both: the assertion names the registration's
   thumbprint, so a new key under the old thumbprint fails every token request.
8. **Run the probe job again** with the same command, right after step 7,
   and require `PASS` on every line. Why there: the Key Vault signer needs
   the worker's identity, a laptop has none, and the worker image has no
   scripts, no `tsx` and no env file. Why before deleting the PEM: it is the
   proof that the new credential works and the scope holds. If any line fails,
   restore the previous registration from the step 6 copy and stop.
9. **Delete the PEM** from the secret store and from every copy. Why after the
   probe: until it passes, the PEM is the rollback.
10. **Remove the old key credential** from the app. Why last: it only matters
    once nothing signs with the PEM, and it must happen before the certificate
    expires on 2026-10-31 in any case.
11. **Reseeding only:** re-grant the two permissions by admin consent for the
    window and revoke them again after, or scope them permanently (see "The
    seeder app").
