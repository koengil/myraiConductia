-- supabase/migrations/20261019150000_team_mailbox_members.sql
-- Admin-managed team inbox (#581), phase 8: the admin adds and removes the people of a team inbox.
--
--   1. team_mailbox_members, the firm admin's list of who may read a team inbox's discovery:
--      one row per person and inbox, closed and never deleted. Written only by the two RPCs
--      below, the seat-loss trigger and Remove. Every change is audited by a trigger, so the
--      table is always the fold of its audit rows (discovery.team_mailbox_member_added and
--      _removed, ids and fixed codes only).
--   2. team_mailbox_readers, the truth of who may read: the open members of a connected inbox
--      who are still active, internal, seated in the registration's firm and not a firm admin.
--      A view, so a promotion, a suspension or a move ends a person's reading on the next read
--      with no job. Service role only.
--   3. discovery_add_team_mailbox_member and discovery_remove_team_mailbox_member, the firm
--      admin's own RPCs (they act on auth.uid()).
--   4. The seat-loss triggers on users: a member who leaves the firm, is suspended or becomes
--      external is closed with seat_lost, and the tenant's discovery lock is taken BEFORE the
--      update, ahead of every after-row trigger that writes audit (audit item 4).
--   5. discovery_team_mailboxes() and discovery_remove_team_mailbox(), restated whole from
--      20261019120000_team_mailbox_list.sql (the only definitions on this base): the list adds
--      each inbox's members and the people who could be added, and Remove closes the open
--      members of the registration it closes (disconnected).
--
-- Membership is recorded and audited here and grants nothing: no RLS helper reads the readers
-- view yet, and the guard still refuses every named owner of a team source. Visibility follows
-- in a later phase.
--
-- Lock order (design R5, #461's rule): every SQL path that changes membership takes the tenant's
-- discovery lock (discovery_lock_tenant) before it writes audit, as discovery_upsert_candidates
-- does (lock, refresh visibility, then audit). The two RPCs, Remove and the seat-loss trigger
-- all take it first, so a member added while the inbox is being read and a candidate upsert
-- queue behind each other instead of deadlocking on the audit chain.

-- ── 1. The members ─────────────────────────────────────────────────────────
-- restrict on both keys: a registration or a user with a membership row is never deleted, so
-- the fold of the audit rows does not depend on another table's foreign key.
create table if not exists team_mailbox_members (
  id              uuid primary key default gen_random_uuid(),
  team_mailbox_id uuid not null references team_mailboxes (id) on delete restrict,
  user_id         uuid not null references users (id) on delete restrict,
  added_by        uuid not null references users (id),
  added_at        timestamptz not null default now(),
  -- Null while the person is a member. removed_by names the admin for a removal or a
  -- disconnect, and is null for the seat lost, which no admin did.
  removed_by      uuid references users (id),
  removed_at      timestamptz,
  removed_reason  text check (removed_reason in ('removed', 'seat_lost', 'disconnected')),
  constraint team_mailbox_members_removed_pair check ((removed_at is null) = (removed_reason is null)),
  constraint team_mailbox_members_removed_by check (removed_by is null or removed_at is not null),
  constraint team_mailbox_members_removed_by_admin check (removed_reason is distinct from 'removed' or removed_by is not null),
  constraint team_mailbox_members_seat_lost_by check (removed_reason is distinct from 'seat_lost' or removed_by is null)
);
create unique index if not exists team_mailbox_members_open
  on team_mailbox_members (team_mailbox_id, user_id) where removed_at is null;
create index if not exists team_mailbox_members_user_idx
  on team_mailbox_members (user_id) where removed_at is null;

-- Append-only: who was added to which inbox, by whom and when never change, and the removal
-- fields are written once, from null.
create or replace function team_mailbox_members_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.id, new.team_mailbox_id, new.user_id, new.added_by, new.added_at)
       is distinct from
     (old.id, old.team_mailbox_id, old.user_id, old.added_by, old.added_at)
     or old.removed_at is not null then
    raise exception 'team mailbox members are append-only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function team_mailbox_members_guard() from public, anon, authenticated;
drop trigger if exists team_mailbox_members_guard on team_mailbox_members;
create trigger team_mailbox_members_guard before update on team_mailbox_members
  for each row execute function team_mailbox_members_guard();

alter table team_mailbox_members enable row level security;
-- No policy: deny-all for the signed-in roles. The RPCs and triggers (definers) write it; the
-- service role reads it. Supabase's default privileges give service_role ALL on new tables and a
-- narrower grant does not take one away, so revoke everything first.
revoke all on team_mailbox_members from public, anon, authenticated, service_role;
grant select on team_mailbox_members to service_role;

-- The one audit writer for membership. It runs for every writer, so an addition or a removal can
-- never exist without its audit row. The actor is the admin when the session is the admin who
-- made the change, else the service (the seat-loss trigger). Ids and fixed codes only: never an
-- address, a name or an email.
create or replace function team_mailbox_members_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant  uuid;
  v_action  text;
  v_actor   uuid;
  v_detail  jsonb := jsonb_build_object('teamMailboxId', new.team_mailbox_id, 'userId', new.user_id);
begin
  select tm.tenant_id into v_tenant from team_mailboxes tm where tm.id = new.team_mailbox_id;
  if tg_op = 'INSERT' then
    v_action := 'discovery.team_mailbox_member_added';
    v_actor := new.added_by;
  elsif old.removed_at is null and new.removed_at is not null then
    v_action := 'discovery.team_mailbox_member_removed';
    v_actor := new.removed_by;
    v_detail := v_detail || jsonb_build_object('reason', new.removed_reason);
  else
    return null;
  end if;
  if auth.uid() is not null and auth.uid() is not distinct from v_actor then
    insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
    values (v_tenant, v_actor, 'user', v_action, v_detail);
  else
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (v_tenant, 'service', 'team-mailbox', v_action, v_detail);
  end if;
  return null;
end;
$$;
revoke all on function team_mailbox_members_audit() from public, anon, authenticated;
drop trigger if exists team_mailbox_members_audit on team_mailbox_members;
create trigger team_mailbox_members_audit after insert or update on team_mailbox_members
  for each row execute function team_mailbox_members_audit();

-- ── 2. The readers ─────────────────────────────────────────────────────────
-- Who may read a team inbox's discovery: an open member of an open registration who is, now,
-- active, internal, seated in the registration's firm and not a firm admin (an admin's /discovery
-- shows no candidate list, and self-add is refused). The view is the truth on every read: the
-- members table can hold an open row for someone since promoted, and the view drops them. No
-- clock, as allowed_team_mailboxes has none. Like it, only the service role reads it, and the RLS
-- helpers of a later phase read it from inside security definer functions.
create or replace view team_mailbox_readers as
select tm.tenant_id, tm.id as team_mailbox_id, m.user_id
from team_mailbox_members m
join team_mailboxes tm on tm.id = m.team_mailbox_id and tm.disconnected_at is null
join users u on u.id = m.user_id
            and u.tenant_id = tm.tenant_id
            and u.company_id = tm.firm_company_id
            and u.status = 'active'
            and u.is_external = false
            and u.firm_role is distinct from 'admin'
