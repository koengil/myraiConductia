-- #316 (M365 sign-in, code 1/6): the access-token hook carries a claim and
-- rechecks bindings on refresh; a Microsoft identity binds only as a tenant member.
--
-- 1. work_identity_access_token_hook adds `work_identity_hook: 1` to every token
--    it issues. A project whose tokens lack it is a project where the hook is
--    not enabled (or this migration is not applied); the app refuses
--    work-identity sessions without it (code 2/6). Nothing requires the claim
--    yet. A refusal still carries no claims.
-- 2. The binding rule also runs on every later token of a session born from
--    an OAuth sign-in (claims.amr lists `oauth`; GoTrue carries amr across
--    refreshes and adds to it on an MFA step-up): `token_refresh`, a `totp`
--    step-up, and any other method whose session amr holds `oauth`. Before
--    this, #320's contract ("an identity that is not bound gets no token") held
--    only at the sign-in itself: a binding removed afterwards did not stop the
--    session refreshing or stepping up. Password-born sessions are not
--    touched. A suspended account is still refused first.
-- 3. work_identity_org_claim: an `azure` identity reports its tenant (`tid`)
--    only when `acct` is '0' (a tenant member, not a guest of any kind,
--    personal Microsoft accounts included) and `xms_edov` is true ('true' or
--    '1'; Entra emits it only for a Verified domain). A guest, a missing acct, a
--    missing, false or '0' xms_edov report no organization, so the accept and
--    connect paths refuse them with work_identity_mismatch. Google (`hd`) is
--    unchanged. Checked when a binding is created or connected: a member later
--    converted to a guest keeps signing in until the binding is removed
--    (accepted limitation, recorded in the decision log).
-- 4. The callback (code 3/6) asks work_identity_has_unbound as the service
--    role. The function itself is unchanged (20261010100000).
--
-- The hook is a full restatement of 20261002100000 with the pg_temp-pinned
-- search_path 20261016100000 gave it; work_identity_org_claim restates
-- 20261002100000 (it is not a definer and keeps `search_path = public`).
-- create or replace keeps owner and grants; the hook's are restated below.
--
-- Reverse: restate both functions from 20261002100000 (the hook with
-- `set search_path = public, pg_temp`), and
-- `revoke execute on function work_identity_has_unbound(uuid) from service_role`.

create or replace function work_identity_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := (event ->> 'user_id')::uuid;
  v_method text := event ->> 'authentication_method';
  v_profile users%rowtype;
  v_oauth_born boolean := false;
begin
  select * into v_profile from users where id = v_user;
  if v_profile.status = 'suspended' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'account_suspended'));
  end if;

  -- A later token of a session that began with an OAuth sign-in: a refresh,
  -- an MFA step-up, or any method other than the oauth sign-in itself (which
  -- the rule below judges directly). amr is the list GoTrue keeps on the
  -- session: objects ({"method": "oauth", ...}); a bare string element is read
  -- the same way. An absent or malformed amr is not OAuth-born.
  if v_method is distinct from 'oauth' and jsonb_typeof(event #> '{claims,amr}') = 'array' then
    select exists (
      select 1 from jsonb_array_elements(event #> '{claims,amr}') a
       where (case jsonb_typeof(a) when 'object' then a ->> 'method' when 'string' then a #>> '{}' end) = 'oauth'
    ) into v_oauth_born;
  end if;

  if v_method = 'oauth' or v_oauth_born then
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

  -- The marker the app requires on a work-identity session (code 2/6).
  return jsonb_build_object('claims',
    coalesce(event -> 'claims', '{}'::jsonb) || jsonb_build_object('work_identity_hook', 1));
end;
$$;

revoke all on function work_identity_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function work_identity_access_token_hook(jsonb) to supabase_auth_admin;

-- The org claim a provider reports for an identity: Google's hosted domain,
-- Microsoft's tenant id, the latter only for a verified tenant member.
-- Lower-cased so a domain or tenant id compares case-insensitively.
create or replace function work_identity_org_claim(p_provider text, p_identity_data jsonb)
returns text language sql immutable set search_path = public as $$
  select lower(case p_provider
    when 'google' then p_identity_data #>> '{custom_claims,hd}'
    when 'azure' then
      case when (p_identity_data #>> '{custom_claims,acct}') = '0'
            and lower(btrim(p_identity_data #>> '{custom_claims,xms_edov}')) in ('true', '1')
           then p_identity_data #>> '{custom_claims,tid}'
      end
  end);
$$;

-- The callback asks whether the signed-in user holds an unbound work identity.
-- 20261010100000 revoked the function from the browser roles and granted it to
-- nobody; the server role is granted explicitly.
grant execute on function work_identity_has_unbound(uuid) to service_role;
