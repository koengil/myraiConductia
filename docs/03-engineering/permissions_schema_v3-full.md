# Permissions Schema — v3 (full)

**Status:** Draft — authoritative merge of v2 (merged) and v3 (patch). The migrations under `supabase/migrations/` are the source of truth where they differ (for example `users.status` also allows `invited`); `ndas`, `deal_expenses` and `compliance_events` below are not built yet.  
**Purpose:** Shared model for prototype UI and future Supabase backend. This is the *model* (entities + who-sees-what + audit), not enforcement code.  
**Target platform:** Supabase / Postgres (RLS enforcement derived, not prescribed here).  
**Supersedes:** `permissions_schema_v2.md`, `permissions_schema_v3.md`

---

## Core principle

Access is **deal-scoped by default**. If a user holds no membership in a deal, that deal does not exist for them — no listing, no search, no documents. This is the Chinese wall, enforced by construction rather than policy. The only roles that sit *above* the walls are `cco` (oversight) and `admin` (user management). A second, firm-level wall separates IB from research/trading — enforced via `users.department`, independent of deal membership.

---

## 1. Entities

```sql
-- ─────────────────────────────────────────────
-- COMPANIES
-- ─────────────────────────────────────────────
-- type enum:
--   'bank'          — the IB firm running the mandate
--   'target'        — the company being sold
--   'acquirer'      — ranked potential buyer (central Conductia object)
--   'client'        — retained client
--   'counterparty'  — other deal party (includes law firms, accounting firms,
--                    and advisory firms; Storm confirmed these will need data
--                    room access — distinguish by companies.name / future subtype
--                    if the UI needs to filter them separately)
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
-- firm_role: firm-wide elevated roles only ('cco', 'admin').
--   All other access is governed by deal_memberships.deal_role.
--
-- department: enforces the internal Chinese wall.
--   'ib'         — Investment Banking (eligible for deal memberships)
--   'research'   — Equity Research (no deal memberships permitted)
--   'trading'    — Trading desk (no deal memberships permitted)
--   'compliance' — Compliance / CCO staff
--   'legal'      — Legal department
--   'admin'      — Platform administration
--   null         — external users (is_external = true)
--
-- display_name: UI label; full_name reserved for legal/audit use.
create table users (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  email        text not null unique,
  full_name    text not null,
  display_name text,
  is_external  boolean not null default false,
  firm_role    text check (firm_role in ('cco','admin')),
  department   text check (department in ('ib','research','trading','compliance','legal','admin')),
  status       text not null default 'active' check (status in ('active','suspended'))
);

-- ─────────────────────────────────────────────
-- ROLES
-- ─────────────────────────────────────────────
-- Slugs:
--   'md'         → Managing Director; deal owner
--   'deal_team'  → internal deal team member (CFO, M&A Advisor, etc.)
--   'legal'      → Legal Counsel; NDA + engagement letter management
--   'cco'        → Chief Compliance Officer; above all walls
--   'seller'     → external; upload-only
--   'buyer'      → external; phase-gated read
--   'read_only'  → internal observer; no write, no compliance access
--   'admin'      → user management only
--
-- permissions is jsonb for flexibility; enforcement is via RLS + app layer.
create table roles (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug in
                ('md','deal_team','legal','cco','seller','buyer','read_only','admin')),
  label       text not null,
  permissions jsonb not null default '[]'
);

-- Seed rows:
insert into roles (slug, label, permissions) values
  ('md',        'Managing Director',   '["deal:full","acquirer:full","scoring:edit","team:manage","compliance:verdicts"]'),
  ('deal_team', 'Deal Team',           '["deal:read","acquirer:scores","document:read:class1-3","thread:own"]'),
  ('legal',     'Legal Counsel',       '["nda:manage","engagement_letter:manage","document:read:class1-3","thread:own"]'),
  ('cco',       'Chief Compliance Officer', '["deal:read:all","compliance:full","audit:full","nda:read"]'),
  ('seller',    'Seller',              '["document:upload:class1-3"]'),
  ('buyer',     'Buyer',               '["document:read:phase_gated"]'),
  ('read_only', 'Observer',            '["deal:read","document:read:class1-2"]'),
  ('admin',     'Administrator',       '["user:manage","tenant:manage"]');

-- ─────────────────────────────────────────────
-- DEALS
-- ─────────────────────────────────────────────
-- code: unique project code assigned at intake (e.g. "ATLAS-2026-014").
--   All expenses, audit entries, and compliance events anchor to this code.
--   Also used for conflict checking before a new mandate is opened.
--
-- codename: internal project name (e.g. "Project Atlas").
--
-- mandate_owner_id: the MD who owns the deal. Explicit at table level —
--   not derivable only from deal_memberships.
--
-- status:
--   'intake'  — project code assigned, compliance screening in progress
--   'active'  — mandate live
--   'paused'  — regulatory hold; not closed
--   'closed'  — deal concluded or abandoned
create table deals (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  code              text not null unique,
  codename          text not null,
  bank_id           uuid not null references companies(id),
  mandate_owner_id  uuid references users(id),
  status            text not null default 'intake'
                    check (status in ('intake','active','paused','closed')),
  created_at        timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- DEAL PARTIES  (replaces deals.target_company_id)
-- ─────────────────────────────────────────────
-- Supports multiple companies per deal and enables conflict detection:
-- query this table before creating a new mandate to find any active deal
-- already involving the incoming company.
--
-- party_role:
--   'target'             — the company being sold
--   'co_seller'          — co-selling shareholder
--   'acquirer_shortlist' — ranked potential buyer
--   'counterparty'       — other deal party
create table deal_parties (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals(id),
  company_id  uuid not null references companies(id),
  party_role  text not null check (party_role in
                ('target','co_seller','acquirer_shortlist','counterparty')),
  added_at    timestamptz not null default now(),
  unique (deal_id, company_id, party_role)
);

-- Conflict-check query (run before creating a new deal):
-- select d.id, d.code, d.codename, dp.party_role
-- from deal_parties dp
-- join deals d on d.id = dp.deal_id
-- where dp.company_id = :incoming_company_id
--   and d.status in ('intake','active')
--   and d.tenant_id = :tenant_id;

-- ─────────────────────────────────────────────
-- DEAL MEMBERSHIPS
-- ─────────────────────────────────────────────
-- deal_role governs access. role_id FK makes the roles table authoritative.
-- access_scope: optional per-membership overrides (e.g. which document
--   classifications a deal_team member can see). Absence = full role defaults.
-- phase: buyer data-room phase gate.
--   Proposed ladder: 0=teaser | 1=nda_signed | 2=preliminary_data_room | 3=confirmatory
--
-- Wall-breach rule: users with department='research' or 'trading' must never
--   hold a deal membership. Enforced by trigger (see §5).
--
-- Firm-departure rule (D32, 2026-06-07): user access is company-scoped.
--   If a user leaves their firm, an admin must be able to revoke all of that
--   user's deal_memberships in a single operation ("remove from all").
--   This is not yet active in /api/v1 but is a regulatory requirement.
--   Implementation: a DELETE /api/v1/users/:id/memberships endpoint, MD-gated,
--   audited as action='revoke' in audit_log with detail={reason:'firm_departure'}.
create table deal_memberships (
  id                 uuid primary key default gen_random_uuid(),
  deal_id            uuid not null references deals(id),
  user_id            uuid not null references users(id),
  role_id            uuid not null references roles(id),
  deal_role          text not null check (deal_role in
                       ('md','deal_team','legal','seller','buyer','read_only')),
  phase              int  not null default 0,
  access_scope       jsonb,
  added_by           uuid references users(id),
  access_granted_at  timestamptz not null default now(),
  unique (deal_id, user_id)
);

-- ─────────────────────────────────────────────
-- DOCUMENTS
-- ─────────────────────────────────────────────
-- classification: 1 Public → 4 MNPI.
--   Class 4 is hidden from all roles except md and cco.
-- min_phase: buyer phase required to access this document (buyers only).
create table documents (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references deals(id),
  name            text not null,
  classification  int  not null check (classification between 1 and 4),
  min_phase       int  not null default 0,
  uploaded_by     uuid references users(id),
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- NDAs
-- ─────────────────────────────────────────────
-- NDAs are directional and have their own lifecycle, distinct from documents.
-- direction:
--   'bank_to_client'  — firm signs before receiving client confidential info
--   'client_to_bank'  — counterparty/buyer signs before accessing data room
--
-- status lifecycle: draft → sent → countersigned → active → expired | terminated
--
-- A buyer cannot be promoted past phase 0 (teaser) until a countersigned NDA
-- exists for their company. Enforced at the application layer.
--
-- managed_by: the legal-role user who owns this NDA.
-- NOT BUILT (2026-10-24): no migration creates this table yet.
create table ndas (
  id               uuid primary key default gen_random_uuid(),
  deal_id          uuid not null references deals(id),
  counterparty_id  uuid not null references companies(id),
  direction        text not null check (direction in ('bank_to_client','client_to_bank')),
  status           text not null default 'draft'
                   check (status in ('draft','sent','countersigned','active','expired','terminated')),
  document_id      uuid references documents(id),
  sent_at          timestamptz,
  signed_at        timestamptz,
  expires_at       timestamptz,
  managed_by       uuid references users(id),
  created_at       timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- DEAL EXPENSES
-- ─────────────────────────────────────────────
-- Every expense anchors to a deal via its project code.
-- No concept of a firm-level expense outside a deal context —
-- pre-deal costs (pitch prep) log against the deal at status='intake'.
--
-- approved_by: nullable. Some categories (e.g. travel under threshold)
--   are self-approving; others require MD sign-off. Thresholds TBD with Storm.
--
-- external_ref: invoice number, wire reference, or card transaction ID
--   for reconciliation against the firm's accounting system.
-- NOT BUILT (2026-10-24): no migration creates this table yet.
create table deal_expenses (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references deals(id),
  incurred_by   uuid not null references users(id),
  approved_by   uuid references users(id),
  amount        numeric(14,2) not null,
  currency      char(3) not null default 'USD',
  category      text not null check (category in (
                  'travel','legal','third_party_data','filing_fee',
                  'entertainment','technology','other'
                )),
  description   text,
  external_ref  text,
  incurred_at   timestamptz not null,
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- COMPLIANCE EVENTS
-- ─────────────────────────────────────────────
-- First-class entity — screening is the platform's moat, not a log entry.
--
-- payload_hash: SHA-256 of original message body (never stored in plaintext).
-- verdict: three-state per ADR-0003.
--   'compliant' — passes screening; message delivered as-is
--   'hold'      — pending human CCO review; message withheld
--   'blocked'   — rejected; CCO-authored rewrite offered
--
-- visible_to: jsonb array of role slugs that can see this event.
--   CCO sees all; MD sees verdicts only; deal_team sees own events only.
-- NOT BUILT (2026-10-24): no migration creates this table yet.
create table compliance_events (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references deals(id),
  actor_id      uuid not null references users(id),
  payload_hash  text not null,
  verdict       text not null check (verdict in ('compliant','hold','blocked')),
  rewrite       text,
  visible_to    jsonb not null default '["md","deal_team","cco"]',
  screened_at   timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- AUDIT LOG
-- ─────────────────────────────────────────────
-- Generic action spine. Compliance screening is in compliance_events, not here.
-- Actions: view | download | upload | export | grant | revoke
create table audit_log (
  id           uuid primary key default gen_random_uuid(),
  ts           timestamptz not null default now(),
  actor_id     uuid not null references users(id),
  action       text not null check (action in
                 ('view','download','upload','export','grant','revoke')),
  deal_id      uuid references deals(id),
  document_id  uuid references documents(id),
  detail       jsonb
);

-- ─────────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────────
-- System-generated alerts. Compliance notifications for new deals were
-- "currently often forgotten" — this is the spine for proactive compliance.
--
-- Mandatory CCO events (deal_created, compliance_hold): a row is created
--   for every user with firm_role='cco' in the tenant on each trigger.
--
-- read_at: null = unread. UI badge count = count(*) where read_at is null.
create table notifications (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  deal_id       uuid references deals(id),
  recipient_id  uuid not null references users(id),
  event_type    text not null check (event_type in (
                  'deal_created','compliance_hold','nda_pending','nda_signed',
                  'phase_promoted','expense_approved','member_added'
                )),
  payload       jsonb not null default '{}',
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index notifications_recipient_unread
  on notifications (recipient_id, created_at desc)
  where read_at is null;
```

