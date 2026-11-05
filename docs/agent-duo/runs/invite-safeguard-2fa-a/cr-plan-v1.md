---
run_id: invite-safeguard-2fa-a
type: review
status: approved
round: 1
source: plan-v1.md
---

# Plan review, round 1

Reviewed plan-v1.md against the frozen spec-v2.md, walking the AC mapping table
row by row and independently re-deriving coverage for the criteria I judged
highest risk (3, 5, 6, 8, 12, 15, 17, 20).

## 1. Every acceptance criterion of the approved spec addressed

Yes. The mapping table covers AC 1 through 20 with paired implementation and
verification evidence. Spot checks: AC 3's server-enforced no-bypass is a bound,
expiring, one-time confirmation identifier recomputed and consumed inside the
locked create_invite transaction, with direct-POST, replay, edit, expiry, and
cross-actor tests. AC 5's secret discipline is a peppered keyed digest with the
plain code confined to the generating process and the single post-delivery
inviter response, plus explicit secret-absence tests across email, URL, rows,
logs, and audit. AC 6's context lock lives in the context endpoint and the
generic delivery notice. AC 8's unlock-versus-grant split is verify recording
success without membership change and accept retaining the single-winner
transaction. AC 12 and 15 are enforced at two independent boundaries
(middleware and requireApiUser default-AAL2 with enumerated allowAal1
exceptions and a route audit). AC 17 is satisfied because assurance is
evaluated per protected request, gating pre-rollout sessions. AC 20 keeps MFA
enforcement outside the platform_onboarding flag. Nothing unmapped.

## 2. Anything outside the spec's scope

No creep found. The preflight endpoint, pepper, audit actions, and MFA audit
route are mechanisms for specified behavior. Working Group and Gate 0 changes
are the spec's own entry-point parity requirement. The file map stays on the
platform side: only src/lib/api/v1/ helpers, /api/v1 routes, auth surfaces, and
the two invite UIs change; the typed M&A seam, Box, data-room, and deal
workflow are untouched, which matches both the spec's out-of-scope list and the
repo invariant that /api/v1 lives beside the seam.

## 3. Migration and rollback

Handled concretely and in a safe order: pepper installed before code ships and
the app fails closed without it; the migration is additive with the onboarding
flag disabled during deploy; legacy pending rows get null challenge state so
they fail closed until resend, matching AC 11; verified domains come only from
reviewed operations data with sandbox seeds. Rollback is operational and
non-destructive (flag off, forward-fix, never drop challenge or audit data),
and the plan correctly flags that a full application rollback is a security
downgrade requiring an explicit decision. Pepper rotation semantics (all codes
invalidated, resend required) are stated.

## 4. Edge cases named and covered

The list is strong and matches the spec's failure surface: IDNA/case/subdomain
and plus-addressing normalization, domain-data change between preflight and
send, per-chip Gate 0 decisions with stale-chip blocking, delivery-finalization
failure withholding the code, five concurrent bad attempts serialized to one
lock, verify-versus-resend and accept-versus-resend races on the invite row
lock, superseded-credential and wrong-account binding, unaccepted verification
invalidated by rotation, stale unverified TOTP factor cleanup, fail-closed AAL
lookup, and open-redirect sanitization of destinations.

## 5. Technical unsoundness

None blocking. The 6-digit code is offline-brutable as a bare hash, but the
required high-entropy pepper plus the five-attempt lock and single-use binding
make the design sound, and the app fails closed when the pepper is absent.
Confirmation consumption and challenge state transitions are transactional
under a row lock, so the named races have one authoritative outcome. Dual
enforcement (middleware plus API) means neither boundary is a single point of
bypass. Supabase AAL remains the source of assurance; the audit endpoint is
correctly not trusted for assurance.

## Verdict

Approved. Proceed to execution against this plan.

## Non-blocking notes

- The AC mapping table's rows 12 and 13 are loosely labeled against the spec's
  numbering (row 12's evidence is enrollment, which is spec AC 13; spec AC 12
  is actually evidenced by row 15's boundary matrices). Substance is covered;
  just make sure the AAL1-cannot-reach-protected assertions exist regardless of
  which test file carries them.
- State explicitly in inviteChallenge.ts that digest comparison is
  constant-time.
- Returning the code only after delivery finalization couples the create/resend
  response to provider latency; acceptable, but keep the failure copy honest if
  the provider is slow rather than failed.
