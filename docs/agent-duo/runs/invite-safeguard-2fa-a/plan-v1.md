---
run_id: invite-safeguard-2fa-a
type: plan
round: 1
source: spec-v2.md
---

# Technical plan, round 1

## Frozen baseline

`spec-v2.md` is the approved and frozen product contract. This plan maps every
acceptance criterion without changing it. The implementation remains in the platform
and auth layer beside the typed ConductiaAPI seam. It does not add M&A content to that
seam or move existing product data around it.

## Approach

### 1. Trusted company domains and a server-enforced send decision

Add trusted company-domain reference data as a separate tenant-scoped relation rather
than overloading the existing company row. Each row contains a normalized ASCII domain,
the company and tenant it belongs to, its operations-supplied provenance, and timestamps.
Only server and service-role code writes this data. No user-facing administration path is
added. Controlled seed and sandbox companies receive documented domains through the seed
scripts; every other company has an empty set and therefore follows the confirmation path.

Normalize recipient domains to lowercase ASCII with Node's IDNA conversion before the
server reaches the database. A match is an exact configured domain or a subdomain of it.
The configured value must be a registrable institutional domain, never a public suffix.
Known consumer-mail domains are classified as personal and never match. Trust is never
inferred from any inviter, member, or recipient address.

Add `POST /api/v1/invites/preflight`, behind `platform_onboarding` and the existing
`userCanInvite` authorization. It accepts the same email, company, and optional deal
context as invite creation. It returns a scope-safe classification and the normalized
email. It does not disclose configured domain values. A match needs no confirmation. A
mismatch, unknown domain, or personal domain returns a one-time confirmation identifier
bound to the actor, tenant, exact normalized email, company, optional deal, and current
domain classification snapshot. The identifier expires after 60 minutes.

The inviter confirms the warning in the UI and submits that identifier with invite
creation. The redefined `create_invite` RPC recomputes the current classification while
holding the relevant rows, validates and consumes the confirmation when one is required,
and writes the mismatch-override audit in the same transaction that creates the invite.
Direct POSTs, replay, cross-user use, edited values, expiry, and a domain-data change all
fail before an invite row or credential is created. A now-matching address proceeds
without consuming a stale confirmation.

Working Group runs preflight after the inviter enters the exact email, company, and role.
It sends matching addresses directly and presents statement-form correction and confirm
actions for every other classification. Changing email, company, or role clears the
decision. Gate 0 performs the same preflight before a chip can enter the queue, stores the
opaque confirmation identifier on that immutable chip, and revalidates all queued chips
before deal creation. An expired or changed decision returns the user to confirmation and
prevents automatic send. Invite creation consumes the identifiers after the deal exists.

### 2. Independent recipient challenge and confidential acceptance sequence

Generate a cryptographically random six-digit code in server-only code for every new
credential. Store only a keyed digest, using a required
`INVITE_VERIFICATION_PEPPER`, plus challenge version, failure count, lock state,
verified recipient, and verification time. Plain codes exist only in the request process
that generated them and the immediate success response to the authorized inviter. They
never enter auth metadata, URLs, email, database rows, logs, audit metadata, or telemetry.
The creation and resend APIs return a code only after delivery is truthfully finalized as
sent. A failed delivery withholds the code and uses resend as the only recovery.

Extend the invite RPCs in a new migration rather than editing historical migrations:

- `create_invite` receives a code digest and the optional domain confirmation. It creates
  the pending invite, consumes a required mismatch confirmation, and records challenge
  issuance without exposing secret material.
- `rotate_invite_credential` receives a fresh digest, rotates the link nonce, increments
  the challenge version, resets attempts and lock state, and clears any successful but
  unaccepted verification. Old links and old codes become unusable in one transaction.
- `verify_invite_challenge` is session-bound and executable only by authenticated users.
  It locks the invite, validates pending and sent state, expiry, current nonce, tenant,
  authenticated email, and authenticated user. It compares the submitted keyed digest,
  records success for that user without changing membership or user status, or increments
  the failure count. The fifth failed attempt locks the challenge. Concurrent attempts,
  resend, verification, and acceptance serialize on the invite row.
