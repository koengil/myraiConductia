# Microsoft 365 sign-in runbook (owner steps, dev proof)

How the owner takes an empty Entra app registration to evidence-backed Microsoft work-account sign-in on the **dev** Supabase project, and takes it all down again the same day. Written for issue #316 (secure Google and Microsoft work-account sign-in, behind the default-off `work_identity_onboarding` flag) and the Tidewell Pike Advisors M365 test tenant, which expires on 2026-10-24. Status: Proposed. The decisions behind it are D69 and D98 (number to confirm at merge) in `docs/07-decisions/decision-log.md`; the contract is [`work-identity-contract.md`](../03-engineering/work-identity-contract.md).

This is **dev only**. Do not run it against staging or production. Code PRs 1/6 (the hook adds a claim and rechecks refresh, Azure binds tenant members only) and 2/6 (work-identity sessions without the claim are refused at every choke point) must be merged **and deployed on every project that has external-provider users before the flag goes on anywhere but this dev proof**. The STOP steps below are the operational equivalent of that code for the proof itself: they check by hand what the code will check on every request.

The conventions follow [`csp-runbook.md`](./csp-runbook.md):
- A step marked "(human step)" is done by the owner in a browser console or a shell, never by an agent or a CI job.
- `<placeholders>` are values you fill in. No secret value is written in this page, and none is pasted anywhere except the Supabase dashboard field or your own shell.
- Every step ends with a `Verify:` line.
- A step marked **STOP** names its check, where to look, what good looks like, and the remedy. If the check fails and the remedy does not clear it: Do not continue. If the flag is on, turn it off and go to Teardown. Teardown is step 9, and its lines for things you have not done yet are no-ops: skip them.

Placeholders used throughout:

| Placeholder | Meaning |
|---|---|
| `<dev-ref>` | The dev Supabase project ref. The project is shared by `develop` and every preview deployment, so everything below changes it for all of them |
| `<dev publishable key>` | The dev project's publishable (anon) key, sent as the `apikey` header. Not a secret, but do not paste it into the repo |
| `<origin>` | The `develop` deployment's origin, the only app origin permitted for this proof. Never a preview origin |
| `<tenant-id>` | The Tidewell Entra tenant id (directory id) |
| `<test firm company id>` | The company id of the test firm the proof maps to the tenant |
| `<firm admin id>` | The user id of an active firm admin or director of that company |
| `<user A>`, `<user B>` | Two Tidewell users. A is invited and accepts. B is assigned to the app, never invited, and must be refused |
| `<user A id>`, `<user B id>` | Their Supabase user ids on dev, from Authentication, Users, recorded in step 8 |

## 1. Preconditions (STOP)

All four checks must pass before you register or configure anything.

1. **Supabase Auth version.** The issuer pin that ties sign-in to one tenant exists only from Auth `v2.190.0`.

   ```bash
   curl -s -H "apikey: <dev publishable key>" https://<dev-ref>.supabase.co/auth/v1/health
   ```

   Good: the `version` field is `v2.190.0` or later. Remedy: open Project Settings, Infrastructure, check for an Auth upgrade and apply it (the project restarts), then run the curl again. This STOP cannot be waived: the proof claims the issuer pin, and below `v2.190.0` there is none to prove. If no upgrade is available or it cannot be applied, stop here. Write a short note in the evidence record (the version you saw and why the upgrade did not run). The note only records why the proof did not run; it never lets it continue.

2. **Migrations.** `20261002100000` and `20261010100000` are applied on dev. In the SQL editor:

   ```sql
   select version from supabase_migrations.schema_migrations
    where version in ('20261002100000', '20261010100000') order by version;
   ```

   If `supabase_migrations.schema_migrations` is not readable from your role, check a function each migration creates instead:

   ```sql
   select
     to_regprocedure('public.work_identity_access_token_hook(jsonb)') is not null as has_20261002100000,
     to_regprocedure('public.work_identity_has_unbound(uuid)') is not null      as has_20261010100000;
   ```

   Good: both rows, or both columns true. Remedy: apply the missing migration through the normal deploy path, then re-run.

