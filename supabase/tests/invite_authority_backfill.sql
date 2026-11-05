-- #296 backfill boundary. The invite-authority restore (20261003100000) stops
-- reading users.can_invite and reads the permission system instead, so it grants
-- company:invites:send to the users who relied on the flag alone. A migration has
-- already run by the time any other probe does, so this probe re-runs the file
-- itself over seeded users and asserts exactly who it grants.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invite_authority_backfill.sql
--
-- The WHERE clause is the boundary. enforce_company_access_eligibility() fires only
-- when a company_member_access row is INSERTED, so a suspended user who already
-- holds an access row would pass the foreign key on company_member_permissions
-- without any trigger objecting: only the migration's own predicates refuse them.
-- That user is seeded here on purpose.
--
-- Ids (all in tenant 29600000-...-01, foreign tenant ...-02):
--   bank 29600000-0000-4000-8000-0000000000b1   bank in the foreign tenant ...b2
--   dir ...d1 (director)   susp ...a1   susp-with-access ...a2   external ...a3
--   admin ...a4   role holder ...a5   foreign-bank user ...a6   eligible ...a7
--   unjoined tenant ...03 with bank ...b3; pending crossings ...e1 (unjoined), ...e2 (foreign)
--
-- It also pins the pending-crossing backfill (section 0) and that reactivating
-- a suspended user the backfill skipped restores no flag-only authority.

begin;

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
declare
  v_t constant uuid := '29600000-0000-4000-8000-000000000001';
  v_t2 constant uuid := '29600000-0000-4000-8000-000000000002';
  v_bank constant uuid := '29600000-0000-4000-8000-0000000000b1';
  v_bank2 constant uuid := '29600000-0000-4000-8000-0000000000b2';
  v_dir constant uuid := '29600000-0000-4000-8000-0000000000d1';
  v_dir2 constant uuid := '29600000-0000-4000-8000-0000000000d2';
  v_role constant uuid := '29600000-0000-4000-8000-0000000000f1';
begin
  insert into companies (id, tenant_id, name, type) values
    (v_bank, v_t, 'Backfill Bank', 'bank'), (v_bank2, v_t2, 'Foreign Bank', 'bank');

  insert into auth.users (id, email) values
    (v_dir, 'dir@backfill.dev'), (v_dir2, 'dir2@backfill.dev'),
    ('29600000-0000-4000-8000-0000000000a1', 'susp@backfill.dev'),
    ('29600000-0000-4000-8000-0000000000a2', 'suspaccess@backfill.dev'),
    ('29600000-0000-4000-8000-0000000000a3', 'ext@backfill.dev'),
    ('29600000-0000-4000-8000-0000000000a4', 'admin@backfill.dev'),
    ('29600000-0000-4000-8000-0000000000a5', 'roleholder@backfill.dev'),
    ('29600000-0000-4000-8000-0000000000a6', 'foreign@backfill.dev'),
    ('29600000-0000-4000-8000-0000000000a7', 'eligible@backfill.dev');

  -- Directors first: a company cannot take a member before it has a director.
  update users set tenant_id = v_t, company_id = v_bank, company_role = 'director',
    is_external = false, firm_role = null, status = 'active' where id = v_dir;
  update users set tenant_id = v_t2, company_id = v_bank2, company_role = 'director',
    is_external = false, firm_role = null, status = 'active' where id = v_dir2;
  update users set tenant_id = v_t, company_id = v_bank, company_role = 'member',
    is_external = false, firm_role = null, status = 'active'
   where id in ('29600000-0000-4000-8000-0000000000a1', '29600000-0000-4000-8000-0000000000a2',
                '29600000-0000-4000-8000-0000000000a5', '29600000-0000-4000-8000-0000000000a7');
  update users set tenant_id = v_t, company_id = v_bank, company_role = 'member',
    is_external = true, firm_role = null, status = 'active'
   where id = '29600000-0000-4000-8000-0000000000a3';
  update users set tenant_id = v_t, company_id = v_bank, company_role = 'member',
    is_external = false, firm_role = 'admin', status = 'active'
   where id = '29600000-0000-4000-8000-0000000000a4';
  -- Works at the foreign tenant's bank while living in this tenant.
  update users set tenant_id = v_t, company_id = v_bank2, company_role = 'member',
    is_external = false, firm_role = null, status = 'active'
   where id = '29600000-0000-4000-8000-0000000000a6';

  -- a2 already holds an access row (no permission) and is suspended afterwards.
  insert into company_member_access (company_id, user_id)
  values (v_bank, '29600000-0000-4000-8000-0000000000a2');
  -- a5 holds the permission through a role, which the backfill must not duplicate.
  insert into company_member_access (company_id, user_id)
  values (v_bank, '29600000-0000-4000-8000-0000000000a5');
  insert into company_roles (id, company_id, name, created_by) values (v_role, v_bank, 'Backfill Inviters', v_dir);
  insert into company_role_permissions (company_id, role_id, permission_key)
  values (v_bank, v_role, 'company:invites:send');
  insert into company_member_roles (company_id, user_id, role_id, assigned_by)
  values (v_bank, '29600000-0000-4000-8000-0000000000a5', v_role, v_dir);

  update users set status = 'suspended'
   where id in ('29600000-0000-4000-8000-0000000000a1', '29600000-0000-4000-8000-0000000000a2');

  -- Everyone relied on the flag alone (no grant row anywhere).
  update users set can_invite = true
   where id in (v_dir, '29600000-0000-4000-8000-0000000000a1', '29600000-0000-4000-8000-0000000000a2',
                '29600000-0000-4000-8000-0000000000a3', '29600000-0000-4000-8000-0000000000a4',
                '29600000-0000-4000-8000-0000000000a5', '29600000-0000-4000-8000-0000000000a6',
                '29600000-0000-4000-8000-0000000000a7');
