-- One tenant per organization (#156).
--
-- The leak: Conductia and Ignatious were both onboarded into the single
-- bootstrap tenant. `is_external` is derived from company type alone
-- (`v_company_type is distinct from 'bank'`), so a second BANK's staff clear it
-- and get treated as the first bank's internal staff. userCanSearchCompanies
-- then grants tenant-wide company search, and GET /api/v1/companies drops its
-- registered_by_company_id filter, so an Ignatious director could enumerate
-- Conductia's client leads.
--
-- The fix is structural: each onboarded organization gets its own tenant, and
-- the `.eq('tenant_id', ...)` scoping already present on every read does the
-- isolating. The visibility gates are deliberately NOT tightened here.
-- `registered_by_company_id` is null on bank rows and on every target that
-- create_deal_gate0 creates, so scoping non-overseers to it would hide a firm's
-- own targets from itself. That is tracked separately.
--
-- Two functions are carried forward verbatim with one change each: a firm admin
-- provisioning a company in another tenant adopts that company's tenant rather
-- than being refused. Without both, minting a tenant per organization makes the
-- owner invite in POST /api/v1/companies/onboard unsendable.
--
-- Deal guards are unchanged and still compare against the (possibly adopted)
-- tenant: a deal invite may never cross tenants.

-- Same drop-and-recreate pattern as 20260804160000 and 20260808120000.
revoke all on function public.create_invite(uuid, text, uuid, text, text, uuid, uuid, text, int) from public;

create or replace function public.create_invite(
  p_actor uuid,
  p_email text,
  p_company_id uuid,
  p_company_role text,
  p_challenge_digest text,
  p_domain_confirmation_id uuid default null,
  p_deal_id uuid default null,
  p_deal_role text default null,
  p_phase int default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    if coalesce(v_actor.firm_role = 'admin', false) then
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
$$;

revoke all on function public.prepare_invite_domain_confirmation() from public;

create or replace function public.prepare_invite_domain_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_tenant uuid;
  v_company_tenant uuid;
  v_deal_tenant uuid;
begin
  select tenant_id into v_actor_tenant from users where id = new.actor_id;
  if v_actor_tenant is null then
    raise exception 'actor_not_found';
  end if;

  select tenant_id into v_company_tenant from companies where id = new.company_id;
  if v_company_tenant is null then
    raise exception 'company_not_found';
  end if;
  -- Same firm-admin provisioning crossing as create_invite (#156). A brand-new
  -- org has no verified domains, so its owner invite always lands here first;
  -- refusing the crossing would make onboarding into a fresh tenant impossible.
  if v_company_tenant is distinct from v_actor_tenant then
    if coalesce((select firm_role from users where id = new.actor_id) = 'admin', false) then
      v_actor_tenant := v_company_tenant;
    else
      raise exception 'tenant_mismatch';
    end if;
  end if;

  if new.deal_id is not null then
    select tenant_id into v_deal_tenant from deals where id = new.deal_id;
    if v_deal_tenant is null then
      raise exception 'deal_not_found';
    end if;
    if v_deal_tenant is distinct from v_actor_tenant then
      raise exception 'tenant_mismatch';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.company_id::text, 1));

  new.email := lower(trim(new.email));
  if length(new.email) - length(replace(new.email, '@', '')) <> 1
     or split_part(new.email, '@', 1) = ''
     or split_part(new.email, '@', 2) = ''
     or new.email ~ '\s'
  then
    raise exception 'invalid_email';
  end if;

  new.tenant_id := v_actor_tenant;
  new.verified_domains_snapshot := company_verified_domain_snapshot(new.company_id);
  new.classification := public.classify_invite_email_domain(
    split_part(new.email, '@', 2),
    new.verified_domains_snapshot
  );
  new.created_at := now();
  new.expires_at := now() + interval '60 minutes';
  new.consumed_at := null;
  new.consumed_invite_id := null;
  return new;
end;
$$;
-- The trigger is re-attached because `create or replace function` keeps the
-- existing attachment, but re-declaring it here keeps this migration
-- self-contained and idempotent.
drop trigger if exists prepare_invite_domain_confirmation_row on invite_domain_confirmations;
create trigger prepare_invite_domain_confirmation_row
  before insert on invite_domain_confirmations
  for each row execute function public.prepare_invite_domain_confirmation();
