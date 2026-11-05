-- Acceptance grants the phase the inviter confirmed, and the gates that stood
-- before this change still stand.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invite_phase_accept.sql
--
-- accept_invite is the function this work modifies, and it is also where
-- verification, credential and tenant checks live. Changing its grant line
-- must not soften any of them, so the probe asserts an unverified acceptance
-- is still refused BEFORE asserting the phase is granted. Order matters: if
-- the refusal stopped working, a passing phase assertion would be worthless.

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
  v_bank uuid := gen_random_uuid();
  v_seller uuid := gen_random_uuid();
  v_deal uuid := gen_random_uuid();
  v_md uuid := gen_random_uuid();
  v_invitee uuid := gen_random_uuid();
  v_seller_dir uuid := gen_random_uuid();
  v_digest text := repeat('b', 64);
  v_invite uuid;
  v_nonce uuid;
  v_result jsonb;
  v_phase int;
  v_audit jsonb;
  v_refused boolean := false;
begin
  insert into companies (id, tenant_id, name, type)
  values (v_bank, v_tenant, 'Advisory Bank', 'bank'),
         (v_seller, v_tenant, 'Target Co', 'target');

  insert into deals (id, tenant_id, code, codename, status, bank_id)
  values (v_deal, v_tenant, 'ACCEPT-1', 'Project Accept', 'active', v_bank);

  insert into deal_parties (deal_id, company_id, party_role)
  values (v_deal, v_seller, 'target');

  insert into company_verified_domains (tenant_id, company_id, domain, source)
  values (v_tenant, v_seller, 'target.dev', 'test');

  insert into auth.users (id, email) values
    (v_md, 'md@bank.dev'),
    (v_seller_dir, 'dir@target.dev'),
    (v_invitee, 'invitee@target.dev');

  -- The auth mirror already created these rows; a company needs its director
  -- before it can take a member.
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'director',
                   is_external = false, firm_role = 'admin', status = 'active'
   where id = v_md;
  -- The seller company needs an active director before it can take a member,
  -- which is what the invitee becomes at acceptance.
  update users set tenant_id = v_tenant, company_id = v_seller, company_role = 'director',
                   is_external = true, status = 'active'
   where id = v_seller_dir;
  update users set tenant_id = v_tenant, status = 'invited' where id = v_invitee;

  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
  select v_deal, v_md, id, 'md', 0, v_md from roles where slug = 'md' limit 1;

  -- An invitation carrying a confirmed phase of 2.
  v_result := create_invite(v_md, 'invitee@target.dev', v_seller, 'member', v_digest,
                            null, v_deal, 'seller', 2);
  v_invite := (v_result->>'id')::uuid;
  select credential_nonce into v_nonce from invites where id = v_invite;

  -- ---- gate first: acceptance without verification is still refused --------
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_invitee::text, 'session_id', v_invitee::text)::text, true);
  begin
    perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
  exception when others then
    if sqlerrm not like '%invite_not_verified%' then
      raise exception 'FAIL gate: unverified acceptance refused with %', sqlerrm;
    end if;
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL gate: an unverified invitation was accepted';
  end if;

  -- ---- then the phase ------------------------------------------------------
  update invites
     set delivery_status = 'sent',
         challenge_verified_at = now(),
         challenge_verified_user_id = v_invitee,
         challenge_verified_version = challenge_version,
         challenge_verified_session_id = v_invitee
   where id = v_invite;

  perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);

  select phase into v_phase from deal_memberships
   where deal_id = v_deal and user_id = v_invitee;
  if v_phase is distinct from 2 then
    raise exception 'FAIL: accepted seat landed on phase % instead of the confirmed 2', v_phase;
  end if;

  select detail into v_audit from audit_log
   where deal_id = v_deal and action = 'grant' and detail->>'via' = 'invite'
   order by ts desc limit 1;
  if (v_audit->>'phase')::int is distinct from 2 then
    raise exception 'FAIL: grant audited phase % instead of the confirmed 2', v_audit->>'phase';
  end if;

  raise notice 'PASS: acceptance grants the confirmed phase, verification gate intact';
end $$;

-- ---------------------------------------------------------------------------
-- #296 (design Q12): an email-code invite is only as good as its inviter's
-- authority AT ACCEPTANCE. accept_invite re-derives the seat the same way
-- accept_work_identity_invite does, so a pending invite dies when its inviter
-- is suspended (SI) or loses the permission the invite was issued under (RV).
-- ---------------------------------------------------------------------------
do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_director uuid := gen_random_uuid();
  v_delegate uuid := gen_random_uuid();
  v_si_invitee uuid := gen_random_uuid();
  v_rv_invitee uuid := gen_random_uuid();
  v_ok_invitee uuid := gen_random_uuid();
  v_digest text := repeat('c', 64);
  v_result jsonb;
  v_invite uuid;
  v_nonce uuid;
