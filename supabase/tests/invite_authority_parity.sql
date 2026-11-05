-- Invite authority parity: the SQL half of the guarantee that
-- `create_invite` and `src/lib/api/v1/proposalFeasibility.ts` agree.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invite_authority_parity.sql
--
-- `create_invite` re-derives invitation authority and seat shape inside the
-- write transaction, because the route's check happens before an async gap: a
-- director can be demoted, or a party removed, between the check and the
-- insert. That re-derivation is a second implementation of rules that already
-- live in TypeScript, and two implementations drift. This probe pins the SQL
-- side to the same case table `tests/invite-authority-parity.test.ts` pins the
-- TypeScript side to. If they disagree, one of the two fails.
--
-- Every case asserts on the RESOLVED OUTCOME, not merely on success: a check
-- that only asked "was it refused" would pass against a build that refuses for
-- the wrong reason.

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
declare
  v_tenant uuid := gen_random_uuid();
  v_other_tenant uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_seller uuid := gen_random_uuid();
  v_foreign uuid := gen_random_uuid();
  v_deal uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_bank_director uuid := gen_random_uuid();
  v_seller_director uuid := gen_random_uuid();
  v_delegated uuid := gen_random_uuid();
  v_plain uuid := gen_random_uuid();
  v_other_member uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_client_director uuid := gen_random_uuid();
  v_nonparty uuid := gen_random_uuid();
  v_nonparty_director uuid := gen_random_uuid();
  v_role_member uuid := gen_random_uuid();
  v_company_role uuid := gen_random_uuid();
  v_susp_delegate uuid := gen_random_uuid();
  v_susp_director uuid := gen_random_uuid();
  v_susp_admin uuid := gen_random_uuid();
  v_fn text;
  v_body text;
  v_role uuid;
  v_digest text := repeat('a', 64);
  v_result jsonb;
  v_row invites%rowtype;
