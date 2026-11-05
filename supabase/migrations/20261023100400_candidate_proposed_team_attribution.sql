-- supabase/migrations/20261023100400_candidate_proposed_team_attribution.sql
-- #173 G-03, slice 4/4: a candidate firm rules create from team inbox mail names those inboxes in its audit row.
--
-- discovery.candidate_proposed gains one key, written when the candidate is created: teamMailboxIds, the distinct
-- team_mailboxes ids, sorted, of the content sources that hold the new candidate's evidence (evidence_links ->
-- source_item_sources -> content_sources.team_mailbox_id). Ids only: no address, name, codename or party. The key is
-- omitted when no evidence came from a team inbox, so a personal-only candidate's row is what it was. The firm's
-- audit read (20261023100300, discovery_team_mailbox_audit, branch B2) matches `detail -> 'teamMailboxIds' ?| M`,
-- an array of uuid strings; it has matched nothing until now.
--
-- Why at creation (design R17): in the same call the links are inserted before they are counted and before the row
-- is written, so the ids are exactly the evidence that formed the proposal, recorded in the row that already exists,
-- with no new audit action. Limits: a candidate created before this migration carries no attribution; team evidence
-- added later to an existing candidate is not recorded (thread T4); the trail shows evidenceCount, never a name.
--
-- Restated whole from 20261002210000_discovery_corrections.sql:325-451, the latest of its three definitions
-- (20260925120000 and 20260929150000 came before). Same signature, language and security; no grant or revoke here:
-- create or replace keeps the service_role-only ACL of 20261002210000:472-473. Two changes:
--   - the teamMailboxIds expression in the `if v_created` audit insert (and its v_team variable);
--   - the header spells `set search_path = public, pg_temp`, the path the function already runs with since
--     20261016100000 re-pinned every definer. Spelling the old `= public` would reset it, and
--     supabase/tests/definer_grants.sql fails a definer without it.
-- Lock order unchanged: the tenant's discovery lock first, the candidate rows, visibility, then audit (whose chain
-- trigger takes the audit lock). The new read takes no row lock and touches only evidence_links, source_item_sources
-- and content_sources, which discovery_refresh_candidate_visibility already reads in the same call, so
-- tests/db/team-mailbox-lock-order.test.ts holds as it is.

create or replace function discovery_upsert_candidates(
  p_tenant_id uuid,
  p_run_id uuid,
  p_groups jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group          jsonb;
  v_id             uuid;
  v_state          text;
  v_pinned         boolean;
  v_merged_into    uuid;
  v_deal           uuid;
  v_target         uuid;
  v_survivor_state text;
  v_created        boolean;
  v_links          integer;
  v_team           jsonb;
  v_result         jsonb := '[]'::jsonb;
begin
  if p_tenant_id is null or p_run_id is null then
    raise exception 'discovery_upsert_candidates: tenant and run are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_groups, '[]'::jsonb)) <> 'array' then
    raise exception 'discovery_upsert_candidates: groups must be an array'
      using errcode = '22023';
  end if;

  perform discovery_lock_tenant(p_tenant_id);

  for v_group in select value from jsonb_array_elements(coalesce(p_groups, '[]'::jsonb)) loop
    v_id := null;
    v_created := false;
    v_target := null;
    v_survivor_state := null;

    insert into deal_candidates (
      tenant_id, cluster_key, proposed_name, codename_guess, parties,
      first_seen_at, last_seen_at, confidence, discovery_run_id
    ) values (
      p_tenant_id,
      v_group->>'clusterKey',
      v_group->>'proposedName',
      v_group->>'codenameGuess',
      coalesce(v_group->'parties', '[]'::jsonb),
      (v_group->>'firstSeenAt')::timestamptz,
      (v_group->>'lastSeenAt')::timestamptz,
      (v_group->>'confidence')::numeric,
      p_run_id
    )
    on conflict (tenant_id, cluster_key) do nothing
    returning id into v_id;

    if v_id is not null then
      v_created := true;
      v_state := 'proposed';
      v_pinned := false;
      v_merged_into := null;
      v_deal := null;
    else
      select id, discovery_state, pinned, merged_into_id, promoted_deal_id
        into v_id, v_state, v_pinned, v_merged_into, v_deal
      from deal_candidates
      where tenant_id = p_tenant_id and cluster_key = v_group->>'clusterKey'
      for update;

      if v_state = 'proposed' and not v_pinned then
        update deal_candidates set
          proposed_name    = v_group->>'proposedName',
          codename_guess   = v_group->>'codenameGuess',
          parties          = coalesce(v_group->'parties', '[]'::jsonb),
          first_seen_at    = least(first_seen_at, (v_group->>'firstSeenAt')::timestamptz),
          last_seen_at     = greatest(last_seen_at, (v_group->>'lastSeenAt')::timestamptz),
          confidence       = (v_group->>'confidence')::numeric,
          discovery_run_id = p_run_id
        where id = v_id;
      end if;
    end if;

    -- Where this group's new evidence lands.
    v_target := case v_state
      when 'proposed'    then v_id
      when 'confirmed'   then v_id
      when 'merged_into' then v_merged_into
      else null                                   -- rejected: nothing
    end;
    if v_state = 'merged_into' then
      select discovery_state, promoted_deal_id into v_survivor_state, v_deal
      from deal_candidates where id = v_merged_into for update;
      if v_survivor_state is null or v_survivor_state not in ('proposed', 'confirmed') then v_target := null; end if;
    end if;

    if v_target is not null then
      -- Only items of this tenant can become evidence.
      insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier)
      select v_target, si.id, link->>'method', (link->>'confidence')::numeric, 'firm'
      from jsonb_array_elements(coalesce(v_group->'links', '[]'::jsonb)) as link
      join source_items si on si.id = (link->>'sourceItemId')::uuid and si.tenant_id = p_tenant_id
      where v_deal is null or discovery_item_owner_seated(si.id, v_deal)            -- Q21
      on conflict (candidate_id, source_item_id) do nothing;

      perform discovery_refresh_candidate_visibility(v_target);
    end if;

    if v_created then
      select count(*) into v_links from evidence_links where candidate_id = v_id;
      -- #173 G-03: the team inboxes whose mail formed it, ids only, sorted and distinct; no key when none did.
      select coalesce(jsonb_agg(distinct cs.team_mailbox_id order by cs.team_mailbox_id), '[]'::jsonb) into v_team
      from evidence_links el
      join source_item_sources sis on sis.source_item_id = el.source_item_id
      join content_sources cs on cs.id = sis.content_source_id
      where el.candidate_id = v_id and cs.team_mailbox_id is not null;
      -- No codename, name or party in detail: overseers (admin included) read
      -- audit_log, and a firm admin sees no candidate content (Q19).
      insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
      values (
        p_tenant_id, 'service', 'discovery-worker', 'discovery.candidate_proposed',
        jsonb_build_object('candidateId', v_id, 'runId', p_run_id, 'evidenceCount', v_links)
        || case when v_team = '[]'::jsonb then '{}'::jsonb else jsonb_build_object('teamMailboxIds', v_team) end
      );
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'clusterKey', v_group->>'clusterKey', 'candidateId', v_id, 'created', v_created
    ));
  end loop;

  return v_result;
end;
$$;
