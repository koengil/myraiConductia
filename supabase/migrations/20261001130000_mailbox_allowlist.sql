-- supabase/migrations/20261001130000_mailbox_allowlist.sql
-- Invitation-scoped mailbox access (#262, epic #261). A mailbox is readable
-- only when its owner holds a live seat at the bank from an accepted invite
-- and has opted in with "Connect my mailbox". This migration adds:
--   - graph_reader_registrations.mailbox_domains and .firm_company_id, with the
--     provider-aware reader_mailbox_domains(), reader_firm_company_ids() and
--     reader_registration_active(), and content_sources.provider (C2, C5)
--   - mailbox_consents, the two consent RPCs (session-bound, audited), the
--     seat-loss trigger that withdraws a consent when its owner loses the seat,
--     and the invite-delete trigger that withdraws it before the invite goes
--   - mailbox_seated_invites and allowed_mailboxes (views, service role only)
--   - mailbox_guard_state, mailbox_guard_verdict() (the one decision) and
--     mailbox_guard_check() (the one guard's SQL side, which audits it); the
--     member's readiness status reports the same verdict
--   - four discovery.* audit actions
--   - the one-click opt-in's eligibility (A2): the member must be MD or deal team on a
--     deal of their tenant (mailbox_member_on_a_deal), checked at grant time only
-- An accepted invite never expires or gets revoked (design premise 1): after
-- acceptance, what revokes access is losing the seat (member removal clears
-- users.company_id and suspends the user), so the views test the seat, not
-- invites.expires_at. "The bank's own firm" is the company the registration
-- names, not any company of type 'bank' (design premise 6, R20).

-- ── 1. What a tenant's reader registration may read ────────────────────────
alter table graph_reader_registrations
  add column if not exists mailbox_domains text[] not null default '{}',
  add column if not exists firm_company_id uuid references companies (id);

-- Which provider reads a source (C2, epic #261). A mailbox is checked against
-- ITS provider's registration and never against another's (C5), so a Gmail
-- source on a Microsoft-registered domain is refused, and the reverse.
-- 'microsoft' is the only reader today; #259 inserts 'google' rows.
alter table content_sources
  add column if not exists provider text not null default 'microsoft'
    check (provider in ('microsoft', 'google'));

-- An orphaned source that still holds provenance rows is archived, never handed
-- to the next holder of the address (audit round 3, H1): mailbox_consent_grant()
-- renames it <address>~xyz, pauses it and stamps these two columns, then gives
-- the member a fresh source. archived_at is also the marker discovery_unify_
-- mailbox_sources() requires of the row it merges away.
alter table content_sources
  add column if not exists archived_at timestamptz,
  add column if not exists archived_from_address text;

-- A worker that read a page for the earlier holder can still be writing it after the
-- archive or the merge commits (audit round 4, Codex 3): the archive and the merge lock
-- the row, which only delays such a write. So the database closes an archived source to
-- it, at write time, with source_archived (P0001): no provenance link may be inserted
-- for it, and none of its checkpoint or sync-state columns may be written, so the
-- archived row cannot be refilled or restart a backfill. The archive step stamps
-- archived_at itself and writes none of those columns, and the merge deletes links from
-- the archived row and inserts them on the live one, so neither is refused. The link
-- trigger takes a key-share lock on the source first: a write that began before an
-- archive waits for it, then sees the stamp.
create or replace function source_item_sources_refuse_archived()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_archived timestamptz;
begin
  select cs.archived_at into v_archived from content_sources cs where cs.id = new.content_source_id for key share;
  if v_archived is not null then
    raise exception 'source_archived' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function source_item_sources_refuse_archived() from public, anon, authenticated;
drop trigger if exists source_item_sources_refuse_archived on source_item_sources;
create trigger source_item_sources_refuse_archived before insert on source_item_sources
  for each row execute function source_item_sources_refuse_archived();

create or replace function content_sources_refuse_archived_sync()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'source_archived' using errcode = 'P0001';
end;
$$;
revoke all on function content_sources_refuse_archived_sync() from public, anon, authenticated;
drop trigger if exists content_sources_refuse_archived_sync on content_sources;
create trigger content_sources_refuse_archived_sync
  before update of delta_checkpoint, backfill_completed_at, checkpoint_updated_at, last_synced_at, last_error, last_error_at
  on content_sources
  for each row when (old.archived_at is not null)
  execute function content_sources_refuse_archived_sync();

-- The registration functions take the provider (C5). Each has a `microsoft`
-- branch over graph_reader_registrations and nothing for `google` yet, so an
-- unknown or not-yet-implemented provider yields empty, active = false (fail
-- closed). #259 adds the google branch over google_reader_registrations, in
-- the same three functions. There is deliberately no one-argument form of the
-- first two: a guard that took the union of the providers' domains or firms
-- would admit a mailbox on another provider's registration.
create or replace function reader_registration_active(p_tenant_id uuid, p_provider text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_provider = 'microsoft' and exists (
    select 1 from graph_reader_registrations r
    where r.tenant_id = p_tenant_id and r.status = 'active'), false);
$$;
revoke all on function reader_registration_active(uuid, text) from public, anon, authenticated;
grant execute on function reader_registration_active(uuid, text) to service_role;

-- Empty means none (fail closed).
create or replace function reader_mailbox_domains(p_tenant_id uuid, p_provider text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct lower(d)), '{}'::text[])
  from graph_reader_registrations r, unnest(r.mailbox_domains) as d
  where p_provider = 'microsoft' and r.tenant_id = p_tenant_id and r.status = 'active';
$$;
revoke all on function reader_mailbox_domains(uuid, text) from public, anon, authenticated;
grant execute on function reader_mailbox_domains(uuid, text) to service_role;

-- The bank's own firm, for one provider's registration. Empty means none (fail
-- closed). Only a same-tenant company of type 'bank' counts, so a registration
-- that names a counterparty or another tenant's company yields no firm; every
-- consumer (views, guard, control room, drift recipients, health) inherits that.
create or replace function reader_firm_company_ids(p_tenant_id uuid, p_provider text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct c.id), '{}'::uuid[])
  from graph_reader_registrations r
  join companies c on c.id = r.firm_company_id and c.tenant_id = r.tenant_id and c.type = 'bank'
  where p_provider = 'microsoft' and r.tenant_id = p_tenant_id and r.status = 'active';
$$;
revoke all on function reader_firm_company_ids(uuid, text) from public, anon, authenticated;
grant execute on function reader_firm_company_ids(uuid, text) to service_role;

-- The providers through which this address, seated at this company, may be
-- read: those whose active registration lists the address's domain AND names
-- the company as its firm. The one place the two are joined, so the view, the
-- consent RPCs and the guard cannot disagree. Today: {} or {microsoft}.
create or replace function mailbox_reader_providers(p_tenant_id uuid, p_address text, p_company_id uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.provider order by p.provider), '{}'::text[])
  from unnest(array['microsoft', 'google']) as p(provider)
  where split_part(lower(coalesce(p_address, '')), '@', 2) = any (reader_mailbox_domains(p_tenant_id, p.provider))
    and p_company_id = any (reader_firm_company_ids(p_tenant_id, p.provider));
