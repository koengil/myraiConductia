# Permissions Schema — v2 (merged)

**Status:** Superseded by [`permissions_schema_v3-full.md`](permissions_schema_v3-full.md); the migrations under `supabase/migrations/` are the source of truth. Originally: Draft — merged from `permissions_schema_v1.md` (Marcello) and the Rob/AI JSON schema.  
**Purpose:** Shared model for prototype UI and future Supabase backend. This is the *model* (entities + who-sees-what + audit), not enforcement code.  
**Target platform:** Supabase / Postgres (RLS enforcement derived, not prescribed here).

> **Merge notes are inline as `<!-- CHANGE: … -->` comments.** See §6 for a consolidated change log.

---

## Core principle

Access is **deal-scoped by default**. If a user holds no membership in a deal, that deal does not exist for them — no listing, no search, no documents. This is the Chinese wall, enforced by construction rather than policy. The only roles that sit *above* the walls are `cco` (oversight) and `admin` (user management).

---

## 1. Entities

```sql
-- ─────────────────────────────────────────────
-- COMPANIES
-- ─────────────────────────────────────────────
-- CHANGE: type enum expanded.
--   v1 had 'target | client | counterparty' (deal parties).
--   JSON schema had 'bank | client | acquirer' (firm taxonomy).
--   Merged into a single enum that covers both:
--     'bank'          — the IB firm running the mandate (Deal.bank_id)
--     'target'        — the company being sold (replaces v1 'target')
--     'acquirer'      — ranked potential buyer — the central Conductia object
--     'client'        — retained from both
--     'counterparty'  — retained from v1
--   'acquirer' is now first-class here so it maps cleanly to the
--   ConductiaAPI Acquirer type (scored, ranked). It was missing from v1.
--
-- CHANGE: tenant_id added from JSON schema.
--   Supports multi-bank deployments without a separate tenants table.
create table companies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  name        text not null,
  type        text not null check (type in ('bank','target','acquirer','client','counterparty')),
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────
-- CHANGE: firm_role 'compliance' renamed to 'cco'.
--   Aligns with the product persona (Chief Compliance Officer) and
--   the access matrix role slug. 'compliance' was ambiguous — it read
--   like a module, not a role.
--
-- CHANGE: tenant_id added for multi-bank isolation.
--
-- CHANGE: display_name added from JSON schema (v1 only had full_name;
--   both are kept — full_name for legal/audit, display_name for UI).
create table users (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  email        text not null unique,
  full_name    text not null,
  display_name text,
  is_external  boolean not null default false,
  firm_role    text check (firm_role in ('cco','admin')),
  status       text not null default 'active' check (status in ('active','suspended'))
);

-- ─────────────────────────────────────────────
-- ROLES  (new table — from JSON schema)
-- ─────────────────────────────────────────────
-- CHANGE: Role extracted as a proper table rather than inline enum strings.
--   v1 hard-coded deal_role values directly on deal_memberships.
--   JSON schema introduced a Role entity with slug + label + permissions[].
--   Merged: roles table holds canonical slugs; deal_memberships still
--   carries deal_role text for query efficiency, but it FK-references here
--   so the catalogue is authoritative. permissions is jsonb for flexibility.
--
-- Slugs and their seam mapping:
--   'md'         → TeamMember.role 'MD' (seam); deal-scoped
--   'deal_team'  → TeamMember.role 'CFO' | 'M&A Advisor' (seam subsumes both)
--   'cco'        → firm_role 'cco' users; above all walls
--   'seller'     → external; upload-only
--   'buyer'      → external; phase-gated read
--   'read_only'  → internal observer; no write, no compliance access
--   'admin'      → firm_role 'admin'; user management only
create table roles (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug in
                ('md','deal_team','cco','seller','buyer','read_only','admin')),
  label       text not null,
  permissions jsonb not null default '[]'
);

-- ─────────────────────────────────────────────
-- DEALS
-- ─────────────────────────────────────────────
-- CHANGE: bank_id added from JSON schema (company_id on the bank running
--   the mandate). v1 only had target_company_id. Now Deal explicitly
--   carries both the originating bank and the target.
--
-- CHANGE: mandate_owner_id added from JSON schema. Makes the MD who owns
--   the deal explicit at the table level — previously derivable only by
--   querying deal_memberships for role='md', which is fragile.
--
-- CHANGE: status 'paused' added from JSON schema. v1 had intake|active|closed;
--   paused covers regulatory hold situations without closing the deal.
create table deals (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  code                text not null unique,          -- e.g. "ATLAS-2026-014"
  codename            text not null,                 -- e.g. "Project Atlas"
  bank_id             uuid not null references companies(id),
  target_company_id   uuid references companies(id),
  mandate_owner_id    uuid references users(id),     -- the MD
  status              text not null default 'intake'
                      check (status in ('intake','active','paused','closed')),
  created_at          timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- DEAL MEMBERSHIPS
-- ─────────────────────────────────────────────
-- CHANGE: role_id FK to roles table added alongside deal_role text.
--   Keeps query efficiency while making the role catalogue authoritative.
--
-- CHANGE: access_scope jsonb added from JSON schema.
--   Allows fine-grained scoping within a role (e.g. which document
--   classifications a deal_team member can see) without a full ACL table.
--   Nullable — absence means full role defaults apply.
--
-- phase retained from v1 (buyer data-room phase gate). Not in JSON schema
-- but essential for the buyer access model.
create table deal_memberships (
  id             uuid primary key default gen_random_uuid(),
  deal_id        uuid not null references deals(id),
  user_id        uuid not null references users(id),
  role_id        uuid not null references roles(id),
  deal_role      text not null check (deal_role in
                   ('md','deal_team','seller','buyer','read_only')),
  phase          int  not null default 0,
  access_scope   jsonb,
  added_by       uuid references users(id),
  access_granted_at timestamptz not null default now(),
  unique (deal_id, user_id)
);

-- ─────────────────────────────────────────────
-- DOCUMENTS
-- ─────────────────────────────────────────────
-- CHANGE: retained from v1 unchanged. JSON schema did not model documents,
--   but classification-driven routing is core to the compliance moat.
--   No modification — keeping v1 exactly.
create table documents (
  id             uuid primary key default gen_random_uuid(),
  deal_id        uuid not null references deals(id),
  name           text not null,
  classification int  not null check (classification between 1 and 4), -- 1 Public … 4 MNPI
  min_phase      int  not null default 0,
  uploaded_by    uuid references users(id),
  created_at     timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- COMPLIANCE EVENTS  (promoted to first-class — from JSON schema)
-- ─────────────────────────────────────────────
-- CHANGE: ComplianceEvent elevated from audit_log rows to its own table.
--   v1 logged screening in the generic audit_log (action = 'route').
--   JSON schema modelled ComplianceEvent as a first-class entity with
--   verdict + rewrite + visible_to — the right call, since screening is
--   the platform's moat, not an ancillary audit entry.
--   Merged: compliance_events is now the authoritative screening record;
--   audit_log still exists for generic action history (see below).
--
-- CHANGE: visible_to is jsonb array of role slugs (from JSON schema).
--   Controls which roles can see the event in the compliance feed.
--   CCO sees all; MD sees verdicts only; deal_team sees own events only
--   (enforced by RLS + application layer).
--
-- CHANGE: three-state verdict (compliant | hold | blocked) from ADR-0003
--   replaces the seam's binary clear | blocked. The 'hold' state covers
--   the "pending human review" case that binary can't express.
create table compliance_events (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references deals(id),
  actor_id     uuid not null references users(id),
  payload_hash text not null,          -- SHA-256 of original message body
  verdict      text not null check (verdict in ('compliant','hold','blocked')),
  rewrite      text,                   -- CCO-authored or AI-suggested rewrite; null if compliant
  visible_to   jsonb not null default '["md","deal_team","cco"]',
  screened_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- AUDIT LOG  (generic spine — retained from v1)
-- ─────────────────────────────────────────────
-- CHANGE: compliance screening actions now live in compliance_events.
--   audit_log covers everything else: view | download | upload | export |
--   grant | revoke. The 'route' action is retired here — routing is a
--   screening event, not a generic log entry.
create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  actor_id    uuid not null references users(id),
  action      text not null check (action in
                ('view','download','upload','export','grant','revoke')),
  deal_id     uuid references deals(id),
  document_id uuid references documents(id),
  detail      jsonb
);
```