end $$;

-- Pending crossings issued before the restore carry no recorded decision. The
-- admin a4 left one into a tenant no one has joined (...03, bank ...b3) and one
-- into the foreign tenant, which dir2 has joined. Only the first is still a
-- provisioning crossing, so only it gains provisioning_crossing.
do $$
begin
  insert into companies (id, tenant_id, name, type) values
    ('29600000-0000-4000-8000-0000000000b3', '29600000-0000-4000-8000-000000000003', 'Unjoined Bank', 'bank');
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role,
                       challenge_digest, challenge_version, challenge_issued_at)
  values
    ('29600000-0000-4000-8000-0000000000e1', '29600000-0000-4000-8000-000000000003', 'owner@unjoined.dev',
     '29600000-0000-4000-8000-0000000000a4', '29600000-0000-4000-8000-0000000000b3', 'director',
     repeat('e', 64), 1, now()),
    ('29600000-0000-4000-8000-0000000000e2', '29600000-0000-4000-8000-000000000002', 'late@foreign.dev',
     '29600000-0000-4000-8000-0000000000a4', '29600000-0000-4000-8000-0000000000b2', 'member',
     repeat('e', 64), 1, now());
end $$;

-- First run: the restore itself. Its backfill may also see rows other tests left
-- behind in a shared database, so every assertion below is scoped to the
-- fixture company.
\ir ../migrations/20261003100000_invite_authority_restore.sql

do $$
declare
  v_bank constant uuid := '29600000-0000-4000-8000-0000000000b1';
  v_eligible constant uuid := '29600000-0000-4000-8000-0000000000a7';
  v_rows int;
  v_audit int;
  v_row company_member_permissions%rowtype;
  v_log audit_log%rowtype;
begin
  select count(*) into v_rows from company_member_permissions
   where company_id = v_bank and permission_key = 'company:invites:send';
  if v_rows <> 1 then
    raise exception 'FAIL backfill: expected exactly one new direct grant, found %', v_rows;
  end if;
  select * into v_row from company_member_permissions
   where company_id = v_bank and permission_key = 'company:invites:send';
  if v_row.user_id <> v_eligible or v_row.granted_by is distinct from v_eligible then
    raise exception 'FAIL backfill: granted to % by %, expected the eligible delegate granting itself',
      v_row.user_id, v_row.granted_by;
  end if;
  if not exists (select 1 from company_member_access where company_id = v_bank and user_id = v_eligible) then
    raise exception 'FAIL backfill: the eligible delegate has no access row';
  end if;

  select count(*) into v_audit from audit_log
   where action = 'grant' and detail->>'company_id' = v_bank::text
     and detail->>'reason' = 'invite_permission_backfilled';
  if v_audit <> 1 then
    raise exception 'FAIL backfill: expected exactly one audit row, found %', v_audit;
  end if;
  select * into v_log from audit_log
   where action = 'grant' and detail->>'company_id' = v_bank::text
     and detail->>'reason' = 'invite_permission_backfilled';
  if v_log.actor_type <> 'service' or v_log.service_identity is distinct from 'migration:invite_authority_restore'
     or v_log.actor_id is not null or v_log.tenant_id <> '29600000-0000-4000-8000-000000000001'
     or v_log.detail->>'user_id' <> v_eligible::text or v_log.detail->>'source_type' <> 'direct'
     or v_log.detail->>'permission_key' <> 'company:invites:send' then
    raise exception 'FAIL backfill: audit row has the wrong shape: %', row_to_json(v_log);
  end if;

  -- The resolver now reports the grant, which is what the access drawer shows.
  if not exists (
    select 1 from app_company_effective_permissions(v_eligible, v_bank)
     where permission_key = 'company:invites:send' and source_type = 'direct'
  ) then
    raise exception 'FAIL backfill: the resolver does not report the new grant';
  end if;
  -- The foreign-tenant user (a6, works at bank ...b2) gets no grant of any kind:
  -- not in its own bank, and not in the bank it nominally works at.
  if exists (select 1 from company_member_permissions
              where user_id = '29600000-0000-4000-8000-0000000000a6')
     or exists (select 1 from audit_log
                 where detail->>'reason' = 'invite_permission_backfilled'
                   and detail->>'user_id' = '29600000-0000-4000-8000-0000000000a6') then
    raise exception 'FAIL backfill: the foreign-tenant user was granted or audited';
  end if;
  -- Across every fixture user (not just the fixture company) exactly one
  -- backfill audit row exists: the eligible delegate's.
  select count(*) into v_audit from audit_log
   where detail->>'reason' = 'invite_permission_backfilled'
     and detail->>'user_id' like '29600000-0000-4000-8000-0000000000%';
  if v_audit <> 1 then
    raise exception 'FAIL backfill: expected exactly one backfill audit row across the fixture users, found %', v_audit;
  end if;
  -- The role holder kept its role source and gained no second one.
  if exists (select 1 from company_member_permissions
              where user_id = '29600000-0000-4000-8000-0000000000a5') then
    raise exception 'FAIL backfill: a role holder received a direct grant';
  end if;
  if not (select provisioning_crossing from invites where id = '29600000-0000-4000-8000-0000000000e1') then
    raise exception 'FAIL backfill: a pending crossing into an unjoined tenant lost its provisioning crossing';
  end if;
  if (select provisioning_crossing from invites where id = '29600000-0000-4000-8000-0000000000e2') then
    raise exception 'FAIL backfill: a pending crossing into a joined tenant was marked a provisioning crossing';
  end if;
  raise notice 'PASS backfill: exactly the eligible delegate was granted and audited';