$$;
revoke all on function mailbox_reader_providers(uuid, text, uuid) from public, anon, authenticated;
grant execute on function mailbox_reader_providers(uuid, text, uuid) to service_role;

-- The same firm across providers, whatever the registration's status. It is
-- one firm, so the union is right here: reads and new consents use the
-- provider-aware functions above (active only, so disabling a reader stops
-- them), while the control room, drift recipients and the health definer use
-- this one, so disabling the reader does not strip the CCO of the metadata
-- Q1 = B keeps (review round 5). Today it reads the Graph registration; #259
-- adds the Google registration's firm.
create or replace function firm_company_ids(p_tenant_id uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct c.id), '{}'::uuid[])
  from graph_reader_registrations r
  join companies c on c.id = r.firm_company_id and c.tenant_id = r.tenant_id and c.type = 'bank'
  where r.tenant_id = p_tenant_id;
$$;
revoke all on function firm_company_ids(uuid) from public, anon, authenticated;
grant execute on function firm_company_ids(uuid) to service_role;

-- ── 2. Opt-in state ─────────────────────────────────────────────────────────
-- One open row per invite. withdrawn_at is set once and never cleared, so a
-- re-consent inserts a new row. Users write it only through the two RPCs
-- below; the seat-loss trigger withdraws on seat loss, and the invite-delete
-- trigger withdraws before the invite (and with it the row) goes. Every change,
-- whoever makes it, is audited by mailbox_consents_audit in the same
-- statement, so the table is always the fold of its audit rows: an open
-- consent is exactly an opt-in row with no withdrawal row.
create table if not exists mailbox_consents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  -- restrict (audit round 2, item 8): a user with a consent row cannot be deleted,
  -- so the fold invariant does not depend on another table's foreign key.
  user_id       uuid not null references users (id) on delete restrict,
  invite_id     uuid not null references invites (id) on delete cascade,
  address       text not null check (address = lower(address)),
  granted_at    timestamptz not null default now(),
  withdrawn_at  timestamptz,
  constraint mailbox_consents_withdrawn_after_grant
    check (withdrawn_at is null or withdrawn_at >= granted_at)
);
create unique index if not exists mailbox_consents_open_per_invite
  on mailbox_consents (invite_id) where withdrawn_at is null;
create index if not exists mailbox_consents_user_idx on mailbox_consents (user_id);

-- Only withdrawn_at may change, and only from null.
create or replace function mailbox_consents_append_only()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.id, new.tenant_id, new.user_id, new.invite_id, new.address, new.granted_at)
       is distinct from (old.id, old.tenant_id, old.user_id, old.invite_id, old.address, old.granted_at)
     or old.withdrawn_at is not null then
    -- P0001, like audit_log_immutable and the other immutability triggers.
    raise exception 'mailbox_consents rows are append-only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists mailbox_consents_append_only on mailbox_consents;
create trigger mailbox_consents_append_only before update on mailbox_consents
  for each row execute function mailbox_consents_append_only();

-- The audit trigger (mailbox_consents_audit) is created after the views in
-- section 3, because it reads mailbox_seated_invites.

-- An opt-in is the owner's own act (audit round 1, item 14). Whoever holds the
-- INSERT privilege (the table owner, a definer function) must run inside the
-- owner's session, so the service role cannot forge one and the audit row
-- always names the person who consented. mailbox_consent_grant() satisfies it
-- because it inserts for auth.uid().
create or replace function mailbox_consents_require_owner()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is distinct from new.user_id then
    raise exception 'mailbox_consent_not_by_owner' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function mailbox_consents_require_owner() from public, anon, authenticated;
drop trigger if exists mailbox_consents_require_owner on mailbox_consents;
create trigger mailbox_consents_require_owner before insert on mailbox_consents
  for each row execute function mailbox_consents_require_owner();

alter table mailbox_consents enable row level security;
-- No delete and no insert for any API role: consents are append-only and the
-- only writer of a new row is mailbox_consent_grant(). Rows go away only with
-- their invite, after the invite-delete trigger has withdrawn them. Supabase's
-- default privileges give service_role ALL on new tables, and a narrower grant
-- does not take a privilege away, so revoke everything first (review T10
-- round, C10-2; audit round 1, items 14 and 17).
revoke all on mailbox_consents from public, anon, authenticated, service_role;
grant select, update on mailbox_consents to service_role;

-- ── 3. The views (plain views: always current, so "the next pass" holds) ────
-- Each seated own-firm user's latest accepted invite into their company. The
-- firm is the company an active registration names (any provider: a seat is
-- about the firm, and it is one firm), so a second bank in the same tenant
-- never qualifies. Which provider may read the address is decided per address
-- in allowed_mailboxes, never here. A consent tied to an older invite (an earlier stint
-- at the firm) never counts.
create or replace view mailbox_seated_invites as
select i.tenant_id, lower(i.email) as address, i.accepted_user_id as user_id,
       i.id as invite_id, i.company_id
