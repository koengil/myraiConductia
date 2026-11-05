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

\ir ../migrations/20260916110000_skill_authoring.sql
create function rail_remove_step(uuid, uuid, uuid, text[]) returns jsonb language sql as $$ select null::jsonb $$;
create function rail_restore_step(uuid, uuid, uuid) returns jsonb language sql as $$ select null::jsonb $$;
create function rail_skip_step(uuid, uuid, uuid, uuid, text) returns jsonb language sql as $$ select null::jsonb $$;
set check_function_bodies = off;
\ir ../migrations/20260916120000_skill_publication.sql
set check_function_bodies = on;

do $$
declare v_function regprocedure; v_config text[]; v_raw text; v_new_path text;
begin
  for v_function, v_config in
    select p.oid::regprocedure, p.proconfig from pg_proc p
    where p.pronamespace = current_schema()::regnamespace and (p.proname like 'skill_authoring_%' or p.proname like 'skill_publication_%')
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

insert into companies (id, kind, tenant_id) values
  ('11111111-0000-4000-8000-000000000001', 'tenant', null),
  ('22222222-0000-4000-8000-000000000002', 'bank', '11111111-0000-4000-8000-000000000001');
insert into users (id, company_id, status, is_external) values
  ('33333333-0000-4000-8000-000000000003', null, 'active', false);
insert into company_permission_grants (user_id, company_id, permission_key) values
  ('33333333-0000-4000-8000-000000000003', '22222222-0000-4000-8000-000000000002', 'company:deals:steps:structure');
insert into deals (id, tenant_id, bank_id) values
  ('44444444-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002');
insert into deal_memberships (deal_id, user_id) values
  ('44444444-0000-4000-8000-000000000004', '33333333-0000-4000-8000-000000000003');

create temporary table probe_draft (id uuid);

do $$
declare
  v_actor uuid := '33333333-0000-4000-8000-000000000003';
  v_deal uuid := '44444444-0000-4000-8000-000000000004';
  v_correlation uuid := '55555555-0000-4000-8000-000000000005';
  v_draft uuid;
  v_receipt1 jsonb;
  v_attempt1 uuid;
  v_receipt2 jsonb;
  v_attempt2 uuid;
begin
  v_draft := (skill_authoring_get_or_create_draft(v_actor, v_deal, v_correlation) #>> '{draft,id}')::uuid;
  v_receipt1 := skill_authoring_submit_message(v_actor, v_deal, v_draft, 0, gen_random_uuid(),
    'draft a buyer outreach tracker', v_correlation);
  v_attempt1 := (v_receipt1 #>> '{attempt,id}')::uuid;
  perform skill_authoring_complete_attempt(v_attempt1, 'here is the tracker', jsonb_build_object(
    'providerCandidateId', gen_random_uuid(), 'contentDigest', repeat('a', 64),
    'preview', jsonb_build_object('name', 'buyer-outreach-tracker', 'purpose', 'Track buyer outreach',
      'expectedInput', 'Buyer list', 'expectedOutput', 'Outreach table')));
  v_receipt2 := skill_authoring_submit_message(v_actor, v_deal, v_draft,
    (select edit_revision from skill_authoring_drafts where id = v_draft),
    gen_random_uuid(), 'add a follow-up column', v_correlation);
  v_attempt2 := (v_receipt2 #>> '{attempt,id}')::uuid;
  perform skill_authoring_record_progress(v_attempt2, 'working on the follow-up column');
  insert into probe_draft values (v_draft);
end;
$$;

select skill_authoring_read_draft(
  '33333333-0000-4000-8000-000000000003'::uuid,
  '44444444-0000-4000-8000-000000000004'::uuid,
  (select id from probe_draft),
  '55555555-0000-4000-8000-000000000005'::uuid
);
