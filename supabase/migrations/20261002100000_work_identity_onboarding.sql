-- #316: banker work-identity onboarding (Google / Microsoft through Supabase).
--
-- Plan: docs/agent-duo/runs/316-c/plan-v1.md, sections 1a-1i.
--
-- 1a  Containment. Every new auth user lands as a contained, invited,
--     single-person-tenant profile. Nothing in client-writable user metadata
--     is read any more. A contained profile reaches a real tenant only through
--     an accepted invite or authorize_provisioned_profile (service role).
--     accept_invite now owns the whole password onboarding step: attest,
--     promote, set the password, end every other session, drop MFA factors.
-- 1b  firm_identity_providers: one Google domain (hd) or Microsoft tenant
--     (tid) per company, managed through set_firm_identity_provider.
-- 1c  invites.auth_method ('email_code' | 'work_identity'), immutable.
-- 1d  work_identity_attempts: the server-held secret that ties one OAuth
--     round trip to one invite generation.
-- 1e  work_identity_bindings + the custom access token hook + the
--     connect-an-identity flow for already active users.
-- 1f  app_caller_live(): browser-role callers need a live, unsuspended
--     session; every RLS helper fails closed without one.
-- 1g  accept_work_identity_invite.
-- 1h  five audit actions.
--
-- Rollback: supabase/rollback/20261002100000_work_identity_onboarding.sql
-- (refuses to run once any binding, work-identity invite or contained profile
-- exists).

-- ---------------------------------------------------------------------------
-- 1h  audit actions (chain trigger zz_audit_log_chain_append stays last; the
--     check stays `not valid` for the replay reason in 20260925100000).
-- ---------------------------------------------------------------------------
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
  'discovery.mailbox_sources_unified',
  'profile_provisioned',
  'identity_provider_configured',
  'identity_provider_removed',
  'work_identity_released',
  'work_identity_connected'
])) not valid;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table users add column provisioning text not null default 'authorized'
  check (provisioning in ('authorized', 'contained'));

alter table invites add column auth_method text not null default 'email_code'
  check (auth_method in ('email_code', 'work_identity'));
alter table invites add column challenge_verified_session_id uuid;
alter table invites add constraint invites_challenge_session_check
  check (challenge_verified_session_id is null or challenge_verified_at is not null);
alter table invites add constraint invites_work_identity_no_challenge_check
  check (auth_method = 'email_code' or challenge_digest is null);

create or replace function invites_auth_method_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.auth_method is distinct from old.auth_method then
    raise exception 'auth_method_immutable';
  end if;
  return new;
end;
$$;
create trigger invites_auth_method_immutable
  before update of auth_method on invites
  for each row execute function invites_auth_method_immutable();

