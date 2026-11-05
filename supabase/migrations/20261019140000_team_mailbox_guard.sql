-- supabase/migrations/20261019140000_team_mailbox_guard.sql
-- Admin-managed team inbox (#581), phase 7: the #262 guard learns about a verified team inbox.
--
-- Until now the guard refused every team source, as it refuses any source nobody opted in. This
-- migration gives it one new branch, so the worker may read a team inbox the Google Directory has
-- confirmed is a real user mailbox, through the same guard, page by page, and only while that
-- confirmation is fresh. Three pieces:
--   1. allowed_team_mailboxes, the team half of the allowlist. It carries NO time term: it is what
--      RLS, candidate visibility and the provider group mirror will read, so a Pause, a worker
--      outage or a directory blip must never change what it holds (design R7, review round 2 M-A).
--   2. mailbox_guard_verdict, restated with the team branch. The personal path below the branch is
--      the #262 body, unchanged. Freshness (verified within 65 minutes) is judged here and nowhere
--      else. The verdict also learns the purpose of the read, so a null owner is admitted for the
--      worker's provider_read and for nothing else (review round 2 M-B).
--   3. mailbox_guard_check, restated (the phase 2 body) to pass the purpose through, and the
--      mailbox_guard_state.last_reason CHECK, restated with the three team reasons.
--   4. discovery_team_mailboxes(), restated with readRefusal, the worker's last refused read of the inbox
--      (audit item 3: a Ready inbox outside the ingest group is never read, and the card says so).
--
-- Nothing here makes anything visible: the RLS helpers, the candidate visibility and the member
-- list are later phases, so what a team source stores is seen by nobody until then.

-- ── 1. The team half of the allowlist ──────────────────────────────────────
-- One row per readable team address and provider: an open registration the Directory confirmed at
-- least once (verified_at is not null) and has not since refused, on a provider whose active
-- registration lists the address's domain and names the registration's firm
-- (mailbox_reader_providers, the one place both are joined, as for allowed_mailboxes), that no
-- person has since come to own. A user, or an invite that is pending or accepted, whose address is
-- this one makes it a person's mailbox, which a team registration may never be (design R8; connect
-- refuses it, and this drops an address that became one later).
-- The provider is the registration's own (Gmail only today), not every provider that lists the domain.
-- No clock: how recently the Directory confirmed the address is the guard's question alone.
create or replace view allowed_team_mailboxes as
select tm.tenant_id, tm.address, tm.id as team_mailbox_id, tm.firm_company_id, tm.verified_at, p.provider
from team_mailboxes tm
cross join lateral unnest(mailbox_reader_providers(tm.tenant_id, tm.address, tm.firm_company_id)) as p(provider)
where tm.disconnected_at is null
  and tm.verified_at is not null
  and tm.check_status <> 'refused'
  and p.provider = tm.provider
  and not exists (select 1 from users u where lower(u.email) = tm.address)
  and not exists (
    select 1 from invites i
    where i.tenant_id = tm.tenant_id and lower(i.email) = tm.address and i.status in ('pending', 'accepted')
  );

-- Like allowed_mailboxes: nobody but the service role reads it, and RLS helpers read it from inside
-- security definer functions. service_role is named in the revoke because Supabase's default
-- privileges give it ALL on every new relation, views included.
revoke all on allowed_team_mailboxes from public, anon, authenticated, service_role;
grant select on allowed_team_mailboxes to service_role;

-- ── 2. The refusal reasons the guard remembers ─────────────────────────────
-- Restated in full from 20261001130000_mailbox_allowlist.sql (the only definition on this base),
-- with the three team reasons after the mailbox ones and before the site ones, as the TS list
-- (SOURCE_REFUSAL_REASONS) orders them.
alter table mailbox_guard_state drop constraint if exists mailbox_guard_state_last_reason_check;
alter table mailbox_guard_state add constraint mailbox_guard_state_last_reason_check
  check (last_reason in (
                 'no_invite', 'seat_inactive', 'external', 'no_consent', 'domain',
                 'owner_mismatch', 'not_in_provider_group', 'mirror_unavailable',
                 'registration_inactive',
                 'provider_mismatch',
                 'no_source',
                 'source_paused',
                 -- a team inbox the Directory has not confirmed (never, no longer, or not recently enough)
                 'team_mailbox_unverified',
                 -- a team inbox whose registration was closed
                 'team_mailbox_disconnected',
                 -- a team inbox whose address is now a person's
                 'team_mailbox_person',
                 'site_not_registered', 'site_wrong_firm',
                 'site_registrant_lost'));

