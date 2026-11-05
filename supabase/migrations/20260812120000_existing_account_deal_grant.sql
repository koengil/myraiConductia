-- Returning-account deal grants must carry the same tenancy, employer, wall,
-- and authority guarantees as create_invite.  Keep the membership write and
-- its audit record in this one transaction: a route-level insert followed by
-- an audit insert can otherwise leave an unaudited live seat.
create or replace function public.grant_existing_account_to_deal(
  p_actor uuid,
  p_email text,
  p_company_id uuid,
  p_deal_id uuid,
  p_deal_role text,
  p_phase int default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_actor users%rowtype;
  v_target users%rowtype;
  v_company companies%rowtype;
  v_deal deals%rowtype;
  v_role_id uuid;
  v_party_role text;
  v_expected_role text;
  v_can_manage_deal boolean;
  v_permitted boolean;
  v_phase int;
  v_membership_id uuid;
  v_target_count int;
begin
  if p_email is null
     or length(v_email) - length(replace(v_email, '@', '')) <> 1
     or split_part(v_email, '@', 1) = ''
     or split_part(v_email, '@', 2) = ''
     or v_email ~ '\s'
  then
    raise exception 'invalid_email';
  end if;
  -- Keep this lock order aligned with create_invite: actor, company, deal,
  -- actor seat, party, normalized-email advisory lock, then target. Row locks
  -- make revocations and company moves commit before a grant can observe them.
  select * into v_actor from users where id = p_actor for share;
  if not found then raise exception 'actor_not_found'; end if;
  select * into v_company from companies where id = p_company_id for share;
  if not found or v_company.tenant_id is distinct from v_actor.tenant_id then
    raise exception 'not_permitted';
  end if;
  select * into v_deal from deals where id = p_deal_id for share;
  if not found or v_deal.tenant_id is distinct from v_actor.tenant_id then
    raise exception 'not_permitted';
  end if;
  perform 1 from deal_memberships
    where deal_id = p_deal_id and user_id = p_actor for share;
  v_can_manage_deal := exists (
      select 1 from deal_memberships
       where deal_id = p_deal_id and user_id = p_actor and deal_role = 'md'
    )
    or coalesce(v_actor.company_role = 'director'
        and v_actor.company_id = v_deal.bank_id, false)
    or coalesce((
      select (access_scope->>'can_manage_members')::boolean from deal_memberships
       where deal_id = p_deal_id and user_id = p_actor
    ), false);

  v_permitted := coalesce(v_actor.firm_role = 'admin', false)
    or (
      coalesce(v_actor.is_external, false)
      and coalesce(v_actor.company_role = 'director'
        and v_actor.company_id = p_company_id, false)
      and exists (
        select 1 from deal_parties
         where deal_id = p_deal_id and company_id = v_actor.company_id for share
      )
    )
    or (not coalesce(v_actor.is_external, false) and v_can_manage_deal);
  if not coalesce(v_permitted, false) then raise exception 'not_permitted'; end if;

  if p_deal_role is null then
    raise exception 'invalid_deal_role';
  end if;
  if p_phase is null or p_phase < 0 then raise exception 'invalid_phase'; end if;
  if v_company.type <> 'bank' then
    select party_role into v_party_role from deal_parties
      where deal_id = p_deal_id and company_id = p_company_id for share;
    if v_party_role is null or p_deal_role not in ('seller', 'buyer') then
      raise exception 'invalid_deal_role';
    end if;
    v_expected_role := case
      when v_party_role in ('target', 'co_seller') then 'seller' else 'buyer'
    end;
    if p_deal_role is distinct from v_expected_role then
      raise exception 'invalid_deal_role';
    end if;
    v_phase := p_phase;
  else
    if p_deal_role not in ('deal_team', 'legal', 'read_only') then
      raise exception 'invalid_deal_role';
    end if;
    v_phase := 0;
  end if;

  select id into v_role_id from roles where slug = p_deal_role;
  if v_role_id is null then raise exception 'role_not_found'; end if;

  -- create_invite takes this same advisory lock after its authority and seat
  -- checks. Taking it here keeps create/fallback calls from deadlocking while
  -- serializing case-insensitive account lookup with a concurrent invite.
  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));
  select count(*) into v_target_count from users where lower(email) = v_email;
  if v_target_count <> 1 then
    -- users.email is case-sensitive. Never pick an arbitrary active account
    -- when legacy rows differ only by casing.
    raise exception 'existing_account_not_eligible';
  end if;
  select * into strict v_target from users where lower(email) = v_email for share;
  -- Do not turn the active-account oracle into a cross-tenant/company oracle.
  if not found
     or v_target.status <> 'active'
     or v_target.tenant_id is distinct from v_actor.tenant_id
     or v_target.company_id is distinct from p_company_id
     or v_target.is_external is distinct from (v_company.type <> 'bank') then
    raise exception 'existing_account_not_eligible';
  end if;

  -- Deliberate no-op policy: an existing seat is never silently upgraded or
  -- changed by an invite. Role changes use the explicit member-management flow.
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
  values (p_deal_id, v_target.id, v_role_id, p_deal_role, v_phase, p_actor)
  on conflict (deal_id, user_id) do nothing
  returning id into v_membership_id;

  if v_membership_id is null then
    return jsonb_build_object(
      'id', v_target.id, 'email', v_target.email, 'access_granted', false
    );
  end if;

  insert into audit_log (actor_id, action, deal_id, detail) values (
    p_actor,
    'grant',
    p_deal_id,
    jsonb_build_object(
      'reason', 'existing_account_added_to_deal',
      'user_id', v_target.id,
      'email', v_target.email,
      'deal_role', p_deal_role,
      'phase', v_phase
    )
  );
  return jsonb_build_object(
    'id', v_target.id, 'email', v_target.email, 'access_granted', true
  );
end;
$$;

revoke all on function public.grant_existing_account_to_deal(uuid, text, uuid, uuid, text, integer) from public;
grant execute on function public.grant_existing_account_to_deal(uuid, text, uuid, uuid, text, integer)
  to service_role;
