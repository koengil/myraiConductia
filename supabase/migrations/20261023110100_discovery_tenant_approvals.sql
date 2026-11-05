-- supabase/migrations/20261023110100_discovery_tenant_approvals.sql
-- G-01 (#173), slice 2 of 5: the shared per-tenant switch. Inert: the table ships empty and nothing reads it yet.
--
-- One table for every capability an owner can approve for one firm company in one tenant, so the three tasks that
-- need a switch (G-01 team proposals, G-07 milestone rules, G-09 firm-name aliases) cannot drift apart:
--
--   discovery_tenant_approvals (tenant_id, firm_company_id, capability)
--     capability   team_proposals | milestone_rules | firm_name_alias   (a CHECK; src/lib/constants/discovery.ts
--                  mirrors it as TENANT_CAPABILITY and tests/constants-schema-sync.test.ts pins the two together)
--
-- What each capability needs besides its row is the capability's own business: team_proposals also needs a reviewed
-- TS entry (TEAM_PROPOSAL_FIRMS, slice 5) because it sends mail to a model; the other two need only the row.
--
-- Written by reviewed migrations only. DML and TRUNCATE are revoked from every API role (service_role keeps SELECT),
-- the table has RLS on and no policy, and the owner who runs a migration is the only writer. Every change is audited
-- (discovery.tenant_approval_changed {capability, firmCompanyId, on, decisionRef}) in the same statement, by an AFTER
-- trigger. A row is revoked, never deleted: DELETE and TRUNCATE are refused, even for the owner. An update may only
-- revoke a live row once, or approve a revoked row again under a new decision_ref; the key columns are frozen.
-- (A database owner can still disable triggers; that is D75's owner-enforced hosted-database access rule.)
--
--   app_tenant_capability_on(p_tenant, p_firm, p_capability)   the one SQL reader (service_role only)
--
-- audit_log_action_check is restated in full from 20261019100000_team_mailboxes.sql, the newest restatement on
-- develop, plus discovery.tenant_approval_changed. Open pull requests were read too: #352 carries a docs plan whose
-- appended list only repeats rail.template_published (develop has it), and #664 states it adds no audit action, so
-- the list below is a superset of every list in flight. A later slice restates it again (the team pass actions).
--
-- Reverse: drop the triggers, their functions, the table and app_tenant_capability_on. The audit CHECK keeps the new
-- action (a restatement may not drop a value without a deliberate removal marker).

-- ── 1. One new audit action ────────────────────────────────────────────────
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view', 'download', 'upload', 'export', 'grant', 'revoke', 'hold_placed', 'hold_lifted', 'create', 'notify',
  'advance', 'attest', 'screen', 'send', 'release', 'invite_sent', 'invite_accepted', 'invite_revoked', 'reject',
  'invite_domain_override', 'invite_challenge_issued', 'invite_challenge_rotated', 'invite_verification_succeeded',
  'invite_verification_locked', 'mfa_enrolled', 'mfa_challenged', 'assign_step', 'complete_step', 'step_work',
  'update', 'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied',
  'skill_publication.admitted', 'skill_publication.admission_denied', 'skill_publication.duplicate_confirmed',
  'skill_publication.duplicate_declined', 'skill_publication.placement_replaced', 'skill_publication.transition',
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced', 'rail.template_applied',
  'discovery.candidate_proposed', 'discovery.candidate_promoted', 'discovery.correction',
  'discovery.milestone_extracted', 'discovery.stage_assessed', 'discovery.mailbox_consented',
  'discovery.mailbox_consent_withdrawn', 'discovery.mailbox_refused', 'discovery.allowlist_drift',
  'discovery.site_registered', 'discovery.site_unregistered', 'discovery.site_refused',
  'discovery.mailbox_source_archived', 'discovery.mailbox_sources_unified', 'profile_provisioned',
  'identity_provider_configured', 'identity_provider_removed', 'work_identity_released', 'work_identity_connected',
  'discovery.mailbox_access_changed', 'discovery.exclusion_policy_changed', 'rail.template_published',
  'discovery.reader_pass_started', 'discovery.reader_pass_finished', 'discovery.mailbox_purged',
  'discovery.content_collected', 'discovery.group_removal_held', 'discovery.tenant_purged', 'discovery.retention_policy_set',
  'discovery.mailbox_retained',
  'mailbox.connected', 'mailbox.connect_refused', 'mailbox.disconnected', 'mailbox.approval_ended',
  'discovery.team_mailbox_connected', 'discovery.team_mailbox_checked', 'discovery.team_mailbox_member_added',
  'discovery.team_mailbox_member_removed', 'discovery.team_mailbox_disconnected',
  'discovery.tenant_approval_changed'
])) not valid;

-- ── 2. The table ───────────────────────────────────────────────────────────
create table if not exists discovery_tenant_approvals (
  tenant_id        uuid not null,
  firm_company_id  uuid not null references companies (id),
  capability       text not null check (capability in ('team_proposals', 'milestone_rules', 'firm_name_alias')),
  -- The reviewed decision the row records (an owner decision, an issue or a pull request): free text, never mail.
  decision_ref     text not null check (char_length(decision_ref) between 1 and 80),
  approved_at      timestamptz not null default now(),
  revoked_at       timestamptz,
  primary key (tenant_id, firm_company_id, capability)
);
alter table discovery_tenant_approvals enable row level security;
-- No policy: closed to anon and authenticated, grants included (TRUNCATE ignores RLS). Reads only for the worker;
-- every write is a reviewed migration, run by the table's owner.
revoke all on discovery_tenant_approvals from public, anon, authenticated, service_role;
grant select on discovery_tenant_approvals to service_role;

