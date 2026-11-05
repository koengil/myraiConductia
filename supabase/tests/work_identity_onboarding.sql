-- #316 work-identity onboarding: containment, provisioning, firm identity
-- providers, work-identity invitations, the email-code acceptance hardening,
-- the access-token hook, account connection and the live-caller RLS guard.
--
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/work_identity_onboarding.sql
-- Everything runs in one transaction and rolls back.
begin;

-- Fixed ids so impersonated statements need no fixture table.
--   tenant   31600000-0000-4000-8000-000000000001
--   bank     31600000-0000-4000-8000-0000000000b1
--   director 31600000-0000-4000-8000-0000000000d1  dir@bank.dev
--   member   31600000-0000-4000-8000-0000000000d2  plain@bank.dev
--   invitee  31600000-0000-4000-8000-0000000000a1  ivy@bank.dev   (work identity)
--   stranger 31600000-0000-4000-8000-0000000000a2  otto@bank.dev  (no invitation)
--   emma     31600000-0000-4000-8000-0000000000a3  emma@bank.dev  (email code)

-- S256 PKCE challenge, as GoTrue computes it (F14 flow binding).
create function pg_temp.s256(p_verifier text) returns text
language sql as $$
  select rtrim(translate(encode(extensions.digest(p_verifier, 'sha256'), 'base64'), '+/', '-_'), '=')
$$;

create function pg_temp.expect_error(p_sql text, p_code text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL: expected % from: %', p_code, p_sql;
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  if sqlerrm <> p_code then
    raise exception 'FAIL: expected % from %, got %', p_code, p_sql, sqlerrm;
  end if;
end;
$$;

-- Impersonate an authenticated caller with a session and assurance level.
create function pg_temp.act_as(p_user uuid, p_session uuid, p_aal text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated', 'session_id', p_session, 'aal', p_aal)::text, true);
  execute 'set local role authenticated';
end;
$$;

create function pg_temp.act_as_server() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;

create function pg_temp.sess(p_id uuid, p_user uuid, p_aal text) returns void
language sql as $$
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (p_id, p_user, now(), now(), p_aal::auth.aal_level);
$$;

-- p_claims are merged over the base claims, e.g. the session's amr on a refresh.
create function pg_temp.hook(p_user uuid, p_method text, p_claims jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select public.work_identity_access_token_hook(jsonb_build_object(
    'user_id', p_user, 'authentication_method', p_method,
    'claims', jsonb_build_object('sub', p_user, 'role', 'authenticated') || coalesce(p_claims, '{}'::jsonb)));
$$;

-- The project revokes default EXECUTE from PUBLIC, so open the probe helpers to
-- the impersonated role explicitly.
grant execute on function pg_temp.expect_error(text, text), pg_temp.act_as(uuid, uuid, text),
  pg_temp.act_as_server() to authenticated;

-- ---------------------------------------------------------------------------
-- AC2 containment: a new auth user never takes authority from its metadata
-- ---------------------------------------------------------------------------
do $$
declare
  v users%rowtype;
begin
  insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at) values
    ('31600000-0000-4000-8000-0000000000d1', 'dir@bank.dev',
      jsonb_build_object('tenant_id', '31600000-0000-4000-8000-000000000001',
                         'firm_role', 'admin', 'is_external', false, 'full_name', 'Mallory'),
      now(), now());
  select * into v from users where id = '31600000-0000-4000-8000-0000000000d1';
  if v.provisioning <> 'contained' or v.status <> 'invited' or v.tenant_id <> v.id
     or v.firm_role is not null or not v.is_external or v.company_id is not null
     or v.full_name <> 'dir' then
    raise exception 'FAIL AC2: new auth user was not contained: %', row_to_json(v);
  end if;
  raise notice 'PASS AC2: a new auth user is contained regardless of its metadata';
end $$;

-- ---------------------------------------------------------------------------
-- Provisioning: the server promotes a contained profile exactly once
-- ---------------------------------------------------------------------------
do $$
declare
  v_res jsonb;
begin
  insert into companies (id, tenant_id, name, type) values
    ('31600000-0000-4000-8000-0000000000b1', '31600000-0000-4000-8000-000000000001', 'WI Bank', 'bank');
  insert into company_verified_domains (tenant_id, company_id, domain, source) values
    ('31600000-0000-4000-8000-000000000001', '31600000-0000-4000-8000-0000000000b1', 'bank.dev', 'test');

  v_res := authorize_provisioned_profile('31600000-0000-4000-8000-0000000000d1', jsonb_build_object(
    'tenant_id', '31600000-0000-4000-8000-000000000001', 'full_name', 'Dana Director',
    'department', 'ib', 'is_external', false,
    'company_id', '31600000-0000-4000-8000-0000000000b1', 'company_role', 'director'));
  if (select provisioning from users where id = '31600000-0000-4000-8000-0000000000d1') <> 'authorized'
     or (select status from users where id = '31600000-0000-4000-8000-0000000000d1') <> 'active' then
    raise exception 'FAIL: authorize_provisioned_profile did not promote';
  end if;
  if not exists (select 1 from audit_log where action = 'profile_provisioned'
                  and actor_id = '31600000-0000-4000-8000-0000000000d1') then
    raise exception 'FAIL: profile_provisioned not audited';
  end if;
  perform pg_temp.expect_error(
    $q$select authorize_provisioned_profile('31600000-0000-4000-8000-0000000000d1', '{}'::jsonb)$q$,
    'profile_not_contained');

  insert into auth.users (id, email, created_at, updated_at) values
    ('31600000-0000-4000-8000-0000000000d2', 'plain@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000000a1', 'ivy@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000000a2', 'otto@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000000a3', 'emma@bank.dev', now(), now());
  perform authorize_provisioned_profile('31600000-0000-4000-8000-0000000000d2', jsonb_build_object(
    'tenant_id', '31600000-0000-4000-8000-000000000001', 'full_name', 'Pat Plain',
    'company_id', '31600000-0000-4000-8000-0000000000b1', 'company_role', 'member'));
  raise notice 'PASS: authorize_provisioned_profile promotes once and audits';
end $$;

-- ---------------------------------------------------------------------------
-- AC3 firm identity providers
-- ---------------------------------------------------------------------------
do $$
declare
  v_res jsonb;
begin
  perform pg_temp.expect_error(
    $q$select set_firm_identity_provider('31600000-0000-4000-8000-0000000000d2',
         '31600000-0000-4000-8000-0000000000b1', 'google', 'bank.dev')$q$, 'not_permitted');
  perform pg_temp.expect_error(
    $q$select set_firm_identity_provider('31600000-0000-4000-8000-0000000000d1',
         '31600000-0000-4000-8000-0000000000b1', 'okta', 'bank.dev')$q$, 'invalid_provider');
  perform pg_temp.expect_error(
    $q$select set_firm_identity_provider('31600000-0000-4000-8000-0000000000d1',
         '31600000-0000-4000-8000-0000000000b1', 'google', 'x')$q$, 'invalid_organization_id');

  v_res := set_firm_identity_provider('31600000-0000-4000-8000-0000000000d1',
    '31600000-0000-4000-8000-0000000000b1', 'google', 'Bank.dev');
  if (select organization_id from firm_identity_providers
       where company_id = '31600000-0000-4000-8000-0000000000b1') <> 'bank.dev' then
    raise exception 'FAIL AC3: mapping not stored lower-cased';
  end if;
  if not exists (select 1 from audit_log where action = 'identity_provider_configured') then
    raise exception 'FAIL AC3: identity_provider_configured not audited';
  end if;
  raise notice 'PASS AC3: only an authorized actor maps a firm to a provider and organization';
end $$;

-- ---------------------------------------------------------------------------
-- AC4 work-identity invitations carry no email code and keep their method
-- ---------------------------------------------------------------------------
do $$
declare
  v_res jsonb;
  v_inv invites%rowtype;
begin
  v_res := create_invite('31600000-0000-4000-8000-0000000000d1', 'ivy@bank.dev',
    '31600000-0000-4000-8000-0000000000b1', 'member', null, null, null, null, 0, 'work_identity');
  select * into v_inv from invites where id = (v_res->>'id')::uuid;
  if v_inv.auth_method <> 'work_identity' or v_inv.challenge_digest is not null then
    raise exception 'FAIL AC4: work-identity invite stored %', row_to_json(v_inv);
  end if;
  perform pg_temp.expect_error(
    format($q$update invites set auth_method = 'email_code' where id = %L$q$, v_inv.id),
    'auth_method_immutable');
  perform pg_temp.expect_error(
    $q$select create_invite('31600000-0000-4000-8000-0000000000d1', 'nobody@bank.dev',
         '31600000-0000-4000-8000-0000000000b1', 'member', null, null, null, null, 0, 'email_code')$q$,
    'challenge_required');
  perform pg_temp.expect_error(
    $q$select create_invite('31600000-0000-4000-8000-0000000000d1', 'nobody@bank.dev',
         '31600000-0000-4000-8000-0000000000b1', 'member', null, null, null, null, 0, 'sms')$q$,
    'invalid_auth_method');

  -- Nothing can start before delivery.
  perform pg_temp.expect_error(format(
    $q$select start_work_identity_attempt(%L, %L, repeat('ab', 32))$q$, v_inv.id, v_inv.credential_nonce),
    'invite_not_sent');
  perform finalize_invite_delivery(v_inv.id);
  perform pg_temp.expect_error(format(
    $q$select start_work_identity_attempt(%L, gen_random_uuid(), repeat('ab', 32))$q$, v_inv.id),
    'credential_mismatch');
  v_res := start_work_identity_attempt(v_inv.id, v_inv.credential_nonce, repeat('ab', 32));
  if v_res->>'provider' <> 'google' or v_res->>'organization_id' <> 'bank.dev'
     or v_res->>'email' <> 'ivy@bank.dev' then
    raise exception 'FAIL AC4: start_work_identity_attempt returned %', v_res;
  end if;
  perform set_config('wi.attempt', v_res->>'attempt_id', true);
  -- F14: the attempt is bound once to its OAuth flow's PKCE challenge.
  perform bind_work_identity_attempt_flow((v_res->>'attempt_id')::uuid, repeat('ab', 32),
    pg_temp.s256('flow-a-verifier-0000000000000000000000000000'));
  perform pg_temp.expect_error(format(
    $q$select bind_work_identity_attempt_flow(%L, repeat('ab', 32), pg_temp.s256('flow-b-verifier-0000000000000000000000000000'))$q$,
    v_res->>'attempt_id'), 'attempt_claimed');
  perform pg_temp.expect_error(format(
    $q$select bind_work_identity_attempt_flow(%L, repeat('ab', 32), 'short')$q$,
    v_res->>'attempt_id'), 'attempt_flow_mismatch');

  -- The email-code acceptance path refuses a work-identity invitation.
  perform pg_temp.expect_error(format(
    $q$select verify_invite_challenge(%L, %L, repeat('cd', 32))$q$, v_inv.id, v_inv.credential_nonce),
    'not_authenticated');
  raise notice 'PASS AC4: work-identity invitations are code-free, immutable, and start only once sent';
end $$;

-- The invitee signed in with Google; the stranger signed in with Google too but
-- holds no invitation.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
values
  ('g-ivy', '31600000-0000-4000-8000-0000000000a1',
    jsonb_build_object('sub', 'g-ivy', 'email', 'ivy@bank.dev', 'email_verified', true,
                       'custom_claims', jsonb_build_object('hd', 'bank.dev')),
    'google', now(), now(), now()),
  ('g-otto', '31600000-0000-4000-8000-0000000000a2',
    jsonb_build_object('sub', 'g-otto', 'email', 'otto@bank.dev', 'email_verified', true,
                       'custom_claims', jsonb_build_object('hd', 'bank.dev')),
    'google', now(), now(), now());
select pg_temp.sess('31600000-0000-4000-8000-0000000000c1', '31600000-0000-4000-8000-0000000000a1', 'aal1');
select pg_temp.sess('31600000-0000-4000-8000-0000000000c2', '31600000-0000-4000-8000-0000000000a1', 'aal2');
select pg_temp.sess('31600000-0000-4000-8000-0000000000c3', '31600000-0000-4000-8000-0000000000a2', 'aal2');

-- ---------------------------------------------------------------------------
-- Hook matrix before acceptance
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'oauth') ? 'error' then
    raise exception 'FAIL hook: a pending work invitee was refused';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'oauth') #>> '{error,message}'
     is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook: an unbound, uninvited OAuth identity got a token';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'password') ? 'error' then
    raise exception 'FAIL hook: a non-OAuth method was refused';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000d1', 'oauth') ? 'error' then
    raise exception 'FAIL hook: a user without OAuth identities was refused';
  end if;
  if not has_function_privilege('supabase_auth_admin', 'work_identity_access_token_hook(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'work_identity_access_token_hook(jsonb)', 'execute')
     or has_function_privilege('service_role', 'work_identity_access_token_hook(jsonb)', 'execute') then
    raise exception 'FAIL hook: execute privilege is not limited to supabase_auth_admin';
  end if;
  raise notice 'PASS hook: pending invitees pass, unbound OAuth identities are refused';
end $$;

-- #316 (M365, 1/6) hook claim: every token the hook issues carries
-- work_identity_hook = 1 and keeps the claims it was given; a refusal carries
-- no claims. Pending invitee (a1), unbound uninvited user (a2) and a password
-- user (d1) are the three states before acceptance.
do $$
begin
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'oauth') #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook claim: a pending invitee token lacks work_identity_hook';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'oauth') #>> '{claims,sub}'
     is distinct from '31600000-0000-4000-8000-0000000000a1'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'oauth') #>> '{claims,role}'
     is distinct from 'authenticated' then
    raise exception 'FAIL hook claim: the claims the hook was given were not kept';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'password') #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook claim: a password token lacks work_identity_hook';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000d1', 'oauth') #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook claim: a user without OAuth identities got a token without work_identity_hook';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'oauth') ? 'claims' then
    raise exception 'FAIL hook claim: a refusal carries claims';
  end if;
  -- The marker is the hook's: a value in the incoming claims does not survive.
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'password', '{"work_identity_hook": 0}'::jsonb)
       #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook claim: an incoming work_identity_hook was kept';
  end if;
  raise notice 'PASS hook claim: every issued token carries work_identity_hook, refusals carry no claims';