where m.removed_at is null;
revoke all on team_mailbox_readers from public, anon, authenticated, service_role;
grant select on team_mailbox_readers to service_role;

-- ── 3. Add and remove a member ─────────────────────────────────────────────
-- Both act on auth.uid() and answer one 42501 not_available for every case the caller must not
-- tell apart: no session, not the firm's admin, no such registration, another firm's, one
-- already closed. The routes map it to 404. The tenant's discovery lock is taken before
-- anything is written (see the header).
--
-- Add. One more refusal, with nothing written:
--   22023 not_eligible_member   the person is not an active, internal colleague seated in the
--                               registration's firm who is not a firm admin; also the admin
--                               themselves, and an unknown or other tenant's user
-- Adding someone who is already a member changes nothing and writes no audit row (added: false).
create or replace function discovery_add_team_mailbox_member(p_id uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid     uuid := auth.uid();
  v_admin   users%rowtype;
  v_tm      team_mailboxes%rowtype;
  v_target  users%rowtype;
  v_member  team_mailbox_members%rowtype;
  v_created boolean := false;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_admin from users where id = v_uid;
  if not found or not app_is_firm_admin(v_admin.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;

  perform discovery_lock_tenant(v_admin.tenant_id);

  select * into v_tm from team_mailboxes t
  where t.id = p_id and t.tenant_id = v_admin.tenant_id and t.firm_company_id = v_admin.company_id
    and t.disconnected_at is null
  for share;
  if not found then
    raise exception 'not_available' using errcode = '42501';
  end if;

  -- The eligibility test is team_mailbox_readers' own, plus not the caller. Kept identical in the
  -- list below (tests/constants-schema-sync.test.ts pins the three).
  select * into v_target from users u
  where u.id = p_user and u.id <> v_uid
    and u.tenant_id = v_tm.tenant_id and u.company_id = v_tm.firm_company_id
    and u.status = 'active' and u.is_external = false and u.firm_role is distinct from 'admin';
  if not found then
    raise exception 'not_eligible_member' using errcode = '22023';
  end if;

  select * into v_member from team_mailbox_members m
  where m.team_mailbox_id = v_tm.id and m.user_id = p_user and m.removed_at is null;
  if not found then
    insert into team_mailbox_members (team_mailbox_id, user_id, added_by)
    values (v_tm.id, p_user, v_uid)
    returning * into v_member;
    v_created := true;
  end if;

  return jsonb_build_object(
    'added', v_created,
    'member', jsonb_build_object(
      'userId', v_target.id, 'name', coalesce(v_target.display_name, v_target.full_name),
      'email', v_target.email, 'addedAt', v_member.added_at));
end;
$$;
revoke all on function discovery_add_team_mailbox_member(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_add_team_mailbox_member(uuid, uuid) to authenticated;

-- Remove. Closes the person's open membership (removed). Removing someone who is not a member
-- changes nothing and writes no audit row (removed: false). The person's own deals, and the
-- deal memberships they hold, are untouched: nothing here reads or writes them.
create or replace function discovery_remove_team_mailbox_member(p_id uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid     uuid := auth.uid();
  v_admin   users%rowtype;
  v_tm      team_mailboxes%rowtype;
  v_removed integer;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_admin from users where id = v_uid;
  if not found or not app_is_firm_admin(v_admin.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;

  perform discovery_lock_tenant(v_admin.tenant_id);

  select * into v_tm from team_mailboxes t
  where t.id = p_id and t.tenant_id = v_admin.tenant_id and t.firm_company_id = v_admin.company_id
    and t.disconnected_at is null
  for share;
  if not found then
    raise exception 'not_available' using errcode = '42501';
  end if;

  update team_mailbox_members
     set removed_at = now(), removed_by = v_uid, removed_reason = 'removed'
   where team_mailbox_id = v_tm.id and user_id = p_user and removed_at is null;
  get diagnostics v_removed = row_count;

  return jsonb_build_object('removed', v_removed > 0);
end;
$$;
revoke all on function discovery_remove_team_mailbox_member(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_remove_team_mailbox_member(uuid, uuid) to authenticated;

-- ── 4. Losing the seat closes the membership ───────────────────────────────
-- Copied from mailbox_consents_close_on_seat_loss (20261001130000): a person who leaves the firm,
-- is suspended or becomes external is closed with seat_lost, so a later re-seat does not revive
-- an old membership. A role change inside the same company keeps it (a promotion to admin is the
-- view's to drop). The tenant's discovery lock is taken first and unconditionally on a seat loss:
-- a member being added at that moment is committed or not before this reads the table, never
-- half-seen. A user who had no company has no membership to close, and the lock is skipped.
create or replace function team_mailbox_members_close_on_seat_loss()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.company_id is null
     or (new.company_id is not distinct from old.company_id
         and new.tenant_id is not distinct from old.tenant_id
         and new.status = 'active'
         and not coalesce(new.is_external, false)) then
    return null;
  end if;
  perform discovery_lock_tenant(old.tenant_id);
  -- team_mailbox_members_audit records each as removed with reason 'seat_lost', by the service.
  update team_mailbox_members set removed_at = now(), removed_reason = 'seat_lost'
  where user_id = new.id and removed_at is null;
  return null;
end;
$$;
revoke all on function team_mailbox_members_close_on_seat_loss() from public, anon, authenticated;
drop trigger if exists team_mailbox_members_close_on_seat_loss on users;
create trigger team_mailbox_members_close_on_seat_loss
  after update of company_id, tenant_id, status, is_external on users
  for each row execute function team_mailbox_members_close_on_seat_loss();

-- The lock comes BEFORE any after-row trigger on users (audit item 4). After-row triggers fire in name order, and
-- mailbox_consents_close_on_seat_loss (20261001130000) sorts first and writes an audit row (the audit chain's lock)
-- for a member who also opted in their own mailbox: taking the tenant lock only in the trigger above would then be
-- audit-then-tenant, the reverse of discovery_upsert_candidates (tenant, visibility, audit), and the two could
-- deadlock. A BEFORE trigger runs ahead of every after-row trigger, so a seat loss takes the tenant's discovery lock
-- first, whatever writes audit after it. The same test as the trigger above; taking the lock again is free.
create or replace function team_mailbox_members_lock_on_seat_loss()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.company_id is not null
     and (new.company_id is distinct from old.company_id
          or new.tenant_id is distinct from old.tenant_id
          or new.status <> 'active'
          or coalesce(new.is_external, false)) then
    perform discovery_lock_tenant(old.tenant_id);
  end if;
  return new;
end;
$$;
revoke all on function team_mailbox_members_lock_on_seat_loss() from public, anon, authenticated;
drop trigger if exists team_mailbox_members_lock_on_seat_loss on users;
create trigger team_mailbox_members_lock_on_seat_loss
  before update of company_id, tenant_id, status, is_external on users
  for each row execute function team_mailbox_members_lock_on_seat_loss();

-- ── 5. The list, with the members; Remove, closing them ────────────────────
-- Restated whole from 20261019120000_team_mailbox_list.sql (Remove, and removable, as audit item 9 left them)
-- and 20261019140000_team_mailbox_guard.sql (readRefusal, audit item 3). The list adds to each entry:
--   members   the open members, oldest first: { userId, name, email, addedAt }. A person promoted
--             to admin since still shows here until the admin removes them, though they read nothing
--   eligible  everyone who could be a member of this inbox, members included (the card subtracts
--             them): the active, internal colleagues seated in the registration's firm who are not
--             firm admins, by name. The admin's view of their own firm's people.
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
                               where g.tenant_id = tm.tenant_id and g.address = tm.address),
               'members', coalesce((
                 select jsonb_agg(
                          jsonb_build_object('userId', mu.id, 'name', coalesce(mu.display_name, mu.full_name),
                                             'email', mu.email, 'addedAt', m.added_at)
                          order by m.added_at, m.id)
                 from team_mailbox_members m
                 join users mu on mu.id = m.user_id
                 where m.team_mailbox_id = tm.id and m.removed_at is null
               ), '[]'::jsonb),
               'eligible', coalesce((
                 select jsonb_agg(
                          jsonb_build_object('userId', eu.id, 'name', coalesce(eu.display_name, eu.full_name),
                                             'email', eu.email)
                          order by coalesce(eu.display_name, eu.full_name), eu.id)
                 from users eu
                 where eu.tenant_id = tm.tenant_id and eu.company_id = tm.firm_company_id
                   and eu.status = 'active' and eu.is_external = false and eu.firm_role is distinct from 'admin'
               ), '[]'::jsonb))
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

-- Remove, as 20261019120000 made it, with two changes: the tenant's discovery lock is taken
-- first (closing the members writes audit rows and, in a later phase, changes who sees what),
-- and the registration's open members are closed with reason disconnected, by the admin who
-- removes it, before the registration is. Their audit rows are written by the members trigger.
-- Order of locks: the tenant's discovery lock, then the advisory lock the connect RPC takes for
-- the address, then the registration row, then its source row. The connect RPC takes the
-- advisory lock and then the source row and never the tenant lock; the worker's check RPC
-- updates the registration row alone; so none of them waits on another.
create or replace function discovery_remove_team_mailbox(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid             uuid := auth.uid();
  v_user            users%rowtype;
  v_tm              team_mailboxes%rowtype;
  v_src             content_sources%rowtype;
  v_archive_address text;
  v_archive_done    boolean := false;
  v_attempt         integer;
  v_reason          text;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_user from users where id = v_uid;
  if not found or not app_is_firm_admin(v_user.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;

  perform discovery_lock_tenant(v_user.tenant_id);

  -- Find the address first (no row lock), so the advisory lock can be taken before any row lock.
  select * into v_tm from team_mailboxes t
  where t.id = p_id and t.tenant_id = v_user.tenant_id and t.firm_company_id = v_user.company_id
    and t.disconnected_at is null;
  if not found then
    raise exception 'not_available' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('team_mailbox:' || v_tm.tenant_id::text || ':' || v_tm.address, 0));

  -- Read it again under its lock: a verification or a close that landed meanwhile decides.
  select * into v_tm from team_mailboxes t where t.id = p_id for update;
  if v_tm.disconnected_at is not null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_src from content_sources cs where cs.team_mailbox_id = v_tm.id for update;
  if v_src.id is not null
     and exists (select 1 from source_item_sources sis where sis.content_source_id = v_src.id) then
    raise exception 'not_removable' using errcode = '55000';
  end if;
  v_reason := case when v_tm.verified_at is null then 'never_verified' else 'no_mail' end;

  -- The people of an inbox that goes are closed with it, never left open on a closed registration.
  update team_mailbox_members
     set removed_at = now(), removed_by = v_uid, removed_reason = 'disconnected'
   where team_mailbox_id = v_tm.id and removed_at is null;

  update team_mailboxes
     set disconnected_at = now(), disconnected_by = v_uid, disconnected_reason = v_reason
   where id = v_tm.id;

  if v_src.id is not null then
    for v_attempt in 1..20 loop
      v_archive_address := v_tm.address || '~' || (
        select string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::integer, 1), '')
        from generate_series(1, 3));
      begin
        update content_sources
           set address = v_archive_address, status = 'paused',
               archived_at = now(), archived_from_address = address
         where id = v_src.id;
        v_archive_done := true;
        exit;
      exception when unique_violation then
        null;   -- that suffix is taken: draw another
      end;
    end loop;
    if not v_archive_done then
      raise exception 'mailbox_source_archive_failed' using errcode = 'P0001';
    end if;
  end if;
  delete from mailbox_guard_state where tenant_id = v_tm.tenant_id and address = v_tm.address;

  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_tm.tenant_id, v_uid, 'user', 'discovery.team_mailbox_disconnected',
          jsonb_build_object('teamMailboxId', v_tm.id, 'sourceId', v_src.id, 'reason', v_reason));

  return jsonb_build_object('id', v_tm.id, 'sourceId', v_src.id, 'removed', true);
end;
$$;
revoke all on function discovery_remove_team_mailbox(uuid) from public, anon, authenticated;
grant execute on function discovery_remove_team_mailbox(uuid) to authenticated;
