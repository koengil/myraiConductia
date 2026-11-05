-- supabase/tests/project_rail.sql
-- Verifies the project-owned rail model: deal creation seeding the rail, and the
-- structural functions. Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/project_rail.sql
-- Each block is wrapped in a transaction that always ROLLBACKs.

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
  v_tenant uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_deal   uuid;
  v_res    jsonb;
  v_a      uuid;
  v_b      uuid;
  v_c      uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'pr-md2@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'PR Test Bank 2', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Rail Remove',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 3,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','p1-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','p1-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','p1-s3','seq',3,'phaseIndex',1,'displayOrder',3)
    ),
    p_census_version => 'test-1x3',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  );
  v_deal := (v_res->'deal'->>'id')::uuid;

  select id into v_a from deal_steps where deal_id = v_deal and step_id = 'p1-s1';
  select id into v_b from deal_steps where deal_id = v_deal and step_id = 'p1-s2';
  select id into v_c from deal_steps where deal_id = v_deal and step_id = 'p1-s3';

  update deal_steps set status = 'complete' where id = v_b;
  begin
    perform rail_remove_step(v_deal, v_md, v_b, array['p1-s1']::text[]);
    raise exception 'FAIL: removing a complete step must be refused';
  exception when sqlstate 'P0003' then null;
  end;

  begin
    perform rail_remove_step(v_deal, v_md, v_a, array['p1-s1']::text[]);
    raise exception 'FAIL: removing a protected step must be refused';
  exception when sqlstate 'P0004' then null;
  end;

  v_res := rail_remove_step(v_deal, v_md, v_c, array['p1-s1']::text[]);
  if (v_res->>'currentStepId') is not null then
    raise exception 'FAIL: removing the last unfinished step must leave no current step';
  end if;
  if (select anchor_step_id from deal_steps where id = v_c) <> v_b then
    raise exception 'FAIL: removal must record the current predecessor as the anchor';
  end if;
  if exists (select 1 from deal_steps where deal_id = v_deal and status = 'current' and removed_at is null) then
    raise exception 'FAIL: no active row may remain status=''current'' when reselection yields null';
  end if;

  v_res := rail_remove_step(v_deal, v_md, v_c, array['p1-s1']::text[]);
  if (v_res->>'removed')::boolean then
    raise exception 'FAIL: repeated removal must be idempotent';
  end if;

  perform rail_restore_step(v_deal, v_md, v_c);
  if (select current_deal_step_id from deals where id = v_deal) is distinct from v_c
     or (select current_step_seq from deals where id = v_deal) is distinct from 3 then
    raise exception 'FAIL: restoring the step removed as the last unfinished one must return the current position to it';
  end if;

  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'advance' and actor_id = v_md
       and detail->'from' = '3'::jsonb and detail->'to' = 'null'::jsonb
       and detail->>'fromStepKey' = 'p1-s3'
  ) then
    raise exception 'FAIL: removing the current step must audit the move to no active step';
  end if;
  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'update'
       and detail->>'rail' = 'remove' and detail->>'stepKey' = 'p1-s3'
  ) then
    raise exception 'FAIL: a removal audit row must name the step by its key';
  end if;
  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'advance' and actor_id = v_md
       and detail->'from' = 'null'::jsonb and detail->'to' = '3'::jsonb
       and detail->>'toStepKey' = 'p1-s3'
  ) then
    raise exception 'FAIL: restoring a step that retakes the current position must audit the move';
  end if;

  raise notice 'OK: rail_remove_step refusals, empty reselection and restore';
end $$;

rollback;

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
  v_tenant uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_deal   uuid;
  v_res    jsonb;
  v_b      uuid;
  v_c      uuid;
  v_d      uuid;
  v_count    int;
  v_span     int;
  v_distinct int;
