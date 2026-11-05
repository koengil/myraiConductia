-- Rollback for 20260928120000_rls_deal_scoped_policies.sql.
--
-- Restores the latest prior definitions verbatim: deal_parties_select,
-- deal_memberships_select, documents_select and audit_log_select from
-- 20260612150000_rls_read_policies.sql, deal_steps_select from
-- 20260716180000_deal_steps.sql. No later migration redefines any of them.
-- Restores the `authenticated` grants and feature_flags_write verbatim from
-- 20260612160000_feature_flags_write_policy.sql:29-33, and the `select` grants
-- on the four lead/CRM tables from 20260722120000:41,70, 20260808121000:25
-- and 20260817140000:32. Those are the grants the migrations wrote. A
-- privilege the forward `revoke all` removed that came only from the
-- platform's default ACL, and never from a migration, is not restored. That
-- covers deal_step_skill_runs and deal_step_skill_bindings entirely: no
-- migration granted `authenticated` anything on them, so nothing is re-granted.
-- This rollback REOPENS the cross-tenant read (#78): with it applied, a cco
-- or admin of any tenant can again read every tenant's deal parties,
-- memberships, documents (MNPI included), deal steps and audit trail through
-- /rest/v1/*, every external member can again list internal-room document
-- names, and external seats can again read deal steps. It also REOPENS the
-- global flag write (#79): a cco or admin of any tenant can again toggle
-- feature flags for every tenant. Apply it only to recover from a broken
-- forward migration, and re-apply the forward migration as soon as possible.
--
-- The policies are restored before the helpers are dropped, because a policy
-- that still calls app_is_deal_overseer, app_user_is_external or
-- app_actor_in_user_tenant blocks the drop.

begin;

-- 20260612160000's feature_flags grant and write policy (tenant-blind, global).
grant select, insert, update, delete on feature_flags to authenticated;
drop policy if exists feature_flags_write on feature_flags;
create policy feature_flags_write on feature_flags for all to authenticated
  using (exists (select 1 from users u where u.id = auth.uid() and u.firm_role in ('cco', 'admin')))
  with check (exists (select 1 from users u where u.id = auth.uid() and u.firm_role in ('cco', 'admin')));

-- The lead/CRM select grants (RLS on, zero policies: deny-all).
grant select on lead_relationships to authenticated;
grant select on lead_stakeholders to authenticated;
grant select on lead_relationship_paths to authenticated;
grant select on crm_people to authenticated;

drop policy if exists deal_parties_select on deal_parties;
create policy deal_parties_select on deal_parties for select to authenticated
  using (app_is_deal_member(deal_id, auth.uid()) or app_is_overseer(auth.uid()));

drop policy if exists deal_memberships_select on deal_memberships;
create policy deal_memberships_select on deal_memberships for select to authenticated
  using (
    user_id = auth.uid()
    or app_is_deal_member(deal_id, auth.uid())
    or app_is_overseer(auth.uid())
  );

-- 20260612150000's documents_select (no room wall, tenant-blind overseer).
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

-- 20260716180000's deal_steps_select (no internal wall, tenant-blind overseer).
drop policy if exists deal_steps_select on deal_steps;
create policy deal_steps_select on deal_steps for select to authenticated
  using (app_is_deal_member(deal_id, auth.uid()) or app_is_overseer(auth.uid()));

-- 20260612150000's audit_log_select (tenant-blind overseer).
drop policy if exists audit_log_select on audit_log;
create policy audit_log_select on audit_log for select to authenticated
  using (actor_id = auth.uid() or app_is_overseer(auth.uid()));

drop function if exists app_actor_in_user_tenant(uuid, uuid);
drop function if exists app_user_is_external(uuid);
drop function if exists app_is_deal_overseer(uuid, uuid);

commit;
