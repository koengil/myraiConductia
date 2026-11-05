-- supabase/migrations/20261002175000_google_reader_registrations.sql
-- Gmail reader (#259), phase 1: one Google Workspace reader registration per
-- firm tenant (schema option (a), a sibling of graph_reader_registrations).
-- It names who may sign (the DWD service account, by email) and never holds
-- key material: the worker signs through IAM Credentials signJwt (R5, R14).
-- The firm is validated at read time by reader_firm_company_ids, as #262 does
-- for Graph (coordination C5); phase 2 adds the google branch there.
create table if not exists google_reader_registrations (
  tenant_id                       uuid primary key,
  workspace_domain                text not null
                                  check (workspace_domain = lower(workspace_domain)
                                         and workspace_domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  service_account_email           text not null
                                  check (service_account_email ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$'),
  client_id                       text not null check (client_id ~ '^[0-9]{10,30}$'),
  directory_service_account_email text not null
                                  check (directory_service_account_email ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$'),
  allowlist_group                 text not null check (allowlist_group = lower(allowlist_group)),
  firm_company_id                 uuid references companies (id),
  status                          text not null default 'pending'
                                  check (status in ('pending', 'active', 'disabled')),
  consented_at                    timestamptz,
  created_at                      timestamptz not null default now(),
  -- The account that reads mail never produces the evidence that audits it (R14).
  constraint google_reader_registrations_split_identities
    check (directory_service_account_email <> service_account_email),
  constraint google_reader_registrations_group_in_domain
    check (split_part(allowlist_group, '@', 2) = workspace_domain),
  constraint google_reader_registrations_active_needs_consent
    check (status <> 'active' or consented_at is not null)
);

alter table google_reader_registrations enable row level security;
-- No user policy: the worker and operator scripts use the service role only.
revoke all on google_reader_registrations from public, anon, authenticated;
grant select, insert, update, delete on google_reader_registrations to service_role;
