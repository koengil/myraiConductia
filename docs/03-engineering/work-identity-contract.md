# Work identity contract (issue #316)

A banker joins and returns with the firm's Google Workspace or Microsoft Entra
account. This page is the contract the code and the tests hold to, and the
list of what is still unproven. It separates what we checked against the
Supabase Auth source and a local stack from what only a hosted project can
prove. The feature flag `work_identity_onboarding` stays **OFF** until every
pending item below is closed.

Sources: the GoTrue (Supabase Auth) source at v2.196.0, cited as
`file.go:line`; the local PKCE probes P-A to P-E (Supabase CLI 2.116,
2026-10-02, recorded in `docs/agent-duo/runs/316-b/log-planner.md`); the plan
`docs/agent-duo/runs/316-c/plan-v1.md`. The regressions live in
`tests/integration/work-identity-broker.test.ts`.

## 1. Desk-verified claims

| # | Claim | Evidence |
|---|---|---|
| C1 | Provider claims live in `auth.identities.identity_data` and are rewritten on every sign-in. `updateUser({ data })` touches only `raw_user_meta_data`, so a user cannot forge a provider claim. | Source; probe P-A |
| C2 | Google's hosted domain is `identity_data.custom_claims.hd` and is present only for Workspace accounts. | `provider/google.go` |
| C3 | Microsoft's `tid` and `oid` land in `custom_claims`; `sub` is top level. With the `common` endpoint any tenant signs in. GoTrue's Azure ID-token parser (`provider/oidc.go` at `v2.196.0`, `IsEmailVerified`) treats the email as verified when `xms_edov` is absent and an email is present. That parser runs only for a Microsoft issuer (`login.microsoftonline.com`); any other issuer, a local mock included, goes through the generic OIDC parser, which stores no `tid`, `acct`, `xms_edov` or `email_verified` unless the token states them. So the hermetic mock states the Azure-parsed `custom_claims` and `email_verified` itself (`e2e/support/mockOidc.ts`), and real Entra tokens are proved only by the dev proof (HQ2). Conductia requires `tid` to equal the firm's mapped tenant and `xms_edov` to be true, and never trusts the email alone. It also reads the optional ID-token claims `acct` (`0` tenant member, `1` guest) and `xms_edov` (Entra emits it only for a Verified domain) from the same `custom_claims`, and reports an organization for an Azure identity only when `acct` is `0` and `xms_edov` is true (section 3; decision log entry proposed in #582 as D97, number to confirm at merge). That `acct` and `xms_edov` arrive in `custom_claims` is read from the source and held by the mock; Entra's real token proves it (HQ2). | `provider/azure.go`, `provider/oidc.go`; `work_identity_org_claim` |
| C4 | Automatic linking runs before any Conductia code. A provider-verified identity whose email matches an existing non-SSO user is linked to that user, including an unconfirmed invited user. A before-user-created hook does not see it. | `DetermineAccountLinking`; probes P-B, P-C |
| C5 | An OAuth session is `aal1`. Only a Conductia TOTP factor raises it to `aal2`. | Source; P-A |
| C6 | Every new auth user, by any path, gets a contained profile (`provisioning = 'contained'`, own tenant, no company). Only `authorize_provisioned_profile` (service role) or a valid acceptance promotes it. `app_metadata` passed to `admin.createUser` is applied after the insert, so the trigger cannot trust it. | Probe P-D |
| C7 | A password written by `PUT /user` or by the admin API deletes the user's other sessions. A bcrypt write in SQL (`extensions.crypt`) works for sign-in and deletes no session, so `accept_invite` deletes the other sessions itself. | `user.go:457-459`, `admin.go:267-270`, `sessions.go:358-360`; credential probes |

## 2. Pending hosted checks

| Id | Check | Owner | Blocks |
|---|---|---|---|
| HQ1 | Google: a Workspace account signs in and `custom_claims.hd` is the firm domain; a consumer Gmail account carries no `hd` and is refused. | Platform | Flag ON |
| HQ2 | Microsoft: the hosted provider uses the tenant-specific URL without a `/v2.0` suffix (`https://login.microsoftonline.com/<tenant>`; a suffix breaks the authorize path and clears the issuer pin), the app registration emits the `xms_edov` optional claim, and `tid` is the firm tenant. A foreign tenant is refused. The flag-on gate is the STOP steps of [`m365-sso-runbook.md`](../04-operations/m365-sso-runbook.md) (version, URLs, hook, claims before accept). | Platform | Flag ON |
| HQ3 | The hosted project runs `public.work_identity_access_token_hook` as the custom access token hook, grants `supabase_auth_admin` and the RPCs what the migration grants locally (read on `auth.flow_state`, `auth.identities`, `auth.sessions`), and the signup setting is confirmed. | Platform | Flag ON |
| SR1 | Independent security review of the hook, the connect flow and the acceptance RPCs. | Security | Flag ON |
| PA4 | Session limits, reauthentication and passwordless recovery while providers are off (section 5). | Banking security owner | Flag ON |
| PM1 | Pilot metrics agreed (completion rate, refusals by code, support contacts). | Product | Pilot exit |

