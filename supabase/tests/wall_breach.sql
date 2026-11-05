-- supabase/tests/wall_breach.sql
-- Verifies the Chinese-wall trigger on deal_memberships (v3 §5, shipped with the
-- Gate 0 RPC in 20260714170000). A research/trading user can NEVER be granted a
-- deal seat; internal deal staff can. Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/wall_breach.sql
-- Wrapped in a transaction that always ROLLBACKs.

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

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-000000000009';
  v_bank     uuid := gen_random_uuid();
  v_deal     uuid := gen_random_uuid();
  v_md       uuid := gen_random_uuid();
  v_research uuid := gen_random_uuid();
  v_trading  uuid := gen_random_uuid();
  v_ib       uuid := gen_random_uuid();
  v_role     uuid;
  v_blocked  boolean;
  v_cnt      int;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_md,       'wb-md@example.com',       jsonb_build_object('department','ib','tenant_id',v_tenant)),
    (v_research, 'wb-research@example.com', jsonb_build_object('department','research','tenant_id',v_tenant)),
    (v_trading,  'wb-trading@example.com',  jsonb_build_object('department','trading','tenant_id',v_tenant)),
    (v_ib,       'wb-ib@example.com',       jsonb_build_object('department','ib','tenant_id',v_tenant));

  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'WB Test Bank', 'bank');
  insert into deals (id, tenant_id, code, codename, bank_id)
    values (v_deal, v_tenant, 'WB-TEST-001', 'Project Wall', v_bank);
  select id into v_role from roles where slug = 'deal_team';

  -- Research is rejected.
  v_blocked := false;
  begin
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by)
      values (v_deal, v_research, v_role, 'deal_team', v_md);
  exception when others then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a research user was granted a deal seat'; end if;

  -- Trading is rejected.
  v_blocked := false;
  begin
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by)
      values (v_deal, v_trading, v_role, 'deal_team', v_md);
  exception when others then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a trading user was granted a deal seat'; end if;

  -- An internal (IB) user is allowed.
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by)
    values (v_deal, v_ib, v_role, 'deal_team', v_md);
  select count(*) into v_cnt from deal_memberships where deal_id = v_deal and user_id = v_ib;
  if v_cnt <> 1 then raise exception 'FAIL: an IB user was not granted a seat'; end if;

  -- The wall also guards UPDATE (moving a seat to a walled user).
  v_blocked := false;
  begin
    update deal_memberships set user_id = v_research where deal_id = v_deal and user_id = v_ib;
  exception when others then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: update to a research user bypassed the wall'; end if;

  raise notice 'PASS: wall-breach trigger rejects research/trading on insert and update; allows internal staff';
end $$;

rollback;
