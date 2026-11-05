-- #461 slice 3: the tenant purge at pilot end, or on the bank's written
-- request (owner decision 2026-10-13, Ignatious G0). Builds on
-- 20261014120500_discovery_purge.sql (the identifier delete and the collector)
-- and 20261014130000_discovery_purge_wiring.sql.
--
-- It reuses the per-banker deletes for every mailbox of the tenant: delete each
-- kind = 'mailbox' content source through discovery_purge_identifiers
-- (provenance, ledger and taints cascade), then collect every message no
-- mailbox holds and every candidate left with no evidence, then delete the
-- mail-address caches. SharePoint site sources, their documents and the
-- candidates a document still evidences stay: they are out of G0's scope. Anything evidencing a deal under legal hold stays, and is
-- listed. mailbox_consents stays: it is the record of who opted in.
--
-- scripts/discovery/purge-tenant.ts runs it inside a psql transaction that
-- rolls back unless the operator confirms, so a dry run reports exact counts.
--
-- 1. audit_log_action_check restated in full, plus discovery.tenant_purged.
-- 2. discovery_tenant_site_counts: the site rows the purge must not change.
-- 3. discovery_purge_tenant: its owner alone. No role holds EXECUTE, the
--    service role included: the operator runs it as the postgres owner.

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
  'discovery.content_collected', 'discovery.group_removal_held', 'discovery.tenant_purged'
])) not valid;

-- ── 2. The site rows a purge must not change ───────────────────────────────
-- Counted before and after the purge; the two must be equal. Called only from
-- discovery_purge_tenant (owner postgres): nobody else holds EXECUTE.
create or replace function discovery_tenant_site_counts(p_tenant uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'siteSources', (select count(*) from content_sources s where s.tenant_id = p_tenant and s.kind = 'sharepoint_site'),
    'siteProvenance', (select count(*) from source_item_sources p join content_sources s on s.id = p.content_source_id
                       where s.tenant_id = p_tenant and s.kind = 'sharepoint_site'),
    'siteLedger', (select count(*) from routing_ledger r join content_sources s on s.id = r.source_id
                   where s.tenant_id = p_tenant and s.kind = 'sharepoint_site'),
    'documents', (select count(*) from source_items i where i.tenant_id = p_tenant and i.kind = 'document'),
    'documentTexts', (select count(*) from source_item_texts t join source_items i on i.id = t.source_item_id
                      where i.tenant_id = p_tenant and i.kind = 'document'),
    'documentEvidence', (select count(*) from evidence_links l join source_items i on i.id = l.source_item_id
                         where i.tenant_id = p_tenant and i.kind = 'document'),
    'documentMilestones', (select count(*) from milestone_events m join source_items i on i.id = m.source_item_id
                           where i.tenant_id = p_tenant and i.kind = 'document'),
    'documentCandidates', (select count(distinct l.candidate_id) from evidence_links l
                           join source_items i on i.id = l.source_item_id
                           where i.tenant_id = p_tenant and i.kind = 'document' and l.candidate_id is not null));
$$;
revoke all on function discovery_tenant_site_counts(uuid) from public, anon, authenticated, service_role;

-- ── 3. The tenant purge ────────────────────────────────────────────────────
-- Refuses while any reader registration of the tenant is active: stop reading
-- first, or the next pass writes new mail behind the purge. A page already in
-- flight cannot attach to a deleted source (source_archived), and its items are
-- collected as orphans by the next run or the worker's backstop.
--
-- Returns:
--   runId              the collector's run
--   auditId            the discovery.tenant_purged row
--   deleted            what was deleted, per kind, as in the audit row
--   site               {before, after}: equal, or the caller must not commit
--   heldResidue        each candidate promoted to a deal under legal hold, with
--                      the stored messages that still evidence it
--   heldResidueCounts  the rows legal hold keeps, per table, keyed like
--                      TENANT_PURGE_TABLES (src/lib/constants/discovery.ts)
-- The audit row holds ids and counts only: no address, no Message-ID.
create or replace function discovery_purge_tenant(p_tenant uuid, p_actor_identity text default 'purge-tenant')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_site_before jsonb;
  v_sources     uuid[];
  v_prov        integer;
  v_ledger      integer;
  v_taints      integer;
  v_orphans     uuid[];
  v_counts      jsonb;
  v_source      uuid;
  v_ids         jsonb;
  v_guard       integer;
  v_drift       integer;
  v_absence     integer;
  v_held        uuid[];
  v_held_items  uuid[];
  v_bare_held   uuid[];
  v_residue     jsonb;
  v_residue_n   jsonb;
  v_deleted     jsonb;
  v_audit       uuid;