from invites i
join companies c on c.id = i.company_id and c.type = 'bank' and c.tenant_id = i.tenant_id
                and c.id = any (reader_firm_company_ids(i.tenant_id, 'microsoft')
                                || reader_firm_company_ids(i.tenant_id, 'google'))
join users u on u.id = i.accepted_user_id
            and u.tenant_id = i.tenant_id
            and u.company_id = i.company_id
            and u.status = 'active'
            and u.is_external = false
where i.status = 'accepted'
  and not exists (
    select 1 from invites later
    where later.accepted_user_id = i.accepted_user_id
      and later.company_id = i.company_id
      and later.status = 'accepted'
      and (coalesce(later.accepted_at, later.created_at), later.id)
          > (coalesce(i.accepted_at, i.created_at), i.id)
  );

-- One row per readable address and provider (R2, R4, R5, R6; C5). `provider`
-- is the provider whose active registration lists the address's domain and
-- names the seat's company as its firm, so each provider group is compared
-- with its own mailboxes only (audit round 1, item 22) and a mailbox is never
-- admitted on another provider's registration. A domain registered under both
-- providers yields a row for each. Last column, so a database that has the view
-- already can take it with `create or replace`.
create or replace view allowed_mailboxes as
select s.tenant_id, s.address, s.user_id, s.invite_id, mc.id as consent_id, mc.granted_at,
       p.provider
from mailbox_seated_invites s
join mailbox_consents mc on mc.invite_id = s.invite_id
                        and mc.user_id = s.user_id
                        and mc.tenant_id = s.tenant_id     -- a malformed row never counts (review round 3)
                        and mc.address = s.address
                        and mc.withdrawn_at is null
cross join lateral unnest(mailbox_reader_providers(s.tenant_id, s.address, s.company_id)) as p(provider);

-- The views run as their owner. Nobody but the service role reads them; RLS
-- helpers read them from inside security definer functions. service_role is
-- named in the revoke because Supabase's default privileges give it ALL on
-- every new relation, views included (audit round 1, item 17).
revoke all on mailbox_seated_invites, allowed_mailboxes from public, anon, authenticated, service_role;
grant select on mailbox_seated_invites, allowed_mailboxes to service_role;

-- The one audit writer for consents (R6). It runs for every writer, the RPCs,
-- the seat-loss trigger, the service role and the dev seed alike, so an opt-in
-- or a withdrawal can never exist without its audit row. The actor is the
-- user when the session is the consent's owner, else the service. Created
-- after the views because it reads mailbox_seated_invites.
create or replace function mailbox_consents_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_by_owner boolean := auth.uid() is not null and auth.uid() = new.user_id;
  v_action   text;
  v_detail   jsonb := jsonb_build_object('consentId', new.id, 'inviteId', new.invite_id, 'address', new.address);
  v_source   text := nullif(current_setting('conductia.mailbox_consent_source_id', true), '');
begin
  if tg_op = 'INSERT' then
    v_action := 'discovery.mailbox_consented';
    -- mailbox_consent_grant() names the mailbox source the opt-in binds (C20),
    -- whether that call created it, and whether it adopted an ownerless one, for
    -- the rest of its own insert. A row written any other way carries none of
    -- the three keys.
    if current_setting('conductia.mailbox_consent_source_created', true) in ('true', 'false') then
      v_detail := v_detail || jsonb_build_object('sourceId', v_source,
        'sourceCreated', current_setting('conductia.mailbox_consent_source_created', true) = 'true',
        'sourceAdopted', coalesce(current_setting('conductia.mailbox_consent_source_adopted', true), '') = 'true');
      -- ... and the earlier holder's source it archived to make room for a fresh one (H1).
      if nullif(current_setting('conductia.mailbox_consent_archived_source_id', true), '') is not null then
        v_detail := v_detail || jsonb_build_object('archivedSourceId',
          current_setting('conductia.mailbox_consent_archived_source_id', true));
      end if;
    end if;
  elsif old.withdrawn_at is null and new.withdrawn_at is not null then
    v_action := 'discovery.mailbox_consent_withdrawn';
    -- invite_deleted is set by mailbox_consents_close_on_invite_delete for the
    -- rest of its own statement; otherwise the reason is read from the seat.
    v_detail := v_detail || jsonb_build_object('reason',
      coalesce(nullif(current_setting('conductia.mailbox_withdraw_reason', true), ''),
        case when exists (select 1 from mailbox_seated_invites s where s.invite_id = new.invite_id)
             then 'withdrawn' else 'seat_lost' end));
  else
    return null;
  end if;
  insert into audit_log (tenant_id, actor_id, actor_type, service_identity, action, detail)
  values (new.tenant_id,
          case when v_by_owner then new.user_id end,
          case when v_by_owner then 'user' else 'service' end,
          case when v_by_owner then null else 'mailbox-consent' end,
          v_action, v_detail);
  return null;
end;
$$;
revoke all on function mailbox_consents_audit() from public, anon, authenticated;
drop trigger if exists mailbox_consents_audit on mailbox_consents;
create trigger mailbox_consents_audit after insert or update on mailbox_consents
  for each row execute function mailbox_consents_audit();

-- ── 4. Consent RPCs: the caller only, audited in the same transaction ──────
-- Why the mailbox is not being read, or null when a pass reads it: the guard's own
-- verdict (mailbox_guard_verdict, section 5) for the member's seated address, as the
-- member, so `reading` means database eligibility: true exactly when the guard allows.
-- It says nothing of the worker's flags, the provider's group mirror or whether a
-- pass is running (audit round 3, H2; owner decision D2), so the card says "Conductia
-- reads your mailbox when your firm's reader runs", never "on the next pass".
-- The reason is the guard's, in the guard's order and vocabulary (no_source before
-- no_consent, a paused source is source_paused). Two reasons come before the
-- verdict, because they are about the member and not the address, and a third is
-- produced by mailbox_consent_status() for a caller with no seat:
--   domain          seated, but no provider's registration lists the address's
--                   domain for the firm (the guard's own domain, external and
--                   registration_inactive refusals say the same of an address a
--                   source holds; with no source it says no_source)
--   not_on_a_deal   no open consent, and the member is not MD or deal team on any
--                   deal of their tenant, so a grant would be refused (A2). A
--                   grant-time precondition the guard never tests: a member already
--                   consented who later leaves every deal keeps being read, so with
--                   an open consent the verdict stands as it is
--   no_invite       (status only) the caller has no seat at all, whatever the
--                   guard's cause (no_invite, external, seat_inactive,
--                   registration_inactive), and also when the address has no source
-- Every other value is the verdict's, unchanged: no_source, no_consent,
-- owner_mismatch, source_paused, and the refusals of a source on a provider that
-- may not read the address (registration_inactive, external, seat_inactive, domain).
-- A caller's provider is a guard input a member has none of, so provider_mismatch
-- and the provider group reasons are never reported here.
-- Called from the two RPCs only; the signed-in roles cannot execute it.

