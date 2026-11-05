-- Invite lifecycle RPCs (plan-v5 M3). Every mutation that must be atomic with
-- its audit event lives here, following the create_deal_gate0 precedent
-- (ADR-0010): the route authenticates and validates; the RPC owns the
-- transaction. Functions are security definer (owned by the migration role,
-- bypassing RLS like the service-role handlers) with search_path pinned.
--
-- State machine (see 20260731120000_onboarding_invites.sql):
--   pending -> accepted | revoked | expired   (all three terminal)
-- Delivery:
--   unsent -> sent  (invite_sent audit written atomically with the flip)

-- ---------------------------------------------------------------------------
-- create_invite: row-first creation (link generation and email happen in the
-- route AFTER this returns; a failure there leaves pending/unsent, recoverable
-- via resend). Returns duplicate info instead of raising so the route can make
-- a scoped disclosure decision (cr-plan-v4 4.1).
-- ---------------------------------------------------------------------------
create or replace function public.create_invite(
  p_actor uuid,
  p_email text,
  p_company_id uuid,
  p_company_role text,
  p_deal_id uuid default null,
  p_deal_role text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_tenant uuid;
  v_existing record;
  v_invite record;
begin
  select tenant_id into v_tenant from users where id = p_actor;
  if v_tenant is null then
    raise exception 'actor_not_found';
  end if;

  -- Lazy expiry: a pending invite past its window flips to expired here (and in
  -- resend), so the global pending-email unique index never blocks a re-invite.
  update invites
     set status = 'expired'
   where email = v_email
     and status = 'pending'
     and expires_at < now();

  -- One email = one account (D33): an email attached to a live account takes
  -- the direct-grant path, not an invite.
  if exists (
    select 1 from users where lower(email) = v_email and status <> 'invited'
  ) then
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

  insert into invites (
    tenant_id, email, invited_by, company_id, company_role, deal_id, deal_role
  ) values (
    v_tenant, v_email, p_actor, p_company_id, p_company_role, p_deal_id, p_deal_role
  )
  returning * into v_invite;

  -- No invite_sent audit here: the credential has not been handed to the email
  -- provider yet. finalize_invite_delivery writes it (cr-plan-v2 5.2).
  return jsonb_build_object(
    'duplicate', false,
    'id', v_invite.id,
    'email', v_invite.email,
    'credential_nonce', v_invite.credential_nonce,
    'tenant_id', v_invite.tenant_id,
    'expires_at', v_invite.expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- finalize_invite_delivery: called after the email provider accepted the
-- message. Conditional flip + audit in one transaction; idempotent (second
-- call is a no-op, so a route retry can never double-audit).
-- ---------------------------------------------------------------------------
create or replace function public.finalize_invite_delivery(
  p_invite_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite record;
begin
  update invites
     set delivery_status = 'sent'
   where id = p_invite_id
     and delivery_status = 'unsent'
     and status = 'pending'
  returning * into v_invite;

  if not found then
    return false; -- already sent (idempotent) or not pending
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
  values (
    v_invite.invited_by,
    'invite_sent',
    v_invite.deal_id,
    jsonb_build_object('invite_id', v_invite.id, 'email', v_invite.email)
  );
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- rotate_invite_credential: resend path. Rotates the nonce (invalidating any
-- previously delivered link at acceptance time), resets delivery to unsent,
-- and extends the expiry window. Pending-only.
-- ---------------------------------------------------------------------------
create or replace function public.rotate_invite_credential(
  p_invite_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite record;
begin
  -- Same lazy expiry as create: a stale pending invite must expire, not rotate.
  update invites
     set status = 'expired'
   where id = p_invite_id
     and status = 'pending'
     and expires_at < now();

  update invites
     set credential_nonce = gen_random_uuid(),
         delivery_status = 'unsent',
         expires_at = now() + interval '7 days'
   where id = p_invite_id
     and status = 'pending'
  returning * into v_invite;

  if not found then
    raise exception 'not_pending';
  end if;

  return jsonb_build_object(
    'id', v_invite.id,
    'email', v_invite.email,
    'credential_nonce', v_invite.credential_nonce,
    'expires_at', v_invite.expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_invite: pending-only, atomic with its audit event.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_invite(
  p_invite_id uuid,
  p_actor uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite record;
begin
  update invites
     set status = 'revoked'
   where id = p_invite_id
     and status = 'pending'
  returning * into v_invite;

  if not found then
    raise exception 'not_pending';
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
  values (
    p_actor,
    'invite_revoked',
    v_invite.deal_id,
    jsonb_build_object('invite_id', v_invite.id, 'email', v_invite.email)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_invite: the single-winner redemption. MUST be called through the
-- session-bound client (PostgREST with the invitee's JWT) so auth.uid() is the
-- accepting user — never through the service-role client (cr-plan-v2 5.1).
-- Validates email + tenant coherence and the credential nonce, then provisions
-- company membership, deal membership, and audits atomically.
-- ---------------------------------------------------------------------------
create or replace function public.accept_invite(
  p_invite_id uuid,
  p_nonce uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_user_email text;
  v_invite record;
  v_company_type text;
  v_is_external boolean;
  v_role_id uuid;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  select lower(email) into v_user_email from auth.users where id = v_user;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found then
    raise exception 'invite_not_found';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'invite_not_pending';
  end if;
  if v_invite.expires_at < now() then
    update invites set status = 'expired' where id = p_invite_id;
    raise exception 'invite_expired';
  end if;
  if v_invite.credential_nonce is distinct from p_nonce then
    raise exception 'credential_mismatch';
  end if;
  if v_invite.email <> v_user_email then
    raise exception 'email_mismatch';
  end if;
  if v_invite.tenant_id is distinct from (select tenant_id from users where id = v_user) then
    raise exception 'tenant_mismatch';
  end if;

  -- Delivered-credential invariant (cr-plan-v3 5.1): a valid nonce proves the
  -- link was minted for this row; if the sent flip was lost after the provider
  -- accepted the email, reconcile here — recording the single invite_sent
  -- audit — rather than stranding the invitee.
  if v_invite.delivery_status = 'unsent' then
    perform finalize_invite_delivery(p_invite_id);
  end if;

  -- Single winner: exactly one concurrent accept flips pending -> accepted.
  update invites
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_user
   where id = p_invite_id
     and status = 'pending';
  if not found then
    raise exception 'invite_not_pending';
  end if;

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
    values (v_invite.deal_id, v_user, v_role_id, v_invite.deal_role, 0, v_invite.invited_by)
    on conflict (deal_id, user_id) do nothing;

    insert into audit_log (actor_id, action, deal_id, detail)
    values (
      v_invite.invited_by,
      'grant',
      v_invite.deal_id,
      jsonb_build_object(
        'user_id', v_user, 'deal_role', v_invite.deal_role, 'phase', 0, 'via', 'invite'
      )
    );
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
  values (
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
$$;

-- Service-role functions stay locked down; accept_invite is the one function
-- an authenticated (still-'invited') user may execute.
revoke all on function public.create_invite(uuid, text, uuid, text, uuid, text) from public;
revoke all on function public.finalize_invite_delivery(uuid) from public;
revoke all on function public.rotate_invite_credential(uuid) from public;
revoke all on function public.revoke_invite(uuid, uuid) from public;
revoke all on function public.accept_invite(uuid, uuid) from public;
grant execute on function public.create_invite(uuid, text, uuid, text, uuid, text) to service_role;
grant execute on function public.finalize_invite_delivery(uuid) to service_role;
grant execute on function public.rotate_invite_credential(uuid) to service_role;
grant execute on function public.revoke_invite(uuid, uuid) to service_role;
grant execute on function public.accept_invite(uuid, uuid) to authenticated;
grant execute on function public.accept_invite(uuid, uuid) to service_role;
