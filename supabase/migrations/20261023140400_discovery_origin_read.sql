-- supabase/migrations/20261023140400_discovery_origin_read.sql
-- G-02b (#173), slice 4a audit fix: where a proposed deal or a deal came from, read past row-level security.
--
-- The owner's rule (design R1, R14, thread TH-7): every model-origin deal gets the pop-up. The app answers "is this
-- model-origin" from the candidate's cluster key (`model:` prefix) and from the candidates merged into it, and until now
-- it read both under the caller's own RLS (app_can_see_candidate). A deal member or overseer who is not the finder, and
-- a viewer who cannot see a merged-away `model:` candidate, then read the deal as `rules` and got a one-click Move with
-- no pop-up. The answer gates a safety guard, so it must not depend on what the caller may read.
--
--   discovery_candidate_origins   the origin of each requested candidate the caller may know about, as an enum
--   discovery_deal_origin         the origin of one deal the caller may know about, as an enum
--
-- What leaves: the words 'model_proposal' and 'rules', and (for the batch) the candidate id the caller already asked
-- about. Never a cluster key, never the id of a candidate that was merged in, never a name.
--
-- Origin. A candidate is 'model_proposal' when its own cluster key starts with `model:`, or when any candidate merged
-- into it, directly or through other merges, does (R14: a merge must not launder AI-found evidence out of the rule).
-- The merges are followed without RLS filtering, to a depth of 32 hops (real chains are one or two deep, since a merge
-- re-points what was merged into the merged candidate), and stop on a cycle.
-- A deal is 'model_proposal' when any candidate promoted to it is.
--
-- Who may know. A candidate: a caller who can see it (app_can_see_candidate, the candidates' own select policy), OR a
-- member or overseer of the deal it was promoted to. A deal: a member or overseer of it. "Member or overseer" is the
-- predicate the deal-scoped policies use (20260928120000_rls_deal_scoped_policies.sql:134-135, app_is_deal_member and
-- app_is_deal_overseer, as 20261002100000_work_identity_onboarding.sql:269-305 defines them), and the app's own
-- userCanAccessDeal (src/lib/api/v1/access.ts:80-115): a seat on the deal, or a CCO or admin, both within the
-- deal's tenant. Anyone else gets no row (the batch) or null (one deal), the same as a candidate or deal that does not
-- exist, so the answer reveals nothing about what the caller cannot reach.
--
-- 22023 too_many_candidates when the array holds more than 200 ids (counted as sent, before any de-duplication), so a
-- caller cannot make the walk large.
--
-- Reverse: drop both functions (nothing else refers to them).

-- ── 1. A batch of candidates ────────────────────────────────────────────────
-- #variable_conflict: the OUT columns share names with columns of the tables read below.
create or replace function discovery_candidate_origins(p_candidate_ids uuid[])
returns table (candidate_id uuid, origin text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_actor  uuid := auth.uid();
  v_tenant uuid;
begin
  if p_candidate_ids is not null and cardinality(p_candidate_ids) > 200 then
    raise exception 'too_many_candidates' using errcode = '22023';
  end if;
  if v_actor is null or p_candidate_ids is null then
    return;
  end if;
  select u.tenant_id into v_tenant from users u where u.id = v_actor;
  if v_tenant is null then
    return;
  end if;

  return query
  with recursive asked as (
    select distinct dc.id as cid, dc.tenant_id as tid
    from unnest(p_candidate_ids) a(id)
    join deal_candidates dc on dc.id = a.id and dc.tenant_id = v_tenant
    where app_can_see_candidate(dc.id, v_actor)
       or (dc.promoted_deal_id is not null
           and exists (select 1 from deals d
                       where d.id = dc.promoted_deal_id and d.tenant_id = v_tenant
                         and (app_is_deal_member(d.id, v_actor) or app_is_deal_overseer(d.id, v_actor))))
  ),
  walk as (
    select s.cid as root, s.cid as node, s.tid, 0 as depth, array[s.cid] as path
    from asked s
    union all
    select w.root, m.id, w.tid, w.depth + 1, w.path || m.id
    from walk w
    join deal_candidates m on m.merged_into_id = w.node and m.tenant_id = w.tid
    where w.depth < 32 and m.id <> all (w.path)
  )
  select s.cid,
         case when exists (select 1 from walk w
                           join deal_candidates n on n.id = w.node
                           where w.root = s.cid and left(n.cluster_key, 6) = 'model:')
              then 'model_proposal' else 'rules' end
  from asked s;
end;
$$;
revoke all on function discovery_candidate_origins(uuid[]) from public, anon, authenticated;
grant execute on function discovery_candidate_origins(uuid[]) to authenticated;

-- ── 2. One deal ─────────────────────────────────────────────────────────────
-- null: no actor, or the caller is neither a member nor an overseer of the deal in their tenant (or no such deal).
-- 'rules' also answers a deal nothing was promoted to.
create or replace function discovery_deal_origin(p_deal_id uuid)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_tenant uuid;
  v_model  boolean;
begin
  if v_actor is null or p_deal_id is null then
    return null;
  end if;
  select u.tenant_id into v_tenant from users u where u.id = v_actor;
  if v_tenant is null
     or not exists (select 1 from deals d
                    where d.id = p_deal_id and d.tenant_id = v_tenant
                      and (app_is_deal_member(d.id, v_actor) or app_is_deal_overseer(d.id, v_actor))) then
    return null;
  end if;

  with recursive walk as (
    select dc.id as node, 0 as depth, array[dc.id] as path
    from deal_candidates dc
    where dc.promoted_deal_id = p_deal_id and dc.tenant_id = v_tenant
    union all
    select m.id, w.depth + 1, w.path || m.id
    from walk w
    join deal_candidates m on m.merged_into_id = w.node and m.tenant_id = v_tenant
    where w.depth < 32 and m.id <> all (w.path)
  )
  select exists (select 1 from walk w
                 join deal_candidates n on n.id = w.node
                 where left(n.cluster_key, 6) = 'model:')
    into v_model;
  return case when v_model then 'model_proposal' else 'rules' end;
end;
$$;
revoke all on function discovery_deal_origin(uuid) from public, anon, authenticated;
grant execute on function discovery_deal_origin(uuid) to authenticated;
