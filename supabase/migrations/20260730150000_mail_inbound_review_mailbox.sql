-- supabase/migrations/20260730150000_mail_inbound_review_mailbox.sql
-- Mail client completion (PR #122 scope, 2026-07-30): the receive side, the
-- supervisory review actions, and the per-user mailbox connection.
-- Additive + idempotent; safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) INBOUND MESSAGES — mail received by the platform channel (provider
--    inbound webhook). deal_id stays null until the per-project address
--    scheme is ratified; resolution then maps to_email -> deal.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists inbound_messages (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  deal_id              uuid references deals (id),
  from_email           text not null,
  to_email             text not null,
  cc_emails            text[] not null default '{}',
  subject              text not null default '',
  body                 text not null default '',
  body_html            text,
  attachments          jsonb not null default '[]',
  provider             text,
  provider_message_id  text,
  received_at          timestamptz not null default now(),
  read_at              timestamptz
);

create index if not exists inbound_messages_tenant_received
  on inbound_messages (tenant_id, received_at desc);

-- RLS: service-role only — reads go through /api/v1 with the bank-side
-- app-layer predicate (external users never see the firm inbox).
alter table inbound_messages enable row level security;
grant select, insert, update, delete on inbound_messages to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) SUPERVISORY REVIEW — a held message can be released (sent by the
--    reviewer) or rejected (returned to the sender with a note).
-- ─────────────────────────────────────────────────────────────────────────────
alter table outbound_messages
  add column if not exists reviewed_by  uuid references users (id),
  add column if not exists reviewed_at  timestamptz,
  add column if not exists review_note  text;

alter table outbound_messages drop constraint if exists outbound_messages_status_check;
alter table outbound_messages add constraint outbound_messages_status_check
  check (status in ('sent','held','blocked','rejected'));

-- Audit actions for the review verbs (template: prior CHECK widenings).
-- NOT VALID for the same replay-safety reason as 20260729130000: the shared
-- dev database already carries actions from work merged after this file
-- (invite_*), and a validated re-add would abort mid-chain. New inserts are
-- still enforced; the newest widening owns the validated superset.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance','attest',
    'screen','send','release','reject',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated','invite_verification_succeeded','invite_verification_locked','mfa_enrolled','mfa_challenged'
  )) not valid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) MAILBOX CONNECTIONS — "Connect your mailbox" (Microsoft Graph OAuth).
--    Tokens are stored ENCRYPTED (AES-256-GCM, key = MAILBOX_TOKEN_KEY env),
--    never in plaintext. One connection per user.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists mailbox_connections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references users (id),
  provider          text not null check (provider in ('microsoft')),
  email             text not null,
  tokens_encrypted  text not null,
  scopes            text,
  connected_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table mailbox_connections enable row level security;
grant select, insert, update, delete on mailbox_connections to service_role;
