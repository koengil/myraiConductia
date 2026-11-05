# Lead Registration + Gate-0 Creation Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a lead (parent-company) registration surface and refactor the Gate-0 project-creation wizard so a project is created by *selecting an existing lead* (not typing a name), gated by an in-flow conflict checklist, entering a rail that hides the pre-project steps.

**Architecture:** "Lead == parent company" maps onto the existing `companies` table (no new entity). Lead registration renders the CRM fields from the requirements doc but persists only the company **name** via a minimal `POST /api/v1/companies`; the relationship/stakeholder fields are visualization-only for now (local state). The wizard's `codename` step swaps its free-text "Target company" input for a typeahead over the *already-built* `GET /api/v1/companies?query=` search, sending `targetCompanyId` (the POST route already accepts it). A new conflict-checklist wizard step gates advancement. The entering-step picker switches from `DEAL_RAIL` to the existing `MVP_DEAL_RAIL` so the pre-project steps are pre-completed.

**Tech Stack:** Next.js 16 (App Router) · TypeScript · Tailwind 4 · Vitest + React Testing Library · Supabase (Postgres, migrations + RPC).

## Global Constraints (copied from CLAUDE.md — apply to every task)

- **The seam:** UI talks only to typed APIs. The `/api/v1/*` platform contract is BESIDE the `ConductiaAPI` content seam — never inside it. Company/deal creation lives in `/api/v1/*`, not in `ConductiaAPI`.
- **Compliance mounted once:** never add a second `[data-compliance-status]`; dispatch `SET_COMPLIANCE` if needed.
- **Project is URL state**, resolved via `resolveProjectId`. Leads are project-less (tier-2), live under `(authed)`.
- **Contrast contract:** light `--surface*` → dark `--ink*`; navy `--canvas-bg` → `--ink-on-dark*`. Type-ramp classes stay in `@layer components`.
- **Brand voice:** senior/precise/decisive, statements not questions, **no em-dashes in visible copy**.
- **Surgical changes only:** smallest correct change, follow existing patterns, no scope creep. Co-Authored-By trailer on commits (per `conventions.md`).

## Execution calibration (per CLAUDE.md "Verify before asserting")

This plan is executed by Marcelo + Claude Code **together**, not handed to a blind agent. Each task is **test-first**: we write the failing test, then Claude reads the real file and writes the minimal implementation. Where a step says "implement", it names the exact file:line and the precise change/shape — the concrete code body is written at execution after reading the file, rather than fabricated here from the map. This is deliberate (avoid asserting unverified code), not a placeholder.

## Pre-flight

