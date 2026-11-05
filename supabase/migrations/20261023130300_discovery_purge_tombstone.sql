-- G-07 slice 1c (#173, design R3): a purge never lets a reader fall back to an older
-- pre-purge assessment. An assessment stream is one (candidate, audience) pair: the shared
-- audience (team_mailbox_id null) or one team inbox's (20261023130100). Readers take a
-- stream's latest row. A purge that deletes the rows citing a deleted milestone used to
-- leave the stream's next older row as its latest, so a reader saw a suggestion the engine
-- had already replaced (20261014151000:99-104). Now, for every stream of a surviving
-- candidate whose LATEST row the purge deleted, it writes a tombstone (no step, no evidence,
-- trigger 'purge', reason 'No milestones extracted yet', the stream's own team_mailbox_id),
-- audits it as discovery.stage_assessed like every other assessment (ids and the trigger
-- only), and asks for a recompute (reason 'purge'), which the extract loop answers with a
-- fresh engine decision under trigger 'purge'. A stream whose latest row survives is left
-- alone, so a still-valid suggestion is never hidden. A held candidate is untouched, as
-- before, and a candidate the run deletes needs no tombstone.
--
-- The tenant purge's held residue also counts milestone_detections, the rule detector's
-- settle ledger (G-07 slice 3b). That table does not exist yet, so the count reads it only
-- once to_regclass finds it, and is 0 until then; slice 3b need not restate this function.
--
-- Both functions are restated with the same signatures, so `create or replace` keeps their
-- owner and ACL; the grants are restated as in their source migrations. Each body is its
-- latest definition byte for byte, apart from the lines marked #173 G-07 slice 1c. No
-- table, policy or grant changes.

-- ── 1. The collector tombstones a stream whose latest row it deleted ────────────
-- As in 20261014151000_discovery_message_index_export.sql:23-194 (its newest definition),
-- plus the lines marked #173 G-07 slice 1c: before the delete, the streams whose latest row
-- the delete removes are noted; after the candidate deletes, each one whose candidate
-- survives gets its tombstone and audit row, and each such candidate one recompute request.
create or replace function discovery_collect_orphans(
  p_tenant   uuid,
  p_min_age  interval default '15 minutes',
  p_detached uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run         uuid := gen_random_uuid();
  v_detached    uuid[] := coalesce(p_detached, '{}'::uuid[]);
  v_held        uuid[];
  v_items       uuid[];
  v_held_items  integer;
  v_events      uuid[];
  v_gone_events uuid[];
  v_touched     uuid[];
  v_empty       uuid[];
  v_rebase      uuid[];
  v_unsupported uuid[];
  v_named       uuid[];
  v_corrections uuid[];
  v_texts       integer;
  v_evidence    integer;
  v_milestones  integer;
  v_calls       integer;
  v_deleted     integer;
  v_candidates  integer;
  v_cand        uuid;
  v_tomb_cands  uuid[];  -- #173 G-07 slice 1c
  v_tomb_teams  uuid[];  -- #173 G-07 slice 1c
  v_tomb        record;  -- #173 G-07 slice 1c
  v_tomb_id     uuid;    -- #173 G-07 slice 1c
begin
  if p_tenant is null then
    raise exception 'discovery_collect_orphans: tenant is required' using errcode = '22023';
  end if;
  if p_min_age is null or p_min_age < interval '0' then
    raise exception 'discovery_collect_orphans: min age must be zero or more' using errcode = '22023';
  end if;
  perform discovery_lock_tenant(p_tenant);
  perform discovery_message_index_link(p_tenant);  -- #461 slice 5

  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_held
  from deal_candidates c
  where c.tenant_id = p_tenant and c.promoted_deal_id is not null and deal_is_under_hold(c.promoted_deal_id);

  with orphan as (
    select i.id,
           exists (select 1 from evidence_links l where l.source_item_id = i.id and l.candidate_id = any (v_held)) as held
    from source_items i
    where i.tenant_id = p_tenant
      and i.kind = 'message'
      and (i.created_at <= now() - p_min_age or i.id = any (v_detached))
      and not exists (select 1 from source_item_sources s where s.source_item_id = i.id))
  select coalesce(array_agg(o.id) filter (where not o.held), '{}'::uuid[]), count(*) filter (where o.held)
    into v_items, v_held_items
  from orphan o;

  -- Counted, and the milestone events noted, before the cascade removes them.
  select count(*) into v_texts from source_item_texts where source_item_id = any (v_items);
  select count(*) into v_evidence from evidence_links where source_item_id = any (v_items);
  select count(*), coalesce(array_agg(id), '{}'::uuid[]) into v_milestones, v_events
    from milestone_events where source_item_id = any (v_items);
  select count(*) into v_calls from model_calls where source_item_id = any (v_items);
  select coalesce(array_agg(distinct l.candidate_id) filter (where l.candidate_id is not null), '{}'::uuid[])
    into v_touched
  from evidence_links l where l.source_item_id = any (v_items);

  -- The provenance test is repeated here: a page that attached a provenance row
  -- since the read above keeps its item.
  with gone as (
    delete from source_items i
    where i.id = any (v_items)
      and not exists (select 1 from source_item_sources s where s.source_item_id = i.id)
    returning i.id)
  select count(*) into v_deleted from gone;

  -- A surviving candidate keeps no assessment built on a deleted milestone.
  select coalesce(array_agg(e), '{}'::uuid[]) into v_gone_events
  from unnest(v_events) e where not exists (select 1 from milestone_events m where m.id = e);
  -- #173 G-07 slice 1c: the (candidate, audience) streams whose latest row (as the writer orders them, as_of
  -- then id) the delete below removes. One pair per stream; both arrays share one order, so they zip.
  select coalesce(array_agg(l.candidate_id order by l.candidate_id, l.team_mailbox_id), '{}'::uuid[]),
         coalesce(array_agg(l.team_mailbox_id order by l.candidate_id, l.team_mailbox_id), '{}'::uuid[])
    into v_tomb_cands, v_tomb_teams
  from (select distinct on (sa.candidate_id, sa.team_mailbox_id) sa.candidate_id, sa.team_mailbox_id, sa.evidence_event_ids
        from stage_assessments sa
        where sa.tenant_id = p_tenant and not (sa.candidate_id = any (v_held))
          and sa.candidate_id in (select d.candidate_id from stage_assessments d
                                  where d.tenant_id = p_tenant and d.evidence_event_ids && v_gone_events)
        order by sa.candidate_id, sa.team_mailbox_id, sa.as_of desc, sa.id desc) l
  where l.evidence_event_ids && v_gone_events;
  delete from stage_assessments sa
  where sa.tenant_id = p_tenant and sa.evidence_event_ids && v_gone_events
    and not (sa.candidate_id = any (v_held));

  -- Only the candidates this run's deletions emptied: one this run did not touch
  -- is not this purge's to delete. At tenant end (min age zero: no reader is
  -- left) every linkless candidate of the tenant goes.
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_empty
  from deal_candidates c
  where c.tenant_id = p_tenant
    and (c.id = any (v_touched) or p_min_age = interval '0')
    and not exists (select 1 from evidence_links l where l.candidate_id = c.id)
    and not (c.id = any (v_held));

  -- Rebase the survivors that lost a link on the evidence they keep.
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_rebase
  from deal_candidates c
  where c.id = any (v_touched) and not (c.id = any (v_empty)) and not (c.id = any (v_held));
  with kept as (
    select l.candidate_id, l.confidence, i.sent_at, i.participants
    from evidence_links l join source_items i on i.id = l.source_item_id
    where l.candidate_id = any (v_rebase) and l.state <> 'rejected')
  update deal_candidates c set
    parties = coalesce((
      select jsonb_agg(p.value order by p.ordinality)
      from jsonb_array_elements(case when jsonb_typeof(c.parties) = 'array' then c.parties else '[]'::jsonb end)
           with ordinality p
      where lower(p.value->>'domain') in (
        select lower(split_part(pt->>'address', '@', 2))
        from kept k,
             jsonb_array_elements(case when jsonb_typeof(k.participants) = 'array' then k.participants else '[]'::jsonb end) pt
        where k.candidate_id = c.id)), '[]'::jsonb),
    first_seen_at = (select min(k.sent_at) from kept k where k.candidate_id = c.id),
    last_seen_at  = (select max(k.sent_at) from kept k where k.candidate_id = c.id),
    confidence    = (select max(k.confidence) from kept k where k.candidate_id = c.id)
  where c.id = any (v_rebase);

  -- A link discovery routed (no correction pinned it) means a kept item carries
  -- the name. Without one, the name has no support left.
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_unsupported
  from deal_candidates c
  where c.id = any (v_rebase)
    and not exists (select 1 from evidence_links l where l.candidate_id = c.id and l.pinned_by_correction_id is null);
  -- An MD-typed name stays: the candidate was renamed to it, or a split created it.
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_named
  from deal_candidates c
  where c.id = any (v_unsupported) and c.pinned
    and (c.cluster_key like 'correction:%'
         or exists (select 1 from corrections k where k.candidate_id = c.id and k.action = 'rename'
                                                  and k.after->>'name' = c.proposed_name));
  update deal_candidates c set
    codename_guess = null,
    cluster_key    = 'purged:' || c.id,
    proposed_name  = case when c.id = any (v_named) then c.proposed_name else 'Unnamed candidate' end
  where c.id = any (v_unsupported);

  -- The corrections that go: every one of an empty candidate, and every one that
  -- carries a candidate name when it belongs to an unsupported candidate or names
  -- an empty or unsupported one by id.
  select coalesce(array_agg(k.id), '{}'::uuid[]) into v_corrections
  from corrections k
  where k.tenant_id = p_tenant
    and (k.candidate_id = any (v_empty)
         or ((coalesce(k.before, '{}'::jsonb) ?| array['name', 'survivorName', 'newName', 'targetName']
              or coalesce(k.after, '{}'::jsonb) ?| array['name', 'survivorName', 'newName', 'targetName'])
             and (k.candidate_id = any (v_unsupported)
                  or exists (select 1 from jsonb_each_text(coalesce(k.after, '{}'::jsonb)) a
                             where a.key in ('survivorId', 'newCandidateId', 'targetCandidateId')
                               and a.value in (select x::text from unnest(v_empty || v_unsupported) x)))));

  perform set_config('conductia.discovery_purge', v_run::text, true);
  update deal_candidates set station_override_correction_id = null
   where station_override_correction_id = any (v_corrections);
  -- A candidate merged into an empty one keeps its own evidence: it is proposed again.
  update deal_candidates set discovery_state = 'proposed', merged_into_id = null
   where merged_into_id = any (v_empty) and not (id = any (v_empty));
  delete from corrections where id = any (v_corrections);
  with gone as (delete from deal_candidates c where c.id = any (v_empty) returning c.id)
  select count(*) into v_candidates from gone;
  perform set_config('conductia.discovery_purge', '', true);

  -- #173 G-07 slice 1c: each noted stream of a candidate that survives gets a tombstone in its own audience, so
  -- no reader falls back to an older pre-purge row, audited like every assessment (ids and the trigger only).
  -- Each such candidate gets one recompute request, answered by a fresh engine decision under trigger 'purge'.
  for v_tomb in
    select u.candidate_id, u.team_mailbox_id
    from unnest(v_tomb_cands, v_tomb_teams) as u(candidate_id, team_mailbox_id)
    where exists (select 1 from deal_candidates c where c.id = u.candidate_id)
  loop
    insert into stage_assessments (tenant_id, candidate_id, step_id, station, lifecycle_suggestion, reason_text,
                                   evidence_event_ids, confidence, flags, engine_version, trigger, team_mailbox_id)
    values (p_tenant, v_tomb.candidate_id, null, null, null, 'No milestones extracted yet',
            '{}'::uuid[], 0, '{}'::text[], 'purge', 'purge', v_tomb.team_mailbox_id)
    returning id into v_tomb_id;
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (p_tenant, 'service', 'discovery-worker', 'discovery.stage_assessed',
            jsonb_build_object('candidateId', v_tomb.candidate_id, 'assessmentId', v_tomb_id, 'trigger', 'purge')
            || jsonb_strip_nulls(jsonb_build_object('teamMailboxId', v_tomb.team_mailbox_id)));
  end loop;
  insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
  select distinct p_tenant, u.candidate_id, 'purge'
  from unnest(v_tomb_cands) as u(candidate_id)
  where exists (select 1 from deal_candidates c where c.id = u.candidate_id);

  -- A surviving candidate that lost evidence is seen by fewer people.
  foreach v_cand in array v_rebase loop
    perform discovery_refresh_candidate_visibility(v_cand);
  end loop;

  return jsonb_build_object('runId', v_run, 'items', v_deleted, 'texts', v_texts, 'evidence', v_evidence,
                            'milestones', v_milestones, 'modelCalls', v_calls, 'candidates', v_candidates,
                            'corrections', cardinality(v_corrections), 'heldSkipped', v_held_items);
end;
$$;
revoke all on function discovery_collect_orphans(uuid, interval, uuid[]) from public, anon, authenticated;
grant execute on function discovery_collect_orphans(uuid, interval, uuid[]) to service_role;

-- ── 2. The tenant purge counts the detector's ledger in its held residue ────────
-- As in 20261021190000_discovery_extract_budget.sql:277-459 (its newest definition), plus
-- the lines marked #173 G-07 slice 1c: heldResidueCounts gains milestone_detections, the
-- held messages' rows of the rule detector's settle ledger, read through dynamic SQL once
-- the table exists (G-07 slice 3b) and 0 before. The tombstones themselves are written by
-- discovery_collect_orphans above, which this function calls. No role holds EXECUTE, the
-- service role included.
create or replace function discovery_purge_tenant(p_tenant uuid, p_actor_identity text default 'purge-tenant')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy      tenant_retention_policies;
  v_site_before jsonb;
  v_sources     uuid[];
  v_prov        integer;
  v_ledger      integer;
  v_taints      integer;
  v_index       integer;
  v_export      jsonb;
  v_orphans     uuid[];
  v_counts      jsonb;
  v_source      uuid;
  v_ids         jsonb;
  v_guard       integer;
  v_drift       integer;
  v_absence     integer;
  v_budgets     integer;
  v_held        uuid[];
  v_held_items  uuid[];
  v_bare_held   uuid[];
  v_residue     jsonb;
  v_residue_n   jsonb;
  v_detections  bigint := 0;  -- #173 G-07 slice 1c
  v_kept_n      jsonb;
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
  v_policy := tenant_retention_policy(p_tenant);  -- #461 slice 7
  v_site_before := discovery_tenant_site_counts(p_tenant);

  -- The mailboxes, locked before the export: the index writer takes FOR KEY SHARE
  -- on its source, so a page in flight commits before this lock is granted, and
  -- the export (a later statement, a fresh snapshot) sees it. What is exported
  -- is then exactly what is deleted.
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[]) into v_sources
  from content_sources s where s.tenant_id = p_tenant and s.kind = 'mailbox';
  perform 1 from content_sources s where s.id = any (v_sources) for update;

  -- The index for the bank, its links current, before any delete.
  perform discovery_message_index_link(p_tenant);
  select coalesce(jsonb_agg(jsonb_build_object(
           'messageKey', x.message_key,
           'providerItemIds', to_jsonb(x.provider_item_ids),
           'sourceId', x.content_source_id, 'sentAt', x.sent_at, 'dealId', x.deal_id, 'tags', to_jsonb(x.tags),
           'rulesVersion', x.rules_version, 'model', x.model, 'promptVersion', x.prompt_version,
           'processedAt', x.processed_at)
         order by x.content_source_id, x.message_key), '[]'::jsonb)
    into v_export
  from discovery_message_index x
  where x.tenant_id = p_tenant and (x.deal_id is null or not deal_is_under_hold(x.deal_id));

  -- Detach every mailbox, archived ones included, through the one identifier
  -- delete a per-banker purge uses: provenance, ledger and taints cascade, and
  -- the index rows when the policy deletes the index at tenant end.
  v_prov := 0; v_ledger := 0; v_taints := 0; v_index := 0;
  foreach v_source in array v_sources loop
    v_ids := discovery_purge_identifiers(p_tenant, v_source, jsonb_build_object(
               'index_on_disconnect', case v_policy.index_at_tenant_end when 'keep' then 'keep' else 'delete' end));
    v_prov := v_prov + (v_ids->>'provenance')::integer;
    v_ledger := v_ledger + (v_ids->>'ledger')::integer;
    v_taints := v_taints + (v_ids->>'taints')::integer;
    v_index := v_index + (v_ids->>'indexRows')::integer;
  end loop;
  -- Index rows whose source an earlier purge deleted.
  if v_policy.index_at_tenant_end = 'export_then_delete' then
    with gone as (
      delete from discovery_message_index x
      where x.tenant_id = p_tenant and (x.deal_id is null or not deal_is_under_hold(x.deal_id))
      returning 1)
    select v_index + count(*) into v_index from gone;
  end if;
  update discovery_message_index
     set orphaned_by = case v_policy.index_at_tenant_end when 'keep' then 'tenant_end_keep' else 'tenant_end_delete' end
   where tenant_id = p_tenant;

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
  -- #261: the extraction budgets (ids and numbers), with their cohort rows by cascade. No foreign key ties
  -- a budget to the tenant's mail, so nothing above removes it.
  with gone as (delete from discovery_extract_budgets where tenant_id = p_tenant returning 1)
  select count(*) into v_budgets from gone;

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
  -- #173 G-07 slice 1c: the rule detector's settle ledger (G-07 slice 3b) on the held messages. Dynamic, so this
  -- body compiles before the table exists; 0 until then.
  if to_regclass('public.milestone_detections') is not null then
    execute 'select count(*) from public.milestone_detections where source_item_id = any ($1)'
      into v_detections using v_held_items;
  end if;
  v_residue_n := jsonb_build_object(
    'source_items', cardinality(v_held_items),
    'source_item_texts', (select count(*) from source_item_texts where source_item_id = any (v_held_items)),
    'evidence_links', (select count(*) from evidence_links where source_item_id = any (v_held_items)),
    'milestone_events', (select count(*) from milestone_events where source_item_id = any (v_held_items)),
    'model_calls', (select count(*) from model_calls where source_item_id = any (v_held_items)),
    'milestone_detections', v_detections,  -- #173 G-07 slice 1c
    'stage_assessments', (select count(*) from stage_assessments sa
                          where sa.candidate_id = any (v_held)
                            and exists (select 1 from unnest(sa.evidence_event_ids) e
                                        where not exists (select 1 from milestone_events m where m.id = e))),
    'deal_candidates', cardinality(v_bare_held),
    'candidate_visibility', (select count(*) from candidate_visibility where candidate_id = any (v_bare_held)),
    'discovery_recompute_requests', (select count(*) from discovery_recompute_requests where candidate_id = any (v_bare_held)),
    'corrections', (select count(*) from corrections where candidate_id = any (v_bare_held)),
    'discovery_message_index', (select count(*) from discovery_message_index
                                where tenant_id = p_tenant and deal_id is not null and deal_is_under_hold(deal_id)));
  v_kept_n := jsonb_build_object(
    'discovery_message_index', (select count(*) from discovery_message_index
                                where tenant_id = p_tenant and (deal_id is null or not deal_is_under_hold(deal_id))));
  select coalesce(jsonb_agg(jsonb_build_object(
           'candidateId', c.id, 'dealId', c.promoted_deal_id,
           'messages', (select count(distinct l.source_item_id) from evidence_links l
                        where l.candidate_id = c.id and l.source_item_id = any (v_held_items))) order by c.id), '[]'::jsonb)
    into v_residue
  from deal_candidates c where c.id = any (v_held);

  v_deleted := jsonb_build_object('sources', cardinality(v_sources), 'provenance', v_prov, 'ledger', v_ledger,
                                  'taints', v_taints, 'indexRows', v_index)
            || (v_counts - 'runId')
            || jsonb_build_object('guardRows', v_guard, 'driftRows', v_drift, 'absenceRows', v_absence,
                                 'budgets', v_budgets);

  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant, 'service', p_actor_identity, 'discovery.tenant_purged',
          jsonb_build_object('runId', v_counts->'runId') || v_deleted)
  returning id into v_audit;

  return jsonb_build_object(
    'runId', v_counts->'runId',
    'auditId', v_audit,
    'policy', jsonb_build_object('lifecycle', v_policy.lifecycle,
                                 'contentOnDisconnect', v_policy.content_on_disconnect,
                                 'indexOnDisconnect', v_policy.index_on_disconnect,
                                 'indexAtTenantEnd', v_policy.index_at_tenant_end),
    'deleted', v_deleted,
    'site', jsonb_build_object('before', v_site_before, 'after', discovery_tenant_site_counts(p_tenant)),
    'heldResidue', v_residue,
    'heldResidueCounts', v_residue_n,
    'policyKeptCounts', v_kept_n,
    'messageIndex', v_export);
end;
$$;
revoke all on function discovery_purge_tenant(uuid, text) from public, anon, authenticated, service_role;
