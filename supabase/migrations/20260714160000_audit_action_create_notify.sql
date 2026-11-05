-- supabase/migrations/20260714160000_audit_action_create_notify.sql
-- G4 (Issue #70, Epic: Gate 0 fixture → real): widen the audit_log action enum
-- with 'create' and 'notify' for the transactional Gate 0 create (G5): the RPC
-- writes a 'create' row for the deal and a 'notify' row per notified recipient.
--
-- Template: 20260629120000_legal_hold.sql (drop-and-re-add CHECK). Idempotent:
-- the constraint is dropped-if-exists and re-added with the full value set, so
-- re-running is safe and existing audit rows are unaffected.

-- REPLAY NOTE: later migrations widen this CHECK further and a lived-in
-- database already holds rows with those actions, so on re-run this re-add
-- must not validate existing rows (`not valid`) — the newest widening
-- migration re-adds the full, validated constraint.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated','invite_verification_succeeded','invite_verification_locked','mfa_enrolled','mfa_challenged'
  ))
  not valid;
