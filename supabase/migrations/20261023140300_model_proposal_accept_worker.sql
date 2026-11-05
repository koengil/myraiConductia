-- supabase/migrations/20261023140300_model_proposal_accept_worker.sql
-- G-02b (#173), slice 1b: the discovery worker's side of an accepted model proposal.
--
-- Demo only, like the proposals it serves (#460): removed with them when #459 lands, before the table of
-- 20261023140100 (drop the seven functions below, then that table and its RPC).
--
-- 20261023140100 stores the owner's request (state 'pending'). The source's own SYNC job drives it from here, through
-- these seven service_role definers; nothing signed-in calls them. A request moves
--
--     pending -> running -> storing -> stored -> done            (failed from any live state)
--
--   claim       pending, or a live state whose lease ran out, becomes the calling job's: its job id is the claim
--               token, the lease is renewed at page boundaries, and every claim counts an attempt. The fourth
--               claim fails the request ('error') instead of returning it, so a request that keeps crashing its
--               job ends. This is the only retry mechanism (design R4).
--   live_keys   the snapshot's messages whose proposal row still has the accepted deal key and item hash: what the
--               job may read and store. A reclaimed 'storing' request is held to its write-ahead keys.
--   storing     the write-ahead (R6): the keys about to be persisted are recorded BEFORE any text is written, so a
--               crash after the write leaves a request that knows what to purge. Keys must be live keys. Only keys
--               this source does not already hold are recorded, and the call returns exactly those: the keys the job
--               may persist (and so the only ones a purge can ever reach). A key the source already held is not this
--               request's text: the job links it and never stores or purges it.
--   stored      the persist finished; a reclaimed request resumes from here without a re-read.
--   finish      the one terminal step: it links, re-keys, records the correction, purges and audits.
--   expire      the tick's backstop: a pending request nobody claimed, and an in-flight one (running, storing or
--               stored) whose lease ran out, when its source is no longer an active mailbox or the request is too old.
--               A pending one fails with no purge (it has no write-ahead keys). An in-flight one takes a fresh token
--               under the tenant lock and ends through the finish, so its purge runs.
--
-- Every definer takes the claim token and does nothing unless it matches the request's (false, no rows, no write),
-- so a duplicate or superseded job is harmless. Malformed arguments raise 22023 with a fixed message; no message
-- raised here contains a deal key, a slug, a name or a message key.
--
-- The finish step, in order, under the tenant's discovery lock, the candidate's row lock and the request's:
--   1. linked  the messages of the request's snapshot (those whose proposal row still has the accepted key and hash,
--              whether or not this request stored them) for which this source's item carries a non-rejected evidence
--              link to the request's candidate (its merged survivor, if a merge moved it meanwhile).
--   2. re-key  only the snapshot's proposal rows whose message is linked and which still have the accepted key and
--              hash: deal_key becomes 'c:<candidate>' AND candidate_id the candidate, so the owner's select policy
--              (app_can_see_candidate) and the archive trigger work. Rows of unlinked messages stay under 'm:'. A
--              message an earlier accept or the link-only path already holds is re-keyed too.
--   3. record  a corrections row (accept_proposal, actor = the requester) and the message index's links.
--   4. purge   an accept purges only what that request newly stored in this source. The write-ahead keys are exactly
--              those (mark_storing records only keys the source did not already hold), so the purge is the write-ahead
--              keys minus the linked ones, success included, with NO evidence exemption: a purged key's
--              routing_ledger rows go back to 'unrouted' (the conversation and Message-ID restored from the item) and
--              this source's source_item_sources row is deleted. Evidence on the item, for this candidate or any
--              other, neither protects the key nor changes the rule: the holder row exists only because this request
--              made it. A message this source already held (an earlier accept, the link-only path or a normal sync)
--              is never in the write-ahead keys, so no accept, failed or not, ever purges it. The item and its text
--              are never deleted here: another source may hold the same Message-ID, and discovery_collect_orphans
--              (unchanged) deletes an item only when no source holds it.
--   5. close   done when something is linked, else failed (a given code, 'candidate_closed' when the candidate was
--              rejected or its survivor is dead, else 'none_readable'), with counts, and a counts-only audit row as
--              the discovery worker.
-- No step writes a station, a pin, a deal or a cursor: the candidate has none until a person sets it.
--
-- Lock order (20261002210000's rule): the tenant's discovery lock first, then the candidate rows, the proposal rows,
-- the request row, then the audit chain's. Claim and expire take the tenant lock before their request rows. Renew,
-- storing and stored take only their own request row and never wait for the tenant lock while holding it.
--
-- Audit details hold ids, outcome words and counts only: never the deal key, its slug, a name or a message key.
--
-- Reverse: drop the seven functions and the two indexes (the table and its RPC of 20261023140100 are untouched by this
-- file).

-- ── 1. Claim ────────────────────────────────────────────────────────────────
-- Returns the requests of p_source now claimed by p_token: pending ones, and live ones whose lease ran out. A
-- request that reaches its fourth attempt is failed in place ('error', with the purge) and not returned. skip
-- locked: a concurrent claim of the same source takes the rest, never waits on a row.
create or replace function discovery_claim_model_proposal_accepts(p_source uuid, p_token text, p_lease interval)
returns setof discovery_model_proposal_accepts
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_tenant uuid;
  v_req    discovery_model_proposal_accepts;
begin
  if p_source is null or p_token is null or btrim(p_token) = '' or p_lease is null or p_lease <= interval '0' then
    raise exception 'invalid_claim' using errcode = '22023';
  end if;
  select c.tenant_id into v_tenant from content_sources c where c.id = p_source;
  if v_tenant is null then
    return;
  end if;
  perform discovery_lock_tenant(v_tenant);

  for v_req in
    select a.*
    from discovery_model_proposal_accepts a
    where a.content_source_id = p_source
      and (a.state = 'pending'
           or (a.state in ('running', 'storing', 'stored') and (a.lease_until is null or a.lease_until < now())))
    order by a.requested_at, a.id
    for update skip locked
  loop
    update discovery_model_proposal_accepts a
       set state = case when a.state = 'pending' then 'running' else a.state end,
           claim_token = p_token, lease_until = now() + p_lease, attempts = a.attempts + 1
     where a.id = v_req.id
    returning a.* into v_req;

    if v_req.attempts > 3 then
      -- The token is now this job's, so the finish below is its own; the purge runs if the request had stored text.
      perform discovery_finish_model_proposal_accept(v_req.id, p_token, null, 'error');
    else
      return next v_req;
    end if;
  end loop;
  return;
end;
$$;
revoke all on function discovery_claim_model_proposal_accepts(uuid, text, interval) from public, anon, authenticated;
grant execute on function discovery_claim_model_proposal_accepts(uuid, text, interval) to service_role;

-- ── 2. Renew ────────────────────────────────────────────────────────────────
-- Pushes the lease out by p_lease from now, at a page boundary. False when the request is not this token's or is
-- finished: the job has lost it and must stop writing for it.
create or replace function discovery_renew_model_proposal_accept(p_request uuid, p_token text, p_lease interval)
returns boolean
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
begin
  if p_lease is null or p_lease <= interval '0' then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;
  update discovery_model_proposal_accepts a
     set lease_until = now() + p_lease
   where a.id = p_request and p_token is not null and a.claim_token = p_token
     and a.state in ('running', 'storing', 'stored');
  return found;
end;
$$;
revoke all on function discovery_renew_model_proposal_accept(uuid, text, interval) from public, anon, authenticated;
grant execute on function discovery_renew_model_proposal_accept(uuid, text, interval) to service_role;

-- ── 3. Live keys ────────────────────────────────────────────────────────────
-- The snapshot's messages (key, item hash, sent_at) whose proposal row is still live and still has the accepted deal
-- key and item hash: a row the proposal writer changed after the accept, or that moved to another key, drops out.
-- Nothing for a request that is not this token's, or not running or storing. A 'storing' request (reclaimed after a
-- crash) is held to its write-ahead keys: it may only continue what it may already have stored.
create or replace function discovery_model_proposal_accept_live_keys(p_request uuid, p_token text)
returns table (message_key text, item_hash text, sent_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (s.mkey, s.ihash) s.mkey, s.ihash, p.sent_at
  from discovery_model_proposal_accepts a
  cross join lateral unnest(a.proposal_ids, a.message_keys, a.item_hashes) as s(pid, mkey, ihash)
  join discovery_model_proposals p
    on p.id = s.pid and p.tenant_id = a.tenant_id and p.content_source_id = a.content_source_id
   and p.deal_key = a.deal_key and p.message_key = s.mkey and p.item_hash = s.ihash
   and p.outcome = 'deal' and p.archived_at is null
  where a.id = p_request and p_token is not null and a.claim_token = p_token
    and a.state in ('running', 'storing')
    and (a.state <> 'storing' or s.mkey = any (a.storing_keys))
  order by s.mkey, s.ihash, p.id;
$$;
revoke all on function discovery_model_proposal_accept_live_keys(uuid, text) from public, anon, authenticated;
grant execute on function discovery_model_proposal_accept_live_keys(uuid, text) to service_role;

-- ── 4. Storing: the write-ahead ─────────────────────────────────────────────
-- running -> storing, recording in storing_keys BEFORE the job persists them the keys of p_keys that this source does
-- not already hold ("hold": a source_item_sources row of this source whose message item has that key, computed as the
-- finish computes it: sha256 of btrim(internet_message_id)). Returns the keys it recorded: the keys the job may
-- persist. A key the source already held is left out, so the purge (storing_keys minus linked) can only ever reach text
-- this request itself newly stored; the job links such a key but neither stores nor purges it. Every key must be a
-- live key (22023 'keys_not_live' otherwise, nothing written). On a request already 'storing' (a retry after a crash)
-- storing_keys stays exactly as recorded, because the purge must cover everything the crashed attempt persisted, and
-- the result is those keys within p_keys. Null when the request is not this token's or not running or storing.
drop function if exists discovery_mark_model_proposal_accept_storing(uuid, text, text[]);
create or replace function discovery_mark_model_proposal_accept_storing(p_request uuid, p_token text, p_keys text[])
returns text[]
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_req  discovery_model_proposal_accepts;
  v_keys text[];
  v_held text[];
  v_new  text[];
begin
  if p_keys is null or cardinality(p_keys) not between 1 and 500 or array_position(p_keys, null) is not null
     or array_to_string(p_keys, ',') !~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$' then
    raise exception 'invalid_keys' using errcode = '22023';
  end if;
  v_keys := array(select distinct k from unnest(p_keys) k order by k);

  select a.* into v_req
  from discovery_model_proposal_accepts a
  where a.id = p_request and p_token is not null and a.claim_token = p_token
  for update;
  if not found or v_req.state not in ('running', 'storing') then
    return null;
  end if;

  if exists (select 1 from unnest(v_keys) k
             where not exists (select 1 from discovery_model_proposal_accept_live_keys(p_request, p_token) l
                               where l.message_key = k)) then
    raise exception 'keys_not_live' using errcode = '22023';
  end if;

  if v_req.state = 'storing' then
    return array(select k from unnest(v_keys) k where k = any (coalesce(v_req.storing_keys, '{}'::text[])) order by k);
  end if;

  select coalesce(array_agg(distinct m.mkey), '{}'::text[]) into v_held
  from (select encode(sha256(convert_to(btrim(si.internet_message_id), 'UTF8')), 'hex') as mkey
        from source_item_sources sis
        join source_items si on si.id = sis.source_item_id
        where sis.content_source_id = v_req.content_source_id and si.tenant_id = v_req.tenant_id
          and si.kind = 'message' and si.internet_message_id is not null) m
  where m.mkey = any (v_keys);
  v_new := array(select k from unnest(v_keys) k where not (k = any (v_held)) order by k);

  update discovery_model_proposal_accepts a set state = 'storing', storing_keys = v_new where a.id = v_req.id;
  return v_new;
end;
$$;
revoke all on function discovery_mark_model_proposal_accept_storing(uuid, text, text[]) from public, anon, authenticated;
grant execute on function discovery_mark_model_proposal_accept_storing(uuid, text, text[]) to service_role;

-- ── 5. Stored ───────────────────────────────────────────────────────────────
-- storing -> stored, once the persist has returned. True on a repeat of the same token. False otherwise.
create or replace function discovery_mark_model_proposal_accept_stored(p_request uuid, p_token text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_req discovery_model_proposal_accepts;
begin
  select a.* into v_req
  from discovery_model_proposal_accepts a
  where a.id = p_request and p_token is not null and a.claim_token = p_token
  for update;
  if not found then
    return false;
  end if;
  if v_req.state = 'stored' then
    return true;
  end if;
  if v_req.state <> 'storing' then
    return false;
  end if;
  update discovery_model_proposal_accepts a set state = 'stored' where a.id = v_req.id;
  return true;
end;
$$;
revoke all on function discovery_mark_model_proposal_accept_stored(uuid, text) from public, anon, authenticated;
grant execute on function discovery_mark_model_proposal_accept_stored(uuid, text) to service_role;

-- ── 6. Finish ───────────────────────────────────────────────────────────────
-- p_candidate: the candidate discovery_upsert_candidates returned for the request's cluster key (null when none was
-- made); 22023 when it is not the tenant's candidate of that key. p_failure: null, or the code to fail with
-- (none_readable, source_unavailable, candidate_closed, error); a given code skips the linking and fails the request.
-- Returns true when this call finished the request, or when it was already finished under this token (no second
-- write, no second audit); false when the request is not this token's or is not live.
create or replace function discovery_finish_model_proposal_accept(p_request uuid, p_token text, p_candidate uuid,
                                                                  p_failure text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_tenant   uuid;
  v_req      discovery_model_proposal_accepts;
  v_cand     deal_candidates;
  v_target   uuid;
  v_surv     text;
  v_keys     text[];
  v_snap     text[] := '{}';
  v_linked   text[] := '{}';
  v_purge    text[];
  v_rekeyed  integer := 0;
  v_changed  integer := 0;
  v_purged   integer := 0;
  v_done     boolean;
  v_code     text;
begin
  if p_failure is not null and p_failure not in ('none_readable', 'source_unavailable', 'candidate_closed', 'error') then
    raise exception 'invalid_failure' using errcode = '22023';
  end if;
  -- The tenant is read from the immutable column before any lock, as the correction prelude does.
  select a.tenant_id into v_tenant from discovery_model_proposal_accepts a where a.id = p_request;
  if v_tenant is null or p_token is null then
    return false;
  end if;
  perform discovery_lock_tenant(v_tenant);

  select a.* into v_req from discovery_model_proposal_accepts a where a.id = p_request for update;
  if not found or v_req.claim_token is distinct from p_token then
    return false;
  end if;
  if v_req.state in ('done', 'failed') then
    return true;
  end if;
  if v_req.state not in ('running', 'storing', 'stored') then
    return false;
  end if;

  -- The candidate the links landed on: the one of the request's key, or the survivor a merge moved it to (the same
  -- target discovery_upsert_candidates used); none when it was rejected or its survivor is dead.
  if p_candidate is not null and p_failure is null then
    select dc.* into v_cand
    from deal_candidates dc
    where dc.id = p_candidate and dc.tenant_id = v_req.tenant_id and dc.cluster_key = v_req.cluster_key
    for update;
    if not found then
      raise exception 'invalid_candidate' using errcode = '22023';
    end if;
    v_target := case v_cand.discovery_state
                  when 'proposed' then v_cand.id
                  when 'confirmed' then v_cand.id
                  when 'merged_into' then v_cand.merged_into_id
                  else null
                end;
    if v_cand.discovery_state = 'merged_into' then
      select dc.discovery_state into v_surv from deal_candidates dc where dc.id = v_cand.merged_into_id for update;
      if v_surv is null or v_surv not in ('proposed', 'confirmed') then
        v_target := null;
      end if;
    end if;
  end if;

  -- 1. Linked: this source's messages of the snapshot (those whose proposal row still has the accepted key and item
  --    hash) with a non-rejected evidence link to the target, whether this request stored them or the source already
  --    held them.
  v_keys := coalesce(v_req.storing_keys, '{}'::text[]);
  select coalesce(array_agg(distinct s.mkey), '{}'::text[]) into v_snap
  from unnest(v_req.proposal_ids, v_req.message_keys, v_req.item_hashes) as s(pid, mkey, ihash)
  join discovery_model_proposals p
    on p.id = s.pid and p.tenant_id = v_req.tenant_id and p.content_source_id = v_req.content_source_id
   and p.deal_key = v_req.deal_key and p.message_key = s.mkey and p.item_hash = s.ihash
   and p.outcome = 'deal' and p.archived_at is null;
  if v_target is not null and cardinality(v_snap) > 0 then
    select coalesce(array_agg(distinct m.mkey), '{}'::text[]) into v_linked
    from (select encode(sha256(convert_to(btrim(si.internet_message_id), 'UTF8')), 'hex') as mkey
          from source_items si
          join source_item_sources sis on sis.source_item_id = si.id and sis.content_source_id = v_req.content_source_id
          join evidence_links l on l.source_item_id = si.id and l.candidate_id = v_target and l.state <> 'rejected'
          where si.tenant_id = v_req.tenant_id and si.kind = 'message' and si.internet_message_id is not null) m
    where m.mkey = any (v_snap);
  end if;
  v_done := cardinality(v_linked) > 0;

  if v_done then
    -- 2. Re-key the linked, still-matching snapshot rows: the key AND the candidate id (the select policy and the
    --    archive trigger both read candidate_id). The rows are locked in id order first.
    perform 1 from discovery_model_proposals p where p.id = any (v_req.proposal_ids) order by p.id for update;
    with snap as (
      select s.pid, s.mkey, s.ihash
      from unnest(v_req.proposal_ids, v_req.message_keys, v_req.item_hashes) as s(pid, mkey, ihash)),
    upd as (
      update discovery_model_proposals p
         set deal_key = 'c:' || v_target::text, candidate_id = v_target, updated_at = now()
        from snap s
       where p.id = s.pid and p.tenant_id = v_req.tenant_id and p.content_source_id = v_req.content_source_id
         and p.deal_key = v_req.deal_key and p.message_key = s.mkey and p.item_hash = s.ihash
         and p.outcome = 'deal' and p.archived_at is null and s.mkey = any (v_linked)
      returning p.id)
    select count(*) into v_rekeyed from upd;
    v_changed := cardinality(v_req.proposal_ids) - v_rekeyed;

    -- 3. The person's accept, in the correction log, and the message index's links.
    insert into corrections (tenant_id, candidate_id, actor_id, action, after)
    values (v_req.tenant_id, v_target, v_req.requested_by, 'accept_proposal',
            jsonb_build_object('requestId', v_req.id, 'found', cardinality(v_linked), 'requested', v_req.email_count));
    perform discovery_message_index_link(v_req.tenant_id, v_req.content_source_id);
  end if;

  -- 4. The purge: the write-ahead keys (only what this request newly stored in this source) minus the linked ones,
  --    this source's rows only. No evidence exemption: the holder row is this request's own, whatever else the item
  --    is evidence for.
  v_purge := array(select k from unnest(v_keys) k where not (k = any (v_linked)));
  if cardinality(v_purge) > 0 then
    with mine as (
      select sis.source_item_id as item_id, sis.provider_item_id, si.conversation_id, si.internet_message_id,
             encode(sha256(convert_to(btrim(si.internet_message_id), 'UTF8')), 'hex') as mkey
      from source_item_sources sis
      join source_items si on si.id = sis.source_item_id
      where sis.content_source_id = v_req.content_source_id and si.tenant_id = v_req.tenant_id
        and si.kind = 'message' and si.internet_message_id is not null),
    gone as (
      select m.* from mine m where m.mkey = any (v_purge)),
    -- The provider ids this source read the message under: its holder row's, and every one its index row lists.
    seen as (
      select g.provider_item_id as pid, g.conversation_id, g.internet_message_id from gone g
      union
      select u.pid, g.conversation_id, g.internet_message_id
      from gone g
      join discovery_message_index x
        on x.tenant_id = v_req.tenant_id and x.content_source_id = v_req.content_source_id and x.message_key = g.mkey
      cross join lateral unnest(x.provider_item_ids) as u(pid)),
    reset as (
      update routing_ledger rl
         set decision = 'unrouted', method = null, confidence = null,
             conversation_id = s.conversation_id, internet_message_id = s.internet_message_id
        from seen s
       where rl.source_id = v_req.content_source_id and rl.provider_item_id = s.pid and rl.decision = 'routed'
      returning 1),
    del as (
      delete from source_item_sources d
       using gone g
       where d.source_item_id = g.item_id and d.content_source_id = v_req.content_source_id
      returning 1)
    select count(*) into v_purged from del;
  end if;

  -- 5. Close.
  v_code := case
              when v_done then null
              else coalesce(p_failure, case when p_candidate is not null and v_target is null
                                            then 'candidate_closed' else 'none_readable' end)
            end;
  update discovery_model_proposal_accepts a
     set state = case when v_done then 'done' else 'failed' end,
         found_count = cardinality(v_linked), changed_count = v_changed, purged_count = v_purged,
         finished_at = now(), failure_code = v_code, lease_until = null,
         candidate_id = case when v_done then v_target else null end
   where a.id = v_req.id;

  -- Ids, an outcome word and counts only: never the key, its slug, a name or a message key.
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (v_req.tenant_id, 'service', 'discovery-worker', 'discovery.model_proposal_accept_finished',
          jsonb_build_object('requestId', v_req.id, 'operationId', v_req.operation_id,
                             'outcome', coalesce(v_code, 'done'), 'found', cardinality(v_linked),
                             'requested', v_req.email_count, 'changed', v_changed, 'purged', v_purged,
                             'requestedBy', v_req.requested_by)
          || case when v_done then jsonb_build_object('candidateId', v_target) else '{}'::jsonb end);
  return true;
