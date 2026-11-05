---
run_id: smart-onboarding
type: review
status: changes_requested
round: 2
source: plan-v2.md
---

# Review — plan-v2.md

## 1. Coverage of the frozen acceptance criteria

The round-two delta was checked against all eight `cr-plan-v1.md` findings and the affected frozen criteria:

| Prior finding | Round-two result | Evidence |
|---|---|---|
| 1.1 confirmed phase | **Forward path resolved; rollback still open under 3.3.** | `plan-v2.md:46-66` adds `invites.phase`, the 9-argument RPC, send/preflight carry, acceptance grant/audit use, internal coercion, and tests. Current `accept_invite` does grant and audit phase `0` at `20260804160000_invite_safeguard_2fa.sql:707-719`, so those named changes are the correct seam. |
| 1.2 Gate 0 preview | **Resolved.** | `plan-v2.md:92-108,141-154,170,191` moves one endpoint outside deal scope, supports an honest zero-document no-deal preview, retains the existing queued-chip/create-then-send flow, and binds proposal role/phase inputs. Current Gate 0 creates the deal then posts the same queued chips (`Gate0Wizard.tsx:841-883`), so attaching the preview before that boundary does not create a third flow. |
| 3.1 fail-closed reads | **Resolved.** | `plan-v2.md:131-139,193` distinguishes error/absent/present, makes any policy-read error an opaque whole-response `503`, forbids partial/false-zero results, and tests both modes plus welcome. |
| 3.2 member race key | **Resolved.** | `plan-v2.md:141-154,188,192` defines a discriminated member key with deal, target user, phase, and surface, then tests target change and out-of-order arrival. |
| 4.1 test ownership | **Still open under 4.1.** | D8.1-D8.16 are mapped, but the five cross-cutting obligations from the prior blocker are only listed at `plan-v2.md:198`. |
| 5.1 exact prospective authority | **Still open under 5.1.** | `assessProposal` closes the firm-admin tenant short circuit in the read path, but the claimed type guarantee is structural rather than enforced and the write still has a pre-RPC authorization race (`plan-v2.md:68-90`). |
| 5.2 lookup/A17 scope | **A17 response shape resolved; candidate authorization still open under 5.2.** | `plan-v2.md:110-129` removes `userCanViewCompany`, requires explicit tenant equality, and defines one fixed schema, but its candidate set is broader than exact invitation authority and the no-selected-company path is undefined. |
| 5.3 unknown room | **Resolved.** | `plan-v2.md:32-44,187` narrows `DocumentGate.room`, validates decoded rows, makes an unknown value fail the whole response unavailable, and deliberately leaves real-access predicate ordering unchanged. |

**1.3 — Make `plan-v2.md` the complete operative plan it says it is.** Line 9 says v2 **supersedes** v1, but v2 deletes the implementation contract for most frozen criteria and does not incorporate it elsewhere. Examples include the exact `Perimeter` result/capability/invariant construction for B1-B6/B13; lookup request, malformed-input behavior, known-domain evidence, label/recommendation algorithms, A18/pending-invite scoping, and A8/A11 read-only response rules; preview response/echo and route check ordering; welcome membership-first reads, fields, capability/action ordering, own-company-only data boundary, and later-visit behavior for C1-C11; and explicit D1/D2/D6/D9 implementation steps. The path table at `plan-v2.md:156-176` reduces M2-M4 and M8-M10 to one-line file descriptions, and the plan mentions `platform_onboarding` only in the test table, not in the two new route/UI execution paths. Restore the unchanged v1 design in v2, or state precisely that named v1 sections remain normative and change “supersedes” accordingly. Map every A1-A19, B1-B13, C1-C11, and D1-D10 criterion to code and verification, including `requireFlag` before auth on both new routes, UI flag gating, the existing external-home membership wall, OpenAPI/API/runbook changes, and the exact Gate 0 queued `dealRole` passed through the no-deal proposal, bound key, response echo, and preview.

## 2. Scope and reuse of existing surfaces

The proposed changes remain within the approved product. One lookup route and one dual-mode preview route feed the current Gate 0, Team invite, Member Drawer, and force-dynamic external deal home; `computePerimeter` reuses the real document/destination/capability seams; no chatbot, crawler, external enrichment, autonomous grant, new destination, persisted preview, or invented workflow is added. The phase migration is not adjacent scope: A9 and B2 require the confirmed previewed phase to survive acceptance.

The Gate 0 route move is appropriate. An optional deal context permits an honest pre-deal zero-document answer while the current queue remains local and the existing final action remains the human confirmation. The revised plan must preserve that exact two-flow boundary when it addresses finding 1.3; it must not turn the preview into another invitation path or make opening it a grant/send action.

No additional scope blocker is raised.

## 3. Data lifecycle, rollback, flags, stale inputs, and audit semantics

The forward migration design uses the repository's real precedent correctly. The current safeguard migration drops a superseded overload before recreating `create_invite` (`20260804160000_invite_safeguard_2fa.sql:323-339`) and later revokes/grants the exact signature (`:747-759`). Adding a final defaulted `p_phase`, recreating the function, and reissuing privileges therefore fits this codebase. `default 0` safely covers old rows and old callers during a forward rollout; internal-company coercion inside the RPC prevents Gate 0 from persisting an irrelevant external phase; and changing the existing `(uuid, uuid)` `accept_invite` body is the correct grant/audit seam. The fail-closed and discriminated-key designs also resolve stale/error lifecycle concerns.

