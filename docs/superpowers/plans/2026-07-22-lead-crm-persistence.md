# Lead CRM Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the `/leads` relationship-map and stakeholder-map fields as repeatable, tenant-scoped lists tied to a lead (company), replacing the current visualization-only behavior.

**Architecture:** Two child tables (`lead_relationships`, `lead_stakeholders`) referencing `companies.id`, exposed as nested REST resources under `/api/v1/companies/{id}/…` (the platform contract, beside `ConductiaAPI`), gated by the same tenant/company-access predicate the companies surface uses. The `/leads` UI turns each map into a repeatable row editor that persists via those endpoints.

**Tech Stack:** Next.js 16 App Router · TypeScript · Supabase (Postgres, migration + REST handlers using the secret/service client) · Vitest + RTL.

**Spec:** `docs/superpowers/specs/2026-07-22-lead-crm-persistence-design.md`.

## Global Constraints (from CLAUDE.md + spec)

- **The seam:** these endpoints are the `/api/v1/*` platform contract, NOT inside `ConductiaAPI`.
- **Access:** tenant-scoped; reuse the existing company-access predicate (`userCanSearchCompanies` / the company-access check in `src/lib/api/v1/access.ts`). Walled/external users → 403. Every read/write scoped by `tenant_id` + `company_id`.
- **Enums are lockstep:** SQL CHECK is the source of truth; TS constants mirror it; the UI selects consume the TS constants; the `constants-schema-sync` guard enforces the match.
- **Brand voice:** statements not questions, NO em-dashes in visible copy.
- **Surgical, YAGNI:** only the two maps; no confidentiality gating, no PATCH, no audit extension, no wizard/deal changes.
- **Reference implementations to mirror:** `src/app/api/v1/deals/[dealId]/audit/route.ts` + `tests/api-v1-deal-audit.test.ts` (a nested resource with tenant + per-parent access gate — the closest pattern), `src/app/api/v1/companies/route.ts` (POST + wall gate), `src/lib/api/v1/access.ts`, `src/lib/api/v1/http.ts`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Execution calibration (per CLAUDE.md "Verify before asserting")

Executed by Marcelo + Claude Code via SDD. Each task is test-first: write the failing test, then read the real file and write the minimal implementation. "Implement" steps name the exact file and the precise change/shape; the concrete body is written at execution after reading the file. **DB migrations are applied to Conductia-dev by the CONTROLLER with explicit user approval (RED→GREEN), never by implementer subagents** (as in the legal-hold slice).

## Pre-flight