## 3. Linking, issuance and access

**Linking is not access.** Supabase Auth links a same-email identity at the
callback, before Conductia sees anything (C4). Probe P-B showed the link
commits even when the hook refuses the session: the identity row stays and
`app_metadata.providers` gains it. The contract is therefore that a committed,
unbound link confers nothing. Access comes only from a row in
`work_identity_bindings (provider, provider_subject) -> user_id`, written by
one of two paths:

- `accept_work_identity_invite` (via `invite`): a claimed attempt, `aal2`, the
  identity's email verified and equal to the invite's, `hd` or `tid` equal to
  the firm mapping in `firm_identity_providers`, a contained and invited
  profile. Codes: `wrong_account`, `organization_mismatch`, `email_unverified`,
  `attempt_expired`, `attempt_consumed`, `account_not_eligible`.
- `begin_work_identity_connect` then `complete_work_identity_connect`
  (via `connect`): an active `aal2` user links a work account. Completion
  checks the `auth.flow_state` row the link left (P-E: auth code, linking
  target, provider, S256 challenge, issue time), exactly one fresh unbound
  identity, and the email and organization match. Beginning releases the
  user's own stale unbound identities (`work_identity_released`).

**Microsoft seat rule.** Decision: the member-only Microsoft entry proposed in
#582 as D97 (number to confirm at merge: #577, #593 and #601 also claim D97).
Both paths read the
organization from `work_identity_org_claim`. For `azure` it returns the
lower-cased `tid` only when `custom_claims.acct` is `'0'` (a member of that
tenant) and `custom_claims.xms_edov` is `true` or `'1'` (compared
case-insensitively, trimmed). A guest of any kind (`acct` `1`, including a
personal Microsoft account invited as a guest, `idp` `live.com`), a missing
`acct`, and a missing, `false` or `'0'` `xms_edov` report no organization, so
accept and connect refuse with `organization_mismatch` (SQL
`work_identity_mismatch`) and bind nothing. Google is unchanged (`hd`). The rule
is checked when a binding is created or connected. Accepted limitation: a
member later converted to a guest keeps signing in until the binding is
removed.

**Flow binding (F14).** `/auth/work/start` creates the attempt, starts the
PKCE round trip and binds the attempt to that round trip's S256
`code_challenge` (`bind_work_identity_attempt_flow`, service role, set once).
The callback reads the PKCE verifier before the exchange. Only after its own
successful `exchangeCodeForSession` does it call `claim_work_identity_attempt`
through the service role, passing the verifier and the user and session the
exchange just minted. The claim is not executable by `authenticated`, so a
browser session cannot present a verifier for a flow it never exchanged. It
refuses with `attempt_flow_mismatch` unless the verifier hashes to the bound
challenge and the session was created no earlier than the attempt, and with
`session_not_live` unless the session belongs to that user. A session from
flow A cannot claim attempt B, even holding B's cookie secret and verifier.

**MFA.** Any account whose server-owned `app_metadata.providers` holds an
external provider (anything but email and phone) requires Conductia TOTP at
`aal2` in every enforcement mode; upstream MFA never counts.

**Issuance.** `work_identity_access_token_hook` decides every token,
including refresh and MFA step-up:

1. A suspended user is refused with `account_suspended` for every method.
2. An OAuth sign-in, or any later token of a session born from an OAuth
   sign-in (a refresh, a TOTP step-up, or any other method whose `claims.amr`
   lists `oauth`; GoTrue carries `amr` across refreshes and adds to it on a
   step-up), is allowed only if every non-email identity is bound, or
   the user is a pending work invitee (contained, invited, no company, own
   tenant, a pending unexpired `work_identity` invite for the email).
   Otherwise `work_identity_not_connected`. So removing a binding ends the
   session at its next refresh or step-up (fix to #320's contract, which held
   only at the sign-in itself; decision log entry proposed in #582 as D98, number
   to confirm at merge).
3. A session whose `amr` never held `oauth` is unchanged, including a refresh
   or step-up of a password-born session.
