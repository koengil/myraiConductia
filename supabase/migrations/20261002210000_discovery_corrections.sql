-- Deal discovery phase 7 (design R10, R11, R12): the MD's corrections to a
-- proposed deal. Rename, reject, set station and merge are append-only rows in
-- `corrections` over materialized columns on deal_candidates, so a re-run of
-- the classification worker never undoes a decision.
--
-- ADR-0017 decision 1: `before` and `after` name candidates (bank content).
-- Until the owner answers T11 (a) they hold synthetic data only: a real bank's
-- mailbox cannot connect before decision 2's gate, and a real bank's
-- extraction also needs DISCOVERY_OUTPUT_PLACEMENT_APPROVED, which ships false
-- (src/lib/modelGateway/processorGate.ts).
--
-- Who writes. A signed-in banker calls one of four definer RPCs, each of which
-- acts on auth.uid() and checks tenant, visibility and deal-create authority
-- itself, inside the same transaction as the row, its audit row and the
-- recompute request. The worker's writers (the upsert) learn pinned, merged
-- and confirmed candidates below.
--
-- Lock order (design "Lock order"). Every writer of candidate rows takes the
-- per-tenant discovery lock first (discovery_lock_tenant), then row locks on
-- deal_candidates, then whatever the audit chain takes ('audit_log:<tenant>'
-- inside the audit trigger). One order everywhere, so two writers queue and
-- never deadlock.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. corrections: append-only, read under RLS with the candidate
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists corrections (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  candidate_id uuid not null references deal_candidates (id),
  actor_id     uuid not null references users (id),
  action       text not null check (action in ('rename', 'reject', 'set_station', 'merge', 'split', 'reassign',
                                               'confirm_link', 'reject_link', 'promote', 'dismiss_suggestion')),
  before       jsonb,
  after        jsonb,
  reason       text,
  created_at   timestamptz not null default now()
);

create index if not exists corrections_candidate_idx on corrections (candidate_id, created_at);

-- The log never changes: no update, no delete, no truncate, for any role.
create or replace function corrections_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'the correction log is append-only: % is not permitted', tg_op;
end;
$$;
create trigger corrections_no_update_delete before update or delete on corrections
  for each row execute function corrections_block_mutation();
create trigger corrections_no_truncate before truncate on corrections
  for each statement execute function corrections_block_mutation();

alter table corrections enable row level security;
revoke all on corrections from anon, authenticated;
grant select, insert on corrections to service_role;
grant select on corrections to authenticated;
create policy corrections_select on corrections for select to authenticated
  using (app_can_see_candidate(candidate_id, auth.uid()));

alter table deal_candidates
  add column if not exists station_override_step_id text,
  add column if not exists station_override_correction_id uuid references corrections (id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Lock, seat filter and the shared prelude. Granted to nobody but service_role.
-- ─────────────────────────────────────────────────────────────────────────────

-- The one per-tenant discovery write lock. Distinct from the audit chain's
-- 'audit_log:<tenant>' key.
create or replace function discovery_lock_tenant(p_tenant_id uuid) returns void
language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtextextended('discovery_candidates:' || p_tenant_id::text, 0));
$$;

