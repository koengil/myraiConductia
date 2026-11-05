-- Migration: feature_flags write policy (#26 / D34, revises ADR-0007 D27)
-- Restrict feature-flag writes to admin/cco. Feature-flag changes are an
-- INTERNAL/dev config concern, NOT a business event, so they are intentionally
-- NOT written to the business audit_log. This migration also reverts an earlier
-- experiment that routed flag toggles into audit_log.

-- Revert the flag-audit experiment (no-ops if it was never applied).
drop trigger if exists feature_flags_audit on feature_flags;
drop function if exists audit_feature_flag_change();

-- Restore the business audit_log to its permissions-schema shape: actor_id is
-- required, and the action enum carries no config value (config is not business
-- audit). Safe — no config_change / null-actor rows were ever committed.
-- REPLAY NOTE: later migrations widen this CHECK (hold/create/notify/advance/
-- attest) and a lived-in database already holds rows with those actions, so on
-- re-run this narrow re-add must not validate existing rows (`not valid`) — the
-- later widening migrations re-add the full, validated constraint. The same
-- replay problem hits the NOT NULL just below: later, legitimate work
-- (skill_publication.transition, skill_authoring.attempt_transitioned,
-- rail.step_rebound, skill_authoring.candidate_selected) writes null-actor
-- audit rows, and a later migration drops this same NOT NULL again, so the
-- final schema is identical whether it applies here or is skipped. Take it
-- only when no null actor_id rows exist yet; a fresh database always
-- qualifies, and a lived-in one simply defers to the later migration that
-- already relaxes it.
do $$
begin
  if not exists (select 1 from audit_log where actor_id is null) then
    alter table audit_log alter column actor_id set not null;
  end if;
end;
$$;
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in ('view', 'download', 'upload', 'export', 'grant', 'revoke',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated','invite_verification_succeeded','invite_verification_locked','mfa_enrolled','mfa_challenged'
  ))
  not valid;

-- Writes (and management reads) of feature flags restricted to admin/cco; the
-- app's flag-evaluation read path stays server-side via the service role, which
-- bypasses RLS.
grant select, insert, update, delete on feature_flags to authenticated;
drop policy if exists feature_flags_write on feature_flags;
create policy feature_flags_write on feature_flags for all to authenticated
  using (exists (select 1 from users u where u.id = auth.uid() and u.firm_role in ('cco', 'admin')))
  with check (exists (select 1 from users u where u.id = auth.uid() and u.firm_role in ('cco', 'admin')));
