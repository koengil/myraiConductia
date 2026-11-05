-- supabase/migrations/20261019120000_team_mailbox_list.sql
-- Admin-managed team inbox (#581), phase 3: the admin's list, connect and cheap Remove
-- through the API.
--
--   1. discovery_connect_team_mailbox is granted to authenticated. Phase 1 created it
--      closed to every API role; its route (POST /api/v1/discovery/team-mailboxes) lands
--      with this migration. Its body is unchanged.
--   2. discovery_team_mailboxes(), the firm admin's list of the firm's open registrations,
--      with the state of each one's source and whether Remove is open to it.
--   3. discovery_remove_team_mailbox(p_id), the firm admin's way out of a registration
--      that holds no mail (deals@ turned out to be a group, a typo, a test, an address
--      whose identity changed). The registration is closed and its source archived, as a
--      reconnect would have done: never_verified when it never verified, no_mail when it
--      did but nothing was ever attached (audit item 9). A registration whose source holds
--      any mail is not removable here: disconnecting one with mail is the purge slice that
--      follows the demo.
--
-- Like the other firm-admin RPCs (discovery_set_mailbox_source_status), both new functions
-- act on auth.uid(), check the caller is the firm's active, internal admin themselves, and
-- answer one 42501 not_available for every case the caller must not tell apart: no session,
-- not an admin, no such registration, another tenant's or another firm's, one already
-- closed. The route maps it to 404.
--
-- Audit rows about a team source carry ids and fixed codes only (design R9): the removal
-- is discovery.team_mailbox_disconnected {teamMailboxId, sourceId, reason}.

-- ── 0. A second way to close: a verified registration that holds nothing ────
-- Restated from 20261019100000_team_mailboxes.sql, widened by no_mail (Remove, below).
alter table team_mailboxes drop constraint if exists team_mailboxes_disconnected_reason_check;
alter table team_mailboxes add constraint team_mailboxes_disconnected_reason_check
  check (disconnected_reason in ('never_verified', 'no_mail'));

-- ── 1. The connect RPC reaches the signed-in role ──────────────────────────
grant execute on function discovery_connect_team_mailbox(text, integer, date) to authenticated;

-- ── 2. The list ────────────────────────────────────────────────────────────
-- The firm's open registrations, oldest first. The address is the admin's to see: it is
-- the one they connected. Nothing here reads mail: removable looks for provenance rows only.
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
               'removable', (not exists (select 1 from source_item_sources sis where sis.content_source_id = s.id))
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

-- ── 3. Remove ──────────────────────────────────────────────────────────────
-- Refusals, each with nothing written:
--   42501 not_available   whatever the reason the caller may not know (see the header)
--   55000 not_removable   its source holds mail
-- Order of locks: the advisory lock the connect RPC takes for the address, then the
-- registration row, then its source row. The connect RPC takes the advisory lock and then
-- the source row, never the registration row, so the two cannot wait on each other. The
-- worker's check RPC (a later phase) updates the registration row alone.
-- The registration is closed before the source is archived, because an open registration
-- keeps its source's address fixed (content_sources_team_fixed). The archive is the one
-- connect makes of a closed registration's source: renamed <address>~xyz, paused, stamped.
-- The guard's last refusal for the address is forgotten, so a later connect of the same
-- address audits its first refusal instead of deduplicating it away.
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

  -- Find the address first (no lock), so the advisory lock can be taken before any row lock.
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
