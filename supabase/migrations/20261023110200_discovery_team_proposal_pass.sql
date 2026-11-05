-- supabase/migrations/20261023110200_discovery_team_proposal_pass.sql
-- G-01 (#173), slice 3 of 5: the audited pass a team source must hold before any model call. Inert: nothing calls
-- these functions yet (the worker hand-off is slice 5), and while TEAM_PROPOSAL_FIRMS ships empty and no approval row
-- exists, every call below refuses.
--
-- A team inbox's mail may reach the model only inside a PASS: one row of discovery_team_proposal_passes for one
-- (source, run), opened by `begin`, kept alive by `renew`, closed by `end`.
--
--   discovery_begin_proposal_source(tenant, source, run, path, firm_ids)   service_role only
--     personal, owned and still on the allowlist   -> {scope: 'personal'}, no pass, nothing audited
--     ownerless and no team inbox, or a personal    -> 42501 no_reader
--       source its owner left the allowlist for
--     team: both halves of the switch, then the inbox:
--       the inbox's firm company is in p_firm_ids    (the reviewed TS list, TEAM_PROPOSAL_FIRMS)  42501 team_not_approved
--       app_tenant_capability_on(.., 'team_proposals') (the migration-written row)                42501 team_not_approved
--       an allowed_team_mailboxes row for the inbox                                              42501 team_inbox_not_allowed
--       an open pass of ANOTHER run: a fresh lease -> 55P03 pass_in_progress; a lapsed lease -> closed 'unclosed',
--         with its last counts, and audited as finished (the worker that held it died or was cut off)
--       a pass this run already ended                                                            42501 pass_closed
--       -> insert the pass (lease 30 minutes), audit discovery.team_mailbox_proposal_started
--                                                    -> {scope: 'team', leaseUntil}
--     The same run beginning again is idempotent: it returns its open pass and writes nothing.
--   discovery_renew_proposal_source(tenant, source, run, firm_ids, counts)  service_role only; once per page
--     the same three checks; the pass must be open and owned by p_run (42501 pass_not_open); extends the lease by 30
--     minutes and stores the counts. A personal source answers {scope: 'personal'}.
--   discovery_end_proposal_source(tenant, source, run, outcome, counts)     service_role only
--     closes the open pass owned by p_run with the outcome, audits discovery.team_mailbox_proposal_finished. No open
--     pass for that run: nothing happens. It checks no approval, so a revoked or refused source can still be closed.
--   discovery_close_lapsed_proposal_passes(tenant)                          service_role only; once per run
--     closes every open pass of the tenant whose lease has lapsed as 'unclosed', audited as finished, and answers how
--     many it closed. It checks no approval and no inbox: begin closes a lapsed pass only when its own checks pass
--     (a refusal raises, and rolls the close back with it), so after a crash followed by a revoke or a refused inbox
--     only this sweep closes the dead pass (review F5). A source whose lock another call holds is skipped; that call
--     is working on it.
--
-- Every audit row carries ids and fixed codes only (passId, sourceId, teamMailboxId, firmCompanyId, runId, path, and
-- on finish the outcome and the integer counts), never an address, a subject or a deal name.
--
-- Concurrency: the three definers take the source's own advisory key ('discovery_team_proposal:' || source), not the
-- tenant lock, so passes over different sources never wait on each other. One open pass per source is also a unique
-- partial index, so a missed lock cannot produce two. Their audit insert takes the audit chain's per-tenant key after
-- this one; nothing takes the two in the other order.
--
-- The check, count and close helpers below are plain functions nobody can execute: the definers call them as their
-- owner, so the three checks, and the 'unclosed' close with its audit row, are written once.
--
-- The table holds ids and numbers describing a pass over a mailbox, no text. It is mailbox-derived (it names a
-- source) and goes with its source (on delete cascade), which the purges delete.
--
-- audit_log_action_check is restated in full from 20261023110100_discovery_tenant_approvals.sql, the newest
-- restatement, plus the two pass actions. Open pull requests were read: #711-#716 add no audit action, so the list
-- below is a superset of every list in flight. The trail slice (a later pull request) adds none.
--
-- Reverse: drop the four definers, the three helpers and the table. The audit CHECK keeps the new actions (a
-- restatement may not drop a value without a deliberate removal marker).

-- ── 1. Two new audit actions ───────────────────────────────────────────────
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
  'discovery.tenant_approval_changed',
  'discovery.team_mailbox_proposal_started', 'discovery.team_mailbox_proposal_finished'
])) not valid;

