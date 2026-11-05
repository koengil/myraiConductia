---
run_id: smart-onboarding
type: escalation
round: 3
---

# Escalation — plan phase round cap reached

**Status: stopped for a user decision. Nothing has been implemented, committed, or pushed.**

The run contract allows a maximum of three substantive review rounds per phase. The plan phase has used all three (`cr-plan-v1.md`, `cr-plan-v2.md`, `cr-plan-v3.md`), and round three returned `changes_requested` with seven findings, all marked blocking with no advisory items. The reviewer states terminal escalation is required.

## The unusual shape of this escalation

The contract anticipates escalation when planner and reviewer **disagree**. That is not what happened here.

**I verified all seven findings against source and I concur with every one.** I have no competing technical position to record. Three are outright defects in my plan — one of which makes the plan internally impossible to implement — and four are genuine incompleteness against frozen criteria.

So the decision in front of you is not "who is right." It is a **process decision**: the round cap is exhausted while the findings are convergent, specified, and mechanical rather than contested.

## What the reviewer affirmed as correct in plan-v3

Recorded so that a further round does not relitigate settled ground:

- Shared document policy, `DocumentRoom` decoded before evaluation, real Internal → MNPI → phase check order unchanged
- Forward phase migration: defaulted final argument preserves old callers, `default 0` backfills, exact signature and grants recreated, internal invites stay phase 0, `accept_invite` grants and audits the stored phase
- Prospective tenant coherence preceding `userCanInvite` (closing the firm-admin short-circuit)
- Member preview reusing `userIsDealMd`; fixed metadata-free lookup warning schema; document queries projecting only policy fields
- Fail-closed reads, discriminated bound inputs, flag-off parity, D8.1–D8.16 ownership, deterministic demo, synchronized docs and gates
- Scope discipline: no chatbot, enrichment, auto-grant, third invitation flow, persisted preview, or new destination. Phase persistence is the minimum state A9/B2 require and is expressly allowed by frozen Q12.

## The seven blockers, with my verification

| # | Finding | Verified against | My position |
|---|---|---|---|
| **2.1** | Plan coerces every **external-company** invitee to Member | `invites/route.ts:126-145`, `InviteModal.tsx:145-149,383-396` | **Confirmed. My error.** |
| **5.1** | Branded subject makes member + welcome paths unimplementable | `plan-v3.md:121-130,160-162,261-265` | **Confirmed. My error.** |
| **5.3** | Missing `can_invite` candidate branch and frozen A17 branch (b) | `access.ts:330-337`, `spec-v2.md:129` | **Confirmed. My error.** |
| **5.2** | Authority rows read without lock; parity test compares only `userCanInvite` | `invite_safeguard_2fa.sql:381-405` | **Confirmed.** Consequence of my choice to close the TOCTOU. |
| **3.1** | Rollback containment not atomic against `accept_invite`'s row lock | `invite_safeguard_2fa.sql:673-695` | **Confirmed.** Cheap fix. |
| **1.1** | No bank-side internal recommendation (A7); D6 mismapped | `Gate0Wizard.tsx:615-638`, `spec-v2.md:199,247` | **Confirmed.** Coverage gap. |
| **4.1** | Cross-cutting assertions narrower than frozen invariants | `spec-v2.md:153` | **Confirmed.** Coverage gap. |

### The three defects, stated plainly

**2.1 — I would have shipped an authority regression.** I conflated *external company* with *external actor*. The shipped route keys coercion on the **actor**: `actorIsExternal = is_external && firm_role !== ADMIN` forces Member, and separately a Director invite is permitted when `canManageCompanyMembers` holds. So today an authorized internal MD **can** invite an external Director; my plan silently removed that. It contradicts frozen A9 (inviter may override company role), frozen Q5 (Director stays an explicit choice), and the out-of-scope boundary forbidding changes to who may invite. This is the finding I am least comfortable with, because it would have narrowed live authority without anyone asking for it.

**5.1 — my plan was internally impossible.** I branded `AuthorizedSubject` with a module-private symbol so only `proposalFeasibility.ts` could construct it, then required `computePerimeter` to accept nothing else. But member phase preview is authorized by `userIsDealMd`, and the welcome brief uses the real membership-validated viewer. Neither can construct the only accepted input. As written, B11 and C1–C11 cannot be built through my own declared API. The fix is three server entry points over a private pure core, each with its own authorization constructor.

**5.3 — I would have broken a delegation path merged at HEAD.** `access.ts:337` returns true for `actor.company_id === target.companyId && actor.can_invite === true` — the delegated-invite path from commit #145, which is this branch's base commit. My candidate rule listed only director/admin-managed companies, so a delegated member would have gotten no lookup result on their own company. Separately I implemented only two of frozen A17's three disclosure branches, omitting "an actor authorized over the membership of a deal on which the user holds a seat."

### The one finding that is genuinely a scope question

**5.2** exists only because I chose to close a **pre-existing** send-time TOCTOU that my change does not introduce. Having chosen to close it, closing it non-atomically is worse than not claiming to close it — it manufactures a false guarantee. The reviewer is right that an email-keyed advisory lock serializes competing sends but not concurrent revocation of actor privilege, membership, company type, or party rows. This is the one blocker you could remove by decision rather than by work.

## Decision required

**My recommendation: Option A.**

**Option A — Authorize one additional plan round (plan-v4), TOCTOU closure retained.**
Every finding is specified and uncontested; there is no judgment call left to arbitrate, only correction. 2.1 / 5.1 / 5.3 are direct fixes. 3.1 becomes a single atomic `UPDATE ... WHERE status='pending' AND phase>0 ... RETURNING` with audit rows built only from returned rows. 5.2 uses the lock structure `create_invite` already has. 1.1 / 4.1 are additive. I estimate one round converges, since v3 was judged "materially more complete" and each round's findings have narrowed.

**Option B — Authorize plan-v4, but drop the TOCTOU closure.**
Revert to the route-level check, documented explicitly as a pre-existing window this change does not widen. Removes 5.2 entirely and the TS/SQL parity burden with it. Smaller, faster, less risk of SQL/TS divergence — at the cost of leaving a known race on a compliance-critical write while adding a new authority-bearing input to it.

**Option C — Proceed to execution on plan-v3 with the seven findings tracked as must-fix.**
**I recommend against this.** 5.1 makes the plan unimplementable as written, so execution would improvise the security-critical seam at the keyboard, and 2.1 would ship an authority regression unless caught later.

**Option D — Reduce scope at the spec level** (drop phase persistence, narrowing A9/B2).
Requires reopening the frozen spec, which is a larger decision than the plan phase. Only worth it if the migration itself is unwanted.

## State at stop

| | |
|---|---|
| Branch | `duo-smart-onboarding` @ `origin/develop` (0 ahead / 0 behind) |
| Working tree | run artifacts only — **no source file modified** |
| Frozen spec | `spec-v2.md` (approved round 2) |
| Latest plan | `plan-v3.md` (not approved) |
| Reviews | `cr-spec-v1`, `cr-spec-v2`, `cr-plan-v1`, `cr-plan-v2`, `cr-plan-v3` |
| Orchestration Run | `run_e5946bef9d53` |
| Reviewer dispatch | `ctx_6960bf38821e` — settled, terminal released |

Phases 3 and 4 have not started. Resuming requires only a decision above; the reviewer terminal can be re-engaged with a new tracked Task.
