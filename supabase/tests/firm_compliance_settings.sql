-- supabase/tests/firm_compliance_settings.sql
-- Verifies the firm compliance settings writer (D105, 20261021140000_firm_compliance_settings_save.sql):
-- the save and its audit row are one transaction, the "from" is the row it replaced, the ceilings hold,
-- and only the service role may call it.
-- Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/firm_compliance_settings.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.

begin;
create or replace function pg_temp.authorize_fixture() returns trigger language plpgsql as $fx$
begin
  perform public.authorize_provisioned_profile(new.id, new.raw_user_meta_data);
  return new;
end
$fx$;
drop trigger if exists zz_authorize_fixture on auth.users;
create trigger zz_authorize_fixture after insert on auth.users
  for each row execute function pg_temp.authorize_fixture();

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-0000000000e5';
  v_cco    uuid := gen_random_uuid();
  v_from   jsonb;
  v_detail jsonb;
  v_cnt    int;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_cco, 'd105-cco@example.com', jsonb_build_object('full_name','Cora Vance','firm_role','cco','department','compliance','tenant_id',v_tenant));

  -- First save: the firm was on the shipped defaults, and the audit says so.
  v_from := firm_compliance_settings_save(v_tenant, v_cco, 85::smallint, 50::smallint, 'sampled', 'confirm_external');
  if v_from <> jsonb_build_object('queuedFrom',70,'sampledFrom',40,'uncheckedFloor','routine','sendFriction','one_click','isDefault',true) then
    raise exception 'FAIL: first save from %', v_from;
  end if;
  select detail into v_detail from audit_log
    where tenant_id = v_tenant and action = 'update' and detail->>'kind' = 'compliance_settings'
    order by chain_seq desc limit 1;
  if v_detail->'to' <> jsonb_build_object('queuedFrom',85,'sampledFrom',50,'uncheckedFloor','sampled','sendFriction','confirm_external') then
    raise exception 'FAIL: first audit to %', v_detail;
  end if;

  -- Second save: "from" is the stored row, not the defaults.
  v_from := firm_compliance_settings_save(v_tenant, v_cco, 90::smallint, 80::smallint, 'queued', 'one_click');
  if v_from <> jsonb_build_object('queuedFrom',85,'sampledFrom',50,'uncheckedFloor','sampled','sendFriction','confirm_external') then
    raise exception 'FAIL: second save from %', v_from;
  end if;
  select count(*) into v_cnt from audit_log
    where tenant_id = v_tenant and action = 'update' and detail->>'kind' = 'compliance_settings';
  if v_cnt <> 2 then raise exception 'FAIL: % audit rows for two saves', v_cnt; end if;

  -- Over a ceiling: refused, and neither the row nor an audit row changes.
  begin
    perform firm_compliance_settings_save(v_tenant, v_cco, 100::smallint, 100::smallint, 'queued', 'one_click');
    raise exception 'FAIL: queued_from 100 saved';
  exception when check_violation then null;
  end;
  begin
    perform firm_compliance_settings_save(v_tenant, v_cco, 90::smallint, 81::smallint, 'queued', 'one_click');
    raise exception 'FAIL: sampled_from 81 saved';
  exception when check_violation then null;
  end;
  select count(*) into v_cnt from audit_log
    where tenant_id = v_tenant and action = 'update' and detail->>'kind' = 'compliance_settings';
  if v_cnt <> 2 then raise exception 'FAIL: a refused save left an audit row (% rows)', v_cnt; end if;
  if not exists (select 1 from firm_compliance_settings where tenant_id = v_tenant and queued_from = 90 and sampled_from = 80) then
    raise exception 'FAIL: a refused save changed the stored row';
  end if;

  -- Only the service role may call it.
  if has_function_privilege('authenticated', 'firm_compliance_settings_save(uuid,uuid,smallint,smallint,text,text)', 'execute')
     or has_function_privilege('anon', 'firm_compliance_settings_save(uuid,uuid,smallint,smallint,text,text)', 'execute') then
    raise exception 'FAIL: firm_compliance_settings_save is callable by a browser role';
  end if;

  raise notice 'firm_compliance_settings: all checks passed';
end $$;

rollback;
