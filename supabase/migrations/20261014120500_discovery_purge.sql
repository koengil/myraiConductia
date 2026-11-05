-- #461: deleting a banker's stored mail when their consent ends (owner
-- decision 2026-10-13, Ignatious G0). Withdrawal used to stop reads and keep
-- everything stored; now it deletes.
--
-- Mail lives in a tenant-wide store, deduplicated per Message-ID, and a mailbox
-- owns only its provenance (source_item_sources), its ledger (routing_ledger)
-- and its thread taints. Deletion is therefore two steps:
--   1. Detach: delete the banker's content_sources row. Its three existing
--      cascades remove the provenance, ledger and taint rows.
--   2. Collect: delete every stored message no mailbox holds any more (texts,
--      evidence, milestones and model calls cascade), then every candidate left
--      with no evidence (visibility, assessments and recompute requests cascade).
-- A message a colleague's mailbox also holds keeps its provenance row, so it
-- survives with everything derived from it. No reference count is kept.
--
-- Every path that ends a consent (the withdraw RPC, the seat-loss trigger, the
-- invite-delete trigger) funnels through one UPDATE of withdrawn_at, so one
-- trigger on that update covers all of them.
--
-- Document items (SharePoint site content) are out of G0's scope and are never
-- collected. A candidate a document still evidences survives, loses its mail
-- evidence and the assessments that cite a deleted milestone, and is rebased
-- on what remains. Anything evidencing a deal under legal hold is skipped and
-- counted.
--
-- 1. audit_log_action_check restated in full from
--    20261006120000_discovery_reader_pass.sql, plus discovery.mailbox_purged.
-- 2. The correction log's guard opens for DELETE inside a purge only; a page
--    in flight when its source is purged is refused like an archived one's.
-- 3. discovery_purge_identifiers: the one delete of a mailbox's per-message
--    identifiers (its source row, provenance, ledger and taints).
-- 4. discovery_collect_orphans: the collector, service_role only.
-- 5. discovery_purge_mailbox: one consent's purge, called by the trigger only.
-- 6. The triggers on mailbox_consents.

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
  'discovery.reader_pass_started', 'discovery.reader_pass_finished', 'discovery.mailbox_purged'
])) not valid;

-- ── 2. The correction log opens for a purge's DELETE only ──────────────────
-- A candidate with any correction cannot be deleted (NO ACTION FK), and
-- corrections carry candidate names, which are mail-derived. The purge sets
-- conductia.discovery_purge transaction-locally around its deletes. Only a
-- postgres-owned purge function reaches this branch: service_role is meant to
-- hold select and insert only (20261002210000_discovery_corrections.sql), but
-- the platform's default privileges had given it every table privilege, so the
-- revoke below makes that true. Setting the GUC from a client then deletes
-- nothing. UPDATE and TRUNCATE stay refused for every role.
create or replace function corrections_block_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('conductia.discovery_purge', true), '') <> '' then
    return old;
  end if;
  raise exception 'the correction log is append-only: % is not permitted', tg_op;
end;
$$;
revoke update, delete, truncate on corrections from service_role;

-- A page in flight when its source is purged. The worker reads a page, then
-- writes its items and their provenance; a withdrawal can commit in between.
-- The provenance link to the deleted source is refused the way a link to an
-- archived one is (source_archived, P0001,
-- 20261001130000_mailbox_allowlist.sql), so the worker skips the source
-- instead of failing the job. The page's new items hold no provenance, and the
-- collector deletes them as orphans.
create or replace function source_item_sources_refuse_archived()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_archived timestamptz;
begin
  select cs.archived_at into v_archived from content_sources cs where cs.id = new.content_source_id for key share;
  if not found or v_archived is not null then
    raise exception 'source_archived' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- ── 3. A mailbox's identifiers ─────────────────────────────────────────────
