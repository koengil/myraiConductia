-- supabase/tests/rls_deal_scoped_policies.sql
-- Parity probe for the deal-scoped read policies (#78, #79 / D63), shipped in
-- 20260928120000_rls_deal_scoped_policies.sql. It is the #78 done-condition:
-- with the service role out of the request path, a direct /rest/v1/* read as
-- `authenticated` returns what the app would show that user, or less, and
-- never another tenant's rows. Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_deal_scoped_policies.sql
-- CI runs it through tests/db/rls-deal-scoped-policies.test.ts.
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.
--
-- Fixture: two tenants, ...00c1 (A) and ...00c2 (B). Tenant A has one deal
-- with four documents (internal/deal room x class 2/4), a party, seats for an
-- MD, a deal_team member and an external seller, a step, two deal audit rows
-- (by the MD and the deal_team member) and a company-level audit row (by the A
-- admin). Tenant B has one company-level audit row (by the B admin), so the
-- actor-tenant branch of audit_log_select is proven by a row it shows, not
-- only by rows it hides. Actors: A MD, A deal_team, A seller, A admin with no
-- seat, B admin, B cco. Every count is scoped to the fixture deal or to the
-- probe's own audit rows, so rows left behind by other suites cannot move it.
--
-- After the row matrix it checks three more things. Privileges: the five deal
-- tables keep `authenticated` SELECT, and feature_flags plus the four lead/CRM
-- tables hold no `authenticated` privilege at all. The skill tables (AQ-12):
-- deal_step_skill_runs and deal_step_skill_bindings stay service-role only,
-- with no `authenticated` privilege and no policy. The overseer lint: after a throwaway-policy self-test proves it can fire, it
-- fails if any public policy calls app_is_overseer( outside an explicit
-- allowlist, or reads firm_role inline. It reads pg_policies, the state that
-- ships after `db reset`, not migration history.

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

-- Fixture ids, readable by every block below (the DO blocks share nothing else).
create temp table rls_fx (k text primary key, v uuid not null) on commit drop;

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.rls_fx where k = p_k $$;

-- Count rows as p_user under RLS. service_role and the table owner bypass RLS,
-- so switch to `authenticated` and set the JWT claim auth.uid() reads
-- (pattern: notifications.sql). p_sql takes the deal id as $1.
create function pg_temp.rls_count(p_user uuid, p_sql text, p_deal uuid) returns int
language plpgsql as $$
declare
  v_cnt int;
begin
  if p_user is null or p_deal is null then
    raise exception 'FAIL: probe harness called rls_count with a null actor or deal';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user)::text, true);
  set local role authenticated;
  execute p_sql into v_cnt using p_deal;
  reset role;
  return v_cnt;
end;
$$;

create function pg_temp.expect_count(p_what text, p_got int, p_want int) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL: % saw % rows, expected %', p_what, p_got, p_want;
  end if;
end;
$$;

-- For values that are not row counts (the document-set bitmask below).
create function pg_temp.expect_value(p_what text, p_got int, p_want int) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL: % was %, expected %', p_what, p_got, p_want;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- FIXTURE
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_tenant_a uuid := '00000000-0000-4000-8000-0000000000c1';
  v_tenant_b uuid := '00000000-0000-4000-8000-0000000000c2';
  v_bank_a   uuid := gen_random_uuid();
  v_target_a uuid := gen_random_uuid();
  v_deal     uuid := gen_random_uuid();
  v_a_md     uuid := gen_random_uuid();
  v_a_team   uuid := gen_random_uuid();
  v_a_seller uuid := gen_random_uuid();
  v_a_admin  uuid := gen_random_uuid();
  v_b_admin  uuid := gen_random_uuid();
  v_b_cco    uuid := gen_random_uuid();
  v_cnt      int;
begin
  -- Seed through auth.users so the on_auth_user_created trigger builds
  -- public.users from the metadata (tenant, firm_role, is_external, department).
  -- No company_id, so the company director invariant stays out of the way.
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_a_md,     'rls-c1-md@example.com',
      jsonb_build_object('tenant_id', v_tenant_a, 'department', 'ib')),
    (v_a_team,   'rls-c1-team@example.com',
      jsonb_build_object('tenant_id', v_tenant_a, 'department', 'ib')),
    (v_a_seller, 'rls-c1-seller@example.com',
      jsonb_build_object('tenant_id', v_tenant_a, 'is_external', true)),
    (v_a_admin,  'rls-c1-admin@example.com',
      jsonb_build_object('tenant_id', v_tenant_a, 'firm_role', 'admin', 'department', 'admin')),
    (v_b_admin,  'rls-c2-admin@example.com',
      jsonb_build_object('tenant_id', v_tenant_b, 'firm_role', 'admin', 'department', 'admin')),
    (v_b_cco,    'rls-c2-cco@example.com',
      jsonb_build_object('tenant_id', v_tenant_b, 'firm_role', 'cco', 'department', 'compliance'));

  -- The mirror must have carried every gating column, or every later count
  -- would be measuring the wrong actors.
  select count(*) into v_cnt from users
    where (id = v_a_md     and tenant_id = v_tenant_a and firm_role is null and not is_external)
       or (id = v_a_team   and tenant_id = v_tenant_a and firm_role is null and not is_external)
       or (id = v_a_seller and tenant_id = v_tenant_a and firm_role is null and is_external)
       or (id = v_a_admin  and tenant_id = v_tenant_a and firm_role = 'admin' and not is_external)
       or (id = v_b_admin  and tenant_id = v_tenant_b and firm_role = 'admin' and not is_external)
       or (id = v_b_cco    and tenant_id = v_tenant_b and firm_role = 'cco' and not is_external);
  perform pg_temp.expect_count('fixture: mirrored public.users actors', v_cnt, 6);

  insert into companies (id, tenant_id, name, type) values
    (v_bank_a,   v_tenant_a, 'RLS Probe Bank C1',   'bank'),
    (v_target_a, v_tenant_a, 'RLS Probe Target C1', 'target');
  insert into deals (id, tenant_id, code, codename, bank_id, mandate_owner_id)
    values (v_deal, v_tenant_a, 'RLSC1-TEST-001', 'Project Fence', v_bank_a, v_a_md);

  insert into deal_parties (deal_id, company_id, party_role)
    values (v_deal, v_target_a, 'target');

  insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by)
    select v_deal, s.user_id, r.id, s.slug, v_a_md
    from (values (v_a_md, 'md'), (v_a_team, 'deal_team'), (v_a_seller, 'seller'))
      as s (user_id, slug)
    join roles r on r.slug = s.slug;

  insert into documents (deal_id, name, room, classification, min_phase, uploaded_by) values
    (v_deal, 'rls-internal-class2.pdf', 'internal', 2, 0, v_a_md),
    (v_deal, 'rls-internal-class4.pdf', 'internal', 4, 0, v_a_md),
    (v_deal, 'rls-deal-class2.pdf',     'deal',     2, 0, v_a_md),
    (v_deal, 'rls-deal-class4.pdf',     'deal',     4, 0, v_a_md);

  insert into deal_steps (deal_id, step_id, seq, status)
    values (v_deal, 'rls-probe-s1', 1, 'current');

  -- Two deal-scoped rows and two company-level rows (deal_id null), one per
  -- tenant. detail.row is the bit the audit_log block pins each row by.
  insert into audit_log (actor_id, action, deal_id, detail) values
    (v_a_md,    'view',  v_deal, jsonb_build_object('probe', 'rls_deal_scoped_policies', 'row', 1)),
    (v_a_team,  'view',  v_deal, jsonb_build_object('probe', 'rls_deal_scoped_policies', 'row', 2)),
    (v_a_admin, 'grant', null,   jsonb_build_object('probe', 'rls_deal_scoped_policies', 'row', 4)),
    (v_b_admin, 'grant', null,   jsonb_build_object('probe', 'rls_deal_scoped_policies', 'row', 8));

  -- The fixture exists as seeded (read as the owner, RLS bypassed), so a zero
  -- below is the policy talking, not an empty table.
  select count(*) into v_cnt from deal_parties where deal_id = v_deal;
  perform pg_temp.expect_count('fixture: deal_parties', v_cnt, 1);
  select count(*) into v_cnt from deal_memberships where deal_id = v_deal;
  perform pg_temp.expect_count('fixture: deal_memberships', v_cnt, 3);
  select count(*) into v_cnt from documents where deal_id = v_deal;
  perform pg_temp.expect_count('fixture: documents', v_cnt, 4);
  select count(*) into v_cnt from deal_steps where deal_id = v_deal;
  perform pg_temp.expect_count('fixture: deal_steps', v_cnt, 1);
  select count(*) into v_cnt from audit_log where detail->>'probe' = 'rls_deal_scoped_policies';
  perform pg_temp.expect_count('fixture: audit_log', v_cnt, 4);

  insert into pg_temp.rls_fx (k, v) values
    ('tenant_a', v_tenant_a), ('tenant_b', v_tenant_b), ('deal', v_deal),
    ('a_md', v_a_md), ('a_team', v_a_team), ('a_seller', v_a_seller),
    ('a_admin', v_a_admin), ('b_admin', v_b_admin), ('b_cco', v_b_cco);

  raise notice 'PASS: rls fixture seeded (two tenants, one tenant-A deal, six actors)';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER: app_is_deal_overseer fences an overseer by the deal's tenant
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_deal uuid := pg_temp.fx('deal');
begin
  -- Tenant-B actors really are overseers, so every zero they see below comes
  -- from the tenant fence and not from a missing firm_role.
  if not app_is_overseer(pg_temp.fx('b_admin')) or not app_is_overseer(pg_temp.fx('b_cco')) then
    raise exception 'FAIL: tenant-B admin and cco must be overseers for this probe to mean anything';
  end if;
  if not app_is_deal_overseer(v_deal, pg_temp.fx('a_admin')) then
    raise exception 'FAIL: a same-tenant admin must oversee the tenant-A deal';
  end if;
  if app_is_deal_overseer(v_deal, pg_temp.fx('b_admin')) then
    raise exception 'FAIL: a tenant-B admin must not oversee the tenant-A deal';
  end if;
  if app_is_deal_overseer(v_deal, pg_temp.fx('b_cco')) then
    raise exception 'FAIL: a tenant-B cco must not oversee the tenant-A deal';
  end if;
  if app_is_deal_overseer(v_deal, pg_temp.fx('a_md')) then
    raise exception 'FAIL: a deal MD without firm_role must not count as an overseer';
  end if;
  if app_is_deal_overseer(gen_random_uuid(), pg_temp.fx('a_admin')) then
    raise exception 'FAIL: an unknown deal must not have an overseer';
  end if;

  raise notice 'PASS: app_is_deal_overseer fences overseers by the deal''s tenant';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- deal_parties / deal_memberships
-- Every tenant-A actor sees all tenant-A rows (the roster the members route
-- returns); tenant-B overseers see none.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_deal uuid := pg_temp.fx('deal');
  r      record;
begin
  for r in
    select *
    from (values
      ('A MD',               pg_temp.fx('a_md'),     1, 3),
      ('A deal_team',        pg_temp.fx('a_team'),   1, 3),
      ('A seller',           pg_temp.fx('a_seller'), 1, 3),
      ('A admin (no seat)',  pg_temp.fx('a_admin'),  1, 3),
      ('B admin',            pg_temp.fx('b_admin'),  0, 0),
      ('B cco',              pg_temp.fx('b_cco'),    0, 0)
    ) as t (label, user_id, parties, memberships)
  loop
    perform pg_temp.expect_count(
      r.label || ' on deal_parties',
      pg_temp.rls_count(r.user_id, 'select count(*)::int from deal_parties where deal_id = $1', v_deal),
      r.parties);
    perform pg_temp.expect_count(
      r.label || ' on deal_memberships',
      pg_temp.rls_count(r.user_id, 'select count(*)::int from deal_memberships where deal_id = $1', v_deal),
      r.memberships);
  end loop;

  raise notice 'PASS: deal_parties and deal_memberships: tenant-A actors see all tenant-A rows, tenant-B overseers see 0';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER: app_user_is_external fails closed on an unknown caller
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not app_user_is_external(pg_temp.fx('a_seller')) then
    raise exception 'FAIL: the external seller must read as external';
  end if;
  if app_user_is_external(pg_temp.fx('a_md')) or app_user_is_external(pg_temp.fx('a_admin')) then
    raise exception 'FAIL: internal staff must not read as external';
  end if;
  if not app_user_is_external(gen_random_uuid()) then
    raise exception 'FAIL: an unknown user must read as external (fail closed)';
  end if;
  if not app_user_is_external(null) then
    raise exception 'FAIL: a null user must read as external (fail closed)';
  end if;

  raise notice 'PASS: app_user_is_external fails closed on an unknown caller';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- documents: tenant fence, room wall, class-4 wall
-- Each cell is what GET /api/v1/deals/:id/documents lists after this PR
-- (userCanListDocument then userCanListDocumentName). The bitmask pins the
-- exact set, not just its size: internal/2 = 1, internal/4 = 2, deal/2 = 4,
-- deal/4 = 8.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_deal uuid := pg_temp.fx('deal');
  v_mask text := 'select coalesce(sum(case'
    || ' when room = ''internal'' and classification = 2 then 1'
    || ' when room = ''internal'' and classification = 4 then 2'
    || ' when room = ''deal''     and classification = 2 then 4'
    || ' when room = ''deal''     and classification = 4 then 8'
    || ' else 16 end), 0)::int from documents where deal_id = $1';
  r      record;
begin
  for r in
    select *
    from (values
      ('A MD',               pg_temp.fx('a_md'),     4, 15),  -- every row
      ('A deal_team',        pg_temp.fx('a_team'),   2,  5),  -- class 2, both rooms
      ('A seller',           pg_temp.fx('a_seller'), 1,  4),  -- deal room, class 2
      ('A admin (no seat)',  pg_temp.fx('a_admin'),  4, 15),  -- every row
      ('B admin',            pg_temp.fx('b_admin'),  0,  0),
      ('B cco',              pg_temp.fx('b_cco'),    0,  0)
    ) as t (label, user_id, docs, mask)
  loop
    perform pg_temp.expect_count(
      r.label || ' on documents',
      pg_temp.rls_count(r.user_id, 'select count(*)::int from documents where deal_id = $1', v_deal),
      r.docs);
    perform pg_temp.expect_value(
      r.label || ' document set (internal/2=1 internal/4=2 deal/2=4 deal/4=8)',
      pg_temp.rls_count(r.user_id, v_mask, v_deal),
      r.mask);
  end loop;

  raise notice 'PASS: documents: MD and same-tenant admin see 4, deal_team 2 (class 2), seller 1 (deal room, class 2), tenant-B overseers 0';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- deal_steps: tenant fence and internal wall
-- Equality with GET /api/v1/deals/:id/steps: internal members and same-tenant
-- overseers see the step; the external seller gets 403 there and 0 here.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_deal uuid := pg_temp.fx('deal');
  r      record;
begin
  for r in
    select *
    from (values
      ('A MD',               pg_temp.fx('a_md'),     1),
      ('A deal_team',        pg_temp.fx('a_team'),   1),
      ('A seller',           pg_temp.fx('a_seller'), 0),  -- member, but external
      ('A admin (no seat)',  pg_temp.fx('a_admin'),  1),
      ('B admin',            pg_temp.fx('b_admin'),  0),
      ('B cco',              pg_temp.fx('b_cco'),    0)
    ) as t (label, user_id, steps)
  loop
    perform pg_temp.expect_count(
      r.label || ' on deal_steps',
      pg_temp.rls_count(r.user_id, 'select count(*)::int from deal_steps where deal_id = $1', v_deal),
      r.steps);
  end loop;

  raise notice 'PASS: deal_steps: internal members and same-tenant admin see 1, seller 0 (internal wall), tenant-B overseers 0';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER: app_actor_in_user_tenant compares the actor's tenant to the user's
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not app_actor_in_user_tenant(pg_temp.fx('a_admin'), pg_temp.fx('a_md')) then
    raise exception 'FAIL: two tenant-A users must share a tenant';
  end if;
  if not app_actor_in_user_tenant(pg_temp.fx('b_admin'), pg_temp.fx('b_cco')) then
    raise exception 'FAIL: two tenant-B users must share a tenant';
  end if;
  if app_actor_in_user_tenant(pg_temp.fx('a_admin'), pg_temp.fx('b_admin')) then
    raise exception 'FAIL: a tenant-A actor must not be in a tenant-B user''s tenant';
  end if;
  if app_actor_in_user_tenant(null, pg_temp.fx('a_admin')) then
    raise exception 'FAIL: a null actor must not match any tenant (fail closed)';
  end if;
  if app_actor_in_user_tenant(gen_random_uuid(), pg_temp.fx('a_admin'))
     or app_actor_in_user_tenant(pg_temp.fx('a_admin'), gen_random_uuid()) then
    raise exception 'FAIL: an unknown actor or user must not match any tenant (fail closed)';
  end if;

  raise notice 'PASS: app_actor_in_user_tenant matches same-tenant actors only and fails closed';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log: own rows, plus the overseer's own tenant only
-- RLS is asserted as a subset of the app, not equal to it: the deal audit
-- trail route shows every deal member the whole trail, and that wider view is
-- the separate audit-route leak, not a target. Non-overseers see only their
-- own rows. An overseer sees deal rows of their tenant's deals and
-- company-level rows whose actor is in their tenant (D2). The bitmask pins the
-- exact set: A MD deal row = 1, A deal_team deal row = 2, A admin company row
-- = 4, B admin company row = 8.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_deal uuid := pg_temp.fx('deal');
  v_scope text := ' from audit_log where detail->>''probe'' = ''rls_deal_scoped_policies'''
    || ' and (deal_id = $1 or deal_id is null)';
  r      record;
begin
  for r in
    select *
    from (values
      ('A MD',               pg_temp.fx('a_md'),     1, 1),  -- own deal row
      ('A deal_team',        pg_temp.fx('a_team'),   1, 2),  -- own deal row
      ('A seller',           pg_temp.fx('a_seller'), 0, 0),  -- wrote nothing
      ('A admin (no seat)',  pg_temp.fx('a_admin'),  3, 7),  -- both deal rows + own company row
      ('B admin',            pg_temp.fx('b_admin'),  1, 8),  -- own company row, no tenant-A row
      ('B cco',              pg_temp.fx('b_cco'),    1, 8)   -- tenant-B company row by actor tenant
    ) as t (label, user_id, rows_seen, mask)
  loop
    perform pg_temp.expect_count(
      r.label || ' on audit_log',
      pg_temp.rls_count(r.user_id, 'select count(*)::int' || v_scope, v_deal),
      r.rows_seen);
    perform pg_temp.expect_value(
      r.label || ' audit_log set (A MD deal=1 A team deal=2 A admin company=4 B admin company=8)',
      pg_temp.rls_count(r.user_id,
        'select coalesce(sum((detail->>''row'')::int), 0)::int' || v_scope, v_deal),
      r.mask);
  end loop;

  raise notice 'PASS: audit_log: members see own rows, same-tenant admin sees 3 tenant-A rows, tenant-B overseers see 0 tenant-A rows';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRIVILEGES
-- The five deal tables keep the `authenticated` SELECT grant: #78 closes on
-- correct isolation with the grant in place, not on "permission denied".
-- feature_flags (#79) and the four dead lead/CRM grants hold no privilege for
-- `authenticated`, at table or column level, while RLS stays on, no policy is
-- left on them and the service role (the app's only path) keeps its access.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t      text;
  p      text;
  v_rls  boolean;
  v_cnt  int;
begin
  foreach t in array array['documents', 'audit_log', 'deal_parties', 'deal_memberships', 'deal_steps']
  loop
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception 'FAIL: authenticated lost SELECT on %; the fix keeps the grant and corrects the policy (#78)', t;
    end if;
  end loop;

  foreach t in array array['feature_flags', 'lead_relationships', 'lead_stakeholders',
                           'lead_relationship_paths', 'crm_people']
  loop
    -- A comma list is true if ANY of the privileges is held.
    if has_table_privilege('authenticated', 'public.' || t,
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_any_column_privilege('authenticated', 'public.' || t,
                                   'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception 'FAIL: authenticated still holds a privilege on %', t;
    end if;

    select relrowsecurity into v_rls from pg_class where oid = ('public.' || t)::regclass;
    if not coalesce(v_rls, false) then
      raise exception 'FAIL: RLS must stay enabled on %', t;
    end if;

    select count(*) into v_cnt from pg_policies where schemaname = 'public' and tablename = t;
    perform pg_temp.expect_count('policies left on ' || t, v_cnt, 0);

    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    loop
      if not has_table_privilege('service_role', 'public.' || t, p) then
        raise exception 'FAIL: service_role lost % on %; the app reads and writes it through the secret key', p, t;
      end if;
    end loop;
  end loop;

  raise notice 'PASS: privileges: authenticated keeps SELECT on the five deal tables and holds nothing on feature_flags or the four lead/CRM tables';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SKILL TABLES (AQ-12)
-- deal_step_skill_runs (20260916130000) and deal_step_skill_bindings
-- (20260916140000) shipped service-role only: RLS on, no policy, no
-- `authenticated` privilege, so a direct /rest/v1 read is denied outright and
-- the tenant question never arises. Assert that state, so a later grant or
-- policy cannot open either table without a reviewed change to this probe
-- (and, if the policy is overseer-keyed, without passing the lint below).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t      text;
  v_rls  boolean;
  v_cnt  int;
begin
  foreach t in array array['deal_step_skill_runs', 'deal_step_skill_bindings']
  loop
    if to_regclass('public.' || t) is null then
      raise exception 'FAIL: % is missing; the probe expects the skill tables from #183/#184', t;
    end if;

    if has_table_privilege('authenticated', 'public.' || t,
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_any_column_privilege('authenticated', 'public.' || t,
                                   'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception 'FAIL: authenticated holds a privilege on %; it is service-role only (AQ-12)', t;
    end if;

    select relrowsecurity into v_rls from pg_class where oid = ('public.' || t)::regclass;
    if not coalesce(v_rls, false) then
      raise exception 'FAIL: RLS must stay enabled on %', t;
    end if;

    select count(*) into v_cnt from pg_policies where schemaname = 'public' and tablename = t;
    perform pg_temp.expect_count('policies on ' || t, v_cnt, 0);

    if not has_table_privilege('service_role', 'public.' || t, 'SELECT') then
      raise exception 'FAIL: service_role lost SELECT on %; the skill routes read it through the secret key', t;
    end if;
  end loop;

  raise notice 'PASS: skill tables: deal_step_skill_runs and deal_step_skill_bindings are service-role only (no authenticated privilege, no policy)';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- OVERSEER LINT
-- app_is_overseer has no tenant term, so a policy may call it only next to its
-- own tenant comparison. Only the allowlisted policies do that, and each new
-- entry is a reviewed diff. A policy that reads firm_role inline is the same
-- check spelled by hand (feature_flags_write was one), so it fails too. The
-- deal-keyed helper is app_is_deal_overseer(deal_id, auth.uid()); \m keeps it
-- from matching. pg_policies.qual is the deparsed expression, so helper names
-- appear verbatim, schema-qualified or not.
-- ─────────────────────────────────────────────────────────────────────────────
create function pg_temp.tenant_blind_policies()
returns table (tablename text, policyname text, reason text)
language sql stable as $$
  select p.tablename::text, p.policyname::text, 'calls app_is_overseer( outside the allowlist'
  from pg_policies p
  where p.schemaname = 'public'
    and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ '\mapp_is_overseer\('
    and (p.tablename::text, p.policyname::text) not in (
      ('users', 'users_select'), ('deals', 'deals_select'), ('audit_log', 'audit_log_select'))
  union all
  select p.tablename::text, p.policyname::text, 'reads firm_role inline'
  from pg_policies p
  where p.schemaname = 'public'
    and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ '\mfirm_role\M'
$$;

-- Self-test: the lint must fire on a tenant-blind policy, in both spellings,
-- and stay quiet on the deal-keyed helper. The throwaway policies are dropped
-- before the verdict, and the whole file rolls back regardless.
do $$
declare
  v_hits text;
begin
  create policy rls_probe_lint_selftest_blind on deal_parties for select to authenticated
    using (app_is_overseer(auth.uid()));
  create policy rls_probe_lint_selftest_inline on deal_parties for select to authenticated
    using (exists (select 1 from users u where u.id = auth.uid() and u.firm_role in ('cco', 'admin')));
  create policy rls_probe_lint_selftest_fenced on deal_parties for select to authenticated
    using (app_is_deal_overseer(deal_id, auth.uid()));

  select string_agg(policyname, ',' order by policyname) into v_hits
    from pg_temp.tenant_blind_policies()
    where policyname like 'rls\_probe\_lint\_selftest\_%';

  drop policy rls_probe_lint_selftest_blind on deal_parties;
  drop policy rls_probe_lint_selftest_inline on deal_parties;
  drop policy rls_probe_lint_selftest_fenced on deal_parties;

  if v_hits is distinct from 'rls_probe_lint_selftest_blind,rls_probe_lint_selftest_inline' then
    raise exception 'FAIL: overseer lint self-test flagged [%], expected the blind and inline throwaways only', v_hits;
  end if;

  raise notice 'PASS: overseer lint self-test: flags app_is_overseer( and inline firm_role, ignores app_is_deal_overseer';
end $$;

do $$
declare
  v_bad  text;
  v_qual text;
  r      record;
begin
  select string_agg(format('%s.%s (%s)', tablename, policyname, reason), '; '
                    order by tablename, policyname)
    into v_bad
    from pg_temp.tenant_blind_policies();
  if v_bad is not null then
    raise exception 'FAIL: tenant-blind overseer in %. Use app_is_deal_overseer(deal_id, auth.uid()) for deal-keyed rows (#78)', v_bad;
  end if;

  -- The allowlist is only safe while each entry keeps its tenant term.
  for r in
    select *
    from (values
      ('users',     'users_select',     '\mapp_user_tenant\('),
      ('deals',     'deals_select',     '\mapp_user_tenant\('),
      ('audit_log', 'audit_log_select', '\mapp_actor_in_user_tenant\(')
    ) as t (tbl, pol, tenant_term)
  loop
    select qual into v_qual from pg_policies
      where schemaname = 'public' and tablename = r.tbl and policyname = r.pol;
    if v_qual is null then
      raise exception 'FAIL: allowlisted policy %.% is missing; drop it from the lint allowlist', r.tbl, r.pol;
    end if;
    if v_qual !~ r.tenant_term then
      raise exception 'FAIL: allowlisted policy %.% calls app_is_overseer without its tenant term', r.tbl, r.pol;
    end if;
  end loop;

  raise notice 'PASS: overseer lint: no policy outside the allowlist calls app_is_overseer( or reads firm_role inline';
end $$;

rollback;
