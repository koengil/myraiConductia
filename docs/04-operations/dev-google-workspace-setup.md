# Dev Google Workspace: setup and first-day checks

Audience: the owner, and the admins of the dev Workspace (Storm and Dan). Scope: everything that must exist so that three live checks run on the same day the Workspace is ready. Status: checklist, not yet started. The domain is not chosen, so this page writes `<dev domain>`.

## Why this Workspace exists

- **It replaces emailmask.uk.** The emailmask.uk trial Workspace has expired (owner, 2026-10-20). Its mailboxes and grants went with it, so no live Google check can run today.
- **It is approved.** A paid dev Workspace (about $225 a year, synthetic mail only) was approved on 2026-10-20 by Dan and Rob. It sits on a Conductia account, with Storm and Dan as admins. Guillermo and Marcelo are its first users.
- **Tier: Demo and Trial only.** It holds synthetic mail only: the committed seed corpora and test messages the team writes. Never real client mail, a real deal name or MNPI. It is never registered for a bank and never holds a bank's data.
- **It unblocks three checks:**
  1. **T1**, the team inbox probe (`npm run google:probe-team`), per [team-inbox-guide.md, "The live check (T1)"](../03-engineering/team-inbox-guide.md#the-live-check-t1) and ADR-0026, "The live check (T1) has not run".
  2. **The Gmail send live check**, T2 step 1 of [gmail-send-runbook.md](../03-engineering/gmail-send-runbook.md) (D102, ADR-0025).
  3. **The seeded dry runs**, per [deal-discovery-demo-runbook.md, "Seeded dry runs on the test Workspace"](../03-engineering/deal-discovery-demo-runbook.md#seeded-dry-runs-on-the-test-workspace-owners-machine-only).

**Owner** marks a step only the owner, or a Workspace or Cloud admin the owner names, may do. Agents never run a live step: every run below is announced to the owner first and run by hand.

## Timing

- **Day 0: create and grant.** Do sections 1 to 4 the day before the runs. Delegation and role changes take up to 24 hours to apply ([google-workspace-reader-admin-guide.md](../03-engineering/google-workspace-reader-admin-guide.md), "What you set up, in order", step 4). Group membership changes get the same 24 hours (same guide, "Team inboxes: one more role permission").
- **Day 1: run.** Section 5 (local files), then the three runs in section 6, in order.
- **The Oct 28 freeze.** No domain-wide delegation (DWD), group or registration change after it (deal-discovery demo runbook, "Seeded dry runs on the test Workspace"). Day 0 must fall before Oct 28.

## 1. Workspace creation and users

### Licence count

Every mailbox below is a licensed user. An alias and a Google Group need no licence. A suspended user is still billed for its licence.

| Account | Why | Source | Licences |
|---|---|---|---|
| Storm, Dan | Admins | Owner approval, 2026-10-20 | 2 |
| Guillermo, Marcelo | First users | Owner approval, 2026-10-20 | 2 |
| `deals@<dev domain>` | The shared user mailbox for T1 (`--shared`): a licensed user used as the team inbox | team-inbox-guide.md, "The live check (T1)" | 1 |
| A suspended user | T1 `--suspended` | Same | 1 |
| Three persona mailboxes | The seeded dry runs: one each for `storm.duncan@bank.example`, `morgan.vale@bank.example` and `alex.chen@bank.example` | Demo runbook, "Steps", step 3 | 3 |
| `probe@<dev domain>` | The banker test user for the Gmail send check | gmail-send-runbook.md, "Owner steps", T2 | 1 |
| **Total** | | | **10** |

T2 step 2 also sends to `storm@` with a Cc and a Bcc. Use the persona mailboxes as those recipients; they need no extra licence.

**Proposed minimum: 8 licences.** The `probe@` role can be played by one persona mailbox, because the send check runs on a deployment's database and the dry runs on a separate local stack. The suspended role can be played by a persona mailbox suspended for T1 and restored before the dry runs (restore it first; a suspended persona fails the dry runs). Both reuses are the owner's choice.

**Cost estimate.** Assumption: Google Workspace Business Starter at about $7 per user per month on an annual plan, or about $8.40 on the Flexible plan (Google's US list prices; confirm at checkout). Any edition with Gmail, Groups and domain-wide delegation serves these checks.

| Licences | Per month (annual plan) | Per year (annual plan) | Per month (Flexible) |
|---|---|---|---|
| 10 | about $70 | about $840 | about $84 |
| 8 | about $56 | about $672 | about $67 |

The approved figure of about $225 a year covers about two licences at these prices. See "Open items for the owner".

### Checklist

- [ ] **Owner.** Create the Workspace on the Conductia account, on `<dev domain>`, and verify the domain. Make Storm and Dan admins.
- [ ] **Owner.** Create the users in the table: Guillermo, Marcelo, `deals@`, the suspended user, the three persona mailboxes and `probe@` (or the minimum set). Use names that read as test accounts.
- [ ] **Owner.** Create them on Day 0, so Google has set each mailbox up before T1. T1 expects `isMailboxSetup` true for `deals@` (team-inbox-guide.md, "The live check (T1)", expected rows).
- [ ] **Owner.** Put `probe@` in an organizational unit (OU) of its own, or note which OU holds it. The send check sets the sending client to Trusted, then Blocked, for that OU (gmail-send-runbook.md, T2 step 4).

## 2. Google Cloud identities and clients

These live in a Google Cloud project, not in the Workspace. Each grant in section 3 needs a value from here.

- [ ] **Owner.** Name the Cloud project that hosts the reader identities. The registration names three service accounts (`.secrets/README.md`; demo runbook, "Prerequisites", Files):
  - the DWD reader account (`serviceAccountEmail`) and its numeric client ID (`clientId`);
  - the directory account (`directoryServiceAccountEmail`), which has no delegation;
  - the seeding account (`seedingServiceAccountEmail` in `seeding.json`).
- [ ] **Owner.** The keyless caller identity (behind `worker-credentials.json`) can sign as the DWD account (IAM Credentials `signJwt`) and mint a directory token (the probe asks IAM for one when `GOOGLE_DIRECTORY_CREDENTIALS` is unset; team-inbox-guide.md, "The live check (T1)", step 2). Both need Service Account Token Creator on those accounts.
- [ ] **Owner.** No service account key is ever created or downloaded. A key anywhere under `.secrets/` makes every script here refuse (`scripts/google/lib/live.ts`, `assertSecretsFolderKeyless`).
- [ ] **Owner and Martin.** The sending OAuth client exists: a Web application client, separate from Google sign-in and from the DWD reader. Its consent screen lists exactly `openid`, `email` and `https://www.googleapis.com/auth/gmail.send` (gmail-send-runbook.md, "Configuration", "What the client must have", owner step T1).

## 3. Admin console settings (Day 0)

All **Owner** (a Workspace admin). Do them the day before the runs.

- [ ] **Reader delegation.** Security > Access and data control > API controls > Manage Domain Wide Delegation > Add new. Client ID: the DWD reader account's. Scopes, exactly one: `https://www.googleapis.com/auth/gmail.readonly`. Never `gmail.metadata` (with it on the entry, Gmail refused full reads in the old test tenant), and never `gmail.modify`, `gmail.send`, `mail.google.com` or a Drive scope (admin guide, step 1; demo runbook, "Prerequisites", Reader delegation). T1 also mints this token for `deals@` (team-inbox-guide.md, "The live check (T1)", check 3).
- [ ] **Import delegation.** A second DWD entry, for the seeding account's client ID, with exactly `https://www.googleapis.com/auth/gmail.insert`. The reader entry does not cover it (demo runbook, "Prerequisites", Import delegation). It exists on this Workspace only: a bank never gets a seeding grant.
- [ ] **Directory role.** Account > Admin roles > Create new role with Groups: Read, Reports: Read and Users: Read, and nothing else. Assign it to the directory account. Users: Read is what T1 and every team inbox need; without it every `users.get` answers 403 (admin guide, steps 3 and "Team inboxes: one more role permission"; team-inbox-guide.md, "Reading the rows"). If the role reads only the ingest group, T1's group row answers 403 on `members.list`: widen it to read all groups, or accept the "can't check this address yet" wording.
- [ ] **Sending client trust.** In App access control, mark the sending client **Trusted** for `probe@`'s OU, as the owner's customer guide tells a bank's admin to. T2 step 4 sets it to Blocked and back to Trusted (gmail-send-runbook.md, "Precondition", item 4, and T2 step 4).

## 4. Objects to create (Day 0)

All **Owner** (a Workspace admin). Every address is inside `<dev domain>`: the probe refuses any other (`scripts/google/probe-team-mailbox.ts`, `ARG_OUT_OF_DOMAIN`).

- [ ] **The ingest group.** `conductia-ingest@<dev domain>`, a Google Group (admin guide, step 2; the demo runbook's preflight expects this address).
- [ ] **Its members, direct and by primary address.** Add `deals@` and the three persona mailboxes. A member through a nested group or an alias is refused `not_in_provider_group` (admin guide, step 2; demo runbook, "Prerequisites", Group). T1 expects `directMember=yes` for `deals@`.
- [ ] **An alias** of an existing user, for T1 `--alias`. Expected: `users.get` 200 with `primaryEmailEqualsInput=no`.
- [ ] **A second Google Group** that is not the ingest group, for T1 `--group`. Expected: `users.get` 404, then `members.list` 200.
- [ ] **The suspended user**, suspended, for T1 `--suspended`. Expected: `suspended=yes`.
- [ ] **Write the four T1 addresses down.** The probe never prints them, so the rows mean nothing without the list.

## 5. Local files (Day 1, before the runs)

On the owner's machine, in a `develop` checkout with `npm ci` done. Layout per `.secrets/README.md`; nothing here is ever committed.

```
.secrets/google/
  worker-credentials.json   keyless caller credential
  registration.json         the reader registration
  seeding.json              test domains, seeding account, persona map
```

- [ ] **`worker-credentials.json`**: `external_account`, `impersonated_service_account` or `authorized_user`. Never a service account key (demo runbook, "Prerequisites", Credential). `GOOGLE_APPLICATION_CREDENTIALS` points at it; the terminal guard sets that for the dry runs.
- [ ] **`registration.json`**: `tenantId`, `workspaceDomain` (`<dev domain>`), `serviceAccountEmail`, `directoryServiceAccountEmail`, `clientId`, `allowlistGroup` (`conductia-ingest@<dev domain>`), `firmCompanyId`, `status`, `consentedAt`, and `sources` as a list of `{ address, ownerEmail }`, one per persona mailbox (demo runbook, "Prerequisites", Files). For the dry runs, `tenantId` is the dev tenant the guard exports (`00000000-0000-4000-8000-000000000001`). T1 reads only five fields, and pins its run to `workspaceDomain`.
- [ ] **`seeding.json`**: `testDomains` includes `<dev domain>`; `seedingServiceAccountEmail`; `personas` maps each of the three persona addresses to its mailbox. Every mailbox shares one domain (`scripts/google/lib/seedConfig.ts`). `seed-gmail.ts` refuses a domain not listed here (`scripts/google/lib/live.ts`, `requireLiveRun`).
- [ ] **`.env.local`** exists at the checkout root. `npm run google:probe-team` loads it (`package.json`).

## 6. The three runs (Day 1, in order)

Announce each run to the owner before it starts. Each prints a `LIVE Google run` line before its first Google call.

### Run 1: T1, the team inbox probe

**Owner.** Source: [team-inbox-guide.md, "The live check (T1)"](../03-engineering/team-inbox-guide.md#the-live-check-t1).

1. In a terminal that exports no hosted Supabase values, with `GOOGLE_APPLICATION_CREDENTIALS` set to the keyless credential, run from the repo root:

   ```
   npm run google:probe-team -- --live --confirm-domain <dev domain> \
     --registration .secrets/google/registration.json \
     --alias <alias> --group <group> --suspended <suspended> --shared deals@<dev domain>
   ```

2. **Paste back:** every line that starts with `T1`, and the exit code. The lines hold status codes, Google reason codes, counts and yes/no only, never an address, id, token or mail.
3. Read them against the guide's expected-rows table. A `matches=no` row, `groupMirror=failed` or exit code 1 is a deviation: it goes to the design owner (ADR-0026 decision 7).

A dev-Workspace T1 proves the verifier against real Google answers. Proposed: it does not replace the owner's 2026-10-20 gate, which runs T1 on the firm's own Workspace before its first team inbox is connected (ADR-0026).

### Run 2: Gmail send, T2 step 1

**Owner, with go-ahead.** Source: [gmail-send-runbook.md](../03-engineering/gmail-send-runbook.md), "Owner steps", T2.

Prerequisites, each from the runbook:

- [ ] **A deployment with the feature**: the Preview alias with `[490 8/10]` or later, or the rehearsal script (`ops/wave6-rehearsal/gcp/20-gmail-send-test.py` on `wave6/deploy-rehearsal`) with the same parameters. Run T2 on the alias itself: a connect started on another preview URL is refused as `failed` ("Configuration", redirect URI per environment).
- [ ] **The four values on that environment**: `GOOGLE_SEND_CLIENT_ID`, `GOOGLE_SEND_CLIENT_SECRET`, `GOOGLE_SEND_REDIRECT_URI` (`<alias>/api/v1/mailbox/google/callback`, registered on the client) and `MAILBOX_TOKEN_KEY`, with the `mail_channel` flag on ("Configuration"). The rollout rule holds: `GOOGLE_SEND_*` stays unset until `[490 8/10]` has merged ("Precondition").
- [ ] **The firm domain on record (T14)**: the banker's company has `<dev domain>` in `firm_identity_providers` (provider `google`) or `company_verified_domains`. Without it the connect is refused `no_firm_domain`. Check with the runbook's read-only query ("Firm domain prerequisite (T14)").
- [ ] **The banker test user**: a Conductia user on that deployment whose address is exactly `probe@<dev domain>` (T10, "Known limits"), with `users.is_external = false`. The connect route and the callback refuse an external user (`not_eligible`).
- [ ] **Google lets `probe@` consent.** The client is Trusted for `probe@`'s OU (section 3). If the client is still in Testing, Google lets only the client's listed test users consent, so list `probe@` there (Google's rule for apps in Testing; the runbook does not state it).

Steps:

1. Sign in to the alias as `probe@`. Open Mail settings, then **Connect for sending**.
2. Screenshot Google's consent screen. Note every line it lists besides "Send email on your behalf". Click **Allow**.
3. **Paste back:** the screenshot, the list of extra lines (or "none"), and what Mail settings shows afterwards ("Connected for sending as ..." or the refusal notice with its `reason`).
4. Then T12: the owner updates Step 2 of the customer guide to the lines seen. Steps 2 to 6 of T2 may follow the same day.

### Run 3: the seeded dry runs

**Owner's machine only, never by an agent.** Source: [deal-discovery-demo-runbook.md, "Seeded dry runs on the test Workspace"](../03-engineering/deal-discovery-demo-runbook.md#seeded-dry-runs-on-the-test-workspace-owners-machine-only), where `<test domain>` is `<dev domain>`.

1. Prepare the scratch stack (`project_id` starting `conductia-live`, shifted ports) and `source` the terminal guard in every terminal ("The terminal guard"). Read the `guarded: project_id ...` line before each step.
2. **Owner.** Grant the caller Service Account Token Creator on the seeding account for this run only ("Steps", 4b).
3. Follow "Steps" 1 to 11 as written. The import (step 4) is:

   ```
   node --import tsx scripts/google/seed-gmail.ts --live --confirm-domain <dev domain> \
     --seed tests/fixtures/discovery/demo/gmail-seed.jsonl --phase seeded
   ```

   A new Workspace holds no base mail, so step 6's base seed import is needed for Falcon.
4. **Paste back:**
   - the `guarded: project_id ...` line;
   - step 3's preflight: yes or no for each of its six checks (no file contents);
   - step 4's `Done (seeded): <n> imported, <m> already present` line, and step 6's;
   - step 5's `Tenant <id>: read <n> items from 3 sources, ... <r> refused, ...` line;
   - that a step 7 pass printed `"selected":0`;
   - the row counts of both step 8 queries (both should be empty), or the Message-IDs they list (synthetic, safe to paste);
   - whether the beats were walked (steps 10 and 11).
5. **Owner.** Remove Token Creator on the seeding account when the session ends (step 4b). `supabase stop --workdir "$SB_WORKDIR"`.

## Open items for the owner

1. **Licences and budget.** These checks need 10 licences, or 8 with the proposed reuse. About $225 a year covers about two. Decide the count, or raise the budget.
2. **Whether Storm and Dan need their own seats.** Google Workspace admins are users of that Workspace, so each admin holds a licence. Decide whether they are admins through their own accounts in `<dev domain>`, or whether Guillermo or Marcelo also hold the admin role.
3. **The domain.** Choose `<dev domain>`. Then engineering adds it to `KNOWN_TEST_DOMAINS` in `tests/google/replayHarness.ts`, so no committed recording may name it, and replaces `<dev domain>` in this page.
4. **The Cloud project** for the DWD, directory and seeding accounts. If the emailmask.uk accounts lived in a project that the trial's expiry removed, they are recreated, and every client ID above is new.
5. **The sending client's project (gmail-send-runbook.md T1)**, and the stable Preview alias for its redirect URI (`TODO(owner)` in "Configuration").
6. **The firm company for `probe@`** on the Preview deployment's database, and who adds its `<dev domain>` row (T14).
7. **Dates.** The demo runbook wanted the test Workspace and its seeding grant by Oct 21. That date has passed. Day 0 must fall before the Oct 28 freeze.
8. **T1 scope.** Proposed: a dev-Workspace T1 informs the design; the gate stays T1 on the firm's own Workspace before its first connect (owner decision 2026-10-20, ADR-0026). Confirm or replace.
9. **Revoking the seeding grant** after the demo (O28) now applies to this Workspace.
