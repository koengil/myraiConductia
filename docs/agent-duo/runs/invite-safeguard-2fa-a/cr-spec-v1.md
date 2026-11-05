---
run_id: invite-safeguard-2fa-a
type: review
status: changes_requested
round: 1
source: spec-v1.md
---

# Spec review, round 1

## 1. Right thing to build, faithful to brief.md, no invented scope

Checked each brief item against the spec section by section. Brief 1a (pre-send
check against company context with explicit confirm/correct) maps to Goals 1,
the pre-send behavior section, and AC 1-4. Brief 1b (recipient verification
challenge before access) maps to the out-of-band code design and AC 5-10; the
choice of an inviter-delivered code over an emailed challenge is correctly
argued in Open Question 3, since an emailed code would reach the same wrong
mailbox. Brief 2 (2FA at platform sign-in, not per-project) maps to AC 11-16,
and the spec explicitly introduces no project-level challenge. Entry-point
parity (Gate 0 queue, Working Group) is coverage of existing PR #124 surfaces,
not creep. The pre-safeguard-invites-must-be-resent migration stance is a
legitimate WHAT decision and is stated. No invented scope found. Verdict:
faithful, with the two definition gaps below.

## 2. Acceptance criteria concrete and testable

18 criteria, each phrased as an observable outcome; spot-checked AC 2, 3, 6,
8, 11, 16 for testability and each yields a concrete pass/fail test (send
attempt blocked, server rejects bypass, link+mailbox insufficient, fifth
failure locks, protected route unreachable, existing session gated on next
request). AC 18 is a broad regression umbrella rather than a single criterion,
acceptable as a regression gate. Testable overall, but AC 1's "matching domain
proceeds" arm is only testable if a company can actually possess a verified
domain in this release, which the spec never establishes (blocking item 2).

## 3. Non-goals and out-of-scope explicit enough

Yes. The non-goals list closes the classic creep vectors for both features:
no domain-admin surface, no DNS verification, no alternative factors, no
remembered-device or risk-based step-up, no self-service factor recovery, no
per-project 2FA policy, no retrofit of direct membership grants. Sufficient to
prevent creep.

## 4. Open questions resolved, not deferred

Eight open questions each carry a resolution and rationale. Seven are genuinely
resolved. Open Question 1 resolves the matching semantics (normalized
registrable domains, subdomains match parent, unknown never silently passes)
but not the provenance of the verified-domain set itself, which is a WHAT-level
gap because it decides which of two very different inviter experiences ships
(blocking item 2).

## 5. Ambiguous or contradictory user-facing behavior

One contradiction found (blocking item 1). The behavior line "the authenticated
recipient sees the inviter, company, deal context when present, and addressed
email, then must enter the verification code" conflicts with AC 10's fail-closed
promise and with the safeguard's own threat model: the mis-addressed recipient
(the wrong Greg, who controls the mailbox and can authenticate) would learn the
inviting bank, target company, and deal context BEFORE proving they are the
intended person. Confidential-mandate disclosure to a stranger is precisely the
harm this feature exists to prevent, and deal code names exist in this product
precisely to avoid naming the target. Everything else checked out as coherent:
the un-2FA'd session allowlist includes invite completion, so the acceptance
before enrollment ordering in Open Question 7 is consistent; resend rotation,
lockout, and expiry interactions are mutually consistent.

## Blocking items

1. **Minimize pre-verification disclosure.** Redefine the recipient-side
   verification screen so that, before a correct code is entered, the recipient
   sees at most the information needed to locate the code (for example the
   addressed email and the inviter's name, or less). Company identity and deal
   context become visible only after successful verification. State this in the
   user-facing behavior section and reconcile AC 10 (and AC 5's acceptance
   context exclusion) with it.

2. **Define the provenance of the verified-domain set for this release.** State
   at behavior level where a selected company's verified domains come from
   (for example an existing field on the company record, or seeded sandbox
   fixtures), or state explicitly that domain sets may be empty for all
   companies in this release and that the always-confirm path is the accepted
   default experience. Without this, AC 1's non-confirmation arm is
   unsatisfiable and the feature's real-world shape is undefined.

## Non-blocking notes

- AC 18 bundles many guarantees into one umbrella criterion; splitting the two
  or three most load-bearing regressions (expiry, revocation, tenant/email
  binding) into their own criteria would make failures easier to localize.
- The single-display inviter code with resend-to-rotate recovery is coherent,
  but the spec could say explicitly that the inviter can retrieve a fresh code
  only via resend, so nobody plans a "view code again" surface later.
