-- #249: discovery_upsert_candidates read an existing candidate's state and
-- pinned flag without a lock, then refreshed it and attached links. A person
-- confirming or pinning the candidate between that read and the write was
-- overwritten. The read now takes the row lock (FOR UPDATE), so the run waits
-- for the person's update and sees the decision. Body otherwise unchanged
-- from 20260925120000_discovery_core.sql.

create or replace function discovery_upsert_candidates(
  p_tenant_id uuid,
  p_run_id uuid,
  p_groups jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group     jsonb;
  v_id        uuid;
  v_state     text;
  v_pinned    boolean;
  v_created   boolean;
  v_links     integer;
  v_result    jsonb := '[]'::jsonb;
begin
  if p_tenant_id is null or p_run_id is null then
    raise exception 'discovery_upsert_candidates: tenant and run are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_groups, '[]'::jsonb)) <> 'array' then
    raise exception 'discovery_upsert_candidates: groups must be an array'
      using errcode = '22023';
  end if;

  for v_group in select value from jsonb_array_elements(coalesce(p_groups, '[]'::jsonb)) loop
    v_id := null;
    v_created := false;

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
    else
      select id, discovery_state, pinned into v_id, v_state, v_pinned
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

    if v_state = 'proposed' and not v_pinned then
      -- Only items of this tenant can become evidence.
      insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier)
      select v_id, si.id, link->>'method', (link->>'confidence')::numeric, 'firm'
      from jsonb_array_elements(coalesce(v_group->'links', '[]'::jsonb)) as link
      join source_items si on si.id = (link->>'sourceItemId')::uuid and si.tenant_id = p_tenant_id
      on conflict (candidate_id, source_item_id) do nothing;

      perform discovery_refresh_candidate_visibility(v_id);
    end if;

    if v_created then
      select count(*) into v_links from evidence_links where candidate_id = v_id;
      -- No codename, name or party in detail: overseers (admin included) read
      -- audit_log, and a firm admin sees no candidate content (Q19).
      insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
      values (
        p_tenant_id, 'service', 'discovery-worker', 'discovery.candidate_proposed',
        jsonb_build_object('candidateId', v_id, 'runId', p_run_id, 'evidenceCount', v_links)
      );
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'clusterKey', v_group->>'clusterKey', 'candidateId', v_id, 'created', v_created
    ));
  end loop;

  return v_result;
end;
$$;

revoke all on function discovery_upsert_candidates(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_upsert_candidates(uuid, uuid, jsonb) to service_role;
