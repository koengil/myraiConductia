# Lead CRM Persistence — Relationship & Stakeholder Maps

Status: approved design (2026-07-22). Author: Marcelo.

Companion to `docs/03-engineering/api-v1.md` (extends the Phase-1 platform contract)
and the lead-registration slice (#114). Turns the `/leads` relationship-map and
stakeholder-map fields from visualization-only into persisted, repeatable data.

## Goal

Today the `/leads` form persists only the company **name** (`POST /api/v1/companies`);
the relationship-map and stakeholder-map fields are local state and are discarded on
submit ("Not saved this week"). This slice persists both maps as **repeatable lists**
tied to a lead (company), with real API storage, so a lead can carry the several
relationships and stakeholders a real M&A pursuit has.

## Non-goals (out of scope)

- Fine-grained confidentiality (per-entry "sensitive", owner-only visibility). Leads
  are the **non-confidential CRM layer** (Storm: "the CRM information does not need to
  be confidential; confidentiality enters when it becomes a project"). Svetozar's open
  questions ("who can see what / what a referrer says that should never be persisted")
  are a Storm/compliance decision to be layered on later; the schema is additive so a
  `sensitive` flag or owner-gating can be added without rework.
- The "digital twin" per individual (Storm's pixie dust) — explicitly post-MVP.
- Editing history / audit of CRM edits (the existing `audit_log` is not extended here).
- Any change to the Gate-0 wizard or the deal flow.

## Access model

Tenant-scoped, identical to the companies surface: the same `userCanSearchCompanies` /
company-access predicate that already gates `/leads` and `GET/POST /api/v1/companies`.
Any tenant user who may see the company may read and write its maps; walled
(research/trading) and external users are barred (403). No new owner model.

## Data model

Two child tables, each referencing a lead (`companies.id`), tenant-scoped, mirroring
the existing migration style (`supabase/migrations/*_permissions_schema.sql`). CHECK
enums copy the current `/leads` UI option sets verbatim (the migration is the source of
truth; TS constants mirror it).

```sql
create table if not exists lead_relationships (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  company_id        uuid not null references companies (id) on delete cascade,
  person_name       text not null,
  title             text,
  person_company    text,
  contact_info      text,
  relationship_type text not null check (relationship_type in
    ('colleague','co-investor','board member','prior client','prior banker',
     'personal','school','prior deal counterparty')),
  strength          text not null check (strength in ('High','Medium','Low')),
  source            text not null check (source in
    ('HubSpot','M365 email-calendar','PitchBook','CapIQ','banker asserted')),
  confidence        text not null check (confidence in ('High','Medium','Low')),
  last_verified     date,
  owner             text,
  basis             text,
  created_at        timestamptz not null default now()
);
create index if not exists lead_relationships_company_idx
  on lead_relationships (tenant_id, company_id);

create table if not exists lead_stakeholders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  company_id       uuid not null references companies (id) on delete cascade,
  name             text not null,
  title            text,
  org              text,
  role_in_decision text not null check (role_in_decision in
    ('decision-maker','influencer','gatekeeper','blocker')),
  equity_pct       numeric,
  motivation       text not null check (motivation in
    ('max price','speed','legacy','keep the team','liquidity','return hurdle')),
  stance           text not null check (stance in ('Supporter','Neutral','Detractor')),
  board_seat       boolean not null default false,
  investor         boolean not null default false,
  likely_objections text,
  created_at       timestamptz not null default now()
);
create index if not exists lead_stakeholders_company_idx
  on lead_stakeholders (tenant_id, company_id);
```

RLS: enable on both tables (consistent with the rest of Phase-1 where RLS is enabled
and policies are deferred to the app layer per ADR-0008 / permissions-enforcement-gaps);
the API layer enforces access with the company-access predicate. Person-name required;
the rest optional except the CHECK-enum fields which default to the UI's default option.

## Constants

`src/lib/constants/leadMaps.ts` (new) mirrors the four SQL CHECK enums as TS string
arrays/unions, replacing the local arrays in `LeadRegistration.tsx` so the UI, the API
validation, and the SQL stay in one lockstep set (repo convention; a
`constants-schema-sync` guard test already exists for other enums and this joins it).

## API (`/api/v1`, beside companies — platform contract, not `ConductiaAPI`)

Nested under a lead (company):

- `GET  /api/v1/companies/{id}/relationships` → `{ relationships: LeadRelationship[] }`
- `POST /api/v1/companies/{id}/relationships` → `201 { relationship: LeadRelationship }`
- `DELETE /api/v1/companies/{id}/relationships/{entryId}` → `204`
- `GET  /api/v1/companies/{id}/stakeholders` → `{ stakeholders: LeadStakeholder[] }`
- `POST /api/v1/companies/{id}/stakeholders` → `201 { stakeholder: LeadStakeholder }`
- `DELETE /api/v1/companies/{id}/stakeholders/{entryId}` → `204`

Status codes: `400` (missing required field / invalid enum value), `401` (no session),
`403` (cannot access the company / walled / external), `404` (company or entry not in
tenant), `201`/`204` success. All handlers `requireApiUser`, resolve the caller's
`tenant_id`, verify the company belongs to the tenant and is accessible, and scope every
read/write by `tenant_id` + `company_id`. `openapi/phase1.json` + `api-v1.md` updated;
explorable at `/dev-api`.

## UI (`/leads`)

Each map becomes a **repeatable list** in `LeadRegistration.tsx` (relationship + stakeholder):

- A row editor with the existing fields, an **"Add relationship" / "Add stakeholder"**
  button that appends the row, and a **remove** control per row.
- Persistence flow: on **Register lead**, the company is created (`POST /companies`),
  then each entered relationship/stakeholder row is persisted to the nested endpoints
  with the new `company_id`. A row that fails validation surfaces a decisive message
  (brand voice, no em-dashes); the company still exists (partial success is reported,
  not silently dropped).
- The **Registered Leads** list (`LeadList`) gains a per-lead view that loads the lead's
  relationships + stakeholders (`GET`) and allows adding/removing rows against an
  existing lead (each add/remove hits the API directly).
- The "Visualization only. Not saved this week." captions are removed.

## Testing

- **API:** for each of the two resources — CRUD happy path (201 create → GET lists it →
  DELETE removes it), tenant scoping (an entry under another tenant's company is 404),
  access gate (walled/external caller → 403), invalid enum → 400, missing person/name →
  400, company-not-found → 404. Mirror `tests/api-v1-companies-post.test.ts` mocking.
- **Constants↔schema:** extend the existing sync guard so the four enums match the SQL.
- **UI:** add-row then remove-row updates the list; on register, the entered rows POST
  with the correct `company_id` (assert the request bodies, as the T2 test does for the
  name-only boundary); a failed row surfaces its message without losing the created lead.

## Rollout

- One migration `supabase/migrations/<ts>_lead_crm_maps.sql` (both tables + indexes +
  RLS enable). Applied to Conductia-dev via `npm run db:migrate` (controller-run,
  user-gated RED→GREEN as with prior migrations).
- Backward compatible: purely additive; existing leads simply have empty maps until
  entries are added. No change to `POST /companies`.

## Follow-ups (later)

- Confidentiality gating (owner-only / `sensitive` flag) once Storm rules on Svetozar's
  open questions.
- Derived "paths" (ranked routes to a target) on the relationship map — the doc's draft
  lists it as derived; out of scope here.
- Edit-in-place (PATCH) of an entry; today edit = remove + re-add.