begin
  if not exists (
    select 1 from company_permissions
     where key = 'company:deals:steps:structure' and category = 'Deals'
  ) then
    raise exception 'FAIL: the company:deals:steps:structure permission must be in the catalogue';
  end if;

  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'pr-md3@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'PR Test Bank 3', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Rail Reselect',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 2,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','p1-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','p1-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','p1-s3','seq',3,'phaseIndex',1,'displayOrder',3),
      jsonb_build_object('stepId','p1-s4','seq',4,'phaseIndex',1,'displayOrder',4)
    ),
    p_census_version => 'test-1x4',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  );
  v_deal := (v_res->'deal'->>'id')::uuid;

  if exists (
    select 1 from deal_steps
     where deal_id = v_deal and (phase_index is null or display_order is null or origin <> 'catalog')
  ) then
    raise exception 'FAIL: create_deal_gate0 must seed phase_index, display_order and origin';
  end if;
  select count(*), max(display_order) - min(display_order) + 1, count(distinct display_order)
    into v_count, v_span, v_distinct
    from deal_steps where deal_id = v_deal;
  if v_count <> v_span or v_count <> v_distinct then
    raise exception 'FAIL: create_deal_gate0 must seed a dense display_order, count=% span=% distinct=%', v_count, v_span, v_distinct;
  end if;
  if (select current_deal_step_id from deals where id = v_deal) is distinct from
       (select id from deal_steps where deal_id = v_deal and status = 'current')
     or (select current_step_seq from deals where id = v_deal) is distinct from 2 then
    raise exception 'FAIL: create_deal_gate0 must seed current_deal_step_id in agreement with current_step_seq';
  end if;

  select id into v_b from deal_steps where deal_id = v_deal and step_id = 'p1-s2';
  select id into v_c from deal_steps where deal_id = v_deal and step_id = 'p1-s3';
  select id into v_d from deal_steps where deal_id = v_deal and step_id = 'p1-s4';

  v_res := rail_remove_step(v_deal, v_md, v_b, array[]::text[]);
  if (v_res->>'currentStepId')::uuid is distinct from v_c then
    raise exception 'FAIL: removing a mid-rail current step must advance to the immediate next unfinished step, got %', v_res->>'currentStepId';
  end if;
  if (select status from deal_steps where id = v_b) <> 'current' then
    raise exception 'FAIL: removal must never change the removed step''s own status';
  end if;
  if (select status from deal_steps where id = v_c) <> 'current' then
    raise exception 'FAIL: the reselected step''s own status must become current';
  end if;

  perform rail_restore_step(v_deal, v_md, v_b);
  if (select count(*) from deal_steps where deal_id = v_deal and status = 'current' and removed_at is null) <> 1 then
    raise exception 'FAIL: restoring a step removed while current must not create a second current position';
  end if;
  if (select current_deal_step_id from deals where id = v_deal) is distinct from v_c then
    raise exception 'FAIL: restore must leave the current position where reselection put it';
  end if;
  if (select status from deal_steps where id = v_b) <> 'pending' then
    raise exception 'FAIL: a restored step that lost the current position must return as pending';
  end if;

  perform rail_remove_step(v_deal, v_md, v_c, array[]::text[]);
  v_res := rail_remove_step(v_deal, v_md, v_d, array[]::text[]);
  if (v_res->>'currentStepId')::uuid is distinct from v_b then
    raise exception 'FAIL: removing the last unfinished step must fall back to the earliest remaining unfinished step, got %', v_res->>'currentStepId';
  end if;
  if (select status from deal_steps where id = v_b) <> 'current' then
    raise exception 'FAIL: the fallback-reselected step''s own status must become current';
  end if;
  if (select current_deal_step_id from deals where id = v_deal) is distinct from v_b
     or (select current_step_seq from deals where id = v_deal) is distinct from 2 then
    raise exception 'FAIL: fallback reselection must move current_deal_step_id and current_step_seq';
  end if;
  if exists (
    select 1 from deal_steps
     where deal_id = v_deal and (status = 'complete' or completed_at is not null or completed_by is not null)
  ) then
    raise exception 'FAIL: reselection must never synthesize a completion';
  end if;

  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'advance' and actor_id = v_md
       and detail->'from' = '2'::jsonb and detail->'to' = '3'::jsonb
       and detail->>'fromStepKey' = 'p1-s2' and detail->>'toStepKey' = 'p1-s3'
  ) then
    raise exception 'FAIL: removing a mid-rail current step must audit the move to the reselected step';
  end if;
  if (select count(*) from audit_log where deal_id = v_deal and action = 'advance') <> 3 then
    raise exception 'FAIL: only the three removals that moved the current position may audit an advance, got %',
      (select count(*) from audit_log where deal_id = v_deal and action = 'advance');
  end if;

  raise notice 'OK: create_deal_gate0 seeds the rail, rail_remove_step reselection';
