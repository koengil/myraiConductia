-- Access requests: a company member can ask an organization administrator
-- for a permission-gated destination (Leads, My organization). One pending
-- request per (company, requester, destination). Service-role writes; the
-- API layer is the wall.

create table if not exists access_requests (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies (id),
  requester_id   uuid not null references users (id),
  destination    text not null check (destination in ('leads', 'organization')),
  permission_key text not null,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by     uuid references users (id),
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);

create unique index if not exists access_requests_one_pending
  on access_requests (company_id, requester_id, destination)
  where status = 'pending';

create index if not exists access_requests_company_pending
  on access_requests (company_id, created_at desc)
  where status = 'pending';

create index if not exists access_requests_requester
  on access_requests (requester_id, created_at desc);

alter table access_requests enable row level security;

grant select, insert, update, delete on access_requests to service_role;

-- Widen notification event types for the request / decision fan-out.
alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed',
    'access_requested','access_approved','access_denied'
  ))
  not valid;