3. **Record the signup setting and the URL settings. Change nothing yet.** A first-ever Microsoft sign-in creates an auth user, so signups must be allowed for the proof, but they are switched on only in step 4, after the hook gate: Supabase's own OAuth endpoints do not read the app flag, so with signups on and a provider enabled, a sign-in can create a dev user before any Conductia check runs. Record the current values in the evidence record **first**, because Teardown restores them. Read them in the dashboard (Authentication, Sign In / Providers, "Allow new users to sign up"; Authentication, URL Configuration) or from the Management API:

   ```bash
   curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
     https://api.supabase.com/v1/projects/<dev-ref>/config/auth | jq '{disable_signup, site_url, uri_allow_list}'
   ```

   `disable_signup: true` means signups are off. Good: `disable_signup`, `site_url` and `uri_allow_list` as they are now are in the evidence record. Do not switch signups on here.

4. **Origin and redirect URLs.** GoTrue silently falls back to the Site URL when a redirect is not allowlisted (`production-bootstrap.md`, section 3, "Configure the hosted project's auth URLs"). `<origin>` is the `develop` deployment's origin: it is the only origin permitted for this proof, and a preview deployment is not. In Authentication, URL Configuration:
   - **Site URL** equals `<origin>`.
   - **Redirect URLs** include `<origin>/**`. The `/**` is what covers `/auth/work/callback`.
   - **`NEXT_PUBLIC_APP_URL`** on the `develop` deployment equals `<origin>`, or is unset (the work routes then use the host the request arrived on, which is `<origin>` when you open it there). Never a different origin.

   The dev project is shared by `develop` and every preview deployment ("A project shared by several deployments" in `production-bootstrap.md`), and its Site URL is normally already the `develop` origin. If the Site URL or the Redirect URLs need a change to match, make it now and note it in the evidence record next to the values you recorded in point 3: Teardown reverts it. Remedy for a proof planned on a preview: run it on `develop` instead.

If any check fails and its remedy does not clear it: Do not continue. If the flag is on, turn it off and go to Teardown.

Verify: the health version is at or above the floor, both migrations are listed, the signup and URL values are recorded, and the three URL settings match `<origin>`.

## 2. Hook gate (STOP)

The custom access token hook is the runtime gate that refuses an OAuth identity with no binding. It is not flag-gated, and it must be live and locked down before the Azure provider and signups go on in step 4.

- **Record first, before you enable anything.** The hook runs for every sign-in on the whole dev project, not only this proof, so enabling it can refuse an existing OAuth identity that has no binding (a Google user on a preview, for example). Record in the evidence record the hook's current state (the two fields from the Management API call below, as they read now) and the count of non-email, non-phone identities on dev:

  ```sql
  select provider, count(*) from auth.identities where provider not in ('email', 'phone') group by 1;
  ```

  If the hook was off and that count is not zero, those users' next OAuth sign-in is refused unless their identity is bound. Tell whoever owns them (Martin, for Google sign-in) before you enable it.
- **Where.** Authentication, Hooks, "Customize Access Token", or the Management API:

  ```bash
  curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    https://api.supabase.com/v1/projects/<dev-ref>/config/auth | jq '{hook_custom_access_token_enabled, hook_custom_access_token_uri}'
  ```

  Good: `hook_custom_access_token_enabled` is true and the URI is `pg-functions://postgres/public/work_identity_access_token_hook`.
- **Who may run it.** In the SQL editor:

  ```sql
  select
    has_function_privilege('supabase_auth_admin', 'public.work_identity_access_token_hook(jsonb)', 'execute') as auth_can_run,
    (has_function_privilege('anon', 'public.work_identity_access_token_hook(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.work_identity_access_token_hook(jsonb)', 'execute')) as browser_can_run;
  ```

  Good: `auth_can_run` true and `browser_can_run` false.
- **Remedy.** Hook off or pointing elsewhere: enable it in the dashboard with that function, then re-check. The function missing: a migration from step 1 is not applied. `browser_can_run` true: the grants were widened, so re-apply the migration's revokes. Then run the checks again.

If any check still fails: Do not continue. If the flag is on, turn it off and go to Teardown.

