-- supabase/migrations/20260714161000_notifications.sql
-- G3 (Issue #69, Epic: Gate 0 fixture → real): the system-generated notification
-- spine. Storm: compliance notifications for new deals are "currently often
-- forgotten" — this table is the proactive spine. Implemented per
-- docs/03-engineering/permissions_schema_v3.md §6.
--
-- First event type used in production: 'deal_created' (create_deal_gate0, G5,
-- fans out one row per tenant CCO). Idempotent: create ... if not exists /
-- drop-and-re-add policy, so re-running is safe.
--
-- COMPLIANCE: payload carries the deal CODE and code name only — never the
-- target company name (the mask must hold in every notification).

create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  deal_id      uuid references deals (id),
  recipient_id uuid not null references users (id),
  event_type   text not null check (event_type in (
                 'deal_created','compliance_hold','nda_pending','nda_signed',
                 'phase_promoted','expense_approved','member_added'
               )),
  payload      jsonb not null default '{}',
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

-- The UI badge count is count(*) where read_at is null; index the unread scan.
create index if not exists notifications_recipient_unread
  on notifications (recipient_id, created_at desc)
  where read_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: a user sees ONLY their own notifications. Writes are service-role-only
-- (the /api/v1 layer + the create_deal_gate0 RPC mutate through the service key,
-- which bypasses RLS), matching the read-policy migration (#22 / D33).
-- ─────────────────────────────────────────────────────────────────────────────
alter table notifications enable row level security;

grant select, insert, update, delete on notifications to service_role;
grant select, update on notifications to authenticated;

drop policy if exists notifications_select on notifications;
create policy notifications_select on notifications for select to authenticated
  using (recipient_id = auth.uid());

-- A recipient may mark their own notification read (read_at) via the publishable
-- client if we ever move the PATCH off the service role; scoped to own rows.
drop policy if exists notifications_update on notifications;
create policy notifications_update on notifications for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());