4. Every token the hook issues carries `work_identity_hook = 1`. A refusal
   carries no claims.

**Choke points.** Decision: the fail-closed sessions entry proposed in #582 as
D98 (number to confirm at merge). The claim is how the app
knows the hook ran: a project that does not run the hook, or lacks the
migration, issues tokens without it. `enforceWorkIdentityHook`
(`src/lib/auth/workIdentityHook.ts`) applies to a user whose server-owned
`app_metadata.providers` holds anything but email and phone (Google as well as
Microsoft); every other user returns untouched, with no session read. It
decodes the access token's payload (no signature check; `getUser()` has just
validated the session) and needs `work_identity_hook` to equal `1`. A token
without it gets one `refreshSession()`. If the new token still lacks it, or the
refresh fails, the check logs `work_identity_hook_missing`, ends this session
only (`signOut({ scope: 'local' })`) and refuses. The refresh and the sign-out
write cookies, so the check runs only where the response can carry them
(middleware and Route Handlers). It runs right after `getUser()`, before any
AAL logic:

- `src/middleware.ts`: redirect to `/sign-in?error=work_identity_not_connected`.
  Every middleware redirect (sign-in, refusal, the AAL1 redirect to
  `/two-factor`) carries the cookies the request wrote, so a rotated
  single-use refresh token or a local sign-out reaches the browser.
- `/two-factor`: the middleware matches it for this check only (no AAL
  redirect there; an anonymous visitor is left to the page). The page itself
  (`src/app/two-factor/page.tsx`, a Server Component, where cookie writes are
  discarded) repeats a read-only claim check, `checkWorkIdentityHook`, before
  the profile read and any factor enrolment.
- `requireApiUser` (`src/lib/api/v1/http.ts`): 401 with error
  `work_identity_not_connected`, whatever `allowAal1` says, so the AAL1-allowed
  routes (invitation accept among them) are covered too.
- `requireApiUserScoped` (`src/lib/api/v1/httpScoped.ts`): the same 401.
- `/auth/work/connect` and `/auth/work/connect/callback` (the middleware does
  not run on `/auth/work`): before the AAL check and before
  `begin_work_identity_connect` / `complete_work_identity_connect`, a refusal
  redirects to the destination with `error=work_identity_not_connected` and
  binds nothing.
- `/auth/work/callback`, after its own code exchange (it does not refresh: the
  token is the one the exchange just minted). In order: no email on the user
  signs out locally with `provider_failed`; a token without the claim logs
  `work_identity_hook_missing`, signs out locally and answers
  `work_identity_not_connected`; then, unless the profile is a pending isolated
  invitee, `work_identity_has_unbound(user.id)` (service role) reporting an
  unbound identity logs `work_identity_unbound_session`, signs out locally and
  answers `work_identity_not_connected`. An RPC error, a throw or any answer
  other than an explicit `false` counts as unbound. On the invitation path (an
  attempt cookie) `work_identity_not_connected` is shown as `existing_account`.

Rollout precondition: the hook migration `20261018130000` and the hook itself
must be live on every project that has external-provider users before this code
ships there (merge precondition T10), because on such a project the check
refuses every work-identity session. Deploy order: the migration first, then the
app. App first signs out every existing Google and Microsoft user. Production
keeps no migration history table, so check the function, not the history.

The RLS helpers additionally require `app_caller_live()` (not suspended, the
session still exists), so a token issued before suspension reads nothing.

**Unconfirmed-account replacement (F10).** When an unconfirmed legacy invitee
signs in with a provider of the same email, Supabase Auth confirms the
account, replaces `raw_user_meta_data` (the invite id and nonce are gone),
clears the unconfirmed password and removes the other identities
(`external.go:402-418`, `user.go:1019-1049`), then the hook refuses the
session. The invite context, verify and accept answer 409
`invite_context_missing` with "This account was invited by email. Use the
invitation email; if it no longer works, ask the sender to resend it." A
resend (`rotate_invite_credential`) recovers: one seat, and the leftover
unbound identity is still refused. Residual: the replacement itself cannot be
prevented from Conductia code. `scripts/release-unbound-identities.ts` lets
an operator remove the leftover identity.

**Email invitations (F3, F12).** `accept_invite` binds acceptance to the
session that verified the challenge (`challenge_session_mismatch`), enforces
the password policy before writing anything (`weak_password`), writes the
password in the same transaction, deletes every other session and every MFA
factor, and answers a retry with `{ duplicate: true }`.

## 4. Local substitution for tests

