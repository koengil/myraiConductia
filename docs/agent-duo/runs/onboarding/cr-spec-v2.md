---
run_id: onboarding
type: review
status: changes_requested
round: 2
source: spec-v2.md
---

# Review: `spec-v2.md`

## 1. Fidelity and completeness against the brief

I re-reviewed the v1→v2 diff against the six round-one findings. The Working
Group conversion is now explicit in behavior and criterion 10 (`spec-v2.md:63-68,
135-137`); director authority now covers any deal where the director's company is
a party and rejects the two forbidden cases server-side (`spec-v2.md:54-55,
123-125`); the internal compliance-theatre Team page is explicitly out of scope
(`spec-v2.md:42-44`); and the three-destination shell plus both membership-routing
paths are restored (`spec-v2.md:97-103,138-141`). Those five changes faithfully
resolve findings 1.1, 2.1, 3.1, 5.1, and 5.2.

1.1. Complete the remaining part of finding 1.2 by requiring an upload-side HTTP
502 when Box is unavailable, in addition to saying the error is retryable. The
approved brief specifically requires “fail the request with a retryable 502”
(`brief.md:145`), while the new behavior and criterion 9 say only “retryable
error” (`spec-v2.md:92-93,133-134`). That weaker wording would permit a 4xx,
generic 500, or in-band application error and is not a complete reading of the
approved failure contract.

## 2. Concrete and testable acceptance criteria

The changed criteria are otherwise concrete and testable. Criterion 5 now names
both allowed and denied director scopes; criterion 10 identifies the exact live
Working Group states and controls; and criterion 11 separately covers the
single- and multi-membership routing paths (`spec-v2.md:123-141`). Criterion 9
becomes fully testable against the approved contract once the required 502 in
item 1.1 is stated; no additional round-two change is required here.

## 3. Non-goals and scope-creep protection

Round-one finding 3.1 is resolved. Lines 42-44 explicitly preserve the existing
bank-internal compliance-theatre Team page and route the real roster, invite, and
phase work to Working Group, preventing the unrelated internal-page rewrite the
prior spec left open. The other non-goals are unchanged, and the round-two diff
introduces no new scope.

## 4. Resolution of open questions

The four product choices remain resolved rather than deferred: Resend delivery,
fully mediated Box access, a scoped external shell, and Box for production/demo
with credential-free dev/CI (`spec-v2.md:158-169`). The external-surface answer
now consistently names Deal, Data Room, and Team, so the round-one inconsistency
in this section is gone.

## 5. Ambiguous or contradictory user-facing behavior

Round-one findings 5.1 and 5.2 are resolved without introducing a new
user-facing contradiction. Both behavior and criterion 11 now specify exactly
three external destinations and distinguish direct routing for one membership
from the minimal picker for multiple memberships (`spec-v2.md:97-103,138-141`).
The only remaining blocker is the underspecified upload failure contract in item
1.1.