create table firm_identity_providers (
  company_id uuid primary key references companies(id) on delete cascade,
  provider text not null check (provider in ('google', 'azure')),
  organization_id text not null check (length(organization_id) between 3 and 255),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table work_identity_attempts (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references invites(id) on delete cascade,
  credential_nonce uuid not null,
  secret_digest text not null check (secret_digest ~ '^[0-9a-f]{64}$'),
  -- S256 PKCE challenge of the OAuth flow this attempt was issued for (F14):
  -- claiming requires the verifier that flow's code was exchanged with.
  code_challenge text check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  claimed_user_id uuid references users(id) on delete cascade,
  claimed_session_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  consumed_at timestamptz,
  check ((claimed_user_id is null) = (claimed_session_id is null))
);
create index work_identity_attempts_invite_idx on work_identity_attempts (invite_id);

create table work_identity_bindings (
  provider text not null check (provider in ('google', 'azure')),
  provider_subject text not null,
  user_id uuid not null references users(id) on delete cascade,
  organization_id text not null,
  via text not null check (via in ('invite', 'connect')),
  bound_at timestamptz not null default now(),
  primary key (provider, provider_subject)
);
create index work_identity_bindings_user_idx on work_identity_bindings (user_id);

create table work_identity_connect_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid not null,
  provider text not null check (provider in ('google', 'azure')),
  secret_digest text not null check (secret_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz
);
create index work_identity_connect_intents_user_idx on work_identity_connect_intents (user_id);

-- Service-role only: RLS on with no policy, and no browser-role grant
-- (TRUNCATE ignores RLS).
-- Test-only broker alias: a local stack cannot run Supabase's google/azure
-- providers against a mock issuer, so the mock OIDC signs in as `keycloak` and
-- this table says which work provider it stands for. Production never has rows.
create table work_identity_broker_aliases (
  provider text primary key check (provider in ('google', 'azure')),
  broker_provider text not null check (broker_provider = 'keycloak')
);

alter table firm_identity_providers enable row level security;
alter table work_identity_broker_aliases enable row level security;
alter table work_identity_attempts enable row level security;
alter table work_identity_bindings enable row level security;
alter table work_identity_connect_intents enable row level security;
revoke all on firm_identity_providers, work_identity_attempts, work_identity_bindings,
  work_identity_connect_intents, work_identity_broker_aliases from anon, authenticated;
grant select, insert, update, delete on firm_identity_providers, work_identity_attempts,
  work_identity_bindings, work_identity_connect_intents, work_identity_broker_aliases to service_role;

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------
create or replace function app_min_password_length()
returns integer language sql immutable set search_path = public as $$ select 6 $$;

-- The auth.identities.provider a work provider signs in as: its broker alias
-- when one exists, else itself.
create or replace function work_identity_auth_provider(p_provider text)
returns text language sql stable set search_path = public as $$
  select coalesce(
    (select broker_provider from work_identity_broker_aliases where provider = p_provider),
    p_provider);
$$;

-- The org claim a provider reports for an identity: Google's hosted domain,
-- Microsoft's tenant id. Lower-cased so a domain compares case-insensitively.
create or replace function work_identity_org_claim(p_provider text, p_identity_data jsonb)
returns text language sql immutable set search_path = public as $$
  select lower(case p_provider
    when 'google' then p_identity_data #>> '{custom_claims,hd}'
    when 'azure' then p_identity_data #>> '{custom_claims,tid}'
  end);
$$;

create or replace function work_identity_session_id()
returns uuid language sql stable set search_path = public as $$
  select case when (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (auth.jwt() ->> 'session_id')::uuid end;
$$;

-- ---------------------------------------------------------------------------
-- 1f  app_caller_live and the RLS helpers
-- ---------------------------------------------------------------------------
-- A browser-role caller (authenticated / anon, the PostgREST SET ROLE) is live
-- only while its profile is not suspended and its JWT session still exists in
-- auth.sessions: deleting the session row ends database access at once instead
-- of when the access token expires. Service-role requests and direct database
-- sessions are unaffected.
create or replace function app_caller_live()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
      or (
        exists (select 1 from users where id = auth.uid() and status <> 'suspended')
        and exists (
          select 1 from auth.sessions
           where id = public.work_identity_session_id() and user_id = auth.uid()
        )
      );
$$;

create or replace function app_is_overseer(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select app_caller_live()
     and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from users where id = p_user and firm_role in ('cco', 'admin'));
$$;

create or replace function app_user_tenant(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select tenant_id from users
  where id = p_user
    and app_caller_live()
    and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'));
$$;

create or replace function app_user_company(p_user uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select company_id from users
  where id = p_user
    and app_caller_live()
    and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'));
$$;

create or replace function app_is_deal_member(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select app_caller_live()
     and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from deal_memberships where deal_id = p_deal and user_id = p_user);
$$;

create or replace function app_is_deal_md(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select app_caller_live()
     and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (
       select 1 from deal_memberships m join roles r on r.id = m.role_id
       where m.deal_id = p_deal and m.user_id = p_user and r.slug = 'md'
     );
$$;

create or replace function app_user_is_director(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select app_caller_live()
     and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
     and exists (select 1 from users where id = p_user and company_role = 'director');
$$;

create or replace function app_is_deal_overseer(p_deal uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select app_caller_live()
     and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
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
  select not app_caller_live()
      or not (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
      or coalesce((select is_external from users where id = p_user), true);
$$;

create or replace function app_actor_in_user_tenant(p_actor uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select app_caller_live()
     and (p_user = auth.uid() or coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon'))
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

-- ---------------------------------------------------------------------------
-- 1a  containment
-- ---------------------------------------------------------------------------
-- Every new auth user is contained: invited, external, alone in a tenant named
-- after itself. Signup metadata is client-writable and is never read.
create or replace function handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (
    id, tenant_id, email, full_name, display_name, is_external,
    firm_role, department, company_id, company_role, status, provisioning
  ) values (
    new.id, new.id, new.email,
    coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'user'),
    null, true, null, null, null, null, 'invited', 'contained'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Trusted provisioning (seed scripts, admin tooling) promotes a contained
-- profile. Service role only.
create or replace function authorize_provisioned_profile(p_user_id uuid, p_profile jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user users%rowtype;
  v_profile jsonb := coalesce(p_profile, '{}'::jsonb);
begin
  select * into v_user from users where id = p_user_id for update;
  if not found then raise exception 'profile_not_found'; end if;
  if v_user.provisioning <> 'contained' or v_user.company_id is not null then
    raise exception 'profile_not_contained';
  end if;

  update users set
    tenant_id = coalesce((v_profile ->> 'tenant_id')::uuid, '00000000-0000-4000-8000-000000000001'),
    full_name = coalesce(nullif(v_profile ->> 'full_name', ''), full_name),
    display_name = v_profile ->> 'display_name',
    firm_role = v_profile ->> 'firm_role',
    department = v_profile ->> 'department',
    is_external = coalesce((v_profile ->> 'is_external')::boolean, false),
    company_id = (v_profile ->> 'company_id')::uuid,
    company_role = v_profile ->> 'company_role',
    status = coalesce(v_profile ->> 'status', 'active'),
    provisioning = 'authorized'
  where id = p_user_id
  returning * into v_user;

  insert into audit_log (actor_id, action, detail) values (
    p_user_id, 'profile_provisioned',
    jsonb_build_object(
      'user_id', p_user_id, 'tenant_id', v_user.tenant_id, 'firm_role', v_user.firm_role,
      'company_id', v_user.company_id, 'company_role', v_user.company_role,
      'is_external', v_user.is_external, 'status', v_user.status
    )
  );

  return jsonb_build_object(
    'user_id', v_user.id, 'tenant_id', v_user.tenant_id, 'status', v_user.status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 1b  firm identity providers
-- ---------------------------------------------------------------------------
create or replace function set_firm_identity_provider(
  p_actor uuid, p_company_id uuid, p_provider text, p_organization_id text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor users%rowtype;
  v_company_tenant uuid;
  v_old firm_identity_providers%rowtype;
  v_org text;
begin
  select * into v_actor from users where id = p_actor for share;
  if not found then raise exception 'actor_not_found'; end if;
  select tenant_id into v_company_tenant from companies where id = p_company_id for share;
  if v_company_tenant is null then raise exception 'company_not_found'; end if;
  if not (
    coalesce(v_actor.status = 'active', false)
    and (
      coalesce(v_actor.firm_role = 'admin' and v_actor.tenant_id = v_company_tenant, false)
      or coalesce(v_actor.company_role = 'director' and v_actor.company_id = p_company_id, false)
    )
  ) then
    raise exception 'not_permitted';
  end if;

  select * into v_old from firm_identity_providers where company_id = p_company_id for update;

  if p_provider is null then
    if v_old.company_id is null then
      return jsonb_build_object('company_id', p_company_id, 'removed', false);
    end if;
    delete from firm_identity_providers where company_id = p_company_id;
    insert into audit_log (actor_id, action, detail) values (
      p_actor, 'identity_provider_removed',
      jsonb_build_object('company_id', p_company_id,
        'old', jsonb_build_object('provider', v_old.provider, 'organization_id', v_old.organization_id))
    );
    return jsonb_build_object('company_id', p_company_id, 'removed', true);
  end if;

  if p_provider not in ('google', 'azure') then raise exception 'invalid_provider'; end if;
  v_org := lower(trim(p_organization_id));
  if v_org is null or length(v_org) not between 3 and 255 or v_org ~ '\s' then
    raise exception 'invalid_organization_id';
  end if;

  insert into firm_identity_providers (company_id, provider, organization_id, updated_by, updated_at)
  values (p_company_id, p_provider, v_org, p_actor, now())
  on conflict (company_id) do update set
    provider = excluded.provider, organization_id = excluded.organization_id,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  insert into audit_log (actor_id, action, detail) values (
    p_actor, 'identity_provider_configured',
    jsonb_build_object(
      'company_id', p_company_id,
      'old', case when v_old.company_id is null then null
             else jsonb_build_object('provider', v_old.provider, 'organization_id', v_old.organization_id) end,
      'new', jsonb_build_object('provider', p_provider, 'organization_id', v_org)
    )
  );
  return jsonb_build_object('company_id', p_company_id, 'provider', p_provider, 'organization_id', v_org);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1c  create_invite gains a trailing p_auth_method
-- ---------------------------------------------------------------------------
drop function create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer);
create function public.create_invite(p_actor uuid, p_email text, p_company_id uuid, p_company_role text, p_challenge_digest text, p_domain_confirmation_id uuid DEFAULT NULL::uuid, p_deal_id uuid DEFAULT NULL::uuid, p_deal_role text DEFAULT NULL::text, p_phase integer DEFAULT 0, p_auth_method text DEFAULT 'email_code'::text)
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

-- A rotation starts a new generation: a new nonce invalidates every
-- outstanding work-identity attempt, and a verified challenge is cleared with
-- its session. A work-identity invite still has no code to rotate.
create or replace function rotate_invite_credential(p_invite_id uuid, p_challenge_digest text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_invite invites%rowtype;
begin
  select * into v_invite from invites where id = p_invite_id for update;
  if not found or v_invite.status <> 'pending' then raise exception 'not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'not_pending'; end if;
  if v_invite.auth_method = 'email_code'
     and (p_challenge_digest is null or p_challenge_digest !~ '^[0-9a-f]{64}$')
  then
    raise exception 'challenge_required';
  end if;

  update invites
     set credential_nonce = gen_random_uuid(),
         delivery_status = 'unsent',
         expires_at = now() + interval '24 hours',
         challenge_digest = case when auth_method = 'email_code' then p_challenge_digest end,
         challenge_version = case when auth_method = 'email_code' then challenge_version + 1 else 0 end,
         challenge_issued_at = case when auth_method = 'email_code' then now() end,
         challenge_attempts = 0,
         challenge_locked_at = null,
         challenge_verified_at = null,
         challenge_verified_user_id = null,
         challenge_verified_version = null,
         challenge_verified_session_id = null
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
    'challenge_version', v_invite.challenge_version,
    'auth_method', v_invite.auth_method
  );
end;
$$;

-- An authorized profile must already be in the invite's tenant; a contained
-- profile (alone in its own tenant, no company) is compatible with any.
create or replace function invite_tenant_compatible(p_invite_tenant uuid, p_user uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from users u
     where u.id = p_user
       and (u.tenant_id = p_invite_tenant
            or (u.provisioning = 'contained' and u.company_id is null and u.tenant_id = u.id))
  );
$$;

create or replace function verify_invite_challenge(p_invite_id uuid, p_nonce uuid, p_code_digest text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_user_email text;
  v_invite invites%rowtype;
  v_attempts integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not app_caller_live() or v_session is null then raise exception 'session_not_live'; end if;
  select lower(email) into v_user_email from auth.users where id = v_user;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found then raise exception 'invite_not_found'; end if;
  if v_invite.status <> 'pending' then raise exception 'invite_not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'invite_expired'; end if;
  if v_invite.credential_nonce is distinct from p_nonce then raise exception 'credential_mismatch'; end if;
  if v_invite.email is distinct from v_user_email then raise exception 'email_mismatch'; end if;
  if not public.invite_tenant_compatible(v_invite.tenant_id, v_user) then raise exception 'tenant_mismatch'; end if;
  if v_invite.auth_method <> 'email_code' then raise exception 'invite_method_mismatch'; end if;
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
           challenge_verified_version = challenge_version,
           challenge_verified_session_id = v_session
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
$$;

-- Shared tail of both acceptance paths: membership, grant audit and the
-- invite_accepted audit.
create or replace function invite_grant_membership(p_invite invites, p_user uuid)
returns void language plpgsql set search_path = public as $$
declare
  v_role_id uuid;
begin
  if p_invite.deal_id is not null then
    select id into v_role_id from roles where slug = p_invite.deal_role;
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (p_invite.deal_id, p_user, v_role_id, p_invite.deal_role, p_invite.phase, p_invite.invited_by)
    on conflict (deal_id, user_id) do nothing;

    insert into audit_log (actor_id, action, deal_id, detail) values (
      p_invite.invited_by, 'grant', p_invite.deal_id,
      jsonb_build_object(
        'user_id', p_user, 'deal_role', p_invite.deal_role, 'phase', p_invite.phase, 'via', 'invite'
      )
    );
  end if;

  insert into audit_log (actor_id, action, deal_id, detail) values (
    p_user, 'invite_accepted', p_invite.deal_id,
    jsonb_build_object('invite_id', p_invite.id, 'email', p_invite.email)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 1a  accept_invite: the whole password onboarding step in one transaction
-- ---------------------------------------------------------------------------
drop function accept_invite(uuid, uuid);

create function accept_invite(
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

-- ---------------------------------------------------------------------------
-- 1d  work-identity attempts
-- ---------------------------------------------------------------------------
create or replace function start_work_identity_attempt(p_invite_id uuid, p_nonce uuid, p_secret_digest text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_invite invites%rowtype;
  v_idp firm_identity_providers%rowtype;
  v_attempt_id uuid;
begin
  if p_secret_digest is null or p_secret_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_secret';
  end if;
  select * into v_invite from invites where id = p_invite_id for share;
  if not found then raise exception 'invite_not_found'; end if;
  if v_invite.status <> 'pending' then raise exception 'invite_not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'invite_expired'; end if;
  if v_invite.credential_nonce is distinct from p_nonce then raise exception 'credential_mismatch'; end if;
  if v_invite.auth_method <> 'work_identity' then raise exception 'invite_method_mismatch'; end if;
  if v_invite.delivery_status <> 'sent' then raise exception 'invite_not_sent'; end if;
  select * into v_idp from firm_identity_providers where company_id = v_invite.company_id for share;
  if not found then raise exception 'identity_provider_not_configured'; end if;

  insert into work_identity_attempts (invite_id, credential_nonce, secret_digest)
  values (v_invite.id, v_invite.credential_nonce, p_secret_digest)
  returning id into v_attempt_id;

  return jsonb_build_object(
    'attempt_id', v_attempt_id, 'provider', v_idp.provider,
    'organization_id', v_idp.organization_id, 'email', v_invite.email
  );
end;
$$;

-- Binds an issued attempt to the PKCE challenge of the OAuth flow the start
-- route opened for it. Once only: a second flow can never adopt the attempt.
create or replace function bind_work_identity_attempt_flow(
  p_attempt_id uuid, p_secret_digest text, p_code_challenge text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_attempt work_identity_attempts%rowtype;
begin
  select * into v_attempt from work_identity_attempts where id = p_attempt_id for update;
  if not found or p_secret_digest is null or p_secret_digest !~ '^[0-9a-f]{64}$'
     or not public.constant_work_digest_equal(v_attempt.secret_digest, p_secret_digest)
  then
    raise exception 'attempt_invalid';
  end if;
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'attempt_flow_mismatch';
  end if;
  if v_attempt.code_challenge is not null or v_attempt.claimed_user_id is not null
     or v_attempt.consumed_at is not null
  then
    raise exception 'attempt_claimed';
  end if;
  update work_identity_attempts set code_challenge = p_code_challenge where id = p_attempt_id;
end;
$$;

-- Service role only (F14, review round 2). The callback calls it right after
-- its own successful PKCE exchange, passing that exchange's user and session.
-- An authenticated caller can never present an arbitrary verifier for an
-- attempt its session was not exchanged with.
create or replace function claim_work_identity_attempt(
  p_attempt_id uuid, p_secret_digest text, p_code_verifier text,
  p_user_id uuid, p_session_id uuid
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := p_user_id;
  v_session uuid := p_session_id;
  v_session_created timestamptz;
  v_attempt work_identity_attempts%rowtype;
begin
  if v_user is null or v_session is null then raise exception 'session_not_live'; end if;
  select s.created_at into v_session_created
    from auth.sessions s where s.id = v_session and s.user_id = v_user;
  if not found then raise exception 'session_not_live'; end if;
  select * into v_attempt from work_identity_attempts where id = p_attempt_id for update;
  if not found or p_secret_digest is null or p_secret_digest !~ '^[0-9a-f]{64}$'
     or not public.constant_work_digest_equal(v_attempt.secret_digest, p_secret_digest)
  then
    raise exception 'attempt_invalid';
  end if;
  -- The session presenting this attempt must come from the attempt's own
  -- OAuth flow: the verifier its code was exchanged with hashes to the
  -- challenge bound at start. A cookie from another flow fails here (F14).
  if v_attempt.code_challenge is null or p_code_verifier is null
     or v_attempt.code_challenge is distinct from
        rtrim(translate(encode(extensions.digest(p_code_verifier, 'sha256'), 'base64'), '+/', '-_'), '=')
  then
    raise exception 'attempt_flow_mismatch';
  end if;
  -- The exchanged session is minted by this flow, so it postdates the attempt;
  -- an older session cannot adopt a newer attempt.
  if v_session_created < v_attempt.created_at then raise exception 'attempt_flow_mismatch'; end if;
  if v_attempt.consumed_at is not null then raise exception 'attempt_consumed'; end if;
  if v_attempt.expires_at <= now() then raise exception 'attempt_expired'; end if;
  if v_attempt.claimed_user_id is not null then
    if v_attempt.claimed_user_id = v_user and v_attempt.claimed_session_id = v_session then
      return jsonb_build_object('attempt_id', v_attempt.id, 'claimed', true);
    end if;
    raise exception 'attempt_claimed';
  end if;

  update work_identity_attempts
     set claimed_user_id = v_user, claimed_session_id = v_session
   where id = p_attempt_id;
  return jsonb_build_object('attempt_id', v_attempt.id, 'claimed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1g  accept_work_identity_invite
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 1e  custom access token hook
-- ---------------------------------------------------------------------------
-- Runs inside GoTrue for every token issue, refresh included. A suspended
-- account gets no token at all. An OAuth sign-in gets one only when every
-- external identity on the account is bound to it (by invite or by connect),
-- or when the account is a contained invitee with a live work-identity invite
-- (it is bound at acceptance). Everything else passes unchanged.
create or replace function work_identity_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_user uuid := (event ->> 'user_id')::uuid;
  v_profile users%rowtype;
begin
  select * into v_profile from users where id = v_user;
  if v_profile.status = 'suspended' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'account_suspended'));
  end if;

  if event ->> 'authentication_method' = 'oauth' then
    if exists (
      select 1 from auth.identities i
       where i.user_id = v_user
         and i.provider not in ('email', 'phone')
         and not exists (
           select 1 from work_identity_bindings b
            where public.work_identity_auth_provider(b.provider) = i.provider
              and b.provider_subject = i.provider_id and b.user_id = v_user
         )
    ) and not (
      v_profile.provisioning = 'contained'
      and v_profile.status = 'invited'
      and v_profile.company_id is null
      and v_profile.tenant_id = v_profile.id
      and exists (
        select 1 from invites
         where email = lower(v_profile.email)
           and status = 'pending' and expires_at > now() and auth_method = 'work_identity'
      )
    ) then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'work_identity_not_connected'));
    end if;
  end if;

  return jsonb_build_object('claims', event -> 'claims');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1e  connect a work identity to an active account
-- ---------------------------------------------------------------------------
create or replace function release_unbound_identities(p_user_id uuid, p_provider text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_released text[];
begin
  with gone as (
    delete from auth.identities i
     where i.user_id = p_user_id
       and i.provider not in ('email', 'phone')
       and (p_provider is null or i.provider = public.work_identity_auth_provider(p_provider))
       and not exists (
         select 1 from work_identity_bindings b
          where public.work_identity_auth_provider(b.provider) = i.provider
            and b.provider_subject = i.provider_id and b.user_id = p_user_id
       )
    returning i.provider
  )
  select array_agg(provider) into v_released from gone;

  if v_released is not null then
    insert into audit_log (actor_id, action, detail) values (
      p_user_id, 'work_identity_released',
      jsonb_build_object('user_id', p_user_id, 'providers', to_jsonb(v_released),
        'count', cardinality(v_released))
    );
  end if;
  return coalesce(cardinality(v_released), 0);
end;
$$;

create or replace function begin_work_identity_connect(p_provider text, p_secret_digest text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.work_identity_session_id();
  v_profile users%rowtype;
  v_idp firm_identity_providers%rowtype;
  v_intent work_identity_connect_intents%rowtype;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not app_caller_live() or v_session is null then raise exception 'session_not_live'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'mfa_required'; end if;
  if p_secret_digest is null or p_secret_digest !~ '^[0-9a-f]{64}$' then raise exception 'invalid_secret'; end if;

  select * into v_profile from users where id = v_user for share;
  if v_profile.status <> 'active' then raise exception 'account_not_eligible'; end if;
  select * into v_idp from firm_identity_providers
   where company_id = v_profile.company_id and provider = p_provider;
  if not found then raise exception 'identity_provider_not_configured'; end if;

  -- A half-finished earlier attempt must not leave an identity behind that a
  -- later one could mistake for its own.
  perform public.release_unbound_identities(v_user, p_provider);

  insert into work_identity_connect_intents (user_id, session_id, provider, secret_digest)
  values (v_user, v_session, p_provider, p_secret_digest)
  returning * into v_intent;

  return jsonb_build_object(
    'provider', v_idp.provider, 'organization_id', v_idp.organization_id,
    'expires_at', v_intent.expires_at
  );
end;
$$;

-- Verifies the linking flow GoTrue just completed (the PKCE flow_state row it
-- left for this user) instead of exchanging its code, so no session is ever
-- issued for an unbound identity. A refusal after the intent is valid still
-- commits: the candidate identities are released, the intent is consumed and
-- the outcome is audited, and the result carries {connected:false, error}.
create or replace function complete_work_identity_connect(
  p_secret_digest text, p_auth_code text, p_code_verifier text
) returns jsonb language plpgsql security definer set search_path = public as $$
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
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not app_caller_live() or v_session is null then raise exception 'session_not_live'; end if;

  select * into v_intent from work_identity_connect_intents
   where user_id = v_user and session_id = v_session and consumed_at is null and expires_at > now()
     and p_secret_digest ~ '^[0-9a-f]{64}$'
     and public.constant_work_digest_equal(secret_digest, p_secret_digest)
   order by created_at desc limit 1
   for update;
  if not found then raise exception 'connect_intent_invalid'; end if;

  select * into v_idp from firm_identity_providers
   where company_id = (select company_id from users where id = v_user) and provider = v_intent.provider;
  if not found then raise exception 'identity_provider_not_configured'; end if;

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
    if lower(v_identity.identity_data ->> 'email') is distinct from v_user_email
       or not coalesce((v_identity.identity_data ->> 'email_verified')::boolean, false)
       or public.work_identity_org_claim(v_intent.provider, v_identity.identity_data)
          is distinct from v_idp.organization_id
    then
      v_error := 'work_identity_mismatch';
    end if;
  end if;

  delete from auth.flow_state where id = v_flow.id;
  update work_identity_connect_intents set consumed_at = now() where id = v_intent.id;

  if v_error is not null then
    perform public.release_unbound_identities(v_user, v_intent.provider);
    return jsonb_build_object('connected', false, 'error', v_error);
  end if;

  insert into work_identity_bindings (provider, provider_subject, user_id, organization_id, via)
  values (v_intent.provider, v_identity.provider_id, v_user, v_idp.organization_id, 'connect');

  insert into audit_log (actor_id, action, detail) values (
    v_user, 'work_identity_connected',
    jsonb_build_object('user_id', v_user, 'provider', v_intent.provider,
      'organization_id', v_idp.organization_id, 'via', 'connect')
  );
  return jsonb_build_object('connected', true, 'provider', v_intent.provider);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Definer functions start closed (revoke from public), then open to
-- exactly the role that calls them.
-- ---------------------------------------------------------------------------
revoke all on function app_caller_live() from public, anon;
grant execute on function app_caller_live() to authenticated, service_role;

revoke all on function handle_new_auth_user() from public, anon, authenticated;
grant execute on function handle_new_auth_user() to service_role;

revoke all on function authorize_provisioned_profile(uuid, jsonb) from public, anon, authenticated;
grant execute on function authorize_provisioned_profile(uuid, jsonb) to service_role;

revoke all on function set_firm_identity_provider(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function set_firm_identity_provider(uuid, uuid, text, text) to service_role;

revoke all on function create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer, text) from public, anon, authenticated;
grant execute on function create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer, text) to service_role;

revoke all on function rotate_invite_credential(uuid, text) from public, anon, authenticated;
grant execute on function rotate_invite_credential(uuid, text) to service_role;

revoke all on function verify_invite_challenge(uuid, uuid, text) from public, anon;
grant execute on function verify_invite_challenge(uuid, uuid, text) to authenticated, service_role;

revoke all on function accept_invite(uuid, uuid, text, text, text) from public, anon;
grant execute on function accept_invite(uuid, uuid, text, text, text) to authenticated, service_role;

revoke all on function start_work_identity_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function start_work_identity_attempt(uuid, uuid, text) to service_role;

revoke all on function bind_work_identity_attempt_flow(uuid, text, text) from public, anon, authenticated;
grant execute on function bind_work_identity_attempt_flow(uuid, text, text) to service_role;

revoke all on function claim_work_identity_attempt(uuid, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function claim_work_identity_attempt(uuid, text, text, uuid, uuid) to service_role;

revoke all on function accept_work_identity_invite(uuid, text, text, text) from public, anon;
grant execute on function accept_work_identity_invite(uuid, text, text, text) to authenticated, service_role;

revoke all on function begin_work_identity_connect(text, text) from public, anon;
grant execute on function begin_work_identity_connect(text, text) to authenticated, service_role;

revoke all on function complete_work_identity_connect(text, text, text) from public, anon;
grant execute on function complete_work_identity_connect(text, text, text) to authenticated, service_role;

revoke all on function release_unbound_identities(uuid, text) from public, anon, authenticated;
grant execute on function release_unbound_identities(uuid, text) to service_role;

revoke all on function work_identity_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function work_identity_access_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;

-- Non-definer helpers are internal; only definer functions call them.
revoke all on function invite_tenant_compatible(uuid, uuid) from public, anon, authenticated;
revoke all on function work_identity_auth_provider(text) from public, anon, authenticated;
revoke all on function invite_grant_membership(invites, uuid) from public, anon, authenticated;
revoke all on function invites_auth_method_immutable() from public, anon, authenticated;