begin
  if p_tenant is null then
    raise exception 'discovery_purge_tenant: tenant is required' using errcode = '22023';
  end if;
  if p_actor_identity is null or btrim(p_actor_identity) = '' then
    raise exception 'discovery_purge_tenant: actor identity is required' using errcode = '22023';
  end if;

  -- Lock order as every other writer: the tenant's discovery lock, then rows.
  -- The registration rows are locked before their status is read, so an
  -- activation cannot land between the check and the purge: it waits for this
  -- transaction, or committed first and is seen here (a fresh snapshot per
  -- statement under READ COMMITTED).
  perform discovery_lock_tenant(p_tenant);
  perform 1 from graph_reader_registrations r where r.tenant_id = p_tenant for update;
  perform 1 from google_reader_registrations g where g.tenant_id = p_tenant for update;
  if exists (select 1 from graph_reader_registrations r where r.tenant_id = p_tenant and r.status = 'active')
     or exists (select 1 from google_reader_registrations g where g.tenant_id = p_tenant and g.status = 'active') then
    raise exception 'discovery_purge_tenant: a reader registration of the tenant is active' using errcode = '55000';
  end if;
  v_site_before := discovery_tenant_site_counts(p_tenant);

  -- Detach every mailbox, archived ones included, through the one identifier
  -- delete a per-banker purge uses: provenance, ledger and taints cascade.
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[]) into v_sources
  from content_sources s where s.tenant_id = p_tenant and s.kind = 'mailbox';
  perform 1 from content_sources s where s.id = any (v_sources) for update;
  v_prov := 0; v_ledger := 0; v_taints := 0;
  foreach v_source in array v_sources loop
    v_ids := discovery_purge_identifiers(p_tenant, v_source);
    v_prov := v_prov + (v_ids->>'provenance')::integer;
    v_ledger := v_ledger + (v_ids->>'ledger')::integer;
    v_taints := v_taints + (v_ids->>'taints')::integer;
  end loop;

  -- Collect: every message of the tenant no mailbox holds is an orphan now,
  -- whatever its age.
  select coalesce(array_agg(i.id), '{}'::uuid[]) into v_orphans
  from source_items i
  where i.tenant_id = p_tenant and i.kind = 'message'
    and not exists (select 1 from source_item_sources s where s.source_item_id = i.id);
  v_counts := discovery_collect_orphans(p_tenant, interval '0', v_orphans);

  -- The mail-address caches. A guard row keyed by a site id (no '@') is site state and stays.
  with gone as (delete from mailbox_guard_state where tenant_id = p_tenant and position('@' in address) > 0 returning 1)
  select count(*) into v_guard from gone;
  with gone as (delete from mailbox_allowlist_drift where tenant_id = p_tenant returning 1)
  select count(*) into v_drift from gone;
  with gone as (delete from mailbox_group_absence where tenant_id = p_tenant returning 1)
  select count(*) into v_absence from gone;

  -- What legal hold keeps, per table: the messages evidencing a held candidate
  -- (with what hangs off them), and a held candidate the collector could not
  -- delete for want of evidence (with its own rows).
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_held
  from deal_candidates c
  where c.tenant_id = p_tenant and c.promoted_deal_id is not null and deal_is_under_hold(c.promoted_deal_id);
  select coalesce(array_agg(distinct i.id), '{}'::uuid[]) into v_held_items
  from source_items i join evidence_links l on l.source_item_id = i.id
  where i.tenant_id = p_tenant and i.kind = 'message' and l.candidate_id = any (v_held);
  select coalesce(array_agg(c), '{}'::uuid[]) into v_bare_held
  from unnest(v_held) c where not exists (select 1 from evidence_links l where l.candidate_id = c);
  v_residue_n := jsonb_build_object(
    'source_items', cardinality(v_held_items),
    'source_item_texts', (select count(*) from source_item_texts where source_item_id = any (v_held_items)),
    'evidence_links', (select count(*) from evidence_links where source_item_id = any (v_held_items)),
    'milestone_events', (select count(*) from milestone_events where source_item_id = any (v_held_items)),
    'model_calls', (select count(*) from model_calls where source_item_id = any (v_held_items)),
    'stage_assessments', (select count(*) from stage_assessments sa
                          where sa.candidate_id = any (v_held)
                            and exists (select 1 from unnest(sa.evidence_event_ids) e
                                        where not exists (select 1 from milestone_events m where m.id = e))),
    'deal_candidates', cardinality(v_bare_held),
    'candidate_visibility', (select count(*) from candidate_visibility where candidate_id = any (v_bare_held)),
    'discovery_recompute_requests', (select count(*) from discovery_recompute_requests where candidate_id = any (v_bare_held)),
    'corrections', (select count(*) from corrections where candidate_id = any (v_bare_held)));
  select coalesce(jsonb_agg(jsonb_build_object(
           'candidateId', c.id, 'dealId', c.promoted_deal_id,
           'messages', (select count(distinct l.source_item_id) from evidence_links l
                        where l.candidate_id = c.id and l.source_item_id = any (v_held_items))) order by c.id), '[]'::jsonb)
    into v_residue
  from deal_candidates c where c.id = any (v_held);

  v_deleted := jsonb_build_object('sources', cardinality(v_sources), 'provenance', v_prov, 'ledger', v_ledger,
                                  'taints', v_taints)
            || (v_counts - 'runId')
            || jsonb_build_object('guardRows', v_guard, 'driftRows', v_drift, 'absenceRows', v_absence);

  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant, 'service', p_actor_identity, 'discovery.tenant_purged',
          jsonb_build_object('runId', v_counts->'runId') || v_deleted)
  returning id into v_audit;

  return jsonb_build_object(
    'runId', v_counts->'runId',
    'auditId', v_audit,
    'deleted', v_deleted,
    'site', jsonb_build_object('before', v_site_before, 'after', discovery_tenant_site_counts(p_tenant)),
    'heldResidue', v_residue,
    'heldResidueCounts', v_residue_n);
end;
$$;
revoke all on function discovery_purge_tenant(uuid, text) from public, anon, authenticated, service_role;