- `accept_invite` additionally requires a current successful verification for the same
  user and credential version. It retains the existing single-winner transaction for user
  activation, company membership, optional phase-0 deal seat, and grant/accept audits.
  Legacy pending rows without a challenge can never pass and require resend.

Add `POST /api/v1/invites/verify`, using the same server-owned invite ID and nonce from
auth metadata as acceptance. It accepts only the six-digit code and maps all invalid,
locked, expired, superseded, wrong-email, wrong-tenant, and closed states to concise,
non-oracular responses. The existing context endpoint returns only generic state and the
addressed email until current verification succeeds. After success it returns inviter,
company, deal, and proposed-role context for review. The accept endpoint remains the sole
grant step.

Change delivery to a generic Conductia action notice. Its subject and body contain no
inviter, company, deal, mandate, or role. Simplify the delivery input so accidental use of
those fields is impossible. The acceptance UI becomes an explicit sequence:

1. establish the session from the invite credential and strip the URL secret;
2. display only the addressed email and generic trusted-channel instructions;
3. verify the code;
4. fetch and display the unlocked context, collect account details, and explicitly accept;
5. redirect to the platform two-factor completion page before any project route.

Working Group creation, Working Group resend, and the Gate 0 creation receipt each display
the fresh code once with precise trusted-channel instructions and a copy affordance. The
code remains only in React memory for that response. Leaving or dismissing that surface
removes it. Resend is the only way to obtain a fresh display after dismissal.

### 3. Platform-wide Supabase TOTP assurance boundary

Add `/two-factor` as the only AAL1 completion surface outside invite verification and
acceptance. Its server page requires a Supabase user, redirects still-contained invited
users to `/accept-invite`, and passes only a sanitized internal destination to the client.
The client uses Supabase Auth MFA APIs directly:

- with no verified TOTP factor, clear stale unverified enrollments, enroll one factor,
  render the Supabase QR and manual secret, and verify a six-digit authenticator code;
- with verified factors, let the user select a factor when more than one exists, create a
  challenge, and verify the authenticator code;
- after Supabase reports AAL2, record the non-secret enrollment or challenge event and
  continue to the sanitized destination;
- keep invalid, expired, and reused codes on the page with retry and sign-out actions.

The ordinary sign-in page redirects a successful password sign-in to `/two-factor` with
the original safe internal destination rather than entering the app directly. Invite
acceptance does the same after the atomic accept transaction.

Enforce assurance at both independent boundaries:

- Browser middleware checks the authenticated user's Supabase authenticator assurance.
  Anonymous users still go to sign-in. AAL1 users requesting an authenticated shell route
  go to `/two-factor`; AAL2 users proceed. `/two-factor`, `/accept-invite`, sign-in,
  sign-out, public, static, and development-only paths retain narrowly stated handling.
  Existing AAL1 sessions are therefore gated on their next protected request.
- `requireApiUser` requires AAL2 by default and returns a stable JSON `403 mfa_required`
  response for AAL1 sessions. Only invite context, verification, and acceptance opt into
  `allowAal1`, while the existing invited-user containment remains in force. The public
  OpenAPI and role catalog and the independently secret-authenticated inbound webhook are
  documented non-user exceptions. A repository audit verifies that no protected v1 route
  bypasses `requireApiUser`.

Add `POST /api/v1/auth/mfa/complete`, outside `platform_onboarding`, requiring AAL2 and
recording `mfa_enrolled` or `mfa_challenged` without factor IDs, QR secrets, or codes. The
2FA UI never treats this audit request as the source of assurance; Supabase AAL remains
authoritative. A failed audit write is surfaced and retried without downgrading the AAL2
session.

The onboarding feature flag continues to return 404 for invite safeguard routes and to
preserve the pre-PR-124 invite-off behavior. It does not gate sign-in, the two-factor page,
middleware assurance, API assurance, or MFA audit behavior.

### 4. Auditing and secret discipline

Extend the audit action constraint and TypeScript constants with:

- `invite_domain_override`
- `invite_challenge_issued`
- `invite_challenge_rotated`
- `invite_verification_succeeded`
- `invite_verification_locked`
- `mfa_enrolled`
- `mfa_challenged`

