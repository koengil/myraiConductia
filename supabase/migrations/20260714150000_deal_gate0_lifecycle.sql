-- supabase/migrations/20260714150000_deal_gate0_lifecycle.sql
-- G2 (Issue #68, Epic: Gate 0 fixture → real): give `deals` the Gate 0
-- lifecycle fields the wizard needs, plus a codename-uniqueness guard.
-- Idempotent: safe to re-run (add column if not exists / drop-and-re-add index).
--
-- No CHECK enum is touched here (deals.status is unchanged), so the TS mirror in
-- src/lib/constants/deals.ts and the constants-schema-sync test are unaffected.

-- 1. Lifecycle columns.
--    entry_step_seq   — the canonical step seq (1..65) where the deal ENTERED the
--                       lifecycle (Gate 0 "confirm where the deal is entering").
--    current_step_seq — the rail cursor. Seeded to entry_step_seq at create; the
--                       PATCH progress endpoint (G15) writes it forward. Kept on
--                       `deals` until the deal_steps step-state table (G16) lands.
--    gate0_completed_at — stamped by create_deal_gate0 (G5) when the gate closes.
--    codename_theme   — the wizard theme (birds/football/movies). Free text: the
--                       theme vocabulary lives in TS (src/lib/rail/deals.ts), so
--                       no CHECK enum to keep in sync.
alter table deals add column if not exists entry_step_seq   int not null default 1;
alter table deals add column if not exists current_step_seq int not null default 1;
alter table deals add column if not exists gate0_completed_at timestamptz;
alter table deals add column if not exists codename_theme   text;

-- 2. Codename uniqueness (Q6 default): a code name must be unique per tenant while
--    the deal is live. Closed/paused deals free the name for reuse. Case-insensitive
--    so "Project Falcon" and "project falcon" collide.
drop index if exists deals_codename_unique_active;
create unique index deals_codename_unique_active
  on deals (tenant_id, lower(codename))
  where status in ('intake','active');
