# Permissions Schema — v3

**Status:** Superseded by [`permissions_schema_v3-full.md`](permissions_schema_v3-full.md); the migrations under `supabase/migrations/` are the source of truth. Originally: Draft — incremental patch on v2. Adds six missing constructs surfaced by the 2026-05-28 kickoff call (Storm Duncan, Roberto, Marcelo).  
**Source:** `permissions_schema_v2.md` is the base. This file documents only what changed and why.  
**Target platform:** Supabase / Postgres.

---

## What changed and why

| # | Construct | v2 state | v3 change | Why |
|---|---|---|---|---|
| 1 | `legal` role | Missing from roles slug enum | Added | Storm called out legal as a distinct user type — NDA + engagement letter management |
| 2 | `deal_expenses` | No table | Added | Storm: "all your expenses will stem from that project" — costs must be tied to a deal code and kept from cross-pollinating |
| 3 | `deal_parties` | Open item §4.3 | Added | Resolves two things: multi-company-per-deal support and the conflict-check query |
| 4 | `ndas` | Not modelled | Added | Separate from generic documents — two-directional (bank→client, client→bank), needs signature status lifecycle |
| 5 | `users.department` | Missing | Added column | Internal Chinese wall: IB vs. research/trading is a firm-level wall, not a deal-level wall |
| 6 | `notifications` | Not modelled | Added | Compliance alerts on new deals were "currently often forgotten" — needs a system-generated event spine |

---

## 1. `legal` role — roles table patch

```sql
-- Add 'legal' to the slug check constraint.
-- Legal: deal-scoped. Can read class 1–3 documents and upload/manage NDAs
-- and engagement letters. No access to acquirer scoring, MNPI docs, or
-- compliance event payloads.
--
-- Updated slug enum:
--   'md' | 'deal_team' | 'legal' | 'cco' | 'seller' | 'buyer' | 'read_only' | 'admin'

alter table roles drop constraint roles_slug_check;
alter table roles add constraint roles_slug_check
  check (slug in ('md','deal_team','legal','cco','seller','buyer','read_only','admin'));

-- Seed row:
insert into roles (slug, label, permissions) values
  ('legal', 'Legal Counsel', '["nda:manage","engagement_letter:manage","document:read:class1-3"]');
```

**Access matrix row for `legal`:**

| Resource | Legal |
|---|---|
| Mandate brief | ✅ Read |
| Acquirer ranked table | ❌ |
| Deep-dive canvas | ❌ |
| Deal team chat threads | ✅ Own thread only |
| Compliance event feed | ❌ (no payload access) |
| NDAs | ✅ Full (upload, track, countersign) |
| Engagement letters | ✅ Full |
| Documents class 1–3 | ✅ Read |
| Documents class 4 / MNPI | ❌ |

---

## 2. `deal_expenses` — new table

```sql
-- Every expense is anchored to a deal via its project code.
-- This enforces Storm's requirement: "make sure you're not cross-pollinating expenses."
--
-- category: the chart-of-accounts bucket for reporting.
-- approved_by: nullable — some expense types (e.g. travel under threshold) are
--   self-approving; others require MD sign-off. RLS enforces who can approve.
-- external_ref: wire ref, invoice number, or card transaction ID for reconciliation.

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

-- RLS: a user can see expenses on deals they are a member of.
-- Only MD and admin can see all expenses on a deal; deal_team sees own only.
create policy expense_visibility on deal_expenses for select using (
  exists (
    select 1 from deal_memberships m
    where m.deal_id = deal_expenses.deal_id
      and m.user_id = auth.uid()
  )
);
```

**Key invariant:** `deal_id` is non-nullable and non-overridable — there is no concept of a firm-level expense outside a deal context. If pre-deal costs exist (pitch preparation), they are logged against a deal at `status = 'intake'`.

---

## 3. `deal_parties` — new join table (replaces `deals.target_company_id`)

```sql
-- v2 had a single target_company_id FK on deals.
-- This table replaces it, supporting:
--   a) multiple companies per deal (e.g. target + co-seller + counterparty)
--   b) conflict detection: query for any company appearing as 'target' or
--      'acquirer_shortlist' across active deals before creating a new mandate.
--
-- party_role is distinct from deal_memberships.deal_role:
--   deal_memberships = people; deal_parties = companies.

create table deal_parties (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references deals(id),
  company_id   uuid not null references companies(id),
  party_role   text not null check (party_role in (
                 'target','co_seller','acquirer_shortlist','counterparty'
               )),
  added_at     timestamptz not null default now(),
  unique (deal_id, company_id, party_role)
);

-- Conflict-check query (run before creating a new deal):
-- Returns any active deal that already involves the company being onboarded.
--
-- select d.id, d.code, d.codename, dp.party_role
-- from deal_parties dp
-- join deals d on d.id = dp.deal_id
-- where dp.company_id = :incoming_company_id
--   and d.status in ('intake','active')
--   and d.tenant_id = :tenant_id;

-- Migration: populate deal_parties from existing deals.target_company_id,
-- then drop the column.
insert into deal_parties (deal_id, company_id, party_role)
  select id, target_company_id, 'target'
  from deals
  where target_company_id is not null;

alter table deals drop column target_company_id;
```

---

## 4. `ndas` — new table

