-- Move one firm, and everything belonging to it, into its own tenant (#156).
--
-- Why this exists: organizations onboarded before 20260915120000 all inherited
-- the bootstrap admin's tenant, so two banks shared one. `is_external` is
-- derived from company type, so a second bank's staff cleared it, counted as
-- the first bank's internal staff, and could enumerate its client leads.
--
-- Usage (rehearse first, then apply):
--   DATABASE_URL=... psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v COMPANY=Ignatious -v FINISH=rollback -f scripts/split-company-tenant.sql
--   ... then the same command with -v FINISH=commit
--
-- The whole move is one transaction, including the auth.users metadata. That
-- matters: `handle_new_auth_user` seeds users.tenant_id from
-- raw_user_meta_data.tenant_id, and accept_invite refuses when the invite's
-- tenant and the accepting user's tenant disagree. Moving the rows without the
-- metadata would silently break every invitation still pending.
\set ON_ERROR_STOP on
begin;

-- psql does not interpolate :variables inside dollar-quoted blocks, so the
-- parameter is captured into a table the plpgsql below can read.
create temp table split_param on commit drop as
select :'COMPANY'::text as company_name;

create temp table split_target on commit drop as
select c.id, c.name, c.type, c.tenant_id as old_tenant, gen_random_uuid() as new_tenant
  from companies c
 where c.name = (select company_name from split_param);

-- Deals banked by the firm, captured before anything moves so later updates can
-- still identify them by id.
create temp table split_deals on commit drop as
select d.id from deals d where d.bank_id = (select id from split_target);

do $$
declare
  v_name text := (select company_name from split_param);
  v_count int;
  v_type text;
  v_id uuid;
  v_old uuid;
begin
  select count(*) into v_count from split_target;
  if v_count <> 1 then
    raise exception 'expected exactly one company named %, found %', v_name, v_count;
  end if;

  select id, type, old_tenant into v_id, v_type, v_old from split_target;

  -- Only a firm owns a tenant. A client/target/counterparty is a party in some
  -- firm's book and must stay in that firm's tenant to remain usable.
  if v_type <> 'bank' then
    raise exception 'company % is type %, not a firm: it cannot own a tenant', v_name, v_type;
  end if;

  -- Refuse if the firm is entangled with the tenant it is leaving. Each of these
  -- would be silently broken by the move, so they stop it rather than cascade:
  -- they need a human decision about where the shared work belongs.
  if exists (select 1 from deal_parties dp where dp.company_id = v_id) then
    raise exception '% is a party on a deal in the tenant it is leaving', v_name;
  end if;

  if exists (
    select 1
      from deal_memberships dm
      join users u on u.id = dm.user_id
     where u.company_id = v_id
       and dm.deal_id not in (select id from split_deals)
  ) then
    raise exception 'a member of % holds a seat on another firm''s deal', v_name;
  end if;

  if exists (
    select 1
      from deal_parties dp
      join companies c on c.id = dp.company_id
     where dp.deal_id in (select id from split_deals)
       and c.id <> v_id
       and c.tenant_id = v_old
  ) then
    raise exception 'deals banked by % have counterparties in the tenant it is leaving', v_name;
  end if;

  if exists (
    select 1 from companies
     where registered_by_company_id = v_id and tenant_id is distinct from v_old
  ) then
    raise exception '% registered leads in a third tenant', v_name;
  end if;
end $$;

-- The identities that move with the firm: current members, plus anyone still
-- holding a pending invitation to it (they have no company_id until they accept,
-- so membership alone would miss them and strand the invite).
create temp table split_users on commit drop as
select u.id from users u where u.company_id = (select id from split_target)
union
select au.id
  from invites i
  join auth.users au on lower(au.email) = i.email
 where i.company_id = (select id from split_target)
   and i.status = 'pending';

-- ---------------------------------------------------------------------------
-- The move. Every table carrying tenant_id that can be attributed to this firm,
-- with the predicate that attributes it.
--
-- Driven by a list rather than written out because this script has to run
-- against databases at different migration levels (ai_usage, for one, exists on
-- develop but not yet in production). A table that is not there yet is reported
-- and skipped; the tenant_id column's own type decides the cast, since the
-- lead_* tables store it as text rather than uuid.
-- ---------------------------------------------------------------------------
do $$
declare
  v_new uuid := (select new_tenant from split_target);
  v_id uuid := (select id from split_target);
  r record;
  v_type text;
  v_rows int;
begin
  for r in
    select * from (values
      ('companies',                  'id = {co}'),
      ('companies',                  'registered_by_company_id = {co}'),
      ('users',                      'id in (select id from split_users)'),
      ('invites',                    'company_id = {co}'),
      ('company_verified_domains',   'company_id = {co}'),
      ('invite_domain_confirmations','company_id = {co}'),
      ('deals',                      'id in (select id from split_deals)'),
      ('notifications',              'recipient_id in (select id from split_users)'),
      ('outbound_messages',          'sender_id in (select id from split_users)'),
      ('inbound_messages',           'deal_id in (select id from split_deals)'),
      ('ai_usage',                   'company_id = {co} or deal_id in (select id from split_deals)'),
      ('lead_relationships',         'company_id = {co}'),
      ('lead_stakeholders',          'company_id = {co}'),
      ('lead_relationship_paths',    'company_id = {co}'),
      ('lead_research',              'company_id = {co}'),
      ('crm_people',                 'registered_by_company_id = {co}'),
      ('lead_documents',             'company_id = {co}'),
      ('lead_intel',                 'company_id = {co}')
    ) as v(tbl, predicate)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'skip %: not present at this migration level', r.tbl;
      continue;
    end if;

    select data_type into v_type from information_schema.columns
     where table_schema = 'public' and table_name = r.tbl and column_name = 'tenant_id';
    if v_type is null then
      raise exception '% has no tenant_id column', r.tbl;
    end if;

    execute format('update %I set tenant_id = %L::%s where %s',
                   r.tbl, v_new, v_type,
                   replace(r.predicate, '{co}', quote_literal(v_id)));
    get diagnostics v_rows = row_count;
    raise notice '% (%): % row(s)', r.tbl, r.predicate, v_rows;
  end loop;
end $$;

-- The auth metadata, in the same transaction as the rows it has to agree with.
update auth.users au
   set raw_user_meta_data =
         jsonb_set(coalesce(au.raw_user_meta_data, '{}'::jsonb),
                   '{tenant_id}',
                   to_jsonb((select new_tenant::text from split_target)))
 where au.id in (select id from split_users);

-- ---------------------------------------------------------------------------
-- Prove the move is coherent before it can be committed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_new uuid := (select new_tenant from split_target);
  v_old uuid := (select old_tenant from split_target);
  v_id uuid := (select id from split_target);
  v_bad int;
begin
  -- Every pending invite must agree with the accepting user's tenant AND that
  -- user's auth metadata, or accept_invite raises tenant_mismatch.
  select count(*) into v_bad
    from invites i
    join auth.users au on lower(au.email) = i.email
    join users u on u.id = au.id
   where i.company_id = v_id
     and i.status = 'pending'
     and (i.tenant_id is distinct from u.tenant_id
       or (au.raw_user_meta_data->>'tenant_id') is distinct from i.tenant_id::text);
  if v_bad > 0 then
    raise exception '% pending invite(s) left with a tenant that cannot be accepted', v_bad;
  end if;

  -- Nobody and nothing owned by the firm may be left behind.
  select count(*) into v_bad from users where company_id = v_id and tenant_id <> v_new;
  if v_bad > 0 then raise exception '% member(s) left in the old tenant', v_bad; end if;

  select count(*) into v_bad from companies
   where (id = v_id or registered_by_company_id = v_id) and tenant_id <> v_new;
  if v_bad > 0 then raise exception '% company row(s) left in the old tenant', v_bad; end if;

  -- The firm must no longer share a tenant with any other firm, which is the
  -- whole point of the move.
  select count(*) into v_bad from companies
   where tenant_id = v_new and type = 'bank' and id <> v_id;
  if v_bad > 0 then raise exception 'new tenant still holds % other firm(s)', v_bad; end if;

  select count(*) into v_bad from companies
   where tenant_id = v_old and type = 'bank' and id <> v_id;
  raise notice 'firms remaining in the old tenant: %', v_bad;
end $$;

select name, old_tenant, new_tenant from split_target;

-- Rows that carry no company attribution stay in the old tenant. Shown so the
-- operator can confirm none of them belonged to the departing firm.
select 'lead_personas' as unattributable_table, count(*)
  from lead_personas where tenant_id = (select old_tenant::text from split_target)
union all
select 'inbound_messages', count(*)
  from inbound_messages where tenant_id = (select old_tenant from split_target);

select name, type, tenant_id::text from companies order by name;

select u.email, u.status, u.tenant_id::text as profile_tenant,
       au.raw_user_meta_data->>'tenant_id' as auth_meta_tenant
  from users u join auth.users au on au.id = u.id
 order by u.email;

:FINISH;
