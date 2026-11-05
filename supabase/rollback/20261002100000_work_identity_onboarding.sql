-- Rollback for 20261002100000_work_identity_onboarding.sql (#316).
--
-- DESTRUCTIVE. It drops the work-identity tables (bindings, attempts, connect
-- intents, firm identity providers, broker aliases), the provisioning and
-- auth_method columns, and restores the pre-#316 functions: the metadata-reading
-- handle_new_auth_user, the two-argument accept_invite, the nine-argument
-- create_invite, and the RLS helpers without the live-caller guard. Restoring
-- the old auth trigger reopens the metadata-trust gap #316 closed, so apply it
-- only to recover from a broken forward migration.
--
-- It refuses to run while any state it would destroy exists: a work-identity
-- binding, a work-identity invitation, or a contained profile. Resolve those
-- first (accept, revoke, or provision them) so nothing is silently lost.
--
-- Remove [auth.hook.custom_access_token] from supabase/config.toml (and the
-- hosted project's hook setting) BEFORE applying: the hook function is dropped.

begin;

do $$
begin
  if exists (select 1 from public.work_identity_bindings) then
    raise exception 'rollback_refused: work identity bindings exist';
  end if;
  if exists (select 1 from public.invites where auth_method = 'work_identity') then
    raise exception 'rollback_refused: work identity invitations exist';
  end if;
  if exists (select 1 from public.users where provisioning = 'contained') then
    raise exception 'rollback_refused: contained profiles exist';
  end if;
end $$;

set local search_path = public;

drop function work_identity_access_token_hook(jsonb);
drop function complete_work_identity_connect(text, text, text);
drop function begin_work_identity_connect(text, text);
drop function release_unbound_identities(uuid, text);
drop function accept_work_identity_invite(uuid, text, text, text);
drop function claim_work_identity_attempt(uuid, text, text, uuid, uuid);
drop function bind_work_identity_attempt_flow(uuid, text, text);
drop function start_work_identity_attempt(uuid, uuid, text);
drop function accept_invite(uuid, uuid, text, text, text);
drop function invite_grant_membership(invites, uuid);
drop function invite_tenant_compatible(uuid, uuid);
drop function set_firm_identity_provider(uuid, uuid, text, text);
drop function authorize_provisioned_profile(uuid, jsonb);
drop function create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer, text);
drop function work_identity_org_claim(text, jsonb);
drop function work_identity_auth_provider(text);
drop function app_min_password_length();

-- Pre-#316 functions, verbatim.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid := '00000000-0000-4000-8000-000000000001';
begin
  insert into public.users (
    id,
    tenant_id,
    email,
    full_name,
    display_name,
    is_external,
    firm_role,
    department
  )
  values (
    new.id,
    coalesce((new.raw_user_meta_data->>'tenant_id')::uuid, v_tenant_id),
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'display_name',
    coalesce((new.raw_user_meta_data->>'is_external')::boolean, false),
    new.raw_user_meta_data->>'firm_role',
    new.raw_user_meta_data->>'department'
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    display_name = excluded.display_name,
    is_external = excluded.is_external,
    firm_role = excluded.firm_role,
    department = excluded.department;

  return new;
end;
$function$
;;

CREATE OR REPLACE FUNCTION public.accept_invite(p_invite_id uuid, p_nonce uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := auth.uid();
  v_user_email text;
  v_invite invites%rowtype;
  v_company_type text;
  v_is_external boolean;
  v_role_id uuid;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select lower(email) into v_user_email from auth.users where id = v_user;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found then raise exception 'invite_not_found'; end if;
  if v_invite.status <> 'pending' then raise exception 'invite_not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'invite_expired'; end if;
  if v_invite.credential_nonce is distinct from p_nonce then raise exception 'credential_mismatch'; end if;
  if v_invite.email <> v_user_email then raise exception 'email_mismatch'; end if;
  if v_invite.tenant_id is distinct from (select tenant_id from users where id = v_user) then
    raise exception 'tenant_mismatch';
  end if;
  if v_invite.delivery_status <> 'sent'
     or v_invite.challenge_digest is null
     or v_invite.challenge_locked_at is not null
     or v_invite.challenge_verified_at is null
     or v_invite.challenge_verified_user_id is distinct from v_user
     or v_invite.challenge_verified_version is distinct from v_invite.challenge_version
  then
    raise exception 'invite_not_verified';
  end if;

  update invites
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_user
   where id = p_invite_id and status = 'pending';
  if not found then raise exception 'invite_not_pending'; end if;

  select type into v_company_type from companies where id = v_invite.company_id;
  v_is_external := (v_company_type is distinct from 'bank');

  update users
     set company_id = v_invite.company_id,
         company_role = v_invite.company_role,
         is_external = v_is_external,
         status = 'active'
   where id = v_user;

  if v_invite.deal_id is not null then
    select id into v_role_id from roles where slug = v_invite.deal_role;
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (v_invite.deal_id, v_user, v_role_id, v_invite.deal_role, v_invite.phase, v_invite.invited_by)
    on conflict (deal_id, user_id) do nothing;

    insert into audit_log (actor_id, action, deal_id, detail) values (
      v_invite.invited_by,
      'grant',
      v_invite.deal_id,
      jsonb_build_object(
        'user_id', v_user, 'deal_role', v_invite.deal_role, 'phase', v_invite.phase, 'via', 'invite'
      )
    );
  end if;

  insert into audit_log (actor_id, action, deal_id, detail) values (
    v_user,
    'invite_accepted',
    v_invite.deal_id,
    jsonb_build_object('invite_id', v_invite.id, 'email', v_invite.email)
  );

  return jsonb_build_object(
    'deal_id', v_invite.deal_id,
    'company_id', v_invite.company_id,
    'is_external', v_is_external
  );
end;
$function$
;;

CREATE OR REPLACE FUNCTION public.create_invite(p_actor uuid, p_email text, p_company_id uuid, p_company_role text, p_challenge_digest text, p_domain_confirmation_id uuid DEFAULT NULL::uuid, p_deal_id uuid DEFAULT NULL::uuid, p_deal_role text DEFAULT NULL::text, p_phase integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if p_challenge_digest is null or p_challenge_digest !~ '^[0-9a-f]{64}$' then
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
    phase, challenge_digest, challenge_version, challenge_issued_at
  ) values (
    v_tenant, v_email, p_actor, p_company_id, v_company_role, p_deal_id, p_deal_role,
    v_phase, p_challenge_digest, 1, now()
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

  return jsonb_build_object(
    'duplicate', false,
    'id', v_invite.id,
    'email', v_invite.email,
    'credential_nonce', v_invite.credential_nonce,
    'tenant_id', v_invite.tenant_id,
    'expires_at', v_invite.expires_at,
    'challenge_version', v_invite.challenge_version
  );
end;
$function$
;;

CREATE OR REPLACE FUNCTION public.rotate_invite_credential(p_invite_id uuid, p_challenge_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invite invites%rowtype;
begin
  if p_challenge_digest is null or p_challenge_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'challenge_required';
  end if;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found or v_invite.status <> 'pending' then raise exception 'not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'not_pending'; end if;

  update invites
     set credential_nonce = gen_random_uuid(),
         delivery_status = 'unsent',
         expires_at = now() + interval '24 hours',
         challenge_digest = p_challenge_digest,
         challenge_version = challenge_version + 1,
         challenge_issued_at = now(),
         challenge_attempts = 0,
         challenge_locked_at = null,
         challenge_verified_at = null,
         challenge_verified_user_id = null,
         challenge_verified_version = null
   where id = p_invite_id
  returning * into v_invite;

  insert into audit_log (actor_id, action, deal_id, detail) values (
    v_invite.invited_by,
    'invite_challenge_rotated',
    v_invite.deal_id,
    jsonb_build_object(
      'invite_id', v_invite.id,
      'company_id', v_invite.company_id,
      'challenge_version', v_invite.challenge_version,
      'outcome', 'rotated'
    )
  );

  return jsonb_build_object(
    'id', v_invite.id,
    'email', v_invite.email,
    'credential_nonce', v_invite.credential_nonce,
    'expires_at', v_invite.expires_at,
    'challenge_version', v_invite.challenge_version
  );
end;
$function$
;;

CREATE OR REPLACE FUNCTION public.verify_invite_challenge(p_invite_id uuid, p_nonce uuid, p_code_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := auth.uid();
  v_user_email text;
  v_user_tenant uuid;
  v_invite invites%rowtype;
  v_attempts integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select lower(a.email), u.tenant_id
    into v_user_email, v_user_tenant
    from auth.users a
    join users u on u.id = a.id
   where a.id = v_user;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found then raise exception 'invite_not_found'; end if;
  if v_invite.status <> 'pending' then raise exception 'invite_not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'invite_expired'; end if;
  if v_invite.credential_nonce is distinct from p_nonce then raise exception 'credential_mismatch'; end if;
  if v_invite.email is distinct from v_user_email then raise exception 'email_mismatch'; end if;
  if v_invite.tenant_id is distinct from v_user_tenant then raise exception 'tenant_mismatch'; end if;
  if v_invite.delivery_status <> 'sent' then raise exception 'invite_not_sent'; end if;
  if v_invite.challenge_digest is null or v_invite.challenge_version = 0 then
    raise exception 'challenge_unavailable';
  end if;
  if v_invite.challenge_locked_at is not null then raise exception 'challenge_locked'; end if;
  if v_invite.challenge_verified_at is not null then raise exception 'already_verified'; end if;

  if p_code_digest is not null
     and p_code_digest ~ '^[0-9a-f]{64}$'
     and public.constant_work_digest_equal(v_invite.challenge_digest, p_code_digest)
  then
    update invites
       set challenge_verified_at = now(),
           challenge_verified_user_id = v_user,
           challenge_verified_version = challenge_version
     where id = p_invite_id;

    insert into audit_log (actor_id, action, deal_id, detail) values (
      v_user,
      'invite_verification_succeeded',
      v_invite.deal_id,
      jsonb_build_object(
        'invite_id', v_invite.id,
        'company_id', v_invite.company_id,
        'challenge_version', v_invite.challenge_version,
        'outcome', 'verified'
      )
    );
    return jsonb_build_object('verified', true, 'challenge_version', v_invite.challenge_version);
  end if;

  v_attempts := least(v_invite.challenge_attempts + 1, 5);
  update invites
     set challenge_attempts = v_attempts,
         challenge_locked_at = case when v_attempts = 5 then now() else null end
   where id = p_invite_id;

  if v_attempts = 5 then
    insert into audit_log (actor_id, action, deal_id, detail) values (
      v_user,
      'invite_verification_locked',
      v_invite.deal_id,
      jsonb_build_object(
        'invite_id', v_invite.id,
        'company_id', v_invite.company_id,
        'challenge_version', v_invite.challenge_version,
        'attempts', v_attempts,
        'outcome', 'locked'
      )
    );
  end if;

  return jsonb_build_object(
    'verified', false,
    'attempts_remaining', greatest(5 - v_attempts, 0),
    'locked', v_attempts = 5
  );
end;
$function$
;;

revoke all on function handle_new_auth_user() from public, anon, authenticated;
grant execute on function handle_new_auth_user() to service_role;
revoke all on function accept_invite(uuid, uuid) from public, anon;
grant execute on function accept_invite(uuid, uuid) to authenticated, service_role;
revoke all on function create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer) to service_role;

-- RLS helpers as 20260930180000 left them.
create or replace function app_is_overseer(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from users where id = p_user and firm_role in ('cco', 'admin'));
$$;

create or replace function app_user_tenant(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select tenant_id from users
  where id = p_user
    and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'));
$$;

create or replace function app_user_company(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select company_id from users
  where id = p_user
    and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'));
$$;

create or replace function app_is_deal_member(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from deal_memberships where deal_id = p_deal and user_id = p_user);
$$;

create or replace function app_is_deal_md(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (
       select 1 from deal_memberships m join roles r on r.id = m.role_id
       where m.deal_id = p_deal and m.user_id = p_user and r.slug = 'md'
     );
$$;

create or replace function app_user_is_director(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from users where id = p_user and company_role = 'director');
$$;

create or replace function app_is_deal_overseer(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (
       select 1
       from users u
       join deals d on d.id = p_deal
       where u.id = p_user
         and u.firm_role in ('cco', 'admin')
         and d.tenant_id = u.tenant_id
     );
$$;

create or replace function app_user_is_external(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select not (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
      or coalesce((select is_external from users where id = p_user), true);
$$;

-- p_actor is any user, so a browser caller asking about itself could still
-- learn whether a colleague it cannot see shares its tenant. Its one policy
-- (audit_log_select) calls it only behind app_is_overseer(auth.uid()), and an
-- overseer already reads the whole tenant through users_select, so a browser
-- caller gets an answer only when it is an overseer.
create or replace function app_actor_in_user_tenant(p_actor uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (
       select 1
       from users a
       join users u on u.id = p_user
       where a.id = p_actor
         and a.tenant_id = u.tenant_id
         and (u.firm_role in ('cco', 'admin')
              or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     );
$$;


drop function app_caller_live();
drop function work_identity_session_id();

drop table work_identity_connect_intents;
drop table work_identity_attempts;
drop table work_identity_bindings;
drop table work_identity_broker_aliases;
drop table firm_identity_providers;

drop trigger invites_auth_method_immutable on invites;
drop function invites_auth_method_immutable();
alter table invites drop constraint invites_work_identity_no_challenge_check;
alter table invites drop constraint invites_challenge_session_check;
alter table invites drop column challenge_verified_session_id;
alter table invites drop column auth_method;
alter table users drop column provisioning;

-- Audit rows written with the five #316 actions stay (the log is append-only);
-- the check is `not valid`, so they do not block restoring the older list.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view',
  'download',
  'upload',
  'export',
  'grant',
  'revoke',
  'hold_placed',
  'hold_lifted',
  'create',
  'notify',
  'advance',
  'attest',
  'screen',
  'send',
  'release',
  'invite_sent',
  'invite_accepted',
  'invite_revoked',
  'reject',
  'invite_domain_override',
  'invite_challenge_issued',
  'invite_challenge_rotated',
  'invite_verification_succeeded',
  'invite_verification_locked',
  'mfa_enrolled',
  'mfa_challenged',
  'assign_step',
  'complete_step',
  'step_work',
  'update',
  'skill_authoring.draft_created',
  'skill_authoring.draft_archived',
  'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned',
  'skill_authoring.candidate_selected',
  'skill_authoring.access_denied',
  'skill_publication.admitted',
  'skill_publication.admission_denied',
  'skill_publication.duplicate_confirmed',
  'skill_publication.duplicate_declined',
  'skill_publication.placement_replaced',
  'skill_publication.transition',
  'rail.step_rebound',
  'rail.template_created',
  'rail.template_replaced',
  'rail.template_applied',
  'discovery.candidate_proposed',
  'discovery.candidate_promoted',
  'discovery.correction',
  'discovery.milestone_extracted',
  'discovery.stage_assessed',
  'discovery.mailbox_consented',
  'discovery.mailbox_consent_withdrawn',
  'discovery.mailbox_refused',
  'discovery.allowlist_drift',
  'discovery.site_registered',
  'discovery.site_unregistered',
  'discovery.site_refused',
  'discovery.mailbox_source_archived',
  'discovery.mailbox_sources_unified'
])) not valid;

commit;
