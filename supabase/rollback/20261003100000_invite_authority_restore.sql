-- Rollback for 20261003100000_invite_authority_restore.sql (#296).
--
-- Restores the three invite functions to their 20261002100000 bodies verbatim
-- (create_invite and accept_work_identity_invite read the users.can_invite
-- projection again, create_invite has no actor-status gate and no external
-- client director deal-less branch, accept_invite no longer reads the inviter)
-- and drops app_invite_seat_authorized and invites.provisioning_crossing with
-- its immutability trigger.
--
-- It deliberately KEEPS the direct company:invites:send grants and their audit
-- rows the forward migration backfilled: they are real permission rows, the
-- projection trigger keeps users.can_invite true for them, and removing them
-- would silently take authority away from people who held it before the restore.
--
-- Applying this reopens what the restore closed (a suspended actor can issue an
-- invite and an email-code invite outlives its inviter), so use it only to
-- recover from a broken forward migration. Grants on the three functions are
-- unchanged: create or replace keeps them.

begin;

set local search_path = public;

create or replace function public.create_invite(p_actor uuid, p_email text, p_company_id uuid, p_company_role text, p_challenge_digest text, p_domain_confirmation_id uuid DEFAULT NULL::uuid, p_deal_id uuid DEFAULT NULL::uuid, p_deal_role text DEFAULT NULL::text, p_phase integer DEFAULT 0, p_auth_method text DEFAULT 'email_code'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_email text := lower(trim(p_email));
  v_email_domain text := split_part(lower(trim(p_email)), '@', 2);
  v_tenant uuid;
  v_company_tenant uuid;
  v_deal_tenant uuid;
  v_domain_snapshot text[];
  v_domain_classification text;
  v_domain_match boolean;
  v_existing record;
  v_confirmation invite_domain_confirmations%rowtype;
  v_invite invites%rowtype;
  v_actor users%rowtype;
  v_company_type text;
  v_is_external_company boolean;
  v_permitted boolean;
  v_can_manage_company boolean;
  v_can_manage_deal boolean;
  v_company_role text;
  v_party_role text;
  v_expected_role text;
  v_phase int;
begin
  -- Authority rows are read FOR SHARE in one fixed order (users -> companies
  -- -> deals -> deal_memberships -> deal_parties) so a revocation committing
  -- between check and insert blocks instead of racing, and so two concurrent
  -- senders cannot deadlock by taking the same locks in opposite orders.
  select * into v_actor from users where id = p_actor for share;
  if v_actor.id is null then raise exception 'actor_not_found'; end if;
  v_tenant := v_actor.tenant_id;

  -- #316: a work-identity invite carries no emailed code; the firm's
  -- identity provider proves the recipient instead.
  if p_auth_method is null or p_auth_method not in ('email_code', 'work_identity') then
    raise exception 'invalid_auth_method';
  end if;
  if p_auth_method = 'email_code'
     and (p_challenge_digest is null or p_challenge_digest !~ '^[0-9a-f]{64}$')
  then
    raise exception 'challenge_required';
  end if;
  if length(v_email) - length(replace(v_email, '@', '')) <> 1
     or split_part(v_email, '@', 1) = ''
     or v_email_domain = ''
     or v_email ~ '\s'
  then
    raise exception 'invalid_email';
  end if;

  select tenant_id, type into v_company_tenant, v_company_type
    from companies where id = p_company_id for share;
  if v_company_tenant is null then raise exception 'company_not_found'; end if;
  -- A firm admin provisioning a new organization acts in THAT organization's
  -- tenant, not their own. Platform operations lives in one tenant while every
  -- org it onboards now gets its own (#156), so the owner invite for a brand-new
  -- org would otherwise be unsendable. Everyone else stays pinned to their own
  -- tenant: this is the guard that stops one firm inviting into another's.
  if v_company_tenant is distinct from v_tenant then
    if coalesce(v_actor.firm_role = 'admin', false)
       and p_deal_id is null
       and public.tenant_is_unprovisioned(v_company_tenant)
    then
      v_tenant := v_company_tenant;
    else
      raise exception 'tenant_mismatch';
    end if;
  end if;
  v_is_external_company := v_company_type is distinct from 'bank';
  if p_auth_method = 'work_identity'
     and not exists (select 1 from firm_identity_providers where company_id = p_company_id for share)
  then
    raise exception 'identity_provider_not_configured';
  end if;

  if p_deal_id is not null then
    select tenant_id into v_deal_tenant from deals where id = p_deal_id for share;
    if v_deal_tenant is null then raise exception 'deal_not_found'; end if;
    if v_deal_tenant is distinct from v_tenant then raise exception 'tenant_mismatch'; end if;
  end if;

  -- Re-derive invitation authority and seat shape here, inside the write
  -- transaction. The route checks the same things for early feedback, but a
  -- director demotion or a party removal committing after that check and
  -- before this insert would otherwise be outrun. This block must stay in
  -- agreement with assessProposal in src/lib/api/v1/proposalFeasibility.ts;
  -- tests/db/invite-authority-parity.test.ts fails if the two disagree.
  -- Every authority expression is coalesced. `firm_role` and `company_role`
  -- are nullable, and in SQL `null = 'admin'` is NULL rather than false, so an
  -- uncoalesced disjunction yields NULL, `not NULL` is NULL, and a guard
  -- written as `if not v_x then raise` silently does not fire. That reads as
  -- permission. Three-valued logic must not decide access.
  v_can_manage_company := coalesce(v_actor.firm_role = 'admin', false)
    or coalesce(v_actor.company_role = 'director' and v_actor.company_id = p_company_id, false);

  if p_deal_id is not null then
    perform 1 from deal_memberships
      where deal_id = p_deal_id and user_id = p_actor for share;
    v_can_manage_deal := exists (
        select 1 from deal_memberships
         where deal_id = p_deal_id and user_id = p_actor and deal_role = 'md'
      )
      or coalesce(v_actor.company_role = 'director'
          and v_actor.company_id = (select bank_id from deals where id = p_deal_id), false)
      or coalesce((
        select (access_scope->>'can_manage_members')::boolean from deal_memberships
         where deal_id = p_deal_id and user_id = p_actor
      ), false);
  else
    v_can_manage_deal := false;
  end if;

  if coalesce(v_actor.firm_role = 'admin', false) then
    v_permitted := true;
  elsif v_actor.is_external then
    -- External directors grow their own team only, and only onto a deal their
    -- own company is a party to.
    v_permitted := coalesce(v_actor.company_role = 'director'
      and v_actor.company_id = p_company_id, false)
      and p_deal_id is not null
      and exists (
        select 1 from deal_parties
         where deal_id = p_deal_id and company_id = v_actor.company_id for share
      );
  elsif p_deal_id is not null then
    v_permitted := v_can_manage_deal;
  else
    -- Delegated can_invite is send-only for member seats on the actor's own
    -- company (#145).
    v_permitted := v_can_manage_company
      or coalesce(v_actor.company_id = p_company_id and v_actor.can_invite, false);
  end if;
  if not coalesce(v_permitted, false) then raise exception 'not_permitted'; end if;

  -- Company role: coercion keys on the ACTOR being external, never on the
  -- target company, so an authorized internal actor may still invite a
  -- director while an external actor is pinned to member.
  v_company_role := p_company_role;
  if v_actor.is_external and v_actor.firm_role is distinct from 'admin' then
    v_company_role := 'member';
  end if;
  if v_company_role not in ('director', 'member') then
    raise exception 'invalid_company_role';
  end if;
  if v_company_role = 'director' and not coalesce(v_can_manage_company, false) then
    raise exception 'not_permitted';
  end if;

  if p_deal_id is not null then
    if p_deal_role is null then raise exception 'invalid_deal_role'; end if;
    if v_is_external_company then
      if p_deal_role not in ('seller', 'buyer') then
        raise exception 'invalid_deal_role';
      end if;
      select party_role into v_party_role from deal_parties
       where deal_id = p_deal_id and company_id = p_company_id for share;
      if v_party_role is null then raise exception 'invalid_deal_role'; end if;
      v_expected_role := case
        when v_party_role in ('target', 'co_seller') then 'seller' else 'buyer'
      end;
      if p_deal_role is distinct from v_expected_role then
        raise exception 'invalid_deal_role';
      end if;
    else
      if p_deal_role not in ('deal_team', 'legal', 'read_only') then
        raise exception 'invalid_deal_role';
      end if;
    end if;
  elsif p_deal_role is not null then
    raise exception 'invalid_deal_role';
  end if;

  if p_phase is null or p_phase < 0 then raise exception 'invalid_phase'; end if;
  -- Phase gates external users only, so an internal seat has none to raise.
  v_phase := case when v_is_external_company then p_phase else 0 end;

  -- A transaction-scoped email lock turns concurrent creates into one create
  -- plus one deterministic duplicate result instead of a unique-index race.
  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));

  update invites set status = 'expired'
   where email = v_email and status = 'pending' and expires_at < now();

  if exists (select 1 from users where lower(email) = v_email and status <> 'invited') then
    raise exception 'active_account';
  end if;

  select id, delivery_status, company_id, deal_id, invited_by
    into v_existing
    from invites
   where email = v_email and status = 'pending';
  if found then
    return jsonb_build_object(
      'duplicate', true,
      'id', v_existing.id,
      'delivery_status', v_existing.delivery_status,
      'company_id', v_existing.company_id,
      'deal_id', v_existing.deal_id,
      'invited_by', v_existing.invited_by
    );
  end if;

  -- Lock the current trusted-domain set while validating its exact snapshot.
  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text, 1));
  perform 1 from company_verified_domains
   where company_id = p_company_id
   order by domain
   for share;
  v_domain_snapshot := company_verified_domain_snapshot(p_company_id);
  v_domain_classification := public.classify_invite_email_domain(
    v_email_domain,
    v_domain_snapshot
  );
  v_domain_match := v_domain_classification = 'match';

  if not v_domain_match then
    if p_domain_confirmation_id is null then
      raise exception 'domain_confirmation_required';
    end if;

    select * into v_confirmation
      from invite_domain_confirmations
     where id = p_domain_confirmation_id
     for update;
    if not found
      or v_confirmation.consumed_at is not null
      or v_confirmation.actor_id is distinct from p_actor
      or v_confirmation.tenant_id is distinct from v_tenant
      or v_confirmation.email is distinct from v_email
      or v_confirmation.company_id is distinct from p_company_id
      or v_confirmation.company_role is distinct from p_company_role
      or v_confirmation.deal_id is distinct from p_deal_id
      or v_confirmation.deal_role is distinct from p_deal_role
    then
      raise exception 'domain_confirmation_invalid';
    end if;
    if v_confirmation.expires_at <= now() then
      raise exception 'domain_confirmation_expired';
    end if;
    if v_confirmation.verified_domains_snapshot is distinct from v_domain_snapshot then
      raise exception 'domain_confirmation_stale';
    end if;
    if v_confirmation.classification is distinct from v_domain_classification then
      raise exception 'domain_confirmation_stale';
    end if;
  end if;

  insert into invites (
    tenant_id, email, invited_by, company_id, company_role, deal_id, deal_role,
    phase, challenge_digest, challenge_version, challenge_issued_at, auth_method
  ) values (
    v_tenant, v_email, p_actor, p_company_id, v_company_role, p_deal_id, p_deal_role,
    v_phase,
    case when p_auth_method = 'email_code' then p_challenge_digest end,
    case when p_auth_method = 'email_code' then 1 else 0 end,
    case when p_auth_method = 'email_code' then now() end,
    p_auth_method
  ) returning * into v_invite;

  if not v_domain_match then
    update invite_domain_confirmations
       set consumed_at = now(), consumed_invite_id = v_invite.id
     where id = v_confirmation.id;

    insert into audit_log (actor_id, action, deal_id, detail) values (
      p_actor,
      'invite_domain_override',
      p_deal_id,
      jsonb_build_object(
        'invite_id', v_invite.id,
        'company_id', p_company_id,
        'email', v_email,
        'classification', v_confirmation.classification,
        'outcome', 'confirmed'
      )
    );
  end if;

  if p_auth_method = 'email_code' then
  insert into audit_log (actor_id, action, deal_id, detail) values (
    p_actor,
    'invite_challenge_issued',
    p_deal_id,
    jsonb_build_object(
      'invite_id', v_invite.id,
      'company_id', p_company_id,
      'challenge_version', v_invite.challenge_version,
      'outcome', 'issued'
    )
  );
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'id', v_invite.id,
    'email', v_invite.email,
    'credential_nonce', v_invite.credential_nonce,
    'tenant_id', v_invite.tenant_id,
    'expires_at', v_invite.expires_at,
    'challenge_version', v_invite.challenge_version,
    'auth_method', v_invite.auth_method
  );