-- ── 2. The pass table ──────────────────────────────────────────────────────
create table if not exists discovery_team_proposal_passes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  -- The purges reach the rows through their source.
  content_source_id uuid not null references content_sources (id) on delete cascade,
  -- The inbox registration and its firm company, as they were when the pass opened.
  team_mailbox_id   uuid not null,
  firm_company_id   uuid not null,
  run_id            uuid not null,
  path              text not null check (path in ('recorded', 'synthetic', 'verified')),
  opened_at         timestamptz not null default now(),
  renewed_at        timestamptz not null default now(),
  -- renewed_at + 30 minutes: a pass nobody renewed for that long is abandoned, and a later begin may close it.
  lease_until       timestamptz not null,
  -- {asked, deal, notDeal, invalid, failed}: non-negative integers only, kept by the definers (never free text).
  counts            jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  closed_at         timestamptz,
  outcome           text check (outcome in ('complete', 'page_limit', 'paused', 'refused', 'revoked', 'archived', 'error',
                                            'zdr_unavailable', 'ledger', 'failure_streak', 'unclosed')),
  -- A pass has run once per source: the reader looks it up by (source, run), and the cascade by source.
  unique (content_source_id, run_id),
  check ((closed_at is null) = (outcome is null))
);
-- One live pass per source: closed only by `end`, or by a later begin once its lease has lapsed.
create unique index if not exists discovery_team_proposal_passes_open
  on discovery_team_proposal_passes (content_source_id) where closed_at is null;
alter table discovery_team_proposal_passes enable row level security;
-- No policy: closed to anon and authenticated, grants included (TRUNCATE ignores RLS). The worker reads it; the
-- three definers below are its only writers.
revoke all on discovery_team_proposal_passes from public, anon, authenticated, service_role;
grant select on discovery_team_proposal_passes to service_role;

