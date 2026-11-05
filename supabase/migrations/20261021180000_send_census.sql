-- Off-platform send census (#425). Metadata and counts only; moves with E1 under #264.
alter table routing_ledger add column sent_at timestamptz;
alter table routing_ledger add column sent_recipient text;
-- routing_ledger is a big table: a CHECK added validated (inline on the column too) scans every row under ACCESS
-- EXCLUSIVE. Add both NOT VALID and validate them in 20261021180400. The columns above are new, so no existing row can
-- break them. The index is built concurrently in 20261021180300.
alter table routing_ledger add constraint routing_ledger_sent_recipient_check check (sent_recipient in ('deal_contact', 'non_deal')) not valid;
alter table routing_ledger add constraint routing_ledger_sent_shape_check check (sent_recipient is null or sent_at is not null) not valid;

create or replace function routing_ledger_keep_send_fact()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Runs only once a send fact exists (the trigger's when clause). The send time is kept; a recipient class is kept
  -- once known, but a row first written without one (a failed contact lookup) can still gain it.
  new.sent_at := old.sent_at;
  new.sent_recipient := coalesce(old.sent_recipient, new.sent_recipient);
  return new;
end;
$$;
create trigger routing_ledger_keep_send_fact before update on routing_ledger
  for each row when (old.sent_at is not null) execute function routing_ledger_keep_send_fact();

-- Retain the policy-skip writer's provenance and taint rules, but carry the send fact through both writes.
create or replace function discovery_ledger_record_policy_skips(p_rows jsonb, p_taints jsonb default '[]'::jsonb)
returns integer language plpgsql set search_path = public as $$
declare v_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'discovery_ledger_record_policy_skips: rows must be a json array' using errcode = '22023';
  end if;
  if p_taints is null or jsonb_typeof(p_taints) <> 'array' then
    raise exception 'discovery_ledger_record_policy_skips: taints must be a json array' using errcode = '22023';
  end if;
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
  select (t ->> 'source_id')::uuid, t ->> 'provider_thread_id', t ->> 'rule_id', (t ->> 'policy_version')::integer,
         t ->> 'provider_item_id', (t ->> 'run_id')::uuid
    from jsonb_array_elements(p_taints) t
  on conflict (source_id, provider_thread_id, rule_id) do nothing;
  insert into routing_ledger
    (source_id, provider_item_id, item_hash, decision, skip_reason, provider_thread_id, policy_version, exclusion_rule, run_id, sent_at, sent_recipient)
  select (r ->> 'source_id')::uuid, r ->> 'provider_item_id', r ->> 'item_hash', 'skipped', r ->> 'skip_reason',
         r ->> 'provider_thread_id', (r ->> 'policy_version')::integer, r ->> 'exclusion_rule', (r ->> 'run_id')::uuid,
         (r ->> 'sent_at')::timestamptz, r ->> 'sent_recipient'
    from jsonb_array_elements(p_rows) r
  on conflict (source_id, provider_item_id) do update set
    item_hash = excluded.item_hash,
    skip_reason = excluded.skip_reason,
    provider_thread_id = excluded.provider_thread_id,
    policy_version = excluded.policy_version,
    exclusion_rule = excluded.exclusion_rule,
    run_id = excluded.run_id,
    sent_at = excluded.sent_at,
    sent_recipient = excluded.sent_recipient
  where routing_ledger.skip_reason in ('policy_excluded', 'policy_thread_excluded', 'policy_unevaluable');
  get diagnostics v_count = row_count;
  -- A row the guard above leaves alone (routed, unrouted or another skip) still gets a send fact or a recipient class
  -- it lacks: only sent_at and sent_recipient are written, and the trigger keeps any send time and class already there.
  update routing_ledger l
     set sent_at = (r ->> 'sent_at')::timestamptz, sent_recipient = r ->> 'sent_recipient'
    from jsonb_array_elements(p_rows) r
   where l.source_id = (r ->> 'source_id')::uuid and l.provider_item_id = r ->> 'provider_item_id'
     and (l.sent_at is null or l.sent_recipient is null) and r ->> 'sent_at' is not null;
  return v_count;
end;
$$;
revoke all on function discovery_ledger_record_policy_skips(jsonb, jsonb) from public, anon, authenticated;
grant execute on function discovery_ledger_record_policy_skips(jsonb, jsonb) to service_role;

alter table content_sources add column send_census_from date
  check (send_census_from is null or extract(isodow from send_census_from) = 1);
update content_sources set send_census_from = date_trunc('week', now() at time zone 'utc')::date + 7
 where kind = 'mailbox';

create table send_census_weekly (
  tenant_id uuid not null,
  week date not null check (extract(isodow from week) = 1),
  source_id uuid not null references content_sources (id) on delete cascade,
  native integer check (native >= 0),
  platform integer not null default 0 check (platform >= 0),
  deal_contact integer check (deal_contact >= 0),
  deal_sensitive integer check (deal_sensitive >= 0),
  non_deal integer check (non_deal >= 0),
  computed_at timestamptz not null default now(),
  primary key (tenant_id, week, source_id)
);
alter table send_census_weekly enable row level security;
revoke all on send_census_weekly from public, anon, authenticated;
grant select, insert, update, delete on send_census_weekly to service_role;

create or replace function send_census_refresh(p_tenant uuid, p_weeks integer default 8)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_to date := date_trunc('week', now() at time zone 'utc')::date;
  v_from date;
  v_lo timestamptz;
  v_hi timestamptz;
  v_rows integer;
begin
  if p_tenant is null or p_weeks is null or p_weeks < 1 or p_weeks > 1040 then
    raise exception 'send_census_refresh: a tenant and 1..1040 weeks' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('send_census:' || p_tenant::text, 0));
  v_from := v_to - p_weeks * 7;
  v_lo := v_from::timestamp at time zone 'utc';
  v_hi := v_to::timestamp at time zone 'utc';
  delete from send_census_weekly where tenant_id = p_tenant and week >= v_from and week < v_to;
  with weeks as (
    select d::date as week from generate_series(v_from::timestamp, (v_to - 7)::timestamp, interval '7 days') d
  ), sources as (
    -- A source re-created for a mailbox whose ownerless source was archived starts at the first Monday on or after
    -- its creation; the archived source keeps the weeks before its archived_at, so no week is counted twice.
    select s.id, s.provider, s.last_synced_at, s.archived_at, s.backfill_completed_at, s.send_census_from as census_from,
           case when exists (select 1 from content_sources p
                              where p.tenant_id = s.tenant_id and p.kind = 'mailbox' and p.id <> s.id
                                and p.archived_at is not null and lower(p.archived_from_address) = lower(s.address))
                then (s.created_at at time zone 'utc')::date
                     + (8 - extract(isodow from (s.created_at at time zone 'utc')::date)::integer) % 7
           end as successor_from
      from content_sources s where s.tenant_id = p_tenant and s.kind = 'mailbox'
  ), grid as (
    select w.week, s.id as source_id from weeks w join sources s
      on s.provider = 'google' and s.backfill_completed_at is not null
     and w.week >= coalesce(s.census_from, '-infinity'::date)
     and w.week >= coalesce(s.successor_from, '-infinity'::date)
     and s.last_synced_at >= ((w.week + 7)::timestamp at time zone 'utc')
     and (s.archived_at is null or s.archived_at >= ((w.week + 7)::timestamp at time zone 'utc'))
  ), sent as (
    select l.source_id, date_trunc('week', l.sent_at at time zone 'utc')::date as week, count(*)::integer as n
      from routing_ledger l join sources s on s.id = l.source_id
     where l.sent_at >= v_lo and l.sent_at < v_hi group by 1, 2
  )
  insert into send_census_weekly (tenant_id, week, source_id, native)
  select p_tenant, g.week, g.source_id, coalesce(x.n, 0)
    from grid g left join sent x on x.source_id = g.source_id and x.week = g.week;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('rows', v_rows, 'unattributed', 0);
end;
$$;
revoke all on function send_census_refresh(uuid, integer) from public, anon, authenticated;
grant execute on function send_census_refresh(uuid, integer) to service_role;