begin
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'Seat Bank', 'bank');
  insert into company_verified_domains (tenant_id, company_id, domain, source)
  values (v_tenant, v_bank, 'seat.dev', 'test');

  insert into auth.users (id, email) values
    (v_admin, 'admin@seat.dev'), (v_director, 'dir@seat.dev'), (v_delegate, 'delegate@seat.dev'),
    (v_si_invitee, 'si@seat.dev'), (v_rv_invitee, 'rv@seat.dev'), (v_ok_invitee, 'ok@seat.dev');

  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'director',
                   is_external = false, firm_role = 'admin', status = 'active'
   where id = v_admin;
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'director',
                   is_external = false, firm_role = null, status = 'active'
   where id = v_director;
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'member',
                   is_external = false, firm_role = null, status = 'active'
   where id = v_delegate;
  update users set tenant_id = v_tenant, status = 'invited'
   where id in (v_si_invitee, v_rv_invitee, v_ok_invitee);

  -- The delegate holds the permission directly. The projection trigger sets
  -- users.can_invite, which acceptance no longer reads.
  insert into company_member_access (company_id, user_id) values (v_bank, v_delegate);
  insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
  values (v_bank, v_delegate, 'company:invites:send', v_admin);

  -- ---- SI: the issuing director is suspended before acceptance ---------------
  v_result := create_invite(v_director, 'si@seat.dev', v_bank, 'member', v_digest);
  v_invite := (v_result->>'id')::uuid;
  select credential_nonce into v_nonce from invites where id = v_invite;
  update invites
     set delivery_status = 'sent', challenge_verified_at = now(),
         challenge_verified_user_id = v_si_invitee, challenge_verified_version = challenge_version,
         challenge_verified_session_id = v_si_invitee
   where id = v_invite;
  update users set status = 'suspended' where id = v_director;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_si_invitee::text, 'session_id', v_si_invitee::text)::text, true);
  begin
    perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
    raise exception 'FAIL SI: an invite from a suspended inviter was accepted';
  exception when others then
    if sqlerrm like 'FAIL SI%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL SI: refused with unexpected error %', sqlerrm;
    end if;
  end;
  if (select status from invites where id = v_invite) <> 'pending'
     or (select status from users where id = v_si_invitee) <> 'invited' then
    raise exception 'FAIL SI: a refused acceptance changed the invite or the profile';
  end if;

  -- ---- RV: a delegate stays active but its grant is revoked -------------------
  v_result := create_invite(v_delegate, 'rv@seat.dev', v_bank, 'member', v_digest);
  v_invite := (v_result->>'id')::uuid;
  select credential_nonce into v_nonce from invites where id = v_invite;
  update invites
     set delivery_status = 'sent', challenge_verified_at = now(),
         challenge_verified_user_id = v_rv_invitee, challenge_verified_version = challenge_version,
         challenge_verified_session_id = v_rv_invitee
   where id = v_invite;
  delete from company_member_permissions
   where company_id = v_bank and user_id = v_delegate and permission_key = 'company:invites:send';
  if (select status from users where id = v_delegate) <> 'active' then
    raise exception 'FAIL RV setup: the delegate is no longer active';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rv_invitee::text, 'session_id', v_rv_invitee::text)::text, true);
  begin
    perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
    raise exception 'FAIL RV: an invite whose inviter lost the permission was accepted';
  exception when others then
    if sqlerrm like 'FAIL RV%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL RV: refused with unexpected error %', sqlerrm;
    end if;
  end;
  if (select status from invites where id = v_invite) <> 'pending' then
    raise exception 'FAIL RV: a refused acceptance consumed the invite';
  end if;

  -- ---- control: an invite from an inviter who still has authority accepts ----
  v_result := create_invite(v_admin, 'ok@seat.dev', v_bank, 'member', v_digest);
  v_invite := (v_result->>'id')::uuid;
  select credential_nonce into v_nonce from invites where id = v_invite;
  update invites
     set delivery_status = 'sent', challenge_verified_at = now(),
         challenge_verified_user_id = v_ok_invitee, challenge_verified_version = challenge_version,
         challenge_verified_session_id = v_ok_invitee
   where id = v_invite;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ok_invitee::text, 'session_id', v_ok_invitee::text)::text, true);
  perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
  if (select status from invites where id = v_invite) <> 'accepted' then
    raise exception 'FAIL control: an invite from an active, authorized inviter was not accepted';
  end if;

  raise notice 'PASS: email-code acceptance re-derives the inviter seat (SI, RV, control)';
end $$;