end $$;

rollback;

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
  v_tenant   uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank     uuid := gen_random_uuid();
  v_md       uuid := gen_random_uuid();
  v_deal     uuid;
  v_res      jsonb;
  v_a        uuid;
  v_b        uuid;
  v_c        uuid;
  v_order    uuid[];
  v_count    int;
  v_span     int;
  v_distinct int;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'pr-md4@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'PR Test Bank 4', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Rail Restore',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','p1-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','p1-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','p1-s3','seq',3,'phaseIndex',1,'displayOrder',3)
    ),
    p_census_version => 'test-1x3',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  );
  v_deal := (v_res->'deal'->>'id')::uuid;

  select id into v_a from deal_steps where deal_id = v_deal and step_id = 'p1-s1';
  select id into v_b from deal_steps where deal_id = v_deal and step_id = 'p1-s2';
  select id into v_c from deal_steps where deal_id = v_deal and step_id = 'p1-s3';

  perform rail_remove_step(v_deal, v_md, v_b, array[]::text[]);
  perform rail_restore_step(v_deal, v_md, v_b);

  select array_agg(id order by display_order) into v_order
    from deal_steps where deal_id = v_deal and removed_at is null;
  if v_order <> array[v_a, v_b, v_c] then
    raise exception 'FAIL: restore must return the step to its original position, got %', v_order;
  end if;
  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'update'
       and detail->>'rail' = 'restore' and detail->>'stepKey' = 'p1-s2'
  ) then
    raise exception 'FAIL: a restore audit row must name the step by its key';
  end if;

  v_res := rail_restore_step(v_deal, v_md, v_b);
  if (v_res->>'restored')::boolean then
    raise exception 'FAIL: restoring an active step must be idempotent';
  end if;

  perform rail_remove_step(v_deal, v_md, v_b, array[]::text[]);
  perform rail_remove_step(v_deal, v_md, v_a, array[]::text[]);
  perform rail_restore_step(v_deal, v_md, v_b);

  select array_agg(id order by display_order) into v_order
    from deal_steps where deal_id = v_deal and removed_at is null;
  if v_order <> array[v_c, v_b] then
    raise exception 'FAIL: restore with a removed anchor must append to the phase, got %', v_order;
  end if;

  select count(*), max(display_order) - min(display_order) + 1, count(distinct display_order)
    into v_count, v_span, v_distinct
    from deal_steps where deal_id = v_deal;
  if v_count <> v_span or v_count <> v_distinct then
    raise exception 'FAIL: restore must keep display_order dense across active and removed rows, count=% span=% distinct=%', v_count, v_span, v_distinct;
  end if;

  raise notice 'OK: rail_restore_step';
end $$;

rollback;

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

-- #312: an internal user of the bank, active, with an optional seat on a deal.
create function pg_temp.skip_user(p_email text, p_tenant uuid, p_bank uuid) returns uuid
language plpgsql as $f$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_id, p_email, jsonb_build_object('department','ib','tenant_id',p_tenant));
  update users set company_id = p_bank, company_role = 'member', is_external = false, status = 'active'
    where id = v_id;
  return v_id;
end
$f$;
create function pg_temp.skip_seat(p_deal uuid, p_user uuid, p_role text) returns void
language sql as $f$
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
    select p_deal, p_user, id, p_role from roles where slug = p_role;
$f$;
-- True when rail_skip_step refuses the approver with 42501. Any other SQLSTATE
-- propagates, and an accepted call returns false (never raises FAIL inside the
-- handler, which a P0001 expectation would swallow).
create function pg_temp.skip_refused(p_deal uuid, p_actor uuid, p_step uuid, p_approver uuid) returns boolean
language plpgsql as $f$
begin
  perform rail_skip_step(p_deal, p_actor, p_step, p_approver, 'Handled off platform');
  return false;