-- ── 3. Helpers the definers call as their owner ────────────────────────────
-- The counts of a pass: the five keys, each a non-negative integer up to a billion, anything else 0. A bad count is
-- cleaned, never refused: a refused `end` would leave the pass to lapse as `unclosed`.
create or replace function discovery_team_pass_counts(p_counts jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_object_agg(k.field,
           coalesce(case when jsonb_typeof(p_counts -> k.field) = 'number' then
                      case when (p_counts ->> k.field)::numeric between 0 and 1000000000
                             and (p_counts ->> k.field)::numeric = trunc((p_counts ->> k.field)::numeric)
                           then (p_counts ->> k.field)::numeric::bigint end
                    end, 0))
  from (values ('asked'), ('deal'), ('notDeal'), ('invalid'), ('failed')) as k(field);
$$;
revoke all on function discovery_team_pass_counts(jsonb) from public, anon, authenticated, service_role;

-- The three checks a team pass makes at begin and at every renew, written once. A personal source is answered
-- without a pass. Refusals: 22023 for a source outside the tenant; 42501 with the code as the message otherwise.
create or replace function discovery_team_pass_gate(p_tenant uuid, p_source uuid, p_firm_ids uuid[],
                                                    out o_scope text, out o_team uuid, out o_firm uuid)
language plpgsql set search_path = public, pg_temp as $$
declare
  v_owner    uuid;
  v_address  text;
  v_provider text;
begin
  select c.team_mailbox_id, c.owner_user_id, lower(c.address), c.provider
    into o_team, v_owner, v_address, v_provider
  from content_sources c
  where c.id = p_source and c.tenant_id = p_tenant and c.kind = 'mailbox';
  if not found then
    raise exception 'source not in tenant' using errcode = '22023';
  end if;

  if o_team is null then
    -- A personal source needs an owner who still holds the allowlist row for this very mailbox (the join
    -- discovery_proposal_may_name makes); anything else is a source nobody reads.
    if v_owner is not null and exists (
         select 1
         from users u
         join allowed_mailboxes a on a.tenant_id = u.tenant_id and a.user_id = u.id
         where u.id = v_owner and u.tenant_id = p_tenant
           and a.address = v_address and a.provider = v_provider) then
      o_scope := 'personal';
      o_firm := null;
      return;
    end if;
    raise exception 'no_reader' using errcode = '42501';
  end if;

  select t.firm_company_id into o_firm from team_mailboxes t where t.id = o_team and t.tenant_id = p_tenant;
  -- The TS half: the reviewed list names the inbox's firm company. A null in the list, or no list, never matches.
  if not coalesce(o_firm = any (p_firm_ids), false) then
    raise exception 'team_not_approved' using errcode = '42501';
  end if;
  -- The row half: a live team_proposals approval for exactly that firm company.
  if not app_tenant_capability_on(p_tenant, o_firm, 'team_proposals') then
    raise exception 'team_not_approved' using errcode = '42501';
  end if;
  -- The inbox itself: still registered, verified and not refused (the allowlist's team half).
  if not exists (select 1 from allowed_team_mailboxes a
                 where a.team_mailbox_id = o_team and a.tenant_id = p_tenant
                   and a.address = v_address and a.provider = v_provider) then
    raise exception 'team_inbox_not_allowed' using errcode = '42501';
  end if;
  o_scope := 'team';
end;
$$;
revoke all on function discovery_team_pass_gate(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;

-- Close one open pass whose lease has lapsed as 'unclosed', with the last counts it kept, and audit it as finished.
-- The caller holds the source's advisory key and the row FOR UPDATE, and has checked the lease.
create or replace function discovery_team_pass_close_lapsed(p_pass uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_pass discovery_team_proposal_passes;
begin
  update discovery_team_proposal_passes
     set closed_at = now(), outcome = 'unclosed'
   where id = p_pass and closed_at is null
  returning * into v_pass;
  if not found then
    return;
  end if;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (v_pass.tenant_id, 'service', 'discovery-worker', 'discovery.team_mailbox_proposal_finished',
          jsonb_build_object('passId', v_pass.id, 'sourceId', v_pass.content_source_id,
                             'teamMailboxId', v_pass.team_mailbox_id, 'firmCompanyId', v_pass.firm_company_id,
                             'runId', v_pass.run_id, 'path', v_pass.path, 'outcome', v_pass.outcome,
                             'counts', v_pass.counts, 'lastRenewedAt', v_pass.renewed_at));
end;
$$;
revoke all on function discovery_team_pass_close_lapsed(uuid) from public, anon, authenticated, service_role;

-- ── 4. begin ───────────────────────────────────────────────────────────────
create or replace function discovery_begin_proposal_source(p_tenant uuid, p_source uuid, p_run uuid, p_path text,
                                                           p_firm_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_scope text;
  v_team  uuid;
  v_firm  uuid;
  v_open  discovery_team_proposal_passes;
  v_pass  discovery_team_proposal_passes;
begin
  if p_tenant is null or p_source is null or p_run is null then
    raise exception 'discovery_begin_proposal_source: tenant, source and run are required' using errcode = '22023';
  end if;
  if p_path is null or p_path not in ('recorded', 'synthetic', 'verified') then
    raise exception 'discovery_begin_proposal_source: unknown path' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('discovery_team_proposal:' || p_source::text, 0));

  select g.o_scope, g.o_team, g.o_firm into v_scope, v_team, v_firm
  from discovery_team_pass_gate(p_tenant, p_source, p_firm_ids) g;
  if v_scope = 'personal' then
    return jsonb_build_object('scope', 'personal');
  end if;

  select * into v_open
  from discovery_team_proposal_passes p
  where p.content_source_id = p_source and p.closed_at is null
  for update;
  if found then
    if v_open.run_id = p_run then
      -- This run's own pass: begin again is a no-op (the lease is renewed by `renew`, not here).
      return jsonb_build_object('scope', 'team', 'leaseUntil', v_open.lease_until);
    end if;
    if v_open.lease_until > now() then
      raise exception 'pass_in_progress' using errcode = '55P03';
    end if;
    -- Another run's pass whose lease lapsed without an end: record it as unclosed, with the last counts it kept.
    -- (Reached only when the checks above passed; discovery_close_lapsed_proposal_passes closes it otherwise.)
    perform discovery_team_pass_close_lapsed(v_open.id);
  end if;

  -- A run does not reopen a pass it has already ended.
  if exists (select 1 from discovery_team_proposal_passes p
             where p.content_source_id = p_source and p.run_id = p_run) then
    raise exception 'pass_closed' using errcode = '42501';
  end if;

  insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id,
                                              path, lease_until)
  values (p_tenant, p_source, v_team, v_firm, p_run, p_path, now() + interval '30 minutes')
  returning * into v_pass;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (v_pass.tenant_id, 'service', 'discovery-worker', 'discovery.team_mailbox_proposal_started',
          jsonb_build_object('passId', v_pass.id, 'sourceId', v_pass.content_source_id,
                             'teamMailboxId', v_pass.team_mailbox_id, 'firmCompanyId', v_pass.firm_company_id,
                             'runId', v_pass.run_id, 'path', v_pass.path));
  return jsonb_build_object('scope', 'team', 'leaseUntil', v_pass.lease_until);
end;
$$;
revoke all on function discovery_begin_proposal_source(uuid, uuid, uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function discovery_begin_proposal_source(uuid, uuid, uuid, text, uuid[]) to service_role;

-- ── 5. renew ───────────────────────────────────────────────────────────────
create or replace function discovery_renew_proposal_source(p_tenant uuid, p_source uuid, p_run uuid, p_firm_ids uuid[],
                                                           p_counts jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_scope text;
  v_team  uuid;
  v_firm  uuid;
  v_pass  discovery_team_proposal_passes;
begin
  if p_tenant is null or p_source is null or p_run is null then
    raise exception 'discovery_renew_proposal_source: tenant, source and run are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('discovery_team_proposal:' || p_source::text, 0));

  select g.o_scope, g.o_team, g.o_firm into v_scope, v_team, v_firm
  from discovery_team_pass_gate(p_tenant, p_source, p_firm_ids) g;
  if v_scope = 'personal' then
    return jsonb_build_object('scope', 'personal');
  end if;

  select * into v_pass
  from discovery_team_proposal_passes p
  where p.tenant_id = p_tenant and p.content_source_id = p_source and p.run_id = p_run and p.closed_at is null
  for update;
  if not found then
    -- Another run's pass, a pass already closed (ended, or closed unclosed by a later begin), or none at all.
    raise exception 'pass_not_open' using errcode = '42501';
  end if;
  update discovery_team_proposal_passes
     set renewed_at = now(), lease_until = now() + interval '30 minutes',
         counts = discovery_team_pass_counts(p_counts)
   where id = v_pass.id
  returning * into v_pass;
  return jsonb_build_object('scope', 'team', 'leaseUntil', v_pass.lease_until);
end;
$$;
revoke all on function discovery_renew_proposal_source(uuid, uuid, uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function discovery_renew_proposal_source(uuid, uuid, uuid, uuid[], jsonb) to service_role;

-- ── 6. end ─────────────────────────────────────────────────────────────────
create or replace function discovery_end_proposal_source(p_tenant uuid, p_source uuid, p_run uuid, p_outcome text,
                                                         p_counts jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pass discovery_team_proposal_passes;
begin
  if p_tenant is null or p_source is null or p_run is null then
    raise exception 'discovery_end_proposal_source: tenant, source and run are required' using errcode = '22023';
  end if;
  -- 'unclosed' is only ever written by a later begin, for a pass nobody ended.
  if p_outcome is null or p_outcome not in ('complete', 'page_limit', 'paused', 'refused', 'revoked', 'archived',
                                            'error', 'zdr_unavailable', 'ledger', 'failure_streak') then
    raise exception 'discovery_end_proposal_source: unknown outcome' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('discovery_team_proposal:' || p_source::text, 0));

  select * into v_pass
  from discovery_team_proposal_passes p
  where p.tenant_id = p_tenant and p.content_source_id = p_source and p.run_id = p_run and p.closed_at is null
  for update;
  if not found then
    return; -- no open pass for this run (a personal source, an ended pass, or one a later begin closed): nothing to close
  end if;
  update discovery_team_proposal_passes
     set closed_at = now(), outcome = p_outcome, counts = discovery_team_pass_counts(p_counts)
   where id = v_pass.id
  returning * into v_pass;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (v_pass.tenant_id, 'service', 'discovery-worker', 'discovery.team_mailbox_proposal_finished',
          jsonb_build_object('passId', v_pass.id, 'sourceId', v_pass.content_source_id,
                             'teamMailboxId', v_pass.team_mailbox_id, 'firmCompanyId', v_pass.firm_company_id,
                             'runId', v_pass.run_id, 'path', v_pass.path, 'outcome', v_pass.outcome,
                             'counts', v_pass.counts));
end;
$$;
revoke all on function discovery_end_proposal_source(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function discovery_end_proposal_source(uuid, uuid, uuid, text, jsonb) to service_role;

-- ── 7. The sweep: lapsed passes are closed whether or not anyone may begin again ──
-- Review F5. A worker that dies mid-pass leaves the pass open. If the approval is then revoked, the TS entry removed
-- or the inbox refused, no later begin for that source succeeds (its refusal rolls back anything it closed), so the
-- pass would stay open with only its started row. The worker calls this once at the start of every propose run, before
-- any source, and it closes each open pass of the tenant whose lease has lapsed. It takes each source's advisory key
-- with a try-lock and skips a source another call holds (that call is beginning, renewing or ending it), so it never
-- waits on, or deadlocks with, a begin that holds the source's key and then the audit chain's.
create or replace function discovery_close_lapsed_proposal_passes(p_tenant uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_source uuid;
  v_pass   uuid;
  v_closed integer := 0;
begin
  if p_tenant is null then
    raise exception 'discovery_close_lapsed_proposal_passes: tenant is required' using errcode = '22023';
  end if;
  for v_source in
    select p.content_source_id from discovery_team_proposal_passes p
    where p.tenant_id = p_tenant and p.closed_at is null and p.lease_until <= now()
    order by p.content_source_id
  loop
    continue when not pg_try_advisory_xact_lock(hashtextextended('discovery_team_proposal:' || v_source::text, 0));
    select p.id into v_pass
    from discovery_team_proposal_passes p
    where p.tenant_id = p_tenant and p.content_source_id = v_source and p.closed_at is null and p.lease_until <= now()
    for update;
    if found then
      perform discovery_team_pass_close_lapsed(v_pass);
      v_closed := v_closed + 1;
    end if;
  end loop;
  return v_closed;
end;
$$;
revoke all on function discovery_close_lapsed_proposal_passes(uuid) from public, anon, authenticated;
grant execute on function discovery_close_lapsed_proposal_passes(uuid) to service_role;