---

## 2. Access matrix — who sees what on a Deal

> Updated to reflect merged role set. CCO replaces 'compliance'. 'seller' and 'buyer' rows added for external party completeness.

| Resource | MD | Deal Team | CCO | Seller (ext.) | Buyer (ext.) |
|---|---|---|---|---|---|
| Mandate brief (vitals, pipeline) | ✅ Full | ✅ Full | ✅ Full | ❌ | ❌ |
| Acquirer ranked table | ✅ Full (scores + weights) | ✅ Read-only scores | ❌ Names redacted (MNPI guard) | ❌ | ❌ |
| Deep-dive canvas (drag skills) | ✅ Execute + view | ✅ View only | ❌ No access | ❌ | ❌ |
| Composite scoring weights (sliders) | ✅ Edit | ❌ | ❌ | ❌ | ❌ |
| Deal team chat threads | ✅ All threads | ✅ Own thread only | ✅ All threads (audit read) | ❌ | ❌ |
| Compliance event feed | ✅ Verdicts only | ✅ Own events only | ✅ Full (payload + rewrite) | ❌ | ❌ |
| Compliance rewrite suggestions | ✅ Receives | ✅ Receives | ✅ Authors | ❌ | ❌ |
| Skills catalogue | ✅ Full (Pro tier) | ✅ Assigned skills only | ❌ | ❌ | ❌ |
| KYC / FINRA / MNPI intake results | ✅ Status only | ❌ | ✅ Full detail | ❌ | ❌ |
| User roster + role assignments | ✅ View | ❌ | ✅ View + audit | ❌ | ❌ |
| Documents (class 1–3) | ✅ | ✅ | ✅ | ✅ Upload only | ✅ Phase-gated read |
| Documents (class 4 / MNPI) | ✅ | ❌ | ✅ | ❌ | ❌ |

