---
run_id: onboarding
type: review
status: changes_requested
round: 1
source: spec-v1.md
---

# Review: `spec-v1.md`

## 1. Fidelity and completeness against the brief

The spec preserves the central approved arc: bank and external invites, delegated
director administration, platform-mediated Box storage, server-side room/phase/
classification walls, synchronous audit coverage, the feature-flag cutover, and
the real-email/real-Box demo. Two approved behaviors are missing from the
acceptance criteria:

1.1. Add a criterion for the MD-side Working Group conversion. The brief requires
the Working Group surface to replace fixtures with real platform data, replace the
stubbed invite control with the live invite flow, and expose member phase plus
pending/resend/revoke state (`brief.md:127-130`). Criteria 1, 6, and 12 verify
pieces of those capabilities but never require that the Working Group itself go
real, so an implementation could satisfy the current spec while leaving that
approved surface stubbed.

1.2. Add the approved Box-outage behavior. The brief requires uploads to fail with
a retryable 502 and downloads to show an error state, with no silent degradation
(`brief.md:140-146`). The spec requires working storage in criteria 7-8 but has no
observable failure-path requirement.

## 2. Concrete and testable acceptance criteria

Most criteria are directly verifiable, including duplicate/active-account
conflicts, atomic acceptance, seller-versus-buyer upload rights, the critical
Internal/MNPI denial matrix, audit vocabulary, flag-off behavior, and the live
demo. One authorization criterion is concrete but specifies the wrong boundary:

2.1. Rewrite criterion 5 so a director is rejected for another company or for a
deal on which their company is not a party (and/or the director lacks the required
deal authority), rather than for any “another deal.” The approved rule permits a
director to invite own-company members onto every deal their company is party to
(`brief.md:74-82`; `spec-v1.md:51-52`), while criterion 5 currently forbids another
deal categorically (`spec-v1.md:108-110`). Predicate tests built from the current
criterion would enforce an unintended restriction.

## 3. Non-goals and scope-creep protection

The listed non-goals faithfully cover the next-30-days setup arc, training,
prescreening, Box-native collaboration/events, finer document ACLs, and terms or
attestation. One explicit surface boundary from the brief is absent:

3.1. State that the existing bank-internal compliance-theatre Team page is
untouched in this arc. The brief assigns the real roster/invite/phase work to
Working Group and explicitly leaves that Team page unchanged (`brief.md:127-130`).
Without that boundary, “Team” can be read as authorizing an unrelated internal
surface rewrite.

## 4. Resolution of open questions

The spec resolves rather than defers the four material choices: Resend owns
delivery, Box access is fully Conductia-mediated, external users receive a scoped
shell, and Box is the production/demo vendor while dev/CI remains credential-free
(`spec-v1.md:136-146`). No unresolved product decision is deferred into the plan.
The exact external navigation expression still needs reconciliation under item 5.

## 5. Ambiguous or contradictory user-facing behavior

5.1. Reconcile the external navigation count with the approved design. The brief
requires the external rail to show `Deal / Data Room / Team` (`brief.md:132-134`),
and criterion 9 names those same three surfaces (`spec-v1.md:118-119`), but the
user-facing section says there are “exactly two destinations: Data Room and Team”
(`spec-v1.md:83-86`). Specify the three rail destinations consistently.

5.2. Preserve both approved post-sign-in paths. The brief routes a user with one
membership directly to that deal and a user with multiple memberships to a minimal
picker (`brief.md:132-134`); criterion 9 requires direct routing without the
multiple-membership exception (`spec-v1.md:118-119`). Add the minimal-picker case
to the user-facing behavior and acceptance criteria so multi-deal external users
have a defined, testable destination.
