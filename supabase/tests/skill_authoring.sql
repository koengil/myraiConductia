create schema :"schema";
set search_path to :"schema", public;
set check_function_bodies = off;
do $$
begin
  if exists (select from pg_extension where extname = 'pgcrypto') then
    raise exception 'environment conflict: pgcrypto extension already installed in %',
      (select extnamespace::regnamespace from pg_extension where extname = 'pgcrypto');
  end if;
end;
$$;
create schema if not exists extensions;
create extension pgcrypto with schema extensions;

do $$
begin
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$$;

create schema if not exists auth;
do $$
begin
  if to_regprocedure('auth.role()') is null then
    create function auth.role() returns text language sql stable as $role$ select 'service_role'::text $role$;
  end if;
end;
$$;

create table companies (
  id uuid primary key,
  kind text not null check (kind in ('tenant', 'bank')),
  tenant_id uuid references companies(id)
);
create table users (
  id uuid primary key,
  company_id uuid references companies(id),
  status text not null,
  is_external boolean not null default false
);
create table deals (
  id uuid primary key,
  tenant_id uuid not null references companies(id),
  bank_id uuid not null references companies(id)
);
create table deal_steps (id uuid primary key, deal_id uuid not null references deals(id), seq integer not null);
create table deal_memberships (
  deal_id uuid not null references deals(id),
  user_id uuid not null references users(id),
  primary key (deal_id, user_id)
);
create table company_permissions (
  key text primary key,
  label text not null,
  description text not null,
  category text not null,
  sort_order integer not null unique,
  constraint company_permissions_key_check check (key in ('placeholder'))
);
create table company_permission_grants (
  user_id uuid not null references users(id),
  company_id uuid not null references companies(id),
  permission_key text not null,
  primary key (user_id, company_id, permission_key)
);
create function app_has_company_permission(p_user_id uuid, p_company_id uuid, p_permission_key text)
returns boolean language sql stable as $$
  select exists (
    select from company_permission_grants grant_row
    where grant_row.user_id = p_user_id and grant_row.company_id = p_company_id
      and grant_row.permission_key = p_permission_key
  )
$$;
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  actor_id uuid references users(id),
  action text not null,
  deal_id uuid references deals(id),
  detail jsonb
);

\ir ../migrations/20260916100000_project_rail_model.sql
\ir ../migrations/20260916110000_skill_authoring.sql

do $$
declare v_function regprocedure; v_config text[]; v_raw text; v_new_path text;
begin
  for v_function, v_config in
    select p.oid::regprocedure, p.proconfig from pg_proc p
    where p.pronamespace = current_schema()::regnamespace and p.proname like 'skill_authoring_%'
  loop
    select cfg into v_raw from unnest(coalesce(v_config, '{}'::text[])) as cfg
    where cfg like 'search_path=%';
    if v_raw is null then
      continue;
    end if;
    select string_agg(
      case when btrim(entry) = 'public' then quote_ident(current_schema()) else quote_ident(btrim(entry)) end,
      ', ' order by ordinality
    ) into v_new_path
    from unnest(string_to_array(split_part(v_raw, '=', 2), ',')) with ordinality as entry;
    execute format('alter function %s set search_path = %s', v_function, v_new_path);
  end loop;
end;
$$;
set check_function_bodies = on;

create function probe_tenant() returns uuid language sql immutable as $$
  select '7e7e7e7e-0000-4000-8000-000000000001'::uuid
$$;
create function probe_bank() returns uuid language sql immutable as $$
  select 'ba0ba0ba-0000-4000-8000-000000000001'::uuid
$$;
create function probe_author_a() returns uuid language sql immutable as $$
  select 'a0a0a0a0-0000-4000-8000-00000000000a'::uuid
$$;
create function probe_author_b() returns uuid language sql immutable as $$
  select 'b0b0b0b0-0000-4000-8000-00000000000b'::uuid
$$;
create function probe_no_perm_member() returns uuid language sql immutable as $$
  select 'c0c0c0c0-0000-4000-8000-00000000000c'::uuid
$$;
create function probe_correlation() returns uuid language sql immutable as $$
  select 'f0f0f0f0-0000-4000-8000-000000000001'::uuid
$$;

create function probe_assert(p_condition boolean, p_message text) returns void language plpgsql as $$
begin
  if p_condition is not true then
    raise exception 'probe assertion failed: %', p_message;
  end if;
end;
$$;