**Governing rule:** `visibility = membership_scope ∩ classification_policy ∩ phase_gate`

- `membership_scope` — which deals the user is walled into
- `classification_policy` — which document classes their role can access
- `phase_gate` — for buyers: `doc.min_phase <= membership.phase`

---

## 3. Seam reconciliation (naming collisions resolved)

| Collision | Seam (`src/lib/api/types.ts`) | v1 Schema | v2 Resolution |
|---|---|---|---|
| **Company.kind** | `'seller' \| 'acquirer' \| 'peer'` (objects of analysis) | `type: 'target' \| 'client' \| 'counterparty'` (deal parties) | v2 `companies.type` uses `'bank' \| 'target' \| 'acquirer' \| 'client' \| 'counterparty'`. The seam's `CompanyKind` is a *display classification* for the UI; `companies.type` is a *structural classification* for access logic. Both coexist — map `seller→target`, `acquirer→acquirer`, `peer→counterparty` at the API layer. |
| **Role** | `TeamMember.role: 'MD' \| 'CFO' \| 'M&A Advisor'` (display-only job titles) | `deal_role: 'md' \| 'deal_team' \| 'seller' \| 'buyer'` | `TeamMember.role` is UI-only and survives unchanged. `deal_role` governs access. CFO and M&A Advisor both map to `deal_role = 'deal_team'` — the seam field is display label, the schema field is permission group. |
| **Acquirer** | Central scored object (`Acquirer extends Company`) | Not modelled — missing from v1 | `companies.type = 'acquirer'` is now explicit. The seam's `Acquirer` type (with `fitInputs`) maps to a `companies` row with `type='acquirer'`. Scores live in the scoring layer, not the permissions layer — no conflict. |
| **Compliance** | Binary `'clear' \| 'blocked'` (`ComplianceCheckResult`) | Generic `audit_log` entry (action = 'route') | v2 `compliance_events.verdict` uses three-state `'compliant' \| 'hold' \| 'blocked'` (ADR-0003). The seam's binary result should be updated to match — `'clear'` → `'compliant'`, `'blocked'` → `'blocked'`, new `'hold'` state added. |

