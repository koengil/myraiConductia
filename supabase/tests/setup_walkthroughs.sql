-- Versioned setup walkthrough authorization, concurrency, attestation, and RLS.
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/setup_walkthroughs.sql

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

do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_user uuid := '18000000-0000-4000-8000-000000000001';
  v_admin uuid := '18000000-0000-4000-8000-000000000002';
  v_result jsonb;
  v_audit_count bigint;
begin
  insert into auth.users (id, email) values
    (v_user, 'setup-user@example.test'),
    (v_admin, 'setup-admin@example.test')
  on conflict (id) do nothing;

  update users set
    tenant_id = v_tenant,
    company_id = null,
    company_role = null,
    firm_role = null,
    is_external = true,
    status = 'active'
  where id = v_user;
  update users set
    tenant_id = v_tenant,
    company_id = null,
    company_role = null,
    firm_role = 'admin',
    is_external = false,
    status = 'active'
  where id = v_admin;

  v_result := update_setup_walkthrough_progress(
    v_user,
    'user',
    1,
    0,
    array['data_security']::text[]
  );
  if (v_result->>'revision')::bigint <> 1
     or v_result->'completed_steps' <> '["data_security"]'::jsonb
     or v_result->>'completed_at' is not null then
    raise exception 'FAIL: first user progress snapshot is wrong: %', v_result;
  end if;
  if not exists (
    select 1 from audit_log
    where actor_id = v_user
      and action = 'update'
      and detail->>'reason' = 'setup_walkthrough_progress_updated'
  ) then
    raise exception 'FAIL: progress update audit row is missing';
  end if;

  select count(*) into v_audit_count from audit_log where actor_id = v_user;
  v_result := update_setup_walkthrough_progress(
    v_user,
    'user',
    1,
    1,
    array['data_security']::text[]
  );
  if (v_result->>'revision')::bigint <> 1
     or (select count(*) from audit_log where actor_id = v_user) <> v_audit_count then
    raise exception 'FAIL: idempotent retry changed revision or audit';
  end if;

  begin
    perform update_setup_walkthrough_progress(
      v_user, 'user', 1, 0, array['data_security']::text[]
    );
    raise exception 'FAIL: stale revision was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%stale_revision%' then
      raise exception 'FAIL: stale-revision refusal was %', sqlerrm;
    end if;
  end;

  begin
    perform update_setup_walkthrough_progress(
      v_user, 'administrator', 1, 0, array[]::text[]
    );
    raise exception 'FAIL: external user received administrator walkthrough';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%administrator_track_not_permitted%' then
      raise exception 'FAIL: administrator-track refusal was %', sqlerrm;
    end if;
  end;

  begin
    perform update_setup_walkthrough_progress(
      v_user, 'user', 1, 1, array['access_governance']::text[]
    );
    raise exception 'FAIL: invalid cross-track step was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%invalid_walkthrough_step%' then
      raise exception 'FAIL: invalid-step refusal was %', sqlerrm;
    end if;
  end;

  v_result := update_setup_walkthrough_progress(
    v_user,
    'user',
    1,
    1,
    array[
      'data_security',
      'data_room_boundaries',
      'communications_screening'
    ]::text[]
  );
  if (v_result->>'revision')::bigint <> 2
     or v_result->>'completed_at' is null then
    raise exception 'FAIL: completing user walkthrough did not attest: %', v_result;
  end if;
  if not exists (
    select 1 from audit_log
    where actor_id = v_user
      and action = 'attest'
      and detail->>'reason' = 'setup_walkthrough_completed'
      and detail->>'content_version' = '1'
  ) then
    raise exception 'FAIL: walkthrough attestation audit row is missing';
  end if;

  begin
    perform update_setup_walkthrough_progress(
      v_user, 'user', 1, 2, array['data_security']::text[]
    );
    raise exception 'FAIL: completed attestation was changed';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%walkthrough_already_completed%' then
      raise exception 'FAIL: immutable-attestation refusal was %', sqlerrm;
    end if;
  end;

  v_result := update_setup_walkthrough_progress(
    v_admin,
    'administrator',
    1,
    0,
    array[
      'access_governance',
      'invitation_controls',
      'audit_accountability'
    ]::text[]
  );
  if v_result->>'completed_at' is null then
    raise exception 'FAIL: firm administrator could not attest administrator walkthrough';
  end if;
end;
$$;

-- Authenticated clients cannot read the progress table directly. The API
-- service returns only the caller's authorized tracks.
do $$
begin
  if has_table_privilege('authenticated', 'setup_walkthrough_progress', 'select') then
    raise exception 'FAIL: authenticated role has direct walkthrough table access';
  end if;
  if has_function_privilege(
    'authenticated',
    'update_setup_walkthrough_progress(uuid,text,integer,bigint,text[])',
    'execute'
  ) then
    raise exception 'FAIL: authenticated role can execute the walkthrough RPC';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '18000000-0000-4000-8000-000000000001',
  true
);

do $$
begin
  begin
    perform count(*) from setup_walkthrough_progress;
    raise exception 'FAIL: authenticated role read service-only walkthrough rows';
  exception when insufficient_privilege then
    null;
  when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'FAIL: unexpected authenticated table refusal: %', sqlerrm;
    end if;
  end;
end;
$$;

reset role;

rollback;
