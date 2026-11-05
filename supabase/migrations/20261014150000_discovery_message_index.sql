-- #461 slice 5: the message index, which holds no content (owner decision 2026-10-14,
-- design entries 19, 20 and 22). Builds on 20261014120500_discovery_purge.sql
-- and 20261014140000_discovery_purge_tenant.sql.
--
-- Content (subject, body, participants, model-proposed names) is deleted when a
-- banker disconnects. The index is what remains true without it: one row per
-- message per mailbox that the worker read and processed, written when the page
-- is stored. It holds identifiers, the content digest (keyed per tenant, owner
-- 2026-10-17), category tags and the versions that processed the message, never
-- content. It serves a per-deal
-- regulator export and the worker's skip rule (a message already indexed under
-- the same digest and rules version, and already routed to a candidate or deal,
-- is not processed again).
--
-- Pilot behaviour, unconditional until the retention policy (slice 6): every
-- purge deletes a mailbox's index rows with the mailbox, through the one
-- identifier delete, so a banker's purge and the tenant purge (which detaches
-- each mailbox through it) both remove them. A row linked to a deal under legal
-- hold stays, like the mail it indexes. Exporting the index into the tenant
-- purge's report, for the bank, is a later slice.
--
-- 1. discovery_message_index, service_role reads and deletes; written by definers.
-- 2. discovery_message_index_record: the worker's per-page upsert.
-- 3. discovery_message_index_link: candidate and deal links from the evidence.
-- 4. discovery_purge_identifiers restated: also deletes the source's index rows.