---

## 2. Access matrix — who sees what on a Deal

**Governing rule:** `visibility = membership_scope ∩ classification_policy ∩ phase_gate`

- `membership_scope` — which deals the user is walled into
- `classification_policy` — which document classes their role can access
- `phase_gate` — for buyers: `doc.min_phase <= membership.phase`

| Resource | MD | Deal Team | Legal | CCO | Seller (ext.) | Buyer (ext.) |
|---|---|---|---|---|---|---|
| Mandate brief (vitals, pipeline) | ✅ Full | ✅ Full | ✅ Read | ✅ Full | ❌ | ❌ |
| Acquirer ranked table | ✅ Full (scores + weights) | ✅ Read-only scores | ❌ | ❌ Names redacted (MNPI guard) | ❌ | ❌ |
| Deep-dive canvas (drag skills) | ✅ Execute + view | ✅ View only | ❌ | ❌ | ❌ | ❌ |
| Composite scoring weights (sliders) | ✅ Edit | ❌ | ❌ | ❌ | ❌ | ❌ |
| Deal team chat threads | ✅ All threads | ✅ Own thread only | ✅ Own thread only | ✅ All threads (audit read) | ❌ | ❌ |
| Compliance event feed | ✅ Verdicts only | ✅ Own events only | ❌ | ✅ Full (payload + rewrite) | ❌ | ❌ |
| Compliance rewrite suggestions | ✅ Receives | ✅ Receives | ❌ | ✅ Authors | ❌ | ❌ |
| NDAs | ✅ Read | ❌ | ✅ Full (manage) | ✅ Read | ❌ | ❌ |
| Engagement letters | ✅ Read | ❌ | ✅ Full (manage) | ✅ Read | ❌ | ❌ |
| Deal expenses | ✅ Full (approve) | ✅ Own only | ❌ | ✅ Read (audit) | ❌ | ❌ |
| Skills catalogue | ✅ Full (Pro tier) | ✅ Assigned skills only | ❌ | ❌ | ❌ | ❌ |
| KYC / FINRA / MNPI intake results | ✅ Status only | ❌ | ❌ | ✅ Full detail | ❌ | ❌ |
| User roster + role assignments | ✅ View | ❌ | ❌ | ✅ View + audit | ❌ | ❌ |
| Documents (class 1–3) | ✅ | ✅ | ✅ | ✅ | ✅ Upload only | ✅ Phase-gated read |
| Documents (class 4 / MNPI) | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Notifications (own) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

