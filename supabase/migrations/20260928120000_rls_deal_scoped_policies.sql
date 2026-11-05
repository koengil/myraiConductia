-- Deal-scope the overseer branch of the deal-table read policies (#78, #79 / D63).
--
-- The leak: app_is_overseer(p_user) (20260612150000:15-18) tests only
-- `firm_role in ('cco','admin')` on the caller. It takes no tenant and cannot
-- see the row being filtered, so every policy that calls it has to supply the
-- tenant comparison itself. users_select, deals_select and companies_select
-- do. deal_parties_select, deal_memberships_select, documents_select,
-- audit_log_select and deal_steps_select do not. Those tables are granted
-- `select` to `authenticated`, and the publishable key ships in the browser,
-- so a signed-in user can read them through /rest/v1/* without ever entering
-- Next.js. On that path RLS is the only control. Since v0.6.0 (#156/#158,
-- D54) every onboarded firm has its own tenant and its own admin, so each
-- firm's admin or CCO could read every other firm's deal rows.
--
-- The fix keeps the `authenticated` grants and corrects the policies. #78
-- closes on "revoking the service role from a request path still yields
-- correct isolation", and a revoke would answer "permission denied", which
-- proves nothing about isolation. The tenant is folded into one helper,
-- app_is_deal_overseer(p_deal, p_user), so the safe call is the one the next
-- policy author copies: an overseer counts only on a deal of their own
-- tenant. app_is_overseer stays for users_select, deals_select and the
-- company-level branch of audit_log_select, which carry their own tenant term.
--
-- documents_select gets two walls on top of the tenant fence. The room wall
-- (documents.room arrived in 20260731120000, seven weeks after the policy was
-- written) keeps internal-room rows from external users, overseers included,
-- exactly as userCanListDocument does before oversight is consulted. The
-- class-4 wall keeps MNPI rows to the deal MD and same-tenant overseers,
-- because a document title can itself be MNPI (D1 = B). An unknown caller is
-- treated as external, so the room wall fails closed.
--
-- deal_steps_select gets the internal wall: external seats are members but
-- never see rail steps, which is what the steps route already answers (403).
-- audit_log_select fences a deal row by the deal's tenant and a company-level
-- row (no deal) by the actor's tenant (D2), through app_actor_in_user_tenant.
-- A row with no actor stays hidden from overseers, which fails closed.
--
-- The app-layer twins are userCanAccessDeal in src/lib/api/v1/access.ts
-- (the overseer branch compares deal.tenant_id to the caller's tenant) and
-- the document walls in src/lib/api/v1/documentAccess.ts. The app reads
-- through the service role and never touches these tables as
-- `authenticated`, so these policies change no application behavior. The one
-- app change that ships with them is the document list route, which now drops
-- class-4 rows for viewers who are neither the deal MD nor oversight
-- (userCanListDocumentName), so the app and RLS agree. The parity probe
-- supabase/tests/rls_deal_scoped_policies.sql asserts that a direct read
-- returns what the app would show, or less.
--
-- feature_flags (#79): feature_flags_write (20260612160000:29-33) lets a cco
-- or admin of any tenant read and write the one global flag table, and the
-- table has no tenant column, so no tenant term can fix it. Every flag reader
-- and writer uses the secret key (src/lib/flags/supabaseSource.ts and three
-- scripts), and no client reads flags as `authenticated`, so the policy is
-- dropped and `authenticated` loses every privilege on the table. RLS stays
-- on, so the table is service-role only again, as 20260603000000 first made it.
-- Reopening it needs a tenant column or a platform-admin role distinct from
-- firm_role (ADR-0016).
--
-- Hygiene: lead_relationships, lead_stakeholders, lead_relationship_paths and
-- crm_people have RLS on, zero policies and a `select` grant to
-- `authenticated`. That is deny-all today, and a trap for the next policy
-- author. The app reads them only through the service role. The revoke is
-- `revoke all`, not `revoke select`, so the tables hold no `authenticated`
-- privilege even where the platform's default ACL granted more than the
-- migrations did. The same holds for deal_step_skill_runs and
-- deal_step_skill_bindings (AQ-12): both are service-role only by design and
-- their migrations revoke `select`, but the default ACL leaves `authenticated`
-- insert, update, delete, truncate, references and trigger. RLS denies the row
-- writes, but truncate is not subject to RLS, so the grants are revoked in full.
--
-- Deliberately unchanged: the five deal-table grants to `authenticated`,
-- app_is_overseer itself, the three policies that already compare tenants,
-- and every service_role grant. Writes to the deal tables stay service-role
-- only; no write policy is added.
--
-- Rollback: supabase/rollback/20260928120000_rls_deal_scoped_policies_down.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPERS (bypass RLS; stable; locked search_path; see 20260612150000:9-10)
-- ─────────────────────────────────────────────────────────────────────────────

-- A cco or admin whose tenant is the deal's tenant. An unknown user or an
-- unknown deal yields false.
create or replace function app_is_deal_overseer(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
    from users u
    join deals d on d.id = p_deal
    where u.id = p_user
      and u.firm_role in ('cco', 'admin')
      and d.tenant_id = u.tenant_id
  );
$$;

grant execute on function app_is_deal_overseer(uuid, uuid) to authenticated;

-- Whether the user is external (a client-side seat: seller, buyer). An unknown
-- user yields true, so any wall keyed on it fails closed.
create or replace function app_user_is_external(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select is_external from users where id = p_user), true);
$$;

grant execute on function app_user_is_external(uuid) to authenticated;

-- Whether the actor of a company-level audit row (no deal) belongs to the
-- user's tenant. The actor's firm performed the operation and owns the record
-- (D2), which also settles the onboarding adoption case in 20260915120000:94-96.
-- A null actor, an unknown actor or an unknown user yields false, so the row
-- stays hidden from overseers (fails closed).
create or replace function app_actor_in_user_tenant(p_actor uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
    from users a
    join users u on u.id = p_user
    where a.id = p_actor
      and a.tenant_id = u.tenant_id
  );
$$;

grant execute on function app_actor_in_user_tenant(uuid, uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- POLICIES
-- ─────────────────────────────────────────────────────────────────────────────

-- deal_parties: visible if you can see the deal (a member, or an overseer of
-- the deal's tenant).
drop policy if exists deal_parties_select on deal_parties;
create policy deal_parties_select on deal_parties for select to authenticated
  using (
    app_is_deal_member(deal_id, auth.uid())
    or app_is_deal_overseer(deal_id, auth.uid())
  );

-- deal_memberships: your own seat, co-members (the roster), or an overseer of
-- the deal's tenant. Fenced by the deal, not by user_id, so a seat on another
-- tenant's deal stays behind that deal's fence.
drop policy if exists deal_memberships_select on deal_memberships;
create policy deal_memberships_select on deal_memberships for select to authenticated
  using (
    user_id = auth.uid()
    or app_is_deal_member(deal_id, auth.uid())
    or app_is_deal_overseer(deal_id, auth.uid())
  );

-- documents: a member, or an overseer of the deal's tenant; then the room wall
-- (internal-room rows never reach an external user, overseer or not); then the
-- class-4 wall (MNPI only to the deal MD or an overseer of the deal's tenant).
-- The order mirrors documentAccess.ts: room before oversight. The buyer phase
-- gate on min_phase stays an open-time wall in the app only.
drop policy if exists documents_select on documents;
create policy documents_select on documents for select to authenticated
  using (
    (
      app_is_deal_member(deal_id, auth.uid())
      or app_is_deal_overseer(deal_id, auth.uid())
    )
    and (room = 'deal' or not app_user_is_external(auth.uid()))
    and (
      classification < 4
      or app_is_deal_md(deal_id, auth.uid())
      or app_is_deal_overseer(deal_id, auth.uid())
    )
  );

-- deal_steps: an internal member, or an overseer of the deal's tenant. Rail
-- steps and their datarooms are bank work product, so external seats are
-- walled out exactly as GET /api/v1/deals/:id/steps returns 403 to them
-- (classifyInternalUser in access.ts). The external check sits outside the
-- member-or-overseer term, as the route applies it to every caller, so it binds an
-- external user who also holds a firm role. Supersedes
-- 20260716180000_deal_steps.sql, whose comment claimed a same-tenant overseer
-- the predicate never checked.
drop policy if exists deal_steps_select on deal_steps;
create policy deal_steps_select on deal_steps for select to authenticated
  using (
    not app_user_is_external(auth.uid())
    and (app_is_deal_member(deal_id, auth.uid()) or app_is_deal_overseer(deal_id, auth.uid()))
  );

-- audit_log: your own actions; or, for an overseer, rows of their own tenant.
-- A row with a deal is fenced by the deal's tenant. A company-level row (no
-- deal) is fenced by the actor's tenant (D2); a null actor never matches, so
-- such rows stay hidden from overseers. app_is_overseer stays here only inside
-- that tenant-bound branch. A non-overseer still sees only their own rows,
-- which is stricter than the app's deal audit trail (that wider view is a
-- separate leak, not a target to match).
drop policy if exists audit_log_select on audit_log;
create policy audit_log_select on audit_log for select to authenticated
  using (
    actor_id = auth.uid()
    or case
      when deal_id is not null then app_is_deal_overseer(deal_id, auth.uid())
      else app_is_overseer(auth.uid()) and app_actor_in_user_tenant(actor_id, auth.uid())
    end
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANTS
-- ─────────────────────────────────────────────────────────────────────────────

-- feature_flags: service-role only (#79). Supersedes 20260612160000:29-33.
drop policy if exists feature_flags_write on feature_flags;
revoke all on feature_flags from authenticated;

-- Dead lead/CRM grants (RLS on, zero policies). Supersedes
-- 20260722120000:41,70, 20260808121000:25 and 20260817140000:32.
revoke all on lead_relationships, lead_stakeholders, lead_relationship_paths, crm_people
  from authenticated;

-- Skill tables (AQ-12): service-role only, as 20260916130000 and
-- 20260916140000 intend. Removes what the platform's default ACL left behind.
revoke all on deal_step_skill_runs, deal_step_skill_bindings from authenticated;
