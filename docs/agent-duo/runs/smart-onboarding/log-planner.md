---
run_id: smart-onboarding
type: log
round: 0
---

# Planner log — smart-onboarding

## 2026-08-08T06:42Z — Run start

- Worktree: `/Users/martincasado/orca/workspaces/intellibank/duo-smart-onboarding`
- Branch: `duo-smart-onboarding`
- Base verification: `git rev-list --left-right --count origin/develop...HEAD` → `0	0`. HEAD is exactly `origin/develop` (`8c20901`). Confirmed based on develop.
- Read in full: `docs/agent-duo/runs/smart-onboarding/brief.md`, `README.md`, `CLAUDE.md`.
- Reviewer terminal handle: `term_ae4664b5-f339-47f0-b41a-99008c65c825`

## 2026-08-08T06:44Z — Orchestration run created

- Command: `orca orchestration run-create --objective "Implement and review smart-onboarding: smart lookup, live perimeter preview, and personalized invitee brief" --json`
- **Orchestration Run ID: `run_e5946bef9d53`**
- Coordinator handle: `term_120850ac-c8c4-4374-a19f-bcff40a73f43`
- All review Tasks and Dispatches for this run belong to `run_e5946bef9d53`.

## Phase plan

1. Phase 1 — spec (`spec-v1.md`), reviewer approval, freeze.
2. Phase 2 — plan (`plan-v1.md`) after spec freeze, reviewer approval, freeze.
3. Phase 3 — execute, full lint/test/build gates.
4. Phase 4 — draft PR into `develop`, `prr-<number>.md`, reviewer approval, ready-for-review, stop without merging.

## 2026-08-08T06:47Z — Phase 1 code survey (read-only, no edits)

Read to ground the spec in real vocabulary and existing surfaces:

- `src/lib/api/v1/access.ts` — `userCanInvite`, `userCanManageInvite`, `canManageDealMembers`, `userIsDealMd`, `userCanUploadToDataroom`, `userIsOnboarded`, `classifyInternalUser`.
- `src/lib/api/v1/documentAccess.ts` — the document wall: `getDocumentViewer`, `userCanSeeDocument` (internal-room exclusion → MNPI → phase), `userCanUploadDocument`.
- `src/lib/api/v1/inviteDomain.ts` + `src/lib/constants/invites.ts` — domain normalization/classification (`match | mismatch | personal | unverified`), confirmation TTL.
- `src/app/api/v1/invites/preflight/route.ts` — the existing pre-send domain gate.
- `src/components/team/InviteModal.tsx` — the live Team invitation surface (preflight → confirm → POST `/api/v1/invites`).
- `src/components/wizard/inviteQueue.ts` — the Gate 0 queued-invite chip state machine.
- `src/app/(authed)/projects/[projectId]/page.tsx` — `externalDealHome()`, the scoped external deal home (today: code, codename, phase, two links).
- `src/app/api/v1/deals/[dealId]/members/[userId]/route.ts` — PATCH phase raise (MD-only, monotonic, audited as `grant`).
- `src/lib/constants/roles.ts`, `src/lib/constants/documents.ts` — role/room/classification vocabulary.
- `docs/03-engineering/onboarding-demo-runbook.md` — the existing demo script this run must extend.

Mandatory gates recorded for Phase 3: `npx eslint .`, `npx tsc --noEmit`, `npm test`, `npm run build` (Node 22 via `.nvmrc`).

## 2026-08-08T06:47Z — spec-v1.md written

`docs/agent-duo/runs/smart-onboarding/spec-v1.md`. Structure: problem, goals, non-goals, vocabulary, user behavior (3 parts), 45 numbered acceptance criteria (A1-A12 lookup, B1-B12 preview, C1-C11 brief, D1-D10 cross-cutting), out-of-scope boundaries, 12 resolved product questions. No implementation choices.

## 2026-08-08T06:48Z — Dispatch: spec review round 1

- Task: `task_efdca8924a94` ("spec review r1")
- Dispatch: `ctx_55b1f3d86614` → terminal `term_ae4664b5-f339-47f0-b41a-99008c65c825`
- Worktree reused (`existing_worktree`), terminal reused. Expected report: `cr-spec-v1.md`.
- Waiting on `orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000`.

## 2026-08-08T06:55Z — Delivery 1 processed: spec review r1

- Delivery `delivery_ccb9af5a47e9`, message `msg_6681a1231856`, type `worker_done`, outcome `succeeded`.
- Report: `cr-spec-v1.md`. Frontmatter `status: changes_requested`, `source: spec-v1.md`. All five rubric sections present, so the report is accepted as valid.
- Five blocking findings, all judged legitimate and accepted without pushback:
  1. **1.1** The brief mandates loading, *empty*, unavailable and stale preview behavior. B8/B10 covered loading/stale/unavailable; nothing defined the zero-document preview state (C11 is the welcome brief, not the preview).
  2. **2.1** Lookup pre-fills security-relevant controls, but no criterion bound a result to its inputs or defined failure / in-flight / out-of-order-response behavior.
  3. **4.1** C1 ("renders identically on every later visit") contradicted C3 (recomputed from current data). The narrative and Q10 support the live-reading reading.
  4. **5.1** C10 permitted rosters for "counterparties already visible", which widens the brief (`never ... another company's roster`) and conflicts with `userCanViewCompany`.
  5. **5.2** A5(c)/(d) disclosed "is a platform user" / "holds a seat" unconditionally. Authority to compose an invitation is not authority to probe the user base; lookup would have become a wider identity oracle than the surfaces beside it.

## 2026-08-08T06:57Z — spec-v2.md written (round 2)

New file, not an in-place edit. Resolutions:

| Finding | Resolution in spec-v2.md |
|---|---|
| 1.1 | New **B13** zero-access preview state (states no documents available, keeps destinations/capabilities and the B5 invariants, discloses no inaccessible count). D8.10. |
| 2.1 | New **A13** (result bound to bound inputs), **A14** (input change withdraws result + pre-fill; superseded responses discarded regardless of arrival order), **A15** (in-flight state announced), **A16** (failure = neutral, no recommendation, no pre-fill, no gate bypass). D8.5-6. B8 also tightened for preview supersession. |
| 4.1 | **C1** rewritten: structure stable across visits, values/capabilities/actions recomputed every render. New **Q14** explains the distinction. D8.13. |
| 5.1 | **C10** prohibition made unconditional ("without exception"); the Team link is explicitly not a channel for roster content into the brief. D8.14. |
| 5.2 | **A5** re-anchored to scoping; **A17** (existing-user disclosure scope), **A18** (existing-seat disclosure scope), **A19** (bare fact only + indistinguishability: an unauthorized actor cannot separate existing-but-invisible from unknown). **A2** amended: invite authority is necessary but not sufficient. New **Q13**. D8.3-4. |

Also added a "bound inputs" and "visibility scope" entry to the vocabulary section, and expanded D8 from a prose list into 16 enumerated test obligations.

## 2026-08-08T06:58Z — Dispatch: spec review round 2

- Task: `task_f1a2726935ba` ("spec review r2")
- Dispatch: `ctx_154093072cd7` → same terminal `term_ae4664b5-f339-47f0-b41a-99008c65c825` (transferred before acknowledging delivery 1, per the review contract).
- Delivery `delivery_ccb9af5a47e9` acknowledged on the following `check --ack`.
- Expected report: `cr-spec-v2.md`.

## 2026-08-08T07:05Z — PHASE 1 COMPLETE. Spec frozen at `spec-v2.md`

- Delivery `delivery_1b0f6e9513d8`, type `worker_done`, outcome `succeeded`.
- `cr-spec-v2.md` frontmatter: `status: approved`, `source: spec-v2.md`, `round: 2`. All five rubric sections present (Faithfulness / Testable behavior / Scope control / Resolved product decisions / Consistency and safety) plus a Decision section. Valid report.
- All five round-1 blockers confirmed resolved; fresh full-document pass found no new blocker.
- **`spec-v2.md` is the frozen spec for this run.** `spec-v1.md` is superseded and must not be edited. Phase 2 maps every criterion in `spec-v2.md` §6 (A1-A19, B1-B13, C1-C11, D1-D10). Any change required to the frozen spec is an escalation, not an edit.
- Review rounds used in phase 1: 2 of 3.

## Durable code map (established by the Phase 1 survey; avoids re-reading)

**The shared-policy seam — the load-bearing find for criterion B2.** The repo already separates *who the viewer is* from *what that viewer may see*:

- `src/lib/api/v1/documentAccess.ts`
  - `getDocumentViewer(admin, userId, dealId)` → `DocumentViewer { userId, isExternal, hasOversight, dealRole, phase }` (DB lookup; `null` when no seat and no oversight).
  - `userCanSeeDocument(viewer, { room, classification, min_phase })` — **pure**. Order is load-bearing: internal-room exclusion for external users, then MNPI (class ≥ 4 → md/cco only), then phase gate (external only).
  - `userCanUploadDocument(viewer, room, classification)` — **pure**. External: deal room only, seller only, class ≤ 3 (`SELLER_MAX_CLASSIFICATION`).
  - Consequence: the perimeter preview can feed these same pure predicates a *proposed* viewer, giving B2 parity by construction rather than a second implementation.

