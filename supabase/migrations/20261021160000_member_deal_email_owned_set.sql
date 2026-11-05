-- supabase/migrations/20261021160000_member_deal_email_owned_set.sql
-- #670: a member's deal email at ~2k links took 8 to 45 s. It now asks "which items does the caller own" once per
-- statement, not once per link. Nobody sees anything they did not see before.
--
-- Measured on the integration fixture (EXPLAIN ANALYZE as the member, track_functions = all): every evidence_links
-- page judged every remaining link through app_can_see_item (the sort runs before the limit), 2,000 + 1,500 + 1,000
-- + 500 judgments over four pages, and each discovery_item_metadata batch of 100 called app_owns_item twice per item.
-- Each app_owns_item re-expands allowed_mailboxes and allowed_team_mailboxes: one mailbox_reader_providers and about
-- four reader_* calls per item, ~1 ms. A page took 2,264 ms and a batch 394 ms. 20261021150000 (#668) makes each of
-- those calls cheaper; this makes them stop growing with the number of links.
--
-- The rewrite rests on one fact: every condition of app_owns_item's three branches is a condition on the content
-- source and the caller alone (the owner's users row, the allowlist rows and the team reader's users row are all
-- joined through the source), plus the source's tenant matching the item's. So, for p_user = auth.uid():
--
--   app_owns_item(x, auth.uid())  <=>  x has provenance, within its tenant, in a source of app_owned_source_ids()
--
-- and app_can_see_item(x, auth.uid()) = app_owns_item(x, auth.uid()) or <the CCO and colleague branches>, so asking
-- the owned set first and app_can_see_item second admits exactly the rows app_can_see_item admits.
--
--   app_owned_source_ids()            NEW, internal: the caller's owned sources, app_owns_item's three branches as
--                                       conditions on the source. PL/pgSQL, so its plan is cached (a re-planned SQL
--                                       definer was ~25 ms a call here)
--   app_item_from_sources(item, ids)  NEW, internal: one index lookup of the item's provenance against those sources
--   app_owned_item_ids()              NEW: the caller's own item ids on the candidates they see, distinct, as a set
--                                       the policy hashes once per statement.
--                                       It takes no input and returns only items the caller already reads
--                                       (source_item_texts admits them by app_owns_item), so it is no oracle. An RLS
--                                       helper the policy calls, so authenticated executes it, like
--                                       app_visible_candidate_ids (allowlisted in supabase/tests/definer_grants.sql)
--   evidence_links_select             20261019160000's policy with the owned set asked before app_can_see_item, and
--                                       in place of app_owns_item in the second conjunct
--   discovery_item_metadata           20261017100000's body with `own` from the owned sources, computed once per
--                                       call in a MATERIALIZED CTE, and the filter `own, else app_can_see_item`
--
-- Unchanged: app_owns_item(uuid, uuid), app_can_see_item, app_can_see_candidate, app_visible_candidate_ids and every
-- other caller of the per-item form. The team inbox stays invite-only (ADR-0026 decision 4): a team source is in the
-- owned set only for an open member who is an active, internal colleague seated in the registration's firm and not a
-- firm admin, the test app_owns_item's third branch makes. The CCO's and colleagues' paths are still app_can_see_item.
-- No freshness term (design R7), as in every RLS helper. Nothing is cached across statements or callers.
--
-- Every definer pins `search_path = public, pg_temp` (20261016100000). discovery_item_metadata keeps its signature,
-- language, security and search_path, so create or replace keeps its grants (authenticated only). Bodies restated
-- from their latest definitions on this base:
--   evidence_links_select       20261019160000_team_mailbox_visibility.sql
--   discovery_item_metadata     20261017100000_source_items_column_wall.sql
--
-- Reverse: restate both from the files above, then
--          drop function app_owned_item_ids(); drop function app_item_from_sources(uuid, uuid[]);
--          drop function app_owned_source_ids();

-- ── 1. The caller's owned sources ───────────────────────────────────────────
-- app_owns_item's three branches (20261019160000, section 2), each written as a condition on the source:
--   a personal mailbox the caller owns, on the allowlist, with the owner seated in the source's tenant;
--   a SharePoint site the caller registered, while they are a firm admin of its tenant;
--   a team inbox the allowlist admits, which the caller reads (team_mailbox_readers' test against the base tables).
-- auth.uid() null (the service role, an anonymous call) owns nothing, as app_owns_item's p_user = auth.uid() test
-- admits nothing for a null user.
create or replace function app_owned_source_ids()
returns uuid[] language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (
    select coalesce(array_agg(o.id), '{}'::uuid[]) from (
      select c.id
      from content_sources c
      join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
      join allowed_mailboxes a on a.tenant_id = c.tenant_id
                              and a.address = lower(c.address)
                              and a.user_id = c.owner_user_id
                              and a.provider = c.provider
      where c.kind = 'mailbox' and c.owner_user_id = auth.uid()
      union
      select c.id
      from content_sources c
      join allowed_sites a on a.tenant_id = c.tenant_id and a.address = lower(c.address)
                          and a.registered_by = auth.uid()
      where c.kind = 'sharepoint_site' and app_is_firm_admin(c.tenant_id, auth.uid())
      union
      select c.id
      from content_sources c
      join allowed_team_mailboxes a on a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id
                                   and a.address = lower(c.address) and a.provider = c.provider
      join team_mailbox_members m on m.team_mailbox_id = a.team_mailbox_id
                                 and m.user_id = auth.uid() and m.removed_at is null
      join users ru on ru.id = m.user_id and ru.tenant_id = a.tenant_id
                   and ru.company_id = a.firm_company_id
                   and ru.status = 'active' and ru.is_external = false
                   and ru.firm_role is distinct from 'admin'
      where c.kind = 'mailbox' and c.team_mailbox_id is not null
    ) o
  );
end;
$$;
revoke all on function app_owned_source_ids() from public, anon, authenticated;
grant execute on function app_owned_source_ids() to service_role;

-- ── 2. Whether an item has provenance in one of the given sources ──────────
-- Internal: it would tell anyone who could pass source ids which mailbox holds an item, so only the definers below
-- call it, with the caller's own owned sources. The tenant join is app_owns_item's (c.tenant_id = si.tenant_id).
create or replace function app_item_from_sources(p_item uuid, p_sources uuid[])
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return exists (
    select 1
    from source_item_sources s
    join source_items si on si.id = s.source_item_id
    join content_sources c on c.id = s.content_source_id and c.tenant_id = si.tenant_id
    where s.source_item_id = p_item and c.id = any (p_sources));
end;
$$;
revoke all on function app_item_from_sources(uuid, uuid[]) from public, anon, authenticated;
grant execute on function app_item_from_sources(uuid, uuid[]) to service_role;

-- ── 3. The caller's own items on the candidates they see, as a set the policy hashes once per statement ──
-- Only the links of the candidates the caller sees: the policy admits no other row (its first test), so the set
-- answers every row the policy asks about. The links come through evidence_links_candidate_item_key, and each is
-- judged by app_item_from_sources, whose cached plan reaches the provenance, the item and the source by their
-- primary keys whatever the tables' statistics say (a set-wise join of the same tests was planned through the
-- items' tenant index, or as a full scan of source_item_sources, on unanalyzed tables). The owned sources and the
-- visible candidates are read into variables first: a stable function in a query's WHERE is evaluated per row.
-- Distinct ids only, so a message held in two of the caller's mailboxes does not tell them it is held twice.
create or replace function app_owned_item_ids()
returns setof uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_sources    uuid[] := app_owned_source_ids();
  v_candidates uuid[];
begin
  if cardinality(v_sources) = 0 then
    return;
  end if;
  v_candidates := array(select app_visible_candidate_ids());
  return query
    select distinct l.source_item_id
    from evidence_links l
    where l.candidate_id = any (v_candidates)
      and app_item_from_sources(l.source_item_id, v_sources);
end;
$$;
revoke all on function app_owned_item_ids() from public, anon;
grant execute on function app_owned_item_ids() to authenticated, service_role;

-- ── 4. The evidence_links policy: the owned set first ───────────────────────
-- 20261019160000's policy. `source_item_id in (select app_owned_item_ids())` is a hashed SubPlan built once per
-- statement. CASE fixes the order (an OR's arguments may be evaluated in any order), so a member's own links never
-- reach app_can_see_item. A cheap filter also lets the planner walk the primary key and stop at the page's limit
-- instead of judging every link before the sort.
drop policy if exists evidence_links_select on evidence_links;
create policy evidence_links_select on evidence_links for select to authenticated
  using (
    candidate_id is not null
    and candidate_id in (select app_visible_candidate_ids())
    and case when source_item_id in (select app_owned_item_ids()) then true
             else app_can_see_item(source_item_id, auth.uid()) end
    and (
      (state <> 'rejected' and (route_tier = 'firm' or state = 'confirmed'))
      or source_item_id in (select app_owned_item_ids())
      or app_is_control_room(auth.uid())
    )
  );

-- ── 5. discovery_item_metadata: own from the owned sources, asked once per call ──
-- 20261017100000's body. `own` was app_owns_item(si.id, auth.uid()) and the filter app_can_see_item(si.id,
-- auth.uid()), which asks app_owns_item again: two view expansions per item. The owned sources are read once, in a
-- MATERIALIZED CTE (a plain subquery is flattened and called per row), and an owned item skips app_can_see_item
-- (CASE, so the order holds).
create or replace function discovery_item_metadata(p_items uuid[])
returns table (id uuid, kind text, sent_at timestamptz, own boolean, subject text, participants jsonb,
               sender_domain text)
language sql stable security definer set search_path = public, pg_temp as $$
  with owned as materialized (select app_owned_source_ids() as ids)
  select si.id, si.kind, si.sent_at, o.own,
         case when o.own then si.subject end,
         case when o.own then si.participants end,
         (select lower(substring(p->>'address' from '^.+@([^@]+)$'))
            from jsonb_array_elements(case when jsonb_typeof(si.participants) = 'array'
                                           then si.participants else '[]'::jsonb end)
                 with ordinality as e(p, n)
           where jsonb_typeof(p) = 'object' and p->>'role' = 'from'
             and jsonb_typeof(p->'address') = 'string' and p->>'address' <> ''
           order by n
           limit 1)
  from owned
  cross join source_items si
  -- offset 0 keeps `own` one call per item: inlined, it ran once for each of its four uses.
  cross join lateral (select app_item_from_sources(si.id, owned.ids) as own offset 0) o
  where auth.uid() is not null
    and si.id = any (coalesce(p_items, '{}'::uuid[]))
    and case when o.own then true else app_can_see_item(si.id, auth.uid()) end;
$$;