-- The only place a purge deletes per-message identifiers (design entry 22):
-- the mailbox's content_sources row, whose source_item_sources, routing_ledger
-- and discovery_thread_taints rows cascade. Returns their counts. Changing
-- what a purge's identifiers are is a change to this function alone.
-- p_policy is the tenant's retention policy, which a later migration reads;
-- nothing reads it yet. Called by the purge functions only (no grant).
create or replace function discovery_purge_identifiers(p_tenant uuid, p_source uuid, p_policy jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prov   integer;
  v_ledger integer;
  v_taints integer;
begin
  if not exists (select 1 from content_sources
                 where id = p_source and tenant_id = p_tenant and kind = 'mailbox') then
    raise exception 'discovery_purge_identifiers: not a mailbox source of the tenant' using errcode = '22023';
  end if;
  select count(*) into v_prov from source_item_sources where content_source_id = p_source;
  select count(*) into v_ledger from routing_ledger where source_id = p_source;
  select count(*) into v_taints from discovery_thread_taints where source_id = p_source;
  delete from content_sources where id = p_source;
  return jsonb_build_object('provenance', v_prov, 'ledger', v_ledger, 'taints', v_taints);
end;
$$;
revoke all on function discovery_purge_identifiers(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- ── 4. The collector ───────────────────────────────────────────────────────
-- Deletes the tenant's stored messages that no mailbox holds, then the
-- candidates left with no evidence. Returns the run id and the counts.
--
-- p_min_age guards an in-flight page: the worker writes an item before its
-- provenance, in separate statements, so a fresh item with no provenance yet is
-- not an orphan. p_detached names items whose provenance the caller has just
-- deleted itself (the purge of one mailbox): those are orphans at once, whatever
-- their age. Only messages are collected: a document item is SharePoint site
-- content, out of G0's scope, and is never deleted here.
--
-- Order:
--   held       candidates promoted to a deal under legal hold; an item that
--              evidences one is kept and counted (heldSkipped), and retried on
--              the next run
--   items      deleted; texts, evidence, milestones and model calls cascade
--   assessments of surviving candidates that cite a deleted milestone event
--   empty      candidates this run's deletions left with no evidence (at tenant
--              end, min age zero, every linkless one), not held
--   rebase     survivors that lost a link: parties, seen dates and confidence
--              from the remaining evidence. With no link discovery routed left,
--              the name has no support: codename_guess null, cluster_key
--              'purged:<id>', proposed_name 'Unnamed candidate' unless the MD
--              typed it (a rename to it, or a split that created it)
--   corrections of empty candidates, and those that name a deleted or an
--              unsupported candidate (the correction log's guard opens for this)
--   un-merge   a candidate merged into an empty one becomes proposed again
--   delete     empty candidates; visibility, assessments and recompute cascade
--
-- Takes the tenant's discovery lock first, like every writer of candidate rows.
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
begin
  if p_tenant is null then
    raise exception 'discovery_collect_orphans: tenant is required' using errcode = '22023';
  end if;
  if p_min_age is null or p_min_age < interval '0' then
    raise exception 'discovery_collect_orphans: min age must be zero or more' using errcode = '22023';
  end if;
  perform discovery_lock_tenant(p_tenant);

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

-- ── 5. One consent's purge ─────────────────────────────────────────────────
-- Called by the mailbox_consents_purge trigger only (no grant). The source is the
-- consent owner's own mailbox source for the address: an archived row (renamed
-- <address>~xyz, ownerless) is an earlier holder's history and is not touched.
-- Nothing happens, and nothing is audited, when there is no such source or the
-- same user still holds another open consent for the address.
--
-- The audit row names the source, the consent, the reason, the collector's run
-- and the counts. The address is already in the consent rows; no Message-ID or
-- content is written.
create or replace function discovery_purge_mailbox(p_consent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_consent  mailbox_consents%rowtype;
  v_source   uuid;
  v_items    uuid[];
  v_touched  uuid[];
  v_counts   jsonb;
  v_reason   text;
  v_by_owner boolean;
  v_cand     uuid;
begin
  select * into v_consent from mailbox_consents where id = p_consent_id;
  if not found or v_consent.withdrawn_at is null then
    return null;
  end if;
  -- Lock order: the tenant's discovery lock, then the source row (the BEFORE
  -- trigger has taken both already; taking them again is a no-op).
  perform discovery_lock_tenant(v_consent.tenant_id);
  select cs.id into v_source from content_sources cs
  where cs.tenant_id = v_consent.tenant_id and cs.kind = 'mailbox'
    and lower(cs.address) = v_consent.address and cs.owner_user_id = v_consent.user_id
  for update;
  if v_source is null then
    return null;
  end if;
  if exists (select 1 from mailbox_consents o
             where o.tenant_id = v_consent.tenant_id and o.user_id = v_consent.user_id
               and o.address = v_consent.address and o.withdrawn_at is null) then
    return null;
  end if;

  -- The reason and the actor, as mailbox_consents_audit states them.
  v_reason := coalesce(nullif(current_setting('conductia.mailbox_withdraw_reason', true), ''),
    case when exists (select 1 from mailbox_seated_invites s where s.invite_id = v_consent.invite_id)
         then 'withdrawn' else 'seat_lost' end);
  v_by_owner := auth.uid() is not null and auth.uid() = v_consent.user_id;

  select coalesce(array_agg(distinct l.candidate_id) filter (where l.candidate_id is not null), '{}'::uuid[])
    into v_touched
  from evidence_links l
  where l.source_item_id in (select s.source_item_id from source_item_sources s where s.content_source_id = v_source);
  select coalesce(array_agg(s.source_item_id), '{}'::uuid[]) into v_items
  from source_item_sources s where s.content_source_id = v_source;

  -- Detach: provenance, ledger and taints cascade.
  v_counts := discovery_purge_identifiers(v_consent.tenant_id, v_source);

  -- Collect: this source's items are orphans at once; anyone else's keep the
  -- in-flight guard.
  v_counts := v_counts || discovery_collect_orphans(v_consent.tenant_id, interval '15 minutes', v_items);

  -- The owner no longer sees the candidates their mailbox backed.
  foreach v_cand in array v_touched loop
    if exists (select 1 from deal_candidates where id = v_cand) then
      perform discovery_refresh_candidate_visibility(v_cand);
    end if;
  end loop;

  insert into audit_log (tenant_id, actor_id, actor_type, service_identity, action, detail)
  values (v_consent.tenant_id,
          case when v_by_owner then v_consent.user_id end,
          case when v_by_owner then 'user' else 'service' end,
          case when v_by_owner then null else 'mailbox-consent' end,
          'discovery.mailbox_purged',
          jsonb_build_object('sourceId', v_source, 'consentId', v_consent.id, 'reason', v_reason) || v_counts);
  return v_counts;
end;
$$;
revoke all on function discovery_purge_mailbox(uuid) from public, anon, authenticated, service_role;

-- ── 6. The triggers ────────────────────────────────────────────────────────
-- One function, two triggers on the one update that ends a consent.
--   BEFORE  takes the tenant's discovery lock and the source row. Every other
--           writer of candidates takes the discovery lock before the audit
--           chain's; mailbox_consents_audit (AFTER) takes the chain's, so the
--           purge must hold its own locks before that trigger runs.
--   AFTER   runs the purge. Row triggers fire at the end of the statement, so a
--           user's other consents closed by the same update are already closed.
create or replace function mailbox_consents_purge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_when = 'BEFORE' then
    perform discovery_lock_tenant(new.tenant_id);
    perform 1 from content_sources cs
    where cs.tenant_id = new.tenant_id and cs.kind = 'mailbox'
      and lower(cs.address) = new.address and cs.owner_user_id = new.user_id
    for update;
    return new;
  end if;
  perform discovery_purge_mailbox(new.id);
  return null;
end;
$$;
revoke all on function mailbox_consents_purge() from public, anon, authenticated, service_role;

drop trigger if exists mailbox_consents_purge_lock on mailbox_consents;
create trigger mailbox_consents_purge_lock
  before update of withdrawn_at on mailbox_consents
  for each row when (old.withdrawn_at is null and new.withdrawn_at is not null)
  execute function mailbox_consents_purge();

drop trigger if exists mailbox_consents_purge on mailbox_consents;
create trigger mailbox_consents_purge
  after update of withdrawn_at on mailbox_consents
  for each row when (old.withdrawn_at is null and new.withdrawn_at is not null)
  execute function mailbox_consents_purge();
