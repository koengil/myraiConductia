-- #406: one work-identity binding per user.
-- #408: an invitation from another firm is refused for an active user
--   (invite_other_firm) on both accept paths, accept_work_identity_invite and
--   the email-code accept_invite (redefined at the end); an invitation never
--   moves a user between firms.
--   The profile menu offers Connect to an active user who holds any unbound
--   work identity (one the token hook refuses work sign-in for), or while no
--   bound account carries the firm's current organization
--   (work_identity_connectable_provider, work_identity_bound_current): after a
--   move, until a work sign-in refreshes the stored claim. A same-account move whose claim is still stale is refused by
--   GoTrue and reported as link_stale ("sign in once"); a recreated account
--   reconnects from the menu after one refused work sign-in.
--   work_identity_bindings.organization_id records the organization at bind time.
--   The most recent Connect wins: begin consumes the user's earlier live intents
--   for the provider and releases every unbound identity of any provider, as a
--   completed connect does. A failed connect callback releases nothing: its
--   cookie is shared across tabs, so it may belong to the winning connect. A
--   stray it leaves keeps Connect in the menu, whose begin releases it.
--   begin and complete serialize on the user row (complete also with
--   accept_work_identity_invite, which locks it for update), so the one live
--   connect cannot overlap another write to the user's bindings.
--   Connecting a new, verified account for the firm's current organization
--   replaces every binding the user holds, a previous provider's included
--   (a firm has one provider): the old identities are
--   released, every other session of the user is revoked, the swap is audited
--   with both accounts and the user is notified.
--   A connect of the already-bound account never reaches complete: GoTrue
--   refuses the link ("Identity is already linked"), and the callback reports
--   what that means through work_identity_link_refusal (read only).
--   begin clears the user's orphaned bindings (identity row removed), so the
--   same subject linked again rebinds.
-- One binding per user and provider is a unique index (below). The duplicate
--   count on both hosted projects returned no rows on 2026-10-09, so no
--   reconcile precedes it. complete deletes the user's bindings before it
--   inserts, accept inserts only for a user with no binding or the same
--   subject, and complete maps a lost race on the subject to
--   work_identity_bound_elsewhere.

create unique index if not exists work_identity_bindings_user_provider_key
  on work_identity_bindings (user_id, provider);

-- A connect replacement notifies the user (see complete_work_identity_connect).
-- The CHECK is restated whole; the newest restatement is the one in force.
alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed',
    'access_requested','access_approved','access_denied',
    'mailbox_allowlist_drift',
    'mailbox_connected',
    'rail_template_updated',
    'ai_budget_threshold',
    'work_identity_replaced'
  ))
  not valid;

-- One rule for "connected" (#406), shared by the menu and the connect
-- callback: a bound account whose stored claim carries the firm's current
-- organization. The claim refreshes on a work sign-in; an identity that
-- carries no claim falls back to the organization recorded at bind time.
-- The organization of each of the user's live bound accounts for a provider
-- (a binding whose identity row is gone is not live). Matched through
-- work_identity_auth_provider, as the token hook and release do.
create or replace function work_identity_bound_orgs(p_user uuid, p_provider text)
returns setof text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.work_identity_org_claim(p_provider, i.identity_data), b.organization_id)
    from work_identity_bindings b join auth.identities i
      on i.user_id = p_user and i.provider = public.work_identity_auth_provider(b.provider)
     and i.provider_id = b.provider_subject
   where b.user_id = p_user and b.provider = p_provider;
$$;
revoke all on function work_identity_bound_orgs(uuid, text) from public, anon, authenticated;