-- ── 3. What a write may do ─────────────────────────────────────────────────
-- BEFORE INSERT OR UPDATE. A new approval is on, names a bank company of its own tenant, and starts now (approved_at
-- is the statement's, never a chosen one). An update either revokes a live row once (and nothing else
-- changes; the revoke time is the statement's, never a chosen one) or approves a revoked row again under a new
-- decision_ref (approved_at restarts). The key columns never change. Anything else, a no-op update included, is
-- refused, so every row change that survives is one the audit trigger below describes.
create or replace function discovery_tenant_approvals_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.revoked_at is not null then
      raise exception 'discovery_tenant_approvals: a new approval is on; revoke it with a later update'
        using errcode = '23000';
    end if;
    -- The firm company must be a bank of this very tenant (the registered_sites check): the foreign key alone would
    -- admit another tenant's company, or a client company, under this tenant's id.
    if not exists (select 1 from companies c
                   where c.id = new.firm_company_id and c.tenant_id = new.tenant_id and c.type = 'bank') then
      raise exception 'discovery_tenant_approvals: the firm company is not a bank of this tenant' using errcode = '23000';
    end if;
    -- An approval starts when it is written, never at a chosen time.
    new.approved_at := now();
    return new;
  end if;
  if (new.tenant_id, new.firm_company_id, new.capability) is distinct from (old.tenant_id, old.firm_company_id, old.capability) then
    raise exception 'discovery_tenant_approvals: the key columns are frozen' using errcode = '23000';
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    if (new.decision_ref, new.approved_at) is distinct from (old.decision_ref, old.approved_at) then
      raise exception 'discovery_tenant_approvals: a revoke changes revoked_at alone' using errcode = '23000';
    end if;
    new.revoked_at := now();
  elsif old.revoked_at is not null and new.revoked_at is null then
    if new.decision_ref is not distinct from old.decision_ref then
      raise exception 'discovery_tenant_approvals: approving again needs a new decision_ref' using errcode = '23000';
    end if;
    new.approved_at := now();
  else
    raise exception 'discovery_tenant_approvals: a row is revoked once, or approved again under a new decision_ref'
      using errcode = '23000';
  end if;
  return new;
end;
$$;
revoke all on function discovery_tenant_approvals_guard() from public, anon, authenticated, service_role;
drop trigger if exists discovery_tenant_approvals_guard on discovery_tenant_approvals;
create trigger discovery_tenant_approvals_guard before insert or update on discovery_tenant_approvals
  for each row execute function discovery_tenant_approvals_guard();

-- AFTER INSERT OR UPDATE: one audit row per change, in the same statement. Ids and a fixed code only: the capability,
-- the firm company, whether it is now on, and the decision reference. A service row names its identity (the audit
-- actor rule), as the retention policy's trigger does.
create or replace function discovery_tenant_approvals_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (new.tenant_id, 'service', 'discovery-tenant-approvals', 'discovery.tenant_approval_changed',
          jsonb_build_object('capability', new.capability, 'firmCompanyId', new.firm_company_id,
                             'on', new.revoked_at is null, 'decisionRef', new.decision_ref));
  return null;
end;
$$;
revoke all on function discovery_tenant_approvals_audit() from public, anon, authenticated, service_role;
drop trigger if exists discovery_tenant_approvals_audit on discovery_tenant_approvals;
create trigger discovery_tenant_approvals_audit after insert or update on discovery_tenant_approvals
  for each row execute function discovery_tenant_approvals_audit();

-- BEFORE DELETE (row) and BEFORE TRUNCATE (statement): a row is revoked, never deleted, even for its owner.
create or replace function discovery_tenant_approvals_refuse_delete()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'discovery_tenant_approvals: approvals are revoked, never deleted' using errcode = '23000';
end;
$$;
revoke all on function discovery_tenant_approvals_refuse_delete() from public, anon, authenticated, service_role;
drop trigger if exists discovery_tenant_approvals_no_delete on discovery_tenant_approvals;
create trigger discovery_tenant_approvals_no_delete before delete on discovery_tenant_approvals
  for each row execute function discovery_tenant_approvals_refuse_delete();
drop trigger if exists discovery_tenant_approvals_no_truncate on discovery_tenant_approvals;
create trigger discovery_tenant_approvals_no_truncate before truncate on discovery_tenant_approvals
  for each statement execute function discovery_tenant_approvals_refuse_delete();

-- ── 4. The one SQL reader ──────────────────────────────────────────────────
-- Whether a tenant's firm company has a capability on right now: a live row for exactly that capability. Another
-- capability's row, another firm's row and a revoked row are all off. G-07 and G-09 call it with their own
-- capability; service_role only (a definer, so it reads a table no API role can).
create or replace function app_tenant_capability_on(p_tenant uuid, p_firm uuid, p_capability text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from discovery_tenant_approvals a
                 where a.tenant_id = p_tenant and a.firm_company_id = p_firm
                   and a.capability = p_capability and a.revoked_at is null);
$$;
revoke all on function app_tenant_capability_on(uuid, uuid, text) from public, anon, authenticated;
grant execute on function app_tenant_capability_on(uuid, uuid, text) to service_role;