-- Whether the member may open a mailbox consent at all (A2, D3): MD or deal team on
-- at least one deal of their tenant. deal_memberships holds a row only while the
-- membership stands (removal deletes it; there is no inactive state to exclude), and
-- a membership on another tenant's deal never counts. The deal's own status does not
-- count either: a closed deal still qualifies (owner decision, audit round 4, Claude 7). Any provider, so there is no
-- provider argument. A grant-time precondition only: mailbox_guard_check does not
-- call it (conductor decision, D68; the owner can flip it).
create or replace function mailbox_member_on_a_deal(p_tenant_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from deal_memberships dm
    join deals d on d.id = dm.deal_id and d.tenant_id = p_tenant_id
    where dm.user_id = p_user and dm.deal_role in ('md', 'deal_team'));
$$;
revoke all on function mailbox_member_on_a_deal(uuid, uuid) from public, anon, authenticated;
grant execute on function mailbox_member_on_a_deal(uuid, uuid) to service_role;

create or replace function mailbox_reading_reason(
  p_tenant_id uuid, p_address text, p_user uuid, p_company_id uuid, p_consented boolean
)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if cardinality(mailbox_reader_providers(p_tenant_id, p_address, p_company_id)) = 0 then
    return 'domain';
  end if;
  if not coalesce(p_consented, false) and not mailbox_member_on_a_deal(p_tenant_id, p_user) then
    return 'not_on_a_deal';
  end if;
  -- The guard's decision for this address, with the member bound as the owner a
  -- read is made for: a source the member does not own is refused, as it is in a pass.
  return mailbox_guard_verdict(p_tenant_id, p_address, null, true, p_user);