end;
$$;
revoke all on function discovery_finish_model_proposal_accept(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function discovery_finish_model_proposal_accept(uuid, text, uuid, text) to service_role;

-- ── 7. Expire ───────────────────────────────────────────────────────────────
-- The tick's backstop (design R4). A request qualifies when its source is no longer an active live mailbox or it is
-- older than p_max_age, and it is either
--   * pending: nobody claimed it. It fails as 'source_unavailable' with a counts-only audit row and no purge (it has
--     no write-ahead keys, so this never touches text); or
--   * in flight (running, storing or stored) with a lapsed lease: the claiming job is gone and no SYNC job will claim
--     it again (a claim happens only inside the SYNC job of an active source). Its claim token is swapped atomically
--     under the tenant lock, as claim does ('expire:' plus a random id), and it ends through the finish with
--     'source_unavailable', so its purge runs and the finish writes the audit row. A row another call holds is skipped
--     (the next tick takes it).
-- A claimed request on an active source with a live lease, or a young one with a lapsed lease on an active source, is
-- the claiming job's or the next claim's to finish. p_tenant null means every tenant that has such rows, each handled
-- under its own tenant lock in tenant id order. When nothing qualifies this returns 0 without taking any lock. Returns
-- the number of requests failed.
create index if not exists discovery_model_proposal_accepts_pending_idx
  on discovery_model_proposal_accepts (requested_at) where state = 'pending';
create index if not exists discovery_model_proposal_accepts_inflight_idx
  on discovery_model_proposal_accepts (lease_until) where state in ('running', 'storing', 'stored');

create or replace function discovery_expire_model_proposal_accepts(p_tenant uuid, p_max_age interval)
returns integer
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_tenant uuid;
  v_req    record;
  v_token  text;
  v_n      integer := 0;
begin
  if p_max_age is null or p_max_age <= interval '0' then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;

  -- Cheap pre-check on the partial indexes, before any lock: nothing to expire is the usual tick.
  if not exists (
    select 1
    from discovery_model_proposal_accepts a
    join content_sources c on c.id = a.content_source_id
    where (p_tenant is null or a.tenant_id = p_tenant)
      and (c.status <> 'active' or c.archived_at is not null or a.requested_at < now() - p_max_age)
      and (a.state = 'pending'
           or (a.state in ('running', 'storing', 'stored') and (a.lease_until is null or a.lease_until < now())))) then
    return 0;
  end if;

  for v_tenant in
    select distinct a.tenant_id
    from discovery_model_proposal_accepts a
    join content_sources c on c.id = a.content_source_id
    where (p_tenant is null or a.tenant_id = p_tenant)
      and (c.status <> 'active' or c.archived_at is not null or a.requested_at < now() - p_max_age)
      and (a.state = 'pending'
           or (a.state in ('running', 'storing', 'stored') and (a.lease_until is null or a.lease_until < now())))
    order by a.tenant_id
  loop
    perform discovery_lock_tenant(v_tenant);

    -- Pending: failed in place, as before.
    for v_req in
      select a.id, a.operation_id, a.email_count, a.requested_by
      from discovery_model_proposal_accepts a
      join content_sources c on c.id = a.content_source_id
      where a.tenant_id = v_tenant and a.state = 'pending'
        and (c.status <> 'active' or c.archived_at is not null or a.requested_at < now() - p_max_age)
      order by a.id
      for update of a
    loop
      update discovery_model_proposal_accepts a
         set state = 'failed', failure_code = 'source_unavailable', finished_at = now()
       where a.id = v_req.id;
      insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
      values (v_tenant, 'service', 'discovery-worker', 'discovery.model_proposal_accept_finished',
              jsonb_build_object('requestId', v_req.id, 'operationId', v_req.operation_id,
                                 'outcome', 'source_unavailable', 'found', 0, 'requested', v_req.email_count,
                                 'changed', 0, 'purged', 0, 'requestedBy', v_req.requested_by));
      v_n := v_n + 1;
    end loop;

    -- In flight with a lapsed lease: take the request under a fresh token, then finish it so the purge runs.
    for v_req in
      select a.id
      from discovery_model_proposal_accepts a
      join content_sources c on c.id = a.content_source_id
      where a.tenant_id = v_tenant and a.state in ('running', 'storing', 'stored')
        and (a.lease_until is null or a.lease_until < now())
        and (c.status <> 'active' or c.archived_at is not null or a.requested_at < now() - p_max_age)
      order by a.id
      for update of a skip locked
    loop
      v_token := null;
      update discovery_model_proposal_accepts a
         set claim_token = 'expire:' || gen_random_uuid()::text
       where a.id = v_req.id and a.state in ('running', 'storing', 'stored')
         and (a.lease_until is null or a.lease_until < now())
      returning a.claim_token into v_token;
      if v_token is not null
         and discovery_finish_model_proposal_accept(v_req.id, v_token, null, 'source_unavailable') then
        v_n := v_n + 1;
      end if;
    end loop;
  end loop;
  return v_n;
end;
$$;
revoke all on function discovery_expire_model_proposal_accepts(uuid, interval) from public, anon, authenticated;
grant execute on function discovery_expire_model_proposal_accepts(uuid, interval) to service_role;