---

## 4. Decisions still open (from v1 §5, status updated)

1. **MD scope** — modelled as deal-scoped (inside assigned walls only). Confirm this is correct vs. firm-wide read.
2. **Buyer phase ladder** — `phase` is an integer; need the actual stage names (e.g. `0=teaser, 1=NDA-data-room, 2=confirmatory`).
3. **Companies per deal** — currently one `target_company_id`. If client + counterparty per deal are needed, `deal_parties` join table required for v2.
4. **Classification vs. visibility** — does class 4 / MNPI *hide* documents from in-deal roles, or only change the routing tier? Matrix above assumes hide-from-externals + on-prem routing for class 4.

---

## 5. RLS sketch (derived, backend lane)

```sql
-- Deal visible if: member, or CCO/admin firm role
create policy deal_visibility on deals for select using (
  exists (select 1 from deal_memberships m
          where m.deal_id = deals.id and m.user_id = auth.uid())
  or exists (select 1 from users u
             where u.id = auth.uid() and u.firm_role in ('cco','admin'))
);

-- Document visible if: deal visible, AND
--   (not external buyer OR phase gate passes) AND
--   (not class 4 OR user is md/cco)
create policy doc_visibility on documents for select using (
  -- deal membership exists
  exists (select 1 from deal_memberships m where m.deal_id = documents.deal_id and m.user_id = auth.uid())
  -- phase gate for buyers
  and (
    not exists (select 1 from deal_memberships m where m.deal_id = documents.deal_id and m.user_id = auth.uid() and m.deal_role = 'buyer')
    or exists (select 1 from deal_memberships m where m.deal_id = documents.deal_id and m.user_id = auth.uid() and m.phase >= documents.min_phase)
  )
  -- class 4 / MNPI: only md or cco
  and (
    documents.classification < 4
    or exists (select 1 from deal_memberships m
               join roles r on r.id = m.role_id
               where m.deal_id = documents.deal_id and m.user_id = auth.uid()
               and r.slug in ('md'))
    or exists (select 1 from users u where u.id = auth.uid() and u.firm_role = 'cco')
  )
);
```

---

## 6. Change log (v1 → v2)

| # | What changed | Why |
|---|---|---|
| 1 | `companies.type` enum expanded to include `'bank'` and `'acquirer'` | `'acquirer'` was the central product object but missing from v1; `'bank'` identifies the IB firm running the mandate |
| 2 | `tenant_id` added to `companies` and `users` | Multi-bank isolation; from JSON schema |
| 3 | `firm_role 'compliance'` renamed to `'cco'` | Matches product persona and role slug; 'compliance' read as a module name |
| 4 | `roles` table introduced | From JSON schema; makes the role catalogue authoritative rather than inline enum strings |
| 5 | `deals.bank_id` + `deals.mandate_owner_id` added | JSON schema; explicit bank and MD ownership at table level |
| 6 | `deals.status` gains `'paused'` | JSON schema; covers regulatory hold without closing the deal |
| 7 | `deal_memberships.role_id` FK + `access_scope jsonb` added | From JSON schema; role catalogue FK + per-membership scope overrides |
| 8 | `compliance_events` promoted to first-class table | JSON schema + ADR-0003; screening is the moat, not a generic log action |
| 9 | `compliance_events.verdict` three-state (`compliant\|hold\|blocked`) | ADR-0003 alignment; replaces seam's binary `clear\|blocked` |
| 10 | `audit_log.action` drops `'route'` | Routing is now a screening event in `compliance_events`, not a generic log entry |
| 11 | Access matrix expanded with `seller` and `buyer` rows + MNPI document row | External parties were in the v1 role model but absent from the matrix |
