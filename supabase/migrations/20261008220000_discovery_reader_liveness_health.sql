-- supabase/migrations/20261008220000_discovery_reader_liveness_health.sql
-- Reader liveness (#409, epic #261), slice 2/3: ingestion health reports one evidence-based
-- state per source. discovery_ingestion_health() is re-created from
-- 20261006130000_discovery_reader_pass_health.sql's body, gate statements verbatim; only
-- these keys are added:
--   sources[].state              paused | halted | switched_off | delegation_broken | waiting |
--                                failing | not_started | reading | up_to_date | stale, the
--                                first that holds (discovery_source_health_state)
--   sources[].lastPassAt         the source's newest consistent pass row (start or end) by
--                                server ts, and lastPassAgeSeconds; null before its first pass
--   sources[].lastActivityAt     the newer of lastPassAt and the source's progress mark
--                                (reader_progress_at), and lastActivityAgeSeconds
--   sources[].latestPassLive     true while the latest pass is unfinished and live by the rule
--                                below: what the card's pass badge reads in place of #388's
--                                3600 s in_progress, so the badge and the row agree
--   reader {enabled, lastActiveAt, lastActiveAgeSeconds, state}
--                                tenant level: is the firm's mail being read, from readable
--                                sources only (null in the no-registration shape)
-- Three helpers, none executable by a browser role:
--   discovery_reader_live(ts)                  the one 900 s liveness window (three ticks, #387's
--                                              no-tick window)
--   discovery_reader_pass_end_with_ts(t, st)   discovery_reader_pass_end()'s predicates, returning
--                                              {detail, ts} in one probe
--   discovery_source_health_state(...)         the precedence, pure over booleans the RPC computes
-- The flags (deal_discovery and discovery_worker_enabled, missing = off) and the registrations are
-- read after the gate. #388's latestPass and its 3600 s in_progress are unchanged and are not used
-- for liveness. No pass writer, index or validation change; pass-row retention is a follow-up.
--
-- One liveness rule for the source row and the reader line: evidence within discovery_reader_live's
-- window. An unfinished pass reads reading while its last progress mark (or, before the first, its
-- start) is live; the reader line is not_reading when no readable source's last activity (pass row or
-- progress mark) is live. So a source never reads reading or up to date while the line reads not
-- reading. The progress mark is content_sources.reader_progress_at, written by the worker
-- (worker/progress.ts) at most once a minute while the reader gets tokens and successful responses;
-- READER_LIVENESS_SECONDS (src/lib/constants/discovery.ts) has the window's arithmetic.

-- The source's progress mark: when the worker last saw its reader move. A timestamp, no content.
alter table content_sources add column if not exists reader_progress_at timestamptz;
comment on column content_sources.reader_progress_at is
  'Reader liveness (#409): when the worker last saw this source''s reader make progress (a token or a successful provider response), written at most once a minute during a pass. No content.';

-- The one liveness window (n1): a row this recent shows the reader at work.
create or replace function discovery_reader_live(p_ts timestamptz)
returns boolean language sql stable set search_path = public as $$
  select p_ts is not null and p_ts > now() - interval '900 seconds'
$$;
revoke all on function discovery_reader_live(timestamptz) from public, anon, authenticated;

-- A consistent start's consistent end, as {detail, ts}: discovery_reader_pass_end()'s predicates, one probe (R5).
create or replace function discovery_reader_pass_end_with_ts(p_tenant uuid, p_started jsonb)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('detail', f.detail, 'ts', f.ts)
  from audit_log f
  where f.tenant_id = p_tenant
    and f.action = 'discovery.reader_pass_finished'
    and f.detail->>'passId' = p_started->>'passId'
    and f.detail->'sourceId' = p_started->'sourceId'
    and f.detail->'runId' = p_started->'runId'
    and f.detail->'jobId' = p_started->'jobId'
    and f.detail->'startedAt' = p_started->'startedAt'
    and f.detail->'worker' = p_started->'worker'
    and discovery_reader_pass_consistent(f.action, f.detail, f.ts)
  limit 1
$$;
revoke all on function discovery_reader_pass_end_with_ts(uuid, jsonb) from public, anon, authenticated;