create function probe_expect_sqlstate(p_statement text, p_sqlstate text) returns text language plpgsql as $$
declare v_detail text;
begin
  begin
    execute p_statement;
  exception when others then
    if sqlstate <> p_sqlstate then
      raise;
    end if;
    get stacked diagnostics v_detail = pg_exception_detail;
    return coalesce(v_detail, '');
  end;
  raise exception 'probe expected sqlstate % from: %', p_sqlstate, p_statement;
end;
$$;

insert into companies (id, kind, tenant_id) values
  (probe_tenant(), 'tenant', null),
  (probe_bank(), 'bank', probe_tenant());
insert into users (id, company_id, status, is_external) values
  (probe_author_a(), probe_bank(), 'active', false),
  (probe_author_b(), probe_bank(), 'active', false),
  (probe_no_perm_member(), probe_bank(), 'active', false);
insert into company_permission_grants (user_id, company_id, permission_key) values
  (probe_author_a(), probe_bank(), 'company:deals:steps:structure'),
  (probe_author_b(), probe_bank(), 'company:deals:steps:structure');

do $$
declare v_deal uuid := 'd0000000-0000-4000-8000-000000000001'; v_first uuid; v_second uuid;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_first := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_second := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  perform probe_assert(v_first = v_second, 'get_or_create_draft returned a different draft on the second call');
  perform probe_assert((select count(*) from skill_authoring_drafts
    where deal_id = v_deal and author_id = probe_author_a() and status = 'active') = 1,
    'author holds more than one active draft');
end;
$$;
\echo ok: get_or_create_draft returns the same active draft on a second call

do $$
declare v_deal uuid := 'd0000000-0000-4000-8000-000000000002'; v_draft uuid;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a()), (v_deal, probe_author_b());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  perform probe_expect_sqlstate(format('select skill_authoring_read_draft(%L, %L, %L, %L)',
    probe_author_b(), v_deal, v_draft, probe_correlation()), 'P0002');
  perform probe_expect_sqlstate(format('select skill_authoring_patch_draft(%L, %L, %L, 0, %L, null, null, null, %L, %L)',
    probe_author_b(), v_deal, v_draft, 'hijack', 'hijack text', probe_correlation()), 'P0002');
end;
$$;
\echo ok: a second member cannot read or patch the first authors draft

do $$
declare v_deal uuid := 'd0000000-0000-4000-8000-000000000003';
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_no_perm_member());
  perform probe_expect_sqlstate(format('select skill_authoring_get_or_create_draft(%L, %L, %L)',
    probe_no_perm_member(), v_deal, probe_correlation()), '42501');
end;
$$;
\echo ok: a member without the structure permission is refused by lock_author

do $$
declare v_deal uuid := 'd0000000-0000-4000-8000-000000000004'; v_draft uuid; v_detail text;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  perform skill_authoring_patch_draft(probe_author_a(), v_deal, v_draft, 0, 'Tab one', null, null, null,
    'tab one text', probe_correlation());
  v_detail := probe_expect_sqlstate(format('select skill_authoring_patch_draft(%L, %L, %L, 0, %L, null, null, null, %L, %L)',
    probe_author_a(), v_deal, v_draft, 'Tab two', 'tab two text', probe_correlation()), '40001');
  perform probe_assert(v_detail::jsonb #>> '{draft,edit_revision}' = '1',
    'stale conflict did not return the latest acknowledged draft');
  perform skill_authoring_patch_draft(probe_author_a(), v_deal, v_draft, 1, '', null, null, null,
    'empty name ok', probe_correlation());
  perform probe_assert((select name = '' from skill_authoring_drafts where id = v_draft),
    'empty name was not accepted');
end;
$$;
\echo ok: patch_draft stale revision conflict and empty name accepted