-- ── 1. The index ──────────────────────────────────────────────────────────
-- One row per message per mailbox, so a banker's purge removes exactly their
-- rows and a message a colleague also holds keeps the colleague's.
-- content_source_id carries no FK: a kept index outlives its source row.
-- The raw Message-ID is never stored (owner decision 2026-10-17): message_key
-- is its sha256 (#460's messageKey(): hex of the trimmed id). A model proposal
-- joins on (tenant_id, message_key), and the bank matches its archive by
-- hashing the archive's Message-IDs the same way.
-- The key is the message, not the provider's id for it: Graph's immutable ids
-- survive a move but not a copy, so a copied message has a second provider id
-- and the same Message-ID in the same mailbox. It is one row, and
-- provider_item_ids holds every provider id the worker has read it under.
create table if not exists discovery_message_index (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  content_source_id   uuid not null,
  provider_item_ids   text[] not null
                        check (cardinality(provider_item_ids) >= 1 and array_position(provider_item_ids, null) is null),
  message_key         text not null check (message_key ~ '^[0-9a-f]{64}$'),
  sent_at             timestamptz,
  -- HMAC-SHA256 of contentHash under the tenant's key (src/lib/discovery/indexDigest.ts; owner, 2026-10-17, D93),
  -- never an unsalted hash of subject and body: without the key a holder of the index cannot confirm a guessed
  -- message. The format is checked, so no text and no unkeyed hash can rest here.
  content_digest      text not null check (content_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  candidate_id        uuid references deal_candidates (id) on delete set null,
  deal_id             uuid references deals (id) on delete set null,
  -- Categories only, never a matched term: the screen's rule kinds, and the
  -- lexicon categories a later pass may write (#501's content_tags pattern).
  tags                text[] not null default '{}'
                        check (array_position(tags, null) is null
                               and array_to_string(tags, ',') ~ '^((mnpi|promissory|lexicon-[0-9]{1,3})(,|$))*$'),
  rules_version       text not null check (btrim(rules_version) <> ''),
  model               text check (char_length(model) <= 200),
  prompt_version      text check (char_length(prompt_version) <= 100),
  processed_at        timestamptz not null default now(),
  unique (tenant_id, content_source_id, message_key)
);
create index if not exists discovery_message_index_candidate_idx
  on discovery_message_index (candidate_id) where candidate_id is not null;
create index if not exists discovery_message_index_deal_idx
  on discovery_message_index (deal_id) where deal_id is not null;
alter table discovery_message_index enable row level security;
-- The worker reads it (the skip rule); writes go through the definer below. A
-- delete is for a loopback replay reset and test cleanup.
revoke all on discovery_message_index from public, anon, authenticated, service_role;
grant select, delete on discovery_message_index to service_role;

-- ── 2. The writer ─────────────────────────────────────────────────────────
-- One call per page, from persistItems after the ledger write. Each input row
-- is one sighting (provider_item_id); sightings sharing a Message-ID collapse
-- to one row per message_key, with all their provider ids. It upserts on
-- (tenant, source, message_key), refreshes the digest, tags, versions and
-- processed_at, and adds the provider ids to those already held (distinct,
-- sorted), so a copy read later is recorded beside the original.
-- A sighting without a Message-ID is not indexed (skipped, not refused): the
-- readers drop such messages, and an unindexed one is only processed again.
-- The source must be the tenant's live mailbox: a page in flight when its
-- source was purged or archived is refused like its provenance
-- (source_archived), since an index row written after the purge would outlive
-- it. The row lock orders this write against the purge's delete of the source.
create or replace function discovery_message_index_record(p_tenant uuid, p_source uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_archived timestamptz;
  v_n        integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'discovery_message_index_record: rows must be an array' using errcode = '22023';
  end if;
  select cs.archived_at into v_archived from content_sources cs
  where cs.id = p_source and cs.tenant_id = p_tenant and cs.kind = 'mailbox'
  for key share;
  if not found or v_archived is not null then
    raise exception 'source_archived' using errcode = 'P0001';
  end if;
  with sightings as (
    select r.provider_item_id,
           encode(sha256(convert_to(btrim(r.internet_message_id), 'UTF8')), 'hex') as message_key,
           r.sent_at, r.content_digest, coalesce(r.tags, '{}') as tags, r.rules_version, r.model, r.prompt_version
    from jsonb_to_recordset(p_rows) as r(provider_item_id text, internet_message_id text, sent_at timestamptz,
                                         content_digest text, tags text[], rules_version text, model text,
                                         prompt_version text)
    where nullif(btrim(r.internet_message_id), '') is not null),
  messages as (
    select distinct on (s.message_key)
           s.message_key, s.sent_at, s.content_digest, s.tags, s.rules_version, s.model,
           s.prompt_version,
           (select array_agg(distinct o.provider_item_id order by o.provider_item_id)
            from sightings o where o.message_key = s.message_key) as provider_item_ids
    from sightings s
    order by s.message_key, s.provider_item_id)
  insert into discovery_message_index as x (tenant_id, content_source_id, provider_item_ids, message_key,
                                            sent_at, content_digest, tags, rules_version, model,
                                            prompt_version)
  select p_tenant, p_source, m.provider_item_ids, m.message_key, m.sent_at,
         m.content_digest, m.tags, m.rules_version, m.model, m.prompt_version
  from messages m
  on conflict (tenant_id, content_source_id, message_key) do update set
    provider_item_ids   = (select array_agg(distinct p order by p) from unnest(x.provider_item_ids || excluded.provider_item_ids) p),
    sent_at             = excluded.sent_at,
    content_digest      = excluded.content_digest,
    tags                = excluded.tags,
    rules_version       = excluded.rules_version,
    model               = excluded.model,
    prompt_version      = excluded.prompt_version,
    processed_at        = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function discovery_message_index_record(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_message_index_record(uuid, uuid, jsonb) to service_role;

-- ── 3. The links ──────────────────────────────────────────────────────────
-- Sets each indexed message's candidate and deal from the current evidence:
-- the stored item with the same Message-ID that the mailbox holds
-- (source_item_sources), its non-rejected links, and the candidate's promoted
-- deal. The join is on the message key, not a provider id, since a copied
-- message has two provider ids and source_item_sources keeps one. A promoted candidate wins, then a live (unmerged) one, then a
-- confirmed link, then the higher confidence. A row with no current link keeps
-- what it had, so the deal link survives the candidate (candidate_id goes null
-- with it). Called by the worker after persistCandidates, and by
-- discovery_purge_identifiers for its mailbox before it deletes the mailbox's
-- rows. p_source narrows it to one mailbox.
create or replace function discovery_message_index_link(p_tenant uuid, p_source uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  with cur as (
    select distinct on (x.id) x.id, l.candidate_id, c.promoted_deal_id
    from deal_candidates c
    join evidence_links l on l.candidate_id = c.id and l.state <> 'rejected'
    join source_items si on si.id = l.source_item_id and si.tenant_id = c.tenant_id
    join source_item_sources s on s.source_item_id = si.id
    join discovery_message_index x
      on x.tenant_id = c.tenant_id and x.content_source_id = s.content_source_id
     and x.message_key = encode(sha256(convert_to(btrim(si.internet_message_id), 'UTF8')), 'hex')
    where c.tenant_id = p_tenant and (p_source is null or s.content_source_id = p_source)
    order by x.id, (c.promoted_deal_id is not null) desc, (c.merged_into_id is null) desc,
             (l.state = 'confirmed') desc, l.confidence desc nulls last, c.id),
  upd as (
    update discovery_message_index x set candidate_id = cur.candidate_id, deal_id = cur.promoted_deal_id
    from cur
    where x.id = cur.id
      and (x.candidate_id is distinct from cur.candidate_id or x.deal_id is distinct from cur.promoted_deal_id)
    returning 1)
  select count(*) into v_n from upd;
  return v_n;
end;
$$;
revoke all on function discovery_message_index_link(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_message_index_link(uuid, uuid) to service_role;

-- ── 4. A mailbox's identifiers, the index included ────────────────────────
-- As in 20261014120500_discovery_purge.sql, plus the source's index rows (design
-- entry 22), counted as indexRows. A row linked to a deal under legal hold
-- stays, its link refreshed first. Pilot: unconditional; the retention policy
-- (slice 6) reads p_policy.
create or replace function discovery_purge_identifiers(p_tenant uuid, p_source uuid, p_policy jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prov   integer;
  v_ledger integer;
  v_taints integer;
  v_index  integer;
begin
  if not exists (select 1 from content_sources
                 where id = p_source and tenant_id = p_tenant and kind = 'mailbox') then
    raise exception 'discovery_purge_identifiers: not a mailbox source of the tenant' using errcode = '22023';
  end if;
  perform discovery_message_index_link(p_tenant, p_source);
  with gone as (
    delete from discovery_message_index x
    where x.tenant_id = p_tenant and x.content_source_id = p_source
      and (x.deal_id is null or not deal_is_under_hold(x.deal_id))
    returning 1)
  select count(*) into v_index from gone;
  select count(*) into v_prov from source_item_sources where content_source_id = p_source;
  select count(*) into v_ledger from routing_ledger where source_id = p_source;
  select count(*) into v_taints from discovery_thread_taints where source_id = p_source;
  delete from content_sources where id = p_source;
  return jsonb_build_object('provenance', v_prov, 'ledger', v_ledger, 'taints', v_taints, 'indexRows', v_index);
end;
$$;
revoke all on function discovery_purge_identifiers(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
