---
run_id: invite-safeguard-2fa-a
type: review
status: approved
round: 2
source: spec-v2.md
---

# Spec review, round 2

Delta review against cr-spec-v1.md. Verified both blocking items were addressed
and re-checked the changed sections for newly introduced problems; unchanged
sections carry over their round 1 verdicts.

## 1. Right thing to build, faithful to brief.md, no invented scope

Round 1 blocking item 1 is resolved beyond the minimum asked: the invitation
email is now a generic action notice, the pre-verification experience shows only
the addressed email and instructions, a correct code unlocks the inviter,
company, deal context, and proposed role for review without granting anything,
and explicit acceptance remains the sole grant step. This strengthens
faithfulness to the brief's threat model instead of drifting from it. Round 1
blocking item 2 is resolved at behavior level: verified domains are
platform-operations-supplied company reference data, never inferred from
inviter, member, or recipient addresses, with documented institutional domains
in controlled seed and sandbox data and empty sets elsewhere. The additions stay
inside the two brief items; no new scope was invented.

## 2. Acceptance criteria concrete and testable

The renumbered set (now 20) remains testable. New AC 6 (no pre-verification
disclosure of inviter, company, deal, mandate, or role) is directly testable
against both the email content and the acceptance surface. Revised AC 8 cleanly
separates the unlock transition from the atomic accept transition, each
observable. Revised AC 1 is now satisfiable because seeded companies carry at
least one verified domain, so the non-confirmation arm is exercised in the
release. AC 20 resolves an ambiguity I had not raised: platform 2FA is a
login-boundary requirement and does not toggle off with the onboarding feature
flag. Consistent and testable.

## 3. Non-goals and out-of-scope explicit enough

Unchanged from round 1 apart from provenance wording; still sufficient. The
operations-supplied domain model keeps the excluded domain-administration
surface out of scope while making the data source explicit.

## 4. Open questions resolved, not deferred

Open Question 1 now resolves both matching semantics and provenance, including
the explicit rule never to infer trust from user or member email addresses.
Open Questions 3 and 4 were updated consistently with the new
withhold-context-until-verified and resend-only-recovery behavior. All eight
remain resolved with rationale; nothing was deferred into the plan.

## 5. Ambiguous or contradictory user-facing behavior

The round 1 contradiction is gone: fail-closed criteria (AC 7, 9, 11) now agree
with the pre-verification experience, since context disclosure itself is behind
the code. Checked the new material for fresh contradictions: rotation now also
invalidates successful-but-unaccepted verification state, which is consistent
with AC 10; the un-2FA'd session allowlist was updated to include invite
verification and acceptance, keeping the enrollment ordering in Open Question 7
coherent; the generic email notice does not conflict with delivery truthfulness
in AC 19, which concerns delivery status rather than content. No ambiguity or
contradiction found.

## Verdict

Approved. The spec is frozen. Both round 1 non-blocking notes were also
addressed (resend-only code retrieval is explicit; the feature-off umbrella was
split into AC 20).