-- ── 3. The decision ─────────────────────────────────────────────────────────
-- The verdict gains a sixth argument, so the five-argument function goes first: leaving it would make
-- every five-argument caller (the member's readiness status, the health RPCs) ambiguous between two
-- functions. Nothing in the database depends on it by signature.
drop function if exists mailbox_guard_verdict(uuid, text, text, boolean, uuid);

-- As in 20261001130000_mailbox_allowlist.sql, plus p_purpose and the block marked #581. A source with no
-- registration (every personal mailbox) never enters the block, so for it the body from the allowlist
-- lookup down is byte for byte the #262 one.
--
-- The team branch, for a source that belongs to a registration (content_sources.team_mailbox_id):
--   in allowed_team_mailboxes for the source's own provider and registration:
--     team_mailbox_unverified  the Directory last confirmed it 65 minutes ago or more. The read stops;
--                              the worker renews the check before a pass at 15 minutes and once mid-pass.
--                              Freshness is read from verified_at, which only a success moves, so a
--                              directory blip (a recorded error) cannot make a stale check look fresh.
--     owner_mismatch           a team source has no owner, so the caller must not name one yet (a member's
--                              read is a later phase), and only the worker's provider_read may name none:
--                              a tool, search, retrieval or export read of a team source is refused
--     source_paused            the source is not active
--     null                     allowed
--   not in the view, the most fundamental missing condition, in this order:
--     registration_inactive    the provider has no active registration for the tenant
--     domain                   no active registration of the source's provider lists the address's domain
--                              for the registration's firm
--     team_mailbox_disconnected  the registration is closed
--     team_mailbox_person      the address is now a user's or an invite's
--     team_mailbox_unverified  anything else: pending, refused, or never confirmed
-- Writes nothing; the guard writes the refusal's audit row.
create or replace function mailbox_guard_verdict(
  p_tenant_id       uuid,
  p_address         text,
  p_provider        text default null,
  p_check_owner     boolean default false,
  p_owner_user_id   uuid default null,
  p_purpose         text default 'provider_read'
)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_address  text := lower(trim(coalesce(p_address, '')));
  v_source   content_sources%rowtype;
  v_allowed  allowed_mailboxes%rowtype;
  v_invite   invites%rowtype;
  v_company  companies%rowtype;
  v_user     users%rowtype;
  v_tm       team_mailboxes%rowtype;
  v_verified timestamptz;
begin
  -- The source's own provider (C5): the mailbox is judged against THAT provider's
  -- registration, never the union of them. content_sources holds one row per
  -- address (unique index), and every source is written before it is read; an
  -- address with no source row has no provider of its own and is refused here
  -- (`no_source`), never judged as a default provider.
  select * into v_source from content_sources cs
  where cs.tenant_id = p_tenant_id and cs.kind = 'mailbox' and lower(cs.address) = v_address;
  if not found then
    return 'no_source';
  end if;
  if p_provider is not null and p_provider <> v_source.provider then
    -- Refused before any allowlist test, so no other provider's registration can stand in.
    return 'provider_mismatch';
  end if;

  -- #581: a team inbox is judged against its registration, not against a person's consent.
  if v_source.team_mailbox_id is not null then
    select a.verified_at into v_verified from allowed_team_mailboxes a
    where a.tenant_id = p_tenant_id and a.address = v_address and a.provider = v_source.provider
      and a.team_mailbox_id = v_source.team_mailbox_id
    limit 1;
    if found then
      -- A team source belongs to the firm. content_sources_team_ownerless keeps it ownerless; a row that
      -- somehow had an owner is no team source, so it fails closed.
      if v_source.owner_user_id is not null then
        return 'owner_mismatch';
      end if;
      -- Read freshness, here only. verified_at moves on a success alone.
      if v_verified <= now() - interval '65 minutes' then
        return 'team_mailbox_unverified';
      end if;
      if p_owner_user_id is not null then
        -- No member may read a team source through the guard yet (a later phase admits the registration's readers).
        return 'owner_mismatch';
      elsif p_purpose is distinct from 'provider_read' then
        -- The worker's own read names no owner. Any other purpose acts for a person, who must be named.
        return 'owner_mismatch';
      elsif v_source.status <> 'active' then
        return 'source_paused';
      end if;
      return null;
    end if;

    select * into v_tm from team_mailboxes t where t.id = v_source.team_mailbox_id;
    if not reader_registration_active(p_tenant_id, v_source.provider) then
      return 'registration_inactive';
    elsif v_tm.id is not null
          and not (v_source.provider = any (mailbox_reader_providers(p_tenant_id, v_address, v_tm.firm_company_id))) then
      return 'domain';
    elsif v_tm.id is null or v_tm.disconnected_at is not null then
      return 'team_mailbox_disconnected';
    elsif exists (select 1 from users u where lower(u.email) = v_address)
          or exists (select 1 from invites i
                     where i.tenant_id = p_tenant_id and lower(i.email) = v_address and i.status in ('pending', 'accepted')) then
      return 'team_mailbox_person';
    end if;
    return 'team_mailbox_unverified';
  end if;

  select * into v_allowed from allowed_mailboxes
  where tenant_id = p_tenant_id and address = v_address and provider = v_source.provider limit 1;
  if found then
    -- The source's CURRENT owner must be the allowlisted user, for every purpose
    -- (C11; design premise 4). The reader asks before every page with the source
    -- row it read when the pass began, so a source handed to someone else
    -- mid-backfill fails here, whatever owner the caller still carries. A source
    -- with no owner fails too: a mailbox is read for one person.
    if v_source.owner_user_id is distinct from v_allowed.user_id then
      return 'owner_mismatch';
    elsif p_check_owner and (p_owner_user_id is null or p_owner_user_id <> v_allowed.user_id) then
      return 'owner_mismatch';
    elsif v_source.status <> 'active' then
      return 'source_paused';
    end if;
    return null;
  end if;

  -- Why not: the most fundamental missing condition first.
  select * into v_invite from invites
  where tenant_id = p_tenant_id and email = v_address and status = 'accepted'
  order by coalesce(accepted_at, created_at) desc, id desc limit 1;
  if not reader_registration_active(p_tenant_id, v_source.provider) then
    -- This provider has no active registration for the tenant (disabled, or
    -- not implemented yet): another provider's registration never stands in.
    return 'registration_inactive';
  elsif v_invite.id is null then
    return 'no_invite';
  end if;
  select * into v_company from companies where id = v_invite.company_id;
  select * into v_user from users where id = v_invite.accepted_user_id;
  -- Not the bank's own firm: another company type, another tenant, an
  -- external user, or a bank-type company the registration does not name (R20).
  if v_company.type is distinct from 'bank' or v_company.tenant_id is distinct from p_tenant_id
     or coalesce(v_user.is_external, true)
     or not (v_company.id = any (reader_firm_company_ids(p_tenant_id, v_source.provider))) then
    return 'external';
  elsif not exists (select 1 from mailbox_seated_invites s where s.invite_id = v_invite.id) then
    return 'seat_inactive';
  elsif split_part(v_address, '@', 2) <> all (reader_mailbox_domains(p_tenant_id, v_source.provider)) then
    return 'domain';
  end if;
  return 'no_consent';
end;
$$;
revoke all on function mailbox_guard_verdict(uuid, text, text, boolean, uuid, text) from public, anon, authenticated;
grant execute on function mailbox_guard_verdict(uuid, text, text, boolean, uuid, text) to service_role;

-- ── 4. The guard ────────────────────────────────────────────────────────────
-- As in 20261019110000_team_mailbox_audit_ids.sql (which restated 20261001130000_mailbox_allowlist.sql),
-- with one change, marked #581: the purpose of the read goes to the verdict. Its arguments, its refusal
-- audit row (ids only for a team source) and its dedupe are unchanged.
create or replace function mailbox_guard_check(
  p_tenant_id        uuid,
  p_address          text,
  p_purpose          text,
  p_caller           text,
  p_check_owner      boolean default false,
  p_owner_user_id    uuid default null,
  p_provider_reason  text default null,
  p_provider         text default null
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_address  text := lower(trim(coalesce(p_address, '')));
  v_reason   text;
  v_changed  integer := 1;
  v_team     uuid;
  v_source   uuid;
begin
  if p_tenant_id is null or v_address = '' then
    raise exception 'mailbox_guard_check: tenant and address are required' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose not in ('provider_read', 'agent_tool', 'search', 'retrieval', 'export') then
    raise exception 'mailbox_guard_check: unknown purpose' using errcode = '22023';
  end if;
  if p_provider_reason is not null and p_provider_reason not in ('not_in_provider_group', 'mirror_unavailable') then
    raise exception 'mailbox_guard_check: unknown provider reason' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_caller)), 0) not between 1 and 100 then
    raise exception 'mailbox_guard_check: caller is required' using errcode = '22023';
  end if;
  if p_provider is null or p_provider not in ('microsoft', 'google') then
    raise exception 'mailbox_guard_check: a known provider is required' using errcode = '22023';
  end if;
  -- A tool, search, retrieval or export read always binds the source owner
  -- (R4, audit round 1): a caller that leaves the check off is a bug, not a
  -- mode, so it raises instead of skipping the owner comparison.
  if p_purpose in ('agent_tool', 'search', 'retrieval', 'export') and not coalesce(p_check_owner, false) then
    raise exception 'mailbox_guard_check: purpose % requires the owner check', p_purpose using errcode = '22023';
  end if;

  -- The decision itself is mailbox_guard_verdict's (audit round 3, A3), shared with
  -- the member's readiness status. What stays here is the caller's own input: the
  -- worker's provider-group verdict, which is not a database fact, applies only when
  -- the database allows the read. #581: the verdict is told the purpose, so a team
  -- source (which has no owner) is admitted to the worker's provider_read alone.
  v_reason := coalesce(
    mailbox_guard_verdict(p_tenant_id, v_address, p_provider, coalesce(p_check_owner, false), p_owner_user_id, p_purpose),
    p_provider_reason);

  if v_reason is null then
    if p_purpose = 'provider_read' then
      update mailbox_guard_state set last_reason = null, decided_at = now()
      where tenant_id = p_tenant_id and address = v_address and last_reason is not null;
    end if;
    return null;
  end if;

  if p_purpose = 'provider_read' then
    insert into mailbox_guard_state (tenant_id, address, last_reason)
    values (p_tenant_id, v_address, v_reason)
    on conflict (tenant_id, address) do update
      set last_reason = excluded.last_reason, decided_at = now()
      where mailbox_guard_state.last_reason is distinct from excluded.last_reason;
    get diagnostics v_changed = row_count;
  end if;

  if v_changed > 0 then
    -- #581: the registration of the source this address names, if it is a team source.
    -- content_sources holds one row per address, so this is at most one row.
    select s.team_mailbox_id, s.id into v_team, v_source from content_sources s
    where s.tenant_id = p_tenant_id and s.kind = 'mailbox' and lower(s.address) = v_address;
    -- No source holds the address any more (a removed registration's source is archived under
    -- another name): it is named by the latest registration of it, if it ever had one. A
    -- personal source holding the address now is that person's, and keeps the address.
    if v_source is null then
      select t.id into v_team from team_mailboxes t
      where t.tenant_id = p_tenant_id and t.address = v_address
      order by t.connected_at desc, t.id desc limit 1;
    end if;
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (p_tenant_id, 'service', trim(p_caller), 'discovery.mailbox_refused',
            jsonb_build_object('reason', v_reason, 'purpose', p_purpose)
            || case when v_team is null
                    then jsonb_build_object('address', v_address)
                    else jsonb_build_object('teamMailboxId', v_team) end);
  end if;
  return v_reason;
