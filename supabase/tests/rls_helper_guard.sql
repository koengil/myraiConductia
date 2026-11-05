-- #233 follow-up (20260930180000_rls_helper_caller_guard.sql): the RLS
-- helpers `authenticated` can execute answer only about the caller.
--
--   Asker   an internal deal-team member of tenant A
--   Target  the CCO of tenant A, who oversees the deal
--
-- As `authenticated` with sub = Asker, every helper asked about Target gives
-- the fixed "not you" answer; asked about Asker it answers truly. As the
-- database owner (psql, migrations, service-role functions) the full answer
-- still comes back.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_helper_guard.sql
-- Everything rolls back.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does (authorize_provisioned_profile over its metadata) and give it a
-- live session whose id is the user id, so impersonating claims can carry
-- session_id = sub.
create or replace function pg_temp.authorize_fixture() returns trigger language plpgsql as $fx$
begin
  perform public.authorize_provisioned_profile(new.id, new.raw_user_meta_data);
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (new.id, new.id, now(), now(), 'aal1') on conflict (id) do nothing;
  return new;
end
$fx$;
drop trigger if exists zz_authorize_fixture on auth.users;
create trigger zz_authorize_fixture after insert on auth.users
  for each row execute function pg_temp.authorize_fixture();

create function pg_temp.expect(actual text, expected text, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
end;
$$;
-- New functions no longer grant PUBLIC EXECUTE by default (#233).
grant execute on all functions in schema pg_temp to authenticated;

create temp table fx (asker uuid, target uuid, tenant uuid, bank uuid, deal uuid) on commit drop;
grant select on fx to authenticated;

do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_asker  uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_bank   uuid := gen_random_uuid();
  v_deal   uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_asker,  'guard-asker@example.test',  jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_target, 'guard-target@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance'));
  update users set status = 'active', is_external = false where id in (v_asker, v_target);
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'Guard Probe Bank', 'bank');
  update users set company_id = v_bank, firm_role = 'cco', company_role = 'director' where id = v_target;
  update users set company_id = v_bank, company_role = 'member' where id = v_asker;
  insert into deals (id, tenant_id, code, codename, bank_id, mandate_owner_id)
    values (v_deal, v_tenant, 'GUARD-TEST-001', 'Project Guard', v_bank, v_target);
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by)
    select v_deal, s.user_id, r.id, s.slug, v_target
    from (values (v_target, 'md'), (v_asker, 'deal_team')) as s (user_id, slug)
    join roles r on r.slug = s.slug;

  insert into fx values (v_asker, v_target, v_tenant, v_bank, v_deal);
end
$$;

-- ── As the owner: full answers about anyone ──────────────────────────────────
select pg_temp.expect(app_is_overseer(target)::text, 'true', 'owner: overseer(target)') from fx;
select pg_temp.expect(app_user_tenant(target)::text, tenant::text, 'owner: tenant(target)') from fx;
select pg_temp.expect(app_is_deal_overseer(deal, target)::text, 'true', 'owner: deal_overseer(target)') from fx;
select pg_temp.expect(app_user_is_external(target)::text, 'false', 'owner: external(target)') from fx;
select pg_temp.expect(app_actor_in_user_tenant(target, asker)::text, 'true', 'owner: actor_in_tenant(non-overseer)') from fx;

-- ── As authenticated, sub = asker ────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', asker, 'session_id', asker, 'role', 'authenticated')::text, true) from fx;
set local role authenticated;

-- Asked about someone else: the fixed answer, whatever the truth is.
select pg_temp.expect(app_is_overseer(target)::text, 'false', 'overseer(other)') from fx;
select pg_temp.expect(app_user_tenant(target)::text, null, 'tenant(other)') from fx;
select pg_temp.expect(app_user_company(target)::text, null, 'company(other)') from fx;
select pg_temp.expect(app_is_deal_member(deal, target)::text, 'false', 'deal_member(other)') from fx;
select pg_temp.expect(app_is_deal_md(deal, target)::text, 'false', 'deal_md(other)') from fx;
select pg_temp.expect(app_user_is_director(target)::text, 'false', 'director(other)') from fx;
select pg_temp.expect(app_is_deal_overseer(deal, target)::text, 'false', 'deal_overseer(other)') from fx;
select pg_temp.expect(app_user_is_external(target)::text, 'true', 'external(other)') from fx;
select pg_temp.expect(app_actor_in_user_tenant(asker, target)::text, 'false', 'actor_in_tenant(other)') from fx;
-- The already-guarded six give the same "not you" answer.
select pg_temp.expect(app_is_control_room(target)::text, 'false', 'control_room(other)') from fx;
select pg_temp.expect(app_company_is_access_root(target, bank)::text, 'false', 'access_root(other)') from fx;
select pg_temp.expect(app_has_company_permission(target, bank, 'company:access:assign')::text, 'false', 'permission(other)') from fx;

-- Asked about the caller: the true answer.
select pg_temp.expect(app_is_overseer(asker)::text, 'false', 'overseer(self)') from fx;
select pg_temp.expect(app_user_tenant(asker)::text, tenant::text, 'tenant(self)') from fx;
select pg_temp.expect(app_user_company(asker)::text, bank::text, 'company(self)') from fx;
select pg_temp.expect(app_is_deal_member(deal, asker)::text, 'true', 'deal_member(self)') from fx;
select pg_temp.expect(app_is_deal_md(deal, asker)::text, 'false', 'deal_md(self)') from fx;
select pg_temp.expect(app_user_is_director(asker)::text, 'false', 'director(self)') from fx;
select pg_temp.expect(app_is_deal_overseer(deal, asker)::text, 'false', 'deal_overseer(self)') from fx;
select pg_temp.expect(app_user_is_external(asker)::text, 'false', 'external(self)') from fx;
-- A non-overseer asking about itself still cannot probe whether another user
-- shares its tenant: users_select would not show it that colleague.
select pg_temp.expect(app_actor_in_user_tenant(target, asker)::text, 'false', 'actor_in_tenant(self, non-overseer)') from fx;

-- The policies still work: the asker reads the deal through deals_select.
select pg_temp.expect(count(*)::text, '1', 'deals_select still admits a member')
from deals where id = (select deal from fx);

-- ── As the target: the true answers the asker was refused ───────────────────
reset role;
select set_config('request.jwt.claims', json_build_object('sub', target, 'session_id', target, 'role', 'authenticated')::text, true) from fx;
set local role authenticated;
select pg_temp.expect(app_is_overseer(target)::text, 'true', 'overseer(self, cco)') from fx;
select pg_temp.expect(app_is_deal_overseer(deal, target)::text, 'true', 'deal_overseer(self, cco)') from fx;
-- The audit_log_select call shape: an overseer asking about an actor of its tenant.
select pg_temp.expect(app_actor_in_user_tenant(asker, target)::text, 'true', 'actor_in_tenant(self, cco)') from fx;
select pg_temp.expect(app_is_deal_md(deal, target)::text, 'true', 'deal_md(self, md)') from fx;
select pg_temp.expect(app_user_is_director(target)::text, 'true', 'director(self)') from fx;
reset role;

rollback;
