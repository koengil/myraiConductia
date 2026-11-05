-- Preferred deal role (#160 Phase A, spec 2026-08-14-company-admin-directory-design).
-- A company-managed preference that prefills future deal assignment. It grants
-- nothing, never creates or modifies a deal membership, and administrators
-- still confirm the role when adding the person to a deal.
-- Company-defined roles CRUD is deliberately deferred; the platform `roles`
-- enum stays closed. This allowlist is the source of truth mirrored by
-- INTERNAL_ASSIGNABLE_DEAL_ROLES in src/lib/constants/roles.ts.
alter table users
  add column preferred_deal_role text null references roles(slug);

alter table users
  add constraint users_preferred_deal_role_internal_check
  check (
    preferred_deal_role is null
    or preferred_deal_role in ('deal_team', 'legal', 'read_only')
  );