-- A source's state in ingestion health: the first that holds. Pure over booleans the RPC computes with
-- discovery_reader_live(), each outcome judged by its own pass (R5); the TS vocabulary (SOURCE_HEALTH_STATE)
-- is pinned to these literals in this order.
create or replace function discovery_source_health_state(
  p_status text, p_archived boolean, p_last_error text, p_waiting_for text,
  p_reading_enabled boolean, p_registration_active boolean,
  p_has_pass boolean, p_pass_group text, p_pass_reason text,
  p_unfinished_live boolean, p_end_live boolean, p_checkpoint_state text)
returns text language sql immutable set search_path = public as $$
  select case
    when p_status <> 'active' or p_archived then 'paused'
    when p_last_error = 'history_window_exceeded' then 'halted'
    -- A deliberate switch-off beats any failure (R3).
    when not p_reading_enabled or not p_registration_active then 'switched_off'
    when p_pass_group = 'failed' and p_pass_reason = 'delegation_refused' then 'delegation_broken'
    when p_waiting_for is not null then 'waiting'
    -- Before stale: pg-boss backoff can push a failing source's last pass past the window (M3).
    when p_pass_group = 'failed' then 'failing'
    -- Never read, or just restarted (its latest pass is the halt) (m1; n2: accepted while the worker is down).
    when p_checkpoint_state = 'not_started'
         and (not p_has_pass or p_pass_reason in ('history_window_exceeded', 'source_halted')) then 'not_started'
    -- An unfinished pass counts while its last progress (or its start) is live; a continued one by its own end (R5).
    when p_unfinished_live or (p_pass_group = 'continued' and p_end_live) then 'reading'
    -- Up to date only with evidence: this pass completed and its own end is live (M3, R5).
    when p_pass_group = 'completed' and p_end_live then 'up_to_date'
    else 'stale'
  end
$$;
revoke all on function discovery_source_health_state(text, boolean, text, text, boolean, boolean, boolean, text, text, boolean, boolean, text)
  from public, anon, authenticated;

create or replace function discovery_ingestion_health()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid;
  v_role    text;
  v_company uuid;
  v_firms   uuid[];
  v_sources jsonb;
  v_reading_enabled boolean;
  v_ms_active       boolean;
  v_google_active   boolean;