**3.3 — Contain rollback for already-created nonzero pending invites.** `plan-v2.md:66` says dropping `invites.phase` causes “no data loss” and simply restores phase 0. That is false for a pending invite whose inviter explicitly confirmed phase 2: dropping the column destroys that decision, and acceptance after rollback silently grants/audits phase 0. Define an ordered app/DB rollback and a containment policy for nonzero pending rows before the column is removed, such as blocking/expiring and reissuing those invites, preserving the value in a compatibility path until they settle, or explicitly preventing acceptance with a clear recovery. Include forward-compatibility and rollback tests for old callers, old phase-0 rows, new nonzero pending rows, and the acceptance boundary. Do not label destructive loss of a confirmed access decision as lossless.

Feature-flag parity and audit neutrality remain subject to findings 1.3 and 4.1. Pure `computePerimeter` structurally cannot write an audit row, but route/welcome reads and the modified invitation lifecycle still need their named regression evidence.

## 4. Edge cases and test quality

The revised D8 table now correctly owns all sixteen enumerated obligations: same-input alternate-state indistinguishability; both parent invitation surfaces; preview parity/leakage/role/phase/zero/failure/supersession; member target races; welcome archetypes/refresh/roster negative; every flag-affected surface; and the seeded E2E path (`plan-v2.md:180-200`). It also adds phase-carry and injected-read-error suites. Those are genuine fixes, not restatements.

**4.1 — The prior cross-cutting test blocker remains unresolved.** Line 198 merely repeats “A11/D3 secret absence; B9/D4 audit neutrality …; Box/fallback …; D5 keyboard/AT/narrow-width” without assigning a test file, fixture, assertion, or verification method. Add concrete ownership and expected evidence:

1. lookup/preview contract tests that assert secret/credential/token fields are absent, including error responses;
2. audit-log before/after assertions for lookup and both preview modes, plus regression tests proving send, accept, grant, phase change, view, and download keep their required current events and non-secret details;
3. the existing Box/storage success, unavailable, and compensation/fallback suites in the mandatory regression set, with a reason these refactors cannot bypass them;
4. component/browser assertions for keyboard reachability, focus behavior, accessible loading/stale/unavailable announcements, and narrow laptop/mobile layouts across all three surfaces; and
5. migration rollback/compatibility tests from 3.3.

Also name how the seeded runbook proves the preview counts and post-acceptance brief agree after the persisted phase is granted, rather than testing those screens as unrelated snapshots.

## 5. Technical security and consistency

The document-policy refactor is safe as planned: current `documentAccess.ts:61-76` checks external Internal room first, then class-4 MD/oversight, then external phase; v2 changes only the subject type and validates unknown rooms before computation. Existing `DocumentViewer` values still structurally satisfy `DocumentSubject`, so real call ordering need not change. Member preview correctly reuses `userIsDealMd`, and acceptance continues to lock and validate the invite/current recipient before mutation.

**5.1 — Close authorization at an enforceable boundary, including write-time TOCTOU.** Returning a plain exported `PerimeterSubject` only from the `ok: true` branch does **not** make ordering “unskippable” as claimed at `plan-v2.md:88`; TypeScript structural callers can construct the same object and call `computePerimeter` directly. Make the authorized proposal subject opaque/branded with a private constructor, or expose a single server entry point that performs feasibility and computation without accepting an arbitrary subject. More importantly, rerunning `assessProposal` in the route immediately before `create_invite` is still a time-of-check/time-of-use gap. The current RPC transaction enforces actor/company/deal tenant equality (`20260804160000_invite_safeguard_2fa.sql:357-379`) but does not enforce current actor invitation authority, company type, party relationship, deal-role derivation, or director/company-role privilege; those can change after the async route check and before the insert. Put the mutable authority/shape invariants inside the write transaction (with the required locks/conditional checks), or pass and atomically validate a versioned authorization snapshot. Keep the route check for early UX, but prove cross-tenant, lost-authority, changed-party, changed-company-type/role, and concurrent send cases fail without an invite, credential, or audit side effect. This is the required send-time TOCTOU protection, not trust in preview state.

**5.2 — Filter lookup candidates by exact disclosure/invitation scope, including the no-selected-company case.** `plan-v2.md:112` builds an external actor's candidate set from their own company **plus every party to the deal** and gives internal staff every company in the tenant. That is not automatically A2/A3 authority: the current `userCanInvite` permits an external director to invite only their own company (`access.ts:317-327`), and not every in-tenant company is necessarily a target the internal actor may invite. Saying lookup is an `assessProposal` caller (`plan-v2.md:90`) does not resolve the first keystroke, because `Proposal` requires a `companyId` while lookup is precisely trying to find one. Define the authorization algorithm for no selected company and for each candidate before returning a match/evidence/name. A candidate may contribute only when the actor is allowed to identify it and the surface context gives the actor invitation-composition authority; exact invitation feasibility must be applied once company/role inputs exist. Add negative tests where an external director enters another deal party's verified domain, an internal actor lacks authority over an unrelated in-tenant company, and no company is selected. Retain the otherwise-correct explicit tenant equality for A17, A18 deal-membership scope, existing-invite `userCanManageInvite` scope, fixed warning schema, and same-input indistinguishability tests in the complete plan required by 1.3.

## Decision

`changes_requested`. Findings 1.3, 3.3, 4.1, 5.1, and 5.2 are blocking. The next round must verify these findings plus the complete delta, all eight original findings, document-wall check order, migration forward/rollback behavior, atomic send/accept TOCTOU, actor-scoped lookup/welcome data, feature-flag parity, audit/secret/Box/a11y evidence, and all sixteen D8 obligations.
