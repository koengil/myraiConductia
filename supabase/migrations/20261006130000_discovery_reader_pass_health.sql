-- supabase/migrations/20261006130000_discovery_reader_pass_health.sql
-- The reader pass record (#370), phase 3: the admin and CCO see the last pass of
-- each source and the last 24 hours. discovery_ingestion_health() is re-created
-- from 20261003120000_discovery_exclusion_health.sql's body VERBATIM, gate
-- included; only these keys are added:
--   sources[].latestPass   the source's newest consistent start by server ts (then
--                          detail startedAt), with its consistent end matched on every
--                          immutable field; state ended | in_progress (no end, start
--                          ts under 3600 s old, the discovery.sync expiry) |
--                          no_end_recorded
--   totals.passesLast24h   consistent starts with ts in the last 24 h, by group, and
--                          their counts (null in the no-registration shape)
-- A row is read only if discovery_reader_pass_consistent() accepts it: the writer's
-- shape checks and time bounds, measured against the row's own ts. An end that
-- differs from its start in passId, sourceId, runId, jobId, startedAt or worker is
-- not that pass's end. So a malformed, inconsistent or forged row written past the
-- writer is neither shown nor counted, and cannot break the card (R1-M7, R2-M5).
-- Never the registration, worker, job id or run id: those stay in audit_log for an
-- operator.
--
-- Two limits (also in docs/03-engineering/deal-discovery-demo-runbook.md):
--   - passes of a deleted source drop out of the totals (they are counted per
--     current source);
--   - an end whose start has not arrived yet (possible only once #264 moves the
--     record) is not shown until the start lands.
-- No new index: 20261006120000's per-source (tenant, sourceId, ts desc) index serves
-- the latest pass and the window, and its unique (tenant, action, passId) index each
-- end lookup (R1-m7).

-- The outcome group the card shows for a status.
create or replace function discovery_reader_pass_group(p_status text)
returns text language sql immutable set search_path = public as $$
  select case p_status
    when 'complete' then 'completed'
    when 'page_limit' then 'continued' when 'reset' then 'continued'
    when 'paused' then 'stopped' when 'disabled' then 'stopped' when 'halted' then 'stopped' when 'skipped' then 'stopped'
    when 'refused' then 'refused'
    when 'failed' then 'failed'
  end
$$;
revoke all on function discovery_reader_pass_group(text) from public, anon, authenticated;

-- The consistent end of a consistent start: same tenant and passId (the unique index), and
-- every other immutable field equal as jsonb (a null jobId equals a null jobId) (R2-M5).
create or replace function discovery_reader_pass_end(p_tenant uuid, p_started jsonb)
returns jsonb language sql stable set search_path = public as $$
  select f.detail
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
revoke all on function discovery_reader_pass_end(uuid, jsonb) from public, anon, authenticated;

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
           'checkpointState', case
             when c.backfill_completed_at is not null then 'incremental'
             when c.delta_checkpoint is not null then 'backfilling'
             else 'not_started'
           end,
           'backfillCompletedAt', c.backfill_completed_at,
           'checkpointUpdatedAt', c.checkpoint_updated_at,
           'checkpointAgeSeconds', case
             when c.checkpoint_updated_at is null then null
             else greatest(0, floor(extract(epoch from (now() - c.checkpoint_updated_at))))::bigint
           end,
           'lastSyncedAt', c.last_synced_at,
           'lastError', c.last_error,
           'lastErrorAt', c.last_error_at,
           -- Why the guard would refuse this source now, only while it is active
           -- and not archived: a paused source is skipped before the guard, so
           -- its last reason is history. A mailbox is judged by the database's own
           -- verdict (live, never stale); when that admits the read, the worker's
           -- provider-group refusal (not a database fact) is what remains. A site
           -- has no verdict here, so its last site refusal stands.
           'waitingFor', case
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
           end,
           'itemsLedgered', coalesce(l.ledgered, 0),
           'itemsRouted', coalesce(l.routed, 0),
           'itemsSkipped', coalesce(l.skipped, 0),
           'itemsExcluded', coalesce(l.excluded, 0),
           -- The newest reader pass (#370): its state, outcome, worker-clock times and
           -- counts. Every cast reads a row discovery_reader_pass_consistent() accepted.
           'latestPass', case when lp.started is null then null else jsonb_build_object(
             'state', case
               when lp.fin is not null then 'ended'
               when lp.started_ts > now() - interval '3600 seconds' then 'in_progress'
               else 'no_end_recorded'
             end,
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
           ) end
         ) order by c.kind, lower(c.address)), '[]'::jsonb)
  into v_sources
  from content_sources c
  left join ledger l on l.source_id = c.id
  -- The source's newest consistent start by server ts (then the worker's startedAt), and its
  -- consistent end matched on every immutable field (R2-M5).
  left join lateral (
    select s.detail as started, s.ts as started_ts, discovery_reader_pass_end(v_tenant, s.detail) as fin
    from audit_log s
    where s.tenant_id = v_tenant
      and s.action = 'discovery.reader_pass_started'
      and s.detail->>'sourceId' = c.id::text
      and discovery_reader_pass_consistent(s.action, s.detail, s.ts)
    order by s.ts desc, s.detail->>'startedAt' desc
    limit 1
  ) lp on true
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
