-- The bound a live extraction run is held to (#261, design Q4, B1, B2, M1).
-- A budget is the printed estimate and the cohort of items it counted. While one is
-- open, discovery_extract_batch selects only from its cohort; spend since it opened
-- is read from ai_usage, plus each failed gateway call at its item's ceiling cost.
-- Unpriced or unrecorded usage is counted, so the run stops rather than undercounting.
-- A call in flight is a reservation on the cohort row (inflight_since), taken by discovery_extract_reserve before
-- the send and cleared by discovery_extract_settle after the call is on record: a write that fails or a process
-- that dies in between leaves it set.
-- Ids and numbers only. Service role only: RLS on, no policies, no signed-in grant.
create table if not exists discovery_extract_budgets (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  model          text not null,
  prompt_version text not null,
  item_count     integer not null check (item_count >= 0),
  est_cost_usd   numeric(12,6) not null check (est_cost_usd >= 0),
  stop_at_usd    numeric(12,6) not null check (stop_at_usd >= est_cost_usd),
  estimate       jsonb not null check (jsonb_typeof(estimate) = 'object'),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz
);
create unique index if not exists discovery_extract_budgets_one_open on discovery_extract_budgets (tenant_id) where closed_at is null;

create table if not exists discovery_extract_budget_items (
  budget_id      uuid not null references discovery_extract_budgets (id) on delete cascade,
  source_item_id uuid not null references source_items (id) on delete cascade,
  ceiling_usd    numeric(12,6) not null check (ceiling_usd >= 0),
  -- null: no call in flight. Set before the item is sent, cleared after the call and its ledger row are on
  -- record. A row left set (crash, SIGKILL, a failed write) is a call whose outcome is unknown.
  inflight_since timestamptz,
  primary key (budget_id, source_item_id)
);

alter table discovery_extract_budgets enable row level security;
alter table discovery_extract_budget_items enable row level security;
revoke all on discovery_extract_budgets, discovery_extract_budget_items from public, anon, authenticated;
grant select, insert, update on discovery_extract_budgets to service_role;
-- The run never updates a cohort row directly: the reservation is set and cleared only through
-- discovery_extract_reserve and discovery_extract_settle, so the stop line is checked under the budget's row
-- lock. No row is deleted but by cascade from its budget. (revoke first: the platform's default grants give
-- service_role every privilege on a new public table.)
revoke all on discovery_extract_budget_items from service_role;
grant select, insert on discovery_extract_budget_items to service_role;

-- The (tenant_id, transport, created_at) index on model_calls that discovery_extract_budget_state reads is
-- built concurrently in 20261021190100, alone in its file: model_calls is a big table.

-- The batch (20261002200000), unchanged but for one optional argument: with a budget, only its cohort.
-- While the tenant has an open budget, the batch answers only a call that names it: a null or any other
-- budget id selects nothing, so no caller reads mail outside the bound. With no open budget the
-- four-argument call behaves as before. The spend and the stop line are not checked here; every send
-- is reserved through discovery_extract_reserve.
drop function if exists discovery_extract_batch(uuid, text, text, integer);
create or replace function discovery_extract_batch(p_tenant_id uuid, p_prompt_version text, p_model text, p_limit integer default 50,
                                        p_budget_id uuid default null)
returns table (item_id uuid, internet_message_id text, content_hash text, subject text, sent_at timestamptz, body_text text, attempt integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select si.id, si.internet_message_id, si.content_hash, si.subject, si.sent_at, t.body_text, coalesce(f.failures, 0)::int + 1
  from source_items si
  join source_item_texts t on t.source_item_id = si.id
  left join lateral (
    select count(*) filter (where mc.outcome = 'failed') as failures,
           bool_or(mc.outcome in ('ok','invalid')) as settled,
           max(mc.created_at) filter (where mc.outcome = 'failed') as last_failed
    from model_calls mc
    where mc.source_item_id = si.id and mc.content_hash = si.content_hash
      and mc.prompt_version = p_prompt_version and mc.model = p_model
  ) f on true
  where si.tenant_id = p_tenant_id and si.kind = 'message'
    and exists (select 1 from evidence_links el join deal_candidates dc on dc.id = el.candidate_id
                where el.source_item_id = si.id and dc.tenant_id = p_tenant_id and dc.discovery_state <> 'rejected'
                  and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed'))
    and app_item_has_allowed_source(si.id)
    and not coalesce(f.settled, false) and coalesce(f.failures, 0) < 3
    and (f.last_failed is null or f.last_failed < now() - interval '30 seconds')
    and (p_budget_id is null or exists (select 1 from discovery_extract_budget_items bi
                                        where bi.budget_id = p_budget_id and bi.source_item_id = si.id))
    and coalesce((select b.id is not distinct from p_budget_id from discovery_extract_budgets b
                   where b.tenant_id = p_tenant_id and b.closed_at is null), true)
  order by si.sent_at nulls last, si.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- One item's worst-case cost: its input (prompt overhead plus subject and body bytes) at the caller's
-- bytes-per-token and input price, plus the output ceiling. The one place the formula lives in SQL;
-- ceilingCostFor in src/lib/discovery/extract/estimate.ts is its twin, and both are held to the cases in
-- tests/fixtures/discovery/extract/ceiling-cases.json.
create or replace function discovery_extract_ceiling_usd(
  p_item_bytes integer, p_overhead_bytes integer, p_bytes_per_token numeric,
  p_input_usd_per_token numeric, p_output_ceiling_usd numeric)
returns numeric language sql immutable as $$
  select round(ceil((p_overhead_bytes + p_item_bytes) / p_bytes_per_token) * p_input_usd_per_token + p_output_ceiling_usd, 6);
$$;

-- Opens the tenant's budget with its cohort, or returns the one already open. Returns null when the pending
-- set is not the one the caller estimated, by item count or by total bytes (subject plus body): the caller
-- sends nothing and estimates again on the next pass. The pending set is read ONCE and both the comparison
-- and the cohort come from that read. An already-open budget for another model or prompt version is not
-- returned: it raises budget_model_mismatch (P0004), so a pass never spends under a bound it did not estimate.
-- Ceilings use the caller's constants and prices through discovery_extract_ceiling_usd.
create or replace function discovery_extract_budget_open(
  p_tenant_id uuid, p_model text, p_prompt_version text, p_expected_items integer, p_expected_bytes bigint,
  p_est_cost_usd numeric, p_stop_at_usd numeric, p_estimate jsonb,
  p_overhead_bytes integer, p_bytes_per_token numeric, p_input_usd_per_token numeric, p_output_ceiling_usd numeric)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; v_model text; v_prompt text;
  v_ids uuid[]; v_sizes integer[];
begin
  if jsonb_typeof(p_estimate) is distinct from 'object' then
    raise exception 'discovery_extract_budget_open: estimate must be an object' using errcode = '22023';
  end if;
  select id, model, prompt_version into v_id, v_model, v_prompt
    from discovery_extract_budgets where tenant_id = p_tenant_id and closed_at is null;
  if v_id is not null then
    if v_model is distinct from p_model or v_prompt is distinct from p_prompt_version then
      raise exception 'budget_model_mismatch' using errcode = 'P0004';
    end if;
    return v_id;
  end if;
  select coalesce(array_agg(p.source_item_id order by p.source_item_id), '{}'),
         coalesce(array_agg(coalesce(p.subject_bytes, 0) + coalesce(p.body_bytes, 0) order by p.source_item_id), '{}')
    into v_ids, v_sizes
    from discovery_extract_pending(p_tenant_id, p_prompt_version, p_model) p;
  if cardinality(v_ids) <> p_expected_items
     or (select coalesce(sum(z), 0) from unnest(v_sizes) z) <> p_expected_bytes then
    return null;
  end if;
  insert into discovery_extract_budgets (tenant_id, model, prompt_version, item_count, est_cost_usd, stop_at_usd, estimate)
  values (p_tenant_id, p_model, p_prompt_version, cardinality(v_ids), p_est_cost_usd, p_stop_at_usd, p_estimate)
  on conflict (tenant_id) where closed_at is null do nothing
  returning id into v_id;
  if v_id is null then
    -- Another opener won the race: its budget is the bound, if it is for this model and prompt.
    select id, model, prompt_version into v_id, v_model, v_prompt
      from discovery_extract_budgets where tenant_id = p_tenant_id and closed_at is null;
    if v_model is distinct from p_model or v_prompt is distinct from p_prompt_version then
      raise exception 'budget_model_mismatch' using errcode = 'P0004';
    end if;
    return v_id;
  end if;
  insert into discovery_extract_budget_items (budget_id, source_item_id, ceiling_usd)
  select v_id, u.item_id,
         discovery_extract_ceiling_usd(u.item_bytes, p_overhead_bytes, p_bytes_per_token, p_input_usd_per_token, p_output_ceiling_usd)
  from unnest(v_ids, v_sizes) as u(item_id, item_bytes);
  return v_id;
end $$;

-- The open budget's state, from what the run wrote since it opened. No row when none is open.
-- The run reserves the item (inflight_since) BEFORE the send and writes the ai_usage row BEFORE the
-- model_calls row (ledger first), then clears the reservation LAST. So a crash anywhere in between leaves
-- the reservation set, or a ledger row without a call, never a billed call nobody saw.
--   spent_usd: priced ai_usage + each failed gateway call that left the process (not 'no_key'), at its
--              item's ceiling cost + each item still reserved, at its ceiling cost
--   unpriced:  a count of cost the ledger cannot vouch for, so the next pass stops instead of undercounting.
--              Only "greater than zero" matters; one fault can be counted by more than one term.
--     (1) null-cost ai_usage rows: a reply with no usage, no response id or no price, or a failed call
--         whose model_calls row could not be saved
--     (2) ok or invalid gateway calls with no ai_usage row whose external_id is the call's response_id.
--         model_calls.response_id is null when the reply carried no id, and a null matches no row, so such
--         a call counts here
--     (3) priced ai_usage rows that match no gateway model_calls.response_id since opening: the ledger saw
--         the call and model_calls did not (the call row failed to save after the ledger write)
--     (4) cohort rows with inflight_since set: a call was reserved and never settled (a crash, a SIGKILL or
--         a failed write mid-call). Its outcome is unknown, so it counts at its ceiling and fails closed:
--         the next pass sends nothing until the owner reads it and renews the budget. A reserved row whose
--         call is also on the ledger counts twice (a conservative overcount, never an undercount).
-- model and prompt_version are the open budget's own, so the run can refuse to spend under another pair.
drop function if exists discovery_extract_budget_state(uuid);
create or replace function discovery_extract_budget_state(p_tenant_id uuid)
returns table (budget_id uuid, item_count integer, stop_at_usd numeric, spent_usd numeric, unpriced integer, model text, prompt_version text)
language sql stable security definer set search_path = public, pg_temp as $$
  with b as (select * from discovery_extract_budgets where tenant_id = p_tenant_id and closed_at is null),
  -- Extraction's own rows only: the proposal step (20261014120000) also writes source 'discovery_extract', under
  -- task 'deal_proposal' and with no model_calls row, so counting it would read as unpriced term (3).
  ledger as (select u.external_id, u.cost_usd from ai_usage u, b
              where u.tenant_id = b.tenant_id and u.source = 'discovery_extract' and u.task = 'milestone_extract'
                and u.created_at >= b.opened_at),
  calls as (select mc.source_item_id, mc.outcome, mc.error_code, mc.response_id from model_calls mc, b
             where mc.tenant_id = b.tenant_id and mc.transport = 'gateway' and mc.created_at >= b.opened_at),
  inflight as (select bi.ceiling_usd from discovery_extract_budget_items bi, b
                where bi.budget_id = b.id and bi.inflight_since is not null)
  select b.id, b.item_count, b.stop_at_usd,
         (coalesce((select sum(l.cost_usd) from ledger l), 0)
           + coalesce((select sum(bi.ceiling_usd) from calls c
                        join discovery_extract_budget_items bi on bi.budget_id = b.id and bi.source_item_id = c.source_item_id
                       where c.outcome = 'failed' and coalesce(c.error_code, '') <> 'no_key'), 0)
           + coalesce((select sum(f.ceiling_usd) from inflight f), 0))::numeric(12,6),
         ((select count(*) from ledger l where l.cost_usd is null)
           + (select count(*) from calls c
               where c.outcome in ('ok', 'invalid')
                 and not exists (select 1 from ledger l where l.external_id = c.response_id))
           + (select count(*) from ledger l
               where l.cost_usd is not null
                 and not exists (select 1 from calls c where c.response_id = l.external_id))
           + (select count(*) from inflight))::integer,
         b.model, b.prompt_version
  from b;
$$;

-- The one way a call is reserved (B2 across processes). The open budget's row is locked first, so reserves
-- for one budget run one at a time, and the checks and the write see every reservation and ledger row
-- committed before it. Returns a code, the first that applies:
--   closed         the budget is not open (closed, or no such id)
--   not_in_cohort  the item is not in the budget's cohort (the batch never selects one; a caller error)
--   busy           a call is in flight on the cohort, this item's included (another process, or a call never
--                  settled), or this item was answered (ok or invalid) since the opening by another process, or
--                  the batch would not select it now: a failure inside the 30-second back-off, or three
--                  failures (the batch's own predicate: this content hash, the budget's model and prompt version)
--   unpriced       the state counts a cost the ledger cannot see
--   over_estimate  spent so far plus this item's ceiling crosses the stop line
--   ok             the item is reserved: inflight_since is set, and the caller may send it
-- Anything but ok writes nothing, and the caller sends nothing.
create or replace function discovery_extract_reserve(p_budget_id uuid, p_item_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid; v_opened timestamptz; v_model text; v_prompt text; v_ceiling numeric;
  v_spent numeric; v_stop numeric; v_unpriced integer;
begin
  select tenant_id, opened_at, model, prompt_version into v_tenant, v_opened, v_model, v_prompt
    from discovery_extract_budgets where id = p_budget_id and closed_at is null for update;
  if v_tenant is null then return 'closed'; end if;
  select ceiling_usd into v_ceiling
    from discovery_extract_budget_items where budget_id = p_budget_id and source_item_id = p_item_id;
  if v_ceiling is null then return 'not_in_cohort'; end if;
  if exists (select 1 from discovery_extract_budget_items where budget_id = p_budget_id and inflight_since is not null)
     or exists (select 1 from model_calls mc
                 where mc.tenant_id = v_tenant and mc.source_item_id = p_item_id and mc.transport = 'gateway'
                   and mc.outcome in ('ok', 'invalid') and mc.created_at >= v_opened)
     or exists (select 1 from source_items si
                 cross join lateral (
                   select count(*) as failures, max(mc.created_at) as last_failed from model_calls mc
                    where mc.source_item_id = si.id and mc.content_hash = si.content_hash
                      and mc.prompt_version = v_prompt and mc.model = v_model and mc.outcome = 'failed') f
                 where si.id = p_item_id
                   and (f.failures >= 3 or f.last_failed >= now() - interval '30 seconds')) then
    return 'busy';
  end if;
  select s.spent_usd, s.stop_at_usd, s.unpriced into v_spent, v_stop, v_unpriced
    from discovery_extract_budget_state(v_tenant) s;
  if v_unpriced > 0 then return 'unpriced'; end if;
  if v_spent + v_ceiling > v_stop then return 'over_estimate'; end if;
  update discovery_extract_budget_items set inflight_since = now()
   where budget_id = p_budget_id and source_item_id = p_item_id and inflight_since is null;
  if not found then return 'busy'; end if;
  return 'ok';
end $$;

-- Clears a reservation once the call and its spend are on record. Raises no_data_found (P0002) when the
-- cohort row does not exist, so a settle that lands nowhere is never mistaken for one that landed. A closed
-- budget's row is still cleared: the owner may close a budget while a call is in flight.
create or replace function discovery_extract_settle(p_budget_id uuid, p_item_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update discovery_extract_budget_items set inflight_since = null
   where budget_id = p_budget_id and source_item_id = p_item_id;
  if not found then raise exception 'no_row' using errcode = 'P0002'; end if;
end $$;

revoke all on function discovery_extract_batch(uuid, text, text, integer, uuid),
  discovery_extract_ceiling_usd(integer, integer, numeric, numeric, numeric),
  discovery_extract_budget_open(uuid, text, text, integer, bigint, numeric, numeric, jsonb, integer, numeric, numeric, numeric),
  discovery_extract_budget_state(uuid),
  discovery_extract_reserve(uuid, uuid),
  discovery_extract_settle(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_extract_batch(uuid, text, text, integer, uuid),
  discovery_extract_ceiling_usd(integer, integer, numeric, numeric, numeric),
  discovery_extract_budget_open(uuid, text, text, integer, bigint, numeric, numeric, jsonb, integer, numeric, numeric, numeric),
  discovery_extract_budget_state(uuid),
  discovery_extract_reserve(uuid, uuid),
  discovery_extract_settle(uuid, uuid) to service_role;

-- The tenant purge also deletes the extraction budgets. As in 20261014160000_tenant_retention_policy.sql
-- (its newest definition), plus (marked #261): the tenant's discovery_extract_budgets rows are deleted after
-- the mail-address caches, their discovery_extract_budget_items with them (on delete cascade), and counted as
-- `budgets` in what was deleted. No role holds EXECUTE, the service role included.
create or replace function discovery_purge_tenant(p_tenant uuid, p_actor_identity text default 'purge-tenant')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy      tenant_retention_policies;
  v_site_before jsonb;
  v_sources     uuid[];
  v_prov        integer;
  v_ledger      integer;
  v_taints      integer;
  v_index       integer;
  v_export      jsonb;
  v_orphans     uuid[];
  v_counts      jsonb;
  v_source      uuid;
  v_ids         jsonb;
  v_guard       integer;
  v_drift       integer;
  v_absence     integer;
  v_budgets     integer;
  v_held        uuid[];
  v_held_items  uuid[];
  v_bare_held   uuid[];
  v_residue     jsonb;
  v_residue_n   jsonb;
  v_kept_n      jsonb;
  v_deleted     jsonb;
  v_audit       uuid;
begin
  if p_tenant is null then
    raise exception 'discovery_purge_tenant: tenant is required' using errcode = '22023';
  end if;
  if p_actor_identity is null or btrim(p_actor_identity) = '' then
    raise exception 'discovery_purge_tenant: actor identity is required' using errcode = '22023';
  end if;

  -- Lock order as every other writer: the tenant's discovery lock, then rows.
  -- The registration rows are locked before their status is read, so an
  -- activation cannot land between the check and the purge: it waits for this
  -- transaction, or committed first and is seen here (a fresh snapshot per
  -- statement under READ COMMITTED).
  perform discovery_lock_tenant(p_tenant);
  perform 1 from graph_reader_registrations r where r.tenant_id = p_tenant for update;
  perform 1 from google_reader_registrations g where g.tenant_id = p_tenant for update;
  if exists (select 1 from graph_reader_registrations r where r.tenant_id = p_tenant and r.status = 'active')
     or exists (select 1 from google_reader_registrations g where g.tenant_id = p_tenant and g.status = 'active') then
    raise exception 'discovery_purge_tenant: a reader registration of the tenant is active' using errcode = '55000';
  end if;
  v_policy := tenant_retention_policy(p_tenant);  -- #461 slice 7
  v_site_before := discovery_tenant_site_counts(p_tenant);

  -- The mailboxes, locked before the export: the index writer takes FOR KEY SHARE
  -- on its source, so a page in flight commits before this lock is granted, and
  -- the export (a later statement, a fresh snapshot) sees it. What is exported
  -- is then exactly what is deleted.
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[]) into v_sources
  from content_sources s where s.tenant_id = p_tenant and s.kind = 'mailbox';
  perform 1 from content_sources s where s.id = any (v_sources) for update;

  -- The index for the bank, its links current, before any delete.
  perform discovery_message_index_link(p_tenant);
  select coalesce(jsonb_agg(jsonb_build_object(
           'messageKey', x.message_key,
           'providerItemIds', to_jsonb(x.provider_item_ids),
           'sourceId', x.content_source_id, 'sentAt', x.sent_at, 'dealId', x.deal_id, 'tags', to_jsonb(x.tags),
           'rulesVersion', x.rules_version, 'model', x.model, 'promptVersion', x.prompt_version,
           'processedAt', x.processed_at)
         order by x.content_source_id, x.message_key), '[]'::jsonb)
    into v_export
  from discovery_message_index x
  where x.tenant_id = p_tenant and (x.deal_id is null or not deal_is_under_hold(x.deal_id));

  -- Detach every mailbox, archived ones included, through the one identifier
  -- delete a per-banker purge uses: provenance, ledger and taints cascade, and
  -- the index rows when the policy deletes the index at tenant end.
  v_prov := 0; v_ledger := 0; v_taints := 0; v_index := 0;
  foreach v_source in array v_sources loop
    v_ids := discovery_purge_identifiers(p_tenant, v_source, jsonb_build_object(
               'index_on_disconnect', case v_policy.index_at_tenant_end when 'keep' then 'keep' else 'delete' end));
    v_prov := v_prov + (v_ids->>'provenance')::integer;
    v_ledger := v_ledger + (v_ids->>'ledger')::integer;
    v_taints := v_taints + (v_ids->>'taints')::integer;
    v_index := v_index + (v_ids->>'indexRows')::integer;
  end loop;
  -- Index rows whose source an earlier purge deleted.
  if v_policy.index_at_tenant_end = 'export_then_delete' then
    with gone as (
      delete from discovery_message_index x
      where x.tenant_id = p_tenant and (x.deal_id is null or not deal_is_under_hold(x.deal_id))
      returning 1)
    select v_index + count(*) into v_index from gone;
  end if;
  update discovery_message_index
     set orphaned_by = case v_policy.index_at_tenant_end when 'keep' then 'tenant_end_keep' else 'tenant_end_delete' end
   where tenant_id = p_tenant;

  -- Collect: every message of the tenant no mailbox holds is an orphan now,
  -- whatever its age.
  select coalesce(array_agg(i.id), '{}'::uuid[]) into v_orphans
  from source_items i
  where i.tenant_id = p_tenant and i.kind = 'message'
    and not exists (select 1 from source_item_sources s where s.source_item_id = i.id);
  v_counts := discovery_collect_orphans(p_tenant, interval '0', v_orphans);

  -- The mail-address caches. A guard row keyed by a site id (no '@') is site state and stays.
  with gone as (delete from mailbox_guard_state where tenant_id = p_tenant and position('@' in address) > 0 returning 1)
  select count(*) into v_guard from gone;
  with gone as (delete from mailbox_allowlist_drift where tenant_id = p_tenant returning 1)
  select count(*) into v_drift from gone;
  with gone as (delete from mailbox_group_absence where tenant_id = p_tenant returning 1)
  select count(*) into v_absence from gone;
  -- #261: the extraction budgets (ids and numbers), with their cohort rows by cascade. No foreign key ties
  -- a budget to the tenant's mail, so nothing above removes it.
  with gone as (delete from discovery_extract_budgets where tenant_id = p_tenant returning 1)
  select count(*) into v_budgets from gone;

  -- What legal hold keeps, per table: the messages evidencing a held candidate
  -- (with what hangs off them), and a held candidate the collector could not
  -- delete for want of evidence (with its own rows).
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_held
  from deal_candidates c
  where c.tenant_id = p_tenant and c.promoted_deal_id is not null and deal_is_under_hold(c.promoted_deal_id);
  select coalesce(array_agg(distinct i.id), '{}'::uuid[]) into v_held_items
  from source_items i join evidence_links l on l.source_item_id = i.id
  where i.tenant_id = p_tenant and i.kind = 'message' and l.candidate_id = any (v_held);
  select coalesce(array_agg(c), '{}'::uuid[]) into v_bare_held
  from unnest(v_held) c where not exists (select 1 from evidence_links l where l.candidate_id = c);
  v_residue_n := jsonb_build_object(
    'source_items', cardinality(v_held_items),
    'source_item_texts', (select count(*) from source_item_texts where source_item_id = any (v_held_items)),
    'evidence_links', (select count(*) from evidence_links where source_item_id = any (v_held_items)),
    'milestone_events', (select count(*) from milestone_events where source_item_id = any (v_held_items)),
    'model_calls', (select count(*) from model_calls where source_item_id = any (v_held_items)),
    'stage_assessments', (select count(*) from stage_assessments sa
                          where sa.candidate_id = any (v_held)
                            and exists (select 1 from unnest(sa.evidence_event_ids) e
                                        where not exists (select 1 from milestone_events m where m.id = e))),
    'deal_candidates', cardinality(v_bare_held),
    'candidate_visibility', (select count(*) from candidate_visibility where candidate_id = any (v_bare_held)),
    'discovery_recompute_requests', (select count(*) from discovery_recompute_requests where candidate_id = any (v_bare_held)),
    'corrections', (select count(*) from corrections where candidate_id = any (v_bare_held)),
    'discovery_message_index', (select count(*) from discovery_message_index
                                where tenant_id = p_tenant and deal_id is not null and deal_is_under_hold(deal_id)));
  v_kept_n := jsonb_build_object(
    'discovery_message_index', (select count(*) from discovery_message_index
                                where tenant_id = p_tenant and (deal_id is null or not deal_is_under_hold(deal_id))));
  select coalesce(jsonb_agg(jsonb_build_object(
           'candidateId', c.id, 'dealId', c.promoted_deal_id,
           'messages', (select count(distinct l.source_item_id) from evidence_links l
                        where l.candidate_id = c.id and l.source_item_id = any (v_held_items))) order by c.id), '[]'::jsonb)
    into v_residue
  from deal_candidates c where c.id = any (v_held);

  v_deleted := jsonb_build_object('sources', cardinality(v_sources), 'provenance', v_prov, 'ledger', v_ledger,
                                  'taints', v_taints, 'indexRows', v_index)
            || (v_counts - 'runId')
            || jsonb_build_object('guardRows', v_guard, 'driftRows', v_drift, 'absenceRows', v_absence,
                                 'budgets', v_budgets);

  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant, 'service', p_actor_identity, 'discovery.tenant_purged',
          jsonb_build_object('runId', v_counts->'runId') || v_deleted)
  returning id into v_audit;

  return jsonb_build_object(
    'runId', v_counts->'runId',
    'auditId', v_audit,
    'policy', jsonb_build_object('lifecycle', v_policy.lifecycle,
                                 'contentOnDisconnect', v_policy.content_on_disconnect,
                                 'indexOnDisconnect', v_policy.index_on_disconnect,
                                 'indexAtTenantEnd', v_policy.index_at_tenant_end),
    'deleted', v_deleted,
    'site', jsonb_build_object('before', v_site_before, 'after', discovery_tenant_site_counts(p_tenant)),
    'heldResidue', v_residue,
    'heldResidueCounts', v_residue_n,
    'policyKeptCounts', v_kept_n,
    'messageIndex', v_export);
end;
$$;
revoke all on function discovery_purge_tenant(uuid, text) from public, anon, authenticated, service_role;
