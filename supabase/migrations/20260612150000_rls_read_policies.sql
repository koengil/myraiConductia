-- Migration: RLS read policies (#22 / D33)
-- Layers tenant + company + deal scope onto SELECT for the `authenticated`
-- role. WRITES remain service-role-only: the /api/v1 layer performs all
-- mutations through the service key (which bypasses RLS), so no authenticated
-- write policies are granted here. Because the app reads through the service
-- role too, these policies do NOT change current behavior — they are
-- defense-in-depth for any future direct (publishable-key) client read.
--
-- SECURITY DEFINER helpers bypass RLS to avoid self-referential policy
-- recursion: a policy ON a table must not directly query that same table.

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPERS (bypass RLS; stable; locked search_path)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function app_is_overseer(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from users where id = p_user and firm_role in ('cco', 'admin'));
$$;

create or replace function app_user_tenant(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select tenant_id from users where id = p_user;
$$;

create or replace function app_user_company(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select company_id from users where id = p_user;
$$;

create or replace function app_is_deal_member(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from deal_memberships where deal_id = p_deal and user_id = p_user);
$$;

create or replace function app_is_deal_md(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from deal_memberships m join roles r on r.id = m.role_id
    where m.deal_id = p_deal and m.user_id = p_user and r.slug = 'md'
  );
$$;

create or replace function app_user_is_director(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from users where id = p_user and company_role = 'director');
$$;

grant execute on function
  app_is_overseer(uuid), app_user_tenant(uuid), app_user_company(uuid),
  app_is_deal_member(uuid, uuid), app_is_deal_md(uuid, uuid),
  app_user_is_director(uuid)
  to authenticated;

-- RLS only filters rows the role can already SELECT; grant base read privilege.
grant select on roles, companies, users, deals, deal_parties, deal_memberships,
  documents, audit_log to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- POLICIES  (governing rule: visibility = membership_scope ∩ classification)
-- ─────────────────────────────────────────────────────────────────────────────

-- roles: reference catalogue, readable by any authenticated user.
drop policy if exists roles_select on roles;
create policy roles_select on roles for select to authenticated using (true);

-- companies: same tenant only.
drop policy if exists companies_select on companies;
create policy companies_select on companies for select to authenticated
  using (tenant_id = app_user_tenant(auth.uid()));

-- users: yourself; a same-tenant overseer (cco/admin); or — only if YOU are a
-- director — the members of your own company. Non-directors see only themselves.
drop policy if exists users_select on users;
create policy users_select on users for select to authenticated
  using (
    id = auth.uid()
    or (app_is_overseer(auth.uid()) and tenant_id = app_user_tenant(auth.uid()))
    or (
      app_user_is_director(auth.uid())
      and company_id is not null
      and company_id = app_user_company(auth.uid())
    )
  );

-- deals: deal members, or a same-tenant overseer.
drop policy if exists deals_select on deals;
create policy deals_select on deals for select to authenticated
  using (
    app_is_deal_member(id, auth.uid())
    or (app_is_overseer(auth.uid()) and tenant_id = app_user_tenant(auth.uid()))
  );

-- deal_parties: visible if you can see the deal.
drop policy if exists deal_parties_select on deal_parties;
create policy deal_parties_select on deal_parties for select to authenticated
  using (app_is_deal_member(deal_id, auth.uid()) or app_is_overseer(auth.uid()));

-- deal_memberships: your own seat, co-members (the roster), or an overseer.
drop policy if exists deal_memberships_select on deal_memberships;
create policy deal_memberships_select on deal_memberships for select to authenticated
  using (
    user_id = auth.uid()
    or app_is_deal_member(deal_id, auth.uid())
    or app_is_overseer(auth.uid())
  );

-- documents: deal members or overseers; class 4 (MNPI) only the deal MD or cco.
-- (Buyer phase gate on min_phase is deferred to Phase 2.)
drop policy if exists documents_select on documents;
create policy documents_select on documents for select to authenticated
  using (
    (app_is_deal_member(deal_id, auth.uid()) or app_is_overseer(auth.uid()))
    and (
      classification < 4
      or app_is_deal_md(deal_id, auth.uid())
      or app_is_overseer(auth.uid())
    )
  );

-- audit_log: your own actions, or an overseer (compliance oversight).
drop policy if exists audit_log_select on audit_log;
create policy audit_log_select on audit_log for select to authenticated
  using (actor_id = auth.uid() or app_is_overseer(auth.uid()));
