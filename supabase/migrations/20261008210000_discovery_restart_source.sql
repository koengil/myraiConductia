-- supabase/migrations/20261008210000_discovery_restart_source.sql
-- Reader liveness (#409, epic #261): the firm admin restarts a halted mailbox source.
-- handleExpiry (worker/sync.ts) halts a source with last_error = 'history_window_exceeded' when a
-- reset would only repeat; the worker then never queues or reads it (worker/classify.ts isHalted).
-- This clears the halt and the stored cursor so the next tick reads the mailbox again from the
-- start (dedupe drops what is already stored). Modelled on discovery_set_mailbox_source_status
-- (20261002181000_discovery_google_connect.sql): one 42501 not_available for every refusal (no such
-- source, another tenant's, a site, an archived source, a source that is not halted, a caller who
-- is not the source's own firm admin). Any provider: the halt is provider-agnostic. status is not
-- touched, so a paused source stays paused. Audited as discovery.mailbox_access_changed with change
-- 'restarted' (no new action). No content.
-- A restart re-reads the whole mailbox, so a source restarted in the last 24 hours (86400 s,
-- SOURCE_RESTART_COOLDOWN_SECONDS in src/lib/constants/discovery.ts) is refused the same way:
-- a source that halts again that soon would only repeat the read.
create or replace function discovery_restart_mailbox_source(p_source_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_src content_sources;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_src from content_sources where id = p_source_id for update;
  if not found or v_src.kind <> 'mailbox' or v_src.archived_at is not null
     or v_src.last_error is distinct from 'history_window_exceeded'
     or not app_is_firm_admin(v_src.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;
  -- The cooldown, read from the restart's own audit rows (append-only), under the row lock above.
  if exists (
    select 1 from audit_log a
     where a.tenant_id = v_src.tenant_id
       and a.action = 'discovery.mailbox_access_changed'
       and a.detail ->> 'change' = 'restarted'
       and a.detail ->> 'sourceId' = v_src.id::text
       and a.ts > now() - interval '86400 seconds'
  ) then
    raise exception 'not_available' using errcode = '42501';
  end if;

  update content_sources
     set last_error = null, last_error_at = null, delta_checkpoint = null,
         backfill_started_at = null, backfill_completed_at = null, history_expiry_streak = 0
   where id = v_src.id;
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_src.tenant_id, v_uid, 'user', 'discovery.mailbox_access_changed',
          jsonb_build_object('change', 'restarted', 'provider', v_src.provider,
                             'address', lower(v_src.address), 'sourceId', v_src.id));
  return jsonb_build_object('id', v_src.id, 'restarted', true);
end;
$$;

revoke all on function discovery_restart_mailbox_source(uuid) from public, anon;
grant execute on function discovery_restart_mailbox_source(uuid) to authenticated, service_role;