Domain override and challenge lifecycle audits are written inside their locking RPC
transactions. MFA completion is written only after an AAL2 session is authoritative. Audit
metadata contains invite/company/deal references and non-secret outcomes only. Tests
explicitly reject raw codes, keyed digests, factor identifiers, QR values, and authenticator
codes in response payloads outside the single inviter code field, logs, email, and audits.

## File map

### Add

- `supabase/migrations/20260804160000_invite_safeguard_2fa.sql`: trusted-domain and
  confirmation relations, invite challenge state, audit actions, RLS/service grants, and
  redefined invite RPCs.
- `src/lib/api/v1/inviteDomain.ts`: email-domain normalization and preflight contract.
- `src/lib/api/v1/inviteChallenge.ts`: code generation, keyed digesting, and strict input
  validation.
- `src/app/api/v1/invites/preflight/route.ts`: authorized domain decision endpoint.
- `src/app/api/v1/invites/verify/route.ts`: session-bound recipient verification endpoint.
- `src/app/api/v1/auth/mfa/complete/route.ts`: post-AAL2 audit endpoint.
- `src/app/two-factor/page.tsx` and `src/app/two-factor/page.client.tsx`: enrollment and
  challenge experience.
- Focused tests: `tests/api-v1-invite-preflight.test.ts`,
  `tests/api-v1-invite-verify.test.ts`, `tests/two-factor-page.test.tsx`,
  `tests/auth-assurance-boundary.test.ts`, and `tests/db/invite-safeguards.test.ts`.

### Modify

- `.env.example`: document the required invite-verification pepper.
- `scripts/seed-data.ts`, `scripts/seed-users.ts`: declare and seed controlled verified
  domains without deriving them from account emails.
- `src/lib/constants/audit.ts`, `src/lib/constants/invites.ts`, and
  `src/lib/constants/tables.ts`: mirror the additive schema contract.
- `src/app/api/v1/invites/route.ts`: preflight-confirmation input, challenge generation,
  transactional create call, and one-time code response.
- `src/app/api/v1/invites/[inviteId]/resend/route.ts`: fresh challenge rotation and one-time
  code response only after delivered resend.
- `src/app/api/v1/invites/context/route.ts`: generic locked response before verification and
  full context only after it.
- `src/app/api/v1/invites/accept/route.ts`: require verified current challenge and return a
  two-factor landing destination.
- `src/lib/api/v1/inviteDelivery.ts` and `src/lib/email/resend.ts`: remove invite context from
  delivery inputs and send the generic notice.
- `src/components/wgl/InviteModal.tsx` and `src/components/wgl/LiveWorkingGroup.tsx`:
  preflight confirmation, decision reset, creation/resend code display, and recovery copy.
- `src/components/wizard/inviteQueue.ts` and `src/components/wizard/Gate0Wizard.tsx`:
  preflight-confirmed chips, pre-create revalidation, automatic-send blocking, and receipt
  code display.
- `src/app/accept-invite/page.client.tsx`: generic verify-first sequence, context unlock,
  explicit acceptance, and two-factor redirect.
- `src/app/sign-in/page.client.tsx`, `src/middleware.ts`, and `src/lib/api/v1/http.ts`:
  mandatory browser and API AAL2 enforcement.
- `openapi/phase1.json` and `docs/03-engineering/api-v1.md`: preflight, verify, acceptance,
  resend responses, MFA audit route, AAL1 exceptions, and platform-wide AAL2 contract.
- Existing invite, delivery, acceptance, queue, HTTP, middleware, sign-in, and constants
  tests where their contracts change.

No file under the typed M&A `src/lib/api/` seam changes except the already-platform-owned
`src/lib/api/v1/` helpers named above. Box, data-room, external-shell authorization, deal
workflow, and content components remain untouched.

## Acceptance-criterion mapping

