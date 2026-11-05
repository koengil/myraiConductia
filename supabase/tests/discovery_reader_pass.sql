-- The reader pass record (#370): what discovery_record_reader_pass() accepts,
-- cleans and refuses; that it chains; and that nobody signed in sees a pass row.
--
--   1. a valid start then end append in chain order, as service rows of the
--      discovery worker, with no actor and no deal
--   2. a duplicate start or end is a no-op, and chain_seq stays contiguous
--   3. an identity or outcome fault raises 22023
--   4. a malformed registration is cleaned to null, never refused
--   5. the clock bounds raise P0001 reader_pass_clock_skew
--   6. an end and its start must agree, in either order (reader_pass_mismatch)
--   7. a start committed but acknowledged late is recognised, however old
--   8. a tenantless call raises
--   9. only service_role executes the writer and its helpers, and an admin or a
--      CCO of the tenant selects no pass row from audit_log
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_reader_pass.sql
-- Everything rolls back.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does and give it a live session whose id is the user id.
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

create function pg_temp.expect(actual bigint, expected bigint, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
end;
$$;

create function pg_temp.expect_text(actual text, expected text, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
end;
$$;

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user, 'role', 'authenticated')::text, true);
$$;

-- The worker's own time format: UTC, milliseconds, Z.
create function pg_temp.iso(p timestamptz)
returns text language sql immutable as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- A valid started detail.
create function pg_temp.started(p_pass uuid, p_source uuid, p_run uuid, p_at timestamptz, p_job uuid default null)
returns jsonb language sql as $$
  select jsonb_build_object(
    'v', 1, 'passId', p_pass, 'runId', p_run, 'jobId', p_job, 'sourceId', p_source,
    'startedAt', pg_temp.iso(p_at),
    'worker', jsonb_build_object('deployment', 'local', 'revision', null));
$$;

-- A valid finished detail for a started one.
create function pg_temp.finished(p_start jsonb, p_ended timestamptz, p_status text default 'complete', p_reason text default null)
returns jsonb language sql as $$
  select p_start || jsonb_build_object(
    'provider', 'google', 'registration', null, 'endedAt', pg_temp.iso(p_ended),
    'status', p_status, 'reason', p_reason,
    'pages', 1, 'fetched', 3, 'excluded', 1, 'stored', 2, 'checkpointAdvanced', true);
$$;

-- The writer's answer: 'ok', or the SQLSTATE and message it raised.
create function pg_temp.rec(p_event text, p_tenant uuid, p_detail jsonb)
returns text language plpgsql as $$
begin
  perform discovery_record_reader_pass(p_event, p_tenant, p_detail);
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;

create function pg_temp.expect_code(actual text, expected_prefix text, label text)
returns void language plpgsql as $$
begin
  if actual is null or left(actual, length(expected_prefix)) <> expected_prefix then
    raise exception 'FAIL: % (expected %, got %)', label, expected_prefix, actual;
  end if;
end;
$$;

-- New functions no longer grant PUBLIC EXECUTE by default (#233).
grant execute on all functions in schema pg_temp to authenticated, service_role;

do $$
declare
  v_tenant  uuid := gen_random_uuid();
  v_admin   uuid := gen_random_uuid();
  v_cco     uuid := gen_random_uuid();
  v_bank    uuid := gen_random_uuid();
  v_source  uuid := gen_random_uuid();
  v_other   uuid := gen_random_uuid();
  v_run     uuid := gen_random_uuid();
  v_job     uuid := gen_random_uuid();
  v_now     timestamptz := now();
  v_pass    uuid;
  v_start   jsonb;
  v_end     jsonb;
  v_bad     jsonb;
  v_row     record;
  v_count   bigint;
  v_rows_before bigint;
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'rp-admin@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_cco,   'rp-cco@example.test',   jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance'));
  update users set status = 'active', is_external = false where id in (v_admin, v_cco);
  update users set firm_role = 'admin' where id = v_admin;
  update users set firm_role = 'cco' where id = v_cco;
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'RP Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id = v_admin;
  update users set company_id = v_bank, company_role = 'member' where id = v_cco;

  set local role service_role;

  -- ── 1. A start, then its end, chained ────────────────────────────────────
  v_pass := gen_random_uuid();
  v_start := pg_temp.started(v_pass, v_source, v_pass, v_now, v_job);
  v_end := pg_temp.finished(v_start, v_now + interval '2 seconds');
  perform pg_temp.expect_text(pg_temp.rec('started', v_tenant, v_start), 'ok', 'a valid start is written');
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, v_end), 'ok', 'a valid end is written');
  for v_row in
    select action, actor_type, service_identity, actor_id, deal_id, chain_seq, hash, detail
    from audit_log where tenant_id = v_tenant and detail->>'passId' = v_pass::text order by chain_seq
  loop
    if v_row.actor_type <> 'service' or v_row.service_identity <> 'discovery-worker'
       or v_row.actor_id is not null or v_row.deal_id is not null or v_row.hash is null then
      raise exception 'FAIL: a pass row is not a chained service row of the discovery worker: %', row_to_json(v_row);
    end if;
  end loop;
  perform pg_temp.expect_text(
    (select string_agg(action, ',' order by chain_seq) from audit_log where tenant_id = v_tenant and detail->>'passId' = v_pass::text),
    'discovery.reader_pass_started,discovery.reader_pass_finished', 'the start and the end append in chain order');
  perform pg_temp.expect_text(
    (select detail::text from audit_log where tenant_id = v_tenant and action = 'discovery.reader_pass_finished'
       and detail->>'passId' = v_pass::text),
    v_end::text, 'the end is stored exactly as sent');
  raise notice 'PASS: a start and its end are chained service rows of the discovery worker, with no actor and no deal';

  -- ── 2. Duplicates are no-ops; the chain has no gap ───────────────────────
  perform pg_temp.expect_text(pg_temp.rec('started', v_tenant, v_start), 'ok', 'a duplicate start answers ok');
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, v_end), 'ok', 'a duplicate end answers ok');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and detail->>'passId' = v_pass::text),
                         2, 'duplicates add no row');
  perform pg_temp.expect((select max(chain_seq) - min(chain_seq) + 1 - count(*) from audit_log where tenant_id = v_tenant),
                         0, 'no gap in chain_seq after duplicate appends');
  raise notice 'PASS: a duplicate start or end is a no-op, and chain_seq stays contiguous';

  -- ── 3. Identity and outcome faults raise 22023 ───────────────────────────
  v_start := pg_temp.started(gen_random_uuid(), v_source, v_run, v_now);
  perform pg_temp.expect_code(pg_temp.rec('begun', v_tenant, v_start), '22023', 'an unknown event');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"subject":"Project Falcon"}'), '22023', 'an extra key');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start - 'worker'), '22023', 'a missing key');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, '[]'::jsonb), '22023', 'a detail that is not an object');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, null), '22023', 'no detail');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"v":2}'), '22023', 'another version');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"passId":"not-a-uuid"}'), '22023', 'a passId that is no uuid');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"jobId":42}'), '22023', 'a jobId that is a number');
  perform pg_temp.expect_code(
    pg_temp.rec('started', v_tenant, v_start || jsonb_build_object('startedAt', replace(pg_temp.iso(v_now), 'Z', '+02:00'))),
    '22023', 'an offset timestamp');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"startedAt":"2026-13-45T00:00:00.000Z"}'),
                              '22023', 'an impossible date');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"worker":{"deployment":"local","revision":"abc"}}'),
                              '22023', 'a revision that is not 40 hex');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"worker":{"deployment":"a b","revision":null}}'),
                              '22023', 'a deployment that is not a code');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"worker":{"deployment":"local","revision":null,"host":"x"}}'),
                              '22023', 'a worker with an extra key');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"worker":"local"}'), '22023', 'a worker that is a string');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"worker":["local"]}'), '22023', 'a worker that is an array');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_start || '{"worker":null}'), '22023', 'a worker that is null');

  v_end := pg_temp.finished(v_start, v_now);
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"reason":"storm.duncan@bank.example"}'),
                              '22023', 'an address in reason');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"reason":"Re: Project Falcon"}'),
                              '22023', 'a subject in reason');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"pages":-1}'), '22023', 'a negative count');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"fetched":1.5}'), '22023', 'a fractional count');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"stored":"2"}'), '22023', 'a count that is a string');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"status":"done"}'), '22023', 'an unknown status');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"provider":"yahoo"}'), '22023', 'an unknown provider');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end || '{"checkpointAdvanced":"yes"}'), '22023', 'a non-boolean checkpointAdvanced');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_end - 'stored'), '22023', 'an end missing a count');
  perform pg_temp.expect_code(pg_temp.rec('finished', v_tenant, v_start), '22023', 'a start sent as an end');
  perform pg_temp.expect_code(pg_temp.rec('started', v_tenant, v_end), '22023', 'an end sent as a start');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and detail->>'passId' = v_start->>'passId'),
                         0, 'no refused event was written');
  raise notice 'PASS: identity and outcome faults raise 22023, and nothing is written';

  -- ── 4. A malformed registration is cleaned to null; the end still lands ──
  foreach v_bad in array array[
    '{"clientId":"app-1","certThumbprint":null,"tenant":"x"}'::jsonb,
    '{"clientId":"app-1","certThumbprint":"AB:CD"}'::jsonb,
    '{"clientId":"reader app","certThumbprint":null}'::jsonb,
    '"app-1"'::jsonb,
    '["app-1"]'::jsonb
  ] loop
    v_pass := gen_random_uuid();
    v_start := pg_temp.started(v_pass, v_source, v_run, v_now);
    perform pg_temp.expect_text(pg_temp.rec('started', v_tenant, v_start), 'ok', 'a start for the registration case');
    perform pg_temp.expect_text(
      pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now) || jsonb_build_object('registration', v_bad)),
      'ok', format('an end with registration %s lands', v_bad));
    perform pg_temp.expect_text(
      (select jsonb_typeof(detail->'registration') from audit_log
       where tenant_id = v_tenant and action = 'discovery.reader_pass_finished' and detail->>'passId' = v_pass::text),
      'null', format('registration %s is stored as null', v_bad));
  end loop;
  -- A well-formed registration is kept as sent.
  v_pass := gen_random_uuid();
  v_start := pg_temp.started(v_pass, v_source, v_run, v_now);
  perform pg_temp.rec('started', v_tenant, v_start);
  perform pg_temp.expect_text(
    pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now)
      || jsonb_build_object('registration', jsonb_build_object('clientId', '1234567890', 'certThumbprint', repeat('ab', 20)))),
    'ok', 'an end with a well-formed registration lands');
  perform pg_temp.expect_text(
    (select detail #>> '{registration,certThumbprint}' from audit_log
     where tenant_id = v_tenant and action = 'discovery.reader_pass_finished' and detail->>'passId' = v_pass::text),
    repeat('ab', 20), 'a well-formed registration is kept');
  raise notice 'PASS: a malformed registration is cleaned to null, never refused; a well-formed one is kept';

  -- ── 5. Clock bounds ──────────────────────────────────────────────────────
  perform pg_temp.expect_text(
    pg_temp.rec('started', v_tenant, pg_temp.started(gen_random_uuid(), v_source, v_run, v_now - interval '11 minutes')),
    'P0001 reader_pass_clock_skew', 'a new start 11 minutes old');
  perform pg_temp.expect_text(
    pg_temp.rec('started', v_tenant, pg_temp.started(gen_random_uuid(), v_source, v_run, v_now + interval '11 minutes')),
    'P0001 reader_pass_clock_skew', 'a new start 11 minutes ahead');
  perform pg_temp.expect_text(
    pg_temp.rec('started', v_tenant, pg_temp.started(gen_random_uuid(), v_source, v_run, v_now - interval '9 minutes')),
    'ok', 'a start 9 minutes old is within the bound');
  v_start := pg_temp.started(gen_random_uuid(), v_source, v_run, v_now);
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now + interval '6 minutes')),
                              'P0001 reader_pass_clock_skew', 'an end 6 minutes ahead');
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now - interval '1 second')),
                              'P0001 reader_pass_clock_skew', 'an end before its start');
  v_start := pg_temp.started(gen_random_uuid(), v_source, v_run, v_now + interval '11 minutes');
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now + interval '11 minutes')),
                              'P0001 reader_pass_clock_skew', 'an end whose start is 11 minutes ahead');
  raise notice 'PASS: the clock bounds raise reader_pass_clock_skew';

  -- ── 6. An end and its start must agree, in either order ──────────────────
  v_pass := gen_random_uuid();
  v_start := pg_temp.started(v_pass, v_source, v_run, v_now, v_job);
  perform pg_temp.rec('started', v_tenant, v_start);
  v_end := pg_temp.finished(v_start, v_now);
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, v_end || jsonb_build_object('sourceId', v_other)),
                              'P0001 reader_pass_mismatch', 'an end with another sourceId');
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, v_end || jsonb_build_object('runId', gen_random_uuid())),
                              'P0001 reader_pass_mismatch', 'an end with another runId');
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, v_end || '{"jobId":null}'),
                              'P0001 reader_pass_mismatch', 'an end with another jobId');
  perform pg_temp.expect_text(
    pg_temp.rec('finished', v_tenant, v_end || jsonb_build_object('startedAt', pg_temp.iso(v_now - interval '1 second'))),
    'P0001 reader_pass_mismatch', 'an end with another startedAt');
  perform pg_temp.expect_text(
    pg_temp.rec('finished', v_tenant, v_end || '{"worker":{"deployment":"aws-other","revision":null}}'),
    'P0001 reader_pass_mismatch', 'an end from another worker');
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, v_end), 'ok', 'the matching end lands after the refusals');

  -- Out of order: the end first.
  v_pass := gen_random_uuid();
  v_start := pg_temp.started(v_pass, v_source, v_run, v_now);
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now)), 'ok', 'an end before its start is accepted');
  perform pg_temp.expect_text(pg_temp.rec('started', v_tenant, v_start || jsonb_build_object('sourceId', v_other)),
                              'P0001 reader_pass_mismatch', 'a start that differs from an end already written');
  perform pg_temp.expect_text(pg_temp.rec('started', v_tenant, v_start), 'ok', 'the matching start lands after its end');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and detail->>'passId' = v_pass::text),
                         2, 'an out-of-order matching pair is two rows');
  raise notice 'PASS: an end and its start must agree on every immutable field, in either order';

  -- ── 7. A start committed but acknowledged late ───────────────────────────
  v_pass := gen_random_uuid();
  v_start := pg_temp.started(v_pass, v_source, v_run, v_now - interval '11 minutes');
  -- Planted directly (service_role keeps INSERT on audit_log, the trust limit): as the first send left it.
  insert into audit_log (action, tenant_id, actor_type, service_identity, detail)
  values ('discovery.reader_pass_started', v_tenant, 'service', 'discovery-worker', v_start);
  perform pg_temp.expect_text(pg_temp.rec('started', v_tenant, v_start), 'ok',
                              'the identical start, sent again, is a success however old');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and detail->>'passId' = v_pass::text),
                         1, 'the late-acknowledged start adds no row');
  perform pg_temp.expect_text(pg_temp.rec('started', v_tenant, v_start || jsonb_build_object('runId', gen_random_uuid())),
                              'P0001 reader_pass_mismatch', 'the same passId with a different start');
  -- A second, different end.
  v_pass := gen_random_uuid();
  v_start := pg_temp.started(v_pass, v_source, v_run, v_now);
  perform pg_temp.rec('started', v_tenant, v_start);
  perform pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now));
  perform pg_temp.expect_text(pg_temp.rec('finished', v_tenant, pg_temp.finished(v_start, v_now, 'failed', 'unexpected')),
                              'P0001 reader_pass_mismatch', 'a second, different end');
  raise notice 'PASS: an identical start is recognised however old; a different one for the same pass is a mismatch';

  -- ── 8. A tenant is required ──────────────────────────────────────────────
  perform pg_temp.expect_code(pg_temp.rec('started', null, pg_temp.started(gen_random_uuid(), v_source, v_run, v_now)),
                              '22023', 'a tenantless call');
  raise notice 'PASS: a tenantless call raises';

  -- ── 9. Grants and visibility ─────────────────────────────────────────────
  reset role;
  if has_function_privilege('authenticated', 'discovery_record_reader_pass(text,uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'discovery_record_reader_pass(text,uuid,jsonb)', 'execute') then
    raise exception 'FAIL: a browser role may execute the reader pass writer';
  end if;
  if not has_function_privilege('service_role', 'discovery_record_reader_pass(text,uuid,jsonb)', 'execute') then
    raise exception 'FAIL: service_role may not execute the reader pass writer';
  end if;
  if has_function_privilege('authenticated', 'discovery_reader_pass_valid(text,jsonb)', 'execute')
     or has_function_privilege('anon', 'discovery_reader_pass_valid(text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'discovery_reader_pass_registration_ok(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'discovery_reader_pass_consistent(text,jsonb,timestamptz)', 'execute')
     or has_function_privilege('anon', 'discovery_reader_pass_consistent(text,jsonb,timestamptz)', 'execute') then
    raise exception 'FAIL: a browser role may execute a reader pass helper';
  end if;
  select count(*) into v_rows_before from audit_log where tenant_id = v_tenant and action like 'discovery.reader_pass%';
  if v_rows_before = 0 then raise exception 'FAIL: the fixture wrote no pass rows to hide'; end if;

  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  select count(*) into v_count from audit_log where action like 'discovery.reader_pass%';
  perform pg_temp.expect(v_count, 0, 'the tenant admin selects no pass row');
  perform pg_temp.act_as(v_cco);
  select count(*) into v_count from audit_log where action like 'discovery.reader_pass%';
  perform pg_temp.expect(v_count, 0, 'the tenant CCO selects no pass row');
  begin
    perform discovery_record_reader_pass('started', v_tenant, pg_temp.started(gen_random_uuid(), v_source, v_run, v_now));
    raise exception 'FAIL: authenticated called the reader pass writer';
  exception when insufficient_privilege then null;
  end;
  reset role;
  raise notice 'PASS: only service_role writes a pass; no signed-in role sees one (% pass rows hidden)', v_rows_before;
end $$;

rollback;