end;
$$;
revoke all on function mailbox_reading_reason(uuid, text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function mailbox_reading_reason(uuid, text, uuid, uuid, boolean) to service_role;

create or replace function mailbox_consent_grant()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user      uuid := auth.uid();
  v_seat      mailbox_seated_invites%rowtype;
  v_open      mailbox_consents%rowtype;
  v_providers text[];
  v_source    uuid;
  v_owner     uuid;
  v_created   boolean := false;
  v_adopted   boolean := false;
  v_archived  uuid;
  v_old_provider text;
  v_fresh_provider text;
  v_archive_address text;
  v_archive_done boolean := false;
  v_attempt   integer;
  v_reason    text;
  v_outcome   text;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Hold the seat still while we decide (R21): a concurrent removal waits for
  -- this transaction, and its seat-loss trigger then withdraws what we insert.
  perform 1 from users where id = v_user for share;
  select s.* into v_seat from mailbox_seated_invites s where s.user_id = v_user;
  -- Seated, and on a domain a provider's registration lists for this firm:
  -- otherwise the guard would refuse every pass with 'domain' while the card
  -- said "Reading starts" (R17).
  if not found then
    raise exception 'not_eligible' using errcode = '42501';
  end if;
  v_providers := mailbox_reader_providers(v_seat.tenant_id, v_seat.address, v_seat.company_id);
  if cardinality(v_providers) = 0 then
    raise exception 'not_eligible' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mailbox_consent:' || v_seat.invite_id::text, 0));
  select * into v_open from mailbox_consents where invite_id = v_seat.invite_id and withdrawn_at is null;
  if found then
    -- Already consented: report the source, create and adopt nothing, audit nothing.
    select cs.id into v_source from content_sources cs
    where cs.tenant_id = v_seat.tenant_id and cs.kind = 'mailbox' and lower(cs.address) = v_seat.address;
    v_reason := mailbox_reading_reason(v_seat.tenant_id, v_seat.address, v_user, v_seat.company_id, true);
    return jsonb_build_object('consented', true, 'since', v_open.granted_at, 'address', v_open.address,
                              'sourceId', v_source, 'sourceCreated', false, 'sourceAdopted', false,
                              'archivedSourceId', null,
                              'reading', v_reason is null, 'readingReason', v_reason);
  end if;

  -- One click is open to the MD and the deal team of a deal, for every provider
  -- (A2, D3): a member on no deal of their tenant is refused like any other
  -- ineligible caller, with nothing written or audited. Checked here, after the
  -- already-consented return, because it is a precondition for opening a consent
  -- and not a condition of reading one: mailbox_guard_check does not test it, so
  -- a member who leaves every deal after consenting is still read until they
  -- withdraw or lose the seat.
  if not mailbox_member_on_a_deal(v_seat.tenant_id, v_user) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;

  -- The opt-in binds the mailbox source, so that "Connect my mailbox" is all it
  -- takes to start a read (C20). The source belongs to this user and to the
  -- provider whose registration admitted the address.
  --   - No row: one is created, unless more than one provider could read the
  --     address (the operator picks the provider: nothing is created).
  --   - A row with no owner and no provenance rows is adopted: the address is the
  --     caller's own, proven by the invitation they accepted, and the guard
  --     refuses an ownerless source (owner_mismatch), so an opt-in that left it
  --     alone would report a read that never happens. Status and provider are
  --     left as they are; the sync state (checkpoint, backfill and error fields)
  --     is cleared, so the new holder starts a fresh backfill and inherits no
  --     resume point from the earlier holder's reads.
  --   - A row with no owner that still holds provenance rows is the earlier
  --     holder's mailbox, and the visibility rule treats the items attached to a
  --     source as its owner's (audit round 3, H1). It is archived, not adopted:
  --     renamed <address>~xyz (three random [a-z0-9], retried on the unique
  --     index), paused and stamped, so nothing ever reads it again and no one
  --     owns it, and the caller gets a fresh active source with no checkpoint. The
  --     fresh source's provider is the archived row's own only while a registration
  --     of that provider may still read the address (it is in mailbox_reader_providers);
  --     otherwise it is the one provider that may, and with several candidates and
  --     none of them the old one no source is created, as when no row existed (audit
  --     round 4, Claude 1). The guard's last refusal for the live address is
  --     forgotten, so the new holder's first refusal is audited (Claude 3). A
  --     firm admin can merge the history into the fresh source afterwards
  --     (discovery_unify_mailbox_sources), which is the only way it reaches
  --     anyone. The archived source keeps its routing_ledger rows (a hash and a
  --     decision per item, never content): they record what the earlier holder's
  --     mailbox read, the merge does not move them, and the fresh source's own
  --     ledger starts empty (audit round 4, Claude 4b).
  --   - A row owned by someone else is never touched, whatever its status (the
  --     guard refuses it owner_mismatch, C11); the result says it is not read.
  -- Withdrawal never deletes the source; the guard refuses it no_consent until
  -- the next opt-in.
  -- The row is locked: a worker's provenance insert takes a share lock on it
  -- (the foreign key), so no item can be attached between the test below and
  -- the rename.
  select cs.id, cs.owner_user_id, cs.provider into v_source, v_owner, v_old_provider from content_sources cs
  where cs.tenant_id = v_seat.tenant_id and cs.kind = 'mailbox' and lower(cs.address) = v_seat.address
  for update;
  if v_source is not null then
    if v_owner is null and exists (select 1 from source_item_sources s where s.content_source_id = v_source) then
      v_archived := v_source;
      for v_attempt in 1..20 loop
        v_archive_address := v_seat.address || '~' || (
          select string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::integer, 1), '')
          from generate_series(1, 3));
        begin
          update content_sources
             set address = v_archive_address, status = 'paused',
                 archived_at = now(), archived_from_address = address
           where id = v_archived;
          v_archive_done := true;
          exit;
        exception when unique_violation then
          null;   -- that suffix is taken: draw another
        end;
      end loop;
      if not v_archive_done then
        raise exception 'mailbox_source_archive_failed' using errcode = 'P0001';
      end if;
      -- Whatever the earlier holder's reads were last refused for says nothing of the new
      -- holder: left in place, a first refusal for the same reason would be deduplicated
      -- away and never audited.
      delete from mailbox_guard_state where tenant_id = v_seat.tenant_id and address = v_seat.address;
      v_fresh_provider := case when v_old_provider = any (v_providers) then v_old_provider
                               when cardinality(v_providers) = 1 then v_providers[1] end;
      if v_fresh_provider is not null then
        insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
        values (v_seat.tenant_id, 'mailbox', v_seat.address, v_user, v_fresh_provider, 'active')
        on conflict (tenant_id, kind, lower(address)) do nothing
        returning id into v_source;
        v_created := v_source is not null;
      else
        v_source := null;   -- the operator picks the provider: nothing is created
      end if;
      if v_source is null then   -- another writer took the freed address, or none was created: name its row, untouched
        select cs.id into v_source from content_sources cs
        where cs.tenant_id = v_seat.tenant_id and cs.kind = 'mailbox' and lower(cs.address) = v_seat.address;
      end if;
      insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
      values (v_seat.tenant_id, v_user, 'user', 'discovery.mailbox_source_archived',
              jsonb_build_object('sourceId', v_archived, 'freshSourceId', v_source, 'address', v_seat.address,
                                 'archivedAddress', v_archive_address, 'inviteId', v_seat.invite_id));
    elsif v_owner is null then
      update content_sources set owner_user_id = v_user,
             delta_checkpoint = null, backfill_completed_at = null, checkpoint_updated_at = null,
             last_synced_at = null, last_error = null, last_error_at = null
      where id = v_source and owner_user_id is null;
      v_adopted := found;
    end if;
  elsif cardinality(v_providers) = 1 then
    insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
    values (v_seat.tenant_id, 'mailbox', v_seat.address, v_user, v_providers[1], 'active')
    on conflict (tenant_id, kind, lower(address)) do nothing
    returning id into v_source;
    v_created := v_source is not null;
    if v_source is null then   -- another writer won the race: name its row, untouched
      select cs.id into v_source from content_sources cs
      where cs.tenant_id = v_seat.tenant_id and cs.kind = 'mailbox' and lower(cs.address) = v_seat.address;
    end if;
  end if;

  -- mailbox_consents_audit records the opt-in, with this user as the actor and
  -- the source this call bound in its detail. The settings live for this
  -- transaction only and are cleared straight after the insert.
  perform set_config('conductia.mailbox_consent_source_id', coalesce(v_source::text, ''), true);
  perform set_config('conductia.mailbox_consent_source_created', v_created::text, true);
  perform set_config('conductia.mailbox_consent_source_adopted', v_adopted::text, true);
  perform set_config('conductia.mailbox_consent_archived_source_id', coalesce(v_archived::text, ''), true);
  insert into mailbox_consents (tenant_id, user_id, invite_id, address)
  values (v_seat.tenant_id, v_user, v_seat.invite_id, v_seat.address)
  returning * into v_open;
  perform set_config('conductia.mailbox_consent_source_id', '', true);
  perform set_config('conductia.mailbox_consent_source_created', '', true);
  perform set_config('conductia.mailbox_consent_source_adopted', '', true);
  perform set_config('conductia.mailbox_consent_archived_source_id', '', true);

  -- Tell the firm's admins and its CCO once per binding (A2; owner decision, audit
  -- round 4): a source was created, taken over, or made fresh after an archive for
  -- this member, or an archive left the member with no fresh source for the operator
  -- to place. A grant that binds nothing new (the member's own source, or one another
  -- writer won) tells no one. The recipients are the drift notification's seat
  -- predicate (active, internal, seated in the firm), admins and the CCO, so a CCO
  -- of a second bank or of a counterparty hears nothing. The payload names the
  -- address, the outcome and the source, and the archived source when there was one
  -- (so an admin can find the history to merge); it carries no mail.
  if v_created or v_adopted or v_archived is not null then
    v_outcome := case when v_archived is not null then 'archived_previous'
                      when v_adopted then 'taken_over' else 'created' end;
    insert into notifications (tenant_id, recipient_id, event_type, payload)
    select v_seat.tenant_id, u.id, 'mailbox_connected',
           jsonb_build_object('address', v_seat.address, 'outcome', v_outcome, 'sourceId', v_source,
                              'provider', (select cs.provider from content_sources cs where cs.id = v_source))
             || case when v_archived is not null then jsonb_build_object('archivedSourceId', v_archived)
                     else '{}'::jsonb end
    from users u
    where u.tenant_id = v_seat.tenant_id and u.status = 'active' and u.firm_role in ('admin', 'cco')
      and u.is_external = false
      and u.company_id = any (firm_company_ids(v_seat.tenant_id));
  end if;

  v_reason := mailbox_reading_reason(v_seat.tenant_id, v_seat.address, v_user, v_seat.company_id, true);
  return jsonb_build_object('consented', true, 'since', v_open.granted_at, 'address', v_open.address,
                            'sourceId', v_source, 'sourceCreated', v_created, 'sourceAdopted', v_adopted,
                            'archivedSourceId', v_archived,
                            'reading', v_reason is null, 'readingReason', v_reason);
