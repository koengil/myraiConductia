-- supabase/migrations/20260731120000_onboarding_invites.sql
-- Onboarding (spec: docs/agent-duo/runs/onboarding/spec-v3.md, plan v5).
-- Invite lifecycle for bank-internal colleagues and external buyer/seller
-- teams, plus the document "room" split (internal bank room vs deal room)
-- and storage columns for the data-room seam.
--
-- INVITE STATE MACHINE (source of truth):
--   pending  -> accepted  (accept_invite RPC, conditional single-winner)
--   pending  -> revoked   (revoke_invite RPC, conditional)
--   pending  -> expired   (lazy locked transition inside create/resend/accept)
-- Terminal states (accepted|revoked|expired) never revive. "Resend" of a
-- terminal invite = a fresh row (the partial unique index only blocks
-- 'pending'). Resend of a 'pending' invite rotates credential_nonce and
-- extends expires_at, killing previously mailed links.
--
-- delivery_status is the truthful-delivery state: 'sent' only after the
-- credential email was handed to the provider; the invite_sent audit event
-- is written exactly on the unsent->sent transition (see invite RPCs
-- migration). Acceptance requires delivery_status='sent'.

-- ─────────────────────────────────────────────────────────────────────────────
-- INVITES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists invites (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  email             text not null check (email = lower(email)),
  invited_by        uuid not null references users (id),
  company_id        uuid not null references companies (id),
  company_role      text not null check (company_role in ('director','member')),
  -- Nullable pair: an invite either carries a deal grant or it does not.
  deal_id           uuid references deals (id) on delete cascade,
  deal_role         text check (deal_role in
                      ('md','deal_team','legal','seller','buyer','read_only')),
  status            text not null default 'pending'
                    check (status in ('pending','accepted','revoked','expired')),
  delivery_status   text not null default 'unsent'
                    check (delivery_status in ('unsent','sent')),
  credential_nonce  uuid not null default gen_random_uuid(),
  expires_at        timestamptz not null default now() + interval '7 days',
  accepted_at       timestamptz,
  accepted_user_id  uuid references users (id),
  created_at        timestamptz not null default now(),
  constraint invites_deal_pair_check check ((deal_id is null) = (deal_role is null))
);

-- GLOBAL, not tenant-scoped: one email means one account (users.email is
-- globally unique), so at most one live pending invite may exist per email
-- anywhere. Tenant coherence is enforced at acceptance (accept_invite RPC).
create unique index if not exists invites_pending_email_uniq
  on invites (email) where status = 'pending';

create index if not exists invites_company_id_idx on invites (company_id);
create index if not exists invites_deal_id_idx on invites (deal_id);

-- 2026-08-01 repair: the table shipped without grants, so the API's admin
-- client got "permission denied for table invites" on direct reads (the RPCs
-- are security definer and masked it). Only the service role touches invites
-- directly; RLS stays enabled with no policies, so anon/authenticated cannot
-- read invitation rows through PostgREST at all.
alter table invites enable row level security;
grant select, insert, update, delete on invites to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- USERS: 'invited' containment status
-- ─────────────────────────────────────────────────────────────────────────────
-- 'invited' = auth identity exists (created at link generation) but the invite
-- was not yet accepted. Set by a server-owned service-role update in the
-- invite create route (NOT by the handle_new_auth_user trigger, which this
-- migration deliberately does not touch — the trigger is frozen per
-- ADR-0008/brief). userIsOnboarded() keys on status <> 'invited'.
alter table users drop constraint if exists users_status_check;
alter table users add constraint users_status_check
  check (status in ('active','suspended','invited'));

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT: invite lifecycle actions
-- ─────────────────────────────────────────────────────────────────────────────
-- Newest widening of the CHECK re-adds the full, validated constraint
-- (template: 20260721120000_conflicts_attestation.sql).
-- 2026-09-14 replay repair: skill authoring/publication and rail actions
-- landed on later migrations without ever widening this list, so a lived-in
-- database that already holds those rows fails this validated re-add. `not
-- valid` here for the same reason as 20260612160000: the later, wider
-- migrations re-add the full, validated constraint.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance','attest',
    -- legacy orchestration-spine actions present in live audit rows (the
    -- 20260721 validated re-add could not have held with these on the books;
    -- the CHECK is widened to match reality rather than re-added `not valid`)
    'screen','send','release',
    'invite_sent','invite_accepted','invite_revoked',
    -- Reserved by the compliance email channel (PR #122, supervisor reject of a
    -- held message) so the final CHECK permits its inserts regardless of merge order.
    'reject',
    -- 20260804160000 (invite safeguards + platform 2FA) actions, mirrored so
    -- every validated re-add in the chain holds against live audit rows.
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated',
    'invite_verification_succeeded','invite_verification_locked',
    'mfa_enrolled','mfa_challenged'
  )) not valid;

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENTS: room split + storage columns (staged, fail-closed)
-- ─────────────────────────────────────────────────────────────────────────────
-- Stage 1: nullable column, NO default (a default of 'deal' would silently
-- expose legacy rows to external users).
alter table documents add column if not exists room text;

-- Stage 2: backfill every legacy row to 'internal' — fail-closed: nothing
-- that predates the room split is ever externally visible.
update documents set room = 'internal' where room is null;

-- Stage 3: verify, then lock.
do $$
declare n bigint;
begin
  select count(*) into n from documents where room is null;
  if n > 0 then
    raise exception 'documents.room backfill incomplete: % null rows', n;
  end if;
end $$;

alter table documents alter column room set not null;
alter table documents drop constraint if exists documents_room_check;
alter table documents add constraint documents_room_check
  check (room in ('internal','deal'));

-- Storage seam columns (nullable: legacy fixture rows have no stored bytes).
alter table documents add column if not exists storage_provider text;
alter table documents add column if not exists storage_file_id text;
alter table documents add column if not exists size_bytes bigint;
alter table documents add column if not exists content_type text;
