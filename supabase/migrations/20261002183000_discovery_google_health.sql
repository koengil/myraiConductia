-- supabase/migrations/20261002183000_discovery_google_health.sql
-- Gmail reader (#259), phase 5: what an admin needs to see that Gmail sync
-- works, and why a mailbox is waiting. Counts, states and timestamps only: the
-- admin who runs the connector cannot read what it collects (Q19).
--
-- 1. google_reader_registrations records the last delegation outcome the
--    reader saw when it minted a token (plan D11). Written by the reader, on
--    change or at most hourly; there is no scheduled job (F4).
--      ok       Google's token endpoint issued a mailbox-scoped token
--      missing  unauthorized_client: the DWD client is not authorised for the
--               scope in the user's domain (the super admin has not granted it,
--               or the grant has not propagated yet)
--      error    the mint failed for another reason (signJwt refused, transport)
-- 2. discovery_ingestion_health() is re-created from #262's final body
--    (20261001160000_mailbox_allowlist_drift.sql) VERBATIM, gate included: the
--    caller is an active, internal admin or CCO, seated in a firm
--    firm_company_ids(tenant) names (which unions the Graph and the Google
--    registration, 20261002180000), else 42501; a tenant whose registrations
--    name no firm gets #262's no-registration shape. Only these keys are added,
--    so every existing key and the current UI and route keep working:
--      registration        the Graph object, kept for one release
--      registrations[]     one entry per provider registration
--      allowlist[]         group drift per provider, counts only (addresses
--                          stay in discovery_allowlist_health())
--      sources[]           gains provider, archived, checkpointAgeSeconds and
--                          waitingFor: why the guard would refuse the source
--                          now, for an active source only (a paused source is
--                          never asked). The database's own verdict,
--                          mailbox_guard_verdict(), is asked live, so the
--                          reason can never be stale; only when it admits the
--                          read does the worker's provider-group refusal, which
--                          is not a database fact and lives in
--                          mailbox_guard_state, show
--      viewerCanManageSources  the caller is the firm's admin, who may pause or
--                          resume a source (the CCO reads, never changes)
--      reconciliation      'not_built': a reconciliation that does not exist
--                          is never reported as clean (F4)
--    The no-registration shape carries the same keys, empty.
-- No token, checkpoint string, subject, body, participant or address of a
-- group member leaves this function.

alter table google_reader_registrations
  add column if not exists delegation_status text
    check (delegation_status in ('ok', 'missing', 'error')),
  add column if not exists delegation_checked_at timestamptz;

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
      'totals', jsonb_build_object('sources', 0, 'itemsLedgered', 0, 'itemsRouted', 0, 'itemsSkipped', 0,
                                   'itemsStored', 0, 'candidatesProposed', 0));
  end if;
  if (v_company = any (v_firms)) is not true then
    raise exception 'discovery_ingestion_health: not available to this user'
      using errcode = '42501';
  end if;

  with ledger as (
    select l.source_id,
           count(*)                                      as ledgered,
           count(*) filter (where l.decision = 'routed')  as routed,
           count(*) filter (where l.decision = 'skipped') as skipped
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
           'itemsSkipped', coalesce(l.skipped, 0)
         ) order by c.kind, lower(c.address)), '[]'::jsonb)
  into v_sources
  from content_sources c
  left join ledger l on l.source_id = c.id
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
    'viewerCanManageSources', app_is_firm_admin(v_tenant, v_uid),
    -- Reconciliation (token-mint ledger, unauthorized mints) is deferred (F4).
    'reconciliation', 'not_built',
    'totals', jsonb_build_object(
      'sources', jsonb_array_length(v_sources),
      'itemsLedgered', coalesce((select sum((s->>'itemsLedgered')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsRouted', coalesce((select sum((s->>'itemsRouted')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsSkipped', coalesce((select sum((s->>'itemsSkipped')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsStored', (select count(*) from source_items si where si.tenant_id = v_tenant),
      'candidatesProposed', (
        select count(*) from deal_candidates dc
        where dc.tenant_id = v_tenant and dc.discovery_state = 'proposed'
      )
    )
  );
end;
$$;

-- create or replace keeps the grants of 20260929180000_discovery_health_grant;
-- restating them makes this migration safe to read alone.
revoke all on function discovery_ingestion_health() from public, anon;
grant execute on function discovery_ingestion_health() to authenticated, service_role;
