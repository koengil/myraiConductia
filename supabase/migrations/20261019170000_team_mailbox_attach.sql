-- supabase/migrations/20261019170000_team_mailbox_attach.sql
-- Admin-managed team inbox (#581), phase 11: a member's tool reads, and a member's promotion.
--
-- Until now a member saw a team inbox's candidates and excerpts (phase 10), but two paths still treated
-- a team source as nobody's:
--
--   1. The guard. A tool, search, retrieval or export read acts for a person, and the guard refused every
--      named person for a team source (the source has no owner, so nobody "owned" it). This restates
--      mailbox_guard_verdict's team branch so the person named is admitted when, and only when, they are one
--      of the registration's readers right now (team_mailbox_readers: an open member who is still active,
--      internal, seated in the firm and not a firm admin). Everything else about the branch is phase 7's:
--      the freshness window, the null owner for the worker's provider_read and for nothing else, the pause.
--   2. Promotion. A promoted deal gains only items whose owner is seated on it (Q21,
--      discovery_item_owner_seated: the upsert and the merge both ask). For a team item the "owner" is its
--      readers, so this restates that predicate with a second disjunct: some reader of the item's team
--      inbox is a member of the deal. Without it a candidate a member promoted would never gain another
--      message from the inbox, because nobody on the deal "owns" the team source.
--      Attaching decides which items the deal's candidate holds, not who reads them. Team items stay invite
--      only (owner decision 2026-10-19): every read of a link, item, text, milestone or deal-email row is
--      still app_can_see_candidate / app_can_see_item / app_owns_item (20261019160000), none of which consults a
--      deal seat, so a deal member who is not a reader of the inbox sees none of its mail on the deal
--      (supabase/tests/discovery_promotion.sql, tests/integration/team-mailbox-visibility.test.ts).
--
-- Nothing here writes, so none of it takes discovery_lock_tenant: both functions are read-only, and the
-- audit row of a refused read is mailbox_guard_check's (phase 7), which touches neither candidates nor
-- visibility. mailbox_guard_check itself is unchanged: it already hands the owner it was given and the
-- purpose to the verdict.
--
-- No freshness term is added anywhere but where phase 7 put it (the verdict's team branch). The attach
-- predicate reads the timer-free allowlist, as every RLS helper does (design R7, review round 2 M-A), so a
-- Pause or a directory blip never changes which items a deal may gain.
--
-- RLS performance: no new index is needed. The predicates below reach a team source through
-- content_sources_team_mailbox_key (unique, partial), the membership through team_mailbox_members_open
-- (unique, partial) or team_mailbox_members_user_idx, and the deal seat through deal_memberships' primary
-- key; the integration test (tests/integration/team-mailbox-visibility.test.ts) reads ~2k links as a member.
--
-- Both definers pin `search_path = public, pg_temp` (20261016100000): create or replace resets the function's
-- configuration to what it states. Bodies restated from their latest definitions on this base:
--   mailbox_guard_verdict              20261019140000_team_mailbox_guard.sql
--   discovery_item_owner_seated        20261002210000_discovery_corrections.sql
-- create or replace keeps the grants of both.

-- ── 1. The decision ─────────────────────────────────────────────────────────
-- 20261019140000's body with one change, marked #581 phase 11: in the team branch a named owner is admitted
-- when they are a reader of the source's own registration. The personal path from the allowlist lookup down
-- is #262's, byte for byte, as phase 7 left it.
--
-- The team branch, for a source that belongs to a registration (content_sources.team_mailbox_id):
--   in allowed_team_mailboxes for the source's own provider and registration:
--     owner_mismatch           the source has an owner (it cannot, content_sources_team_ownerless), or
--                              a named person is not one of the registration's readers, or
--                              nobody is named and the purpose is not the worker's provider_read
--     team_mailbox_unverified  the Directory last confirmed it 65 minutes ago or more
--     source_paused            the source is not active
--     null                     allowed
--   not in the view: the most fundamental missing condition, as phase 7 orders them.
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
        -- #581 phase 11: a read that acts for a person is admitted when the person is one of this registration's
        -- readers now (the view is the truth on every read: a member since promoted to firm admin, suspended or
        -- moved is no reader). Another inbox's reader, another tenant's user and a non-member are refused alike.
        if not exists (
          select 1 from team_mailbox_readers r
          where r.team_mailbox_id = v_source.team_mailbox_id and r.tenant_id = p_tenant_id and r.user_id = p_owner_user_id
        ) then
          return 'owner_mismatch';
        elsif v_source.status <> 'active' then
          return 'source_paused';
        end if;
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

-- ── 2. Whether an item may join a promoted deal: its owner, or a reader of its inbox, is seated on it ──
-- 20261002210000's body (Q21: a promoted deal gains only items whose owner is seated on it, and the owner must
-- still be reading) with a second disjunct for team provenance: the item is in a team source of an inbox the
-- allowlist admits, and one of that inbox's readers holds a seat on the deal. The reader test is the one
-- app_owns_item uses (an open member who is active, internal, seated in the registration's firm and not a firm
-- admin), written against the base tables beside the allowlist. A reader who is removed, loses their seat, or is
-- promoted to firm admin stops carrying the inbox's items onto a deal at once, as an owner who withdraws consent
-- does. The personal disjunct is unchanged.
create or replace function discovery_item_owner_seated(p_item uuid, p_deal uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from source_item_sources sis
    join source_items si on si.id = sis.source_item_id
    join content_sources cs on cs.id = sis.content_source_id and cs.kind = 'mailbox' and cs.tenant_id = si.tenant_id
    join allowed_mailboxes a on a.tenant_id = cs.tenant_id and a.address = lower(cs.address)
                            and a.user_id = cs.owner_user_id and a.provider = cs.provider
    join deal_memberships dm on dm.user_id = cs.owner_user_id and dm.deal_id = p_deal
    where sis.source_item_id = p_item
  )
  or exists (
    select 1
    from source_item_sources sis
    join source_items si on si.id = sis.source_item_id
    join content_sources cs on cs.id = sis.content_source_id and cs.kind = 'mailbox' and cs.tenant_id = si.tenant_id
                           and cs.team_mailbox_id is not null
    join allowed_team_mailboxes a on a.team_mailbox_id = cs.team_mailbox_id and a.tenant_id = cs.tenant_id
                                 and a.address = lower(cs.address) and a.provider = cs.provider
    join team_mailbox_members m on m.team_mailbox_id = a.team_mailbox_id and m.removed_at is null
    join users ru on ru.id = m.user_id and ru.tenant_id = a.tenant_id
                 and ru.company_id = a.firm_company_id
                 and ru.status = 'active' and ru.is_external = false
                 and ru.firm_role is distinct from 'admin'
    join deal_memberships dm on dm.user_id = m.user_id and dm.deal_id = p_deal
    where sis.source_item_id = p_item
  );
$$;
revoke all on function discovery_item_owner_seated(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_item_owner_seated(uuid, uuid) to service_role;
