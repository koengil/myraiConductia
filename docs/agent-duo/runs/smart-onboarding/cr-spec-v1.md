---
run_id: smart-onboarding
type: review
status: changes_requested
round: 1
source: spec-v1.md
---

# Review: `spec-v1.md`

## 1. Faithfulness to the approved three-part experience

The spec preserves the approved shape: lookup stays in Gate 0 and Team, the
preview is server-authoritative and read-only, and the welcome brief lives on
the persistent external deal home. Human confirmation, deterministic inputs,
the Internal/classification-4 walls, and flag-off parity are all represented
(`spec-v1.md:81-103,107-129,133-175`). One brief-mandated preview state is
missing.

1.1 **Add an explicit zero-access preview state.** The brief requires clear
loading, **empty**, unavailable, and stale-input behavior (`brief.md:40-46`).
B8 covers loading/stale and B10 covers unavailable, but B3-B12 never define
what **What they'll see** renders when the computed accessible-document count
is zero (`spec-v1.md:111-129`). C11 is an empty state for the later welcome
brief, not for the pre-send preview (`spec-v1.md:153`). Add an independently
testable preview criterion that renders an honest zero-document state, retains
the qualitative invariant denials, and exposes neither fabricated content nor
an inaccessible count; add that case to D8.

## 2. Testability of behavior and security requirements

Most acceptance criteria are concrete and observable: the warning matrix,
server policy parity, response-field exclusions, read-only audit semantics,
permission-derived actions, accessibility, feature-flag parity, demo runbook,
and repository gates all have direct assertions (`spec-v1.md:81-175`). The
lookup's asynchronous state contract is not yet testable.

2.1 **Specify and test lookup loading, failure, and stale-response behavior.**
The card may pre-fill security-sensitive company/role/phase controls
(`spec-v1.md:51-55`), but A12 addresses only malformed, empty, and ambiguous
inputs (`spec-v1.md:103`). It does not say what happens when a request fails,
the email or selected company changes in flight, or responses arrive out of
order. Add criteria binding every result and pre-fill to the exact current
normalized email, selected company, deal, and invitation surface; clear or
mark the old result non-current as soon as any bound input changes; ignore
out-of-order responses; and render a neutral unavailable state with no
recommendation pre-fill or confirmation-gate bypass on failure. Extend D8
with failure and response-race cases for both invitation surfaces.

## 3. Scope control and non-goals

Approved. Sections 3 and 7 explicitly exclude chat, autonomous grants or
company creation, network enrichment/KYC claims, replacement destinations,
workflow-task invention, invitation-state-machine changes, persistence of
preview results, and widened invite/phase/upload authority
(`spec-v1.md:20-31,177-188`). A1 confines integration to Gate 0 and Team, C9
confines welcome links to Deal/Data Room/Team, and D1 preserves the existing
flag-off product (`spec-v1.md:81,149,157`). No adjacent product scope needs to
be removed.

## 4. Product decisions and ambiguous states

The spec resolves least privilege, role/company-role recommendations,
pending-invite disclosure, qualitative hidden-content messaging, failed
preview behavior, welcome placement, zero-document welcome behavior, and the
no-persistence default (`spec-v1.md:190-214`). One first/later-visit statement
is internally contradictory.

4.1 **Replace "renders identically" with a current-data later-visit contract.**
C1 says the brief renders identically on every later visit
(`spec-v1.md:133`), while C3 requires its document count, phase, permissions,
and actions to change on the next render as server state changes
(`spec-v1.md:137`). The behavior narrative and Q10 support the latter,
live-reading interpretation (`spec-v1.md:73,210`). Rewrite C1 to require the
brief to remain available and structurally useful on every visit while its
values/actions are recomputed from current trusted data, then add a later
visit/refresh test that covers a phase or permission change.

## 5. Consistency and safety

The spec correctly makes preview policy server-authoritative, excludes
inaccessible document metadata/counts, keeps lookup/preview read-only, gates
all deal content on membership, and forbids secrets (`spec-v1.md:95,101,
107-129,135,159-163`). Two disclosure rules still permit or leave ambiguous
facts outside the viewer's established scope.

5.1 **Remove the another-company-roster exception from C10.** The brief says
the welcome brief must never reveal another company's roster
(`brief.md:48-55`). C10 instead permits rosters for "counterparties already
visible" (`spec-v1.md:151`), which widens the approved contract and conflicts
with the existing `userCanViewCompany` rule limiting ordinary roster reads to
the caller's own company (`docs/03-engineering/api-v1.md:47-53`). Make the
prohibition unconditional for the welcome brief. It may link to Team when
authorized, but must not return or render another company's roster or derive
welcome content from it; add a cross-company negative test.

5.2 **Define the minimum authorized disclosure for existing-user and
existing-member warnings.** A3 scopes company matches and A6 scopes pending
invitation facts, but A5(c-d) unconditionally signal that an address is a
platform user and holds a seat on this deal (`spec-v1.md:85,89-91`). A2's
permission to compose an invitation does not state which identity or roster
facts that actor may inspect, while the current platform has a narrower
company-roster predicate (`docs/03-engineering/api-v1.md:52`). Preserve the
brief-required warnings for an actor authorized to receive the relevant bare
fact, but specify that the response never adds identity, company, role, phase,
tenant, or roster metadata and that an actor outside the fact's visibility
scope receives an opaque/neutral result that does not imply the user or seat
exists. Extend D8 beyond pending-invite scoping to positive and negative
identity/membership disclosure cases, including another company and tenant.

Status is `changes_requested` until findings 1.1, 2.1, 4.1, 5.1, and 5.2 are
resolved in the specification and their required tests are reflected in the
acceptance criteria.