create or replace function work_identity_bound_current(p_user uuid, p_provider text, p_org text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_org in (select public.work_identity_bound_orgs(p_user, p_provider));
$$;
revoke all on function work_identity_bound_current(uuid, text, text) from public, anon, authenticated;

-- An identity complete_work_identity_connect would accept for this user and
-- firm: the user's email, verified, the current organization.
create or replace function work_identity_acceptable(p_identity auth.identities, p_email text, p_provider text, p_org text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select lower(p_identity.identity_data ->> 'email') = lower(p_email)
     -- The literals ::boolean reads as true (accept_work_identity_invite casts),
     -- without raising on anything else.
     and lower(btrim(coalesce(p_identity.identity_data ->> 'email_verified', '')))
         in ('t', 'tr', 'tru', 'true', 'y', 'ye', 'yes', 'on', '1')
     and public.work_identity_org_claim(p_provider, p_identity.identity_data) = p_org;
$$;
revoke all on function work_identity_acceptable(auth.identities, text, text, text) from public, anon, authenticated;

-- An unbound work identity: the token hook refuses work sign-in while one
-- exists. Shared by the menu and the link refusal so they cannot drift.
create or replace function work_identity_has_unbound(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from auth.identities i
                  where i.user_id = p_user and i.provider not in ('email', 'phone')
                    and not exists (select 1 from work_identity_bindings b
                                     where b.user_id = p_user
                                       and public.work_identity_auth_provider(b.provider) = i.provider
                                       and b.provider_subject = i.provider_id));
$$;
revoke all on function work_identity_has_unbound(uuid) from public, anon, authenticated;

create or replace function work_identity_connectable_provider(p_user uuid)
-- security definer: it reads auth.identities, which service_role cannot select.
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select f.provider
    from users u join firm_identity_providers f on f.company_id = u.company_id
   where u.id = p_user and u.status = 'active'
     -- No bound account carries the firm's current organization (never
     -- connected, a provider switch, or an organization move)...
     and (not public.work_identity_bound_current(p_user, f.provider, f.organization_id)
          -- ...or any unbound work identity: a new account work sign-in linked
          -- and the hook refused (recreated account, new Workspace on the same
          -- domain), or a stray a failed connect left. begin releases it.
          -- ponytail: after a failed connect in the recreated-account case
          -- Connect returns only with the next refused work sign-in, whose
          -- not-connected copy points back to the menu.
          or public.work_identity_has_unbound(p_user));
$$;
revoke all on function work_identity_connectable_provider(uuid) from public, anon, authenticated;
grant execute on function work_identity_connectable_provider(uuid) to service_role;

-- What GoTrue's "Identity is already linked" refusal of a connect means for
-- this user (#406), as an error code the connect callback maps to copy:
-- already connected only with no stray linked and a bound account carrying the current
-- organization; a binding without it predates a move (stale); with no binding
-- the refused account was a stray, which the menu's Connect releases. Read
-- only: the callback's cookie may belong to another tab's winning connect.
create or replace function work_identity_link_refusal(p_user uuid)
-- security definer: it reads auth.identities, which service_role cannot select.
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_idp firm_identity_providers%rowtype;
begin
  select u.status into v_status from users u where u.id = p_user;
  if v_status is distinct from 'active' then return 'account_not_eligible'; end if;
  select f.* into v_idp from users u join firm_identity_providers f on f.company_id = u.company_id
   where u.id = p_user;
  if not found then return 'identity_provider_not_configured'; end if;
  -- A stray is linked: the refused account may be it, and the token hook
  -- refuses every work sign-in until it goes, so Connect again (its begin
  -- releases the stray).
  if public.work_identity_has_unbound(p_user) then return 'work_identity_ambiguous'; end if;
  if public.work_identity_bound_current(p_user, v_idp.provider, v_idp.organization_id) then
    return 'work_identity_already_connected';
  end if;
  -- A bound account whose stored claim predates the move: the same account
  -- refreshes it on its next work sign-in; a new one is connected instead.
  -- An orphaned binding (no identity row) does not count.
  if exists (select public.work_identity_bound_orgs(p_user, v_idp.provider)) then
    return 'work_identity_link_stale';
  end if;
  return 'work_identity_ambiguous';
end;
$$;
revoke all on function work_identity_link_refusal(uuid) from public, anon, authenticated;
grant execute on function work_identity_link_refusal(uuid) to service_role;

-- create or replace keeps the existing grants.
create or replace function begin_work_identity_connect(p_provider text, p_secret_digest text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_profile users%rowtype;
  v_idp firm_identity_providers%rowtype;
  v_intent work_identity_connect_intents%rowtype;
  v_orphaned jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not app_caller_live() or v_session is null then raise exception 'session_not_live'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'mfa_required'; end if;
  if p_secret_digest is null or p_secret_digest !~ '^[0-9a-f]{64}$' then raise exception 'invalid_secret'; end if;

  -- Serializes this user's begins and completions (complete takes the same
  -- lock), so at most one connect is ever live.
  select * into v_profile from users where id = v_user for no key update;
  if v_profile.status <> 'active' then raise exception 'account_not_eligible'; end if;
  select * into v_idp from firm_identity_providers
   where company_id = v_profile.company_id and provider = p_provider;
  if not found then raise exception 'identity_provider_not_configured'; end if;

  -- The most recent Connect wins: earlier live intents (abandoned, or another
  -- tab's) are consumed, so their callbacks fail as expired, and every unbound
  -- identity, including one they linked, is released.
  update work_identity_connect_intents set consumed_at = now()
   where user_id = v_user and provider = p_provider and consumed_at is null;
  -- ponytail: an invitation accept racing a Connect in another tab can lose
  -- the identity its work sign-in just linked; that accept fails and is retried.
  -- Every provider: the token hook refuses work sign-in for any unbound one.
  perform public.release_unbound_identities(v_user);
  -- A binding whose identity row is gone (unlinked through GoTrue) can never
  -- sign in, and would keep complete from accepting that subject linked again.
  with orphaned as (
    delete from work_identity_bindings b
     where b.user_id = v_user
       and not exists (select 1 from auth.identities i
                        where i.user_id = v_user and i.provider_id = b.provider_subject
                          -- The same mapping the token hook and release use:
                          -- one definition of a live binding.
                          and i.provider = public.work_identity_auth_provider(b.provider))
    returning b.provider, b.provider_subject, b.organization_id, b.via
  )
  select jsonb_agg(jsonb_build_object('provider', provider, 'provider_subject', provider_subject,
                                      'organization_id', organization_id, 'via', via))
    into v_orphaned from orphaned;
  if v_orphaned is not null then
    insert into audit_log (actor_id, action, detail) values (
      v_user, 'work_identity_released',
      jsonb_build_object('user_id', v_user, 'orphaned_bindings', v_orphaned));
  end if;

  insert into work_identity_connect_intents (user_id, session_id, provider, secret_digest)
  values (v_user, v_session, p_provider, p_secret_digest)
  returning * into v_intent;

  return jsonb_build_object(
    'provider', v_idp.provider, 'organization_id', v_idp.organization_id,
    'expires_at', v_intent.expires_at
  );
end;
$$;

-- create or replace keeps the existing grants.
create or replace function complete_work_identity_connect(
  p_secret_digest text, p_auth_code text, p_code_verifier text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_intent work_identity_connect_intents%rowtype;
  v_idp firm_identity_providers%rowtype;
  v_flow auth.flow_state%rowtype;
  v_candidates auth.identities[];
  v_identity auth.identities%rowtype;
  v_user_email text;
  v_error text;
  v_replaced jsonb;
  v_revoked int := 0;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not app_caller_live() or v_session is null then raise exception 'session_not_live'; end if;

  -- Serializes with begin and with accept, so the user's bindings cannot
  -- change under this completion. Before the intent row, as in begin.
  -- no key update: does not block audit/membership FK inserts.
  perform 1 from users where id = v_user for no key update;
  -- Read, not locked: accept and set_firm_identity_provider lock the provider
  -- and the user in opposite orders, so any lock here could deadlock with one.
  -- ponytail: a firm change mid-connect can record the old organization on the
  -- binding; bound_current reads the account's claim, so Connect is offered again.
  select f.* into v_idp from firm_identity_providers f
   where f.company_id = (select company_id from users where id = v_user);

  select * into v_intent from work_identity_connect_intents
   where user_id = v_user and session_id = v_session
     and consumed_at is null and expires_at > now()
     and p_secret_digest ~ '^[0-9a-f]{64}$'
     and public.constant_work_digest_equal(secret_digest, p_secret_digest)
   order by created_at desc limit 1
   for update;
  -- Overtaken by a later begin, or replayed. Nothing is released here: the
  -- stray keeps Connect offered (work_identity_has_unbound) and the next begin
  -- releases it.
  if not found then raise exception 'connect_intent_invalid'; end if;

  if v_idp.company_id is null or v_idp.provider is distinct from v_intent.provider then
    raise exception 'identity_provider_not_configured';
  end if;

  select * into v_flow from auth.flow_state f
   where f.auth_code = p_auth_code
     and f.linking_target_id = v_user
     and f.provider_type = public.work_identity_auth_provider(v_intent.provider)
     and f.code_challenge_method = 's256'
     and p_code_verifier is not null
     and f.code_challenge = rtrim(translate(encode(extensions.digest(p_code_verifier, 'sha256'), 'base64'), '+/', '-_'), '=')
     and f.created_at >= v_intent.created_at
     and f.auth_code_issued_at is not null
     and f.auth_code_issued_at > now() - interval '10 minutes'
   for update;
  if not found then raise exception 'connect_flow_invalid'; end if;

  select array_agg(i order by i.created_at) into v_candidates
    from auth.identities i
   where i.user_id = v_user
     and i.provider = public.work_identity_auth_provider(v_intent.provider)
     and i.created_at between v_flow.created_at and v_flow.auth_code_issued_at
     and not exists (
       select 1 from work_identity_bindings b
        where b.provider = v_intent.provider and b.provider_subject = i.provider_id
     );

  select lower(email) into v_user_email from auth.users where id = v_user;
  if coalesce(cardinality(v_candidates), 0) <> 1 then
    v_error := 'work_identity_ambiguous';
  else
    v_identity := v_candidates[1];
    if not coalesce(public.work_identity_acceptable(v_identity, v_user_email, v_intent.provider, v_idp.organization_id), false)
    then
      v_error := 'work_identity_mismatch';
    end if;
  end if;

  delete from auth.flow_state where id = v_flow.id;
  update work_identity_connect_intents set consumed_at = now() where id = v_intent.id;

  if v_error is not null then
    perform public.release_unbound_identities(v_user);
    return jsonb_build_object('connected', false, 'error', v_error);
  end if;

  -- #406: the new, verified account replaces the user's links, so a moved firm
  -- (new Workspace or tenant, or a provider switch) always recovers and one
  -- binding remains. Every binding the user holds is their own
  -- firm's: a connect is for the user's firm, and an invite binding is made only
  -- when a contained invitee joins the inviting firm. The old identity is
  -- released, or the token hook would refuse work sign-in for an unbound identity.
  with gone as (
    delete from work_identity_bindings where user_id = v_user
    returning provider, provider_subject, organization_id, via
  )
  select jsonb_agg(jsonb_build_object('provider', provider, 'provider_subject', provider_subject,
           'organization_id', organization_id, 'via', via))
    into v_replaced from gone;

  -- Another user binding this subject since the candidate check is refused as
  -- the invite path refuses it, not surfaced as a raw unique_violation.
  insert into work_identity_bindings (provider, provider_subject, user_id, organization_id, via)
  values (v_intent.provider, v_identity.provider_id, v_user, v_idp.organization_id, 'connect')
  on conflict (provider, provider_subject) do nothing;
  if not found then raise exception 'work_identity_bound_elsewhere'; end if;

  -- Any other unbound identity (a replaced account, or a stray linked outside
  -- this flow) would make the token hook refuse work sign-in.
  perform public.release_unbound_identities(v_user);
  if v_replaced is not null then
    -- As accept_work_identity_invite does: only the connecting session keeps
    -- refreshing after the account behind work sign-in changes.
    with revoked as (
      delete from auth.sessions s where s.user_id = v_user and s.id <> v_session
      returning 1
    )
    select count(*) into v_revoked from revoked;
    insert into notifications (tenant_id, recipient_id, event_type, payload)
    select u.tenant_id, v_user, 'work_identity_replaced',
           jsonb_build_object('provider', v_intent.provider, 'organizationId', v_idp.organization_id)
      from users u where u.id = v_user;
  end if;

  insert into audit_log (actor_id, action, detail) values (
    v_user, 'work_identity_connected',
    jsonb_build_object('user_id', v_user, 'provider', v_intent.provider,
      'provider_subject', v_identity.provider_id,
      'organization_id', v_idp.organization_id, 'via', 'connect',
      'replaced', coalesce(v_replaced, '[]'::jsonb), 'sessions_revoked', v_revoked)
  );
  return jsonb_build_object('connected', true, 'provider', v_intent.provider);
end;
$$;

-- #408: refuse an invitation from another firm for an active user (the
-- "no" answer: an invitation does not move a user between firms).
-- create or replace keeps the existing grants.
create or replace function accept_work_identity_invite(
  p_attempt_id uuid, p_secret_digest text, p_terms_version text, p_display_name text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
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

  -- The user row first, the order begin and complete use, so a Connect cannot
  -- release the identity read below before this accept binds it.
  select * into v_profile from users where id = v_user for update;

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

  -- #408: an invitation never moves an active user to another firm. Refuse it
  -- before any work-account check, so the user is not sent to connect an
  -- account that cannot help. The row is locked above, so this holds.
  if v_profile.status = 'active' and v_profile.company_id is distinct from v_invite.company_id then
    raise exception 'invite_other_firm';
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

  if not (
    (v_profile.provisioning = 'contained' and v_profile.status = 'invited' and v_profile.company_id is null)
    or (v_profile.status = 'active' and v_profile.company_id = v_invite.company_id and exists (
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

-- #408 on the email-code path: accept_invite (20261003100000) promotes the
-- profile into the invitation's company, so without this an email-code
-- invitation from a client company could move an active bank user across and
-- reset their password and factors. Same check as accept_work_identity_invite.
-- create or replace keeps the existing grants.
create or replace function accept_invite(
  p_invite_id uuid, p_nonce uuid, p_password text, p_tos_version text, p_display_name text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_user_email text;
  v_invite invites%rowtype;
  v_profile users%rowtype;
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
  -- The user row first, as accept_work_identity_invite takes it, so the #408
  -- check below holds until the profile is promoted.
  select * into v_profile from users where id = v_user for update;
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
  -- #408: an invitation never moves an active user to another firm, or resets
  -- their password and factors on the way.
  if v_profile.status = 'active' and v_profile.company_id is distinct from v_invite.company_id then
    raise exception 'invite_other_firm';
  end if;
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
