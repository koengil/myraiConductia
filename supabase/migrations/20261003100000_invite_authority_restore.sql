-- Restore invitation authority to the permission system (#296).
--
-- Invitation authority has one source of truth: company:invites:send, held
-- through a company role or a direct grant and resolved by
-- app_company_effective_permissions. 20260814190000 swapped create_invite's
-- delegation predicate onto it and 20260816130000 let an external CLIENT
-- director invite without a deal, both by patching the function in place. Two
-- later full redefinitions (20260929120000, 20261002100000) were built from an
-- older body and silently overwrote both patches, so create_invite went back to
-- reading the users.can_invite projection (a read model) and the TypeScript and
-- SQL halves of invite authority disagreed again.
--
-- This migration is ONE readable full redefinition of the three functions,
-- each composed from its 20261002100000 body with only the lines below
-- changed, so a diff shows exactly what moved. tests/invite-authority-migration
-- .test.ts and supabase/tests/invite_authority_parity.sql fail if a later
-- migration drops any of it.
--
--   create_invite
--     + takes the shared company access lock first (a revocation in flight
--       finishes before authority is read; invites never block each other);
--     + refuses a non-active actor on EVERY branch (admin, director, deal MD,
--       external, delegate), whatever users.can_invite says;
--     ~ delegated authority reads company:invites:send from the resolver;
--     ~ an external director may invite deal-less into their own CLIENT company
--       only (X-nonclient: a target or acquirer director gets none);
--     + records a firm admin's provisioning crossing on the invite
--       (invites.provisioning_crossing, section 0).
--   app_invite_seat_authorized (new)
--     the inviter-active, tenant, authority, director-seat and party-shape
--     re-derivation accept_work_identity_invite already ran, lifted into one
--     helper with the restored predicate. A crossing is honoured from the
--     recorded issue-time decision, not by re-asking whether the tenant is
--     still unprovisioned.
--   accept_work_identity_invite   inline re-derivation -> the helper.
--   accept_invite                 gains the check (it never read the inviter);
--                                 raises inviter_not_authorized.
--
-- Every statement is re-runnable (create or replace, idempotent grants), and
-- supabase/tests/invite_authority_backfill.sql re-runs this file over seeded
-- users to prove the backfill boundary.

-- ---------------------------------------------------------------------------
-- 0  invites.provisioning_crossing: the crossing decided at issue
-- ---------------------------------------------------------------------------
-- A firm admin may invite across a tenant boundary only to provision a new
-- organization: no deal, into a tenant no one has joined yet (#248). Acceptance
-- used to re-ask tenant_is_unprovisioned, which turns false the moment the
-- first invitee goes active, so every other invitation the admin issued into
-- the new org died with inviter_not_authorized. Comparing invites.tenant_id to
-- the company tenant is not a substitute: it is copied from the company at
-- issue, and 20260915120000 let an admin cross into an already-provisioned
-- tenant, so a pending invite from that window would pass.
--
-- So create_invite records the decision it made. The flag is true only when
-- the crossing branch ran because the tenant was unprovisioned at issue.
-- Existing rows take the default (false) and stay refused, except a pending
-- crossing whose tenant is still unprovisioned now: acceptance would have let
-- it through before this change, so it keeps working. invites is service-role
-- only (RLS on, no policy, no grant to API roles), and the trigger makes the
-- flag immutable after insert even for the server.
alter table invites add column if not exists provisioning_crossing boolean not null default false;

drop trigger if exists invites_provisioning_crossing_immutable on invites;

update invites i
   set provisioning_crossing = true
  from companies c, users u
 where c.id = i.company_id
   and u.id = i.invited_by
   and i.status = 'pending'
   and not i.provisioning_crossing
   and i.deal_id is null
   and i.tenant_id = c.tenant_id
   and coalesce(u.firm_role = 'admin', false)
   and u.tenant_id is distinct from c.tenant_id
   and public.tenant_is_unprovisioned(c.tenant_id);

create or replace function invites_provisioning_crossing_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.provisioning_crossing is distinct from old.provisioning_crossing then
    raise exception 'provisioning_crossing_immutable';
  end if;
  return new;
end;
$$;
create trigger invites_provisioning_crossing_immutable
  before update of provisioning_crossing on invites
  for each row execute function invites_provisioning_crossing_immutable();
revoke all on function invites_provisioning_crossing_immutable() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1  create_invite
-- ---------------------------------------------------------------------------
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
  v_provisioning_crossing boolean := false;
begin
  -- Invitation authority is the company permission system (#296), and its role
  -- and permission rows are read without row locks. Every grant mutation takes
  -- this company-scoped advisory lock first (company_access_lock_actor), so
  -- holding it SHARED before reading authority makes a revocation in flight
  -- finish first, while two invites never block each other. It is the first
  -- statement: the mutation's can_invite projection trigger updates the users
  -- row, so taking the advisory lock before any users or companies row lock
  -- rules out a deadlock.
  perform pg_advisory_xact_lock_shared(hashtextextended(p_company_id::text, 160));

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
  -- The invite records that this branch ran (#296), so acceptance honours the
  -- decision made here instead of re-asking after the tenant has filled up.
  if v_company_tenant is distinct from v_tenant then
    if coalesce(v_actor.firm_role = 'admin', false)
       and p_deal_id is null
       and public.tenant_is_unprovisioned(v_company_tenant)
    then
      v_tenant := v_company_tenant;
      v_provisioning_crossing := true;
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

  -- No branch below may authorize a non-active actor: a suspended firm admin,
  -- director, deal MD or delegate holds no authority whatever the rest of the
  -- row says (design Q12).
  if not coalesce(v_actor.status = 'active', false) then raise exception 'not_permitted'; end if;

  if coalesce(v_actor.firm_role = 'admin', false) then
    v_permitted := true;
  elsif v_actor.is_external then
    -- External directors invite into their own company. Deal-less invites are
    -- for client companies only (the Employees HR view, 20260816130000);
    -- deal-attached invites need a party seat on that deal.
    v_permitted := coalesce(v_actor.company_role = 'director'
      and v_actor.company_id = p_company_id, false)
      and (
        (p_deal_id is null and v_company_type = 'client')
        or (
          p_deal_id is not null
          and exists (
            select 1 from deal_parties
             where deal_id = p_deal_id and company_id = v_actor.company_id for share
          )
        )
      );
  elsif p_deal_id is not null then
    v_permitted := v_can_manage_deal;
  else
    -- Delegated invitation authority is the company:invites:send permission,
    -- held through a company role or a direct grant, and it is send-only for
    -- member seats on the actor's own company (#145). The resolver is claim-free
    -- for role and direct grants (it reads no caller identity for them), which
    -- is what lets acceptance, running as the invitee, re-derive the same answer.
    -- Access roots never reach it: v_can_manage_company decides them first.
    v_permitted := v_can_manage_company
      or exists (
        select 1 from public.app_company_effective_permissions(p_actor, p_company_id) ep
         where ep.permission_key = 'company:invites:send'
      );
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
    phase, challenge_digest, challenge_version, challenge_issued_at, auth_method,
    provisioning_crossing
  ) values (
    v_tenant, v_email, p_actor, p_company_id, v_company_role, p_deal_id, p_deal_role,
    v_phase,
    case when p_auth_method = 'email_code' then p_challenge_digest end,
    case when p_auth_method = 'email_code' then 1 else 0 end,
    case when p_auth_method = 'email_code' then now() end,
    p_auth_method,
    v_provisioning_crossing
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

-- ---------------------------------------------------------------------------
-- 2  app_invite_seat_authorized: one re-derivation for BOTH acceptance paths
-- ---------------------------------------------------------------------------
-- A pending invite is only as good as its inviter's authority at the moment it
-- is accepted. accept_work_identity_invite has always re-derived the seat;
-- accept_invite never read the inviter, so an email-code invite outlived a
-- suspended inviter and a revoked grant (design Q12, T7). The block is lifted
-- here so both paths share one body and cannot drift apart again.
--
-- Called only from the two security definer acceptance bodies, right after the
-- invite row is loaded and before any inviter row lock. Not callable by API
-- roles.
create or replace function public.app_invite_seat_authorized(p_invite invites)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inviter users%rowtype;
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
  -- Shared mode on the key every grant mutation holds exclusively, taken before
  -- any users or companies row lock (see create_invite).
  perform pg_advisory_xact_lock_shared(hashtextextended(p_invite.company_id::text, 160));

  -- Continuing authority (F13): the inviter must still be able to grant this
  -- exact seat, re-derived with create_invite's rules (tenant, company role,
  -- external-party pinning, deal authority and party shape) under its lock
  -- order users -> companies -> deals -> deal_memberships -> deal_parties.
  -- Every expression is coalesced: NULL must never read as permission.
  select * into v_inviter from users where id = p_invite.invited_by for share;
  select tenant_id, type into v_company_tenant, v_company_type
    from companies where id = p_invite.company_id for share;
  v_is_external_company := v_company_type is distinct from 'bank';
  -- A firm admin's crossing stands on the decision create_invite recorded at
  -- issue (section 0), never on whether the tenant is still unprovisioned: the
  -- first acceptance provisions it, and the admin's other invitations into the
  -- new org must survive that. A legacy invite carries false and is refused.
  -- The stored tenant must still be the company's. scripts/split-company-
  -- tenant.sql (D54) moves the company, its invites and its users together, so
  -- the equality holds after a split.
  v_seat_ok := coalesce(v_inviter.status = 'active', false) and v_company_tenant is not null
    and (coalesce(v_company_tenant = v_inviter.tenant_id, false)
         or (coalesce(v_inviter.firm_role = 'admin', false) and p_invite.deal_id is null
             and coalesce(p_invite.provisioning_crossing, false)
             and coalesce(p_invite.tenant_id = v_company_tenant, false)));
  v_can_manage_company := coalesce(v_inviter.firm_role = 'admin', false)
    or coalesce(v_inviter.company_role = 'director' and v_inviter.company_id = p_invite.company_id, false);

  if p_invite.deal_id is not null then
    select tenant_id, bank_id into v_deal_tenant, v_deal_bank from deals where id = p_invite.deal_id for share;
    perform 1 from deal_memberships
     where deal_id = p_invite.deal_id and user_id = p_invite.invited_by for share;
    v_seat_ok := v_seat_ok and coalesce(v_deal_tenant = v_company_tenant, false);
    v_can_manage_deal := exists (
        select 1 from deal_memberships
         where deal_id = p_invite.deal_id and user_id = p_invite.invited_by and deal_role = 'md'
      )
      or coalesce(v_inviter.company_role = 'director' and v_inviter.company_id = v_deal_bank, false)
      or coalesce((
        select (access_scope->>'can_manage_members')::boolean from deal_memberships
         where deal_id = p_invite.deal_id and user_id = p_invite.invited_by
      ), false);
  else
    v_can_manage_deal := false;
  end if;

  if coalesce(v_inviter.firm_role = 'admin', false) then
    v_permitted := true;
  elsif coalesce(v_inviter.is_external, false) then
    -- Same rule as create_invite: a deal-less invite is for client companies
    -- only, a deal-attached one needs a party seat on that deal.
    v_permitted := coalesce(v_inviter.company_role = 'director'
      and v_inviter.company_id = p_invite.company_id, false)
      and (
        (p_invite.deal_id is null and v_company_type = 'client')
        or (
          p_invite.deal_id is not null
          and exists (
            select 1 from deal_parties
             where deal_id = p_invite.deal_id and company_id = v_inviter.company_id for share
          )
        )
      );
  elsif p_invite.deal_id is not null then
    v_permitted := v_can_manage_deal;
  else
    -- The permission system, not the can_invite projection. Role and direct
    -- grants resolve without the caller being the user, which is what lets
    -- acceptance, running as the invitee, ask the question.
    v_permitted := v_can_manage_company
      or exists (
        select 1 from public.app_company_effective_permissions(v_inviter.id, p_invite.company_id) ep
         where ep.permission_key = 'company:invites:send'
      );
  end if;

  -- Seat shape: a director seat needs company authority now; external actors
  -- only ever grant member seats; the deal role must still fit the party.
  if p_invite.company_role = 'director' and (
       not coalesce(v_can_manage_company, false)
       or (coalesce(v_inviter.is_external, false) and not coalesce(v_inviter.firm_role = 'admin', false)))
  then
    v_seat_ok := false;
  end if;
  if p_invite.deal_id is not null then
    if v_is_external_company then
      select party_role into v_party_role from deal_parties
       where deal_id = p_invite.deal_id and company_id = p_invite.company_id for share;
      v_seat_ok := v_seat_ok and v_party_role is not null
        and p_invite.deal_role is not distinct from
            case when v_party_role in ('target', 'co_seller') then 'seller' else 'buyer' end;
    else
      v_seat_ok := v_seat_ok and coalesce(p_invite.deal_role in ('deal_team', 'legal', 'read_only'), false);
    end if;
  end if;

  return coalesce(v_seat_ok, false) and coalesce(v_permitted, false);
end;
$$;

revoke all on function public.app_invite_seat_authorized(invites) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3  accept_work_identity_invite
-- ---------------------------------------------------------------------------
create or replace function accept_work_identity_invite(
  p_attempt_id uuid, p_secret_digest text, p_terms_version text, p_display_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_attempt work_identity_attempts%rowtype;
  v_invite invites%rowtype;
  v_profile users%rowtype;
  v_idp firm_identity_providers%rowtype;
  v_identity auth.identities%rowtype;
  v_user_email text;
  v_is_external boolean;
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

  -- Continuing authority (F13, #296): the inviter must still be able to grant
  -- this exact seat. One helper re-derives it for both acceptance paths: the
  -- inviter is active, holds the authority the invite was issued under (through
  -- the permission system, not the can_invite projection), and the seat shape
  -- still fits. It takes the shared company access lock first, so a revocation
  -- in flight finishes before it reads.
  if not public.app_invite_seat_authorized(v_invite) then
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

-- ---------------------------------------------------------------------------
-- 4  accept_invite
-- ---------------------------------------------------------------------------
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

  -- Continuing authority (#296, design Q12): the inviter must still be able to
  -- grant this seat. The same helper accept_work_identity_invite calls, so a
  -- pending invite dies when its inviter is suspended or loses the authority
  -- it was issued under, whichever way the invitee proves their identity.
  if not public.app_invite_seat_authorized(v_invite) then
    raise exception 'inviter_not_authorized';
  end if;

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

-- ---------------------------------------------------------------------------
-- 5  Backfill: keep the authority users hold today, as a visible grant
-- ---------------------------------------------------------------------------
-- Until now an internal bank user with users.can_invite and no grant row could
-- invite (create_invite read the projection). Reading the permission system
-- would silently remove that, so give each such user the direct grant the flag
-- stood for (the 20260814190000 pattern, tightened). It then shows in the
-- access drawer and survives the projection being dropped.
--
-- WHO. The WHERE is the boundary; enforce_company_access_eligibility() is only a
-- partial backstop, because it fires when a company_member_access row is
-- INSERTED, and a suspended user who already holds an access row passes the
-- permissions foreign key without it running. So every predicate is explicit:
-- active, internal, in their own bank company in their own tenant, not an
-- access root (directors and firm admins hold the permission already), and no
-- effective company:invites:send from any source (a role holder is skipped).
--
-- ROWS. Per grant: a company_member_access row if missing, a direct permission
-- row (granted_by is NOT NULL, so the user is recorded granting themselves, as
-- 0814 did), and one audit_log service row with the existing action 'grant'
-- (no CHECK rebuild). The audit insert reads only the rows the grant actually
-- returned, so a re-run adds nothing.
with eligible as (
  select u.id as user_id, u.company_id, c.tenant_id
    from users u
    join companies c on c.id = u.company_id and c.type = 'bank' and c.tenant_id = u.tenant_id
   where u.can_invite
     and u.status = 'active'
     and not u.is_external
     and u.company_role is distinct from 'director'
     and u.firm_role is distinct from 'admin'
     and not exists (
       select 1 from public.app_company_effective_permissions(u.id, u.company_id) ep
        where ep.permission_key = 'company:invites:send'
     )
), access_rows as (
  insert into company_member_access (company_id, user_id)
  select company_id, user_id from eligible
  on conflict (company_id, user_id) do nothing
  returning company_id, user_id
), granted as (
  insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
  select company_id, user_id, 'company:invites:send', user_id from eligible
  on conflict (user_id, permission_key) do nothing
  returning company_id, user_id
)
insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
select c.tenant_id, 'service', 'migration:invite_authority_restore', 'grant',
       jsonb_build_object(
         'reason', 'invite_permission_backfilled',
         'company_id', g.company_id,
         'user_id', g.user_id,
         'source_type', 'direct',
         'permission_key', 'company:invites:send'
       )
  from granted g
  join companies c on c.id = g.company_id;