| AC | Implementation evidence | Verification evidence |
| --- | --- | --- |
| 1 | Trusted-domain relation, controlled seed data, normalized preflight match | Exact, case, subdomain, configured seed, and no-confirm API/UI tests |
| 2 | Mismatch/personal/empty-set classification and UI correction/confirm states | Working Group and Gate 0 behavior tests for all three classes |
| 3 | Bound expiring confirmation plus atomic recompute/consume in `create_invite` | Direct POST, edit, replay, expiry, cross-actor, and concurrent-create tests |
| 4 | Shared statement-form warning model and both invitation surfaces | Visible-copy assertions, including an em-dash rejection check |
| 5 | Random six-digit code, keyed digest only, delivered-response disclosure | Format, uniqueness, delivery failure, email, metadata, log, and audit tests |
| 6 | Generic email and context lock before verification | Email rendering and acceptance-page/API disclosure tests |
| 7 | Session-bound verify RPC with link/email/tenant/nonce/code requirements | Link-only, mailbox-only, wrong account, and correct-code tests |
| 8 | Verification-only state followed by unchanged atomic accept grant | SQL and route tests proving verify grants nothing and accept grants once |
| 9 | Locked row, atomic attempt increment, fifth-failure lock | Sequential and concurrent wrong-code tests plus post-lock correct-code test |
| 10 | Resend rotates nonce, digest, version, attempts, and verification state | Old/new link and code matrix, dismissed-code recovery, resend UI tests |
| 11 | Closed/expired/revoked/legacy and binding checks fail before context or grant | Status matrix and pre-safeguard pending-invite tests |
| 12 | Mandatory Supabase TOTP `/two-factor` flow | Enrollment QR/manual-secret and successful verification tests |
| 13 | Invite accept redirects to two-factor while protected boundaries remain closed | Invite-to-enrollment integration and AAL1 containment tests |
| 14 | Verified-factor challenge on password sign-in | Sign-in redirect and valid challenge tests |
| 15 | Middleware AAL2 plus default `requireApiUser` AAL2 | Browser route and protected API AAL1/AAL2 matrices; route audit |
| 16 | Retry and sign-out states with no protected redirect on invalid code | Invalid, expired, reused, provider-error, and sign-out UI tests |
| 17 | Middleware evaluates current AAL on every protected request | Existing-session AAL1 regression test |
| 18 | Transactional invite audits and post-AAL2 MFA audit | Per-event audit assertions and secret-absence scans |
| 19 | Additive RPC redefinitions preserve existing invite lifecycle and delivery truth | Existing invite suites plus expiry, revoke, duplicate, tenant, containment, and delivery tests |
| 20 | Invite routes remain flag-gated; MFA boundaries have no flag dependency | Feature-off invite 404 tests and feature-off AAL1 block/AAL2 pass tests |

## Migration and rollout

1. Generate and install a high-entropy `INVITE_VERIFICATION_PEPPER` in every runtime before
   deploying code. The application fails closed on invite create/resend/verify if absent.
2. Disable `platform_onboarding` during deployment. Apply the additive migration. It leaves
   existing invite fields and accepted/revoked history intact, adds null challenge state to
   old pending rows, and replaces functions with compatible lifecycle behavior.
3. Run the controlled seed path in sandbox environments. Production verified domains are
   populated only from an explicitly reviewed operations data set; missing data safely
   selects confirmation.
4. Deploy the application. Validate anonymous, invited AAL1, active AAL1, and AAL2 smoke
   paths. Enable `platform_onboarding` only after invite create, resend, verify, accept, and
   audit checks pass. MFA enforcement remains active regardless of that flag.
5. Notify operators that old pending invitations require resend and that existing users are
   gated at next protected access. Supabase administrative factor reset remains the only
   recovery path.

The database change is forward-compatible with the previous application because it is
additive and retains prior columns and function result fields. Rollback is operational and
non-destructive: turn off `platform_onboarding`, stop new invite delivery, retain the new
relations and challenge history, and forward-fix. Do not drop challenge or audit data. A
full application rollback would remove mandatory AAL2 enforcement and therefore requires
an explicit security downgrade decision; it is not the normal rollback path. Supabase TOTP
factors remain valid and are not deleted by application rollback.

Rotating `INVITE_VERIFICATION_PEPPER` invalidates every outstanding code. If rotation is
required, disable onboarding, deploy the new secret, require resend for all pending invites,
then re-enable. No migration attempts to recover or expose previous codes.