begin
  -- ---- fixtures -----------------------------------------------------------
  insert into companies (id, tenant_id, name, type)
  values
    (v_bank, v_tenant, 'Advisory Bank', 'bank'),
    (v_seller, v_tenant, 'Target Co', 'target'),
    (v_foreign, v_other_tenant, 'Other Tenant Co', 'target'),
    (v_client, v_tenant, 'Client Co', 'client'),
    (v_nonparty, v_tenant, 'Bystander Co', 'target');

  insert into deals (id, tenant_id, bank_id, code, codename, status)
  values (v_deal, v_tenant, v_bank, 'PARITY-1', 'Parity', 'active');

  insert into deal_parties (deal_id, company_id, party_role)
  values (v_deal, v_seller, 'target');

  -- Verified domains so the pre-send domain gate classifies these addresses as
  -- `match`. This probe is about authority, not about the domain gate, which
  -- `invite_safeguards.sql` already covers.
  insert into company_verified_domains (tenant_id, company_id, domain, source)
  values
    (v_tenant, v_bank, 'bank.dev', 'test'),
    (v_tenant, v_seller, 'target.dev', 'test'),
    (v_other_tenant, v_foreign, 'other.dev', 'test'),
    (v_tenant, v_client, 'client.dev', 'test'),
    (v_tenant, v_nonparty, 'bystander.dev', 'test');

  insert into auth.users (id, email) values
    (v_admin, 'admin@bank.dev'),
    (v_bank_director, 'dir@bank.dev'),
    (v_seller_director, 'dir@target.dev'),
    (v_delegated, 'delegate@bank.dev'),
    (v_plain, 'plain@bank.dev'),
    (v_other_member, 'member@other.dev'),
    (v_client_director, 'dir@client.dev'),
    (v_nonparty_director, 'dir@bystander.dev'),
    (v_role_member, 'rolemember@bank.dev'),
    (v_susp_delegate, 'suspdelegate@bank.dev'),
    (v_susp_director, 'suspdir@bank.dev'),
    (v_susp_admin, 'suspadmin@bank.dev')
  on conflict (id) do nothing;

  -- The auth mirror trigger already created a `public.users` row for each of
  -- the accounts above, in the default tenant. Update those rows rather than
  -- racing the trigger with a second insert.
  --
  -- Directors are placed first: a trigger enforces that a company always
  -- retains an active director, so a company cannot receive its first member
  -- before it has one.
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'director',
    is_external = false, firm_role = null, can_invite = false, status = 'active'
  where id = v_bank_director;
  update users set tenant_id = v_tenant, company_id = v_seller, company_role = 'director',
    is_external = true, firm_role = null, can_invite = false, status = 'active'
  where id = v_seller_director;
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'member',
    is_external = false, firm_role = 'admin', can_invite = false, status = 'active'
  where id = v_admin;
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'member',
    is_external = false, firm_role = null, can_invite = true, status = 'active'
  where id = v_delegated;
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'member',
    is_external = false, firm_role = null, can_invite = false, status = 'active'
  where id = v_plain;

  -- The foreign tenant is JOINED: it holds one active user, so
  -- `tenant_is_unprovisioned` is false and the #251 provisioning crossing does
  -- not apply (case 8). The user has no company on purpose:
  -- `company_has_director` would reject an active member of the directorless
  -- v_foreign, and `tenant_is_unprovisioned` reads only `users.tenant_id`.
  update users set tenant_id = v_other_tenant, company_id = null, company_role = null,
    is_external = false, firm_role = null, can_invite = false, status = 'active'
  where id = v_other_member;

  -- Directors first, as above: a company cannot take its first member before
  -- it has a director.
  update users set tenant_id = v_tenant, company_id = v_client, company_role = 'director',
    is_external = true, firm_role = null, can_invite = false, status = 'active'
  where id = v_client_director;
  update users set tenant_id = v_tenant, company_id = v_nonparty, company_role = 'director',
    is_external = true, firm_role = null, can_invite = false, status = 'active'
  where id = v_nonparty_director;
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'member',
    is_external = false, firm_role = null, can_invite = false, status = 'active'
  where id in (v_role_member, v_susp_delegate);
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'director',
    is_external = false, firm_role = null, can_invite = false, status = 'active'
  where id = v_susp_director;
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'member',
    is_external = false, firm_role = 'admin', can_invite = false, status = 'active'
  where id = v_susp_admin;

  if (select count(*) from users where id in (v_admin, v_bank_director, v_seller_director, v_delegated, v_plain, v_other_member,
      v_client_director, v_nonparty_director, v_role_member, v_susp_delegate, v_susp_director, v_susp_admin)) <> 12 then
    raise exception 'FAIL setup: the auth mirror did not produce all twelve fixture users';
  end if;

  -- Invitation authority is the company:invites:send permission, held directly
  -- (the delegate, the soon-to-be-suspended delegate) or through a company role
  -- (the role member). The projection trigger sets users.can_invite from a
  -- direct grant; it is a read model, never the authority.
  insert into company_member_access (company_id, user_id)
  values (v_bank, v_delegated), (v_bank, v_susp_delegate), (v_bank, v_role_member)
  on conflict (company_id, user_id) do nothing;
  insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
  values (v_bank, v_delegated, 'company:invites:send', v_bank_director),
         (v_bank, v_susp_delegate, 'company:invites:send', v_bank_director);
  insert into company_roles (id, company_id, name, created_by)
  values (v_company_role, v_bank, 'Parity Inviters', v_bank_director);
  insert into company_role_permissions (company_id, role_id, permission_key)
  values (v_bank, v_company_role, 'company:invites:send');
  insert into company_member_roles (company_id, user_id, role_id, assigned_by)
  values (v_bank, v_role_member, v_company_role, v_bank_director);
  -- The delegate is suspended AFTER the grant: the projection still reads true.
  update users set status = 'suspended' where id in (v_susp_delegate, v_susp_director, v_susp_admin);

  select id into v_role from roles limit 1;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
  values (v_deal, v_bank_director, v_role, 'md', 0, v_bank_director)
  on conflict (deal_id, user_id) do nothing;

  -- ---- case 1: firm admin may create a Director in its own tenant ---------
  v_result := create_invite(v_admin, 'c1@target.dev', v_seller, 'director', v_digest, null, v_deal, 'seller', 2);
  select * into v_row from invites where id = (v_result->>'id')::uuid;
  if v_row.company_role <> 'director' then
    raise exception 'FAIL case 1: firm admin director invite resolved to %', v_row.company_role;
  end if;
  if v_row.phase <> 2 then
    raise exception 'FAIL case 1: confirmed phase 2 stored as %', v_row.phase;
  end if;

  -- ---- case 2: an INTERNAL Director of that same company may create a Director
  -- This is the second branch of `canManageCompanyMembers` (director of that
  -- same company, no firm role). It must be an internal actor: external actors
  -- are pinned to Member before authority is even consulted, which case 6
  -- covers.
  v_result := create_invite(v_bank_director, 'c2@bank.dev', v_bank, 'director', v_digest, null, v_deal, 'deal_team', 0);
  select * into v_row from invites where id = (v_result->>'id')::uuid;
  if v_row.company_role <> 'director' then
    raise exception 'FAIL case 2: same-company director invite resolved to %', v_row.company_role;
  end if;

  -- ---- case 3: a Director of a DIFFERENT company may not ------------------
  begin
    v_result := create_invite(v_bank_director, 'c3@target.dev', v_seller, 'director', v_digest, null, v_deal, 'seller', 0);
    raise exception 'FAIL case 3: cross-company director invite was permitted';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case 3%' then
        raise exception 'FAIL case 3: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case 3%' then raise; end if;
  end;

  -- ---- case 4: delegated can_invite may not create a Director ------------
  -- Delegation is send-only for member seats: a director invite is a
  -- company-management act.
  begin
    v_result := create_invite(v_delegated, 'c4@bank.dev', v_bank, 'director', v_digest, null, null, null, 0);
    raise exception 'FAIL case 4: delegated member created a director';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case 4%' then
        raise exception 'FAIL case 4: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case 4%' then raise; end if;
  end;

  -- ---- case 5: delegated can_invite MAY create a Member ------------------
  v_result := create_invite(v_delegated, 'c5@bank.dev', v_bank, 'member', v_digest, null, null, null, 0);
  select * into v_row from invites where id = (v_result->>'id')::uuid;
  if v_row.company_role <> 'member' then
    raise exception 'FAIL case 5: delegated member invite resolved to %', v_row.company_role;
  end if;

  -- ---- case 6: an external actor is coerced to Member ---------------------
  v_result := create_invite(v_seller_director, 'c6@target.dev', v_seller, 'member', v_digest, null, v_deal, 'seller', 3);
  select * into v_row from invites where id = (v_result->>'id')::uuid;
  if v_row.company_role <> 'member' then
    raise exception 'FAIL case 6: external member invite resolved to %', v_row.company_role;
  end if;

  -- ---- case 7: a plain internal member has no invitation authority -------
  begin
    v_result := create_invite(v_plain, 'c7@bank.dev', v_bank, 'member', v_digest, null, null, null, 0);
    raise exception 'FAIL case 7: unauthorized member sent an invitation';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case 7%' then
        raise exception 'FAIL case 7: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case 7%' then raise; end if;
  end;

  -- ---- case 8: a company in a JOINED foreign tenant is refused -------------
  -- An unprovisioned tenant is the one crossing a firm admin may make (#251,
  -- `invite_tenant_crossing.sql` pins it). v_other_tenant has an active user, so
  -- it is provisioned and the crossing must stay refused.
  begin
    v_result := create_invite(v_admin, 'c8@other.dev', v_foreign, 'member', v_digest, null, null, null, 0);
    raise exception 'FAIL case 8: firm admin reached across a tenant boundary';
  exception
    when others then
      if sqlerrm not like '%tenant_mismatch%' and sqlerrm not like '%FAIL case 8%' then
        raise exception 'FAIL case 8: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case 8%' then raise; end if;
  end;

  -- ---- case 9: seat shape must match the party relationship ---------------
  begin
    v_result := create_invite(v_admin, 'c9@target.dev', v_seller, 'member', v_digest, null, v_deal, 'buyer', 0);
    raise exception 'FAIL case 9: a target-side company took a buyer seat';
  exception
    when others then
      if sqlerrm not like '%invalid_deal_role%' and sqlerrm not like '%FAIL case 9%' then
        raise exception 'FAIL case 9: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case 9%' then raise; end if;
  end;

  -- ---- case 10: an internal seat is pinned to phase 0 ---------------------
  -- Phase gates external users only, so a requested phase on a bank seat is
  -- coerced rather than honoured.
  v_result := create_invite(v_bank_director, 'c10@bank.dev', v_bank, 'member', v_digest, null, v_deal, 'deal_team', 4);
  select * into v_row from invites where id = (v_result->>'id')::uuid;
  if v_row.phase <> 0 then
    raise exception 'FAIL case 10: internal seat stored phase %', v_row.phase;
  end if;

  -- ---- case 11: a negative phase is refused -------------------------------
  begin
    v_result := create_invite(v_admin, 'c11@target.dev', v_seller, 'member', v_digest, null, v_deal, 'seller', -1);
    raise exception 'FAIL case 11: a negative phase was accepted';
  exception
    when others then
      if sqlerrm not like '%invalid_phase%' and sqlerrm not like '%FAIL case 11%' then
        raise exception 'FAIL case 11: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case 11%' then raise; end if;
  end;

  -- ---- case R: a member who holds the permission through a ROLE may invite --
  -- Authority is the permission system, not the can_invite projection: this
  -- member has no direct grant, so the projection is false.
  if (select can_invite from users where id = v_role_member) then
    raise exception 'FAIL setup R: the role member unexpectedly carries the projection';
  end if;
  v_result := create_invite(v_role_member, 'r1@bank.dev', v_bank, 'member', v_digest, null, null, null, 0);
  select * into v_row from invites where id = (v_result->>'id')::uuid;
  if v_row.company_role <> 'member' or v_row.invited_by <> v_role_member then
    raise exception 'FAIL case R: role-held invite resolved to % by %', v_row.company_role, v_row.invited_by;
  end if;

  -- ---- case X: an external CLIENT director invites into their own company ----
  v_result := create_invite(v_client_director, 'x1@client.dev', v_client, 'member', v_digest, null, null, null, 0);
  select * into v_row from invites where id = (v_result->>'id')::uuid;
  if v_row.company_role <> 'member' or v_row.company_id <> v_client then
    raise exception 'FAIL case X: client director invite resolved to % in %', v_row.company_role, v_row.company_id;
  end if;

  -- ---- case S: a suspended delegate is refused, whatever the projection says ---
  if not (select can_invite from users where id = v_susp_delegate) then
    raise exception 'FAIL setup S: the suspended delegate lost the projection';
  end if;
  begin
    v_result := create_invite(v_susp_delegate, 's1@bank.dev', v_bank, 'member', v_digest, null, null, null, 0);
    raise exception 'FAIL case S: a suspended delegate issued an invite';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case S%' then
        raise exception 'FAIL case S: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case S%' then raise; end if;
  end;

  -- ---- case SD: a suspended director is refused ------------------------------
  begin
    v_result := create_invite(v_susp_director, 'sd1@bank.dev', v_bank, 'member', v_digest, null, null, null, 0);
    raise exception 'FAIL case SD: a suspended director issued an invite';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case SD%' then
        raise exception 'FAIL case SD: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case SD%' then raise; end if;
  end;

  -- ---- case SA: a suspended firm admin is refused ----------------------------
  begin
    v_result := create_invite(v_susp_admin, 'sa1@bank.dev', v_bank, 'member', v_digest, null, null, null, 0);
    raise exception 'FAIL case SA: a suspended firm admin issued an invite';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case SA%' then
        raise exception 'FAIL case SA: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case SA%' then raise; end if;
  end;

  -- ---- case X-deal (pin): an external director may not attach a deal their
  -- own company is not a party to ------------------------------------------------
  begin
    v_result := create_invite(v_nonparty_director, 'xd1@bystander.dev', v_nonparty, 'member', v_digest, null, v_deal, 'seller', 0);
    raise exception 'FAIL case X-deal: an external director attached a deal their company is not a party to';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case X-deal%' then
        raise exception 'FAIL case X-deal: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case X-deal%' then raise; end if;
  end;

  -- ---- case X-nonclient (pin): a deal-less external invite is for CLIENT
  -- companies only; an external director of a target company gets none ----------
  begin
    v_result := create_invite(v_seller_director, 'xn1@target.dev', v_seller, 'member', v_digest, null, null, null, 0);
    raise exception 'FAIL case X-nonclient: a target-company director issued a deal-less invite';
  exception
    when others then
      if sqlerrm not like '%not_permitted%' and sqlerrm not like '%FAIL case X-nonclient%' then
        raise exception 'FAIL case X-nonclient: refused with unexpected error %', sqlerrm;
      end if;
      if sqlerrm like '%FAIL case X-nonclient%' then raise; end if;
  end;

  -- ---- live bodies: a later redefinition cannot silently drop the restore ----
  -- The text guard (tests/invite-authority-migration.test.ts) reads the lexically
  -- latest migration; this reads what the database actually runs.
  v_fn := 'public.create_invite(uuid,text,uuid,text,text,uuid,uuid,text,integer,text)';
  if to_regprocedure(v_fn) is null then raise exception 'FAIL live body: % is missing', v_fn; end if;
  v_body := pg_get_functiondef(to_regprocedure(v_fn));
  if v_body !~ 'app_company_effective_permissions\(' or position('''company:invites:send''' in v_body) = 0 then
    raise exception 'FAIL live body: create_invite does not read the permission resolver';
  end if;
  if v_body ~ '\.can_invite' then
    raise exception 'FAIL live body: create_invite decides authority from the can_invite projection';
  end if;
  if position('v_company_type = ''client''' in v_body) = 0 then
    raise exception 'FAIL live body: create_invite lost the client deal-less branch';
  end if;
  if position('v_actor.status = ''active''' in v_body) = 0 then
    raise exception 'FAIL live body: create_invite lost the actor-active gate';
  end if;
  if position('pg_advisory_xact_lock_shared' in v_body) = 0 then
    raise exception 'FAIL live body: create_invite does not take the shared access lock';
  end if;

  v_fn := 'public.app_invite_seat_authorized(public.invites)';
  if to_regprocedure(v_fn) is null then raise exception 'FAIL live body: % is missing', v_fn; end if;
  v_body := pg_get_functiondef(to_regprocedure(v_fn));
  if v_body !~ 'app_company_effective_permissions\(' or position('''company:invites:send''' in v_body) = 0 then
    raise exception 'FAIL live body: the seat helper does not read the permission resolver';
  end if;
  if v_body ~ '\.can_invite' then
    raise exception 'FAIL live body: the seat helper decides authority from the can_invite projection';
  end if;
  if position('v_company_type = ''client''' in v_body) = 0 then
    raise exception 'FAIL live body: the seat helper lost the client deal-less branch';
  end if;
  if position('v_inviter.status = ''active''' in v_body) = 0 then
    raise exception 'FAIL live body: the seat helper lost the inviter-active check';
  end if;
  if position('pg_advisory_xact_lock_shared' in v_body) = 0 then
    raise exception 'FAIL live body: the seat helper does not take the shared access lock';
  end if;

  -- The helper is internal: only the two definer acceptance functions call it,
  -- so no API role may execute it, and it pins its search_path.
  if has_function_privilege('anon', to_regprocedure(v_fn), 'execute')
     or has_function_privilege('authenticated', to_regprocedure(v_fn), 'execute') then
    raise exception 'FAIL live body: the seat helper is executable by an API role';
  end if;
  if not coalesce((select 'search_path=public, pg_temp' = any(proconfig) from pg_proc
                    where oid = to_regprocedure(v_fn)), false) then
    raise exception 'FAIL live body: the seat helper does not pin search_path=public, pg_temp';
  end if;

  v_fn := 'public.accept_work_identity_invite(uuid,text,text,text)';
  if to_regprocedure(v_fn) is null then raise exception 'FAIL live body: % is missing', v_fn; end if;
  v_body := pg_get_functiondef(to_regprocedure(v_fn));
  if position('app_invite_seat_authorized(' in v_body) = 0 then
    raise exception 'FAIL live body: accept_work_identity_invite does not call the seat helper';
  end if;
  if v_body ~ '\.can_invite' then
    raise exception 'FAIL live body: accept_work_identity_invite decides authority from the can_invite projection';
  end if;

  v_fn := 'public.accept_invite(uuid,uuid,text,text,text)';
  if to_regprocedure(v_fn) is null then raise exception 'FAIL live body: % is missing', v_fn; end if;
  v_body := pg_get_functiondef(to_regprocedure(v_fn));
  if position('app_invite_seat_authorized(' in v_body) = 0 then
    raise exception 'FAIL live body: accept_invite does not call the seat helper';
  end if;

  -- ---- case 12: a refused send leaves nothing behind ----------------------
  if exists (select 1 from invites where email in ('c3@target.dev', 'c4@bank.dev', 'c7@bank.dev', 'c8@other.dev', 'c9@target.dev', 'c11@target.dev',
                              's1@bank.dev', 'sd1@bank.dev', 'sa1@bank.dev', 'xd1@bystander.dev', 'xn1@target.dev')) then
    raise exception 'FAIL case 12: a refused invitation was persisted';
  end if;

  raise notice 'PASS: invite authority parity (12 cases, R, X, S, SD, SA, X-deal, X-nonclient, live bodies)';
end $$;

rollback;
