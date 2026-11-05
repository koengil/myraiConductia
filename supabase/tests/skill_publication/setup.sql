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

\ir ../../migrations/20260916100000_project_rail_model.sql
\ir ../../migrations/20260916110000_skill_authoring.sql

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
  (probe_author_b(), probe_bank(), 'active', false);
insert into company_permission_grants (user_id, company_id, permission_key) values
  (probe_author_a(), probe_bank(), 'company:deals:steps:structure'),
  (probe_author_b(), probe_bank(), 'company:deals:steps:structure');

create function probe_seed_deal(p_deal uuid) returns void language plpgsql as $$
begin
  insert into deals (id, tenant_id, bank_id) values (p_deal, probe_tenant(), probe_bank())
    on conflict (id) do nothing;
  insert into deal_memberships (deal_id, user_id) values (p_deal, probe_author_a()), (p_deal, probe_author_b())
    on conflict do nothing;
end;
$$;

create function probe_draft(p_actor uuid, p_deal uuid) returns uuid language plpgsql as $$
declare v_draft uuid;
begin
  v_draft := (skill_authoring_get_or_create_draft(p_actor, p_deal, probe_correlation()) #>> '{draft,id}')::uuid;
  return v_draft;
end;
$$;

create function probe_revision(p_draft uuid) returns bigint language sql stable as $$
  select edit_revision from skill_authoring_drafts where id = p_draft
$$;

create function probe_submit(
  p_actor uuid, p_deal uuid, p_draft uuid, p_client uuid, p_text text
) returns jsonb language plpgsql as $$
begin
  return skill_authoring_submit_message(
    p_actor, p_deal, p_draft, probe_revision(p_draft), p_client, p_text, probe_correlation());
end;
$$;
