-- Invite wrong-recipient safeguard and recipient verification challenge.
-- Additive security migration for the approved invite-safeguard-2fa plan.
--
-- Plain verification codes never cross this boundary. The application passes
-- only a peppered HMAC-SHA256 digest (64 lowercase hexadecimal characters).

-- ---------------------------------------------------------------------------
-- Trusted, operations-supplied company domains.
-- ---------------------------------------------------------------------------
create table if not exists company_verified_domains (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  company_id  uuid not null references companies (id) on delete cascade,
  domain      text not null
              check (
                domain = lower(trim(domain))
                and domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9-]*$'
                and domain !~ '\.\.'
                and position('@' in domain) = 0
                and domain not in (
                  'aol.com','gmail.com','googlemail.com','hotmail.com','icloud.com',
                  'live.com','mail.com','me.com','msn.com','outlook.com','proton.me',
                  'protonmail.com','yahoo.com','yandex.com','zoho.com'
                )
              ),
  source      text not null check (length(trim(source)) > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, domain)
);

create index if not exists company_verified_domains_tenant_idx
  on company_verified_domains (tenant_id, company_id);

create or replace function public.prepare_company_verified_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_tenant uuid;
begin
  select tenant_id into v_company_tenant
    from companies
   where id = new.company_id;
  if v_company_tenant is null then
    raise exception 'company_not_found';
  end if;

  new.domain := lower(trim(new.domain));
  new.tenant_id := v_company_tenant;
  if tg_op = 'INSERT' then
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Serialize changes to a company's domain set with invite preflight/create so
-- a concurrent insert or delete cannot create a snapshot phantom.
create or replace function public.lock_company_verified_domain_set()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
begin
  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'company_id_immutable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text, 1));
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists lock_company_verified_domain_set_row on company_verified_domains;
create trigger lock_company_verified_domain_set_row
  before insert or update or delete on company_verified_domains
  for each row execute function public.lock_company_verified_domain_set();

drop trigger if exists prepare_company_verified_domain_row on company_verified_domains;
create trigger prepare_company_verified_domain_row
  before insert or update on company_verified_domains
  for each row execute function public.prepare_company_verified_domain();

-- Stable, sorted set used to bind a mismatch confirmation to the exact
-- operations reference data observed at preflight time.
create or replace function public.company_verified_domain_snapshot(p_company_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(domain order by domain), '{}'::text[])
    from company_verified_domains
   where company_id = p_company_id
$$;

-- Mirrors the server-side classifier. Personal domains always win, including
-- over accidental trusted data, followed by empty-set and suffix matching.
create or replace function public.classify_invite_email_domain(
  p_email_domain text,
  p_verified_domains text[]
) returns text
language sql
immutable
security definer
set search_path = public
as $$
  select case
    when p_email_domain = any (array[
      'aol.com','gmail.com','googlemail.com','hotmail.com','icloud.com',
      'live.com','mail.com','me.com','msn.com','outlook.com','proton.me',
      'protonmail.com','yahoo.com','yandex.com','zoho.com'
    ]) then 'personal'
    when cardinality(p_verified_domains) = 0 then 'unverified'
    when exists (
      select 1
        from unnest(p_verified_domains) as configured(domain)
       where p_email_domain = configured.domain
          or p_email_domain like ('%.' || configured.domain)
    ) then 'match'
    else 'mismatch'
  end
$$;

-- ---------------------------------------------------------------------------
-- One-time, 60-minute mismatch confirmations.
-- ---------------------------------------------------------------------------
create table if not exists invite_domain_confirmations (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null,
  actor_id                   uuid not null references users (id) on delete cascade,
  email                      text not null check (email = lower(trim(email))),
  company_id                 uuid not null references companies (id) on delete cascade,
  company_role               text not null check (company_role in ('director','member')),
  deal_id                    uuid references deals (id) on delete cascade,
  deal_role                  text check (deal_role in
                               ('md','deal_team','legal','seller','buyer','read_only')),
  classification             text not null
                             check (classification in ('mismatch','personal','unverified')),
  verified_domains_snapshot  text[] not null default '{}'::text[],
  created_at                 timestamptz not null default now(),
  expires_at                 timestamptz not null default now() + interval '60 minutes',
  consumed_at                timestamptz,
  consumed_invite_id         uuid references invites (id),
  constraint invite_domain_confirmation_consumed_pair
    check ((consumed_at is null) = (consumed_invite_id is null)),
  constraint invite_domain_confirmation_deal_pair
    check ((deal_id is null) = (deal_role is null))
);