-- ---------------------------------------------------------------------------
-- #296 provisioning crossing at acceptance. A firm admin may invite across a
-- tenant boundary only while the target tenant is unprovisioned, and
-- create_invite records that decision on the invite (provisioning_crossing).
-- Acceptance honours the recorded decision rather than re-asking, so BOTH
-- bootstrap invitations accept even though the first acceptance provisions
-- the tenant. Once it is provisioned the admin can issue no new crossing, and a
-- pending crossing that carries no recorded decision (a legacy row, issued
-- when 20260915120000 let an admin cross into a provisioned tenant) is refused.
-- So is a recorded crossing whose stored tenant is not the company's.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin_tenant uuid := gen_random_uuid();
  v_new_tenant uuid := gen_random_uuid();
  v_new_bank uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_first uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_late uuid := gen_random_uuid();
  v_legacy uuid := gen_random_uuid();
  v_stray uuid := gen_random_uuid();
  v_stray_tenant uuid := gen_random_uuid();
  v_digest text := repeat('d', 64);
  v_confirmation uuid;
  v_result jsonb;
  v_first_invite uuid;
  v_second_invite uuid;
  v_legacy_invite uuid;
  v_stray_invite uuid;
  v_nonce uuid;
begin
  insert into companies (id, tenant_id, name, type)
  values (v_new_bank, v_new_tenant, 'Crossing Accept Bank ' || v_new_bank::text, 'bank');

  insert into auth.users (id, email) values
    (v_admin, 'bootstrap-admin@crossing-accept.dev'),
    (v_first, 'first@crossing-accept.dev'),
    (v_second, 'second@crossing-accept.dev'),
    (v_late, 'late@crossing-accept.dev'),
    (v_legacy, 'legacy@crossing-accept.dev'),
    (v_stray, 'stray@crossing-accept.dev');

  -- The admin has no company on purpose: the company director invariant stays
  -- out of the way, as in invite_tenant_crossing.sql.
  update users set tenant_id = v_admin_tenant, firm_role = 'admin', status = 'active'
   where id = v_admin;
  update users set tenant_id = v_new_tenant, status = 'invited'
   where id in (v_first, v_second, v_late, v_legacy);

  -- The admin issues both invites while the new tenant is unprovisioned.
  insert into invite_domain_confirmations (actor_id, email, company_id, company_role, classification)
  values (v_admin, 'first@crossing-accept.dev', v_new_bank, 'director', 'mismatch')
  returning id into v_confirmation;
  v_result := create_invite(v_admin, 'first@crossing-accept.dev', v_new_bank, 'director', v_digest, v_confirmation);
  v_first_invite := (v_result->>'id')::uuid;

  insert into invite_domain_confirmations (actor_id, email, company_id, company_role, classification)
  values (v_admin, 'second@crossing-accept.dev', v_new_bank, 'director', 'mismatch')
  returning id into v_confirmation;
  v_result := create_invite(v_admin, 'second@crossing-accept.dev', v_new_bank, 'director', v_digest, v_confirmation);
  v_second_invite := (v_result->>'id')::uuid;

  if (select count(*) from invites
       where id in (v_first_invite, v_second_invite)
         and provisioning_crossing and tenant_id = v_new_tenant) <> 2 then
    raise exception 'FAIL crossing: create_invite did not record the provisioning crossing on both invites';
  end if;

  -- The flag is fixed at issue: not even the server can flip it afterwards.
  begin
    update invites set provisioning_crossing = false where id = v_first_invite;
    raise exception 'FAIL crossing: provisioning_crossing was changed after insert';
  exception when others then
    if sqlerrm like 'FAIL crossing%' then raise; end if;
    if sqlerrm <> 'provisioning_crossing_immutable' then
      raise exception 'FAIL crossing: flipping the flag failed with unexpected error %', sqlerrm;
    end if;
  end;

  update invites
     set delivery_status = 'sent', challenge_verified_at = now(),
         challenge_verified_user_id = case id when v_first_invite then v_first else v_second end,
         challenge_verified_version = challenge_version,
         challenge_verified_session_id = case id when v_first_invite then v_first else v_second end
   where id in (v_first_invite, v_second_invite);

  -- (c) A recorded crossing whose stored tenant is not the company's is
  -- refused, even while the target is still unprovisioned. Inserted directly
  -- as the service role would; the invitee lives in the stored tenant so the
  -- invitee-tenant check passes and only the seat helper can refuse it. A
  -- director seat, so nothing after the helper (the director invariant on a
  -- company with none yet) can refuse it instead.
  update users set tenant_id = v_stray_tenant, status = 'invited' where id = v_stray;
  insert into invites (tenant_id, email, invited_by, company_id, company_role,
                       challenge_digest, challenge_version, challenge_issued_at, auth_method,
                       provisioning_crossing, delivery_status, challenge_verified_at,
                       challenge_verified_user_id, challenge_verified_version,
                       challenge_verified_session_id)
  values (v_stray_tenant, 'stray@crossing-accept.dev', v_admin, v_new_bank, 'director',
          v_digest, 1, now(), 'email_code', true, 'sent', now(), v_stray, 1, v_stray)
  returning id, credential_nonce into v_stray_invite, v_nonce;
  if not public.tenant_is_unprovisioned(v_new_tenant) then
    raise exception 'FAIL crossing (c) setup: the target tenant is already provisioned';
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_stray::text, 'session_id', v_stray::text)::text, true);
  begin
    perform accept_invite(v_stray_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
    raise exception 'FAIL crossing (c): a recorded crossing stored under another tenant was accepted';
  exception when others then
    if sqlerrm like 'FAIL crossing%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL crossing (c): refused with unexpected error %', sqlerrm;
    end if;
  end;
  if (select status from invites where id = v_stray_invite) <> 'pending'
     or (select status from users where id = v_stray) <> 'invited' then
    raise exception 'FAIL crossing (c): a refused acceptance changed the invite or the profile';
  end if;

  -- The first acceptance crosses the boundary and provisions the tenant.
  select credential_nonce into v_nonce from invites where id = v_first_invite;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_first::text, 'session_id', v_first::text)::text, true);
  perform accept_invite(v_first_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
  if (select status from invites where id = v_first_invite) <> 'accepted'
     or (select status from users where id = v_first) <> 'active' then
    raise exception 'FAIL crossing: the first invite into an unprovisioned tenant was not accepted';
  end if;
  if public.tenant_is_unprovisioned(v_new_tenant) then
    raise exception 'FAIL crossing setup: the first acceptance did not provision the tenant';
  end if;

  -- The tenant is now provisioned, and the second invite still accepts: it
  -- was issued while the crossing was allowed.
  select credential_nonce into v_nonce from invites where id = v_second_invite;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_second::text, 'session_id', v_second::text)::text, true);
  perform accept_invite(v_second_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
  if (select status from invites where id = v_second_invite) <> 'accepted'
     or (select status from users where id = v_second) <> 'active'
     or (select tenant_id from users where id = v_second) <> v_new_tenant then
    raise exception 'FAIL crossing: the second bootstrap invite was not accepted after the tenant was provisioned';
  end if;

  -- (a) No NEW crossing once the tenant is provisioned. create_invite refuses
  -- at its tenant guard, before any domain check (preparing the domain
  -- confirmation is refused the same way).
  begin
    perform create_invite(v_admin, 'late@crossing-accept.dev', v_new_bank, 'member', v_digest);
    raise exception 'FAIL crossing (a): the admin issued a crossing invite into a provisioned tenant';
  exception when others then
    if sqlerrm like 'FAIL crossing%' then raise; end if;
    if sqlerrm <> 'tenant_mismatch' then
      raise exception 'FAIL crossing (a): refused with unexpected error %', sqlerrm;
    end if;
  end;

  -- (b) A legacy pending crossing (no recorded decision, inserted directly as
  -- the service role would have) is refused at acceptance, even though its
  -- tenant_id matches the company tenant.
  insert into invites (tenant_id, email, invited_by, company_id, company_role,
                       challenge_digest, challenge_version, challenge_issued_at, auth_method)
  values (v_new_tenant, 'legacy@crossing-accept.dev', v_admin, v_new_bank, 'member',
          v_digest, 1, now(), 'email_code')
  returning id, credential_nonce into v_legacy_invite, v_nonce;
  if (select provisioning_crossing from invites where id = v_legacy_invite) then
    raise exception 'FAIL crossing (b) setup: a directly inserted invite defaulted to a recorded crossing';
  end if;
  update invites
     set delivery_status = 'sent', challenge_verified_at = now(),
         challenge_verified_user_id = v_legacy, challenge_verified_version = challenge_version,
         challenge_verified_session_id = v_legacy
   where id = v_legacy_invite;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_legacy::text, 'session_id', v_legacy::text)::text, true);
  begin
    perform accept_invite(v_legacy_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
    raise exception 'FAIL crossing (b): a legacy crossing invite with no recorded decision was accepted';
  exception when others then
    if sqlerrm like 'FAIL crossing%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL crossing (b): refused with unexpected error %', sqlerrm;
    end if;
  end;
  if (select status from invites where id = v_legacy_invite) <> 'pending'
     or (select status from users where id = v_legacy) <> 'invited' then
    raise exception 'FAIL crossing (b): a refused acceptance changed the invite or the profile';
  end if;

  raise notice 'PASS: a recorded provisioning crossing survives provisioning; no new, legacy or mis-tenanted crossing does';
end $$;

rollback;
