---
run_id: smart-onboarding
type: escalation
round: 4
---

# Escalation 2 — extra plan round spent, five blockers remain

**Status: stopped for a user decision. Nothing implemented, committed, or pushed.**

You authorized Option A after `escalation.md`: one additional plan round with the TOCTOU closure retained. `plan-v4.md` was that round. `cr-plan-v4.md` returns `changes_requested` with five blocking findings and no advisory items. The authorized round is spent, so this returns to you rather than continuing.

## Progress across rounds

| Round | Findings | Defects among them |
|---|---|---|
| plan r1 | 8 | 3 |
| plan r2 | 5 | 2 |
| plan r3 | 7 | 3 |
| **plan r4** | **5** | **1** |

Round 4 resolved prior findings **1.1, 3.1, 4.1, and 5.2**, and the reviewer confirms the substantive Director authority rule from 2.1 is now correct. The write-transaction design (`FOR SHARE` ordering, full-verdict parity) was reviewed in detail and affirmed.

## The five remaining findings

**One is a real technical error.**

**5.1 — my module split does not do what I claimed.** I wrote that `computePerimeterInternal` is "module-private" in `perimeter.ts` while the three entry points live in `index.ts`. TypeScript has no cross-file privacy: for `index.ts` to call it, `perimeter.ts` must export it — and once exported, any caller can deep-import it and pass a structurally forged `DocumentSubject`. The repo has no restricted-import rule that would make the boundary real. The reviewer is correct and I have no defense. **Fix: one module, only the three entry points exported** (or an enforced lint boundary). This is a small structural change, and it is the third round in a row this seam has been wrong — first the brand, then a fake module boundary.

**Four are completeness, not judgment.**

- **1.2 and 4.2** are the same issue stated twice (the reviewer says so): I declared v1–v3 non-normative, then referenced "thirteen files as in v3 §12.1" and promised the criterion table would be "maintained during execution." That is self-contradictory, and deferring a table the plan review must approve *now* is not acceptable. **Fix: transcribe the D8 matrix and the full criterion table into v5.** Bulk, not thinking — the content exists in v3.
- **2.1** is missing one parity case: Director *of that same target company* → Director permitted, the second branch of `canManageCompanyMembers`. I covered firm-admin, non-director, delegated member, and external coercion but not that branch. **Fix: add the case in TS and RPC.**
- **5.3** needs the candidate algorithm stated exactly rather than as "canManageDealMembers + deal parties," plus named positive/negative tests. **Fix: precision pass.**

**Nothing is contested.** I have no disagreement with any of the five.

## The real question

Each round the reviewer does a fresh full-document pass, so restructuring the plan can surface findings specific to that restructuring — 1.2 and 4.2 exist *because* v4 reorganized. That pattern is worth weighing: a v5 could converge, or could surface v5-specific documentation findings while the code design itself is now largely settled.

Against that: the security-critical seams are converging, not thrashing. Tenant coherence, the write-transaction lock set, phase carry, rollback atomicity, and the Director rule are all now affirmed. What remains is one structural fix plus transcription.

## Decision required

**My recommendation: Option C.**

**Option C — Fix the substantive findings now, then execute; the reviewer reviews the PR.**
I write `plan-v5.md` fixing 5.1 (single module, enforced boundary), adding the 2.1 parity case, tightening 5.3's algorithm and tests, and transcribing the full D8 and criterion tables. Then I proceed to execution **without another plan-review cycle**, and the reviewer's next gate is the PR — where the tests are real and runnable rather than promised in prose. A test table in a plan is a promise; a passing test in a PR is evidence, and the PR review verifies the same obligations against actual code.

**Option A′ — One more plan round (v5), reviewed before any code.**
Cleanest process: a plan the reviewer has approved before implementation begins. Costs another cycle and carries the fresh-pass risk described above. Defensible if you want the plan gate held strictly.

**Option B — Execute on plan-v4 as-is, findings tracked.**
**I recommend against.** 5.1 is a genuine defect in the security seam; executing it as written would build the forgeable boundary I just described.

**Option D — Reduce scope.** Still available (drop the TOCTOU closure, or drop phase persistence at the spec level), but nothing in round 4 suggests scope is the problem.

## State at stop

| | |
|---|---|
| Branch | `duo-smart-onboarding` @ `origin/develop` (0 / 0) |
| Working tree | run artifacts only — **no source file modified** |
| Frozen spec | `spec-v2.md` |
| Latest plan | `plan-v4.md` (not approved) |
| Reviews | 3 spec/plan rounds + `cr-plan-v4.md` |
| Run | `run_e5946bef9d53`; dispatch `ctx_41e7c2b7464b` settled, terminal released, unread queue 0 |
