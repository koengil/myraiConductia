-- #233 follow-up: the RLS helpers stop answering about other users.
--
-- 20260929170000 left fifteen SECURITY DEFINER helpers executable by
-- `authenticated`, because the `to authenticated` policies call them. Each
-- takes the user to ask about as an argument, so a signed-in caller could hit
-- /rest/v1/rpc/app_is_deal_overseer (and the rest) with any user id and learn
-- who oversees a deal, who is external, or who shares a tenant.
--
-- Every policy passes auth.uid() as that argument, so a browser-role caller
-- only ever needs to ask about itself. The nine helpers below now answer only
-- that question when the caller runs as `authenticated` or `anon`:
-- asked about anyone else they return false (null for the tenant and company
-- lookups, true for app_user_is_external, whose unknown-user answer already
-- fails closed). The discriminator is the request role, not the JWT alone:
-- service_role requests, and direct database sessions such as migrations,
-- seed scripts and the psql probes, keep the full answer. The service-role
-- functions that ask about an actor (rail_template_assert_source_actor calls
-- app_is_deal_member and app_is_overseer with p_actor_id) depend on that.
-- current_setting('role') is the SET ROLE that PostgREST applies per request;
-- SECURITY DEFINER changes current_user to the owner but leaves that setting.
--
-- The other six allowlisted helpers (app_has_company_permission,
-- app_company_is_access_root, app_is_control_room, app_owns_item,
-- app_can_see_candidate, app_can_see_item) already refuse any user other than
-- auth.uid() unless the JWT role is service_role, and are unchanged.
--
-- Bodies are carried forward verbatim from 20260612150000 and 20260928120000;
-- only the guard is new. `create or replace` keeps the grants 20260929170000
-- set (authenticated + service_role, nothing to anon).
--
-- Versioned 20260930180000 (first drafted as 20260929180000, which
-- 20260929180000_discovery_health_grant took) so it applies after every
-- migration it could interact with, 20260930170000_legal_holds_rls included.
--
-- Rollback: re-run the six definitions in 20260612150000:15-46 and the three in
-- 20260928120000 (HELPERS section).

create or replace function app_is_overseer(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from users where id = p_user and firm_role in ('cco', 'admin'));
$$;

create or replace function app_user_tenant(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select tenant_id from users
  where id = p_user
    and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'));
$$;

create or replace function app_user_company(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select company_id from users
  where id = p_user
    and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'));
$$;

create or replace function app_is_deal_member(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from deal_memberships where deal_id = p_deal and user_id = p_user);
$$;

create or replace function app_is_deal_md(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (
       select 1 from deal_memberships m join roles r on r.id = m.role_id
       where m.deal_id = p_deal and m.user_id = p_user and r.slug = 'md'
     );
$$;

create or replace function app_user_is_director(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from users where id = p_user and company_role = 'director');
$$;

create or replace function app_is_deal_overseer(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (
       select 1
       from users u
       join deals d on d.id = p_deal
       where u.id = p_user
         and u.firm_role in ('cco', 'admin')
         and d.tenant_id = u.tenant_id
     );
$$;

create or replace function app_user_is_external(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select not (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
      or coalesce((select is_external from users where id = p_user), true);
$$;

-- p_actor is any user, so a browser caller asking about itself could still
-- learn whether a colleague it cannot see shares its tenant. Its one policy
-- (audit_log_select) calls it only behind app_is_overseer(auth.uid()), and an
-- overseer already reads the whole tenant through users_select, so a browser
-- caller gets an answer only when it is an overseer.
create or replace function app_actor_in_user_tenant(p_actor uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (
       select 1
       from users a
       join users u on u.id = p_user
       where a.id = p_actor
         and a.tenant_id = u.tenant_id
         and (u.firm_role in ('cco', 'admin')
              or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     );
$$;