create index if not exists invite_domain_confirmations_actor_idx
  on invite_domain_confirmations (actor_id, expires_at desc);
create index if not exists invite_domain_confirmations_company_idx
  on invite_domain_confirmations (company_id, expires_at desc);

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
  if v_company_tenant is distinct from v_actor_tenant then
    raise exception 'tenant_mismatch';
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

drop trigger if exists prepare_invite_domain_confirmation_row on invite_domain_confirmations;
create trigger prepare_invite_domain_confirmation_row
  before insert on invite_domain_confirmations
  for each row execute function public.prepare_invite_domain_confirmation();

-- ---------------------------------------------------------------------------
-- Challenge state. Existing pending rows deliberately retain NULL state and
-- therefore fail closed until an authorized resend rotates in a fresh code.
-- ---------------------------------------------------------------------------
alter table invites add column if not exists challenge_digest text;
alter table invites add column if not exists challenge_version integer not null default 0;
alter table invites add column if not exists challenge_issued_at timestamptz;
alter table invites add column if not exists challenge_attempts integer not null default 0;
alter table invites add column if not exists challenge_locked_at timestamptz;
alter table invites add column if not exists challenge_verified_at timestamptz;
alter table invites add column if not exists challenge_verified_user_id uuid references users (id);
alter table invites add column if not exists challenge_verified_version integer;

alter table invites drop constraint if exists invites_challenge_digest_check;
alter table invites add constraint invites_challenge_digest_check
  check (challenge_digest is null or challenge_digest ~ '^[0-9a-f]{64}$');
alter table invites drop constraint if exists invites_challenge_version_check;
alter table invites add constraint invites_challenge_version_check
  check (challenge_version >= 0);
alter table invites drop constraint if exists invites_challenge_attempts_check;
alter table invites add constraint invites_challenge_attempts_check
  check (challenge_attempts between 0 and 5);
alter table invites drop constraint if exists invites_challenge_state_check;
alter table invites add constraint invites_challenge_state_check check (
  (
    challenge_digest is null
    and challenge_version = 0
    and challenge_issued_at is null
    and challenge_attempts = 0
    and challenge_locked_at is null
    and challenge_verified_at is null
    and challenge_verified_user_id is null
    and challenge_verified_version is null
  )
  or
  (
    challenge_digest is not null
    and challenge_version > 0
    and challenge_issued_at is not null
    and ((challenge_locked_at is null and challenge_attempts < 5)
      or (challenge_locked_at is not null and challenge_attempts = 5))
    and (
      (challenge_verified_at is null
        and challenge_verified_user_id is null
        and challenge_verified_version is null)
      or
      (challenge_verified_at is not null
        and challenge_verified_user_id is not null
        and challenge_verified_version = challenge_version
        and challenge_locked_at is null)
    )
  )
);

-- Compare fixed-size hexadecimal digests with the same full traversal for a
-- match and mismatch. The plaintext code and pepper never enter PostgreSQL.
create or replace function public.constant_work_digest_equal(p_left text, p_right text)
returns boolean
language plpgsql
immutable
security definer
set search_path = public
as $$
declare
  v_difference integer := 0;
  v_index integer;
begin
  if p_left is null or p_right is null
     or octet_length(p_left) <> 64 or octet_length(p_right) <> 64
  then
    return false;
  end if;

  for v_index in 1..64 loop
    v_difference := v_difference
      | (ascii(substr(p_left, v_index, 1)) # ascii(substr(p_right, v_index, 1)));
  end loop;
  return v_difference = 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit actions. Re-add the complete latest action set plus safeguard/MFA
-- outcomes so later application work can only record non-secret metadata.
-- 2026-09-14 replay repair: skill authoring/publication and rail actions
-- landed on later migrations without ever widening this list, so a lived-in
-- database that already holds those rows fails this validated re-add. `not
-- valid` here for the same reason as 20260612160000: the later, wider
-- migrations re-add the full, validated constraint.
-- ---------------------------------------------------------------------------
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance','attest',
    'screen','send','release','invite_sent','invite_accepted','invite_revoked','reject',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated',
    'invite_verification_succeeded','invite_verification_locked',
    'mfa_enrolled','mfa_challenged'
  )) not valid;