end $$;

-- Second run: nothing changes, and no audit row is added.
\ir ../migrations/20261003100000_invite_authority_restore.sql

do $$
declare
  v_bank constant uuid := '29600000-0000-4000-8000-0000000000b1';
begin
  if (select count(*) from company_member_permissions
       where company_id = v_bank and permission_key = 'company:invites:send') <> 1 then
    raise exception 'FAIL backfill rerun: a grant was added or removed';
  end if;
  if (select count(*) from audit_log
       where action = 'grant' and detail->>'company_id' = v_bank::text
         and detail->>'reason' = 'invite_permission_backfilled') <> 1 then
    raise exception 'FAIL backfill rerun: an audit row was added';
  end if;
  if (select count(*) from audit_log
       where detail->>'reason' = 'invite_permission_backfilled'
         and detail->>'user_id' like '29600000-0000-4000-8000-0000000000%') <> 1 then
    raise exception 'FAIL backfill rerun: the backfill audit rows across the fixture users are not exactly one';
  end if;
  if exists (select 1 from company_member_permissions
              where user_id = '29600000-0000-4000-8000-0000000000a6') then
    raise exception 'FAIL backfill rerun: the foreign-tenant user was granted';
  end if;
  raise notice 'PASS backfill: a re-run adds no grant and no audit row';
end $$;

-- Reactivation does not restore flag-only authority (intended). The backfill
-- skipped a1 because it was suspended, and users.can_invite is no longer read,
-- so reactivating it brings back no invitation authority. A director restores
-- it explicitly through access management, which is audited and visible in the
-- access drawer.
do $$
declare
  v_bank constant uuid := '29600000-0000-4000-8000-0000000000b1';
  v_dir constant uuid := '29600000-0000-4000-8000-0000000000d1';
  v_susp constant uuid := '29600000-0000-4000-8000-0000000000a1';
begin
  update users set status = 'active' where id = v_susp;
  if exists (select 1 from app_company_effective_permissions(v_susp, v_bank)
              where permission_key = 'company:invites:send') then
    raise exception 'FAIL reactivation: a reactivated flag-only user regained company:invites:send without a grant';
  end if;
  begin
    perform create_invite(v_susp, 'new@backfill.dev', v_bank, 'member', repeat('e', 64));
    raise exception 'FAIL reactivation: a reactivated flag-only user issued an invite';
  exception when others then
    if sqlerrm like 'FAIL reactivation%' then raise; end if;
    if sqlerrm <> 'not_permitted' then
      raise exception 'FAIL reactivation: refused with unexpected error %', sqlerrm;
    end if;
  end;

  -- The access RPC runs as the server does: service role, naming the actor.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform replace_company_member_access(v_dir, v_bank, v_susp, 0, array[]::uuid[],
                                        array['company:invites:send']);
  perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from app_company_effective_permissions(v_susp, v_bank)
                  where permission_key = 'company:invites:send' and source_type = 'direct') then
    raise exception 'FAIL reactivation: an explicit grant through access management did not restore company:invites:send';
  end if;
  raise notice 'PASS backfill: reactivation restores no flag-only authority; an explicit grant does';
end $$;

rollback;