do $$
declare
  v_deal uuid := 'd0000000-0000-4000-8000-000000000005';
  v_draft uuid;
  v_client uuid := 'e5e5e5e5-0000-4000-8000-000000000005';
  v_first jsonb;
  v_replay jsonb;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_first := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, v_client, 'first message', probe_correlation());
  perform probe_assert((v_first ->> 'created')::boolean is true, 'first submission was not reported as created');
  perform probe_assert(v_first #>> '{attempt,status}' = 'running', 'first attempt was not running');
  v_replay := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, v_client, 'first message', probe_correlation());
  perform probe_assert((v_replay ->> 'created')::boolean is false, 'replay was reported as created');
  perform probe_assert(v_replay #>> '{message,id}' = v_first #>> '{message,id}'
    and v_replay #>> '{attempt,id}' = v_first #>> '{attempt,id}', 'replay did not return the original ids');
  perform probe_expect_sqlstate(format('select skill_authoring_submit_message(%L, %L, %L, %s, %L, %L, %L)',
    probe_author_a(), v_deal, v_draft, (select edit_revision from skill_authoring_drafts where id = v_draft),
    gen_random_uuid(), 'a different message', probe_correlation()), '40001');
end;
$$;
\echo ok: submit_message creates a running attempt and replays or conflicts correctly

do $$
declare
  v_deal uuid := 'd0000000-0000-4000-8000-000000000006';
  v_draft uuid;
  v_receipt jsonb;
  v_attempt uuid;
  v_second jsonb;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_receipt := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, gen_random_uuid(), 'first message', probe_correlation());
  v_attempt := (v_receipt #>> '{attempt,id}')::uuid;
  update skill_authoring_attempts set last_progress_at = now() - interval '2 minutes' where id = v_attempt;
  perform probe_assert(
    (skill_authoring_read_draft(probe_author_a(), v_deal, v_draft, probe_correlation()) #> '{draft,active_attempt}') = 'null'::jsonb,
    'a stale attempt was still reported as the active attempt');
  perform probe_assert(
    (skill_authoring_read_draft(probe_author_a(), v_deal, v_draft, probe_correlation())
      #>> '{draft,messages,0,attempts,0,status}') = 'failed',
    'the stale attempt was not projected as failed inside its message');
  perform probe_assert(
    (skill_authoring_read_draft(probe_author_a(), v_deal, v_draft, probe_correlation())
      #>> '{draft,messages,0,attempts,0,error_code}') = 'generation_interrupted',
    'the stale attempt did not report generation_interrupted inside its message');
  perform probe_assert((select status from skill_authoring_attempts where id = v_attempt) = 'running',
    'attempt row changed status before a new submission touched it');
  v_second := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft,
    (select edit_revision from skill_authoring_drafts where id = v_draft),
    gen_random_uuid(), 'second message', probe_correlation());
  perform probe_assert((v_second ->> 'created')::boolean is true, 'second submission was not created after the stale failure');
  perform probe_assert((select status = 'failed' and error_code = 'generation_interrupted'
    from skill_authoring_attempts where id = v_attempt), 'stale attempt was not marked failed in the table');
  perform probe_assert((select status from skill_authoring_attempts where id = (v_second #>> '{attempt,id}')::uuid) = 'running',
    'new attempt after the stale failure was not running');
end;
$$;
\echo ok: stale running attempt is projected and then failed on the next submission

do $$
declare
  v_deal uuid := 'd0000000-0000-4000-8000-000000000007';
  v_draft uuid;
  v_receipt1 jsonb;
  v_attempt1 uuid;
  v_candidate_id uuid := gen_random_uuid();
  v_receipt2 jsonb;
  v_attempt2 uuid;
  v_context jsonb;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_receipt1 := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, gen_random_uuid(),
    'draft a buyer screen', probe_correlation());
  v_attempt1 := (v_receipt1 #>> '{attempt,id}')::uuid;
  perform skill_authoring_complete_attempt(v_attempt1, 'here is the buyer screen', jsonb_build_object(
    'providerCandidateId', v_candidate_id, 'contentDigest', repeat('a', 64),
    'preview', jsonb_build_object('name', 'Buyer screen', 'purpose', 'Screen buyers',
      'expectedInput', 'Deal context', 'expectedOutput', 'Ranked buyers')));
  v_receipt2 := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft,
    (select edit_revision from skill_authoring_drafts where id = v_draft),
    gen_random_uuid(), 'now narrow to buyers over $1B', probe_correlation());
  v_attempt2 := (v_receipt2 #>> '{attempt,id}')::uuid;
  v_context := skill_authoring_run_context(v_attempt2);
  perform probe_assert(v_context ->> 'attemptId' = v_attempt2::text, 'run_context returned the wrong attempt');
  perform probe_assert(v_context ->> 'message' = 'now narrow to buyers over $1B', 'run_context did not return the admitted message');
  perform probe_assert(v_context -> 'history' = jsonb_build_array(
    jsonb_build_object('role', 'user', 'content', 'draft a buyer screen'),
    jsonb_build_object('role', 'assistant', 'content', 'here is the buyer screen')
  ), 'run_context history did not pair the prior turn correctly');
  perform probe_assert(v_context -> 'currentCandidate' = jsonb_build_object(
    'name', 'Buyer screen', 'purpose', 'Screen buyers', 'expectedInput', 'Deal context', 'expectedOutput', 'Ranked buyers'
  ), 'run_context did not return the current candidate preview');
end;
$$;
\echo ok: run_context pairs history and returns the current candidate

do $$
declare
  v_deal uuid := 'd0000000-0000-4000-8000-000000000008';
  v_draft uuid;
  v_receipt jsonb;
  v_attempt uuid;
  v_candidate_id uuid := gen_random_uuid();
  v_candidate_row uuid;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_receipt := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, gen_random_uuid(),
    'draft a nda tracker', probe_correlation());
  v_attempt := (v_receipt #>> '{attempt,id}')::uuid;
  perform probe_assert(skill_authoring_record_progress(v_attempt, 'partial reply') is true,
    'record_progress did not report success');
  perform probe_assert((select response_text from skill_authoring_attempts where id = v_attempt) = 'partial reply',
    'record_progress did not store the text');
  perform probe_assert(skill_authoring_complete_attempt(v_attempt, 'final reply', jsonb_build_object(
    'providerCandidateId', v_candidate_id, 'contentDigest', repeat('b', 64),
    'preview', jsonb_build_object('name', 'NDA tracker', 'purpose', 'Track NDAs',
      'expectedInput', 'Buyer list', 'expectedOutput', 'NDA status'))) is true,
    'complete_attempt did not report success');
  select id into v_candidate_row from skill_authoring_candidates where provider_candidate_id = v_candidate_id;
  perform probe_assert((select status = 'succeeded' and response_text = 'final reply'
    from skill_authoring_attempts where id = v_attempt), 'complete_attempt did not mark the attempt succeeded');
  perform probe_assert((select current_candidate_id = v_candidate_row from skill_authoring_drafts where id = v_draft),
    'complete_attempt did not select the candidate');
  perform probe_assert(skill_authoring_complete_attempt(v_attempt, 'again', null) is false,
    'a second complete_attempt did not return false');
  perform probe_assert((select response_text from skill_authoring_attempts where id = v_attempt) = 'final reply',
    'a second complete_attempt changed the response text');
  perform probe_assert(skill_authoring_fail_attempt(v_attempt, 'generation_failed', 'Generation could not complete. Try again.') is false,
    'fail_attempt on a succeeded attempt did not return false');
  perform probe_assert((select status from skill_authoring_attempts where id = v_attempt) = 'succeeded',
    'fail_attempt changed a succeeded attempt');
end;
$$;
\echo ok: record_progress and complete_attempt succeed once, then no-op

do $$
declare
  v_deal uuid := 'd0000000-0000-4000-8000-000000000009';
  v_draft uuid;
  v_receipt jsonb;
  v_attempt uuid;
  v_candidate_id uuid := gen_random_uuid();
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_receipt := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, gen_random_uuid(),
    'draft a teaser', probe_correlation());
  v_attempt := (v_receipt #>> '{attempt,id}')::uuid;
  perform skill_authoring_discard_draft(probe_author_a(), v_deal, v_draft,
    (select edit_revision from skill_authoring_drafts where id = v_draft), probe_correlation());
  perform probe_assert((select status from skill_authoring_drafts where id = v_draft) = 'archived', 'draft was not archived');
  perform probe_assert(skill_authoring_complete_attempt(v_attempt, 'reply after discard', jsonb_build_object(
    'providerCandidateId', v_candidate_id, 'contentDigest', repeat('c', 64),
    'preview', jsonb_build_object('name', 'Teaser', 'purpose', 'Draft teaser',
      'expectedInput', 'Deal facts', 'expectedOutput', 'Teaser copy'))) is true,
    'complete_attempt did not succeed after discard');
  perform probe_assert((select current_candidate_id is null from skill_authoring_drafts where id = v_draft),
    'discarded draft picked up a candidate selection');
  perform probe_assert((select status = 'succeeded' from skill_authoring_attempts where id = v_attempt),
    'attempt did not succeed after discard');
end;
$$;
\echo ok: candidate after discard is completed but not selected

do $$
declare
  v_deal uuid := 'd0000000-0000-4000-8000-000000000010';
  v_draft uuid;
  v_receipt jsonb;
  v_message uuid;
  v_first_attempt uuid;
  v_retry_request_id uuid := gen_random_uuid();
  v_retry_receipt jsonb;
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_receipt := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, gen_random_uuid(),
    'draft a data room index', probe_correlation());
  v_message := (v_receipt #>> '{message,id}')::uuid;
  v_first_attempt := (v_receipt #>> '{attempt,id}')::uuid;
  perform skill_authoring_fail_attempt(v_first_attempt, 'generation_failed', 'Generation could not complete. Try again.');
  v_retry_receipt := skill_authoring_retry_message(probe_author_a(), v_deal, v_draft, v_message, v_retry_request_id, probe_correlation());
  perform probe_assert((v_retry_receipt ->> 'created')::boolean is true, 'retry was not reported as created');
  perform probe_assert(v_retry_receipt #>> '{attempt,status}' = 'running', 'retried attempt was not running');
  perform probe_assert(v_retry_receipt #>> '{attempt,message_id}' = v_message::text,
    'the retried attempt projection did not carry message_id');
  perform probe_assert(v_retry_receipt #>> '{attempt,retry_request_id}' = v_retry_request_id::text,
    'the retried attempt projection did not carry retry_request_id');
end;
$$;
\echo ok: a retried attempt projects its message_id and retry_request_id

do $$
begin
  perform probe_assert(not has_function_privilege('anon', 'skill_authoring_read_draft(uuid,uuid,uuid,uuid)', 'execute'),
    'anon retained execute on skill_authoring_read_draft');
  perform probe_assert(not has_function_privilege('authenticated', 'skill_authoring_read_draft(uuid,uuid,uuid,uuid)', 'execute'),
    'authenticated retained execute on skill_authoring_read_draft');
  perform probe_assert(has_function_privilege('service_role', 'skill_authoring_read_draft(uuid,uuid,uuid,uuid)', 'execute'),
    'service_role lost execute on skill_authoring_read_draft');
end;
$$;
\echo ok: only service_role can execute skill_authoring_read_draft

do $$
declare
  v_deal uuid := 'd0000000-0000-4000-8000-000000000011';
  v_draft uuid;
  v_receipt jsonb;
  v_attempt uuid;
  v_candidate_id uuid := gen_random_uuid();
  v_secret_message text := 'the secret buyer instruction';
  v_secret_reply text := 'the secret model reply';
begin
  insert into deals (id, tenant_id, bank_id) values (v_deal, probe_tenant(), probe_bank());
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_a());
  v_draft := (skill_authoring_get_or_create_draft(probe_author_a(), v_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  v_receipt := skill_authoring_submit_message(probe_author_a(), v_deal, v_draft, 0, gen_random_uuid(), v_secret_message, probe_correlation());
  v_attempt := (v_receipt #>> '{attempt,id}')::uuid;
  perform skill_authoring_complete_attempt(v_attempt, v_secret_reply, jsonb_build_object(
    'providerCandidateId', v_candidate_id, 'contentDigest', repeat('d', 64),
    'preview', jsonb_build_object('name', 'Audit test', 'purpose', 'Audit', 'expectedInput', 'x', 'expectedOutput', 'y')));
  perform skill_authoring_discard_draft(probe_author_a(), v_deal, v_draft,
    (select edit_revision from skill_authoring_drafts where id = v_draft), probe_correlation());
  perform probe_assert((select count(*) from audit_log where deal_id = v_deal and action = 'skill_authoring.draft_created') = 1,
    'draft_created audit row is missing');
  perform probe_assert((select count(*) from audit_log where deal_id = v_deal and action = 'skill_authoring.message_admitted') = 1,
    'message_admitted audit row is missing');
  perform probe_assert((select count(*) from audit_log where deal_id = v_deal and action = 'skill_authoring.attempt_transitioned') >= 1,
    'attempt_transitioned audit row is missing');
  perform probe_assert((select count(*) from audit_log where deal_id = v_deal and action = 'skill_authoring.candidate_selected') = 1,
    'candidate_selected audit row is missing');
  perform probe_assert(not exists (
    select from audit_log where deal_id = v_deal and detail::text ilike '%' || v_secret_message || '%'
  ), 'audit detail leaked the message text');
  perform probe_assert(not exists (
    select from audit_log where deal_id = v_deal and detail::text ilike '%' || v_secret_reply || '%'
  ), 'audit detail leaked the reply text');
  perform probe_assert((select count(*) from audit_log
    where deal_id = v_deal and action in ('skill_authoring.candidate_selected', 'skill_authoring.attempt_transitioned')
      and actor_id is null and service_identity = 'conductia') >= 2,
    'turn-written audit rows must carry a null actor_id and service_identity conductia');
end;
$$;
\echo ok: audit rows exist for the lifecycle without leaking message or reply text