end $$;

-- #316 (M365, 1/6) hook refresh (fix to #320): a refresh of a session born from an
-- OAuth sign-in (amr lists oauth) is judged by the binding rule as the sign-in
-- is. amr is GoTrue's list of objects ({"method": ...}); a bare string element
-- reads the same. A password-born session, or one with no amr, is untouched.
do $$
begin
  -- The pending invitee still refreshes (the exemption holds on refresh).
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh',
       '{"amr": [{"method": "oauth", "timestamp": 1}]}'::jsonb) ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh',
       '{"amr": [{"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook refresh: a pending invitee was refused a refresh or got no claim';
  end if;
  -- An unbound, uninvited identity does not refresh an OAuth-born session ...
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh',
       '{"amr": [{"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{error,message}'
     is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook refresh: an unbound identity refreshed an OAuth-born session';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh',
       '{"amr": [{"method": "totp", "timestamp": 2}, {"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{error,message}'
     is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook refresh: oauth was not found among several amr methods';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh', '{"amr": ["oauth"]}'::jsonb)
       #>> '{error,message}' is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook refresh: a string amr element was not read as oauth';
  end if;
  -- ... but a password-born session, or one with no usable amr, is not judged.
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh',
       '{"amr": [{"method": "password", "timestamp": 1}]}'::jsonb) ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh',
       '{"amr": [{"method": "password", "timestamp": 1}]}'::jsonb) #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook refresh: a password-born session was refused or got no claim';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh') ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh', '{"amr": "oauth"}'::jsonb) ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'token_refresh', '{"amr": [{"timestamp": 1}, 7, null]}'::jsonb) ? 'error' then
    raise exception 'FAIL hook refresh: a missing or malformed amr was read as oauth';
  end if;
  -- An MFA step-up of an OAuth-born session (method totp, amr still holding
  -- oauth) is judged like a refresh: it does not get round the rule.
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'totp',
       '{"amr": [{"method": "totp", "timestamp": 2}, {"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{error,message}'
     is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook step-up: an unbound identity stepped up an OAuth-born session';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'totp',
       '{"amr": [{"method": "totp", "timestamp": 2}, {"method": "oauth", "timestamp": 1}]}'::jsonb) ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'totp',
       '{"amr": [{"method": "totp", "timestamp": 2}, {"method": "oauth", "timestamp": 1}]}'::jsonb)
       #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook step-up: a pending invitee was refused a step-up or got no claim';
  end if;
  -- A session that never held oauth is not judged, whatever the method.
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'totp',
       '{"amr": [{"method": "totp", "timestamp": 2}, {"method": "password", "timestamp": 1}]}'::jsonb) ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'password',
       '{"amr": [{"method": "password", "timestamp": 1}]}'::jsonb) ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a2', 'totp') ? 'error' then
    raise exception 'FAIL hook step-up: a session without oauth in its amr was judged';
  end if;
  raise notice 'PASS hook refresh: every later token of an OAuth-born session is judged by the binding rule';
end $$;

-- ---------------------------------------------------------------------------
-- AC5/AC6 claim and accept a work-identity invitation
-- ---------------------------------------------------------------------------
-- F14 (review round 2): the claim is service role only. The callback calls it
-- after its own PKCE exchange with that exchange's user and session; the
-- browser role cannot present a verifier for an attempt it never exchanged.
select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1', 'aal1');
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select claim_work_identity_attempt(%L, repeat('ab', 32), 'flow-a-verifier-0000000000000000000000000000', '31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1')$q$,
    current_setting('wi.attempt')), 'permission denied for function claim_work_identity_attempt');
end $$;

select pg_temp.act_as_server();
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select claim_work_identity_attempt(%L, repeat('ee', 32), 'flow-a-verifier-0000000000000000000000000000', '31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1')$q$, current_setting('wi.attempt')),
    'attempt_invalid');
  -- A session that does not belong to the user is refused.
  perform pg_temp.expect_error(format(
    $q$select claim_work_identity_attempt(%L, repeat('ab', 32), 'flow-a-verifier-0000000000000000000000000000', '31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c3')$q$, current_setting('wi.attempt')),
    'session_not_live');
  -- A session exchanged in another OAuth flow (verifier B) or with no verifier
  -- cannot claim attempt A, even holding A's cookie secret.
  perform pg_temp.expect_error(format(
    $q$select claim_work_identity_attempt(%L, repeat('ab', 32), 'flow-b-verifier-0000000000000000000000000000', '31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1')$q$, current_setting('wi.attempt')),
    'attempt_flow_mismatch');
  perform pg_temp.expect_error(format(
    $q$select claim_work_identity_attempt(%L, repeat('ab', 32), null, '31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1')$q$, current_setting('wi.attempt')),
    'attempt_flow_mismatch');
  perform claim_work_identity_attempt(current_setting('wi.attempt')::uuid, repeat('ab', 32),
    'flow-a-verifier-0000000000000000000000000000', '31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1');
end $$;

select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1', 'aal1');
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select accept_work_identity_invite(%L, repeat('ab', 32), 'tos-1', 'Ivy')$q$,
    current_setting('wi.attempt')), 'mfa_required');
end $$;

-- The same user from another session cannot finish someone else's claim.
select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c2', 'aal2');
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select accept_work_identity_invite(%L, repeat('ab', 32), 'tos-1', 'Ivy')$q$,
    current_setting('wi.attempt')), 'attempt_not_claimed');
end $$;

-- A different user cannot take the claim over.
select pg_temp.act_as_server();
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select claim_work_identity_attempt(%L, repeat('ab', 32), 'flow-a-verifier-0000000000000000000000000000', '31600000-0000-4000-8000-0000000000a2', '31600000-0000-4000-8000-0000000000c3')$q$, current_setting('wi.attempt')),
    'attempt_claimed');
end $$;

-- Re-claim from the aal2 session: the server starts a fresh attempt.
select pg_temp.act_as_server();
do $$
declare
  v_inv invites%rowtype;
  v_res jsonb;
begin
  select * into v_inv from invites where email = 'ivy@bank.dev';
  v_res := start_work_identity_attempt(v_inv.id, v_inv.credential_nonce, repeat('ab', 32));
  perform set_config('wi.attempt', v_res->>'attempt_id', true);
  perform bind_work_identity_attempt_flow((v_res->>'attempt_id')::uuid, repeat('ab', 32),
    pg_temp.s256('flow-c-verifier-0000000000000000000000000000'));
  -- Wrong org evidence first.
  update auth.identities set identity_data = jsonb_set(identity_data, '{custom_claims,hd}', '"evil.dev"')
   where provider_id = 'g-ivy';
end $$;

do $$
begin
  perform claim_work_identity_attempt(current_setting('wi.attempt')::uuid, repeat('ab', 32),
    'flow-c-verifier-0000000000000000000000000000', '31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c2');
end $$;

select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c2', 'aal2');
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select accept_work_identity_invite(%L, repeat('ab', 32), 'tos-1', 'Ivy')$q$,
    current_setting('wi.attempt')), 'work_identity_mismatch');
end $$;

select pg_temp.act_as_server();
update auth.identities set identity_data = jsonb_set(identity_data, '{custom_claims,hd}', '"bank.dev"')
 where provider_id = 'g-ivy';

-- F13: continuing authority is the exact-seat authority create_invite would
-- grant now. A director demoted to member who keeps an MD deal membership may
-- still run that deal, but can no longer grant a director seat on it.
insert into deals (id, tenant_id, code, codename, bank_id)
values ('31600000-0000-4000-8000-0000000000e1', '31600000-0000-4000-8000-000000000001',
        'WI-F13', 'Seat check', '31600000-0000-4000-8000-0000000000b1');
insert into deal_memberships (deal_id, user_id, role_id, deal_role)
values ('31600000-0000-4000-8000-0000000000e1', '31600000-0000-4000-8000-0000000000d1',
        (select id from roles where slug = 'md'), 'md');
update invites set company_role = 'director', deal_id = '31600000-0000-4000-8000-0000000000e1',
       deal_role = 'deal_team'
 where email = 'ivy@bank.dev';
update users set company_role = 'director' where id = '31600000-0000-4000-8000-0000000000d2';
update users set company_role = 'member' where id = '31600000-0000-4000-8000-0000000000d1';

select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c2', 'aal2');
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select accept_work_identity_invite(%L, repeat('ab', 32), 'tos-1', 'Ivy')$q$,
    current_setting('wi.attempt')), 'inviter_not_authorized');
end $$;

select pg_temp.act_as_server();
do $$
begin
  if exists (select 1 from users where id = '31600000-0000-4000-8000-0000000000a1' and status = 'active')
     or exists (select 1 from deal_memberships where user_id = '31600000-0000-4000-8000-0000000000a1')
     or exists (select 1 from work_identity_bindings where user_id = '31600000-0000-4000-8000-0000000000a1') then
    raise exception 'FAIL F13: a refused seat left an activation, membership or binding';
  end if;
  raise notice 'PASS F13: a demoted MD cannot grant a director seat at acceptance';
end $$;

