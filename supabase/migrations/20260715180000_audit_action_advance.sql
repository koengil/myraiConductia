-- supabase/migrations/20260715180000_audit_action_advance.sql
-- G15 (Issue #80): the rail now persists position server-side (deals.current_step_seq
-- via PATCH /api/v1/deals/{id}/progress). Each advance/regress is a deal-state
-- change and must be audited on its own action rather than overloading 'grant'.
--
-- Template: the drop-and-re-add CHECK from 20260714160000_audit_action_create_notify.sql.
-- Idempotent; existing audit rows are unaffected.

-- REPLAY NOTE: later migrations widen this CHECK further and a lived-in
-- database already holds rows with those actions, so on re-run this re-add
-- must not validate existing rows (`not valid`) — the newest widening
-- migration re-adds the full, validated constraint.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated','invite_verification_succeeded','invite_verification_locked','mfa_enrolled','mfa_challenged'
  ))
  not valid;
