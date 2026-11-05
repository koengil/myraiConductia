-- supabase/migrations/20261018110000_discovery_set_source_window.sql
-- Ingestion window (#353), slice 3/3: a firm admin sets how far back a Gmail mailbox's first
-- read goes, before that read starts. Owner decision 2026-10-16 (Option B):
--   who      the source's own firm admin (app_is_firm_admin), as pause, resume and restart; the
--            CCO sees the window in ingestion health and cannot change it
--   bounds   no later than today (UTC) and no earlier than 730 days before today (UTC); 730 is
--            BACKFILL_WINDOW_MAX_DAYS in src/lib/constants/discovery.ts, pinned to the one literal
--            below by tests/constants-schema-sync.test.ts
--   when     only before the source's first read: once delta_checkpoint, backfill_started_at or
--            backfill_completed_at is set the window is locked (55000 window_locked). The worker
--            sets backfill_started_at and reads the window back in one statement before its first
--            Gmail request (worker/sync.ts firstReadClaim), and this function holds the row lock
--            while it checks, so a change is either read by that pass or refused. The same
--            predicate discovery_ingestion_health() reports as windowLocked
--            (20261018100000_discovery_health_window.sql). A restart clears all three, so a
--            restarted source (paused first, so the worker cannot lock it in between) is editable
--            again.
--   audit    every real change writes discovery.mailbox_access_changed with change 'window_set'
--            and the from and to dates, in the same transaction (no new action, as restart:
--            20261008210000_discovery_restart_source.sql); a repeat of the stored date is a no-op
--            with changed false and no audit row
-- Refusals, modelled on discovery_set_mailbox_source_status
-- (20261002181000_discovery_google_connect.sql): one 42501 not_available for no session, no
-- such source, another tenant's, a site, a Microsoft source (its reader does not honour the
-- window yet, #353 follow-up F1), an archived source, a caller who is not the firm's admin, or
-- deal_discovery off (the route's gate, held here too because PostgREST reaches the RPC directly);
-- 22023 out_of_range for a null or out-of-bounds date (checked after the role, so a stranger
-- learns nothing); 55000 window_locked once reading has started. set search_path = public,
-- pg_temp (#312's form). No content.
create or replace function discovery_set_mailbox_source_window(p_source_id uuid, p_since date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_src   content_sources;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  -- The route's gate, held here too: execute is granted to authenticated, so PostgREST reaches this with the flag off.
  if not exists (select 1 from feature_flags where key = 'deal_discovery' and enabled) then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_src from content_sources where id = p_source_id for update;
  if not found or v_src.kind <> 'mailbox' or v_src.provider <> 'google' or v_src.archived_at is not null
     or not app_is_firm_admin(v_src.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;
  if p_since is null or p_since > v_today or p_since < v_today - 730 then
    raise exception 'out_of_range' using errcode = '22023';
  end if;
  if v_src.delta_checkpoint is not null or v_src.backfill_started_at is not null
     or v_src.backfill_completed_at is not null then
    raise exception 'window_locked' using errcode = '55000';
  end if;

  if v_src.backfill_since is not distinct from p_since then
    return jsonb_build_object('id', v_src.id, 'backfillSince', p_since, 'changed', false);
  end if;
  update content_sources set backfill_since = p_since where id = v_src.id;
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_src.tenant_id, v_uid, 'user', 'discovery.mailbox_access_changed',
          jsonb_build_object('change', 'window_set', 'provider', v_src.provider,
                             'address', lower(v_src.address), 'sourceId', v_src.id,
                             'from', v_src.backfill_since, 'to', p_since));
  return jsonb_build_object('id', v_src.id, 'backfillSince', p_since, 'changed', true);
end;
$$;

revoke all on function discovery_set_mailbox_source_window(uuid, date) from public, anon;
grant execute on function discovery_set_mailbox_source_window(uuid, date) to authenticated, service_role;
