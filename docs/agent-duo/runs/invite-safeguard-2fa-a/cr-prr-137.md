---
run_id: invite-safeguard-2fa-a
type: review
status: approved
round: 0
source: prr-137.md
---

# PR review, PR #137 (commit ec1599f)

Reviewed the full diff (77 files, +4715/-161) against the frozen spec-v2.md and
approved plan-v1.md. Method: read the migration, every new auth/invite module,
and the diffs of every modified route and boundary file; ran targeted scans for
secret leakage and visible-copy em dashes; independently re-ran the test gate.

## 1. Spec compliance (all 20 acceptance criteria)

Walked the criteria against code. AC 1-4: preflight classifies via
operations-supplied `company_verified_domains` (seeded for controlled
companies, never account-derived), mismatch/personal/unverified requires a
bound one-time confirmation, and `create_invite` recomputes the snapshot under
lock and rejects stale, edited, replayed, expired, or cross-actor
confirmations. AC 5-11: the six-digit code is CSPRNG-generated, stored only as
a peppered HMAC digest, returned exactly once and only when delivery finalizes
as sent; the email is a generic action notice with context fields removed from
the delivery types; the context endpoint returns only status, addressed email,
verificationRequired, and locked until the session-bound
`verify_invite_challenge` (email, tenant, nonce, version bound, constant-work
compare, five-attempt lock) succeeds; `accept_invite` requires
current-version verification by the same user and keeps the grant transaction
atomic; legacy pending rows have NULL challenge state and fail closed until
resend. AC 12-17: middleware and `requireApiUser` enforce AAL2 independently,
both fail closed on assurance errors; enrollment and challenge run on
`/two-factor`, which re-checks AAL2 after verification before proceeding;
sign-in and acceptance both hand off to `/two-factor`; existing sessions are
gated per protected request. AC 18: all seven new audit actions are written
transactionally (invite side) or post-AAL2 (MFA side) with non-secret detail.
AC 19-20: invite lifecycle behavior is preserved by additive RPC
redefinitions, and MFA enforcement is deliberately outside the
`platform_onboarding` flag.

## 2. Plan adherence

The file map matches the plan: only platform-side modules changed
(`src/lib/api/v1/`, `/api/v1` routes, auth surfaces, the two invite UIs,
migration, seeds, OpenAPI, docs). The typed M&A seam, Box, data-room, and deal
workflow are untouched. All three round 1 non-blocking plan notes were
honored: digest comparison is constant-time (`timingSafeEqual` in TS,
`constant_work_digest_equal` in SQL), and the code-after-delivery coupling is
implemented with honest failure copy and resend as recovery.

## 3. Gate verification (independent)

I re-ran `npm run test` myself in the run worktree: 684 passed, 3 skipped,
exit 0. The planner's log records lint zero errors and a successful build, and
a disposable-database migration-chain probe. Gate satisfied.

## 4. Security review

The threat model holds end to end. Session metadata (`invite_id`,
`credential_nonce`) is treated as a hint only; the RPCs bind to the
authenticated email, tenant, nonce, and challenge version, so metadata forgery
gains nothing. The pepper is required and everything fails closed without it.
Redirect destinations are normalized internal-only, reject credential-bearing
params, and cannot loop into auth pages. The verification code exists only in
the generating request, the one-time response, and React component state;
scans found no logging, persistence, or audit leakage, and the localStorage
fixture write excludes chip codes. New tables are RLS-enabled and server-only;
superseded RPC overloads are dropped so historical signatures cannot bypass
the challenge.

## 5. Regressions and scope

No scope creep beyond the frozen spec. Em-dash scan of changed source found
hits only in code comments, none in visible copy. GET /api/v1/invites selects
no challenge columns. Feature-off behavior is preserved for invite routes
while MFA stays platform-wide.

## Verdict

Approved. Non-blocking notes posted on the PR: the personal-domain list exists
in three places (TS classifier, SQL CHECK, SQL classifier) and should get a
single source of truth eventually (drift currently fails closed via the
snapshot/stale checks); the run's agent-duo artifacts ship inside the PR,
which is acceptable as an audit trail but worth a conscious call; the PR is
still marked draft and needs the planner to mark it ready.