exception when sqlstate '42501' then
  return true;
end
$f$;

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_deal   uuid;
  v_res    jsonb;
  v_a      uuid;
  v_b      uuid;
  v_c      uuid;
  v_dt      uuid;
  v_legal   uuid;
  v_ro      uuid;
  v_buyer   uuid;
  v_susp    uuid;
  v_nobody  uuid;
  v_split   uuid;
  v_other_dt uuid;
  v_other_deal uuid;
  v_refused boolean;
  v_name    text;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'pr-md5@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'PR Test Bank 5', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Rail Skip',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','p1-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','p1-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','p1-s3','seq',3,'phaseIndex',1,'displayOrder',3)
    ),
    p_census_version => 'test-1x3',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  );
  v_deal := (v_res->'deal'->>'id')::uuid;

  select id into v_a from deal_steps where deal_id = v_deal and step_id = 'p1-s1';
  select id into v_b from deal_steps where deal_id = v_deal and step_id = 'p1-s2';
  select id into v_c from deal_steps where deal_id = v_deal and step_id = 'p1-s3';

  -- The actor holds an active md seat from create_deal_gate0: the skips below
  -- name v_md as approver, which the SQL approver check (#312) only accepts then.
  if not exists (select 1 from deal_memberships m join users u on u.id = m.user_id
                  where m.deal_id = v_deal and m.user_id = v_md and m.deal_role = 'md'
                    and u.status = 'active') then
    raise exception 'FAIL: create_deal_gate0 must give the actor an active md seat';
  end if;

  -- Refusal assertions use a flag: an accepted call fails here whatever the code,
  -- and any SQLSTATE other than the expected one propagates.
  v_refused := false;
  begin
    perform rail_skip_step(v_deal, v_md, v_b, v_md, '');
  exception when sqlstate 'P0001' then v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL: skip must require a reason';
  end if;

  -- #312: the approver must hold an active md, deal_team or legal seat on this
  -- deal. Each ineligible kind is refused with 42501, and nothing is written.
  v_dt     := pg_temp.skip_user('pr-skip-dt@example.com', v_tenant, v_bank);
  v_legal  := pg_temp.skip_user('pr-skip-legal@example.com', v_tenant, v_bank);
  v_ro     := pg_temp.skip_user('pr-skip-ro@example.com', v_tenant, v_bank);
  v_buyer  := pg_temp.skip_user('pr-skip-buyer@example.com', v_tenant, v_bank);
  v_susp   := pg_temp.skip_user('pr-skip-susp@example.com', v_tenant, v_bank);
  v_nobody := pg_temp.skip_user('pr-skip-nobody@example.com', v_tenant, v_bank);
  v_other_dt := pg_temp.skip_user('pr-skip-other@example.com', v_tenant, v_bank);
  perform pg_temp.skip_seat(v_deal, v_dt, 'deal_team');
  perform pg_temp.skip_seat(v_deal, v_legal, 'legal');
  perform pg_temp.skip_seat(v_deal, v_ro, 'read_only');
  perform pg_temp.skip_seat(v_deal, v_buyer, 'buyer');
  perform pg_temp.skip_seat(v_deal, v_susp, 'deal_team');
  update users set status = 'suspended' where id = v_susp;
  -- A tenant split: the user row moves to another tenant, the company and the seat
  -- stay. The seat alone is not a tenant boundary.
  v_split  := pg_temp.skip_user('pr-skip-split@example.com', v_tenant, v_bank);
  perform pg_temp.skip_seat(v_deal, v_split, 'deal_team');
  update users set tenant_id = '00000000-0000-4000-8000-0000000000bd' where id = v_split;
  if not exists (select 1 from deal_memberships where deal_id = v_deal and user_id = v_split) then
    raise exception 'FAIL: fixture: a tenant change alone must leave the seat in place';
  end if;

  -- A seat on another deal of the same bank does not make an approver here.
  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Rail Skip Other',
    p_target_name    => 'Other Target',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','p1-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','p1-s2','seq',2,'phaseIndex',1,'displayOrder',2)
    ),
    p_census_version => 'test-1x2',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  );
  v_other_deal := (v_res->'deal'->>'id')::uuid;
  perform pg_temp.skip_seat(v_other_deal, v_other_dt, 'md');

  if not pg_temp.skip_refused(v_deal, v_md, v_b, v_ro) then
    raise exception 'FAIL: a read_only approver must be refused';
  end if;
  if not pg_temp.skip_refused(v_deal, v_md, v_b, v_buyer) then
    raise exception 'FAIL: a buyer approver must be refused';
  end if;
  if not pg_temp.skip_refused(v_deal, v_md, v_b, v_susp) then
    raise exception 'FAIL: a suspended approver must be refused';
  end if;
  if not pg_temp.skip_refused(v_deal, v_md, v_b, v_nobody) then
    raise exception 'FAIL: an approver with no seat must be refused';
  end if;
  if not pg_temp.skip_refused(v_deal, v_md, v_b, v_other_dt) then
    raise exception 'FAIL: an approver seated on another deal only must be refused';
  end if;
  if not pg_temp.skip_refused(v_deal, v_md, v_b, v_split) then
    raise exception 'FAIL: an approver whose user row left the deal''s tenant must be refused';
  end if;
  if not pg_temp.skip_refused(v_deal, v_md, v_b, null) then
    raise exception 'FAIL: a null approver must be refused';
  end if;
  if not pg_temp.skip_refused(v_deal, v_md, v_b, gen_random_uuid()) then
    raise exception 'FAIL: an unknown approver id must be refused';
  end if;
  if (select status from deal_steps where id = v_b) = 'skipped'
     or exists (select 1 from audit_log where deal_id = v_deal and detail->>'rail' = 'skip') then
    raise exception 'FAIL: a refused skip must leave the step and the audit trail untouched';
  end if;

  -- A legal approver is eligible: the role list is md, deal_team and legal.
  perform pg_temp.skip_seat(v_other_deal, v_legal, 'legal');
  perform rail_skip_step(v_other_deal, v_md,
    (select id from deal_steps where deal_id = v_other_deal and step_id = 'p1-s1'), v_legal, 'Handled off platform');
  if (select work->'skip'->>'approverRole' from deal_steps where deal_id = v_other_deal and step_id = 'p1-s1')
       is distinct from 'legal' then
    raise exception 'FAIL: a legal approver must be accepted';
  end if;

  -- An eligible approver other than the actor passes, and the record carries the
  -- approver's id, the SQL-read name and the seat's role.
  v_res := rail_skip_step(v_deal, v_md, v_b, v_dt, 'Handled off platform');
  select coalesce(nullif(btrim(display_name), ''), nullif(btrim(full_name), ''), email)
    into v_name from users where id = v_dt;
  if (select skip_approver_id from deal_steps where id = v_b) is distinct from v_dt
     or (select work->'skip'->>'approverId' from deal_steps where id = v_b) is distinct from v_dt::text
     or (select work->'skip'->>'approver' from deal_steps where id = v_b) is distinct from v_name
     or (select work->'skip'->>'approverRole' from deal_steps where id = v_b) is distinct from 'deal_team' then
    raise exception 'FAIL: work.skip must carry approverId, the approver name and the seat role (and skip_approver_id the id)';
  end if;
  if (select status from deal_steps where id = v_b) <> 'skipped'
     or (select skip_reason from deal_steps where id = v_b) is null
     or (select skip_approver_id from deal_steps where id = v_b) is null
     or (select removed_at from deal_steps where id = v_b) is not null then
    raise exception 'FAIL: skip must set status, record approver and reason, and keep the step on the rail';
  end if;
  if (select completion_note from deal_steps where id = v_b) is distinct from 'Handled off platform'
     or (select completed_by from deal_steps where id = v_b) is distinct from v_md
     or (select work->'skip'->>'reason' from deal_steps where id = v_b) is distinct from 'Handled off platform'
     or coalesce((select work->'skip'->>'approver' from deal_steps where id = v_b), '') = '' then
    raise exception 'FAIL: a rail skip must land on the step record develop reads (completion note, completer, work.skip)';
  end if;
  if (select jsonb_typeof(work->'skip'->'approverRole') from deal_steps where id = v_b) is distinct from 'string'
     or (select work->'skip'->>'at' from deal_steps where id = v_b) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
    raise exception 'FAIL: work.skip must carry approverRole and an ISO UTC timestamp, as PATCH /steps { skip } writes';
  end if;
  if (v_res->>'currentStepId')::uuid is distinct from v_a then
    raise exception 'FAIL: skipping a step that is not current must leave the current position, got %', v_res->>'currentStepId';
  end if;

  v_res := rail_skip_step(v_deal, v_md, v_a, v_md, 'Handled off platform');
  if (v_res->>'currentStepId')::uuid is distinct from v_c
     or (select current_deal_step_id from deals where id = v_deal) is distinct from v_c
     or (select status from deal_steps where id = v_c) <> 'current' then
    raise exception 'FAIL: skipping the current step must reselect the next unfinished step, got %', v_res->>'currentStepId';
  end if;

  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'advance' and actor_id = v_md
       and detail->'from' = '1'::jsonb and detail->'to' = '3'::jsonb
       and detail->>'fromStepKey' = 'p1-s1' and detail->>'toStepKey' = 'p1-s3'
  ) then
    raise exception 'FAIL: skipping the current step must audit its position move';
  end if;
  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'update'
       and detail->>'rail' = 'skip' and detail->>'stepKey' = 'p1-s1'
       and detail->>'reason' = 'Handled off platform'
  ) then
    raise exception 'FAIL: a skip audit row must name the step by its key';
  end if;

  update deal_steps set status = 'complete' where id = v_c;
  begin
    perform rail_skip_step(v_deal, v_md, v_c, v_md, 'Handled off platform');
    raise exception 'FAIL: skipping a complete step must be refused';
  exception when sqlstate 'P0003' then null;
  end;

  raise notice 'OK: rail_skip_step';