select pg_temp.act_as_server();
update users set company_role = 'director' where id = '31600000-0000-4000-8000-0000000000d1';
update users set company_role = 'member' where id = '31600000-0000-4000-8000-0000000000d2';
update invites set company_role = 'member', deal_id = null, deal_role = null
 where email = 'ivy@bank.dev';
delete from deal_memberships where deal_id = '31600000-0000-4000-8000-0000000000e1';
delete from deals where id = '31600000-0000-4000-8000-0000000000e1';

-- F13: an inviter moved to another tenant no longer holds authority here.
update users set tenant_id = '31600000-0000-4000-8000-0000000000f9'
 where id = (select invited_by from invites where email = 'ivy@bank.dev');
select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c2', 'aal2');
do $$
begin
  perform pg_temp.expect_error(format(
    $q$select accept_work_identity_invite(%L, repeat('ab', 32), 'tos-1', 'Ivy')$q$,
    current_setting('wi.attempt')), 'inviter_not_authorized');
  raise notice 'PASS F13: an inviter moved out of the tenant cannot grant the seat';
end $$;
select pg_temp.act_as_server();
update users set tenant_id = '31600000-0000-4000-8000-000000000001'
 where id = (select invited_by from invites where email = 'ivy@bank.dev');

select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c2', 'aal2');
do $$
declare
  v_res jsonb;
begin
  v_res := accept_work_identity_invite(current_setting('wi.attempt')::uuid, repeat('ab', 32), 'tos-1', 'Ivy');
  if (v_res->>'duplicate')::boolean or v_res->>'company_id' <> '31600000-0000-4000-8000-0000000000b1'
     or (v_res->>'is_external')::boolean then
    raise exception 'FAIL AC6: accept returned %', v_res;
  end if;
  v_res := accept_work_identity_invite(current_setting('wi.attempt')::uuid, repeat('ab', 32), 'tos-1', 'Ivy');
  if not (v_res->>'duplicate')::boolean then
    raise exception 'FAIL AC6: replay was not idempotent: %', v_res;
  end if;
  -- The member now reads within its tenant through the live-caller guard.
  if app_user_tenant('31600000-0000-4000-8000-0000000000a1') <> '31600000-0000-4000-8000-000000000001' then
    raise exception 'FAIL AC6: the new member cannot resolve its own tenant';
  end if;
end $$;

select pg_temp.act_as_server();
do $$
declare
  v users%rowtype;
begin
  select * into v from users where id = '31600000-0000-4000-8000-0000000000a1';
  if v.status <> 'active' or v.company_id <> '31600000-0000-4000-8000-0000000000b1'
     or v.tenant_id <> '31600000-0000-4000-8000-000000000001' or v.is_external
     or v.company_role <> 'member' then
    raise exception 'FAIL AC6: profile not activated: %', row_to_json(v);
  end if;
  if (select status from invites where email = 'ivy@bank.dev') <> 'accepted' then
    raise exception 'FAIL AC6: invite not accepted';
  end if;
  if not exists (select 1 from work_identity_bindings
                  where provider = 'google' and provider_subject = 'g-ivy' and via = 'invite'
                    and user_id = v.id) then
    raise exception 'FAIL AC6: binding not recorded';
  end if;
  if exists (select 1 from auth.sessions where user_id = v.id and id <> '31600000-0000-4000-8000-0000000000c2') then
    raise exception 'FAIL AC6: other sessions survived acceptance';
  end if;
  if (select count(*) from audit_log where actor_id = v.id and action in ('attest', 'invite_accepted')) <> 2 then
    raise exception 'FAIL AC6: attest + invite_accepted not audited exactly once';
  end if;
  if pg_temp.hook(v.id, 'oauth') ? 'error' then
    raise exception 'FAIL AC6: a bound work identity was refused a token';
  end if;
  raise notice 'PASS AC5/AC6: claim is single-owner, MFA and org evidence are required, acceptance binds and is idempotent';
end $$;

-- ---------------------------------------------------------------------------
-- F5 suspension and dead sessions close the RLS helpers and the hook
-- ---------------------------------------------------------------------------
select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c1', 'aal2');
do $$
begin
  if app_caller_live() or app_user_tenant('31600000-0000-4000-8000-0000000000a1') is not null
     or not app_user_is_external('31600000-0000-4000-8000-0000000000a1') then
    raise exception 'FAIL F5: a deleted session still resolves';
  end if;
end $$;

select pg_temp.act_as_server();
update users set status = 'suspended' where id = '31600000-0000-4000-8000-0000000000a1';
select pg_temp.act_as('31600000-0000-4000-8000-0000000000a1', '31600000-0000-4000-8000-0000000000c2', 'aal2');
do $$
begin
  if app_caller_live() or app_user_company('31600000-0000-4000-8000-0000000000a1') is not null then
    raise exception 'FAIL F5: a suspended caller still resolves';
  end if;
end $$;
select pg_temp.act_as_server();
do $$
begin
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh') #>> '{error,message}'
     is distinct from 'account_suspended' then
    raise exception 'FAIL F5: a suspended account refreshed a token';
  end if;
  -- Suspension is judged first, for an OAuth-born session too, and carries no claims.
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh',
       '{"amr": [{"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{error,message}'
     is distinct from 'account_suspended'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh') ? 'claims' then
    raise exception 'FAIL F5: a suspended OAuth-born session refreshed or its refusal carried claims';
  end if;
  raise notice 'PASS F5: suspension and session deletion close the helpers and the hook';
end $$;
update users set status = 'active' where id = '31600000-0000-4000-8000-0000000000a1';

-- #316 (M365, 1/6) hook refresh after acceptance (fix to #320): the bound, active
-- invitee refreshes an OAuth-born session and its password-born one; once the
-- binding is gone the OAuth-born session stops refreshing, the password-born
-- one does not. The probe deletes the binding and rolls it back.
do $$
declare
  v_gone text;
  v_gone_password jsonb;
  v_gone_step_up text;
begin
  if pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh',
       '{"amr": [{"method": "oauth", "timestamp": 1}]}'::jsonb) ? 'error'
     or pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh',
       '{"amr": [{"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook refresh: a bound OAuth-born session was refused or got no claim';
  end if;

  begin
    delete from work_identity_bindings where user_id = '31600000-0000-4000-8000-0000000000a1';
    v_gone := pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh',
      '{"amr": [{"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{error,message}';
    v_gone_password := pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'token_refresh',
      '{"amr": [{"method": "password", "timestamp": 1}]}'::jsonb);
    v_gone_step_up := pg_temp.hook('31600000-0000-4000-8000-0000000000a1', 'totp',
      '{"amr": [{"method": "totp", "timestamp": 2}, {"method": "oauth", "timestamp": 1}]}'::jsonb) #>> '{error,message}';
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then raise; end if;
  end;
  if v_gone is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook refresh: an OAuth-born session refreshed after its binding was deleted (got %)', v_gone;
  end if;
  if v_gone_step_up is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook step-up: an OAuth-born session stepped up after its binding was deleted (got %)', v_gone_step_up;
  end if;
  if v_gone_password ? 'error' or v_gone_password #>> '{claims,work_identity_hook}' is distinct from '1' then
    raise exception 'FAIL hook refresh: a password-born session was refused after the binding was deleted';
  end if;
  if not exists (select 1 from work_identity_bindings
                  where provider = 'google' and provider_subject = 'g-ivy'
                    and user_id = '31600000-0000-4000-8000-0000000000a1') then
    raise exception 'FAIL hook refresh: the probe left the binding deleted';
  end if;
  raise notice 'PASS hook refresh (#320 fix): a deleted binding stops an OAuth-born session refreshing';
end $$;

-- ---------------------------------------------------------------------------
-- AC8 email-code acceptance: password, terms and session in one transaction
-- ---------------------------------------------------------------------------
do $$
declare
  v_res jsonb;
begin
  v_res := create_invite('31600000-0000-4000-8000-0000000000d1', 'emma@bank.dev',
    '31600000-0000-4000-8000-0000000000b1', 'member', repeat('cd', 32), null, null, null, 0);
  perform finalize_invite_delivery((v_res->>'id')::uuid);
  perform set_config('wi.emma_invite', v_res->>'id', true);
  perform set_config('wi.emma_nonce', v_res->>'credential_nonce', true);
  perform pg_temp.sess('31600000-0000-4000-8000-0000000000c4', '31600000-0000-4000-8000-0000000000a3', 'aal1');
  perform pg_temp.sess('31600000-0000-4000-8000-0000000000c5', '31600000-0000-4000-8000-0000000000a3', 'aal1');
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000a3', 'stale', 'totp', 'unverified', now(), now());
end $$;

select pg_temp.act_as('31600000-0000-4000-8000-0000000000a3', '31600000-0000-4000-8000-0000000000c4', 'aal1');
do $$
declare
  v_inv uuid := current_setting('wi.emma_invite')::uuid;
  v_nonce uuid := current_setting('wi.emma_nonce')::uuid;
  v_res jsonb;
begin
  perform pg_temp.expect_error(format($q$select accept_invite(%L, %L, 'short', 'tos-1', null)$q$, v_inv, v_nonce),
    'weak_password');
  perform pg_temp.expect_error(format($q$select accept_invite(%L, %L, %L, 'tos-1', null)$q$,
    v_inv, v_nonce, repeat('x', 73)), 'weak_password');
  perform pg_temp.expect_error(format($q$select accept_invite(%L, %L, 'long-enough-1', 'tos-1', null)$q$,
    v_inv, v_nonce), 'invite_not_verified');
  v_res := verify_invite_challenge(v_inv, v_nonce, repeat('cd', 32));
  if not coalesce((v_res->>'verified')::boolean, false) then
    raise exception 'FAIL AC8: verification failed: %', v_res;
  end if;
end $$;

-- Verified in session c4; accepting from c5 is refused.
select pg_temp.act_as('31600000-0000-4000-8000-0000000000a3', '31600000-0000-4000-8000-0000000000c5', 'aal1');
do $$
begin
  perform pg_temp.expect_error(format($q$select accept_invite(%L, %L, 'long-enough-1', 'tos-1', null)$q$,
    current_setting('wi.emma_invite'), current_setting('wi.emma_nonce')), 'challenge_session_mismatch');
end $$;

select pg_temp.act_as('31600000-0000-4000-8000-0000000000a3', '31600000-0000-4000-8000-0000000000c4', 'aal1');
do $$
declare
  v_res jsonb;
begin
  v_res := accept_invite(current_setting('wi.emma_invite')::uuid, current_setting('wi.emma_nonce')::uuid,
    'long-enough-1', 'tos-1', 'Emma');
  if (v_res->>'duplicate')::boolean then raise exception 'FAIL AC8: first accept was a duplicate'; end if;
  v_res := accept_invite(current_setting('wi.emma_invite')::uuid, current_setting('wi.emma_nonce')::uuid,
    'another-password', 'tos-1', 'Emma');
  if not (v_res->>'duplicate')::boolean then raise exception 'FAIL AC8: replay was not idempotent'; end if;
end $$;

select pg_temp.act_as_server();
do $$
declare
  v_pw text;
begin
  select encrypted_password into v_pw from auth.users where id = '31600000-0000-4000-8000-0000000000a3';
  if v_pw is null or v_pw <> extensions.crypt('long-enough-1', v_pw) then
    raise exception 'FAIL AC8: password not set (or the replay rewrote it)';
  end if;
  if exists (select 1 from auth.sessions where user_id = '31600000-0000-4000-8000-0000000000a3'
              and id <> '31600000-0000-4000-8000-0000000000c4')
     or exists (select 1 from auth.mfa_factors where user_id = '31600000-0000-4000-8000-0000000000a3') then
    raise exception 'FAIL AC8: other sessions or MFA factors survived acceptance';
  end if;
  if (select provisioning from users where id = '31600000-0000-4000-8000-0000000000a3') <> 'authorized'
     or (select status from users where id = '31600000-0000-4000-8000-0000000000a3') <> 'active' then
    raise exception 'FAIL AC8: email-code member not activated';
  end if;
  if not exists (select 1 from audit_log where action = 'attest'
                  and actor_id = '31600000-0000-4000-8000-0000000000a3'
                  and detail->>'tos_version' = 'tos-1') then
    raise exception 'FAIL AC8: terms attestation not audited in the transaction';
  end if;
  raise notice 'PASS AC8: email-code acceptance sets the password, attests and rotates sessions atomically';