-- Q21: a promoted deal gains only items whose owner is seated on it. The seat
-- is the same predicate as app_is_deal_member's body, inlined so a later caller
-- guard on that helper cannot change it. The owner must also still be reading:
-- the source's mailbox is on allowed_mailboxes, joined the way app_owns_item
-- does (#262), so an owner who withdrew consent or lost their seat to the firm
-- cannot carry an item onto the deal.
create or replace function discovery_item_owner_seated(p_item uuid, p_deal uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from source_item_sources sis
    join source_items si on si.id = sis.source_item_id
    join content_sources cs on cs.id = sis.content_source_id and cs.kind = 'mailbox' and cs.tenant_id = si.tenant_id
    join allowed_mailboxes a on a.tenant_id = cs.tenant_id and a.address = lower(cs.address)
                            and a.user_id = cs.owner_user_id and a.provider = cs.provider
    join deal_memberships dm on dm.user_id = cs.owner_user_id and dm.deal_id = p_deal
    where sis.source_item_id = p_item
  );
$$;

-- Shared prelude: the tenant lock, then the row lock, then visibility and
-- authority. Not granted; only the four correction RPCs call it.
create or replace function discovery_authorize_correction(p_candidate uuid, p_actor uuid)
returns table (tenant_id uuid, bank_id uuid, state text, proposed_name text, override_step text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tenant uuid;
  v_bank   uuid;
begin
  if p_actor is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select dc.tenant_id into v_tenant from deal_candidates dc where dc.id = p_candidate;   -- immutable column
  if v_tenant is null or v_tenant is distinct from (select u.tenant_id from users u where u.id = p_actor) then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  perform discovery_lock_tenant(v_tenant);
  perform 1 from deal_candidates dc where dc.id = p_candidate for update;
  if not app_can_see_candidate(p_candidate, p_actor) then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  select c.id into v_bank from companies c
   where c.tenant_id = v_tenant and c.type = 'bank' order by c.created_at limit 1;
  if v_bank is null or not app_can_create_deals(p_actor, v_bank) then
    raise exception 'no_authority' using errcode = '42501';
  end if;
  return query
    select v_tenant, v_bank, dc.discovery_state, dc.proposed_name, dc.station_override_step_id
    from deal_candidates dc where dc.id = p_candidate;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The four corrections. Each acts on auth.uid(); none takes an actor argument.
--    Audit detail holds ids only, never a name (a firm admin reads audit_log and
--    sees no candidate content, Q19).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function discovery_rename_candidate(p_candidate uuid, p_name text, p_reason text default null)
returns uuid language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare
  v      record;
  v_actor uuid := auth.uid();
  v_corr  uuid;
begin
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  select * into v from discovery_authorize_correction(p_candidate, v_actor);
  if v.state not in ('proposed', 'confirmed') then raise exception 'candidate_state' using errcode = '55000'; end if;

  insert into corrections (tenant_id, candidate_id, actor_id, action, before, after, reason)
  values (v.tenant_id, p_candidate, v_actor, 'rename', jsonb_build_object('name', v.proposed_name),
          jsonb_build_object('name', trim(p_name)), nullif(trim(p_reason), ''))
  returning id into v_corr;
  update deal_candidates set proposed_name = trim(p_name), pinned = true where id = p_candidate;   -- a rename pins (R11)
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v.tenant_id, v_actor, 'user', 'discovery.correction',
          jsonb_build_object('candidateId', p_candidate, 'correctionId', v_corr, 'action', 'rename'));
  insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
  values (v.tenant_id, p_candidate, 'correction');
  return v_corr;
end;
$$;

create or replace function discovery_reject_candidate(p_candidate uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare
  v      record;
  v_actor uuid := auth.uid();
  v_corr  uuid;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into v from discovery_authorize_correction(p_candidate, v_actor);
  if v.state <> 'proposed' then raise exception 'candidate_state' using errcode = '55000'; end if;

  insert into corrections (tenant_id, candidate_id, actor_id, action, before, after, reason)
  values (v.tenant_id, p_candidate, v_actor, 'reject', jsonb_build_object('state', v.state),
          jsonb_build_object('state', 'rejected'), trim(p_reason))
  returning id into v_corr;
  update deal_candidates set discovery_state = 'rejected' where id = p_candidate;
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v.tenant_id, v_actor, 'user', 'discovery.correction',
          jsonb_build_object('candidateId', p_candidate, 'correctionId', v_corr, 'action', 'reject'));
  -- No recompute request: a rejected candidate is not assessed.
  return v_corr;
end;
$$;

create or replace function discovery_set_station(p_candidate uuid, p_step_id text, p_reason text)
returns uuid language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare
  v         record;
  v_actor   uuid := auth.uid();
  v_corr    uuid;
  v_suggest text;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_step_id is null or p_step_id !~ '^p[1-5]-s[0-9]+$' then raise exception 'invalid_step' using errcode = '22023'; end if;
  select * into v from discovery_authorize_correction(p_candidate, v_actor);
  if v.state not in ('proposed', 'confirmed') then raise exception 'candidate_state' using errcode = '55000'; end if;

  -- What the evidence suggested when the MD chose, so the history can say what changed.
  select sa.step_id into v_suggest from stage_assessments sa
   where sa.candidate_id = p_candidate order by sa.as_of desc, sa.id desc limit 1;
  insert into corrections (tenant_id, candidate_id, actor_id, action, before, after, reason)
  values (v.tenant_id, p_candidate, v_actor, 'set_station',
          jsonb_build_object('stepId', v.override_step, 'suggestedStepId', v_suggest),
          jsonb_build_object('stepId', p_step_id), trim(p_reason))
  returning id into v_corr;
  update deal_candidates
     set station_override_step_id = p_step_id, station_override_correction_id = v_corr, pinned = true
   where id = p_candidate;
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v.tenant_id, v_actor, 'user', 'discovery.correction',
          jsonb_build_object('candidateId', p_candidate, 'correctionId', v_corr, 'action', 'set_station'));
  insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
  values (v.tenant_id, p_candidate, 'correction');
  return v_corr;
