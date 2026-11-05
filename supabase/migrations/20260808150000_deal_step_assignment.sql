-- Deal step assignment, manual work capture, and step-scoped notifications.

alter table deal_steps
  add column if not exists assigned_to uuid references users (id),
  add column if not exists assigned_by uuid references users (id),
  add column if not exists assigned_at timestamptz,
  add column if not exists completed_by uuid references users (id),
  add column if not exists completed_at timestamptz,
  add column if not exists completion_note text,
  add column if not exists work jsonb not null default '{}'::jsonb;

-- Widen notification event types.
alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed'
  ))
  not valid;

-- Widen audit actions for step lifecycle.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance','attest',
    'screen','send','release','invite_sent','invite_accepted','invite_revoked','reject',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated',
    'invite_verification_succeeded','invite_verification_locked',
    'mfa_enrolled','mfa_challenged',
    'assign_step','complete_step','step_work'
  ))
  not valid;