end $$;

-- ---------------------------------------------------------------------------
-- #296 invitation authority is the permission system, on both sides of the wire.
-- A work-identity invite issued by a member who holds company:invites:send
-- through a ROLE (R) or by an external client director (X) is created AND
-- accepted. Acceptance re-derives the seat with the same helper email-code
-- acceptance uses, so an inviter who is suspended (SI-WI) or whose grant is
-- revoked while active (RV-WI) leaves the invite unacceptable.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_server();

-- Prepare: deliver the invite, start and bind an attempt, claim it from the
-- invitee's own aal2 session. Returns the attempt id.
create function pg_temp.wi_prepare(
  p_invite uuid, p_user uuid, p_session uuid, p_subject text, p_org text, p_verifier text
) returns uuid language plpgsql as $$
declare
  v_nonce uuid;
  v_res jsonb;
  v_email text;
begin
  perform pg_temp.act_as_server();
  select credential_nonce, email into v_nonce, v_email from invites where id = p_invite;
  perform finalize_invite_delivery(p_invite);
  v_res := start_work_identity_attempt(p_invite, v_nonce, repeat('ab', 32));
  perform bind_work_identity_attempt_flow((v_res->>'attempt_id')::uuid, repeat('ab', 32), pg_temp.s256(p_verifier));
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  values (p_subject, p_user,
    jsonb_build_object('sub', p_subject, 'email', v_email, 'email_verified', true,
                       'custom_claims', jsonb_build_object('hd', p_org)),
    'google', now(), now(), now());
  perform pg_temp.sess(p_session, p_user, 'aal2');
  perform claim_work_identity_attempt((v_res->>'attempt_id')::uuid, repeat('ab', 32), p_verifier, p_user, p_session);
  return (v_res->>'attempt_id')::uuid;
end;
$$;

-- Accept as the invitee (aal2) and return to the server role.
create function pg_temp.wi_accept(p_attempt uuid, p_user uuid, p_session uuid) returns jsonb
language plpgsql as $$
declare
  v_res jsonb;
begin
  perform pg_temp.act_as(p_user, p_session, 'aal2');
  v_res := accept_work_identity_invite(p_attempt, repeat('ab', 32), 'tos-1', 'Invitee');
  perform pg_temp.act_as_server();
  return v_res;
end;
$$;

-- Fixtures. 1a..1f are the invitees, 2a is a second bank director, 2b a
-- role-holding member, 2c a delegate with a direct grant, 2d the client's
-- external director.
do $$
declare
  v_t constant uuid := '31600000-0000-4000-8000-000000000001';
  v_bank constant uuid := '31600000-0000-4000-8000-0000000000b1';
  v_client constant uuid := '31600000-0000-4000-8000-0000000000b2';
  v_d1 constant uuid := '31600000-0000-4000-8000-0000000000d1';
  v_role constant uuid := '31600000-0000-4000-8000-0000000000f1';
begin
  insert into companies (id, tenant_id, name, type) values (v_client, v_t, 'WI Client', 'client');
  insert into company_verified_domains (tenant_id, company_id, domain, source) values
    (v_t, v_client, 'client.dev', 'test');
  insert into firm_identity_providers (company_id, provider, organization_id, updated_by, updated_at)
  values (v_client, 'google', 'client.dev', v_d1, now());  -- the bank's mapping is set in AC3

  insert into auth.users (id, email, created_at, updated_at) values
    ('31600000-0000-4000-8000-0000000002a1', 'dir2@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000002b1', 'rolemember@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000002c1', 'delegate@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000002d1', 'cdir@client.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000001a1', 'inv-r@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000001a2', 'inv-x@client.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000001a3', 'inv-si@bank.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000001a4', 'inv-rv@bank.dev', now(), now());

  perform authorize_provisioned_profile('31600000-0000-4000-8000-0000000002d1', jsonb_build_object(
    'tenant_id', v_t, 'full_name', 'Cleo Client', 'is_external', true,
    'company_id', v_client, 'company_role', 'director'));
  perform authorize_provisioned_profile('31600000-0000-4000-8000-0000000002a1', jsonb_build_object(
    'tenant_id', v_t, 'full_name', 'Dara Director', 'is_external', false,
    'company_id', v_bank, 'company_role', 'director'));
  perform authorize_provisioned_profile('31600000-0000-4000-8000-0000000002b1', jsonb_build_object(
    'tenant_id', v_t, 'full_name', 'Rhea Role', 'is_external', false,
    'company_id', v_bank, 'company_role', 'member'));
  perform authorize_provisioned_profile('31600000-0000-4000-8000-0000000002c1', jsonb_build_object(
    'tenant_id', v_t, 'full_name', 'Del Delegate', 'is_external', false,
    'company_id', v_bank, 'company_role', 'member'));

  insert into company_member_access (company_id, user_id) values
    (v_bank, '31600000-0000-4000-8000-0000000002b1'), (v_bank, '31600000-0000-4000-8000-0000000002c1');
  insert into company_roles (id, company_id, name, created_by) values (v_role, v_bank, 'WI Inviters', v_d1);
  insert into company_role_permissions (company_id, role_id, permission_key)
  values (v_bank, v_role, 'company:invites:send');
  insert into company_member_roles (company_id, user_id, role_id, assigned_by)
  values (v_bank, '31600000-0000-4000-8000-0000000002b1', v_role, v_d1);
  insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
  values (v_bank, '31600000-0000-4000-8000-0000000002c1', 'company:invites:send', v_d1);
end $$;

-- R and X: created and accepted.
do $$
declare
  v_bank constant uuid := '31600000-0000-4000-8000-0000000000b1';
  v_client constant uuid := '31600000-0000-4000-8000-0000000000b2';
  v_inv uuid;
  v_attempt uuid;
  v_res jsonb;
begin
  v_res := create_invite('31600000-0000-4000-8000-0000000002b1', 'inv-r@bank.dev', v_bank,
    'member', null, null, null, null, 0, 'work_identity');
  v_inv := (v_res->>'id')::uuid;
  v_attempt := pg_temp.wi_prepare(v_inv, '31600000-0000-4000-8000-0000000001a1',
    '31600000-0000-4000-8000-0000000001c1', 'g-inv-r', 'bank.dev', 'flow-r-verifier-00000000000000000000000000000');
  v_res := pg_temp.wi_accept(v_attempt, '31600000-0000-4000-8000-0000000001a1', '31600000-0000-4000-8000-0000000001c1');
  if (v_res->>'duplicate')::boolean or v_res->>'company_id' <> v_bank::text then
    raise exception 'FAIL R: role-issued work-identity invite accepted as %', v_res;
  end if;
  if (select company_id from users where id = '31600000-0000-4000-8000-0000000001a1') <> v_bank then
    raise exception 'FAIL R: the invitee was not seated';
  end if;

  v_res := create_invite('31600000-0000-4000-8000-0000000002d1', 'inv-x@client.dev', v_client,
    'member', null, null, null, null, 0, 'work_identity');
  v_inv := (v_res->>'id')::uuid;
  v_attempt := pg_temp.wi_prepare(v_inv, '31600000-0000-4000-8000-0000000001a2',
    '31600000-0000-4000-8000-0000000001c2', 'g-inv-x', 'client.dev', 'flow-x-verifier-00000000000000000000000000000');
  v_res := pg_temp.wi_accept(v_attempt, '31600000-0000-4000-8000-0000000001a2', '31600000-0000-4000-8000-0000000001c2');
  if (v_res->>'duplicate')::boolean or v_res->>'company_id' <> v_client::text
     or not (v_res->>'is_external')::boolean then
    raise exception 'FAIL X: client-director-issued work-identity invite accepted as %', v_res;
  end if;
  raise notice 'PASS #296: work-identity invites issued by a role holder (R) and a client director (X) are created and accepted';
end $$;

-- SI-WI and RV-WI (pins): a pending invite dies with its inviter's authority.
do $$
declare
  v_bank constant uuid := '31600000-0000-4000-8000-0000000000b1';
  v_inv uuid;
  v_attempt uuid;
  v_res jsonb;
begin
  -- SI-WI: the issuing director is suspended before acceptance.
  v_res := create_invite('31600000-0000-4000-8000-0000000002a1', 'inv-si@bank.dev', v_bank,
    'member', null, null, null, null, 0, 'work_identity');
  v_inv := (v_res->>'id')::uuid;
  v_attempt := pg_temp.wi_prepare(v_inv, '31600000-0000-4000-8000-0000000001a3',
    '31600000-0000-4000-8000-0000000001c3', 'g-inv-si', 'bank.dev', 'flow-si-verifier-0000000000000000000000000000');
  update users set status = 'suspended' where id = '31600000-0000-4000-8000-0000000002a1';
  begin
    perform pg_temp.wi_accept(v_attempt, '31600000-0000-4000-8000-0000000001a3', '31600000-0000-4000-8000-0000000001c3');
    raise exception 'FAIL SI-WI: an invite from a suspended inviter was accepted';
  exception when others then
    if sqlerrm like 'FAIL SI-WI%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL SI-WI: refused with unexpected error %', sqlerrm;
    end if;
  end;
  perform pg_temp.act_as_server();

  -- RV-WI: the delegate stays active but its grant is revoked.
  v_res := create_invite('31600000-0000-4000-8000-0000000002c1', 'inv-rv@bank.dev', v_bank,
    'member', null, null, null, null, 0, 'work_identity');
  v_inv := (v_res->>'id')::uuid;
  v_attempt := pg_temp.wi_prepare(v_inv, '31600000-0000-4000-8000-0000000001a4',
    '31600000-0000-4000-8000-0000000001c4', 'g-inv-rv', 'bank.dev', 'flow-rv-verifier-0000000000000000000000000000');
  delete from company_member_permissions
   where company_id = v_bank and user_id = '31600000-0000-4000-8000-0000000002c1'
     and permission_key = 'company:invites:send';
  begin
    perform pg_temp.wi_accept(v_attempt, '31600000-0000-4000-8000-0000000001a4', '31600000-0000-4000-8000-0000000001c4');
    raise exception 'FAIL RV-WI: an invite whose inviter lost the permission was accepted';
  exception when others then
    if sqlerrm like 'FAIL RV-WI%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL RV-WI: refused with unexpected error %', sqlerrm;
    end if;
  end;
  perform pg_temp.act_as_server();
  raise notice 'PASS #296: a suspended inviter (SI-WI) and a revoked grant (RV-WI) make a work-identity invite unacceptable';
end $$;

-- #296 provisioning crossing on the work-identity path (PX-WI). A firm admin
-- in this tenant provisions a new organization in another tenant. Both
-- invitations it issued while that tenant was unprovisioned carry the recorded
-- crossing and accept, the second after the first has provisioned the tenant.
-- A pending crossing with no recorded decision (a legacy row) is refused, and
-- so is a recorded one stored under a tenant that is not the company's.
do $$
declare
  v_t constant uuid := '31600000-0000-4000-8000-000000000001';
  v_t3 constant uuid := '31600000-0000-4000-8000-000000000003';
  v_new constant uuid := '31600000-0000-4000-8000-0000000000b3';
  v_admin constant uuid := '31600000-0000-4000-8000-0000000003d1';
  v_first constant uuid := '31600000-0000-4000-8000-0000000003a1';
  v_second constant uuid := '31600000-0000-4000-8000-0000000003a2';
  v_legacy constant uuid := '31600000-0000-4000-8000-0000000003a3';
  v_first_inv uuid;
  v_second_inv uuid;
  v_legacy_inv uuid;
  v_stray_inv uuid;
  v_attempt uuid;
  v_res jsonb;