end;
$$;

create or replace function discovery_merge_candidates(p_merged uuid, p_survivor uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare
  v_m      record;
  v_s      record;
  v_actor  uuid := auth.uid();
  v_corr   uuid;
  v_deal   uuid;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_merged is null or p_survivor is null or p_merged = p_survivor then
    raise exception 'invalid_merge' using errcode = '22023';
  end if;
  -- Under the tenant lock the order of the two row locks is moot.
  select * into v_m from discovery_authorize_correction(p_merged, v_actor);
  select * into v_s from discovery_authorize_correction(p_survivor, v_actor);
  if v_m.state <> 'proposed' or v_s.state not in ('proposed', 'confirmed') then
    raise exception 'candidate_state' using errcode = '55000';
  end if;

  select dc.promoted_deal_id into v_deal from deal_candidates dc where dc.id = p_survivor;
  -- The merged candidate's links join the survivor's (the originals stay), and a
  -- promoted survivor gains only items whose owner is seated on its deal (Q21).
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier, state)
  select p_survivor, l.source_item_id, l.method, l.confidence, l.route_tier, l.state
  from evidence_links l
  where l.candidate_id = p_merged
    and (v_deal is null or discovery_item_owner_seated(l.source_item_id, v_deal))
  on conflict (candidate_id, source_item_id) do nothing;

  -- Anything already merged into this candidate follows it to the survivor.
  update deal_candidates set merged_into_id = p_survivor
   where merged_into_id = p_merged and discovery_state = 'merged_into';
  update deal_candidates set discovery_state = 'merged_into', merged_into_id = p_survivor where id = p_merged;
  update deal_candidates s
     set first_seen_at = least(s.first_seen_at, m.first_seen_at),
         last_seen_at  = greatest(s.last_seen_at, m.last_seen_at)
    from deal_candidates m
   where s.id = p_survivor and m.id = p_merged;
  perform discovery_refresh_candidate_visibility(p_survivor);

  insert into corrections (tenant_id, candidate_id, actor_id, action, before, after, reason)
  values (v_m.tenant_id, p_merged, v_actor, 'merge',
          jsonb_build_object('state', v_m.state, 'name', v_m.proposed_name),
          jsonb_build_object('survivorId', p_survivor, 'survivorName', v_s.proposed_name), trim(p_reason))
  returning id into v_corr;
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_m.tenant_id, v_actor, 'user', 'discovery.correction',
          jsonb_build_object('candidateId', p_merged, 'correctionId', v_corr, 'action', 'merge', 'survivorId', p_survivor));
  insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
  values (v_m.tenant_id, p_survivor, 'correction');
  return v_corr;
