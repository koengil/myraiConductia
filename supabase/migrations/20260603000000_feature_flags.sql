-- Migration: feature_flags  (ADR-0007 / decision-log D27)
-- The first real backend slice: dynamic, DB-backed feature flags.
-- Apply order: Conductia-dev (lknjzkvvhmqdmhdnnmwb) first, then staging, then prod.

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- `key` matches the FlagKey union in src/lib/flags/keys.ts (code is the source of
-- truth for which flags exist; the seed materialises the registry into this table).
-- The row owns the runtime ENABLED state; the registry owns EXISTENCE + metadata.
create table if not exists feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid          -- references users(id) once the permissions schema is migrated
);

-- Keep updated_at honest on every change.
create or replace function set_feature_flags_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists feature_flags_set_updated_at on feature_flags;
create trigger feature_flags_set_updated_at
  before update on feature_flags
  for each row execute function set_feature_flags_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — locked down (service-role only)
-- ─────────────────────────────────────────────────────────────────────────────
-- With RLS enabled and NO permissive policy, only the service_role (server-side,
-- bypasses RLS) can read or write. This matches ADR-0007 Option 2: server-side
-- evaluation + hydration, no anon-key client reads. The broad-read and the
-- admin/cco write policies are deferred below until the permissions schema lands.
alter table feature_flags enable row level security;

-- Grant table access to the API role behind the Supabase Secret key (service_role,
-- which bypasses RLS). Required because this table is created via a direct psql
-- connection (owner = postgres); PostgREST roles get no automatic privileges that
-- way. This is the server-side access path for reads + the seed (ADR-0007 Option 2).
grant select, insert, update, delete on feature_flags to service_role;

-- ── Write access (admin/cco) — see follow-up migration ──────────────────────
-- The admin/cco write RLS policy references users.firm_role, which does not
-- exist until the permissions schema is migrated; it is added in
-- 20260612160000_feature_flags_write_policy.sql.
--
-- NOTE: feature-flag changes are an internal/dev config concern, NOT a business
-- event, so they are intentionally NOT written to the business audit_log
-- (D34, revising ADR-0007 D27). The control on who can toggle is the write RLS
-- policy, not an audit trail.