- [ ] **Branch from `develop`** (current tree is on `fix/gate0-stuck-creating-modal` = PR #112). Run:
  `git checkout develop && git pull && git checkout -b feat/lead-registration-gate0-refactor`
- [ ] Confirm baseline green: `npm test` (expect the full suite passing, ~357).

---

## Task 1: `POST /api/v1/companies` — persist a lead's name

**Why first:** the lead registration UI (Task 2) and the selector (Task 3) both need companies to exist and to be creatable. This is the one backend piece.

**Files:**
- Create: `src/app/api/v1/companies/route.ts` already exists (GET). ADD a `POST` handler in the same file.
- Reference: `src/app/api/v1/deals/route.ts` (POST pattern, `requireApiUser`, tenant scoping, `jsonError`), `src/lib/api/v1/http.ts`, `src/lib/api/v1/access.ts`, `src/lib/constants/companies.ts` (`COMPANY_TYPE`).
- Migration reference (uniqueness already exists): `supabase/migrations/20260716170000_companies_name_unique.sql`.
- Test: `tests/api-v1-companies-post.test.ts` (new; mirror `tests/api-v1-deals-post.test.ts`).

**Interfaces:**
- Produces: `POST /api/v1/companies` — body `{ name: string; type?: CompanyType }` (default `type = COMPANY_TYPE.CLIENT` for a lead). Returns `201 { company: { id, name, type } }`; `409` on duplicate name (unique constraint); `400` on empty name; `401` unauth.

- [ ] **Step 1 — failing test:** in `tests/api-v1-companies-post.test.ts`, assert POST with `{ name: "Acme" }` returns 201 with `company.name === "Acme"` and a uuid `id`; a second identical POST returns 409; empty name → 400. Mock auth like the deals-post test.
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/api-v1-companies-post.test.ts` → FAIL (no POST export).
- [ ] **Step 3 — implement:** add `export async function POST(req)` to `src/app/api/v1/companies/route.ts`: `requireApiUser`; parse/validate name; tenant-scoped insert into `companies` (`name`, `type`, `tenant_id`); map unique-violation → 409; return 201. Follow the secret-key + tenant pattern used by the deals POST.
- [ ] **Step 4 — run, expect pass:** `npx vitest run tests/api-v1-companies-post.test.ts` → PASS.
- [ ] **Step 5 — commit:** `feat(gate0): POST /api/v1/companies to register a lead by name`

---

## Task 2: Lead registration UI (CRM fields visualized, name persisted)

**Files:**
- Create route: `src/app/(authed)/leads/page.tsx` (project-less, tier-2, inside the shell).
- Create component: `src/components/leads/LeadRegistration.tsx` (the form) and `src/components/leads/LeadList.tsx` (visualization of existing leads via `GET /api/v1/companies?query=&type=client`).
- Reference field list: `docs/03-engineering/` requirements + the relationship/stakeholder field draft (from the Granola doc). Render relationship-map + stakeholder-map fields as inputs; keep them in local state only (no persistence this week).
- Test: `tests/lead-registration.test.tsx` (new; follow `tests/gate0-wizard.test.tsx` RTL pattern — `render/screen/fireEvent/act`, wrap in `SessionProvider`).

**Interfaces:**
- Consumes: `POST /api/v1/companies` (Task 1), `GET /api/v1/companies?query=&type=` (exists).
- Produces: a `/leads` surface where submitting the name creates a company; the list reflects it. Registered leads become selectable in Task 3.

- [ ] **Step 1 — failing test:** render `LeadRegistration`; assert it shows a Name field plus the CRM field groups (relationship map, stakeholder map) as visualization; submitting a name calls the POST (mock fetch) and clears/refreshes the list.
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/lead-registration.test.tsx`.
- [ ] **Step 3 — implement `LeadRegistration.tsx`:** name input (persisted), plus read-for-now CRM field groups; on submit `POST /api/v1/companies`. Copy per brand voice, no em-dashes. Contrast contract on surfaces.
- [ ] **Step 4 — implement `LeadList.tsx` + `/leads/page.tsx`:** list companies (`type=client`) from the search API; compose form + list on the page.
- [ ] **Step 5 — run, expect pass:** `npx vitest run tests/lead-registration.test.tsx`.
- [ ] **Step 6 — manual check:** `npm run dev`, visit `/leads`, register "Atlassian", confirm it appears. (Rail run skill / browser.)
- [ ] **Step 7 — commit:** `feat(gate0): lead registration surface (CRM fields visualized, name persisted)`

---

## Task 3: Lead selector replaces the target-company text input

**Files:**
- Modify: `src/components/wizard/Gate0Wizard.tsx` — the `codename` sub-step target input (`~:462-473`); state `target`/`company`/`resolveCompany` (`~:163-174`) becomes a selected-company object carrying `id`; the `complete()` API branch (`~:351-357`) must send `targetCompanyId` (route already accepts it).
- Reuse if clean: `src/components/companies/CompanySearch.tsx` as the typeahead shell (note it currently reads the fixture directory `src/lib/companies/directory.ts`; point it at `GET /api/v1/companies?query=` instead, or add a variant prop).
- Fixture path: `src/lib/rail/deals.ts` — `createDeal` / `SearchableCompany` (`:71`, `:239`) to carry a company id on the flag-off path.
- Tests: `tests/gate0-wizard.test.tsx`, `tests/gate0-wizard-api.test.tsx` (update `fillCodenameStep()` to select from the typeahead instead of typing a raw name), `tests/api-v1-deals-post.test.ts` (assert `targetCompanyId` accepted — likely already covered).

**Interfaces:**
- Consumes: `GET /api/v1/companies?query=`.
- Produces: wizard sends `targetCompanyId` (flag-on) and carries a company id on the fixture deal (flag-off); the codename-masks-company check runs against the selected company's real name.

- [ ] **Step 1 — failing test:** in `tests/gate0-wizard.test.tsx`, drive the codename step by *searching + selecting* a company (mock the search response), assert the selection is shown and advancing works; in the API test assert the POST body includes `targetCompanyId`.
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/gate0-wizard.test.tsx tests/gate0-wizard-api.test.tsx`.
- [ ] **Step 3 — implement:** replace the `<input>` with the typeahead; hold a selected `{ id, name }`; feed `company` into codename-mask validation; add `targetCompanyId` to the POST body; carry the id on the fixture `createDeal` path.
- [ ] **Step 4 — run, expect pass:** same command → PASS (update `fillCodenameStep` helper).
- [ ] **Step 5 — manual check:** create a deal by selecting the "Atlassian" lead from Task 2; confirm it lands on the rail with the receipt.
- [ ] **Step 6 — commit:** `feat(gate0): select an existing lead instead of typing target company`

---

## Task 4: Conflict-checklist step in the wizard (gate advance)

**Files:**
- Modify: `src/components/wizard/Gate0Wizard.tsx` — add a `WizardStepKey` (`~:69`) e.g. `'conflicts'` and a `WIZARD_STEPS` entry (`~:85-110`) placed after `codename`; add a render branch (a 6-item checklist); block "next" until all six are checked.
- Audit: `src/lib/audit/store.ts` (`logAudit`) — log a "conflicts cleared" event on create; server side, the create RPC already writes `audit_log`. This directly satisfies the doc's MVP principle (verbatim): *"the platform's job is to ensure nothing is skipped and to record that it was run."*
- Labels (VERBATIM from the live requirements doc, Seq 6 "Conflicts Checklist", re-read 2026-07-21) — put these in one `CONFLICT_CHECKS` constant so a rename is one edit:
  1. `restricted list`
  2. `prior engagements (company or related entity)`
  3. `competing/related entities`
  4. `board roles and interlocks` — doc had a dangling "(" (unfinished edit); we drop the stray paren and use this clean label
  5. `personal holdings by deal-team members`
  6. `cross-deal conflict with another banker's engagement`
  - MVP = flat checklist, human decision, no per-check evidence table (the doc's Post-MVP / cross-deal-walls detail is still an empty stub). Approval routes to senior banker / compliance / legal; the agent assembles but does not judge. Framing: Seq 6 = "are we allowed to continue?" (distinct from Seq 11 Deal Qualification = "should we pursue?").
- Test: `tests/gate0-wizard.test.tsx` — advancement blocked until all six checked; audit event on complete.

**Interfaces:**
- Consumes: nothing new.
- Produces: creation is gated on a completed conflict checklist; an audit event records the clearance. (MVP = checklist only; no per-check table — matches "just a checklist" scope.)

- [ ] **Step 1 — failing test:** assert the wizard shows six checkboxes after the lead-selection step; "Continue" is disabled until all six are checked; on create, `logAudit` is called with a conflicts-cleared action.
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/gate0-wizard.test.tsx`.
- [ ] **Step 3 — implement:** new `conflicts` sub-step with six checkboxes from a `CONFLICT_CHECKS` constant; disable advance until all true; call `logAudit(...)` in `complete()`.
- [ ] **Step 4 — run, expect pass:** same command → PASS.
- [ ] **Step 5 — commit:** `feat(gate0): conflict checklist gates project creation (G6)`

---

## Task 5: Trim the entering-step picker to the MVP rail

**Files:**
- Modify: `src/components/wizard/Gate0Wizard.tsx` — the `entry` sub-step phase list + `<select>` (`~:759-805`) and default `entrySeq` (`~:289`): source from `MVP_DEAL_RAIL` instead of `DEAL_RAIL` so the pre-project (New-Biz-Dev) steps are not offered; default to the first persistent step.
- Confirm seeding: `src/app/api/v1/deals/route.ts` (`~:178`, `orderedSteps(DEAL_RAIL)` → statuses from `entryStepSeq`) and the RPC in `supabase/migrations/20260716180000_deal_steps.sql` mark earlier steps `skipped_entry`. Fixture default: `src/lib/rail/deals.ts` `createDeal` `entryStepSeq` (`~:248`).
- Reference (existing mechanism, do not reinvent): `PERSISTENT_STEP_IDS` + `MVP_DEAL_RAIL` in `src/lib/rail/dealRail.ts` (`:172-178`, `:988`).
- Test: `tests/gate0-wizard.test.tsx` — the entry picker lists only MVP-rail steps; the pre-project steps are absent.

**Interfaces:**
- Consumes: `MVP_DEAL_RAIL`.
- Produces: the entering-step picker offers only execution-rail steps; the seeded `deal_steps` mark trimmed steps complete/skipped.

- [ ] **Step 1 — failing test:** assert the entry `<select>` does not contain the trimmed phase-1 steps and does contain the first persistent step; default selection is the first MVP step.
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/gate0-wizard.test.tsx`.
- [ ] **Step 3 — implement:** switch the entry sub-step source to `MVP_DEAL_RAIL`; set the default `entrySeq`; verify the create paths seed statuses consistently.
- [ ] **Step 4 — run, expect pass:** same command → PASS.
- [ ] **Step 5 — manual check:** create a deal, open the rail, confirm the trimmed steps show complete and the entry step is `current`.
- [ ] **Step 6 — commit:** `feat(gate0): entering-step picker uses the MVP rail (pre-project steps pre-completed)`

---

## Wrap-up

- [ ] Full suite green: `npm test`.
- [ ] Typecheck: `npm run typecheck` (or `tsc --noEmit`).
- [ ] Open PR into `develop`; reference the demo punch-list items closed (target-company rename via selector, checklist step).

## Open decisions to confirm with the team (do not block Task 1-3)

1. **Conflict-check labels** — Task 4 uses the doc's verbatim Seq-6 labels (re-read live 2026-07-21) behind one `CONFLICT_CHECKS` constant. Item 4 uses the clean label "board roles and interlocks" (the doc's stray dangling paren dropped). The concise Storm/Finalis naming pass may still adjust wording; rename = one edit.
2. **Lead company `type`** — using `COMPANY_TYPE.CLIENT` for a lead. Confirm vs `TARGET` given the sell-side "prospective client" meaning.
3. **CRM field persistence** — this week is visualization-only per the call; the relationship/stakeholder schema (or HubSpot sync) is a later decision. Keep fields in local state; do not add columns now.
4. **Ownership** — Marcelo owns Tasks 1-5; Roberto owns data room + Box in parallel. The audit-log *viewer* was discussed as Roberto's — Task 4 only *writes* an audit event, it does not build the viewer.

## Self-review

- Spec coverage: lead registration (T1-2), lead selector replacing target input (T3), conflict checklist step (T4), entering-step trim (T5) — all mapped. Agent transport intentionally out of scope (deferred to next week per Marcelo).
- Reused existing infra rather than rebuilding: company search API (T3), `MVP_DEAL_RAIL`/`PERSISTENT_STEP_IDS` (T5), `targetCompanyId` on the POST route (T3), client audit store (T4).
- Dependency order: T1 → T2/T3 (need creatable/selectable companies) → T4 → T5. T4 and T5 are independent of each other.
