-- Delegated inviting (Aug 4 sync, Roberto): a company director can grant a
-- member the ability to invite into their own company without director rights.
-- Consumed by userCanInvite (src/lib/api/v1/access.ts); toggled via
-- PATCH /api/v1/companies/{companyId}/members/{userId}.
alter table public.users
  add column if not exists can_invite boolean not null default false;