end $$;

rollback;

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
  v_tenant uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_deal   uuid;
  v_res    jsonb;
  v_a      uuid;
  v_b      uuid;
  v_c      uuid;
  v_order  uuid[];
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'pr-md6@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'PR Test Bank 6', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Rail Restore Phase',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','p1-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','p2-s2','seq',2,'phaseIndex',2,'displayOrder',2),
      jsonb_build_object('stepId','p2-s3','seq',3,'phaseIndex',2,'displayOrder',3)
    ),
    p_census_version => 'test-2x3',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  );
  v_deal := (v_res->'deal'->>'id')::uuid;

  select id into v_a from deal_steps where deal_id = v_deal and step_id = 'p1-s1';
  select id into v_b from deal_steps where deal_id = v_deal and step_id = 'p2-s2';
  select id into v_c from deal_steps where deal_id = v_deal and step_id = 'p2-s3';

  perform rail_remove_step(v_deal, v_md, v_b, array[]::text[]);
  perform rail_remove_step(v_deal, v_md, v_c, array[]::text[]);
  perform rail_restore_step(v_deal, v_md, v_c);

  select array_agg(id order by display_order) into v_order
    from deal_steps where deal_id = v_deal and removed_at is null;
  if v_order <> array[v_a, v_c] then
    raise exception 'FAIL: restoring into an emptied phase must land after the earlier phases, got %', v_order;
  end if;

  perform rail_restore_step(v_deal, v_md, v_b);
  perform rail_remove_step(v_deal, v_md, v_b, array[]::text[]);
  perform rail_restore_step(v_deal, v_md, v_b);

  select array_agg(id order by display_order) into v_order
    from deal_steps where deal_id = v_deal and removed_at is null;
  if v_order <> array[v_a, v_b, v_c] then
    raise exception 'FAIL: a step removed while first in its phase must return first in that phase, got %', v_order;
  end if;

  raise notice 'OK: rail_restore_step into an emptied phase';
end $$;

rollback;
