-- supabase/migrations/20260925150000_discovery_health.sql
-- Deal discovery, phase 4: what the live Graph reader needs to resume and to
-- report, and the firm admin's health view (design Q16, Q19).
--
-- 1. content_sources gains its sync state. delta_checkpoint (phase 3) is the
--    resume point the worker writes after every page; these columns say how
--    far the source got and whether the last sync failed:
--      backfill_completed_at  set once the first full read finishes; after it
--                             the worker reads changes only
--      checkpoint_updated_at  when the resume point last moved
--      last_synced_at         when the last sync (backfill or delta) finished
--      last_error, last_error_at  the last failure, one content-free line
--                             (a Graph status and code, never a response body)
-- 2. routing_ledger records documents the worker saw but did not read into
--    text: decision 'skipped' with a skip_reason. Image-only files are out of
--    scope for the demo (no OCR) and land here as image_only. A message
--    whose Internet message id the tenant already holds for different
--    content lands here too, as id_collision: the id is the sender's to
--    write, so the first message keeps it and the newcomer is neither stored
--    nor made an owner of the stored text. The row keeps how far the two
--    differ (cosine similarity and length ratio of subject and text, numbers
--    only), so the eval can see whether collisions are near-duplicates.
--    An unrouted message also keeps its conversation_id and
--    internet_message_id: identifiers only, never text. Routing is forward
--    only, so a reply read before the message that names the codename stays
--    unrouted; these let the eval count such items apart from true misses
--    (phase 5) and let a later phase re-fetch them by provider_item_id, the
--    Graph immutable id (phase 7).
-- 3. source_items gains drive_item_key, the identity of a SharePoint document
--    (`<driveId>:<itemId>`), so a document is upserted like a message is on
--    internet_message_id.
-- 4. discovery_ingestion_health(): counts and sync state for the caller's own
--    tenant, for a firm admin or the control room (cco), and nobody else. It
--    never returns text, subjects, participants, parties or codenames: the
--    admin who runs the connector cannot read what it collects (Q19). Every
--    other role gets 42501, which the route answers as 404.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Sync state
-- ─────────────────────────────────────────────────────────────────────────────

alter table content_sources add column if not exists backfill_completed_at timestamptz;
alter table content_sources add column if not exists checkpoint_updated_at timestamptz;
alter table content_sources add column if not exists last_synced_at timestamptz;
alter table content_sources add column if not exists last_error text;
alter table content_sources add column if not exists last_error_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Skipped documents in the ledger
-- ─────────────────────────────────────────────────────────────────────────────

alter table routing_ledger add column if not exists skip_reason text;

alter table routing_ledger drop constraint if exists routing_ledger_decision_check;
alter table routing_ledger add constraint routing_ledger_decision_check
  check (decision in ('routed', 'unrouted', 'skipped'));

alter table routing_ledger drop constraint if exists routing_ledger_skip_reason_check;
alter table routing_ledger add constraint routing_ledger_skip_reason_check
  check (skip_reason in ('image_only', 'unsupported_type', 'too_large', 'extraction_failed', 'extraction_timeout',
    'id_collision'));

-- A skip reason exactly when the item was skipped.
alter table routing_ledger drop constraint if exists routing_ledger_skip_shape_check;
alter table routing_ledger add constraint routing_ledger_skip_shape_check
  check ((decision = 'skipped') = (skip_reason is not null));

create index if not exists routing_ledger_source_decision_idx on routing_ledger (source_id, decision);

-- How far an id collision is from the stored item, on the collision's row only.
alter table routing_ledger add column if not exists collision_similarity real;
alter table routing_ledger add column if not exists collision_length_ratio real;

alter table routing_ledger drop constraint if exists routing_ledger_collision_shape_check;
alter table routing_ledger add constraint routing_ledger_collision_shape_check
  check (
    (skip_reason is not distinct from 'id_collision')
      = (collision_similarity is not null and collision_length_ratio is not null)
    and (collision_similarity is null) = (collision_length_ratio is null)
    and coalesce(collision_similarity between 0 and 1, true)
    and coalesce(collision_length_ratio between 0 and 1, true)
  );

-- Thread identifiers of an unrouted message. Metadata only; a routed item's
-- are on source_items, and a document has none.
alter table routing_ledger add column if not exists conversation_id text;
alter table routing_ledger add column if not exists internet_message_id text;

alter table routing_ledger drop constraint if exists routing_ledger_thread_ids_unrouted_check;
alter table routing_ledger add constraint routing_ledger_thread_ids_unrouted_check
  check (decision = 'unrouted' or (conversation_id is null and internet_message_id is null));

create index if not exists routing_ledger_unrouted_conversation_idx
  on routing_ledger (conversation_id) where decision = 'unrouted' and conversation_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Document identity
-- ─────────────────────────────────────────────────────────────────────────────

alter table source_items add column if not exists drive_item_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'source_items_tenant_drive_item_key'
  ) then
    -- NULLs stay distinct, so messages (no drive_item_key) never collide here.
    alter table source_items
      add constraint source_items_tenant_drive_item_key unique (tenant_id, drive_item_key);
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The health view
-- ─────────────────────────────────────────────────────────────────────────────

-- { registration: { status, consentedAt } | null,
--   sources: [{ id, kind, address, status, ownerAssigned, checkpointState,
--               backfillCompletedAt, checkpointUpdatedAt, lastSyncedAt,
--               lastError, lastErrorAt, itemsLedgered, itemsRouted,
--               itemsSkipped }],
--   totals: { sources, itemsLedgered, itemsRouted, itemsSkipped, itemsStored,
--             candidatesProposed } }
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
  v_sources jsonb;
begin
  select tenant_id, firm_role into v_tenant, v_role from users where id = v_uid;
  if v_uid is null or v_tenant is null or v_role is null or v_role not in ('admin', 'cco') then
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
           'address', c.address,
           'status', c.status,
           'ownerAssigned', c.owner_user_id is not null,
           'checkpointState', case
             when c.backfill_completed_at is not null then 'incremental'
             when c.delta_checkpoint is not null then 'backfilling'
             else 'not_started'
           end,
           'backfillCompletedAt', c.backfill_completed_at,
           'checkpointUpdatedAt', c.checkpoint_updated_at,
           'lastSyncedAt', c.last_synced_at,
           'lastError', c.last_error,
           'lastErrorAt', c.last_error_at,
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
    'sources', v_sources,
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

revoke all on function discovery_ingestion_health() from public, anon;
grant execute on function discovery_ingestion_health() to authenticated, service_role;
