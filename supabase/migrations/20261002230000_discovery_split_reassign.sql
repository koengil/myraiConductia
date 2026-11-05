-- Deal discovery phase 8 (design R10, R11): split one proposed deal in two, and
-- move one email's link from a proposed deal to another. Two more corrections
-- on the append-only log of 20261002210000_discovery_corrections.sql, over the
-- same prelude (discovery_authorize_correction): the per-tenant discovery lock,
-- then the candidate's row lock, then visibility, then deal-create authority.
--
-- ADR-0017 decision 1: `before` and `after` name candidates (bank content).
-- Until the owner answers T11 (a) they hold synthetic data only (see the header
-- of 20261002210000_discovery_corrections.sql). The audit detail holds ids only.
--
-- How a decision survives a re-run. The upsert inserts links with
-- `on conflict (candidate_id, source_item_id) do nothing`, so a link a person
-- rejected stays rejected and a link a person confirmed stays confirmed. The
-- upsert therefore needs no change: the worker keeps routing an item to its
-- cluster, the original link stays rejected, and the item's evidence lives on
-- the candidate the MD chose. A split candidate's cluster key is
-- 'correction:<correction id>', which no classification run ever produces.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Split: some of a candidate's emails become a new proposed deal.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function discovery_split_candidate(
  p_candidate uuid, p_source_item_ids uuid[], p_name text, p_reason text
)
returns uuid language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare
  v         record;
  v_actor   uuid := auth.uid();
  v_corr    uuid := gen_random_uuid();
  v_new     uuid;
  v_items   uuid[];
  v_live    integer;
  v_rest    integer;
  v_first   timestamptz;
  v_last    timestamptz;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'invalid_name' using errcode = '22023'; end if;
  v_items := array(select distinct i from unnest(p_source_item_ids) as i where i is not null);
  if coalesce(cardinality(v_items), 0) = 0 then raise exception 'no_items' using errcode = '22023'; end if;

  select * into v from discovery_authorize_correction(p_candidate, v_actor);
  if v.state not in ('proposed', 'confirmed') then raise exception 'candidate_state' using errcode = '55000'; end if;

  -- Every chosen item must be one the caller can open (an unknown id and an item
  -- outside their reach answer alike), hold a live link on this candidate, and the
  -- candidate must keep at least one: a split that moves everything is a rename.
  if exists (select 1 from unnest(v_items) as i where not app_can_see_item(i, v_actor)) then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  select count(*) filter (where l.source_item_id = any (v_items)),
         count(*) filter (where not (l.source_item_id = any (v_items)))
    into v_live, v_rest
    from evidence_links l where l.candidate_id = p_candidate and l.state <> 'rejected';
  if v_live <> cardinality(v_items) then raise exception 'link_not_live' using errcode = '22023'; end if;
  if v_rest = 0 then raise exception 'nothing_left' using errcode = '22023'; end if;

  select min(si.sent_at), max(si.sent_at) into v_first, v_last from source_items si where si.id = any (v_items);
  insert into deal_candidates (tenant_id, cluster_key, proposed_name, parties, first_seen_at, last_seen_at, pinned)
  values (v.tenant_id, 'correction:' || v_corr, trim(p_name), '[]'::jsonb, v_first, v_last, true)
  returning id into v_new;

  -- The new candidate's links are confirmed by a person; the originals are rejected, so the
  -- upsert's `do nothing` keeps them off the original candidate.
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier, state, pinned_by_correction_id)
  select v_new, l.source_item_id, l.method, l.confidence, l.route_tier, 'confirmed', v_corr
    from evidence_links l
   where l.candidate_id = p_candidate and l.source_item_id = any (v_items) and l.state <> 'rejected';
  update evidence_links set state = 'rejected', pinned_by_correction_id = v_corr
   where candidate_id = p_candidate and source_item_id = any (v_items) and state <> 'rejected';

  perform discovery_refresh_candidate_visibility(p_candidate);
  perform discovery_refresh_candidate_visibility(v_new);
  -- A split whose result the caller could not open is refused, not left behind.
  if not app_can_see_candidate(v_new, v_actor) then raise exception 'not_visible_result' using errcode = '22023'; end if;

  insert into corrections (id, tenant_id, candidate_id, actor_id, action, before, after, reason)
  values (v_corr, v.tenant_id, p_candidate, v_actor, 'split',
          jsonb_build_object('name', v.proposed_name),
          jsonb_build_object('newCandidateId', v_new, 'newName', trim(p_name), 'itemCount', cardinality(v_items)),
          trim(p_reason));
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v.tenant_id, v_actor, 'user', 'discovery.correction',
          jsonb_build_object('candidateId', p_candidate, 'correctionId', v_corr, 'action', 'split', 'newCandidateId', v_new));
  insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
  values (v.tenant_id, p_candidate, 'correction'), (v.tenant_id, v_new, 'correction');
  return v_corr;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Reassign: one email's link moves from a proposed deal to another.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function discovery_reassign_link(p_link uuid, p_target_candidate uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare
  v_src     record;
  v_dst     record;
  v_link    record;
  v_actor   uuid := auth.uid();
  v_source  uuid;
  v_deal    uuid;
  v_corr    uuid;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_link is null or p_target_candidate is null then raise exception 'invalid_reassign' using errcode = '22023'; end if;

  -- Which candidate holds the link is immutable, so it can be read before the locks;
  -- the link's state is read again after them. An unknown link is simply not visible.
  select el.candidate_id into v_source from evidence_links el where el.id = p_link;
  if v_source is null then raise exception 'not_visible' using errcode = 'P0002'; end if;
  if v_source = p_target_candidate then raise exception 'invalid_reassign' using errcode = '22023'; end if;

  -- Under the tenant lock the order of the two row locks is moot.
  select * into v_src from discovery_authorize_correction(v_source, v_actor);
  select * into v_dst from discovery_authorize_correction(p_target_candidate, v_actor);
  if v_src.state not in ('proposed', 'confirmed') or v_dst.state not in ('proposed', 'confirmed') then
    raise exception 'candidate_state' using errcode = '55000';
  end if;

  select el.source_item_id, el.method, el.confidence, el.route_tier, el.state into v_link
    from evidence_links el where el.id = p_link and el.candidate_id = v_source for update;
  if not found then raise exception 'not_visible' using errcode = 'P0002'; end if;
  if v_link.state = 'rejected' then raise exception 'candidate_state' using errcode = '55000'; end if;
  -- The caller must be able to open the email they move: seeing the candidate is not enough.
  if not app_can_see_item(v_link.source_item_id, v_actor) then raise exception 'not_visible' using errcode = 'P0002'; end if;

  -- Q21: a promoted target gains only items whose owner is seated on its deal.
  select dc.promoted_deal_id into v_deal from deal_candidates dc where dc.id = p_target_candidate;
  if v_deal is not null and not discovery_item_owner_seated(v_link.source_item_id, v_deal) then
    raise exception 'owner_not_seated' using errcode = '42501';
  end if;

  insert into corrections (tenant_id, candidate_id, actor_id, action, before, after, reason)
  values (v_src.tenant_id, v_source, v_actor, 'reassign',
          jsonb_build_object('name', v_src.proposed_name, 'linkId', p_link, 'sourceItemId', v_link.source_item_id),
          jsonb_build_object('targetCandidateId', p_target_candidate, 'targetName', v_dst.proposed_name),
          trim(p_reason))
  returning id into v_corr;

  update evidence_links set state = 'rejected', pinned_by_correction_id = v_corr where id = p_link;
  -- A link the target already holds (even a rejected one) becomes the MD's confirmed choice.
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier, state, pinned_by_correction_id)
  values (p_target_candidate, v_link.source_item_id, v_link.method, v_link.confidence, v_link.route_tier, 'confirmed', v_corr)
  on conflict (candidate_id, source_item_id)
  do update set state = 'confirmed', pinned_by_correction_id = excluded.pinned_by_correction_id;

  perform discovery_refresh_candidate_visibility(v_source);
  perform discovery_refresh_candidate_visibility(p_target_candidate);

  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_src.tenant_id, v_actor, 'user', 'discovery.correction',
          jsonb_build_object('candidateId', v_source, 'correctionId', v_corr, 'action', 'reassign',
                             'targetCandidateId', p_target_candidate));
  insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
  values (v_src.tenant_id, v_source, 'correction'), (v_src.tenant_id, p_target_candidate, 'correction');
  return v_corr;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Grants. Both are the banker's own session; each acts on auth.uid().
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function
  discovery_split_candidate(uuid, uuid[], text, text), discovery_reassign_link(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function
  discovery_split_candidate(uuid, uuid[], text, text), discovery_reassign_link(uuid, uuid, text)
  to authenticated;
