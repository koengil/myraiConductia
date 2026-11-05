-- supabase/migrations/20261016170000_discovery_google_mailbox_sync_status.sql
-- First-sync status on the Connect Gmail card (#341, PR 1). discovery_google_mailbox_status() is re-created from
-- 20261002181000_discovery_google_connect.sql's body, every existing key and its meaning unchanged; only these keys
-- are added, for the caller's own source and only when connected:
--   state                the source's ingestion health state, from the one precedence
--                        (discovery_source_health_state, 20261008220000) over the same inputs
--                        discovery_ingestion_health() computes for the admin's row
--   backfillCompletedAt  when the first full read of the mailbox finished, or null
--   lastSyncedAt         the source's last successful sync, or null
--   delegationRefused    Google's token endpoint refused the domain-wide delegation: the latest pass failed
--                        delegation_refused, or the worker's last error on the active source is SYNC_ERROR.DELEGATION
--                        (worker/sync.ts) and was written at or after the latest pass started. last_error clears only
--                        when a sync completes, so a first backfill that ends passes at the page limit would otherwise
--                        keep a refusal the admin has since fixed. Both sides of the comparison are the worker's clock
--                        (last_error_at and the start row's detail.startedAt), never the database's audit ts, so host
--                        skew between the worker and the database cannot flip it. Only the firm's Google admin can grant it
-- No read count: routing_ledger rows survive mailbox_consent_grant's in-place adoption of an ownerless source, so a
-- count could show a new holder the previous holder's reads.
-- Timestamps and a state. No subject, participant, body or message id leaves this function, and the gate is
-- unchanged: auth.uid() only, a live Google source the caller owns for the address of their seat.
create or replace function discovery_google_mailbox_status()
returns jsonb language plpgsql security definer stable set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_allowed record;
  v_reg google_reader_registrations;
  v_reg_active boolean;
  v_src content_sources;
  v_reading_enabled boolean;
  v_started jsonb;
  v_started_ts timestamptz;
  v_end jsonb;
  v_fin jsonb;
  v_waiting text;
  v_state text;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select a.tenant_id, a.address into v_allowed from allowed_mailboxes a
   where a.user_id = v_uid and a.provider = 'google' limit 1;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  select * into v_src from content_sources cs
   where cs.tenant_id = v_allowed.tenant_id and cs.kind = 'mailbox' and cs.provider = 'google'
     and lower(cs.address) = v_allowed.address
     and cs.owner_user_id = v_uid and cs.archived_at is null;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  select * into v_reg from google_reader_registrations g
   where g.tenant_id = v_allowed.tenant_id and g.status = 'active';
  v_reg_active := found;

  -- The health state's inputs, derived as discovery_ingestion_health() derives them for this one source.
  v_reading_enabled :=
    coalesce((select f.enabled from feature_flags f where f.key = 'deal_discovery'), false)
    and coalesce((select f.enabled from feature_flags f where f.key = 'discovery_worker_enabled'), false);
  select s.detail, s.ts, discovery_reader_pass_end_with_ts(v_src.tenant_id, s.detail)
    into v_started, v_started_ts, v_end
    from audit_log s
   where s.tenant_id = v_src.tenant_id
     and s.action = 'discovery.reader_pass_started'
     and s.detail->>'sourceId' = v_src.id::text
     and discovery_reader_pass_consistent(s.action, s.detail, s.ts)
   order by s.ts desc, s.detail->>'startedAt' desc
   limit 1;
  v_fin := v_end->'detail';
  if v_src.status = 'active' then
    v_waiting := coalesce(
      mailbox_guard_verdict(v_src.tenant_id, v_src.address, v_src.provider),
      (select g.last_reason from mailbox_guard_state g
        where g.tenant_id = v_src.tenant_id and g.address = lower(v_src.address)
          and g.last_reason in ('not_in_provider_group', 'mirror_unavailable')));
  end if;
  v_state := discovery_source_health_state(
    v_src.status, false, v_src.last_error, v_waiting, v_reading_enabled, v_reg_active,
    v_started is not null, discovery_reader_pass_group(v_fin->>'status'), v_fin->>'reason',
    v_started is not null and v_fin is null and discovery_reader_live(greatest(v_started_ts, v_src.reader_progress_at)),
    discovery_reader_live((v_end->>'ts')::timestamptz),
    case
      when v_src.backfill_completed_at is not null then 'incremental'
      when v_src.delta_checkpoint is not null then 'backfilling'
      else 'not_started'
    end);

  return jsonb_build_object(
    'connected', true,
    'address', v_allowed.address,
    'group', v_reg.allowlist_group,
    'domain', v_reg.workspace_domain,
    'paused', v_src.status = 'paused',
    'waitingForGroup', coalesce((select g.last_reason = 'not_in_provider_group' from mailbox_guard_state g
                                  where g.tenant_id = v_allowed.tenant_id and g.address = v_allowed.address), false),
    'state', v_state,
    'backfillCompletedAt', v_src.backfill_completed_at,
    'lastSyncedAt', v_src.last_synced_at,
    'delegationRefused', v_state = 'delegation_broken'
                         or (v_src.status = 'active' and v_src.last_error is not distinct from 'Google delegation refused'
                             and v_src.last_error_at >= coalesce((v_started->>'startedAt')::timestamptz, '-infinity'::timestamptz)));
end;
$$;

-- create or replace keeps 20261002181000's grants; restating them makes this migration safe to read alone.
revoke all on function discovery_google_mailbox_status() from public, anon;
grant execute on function discovery_google_mailbox_status() to authenticated, service_role;