Verify: the prior hook state and the identity count are recorded, and both the Management API fields and the SQL row read good.

## 3. Register the Entra app (human step)

In the Entra admin center for the Tidewell tenant. This is a **separate app** from the Graph reader app used for mailbox capture (`scripts/m365/README.md`). Do not reuse the reader app or its credentials.

1. App registrations, New registration. Supported account types: **single tenant** (this directory only). Single tenant means Entra itself refuses accounts from other tenants, and it is what lets the Supabase issuer pin hold.
2. Redirect URI: platform **Web**, value `https://<dev-ref>.supabase.co/auth/v1/callback`. This is the Supabase Auth callback, not an app URL.
3. Token configuration, Add optional claim, token type **ID**: add `email`, `xms_edov` and `acct`. Accept the prompt to add the Graph `email` permission.
   - `xms_edov` says whether the email domain is verified. Without it, GoTrue treats the email as verified, so Conductia refuses to bind a Microsoft identity that lacks it.
   - `acct` says whether the user is a tenant member (`0`) or a guest (`1`). Conductia binds members only (D98).
4. API permissions: Microsoft Graph delegated `openid`, `email`, `profile`, then **Grant admin consent** for the tenant.
5. Enterprise applications, the app, Properties: set **Assignment required** to Yes. Users and groups: assign **only** user A and user B.
6. Certificates and secrets, New client secret, expiry **2026-10-24** (the tenant's end). Copy the secret **Value** (not the Secret ID) straight into the Supabase field in step 4. It is shown once.
7. **Mail addresses on a Verified domain.** `xms_edov` is true only when the user's email claim is on a domain marked **Verified** in the tenant (Entra, Domain names, "Custom domain names"; the default `onmicrosoft.com` domain counts). Give users A and B a mail address on a Verified domain. **Invite A at that mail address, not the UPN** if the two differ: the invite email must equal the `email` claim, and the claim carries the mail address.

Verify: the app shows Single tenant, one Web redirect URI, ID-token optional claims `email`, `xms_edov` and `acct`, admin consent granted, Assignment required Yes with exactly users A and B, a secret expiring 2026-10-24, and both users show a mail address on a Verified domain.

## 4. Configure the dev Azure provider and allow signups (human step)

Only after the hook gate (step 2) passed. In the dev project: Authentication, Sign In / Providers, Azure.

- **Enable** it.
- **Client ID**: the app's Application (client) ID.
- **Client Secret**: the secret **Value** from step 3.
- **Azure Tenant URL**: `https://login.microsoftonline.com/<tenant-id>`, **without** a `/v2.0` suffix. GoTrue appends the endpoint paths itself, so a `/v2.0` suffix breaks the authorize path and also clears the issuer pin. (The contract page used to show the URL with a suffix; that was wrong.)
- **Allow users without an email**: off.

Then switch "Allow new users to sign up" on (Authentication, Sign In / Providers). The value it had before is the one you recorded in step 1 point 3.

Verify: this prints only these fields (never the secret), `external_azure_enabled` is true, `external_azure_url` is exactly the tenant URL above, and `disable_signup` is false.

```bash
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  https://api.supabase.com/v1/projects/<dev-ref>/config/auth | jq '{external_azure_enabled, external_azure_url, disable_signup}'
```

## 5. Flag on, map the firm (human step)

1. Turn the flag on for the dev project. It is a row, so it is on for **every** deployment that reads dev, not only `<origin>`:

   ```sql
   update feature_flags set enabled = true where key = 'work_identity_onboarding' returning key, enabled;
   ```

   Good: one row, `enabled` true. Zero rows means the flag row does not exist on dev: the flag seed (`scripts/seed-flags.ts`, see `production-bootstrap.md`) has not run there, and the update changed nothing. Do not continue. If the flag is on, turn it off and go to Teardown.

2. Map the test firm to the tenant. `node --env-file` does not override a variable already exported in your shell, so the command first unsets the hosted Supabase variables (`env -u`), and `EXPECT_SUPABASE_REF` makes the script exit before any call when the URL's project ref is not `<dev-ref>`. It then prints `Target: supabase <dev-ref>`.

   ```bash
   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
     EXPECT_SUPABASE_REF=<dev-ref> ACTOR_ID=<firm admin id> COMPANY_ID=<test firm company id> \
     PROVIDER=azure ORGANIZATION_ID=<tenant-id> \
     node --env-file=.env.<dev> --import tsx scripts/set-firm-identity-provider.ts
   ```

   A refusal reads `EXPECT_SUPABASE_REF must be set` or `Target is supabase <ref>, but EXPECT_SUPABASE_REF is <dev-ref>; nothing was changed`. Fix the env file or the shell and run it again.

3. As the firm director, invite user A to the deal from Team, at A's Verified-domain mail address. With the flag on and the firm mapped, the invite is a work-identity invite: one email linking to `/join`.

Verify: `/sign-in` on `<origin>` shows "Continue with Microsoft", and this returns one pending `work_identity` row for the test firm:

```sql
select auth_method, status from invites
 where company_id = '<test firm company id>' and status = 'pending';
```

## 6. Sign in, check claims before accepting (STOP)

1. In a private window, open the invite link from user A's mailbox. On `/join`, choose "Continue with Microsoft" and sign in as user A.
2. Enrol Conductia TOTP on `/two-factor`. You land on `/join/confirm`.
3. **Pause there. Do not press Accept.** Run this in the SQL editor. It reads the stored identity of the pending invitee of the test firm and returns key names, types and booleans only, never a claim value:

   ```sql
   select
     i.user_id,
     jsonb_typeof(i.identity_data #> '{custom_claims,tid}')      as tid_type,
     jsonb_typeof(i.identity_data #> '{custom_claims,acct}')     as acct_type,
     jsonb_typeof(i.identity_data #> '{custom_claims,xms_edov}') as xms_edov_type,
     coalesce(lower(i.identity_data #>> '{custom_claims,tid}') = f.organization_id, false)            as tid_matches_firm,
     coalesce((i.identity_data #>> '{custom_claims,acct}') = '0', false)                              as acct_member,
     coalesce((i.identity_data #>> '{custom_claims,xms_edov}') in ('true', '1'), false)               as xms_edov_true,
     coalesce(nullif(i.identity_data ->> 'email', '') is not null, false)                             as email_present,
     (select array_agg(k order by k)
        from jsonb_object_keys(coalesce(i.identity_data -> 'custom_claims', '{}'::jsonb)) as k)      as custom_claim_keys
   from public.invites v
   join public.firm_identity_providers f on f.company_id = v.company_id
   join auth.users u on lower(u.email) = lower(v.email)
   join auth.identities i on i.user_id = u.id and i.provider = 'azure'
   where v.company_id = '<test firm company id>' and v.status = 'pending' and v.auth_method = 'work_identity';
   ```

Good: one row, and `tid_matches_firm`, `acct_member`, `xms_edov_true` and `email_present` are all **true**. Save the row (it holds a user id and no claim value) in the evidence record.

Remedy by column:
- No row: the sign-in did not reach the callback. Re-check step 4 (provider enabled, secret Value) and step 1 point 4 (redirect URLs).
- `tid_matches_firm` false: the mapping's `ORGANIZATION_ID` is not the tenant id, or you signed in with an account from another tenant. Fix the mapping (step 5) or the account.
- `acct_member` false: the account is a guest. Use a tenant member. Members only is the rule (D98).
- `xms_edov_true` false: the `xms_edov` optional claim is missing from the ID token (step 3 point 3), or the mail address is on a domain that is not Verified (step 3 point 7). The type column shows whether the claim arrived at all.
- `email_present` false: the `email` optional claim is missing, or the user has no mail address.

If any of the four stays false: Do not continue. If the flag is on, turn it off and go to Teardown. Never press Accept on a failing row: the accept function in this version does not yet require `acct` or `xms_edov` (code PR 1/6 adds that), so this step is the only check on them.

Verify: the four booleans are true and the row is saved.

## 7. Accept and return (human step)

1. In the same window, press Accept on `/join/confirm`. Good: you land on the deal.
2. Sign out. From `/sign-in`, choose "Continue with Microsoft" as user A. Good: after TOTP you land on the deal list.
3. In a fresh private window, choose "Continue with Microsoft" from `/sign-in` as user B (assigned in Entra, never invited). Good: you land on `/sign-in?error=work_identity_not_connected`. B cannot hold a session.
4. **Optional T1: a foreign tenant, as a short window.** Only if you hold a work account in another Entra tenant, and only in one sitting. Switch the Entra registration to multi-tenant and the dev Azure Tenant URL to `https://login.microsoftonline.com/organizations`. Invite that account to the test firm, sign in with it, and expect `organization_mismatch` on accept. Then **switch both back in the same sitting**. The window clears the issuer pin, and with signup on any Entra account could create a dev user during it, so skip this if in doubt. Before step 8, check that `external_azure_url` is the tenant URL again, with the step 4 curl and jq. Do not continue to step 8 until it is.

Verify: A reaches the deal twice (accept, then a fresh sign-in), B is refused with `work_identity_not_connected`, and if T1 ran the URL check reads the tenant URL.

## 8. Record the evidence (human step)

Fill the template at the end of this page.
- Claim shape: the step 6 row, nothing else from the claims.
- The result of each step (pass or fail) with the date.
- The user ids of A and B (B's from the dashboard, Authentication, Users). Teardown point 9 lists the rows that stay.
- Screenshots go in the owner's store, **not** in git, with tenant ids, addresses and codes blurred: the Entra Token configuration and Assignment pages, the dev Azure provider page with the secret hidden, the Hooks page, `/join/confirm`, the deal after sign-in, B's refusal, and the Teardown outputs.
- If step 1 stopped the proof, the note saying why, and nothing else.

Verify: every field of the template is filled, and nothing in it is a claim value, address, tenant id or secret.

## 9. Teardown, same day (human step)

Do this the same day, in this order. A leftover provider with a live secret is a standing way in.

1. **Flag off.** `update feature_flags set enabled = false where key = 'work_identity_onboarding' returning key, enabled;` Good: one row, `enabled` false.
2. **Disable the Azure provider** in the dev project (Authentication, Sign In / Providers, Azure, off).
3. **The hook stays on.** Proposed: leave the access token hook enabled whatever its state before the proof. It only refuses, and it is the gate code PRs 1/6 and 2/6 need live on dev (the Next tenant table below). Turning it off again would let any unbound OAuth identity sign in. The one exception is the owner's call: if step 2 recorded the hook as off and enabling it refused identities someone relies on, the owner may turn it off and record why. Write which, and why, in the evidence record.
4. **Delete the Entra client secret** (app registration, Certificates and secrets). If T1 ran, also set the registration back to single tenant.
5. **Check the provider is off.** The settings endpoint needs the `apikey` header:

   ```bash
   curl -s -H "apikey: <dev publishable key>" https://<dev-ref>.supabase.co/auth/v1/settings | jq '.external.azure'
   ```

   Good: `false`. Then confirm the authorize endpoint no longer starts a Microsoft sign-in:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "https://<dev-ref>.supabase.co/auth/v1/authorize?provider=azure"
   ```

   Good: not `302`. A `302` means a redirect to Microsoft is still live: go back to point 2.
6. **End A's and B's sessions.** Deleting a session also deletes its refresh tokens, so neither user can refresh. In the SQL editor:

   ```sql
   delete from auth.sessions where user_id in ('<user A id>', '<user B id>');
   select count(*) as sessions_left from auth.sessions where user_id in ('<user A id>', '<user B id>');
   ```

   Good: `sessions_left` is `0`.
7. **Restore the signup and URL settings** to the values you recorded in step 1 point 3: "Allow new users to sign up" back to its recorded value, and, if step 1 point 4 changed the Site URL or added `<origin>/**` to the Redirect URLs, the recorded Site URL and Redirect URLs. Read them back and compare with the record:

   ```bash
   curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
     https://api.supabase.com/v1/projects/<dev-ref>/config/auth | jq '{disable_signup, site_url, uri_allow_list}'
   ```

   Good: all three equal the recorded values.
8. **Revoke pending work invitations**, then **remove the mapping**. The same guard as step 5 point 2: hosted variables unset, `EXPECT_SUPABASE_REF=<dev-ref>`, and each script exits before any read or write on another ref.

   ```bash
   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
     EXPECT_SUPABASE_REF=<dev-ref> ACTOR_ID=<firm admin id> COMPANY_ID=<test firm company id> CONFIRM=1 \
     node --env-file=.env.<dev> --import tsx scripts/revoke-work-identity-invites.ts

   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
     EXPECT_SUPABASE_REF=<dev-ref> ACTOR_ID=<firm admin id> COMPANY_ID=<test firm company id> PROVIDER=none \
     node --env-file=.env.<dev> --import tsx scripts/set-firm-identity-provider.ts
   ```

9. **Leave rows A and B in place. Nothing is archived; these rows stay as they are.** With the provider off and no session left, neither user can sign in by any method (neither has a password or an email identity). Their user ids are in the evidence record.
   - User A: the `auth.users` row; its `azure` row in `auth.identities`; the `public.users` row (status `active`, `company_id` the test firm); the `work_identity_bindings` row (provider `azure`, via `invite`); the `deal_memberships` row for the invited deal, so A still shows on that deal's Team roster; the invite (status `accepted`), the consumed `work_identity_attempts` row and the `audit_log` rows.
   - User B: the `auth.users` row created at B's first sign-in; its unbound `azure` row in `auth.identities`; the contained `public.users` profile (status `invited`, no company). No binding, membership or invite.
   - The revoked invites and the removed mapping stay in `audit_log`.

Verify: the flag row reads false, the hook state is recorded, the settings curl returns `false`, the authorize curl is not `302`, `sessions_left` is `0`, the signup and URL settings match the recorded ones, and the mapping and pending invitations are gone. Tick each in the evidence record.

## Next tenant (Ignatious)

Before the same proof runs on another project, such as the Ignatious tenant, fill this table. It is the same table as the merge precondition of code PR 2/6, because that PR refuses any Google or Microsoft session whose token lacks the hook's claim:

| Hosted project | Hook gate passed (step 2) | Code PR 1/6 migration applied | Who checked, when |
|---|---|---|---|
| dev | | | |
| staging | | | |
| production | | | |
| Ignatious Google sign-in project | | | |
| any other project with Google or Microsoft users | | | |

A project with no external-provider users is marked "none". Then run steps 1 to 9 on that project with its own app registration, ref and tenant. A project serves one Azure provider and one tenant URL; serving several firms needs a different shape (multi-tenant app, `organizations`, and the SQL `tid` check as the only tenant gate) and a decision first. Links to the merged code PRs and the filled table are added here when they land.

## Evidence record template

Copy into a comment on #316 or a file the owner names. No claim values, addresses, tenant ids or secrets.

| Field | Value |
|---|---|
| Date and operator | |
| Dev project ref prefix | |
| Auth version (step 1) | |
| Stopped at step 1? If so, why (the note) | no / yes (note) |
| Signup setting before the proof | on / off |
| Site URL and Redirect URLs before the proof, and any change step 1 point 4 made | |
| Hook before the proof (step 2): enabled, URI | |
| Non-email, non-phone identities on dev before the proof (step 2): provider, count | |
| Hook gate (step 2): `auth_can_run`, `browser_can_run` | |
| Claim shape (step 6): `tid_type`, `acct_type`, `xms_edov_type`, the four booleans, `custom_claim_keys` | |
| User A id, user B id | |
| Step 7: A accepted, A returned, B refused, T1 run (yes / no / result) | |
| Teardown 1 flag off | pass / fail |
| Teardown 2 provider disabled | pass / fail |
| Teardown 3 hook: stays on / turned off, and why | |
| Teardown 4 Entra secret deleted | pass / fail |
| Teardown 5 settings `azure` false, authorize not 302 | pass / fail |
| Teardown 6 sessions of A and B deleted, `sessions_left` 0 | pass / fail |
| Teardown 7 signup, Site URL and Redirect URLs restored to the recorded values | pass / fail |
| Teardown 8 invites revoked, mapping `none` | pass / fail |
| Teardown 9 rows of A and B left as listed | pass / fail |
| Screenshots stored at (location, not a URL in git) | |