begin
  insert into auth.users (id, email, created_at, updated_at) values
    (v_admin, 'xadmin@bank.dev', now(), now()),
    (v_first, 'px-first@neworg.dev', now(), now()),
    (v_second, 'px-second@neworg.dev', now(), now()),
    (v_legacy, 'px-legacy@neworg.dev', now(), now()),
    ('31600000-0000-4000-8000-0000000003a4', 'px-stray@neworg.dev', now(), now());
  perform authorize_provisioned_profile(v_admin, jsonb_build_object(
    'tenant_id', v_t, 'full_name', 'Xan Admin', 'is_external', false, 'firm_role', 'admin'));

  insert into companies (id, tenant_id, name, type) values (v_new, v_t3, 'WI New Org', 'bank');
  insert into company_verified_domains (tenant_id, company_id, domain, source) values
    (v_t3, v_new, 'neworg.dev', 'test');
  insert into firm_identity_providers (company_id, provider, organization_id, updated_by, updated_at)
  values (v_new, 'google', 'neworg.dev', v_admin, now());

  v_res := create_invite(v_admin, 'px-first@neworg.dev', v_new, 'director', null, null, null, null, 0, 'work_identity');
  v_first_inv := (v_res->>'id')::uuid;
  v_res := create_invite(v_admin, 'px-second@neworg.dev', v_new, 'director', null, null, null, null, 0, 'work_identity');
  v_second_inv := (v_res->>'id')::uuid;
  if (select count(*) from invites
       where id in (v_first_inv, v_second_inv) and provisioning_crossing and tenant_id = v_t3) <> 2 then
    raise exception 'FAIL PX-WI: create_invite did not record the provisioning crossing on both invites';
  end if;

  -- Mis-tenanted: a recorded crossing stored under a tenant that is not the
  -- company's is refused while the target is still unprovisioned. A director
  -- seat, so only the seat helper (not the director invariant) can refuse it.
  insert into invites (tenant_id, email, invited_by, company_id, company_role, challenge_version,
                       auth_method, provisioning_crossing)
  values ('31600000-0000-4000-8000-000000000004', 'px-stray@neworg.dev', v_admin, v_new, 'director', 0,
          'work_identity', true)
  returning id into v_stray_inv;
  if not public.tenant_is_unprovisioned(v_t3) then
    raise exception 'FAIL PX-WI setup: the target tenant is already provisioned';
  end if;
  v_attempt := pg_temp.wi_prepare(v_stray_inv, '31600000-0000-4000-8000-0000000003a4',
    '31600000-0000-4000-8000-0000000003c4', 'g-px-stray', 'neworg.dev', 'flow-px4-verifier-000000000000000000000000000');
  begin
    perform pg_temp.wi_accept(v_attempt, '31600000-0000-4000-8000-0000000003a4', '31600000-0000-4000-8000-0000000003c4');
    raise exception 'FAIL PX-WI: a recorded crossing stored under another tenant was accepted';
  exception when others then
    if sqlerrm like 'FAIL PX-WI%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL PX-WI: mis-tenanted refused with unexpected error %', sqlerrm;
    end if;
  end;
  perform pg_temp.act_as_server();

  v_attempt := pg_temp.wi_prepare(v_first_inv, v_first, '31600000-0000-4000-8000-0000000003c1',
    'g-px-first', 'neworg.dev', 'flow-px1-verifier-000000000000000000000000000');
  perform pg_temp.wi_accept(v_attempt, v_first, '31600000-0000-4000-8000-0000000003c1');
  if public.tenant_is_unprovisioned(v_t3) then
    raise exception 'FAIL PX-WI setup: the first acceptance did not provision the tenant';
  end if;

  v_attempt := pg_temp.wi_prepare(v_second_inv, v_second, '31600000-0000-4000-8000-0000000003c2',
    'g-px-second', 'neworg.dev', 'flow-px2-verifier-000000000000000000000000000');
  v_res := pg_temp.wi_accept(v_attempt, v_second, '31600000-0000-4000-8000-0000000003c2');
  if (v_res->>'duplicate')::boolean or v_res->>'company_id' <> v_new::text
     or (select tenant_id from users where id = v_second) <> v_t3 then
    raise exception 'FAIL PX-WI: the second bootstrap invite was not accepted after provisioning: %', v_res;
  end if;

  -- Legacy: same tenant_id as the company, no recorded crossing.
  insert into invites (tenant_id, email, invited_by, company_id, company_role, challenge_version, auth_method)
  values (v_t3, 'px-legacy@neworg.dev', v_admin, v_new, 'member', 0, 'work_identity')
  returning id into v_legacy_inv;
  v_attempt := pg_temp.wi_prepare(v_legacy_inv, v_legacy, '31600000-0000-4000-8000-0000000003c3',
    'g-px-legacy', 'neworg.dev', 'flow-px3-verifier-000000000000000000000000000');
  begin
    perform pg_temp.wi_accept(v_attempt, v_legacy, '31600000-0000-4000-8000-0000000003c3');
    raise exception 'FAIL PX-WI: a legacy crossing invite with no recorded decision was accepted';
  exception when others then
    if sqlerrm like 'FAIL PX-WI%' then raise; end if;
    if sqlerrm <> 'inviter_not_authorized' then
      raise exception 'FAIL PX-WI: legacy refused with unexpected error %', sqlerrm;
    end if;
  end;
  perform pg_temp.act_as_server();
  raise notice 'PASS #296: a recorded provisioning crossing survives provisioning on the work-identity path; a legacy or mis-tenanted one does not (PX-WI)';
end $$;

-- ---------------------------------------------------------------------------
-- AC9/AC10 connect a work identity to an active account (via a broker alias)
-- ---------------------------------------------------------------------------
insert into work_identity_broker_aliases (provider, broker_provider) values ('google', 'keycloak');
select pg_temp.sess('31600000-0000-4000-8000-0000000000c6', '31600000-0000-4000-8000-0000000000d1', 'aal2');

-- A stale unbound identity is released when a connection begins.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-stale', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-stale', 'email', 'dir@bank.dev', 'email_verified', true), 'keycloak',
  now() - interval '1 hour', now());

select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal1');
do $$
begin
  perform pg_temp.expect_error($q$select begin_work_identity_connect('google', repeat('12', 32))$q$, 'mfa_required');
end $$;

select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
select begin_work_identity_connect('google', repeat('12', 32));

select pg_temp.act_as_server();
do $$
begin
  if exists (select 1 from auth.identities where provider_id = 'kc-stale') then
    raise exception 'FAIL AC9: begin did not release the unbound identity';
  end if;
  if not exists (select 1 from audit_log where action = 'work_identity_released'
                  and actor_id = '31600000-0000-4000-8000-0000000000d1') then
    raise exception 'FAIL AC9: release not audited';
  end if;
end $$;

-- First attempt: the provider reports the wrong organization.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-dir-wrong', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-dir-wrong', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'evil.dev')), 'keycloak', now(), now());
insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                             authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000d1', 'code-wrong', 's256',
  rtrim(translate(encode(extensions.digest('verifier-wrong', 'sha256'), 'base64'), '+/', '-_'), '='),
  'keycloak', 'oauth', now(), now(), now(), '31600000-0000-4000-8000-0000000000d1');

select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
do $$
declare
  v_res jsonb;
begin
  perform pg_temp.expect_error(
    $q$select complete_work_identity_connect(repeat('12', 32), 'code-wrong', 'not-the-verifier')$q$,
    'connect_flow_invalid');
  v_res := complete_work_identity_connect(repeat('12', 32), 'code-wrong', 'verifier-wrong');
  if (v_res->>'connected')::boolean or v_res->>'error' <> 'work_identity_mismatch' then
    raise exception 'FAIL AC10: wrong-organization connect returned %', v_res;
  end if;
  perform pg_temp.expect_error(
    $q$select complete_work_identity_connect(repeat('12', 32), 'code-wrong', 'verifier-wrong')$q$,
    'connect_intent_invalid');
  perform begin_work_identity_connect('google', repeat('34', 32));
end $$;

select pg_temp.act_as_server();
do $$
begin
  if exists (select 1 from auth.identities where provider_id = 'kc-dir-wrong') then
    raise exception 'FAIL AC10: refused identity was not released';
  end if;
end $$;

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-dir', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-dir', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'bank.dev')), 'keycloak', now(), now());
insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                             authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000d1', 'code-ok', 's256',
  rtrim(translate(encode(extensions.digest('verifier-ok', 'sha256'), 'base64'), '+/', '-_'), '='),
  'keycloak', 'oauth', now(), now(), now(), '31600000-0000-4000-8000-0000000000d1');

-- Before the connection completes, the unbound identity cannot mint a token.
do $$
begin
  if pg_temp.hook('31600000-0000-4000-8000-0000000000d1', 'oauth') #>> '{error,message}'
     is distinct from 'work_identity_not_connected' then
    raise exception 'FAIL hook: an unbound brokered identity got a token';
  end if;
end $$;

select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
do $$
declare
  v_res jsonb;
begin
  v_res := complete_work_identity_connect(repeat('34', 32), 'code-ok', 'verifier-ok');
  if not (v_res->>'connected')::boolean or v_res->>'provider' <> 'google' then
    raise exception 'FAIL AC9: connect returned %', v_res;
  end if;
end $$;

select pg_temp.act_as_server();
do $$
begin
  if not exists (select 1 from work_identity_bindings
                  where provider = 'google' and provider_subject = 'kc-dir' and via = 'connect'
                    and user_id = '31600000-0000-4000-8000-0000000000d1') then
    raise exception 'FAIL AC9: connect binding missing';
  end if;
  if exists (select 1 from auth.flow_state where auth_code = 'code-ok') then
    raise exception 'FAIL AC9: flow state not consumed';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000d1', 'oauth') ? 'error' then
    raise exception 'FAIL AC9: a connected brokered identity was refused';
  end if;
  if not exists (select 1 from audit_log where action = 'work_identity_connected') then
    raise exception 'FAIL AC9: connection not audited';
  end if;
  raise notice 'PASS AC9/AC10: connection is MFA-gated, PKCE-bound, org-checked, released on refusal, and honours a broker alias';
end $$;

-- #406 menu rule: Connect is offered with no binding for the firm's provider,
-- or with an unbound account that work sign-in linked. An organization move
-- or a provider switch offers it until a bound account carries the current
-- organization.
select pg_temp.act_as_server();
do $$
begin
  if work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is not null then
    raise exception 'FAIL #406: Connect offered to a bound account';
  end if;
  update firm_identity_providers set organization_id = 'moved.dev'
   where company_id = (select company_id from users where id = '31600000-0000-4000-8000-0000000000d1');
  if work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is distinct from 'google' then
    raise exception 'FAIL #406: Connect not offered after an organization move';
  end if;
  update firm_identity_providers set provider = 'azure'
   where company_id = (select company_id from users where id = '31600000-0000-4000-8000-0000000000d1');
  if work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is distinct from 'azure' then
    raise exception 'FAIL #406: Connect not offered after a provider switch';
  end if;
  update firm_identity_providers set provider = 'google', organization_id = 'bank.dev'
   where company_id = (select company_id from users where id = '31600000-0000-4000-8000-0000000000d1');
  -- Any unbound work identity (the hook refuses work sign-in for it) offers
  -- Connect, whose begin releases it.
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values ('kc-stray', '31600000-0000-4000-8000-0000000000d1', '{}'::jsonb, 'keycloak', now(), now());
  if work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is distinct from 'google' then
    raise exception 'FAIL #406: Connect not offered for an unbound, hook-refused account';
  end if;
  delete from auth.identities where provider_id = 'kc-stray';
  raise notice 'PASS #406: the menu offers Connect until a bound account carries the current organization, and for any unbound account';
