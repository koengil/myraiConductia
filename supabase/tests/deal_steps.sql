-- supabase/tests/deal_steps.sql
-- Verifies G16 step-state seeding by create_deal_gate0. A deal entering at seq 12
-- over a 20-step census yields: seq 1..11 skipped_entry (NOT complete), seq 12
-- current, seq 13..20 pending. Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/deal_steps.sql
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

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000a';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_steps  jsonb;
  v_res    jsonb;
  v_deal   uuid;
  v_cnt    int;
  v_status text;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'ds-md@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'DS Test Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id = v_md;

  -- A 20-step synthetic census (stepId + seq), like the route passes.
  select jsonb_agg(jsonb_build_object('stepId', 'p1-s' || g, 'seq', g))
    into v_steps
    from generate_series(1, 20) g;

  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Kestrel',
    p_target_name    => 'Canva',
    p_entry_step_seq => 12,
    p_steps          => v_steps,
    p_census_version => 'test-1x20',
    p_conflicts      => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
  );
  v_deal := (v_res->'deal'->>'id')::uuid;

  select count(*) into v_cnt from deal_steps where deal_id = v_deal;
  if v_cnt <> 20 then raise exception 'FAIL: expected 20 step rows, found %', v_cnt; end if;

  select count(*) into v_cnt from deal_steps where deal_id = v_deal and status = 'skipped_entry';
  if v_cnt <> 11 then raise exception 'FAIL: expected 11 skipped_entry (seq 1..11), found %', v_cnt; end if;

  select count(*) into v_cnt from deal_steps where deal_id = v_deal and status = 'current';
  if v_cnt <> 1 then raise exception 'FAIL: expected exactly 1 current, found %', v_cnt; end if;

  select status into v_status from deal_steps where deal_id = v_deal and seq = 12;
  if v_status <> 'current' then raise exception 'FAIL: seq 12 should be current, got %', v_status; end if;

  select count(*) into v_cnt from deal_steps where deal_id = v_deal and status = 'pending';
  if v_cnt <> 8 then raise exception 'FAIL: expected 8 pending (seq 13..20), found %', v_cnt; end if;

  -- No pre-entry step is marked complete (they were skipped, not done).
  select count(*) into v_cnt from deal_steps where deal_id = v_deal and status = 'complete';
  if v_cnt <> 0 then raise exception 'FAIL: pre-entry steps must not be complete, found %', v_cnt; end if;

  -- Census version stored for drift detection.
  select count(*) into v_cnt from deal_steps where deal_id = v_deal and census_version = 'test-1x20';
  if v_cnt <> 20 then raise exception 'FAIL: census_version not stored on all rows'; end if;

  raise notice 'PASS: deal_steps seeded — 11 skipped_entry + 1 current + 8 pending, none complete, census stored';
end $$;

rollback;