Google cannot be redirected locally, so the Google journey and the broker
contract suite use the `keycloak` provider pointed at `e2e/support/mockOidc.ts`
(`http://host.docker.internal:56430/realms/x`). (Earlier revisions of this page
said the `azure` provider accepts only Microsoft issuers; the Microsoft journey
below supersedes that.) Keycloak's userinfo puts every
non-standard claim in `custom_claims` (`provider/keycloak.go`), so the mock's
`hd` and `tid` arrive where Google's and Microsoft's do. The repository's
`[auth.external.keycloak]` block ships `enabled = false`: the CLI cannot read
a boolean from an unset `env()`, so a local run sets `enabled = true` in a
local copy together with `WORK_IDENTITY_MOCK_OIDC_URL` and the hook section,
then restarts the stack. In test mode only, the app and the database treat
`keycloak` as an alias of the mapped provider: the app substitutes it only when
`WORK_IDENTITY_TEST_BROKER_PROVIDER=keycloak` and `NEXT_PUBLIC_SUPABASE_URL` is
a loopback host (the hermetic e2e runs a production build, so `NODE_ENV`
cannot be the guard), and the database only through a service-role-seeded
`work_identity_broker_aliases` row. The browser journey
`e2e/journeys/work-identity-onboarding.spec.ts` (opt-in `E2E_WORK_IDENTITY=1`)
maps `host.docker.internal` to loopback in its own browser. This substitution proves the
broker behavior, not Google's or Microsoft's claims; that is HQ1 and HQ2.

**Microsoft journey (azure against the mock).** The same journey runs with
`E2E_WORK_IDENTITY_PROVIDER=azure` against the REAL `azure` provider, with no
keycloak substitution: `WORK_IDENTITY_TEST_BROKER_PROVIDER` is unset and there is
no `work_identity_broker_aliases` row, so `auth.identities` rows are provider
`azure`. The provider takes a `url`; GoTrue derives `<url>/oauth2/v2.0/{authorize,token}`
from it and, for a host that is not Microsoft's, clears its expected issuer
(`provider/azure.go`). `supabase/config.toml` ships an `[auth.external.azure]`
block with `enabled = false` and `url = env(WORK_IDENTITY_MOCK_AZURE_URL)`
(`http://host.docker.internal:56430/<tenant>`); like keycloak's, the CI job
enables it in its own checkout. The mock's Azure dialect serves tenant-scoped
v2.0 discovery, the authorize and token endpoints, a JWKS and an RS256
`id_token` carrying `tid`, `acct`, `xms_edov` and `email`. The provider reads
user data only from that token, but GoTrue applies its Azure parsing only to a
Microsoft issuer (C3), so the token also states the `custom_claims` and
`email_verified` that `parseAzureIDToken` and `IsEmailVerified` would derive;
`tests/mock-oidc-azure.test.ts` pins that shape without a stack. The journey asserts the Microsoft cases
(member, guest, no `xms_edov`, foreign tenant, uninvited, and a refresh refused
once the binding is gone) and that the stored identity is provider `azure` with
the mock's `tid` and `acct` in `custom_claims`. The spike is done: the
CLI's bundled GoTrue (`v2.196.0`) accepts the mock issuer, and
`e2e_work_identity` passed every Microsoft case on run 39088341993 with the
real `azure` provider. The limit stands: the hermetic job proves the app and the
SQL rules against the claims GoTrue would store, not what a real Entra token
carries or how GoTrue parses one; that is the dev proof's (HQ2). The repository
variable `WORK_IDENTITY_E2E_PROVIDER=keycloak` still selects the fallback, where
keycloak stands in for `azure` with the same Azure-shaped `custom_claims`.

## 5. Session, reauthentication and recovery (PA4)

Owner: the banking security owner. Open slots, each a release blocker for
the flag:

- Maximum session age and idle timeout for work-identity sessions.
- Reauthentication before sensitive acts (MFA reset, connect, invitations).
- Recovery for a banker who has no password while providers are disabled
  (rollback below). Until decided, rollback strands passwordless bankers.

## 6. Operational rollback (1i)

1. Turn `work_identity_onboarding` OFF: the work routes return 404, delivery
   refuses work invitations (409 `work_identity_disabled`), and the operator
   script revokes pending ones.
2. Disable the hosted Google and Microsoft providers.
3. Keep the hook, the bindings and containment: they only refuse. Do not
   disable the hook or revert migration `20261018130000` while the app that
   requires the `work_identity_hook` claim is deployed: every work-identity
   session would then be refused (section 3).
4. The destructive down migration
   `supabase/rollback/20261002100000_work_identity_onboarding.sql` refuses to
   run while any binding, work invitation or contained profile exists.