## Edge cases and failure handling

- Normalize case, whitespace, IDNA domains, subdomains, and plus-addressing without changing
  the local part beyond the existing lowercase contract. Reject malformed or non-ASCII-after-
  conversion domains before preflight.
- An operations domain change between preflight and send forces a new decision. Confirmation
  identifiers cannot be reused, extended, or moved across users, tenants, companies, deals,
  emails, or roles.
- Multiple Gate 0 chips carry independent decisions. Any stale chip blocks deal creation so
  the deal cannot be created and then silently skip a mismatched automatic invite.
- Duplicate pending and active-account responses disclose no challenge. Resend is required
  to rotate and display a fresh code for an existing pending invite.
- A provider send followed by delivery-finalization failure is treated as unsent and reveals
  no code. The recipient cannot verify that credential; resend repairs it.
- Five concurrent bad attempts produce one locked invite with no sixth comparison. A correct
  code racing the fifth failure, resend racing verify, and accept racing resend all serialize
  under the invite lock with one authoritative outcome.
- Verification is bound to the authenticated user and current credential version. Signing in
  as another account, changing auth metadata client-side, or using a superseded credential
  cannot unlock context.
- Successful verification without acceptance grants nothing. Resend, revoke, expiry, or
  credential rotation invalidates that unaccepted state.
- TOTP enrollment resumes safely after refresh by removing stale unverified factors before a
  new enrollment. Multiple verified factors are selectable. Provider/AAL lookup failure is
  fail-closed.
- AAL1 sessions can reach only invite completion, two-factor completion, sign-out, and true
  public endpoints. Invited users who reach `/two-factor` are sent back to invite completion;
  active users cannot use project routes or APIs until AAL2.
- Redirect destinations are normalized to internal paths. Query strings survive, external or
  malformed destinations fall back to `/projects`, and completing AAL2 never redirects to an
  invite credential URL.
- UI error copy stays senior, precise, decisive, statement-form, and contains no em dash.
  Secrets are never interpolated into errors.

## Test strategy and gates

1. Add pure unit tests for domain normalization/classification contracts, code generation and
   digest stability, redirect sanitization, and Gate 0 queue decision transitions.
2. Add route tests with mocked Supabase clients for preflight authorization, confirmation
   binding, code disclosure, context lock/unlock, verification errors, acceptance gating,
   resend rotation, MFA audit, and default AAL2 enforcement.
3. Add React Testing Library coverage for Working Group confirmation, Gate 0 stale-decision
   blocking and receipt codes, generic verify-first acceptance, TOTP enrollment/challenge,
   retry/sign-out, and safe redirects.
4. Add database integration coverage for transactional confirmation consumption, duplicate
   and concurrent sends, five-attempt locking, verify-versus-resend and accept-versus-resend
   races, old pending rows, membership atomicity, and audit secret absence. The test skips
   only when the existing repository database-test prerequisites are absent and is run
   explicitly when `DATABASE_URL` is available.
5. Update and run the entire existing suite to prove invite expiry, revoke, duplicate,
   containment, tenant/email binding, delivery truthfulness, feature-off parity, Box/data-room,
   and external-shell behavior did not regress.
6. Inspect rendered invite email and both new browser surfaces for disclosure and copy. Search
   all changed visible strings for em dashes and challenge material.
7. Run the mandatory gates in order and log exact results:
   `npm run lint && npm run test && npm run build`.
   No commit, push, or PR request is created until all three commands are green.

## Implementation sequence and subagent boundaries

After approval, use subagents in this single shared run worktree with disjoint primary file
ownership:

1. Database/domain worker: migration, constants, seed updates, and database-focused tests.
2. MFA-boundary worker: two-factor pages, sign-in, middleware, `requireApiUser`, MFA audit,
   and assurance tests.
3. Invite-flow worker: preflight/verify routes, challenge/delivery helpers, create/resend/
   context/accept routes, invitation UIs, and invite-focused tests.
4. Planner/executor integrates contracts, resolves overlapping call sites, updates OpenAPI and
   engineering docs, runs all gates, and fixes cross-stream failures. Subagents do not commit,
   push, or open PRs.

