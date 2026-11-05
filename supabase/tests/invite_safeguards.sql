-- Transactional probe for invite domain confirmation, challenge rotation,
-- recipient verification, lockout, and acceptance invariants.
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invite_safeguards.sql

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
  v_company uuid := gen_random_uuid();
  v_other_company uuid := gen_random_uuid();
  v_role text;
  v_deal uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_recipient uuid := gen_random_uuid();
  v_legacy_recipient uuid := gen_random_uuid();
  v_confirmation uuid;
  v_stale_confirmation uuid;
  v_invite uuid;
  v_legacy_invite uuid;
  v_nonce uuid;
  v_old_nonce uuid;
  v_result jsonb;
  v_count integer;
  v_blocked boolean;
  v_digest_a text := repeat('a', 64);
  v_digest_b text := repeat('b', 64);
  v_digest_c text := repeat('c', 64);
  v_wrong_digest text := repeat('f', 64);
begin
  insert into auth.users (id, email, raw_user_meta_data) values (
    v_actor,
    'invite-guard-actor@example.test',
    jsonb_build_object('full_name','Invite Guard Actor','department','ib','tenant_id',v_tenant)
  );
  insert into companies (id, tenant_id, name, type)
    values (v_company, v_tenant, 'Invite Guard Bank ' || v_company::text, 'bank');
  update users
     set company_id = v_company, company_role = 'director', status = 'active'
   where id = v_actor;
  insert into company_verified_domains (company_id, domain, source)
    values (v_company, 'futureproofing.com', 'database_test');
  insert into deals (id, tenant_id, code, codename, bank_id, mandate_owner_id)
    values (v_deal, v_tenant, 'IG-' || left(v_deal::text, 8), 'Project Invite Guard', v_company, v_actor);

  -- A mismatch confirmation is bound to actor/email/company/deal/domain-set,
  -- consumed in the same transaction as the invite, and cannot be replayed.
  insert into invite_domain_confirmations (
    actor_id, email, company_id, company_role, classification
  ) values (v_actor, 'outside@external.example', v_company, 'member', 'mismatch')
    returning id into v_confirmation;

  v_result := create_invite(
    p_actor => v_actor,
    p_email => 'outside@external.example',
    p_company_id => v_company,
    p_company_role => 'member',
    p_challenge_digest => v_digest_a,
    p_domain_confirmation_id => v_confirmation
  );
  v_invite := (v_result->>'id')::uuid;
  if coalesce((v_result->>'duplicate')::boolean, true) then
    raise exception 'FAIL: confirmed mismatch was not created';
  end if;
  select count(*) into v_count
    from invite_domain_confirmations
   where id = v_confirmation and consumed_at is not null and consumed_invite_id = v_invite;
  if v_count <> 1 then raise exception 'FAIL: mismatch confirmation was not atomically consumed'; end if;

  perform revoke_invite(v_invite, v_actor);
  v_blocked := false;
  begin
    perform create_invite(
      p_actor => v_actor,
      p_email => 'outside@external.example',
      p_company_id => v_company,
      p_company_role => 'member',
      p_challenge_digest => v_digest_b,
      p_domain_confirmation_id => v_confirmation
    );
  exception when others then
    v_blocked := sqlerrm = 'domain_confirmation_invalid';
  end;
  if not v_blocked then raise exception 'FAIL: consumed confirmation was reusable'; end if;

  -- A domain-reference mutation invalidates a still-live confirmation.
  insert into invite_domain_confirmations (
    actor_id, email, company_id, company_role, classification
  ) values (v_actor, 'stale@external.example', v_company, 'member', 'mismatch')
    returning id into v_stale_confirmation;
  insert into company_verified_domains (company_id, domain, source)
    values (v_company, 'newly-verified.example', 'database_test');
  v_blocked := false;
  begin
    perform create_invite(
      p_actor => v_actor,
      p_email => 'stale@external.example',
      p_company_id => v_company,
      p_company_role => 'member',
      p_challenge_digest => v_digest_a,
      p_domain_confirmation_id => v_stale_confirmation
    );
  exception when others then
    v_blocked := sqlerrm = 'domain_confirmation_stale';
  end;
  if not v_blocked then raise exception 'FAIL: stale domain snapshot was accepted'; end if;

  -- Verified company-domain invite needs no override token. A sequential retry
  -- returns the one pending invite and never replaces its challenge digest.
  v_result := create_invite(
    p_actor => v_actor,
    p_email => 'recipient@futureproofing.com',
    p_company_id => v_company,
    p_company_role => 'member',
    p_challenge_digest => v_digest_a,
    p_deal_id => v_deal,
    p_deal_role => 'deal_team'
  );
  v_invite := (v_result->>'id')::uuid;
  v_nonce := (v_result->>'credential_nonce')::uuid;
  v_result := create_invite(
    p_actor => v_actor,
    p_email => 'recipient@futureproofing.com',
    p_company_id => v_company,
    p_company_role => 'member',
    p_challenge_digest => v_digest_b,
    p_deal_id => v_deal,
    p_deal_role => 'deal_team'
  );
  if not coalesce((v_result->>'duplicate')::boolean, false) then
    raise exception 'FAIL: repeated create did not return duplicate';
  end if;
  select count(*) into v_count from invites
   where email = 'recipient@futureproofing.com' and status = 'pending' and challenge_digest = v_digest_a;
  if v_count <> 1 then raise exception 'FAIL: duplicate create mutated or duplicated challenge state'; end if;

  perform finalize_invite_delivery(v_invite);
  insert into auth.users (id, email, raw_user_meta_data) values (
    v_recipient,
    'recipient@futureproofing.com',
    jsonb_build_object('full_name','Invite Guard Recipient','department','ib','tenant_id',v_tenant)
  );
  update users set status = 'invited' where id = v_recipient;
  perform set_config('request.jwt.claims', json_build_object('sub', v_recipient, 'session_id', v_recipient)::text, true);

  -- Exactly five wrong attempts lock the challenge and do not grant access.
  for v_count in 1..5 loop
    v_result := verify_invite_challenge(v_invite, v_nonce, v_wrong_digest);
    if (v_result->>'attempts_remaining')::integer <> 5 - v_count then
      raise exception 'FAIL: wrong remaining-attempt count at attempt %', v_count;
    end if;
  end loop;
  select count(*) into v_count from invites
   where id = v_invite and challenge_attempts = 5 and challenge_locked_at is not null;
  if v_count <> 1 then raise exception 'FAIL: fifth failed attempt did not lock'; end if;
  if exists (select 1 from deal_memberships where deal_id = v_deal and user_id = v_recipient) then
    raise exception 'FAIL: verification failure granted membership';
  end if;

  -- Resend is the only recovery: it rotates link + digest + version and clears
  -- both lock and verification. The old link loses the accept/verify race.
  v_old_nonce := v_nonce;
  v_result := rotate_invite_credential(v_invite, v_digest_b);
  v_nonce := (v_result->>'credential_nonce')::uuid;
  perform finalize_invite_delivery(v_invite);
  v_blocked := false;
  begin
    perform verify_invite_challenge(v_invite, v_old_nonce, v_digest_b);
  exception when others then
    v_blocked := sqlerrm = 'credential_mismatch';
  end;
  if not v_blocked then raise exception 'FAIL: stale link survived resend'; end if;
  v_result := verify_invite_challenge(v_invite, v_nonce, v_digest_b);
  if not (v_result->>'verified')::boolean then raise exception 'FAIL: correct challenge did not verify'; end if;

  -- A resend that wins after verification invalidates the verified version;
  -- acceptance remains all-or-nothing until the new challenge verifies.
  v_result := rotate_invite_credential(v_invite, v_digest_c);
  v_nonce := (v_result->>'credential_nonce')::uuid;
  perform finalize_invite_delivery(v_invite);
  v_blocked := false;
  begin
    perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
  exception when others then
    v_blocked := sqlerrm = 'invite_not_verified';
  end;
  if not v_blocked then raise exception 'FAIL: resend/accept race bypassed current verification'; end if;
  if exists (select 1 from deal_memberships where deal_id = v_deal and user_id = v_recipient) then
    raise exception 'FAIL: failed acceptance partially granted membership';
  end if;

  perform verify_invite_challenge(v_invite, v_nonce, v_digest_c);

  -- #408: an email-code invitation never moves an active user to another firm.
  insert into companies (id, tenant_id, name, type)
    values (v_other_company, v_tenant, 'Invite Guard Client ' || v_other_company::text, 'client');
  select company_role into v_role from users where id = v_recipient;
  update users set status = 'active', company_id = v_other_company, company_role = 'director' where id = v_recipient;
  v_blocked := false;
  begin
    perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
  exception when others then
    v_blocked := sqlerrm = 'invite_other_firm';
  end;
  if not v_blocked then raise exception 'FAIL #408: email-code accept moved an active user to another firm'; end if;
  if (select company_id from users where id = v_recipient) <> v_other_company
     or (select status from invites where id = v_invite) <> 'pending' then
    raise exception 'FAIL #408: the refused email-code accept changed the user or the invitation';
  end if;
  update users set status = 'invited', company_id = null, company_role = v_role where id = v_recipient;

  perform accept_invite(v_invite, v_nonce, 'fixture-password-1', 'tos-test', null);
  select count(*) into v_count from deal_memberships
   where deal_id = v_deal and user_id = v_recipient and deal_role = 'deal_team';
  if v_count <> 1 then raise exception 'FAIL: verified acceptance did not grant exactly one membership'; end if;
  select count(*) into v_count from users
   where id = v_recipient and status = 'active' and company_id = v_company;
  if v_count <> 1 then raise exception 'FAIL: verified acceptance did not activate the user atomically'; end if;

  -- Legacy pending rows fail closed until resend provisions version 1.
  insert into invites (
    tenant_id, email, invited_by, company_id, company_role, delivery_status
  ) values (
    v_tenant, 'legacy@futureproofing.com', v_actor, v_company, 'member', 'sent'
  ) returning id, credential_nonce into v_legacy_invite, v_nonce;
  insert into auth.users (id, email, raw_user_meta_data) values (
    v_legacy_recipient,
    'legacy@futureproofing.com',
    jsonb_build_object('full_name','Legacy Invite Recipient','department','ib','tenant_id',v_tenant)
  );
  update users set status = 'invited' where id = v_legacy_recipient;
  perform set_config('request.jwt.claims', json_build_object('sub', v_legacy_recipient, 'session_id', v_legacy_recipient)::text, true);
  v_blocked := false;
  begin
    perform verify_invite_challenge(v_legacy_invite, v_nonce, v_digest_a);
  exception when others then
    v_blocked := sqlerrm = 'challenge_unavailable';
  end;
  if not v_blocked then raise exception 'FAIL: legacy row did not fail closed'; end if;
  v_result := rotate_invite_credential(v_legacy_invite, v_digest_a);
  v_nonce := (v_result->>'credential_nonce')::uuid;
  if (v_result->>'challenge_version')::integer <> 1 then
    raise exception 'FAIL: legacy resend did not provision challenge version 1';
  end if;

  -- Audit/return surfaces contain lifecycle metadata, never digests or codes.
  select count(*) into v_count from audit_log
   where detail::text like '%' || v_digest_a || '%'
      or detail::text like '%' || v_digest_b || '%'
      or detail::text like '%' || v_digest_c || '%'
      or detail::text like '%123456%';
  if v_count <> 0 then raise exception 'FAIL: challenge secret leaked into audit detail'; end if;

  raise notice 'PASS: invite confirmations are bound/one-use/stale-safe; duplicate create preserves one challenge; fifth failure locks; resend invalidates links and verification; legacy rows fail closed; verified accept grants atomically; audits contain no secrets';
end $$;

rollback;
