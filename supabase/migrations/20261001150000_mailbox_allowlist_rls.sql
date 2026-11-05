-- Discovery RLS follows the mailbox allowlist (#262, R15, Q1 = B confirmed
-- by the owner 2026-09-29). A row derived from a mailbox that left
-- allowed_mailboxes (withdrawal, removal, lost seat) disappears for its owner
-- and colleagues. The control room keeps the metadata and never the text.
-- The service role is unaffected. Signed-in reads only: the worker and the
-- /v1 agent routes use the service role, which the app guard covers.

-- Does this item have at least one provenance source still on the allowlist,
-- bound to its owner? Internal: called only from the helpers below.
create or replace function app_item_has_allowed_source(p_item uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from source_item_sources s
    join content_sources c on c.id = s.content_source_id
    join allowed_mailboxes a on a.tenant_id = c.tenant_id
                            and a.address = lower(c.address)
                            and a.user_id = c.owner_user_id
                            and a.provider = c.provider
    where s.source_item_id = p_item
  );
$$;

-- The firm's control room: an active CCO seated in the company the reader
-- registration names. app_is_control_room as discovery_core defined it tests
-- firm_role only, which would admit a suspended CCO or one seated in a second
-- bank of the tenant (design premise 6, review round 1); it is redefined below
-- to delegate to this predicate.
create or replace function app_is_firm_cco(p_tenant_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from users u
                 where u.id = p_user and u.tenant_id = p_tenant_id and u.firm_role = 'cco'
                   and u.status = 'active' and u.is_external = false
                   and u.company_id = any (firm_company_ids(p_tenant_id)));   -- any registration status (round 5)
$$;

-- The caller-bound form of app_is_firm_cco. A signed-in role may run this one
-- (app_is_firm_cco itself is service-role only, because it answers for any
-- user), and the link and visibility policies below call it. Audit round 1,
-- item 18: those policies used to test firm_role alone; through this definition
-- they now agree with every other control-room test. The grants
-- discovery_core gave the function are kept by create or replace.
create or replace function app_is_control_room(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (select 1 from users u where u.id = p_user and app_is_firm_cco(u.tenant_id, u.id));
$$;

-- The Q1 carve-out. Returning false here is option A (retroactive for everyone).
create or replace function app_mailbox_retained_for_control_room(p_tenant_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and app_is_firm_cco(p_tenant_id, p_user);
$$;

-- An item's owner: an allowlisted source of theirs, in their tenant, holds it.
create or replace function app_owns_item(p_item uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (
       select 1
       from source_item_sources s
       join content_sources c on c.id = s.content_source_id
       join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
       join allowed_mailboxes a on a.tenant_id = c.tenant_id
                               and a.address = lower(c.address)
                               and a.user_id = c.owner_user_id
                               and a.provider = c.provider
       where s.source_item_id = p_item and c.owner_user_id = p_user
     );
$$;

-- A candidate: through the user's visibility row while their own allowlisted
-- evidence still backs it, or to the control room (carve-out, or any
-- allowlisted evidence).
create or replace function app_can_see_candidate(p_candidate uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (
       select 1 from deal_candidates dc
       join users u on u.id = p_user and u.tenant_id = dc.tenant_id
       where dc.id = p_candidate
         and (
           (exists (select 1 from candidate_visibility v where v.candidate_id = dc.id and v.person_id = p_user)
            and exists (
              select 1
              from evidence_links l
              join source_item_sources s on s.source_item_id = l.source_item_id
              join content_sources c on c.id = s.content_source_id
                                    and c.tenant_id = dc.tenant_id and c.owner_user_id = p_user
              join allowed_mailboxes a on a.tenant_id = c.tenant_id
                                      and a.address = lower(c.address) and a.user_id = p_user
                                      and a.provider = c.provider
              where l.candidate_id = dc.id and l.state <> 'rejected'
                and (l.route_tier = 'firm' or l.state = 'confirmed')))
           or (app_is_firm_cco(dc.tenant_id, p_user)
               and (app_mailbox_retained_for_control_room(dc.tenant_id, p_user)
                    or exists (select 1 from evidence_links l
                               where l.candidate_id = dc.id and app_item_has_allowed_source(l.source_item_id))))
         )
     );
$$;

-- An item's metadata: its (allowlisted) owners; the control room (carve-out,
-- or the item is still allowlisted); anyone who sees a candidate it is firm or
-- confirmed evidence for, while the item is still allowlisted.
create or replace function app_can_see_item(p_item uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and (
       app_owns_item(p_item, p_user)
       or exists (
         select 1 from source_items si
         where si.id = p_item
           and app_is_firm_cco(si.tenant_id, p_user)
           and (app_mailbox_retained_for_control_room(si.tenant_id, p_user) or app_item_has_allowed_source(si.id))
       )
       or (app_item_has_allowed_source(p_item) and exists (
         select 1 from evidence_links l
         where l.source_item_id = p_item
           and l.candidate_id is not null
           and l.state <> 'rejected'
           and (l.route_tier = 'firm' or l.state = 'confirmed')
           and app_can_see_candidate(l.candidate_id, p_user)
       ))
     );
$$;

revoke all on function app_item_has_allowed_source(uuid) from public, anon, authenticated;
revoke all on function app_is_firm_cco(uuid, uuid) from public, anon, authenticated;
revoke all on function app_mailbox_retained_for_control_room(uuid, uuid) from public, anon, authenticated;
grant execute on function app_item_has_allowed_source(uuid), app_is_firm_cco(uuid, uuid),
  app_mailbox_retained_for_control_room(uuid, uuid)
  to service_role;
-- The four widened helpers keep their existing grants (create or replace keeps them).

-- A link row follows its item's visibility too, so a colleague loses the
-- links of a mailbox that left the allowlist. The app_is_control_room branch
-- below only widens the tentative/rejected link rule; it is the firm's CCO
-- (redefined above to delegate to app_is_firm_cco), and the two conjuncts
-- above already require that CCO for any control-room read.
drop policy if exists evidence_links_select on evidence_links;
create policy evidence_links_select on evidence_links for select to authenticated
  using (
    candidate_id is not null
    and app_can_see_candidate(candidate_id, auth.uid())
    and app_can_see_item(source_item_id, auth.uid())
    and (
      (state <> 'rejected' and (route_tier = 'firm' or state = 'confirmed'))
      or app_owns_item(source_item_id, auth.uid())
      or app_is_control_room(auth.uid())
    )
  );

-- Your own row only while you can still see the candidate.
drop policy if exists candidate_visibility_select on candidate_visibility;
create policy candidate_visibility_select on candidate_visibility for select to authenticated
  using (
    (person_id = auth.uid() and app_can_see_candidate(candidate_id, auth.uid()))
    or (app_is_control_room(auth.uid()) and app_can_see_candidate(candidate_id, auth.uid()))
  );