end $$;

-- #406 replace (a new account in the same organization): a new verified account replaces the user's binding,
-- the old identity is released and work sign-in keeps working.
-- Through begin, as the connect route runs it.
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
select begin_work_identity_connect('google', repeat('78', 32));
select pg_temp.act_as_server();
select pg_temp.sess('31600000-0000-4000-8000-0000000000e9', '31600000-0000-4000-8000-0000000000d1', 'aal2');
-- e9 signed in with the work account, ea with a password; both are revoked.
select pg_temp.sess('31600000-0000-4000-8000-0000000000ea', '31600000-0000-4000-8000-0000000000d1', 'aal2');
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  (gen_random_uuid(), '31600000-0000-4000-8000-0000000000e9', now(), now(), 'oauth'),
  (gen_random_uuid(), '31600000-0000-4000-8000-0000000000ea', now(), now(), 'password');
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-second', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-second', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'bank.dev')), 'keycloak', now(), now());
insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                             authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000d1', 'code-kc-second', 's256',
  rtrim(translate(encode(extensions.digest('verifier-kc-second', 'sha256'), 'base64'), '+/', '-_'), '='),
  'keycloak', 'oauth', now(), now(), now(), '31600000-0000-4000-8000-0000000000d1');
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
do $$
declare v_res jsonb;
begin
  v_res := complete_work_identity_connect(repeat('78', 32), 'code-kc-second', 'verifier-kc-second');
  if not coalesce((v_res->>'connected')::boolean, false) then
    raise exception 'FAIL #406 same org: completion returned %', v_res;
  end if;
end $$;
select pg_temp.act_as_server();
do $$
begin
  if (select array_agg(provider_subject) from work_identity_bindings
       where user_id = '31600000-0000-4000-8000-0000000000d1' and provider = 'google') is distinct from array['kc-second'] then
    raise exception 'FAIL #406 same org: expected only the new binding';
  end if;
  if exists (select 1 from auth.identities where provider_id = 'kc-dir') then
    raise exception 'FAIL #406 same org: the replaced identity was not released';
  end if;
  if not exists (select 1 from audit_log where action = 'work_identity_connected'
                  and detail->>'provider_subject' = 'kc-second' and detail->>'organization_id' = 'bank.dev'
                  and detail->'replaced' @> '[{"provider_subject":"kc-dir","organization_id":"bank.dev"}]') then
    raise exception 'FAIL #406 same org: the replacement was not audited with both accounts';
  end if;
  if exists (select 1 from auth.sessions where id in ('31600000-0000-4000-8000-0000000000e9',
                                                       '31600000-0000-4000-8000-0000000000ea')) then
    raise exception 'FAIL #406 same org: a session from before the replacement survived';
  end if;
  if not exists (select 1 from audit_log where action = 'work_identity_connected'
                  and detail->>'provider_subject' = 'kc-second' and (detail->>'sessions_revoked')::int >= 2) then
    raise exception 'FAIL #406 same org: the revoked sessions were not audited';
  end if;
  if not exists (select 1 from auth.sessions where id = '31600000-0000-4000-8000-0000000000c6') then
    raise exception 'FAIL #406 same org: the connecting session was revoked';
  end if;
  if not exists (select 1 from notifications where recipient_id = '31600000-0000-4000-8000-0000000000d1'
                  and event_type = 'work_identity_replaced') then
    raise exception 'FAIL #406 same org: the user was not notified of the replacement';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000d1', 'oauth') ? 'error' then
    raise exception 'FAIL #406 same org: work sign-in blocked after the replacement';
  end if;
  raise notice 'PASS #406 same org: a new account in the same organization replaces the binding and keeps sign-in working';
end $$;
select pg_temp.act_as_server();
update firm_identity_providers set organization_id = 'moved.dev'
 where company_id = (select company_id from users where id = '31600000-0000-4000-8000-0000000000d1');

-- #406 replace (a new account after an organization move): a new verified account replaces the user's binding,
-- the old identity is released and work sign-in keeps working.
insert into work_identity_connect_intents (user_id, session_id, provider, secret_digest)
values ('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'google', repeat('79', 32));
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-third', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-third', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'moved.dev')), 'keycloak', now(), now());
insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                             authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000d1', 'code-kc-third', 's256',
  rtrim(translate(encode(extensions.digest('verifier-kc-third', 'sha256'), 'base64'), '+/', '-_'), '='),
  'keycloak', 'oauth', now(), now(), now(), '31600000-0000-4000-8000-0000000000d1');
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
do $$
declare v_res jsonb;
begin
  v_res := complete_work_identity_connect(repeat('79', 32), 'code-kc-third', 'verifier-kc-third');
  if not coalesce((v_res->>'connected')::boolean, false) then
    raise exception 'FAIL #406 org move: completion returned %', v_res;
  end if;
end $$;
select pg_temp.act_as_server();
do $$
begin
  if (select array_agg(provider_subject) from work_identity_bindings
       where user_id = '31600000-0000-4000-8000-0000000000d1' and provider = 'google') is distinct from array['kc-third'] then
    raise exception 'FAIL #406 org move: expected only the new binding';
  end if;
  if exists (select 1 from auth.identities where provider_id = 'kc-second') then
    raise exception 'FAIL #406 org move: the replaced identity was not released';
  end if;
  if not exists (select 1 from audit_log where action = 'work_identity_connected'
                  and detail->>'organization_id' = 'moved.dev'
                  and detail->'replaced' @> '[{"provider_subject":"kc-second","organization_id":"bank.dev"}]') then
    raise exception 'FAIL #406 org move: the replacement was not audited';
  end if;
  if pg_temp.hook('31600000-0000-4000-8000-0000000000d1', 'oauth') ? 'error' then
    raise exception 'FAIL #406 org move: work sign-in blocked after the replacement';
  end if;
  raise notice 'PASS #406 org move: a new account after an organization move replaces the binding and keeps sign-in working';
end $$;

-- #406 the most recent Connect wins: a later begin consumes the earlier intent
-- and releases the account it linked.
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
select begin_work_identity_connect('google', repeat('7a', 32));
select pg_temp.act_as_server();
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-fourth', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-fourth', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'moved.dev')), 'keycloak', now(), now());
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
select begin_work_identity_connect('google', repeat('7b', 32));
select pg_temp.act_as_server();
do $$
begin
  if exists (select 1 from auth.identities where provider_id = 'kc-fourth') then
    raise exception 'FAIL #406 latest wins: the earlier attempt''s account was not released';
  end if;
end $$;
-- The overtaken tab still finishes at the provider: complete refuses it, and
-- the callback's failure path (work_identity_link_refusal) releases the account
-- it linked.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-late', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-late', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'moved.dev')), 'keycloak', now(), now());
insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                             authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000d1', 'code-kc-late', 's256',
  rtrim(translate(encode(extensions.digest('verifier-kc-late', 'sha256'), 'base64'), '+/', '-_'), '='),
  'keycloak', 'oauth', now(), now(), now(), '31600000-0000-4000-8000-0000000000d1');
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
select pg_temp.expect_error(
  $q$select complete_work_identity_connect(repeat('7a', 32), 'code-kc-late', 'verifier-kc-late')$q$,
  'connect_intent_invalid');
select pg_temp.act_as_server();
do $$
begin
  delete from auth.flow_state where auth_code = 'code-kc-late';
  -- The failed callback releases nothing (its cookie may be the winner's); the
  -- stray keeps Connect in the menu, and the next begin releases it.
  if work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is distinct from 'google' then
    raise exception 'FAIL #406 latest wins: the overtaken flow''s stray does not offer Connect';
  end if;
  perform release_unbound_identities('31600000-0000-4000-8000-0000000000d1');
  if exists (select 1 from auth.identities where provider_id = 'kc-late') then
    raise exception 'FAIL #406 latest wins: the overtaken flow''s account was left behind';
  end if;
  if (select count(*) from work_identity_connect_intents
       where user_id = '31600000-0000-4000-8000-0000000000d1' and consumed_at is null) <> 1
     or not exists (select 1 from work_identity_connect_intents
                     where secret_digest = repeat('7b', 32) and consumed_at is null) then
    raise exception 'FAIL #406 latest wins: expected only the latest intent live';
  end if;
  if (select array_agg(provider_subject) from work_identity_bindings
       where user_id = '31600000-0000-4000-8000-0000000000d1' and provider = 'google') is distinct from array['kc-third'] then
    raise exception 'FAIL #406 latest wins: the binding changed';
  end if;
  update work_identity_connect_intents set consumed_at = now() where secret_digest = repeat('7b', 32);
  raise notice 'PASS #406 latest wins: a later begin consumes the earlier intent; an overtaken callback releases what it linked';
end $$;

-- #406 same-account move: the bound account now carries the firm's current
-- organization. Connect is not offered (GoTrue would refuse the link) and the
-- binding is left as it is: acceptance keys on the subject and current claim.
update auth.identities
   set identity_data = jsonb_set(identity_data, '{custom_claims,hd}', '"bank.dev"')
 where provider_id = 'kc-third';
update firm_identity_providers set organization_id = 'bank.dev'
 where company_id = (select company_id from users where id = '31600000-0000-4000-8000-0000000000d1');
do $$
begin
  if work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is not null then
    raise exception 'FAIL #406 same-account move: Connect offered after the move';
  end if;
  if not exists (select 1 from work_identity_bindings
                  where provider_subject = 'kc-third' and user_id = '31600000-0000-4000-8000-0000000000d1') then
    raise exception 'FAIL #406 same-account move: the binding was dropped';
  end if;
  raise notice 'PASS #406 same-account move: no Connect offered and the binding kept';
end $$;

-- #406 what GoTrue's "Identity is already linked" means: already connected only
-- for a bound account carrying the current organization.
do $$
declare v_d1 constant uuid := '31600000-0000-4000-8000-0000000000d1';
begin
  if work_identity_link_refusal(v_d1) <> 'work_identity_already_connected' then
    raise exception 'FAIL #406 link refusal: current-org binding read as %', work_identity_link_refusal(v_d1);
  end if;
  update auth.identities set identity_data = jsonb_set(identity_data, '{custom_claims,hd}', '"old.dev"')
   where provider_id = 'kc-third';
  if work_identity_link_refusal(v_d1) <> 'work_identity_link_stale' then
    raise exception 'FAIL #406 link refusal: old-org binding read as %', work_identity_link_refusal(v_d1);
  end if;
  -- A stray beside a stale binding: the refused account may be the stray.
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values ('kc-stray3', v_d1, '{}'::jsonb, 'keycloak', now(), now());
  if work_identity_link_refusal(v_d1) <> 'work_identity_ambiguous' then
    raise exception 'FAIL #406 link refusal: a stray beside a stale binding read as %', work_identity_link_refusal(v_d1);
  end if;
  delete from auth.identities where provider_id = 'kc-stray3';
  update auth.identities set identity_data = jsonb_set(identity_data, '{custom_claims,hd}', '"bank.dev"')
   where provider_id = 'kc-third';
  -- Read only: a stray beside the bound current account blocks work sign-in,
  -- so Connect again; it is left for begin.
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values ('kc-stray2', v_d1, '{}'::jsonb, 'keycloak', now(), now());
  if work_identity_link_refusal(v_d1) <> 'work_identity_ambiguous'
     or not exists (select 1 from auth.identities where provider_id = 'kc-stray2') then
    raise exception 'FAIL #406 link refusal: the verdict changed or the stray was released';
  end if;
  delete from auth.identities where provider_id = 'kc-stray2';
  raise notice 'PASS #406 link refusal: already connected only for a bound current-organization account';
end $$;

-- #406 orphaned binding: the identity row behind the binding was removed, so
-- Connect is offered and GoTrue links the same subject again; complete
-- rebinds it over the user's own orphan.
delete from auth.identities where provider_id = 'kc-third';
do $$
begin
  if work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is distinct from 'google' then
    raise exception 'FAIL #406 orphan: Connect not offered for an orphaned binding';
  end if;
end $$;
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
select begin_work_identity_connect('google', repeat('7e', 32));
select pg_temp.act_as_server();
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-third', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-third', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'bank.dev')), 'keycloak', now(), now());
insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                             authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000d1', 'code-kc-re', 's256',
  rtrim(translate(encode(extensions.digest('verifier-kc-re', 'sha256'), 'base64'), '+/', '-_'), '='),
  'keycloak', 'oauth', now(), now(), now(), '31600000-0000-4000-8000-0000000000d1');
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
do $$
declare v_res jsonb;
begin
  v_res := complete_work_identity_connect(repeat('7e', 32), 'code-kc-re', 'verifier-kc-re');
  if v_res is distinct from '{"connected": true, "provider": "google"}'::jsonb then
    raise exception 'FAIL #406 orphan: reconnecting the same subject returned %', v_res;
  end if;