---

## 3. Seam reconciliation (naming collisions resolved)

| Collision | Seam (`src/lib/api/types.ts`) | Schema | Resolution |
|---|---|---|---|
| **Company.kind** | `'seller' \| 'acquirer' \| 'peer'` (display classification) | `companies.type: 'bank' \| 'target' \| 'acquirer' \| 'client' \| 'counterparty'` (structural) | Both coexist. Map at the API layer: `seller→target`, `acquirer→acquirer`, `peer→counterparty`. |
| **Role** | `TeamMember.role: 'MD' \| 'CFO' \| 'M&A Advisor'` (display label) | `deal_role: 'md' \| 'deal_team' \| 'legal' \| 'seller' \| 'buyer' \| 'read_only'` (permission group) | `TeamMember.role` is UI-only and survives unchanged. CFO and M&A Advisor both map to `deal_role = 'deal_team'`. |
| **Acquirer** | `Acquirer extends Company` (central scored object) | `companies.type = 'acquirer'` | The seam's `Acquirer` type (with `fitInputs`) maps to a `companies` row with `type='acquirer'`. Scores live in the scoring layer, not the permissions layer. |
| **Compliance** | Binary `'clear' \| 'blocked'` (`ComplianceCheckResult`) | `compliance_events.verdict: 'compliant' \| 'hold' \| 'blocked'` | Seam should be updated: `'clear'` → `'compliant'`, new `'hold'` state added. |