-- ---------------------------------------------------------------------------
-- Redefined invite RPCs. Drop the superseded overloads first so no caller can
-- bypass the mandatory challenge arguments through the historical signatures.
-- ---------------------------------------------------------------------------
revoke all on function public.create_invite(uuid, text, uuid, text, uuid, text) from public;
drop function public.create_invite(uuid, text, uuid, text, uuid, text);

create or replace function public.create_invite(
  p_actor uuid,
  p_email text,
  p_company_id uuid,
  p_company_role text,
  p_challenge_digest text,
  p_domain_confirmation_id uuid default null,
  p_deal_id uuid default null,
  p_deal_role text default null
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
begin
  select tenant_id into v_tenant from users where id = p_actor;
  if v_tenant is null then raise exception 'actor_not_found'; end if;

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

  select tenant_id into v_company_tenant from companies where id = p_company_id;
  if v_company_tenant is null then raise exception 'company_not_found'; end if;
  if v_company_tenant is distinct from v_tenant then raise exception 'tenant_mismatch'; end if;

  if p_deal_id is not null then
    select tenant_id into v_deal_tenant from deals where id = p_deal_id;
    if v_deal_tenant is null then raise exception 'deal_not_found'; end if;
    if v_deal_tenant is distinct from v_tenant then raise exception 'tenant_mismatch'; end if;
  end if;

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
    challenge_digest, challenge_version, challenge_issued_at
  ) values (
    v_tenant, v_email, p_actor, p_company_id, p_company_role, p_deal_id, p_deal_role,
    p_challenge_digest, 1, now()
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

revoke all on function public.rotate_invite_credential(uuid) from public;
drop function public.rotate_invite_credential(uuid);

create or replace function public.rotate_invite_credential(
  p_invite_id uuid,
  p_challenge_digest text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
         expires_at = now() + interval '7 days',
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
$$;

create or replace function public.verify_invite_challenge(
  p_invite_id uuid,
  p_nonce uuid,
  p_code_digest text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- Acceptance retains the previous atomic grant transaction and adds the
-- current-recipient/current-version verification gate before any mutation.
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
    values (v_invite.deal_id, v_user, v_role_id, v_invite.deal_role, 0, v_invite.invited_by)
    on conflict (deal_id, user_id) do nothing;

    insert into audit_log (actor_id, action, deal_id, detail) values (
      v_invite.invited_by,
      'grant',
      v_invite.deal_id,
      jsonb_build_object(
        'user_id', v_user, 'deal_role', v_invite.deal_role, 'phase', 0, 'via', 'invite'
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
$$;

-- Protected reference/confirmation rows remain server-only. Authenticated
-- invitees receive only the two session-bound RPCs required to verify/accept.
alter table company_verified_domains enable row level security;
alter table invite_domain_confirmations enable row level security;
revoke all on company_verified_domains from anon, authenticated;
revoke all on invite_domain_confirmations from anon, authenticated;
grant select, insert, update, delete on company_verified_domains to service_role;
grant select, insert, update, delete on invite_domain_confirmations to service_role;

revoke all on function public.prepare_company_verified_domain() from public;
revoke all on function public.lock_company_verified_domain_set() from public;
revoke all on function public.company_verified_domain_snapshot(uuid) from public;
revoke all on function public.classify_invite_email_domain(text, text[]) from public;
revoke all on function public.prepare_invite_domain_confirmation() from public;
revoke all on function public.constant_work_digest_equal(text, text) from public;
revoke all on function public.create_invite(uuid, text, uuid, text, text, uuid, uuid, text) from public;
revoke all on function public.rotate_invite_credential(uuid, text) from public;
revoke all on function public.verify_invite_challenge(uuid, uuid, text) from public;
revoke all on function public.accept_invite(uuid, uuid) from public;

grant execute on function public.create_invite(uuid, text, uuid, text, text, uuid, uuid, text)
  to service_role;
grant execute on function public.rotate_invite_credential(uuid, text) to service_role;
grant execute on function public.verify_invite_challenge(uuid, uuid, text) to authenticated;
grant execute on function public.accept_invite(uuid, uuid) to authenticated;
grant execute on function public.accept_invite(uuid, uuid) to service_role;