end;
$$;

-- Withdrawal needs no eligibility: anyone may stop being read.
create or replace function mailbox_consent_withdraw()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- mailbox_consents_audit records each withdrawal, with this user as the actor.
  -- The reason is stated here, as the invite-delete trigger states its own: left
  -- to the audit trigger it is read from the seat, and while the registration is
  -- paused there is no seat, so a voluntary withdrawal would read seat_lost (C13).
  -- The seat-derived reason stays for the seat-loss trigger path only.
  perform set_config('conductia.mailbox_withdraw_reason', 'withdrawn', true);
  update mailbox_consents set withdrawn_at = now()
  where user_id = v_user and withdrawn_at is null;
  perform set_config('conductia.mailbox_withdraw_reason', '', true);
  return jsonb_build_object('consented', false);
end;
$$;

-- Merges an archived source's history into the live source of the address it was
-- archived from (audit round 3, D1). The only way an orphaned mailbox's items
-- reach anyone: a firm admin decides that the member now holding the address is
-- entitled to them. The caller must be an active, internal firm admin seated in
-- the bank's own firm (the site_register predicate); both sources must be the
-- caller's tenant's. Preconditions, each refused with its own message:
--   unify_not_archived          the first source has no archived_at
--   unify_already_unified       it has no provenance rows left (an archived row
--                               is only ever archived with some, and nothing
--                               reads or writes it afterwards, so none left
--                               means it was merged: a second merge is refused)
--   unify_address_mismatch      archived_from_address is not the target's address
--   unify_target_not_active     the target is not `active` (a paused target's owner would
--                               see the merged items through RLS, which does not test
--                               status, while the guard refuses source_paused)
--   unify_provider_mismatch     the target is not on the archived row's provider (items
--                               read through one provider are never attached to a source
--                               of another)
--   unify_target_not_allowlisted the target's owner is not on allowed_mailboxes
--                               for it (unowned, unseated, or no open consent)
--   unify_discovery_disabled    the `deal_discovery` flag is off (the route answers 404 for
--                               it first; the RPC repeats the test so a direct caller cannot
--                               widen who sees stored mail while discovery is off, and
--                               fails closed on a missing flag row)
-- The archived row is closed by being emptied: it stays paused and ownerless
-- under its ~xyz key, which no worker or guard reads, and the audit row
-- records the merge. No third status or column is needed. Links already on the
-- target are not duplicated (the key is the item and the source), and the
-- affected candidates' visibility is rebuilt so the target's owner sees them.
create or replace function discovery_unify_mailbox_sources(p_archived uuid, p_target uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user   users%rowtype;
  v_arch   content_sources%rowtype;
  v_tgt    content_sources%rowtype;
  v_total  integer;
  v_moved  integer;
  v_cands  uuid[];
  v_cand   uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_user from users
  where id = auth.uid() and status = 'active' and is_external = false and firm_role = 'admin'
  for share;
  if not found or (v_user.company_id = any (firm_company_ids(v_user.tenant_id))) is not true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_archived is null or p_target is null then
    raise exception 'invalid_unify_request' using errcode = '22023';
  end if;
  if not exists (select 1 from feature_flags where key = 'deal_discovery' and enabled) then
    raise exception 'unify_discovery_disabled' using errcode = 'P0001';
  end if;

  -- Both rows, in id order so two merges cannot deadlock, and only the caller's
  -- tenant's mailboxes: another tenant's id reads as not found.
  perform 1 from content_sources
  where id in (p_archived, p_target) and tenant_id = v_user.tenant_id and kind = 'mailbox'
  order by id for update;
  select * into v_arch from content_sources
  where id = p_archived and tenant_id = v_user.tenant_id and kind = 'mailbox';
  if not found then
    raise exception 'unify_source_not_found' using errcode = 'P0001';
  end if;
  select * into v_tgt from content_sources
  where id = p_target and tenant_id = v_user.tenant_id and kind = 'mailbox';
  if not found then
    raise exception 'unify_source_not_found' using errcode = 'P0001';
  end if;

  if v_arch.archived_at is null then
    raise exception 'unify_not_archived' using errcode = 'P0001';
  end if;
  select count(*) into v_total from source_item_sources where content_source_id = v_arch.id;
  if v_total = 0 then
    raise exception 'unify_already_unified' using errcode = 'P0001';
  end if;
  if v_tgt.archived_at is not null
     or lower(v_arch.archived_from_address) is distinct from lower(v_tgt.address) then
    raise exception 'unify_address_mismatch' using errcode = 'P0001';
  end if;
  if v_tgt.status <> 'active' then
    raise exception 'unify_target_not_active' using errcode = 'P0001';
  end if;
  if v_tgt.provider is distinct from v_arch.provider then
    raise exception 'unify_provider_mismatch' using errcode = 'P0001';
  end if;
  if v_tgt.owner_user_id is null or not exists (
       select 1 from allowed_mailboxes a
       where a.tenant_id = v_tgt.tenant_id and a.address = lower(v_tgt.address)
         and a.user_id = v_tgt.owner_user_id and a.provider = v_tgt.provider) then
    raise exception 'unify_target_not_allowlisted' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct l.candidate_id) filter (where l.candidate_id is not null), '{}'::uuid[])
    into v_cands
  from evidence_links l
  where l.source_item_id in (select s.source_item_id from source_item_sources s where s.content_source_id = v_arch.id);

  with moved as (
    insert into source_item_sources (source_item_id, content_source_id, provider_item_id, observed_at)
    select s.source_item_id, v_tgt.id, s.provider_item_id, s.observed_at
    from source_item_sources s where s.content_source_id = v_arch.id
    on conflict (source_item_id, content_source_id) do nothing
    returning 1)
  select count(*) into v_moved from moved;
  delete from source_item_sources where content_source_id = v_arch.id;

  foreach v_cand in array v_cands loop
    perform discovery_refresh_candidate_visibility(v_cand);
  end loop;

  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_tgt.tenant_id, v_user.id, 'user', 'discovery.mailbox_sources_unified',
          jsonb_build_object('archivedSourceId', v_arch.id, 'targetSourceId', v_tgt.id,
                             'address', v_tgt.address, 'archivedAddress', v_arch.address,
                             'moved', v_moved, 'alreadyLinked', v_total - v_moved,
                             'candidatesRefreshed', cardinality(v_cands)));
  return jsonb_build_object('archivedSourceId', v_arch.id, 'targetSourceId', v_tgt.id,
                            'moved', v_moved, 'alreadyLinked', v_total - v_moved,
                            'candidatesRefreshed', cardinality(v_cands));
