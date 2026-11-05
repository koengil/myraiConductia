-- Firm compliance settings (Issue #94 CCO risk thresholds, Issue #95 send friction; D105).
--
-- One row per firm (one tenant per firm), set by the firm's CCO or admin.
-- No row means the shipped defaults, which are exactly the behaviour before
-- this migration: Queued from 70, Sampled from 40, a send the AI pass did not
-- check banded like any other, one-click sends.
--
-- The thresholds are compared with the send-time heat score in
-- riskBandFor(), which then drops the score: the score itself is still never
-- stored (#192). Only the band and these settings are.

create table if not exists firm_compliance_settings (
  tenant_id         uuid primary key,
  -- A compliant send whose heat is at or above this is Queued for the CCO.
  queued_from       smallint not null default 70 check (queued_from between 1 and 100),
  -- At or above this (and below queued_from) it is Sampled.
  sampled_from      smallint not null default 40 check (sampled_from between 1 and 100),
  -- The lowest band for a send the AI pass did not check (timeout, outage):
  -- the rules alone passed it.
  unchecked_floor   text not null default 'routine'
                    check (unchecked_floor in ('routine', 'sampled', 'queued')),
  -- How much a send carries before it leaves: one click, or a confirm step
  -- before any send that reaches outside the firm.
  send_friction     text not null default 'one_click'
                    check (send_friction in ('one_click', 'confirm_external')),
  updated_by        uuid not null references users (id),
  updated_at        timestamptz not null default now(),
  check (sampled_from <= queued_from)
);

alter table firm_compliance_settings enable row level security;
-- No policy: closed to anon and authenticated, grants included (TRUNCATE ignores RLS).
revoke all on table firm_compliance_settings from public, anon, authenticated;
grant select, insert, update, delete on firm_compliance_settings to service_role;

-- A Queued send that went out notifies the firm's CCOs and admins.
-- The CHECK is restated whole; the newest restatement is the one in force.
alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed',
    'access_requested','access_approved','access_denied',
    'mailbox_allowlist_drift',
    'mailbox_connected',
    'rail_template_updated',
    'ai_budget_threshold',
    'work_identity_replaced',
    'mail_queued_for_review'
  ))
  not valid;
