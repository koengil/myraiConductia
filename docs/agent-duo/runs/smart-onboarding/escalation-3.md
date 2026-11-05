---
run_id: smart-onboarding
type: escalation
round: 3
---

# Escalation — PR phase exhausted its three substantive rounds

**Status: stopped for a user decision. Nothing merged. PR 149 remains a draft.**

## What happened

| Round | Findings | Of which genuine defects in my work |
|---|---|---|
| PR r1 | 5 blocking | 5 |
| PR r2 | 4 blocking (5.1 resolved) | 4 |
| PR r3 | 5 blocking (4 carried + 1 new) | 5 |

Round 3 was the last substantive round available. It returned
`changes_requested`, so the contract requires stopping here rather than taking a
fourth round unasked.

**This is not a disagreement.** I have no competing technical position on any of
the five. Where I pushed back implicitly — by calling a gap "the safe direction"
or by presenting a route-level composition as the end-to-end path — the reviewer
is right that those were weaker than what the frozen spec asks for.

## The five blocking findings

**4.1 — I authorized against the wrong resource.** I removed the hidden-row
inputs correctly, then gated disclosure on `pending.company_id ===
actor.company_id`. That asks "does the actor own this company" and answers "may
the actor manage *this invitation*". Those are different questions. I described
the result as safe under-disclosure; it is more accurately an authorization
decision made against a resource other than the one being disclosed.

**1.2 — the fail-closed guarantee stops one level down.** `userCanInviteChecked`
reports `'unreadable'`, but `canManageDealMembers` and `canManageCompanyMembers`
still collapse their own read failures into `false`. So a failed read inside
those still produces a confident perimeter. I disclosed this rather than fixing
it, on the grounds that it widens blast radius across live routes. The reviewer
holds that a partial guarantee here is not the guarantee the spec requires.

**4.2 — my E2E is not the D7 path.** It composes four real handlers with a
mocked client. Frozen D8.16 asks for the demo path of D7 automated. Mine proves
the handlers compose and that preview and welcome agree; it does not walk the
scenario the runbook describes.

**1.1 — mandatory verification absent.** I implemented the withdrawal key and
typed-phase preservation, could not get the two tests working, and removed them.
D8.6 lists them as required coverage. Removing a test I could not make pass does
not make the obligation go away.

**New — Gate 0 preview mismatch.** The wizard passes `dealId: null` with a
non-null `dealRole`. I did not catch this and have not investigated it.

Advisory, not blocking: stronger A19 schedule/mutation evidence, two-session
rollback automation, a hermetic migrated SQL harness, and the pre-existing raw
500 cleanup.

## What is sound and would survive

The reviewer has repeatedly credited, and did not re-open: the shared document
decision path and its check ordering, the perimeter core's export boundary,
`assessProposal`'s ordering and actor-specific Director rule, TS/SQL authority
parity (including the NULL three-valued-logic bug the probe found), the phase
carry through to the granted seat, rollback containment's row-lock reasoning,
flag-off parity, audit neutrality, secret absence, and the dependency audit.

## Options

**A — one more PR round.** All five findings are specified; none require
discovery. 4.1 and the Gate 0 mismatch are small. 1.2 means touching two shared
predicates. 1.1 needs the harness problem actually diagnosed. 4.2 is the large
one: a real D7 walk. *Recommended if you want this merged as specified.*

**B — one more round, minus 4.2.** Fix the four smaller findings; accept the
route-level E2E and record D8.16 as partially met. Halves the work; leaves a
frozen criterion knowingly unmet.

**C — merge as-is with findings tracked.** *Recommend against.* 4.1 and 1.2 are
authorization defects, not polish.

**D — reduce scope at the spec level.** If the full D7 automation is not worth
another round, that is a spec decision, not mine to take.

## State

| | |
|---|---|
| Branch | `duo-smart-onboarding` @ `7a386b0` (+ this doc) |
| PR | 149, draft into `develop`, **not merged** |
| Gates | eslint 0 errors · tsc clean · 883 passed · audit 0 vulns |
| Frozen spec | `spec-v2.md` |
| Latest PR request | `prr-149-r3.md` (unapproved) |
| Run | `run_e5946bef9d53`, reviewer terminal released |
