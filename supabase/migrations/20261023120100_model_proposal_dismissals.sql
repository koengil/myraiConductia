-- supabase/migrations/20261023120100_model_proposal_dismissals.sql
-- G-02a (#173), slice 1 of 5: the source owner dismisses a model proposal, archive-not-delete.
--
-- Demo only, like the proposals it dismisses (#460): removed with them when #459 lands (drop the table and the
-- three functions below).
--
-- A dismissal is a decision row, never a change to discovery_model_proposals: the proposals table, its select
-- policy and its writer (discovery_record_model_proposal) are untouched. One dismiss call writes one row per
-- mailbox source of the key it covers, all sharing one operation_id, and one audit row.
--
-- "Covered" (one rule for the dismiss RPC, the reader and known deals): a proposal row is covered when a live
-- dismissal (restored_at is null) on the row's own source, of the row's current deal_key, lists the row's id in
-- proposal_ids. The dismiss RPC writes proposal_ids from the very rows it read under the tenant lock, so a
-- dismissal covers exactly what its owner could see, never a row committed after it read (no timestamp order
-- between the writer's created_at and dismissed_at is needed: the writer takes no tenant lock). A later proposal of
-- the key (a later run, a new prompt version) is a new row with a new id, so it shows, and the owner can dismiss it
-- again, which adds a row (the live index is NOT unique). The writer upserts in place on a re-run of the same
-- prompt version; a row whose deal_key then changes no longer matches its dismissal's key, so it shows too. One
-- call covers every readable row of the key across the owner's personal sources, one dismissal row per source.
--
--   discovery_model_proposal_dismissals          the decision rows. Never deleted by a user: a restore marks the
--                                                row; a source purge (consent withdrawal, pilot end) cascades.
--   app_can_read_model_proposal(...)             the select policy's terms on discovery_model_proposals as
--                                                G-01 left them (20261023110300), as a function: a reader of the
--                                                row's source for its run (app_reads_proposal_source: the owner
--                                                of a personal source, or a reader of a team inbox that holds a
--                                                pass for the run), and for a `c:` key the candidate too
--                                                (app_can_see_candidate). The policy's row terms
--                                                (outcome = 'deal', archived_at is null) are the caller's filter;
--                                                on such a row deal_key is never null. A migration that widens the
--                                                policy widens this helper in the same migration (TH1-1), and the
--                                                parity test in supabase/tests fails until it does.
--   discovery_dismiss_model_proposal(key)        the owner's dismiss, on their own session (auth.uid()).
--   discovery_restore_model_proposal_dismissals  an operator's restore at the owner's request, service_role only.
--
-- Who may dismiss: a reader of the row (the helper) who is ALSO the owner of its personal source
-- (owner_user_id = actor and team_mailbox_id is null). The guard is separate from the helper on purpose (design
-- R6): when a later migration makes team readers or the CCO policy readers, they still get P0002 here, because
-- the dismissals policy below (app_owns_mailbox_source) and the known-deals filter could not see what they wrote.
-- Only the change that decides team dismissal (TH1-3) lifts it, together with that policy and that filter.
--
-- The deal key carries a slug of a mail-derived deal name ("never logged", 20261014120000): no message raised
-- here contains it, and the audit rows hold ids and counts only.
--
-- Lock order (20261002210000's rule): the tenant's discovery lock first, then the audit chain's. Two dismiss calls
-- of one tenant queue on that lock, and each reads after it holds it, so a repeat or a second tab finds every row
-- it would cover already listed and writes nothing.
--
-- Reverse: drop the three functions and the table (no other object refers to them).

-- ── 1. The decision rows ────────────────────────────────────────────────────
-- tenant_id has no foreign key: no tenants table exists (discovery_model_proposals and corrections do the same).
create table if not exists discovery_model_proposal_dismissals (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  -- Disconnect and pilot-end purge reach the rows through their source.
  content_source_id    uuid not null references content_sources (id) on delete cascade,
  -- The proposals table's key shape: 'c:<candidate uuid>' or 'm:<slug>'.
  deal_key             text not null check (deal_key ~ '^(c:[0-9a-f-]{36}|m:[a-z0-9-]{1,64})$'),
  dismissed_by         uuid not null references users (id),
  dismissed_at         timestamptz not null default now(),
  -- One per dismiss call, shared by the rows it wrote (the audit row names it).
  operation_id         uuid not null,
  -- The proposal rows of this source and key the call read and covered: the link "covered" is derived from. No
  -- element foreign key: the proposals go with the same source (on delete cascade), and with #459.
  proposal_ids         uuid[] not null check (cardinality(proposal_ids) > 0),
  -- Set once by the operator restore: when, the operator's service identity, and the owner who asked.
  restored_at          timestamptz,
  restored_by_identity text,
  restore_requested_by uuid references users (id),
  constraint discovery_model_proposal_dismissals_restored_shape
    check ((restored_at is null) = (restored_by_identity is null)
           and (restored_at is null) = (restore_requested_by is null))
);
-- Not unique: a later re-dismiss of the same key on the same source adds a row.
create index if not exists discovery_model_proposal_dismissals_live_idx
  on discovery_model_proposal_dismissals (content_source_id, deal_key) where restored_at is null;
create index if not exists discovery_model_proposal_dismissals_dismisser_idx
  on discovery_model_proposal_dismissals (tenant_id, dismissed_by);

alter table discovery_model_proposal_dismissals enable row level security;
-- Supabase's default privileges give the API roles ALL on a new table: revoke first. Signed-in users read their
-- own sources' dismissals (the reader's owner-wide coverage); nobody writes but the two definers below and the
-- service role.
revoke all on discovery_model_proposal_dismissals from public, anon, authenticated;
grant select, insert, update, delete on discovery_model_proposal_dismissals to service_role;
grant select on discovery_model_proposal_dismissals to authenticated;

drop policy if exists discovery_model_proposal_dismissals_select on discovery_model_proposal_dismissals;
-- The source owner's, while the mailbox is allowlisted: the proposals policy's owner term.
create policy discovery_model_proposal_dismissals_select on discovery_model_proposal_dismissals
  for select to authenticated
  using (app_owns_mailbox_source(content_source_id, tenant_id, auth.uid()));

-- ── 2. The read helper: may this user read this proposal row? ───────────────
-- The select policy's terms (see the header). Called by the dismiss RPC (a definer, as its owner) and by the
-- parity test as service_role with each persona's id; the two helpers it calls answer only about the caller
-- or for service_role, so a signed-in role never needs it.
create or replace function app_can_read_model_proposal(p_source uuid, p_tenant uuid, p_run uuid, p_deal_key text,
                                                       p_candidate uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce(
           app_reads_proposal_source(p_source, p_tenant, p_run, p_user)
           and (p_deal_key like 'm:%' or app_can_see_candidate(p_candidate, p_user)),
           false);
$$;
revoke all on function app_can_read_model_proposal(uuid, uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function app_can_read_model_proposal(uuid, uuid, uuid, text, uuid, uuid) to service_role;

-- ── 3. Dismiss: the owner's, on their own session ───────────────────────────
-- 42501 no actor · 22023 a key of the wrong shape · P0002 no live row of the key the caller reads on a personal
-- source they own · {dismissed: 0, operationId: null} when every such row is already covered (a repeat, a second
-- tab: no row, no audit) · else {dismissed: n, operationId}: n dismissal rows, one per source of the rows it
-- covers, and the operation id, content-free, which the owner quotes to ask for a restore.
-- Audit detail: operationId, dismissalIds, keyKind ('c' or 'm'), candidateId (`c:` only), sourceCount and
-- rowCount (the live proposal rows this call covered). A `c:` dismissal never touches the candidate.
create or replace function discovery_dismiss_model_proposal(p_deal_key text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_actor     uuid := auth.uid();
  v_tenant    uuid;
  v_readable  integer;
  v_candidate uuid;
  v_open      uuid[];
  v_open_src  uuid[];
  v_op        uuid;
  v_ids       uuid[];
  v_detail    jsonb;
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- A fixed message: the key is never echoed.
  if p_deal_key is null or p_deal_key !~ '^(c:[0-9a-f-]{36}|m:[a-z0-9-]{1,64})$' then
    raise exception 'invalid_deal_key' using errcode = '22023';
  end if;

  select u.tenant_id into v_tenant from users u where u.id = v_actor;
  if v_tenant is null then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  perform discovery_lock_tenant(v_tenant);

  -- Read under the lock: readable is the live deal rows of the key the caller reads (the helper) AND on a personal
  -- source the caller owns (the owner-only guard, kept apart from the helper); covered is the link rule (header).
  with readable as (
    select p.id, p.content_source_id, p.candidate_id,
           exists (select 1
                   from discovery_model_proposal_dismissals d
                   where d.content_source_id = p.content_source_id and d.deal_key = p.deal_key
                     and d.restored_at is null and p.id = any (d.proposal_ids)) as covered
    from discovery_model_proposals p
    join content_sources c on c.id = p.content_source_id and c.tenant_id = p.tenant_id
    where p.tenant_id = v_tenant and p.deal_key = p_deal_key
      and p.outcome = 'deal' and p.archived_at is null
      and app_can_read_model_proposal(p.content_source_id, p.tenant_id, p.run_id, p.deal_key, p.candidate_id, v_actor)
      and c.owner_user_id = v_actor and c.team_mailbox_id is null
  )
  select count(*),
         (array_agg(r.candidate_id) filter (where r.candidate_id is not null))[1],
         coalesce(array_agg(r.id order by r.id) filter (where not r.covered), '{}'),
         coalesce(array_agg(r.content_source_id order by r.id) filter (where not r.covered), '{}')
    into v_readable, v_candidate, v_open, v_open_src
  from readable r;

  if v_readable = 0 then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  if cardinality(v_open) = 0 then
    return jsonb_build_object('dismissed', 0, 'operationId', null);
  end if;

  v_op := gen_random_uuid();
  with ins as (
    insert into discovery_model_proposal_dismissals (tenant_id, content_source_id, deal_key, dismissed_by,
                                                     dismissed_at, operation_id, proposal_ids)
    select v_tenant, o.src, p_deal_key, v_actor, now(), v_op, array_agg(o.id order by o.id)
    from unnest(v_open, v_open_src) as o(id, src)
    group by o.src
    returning id
  )
  select array_agg(ins.id order by ins.id) into v_ids from ins;

  -- Ids and counts only: never the key, its slug or a name.
  v_detail := jsonb_build_object('operationId', v_op, 'dismissalIds', to_jsonb(v_ids),
                                 'keyKind', left(p_deal_key, 1), 'sourceCount', cardinality(v_ids),
                                 'rowCount', cardinality(v_open));
  if p_deal_key like 'c:%' then
    v_detail := v_detail || jsonb_build_object('candidateId', v_candidate);
  end if;
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_tenant, v_actor, 'user', 'discovery.model_proposal_dismissed', v_detail);
  return jsonb_build_object('dismissed', cardinality(v_ids), 'operationId', v_op);
end;
$$;
revoke all on function discovery_dismiss_model_proposal(text) from public, anon, authenticated;
grant execute on function discovery_dismiss_model_proposal(text) to authenticated;

-- ── 4. Restore: an operator's, at the owner's request ───────────────────────
-- service_role only (the runbook step). p_requested_by is the owner who asked; it must own the source of every
-- listed dismissal, else 22023 and nothing changes. Marks the live ones restored, never deletes; an id already
-- restored is skipped, so a repeat returns 0 and writes no audit row. The audit row is the service's, under the
-- operator's service identity, with the ids and the requester only.
create or replace function discovery_restore_model_proposal_dismissals(p_tenant uuid, p_dismissal_ids uuid[],
                                                                       p_requested_by uuid, p_identity text)
returns integer
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_wanted uuid[];
  v_ids    uuid[];
  v_ops    uuid[];
begin
  v_wanted := array(select distinct i from unnest(coalesce(p_dismissal_ids, '{}'::uuid[])) i where i is not null);
  if p_tenant is null or p_requested_by is null or cardinality(v_wanted) = 0
     or length(btrim(coalesce(p_identity, ''))) = 0 then
    raise exception 'invalid_restore' using errcode = '22023';
  end if;
  perform discovery_lock_tenant(p_tenant);

  -- Every listed dismissal exists in the tenant and sits on a source the requester owns.
  if exists (select 1 from unnest(v_wanted) w
             where not exists (select 1
                               from discovery_model_proposal_dismissals d
                               join content_sources c on c.id = d.content_source_id and c.tenant_id = d.tenant_id
                               where d.id = w and d.tenant_id = p_tenant and c.owner_user_id = p_requested_by)) then
    raise exception 'requester_not_owner' using errcode = '22023';
  end if;

  with upd as (
    update discovery_model_proposal_dismissals d
       set restored_at = now(), restored_by_identity = btrim(p_identity), restore_requested_by = p_requested_by
     where d.tenant_id = p_tenant and d.id = any (v_wanted) and d.restored_at is null
    returning d.id, d.operation_id
  )
  select array_agg(upd.id order by upd.id), array_agg(distinct upd.operation_id) into v_ids, v_ops from upd;

  if coalesce(cardinality(v_ids), 0) = 0 then
    return 0;
  end if;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant, 'service', btrim(p_identity), 'discovery.model_proposal_dismissal_restored',
          jsonb_build_object('dismissalIds', to_jsonb(v_ids), 'operationIds', to_jsonb(v_ops),
                             'requestedBy', p_requested_by));
  return cardinality(v_ids);
end;
$$;
revoke all on function discovery_restore_model_proposal_dismissals(uuid, uuid[], uuid, text)
  from public, anon, authenticated;
grant execute on function discovery_restore_model_proposal_dismissals(uuid, uuid[], uuid, text) to service_role;
