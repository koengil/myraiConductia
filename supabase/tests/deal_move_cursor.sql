-- supabase/tests/deal_move_cursor.sql
-- #249: a rail move and its audit row commit together. A rejected audit insert
-- must leave the cursor where it was. Run via psql; always ROLLBACKs.

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

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_deal   uuid;
  v_step2  uuid;
  v_step3  uuid;
  v_seq    int;
  v_audits int;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'move-cursor-md@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'Move Cursor Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_deal := (create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Move Cursor',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','m-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','m-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','m-s3','seq',3,'phaseIndex',1,'displayOrder',3)
    ),
    p_census_version => 'test-1x3',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  select id into v_step2 from deal_steps where deal_id = v_deal and step_id = 'm-s2';
  select id into v_step3 from deal_steps where deal_id = v_deal and step_id = 'm-s3';

  perform deal_move_cursor(v_deal, v_md, v_step2, 1, 2);
  select current_step_seq into v_seq from deals where id = v_deal;
  select count(*) into v_audits from audit_log
    where deal_id = v_deal and action = 'advance' and detail->>'to' = '2';
  if v_seq <> 2 or v_audits <> 1 then
    raise exception 'FAIL: move should land with one audit row (seq %, audits %)', v_seq, v_audits;
  end if;

  -- Reject the next audit insert; the move must not survive it.
  create function pg_temp.reject_audit() returns trigger language plpgsql as
    $f$ begin raise exception 'audit rejected' using errcode = 'P0009'; end $f$;
  create trigger reject_audit before insert on audit_log
    for each row execute function pg_temp.reject_audit();
  begin
    perform deal_move_cursor(v_deal, v_md, v_step3, 2, 3);
    raise exception 'FAIL: the move must fail with its audit';
  exception when sqlstate 'P0009' then null;
  end;
  drop trigger reject_audit on audit_log;

  select current_step_seq into v_seq from deals where id = v_deal;
  if v_seq <> 2 then
    raise exception 'FAIL: a rejected audit left the cursor at %', v_seq;
  end if;
end $$;

do $$
declare
  v_tenant  uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank    uuid;
  v_md      uuid;
  v_steps   jsonb := jsonb_build_array(
    jsonb_build_object('stepId','s-s1','seq',1,'phaseIndex',1,'displayOrder',1),
    jsonb_build_object('stepId','s-s2','seq',2,'phaseIndex',2,'displayOrder',2),
    jsonb_build_object('stepId','s-s3','seq',3,'phaseIndex',2,'displayOrder',3)
  );
  v_deal    uuid;
  v_won     uuid;
  v_step1   uuid;
  v_step2   uuid;
  v_step3   uuid;
  v_status  text;
begin
  select company_id, id into v_bank, v_md from users where email = 'move-cursor-md@example.com';

  v_deal := (create_deal_gate0(
    p_tenant_id => v_tenant, p_actor_id => v_md, p_bank_id => v_bank,
    p_codename => 'Project Intake Phase', p_target_name => 'Canva',
    p_entry_step_seq => 1, p_steps => v_steps, p_census_version => 'test-2x3',
    p_conflicts => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  select status into v_status from deals where id = v_deal;
  if v_status <> 'intake' then
    raise exception 'FAIL: a deal entering in phase 1 should be intake, got %', v_status;
  end if;

  select id into v_step1 from deal_steps where deal_id = v_deal and step_id = 's-s1';
  select id into v_step2 from deal_steps where deal_id = v_deal and step_id = 's-s2';
  select id into v_step3 from deal_steps where deal_id = v_deal and step_id = 's-s3';

  perform deal_move_cursor(v_deal, v_md, v_step2, 1, 2);
  select status into v_status from deals where id = v_deal;
  if v_status <> 'active' then
    raise exception 'FAIL: crossing into phase 2 should leave intake, got %', v_status;
  end if;

  perform deal_move_cursor(v_deal, v_md, v_step1, 2, 1);
  select status into v_status from deals where id = v_deal;
  if v_status <> 'active' then
    raise exception 'FAIL: moving back to phase 1 should not return to intake, got %', v_status;
  end if;

  update deals set status = 'paused' where id = v_deal;
  perform deal_move_cursor(v_deal, v_md, v_step3, 1, 3);
  select status into v_status from deals where id = v_deal;
  if v_status <> 'paused' then
    raise exception 'FAIL: a cursor move should not reactivate a paused deal, got %', v_status;
  end if;

  v_won := (create_deal_gate0(
    p_tenant_id => v_tenant, p_actor_id => v_md, p_bank_id => v_bank,
    p_codename => 'Project Entered Won', p_target_name => 'Linear',
    p_entry_step_seq => 2, p_steps => v_steps, p_census_version => 'test-2x3',
    p_conflicts => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  select status into v_status from deals where id = v_won;
  if v_status <> 'active' then
    raise exception 'FAIL: a deal entering in phase 2 should be active, got %', v_status;
  end if;

  raise notice 'PASS: a deal is intake through phase 1 and active once its cursor is past it, at entry or on a move, and never back';
end $$;

rollback;