end $$;
select pg_temp.act_as_server();
do $$
begin
  if (select array_agg(provider_subject) from work_identity_bindings
       where user_id = '31600000-0000-4000-8000-0000000000d1' and provider = 'google') is distinct from array['kc-third']
     or work_identity_connectable_provider('31600000-0000-4000-8000-0000000000d1') is not null then
    raise exception 'FAIL #406 orphan: the same subject was not rebound';
  end if;
  raise notice 'PASS #406 orphan: the same subject reconnects over its orphaned binding';
end $$;

-- #406 provider switch: a binding from the firm's previous provider is
-- replaced by the connect, not kept beside it.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('az-old', '31600000-0000-4000-8000-0000000000d1', '{}'::jsonb,
        work_identity_auth_provider('azure'), now() - interval '1 day', now());
insert into work_identity_bindings (provider, provider_subject, user_id, organization_id, via)
values ('azure', 'az-old', '31600000-0000-4000-8000-0000000000d1', 'old-tenant', 'connect');
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
select begin_work_identity_connect('google', repeat('7f', 32));
select pg_temp.act_as_server();
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('kc-fifth', '31600000-0000-4000-8000-0000000000d1',
  jsonb_build_object('sub', 'kc-fifth', 'email', 'dir@bank.dev', 'email_verified', true,
                     'custom_claims', jsonb_build_object('hd', 'bank.dev')), 'keycloak', now(), now());
insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                             authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
values (gen_random_uuid(), '31600000-0000-4000-8000-0000000000d1', 'code-kc-fifth', 's256',
  rtrim(translate(encode(extensions.digest('verifier-kc-fifth', 'sha256'), 'base64'), '+/', '-_'), '='),
  'keycloak', 'oauth', now(), now(), now(), '31600000-0000-4000-8000-0000000000d1');
select pg_temp.act_as('31600000-0000-4000-8000-0000000000d1', '31600000-0000-4000-8000-0000000000c6', 'aal2');
do $$
declare v_res jsonb;
begin
  v_res := complete_work_identity_connect(repeat('7f', 32), 'code-kc-fifth', 'verifier-kc-fifth');
  if v_res is distinct from '{"connected": true, "provider": "google"}'::jsonb then
    raise exception 'FAIL #406 provider switch: connect returned %', v_res;
  end if;
end $$;
select pg_temp.act_as_server();
do $$
begin
  if (select array_agg(provider || ':' || provider_subject) from work_identity_bindings
       where user_id = '31600000-0000-4000-8000-0000000000d1') is distinct from array['google:kc-fifth']
     or exists (select 1 from auth.identities where provider_id = 'az-old')
     or not exists (select 1 from audit_log
                     where action = 'work_identity_connected' and detail ->> 'provider_subject' = 'kc-fifth'
                       and detail -> 'replaced' @> '[{"provider":"azure","provider_subject":"az-old"}]'::jsonb) then
    raise exception 'FAIL #406 provider switch: the previous provider''s binding survived the connect';
  end if;
  raise notice 'PASS #406 provider switch: a connect replaces the previous provider''s binding';
end $$;

-- #408: an invitation never moves an active user to another firm.
-- create_invite refuses an account that is no longer invited, so the case is
-- a user holding two pending invitations: the client's one stays pending while
-- the user becomes active at the bank (the bank's acceptance, simulated), then
-- the client's is accepted. It is refused with invite_other_firm and nothing
-- changes.
do $$
declare
  v_bank constant uuid := '31600000-0000-4000-8000-0000000000b1';
  v_client constant uuid := '31600000-0000-4000-8000-0000000000b2';
  v_u constant uuid := '31600000-0000-4000-8000-0000000001a9';
  v_inv uuid;
  v_attempt uuid;
  v_res jsonb;
begin
  perform pg_temp.act_as_server();
  insert into auth.users (id, email, created_at, updated_at) values (v_u, 'inv-408@client.dev', now(), now());
  v_res := create_invite('31600000-0000-4000-8000-0000000002d1', 'inv-408@client.dev', v_client,
    'member', null, null, null, null, 0, 'work_identity');
  v_inv := (v_res->>'id')::uuid;
  v_attempt := pg_temp.wi_prepare(v_inv, v_u, '31600000-0000-4000-8000-0000000001c9',
    'g-inv-408', 'client.dev', 'flow-408-verifier-000000000000000000000000000');
  update users set status = 'active', provisioning = 'authorized', company_id = v_bank,
         tenant_id = '31600000-0000-4000-8000-000000000001'
   where id = v_u;
  begin
    perform pg_temp.wi_accept(v_attempt, v_u, '31600000-0000-4000-8000-0000000001c9');
    raise exception 'FAIL #408: an active user was moved to another firm by an invitation';
  exception when others then
    if sqlerrm like 'FAIL #408%' then raise; end if;
    if sqlerrm <> 'invite_other_firm' then
      raise exception 'FAIL #408: refused with unexpected error %', sqlerrm;
    end if;
  end;
  perform pg_temp.act_as_server();
  if (select company_id from users where id = v_u) <> v_bank
     or (select status from invites where id = v_inv) <> 'pending' then
    raise exception 'FAIL #408: the refusal changed the user or the invitation';
  end if;
  raise notice 'PASS #408: an invitation from another firm is refused for an active user';
end $$;

-- ---------------------------------------------------------------------------
-- #316 (M365, 1/6) Microsoft binds tenant members only
-- ---------------------------------------------------------------------------
-- work_identity_org_claim: an azure identity reports lower(tid) only for a
-- tenant member (acct 0) whose domain Entra verified (xms_edov true or "1").
select pg_temp.act_as_server();
do $$
declare
  c record;
  v_got text;
begin
  for c in
    select * from (values
      (1,  '{"tid": "72F988BF-86F1-41AF-91AB-2D7CD011DB47", "acct": 0, "xms_edov": true}'::jsonb, '72f988bf-86f1-41af-91ab-2d7cd011db47'::text),
      (2,  '{"tid": "t-1", "acct": "0", "xms_edov": "1"}'::jsonb, 't-1'),
      (3,  '{"tid": "t-1", "acct": "0", "xms_edov": "true"}'::jsonb, 't-1'),
      (4,  '{"tid": "t-1", "acct": 1, "idp": "live.com", "xms_edov": true}'::jsonb, null),
      (5,  '{"tid": "t-1", "acct": "1", "xms_edov": true}'::jsonb, null),
      (6,  '{"tid": "t-1", "xms_edov": true}'::jsonb, null),
      (7,  '{"tid": "t-1", "acct": 0}'::jsonb, null),
      (8,  '{"tid": "t-1", "acct": 0, "xms_edov": false}'::jsonb, null),
      (9,  '{"tid": "t-1", "acct": 0, "xms_edov": "0"}'::jsonb, null),
      (10, '{"tid": "t-1", "acct": 0, "xms_edov": "false"}'::jsonb, null),
      (11, '{"tid": "t-1", "acct": 0, "xms_edov": null}'::jsonb, null),
      (12, '{"acct": 0, "xms_edov": true}'::jsonb, null),
      (13, '{"hd": "bank.dev", "acct": 0, "xms_edov": true}'::jsonb, null)
    ) as t(n, claims, expected)
  loop
    v_got := work_identity_org_claim('azure', jsonb_build_object('custom_claims', c.claims));
    if v_got is distinct from c.expected then
      raise exception 'FAIL azure org claim case %: expected %, got %', c.n, c.expected, v_got;
    end if;
  end loop;
  if work_identity_org_claim('azure', '{}'::jsonb) is not null
     or work_identity_org_claim('azure', null) is not null then
    raise exception 'FAIL azure org claim: an identity without custom_claims reported an organization';
  end if;
  -- Google is unchanged: hd, lower-cased, no acct or xms_edov needed.
  if work_identity_org_claim('google', '{"custom_claims": {"hd": "Bank.DEV"}}'::jsonb) is distinct from 'bank.dev'
     or work_identity_org_claim('google', '{"custom_claims": {"tid": "t-1", "acct": 0, "xms_edov": true}}'::jsonb) is not null
     or work_identity_org_claim('okta', '{"custom_claims": {"hd": "bank.dev", "tid": "t-1"}}'::jsonb) is not null then
    raise exception 'FAIL google org claim: the hd rule changed';
  end if;
  raise notice 'PASS azure org claim: tid only for a verified tenant member; google unchanged';
end $$;

-- An external firm mapped to azure (the stored tenant id is lower-cased) and its director.
do $$
declare
  v_t constant uuid := '31600000-0000-4000-8000-000000000001';
  v_az constant uuid := '31600000-0000-4000-8000-0000000000b5';
  v_dir constant uuid := '31600000-0000-4000-8000-0000000004d1';
begin
  insert into companies (id, tenant_id, name, type) values (v_az, v_t, 'WI Azure Client', 'client');
  insert into company_verified_domains (tenant_id, company_id, domain, source) values
    (v_t, v_az, 'az.dev', 'test');
  insert into firm_identity_providers (company_id, provider, organization_id, updated_by, updated_at)
  values (v_az, 'azure', '72f988bf-86f1-41af-91ab-2d7cd011db47', '31600000-0000-4000-8000-0000000000d1', now());
  insert into auth.users (id, email, created_at, updated_at) values (v_dir, 'azdir@az.dev', now(), now());
  perform authorize_provisioned_profile(v_dir, jsonb_build_object(
    'tenant_id', v_t, 'full_name', 'Azra Director', 'is_external', true,
    'company_id', v_az, 'company_role', 'director'));
end $$;

-- One Microsoft invitee: an auth user, a work-identity invite from the firm's
-- director, an attempt claimed from the invitee's own aal2 session with an azure
-- identity carrying p_claims, then the accept. Returns 'accepted' or the error
-- the accept raised. Case n has user 5000n, session 6000n, subject az-sub-n.
create function pg_temp.wi_azure_accept(
  p_n integer, p_claims jsonb, p_email boolean default true, p_verified boolean default true
) returns text language plpgsql as $$
declare
  v_az constant uuid := '31600000-0000-4000-8000-0000000000b5';
  v_user uuid := ('31600000-0000-4000-8000-00000005' || lpad(p_n::text, 4, '0'))::uuid;
  v_session uuid := ('31600000-0000-4000-8000-00000006' || lpad(p_n::text, 4, '0'))::uuid;
  v_email text := 'az-' || p_n::text || '@az.dev';
  v_verifier text := 'flow-az-verifier-' || lpad(p_n::text, 30, '0');
  v_invite uuid;
  v_nonce uuid;
  v_start jsonb;
  v_attempt uuid;
begin
  perform pg_temp.act_as_server();
  insert into auth.users (id, email, created_at, updated_at) values (v_user, v_email, now(), now());
  v_invite := (create_invite('31600000-0000-4000-8000-0000000004d1', v_email, v_az,
    'member', null, null, null, null, 0, 'work_identity') ->> 'id')::uuid;
  select credential_nonce into v_nonce from invites where id = v_invite;
  perform finalize_invite_delivery(v_invite);
  v_start := start_work_identity_attempt(v_invite, v_nonce, repeat('ab', 32));
  v_attempt := (v_start ->> 'attempt_id')::uuid;
  perform bind_work_identity_attempt_flow(v_attempt, repeat('ab', 32), pg_temp.s256(v_verifier));
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  values ('az-sub-' || p_n::text, v_user,
    jsonb_build_object('sub', 'az-sub-' || p_n::text, 'email_verified', p_verified, 'custom_claims', p_claims)
      || case when p_email then jsonb_build_object('email', v_email) else '{}'::jsonb end,
    'azure', now(), now(), now());
  perform pg_temp.sess(v_session, v_user, 'aal2');
  perform claim_work_identity_attempt(v_attempt, repeat('ab', 32), v_verifier, v_user, v_session);
  begin
    perform pg_temp.wi_accept(v_attempt, v_user, v_session);
    return 'accepted';
  exception when others then
    perform pg_temp.act_as_server();
    return sqlerrm;
  end;
end;
$$;

do $$
declare
  v_tid constant text := '72F988BF-86F1-41AF-91AB-2D7CD011DB47';  -- Entra's case; the mapping is lower-cased
  c record;
  v_got text;
begin
  for c in
    select * from (values
      (1,  jsonb_build_object('tid', v_tid, 'acct', 0, 'xms_edov', true), true, true, 'accepted'::text),
      (2,  jsonb_build_object('tid', v_tid, 'acct', '0', 'xms_edov', '1'), true, true, 'accepted'),
      (3,  jsonb_build_object('tid', v_tid, 'acct', 1, 'idp', 'live.com', 'xms_edov', true), true, true, 'work_identity_mismatch'),
      (4,  jsonb_build_object('tid', v_tid, 'xms_edov', true), true, true, 'work_identity_mismatch'),
      (5,  jsonb_build_object('tid', v_tid, 'acct', 0), true, true, 'work_identity_mismatch'),
      (6,  jsonb_build_object('tid', v_tid, 'acct', 0, 'xms_edov', false), true, true, 'work_identity_mismatch'),
      (7,  jsonb_build_object('tid', v_tid, 'acct', 0, 'xms_edov', '0'), true, true, 'work_identity_mismatch'),
      (8,  jsonb_build_object('tid', 'another-tenant', 'acct', 0, 'xms_edov', true), true, true, 'work_identity_mismatch'),
      (9,  jsonb_build_object('acct', 0, 'xms_edov', true), true, true, 'work_identity_mismatch'),
      (10, jsonb_build_object('tid', v_tid, 'acct', 0, 'xms_edov', true), false, true, 'work_identity_mismatch'),
      (11, jsonb_build_object('tid', v_tid, 'acct', 0, 'xms_edov', true), true, false, 'work_identity_mismatch')
    ) as t(n, claims, with_email, verified, expected)
    order by n
  loop
    v_got := pg_temp.wi_azure_accept(c.n, c.claims, c.with_email, c.verified);
    if v_got is distinct from c.expected then
      raise exception 'FAIL azure accept case %: expected %, got %', c.n, c.expected, v_got;
    end if;
  end loop;

  -- Only the two members were seated and bound, to the lower-cased tenant.
  if (select count(*) from work_identity_bindings where provider = 'azure') <> 2
     or exists (select 1 from work_identity_bindings
                 where provider = 'azure' and organization_id <> '72f988bf-86f1-41af-91ab-2d7cd011db47')
     or (select count(*) from users where company_id = '31600000-0000-4000-8000-0000000000b5'
                                      and status = 'active' and id::text like '31600000-0000-4000-8000-00000005%') <> 2 then
    raise exception 'FAIL azure accept: the members were not the only ones seated and bound';
  end if;
  -- A refusal consumes nothing: the guest's invitation is still pending and it holds no seat.
  if (select status from invites where email = 'az-3@az.dev') <> 'pending'
     or exists (select 1 from users where id = '31600000-0000-4000-8000-000000050003' and company_id is not null) then
    raise exception 'FAIL azure accept: a refused guest changed the invitation or the profile';
  end if;
  -- A bound member signs in; the refused guest's unbound identity does not.
  if pg_temp.hook('31600000-0000-4000-8000-000000050001', 'oauth') ? 'error' then
    raise exception 'FAIL azure accept: the seated member was refused a token';
  end if;
  raise notice 'PASS azure accept: a verified tenant member is accepted; guest, missing acct or xms_edov, wrong or missing tid, no email, unverified email are work_identity_mismatch';
end $$;

-- Connect (the member, case 1, from its surviving aal2 session): the same rule,
-- reported in-band as connected = false with work_identity_mismatch. The
-- refused identity is released; the binding stays. A member replaces it.
create function pg_temp.wi_azure_connect(p_digest text, p_code text, p_sub text, p_claims jsonb) returns jsonb
language plpgsql as $$
declare
  v_user constant uuid := '31600000-0000-4000-8000-000000050001';
  v_session constant uuid := '31600000-0000-4000-8000-000000060001';
  v_verifier text := 'verifier-' || p_code;
  v_res jsonb;
begin
  perform pg_temp.act_as(v_user, v_session, 'aal2');
  perform begin_work_identity_connect('azure', p_digest);
  perform pg_temp.act_as_server();
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (p_sub, v_user,
    jsonb_build_object('sub', p_sub, 'email', 'az-1@az.dev', 'email_verified', true, 'custom_claims', p_claims),
    'azure', now(), now());
  insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
                               authentication_method, created_at, updated_at, auth_code_issued_at, linking_target_id)
  values (gen_random_uuid(), v_user, p_code, 's256',
    rtrim(translate(encode(extensions.digest(v_verifier, 'sha256'), 'base64'), '+/', '-_'), '='),
    'azure', 'oauth', now(), now(), now(), v_user);
  perform pg_temp.act_as(v_user, v_session, 'aal2');
  v_res := complete_work_identity_connect(p_digest, p_code, v_verifier);
  perform pg_temp.act_as_server();
  return v_res;