```sql
-- NDAs are directional and have a lifecycle distinct from generic documents.
-- Storm: NDAs run both ways — bank signs one before receiving confidential info;
-- client signs one before seeing the data room.
--
-- direction:
--   'bank_to_client'  — firm signs NDA before receiving client confidential info
--   'client_to_bank'  — counterparty/buyer signs before accessing data room
--
-- status lifecycle:
--   draft → sent → countersigned → active → expired | terminated

create table ndas (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references deals(id),
  counterparty_id uuid not null references companies(id),
  direction       text not null check (direction in ('bank_to_client','client_to_bank')),
  status          text not null default 'draft'
                  check (status in ('draft','sent','countersigned','active','expired','terminated')),
  document_id     uuid references documents(id),   -- the actual NDA file
  sent_at         timestamptz,
  signed_at       timestamptz,
  expires_at      timestamptz,
  managed_by      uuid references users(id),       -- legal role user who owns this NDA
  created_at      timestamptz not null default now()
);

-- A buyer cannot be promoted past phase 0 (teaser) until an active NDA exists.
-- Enforced at the application layer; the RLS sketch below supports the check:
--
-- create policy nda_gate on deal_memberships for update using (
--   -- only allow phase increment for buyers if a countersigned NDA exists
--   case when new.deal_role = 'buyer' and new.phase > 0 then
--     exists (
--       select 1 from ndas n
--       join companies c on c.id = n.counterparty_id
--       join users u on u.id = auth.uid()
--       where n.deal_id = deal_memberships.deal_id
--         and n.status = 'active'
--     )
--   else true end
-- );
```

---

## 5. `users.department` — new column

```sql
-- Enforces the internal Chinese wall between IB and research/trading.
-- This is a firm-level wall, not a deal-level wall — it applies regardless
-- of deal membership. A research analyst with no deal memberships still
-- must not see IB deal data, and vice versa.
--
-- 'ib'         — Investment Banking (can hold deal memberships)
-- 'research'   — Equity Research (no deal memberships permitted)
-- 'trading'    — Trading desk (no deal memberships permitted)
-- 'compliance' — Compliance / CCO staff
-- 'legal'      — Legal department
-- 'admin'      — Platform administration
-- null         — external users (is_external = true)

alter table users add column department text
  check (department in ('ib','research','trading','compliance','legal','admin'));

-- RLS enforcement: users in research or trading cannot hold deal memberships.
-- (Enforced by application layer on insert; belt-and-suspenders constraint below.)
alter table deal_memberships add constraint no_wall_breach
  check (
    -- verified via trigger; constraint here is documentation
    true  -- replace with trigger: reject if users.department in ('research','trading')
  );
```

**Note:** The actual wall-breach check requires a trigger (can't reference another table in a CHECK constraint in Postgres). The trigger should run on `deal_memberships` insert/update and reject if `users.department in ('research','trading')`.

---

## 6. `notifications` — new table

```sql
-- System-generated alerts. Storm: compliance notifications for new deals are
-- "currently often forgotten" — this table is the spine for proactive compliance.
--
-- event_type covers the known mandatory notification points:
--   'deal_created'       — CCO must be notified immediately on any new mandate
--   'compliance_hold'    — a message hit 'hold' verdict; CCO action required
--   'nda_pending'        — NDA sent; awaiting countersignature
--   'nda_signed'         — NDA countersigned; buyer can be promoted
--   'phase_promoted'     — buyer phase incremented; CCO informed
--   'expense_approved'   — MD approved an expense
--   'member_added'       — someone added to deal team
--
-- recipient_id: the specific user who should receive this notification.
--   For CCO-mandatory events (deal_created, compliance_hold), a row is
--   created for every user with firm_role = 'cco' in the tenant.
--
-- read_at: null = unread. The UI badge count is count(*) where read_at is null.

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  deal_id      uuid references deals(id),
  recipient_id uuid not null references users(id),
  event_type   text not null check (event_type in (
                 'deal_created','compliance_hold','nda_pending','nda_signed',
                 'phase_promoted','expense_approved','member_added'
               )),
  payload      jsonb not null default '{}',   -- context: deal code, actor name, etc.
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index notifications_recipient_unread
  on notifications (recipient_id, created_at desc)
  where read_at is null;

-- RLS: users see only their own notifications.
create policy notification_visibility on notifications for select using (
  recipient_id = auth.uid()
);
```

---

## 7. Open items (updated from v2 §4)

| # | Item | Status |
|---|---|---|
| 1 | MD scope — deal-scoped vs firm-wide read | Still open |
| 2 | Buyer phase ladder — stage names for `phase` integer | Still open. Proposed: `0=teaser, 1=nda_signed, 2=preliminary_data_room, 3=confirmatory` |
| 3 | ~~Companies per deal — `deal_parties` join table~~ | ✅ Resolved — `deal_parties` added in v3 |
| 4 | Classification vs. visibility for class 4 / MNPI | Still open |
| 5 | Expense approval thresholds — which categories require MD sign-off vs. self-approve | New. Needs Storm input |
| 6 | NDA expiry policy — auto-terminate on deal close, or require explicit termination | New |
| 7 | Department wall trigger implementation — research/trading rejection on membership insert | New. Backend task, Week 1 |

---

## 8. Change log (v2 → v3)

| # | What changed | Why |
|---|---|---|
| 1 | `legal` added to roles slug enum + access matrix row | Distinct user type from kickoff call; NDA + engagement letter management |
| 2 | `deal_expenses` table added | Storm: all costs tie to the project code; no cross-deal expense pollution |
| 3 | `deal_parties` replaces `deals.target_company_id` | Multi-company support + conflict-check query |
| 4 | `ndas` table added | Directional, lifecycle-tracked; distinct from generic documents |
| 5 | `users.department` column added | Internal Chinese wall (IB vs. research/trading) is firm-level, not deal-level |
| 6 | `notifications` table added | Compliance alerts were ad-hoc and forgotten; needs a systematic spine |
