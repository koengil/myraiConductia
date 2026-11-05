-- supabase/tests/deal_step_skill_runs.sql
-- Verifies the skill-run ledger: deal_step_skill_runs exists alongside the
-- documents.step_skill_run_id provenance column, a run row inserts, the row is
-- immutable (UPDATE and DELETE both blocked), the outcome/result_text pairing
-- holds in both directions, digest must be 64 lowercase hex characters, and the
-- table is off the browser's REST surface: the authenticated role holds no
-- grant, so a deal member, a same-tenant non-member and another tenant's
-- overseer are all refused alike.
-- Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/deal_step_skill_runs.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.

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
begin
  perform 1 from information_schema.tables where table_name = 'deal_step_skill_runs';
  if not found then raise exception 'FAIL: deal_step_skill_runs missing'; end if;

  perform 1 from information_schema.columns
    where table_name = 'documents' and column_name = 'step_skill_run_id';
  if not found then raise exception 'FAIL: documents.step_skill_run_id missing'; end if;

  raise notice 'OK: skill run schema';
end $$;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant  uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank    uuid := gen_random_uuid();
  v_md      uuid := gen_random_uuid();
  v_deal    uuid := gen_random_uuid();
  v_step    uuid := gen_random_uuid();
  v_run     uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_other_tenant uuid := '00000000-0000-4000-8000-00000000000d';
  v_other_bank uuid := gen_random_uuid();
  v_overseer uuid := gen_random_uuid();
  v_digest  text := repeat('a', 64);
  v_blocked boolean;
  v_cnt     int;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'skill-run-md@example.test',
            jsonb_build_object('department', 'ib', 'tenant_id', v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'Skill Run Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;
  insert into deals (id, tenant_id, bank_id, code, codename, mandate_owner_id)
    values (v_deal, v_tenant, v_bank, 'SKRUN-2026-001', 'Project Skill Run', v_md);
  insert into deal_steps (id, deal_id, step_id, seq, status, origin)
    values (v_step, v_deal, 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6', null, 'pending', 'custom');

  insert into deal_step_skill_runs (
    id, deal_id, deal_step_id, actor_id, skill_id, version_id,
    digest, input, outcome, result_text
  )
  values (
    v_run, v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
    v_digest, 'the input', 'succeeded', 'the result'
  );

  select count(*) into v_cnt from deal_step_skill_runs where id = v_run;
  if v_cnt <> 1 then raise exception 'FAIL: run row did not insert, found %', v_cnt; end if;

  v_blocked := false;
  begin
    update deal_step_skill_runs set result_text = 'tampered' where id = v_run;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: UPDATE on deal_step_skill_runs was not blocked'; end if;

  v_blocked := false;
  begin
    delete from deal_step_skill_runs where id = v_run;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: DELETE on deal_step_skill_runs was not blocked'; end if;

  v_blocked := false;
  begin
    insert into deal_step_skill_runs (
      id, deal_id, deal_step_id, actor_id, skill_id, version_id,
      digest, input, outcome, result_text
    )
    values (
      gen_random_uuid(), v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
      v_digest, 'the input', 'succeeded', null
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: succeeded with NULL result_text was accepted'; end if;

  v_blocked := false;
  begin
    insert into deal_step_skill_runs (
      id, deal_id, deal_step_id, actor_id, skill_id, version_id,
      digest, input, outcome, result_text, error_message
    )
    values (
      gen_random_uuid(), v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
      v_digest, 'the input', 'failed', 'the result', 'boom'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: failed with a non-null result_text was accepted'; end if;

  v_blocked := false;
  begin
    insert into deal_step_skill_runs (
      id, deal_id, deal_step_id, actor_id, skill_id, version_id,
      digest, input, outcome, result_text
    )
    values (
      gen_random_uuid(), v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
      upper(v_digest), 'the input', 'succeeded', 'the result'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: uppercase digest was accepted'; end if;

  v_blocked := false;
  begin
    insert into deal_step_skill_runs (
      id, deal_id, deal_step_id, actor_id, skill_id, version_id,
      digest, input, outcome, result_text
    )
    values (
      gen_random_uuid(), v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
      'deadbeef', 'the input', 'succeeded', 'the result'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: short digest was accepted'; end if;

  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
    select v_deal, v_md, id, 'md' from roles where slug = 'md';

  insert into auth.users (id, email, raw_user_meta_data)
    values (v_outsider, 'skill-run-outsider@example.test',
            jsonb_build_object('department', 'ib', 'tenant_id', v_tenant));
  update users set company_id = v_bank, company_role = 'member', is_external = false, status = 'active'
    where id = v_outsider;

  insert into auth.users (id, email, raw_user_meta_data)
    values (v_overseer, 'skill-run-overseer@example.test',
            jsonb_build_object('department', 'ib', 'tenant_id', v_other_tenant,
                               'firm_role', 'admin'));
  insert into companies (id, tenant_id, name, type)
    values (v_other_bank, v_other_tenant, 'Other Firm', 'bank');
  update users set company_id = v_other_bank, company_role = 'director', is_external = false,
                   status = 'active', firm_role = 'admin', tenant_id = v_other_tenant
    where id = v_overseer;

  if not app_is_overseer(v_overseer) then
    raise exception 'FAIL: the probe user is not an overseer, so it proves nothing';
  end if;

  set local role authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub', v_md, 'session_id', v_md)::text, true);
  v_blocked := false;
  begin
    select count(*) into v_cnt from deal_step_skill_runs where id = v_run;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: the deal member reached the table as authenticated, saw %', v_cnt;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'session_id', v_outsider)::text, true);
  v_blocked := false;
  begin
    select count(*) into v_cnt from deal_step_skill_runs where id = v_run;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: a same-tenant non-member reached the table as authenticated, saw %', v_cnt;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_overseer, 'session_id', v_overseer)::text, true);
  v_blocked := false;
  begin
    select count(*) into v_cnt from deal_step_skill_runs where id = v_run;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: another tenant''s overseer read the runs, saw %', v_cnt;
  end if;

  reset role;

  raise notice 'OK: run rows insert, are immutable, enforce the outcome and digest checks, and are unreachable by the authenticated role';
end $$;

rollback;