end;
$$;

revoke all on function mailbox_consent_grant() from public, anon;
revoke all on function mailbox_consent_withdraw() from public, anon;
grant execute on function mailbox_consent_grant(), mailbox_consent_withdraw() to authenticated;
revoke all on function discovery_unify_mailbox_sources(uuid, uuid) from public, anon;
grant execute on function discovery_unify_mailbox_sources(uuid, uuid) to authenticated;

-- Losing the seat closes the consent (R21). The members route is the only way
-- back after removal (create_invite refuses existing accounts), and without
-- this a re-seat would revive the old invite and the old consent. A role change
-- inside the same company keeps the consent.
create or replace function mailbox_consents_close_on_seat_loss()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.company_id is not distinct from old.company_id
     and new.tenant_id is not distinct from old.tenant_id
     and new.status = 'active'
     and not coalesce(new.is_external, false) then
    return null;
  end if;
  -- mailbox_consents_audit records each as withdrawn with reason 'seat_lost'
  -- (the invite has no seat any more by the time it runs).
  update mailbox_consents set withdrawn_at = now()
  where user_id = new.id and withdrawn_at is null;
  return null;
end;
$$;
revoke all on function mailbox_consents_close_on_seat_loss() from public, anon, authenticated;
drop trigger if exists mailbox_consents_close_on_seat_loss on users;
create trigger mailbox_consents_close_on_seat_loss
  after update of company_id, tenant_id, status, is_external on users
  for each row execute function mailbox_consents_close_on_seat_loss();

-- Deleting an invite deletes its consents (the FK cascades), so the open one is
-- withdrawn first: mailbox_consents_audit then writes the withdrawal row while
-- the consent still exists, and the audit log never shows an opt-in with no
-- end (audit round 1, item 13). The fixture recycler, the demo reset and the
-- tenant teardown all delete invites; a cascade from a company fires this too.
create or replace function mailbox_consents_close_on_invite_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('conductia.mailbox_withdraw_reason', 'invite_deleted', true);
  update mailbox_consents set withdrawn_at = now()
  where invite_id = old.id and withdrawn_at is null;
  perform set_config('conductia.mailbox_withdraw_reason', '', true);
  return old;
end;
$$;
revoke all on function mailbox_consents_close_on_invite_delete() from public, anon, authenticated;
drop trigger if exists mailbox_consents_close_on_invite_delete on invites;
create trigger mailbox_consents_close_on_invite_delete before delete on invites
  for each row execute function mailbox_consents_close_on_invite_delete();

-- ── 5. The guard ────────────────────────────────────────────────────────────
-- The last provider_read refusal per address, so a withdrawn mailbox is
-- audited on change, not every pass (R10). Other purposes audit every call.
create table if not exists mailbox_guard_state (
  tenant_id    uuid not null,
  address      text not null check (address = lower(address)),
  last_reason  text,
  decided_at   timestamptz not null default now(),
  primary key (tenant_id, address)
);
-- The last_reason CHECK is stated here, after the table, and not inline: `create table
-- if not exists` leaves an existing table alone, so a database that ran an earlier
-- version of this migration (without source_paused or site_registrant_lost) would
-- keep its narrower CHECK and the guard's first write of either reason would fail on it
-- (audit round 4, Claude 2). Dropping and re-adding the one named constraint makes every
-- run end at this list, like the audit_log action CHECK below.
alter table mailbox_guard_state drop constraint if exists mailbox_guard_state_last_reason_check;
alter table mailbox_guard_state add constraint mailbox_guard_state_last_reason_check
  check (last_reason in (
                 'no_invite', 'seat_inactive', 'external', 'no_consent', 'domain',
                 'owner_mismatch', 'not_in_provider_group', 'mirror_unavailable',
                 -- both guards: the address's provider has no active registration (C5)
                 'registration_inactive',
                 -- the caller's provider is not the source's (audit round 2, item 6)
                 'provider_mismatch',
                 -- the address has no content_sources mailbox row (audit round 3, item 6)
                 'no_source',
                 -- the source is not active: the one verdict now also says what the worker used to
                 -- skip on its own (audit round 3, M6)
                 'source_paused',
                 -- site reasons, produced by site_guard_check from Phase 7 (R23). Site
                 -- addresses (Graph site ids) never collide with mail addresses here.
                 'site_not_registered', 'site_wrong_firm',
                 -- an open registration whose registrant no longer stands (audit round 3, L8)
                 'site_registrant_lost'));
