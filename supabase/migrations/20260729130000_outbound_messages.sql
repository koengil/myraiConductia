-- supabase/migrations/20260729130000_outbound_messages.sql
-- Compliance email client (pre-send screening, 2026-07-28 roadmap): the
-- outbound comms record + supervisory hold queue, and the audit actions the
-- screening service writes.
--
-- Retention rationale: an email sent through the platform is a business
-- communication — a required record under SEC 17a-4 / FINRA 4511 (audit-trail
-- alternative, Release 34-96034). A HELD message must be readable by the
-- supervisor to review it, so the full message is stored here; audit_log keeps
-- only the event + a content hash. Storm (2026-07-24, #external-conductia):
-- comms through the platform are stored on our system with the audit records.
--
-- Idempotent: create-if-not-exists / drop-and-re-add, safe to re-run.

-- Widen the audit action CHECK with the two screening events:
--   'screen' — a full-mode pre-send screen ran (verdict in detail).
--   'send'   — a compliant message left via the email provider.
-- Template: 20260714160000_audit_action_create_notify.sql.
-- NOT VALID: a mid-chain re-add must never validate existing rows — a database
-- that already carries LATER actions (release/reject here, or actions from
-- migrations merged after this file) would abort the replay on validation.
-- New inserts are still enforced; the newest widening in the chain owns the
-- validated superset.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance','attest',
    'screen','send',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated','invite_verification_succeeded','invite_verification_locked','mfa_enrolled','mfa_challenged'
  )) not valid;

-- ─────────────────────────────────────────────────────────────────────────────
-- OUTBOUND MESSAGES — every send attempt through the platform channel, with
-- the screening verdict that decided its fate.
--   status 'sent'    — verdict compliant; handed to the email provider.
--   status 'held'    — verdict hold (MNPI signal); the supervisory review
--                      queue. Never delivered until released (release flow is
--                      a later slice).
--   status 'blocked' — verdict blocked (promissory language); never left,
--                      recorded as evidence the control fired.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists outbound_messages (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  deal_id              uuid references deals (id),
  sender_id            uuid not null references users (id),
  to_emails            text[] not null,
  subject              text not null,
  body                 text not null,
  verdict              text not null check (verdict in ('compliant','hold','blocked')),
  reasons              jsonb not null default '[]',
  rewrite              text,
  -- Whether the LLM escalation layer ran. The deterministic screen is the
  -- control (never an LLM); false records visible degradation, not failure.
  llm_checked          boolean not null default false,
  status               text not null check (status in ('sent','held','blocked')),
  provider             text,
  provider_message_id  text,
  created_at           timestamptz not null default now()
);

-- The supervisory queue scan (CCO view) and the sender's own outbox.
create index if not exists outbound_messages_held_queue
  on outbound_messages (tenant_id, created_at desc)
  where status = 'held';
create index if not exists outbound_messages_sender_idx
  on outbound_messages (sender_id, created_at desc);

-- RLS: writes are service-role-only (the /api/v1 layer mutates through the
-- service key); a sender may read their own messages. Supervisory tenant-wide
-- reads go through the service role with the app-layer overseer predicate,
-- matching the notifications pattern (#22 / D33). No update/delete grants to
-- authenticated — the record is retention data.
alter table outbound_messages enable row level security;

grant select, insert, update, delete on outbound_messages to service_role;
grant select on outbound_messages to authenticated;

drop policy if exists outbound_messages_select on outbound_messages;
create policy outbound_messages_select on outbound_messages for select to authenticated
  using (sender_id = auth.uid());