end;
$$;

create or replace function accept_invite(
  p_invite_id uuid, p_nonce uuid, p_password text, p_tos_version text, p_display_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_user_email text;
  v_invite invites%rowtype;
  v_is_external boolean;
begin
  -- (0) Validate the password before anything is read or written. 72 bytes is
  -- bcrypt's input limit: anything longer would be silently truncated.
  if p_password is null or length(p_password) < app_min_password_length()
     or octet_length(p_password) > 72
  then
    raise exception 'weak_password';
  end if;

  if v_user is null then raise exception 'not_authenticated'; end if;
  if not app_caller_live() or v_session is null then raise exception 'session_not_live'; end if;
  select lower(email) into v_user_email from auth.users where id = v_user;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found then raise exception 'invite_not_found'; end if;

  -- A replay from the session that accepted is answered, not re-applied: the
  -- password is not rewritten and nothing is audited twice.
  if v_invite.status = 'accepted'
     and v_invite.accepted_user_id = v_user
     and v_invite.challenge_verified_session_id = v_session
  then
    return jsonb_build_object(
      'deal_id', v_invite.deal_id, 'company_id', v_invite.company_id,
      'is_external', (select is_external from users where id = v_user), 'duplicate', true
    );
  end if;

  -- (1) Existing predicates.
  if v_invite.status <> 'pending' then raise exception 'invite_not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'invite_expired'; end if;
  if v_invite.credential_nonce is distinct from p_nonce then raise exception 'credential_mismatch'; end if;
  if v_invite.email <> v_user_email then raise exception 'email_mismatch'; end if;
  if not public.invite_tenant_compatible(v_invite.tenant_id, v_user) then raise exception 'tenant_mismatch'; end if;
  if v_invite.auth_method <> 'email_code' then raise exception 'invite_method_mismatch'; end if;
  if v_invite.delivery_status <> 'sent'
     or v_invite.challenge_digest is null
     or v_invite.challenge_locked_at is not null
     or v_invite.challenge_verified_at is null
     or v_invite.challenge_verified_user_id is distinct from v_user
     or v_invite.challenge_verified_version is distinct from v_invite.challenge_version
  then
    raise exception 'invite_not_verified';
  end if;
  if v_invite.challenge_verified_session_id is distinct from v_session
     or not exists (select 1 from auth.sessions where id = v_session and user_id = v_user)
  then
    raise exception 'challenge_session_mismatch';
  end if;
  if nullif(trim(p_tos_version), '') is null then raise exception 'terms_required'; end if;

  -- (2) Attestation.
  insert into audit_log (actor_id, action, deal_id, detail) values (
    v_user, 'attest', v_invite.deal_id,
    jsonb_build_object('reason', 'tos_accepted', 'tos_version', p_tos_version, 'invite_id', v_invite.id)
  );

  update invites
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_user
   where id = p_invite_id and status = 'pending';
  if not found then raise exception 'invite_not_pending'; end if;

  -- (3) Promote the profile into the invite's tenant and company.
  v_is_external := (select type from companies where id = v_invite.company_id) is distinct from 'bank';
  update users
     set tenant_id = v_invite.tenant_id,
         company_id = v_invite.company_id,
         company_role = v_invite.company_role,
         is_external = v_is_external,
         status = 'active',
         provisioning = 'authorized',
         display_name = coalesce(nullif(trim(p_display_name), ''), display_name)
   where id = v_user;

  -- (4) Password.
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = v_user;

  -- (5) Only this session survives; factors enrolled before acceptance go.
  delete from auth.sessions where user_id = v_user and id <> v_session;
  delete from auth.mfa_factors where user_id = v_user;

  -- (6) Membership and audits.
  perform public.invite_grant_membership(v_invite, v_user);

  return jsonb_build_object(
    'deal_id', v_invite.deal_id, 'company_id', v_invite.company_id,
    'is_external', v_is_external, 'duplicate', false
  );
end;
$$;

create or replace function accept_work_identity_invite(
  p_attempt_id uuid, p_secret_digest text, p_terms_version text, p_display_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_attempt work_identity_attempts%rowtype;
  v_invite invites%rowtype;
  v_inviter users%rowtype;
  v_profile users%rowtype;
  v_idp firm_identity_providers%rowtype;
  v_identity auth.identities%rowtype;
  v_user_email text;
  v_is_external boolean;
  v_company_tenant uuid;
  v_company_type text;
  v_is_external_company boolean;
  v_deal_tenant uuid;
  v_deal_bank uuid;
  v_party_role text;
  v_can_manage_company boolean;
  v_can_manage_deal boolean;
  v_permitted boolean;
  v_seat_ok boolean;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not app_caller_live() or v_session is null then raise exception 'session_not_live'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'mfa_required'; end if;

  select * into v_attempt from work_identity_attempts where id = p_attempt_id for update;
  if not found or p_secret_digest is null or p_secret_digest !~ '^[0-9a-f]{64}$'
     or not public.constant_work_digest_equal(v_attempt.secret_digest, p_secret_digest)
  then
    raise exception 'attempt_invalid';
  end if;
  if v_attempt.claimed_user_id is distinct from v_user then raise exception 'attempt_not_claimed'; end if;

  select * into v_invite from invites where id = v_attempt.invite_id for update;
  if v_attempt.consumed_at is not null then
    if v_invite.status = 'accepted' and v_invite.accepted_user_id = v_user then
      return jsonb_build_object(
        'deal_id', v_invite.deal_id, 'company_id', v_invite.company_id,
        'is_external', (select is_external from users where id = v_user), 'duplicate', true
      );
    end if;
    raise exception 'attempt_consumed';
  end if;
  if v_attempt.claimed_session_id is distinct from v_session then raise exception 'attempt_not_claimed'; end if;
  if v_attempt.expires_at <= now() then raise exception 'attempt_expired'; end if;

  if v_invite.status <> 'pending' then raise exception 'invite_not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'invite_expired'; end if;
  if v_invite.auth_method <> 'work_identity' then raise exception 'invite_method_mismatch'; end if;
  if v_invite.credential_nonce is distinct from v_attempt.credential_nonce then
    raise exception 'credential_mismatch';
  end if;
  if nullif(trim(p_terms_version), '') is null then raise exception 'terms_required'; end if;

  -- Continuing authority (F13): the inviter must still be able to grant this
  -- exact seat, re-derived with create_invite's rules (tenant, company role,
  -- external-party pinning, deal authority and party shape) under its lock
  -- order users -> companies -> deals -> deal_memberships -> deal_parties.
  -- Every expression is coalesced: NULL must never read as permission.
  select * into v_inviter from users where id = v_invite.invited_by for share;
  select tenant_id, type into v_company_tenant, v_company_type
    from companies where id = v_invite.company_id for share;
  v_is_external_company := v_company_type is distinct from 'bank';
  v_seat_ok := coalesce(v_inviter.status = 'active', false) and v_company_tenant is not null
    and (coalesce(v_company_tenant = v_inviter.tenant_id, false)
         or (coalesce(v_inviter.firm_role = 'admin', false) and v_invite.deal_id is null
             and public.tenant_is_unprovisioned(v_company_tenant)));
  v_can_manage_company := coalesce(v_inviter.firm_role = 'admin', false)
    or coalesce(v_inviter.company_role = 'director' and v_inviter.company_id = v_invite.company_id, false);

  if v_invite.deal_id is not null then
    select tenant_id, bank_id into v_deal_tenant, v_deal_bank from deals where id = v_invite.deal_id for share;
    perform 1 from deal_memberships
     where deal_id = v_invite.deal_id and user_id = v_invite.invited_by for share;
    v_seat_ok := v_seat_ok and coalesce(v_deal_tenant = v_company_tenant, false);
    v_can_manage_deal := exists (
        select 1 from deal_memberships
         where deal_id = v_invite.deal_id and user_id = v_invite.invited_by and deal_role = 'md'
      )
      or coalesce(v_inviter.company_role = 'director' and v_inviter.company_id = v_deal_bank, false)
      or coalesce((
        select (access_scope->>'can_manage_members')::boolean from deal_memberships
         where deal_id = v_invite.deal_id and user_id = v_invite.invited_by
      ), false);
  else
    v_can_manage_deal := false;
  end if;

  if coalesce(v_inviter.firm_role = 'admin', false) then
    v_permitted := true;
  elsif coalesce(v_inviter.is_external, false) then
    v_permitted := coalesce(v_inviter.company_role = 'director'
      and v_inviter.company_id = v_invite.company_id, false)
      and v_invite.deal_id is not null
      and exists (
        select 1 from deal_parties
         where deal_id = v_invite.deal_id and company_id = v_inviter.company_id for share
      );
  elsif v_invite.deal_id is not null then
    v_permitted := v_can_manage_deal;
  else
    v_permitted := v_can_manage_company
      or coalesce(v_inviter.company_id = v_invite.company_id and v_inviter.can_invite, false);
  end if;

  -- Seat shape: a director seat needs company authority now; external actors
  -- only ever grant member seats; the deal role must still fit the party.
  if v_invite.company_role = 'director' and (
       not coalesce(v_can_manage_company, false)
       or (coalesce(v_inviter.is_external, false) and not coalesce(v_inviter.firm_role = 'admin', false)))
  then
    v_seat_ok := false;
  end if;
  if v_invite.deal_id is not null then
    if v_is_external_company then
      select party_role into v_party_role from deal_parties
       where deal_id = v_invite.deal_id and company_id = v_invite.company_id for share;
      v_seat_ok := v_seat_ok and v_party_role is not null
        and v_invite.deal_role is not distinct from
            case when v_party_role in ('target', 'co_seller') then 'seller' else 'buyer' end;
    else
      v_seat_ok := v_seat_ok and coalesce(v_invite.deal_role in ('deal_team', 'legal', 'read_only'), false);
    end if;
  end if;

  if not (coalesce(v_seat_ok, false) and coalesce(v_permitted, false)) then
    raise exception 'inviter_not_authorized';
  end if;

  select * into v_idp from firm_identity_providers where company_id = v_invite.company_id for share;
  if not found then raise exception 'identity_provider_not_configured'; end if;

  select lower(email) into v_user_email from auth.users where id = v_user;
  if v_user_email is distinct from v_invite.email then raise exception 'email_mismatch'; end if;

  -- The provider's evidence, from the identity Supabase stored at sign-in.
  select i.* into v_identity
    from auth.identities i
   where i.user_id = v_user
     and i.provider = public.work_identity_auth_provider(v_idp.provider)
     and lower(i.identity_data ->> 'email') = v_invite.email
     and coalesce((i.identity_data ->> 'email_verified')::boolean, false)
     and public.work_identity_org_claim(v_idp.provider, i.identity_data) = v_idp.organization_id
   order by i.created_at desc
   limit 1;
  if not found then raise exception 'work_identity_mismatch'; end if;
  if exists (
    select 1 from work_identity_bindings
     where provider = v_idp.provider and provider_subject = v_identity.provider_id
       and user_id <> v_user
  ) then
    raise exception 'work_identity_bound_elsewhere';
  end if;

  select * into v_profile from users where id = v_user for update;
  if not (
    (v_profile.provisioning = 'contained' and v_profile.status = 'invited' and v_profile.company_id is null)
    or (v_profile.status = 'active' and exists (
      select 1 from work_identity_bindings
       where provider = v_idp.provider and provider_subject = v_identity.provider_id
         and user_id = v_user))
  ) then
    raise exception 'account_not_eligible';
  end if;

  update work_identity_attempts set consumed_at = now() where id = v_attempt.id;
  update invites
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_user
   where id = v_invite.id and status = 'pending';
  if not found then raise exception 'invite_not_pending'; end if;

  insert into audit_log (actor_id, action, deal_id, detail) values (
    v_user, 'attest', v_invite.deal_id,
    jsonb_build_object('reason', 'tos_accepted', 'tos_version', p_terms_version, 'invite_id', v_invite.id)
  );

  v_is_external := (select type from companies where id = v_invite.company_id) is distinct from 'bank';
  update users
     set tenant_id = v_invite.tenant_id,
         company_id = v_invite.company_id,
         company_role = v_invite.company_role,
         is_external = v_is_external,
         status = 'active',
         display_name = coalesce(nullif(trim(p_display_name), ''), display_name)
   where id = v_user;

  insert into work_identity_bindings (provider, provider_subject, user_id, organization_id, via)
  values (v_idp.provider, v_identity.provider_id, v_user, v_idp.organization_id, 'invite')
  on conflict (provider, provider_subject) do nothing;

  perform public.invite_grant_membership(v_invite, v_user);

  delete from auth.sessions where user_id = v_user and id <> v_session;

  return jsonb_build_object(
    'deal_id', v_invite.deal_id, 'company_id', v_invite.company_id,
    'is_external', v_is_external, 'duplicate', false
  );
end;
$$;

drop function public.app_invite_seat_authorized(invites);

-- The restored bodies re-check tenant_is_unprovisioned at acceptance again, so
-- the recorded crossing has no reader left.
drop trigger if exists invites_provisioning_crossing_immutable on invites;
drop function if exists invites_provisioning_crossing_immutable();
alter table invites drop column if exists provisioning_crossing;

commit;