### Handbook role hierarchy (third vocabulary — D35)

The engineering handbook ([`intelibank-handbook.html`](./intelibank-handbook.html)) describes the *deal-team org
hierarchy* as a 9-value `HumanActor.role` domain enum. That is a domain description,
not a competing schema; it maps onto this schema's 8-slug permission enum:

| Handbook role | Schema `deal_role` / `firm_role` | Note |
|---|---|---|
| `md` | `md` | Deal owner; approves anything that leaves the firm. |
| `vp` | `deal_team` | "First reviewer" before MD sign-off — a *firm-policy gate*, not a schema role. |
| `associate`, `analyst` | `deal_team` | Collapsed into the `deal_team` permission group. |
| `compliance` | `cco` (firm role) | Renamed `compliance → cco` in v3 (change-log #3). |
| `legal` | `legal` | 1:1. |
| `admin` | `admin` (firm role) | 1:1. |
| `client` | `seller` | External; upload-only. |
| `third-party` | `buyer` | External; phase-gated read. |

The handbook's default gate ("reviewer = VP, approver = MD") is therefore expressed
here as MD approval authority + a policy-level review step, not a distinct `vp` slug.
The handbook does **not** model `users.company_role` (director/member, D33) — that is
an orthogonal company-admin axis, separate from `deal_role` (deal authority) and
`firm_role` (platform).

---

## 4. Open items

| # | Item | Priority |
|---|---|---|
| 1 | MD scope — deal-scoped (current model) vs. firm-wide read | Confirm with Storm |
| 2 | Buyer phase ladder — confirm stage names for `phase` integer (proposed: `0=teaser \| 1=nda_signed \| 2=preliminary_data_room \| 3=confirmatory`) | Confirm with Storm |
| 3 | Classification vs. visibility for class 4 / MNPI — does class 4 *hide* the document or only change routing tier? | Confirm with Storm |
| 4 | Expense approval thresholds — which categories require MD sign-off vs. self-approve | Confirm with Storm |
| 5 | NDA expiry policy — auto-terminate on deal close, or require explicit termination | Confirm with Storm |
| 6 | Department wall trigger — reject `deal_memberships` insert if `users.department in ('research','trading')` | Backend task, Week 1 |

---

## 5. RLS sketch (derived, backend lane)

```sql
-- ── Deal visibility ────────────────────────────────────────────────────────
create policy deal_visibility on deals for select using (
  exists (select 1 from deal_memberships m
          where m.deal_id = deals.id and m.user_id = auth.uid())
  or exists (select 1 from users u
             where u.id = auth.uid() and u.firm_role in ('cco','admin'))
);

-- ── Document visibility ────────────────────────────────────────────────────
create policy doc_visibility on documents for select using (
  exists (select 1 from deal_memberships m
          where m.deal_id = documents.deal_id and m.user_id = auth.uid())
  and (
    not exists (select 1 from deal_memberships m
                where m.deal_id = documents.deal_id
                  and m.user_id = auth.uid()
                  and m.deal_role = 'buyer')
    or exists (select 1 from deal_memberships m
               where m.deal_id = documents.deal_id
                 and m.user_id = auth.uid()
                 and m.phase >= documents.min_phase)
  )
  and (
    documents.classification < 4
    or exists (select 1 from deal_memberships m
               join roles r on r.id = m.role_id
               where m.deal_id = documents.deal_id
                 and m.user_id = auth.uid()
                 and r.slug = 'md')
    or exists (select 1 from users u
               where u.id = auth.uid() and u.firm_role = 'cco')
  )
);

-- ── Expense visibility ─────────────────────────────────────────────────────
create policy expense_visibility on deal_expenses for select using (
  exists (select 1 from deal_memberships m
          where m.deal_id = deal_expenses.deal_id and m.user_id = auth.uid())
);

-- ── Notification visibility ────────────────────────────────────────────────
create policy notification_visibility on notifications for select using (
  recipient_id = auth.uid()
);

-- ── Department wall (trigger — can't use CHECK across tables) ──────────────
create or replace function enforce_department_wall()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from users u
    where u.id = new.user_id
      and u.department in ('research', 'trading')
  ) then
    raise exception 'Wall breach: research/trading users cannot hold deal memberships';
  end if;
  return new;
end;
$$;

create trigger department_wall_check
  before insert or update on deal_memberships
  for each row execute function enforce_department_wall();

-- ── NDA phase gate (buyer promotion guard) ─────────────────────────────────
create or replace function enforce_nda_phase_gate()
returns trigger language plpgsql as $$
begin
  if new.deal_role = 'buyer' and new.phase > 0 then
    if not exists (
      select 1 from ndas n
      join companies c on c.id = n.counterparty_id
      join users u on u.id = new.user_id
      where n.deal_id = new.deal_id
        and n.status = 'active'
    ) then
      raise exception 'NDA gate: buyer cannot be promoted past phase 0 without an active NDA';
    end if;
  end if;
  return new;
end;
$$;

create trigger nda_phase_gate_check
  before insert or update on deal_memberships
  for each row execute function enforce_nda_phase_gate();
```

---

## 6. Full change log (v1 → v3)

| # | What changed | Why |
|---|---|---|
| 1 | `companies.type` enum expanded to include `'bank'` and `'acquirer'` | `'acquirer'` was the central product object but missing from v1; `'bank'` identifies the IB firm running the mandate |
| 2 | `tenant_id` added to `companies` and `users` | Multi-bank isolation |
| 3 | `firm_role 'compliance'` renamed to `'cco'` | Matches product persona; 'compliance' read as a module name |
| 4 | `roles` table introduced | Makes the role catalogue authoritative rather than inline enum strings |
| 5 | `legal` added to `roles` slug enum + access matrix | Distinct user type from kickoff call; NDA + engagement letter management |
| 6 | `deals.bank_id` + `deals.mandate_owner_id` added | Explicit bank and MD ownership at table level |
| 7 | `deals.status` gains `'paused'` | Covers regulatory hold without closing the deal |
| 8 | `deals.target_company_id` replaced by `deal_parties` join table | Multi-company support + conflict-check query |
| 9 | `deal_memberships.role_id` FK + `access_scope jsonb` added | Role catalogue FK + per-membership scope overrides |
| 10 | `deal_memberships` gains department wall trigger | Blocks research/trading users from holding deal memberships |
| 11 | `ndas` table added | Directional, lifecycle-tracked; distinct from generic documents; gates buyer phase promotion |
| 12 | `deal_expenses` table added | Storm: all costs tie to project code; no cross-deal expense pollution |
| 13 | `users.department` column added | Internal Chinese wall (IB vs. research/trading) is firm-level, not deal-level |
| 14 | `compliance_events` promoted to first-class table | Screening is the moat, not a generic log action |
| 15 | `compliance_events.verdict` three-state (`compliant\|hold\|blocked`) | ADR-0003 alignment; replaces binary `clear\|blocked` |
| 16 | `audit_log.action` drops `'route'` | Routing is a screening event in `compliance_events` |
| 17 | `notifications` table added | Compliance alerts were ad-hoc and forgotten; systematic spine for proactive compliance |
| 18 | Access matrix expanded with `legal` column + NDA, expense, notification rows | External parties and new roles were absent from the v1/v2 matrix |
