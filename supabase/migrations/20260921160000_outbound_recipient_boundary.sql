-- Q3 / #171: send-time boundary, independent of risk and working-group membership.
-- Historical messages remain NULL; never infer yesterday's boundary from today's domains.
alter table public.outbound_messages add column if not exists recipient_boundary text;
alter table public.outbound_messages drop constraint if exists outbound_messages_recipient_boundary_check;
alter table public.outbound_messages add constraint outbound_messages_recipient_boundary_check
  check (recipient_boundary in ('internal', 'external', 'unverified'));
