-- supabase/migrations/20260716170000_companies_name_unique.sql
-- G23 (Issue #103): one company per (tenant, name). The target dedupe was
-- app-layer only (RPC uses lower(name); the seed used an exact match), with no
-- DB invariant — so case variants / pre-dedupe rows could coexist (two
-- "Atlassian" rows seen in dev). Make it a real constraint, case-insensitive to
-- match the RPC's dedupe. Idempotent.
--
-- NOTE: a fresh/production DB is clean, so this applies directly. Any duplicate
-- rows in an existing environment must be merged first (repoint deal_parties /
-- deals.bank_id to the canonical company, delete the dup) or the index build
-- fails — that cleanup is a one-time data step, not part of this migration.

create unique index if not exists companies_tenant_name_unique
  on companies (tenant_id, lower(name));
