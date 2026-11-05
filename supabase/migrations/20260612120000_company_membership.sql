-- Migration: company membership (D33 / 2026-06-07 sync)
-- Adds the company-level role axis. Under "1 email = 1 account", a user belongs
-- to exactly one company (their employer/affiliation within the tenant) and is
-- either a 'director' (administers that company's members) or a 'member'.
--
-- This axis is DISTINCT from:
--   - deal_role ('md','deal_team',...) — authority on a specific deal
--   - firm_role ('cco','admin')        — platform-wide elevated roles
--
-- A company "has members" iff any users.company_id points at it; the
-- ">= 1 director per company that has members" invariant (S4) is
-- conditioned on that, so referenced-only deal parties (e.g. a target with no
-- accounts) need no director. The invariant trigger ships in a follow-up.

alter table users add column if not exists company_id uuid references companies (id);
alter table users add column if not exists company_role text
  check (company_role in ('director', 'member'));

create index if not exists users_company_id_idx on users (company_id);

-- A company_role only makes sense for a user attached to a company.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_company_role_requires_company'
  ) then
    alter table users
      add constraint users_company_role_requires_company
      check (company_role is null or company_id is not null);
  end if;
end;
$$;