- `src/lib/api/v1/access.ts` — `userCanInvite(admin, actorId, {companyId, dealId})`, `userCanManageInvite(admin, actorId, {companyId, dealId})`, `canManageDealMembers`, `canManageCompanyMembers`, `userIsDealMd`, `userCanAccessDeal`, `userCanViewCompany` (own company or firm overseer), `userCanSearchCompanies`, `userCanUploadToDataroom`, `userIsOnboarded`, `classifyInternalUser`. Admin/overseer reach is tenant-wide, never cross-tenant (#116/#141/#144 family).

- `src/lib/api/v1/inviteDomain.ts` — `normalizeInviteEmail`, `inviteEmailDomain`, `isPersonalInviteDomain` (15-domain deny set), `domainMatchesVerifiedDomain` (exact or subdomain), `classifyInviteDomain(email, verifiedDomains)` → `match | mismatch | personal | unverified`.

- `src/app/api/v1/invites/preflight/route.ts` — the existing pre-send domain gate. Pattern for every `/api/v1` handler: `requireFlag('platform_onboarding')` → `requireApiUser()` → `resolveDealRef()` → predicate → work. Non-`match` classifications insert an `invite_domain_confirmations` row and return `confirmationId`.

- `src/app/api/v1/invites/route.ts` (POST) — `userCanInvite`; `company.type !== COMPANY_TYPE.BANK` ⇒ external company; `INTERNAL_INVITE_DEAL_ROLES = [deal_team, legal, read_only]`; `EXTERNAL_INVITE_DEAL_ROLES = [seller, buyer]`; `SELLER_PARTY_ROLES = [target, co_seller]`; `md` is never invitable. **Duplicate-invite precedent for criteria A6/A19:** on `result.duplicate`, `userCanManageInvite` decides between a 409 carrying `inviteId`/`deliveryStatus` and an opaque `duplicate_pending` 409.

- `src/app/(authed)/projects/[projectId]/page.tsx` — `externalDealHome(userId, projectId)` is the welcome-brief surface. Today: resolve deal ref → seat check → `code · status · Phase n`, codename, seat sentence, two cards (Data Room, Team). `export const dynamic = 'force-dynamic'`.

- `src/app/api/v1/deals/[dealId]/members/[userId]/route.ts` — PATCH is the phase raise (criterion B11's host): MD-only (`userIsDealMd`), monotonic (downgrade → 409), equal-phase idempotent, audited as `AUDIT_ACTION.GRANT` with `detail.reason = 'phase_raised'`.

- `src/lib/perspective/access.ts` — `ALLOWED_DESTINATIONS.external = { mandate, dataRoom, team }`. This is the C9 permitted set. Nav gating is presentation, not security (ADR-0009).
- `src/lib/perspective/serverIdentity.ts` — `getShellIdentity()` → `{ userId, perspective, isExternal, isInvited }`; fails open to the internal shell by design.

- UI surfaces: `src/components/team/InviteModal.tsx` (Team invite dialog: preflight → confirm → `POST /api/v1/invites`), `src/components/wizard/inviteQueue.ts` (Gate 0 chip state machine, pure, queues until the deal exists), `src/components/team/MemberDrawer.tsx` (phase-raise controls), `src/lib/team/roster.ts`.

- Constants (typed mirrors of the SQL `CHECK` enums; the migration is the source of truth): `src/lib/constants/roles.ts` (`DEAL_ROLE`, `COMPANY_ROLE`, `FIRM_ROLE`, `DEPARTMENT`, label maps), `src/lib/constants/documents.ts` (`DOCUMENT_CLASSIFICATION` 1 Public / 2 Internal / 3 Confidential / 4 MNPI; `DOCUMENT_ROOM` internal | deal), `src/lib/constants/invites.ts`, `src/lib/constants/companies.ts` (`COMPANY_TYPE`, `PARTY_ROLE`).

- Tests: flat files in `tests/*.test.ts(x)` (282 files). Vitest, jsdom, globals, setup `src/test/setup.ts`, alias `@` → `src`. Nearest neighbours to copy conventions from: `api-v1-invite-preflight.test.ts`, `document-wall.test.ts`, `access-external.test.ts`, `api-v1-members-patch.test.ts`, `team-roster-live.test.tsx`, `gate0-wizard-api.test.tsx`.

- Docs/contract surfaces to keep synchronized (criterion D9): `openapi/phase1.json` (served at `/api/v1/openapi.json`, explorer at `/dev-api`), `docs/03-engineering/api-v1.md` (§"Onboarding & data room (`platform_onboarding`)"), `docs/03-engineering/onboarding-demo-runbook.md` (the D7 runbook to extend).

**Mandatory Phase 3 gates:** `npx eslint .`, `npx tsc --noEmit`, `npm test`, `npm run build`. Node 22 (`.nvmrc`).

Additional facts settled before planning: `company_verified_domains(tenant_id, company_id, domain, source)` with the personal-domain deny list enforced in SQL as well; `deal_parties(deal_id, company_id, party_role)` with `party_role in (target, co_seller, acquirer_shortlist, counterparty)`; `src/lib/api/v1/http.ts` exports `requireApiUser`, `jsonError`, `resolveDealRef`, `isUuid`, `safeInternalPath`, `mintDealCode`; the Gate 0 surface is `src/components/wizard/Gate0Wizard.tsx`.

## 2026-08-08T07:20Z — PHASE 2: plan-v1.md written

Governing idea: the existing split between `getDocumentViewer()` (identity lookup) and the pure `userCanSeeDocument()` / `userCanUploadDocument()` predicates means the perimeter preview can feed those same predicates a *proposed* subject. B2 parity is then structural rather than a second implementation, and the welcome brief reuses the identical module against the real viewer.

19 numbered changes (M1-M19). Highlights:

- **M1** splits `DocumentViewer` into `DocumentSubject` (the four policy-relevant fields the predicates actually read) + `userId`. Predicates take `DocumentSubject`. Existing call sites pass a `DocumentViewer`, which structurally satisfies it, so no call site changes and the load-bearing check order is untouched.
- **M2** `perimeter.ts`: pure `computePerimeter(subject, docs)`. Bands group only the *survivors*, so an unreachable room produces no entry and a count of inaccessible documents is inexpressible (B4/B6/B13). Being pure and synchronous, it cannot write an audit row — B9 holds structurally.
- **M5** `POST /api/v1/invites/lookup`, **M6** `POST /api/v1/deals/{dealId}/perimeter-preview` (one endpoint, two subject kinds).
- Authorization mirrors the achievable action: `userCanInvite` for a prospective invitee, `userIsDealMd` for a member phase raise (the same predicate the PATCH requires), so the preview can never depict a consequence the actor could not bring about.
- **A19 indistinguishability** is achieved by response *shape*: `warnings` is a flat array, an undisclosed condition contributes no element, and no per-check status map, count, or suppression-varying order exists. The plan explicitly names `checks: { existingUser: 'not_permitted' }` as a regression a reviewer should reject.
- The document query projects only `room, classification, min_phase`; titles and storage ids never enter the computation.
- **No migration.** Every path is read-only; rollback is reverting the branch.
- §11 maps the 16 D8 obligations onto 8 test files, including a generated-matrix parity assertion that fails if preview and real access ever diverge.

## 2026-08-08T07:22Z — Dispatch: plan review round 1

- Task: `task_64a719631b15` ("plan review r1")
- Dispatch: `ctx_3c4992e02ab8` → terminal `term_ae4664b5-f339-47f0-b41a-99008c65c825` (transferred before acknowledging delivery 2).
- The task spec directs the reviewer at the four highest-risk claims: the M1 refactor's call-site/order safety, whether the flat warnings array truly delivers A19, whether the two authorization choices disclose no more than the actor could achieve, and D8 coverage. It also instructs that any silent change to the frozen spec is an escalation, not an approval.
- Delivery `delivery_1b0f6e9513d8` acknowledged on the following `check --ack`.
- Expected report: `cr-plan-v1.md`.

## 2026-08-08T07:35Z — Checkpoint: wait command killed, reviewer unaffected

My backgrounded `check --wait` was killed at ~600s of its 900s budget. This is a checkpoint, not a failure, and specifically **not** a reviewer problem. State inspected before taking any action:

- `task_64a719631b15` status `dispatched` — the reviewer is alive and holds the dispatch.
- A non-waiting `check` returned a single `heartbeat` message, `phase: reviewing`. The worker is mid-pass.
- `delivery_1b0f6e9513d8` did **not** reappear as unread, which confirms the earlier `--ack` landed before the kill.
- `cr-plan-v1.md` already exists on disk (11843 bytes) but is **not** treated as authoritative. A report is only authoritative on `worker_done`; reading a file mid-write risks acting on a draft, which is precisely what the delivery contract prevents.

Action taken: acknowledged the heartbeat delivery `delivery_9652ef672bbc` and re-issued the same wait. The worker was not killed, restarted, or re-dispatched — the run contract forbids disturbing a live worker merely for elapsed time, and nothing here indicated anything but normal progress.

## 2026-08-08T07:55Z — Delivery 3 processed: plan review r1 → changes_requested

- Delivery `delivery_da69879c40f4`, `worker_done`, outcome `succeeded`. Report `cr-plan-v1.md`, `status: changes_requested`, five rubric sections + Decision. Valid.
- Eight findings: 1.1, 1.2, 3.1, 3.2, 4.1, 5.1, 5.2, 5.3.

**Each finding was verified against source before being accepted.** Four were load-bearing enough to check directly, since three assert security defects and one pulls a migration into scope:

| Claim | Verification | Verdict |
|---|---|---|
| 5.3 `userCanSeeDocument` does not deny unknown rooms | `documentAccess.ts:63` special-cases only `DOCUMENT_ROOM.INTERNAL`; an unrecognized room falls through Wall 1 and returns `true` when classification < 4 and phase allows | **Confirmed.** plan-v1 §10 contained a false security guarantee I had written |
| 5.1 `userCanInvite` is not a feasible-invitation check | `access.ts:304` `if (actor.firm_role === FIRM_ROLE.ADMIN) return true;` fires before any tenant check; its own docblock says shape constraints "are enforced in the route" | **Confirmed.** v1 would have let a firm admin probe cross-tenant document counts, regressing the invariant #116/#141/#144 just hardened |
| 5.2 `userCanViewCompany` cannot scope a cross-tenant fact | returns `true` for any cco/admin without ever loading the target company's tenant | **Confirmed** |
| 1.1 confirmed phase cannot survive send | `20260804160000…sql:707-711` inserts `phase, 0` literal and audits `'phase', 0`; `invites` has no `phase` column; `POST /api/v1/invites` never mentions phase | **Confirmed.** Frozen A9 requires confirming *phase* before sending, so without persistence a confirmed phase 2 previews phase-2 access and grants phase 0 — the preview becomes a lie |
| 1.2 no Gate 0 pre-send preview | `brief.md:29` requires integrating with both existing flows and forbids a third; Gate 0 queues locally because no deal exists, so a deal-scoped preview route cannot serve it | **Confirmed** |

No finding was rejected and none required escalation: 1.1 implements frozen A9 rather than changing it, and spec Q12 already admitted a migration if persistence proved necessary.

## 2026-08-08T08:05Z — plan-v2.md written (round 2)

New file; `plan-v1.md` superseded and left untouched. §0 maps all eight findings to resolutions. Substantive changes:

- **§3 migration (M20)** — `invites.phase int not null default 0 check (phase >= 0)`. The default makes the backfill exact, so the migration is safe to apply ahead of the code. `create_invite` gains `p_phase`, following this repo's own precedent: the safeguard migration already dropped and recreated that function with a changed signature (`20260804160000…sql:328-330`). `accept_invite` keeps its signature; its body swaps the literal `0` for `v_invite.phase` in both the membership insert and the grant audit. Phase carries form → preflight snapshot → send → `invites.phase` → accept → seat → audit. Gate 0's non-applicability is stated and tested, not silently dropped: its invitees are internal and phase gates external users only, so the server coerces to 0.
- **§4 `assessProposal` (M21)** — one shared feasibility path for lookup, preview, and send. Tenant coherence is checked **first and unconditionally**, so feasibility never inherits `userCanInvite`'s admin short circuit. Returning the assembled subject only on `ok: true` makes it impossible to compute a perimeter for a proposal not first proven feasible.
- **§5** — preview endpoint moved off `/deals/{dealId}` to `POST /api/v1/invites/perimeter-preview` with an optional deal context, so Gate 0 is served without the third invitation flow the brief prohibits. The wizard's existing create-then-send ordering and final confirm are unchanged.
- **§2** — the unknown-room guarantee moves to the **decode boundary** (`parseDocumentRoom`), not the predicate. I deliberately did not change `userCanSeeDocument`'s real-access semantics to make my earlier claim true; an unrecognized room is never counted and forces an unavailable response.
- **§6** — candidate companies are actor-scoped *before* matching; A17 no longer uses `userCanViewCompany` and requires explicit tenant equality. One canonical response schema, fixing v1's own contradiction between "flat array of ids" and an object example. Reasons are stable ids, so no prose ships from the API.
- **§7** fail-closed: error / absent / present are now distinct; a failed document read can never render as `total: 0`.
- **§8** discriminated bound inputs including a `member` variant carrying `dealId` + `userId`, so a late response for one member cannot satisfy another.
- **§10** test matrix rewritten. The indistinguishability test is now the *same* request against two world states differing only in the hidden fact — v1's cross-address deep-equality was impossible because `normalizedEmail` differs, which the reviewer caught correctly.

## 2026-08-08T08:07Z — Dispatch: plan review round 2

- Task `task_bd059a051a32` ("plan review r2"), dispatch `ctx_550a214688c8`, same terminal.
- Delivery `delivery_da69879c40f4` acknowledged on the following `check --ack`.
- Expected report: `cr-plan-v2.md`. **This is round 2 of a maximum 3 for this phase.**

## 2026-08-08T08:25Z — Delivery 4 processed: plan review r2 → changes_requested

- Delivery `delivery_8e8e889b312f`, `worker_done`, `succeeded`. Report `cr-plan-v2.md`, `status: changes_requested`, five rubric sections + Decision. Valid.
- Five findings: 1.3, 3.3, 4.1, 5.1 (a and b), 5.2. All accepted.

Four were mine and mechanical:

- **1.3** — plan-v2 declared it superseded plan-v1 while deleting v1's design detail, which silently made most of the implementation contract non-normative. I had compressed v2 to deltas without adjusting the supersession claim.
- **3.3** — I wrote that dropping `invites.phase` causes "no data loss." False. A pending invite carrying a confirmed phase 2 holds a real access decision; dropping the column destroys it and acceptance afterwards grants phase 0 silently — the exact lie the migration exists to prevent, arriving through the back door.
- **4.1** — the cross-cutting obligations (A11/D3 secrets, B9/D4 audit neutrality, Box non-regression, D5 a11y) were a sentence with no file, fixture, or assertion owner.
- **5.1a** — my claim that returning the subject only on `ok: true` made the ordering "unskippable" was wrong: TypeScript structural typing lets any caller construct the object literal.

**5.2** was also correct: plan-v2 gave an external actor "own company plus every deal party" and internal staff "every company in the tenant," but `userCanInvite` permits an external director to invite **only their own company** (`access.ts:317-327`). The reviewer also caught that `Proposal` requires a `companyId` while lookup is precisely trying to discover one, so `assessProposal` cannot gate the first keystroke.

**5.1b (send-time TOCTOU) was the one genuine judgment call.** The window is pre-existing: the route checks authority async, then `create_invite` enforces tenant equality in-transaction but not actor authority, party relationship, company type, or role derivation. Every invitation sent on `develop` today has that window; my change does not introduce it, so arguing scope would have been defensible.

I chose to close it. Reasons recorded for the PR: this change adds a new authority-bearing input (`phase`) that flows into that exact write; compliance is this product's stated moat and the write path is where it lives; and `create_invite` already performs security-definer validation in-transaction, so the pattern is being followed rather than invented. Inspection confirmed the RPC already loads actor tenant, validates company/deal tenant, and takes `pg_advisory_xact_lock` on the email — which also already serializes concurrent sends — so the new checks slot into existing structure.

**The real risk is divergence, not effort.** SQL re-derivation that disagrees with the TS predicate would silently break shipped Gate 0 and Team invitations. plan-v3 therefore makes TS/SQL parity across every authority tier a mandatory test, and sequences it *before* anything else touches the send path.

## 2026-08-08T08:40Z — plan-v3.md written (round 3, the complete operative plan)

`plan-v1.md` and `plan-v2.md` are both superseded and non-normative; v3 stands alone. Additions beyond the five resolutions:

- **§13 criterion map** — every A/B/C/D criterion mapped to both an implementation site and a verifying test.
- **§4.3 ordered rollback** — revert app first, then expire and audit nonzero pending invites (making the loss explicit and recoverable), then revert RPCs, then drop the column. Forward compatibility holds because `default 0` makes old callers behave identically.
- **§5.2 brand** — `AuthorizedSubject` carries a module-private `unique symbol`, so it is constructible only inside `proposalFeasibility.ts` and `computePerimeter` accepts nothing else. Compiler-enforced rather than conventional.
- **§5.3** — authority and shape re-derived inside the `create_invite` transaction, under the existing advisory lock, each failure raising a distinct exception mapped to an opaque 403 with no invite row, credential nonce, delivery, or audit side effect.
- **§7.1** — `candidateCompaniesFor` mirrors real invite authority per tier, and the no-company first keystroke requires invitation-composition authority in the surface context rather than being ungated.
- **§12.3** — each cross-cutting obligation now has a file, fixture, and assertion.

## 2026-08-08T08:42Z — Dispatch: plan review round 3 (final)

- Task `task_c966fd7299cc` ("plan review r3"), dispatch `ctx_6960bf38821e`, same terminal.
- Delivery `delivery_8e8e889b312f` acknowledged on the following `check --ack`.
- The task spec tells the reviewer this is the **third and final** substantive round for this phase, and asks it to state explicitly in its Decision section whether any remaining item is genuinely blocking or merely advisory.
- **If this returns `changes_requested`, I write `escalation.md` with both positions and stop for a user decision. I do not silently choose.**

## 2026-08-08T09:20Z — Delivery 5 processed: plan review r3 → changes_requested (terminal)

- Delivery `delivery_a01d0a3299ad`, `worker_done`, `succeeded`. Report `cr-plan-v3.md`, `status: changes_requested`, round 3, five rubric sections + Decision. Valid.
- **Seven findings: 1.1, 2.1, 3.1, 4.1, 5.1, 5.2, 5.3. Reviewer states all are genuinely blocking with no advisory-only items, and that terminal escalation is required.**
- The reviewer affirmed plan-v3 as materially more complete than v2 and listed the parts it judged correct (recorded in `escalation.md` so a further round does not relitigate them).

### Verification before escalating

I verified every finding against source rather than accepting or disputing them on assertion. All seven confirmed:

- **2.1** `invites/route.ts:126-145` — coercion is keyed on `actorIsExternal` (`is_external && firm_role !== ADMIN`), and a Director invite is permitted separately when `canManageCompanyMembers` holds. `InviteModal.tsx:145-149` locks only on `viewer?.isExternal`, and the Member/Director select is offered for external companies when unlocked. **My plan conflated external company with external actor and would have removed an authorized internal MD's ability to invite an external Director** — contradicting frozen A9, Q5, and the out-of-scope boundary on who may invite.
- **5.1** By inspection of my own plan: `AuthorizedSubject` constructible only in `proposalFeasibility.ts`, but member preview is authorized by `userIsDealMd` and the welcome brief uses the real viewer. **Neither can construct the only input `computePerimeter` accepts, so B11 and C1-C11 are unimplementable through my own declared API.**
- **5.3** `access.ts:337` returns true for `actor.company_id === target.companyId && actor.can_invite === true` — the delegated-invite path from commit #145, **this branch's own base commit**. My candidate rule omitted it. Frozen A17 (`spec-v2.md:129`) has three disclosure branches; I implemented two, omitting the deal-membership branch.
- **5.2** `invite_safeguard_2fa.sql:381-405` — the advisory lock is keyed on email, serializing competing sends but not concurrent revocation of actor privilege, membership, company type, or party rows. Also correct that a parity test comparing only `userCanInvite` cannot detect shape divergence, since that helper's own docblock says shape is enforced in the route.
- **3.1** `invite_safeguard_2fa.sql:673-695` — `accept_invite` takes `select * into v_invite from invites where id = p_invite_id for update` before checking status, so rollback containment must contend on that same row. My "select; set expired; audit" sequence named no transactional boundary.
- **1.1** `Gate0Wizard.tsx:615-638` queues the bank company with an internal role, which has no `deal_parties` row, so my party-derived recommendation produces nothing there. D6 is the Conductia voice/no-em-dash contract (`spec-v2.md:199`) and I mismapped it to the Gate 0 flow boundary.
- **4.1** Frozen `spec-v2.md:153` names the phase-change event explicitly; my audit-neutrality assertion omitted it. No fixture proved verification/TOS/2FA sequencing survives the `accept_invite` change, which matters because those gates live in the RPC I am modifying.

### Position recorded

**I concur with all seven. I have no competing technical position.** Three are defects (2.1, 5.1, 5.3), one is a consequence of my own choice to close a pre-existing TOCTOU (5.2), three are incompleteness (1.1, 3.1, 4.1).

This makes the escalation procedural rather than adversarial: the round cap is exhausted while the findings are convergent and uncontested. `escalation.md` records four options with a recommendation (Option A: authorize one further plan round, TOCTOU closure retained), and explicitly recommends **against** proceeding to execution on plan-v3, since 5.1 would force improvising the security-critical seam at the keyboard and 2.1 would ship an authority regression.

## 2026-08-08T09:24Z — Run paused for user decision

- `escalation.md` written with both positions, verification evidence, and four options.
- Dispatch `ctx_6960bf38821e` released (`state: retained`, `reason: external_terminal` — the reviewer terminal is externally owned, so the dispatch settles without terminating it).
- Delivery `delivery_a01d0a3299ad` acknowledged. Unread queue: 0. No Task or Dispatch left in flight.
- **Phases 3 and 4 not started. No source file modified; no commit, no push, no PR.** Branch remains at `origin/develop`, 0 ahead / 0 behind.
- Resuming needs only a decision from the user; the reviewer terminal can be re-engaged with a new tracked Task under the same Run `run_e5946bef9d53`.

## 2026-08-08T09:30Z — USER DECISION: Option A

The user reviewed `escalation.md` and authorized **Option A**: one additional plan round, TOCTOU closure retained in scope. Run resumed under the same Run `run_e5946bef9d53`.

## 2026-08-08T09:45Z — plan-v4.md written (round 4, complete operative plan)

`plan-v1/v2/v3` all superseded and non-normative. Resolutions:

- **2.1** — Read `canManageCompanyMembers` before writing the fix. It is **admin-within-tenant OR director of that same company**. So the shipped rule is: external actor (non-admin) coerced to Member; `companyRole` must be director|member; a Director invite requires `canManageCompanyMembers` over the *target* company. Consequences I had to get exactly right: the **firm-admin Director path is real** and my v3 blanket coercion would have denied it; a delegated `can_invite` member fails that predicate (it demands `company_role === DIRECTOR`), which is precisely why the route comments call delegation "send-only for member seats". Mirrored in TS and SQL with positive and negative parity cases on both.
- **5.1** — Dropped the brand entirely. A private pure core (`computePerimeterInternal`) sits behind **three** entry points — `perimeterForProposal` (assessProposal), `perimeterForMember` (`userIsDealMd`), `perimeterForViewer` (`getDocumentViewer` wall). No subject-accepting function is exported at all, which is a stronger guarantee than a brand and, unlike v3, leaves B11 and C1-C11 actually implementable.
- **5.2** — Deterministic `for share` order inside `create_invite` (users → companies → deals → deal_memberships → deal_parties) after the existing advisory lock. `for share` blocks concurrent update/delete of exactly the rows the decision reads, so a revocation either precedes our read or waits until after our insert. Deadlock-safe by fixed ordering. Parity test now compares the **full verdict**, not `userCanInvite` — which by its own docblock excludes shape, and would have blessed the v3 Director bug.
- **5.3** — Added the `can_invite` own-company candidate branch (`access.ts:337`, the #145 delegation path) and frozen A17's missing branch (b), actor authorized over the membership of a deal on which the user holds a seat.
- **3.1** — Single-transaction `update … where status='pending' and phase>0 … returning`, contending on the same row lock `accept_invite` takes; withdrawal audit rows built only from returned rows; column dropped only after containment commits. Both interleavings tested.
- **1.1** — Bank-side recommendation defined: `deal_team` with `legal`/`read_only` one click away, company role member, phase 0 non-applicable. Reading recorded for the reviewer to check: frozen A7's "least-privilege" qualifies **phase**, not role, so an ordinary working seat is the context-appropriate internal recommendation. D6 rebound to the voice/copy contract with a mechanical em-dash assertion over the reason-copy map and the three components. A1 map now names M11/M12.
- **4.1** — Every cross-cutting obligation has a file and a concrete assertion, including opaque **error** responses for secrets, the frozen phase-change audit event, and fixtures proving verification/TOS/2FA sequencing survives the `accept_invite` change.

## 2026-08-08T09:47Z — Dispatch: plan review round 4

- Task `task_cf5c0db2feda` ("plan review r4"), dispatch `ctx_41e7c2b7464b`, same terminal.
- Task spec states the round was granted by explicit user decision after terminal escalation, enumerates all seven prior findings as verification targets, and asks the reviewer to mark any remaining finding as blocking vs advisory so I can distinguish what must return to the user from what can be resolved during execution.
- Expected report: `cr-plan-v4.md`.

## 2026-08-08T10:05Z — Delivery 6 processed: plan review r4 → changes_requested

- Delivery `delivery_f2ea0c2fbca9`, `worker_done`, `succeeded`. Report `cr-plan-v4.md`, `status: changes_requested`, round 4, five rubric sections + Decision. Valid.
- **Resolved: prior 1.1, 3.1, 4.1, 5.2.** The reviewer confirms 2.1's substantive actor-role rule is now correct, and affirms the write-transaction design in detail (advisory lock then deterministic `FOR SHARE` over actor/company/deal/membership/party, full-verdict parity).
- **Remaining blocking: 1.2, 2.1 (test case only), 4.2, 5.1, 5.3.** No advisory items.

### Assessment

One is a genuine error:

- **5.1** — I claimed `computePerimeterInternal` was "module-private" in `perimeter.ts` with entry points in `index.ts`. TypeScript has no cross-file privacy: `index.ts` can only call it if `perimeter.ts` exports it, and then any caller can deep-import and forge a `DocumentSubject`. No restricted-import rule exists in the repo to make the boundary real. **No defense; the reviewer is right.** Worth noting this seam has now been wrong three rounds running — first the brand (v3), then a fake module boundary (v4). Fix is one module with only the three entry points exported, or a lint-enforced boundary.

Four are completeness rather than judgment:

- **1.2 / 4.2** — the same issue twice, as the reviewer states. I declared v1-v3 non-normative and then referenced "thirteen files as in v3 §12.1" and deferred the criterion table to "during execution." Self-contradictory, and a plan review cannot approve a table that does not exist yet. Fix is transcription; the content is already written in v3.
- **2.1** — missing the second `canManageCompanyMembers` branch as a parity case: Director *of that same target company* → Director permitted.
- **5.3** — "canManageDealMembers + deal parties" is ambiguous; needs the exact algorithm and named positive/negative tests.

Nothing is contested. I have no disagreement with any of the five.

### Trend

| Round | Findings | Defects |
|---|---|---|
| r1 | 8 | 3 |
| r2 | 5 | 2 |
| r3 | 7 | 3 |
| r4 | 5 | 1 |

Converging on substance. The countervailing risk, recorded honestly: the reviewer does a fresh full pass each round, so restructuring surfaces round-specific findings — 1.2 and 4.2 exist *because* v4 reorganized. A v5 could converge or could surface v5-specific documentation findings.

## 2026-08-08T10:08Z — Run paused for second user decision

- `escalation-2.md` written: four options, recommending **Option C** (fix the substantive findings in a v5, proceed to execution without another plan-review cycle, let the reviewer's next gate be the PR where tests are runnable evidence rather than promises in prose). Recommends against Option B, since 5.1 is a real defect in the security seam.
- Dispatch `ctx_41e7c2b7464b` released (`retained` / `external_terminal`). Delivery `delivery_f2ea0c2fbca9` acknowledged. Unread queue 0. Nothing in flight.
- **Still no source file modified, no commit, no push, no PR.** Branch at `origin/develop`, 0 / 0.
- Note for any later resumption: the original task prompt is preserved verbatim at `docs/agent-duo/runs/smart-onboarding/planner.txt` (includes the Phase 3 and Phase 4 contracts and the `prr-<number>.md` artifact requirement).

## 2026-08-08T10:15Z — USER DECISION: Option C

User chose **Option C**: fix the substantive cr-plan-v4 findings in a v5, then proceed to execution **without** another plan-review cycle. The reviewer's next gate is the PR, where tests are runnable evidence rather than prose promises.

## 2026-08-08T10:30Z — plan-v5.md written (final plan artifact)

Complete and standalone; v1-v4 non-normative and nothing depends on them. Resolutions:

- **5.1** — abandoned the cross-file "private core" fiction. **One module** `src/lib/perimeter/perimeter.ts`, no `index.ts`; `computePerimeterInternal` is not exported; the only exports are `perimeterForProposal` / `perimeterForMember` / `perimeterForViewer`, each constructing its own subject from its own authorization. **No exported function accepts a subject, so there is nothing to forge** — the guarantee is the absence of a door, not a lock on one. Belt and braces given this seam was wrong twice: an `eslint no-restricted-imports` rule plus `perimeter-boundary.test.ts` asserting the export surface is exactly those three names.
- **1.2 / 4.2** — full D8.1-D8.16 ownership table (file + assertion per obligation) and the complete A1-A19 / B1-B13 / C1-C11 / D1-D10 criterion map transcribed into §12.1 and §13. Nothing deferred to "during execution".
- **2.1** — added same-company Director → Director permitted, and different-company Director → refused, comparing the **resolved company role** rather than success status.
- **5.3** — exact per-tier candidate algorithm (§7.1), including that an external director has **no** candidate without a deal (`userCanInvite`'s external branch requires `target.dealId`), and named positive/negative tests in `lookup-candidates.test.ts`.

## 2026-08-08T10:35Z — PHASE 3 EXECUTION BEGUN

Environment: Node v22.22.3 matches `.nvmrc` (22). No `.env.local` in this worktree yet; the source repo has one, to be copied when a live DB gate is needed (never committed).

### M1 — policy seam (`src/lib/api/v1/documentAccess.ts`) — DONE

- Split `DocumentSubject { isExternal, hasOversight, dealRole, phase }` from `DocumentViewer = DocumentSubject & { userId }`. `userCanSeeDocument` and `userCanUploadDocument` now take `DocumentSubject`, so the perimeter preview can ask them about a subject that does not exist yet. This is the change that makes B2 structural.
- Narrowed `DocumentGate.room` from `DocumentRoom | string` to `DocumentRoom`.
- Added `parseDocumentRoom(value: unknown): DocumentRoom | null`. Rationale recorded in the file: `userCanSeeDocument` special-cases only the internal room, so an unrecognized value would fall through its walls and read as visible. The DB CHECK makes such a row impossible; this keeps that a fact rather than an assumption, **at the decode boundary rather than by loosening the predicate**.
- **Predicate semantics deliberately unchanged** — Internal → MNPI → phase ordering intact.
- `tsc` after M1: every production call site passed. The only failures were `tests/document-wall.test.ts` fixtures declared as `{ room: string }`; typed them `DocumentGate` and imported the type. No production behavior changed.
- **Verified green:** `npx tsc --noEmit` clean; `npx vitest run tests/document-wall.test.ts` 11/11 passed.

### M21 — `src/lib/api/v1/proposalFeasibility.ts` — WRITTEN

`assessProposal` in the plan-v5 §5 order: tenant coherence (unconditional, before `userCanInvite`'s admin short-circuit) → `userCanInvite` → company-role authority → deal-role shape → phase. Deal-role rules copied verbatim from `invites/route.ts:148-200` rather than recalled, to avoid divergence. Missing-company and wrong-tenant return the same `forbidden` deliberately, so neither confirms the other's existence. Internal seats coerce phase to 0. Fixed one `tsc` error: `InviteTarget.dealId` is `string | null`, not optional.

### Harness finding — DB-backed test convention (affects what §12.2 can promise)

The repo already has the right precedent: `tests/db/*.test.ts` use `describe.skipIf(!RUN_DB_TESTS)` and shell out to `psql` against a transactional probe in `supabase/tests/*.sql` (`begin … do $$ … raise exception 'FAIL: …' … $$; rollback;`), asserting the output contains `ROLLBACK`. The parity suite will follow it exactly: `supabase/tests/invite_authority_parity.sql` + `tests/db/invite-authority-parity.test.ts`.

**Honest limitation to carry into the PR request, not to discover there:** `RUN_DB_TESTS` is **not set in `.github/workflows/*.yml`**, so every SQL probe — the existing ones and mine — **skips in CI**. TS↔SQL authority parity is therefore verified by a documented local command, not enforced by CI. I will state that plainly in `prr-<n>.md` under residual risks rather than implying CI proves parity. Raising it with the reviewer as a known gap is the honest move; silently letting "tests pass" imply parity is not.

### `tests/api-v1-proposal-feasibility.test.ts` — written, and mutation-verified

21 tests covering tenant-first ordering, company-role coercion, party-derived deal-role shape, phase handling, and the error-vs-denial split. Passed 21/21 on the first run.

**That first pass was a false green, and the mutation check caught it.** I deleted the tenant comparison from `assessProposal` and re-ran: still 21/21. The cross-tenant-company case omitted a `deals` fixture, so `from('deals')` returned null and the function refused at the *missing-deal* wall before ever reaching `userCanInvite` — the assertion was satisfied by an unrelated guard, and the test would have certified a build with the cross-tenant hole wide open.

Fixed by making every other fixture in that case valid, so the tenant check is the only thing that can refuse. Re-verified:

- with the tenant comparison deleted: **2 failed | 19 passed** (both tenant-ordering tests)
- reverted: **21 passed**, tenant comparison confirmed present in source

Carrying this forward: for every security-critical assertion in this run, the surrounding fixtures must be valid, otherwise the test proves nothing about the wall it names. I will mutation-check the remaining wall tests (parity, indistinguishability, document counts) the same way rather than trusting a green run.

### M20 — `supabase/migrations/20260808120000_invite_phase.sql` — WRITTEN AND VALIDATED

Built by copying `create_invite` (lines 330-501) and `accept_invite` (654-736) verbatim out of `20260804160000_invite_safeguard_2fa.sql` and then editing surgically, rather than retyping ~250 lines of SQL from memory where a silent transcription slip would be invisible.

Contents: `invites.phase int not null default 0 check (phase >= 0)`; `create_invite` gains `p_phase int default 0` as the final defaulted argument (drop-and-recreate, same precedent as the safeguard migration, with `revoke`/`grant` re-issued for the new 9-arg signature); `accept_invite` keeps its `(uuid, uuid)` signature so its grants survive `create or replace`, and now grants `v_invite.phase` instead of the literal `0` in both the `deal_memberships` insert and the `grant` audit detail.

In-transaction authority (cr-plan-v3 5.2): authority rows are read `FOR SHARE` in one fixed order — `users` → `companies` → `deals` → `deal_memberships` → `deal_parties` — then invitation authority, company-role coercion, deal-role shape and phase bounds are re-derived before the insert, so a director demotion or party removal committing between the route check and the write blocks rather than races. Fixed lock ordering is also what keeps two concurrent senders from deadlocking.

**Verification (env: copied `.env.local`, gitignored, never committed, no secret printed):**
- Ran the whole migration through `psql` wrapped in `begin … rollback;` — `ALTER TABLE / COMMENT / REVOKE / DROP FUNCTION / CREATE FUNCTION / REVOKE / GRANT / CREATE FUNCTION`, probe row `MIGRATION APPLIED CLEANLY`, then `ROLLBACK`. The SQL is proven to execute **without mutating the shared dev database**.
- A `plpgsql` body is only syntax-checked at `CREATE`, not name-resolved, so the probe does not prove column references. Checked each one against `information_schema` separately: `deals.bank_id`, `deal_memberships.access_scope`, `users.can_invite`, `users.firm_role`, `deal_parties.party_role`, `companies.type` — all present.

Not yet done for M20: the SQL parity probe (`supabase/tests/invite_authority_parity.sql`) and the rollback-containment transaction, both of which need the TS side wired first.

### M11a — `src/app/api/v1/invites/route.ts` — DONE

Accepts `phase` (defaults to 0, which is what every pre-existing caller sends), validates it as a non-negative integer, passes `p_phase` to the RPC, and maps the new in-transaction exceptions: `not_permitted` → opaque **403 Forbidden**, `invalid_company_role` / `invalid_deal_role` / `invalid_phase` → **400**. Without that mapping they would have surfaced as 500s carrying raw database text.

**Checkpoint verified: `npx tsc --noEmit` clean, `npm test` → 754 passed | 3 skipped (115 files).** The 3 skips are the pre-existing `tests/db/*` probes, which need `RUN_DB_TESTS=1`. No regression from M1, M20 or M11a.

### M2 — `src/lib/perimeter/perimeter.ts` — DONE

One module, no barrel. `computePerimeterInternal` is not exported; the only exports are `perimeterForProposal` / `perimeterForMember` / `perimeterForViewer`, each building its subject from its own authorization (`assessProposal`, `userIsDealMd` + monotonic-phase refusal, `getDocumentViewer`'s membership wall). The core is pure and synchronous, so B9 (previewing grants nothing, audits nothing) holds structurally.

Counts are computed from survivors only, so an unreachable room is **absent rather than present-and-zero** — a zero is still a disclosure (B4). Unrecognized rooms make the whole result unavailable (B10 + cr-plan-v3 5.3). Exported `ALLOWED_DESTINATIONS` from `perspective/access` rather than keeping a second copy of the permitted set, so C9 has one source of truth.

Dropped two things the plan had called for, because they turned out to be unnecessary rather than merely hard: the dynamic `import()` (no cycle exists) and the `eslint no-restricted-imports` rule (with no barrel and no exported core, there is no import to restrict — the absence of the door is the boundary).

### Tests written and **mutation-verified** (not merely green)

| Suite | Tests | Mutation applied | Result |
|---|---|---|---|
| `api-v1-proposal-feasibility` | 21 | delete the tenant comparison | 2 failed ✅ |
| `perimeter-parity` | 17 | count every gate, ignore the wall | 9 failed ✅ |
| `perimeter-parity` | 17 | skip unrecognized rooms instead of refusing | 1 failed ✅ |
| `perimeter-boundary` | 4 | `export` the pure core | 2 failed ✅ |

All revert cleanly to green. `perimeter-parity` drives a generated 32-document matrix (2 rooms × 4 classifications × 4 phase gates) through the real `perimeterForViewer` entry point for 9 seat archetypes and compares against `userCanSeeDocument` applied directly — so the preview cannot grow its own opinion about visibility without failing.

One test-design correction: the boundary suite's original "no barrel" check used `await expect(import('@/lib/perimeter/index')).rejects.toThrow()`, which Vite tries to resolve at transform time and which failed the whole file to load. Replaced with a filesystem assertion — same guarantee, no resolver dependency.

### M6 — `src/app/api/v1/invites/perimeter-preview/route.ts` — DONE

Not nested under `/deals/{dealId}`: Gate 0 composes invitations before the deal exists, and the brief forbids a third invitation flow, so the deal is optional context rather than the route's identity. Two modes — `proposal` (authorized by `assessProposal`, the same check the send route makes) and `member` (authorized by `userIsDealMd`, refusing a downgrade with the same 409 the real phase raise gives). Failure mapping: `forbidden` → opaque 403, `invalid` → 400, `unavailable` → **503 with no `perimeter` key at all**, so "unavailable" can never arrive dressed as "they can see nothing".

`tests/api-v1-perimeter-preview.test.ts` — 14 tests. Mutation: moved `requireApiUser` ahead of `requireFlag` → **2 failed** ✅ (flag-before-auth is enforced, not incidental).

### M5 — `src/app/api/v1/invites/lookup/route.ts` — DONE

The scoping, not the matching, is the substance. Candidate companies are computed per actor tier before any domain is matched, so an external director cannot learn another party's verified domain by typing an address; an external director with **no deal in context has no candidate at all** (`userCanInvite`'s external branch requires a deal), and a delegated `can_invite` member gets their own company (#145). A17's three branches each require explicit tenant equality. A failed read returns 503 rather than a partial answer — never a match, warning or recommendation built from incomplete data.

`tests/lookup-indistinguishable.test.ts` — 4 tests, the A19 guarantee. Structured exactly as cr-plan-v3 4.1 required: **one fixed normalized request** against two worlds differing only in the hidden row, asserting byte-identical serialized responses. Comparing two different addresses would have proved nothing, since `normalizedEmail` and every domain-derived field differ regardless.

Includes a **positive control** — the same row varied in a way that IS disclosable must produce a *different* response. Without it, "the two responses matched" could pass simply because the route never says anything. Mutation: replaced the A17 tenant equality with `true` → **1 failed** ✅.

Type note: my first draft typed the helper's client with a conditional `Awaited<ReturnType<…>> extends { admin: infer A }`, which resolved to `never` and produced six errors. Replaced with plain `SupabaseClient` — the clever version bought nothing.

### Server side complete. Remaining for Phase 3

M8/M9/M10 components · M11-M14 surface wiring · remaining D8 suites (lookup warnings/candidates/failure, parent-surface supersession, welcome brief, flag-off, E2E) · SQL parity + rollback probes · M15-M18 demo fixture, runbook, OpenAPI, `api-v1.md`.

### M8, M9, M10 — components; M12, M13, M14 — surface wiring (done)

`src/components/onboarding/useBoundRequest.ts` is the shared A13/A14/B8
machinery. The first version tracked the current key in a ref and cleared
state during render; lint's "cannot access refs during render" rule was
pointing at a real design flaw, not style. Rewritten to **derive** staleness:
the fetched entry carries the key it was fetched for, and the hook compares it
to the live key at render time. A response for a superseded key is not
discarded by a guard that could be forgotten, it is simply unreachable through
the return value. Cleanup-flag cancellation replaces the ref entirely.

`SmartLookupCard` holds all user-facing prose (warning and reason copy) so the
API ships stable ids only. `PerimeterPreview` renders, never computes, and its
bound key includes `mode` so a proposal result cannot render for a member
request. `WelcomeBrief` was written async, which broke `external-deal-home`
(RTL cannot resolve an async component nested in an async page); made
synchronous and presentational, with the page awaiting `perimeterForViewer` —
better anyway, since the DB read now sits where the membership wall already is.

Wiring: Team invite modal (lookup + preview + a phase control that feeds the
preflight snapshot, so changing phase invalidates a domain confirmation
obtained for a different disclosure level), Gate 0 team step (lookup + a
no-deal preview), Member Drawer (member-mode preview reading the phase input,
so the perimeter shown is the one the button would grant).

Three defects found by verification rather than by reading:

- The submit callback closed over a stale `phase` (lint dependency warning).
  It would have sent a disclosure level other than the one confirmed on
  screen — the exact failure this feature exists to prevent.
- Both cards crashed on an unexpected response body. Now a body that is not a
  lookup result is a *failed lookup* (A16), and an unrecognized preview shape
  is an *uncomputed perimeter* (B10) rather than a perimeter with zero
  documents — the lie in the dangerous direction.
- `WelcomeBrief` gated the Data Room link on `documents.total > 0`. An empty
  room is still a room; hiding it tells the invitee they lack access they
  hold. Only capability actions (upload, invite) are gated now.

Checkpoint: `npx tsc --noEmit` clean, `npx eslint` clean on all touched files,
`npm test` 793 passed | 3 skipped (119 files).

## Phase 3 — SQL authority parity (M20 verification)

`supabase/tests/invite_authority_parity.sql` + `tests/db/invite-authority-parity.test.ts`
(wrapper follows the existing `tests/db/*` convention: `describe.skipIf(!RUN_DB_TESTS)`
shelling out to psql against a transactional probe).

Twelve cases, asserting the RESOLVED outcome rather than mere refusal: firm admin
creates a Director and phase 2 is stored verbatim; internal Director of that same
company creates a Director; Director of a different company refused; delegated
`can_invite` may not create a Director but may create a Member; external actor
coerced to Member; plain member has no authority; cross-tenant refused;
target-side company taking a buyer seat refused; internal seat pinned to phase 0
even when phase 4 is requested; negative phase refused; and no refused invitation
was persisted.

**The probe found a real security bug in my migration.** `users.firm_role` and
`users.company_role` are nullable, and in SQL `null = 'admin'` is NULL, not false.
So for an ordinary internal director:

    v_can_manage_company := NULL or (true and false)   -- NULL, not false
    if v_company_role = 'director' and not v_can_manage_company then raise

`not NULL` is NULL, the IF is not taken, and the guard silently does not fire.
An internal director could have created a Director at a company they do not
manage. Seven expressions had that shape; every authority derivation is now
`coalesce(..., false)` and both guards are `not coalesce(v_x, false)` — belt and
braces, so neither a new uncoalesced source nor a new guard alone can reopen it.

TypeScript has no equivalent hazard (`undefined === 'admin'` is plainly false),
which is precisely the point: the divergence was invisible to reading the two
implementations side by side, and only a probe that executes both could find it.
This is the concrete payoff of the TOCTOU closure the user authorised under
Option A, and of writing the parity probe before trusting the mirror.

Two earlier probe failures were faults in the probe, not the code, and are worth
recording because both were my misreadings of shipped behaviour:
- fixtures fought the auth mirror trigger (it creates `public.users` rows on
  `auth.users` insert), and a company must have an active director before it can
  take its first member — so fixtures now UPDATE trigger-created rows, directors first;
- case 2 originally used an EXTERNAL director to test "director of that same
  company may create a Director". External actors are pinned to Member before
  authority is consulted, so that case was testing the wrong branch.

## Phase 3 complete — all gates green

| Gate | Result |
|---|---|
| `npx eslint .` | 0 errors, 8 warnings (all pre-existing files) |
| `npx tsc --noEmit` | clean |
| `npm test` | 875 passed, 5 skipped (develop: 754) |
| `npm run build` | succeeded |
| migration + rollback | applied and reverted transactionally, ROLLBACK |
| `RUN_DB_TESTS=1 npx vitest run tests/db` | 12 parity cases + acceptance probe pass |

20 new test suites, 121 net new tests. Ten security guards mutation-checked:
each deleted, suite confirmed to fail, reverted.

Docs synchronized: `openapi/phase1.json` (37 paths), `api-v1.md` new section with
the candidate-scoping table, `onboarding-demo-runbook.md` with a step that
demonstrates the scoping rather than only the happy path.

## Phase 4 — PR opened

| | |
|---|---|
| PR | https://github.com/FutureProofingDev/intelibank/pull/149 (draft, base develop) |
| Head SHA | c3e94deb3fb7d3712d6572322a1bdc87083b0cfe |
| Commits | 5 — policy seam, phase carry, surfaces, docs, PR request |
| Artifact | prr-149.md |
| Review task | task_e656e6603c95 / dispatch ctx_78e682585dec |

Reviewer briefed that plan-v5 was executed without a plan-review cycle by user
decision, so the PR gates both the plan and the implementation, and told not to
assume any part of plan-v5 was pre-approved.

Residual risks disclosed rather than smoothed over: RUN_DB_TESTS is not in CI so
TS<->SQL parity is locally verified only; rollback is not lossless; Gate 0 tests
deviate from the plan's named file; the pre-existing catch-all 500 was left alone.

## PR review round 1 — changes_requested (delivery_306eed6f25fb)

`cr-prr-149.md`, head `c3e94de`. Five blocking findings. Reviewer also posted them
on PR 149 as `#issuecomment-5226804501` (GitHub blocks a formal request-changes
review from the PR author). All five verified against source; all accepted.

Credited as correct and unchanged: perimeter core privacy, assessProposal's
actor-specific Director rule, candidate derivation per tier, TS/SQL parity with
no remaining NULL-logic instance, FOR SHARE lock sufficiency, rollback row-lock
reasoning, document-wall ordering, flag-off, audit neutrality, secret absence.

### 1.1 — bound inputs incomplete, withdrawal did not withdraw. FIXED
`companyId` and `surface` were not bound inputs, so "this domain does not match
the company record" was decided against whichever candidate matched rather than
the SELECTED company. Worse: `onResult(null)` returned early, leaving the
recommendation's phase and company sitting in the form.
- Card and route take `companyId`; key and request body carry it; matching and
  `classifyInviteDomain` run against the selected company's domains when one is
  selected.
- `appliedRef` records what the recommendation applied (phase, company,
  previous company, the email that produced it). Withdrawal reverts only those
  values and only if the inviter has not since changed them.
- Fixing this caused an infinite render loop: reverting `companyId` re-keyed the
  lookup, which emitted null, which reverted again. Cause was conflating "no
  result yet" with "result lost". `onResult` now receives `status`, and only
  `unavailable` or a changed email counts as lost. The loop was a real defect
  that only running the test found.
- Mutation: `const lost = false` -> 1 failed.

### 1.2 — welcome brief offered an action the send route refuses. FIXED
`canInviteTeammate` was `isExternal && companyRole === 'director'`. Real
`userCanInvite` also requires the director's company be a current party. A
seated director of a removed party would have been offered an invite action that
403s. `PerimeterContext` now carries `canInviteTeammate` as a decided boolean;
member and viewer paths call the real `userCanInvite`, and a read failure is
`unavailable` rather than a guess in either direction.

### 4.1 — A19 timing oracle. PARTIALLY FIXED, residue disclosed
Existence changed the work done: membership reads and predicate calls ran only
when rows existed, and the seat query was issued twice. Now a fixed schedule —
same queries, same predicates evaluated, existence changes only what is
concluded. Sentinel `NO_ROW` keeps query shape identical when there is nothing
to look up.
Residue: `userCanManageInvite` branches internally on the company it is handed,
costing one extra read when a pending invitation exists. Removing it means
rewriting a predicate other callers depend on. Pinned by a test that asserts the
difference is exactly one read and the response is still byte-identical, so it
cannot grow unnoticed. Disclosed rather than claimed closed.

### 4.2 — missing and false-positive tests. IN PROGRESS
`invite-modal-lookup` claimed A14 coverage while asserting only that the card
went stale; it passed against a parent that kept the values. Now asserts the
company and phase are actually taken back, and that the inviter's own choice is
not. Still owed: rollback interleaving test, E2E (D8.16), and correcting
`prr-149.md` which overstates evidence for A14, D8.4, rollback and D8.16.

### 5.1 — red production dependency audit. NOT YET ADDRESSED
CI has a FIFTH blocking job I never ran: `Dependency vulnerability audit`
(`npm audit --omit=dev --audit-level=moderate`, ci.yml:68). It fails on
`nanoid <3.3.17` (GHSA-2v37-7h3g-55p8, high). Lockfile is byte-identical to
`develop`, so this is inherited, not introduced — but a required check is red
and the PR cannot be approved over it. I verified only the four gates named in
README/CLAUDE.md and took "all gates green" from those. The docs were not the
authority on what CI requires; CI was.

### Factual correction owed
`prr-149.md` and commit 59805e0 say the authority block runs "under the advisory
lock it already took". It does not: the FOR SHARE row locks protect it, and the
email advisory lock is taken afterward (`invite_phase.sql:191`). Protection is
real, description was wrong.

### PR round 1 fixes — status at context checkpoint

DONE and verified:
- **1.1** bound inputs + real withdrawal (`appliedRef`), render-loop fixed by
  giving `onResult` the status so "in flight" is not read as "lost".
- **1.2** `canInviteTeammate` now decided by the real `userCanInvite`.
- **4.1** fixed query schedule. Proven identical for all three hidden-fact
  classes (user, seat, invitation). The earlier "one extra read" residue I
  logged was WRONG — it was my own fixture draining a mock queue differently,
  not the route. Corrected here.
- **5.1** `nanoid` pinned to `^3.3.17` via the `overrides` block the repo
  already uses for postcss and sharp. `npm audit --omit=dev` now reports 0
  vulnerabilities. This is the fifth CI job I had never run.
- **4.2 (part)** rollback containment probe
  `supabase/tests/invite_phase_rollback.sql` + wrapper: expires only nonzero
  pending rows, audits exactly those, leaves phase-0 and accepted rows, and a
  contained invitation can no longer be accepted.

OPEN:
- `tests/invite-modal-lookup.test.tsx` — my regex adding waitFor timeouts broke
  the withdrawal test; it now fails alone. Must be repaired by hand.
- It also failed in the FULL suite while passing alone before that, so there is
  a real order/load sensitivity to fix, not just a timeout to raise.
- D8.16 E2E still not automated. Do not claim it.
- `prr-149.md` corrections still owed: overstated evidence for A14/D8.4/
  rollback/D8.16, and the false "under the advisory lock it already took"
  (FOR SHARE row locks are what protect it; the email advisory lock comes
  after, `invite_phase.sql:191`).
- `tests/db/*` require the migration to be applied first (`npm run db:migrate`);
  run bare against an unmigrated DB they fail. `legal-hold.sql` additionally
  fails for a PRE-EXISTING reason (`documents.room` not-null), unrelated here.

SECURITY NOTE: a failing `psql` echoed the dev `DATABASE_URL` (with password)
into tool output. Not written to any file, not committed. Treat that dev
credential as exposed to this session.

### PR round 1 fixes — complete, round 2 dispatched

All five blocking findings addressed. Gates: eslint 0 errors, tsc clean,
`npm test` 881 passed / 6 skipped, build compiled, `npm audit --omit=dev` 0
vulnerabilities, DB probes (parity, acceptance, rollback) pass with the
migration applied.

Corrections carried into `prr-149-r2.md` rather than dropped: the "one extra
read residue" I logged for 4.1 was my own fixture, not the route; the advisory
lock claim was wrong (FOR SHARE row locks do the work); D8.16 E2E is still not
automated and is not claimed; the A19 schedule tests are not mutation-confirmed
and that is stated.

Head `154dbe8`. The nanoid pin ended up inside the fix commit (an `add -A`
before committing), and the follow-up commit that described it was therefore
empty — dropped with a `--force-with-lease` push rather than left as history
describing work it does not contain.

PR review r2 dispatched: task_6ebc0daa4a5c, head 154dbe8, artifact prr-149-r2.md,
expected report cr-prr-149-r2.md.

## PR review round 2 — changes_requested (cr-prr-149-r2.md)

Head `154dbe8`. **5.1 RESOLVED** (nanoid override accepted, CI audit green).
Four remain blocking. All four verified as legitimate; none disputed. This was
substantive PR round 2 of 3.

Credited as correct: bound-key now covers email/deal/company/surface; route uses
only the authorized company's domains; out-of-scope companyId ignored; the
`onResult` status fix is a sound loop fix, not a mask; `previousCompanyId`
preservation is right; member/viewer paths use real `userCanInvite`; proposal
path may derive from `assessProposal` because that verdict already proves the
party relationship; response bodies/status/warning order indistinguishable in
the added cases; rollback probe useful and its single-session limit accurately
disclosed.

### Exact remaining work (nothing here needs re-derivation)

**1.1 — parent still violates A14.** Withdraw *immediately* on every bound-key
change, not just email, and only when the control still equals the applied
value. Preserve a phase the user typed themselves. Tests currently exercise
only email-change-then-503; add company, deal, surface, and user-chosen-phase
cases.

**1.2 — fail-closed hole.** When the `userCanInvite` read fails,
`perimeterForMember` / `perimeterForViewer` still return a perimeter with
`canInviteTeammate: false` instead of `unavailable`. A failed authority read
must make the preview unavailable, not silently absent the action.

**4.1 — schedule still leaks, and my retraction was too broad.** Real catch:
`pending?.deal_id ?? dealId` (`lookup/route.ts:320-342`) derives an authority
input FROM the hidden row. A hidden invite whose deal differs from the request
runs authority queries against a different deal, so predicates/cardinality/
timing still depend on the hidden fact even though the ordered table names
match. My round-2 retraction was correct only for the fixture I measured; it
did not establish the general claim. Fix the argument derivation, and make the
schedule assertion finer than ordered table names.

**4.2 — D8.16 is frozen and mandatory, so its absence is blocking.** Needs an
automated path: compose/send invite -> accept through the existing
verification/TOS/2FA sequence -> confirm the stored phase is what gets granted
-> assert welcome/perimeter behavior, with no persistence or audit leakage.
Also add the immediate-withdrawal and user-phase assertions from 1.1.

### Stop reason

Planner context exhausted. One substantive review round remains (3 of 3), and
the largest item (D8.16 E2E) is a real harness build. Starting it with no
context left risks spending the final round on a rushed attempt. Resuming needs
only this section; branch `duo-smart-onboarding` @ `154dbe8`, PR 149 draft, all
six gates green at that head, reviewer terminal
term_ae4664b5-f339-47f0-b41a-99008c65c825, run run_e5946bef9d53,
task_6ebc0daa4a5c / ctx_69cbbcb81bee settled on delivery.

## Resume instructions (fresh session, PR round 3 of 3)

User chose option A: resume in a fresh session and spend the final substantive
review round on all four remaining blockers.

Read, in order: `brief.md`, `spec-v2.md` (FROZEN), `plan-v5.md` (never
plan-reviewed — user Option C, so nothing in it is pre-approved),
`cr-prr-149-r2.md`, and the "Exact remaining work" section above. That section
is sufficient; do not re-derive the findings.

State to resume from:
- Branch `duo-smart-onboarding` @ `154dbe8`, PR 149 draft into `develop`,
  **not merged**. Six gates green at that head.
- Orchestration run `run_e5946bef9d53`. Reviewer terminal
  `term_ae4664b5-f339-47f0-b41a-99008c65c825`. Queue empty, no open dispatch.
- Next artifact is `prr-149-r3.md` (never edit `prr-149-r2.md` in place).
- Dispatch with `task-create` then `worker-start --terminal <above>`, then
  `check --wait`. This is the LAST substantive round; if it returns
  `changes_requested`, write `escalation-3.md` and stop.

Working notes worth carrying:
- Every security-critical assertion must be mutation-checked, and the fixtures
  around it must all be valid or it proves nothing (a suite here once passed
  21/21 against a build with the cross-tenant check deleted).
- `tests/db/*` need `npm run db:migrate` first. `legal-hold` fails for a
  pre-existing reason unrelated to this work.
- CI has FIVE blocking jobs, not the four named in README/CLAUDE.md: the fifth
  is `Dependency vulnerability audit`.
- A failing `psql` once echoed the dev `DATABASE_URL` into tool output. Treat
  that credential as exposed; never re-print it.

### Round 3 — diagnosis of 1.2 (recorded before implementing)

`realInvitationAuthority` already maps a THROWN error to null and callers map
null to `unavailable`. The hole is upstream: `userCanInvite` swallows its own
read failures and returns `false`. So a failed authority read arrives as "no
authority" and the perimeter renders available with the action silently absent
— exactly what the reviewer describes. A try/catch cannot see it because
nothing is thrown.

Options weighed: (a) duplicate `userCanInvite`'s queries in the perimeter path
to pre-check readability — fragile, and divergence is the thing this design
avoids; (b) make `userCanInvite` distinguish error from false — correct, but it
is a shared predicate used by live invite routes, so it widens blast radius;
(c) treat an unreadable/absent actor company as `unavailable` rather than
`false` — narrow, honest, but does not cover failures deeper inside the
predicate.

Chosen: (b), scoped. `userCanInvite` gains a documented error signal, and every
existing caller keeps its current behaviour by mapping that signal to the same
`false` it gets today. Only the perimeter path treats it as `unavailable`. That
keeps the live invite routes byte-identical while making the preview honest.

## Round 3 — in progress, NOT committed. Stop point.

Working tree has uncommitted round-3 work. `154dbe8` is still the pushed head.

DONE and green:
- **4.1** — authority arguments no longer derive from the hidden row.
  `userCanManageInvite` is called with `actor.company_id` and the REQUEST's
  deal, constant across worlds; disclosure additionally requires
  `pending.company_id === actor.company_id`, a comparison on already-fetched
  data. First attempt over-disclosed (asked "may you manage your own company's
  invites" then disclosed on it) — caught by the indistinguishability suite.
  Deliberate cost: under-disclosure for actors whose authority comes from
  elsewhere; they learn at send time from the existing scoped 409.
- **1.2** — `userCanInvite` split. `userCanInviteChecked` reports `'unreadable'`
  for a failed read; `userCanInvite` maps it to `false` so every enforcement
  caller is unchanged. Only the perimeter treats it as `unavailable`. Nested
  predicates still collapse their own read errors — documented, not fixed.
- **1.1 (code)** — withdrawal now keys on all bound inputs via a stored key,
  and a phase the inviter typed is preserved (`phaseTouched`).

RED / UNFINISHED — do not ship as is:
- `tests/onboarding-audit-neutral.test.ts` "the perimeter preview performs no
  write and no RPC" now returns **503 instead of 200**. Introduced by the 1.2
  fail-closed change. Fixtures all have `error: null`, so `'unreadable'` should
  not be reachable — the cause is NOT yet diagnosed. Either the fail-closed
  mapping is firing where it should not, or the fixture drives a path I have not
  traced. Diagnose before anything else: this is the difference between a real
  fail-closed guarantee and a preview that reports unavailable when it is fine.
- **1.1 tests not written.** Two attempted (company-change withdrawal,
  typed-phase preservation) were REMOVED rather than shipped red. The company
  one never re-fetched: the card stayed `ready` after
  `fireEvent.change` on the company select even though `companyId` is passed and
  keyed. Harness problem or a real prop-propagation bug — unresolved. The code
  fix is in; its coverage is not.
- **4.2 D8.16 E2E** — not started.

Gates at this stop point: eslint 0 errors, tsc clean, `npm test` **1 failed** /
880 passed. Nothing committed, nothing pushed, PR 149 unchanged.

### Round 3 — status after fixes

- **4.1 DONE.** Authority arguments now come from the request only
  (`actor.company_id`, request `dealId`), never from `pending`. Disclosure
  additionally requires `pending.company_id === actor.company_id` — a comparison
  on already-fetched data. First attempt over-disclosed (asked about the
  actor's own company, then disclosed on the answer); the suite caught it.
  Cost: under-disclosure for an actor whose authority comes from elsewhere.
- **1.2 DONE.** Root cause was upstream: `userCanInvite` swallowed read errors
  and returned `false`. Split into `userCanInviteChecked` (returns
  `'unreadable'`) with `userCanInvite` a wrapper mapping that to `false`, so
  every enforcement caller is unchanged. Only the preview treats it as
  unavailable. Nested predicates still collapse their own read failures —
  disclosed, not fixed.
- **1.1 CODE DONE, COVERAGE PARTIAL.** Withdrawal keys on all bound inputs;
  `phaseTouched` preserves an inviter-typed phase. Two new tests could not be
  made to work (company-change never re-fetched in the harness) and were
  REMOVED rather than shipped red or skipped. This gap is real and disclosed.
- **4.2 D8.16 DONE.** `tests/onboarding-e2e.test.ts` drives lookup -> preview ->
  send -> welcome through the real handlers, asserts the confirmed phase reaches
  the RPC, and asserts preview and welcome agree. The DB half stays in the SQL
  probe deliberately: asserting it against a mocked client proves the mock.

Two findings from writing it, both my own fixtures, not product defects: the
preview was correct while my welcome step read the MD's profile instead of the
invitee's; and adding `userCanInviteChecked` broke six suites that mock the
access module wholesale — the new fail-closed path firing against a stale mock,
which is evidence the guarantee is live.

Gates: eslint 0 errors, tsc clean, 883 passed / 6 skipped, audit 0 vulns.
PR review r3 dispatched: task_c2185f1265b1, head 7a386b0, artifact prr-149-r3.md, expected cr-prr-149-r3.md. THIRD and final substantive PR round: changes_requested means escalation-3.md and stop.

## RUN PAUSED — PR phase exhausted (escalation-3.md)

PR review r3 returned changes_requested with five blocking findings (1.1, 1.2,
4.1, 4.2, plus a new Gate 0 preview mismatch: null dealId with non-null
dealRole). Third and final substantive PR round, so escalation-3.md was written
and the run stopped for a user decision. Reviewer dispatch ctx_673010b3681f
released, delivery acknowledged.

I concur with all five; no competing position. The two that were my own
weak reasoning rather than oversight: I gated invitation disclosure on the
actor owning the company, which answers a different question than "may the
actor manage this invitation" — an authorization decision made against the
wrong resource, which I had described as safe under-disclosure. And I
presented a route-level composition as the D8.16 end-to-end path when frozen
D8.16 asks for the D7 demo walk.

Resume state: branch duo-smart-onboarding @ 7a386b0, PR 149 draft into develop,
NOT merged, gates green (eslint 0 errors, tsc clean, 883 passed, audit 0 vulns).
Frozen spec spec-v2.md. Run run_e5946bef9d53, reviewer terminal
term_ae4664b5-f339-47f0-b41a-99008c65c825 free. Next artifact would be
prr-149-r4.md; never edit prr-149-r3.md in place.

### Round 4 (option A) — started, stopped mid-4.1. UNCOMMITTED.

User said "continue" after escalation-3.md; read as option A and begun with the
four smaller findings first, so the work is shared with option B.

**4.1 attempted.** `userCanManageInvite` is now asked about the pending
invitation itself, with BOTH arguments falling back to the `NO_ROW` sentinel
when there is none — "a company that is not mine, on a deal I am not on" — which
is the same branch and the same work as a real foreign invitation. The
own-company gate was removed: it asked whether the actor owned the company,
which is not the question. This is in the WORKING TREE, NOT COMMITTED.

**Two A19 tests now fail** (`lookup-indistinguishable`: hidden invitation no
longer indistinguishable). Diagnosis is unfinished. What is known: that file
does NOT mock `@/lib/api/v1/access`, so the real `userCanManageInvite` runs
against `makeAdmin`, which returns queued rows regardless of the filters
applied. It appears to conclude authority over an `other-co` invitation while
the actor directs `bank-1`. So either the product genuinely over-discloses here,
or the fixture cannot represent the query and the test is lying — the same trap
that produced the 21/21 false green earlier in this run.

**Do not resolve this by adjusting the fixture until the product behaviour is
established.** Suggested first step: call `userCanManageInvite` directly against
a faithful (filtering) admin mock for (actor=bank-1 director, invite=other-co,
deal=null) and see what it actually returns. `tests/invite-authority-parity.
test.ts` has a filtering mock that can be copied.

Everything else from escalation-3.md is untouched: 1.2 nested predicates, 1.1
missing D8.6 tests, 4.2 real D7 walk, Gate 0 null-deal/non-null-role mismatch.

Tree state: `src/app/api/v1/invites/lookup/route.ts` modified and RED. Deliberately
not committed — pushing it would break CI on PR 149. Either finish the diagnosis
or `git checkout src/app/api/v1/invites/lookup/route.ts` to return to the green
state at 2a44059.

### 4.1 RESOLVED — the diagnosis, and it was my defect

Reading `userCanManageInvite` settled it without a probe. It branches on
`invite.dealId`: null takes the company-authority path, non-null takes the
deal-authority path. My sentinel `pending?.deal_id ?? NO_ROW` turned a
legitimately-null deal into a fake deal id, sending a company-scoped invitation
down the deal path. Constant work, wrong branch, wrong authorization. The
fixture was not lying; the code was.

Fix: evaluate BOTH shapes every time (`dealId: null` and `dealId:
pending?.deal_id ?? NO_ROW`) and let the real value select. Work is constant
whether or not an invitation exists, and the verdict is about the invitation
actually being disclosed. Inlining the branch here would have duplicated policy
that lives in one place today, so the helper is called twice instead.

Mutation: `const mayManage = true` -> 2 failed; reverted -> 8 passed.
Gates: eslint 0 errors, tsc clean, 883 passed / 6 skipped.

Worth carrying: a sentinel is only safe when it preserves the SHAPE the callee
branches on. `NO_ROW` was a valid company id but not a valid "no deal".

## 2026-08-09T13:33Z — Round 4: Gate 0 preview mismatch closed

The wizard was the liar, not the route. `assessProposal` returns `invalid` for a
deal role with no deal, and the invites table CHECKs the same pairing, so the
preview route's 400 is the rule rather than an over-strict guard. Gate 0 mounted
`PerimeterPreview` with `dealId={null}` and the queued `inviteRole`, so every
pre-deal preview 400'd into "could not be computed" instead of the B12/B13
zero-document prospective perimeter. Fix: `dealRole={null}`. The role is not
lost, it is applied where it means something, at send, once the deal exists.

Test: one case in the existing `platform_onboarding` describe of
`gate0-wizard-api.test.tsx`. The stub applies the route's real pairing rule
rather than trusting the body literally, so the test fails the way production
fails (400 -> unavailable) and only passes for a proposal the route would
accept. The body is also asserted directly so a regression names its cause.

Mutation: `dealRole={inviteRole}` -> 1 failed; reverted -> 18 passed.
Gates: eslint 0 errors, tsc clean, 884 passed / 6 skipped.

Not fixed, surfaced for review: `SmartLookupCard` gates its request on
`LOOKS_LIKE_EMAIL` citing A12 ("a malformed or incomplete address issues no
request at all"); `PerimeterPreview` has no such gate and fires per keystroke,
each 400ing until the address is complete. Whether A12 binds both onboarding
request surfaces is the reviewer's call, and changing a shared three-surface
component mid-round is the drift the brief forbids.

## 2026-08-09T13:46Z — Round 4: finding 1.1, harness diagnosed, D8.6 tests restored

The harness problem was a cascade, not a flake. A recommendation that pre-fills
the company changes one of `SmartLookupCard`'s own bound inputs, so the card
immediately re-keys and looks up AGAIN. A test that touches a bound input before
that second cycle lands races it: the in-flight delivery arrives after the
change and re-applies exactly what the change withdrew. Probing showed the
select reverting to `seller-1` with the card still `ready` and no withdrawal
call at all, which reads as broken withdrawal and is in fact correct behaviour
observed mid-cascade.

That is why the two tests were removed rather than fixed. The fix is discipline,
not product change: `lookupSettled()` waits for two consecutive polls at `ready`
with no new lookup between them, and both tests act only after it. No source
file changed for this finding.

Restored, per D8.6:
- Company change withdraws the applied phase. The next lookup is held PENDING
  rather than failed on purpose: a failure would satisfy `status ===
  'unavailable'` as well as the key comparison, and the test would pass with the
  key comparison deleted, proving nothing about the input that changed.
- A phase the inviter typed survives the next recommendation. The same delivery
  that legitimately moves the company must leave the phase alone, which exercises
  `phaseTouched` in both the withdrawal and the apply branch.

Mutations: drop `|| currentKey !== applied.key` -> company-change test failed;
drop the `!phaseTouched` guard on apply -> typed-phase test failed; reverted ->
9 passed. Five consecutive runs green, no flake.
Gates: eslint 0 errors, tsc clean, 886 passed / 6 skipped.

Worth carrying: when a surface pre-fills one of its own bound inputs, it
re-queries itself. Any test that acts on those inputs must first wait for the
self-inflicted second cycle, or it will assert against a transient and blame the
implementation.

## 2026-08-09T15:16Z — Round 4: finding 1.2, unreadable now propagates from depth

`userCanInviteChecked` reported its own failed reads honestly and then handed
the real decision to nested predicates that discarded `error` and answered
false. B10 asks for unavailable when the perimeter cannot be reliably computed;
what arrived instead was a confident "cannot invite teammates".

Shape: rather than a second set of parallel predicates, the Checked variant IS
the implementation and the boolean is a one-line view of it
(`(await ...Checked(...)) === true`). One body, two readings — the same reason
4.1 called the shared helper twice instead of inlining a branch. Added
`canManageCompanyMembersChecked`, `userIsDealMdChecked`,
`canManageDealMembersChecked`; `userCanInviteChecked` now calls the Checked
forms. Every existing caller keeps deny-on-error byte for byte.

One subtlety worth naming: the two actor reads moved from `single` to
`maybeSingle`. Under `single` a MISSING row is itself an error, so binding the
error would have reported an absent actor as unreadable instead of false —
turning a real answer into an outage. For the boolean view the two are
identical (no row -> null data -> false).

Tests (`access-invites.test.ts`, +5): the deal-authority and company-authority
read failures each asserted TWICE — 'unreadable' from `userCanInviteChecked`,
and still `false` from `userCanInvite` on the same stub. The second half is the
guarantee that enforcement did not move, which is the part that would be a
security regression. Plus: a missing actor stays false, so the distinction
stays a distinction.

Mutations: drop `if (membershipError)` -> deal-authority test failed; drop
`if (actorError)` in the company path -> company-authority test failed;
reverted -> 21 passed.
Gates: eslint 0 errors, tsc clean, 891 passed / 6 skipped.

Disclosed, not covered: the composed path (nested unreadable -> perimeter
`unavailable`) is still asserted only by inspection. The remaining link is two
literal lines of code the reviewer already credited (`=== 'unreadable' ? null`
in `realInvitationAuthority`, and `if (canInvite === null)` in
`perimeterForMember`). Reaching it from a test means driving five sequenced
reads through `getDocumentViewer`, and a stub that positional would assert its
own fixture more than the code. Raising it rather than quietly claiming B10 is
fully automated; the reviewer may still want it.

## 2026-08-09T15:42Z — Round 4: finding 4.2, one walk instead of two probes

The old test stopped at send and then manufactured an already-active viewer.
Everything D7 asks for after "send" — accept, the code challenge, the terms, the
seat, the brief — was either absent or proven separately in SQL, so the two
halves could agree while sharing nothing.

The walk now runs from the invite surface to the brief on ONE invitation. Added
after send: the code challenge refused with a wrong code and passed with the
right one; acceptance refused before verification (409) and refused again
without the terms (400, and the RPC call count does not move); acceptance with
the terms, asserting the ATTEST row is written before the grant; then the seat's
perimeter and the rendered `WelcomeBrief`.

What makes it a walk rather than a sequence: a three-field invitation store
(`id`, `phase`, `verified`) backs `create_invite`, `verify_invite_challenge` and
`accept_invite` on both the admin and the session client, and the invitee's
`deal_memberships` fixture reads `invite.row.phase`. So the phase the MD
confirms is the phase the RPC carries, is the phase the seat holds, is the count
the brief prints. The store re-implements no authority; the grant and its audit
remain SQL's to prove (`supabase/tests/invite_phase_accept.sql`).

Mutations: `p_phase: 0` in send -> failed (the whole chain, at the brief); drop
the `invite_not_verified` mapping -> failed; drop the TOS gate -> failed;
`ATTEST` -> `VIEW` -> failed; reverted -> 2 passed.

### The front door, and a defect it exposed

D7 starts at a typed address, so the walk now starts at the real `InviteModal`
with `fetch` answered by the REAL handlers. Both existing invite-surface tests
stub literal bodies, so nothing until now proved the UI reads the shape the
handler actually returns.

It did not. **The Team modal never identified a counterparty company.** The
company select opens on the advisory bank, the modal passed that untouched
default to lookup, and lookup reads a selected company as "does THIS address
belong to THAT company" — so `alex@target.dev` came back `companyMatch: null`,
`recommendation: null`, warning `unverified_domain`, and nothing pre-filled. The
runbook has claimed since 2026-08-08 that the card "names the company behind the
domain when a verified domain the actor can see matches it". On the Team surface
that was not true.

Fix, one line: `companyId={companyTouched ? companyId || null : null}`. The
component already keeps `companyTouched` for exactly this distinction, and sets
it only from the inviter's own `onChange` — a recommendation pre-filling the
select deliberately does not. Untouched is not a choice, so lookup gets the
question the route documents for it ("before any choice — which candidate
company it belongs to, if any"). A deliberate mismatch still warns, because
touching the select still sends it. Side effect worth noting: the bound input no
longer changes when a recommendation pre-fills the company, so the self-chasing
second lookup from finding 1.1 does not occur on this surface.

Mutation: revert the line -> front-door step failed; restored -> 2 passed.

### Gate 0 is not D7's surface

Round three asked why the walk "never drives Gate 0". Gate 0 answers that
itself, in its own copy: "Bank colleagues only. Buyer and seller invitations
happen from Team once the deal exists." (`Gate0Wizard.tsx`). D7's address is a
seller's, so Team is where that address is typed. Gate 0's own invite path is
covered by `gate0-wizard-api.test.tsx`, including round four's null-deal preview
fix. Stating the disagreement rather than adding a Gate 0 drive that would
assert the wrong surface.

Gates: eslint 0 errors (8 pre-existing warnings), tsc clean, 891 passed /
6 skipped, `npm run build` passed.

Still not covered, disclosed: the database half stays SQL-side by design; the
composed `unreadable` path from finding 1.2 remains inspection-only; and the A12
question raised in round four is now visible in this walk's traffic — the modal
fires a perimeter preview for an empty address before anything is typed, which
400s harmlessly. Unchanged, because it is a shared three-surface component and
the reviewer's call.

## 2026-08-09T21:33Z — Round 5: the three round-4 blockers

### 1.3 — the control now holds "unset" honestly

Round 4 fixed the wrong half. The select still opened on the advisory bank,
still rendered it as chosen, and still sent it to preflight; I only hid it from
lookup. So the value on screen and the value on the wire disagreed, which is
A13 broken in a new place rather than A5(b) repaired.

The real defect was that "no company chosen yet" had no representation. It does
now: a placeholder option, `initialCompanyId` empty for an internal inviter,
and `companyId={companyId || null}` passed straight through — the form sends
exactly what it shows. `companyTouched` goes back to what it was for, guarding
the pre-fill. Unset also means no seat exists yet, so the phase control appears
with the company; and `PerimeterPreview` already keys on a truthy company, so
the empty-address previews the reviewer flagged as advisory stop firing as a
side effect rather than as a special case.

Two tests assert the request body against the rendered value: the first lookup
carries no company (it precedes any pre-fill), the settled one carries what the
select shows, and a manual change re-asks about the picked company rather than
the matched one. Mutation: restoring the `options[0]` default failed the first;
reverted, 11 passed.

### 4.1 — tenant coherence, and an honest comment

Two things, one of them not mine. `userCanManageInvite` returned true for any
firm admin before reading the target's tenant, while lookup finds pending
invitations globally by address — so an admin could learn that another tenant's
invitation exists (A6, A19). `canManageCompanyMembersChecked` and
`userIsDealMdChecked` already carry exactly this check; this predicate was the
one member of the family that never got it. It reads the invited company's
tenant and denies on mismatch or on an unresolvable company. Reading it before
the branch also removes the admin's short-circuit, so the admin path no longer
does visibly less work than everyone else's.

Fixtures needed a `companies` row and actor `tenant_id`s; `makeAdmin` now
supplies both by default so a test expecting false still fails on the rule it is
about. Two tests added: a same-tenant admin is allowed, a cross-tenant one is
not, and an invitation whose company cannot be resolved is not disclosed.
Mutation: dropping the tenant comparison failed both; reverted, 23 passed.

The reviewer also caught the comment above the dual-shape evaluation still
claiming both arguments come from the request. They do not, and have not since
round 4. The comment now says what the construction actually buys — an
identical response and a constant invocation count — and what it does not:
a real deal whose MD is the actor short-circuits earlier than a sentinel, so a
timing difference remains. Closing that means duplicating policy or imposing a
fixed schedule on every caller. Recorded rather than papered over. A19 as
frozen is a property of the response, which holds.

### 3.1 — the walk carries the invitation, and ends with the second factor

The store was too thin to prove what I claimed. It kept `{id, phase, verified}`,
so `create_invite` discarded the address, company, deal and both roles, and
`accept_invite` answered from constants — the ending could not disagree with the
beginning because nothing connected them.

It now records what was sent and answers acceptance from that record. The
invitee's company, seat and phase are all read off the stored invitation, so
composing the wrong invitation produces the wrong ending. Send is asserted
against the composed form, not against a literal.

The missing leg was 2FA. Acceptance runs at AAL1 by design — the invitee has
proven an emailed code, not a device — so the step that opens the full seat is
the challenge, and it is audited. The walk now calls the real
`/api/v1/auth/mfa/complete` between acceptance and the perimeter and asserts the
MFA_CHALLENGED row. D4 said that flow is unchanged; it is. It is walked, not
modified.

Mutations, all caught: sending the wrong company, sending the wrong seat, and
recording the second factor as the wrong event. Reverted, 2 passed.

### Gates

eslint 0 errors (8 pre-existing warnings), tsc clean, 895 passed / 6 skipped,
`npm run build` passing.

### Still open

The composed unreadable-to-unavailable perimeter test and the migrated CI
database for the opt-in SQL probes remain advisory and unaddressed. The residual
timing difference in 4.1 is disclosed above.

## 2026-08-09T22:01Z — Round 6: the two round-5 blockers

### 4.1 — the predicate decided before it finished reading

Round 5 equalized the response and the call count. It did not equalize the
work, and the reviewer was right that this is the thing A19 exists to prevent:
answering "no such row" faster than "a row you cannot see" is an oracle, and my
own tenant fix had sharpened it, because the company read it added returns
early exactly when the sentinel is used.

`userCanManageInvite` now gathers before it decides. Four reads issue
unconditionally — actor, the invited company, the deal, the actor's seat on
that deal — and every rule is then evaluated in memory. A read with nothing
real to look up looks up an id that cannot exist rather than being skipped.
The shared predicates (`inTenant`, `directorOf`, `holdsMdSeat`,
`holdsDelegatedSeat`) exist so the constant-shape path and the branching
helpers state each rule once instead of twice.

That made the lookup route's dual-shape construction obsolete: with constant
work inside the predicate, one call with the real shape is enough, so the
route lost ~25 lines and the comment that used to concede the residual.

The A19 harness could not have caught this: its stub recorded table names and
ignored filter arguments, so a sentinel id read the same canned row as a real
one. It now records `table(filter columns)` per read, and the schedule test
compares three worlds — no invitation, one attached to nothing, one attached
to a deal — asserting identical schedules and naming the four reads that must
appear. Mutation: make the deal read conditional again, the historical shape;
the schedule test fails. Reverted, 8 passed. All 67 existing authority verdicts
unchanged by the refactor.

### 3.1 — the seat now comes from acceptance, and the factor is real

Two separate criticisms, both fair.

The membership was a fixture written before acceptance, so it would have agreed
with the ending no matter what acceptance did. Tables may now be given as
thunks; `accept_invite` creates the membership from the stored invitation, and
the walk reads the perimeter *before* acceptance and asserts there is no seat.
The transition is what produces it.

The second factor was a direct POST to the audit endpoint, which only writes a
row. The walk now renders the real two-factor page: it challenges the factor,
verifies the code, confirms AAL2 and only then records — the assertions name
the challenge id and code that reached `mfa.verify`. Then the real
`requireApiUser` refuses the invitee at aal1 and admits them at aal2, which is
the guard every protected route runs. Mutations: make the session aal2 where
the test expects refusal, and stop the verification from raising assurance;
both fail. Reverted.

### Gates

eslint 0 errors (8 pre-existing warnings), tsc clean, 895 passed / 6 skipped,
build passing.

Still open, unchanged and disclosed: the composed unreadable-to-unavailable
perimeter test, and a migrated disposable database so the SQL probes run in CI.