begin
  -- An active, internal admin or CCO of the tenant, and, once the registration
  -- names a firm, seated in it (C5), the same standing
  -- discovery_allowlist_health() requires. Any registration status counts, so
  -- disabling the reader does not strip the CCO of the metadata Q1 = B keeps.
  -- `is not true`, not `not (...)`: with no company the comparison is null, and
  -- a null must refuse.
  select tenant_id, firm_role, company_id into v_tenant, v_role, v_company
  from users
  where id = v_uid and status = 'active' and is_external = false;
  if v_uid is null or v_tenant is null or v_role is null or v_role not in ('admin', 'cco') then
    raise exception 'discovery_ingestion_health: not available to this user'
      using errcode = '42501';
  end if;
  v_firms := firm_company_ids(v_tenant);
  if cardinality(v_firms) = 0 then
    -- No firm is named: the no-registration shape, and nothing of the tenant.
    return jsonb_build_object(
      'registration', null,
      'registrations', '[]'::jsonb,
      'allowlist', '[]'::jsonb,
      'sources', '[]'::jsonb,
      'reader', null,
      'viewerCanManageSources', false,
      'reconciliation', 'not_built',
      'policyVersion', null,
      'totals', jsonb_build_object('sources', 0, 'itemsLedgered', 0, 'itemsRouted', 0, 'itemsSkipped', 0,
                                   'itemsExcluded', 0, 'itemsStored', 0, 'candidatesProposed', 0,
                                   'passesLast24h', null));
  end if;
  if (v_company = any (v_firms)) is not true then
    raise exception 'discovery_ingestion_health: not available to this user'
      using errcode = '42501';
  end if;

  -- Both switches, read as the worker reads them: deal_discovery and discovery_worker_enabled, missing = off (M2).
  v_reading_enabled :=
    coalesce((select f.enabled from feature_flags f where f.key = 'deal_discovery'), false)
    and coalesce((select f.enabled from feature_flags f where f.key = 'discovery_worker_enabled'), false);
  v_ms_active := exists (select 1 from graph_reader_registrations r where r.tenant_id = v_tenant and r.status = 'active');
  v_google_active := exists (select 1 from google_reader_registrations r where r.tenant_id = v_tenant and r.status = 'active');

  with ledger as (
    select l.source_id,
           count(*)                                      as ledgered,
           count(*) filter (where l.decision = 'routed')  as routed,
           count(*) filter (where l.decision = 'skipped') as skipped,
           -- Every policy reason, from every version: a historical count. The
           -- after-fetch reason is included: it is a policy exclusion too, and
           -- the ledger records honestly that its body was fetched and dropped.
           count(*) filter (where l.skip_reason in
             ('policy_excluded', 'policy_thread_excluded', 'policy_unevaluable', 'policy_excluded_after_fetch')) as excluded
    from routing_ledger l
    join content_sources c on c.id = l.source_id
    where c.tenant_id = v_tenant
    group by l.source_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'kind', c.kind,
           'provider', c.provider,
           'address', c.address,
           'status', c.status,
           -- An archived source (#262's orphan handling) is closed for good: it
           -- cannot be resumed, so the panel must not offer to.
           'archived', c.archived_at is not null,
           'ownerAssigned', c.owner_user_id is not null,
           'checkpointState', d.checkpoint_state,
           'backfillCompletedAt', c.backfill_completed_at,
           'checkpointUpdatedAt', c.checkpoint_updated_at,
           'checkpointAgeSeconds', case
             when c.checkpoint_updated_at is null then null
             else greatest(0, floor(extract(epoch from (now() - c.checkpoint_updated_at))))::bigint
           end,
           'lastSyncedAt', c.last_synced_at,
           'lastError', c.last_error,
           'lastErrorAt', c.last_error_at,
           'waitingFor', d.waiting_for,
           'itemsLedgered', coalesce(l.ledgered, 0),
           'itemsRouted', coalesce(l.routed, 0),
           'itemsSkipped', coalesce(l.skipped, 0),
           'itemsExcluded', coalesce(l.excluded, 0),
           -- The newest reader pass (#370): its state, outcome, worker-clock times and
           -- counts. Every cast reads a row discovery_reader_pass_consistent() accepted.
           'latestPass', case when lp.started is null then null else jsonb_build_object(
             'state', d.pass_state,
             'group', discovery_reader_pass_group(lp.fin->>'status'),
             'status', lp.fin->>'status',
             'reason', lp.fin->>'reason',
             'startedAt', lp.started->>'startedAt',
             'endedAt', lp.fin->>'endedAt',
             'pages', coalesce((lp.fin->>'pages')::bigint, 0),
             'fetched', coalesce((lp.fin->>'fetched')::bigint, 0),
             'excluded', coalesce((lp.fin->>'excluded')::bigint, 0),
             'stored', coalesce((lp.fin->>'stored')::bigint, 0),
             'checkpointAdvanced', coalesce((lp.fin->>'checkpointAdvanced')::boolean, false)
           ) end,
           -- The newest pass row of either action for the source, by server ts (m3): for the reason line and the reader.
           'lastPassAt', act.ts,
           'lastPassAgeSeconds', case when act.ts is null then null
             else greatest(0, floor(extract(epoch from (now() - act.ts))))::bigint end,
           -- The newer of that row and the progress mark: what the reader line ages, by the same window.
           'lastActivityAt', d.activity_at,
           -- The latest pass is unfinished and live by the same rule as the state (one clock for the row and badge).
           'latestPassLive', d.unfinished_live,
           'lastActivityAgeSeconds', case when d.activity_at is null then null
             else greatest(0, floor(extract(epoch from (now() - d.activity_at))))::bigint end,
           'state', discovery_source_health_state(
             c.status, c.archived_at is not null, c.last_error, d.waiting_for, v_reading_enabled,
             case c.provider when 'microsoft' then v_ms_active when 'google' then v_google_active else false end,
             lp.started is not null, discovery_reader_pass_group(lp.fin->>'status'), lp.fin->>'reason',
             d.unfinished_live, d.end_live, d.checkpoint_state)
         ) order by c.kind, lower(c.address)), '[]'::jsonb)
  into v_sources
  from content_sources c
  left join ledger l on l.source_id = c.id
  -- The source's newest consistent start by server ts (then the worker's startedAt), and its own end's
  -- detail and server ts in one probe, matched on every immutable field (R2-M5, R5).
  left join lateral (
    select q.started, q.started_ts, q.e->'detail' as fin, (q.e->>'ts')::timestamptz as fin_ts
    from (
      select s.detail as started, s.ts as started_ts, discovery_reader_pass_end_with_ts(v_tenant, s.detail) as e
      from audit_log s
      where s.tenant_id = v_tenant
        and s.action = 'discovery.reader_pass_started'
        and s.detail->>'sourceId' = c.id::text
        and discovery_reader_pass_consistent(s.action, s.detail, s.ts)
      order by s.ts desc, s.detail->>'startedAt' desc
      limit 1
    ) q
  ) lp on true
  -- One index probe (audit_log_reader_pass_source): the source's newest consistent pass row of either action (m3, m7).
  left join lateral (
    select a.ts from audit_log a
    where a.tenant_id = v_tenant
      and a.action in ('discovery.reader_pass_started', 'discovery.reader_pass_finished')
      and a.detail->>'sourceId' = c.id::text
      and discovery_reader_pass_consistent(a.action, a.detail, a.ts)
    order by a.ts desc
    limit 1
  ) act on true
  -- Each derived value once, for its JSON key and for the state.
  cross join lateral (
    select
      case
        when c.backfill_completed_at is not null then 'incremental'
        when c.delta_checkpoint is not null then 'backfilling'
        else 'not_started'
      end as checkpoint_state,
      -- Why the guard would refuse this source now, only while it is active
      -- and not archived: a paused source is skipped before the guard, so
      -- its last reason is history. A mailbox is judged by the database's own
      -- verdict (live, never stale); when that admits the read, the worker's
      -- provider-group refusal (not a database fact) is what remains. A site
      -- has no verdict here, so its last site refusal stands.
      case
        when c.status = 'active' and c.archived_at is null then
          case
            when c.kind = 'mailbox' then coalesce(
              mailbox_guard_verdict(c.tenant_id, c.address, c.provider),
              (select g.last_reason from mailbox_guard_state g
                where g.tenant_id = c.tenant_id and g.address = lower(c.address)
                  and g.last_reason in ('not_in_provider_group', 'mirror_unavailable')))
            else
              (select g.last_reason from mailbox_guard_state g
                where g.tenant_id = c.tenant_id and g.address = lower(c.address))
          end
        else null
      end as waiting_for,
      case when lp.started is null then null
           when lp.fin is not null then 'ended'
           when lp.started_ts > now() - interval '3600 seconds' then 'in_progress'
           else 'no_end_recorded' end as pass_state,
      -- An unfinished pass is live while the newer of its start and the source's last progress mark is within the
      -- window: a crashed worker stops marking, a slow page keeps marking. A mark older than the start is the start.
      (lp.started is not null and lp.fin is null
        and discovery_reader_live(greatest(lp.started_ts, c.reader_progress_at))) as unfinished_live,
      -- Any evidence of the reader at work on this source, for the reader line: the same window judges it.
      greatest(act.ts, c.reader_progress_at) as activity_at,
      discovery_reader_live(lp.fin_ts) as end_live
  ) d
  where c.tenant_id = v_tenant;

  return jsonb_build_object(
    'registration', (
      select jsonb_build_object('status', r.status, 'consentedAt', r.consented_at)
      from graph_reader_registrations r
      where r.tenant_id = v_tenant
    ),
    'registrations', coalesce((
      select jsonb_agg(reg order by reg->>'provider')
      from (
        select jsonb_build_object('provider', 'microsoft', 'status', r.status, 'consentedAt', r.consented_at,
                                  'delegationStatus', null, 'delegationCheckedAt', null) as reg
        from graph_reader_registrations r where r.tenant_id = v_tenant
        union all
        select jsonb_build_object('provider', 'google', 'status', r.status, 'consentedAt', r.consented_at,
                                  'delegationStatus', r.delegation_status,
                                  'delegationCheckedAt', r.delegation_checked_at) as reg
        from google_reader_registrations r where r.tenant_id = v_tenant
      ) regs
    ), '[]'::jsonb),
    -- Group drift, counts only. The member addresses stay in discovery_allowlist_health().
    'allowlist', coalesce((
      select jsonb_agg(jsonb_build_object(
               'provider', d.provider,
               'status', d.status,
               'missingCount', cardinality(d.missing_in_group),
               'extraCount', cardinality(d.extra_in_group),
               'checkedAt', d.checked_at) order by d.provider)
      from mailbox_allowlist_drift d
      where d.tenant_id = v_tenant
    ), '[]'::jsonb),
    -- Is the firm's mail being read (R4)? From readable sources only: a paused, halted or switched-off source (and a
    -- halted source's stray skip) never counts. lastActiveAt proves the worker recorded an attempt, or progress, on a
    -- readable mailbox then, whatever its outcome (m2). No heartbeat table, no extra audit_log scan.
    'reader', (
      select jsonb_build_object(
        'enabled', v_reading_enabled,
        'lastActiveAt', r.last_active_at,
        'lastActiveAgeSeconds', case when r.last_active_at is null then null
          else greatest(0, floor(extract(epoch from (now() - r.last_active_at))))::bigint end,
        'state', case
          when not v_reading_enabled then 'switched_off'
          when r.readable = 0 then 'idle'
          when not discovery_reader_live(r.last_active_at) then 'not_reading'
          when r.healthy > 0 then 'reading'
          else 'active'
        end)
      from (
        select count(*) as readable,
               max((s->>'lastActivityAt')::timestamptz) as last_active_at,
               count(*) filter (where s->>'state' in ('reading', 'up_to_date')) as healthy
        from jsonb_array_elements(v_sources) s
        where s->>'state' not in ('paused', 'halted', 'switched_off')
      ) r
    ),
    'sources', v_sources,
    -- The tenant's current policy version (a separate fact from the historical
    -- count above), or null when none was ever written. Only the version number
    -- leaves the function: never a rule, a domain, an address or a label.
    'policyVersion', (select max(p.version) from discovery_exclusion_policies p where p.tenant_id = v_tenant),
    'viewerCanManageSources', app_is_firm_admin(v_tenant, v_uid),
    -- Reconciliation (token-mint ledger, unauthorized mints) is deferred (F4).
    'reconciliation', 'not_built',
    'totals', jsonb_build_object(
      'sources', jsonb_array_length(v_sources),
      'itemsLedgered', coalesce((select sum((s->>'itemsLedgered')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsRouted', coalesce((select sum((s->>'itemsRouted')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsSkipped', coalesce((select sum((s->>'itemsSkipped')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsExcluded', coalesce((select sum((s->>'itemsExcluded')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsStored', (select count(*) from source_items si where si.tenant_id = v_tenant),
      'candidatesProposed', (
        select count(*) from deal_candidates dc
        where dc.tenant_id = v_tenant and dc.discovery_state = 'proposed'
      ),
      -- Reader passes started in the last 24 hours by server ts (#370), by outcome group,
      -- with their counts. A start with no end older than the discovery.sync expiry
      -- has no end recorded; a younger one is still in progress and in no group.
      'passesLast24h', (
        select jsonb_build_object(
          'passes', count(*),
          'completed', count(*) filter (where discovery_reader_pass_group(p.fin->>'status') = 'completed'),
          'continued', count(*) filter (where discovery_reader_pass_group(p.fin->>'status') = 'continued'),
          'stopped',   count(*) filter (where discovery_reader_pass_group(p.fin->>'status') = 'stopped'),
          'refused',   count(*) filter (where discovery_reader_pass_group(p.fin->>'status') = 'refused'),
          'failed',    count(*) filter (where discovery_reader_pass_group(p.fin->>'status') = 'failed'),
          'noEndRecorded', count(*) filter (where p.fin is null and p.ts <= now() - interval '3600 seconds'),
          'fetched',  coalesce(sum((p.fin->>'fetched')::bigint), 0),
          'excluded', coalesce(sum((p.fin->>'excluded')::bigint), 0),
          'stored',   coalesce(sum((p.fin->>'stored')::bigint), 0))
        from content_sources c2
        cross join lateral (
          select s.ts, discovery_reader_pass_end(v_tenant, s.detail) as fin
          from audit_log s
          where s.tenant_id = v_tenant and s.action = 'discovery.reader_pass_started'
            and s.detail->>'sourceId' = c2.id::text
            and s.ts >= now() - interval '24 hours'
            and discovery_reader_pass_consistent(s.action, s.detail, s.ts)
        ) p
        where c2.tenant_id = v_tenant
      )
    )
  );
end;
$$;

-- create or replace keeps the grants of 20260929180000_discovery_health_grant;
-- restating them makes this migration safe to read alone.
revoke all on function discovery_ingestion_health() from public, anon;
grant execute on function discovery_ingestion_health() to authenticated, service_role;