end;
$$;
revoke all on function mailbox_guard_check(uuid, text, text, text, boolean, uuid, text, text) from public, anon, authenticated;
grant execute on function mailbox_guard_check(uuid, text, text, text, boolean, uuid, text, text) to service_role;

-- ── 5. The admin's list says why the worker's read was refused (audit item 3) ─
-- Live mode reads a team inbox only when its address is a DIRECT member of the ingest group (the provider mirror
-- lists direct USER members), and nobody signs in as deals@ to be added, so a Ready inbox outside the group is refused
-- not_in_provider_group on every pass. The list carries the guard's last provider-read refusal for the address
-- (mailbox_guard_state: a fixed code, cleared on the next allowed read), and the card names it. Restated from
-- 20261019120000_team_mailbox_list.sql with the one field added.
create or replace function discovery_team_mailboxes()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := auth.uid();
  v_user users%rowtype;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_user from users where id = v_uid;
  if not found or not app_is_firm_admin(v_user.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id', tm.id,
               'address', tm.address,
               'provider', tm.provider,
               'connectedAt', tm.connected_at,
               'checkStatus', tm.check_status,
               'checkReason', tm.check_reason,
               'checkedAt', tm.checked_at,
               'lastCheckError', tm.last_check_error,
               'sourceId', s.id,
               'sourceStatus', s.status,
               'backfillSince', s.backfill_since,
               -- Remove is open while nothing is attached to its source, verified or not (the same
               -- test discovery_remove_team_mailbox applies under its lock).
               'removable', (not exists (select 1 from source_item_sources sis where sis.content_source_id = s.id)),
               -- Why the worker's last read of it was refused, a fixed code (mailbox_guard_state, provider_read only), or
               -- null once a read is allowed. not_in_provider_group is the one the card names (audit item 3).
               'readRefusal', (select g.last_reason from mailbox_guard_state g
                               where g.tenant_id = tm.tenant_id and g.address = tm.address)
             )
             order by tm.connected_at, tm.id)
    from team_mailboxes tm
    left join lateral (
      select cs.id, cs.status, cs.backfill_since
      from content_sources cs
      where cs.team_mailbox_id = tm.id
    ) s on true
    where tm.tenant_id = v_user.tenant_id
      and tm.firm_company_id = v_user.company_id
      and tm.disconnected_at is null
  ), '[]'::jsonb);
end;
$$;
revoke all on function discovery_team_mailboxes() from public, anon, authenticated;
grant execute on function discovery_team_mailboxes() to authenticated;
