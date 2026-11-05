-- Deal discovery phase 6 (design R8, R9): milestone events per item, stage
-- assessments per candidate, the model-call ledger and the recompute outbox.
-- ADR-0017 decision 1: these rows are model outputs about mail, so bank
-- content in the E1 set. Until the owner answers T11 (a) they hold synthetic
-- data only: a real bank's mailbox cannot connect before decision 2's gate,
-- and a real bank's extraction also needs DISCOVERY_OUTPUT_PLACEMENT_APPROVED,
-- which ships false (src/lib/modelGateway/processorGate.ts).

create table if not exists milestone_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  source_item_id    uuid not null references source_items (id) on delete cascade,
  type              text not null check (type in (
    'client_nda_signed', 'pitch_delivered', 'engagement_letter_signed', 'kickoff_held', 'vdr_opened',
    'teaser_drafted', 'cim_drafted', 'buyer_outreach_started', 'buyer_nda_executed',
    'buyer_vdr_access_granted', 'management_presentation_held', 'process_letter_sent', 'bids_received',
    'exclusivity_lapsed', 'round_reopened', 'loi_signed', 'exclusivity_granted', 'spa_draft_circulated',
    'disclosure_schedules_exchanged', 'signed', 'announced', 'regulatory_filing', 'closed',
    'process_paused', 'process_terminated')),
  occurred_at       date not null,
  span_start        integer not null check (span_start >= 0),
  span_end          integer not null check (span_end > span_start),
  confidence        numeric(4,3) not null check (confidence between 0 and 1),
  extractor_version text not null,            -- '<promptVersion>:<model>'
  model_call_id     uuid not null,
  created_at        timestamptz not null default now(),
  unique (source_item_id, extractor_version, type, span_start)
);
create index if not exists milestone_events_item_idx on milestone_events (source_item_id);

create table if not exists model_calls (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  purpose         text not null check (purpose in ('milestone_extract')),
  model           text not null,
  prompt_version  text not null,
  prompt_hash     text not null,
  source_item_id  uuid not null references source_items (id) on delete cascade,
  content_hash    text not null,
  response_id     text,
  transport       text not null check (transport in ('gateway','recorded')),
  parsed          jsonb,                       -- types, dates, offsets, confidence; never a quote
  outcome         text not null check (outcome in ('ok','invalid','failed')),
  error_code      text,
  attempt         integer not null default 1,
  input_tokens    integer, output_tokens integer, latency_ms integer,
  created_at      timestamptz not null default now()
);   -- no request text: it is rebuilt from source_item_texts plus the prompt version (R8)
create index if not exists model_calls_settle_idx on model_calls (source_item_id, content_hash, prompt_version, model);

create table if not exists stage_assessments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  candidate_id          uuid not null references deal_candidates (id) on delete cascade,
  deal_id               uuid references deals (id),
  step_id               text,
  station               integer,
  lifecycle_suggestion  text check (lifecycle_suggestion in ('live','closed','terminated','mandate_hold')),
  reason_text           text not null,
  evidence_event_ids    uuid[] not null default '{}',
  confidence            numeric(4,3) not null,
  flags                 text[] not null default '{}' check (flags <@ array['conflict','station_removed','overridden']::text[]),
  engine_version        text not null,
  trigger               text not null check (trigger in ('extraction','correction','rerun')),
  -- clock_timestamp(), not now(): two assessments in one transaction must still order.
  as_of                 timestamptz not null default clock_timestamp()
);
create index if not exists stage_assessments_latest_idx on stage_assessments (candidate_id, as_of desc);
create index if not exists stage_assessments_deal_idx on stage_assessments (deal_id, as_of desc) where deal_id is not null;

-- Every insert copies the candidate's deal, so assessments made after promotion reach the rail (R9).
create or replace function stage_assessments_copy_deal_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select promoted_deal_id into new.deal_id from deal_candidates where id = new.candidate_id;
  return new;
end; $$;
drop trigger if exists stage_assessments_copy_deal_id on stage_assessments;
create trigger stage_assessments_copy_deal_id before insert on stage_assessments
  for each row execute function stage_assessments_copy_deal_id();