end;
$$;

-- Read-only: null when the caller may act on the candidate, else why not. The
-- page shows the reason instead of a button that would fail. p_action names what
-- the caller is about to do: 'promote', 'reject' and 'merge' end the proposal, so
-- they also need a candidate that is proposed and not yet promoted (a promoted
-- candidate is 'confirmed' with promoted_deal_id set, and keeps the corrections
-- that leave it standing: rename, set station, split and reassign). Null judges
-- the candidate for those.
drop function if exists discovery_correction_authority(uuid);
create or replace function discovery_correction_authority(p_candidate uuid, p_action text default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_actor  uuid := auth.uid();
  v_tenant uuid;
  v_state  text;
  v_deal   uuid;
  v_bank   uuid;
begin
  if p_action is not null and p_action not in ('rename', 'station', 'split', 'reassign', 'promote', 'reject', 'merge') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if v_actor is null then return 'not_visible'; end if;
  select dc.tenant_id, dc.discovery_state, dc.promoted_deal_id into v_tenant, v_state, v_deal
    from deal_candidates dc where dc.id = p_candidate;
  if v_tenant is null or v_tenant is distinct from (select u.tenant_id from users u where u.id = v_actor) then
    return 'not_visible';
  end if;
  if not app_can_see_candidate(p_candidate, v_actor) then return 'not_visible'; end if;
  select c.id into v_bank from companies c
   where c.tenant_id = v_tenant and c.type = 'bank' order by c.created_at limit 1;
  if v_bank is null or not app_can_create_deals(v_actor, v_bank) then return 'no_authority'; end if;
  if v_state not in ('proposed', 'confirmed') then return 'candidate_state'; end if;
  if p_action in ('promote', 'reject', 'merge') and (v_state <> 'proposed' or v_deal is not null) then
    return 'candidate_state';
  end if;
  return null;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The upsert learns pinned, merged and confirmed candidates. Starts from
--    20260929150000_discovery_upsert_lock.sql (the row lock of #286 stays);
--    #262 does not redefine it. What changes:
--      - the tenant lock is the first writer statement;
--      - a pinned proposed candidate keeps gaining links (a rename pins);
--      - a merged candidate's new evidence lands on its survivor, without
--        refreshing the survivor's name or other metadata;
--      - a confirmed candidate gains links too, and a promoted one only items
--        whose owner is seated on its deal (Q21);
--      - a rejected candidate gains nothing.
--    Metadata is refreshed only for a proposed, unpinned candidate, as before.
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Grants. The four corrections and the authority read are the browser
--    role's; each acts on auth.uid(). The rest stay service-role only.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function
  discovery_lock_tenant(uuid), discovery_item_owner_seated(uuid, uuid), discovery_authorize_correction(uuid, uuid),
  discovery_rename_candidate(uuid, text, text), discovery_reject_candidate(uuid, text),
  discovery_set_station(uuid, text, text), discovery_merge_candidates(uuid, uuid, text),
  discovery_correction_authority(uuid, text), corrections_block_mutation()
  from public, anon, authenticated;
grant execute on function
  discovery_lock_tenant(uuid), discovery_item_owner_seated(uuid, uuid), discovery_authorize_correction(uuid, uuid)
  to service_role;
grant execute on function
  discovery_rename_candidate(uuid, text, text), discovery_reject_candidate(uuid, text),
  discovery_set_station(uuid, text, text), discovery_merge_candidates(uuid, uuid, text),
  discovery_correction_authority(uuid, text)
  to authenticated;
revoke all on function discovery_upsert_candidates(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_upsert_candidates(uuid, uuid, jsonb) to service_role;