end;
$$;

do $$
declare
  v_tid constant text := '72F988BF-86F1-41AF-91AB-2D7CD011DB47';
  c record;
  v_res jsonb;
begin
  for c in
    select * from (values
      (1, 'az-guest',   jsonb_build_object('tid', v_tid, 'acct', 1, 'idp', 'live.com', 'xms_edov', true)),
      (2, 'az-nodov',   jsonb_build_object('tid', v_tid, 'acct', 0)),
      (3, 'az-foreign', jsonb_build_object('tid', 'another-tenant', 'acct', 0, 'xms_edov', true))
    ) as t(n, sub, claims)
    order by n
  loop
    v_res := pg_temp.wi_azure_connect(repeat(to_hex(160 + c.n), 32), 'code-' || c.sub, c.sub, c.claims);
    if v_res is distinct from '{"connected": false, "error": "work_identity_mismatch"}'::jsonb then
      raise exception 'FAIL azure connect %: returned %', c.sub, v_res;
    end if;
    if exists (select 1 from auth.identities where provider_id = c.sub)
       or not exists (select 1 from work_identity_bindings
                       where provider = 'azure' and provider_subject = 'az-sub-1'
                         and user_id = '31600000-0000-4000-8000-000000050001') then
      raise exception 'FAIL azure connect %: the refused identity survived or the binding changed', c.sub;
    end if;
  end loop;

  v_res := pg_temp.wi_azure_connect(repeat('a4', 32), 'code-az-member', 'az-member',
    jsonb_build_object('tid', v_tid, 'acct', 0, 'xms_edov', true));
  if v_res is distinct from '{"connected": true, "provider": "azure"}'::jsonb then
    raise exception 'FAIL azure connect: a verified tenant member returned %', v_res;
  end if;
  if (select array_agg(provider_subject) from work_identity_bindings
       where user_id = '31600000-0000-4000-8000-000000050001' and provider = 'azure') is distinct from array['az-member']
     or not work_identity_bound_current('31600000-0000-4000-8000-000000050001', 'azure',
          '72f988bf-86f1-41af-91ab-2d7cd011db47') then
    raise exception 'FAIL azure connect: the member did not replace the binding';
  end if;
  raise notice 'PASS azure connect: a guest, an unverified or a foreign-tenant identity is work_identity_mismatch; a verified member connects';
end $$;

-- service_role asks has_unbound (the callback); the browser roles cannot.
do $$
begin
  if not has_function_privilege('service_role', 'work_identity_has_unbound(uuid)', 'execute')
     or has_function_privilege('anon', 'work_identity_has_unbound(uuid)', 'execute')
     or has_function_privilege('authenticated', 'work_identity_has_unbound(uuid)', 'execute') then
    raise exception 'FAIL grant: work_identity_has_unbound is not service_role only';
  end if;
  -- A member with every identity bound has none unbound; the guest's identity (case 3) is unbound.
  if work_identity_has_unbound('31600000-0000-4000-8000-000000050001')
     or not work_identity_has_unbound('31600000-0000-4000-8000-000000050003') then
    raise exception 'FAIL grant: work_identity_has_unbound answered wrongly';
  end if;
  raise notice 'PASS grant: work_identity_has_unbound is executable by service_role only';
end $$;

-- ---------------------------------------------------------------------------
-- Server release helper, removal of a mapping, privileges
-- ---------------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_res jsonb;
begin
  v_n := release_unbound_identities('31600000-0000-4000-8000-0000000000a2');
  if v_n <> 1 or exists (select 1 from auth.identities where provider_id = 'g-otto') then
    raise exception 'FAIL: release_unbound_identities released %', v_n;
  end if;
  if exists (select 1 from auth.identities where provider_id in ('g-ivy', 'kc-third')) then
    null;
  else
    raise exception 'FAIL: a bound identity was released';
  end if;

  v_res := set_firm_identity_provider('31600000-0000-4000-8000-0000000000d1',
    '31600000-0000-4000-8000-0000000000b1', null, null);
  if exists (select 1 from firm_identity_providers where company_id = '31600000-0000-4000-8000-0000000000b1')
     or not exists (select 1 from audit_log where action = 'identity_provider_removed') then
    raise exception 'FAIL: removing the mapping did not delete and audit';
  end if;

  if has_function_privilege('authenticated', 'authorize_provisioned_profile(uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'start_work_identity_attempt(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'bind_work_identity_attempt_flow(uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'claim_work_identity_attempt(uuid,text,text,uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'set_firm_identity_provider(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'release_unbound_identities(uuid,text)', 'execute')
     or has_table_privilege('authenticated', 'work_identity_bindings', 'select')
     or has_table_privilege('authenticated', 'work_identity_broker_aliases', 'select')
     or has_table_privilege('authenticated', 'firm_identity_providers', 'select') then
    raise exception 'FAIL: a server-only object is reachable by the browser role';
  end if;
  if exists (select 1 from pg_proc where proname = 'accept_invite' and pronargs = 2) then
    raise exception 'FAIL: the two-argument accept_invite still exists';
  end if;
  raise notice 'PASS: release helper, mapping removal and privileges';
end $$;

rollback;