create table if not exists discovery_recompute_requests (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  candidate_id uuid not null references deal_candidates (id) on delete cascade,
  reason text not null, created_at timestamptz not null default now()
);

alter table milestone_events enable row level security;
alter table model_calls enable row level security;
alter table stage_assessments enable row level security;
alter table discovery_recompute_requests enable row level security;
revoke all on milestone_events, model_calls, stage_assessments, discovery_recompute_requests from anon, authenticated;
grant select, insert, update, delete on milestone_events, model_calls, stage_assessments, discovery_recompute_requests to service_role;
grant select on milestone_events, stage_assessments to authenticated;
drop policy if exists milestone_events_select on milestone_events;
create policy milestone_events_select on milestone_events for select to authenticated
  using (app_can_see_item(source_item_id, auth.uid()));
drop policy if exists stage_assessments_select on stage_assessments;
create policy stage_assessments_select on stage_assessments for select to authenticated
  using (app_can_see_candidate(candidate_id, auth.uid()));
-- model_calls and discovery_recompute_requests: no user policy (service role only).

-- E1: the one service-role read of stored text. Items with a firm or confirmed,
-- unrejected link on a live candidate, whose source is allowlisted (#262), and
-- with no settled call for (content_hash, prompt_version, model). 'ok' (zero
-- events included) and 'invalid' settle; 'failed' retries 3 times, 30 s apart.
create or replace function discovery_extract_batch(p_tenant_id uuid, p_prompt_version text, p_model text, p_limit integer default 50)
returns table (item_id uuid, internet_message_id text, content_hash text, subject text, sent_at timestamptz, body_text text, attempt integer)
language sql stable security definer set search_path = public as $$
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
  order by si.sent_at nulls last, si.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- R15: the one service-role read of milestone events for an assessment. Each
-- candidate's live (firm or confirmed, unrejected) links, narrowed to items that
-- still have an allowed source, so a withdrawn, seat-lost or archived mailbox's
-- events never reach reason_text or evidence_event_ids (which the candidate's
-- readers see under app_can_see_candidate alone). Rows carry ids, type, date and
-- confidence: never text and never a span.
create or replace function discovery_assessment_inputs(p_tenant_id uuid, p_candidate_ids uuid[])
returns table (candidate_id uuid, source_item_id uuid, event_id uuid, type text, occurred_at date,
               confidence numeric, extractor_version text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select el.candidate_id, me.source_item_id, me.id, me.type, me.occurred_at, me.confidence, me.extractor_version, me.created_at
  from deal_candidates dc
  join evidence_links el on el.candidate_id = dc.id
                        and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed')
  join milestone_events me on me.source_item_id = el.source_item_id and me.tenant_id = p_tenant_id
  where dc.tenant_id = p_tenant_id and dc.id = any (p_candidate_ids)
    and app_item_has_allowed_source(el.source_item_id);
$$;

-- One call, its events and its audit row commit together (the deal_move_cursor pattern).
create or replace function discovery_record_extraction(p_tenant_id uuid, p_call jsonb, p_events jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_call uuid; v_count integer := 0;
begin
  insert into model_calls (tenant_id, purpose, model, prompt_version, prompt_hash, source_item_id, content_hash,
                           response_id, transport, parsed, outcome, error_code, attempt, input_tokens, output_tokens, latency_ms)
  select p_tenant_id, c.purpose, c.model, c.prompt_version, c.prompt_hash, c.source_item_id, c.content_hash,
         c.response_id, c.transport, p_events, c.outcome, c.error_code, coalesce(c.attempt, 1),
         c.input_tokens, c.output_tokens, c.latency_ms
  from jsonb_to_record(p_call) as c(purpose text, model text, prompt_version text, prompt_hash text, source_item_id uuid,
       content_hash text, response_id text, transport text, outcome text, error_code text, attempt int,
       input_tokens int, output_tokens int, latency_ms int)
  join source_items si on si.id = c.source_item_id and si.tenant_id = p_tenant_id     -- tenant match
  returning id into v_call;
  if v_call is null then raise exception 'discovery_record_extraction: item not in tenant' using errcode = '22023'; end if;
  if (p_call->>'outcome') = 'ok' then
    insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, model_call_id)
    select p_tenant_id, (p_call->>'source_item_id')::uuid, e.type, e.occurred_at, e.span_start, e.span_end, e.confidence,
           (p_call->>'prompt_version') || ':' || (p_call->>'model'), v_call
    from jsonb_to_recordset(coalesce(p_events, '[]')) as e(type text, occurred_at date, span_start int, span_end int, confidence numeric)
    on conflict do nothing;
    get diagnostics v_count = row_count;
  end if;
  if (p_call->>'outcome') in ('ok','invalid') then
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (p_tenant_id, 'model', 'model-gateway', 'discovery.milestone_extracted',
            jsonb_build_object('modelCallId', v_call, 'sourceItemId', p_call->>'source_item_id', 'eventCount', v_count,
                               'outcome', p_call->>'outcome', 'transport', p_call->>'transport'));   -- ids and counts only
  end if;
  return v_call;
end; $$;

-- Insert on change only (step, lifecycle, evidence set, flags); audited as the deterministic service.
create or replace function discovery_record_assessment(p_tenant_id uuid, p_candidate_id uuid, p_assessment jsonb, p_trigger text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_last stage_assessments; v_id uuid;
begin
  perform 1 from deal_candidates where id = p_candidate_id and tenant_id = p_tenant_id;
  if not found then raise exception 'discovery_record_assessment: candidate not in tenant' using errcode = '22023'; end if;
  select * into v_last from stage_assessments where candidate_id = p_candidate_id order by as_of desc, id desc limit 1;
  if v_last.id is not null
     and v_last.step_id is not distinct from p_assessment->>'stepId'
     and v_last.lifecycle_suggestion is not distinct from p_assessment->>'lifecycle'
     and v_last.flags = array(select jsonb_array_elements_text(p_assessment->'flags'))
     and (select array_agg(x order by x) from unnest(v_last.evidence_event_ids) x)
         is not distinct from (select array_agg(x::uuid order by x::uuid) from jsonb_array_elements_text(p_assessment->'evidenceEventIds') x)
  then return false; end if;
  insert into stage_assessments (tenant_id, candidate_id, step_id, station, lifecycle_suggestion, reason_text,
                                 evidence_event_ids, confidence, flags, engine_version, trigger)
  values (p_tenant_id, p_candidate_id, p_assessment->>'stepId', (p_assessment->>'station')::int, p_assessment->>'lifecycle',
          p_assessment->>'reason', array(select jsonb_array_elements_text(p_assessment->'evidenceEventIds'))::uuid[],
          (p_assessment->>'confidence')::numeric, array(select jsonb_array_elements_text(p_assessment->'flags')),
          p_assessment->>'engineVersion', p_trigger)
  returning id into v_id;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant_id, 'service', 'discovery-worker', 'discovery.stage_assessed',
          jsonb_build_object('candidateId', p_candidate_id, 'assessmentId', v_id, 'trigger', p_trigger));
  return true;
end; $$;

revoke all on function discovery_extract_batch(uuid, text, text, integer), discovery_record_extraction(uuid, jsonb, jsonb),
  discovery_record_assessment(uuid, uuid, jsonb, text), discovery_assessment_inputs(uuid, uuid[]),
  stage_assessments_copy_deal_id() from public, anon, authenticated;
grant execute on function discovery_extract_batch(uuid, text, text, integer), discovery_record_extraction(uuid, jsonb, jsonb),
  discovery_record_assessment(uuid, uuid, jsonb, text), discovery_assessment_inputs(uuid, uuid[]) to service_role;

-- T13 (decided 2026-09-30): a live synthetic gateway call is priced from tokens and
-- recorded here; the extractor has no user actor, so actor_id may be null for it alone.
alter table ai_usage drop constraint if exists ai_usage_source_check;
alter table ai_usage add constraint ai_usage_source_check
  check (source in ('screen','agent_run','bench_chat','twin_chat','discovery_extract'));
alter table ai_usage alter column actor_id drop not null;
alter table ai_usage drop constraint if exists ai_usage_actor_check;
alter table ai_usage add constraint ai_usage_actor_check check (actor_id is not null or source = 'discovery_extract');