alter table mailbox_guard_state enable row level security;
revoke all on mailbox_guard_state from public, anon, authenticated, service_role;
grant select, insert, update, delete on mailbox_guard_state to service_role;

-- The one decision (audit round 3, A3; H2 and M6): why an address may not be read, or
-- null when it may, in this order. mailbox_guard_check returns it (plus the caller's
-- own provider reason) and mailbox_reading_reason reports it to the member, so
-- `reading` is true exactly when the guard allows and the two cannot disagree.
-- Writes nothing; the guard writes the refusal's audit row.
--   no_source          the address has no content_sources mailbox row, before any
--                      allowlist test, for every purpose
--   provider_mismatch  the caller reads through another provider than the source's
--                      (only when p_provider is given; the member's status gives none)
--   with an allowlisted mailbox for the source's own provider:
--     owner_mismatch   the source's CURRENT owner is not the allowlisted user (C11;
--                      no owner fails too), or, when p_check_owner, the caller's
--                      owner is not the allowlisted user
--     source_paused    the source is not active. The worker used to skip such a row
--                      on its own while the guard said nothing (audit round 3, M6):
--                      the one verdict now refuses it for every purpose, so a paused
--                      source is a narrowing, never a widening, of what the guard admits
--     null             allowed
--   otherwise the most fundamental missing condition, judged against the source's
--   own provider: registration_inactive, no_invite, external, seat_inactive, domain,
--   no_consent.
-- The caller's provider_reason (the worker's group-mirror verdict) is not a database
-- fact and stays in mailbox_guard_check, applied only when this says allowed.
create or replace function mailbox_guard_verdict(
  p_tenant_id       uuid,
  p_address         text,
  p_provider        text default null,
  p_check_owner     boolean default false,
  p_owner_user_id   uuid default null
)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_address  text := lower(trim(coalesce(p_address, '')));
  v_source   content_sources%rowtype;
  v_allowed  allowed_mailboxes%rowtype;
  v_invite   invites%rowtype;
  v_company  companies%rowtype;
  v_user     users%rowtype;
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
revoke all on function mailbox_guard_verdict(uuid, text, text, boolean, uuid) from public, anon, authenticated;
grant execute on function mailbox_guard_verdict(uuid, text, text, boolean, uuid) to service_role;

-- Returns null when the read may proceed, or the refusal reason. Writes the
-- refusal's audit row itself (service identity p_caller), never content.
-- p_check_owner is required (true) for agent_tool, search, retrieval and export;
-- only provider_read may run without it. Whatever it says, every purpose also
-- requires the source's CURRENT content_sources.owner_user_id to be the
-- allowlisted user (C11): the caller's owner is the one it read earlier, the
-- source's is the one that holds now.
-- p_provider is required: the provider the caller reads through (the reader's
-- for the worker, the source's own for a tool). It must equal the source's
-- content_sources.provider, else 'provider_mismatch' (audit round 2, item 6),
-- so a caller can never have a mailbox judged against another provider's
-- registration than the one that reads it.
-- Every purpose requires the address's content_sources mailbox row (audit round
-- 3, item 6): with none, the guard refuses 'no_source', audited like any other
-- refusal (provider_read on change, the rest on every call). No caller
-- legitimately checks an address with no source: the worker and the seed script
-- read a source row they hold, the tool accessor looks the row up first, and the
-- consent RPCs never call the guard (they judge eligibility from invites, not from
-- a source; the readiness they report asks mailbox_guard_verdict, the guard's own
-- decision, as the member). So no purpose keeps the old behaviour of judging a
-- sourceless address as microsoft.
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
returns text language plpgsql security definer set search_path = public as $$
declare
  v_address  text := lower(trim(coalesce(p_address, '')));
  v_reason   text;
  v_changed  integer := 1;
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
  -- the database allows the read.
  v_reason := coalesce(
    mailbox_guard_verdict(p_tenant_id, v_address, p_provider, coalesce(p_check_owner, false), p_owner_user_id),
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
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (p_tenant_id, 'service', trim(p_caller), 'discovery.mailbox_refused',
            jsonb_build_object('address', v_address, 'reason', v_reason, 'purpose', p_purpose));
  end if;
  return v_reason;
end;
$$;
revoke all on function mailbox_guard_check(uuid, text, text, text, boolean, uuid, text, text) from public, anon, authenticated;
grant execute on function mailbox_guard_check(uuid, text, text, text, boolean, uuid, text, text) to service_role;

-- ── 6. Audit actions: the full list from 20260925100000 plus nine ──────────
-- The three site actions get their writers in Phase 7 (R23); declaring them
-- here keeps this the only redefinition of the CHECK in #262.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view', 'download', 'upload', 'export', 'grant', 'revoke', 'hold_placed', 'hold_lifted', 'create', 'notify',
  'advance', 'attest', 'screen', 'send', 'release', 'invite_sent', 'invite_accepted', 'invite_revoked', 'reject',
  'invite_domain_override', 'invite_challenge_issued', 'invite_challenge_rotated', 'invite_verification_succeeded',
  'invite_verification_locked', 'mfa_enrolled', 'mfa_challenged', 'assign_step', 'complete_step', 'step_work',
  'update', 'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied',
  'skill_publication.admitted', 'skill_publication.admission_denied', 'skill_publication.duplicate_confirmed',
  'skill_publication.duplicate_declined', 'skill_publication.placement_replaced', 'skill_publication.transition',
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced', 'rail.template_applied',
  'discovery.candidate_proposed', 'discovery.candidate_promoted', 'discovery.correction',
  'discovery.milestone_extracted', 'discovery.stage_assessed',
  'discovery.mailbox_consented', 'discovery.mailbox_consent_withdrawn',
  'discovery.mailbox_refused', 'discovery.allowlist_drift',
  'discovery.site_registered', 'discovery.site_unregistered', 'discovery.site_refused',
  'discovery.mailbox_source_archived', 'discovery.mailbox_sources_unified'
])) not valid;
