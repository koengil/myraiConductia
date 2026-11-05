-- supabase/migrations/20261023140100_model_proposal_accepts.sql
-- G-02b (#173), slice 1a: the source owner asks to accept a model-only proposal (an `m:` deal key) as a proposed deal.
--
-- Demo only, like the proposals it accepts (#460): removed with them when #459 lands (drop the table and the function
-- below, and slice 1b's definers).
--
-- Accepting is a request, nothing more. The RPC below stores one request row per mailbox source of the key and one audit
-- row, and touches nothing else: no candidate, no proposal row, no mail, no station. The source's own sync job picks the
-- request up later (slice 1b's definers, slice 3's worker step), re-reads the proposed messages through the mailbox guard
-- and the exclusion policy, links the ones still admitted to a `model:u:<owner>:<slug>` candidate, and re-keys the
-- proposal rows it linked. The candidate has NO station: a person sets it afterwards in the Set station dialog.
--
--   discovery_model_proposal_accepts   the request rows: the snapshot the job holds the live rows to, and the fields of
--                                      slice 1b's state machine (claim, lease, write-ahead keys, outcome counts), added
--                                      now so no later slice alters the table. Never written by a signed-in role.
--   discovery_accept_model_proposal    the owner's request, on their own session (auth.uid()).
--
-- Snapshot. proposal_ids, message_keys and item_hashes are parallel arrays, one entry per live proposal row of this
-- source the caller read under the tenant lock (a message can appear under several prompt versions or models, so a key
-- may repeat). The job acts only on a row whose live proposal row still has the accepted deal key and item hash; the
-- proposal writer takes no tenant lock, so nothing about its timing is assumed (the same rule as the dismissals').
--
-- The proposed station is the canonical one of the phase (the reader's `proposedStepFor`: p1-s7, p2-s26, p3-s39, p4-s46,
-- p5-s51), not any step of it: the RPC is executable by signed-in roles, so a route-only check can be bypassed, and the
-- step is stored and audited as the one the dialog showed.
--
-- Who may accept, in the order the RPC checks it: first the corrections prelude's authority
-- (20261002210000_discovery_corrections.sql:117-120, app_can_create_deals on the tenant's bank), before any row is read,
-- so a caller without it gets 42501 whatever the key (the answer does not depend on the key and reveals nothing about
-- it); then a reader of the row (app_can_read_model_proposal) who is ALSO the owner of its personal source
-- (owner_user_id = actor and team_mailbox_id is null), like the dismiss RPC (design R11): a caller WITH the authority
-- who is a team reader, the CCO, an admin or a colleague not owning the source gets P0002. A row a live dismissal covers
-- (20261023120100's link) is not offered.
--
-- The deal key carries a slug of a mail-derived deal name ("never logged", 20261014120000): no message raised here
-- contains it, and the audit row holds ids, a step id and counts only.
--
-- Lock order (20261002210000's rule): the tenant's discovery lock first, then the audit chain's. Two accept calls of one
-- tenant queue on that lock, and each reads after it holds it, so a repeat or a second tab finds the live request and
-- writes nothing; the partial unique index below is the backstop.
--
-- Reverse: drop the function and the table (no other object refers to them; slice 1b's definers go first).

-- ── 1. The request rows ─────────────────────────────────────────────────────
-- tenant_id has no foreign key: no tenants table exists (the proposals, their dismissals and corrections do the same).
create table if not exists discovery_model_proposal_accepts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  -- Disconnect and pilot-end purge reach the rows through their source.
  content_source_id uuid not null references content_sources (id) on delete cascade,
  -- The proposals table's `m:` key shape.
  deal_key          text not null check (deal_key ~ '^m:[a-z0-9-]{1,64}$'),
  -- One per accept call, shared by the rows it wrote (the audit row names it).
  operation_id      uuid not null,
  requested_by      uuid not null references users (id),
  requested_at      timestamptz not null default now(),
  -- The snapshot: parallel arrays, equal cardinality, 1..500 entries, every key and hash 64 hex.
  proposal_ids      uuid[] not null check (cardinality(proposal_ids) between 1 and 500),
  message_keys      text[] not null check (array_to_string(message_keys, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'),
  item_hashes       text[] not null check (array_to_string(item_hashes, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'),
  -- The candidate this request links to: the owner's, per deal slug (the table check below ties both to the request).
  cluster_key       text not null
                    check (cluster_key ~ '^model:u:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z0-9-]{1,64}$'),
  -- What the dialog showed: a proposed station of the group's highest phase. Never written as a station.
  proposed_step_id  text not null check (proposed_step_id ~ '^p[1-5]-s[0-9]+$'),
  proposed_phase    text not null check (proposed_phase ~ '^phase-[1-5]$'),
  -- Distinct messages of this source: placed in the proposed phase, and in all.
  placed_count      integer not null check (placed_count >= 0),
  email_count       integer not null check (email_count between 1 and 500),
  state             text not null default 'pending'
                    check (state in ('pending', 'running', 'storing', 'stored', 'done', 'failed')),
  -- Slice 1b: the claiming sync job's id, its lease, and how many times a job claimed the request.
  claim_token       text,
  lease_until       timestamptz,
  attempts          integer not null default 0 check (attempts >= 0),
  -- The write-ahead: the message keys about to be persisted, set at 'storing', before any text is written.
  storing_keys      text[] check (storing_keys is null
                                  or array_to_string(storing_keys, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
  -- A deleted candidate nulls the link; the request row stays.
  candidate_id      uuid references deal_candidates (id) on delete set null,
  found_count       integer not null default 0 check (found_count >= 0),
  changed_count     integer not null default 0 check (changed_count >= 0),
  purged_count      integer not null default 0 check (purged_count >= 0),
  finished_at       timestamptz,
  failure_code      text check (failure_code in ('none_readable', 'source_unavailable', 'candidate_closed', 'error')),
  constraint discovery_model_proposal_accepts_snapshot_shape
    check (cardinality(message_keys) = cardinality(proposal_ids)
           and cardinality(item_hashes) = cardinality(proposal_ids)
           and email_count <= cardinality(message_keys)),
  constraint discovery_model_proposal_accepts_count_shape check (placed_count <= email_count),
  constraint discovery_model_proposal_accepts_key_shape
    check (split_part(cluster_key, ':', 3) = requested_by::text
           and split_part(cluster_key, ':', 4) = substr(deal_key, 3)
           and substr(proposed_step_id, 2, 1) = right(proposed_phase, 1)),
  constraint discovery_model_proposal_accepts_outcome_shape
    check ((state = 'failed') = (failure_code is not null)
           and (state in ('done', 'failed')) = (finished_at is not null))
);
-- At most one live request per source and key: a repeat click or a second tab finds it instead of adding a row.
create unique index if not exists discovery_model_proposal_accepts_live_idx
  on discovery_model_proposal_accepts (content_source_id, deal_key)
  where state in ('pending', 'running', 'storing', 'stored');
create index if not exists discovery_model_proposal_accepts_candidate_idx
  on discovery_model_proposal_accepts (candidate_id) where candidate_id is not null;
create index if not exists discovery_model_proposal_accepts_requester_idx
  on discovery_model_proposal_accepts (tenant_id, requested_by);

alter table discovery_model_proposal_accepts enable row level security;
-- Supabase's default privileges give the API roles ALL on a new table: revoke first. Signed-in users read their own
-- sources' requests (the list's pending and failed rows); nobody writes but the definers and the service role.
revoke all on discovery_model_proposal_accepts from public, anon, authenticated;
grant select, insert, update, delete on discovery_model_proposal_accepts to service_role;
grant select on discovery_model_proposal_accepts to authenticated;

drop policy if exists discovery_model_proposal_accepts_select on discovery_model_proposal_accepts;
-- The source owner's, while the mailbox is allowlisted: the proposals policy's owner term.
create policy discovery_model_proposal_accepts_select on discovery_model_proposal_accepts
  for select to authenticated
  using (app_owns_mailbox_source(content_source_id, tenant_id, auth.uid()));

-- ── 2. Accept: the owner's request, on their own session ────────────────────
-- 42501 no actor, or no authority on the tenant's bank · 22023 a key or step of the wrong shape, a step that is not the
-- canonical station of the group's phase (invalid_proposed_step), or more than 500 rows · P0002 no live row of the key
-- the caller reads on a personal source they own and no dismissal covers · 55000 candidate_closed when the owner's
-- candidate for this slug was rejected, or was merged into a survivor that is itself rejected or gone · else
-- (operation_id, request_count): request_count new requests, one per source of the rows. A repeat or a second tab, while
-- every source of the key already holds a live request, returns that request's operation_id and 0 and writes no row and
-- no audit. Audit detail: operationId, requestIds, sourceCount, messageCount (distinct messages, summed over the new
-- requests) and proposedStepId; never the key, its slug or a name.
-- #variable_conflict: the OUT columns share names with the table's.
create or replace function discovery_accept_model_proposal(p_deal_key text, p_proposed_step_id text)
returns table (operation_id uuid, request_count integer)
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
#variable_conflict use_column
declare
  v_actor    uuid := auth.uid();
  v_tenant   uuid;
  v_bank     uuid;
  v_ids      uuid[];
  v_srcs     uuid[];
  v_keys     text[];
  v_hashes   text[];
  v_phases   text[];
  v_phase    text;
  v_live_src uuid[];
  v_existing uuid;
  v_cluster  text;
  v_cur      uuid;
  v_next     uuid;
  v_seen     uuid[];
  v_state    text;
  v_op       uuid;
  v_req      uuid[];
  v_msgs     integer;
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Fixed messages: the key is never echoed.
  if p_deal_key is null or p_deal_key !~ '^m:[a-z0-9-]{1,64}$' then
    raise exception 'invalid_deal_key' using errcode = '22023';
  end if;
  if p_proposed_step_id is null or p_proposed_step_id !~ '^p[1-5]-s[0-9]+$' then
    raise exception 'invalid_proposed_step' using errcode = '22023';
  end if;

  select u.tenant_id into v_tenant from users u where u.id = v_actor;
  if v_tenant is null then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  perform discovery_lock_tenant(v_tenant);

  -- The corrections prelude's authority (20261002210000:117-120): the tenant's bank, resolved first, then the right to
  -- create deals on it.
  select c.id into v_bank from companies c
   where c.tenant_id = v_tenant and c.type = 'bank' order by c.created_at limit 1;
  if v_bank is null or not app_can_create_deals(v_actor, v_bank) then
    raise exception 'no_authority' using errcode = '42501';
  end if;

  -- Read under the lock: the live deal rows of the key the caller reads (the helper) AND on a personal source the caller
  -- owns (the owner-only guard, kept apart from the helper), minus any row a live dismissal covers.
  select array_agg(e.id order by e.content_source_id, e.id),
         array_agg(e.content_source_id order by e.content_source_id, e.id),
         array_agg(e.message_key order by e.content_source_id, e.id),
         array_agg(e.item_hash order by e.content_source_id, e.id),
         array_agg(e.phase order by e.content_source_id, e.id)
    into v_ids, v_srcs, v_keys, v_hashes, v_phases
  from (
    select p.id, p.content_source_id, p.message_key, p.item_hash, p.phase
    from discovery_model_proposals p
    join content_sources c on c.id = p.content_source_id and c.tenant_id = p.tenant_id
    where p.tenant_id = v_tenant and p.deal_key = p_deal_key
      and p.outcome = 'deal' and p.archived_at is null
      and app_can_read_model_proposal(p.content_source_id, p.tenant_id, p.run_id, p.deal_key, p.candidate_id, v_actor)
      and c.owner_user_id = v_actor and c.team_mailbox_id is null
      and not exists (select 1
                      from discovery_model_proposal_dismissals d
                      where d.content_source_id = p.content_source_id and d.deal_key = p.deal_key
                        and d.restored_at is null and p.id = any (d.proposal_ids))
  ) e;

  if coalesce(cardinality(v_ids), 0) = 0 then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'too_many_proposals' using errcode = '22023';
  end if;

  -- The proposed phase is the group's highest (the reader's lead rule: no ties), and the step must be that phase's
  -- canonical station (the shape check above keeps the digit in 1..5).
  select max(x) into v_phase from unnest(v_phases) x;
  if p_proposed_step_id <> (array['p1-s7', 'p2-s26', 'p3-s39', 'p4-s46', 'p5-s51'])[right(v_phase, 1)::int] then
    raise exception 'invalid_proposed_step' using errcode = '22023';
  end if;

  -- A live request for a source of the key: a repeat, a second tab. Sources without one still get theirs.
  select array_agg(distinct a.content_source_id) into v_live_src
  from discovery_model_proposal_accepts a
  where a.tenant_id = v_tenant and a.deal_key = p_deal_key and a.content_source_id = any (v_srcs)
    and a.state in ('pending', 'running', 'storing', 'stored');
  v_live_src := coalesce(v_live_src, '{}'::uuid[]);
  if not exists (select 1 from unnest(v_srcs) s where s <> all (v_live_src)) then
    select a.operation_id into v_existing
    from discovery_model_proposal_accepts a
    where a.tenant_id = v_tenant and a.deal_key = p_deal_key and a.content_source_id = any (v_srcs)
      and a.state in ('pending', 'running', 'storing', 'stored')
    order by a.requested_at desc, a.id
    limit 1;
    return query select v_existing, 0;
    return;
  end if;

  -- The owner's candidate for this slug (R3). Rejected is closed. Merged away is closed only when its survivor is: the
  -- finish step (20261023140300) and discovery_upsert_candidates route new evidence to the survivor of a merge, so a
  -- candidate merged into a live one still accepts. The chain is followed up to 8 hops and stops on a cycle or a missing
  -- row (a merge re-points what was merged into the merged candidate, so one hop is the normal case).
  v_cluster := 'model:u:' || v_actor::text || ':' || substr(p_deal_key, 3);
  select dc.id, dc.discovery_state, dc.merged_into_id into v_cur, v_state, v_next
  from deal_candidates dc where dc.tenant_id = v_tenant and dc.cluster_key = v_cluster;
  if found then
    v_seen := array[v_cur];
    while v_state = 'merged_into' and cardinality(v_seen) <= 8 loop
      exit when v_next is null or v_next = any (v_seen);
      v_seen := v_seen || v_next;
      select dc.discovery_state, dc.merged_into_id into v_state, v_next
      from deal_candidates dc where dc.id = v_next and dc.tenant_id = v_tenant;
    end loop;
    if v_state is null or v_state not in ('proposed', 'confirmed') then
      raise exception 'candidate_closed' using errcode = '55000';
    end if;
  end if;

  v_op := gen_random_uuid();
  with ins as (
    insert into discovery_model_proposal_accepts (tenant_id, content_source_id, deal_key, operation_id, requested_by,
                                                  requested_at, proposal_ids, message_keys, item_hashes, cluster_key,
                                                  proposed_step_id, proposed_phase, placed_count, email_count)
    select v_tenant, r.src, p_deal_key, v_op, v_actor, now(),
           array_agg(r.id order by r.id), array_agg(r.mkey order by r.id), array_agg(r.ihash order by r.id),
           v_cluster, p_proposed_step_id, v_phase,
           count(distinct r.mkey) filter (where r.phase = v_phase), count(distinct r.mkey)
    from unnest(v_ids, v_srcs, v_keys, v_hashes, v_phases) as r(id, src, mkey, ihash, phase)
    where r.src <> all (v_live_src)
    group by r.src
    returning id, email_count
  )
  select array_agg(ins.id order by ins.id), coalesce(sum(ins.email_count), 0)::integer into v_req, v_msgs from ins;

  -- Ids, a step id and counts only: never the key, its slug or a name.
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_tenant, v_actor, 'user', 'discovery.model_proposal_accept_requested',
          jsonb_build_object('operationId', v_op, 'requestIds', to_jsonb(v_req), 'sourceCount', cardinality(v_req),
                             'messageCount', v_msgs, 'proposedStepId', p_proposed_step_id));
  return query select v_op, cardinality(v_req);
end;
$$;
revoke all on function discovery_accept_model_proposal(text, text) from public, anon, authenticated;
grant execute on function discovery_accept_model_proposal(text, text) to authenticated;