- [ ] On branch `feat/lead-crm-persistence` (stacked on #114; already checked out). Confirm baseline green: `npm test`.

---

## Task 1: Migration + constants + sync guard

**Files:**
- Create: `supabase/migrations/<timestamp>_lead_crm_maps.sql` — the two tables + indexes + `alter table … enable row level security` (policies deferred to app layer, per ADR-0008 / `permissions-enforcement-gaps.md`). Copy column/CHECK definitions verbatim from the spec's Data Model.
- Create: `src/lib/constants/leadMaps.ts` — export the four enums as `as const` arrays + derived union types: `RELATIONSHIP_TYPES`, `STRENGTH_LEVELS`, `RELATIONSHIP_SOURCES`, `DECISION_ROLES`, `MOTIVATIONS`, `STANCES` (values verbatim from the SQL CHECK / the current arrays in `src/components/leads/LeadRegistration.tsx:13-45`).
- Modify: `src/lib/constants/tables.ts` — add `LEAD_RELATIONSHIPS: 'lead_relationships'`, `LEAD_STAKEHOLDERS: 'lead_stakeholders'` and the `TABLE` list.
- Modify: `tests/constants-schema-sync.test.ts` — extend the guard so the four enums match the migration's CHECK lists.

**Interfaces (produced):** the `leadMaps.ts` enum arrays/types + the two `TABLE` keys, consumed by Tasks 2-5.

- [ ] **Step 1 — failing test:** extend `tests/constants-schema-sync.test.ts` to assert each of the four `leadMaps.ts` enums equals the values parsed from the new migration's CHECK constraints. (Mirror how the existing test reads the migration + compares.)
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/constants-schema-sync.test.ts` → FAIL (module/enum missing).
- [ ] **Step 3 — implement:** write the migration SQL (spec Data Model), `leadMaps.ts`, and the `TABLE` additions.
- [ ] **Step 4 — run, expect pass:** same command → PASS. Full suite `npm test` green.
- [ ] **Step 5 — commit:** `feat(leads): lead_relationships + lead_stakeholders schema + enum constants`
- [ ] **Step 6 — CONTROLLER (user-gated):** apply the migration to Conductia-dev (RED: tables absent → apply → GREEN: tables + indexes present, RLS enabled). Not done by the implementer.

---

## Task 2: Relationships API (`/api/v1/companies/{id}/relationships`)

**Files:**
- Create: `src/app/api/v1/companies/[companyId]/relationships/route.ts` — `GET` (list) + `POST` (create).
- Create: `src/app/api/v1/companies/[companyId]/relationships/[entryId]/route.ts` — `DELETE`.
- Reference: `src/app/api/v1/deals/[dealId]/audit/route.ts` (nested GET + parent access gate), `src/app/api/v1/companies/route.ts` (POST + validation + wall gate), `access.ts`, `http.ts`, `leadMaps.ts` (Task 1).
- Modify: `openapi/phase1.json` + `docs/03-engineering/api-v1.md` (add the 3 routes).
- Test: `tests/api-v1-lead-relationships.test.ts` (mirror `tests/api-v1-deal-audit.test.ts` + `api-v1-companies-post.test.ts` mocking).

**Interfaces (produced):**
- `GET …/relationships` → `{ relationships: LeadRelationship[] }`.
- `POST …/relationships` body `{ person_name, title?, person_company?, contact_info?, relationship_type, strength, source, confidence, last_verified?, owner?, basis? }` → `201 { relationship }`. `400` missing `person_name`/invalid enum; `403` no company access; `404` company not in tenant.
- `DELETE …/relationships/{entryId}` → `204`; `404` entry not under that company/tenant.

- [ ] **Step 1 — failing test:** in `tests/api-v1-lead-relationships.test.ts`: POST valid → 201 + GET lists it; POST invalid `relationship_type` → 400; missing `person_name` → 400; walled caller → 403; company in another tenant → 404; DELETE → 204 then GET empty. Mock auth + the supabase client as the deal-audit/companies tests do.
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/api-v1-lead-relationships.test.ts`.
- [ ] **Step 3 — implement:** the two route files — `requireApiUser`, resolve tenant, verify company access (same predicate as companies), validate body against `leadMaps.ts` enums, insert/select/delete scoped by `tenant_id` + `company_id`.
- [ ] **Step 4 — run, expect pass:** same command → PASS; full suite green.
- [ ] **Step 5 — implement docs:** add the 3 routes to `openapi/phase1.json` + `api-v1.md`.
- [ ] **Step 6 — commit:** `feat(leads): relationships REST under /api/v1/companies/{id}`

---

## Task 3: Stakeholders API (`/api/v1/companies/{id}/stakeholders`)

Same shape as Task 2, for the stakeholder resource.

**Files:**
- Create: `src/app/api/v1/companies/[companyId]/stakeholders/route.ts` (GET + POST) and `…/[entryId]/route.ts` (DELETE).
- Modify: `openapi/phase1.json` + `api-v1.md`.
- Test: `tests/api-v1-lead-stakeholders.test.ts`.

**Interfaces (produced):**
- `POST …/stakeholders` body `{ name, title?, org?, role_in_decision, equity_pct?, motivation, stance, board_seat?, investor?, likely_objections? }` → `201 { stakeholder }`. Same 400/403/404 semantics. `equity_pct` numeric (coerce/validate). `GET` → `{ stakeholders: [] }`; `DELETE` → `204`.

- [ ] **Step 1 — failing test:** mirror Task 2's cases for stakeholders (valid → 201 + GET; invalid `role_in_decision`/`motivation`/`stance` → 400; missing `name` → 400; walled → 403; cross-tenant → 404; DELETE → 204).
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/api-v1-lead-stakeholders.test.ts`.
- [ ] **Step 3 — implement:** the two route files (mirror Task 2, stakeholder fields/enums).
- [ ] **Step 4 — run, expect pass:** same → PASS; full suite green.
- [ ] **Step 5 — docs:** `openapi/phase1.json` + `api-v1.md`.
- [ ] **Step 6 — commit:** `feat(leads): stakeholders REST under /api/v1/companies/{id}`

---

## Task 4: `/leads` UI — repeatable maps on a lead

**Files:**
- Modify: `src/components/leads/LeadRegistration.tsx` — the two maps become repeatable row editors: an "Add relationship" / "Add stakeholder" button appends a row, a remove control per row; the row fields consume the `leadMaps.ts` enums (replace the local arrays). Remove the "Visualization only. Not saved this week." captions.
- Modify: `src/components/leads/LeadList.tsx` — a per-lead expand/detail that loads `GET …/relationships` + `…/stakeholders` and lets the MD add (POST) / remove (DELETE) rows against that existing lead.
- Consider extracting the row editors into `src/components/leads/RelationshipRows.tsx` + `StakeholderRows.tsx` if `LeadRegistration.tsx` grows unwieldy (report as DONE_WITH_CONCERNS if a split is warranted).
- Test: `tests/lead-registration.test.tsx` (extend) + a new `tests/lead-maps.test.tsx` for the row add/remove + persistence.

**Interfaces (consumed):** the six endpoints from Tasks 2-3; `leadMaps.ts` enums.

- [ ] **Step 1 — failing test:** in `tests/lead-maps.test.tsx`: on an existing lead, "Add relationship" renders a row; filling it + save POSTs the correct body to `…/{id}/relationships` (assert the request body, as the T2 name-boundary test does); remove calls DELETE and drops the row; same for stakeholders. Mock fetch.
- [ ] **Step 2 — run, expect fail:** `npx vitest run tests/lead-maps.test.tsx`.
- [ ] **Step 3 — implement:** the repeatable row editors + the wire calls; on **Register lead**, create the company then POST each entered row with the new `company_id`, surfacing a decisive per-row message on failure without losing the created lead.
- [ ] **Step 4 — run, expect pass:** `npx vitest run tests/lead-maps.test.tsx tests/lead-registration.test.tsx`; full suite green.
- [ ] **Step 5 — manual check:** with `gate0_api_create` on + a seeded lead, add a relationship + a stakeholder, reload, confirm they persist.
- [ ] **Step 6 — commit:** `feat(leads): persist relationship + stakeholder maps in the /leads UI`

---

## Wrap-up

- [ ] Full suite green: `npm test`. Typecheck: `npx tsc --noEmit` (ignore the known stale `.next` artifact error).
- [ ] Open PR into `develop` (stacked: note it depends on #114; rebase onto develop once #114 merges).

## Open decisions / follow-ups (not blocking)

- Confidentiality gating (owner-only / `sensitive`) — deferred to Storm's ruling; schema is additive.
- Register-time chaining (Task 4 Step 3): if the create-then-POST-rows flow proves fiddly (partial failure), fall back to name-only register + manage rows on the lead detail (Task 4 LeadList path), and note it.
- PATCH (edit-in-place) of an entry — today edit = remove + re-add.

## Self-review

- Spec coverage: schema+constants (T1), relationships API (T2), stakeholders API (T3), repeatable UI + persistence (T4) — all mapped. Access model = reuse existing predicate. Non-goals honored (no confidentiality gating, no PATCH, no audit/ wizard changes).
- Dependency order: T1 → T2/T3 (need tables+constants) → T4 (needs endpoints). T2 and T3 are independent of each other.
- Migration DB-apply is controller-gated (T1 Step 6), consistent with prior migration slices.
