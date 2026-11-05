-- #461 timing probe (design entry 2). NOT run in CI: a local-stack measurement.
--
-- Withdrawal deletes synchronously inside mailbox_consent_withdraw(), which a
-- banker calls as `authenticated`, and Supabase gives that role an 8-second
-- statement timeout. This seeds one tenant at pilot scale and times the real
-- RPC under the banker's own claims:
--   - Alex's source: 50,000 routing_ledger rows, 2,000 message items with texts,
--     provenance, evidence, milestones and model calls, a few thread taints;
--   - Storm's source holds the first 1,000 of those items too (shared);
--   - one message index row per ledger row, routed or not (51,000);
--   - 20 candidates of 100 items each: 10 shared (survive), 10 Alex-only (deleted);
--     one stage assessment each.
-- Result: measured <= 2 s keeps the synchronous trigger; > 2 s takes the
-- fallback in the #461 structure outline (detach only, purge on the tick).
--
-- Run against the throwaway local stack only:
--   psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_purge_timing.sql
-- Everything rolls back.

begin;
create or replace function pg_temp.authorize_fixture() returns trigger language plpgsql as $fx$
begin
  perform public.authorize_provisioned_profile(new.id, new.raw_user_meta_data);
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (new.id, new.id, now(), now(), 'aal1') on conflict (id) do nothing;
  return new;
end
$fx$;
drop trigger if exists zz_authorize_fixture on auth.users;
create trigger zz_authorize_fixture after insert on auth.users
  for each row execute function pg_temp.authorize_fixture();

create temp table fx (k text primary key, v uuid);
grant select on fx to authenticated;

do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_bank   uuid := gen_random_uuid();
  v_alex   uuid := gen_random_uuid();
  v_storm  uuid := gen_random_uuid();
  v_deal   uuid;
  v_src_a  uuid;
  v_src_s  uuid;
  v_run    uuid := gen_random_uuid();
  v_t0     timestamptz := clock_timestamp();
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alex,  'purge-timing-alex@example.test',  jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_storm, 'purge-timing-storm@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false where id in (v_alex, v_storm);
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status)
    values (v_tenant, 'fixture', 'fixture', 'active');
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'Timing Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id = v_alex;
  update users set company_id = v_bank, company_role = 'member' where id = v_storm;
  update graph_reader_registrations set mailbox_domains = '{bank.example}', firm_company_id = v_bank
   where tenant_id = v_tenant;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (v_tenant, 'alex@bank.example',  v_alex, v_bank, 'director', 'accepted', 'sent', now(), v_alex),
    (v_tenant, 'storm@bank.example', v_alex, v_bank, 'member', 'accepted', 'sent', now(), v_storm);
  insert into deals (tenant_id, code, codename, bank_id)
    values (v_tenant, 'pt-' || v_tenant::text, 'Timing fixture', v_bank) returning id into v_deal;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  select v_deal, u, (select id from roles where slug = 'deal_team'), 'deal_team' from unnest(array[v_alex, v_storm]) u;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_alex, 'session_id', v_alex, 'role', 'authenticated')::text, true);
  perform mailbox_consent_grant();
  perform set_config('request.jwt.claims', json_build_object('sub', v_storm, 'session_id', v_storm, 'role', 'authenticated')::text, true);
  perform mailbox_consent_grant();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select id into v_src_a from content_sources where tenant_id = v_tenant and address = 'alex@bank.example';
  select id into v_src_s from content_sources where tenant_id = v_tenant and address = 'storm@bank.example';
  if v_src_a is null or v_src_s is null then
    raise exception 'FAIL: an opt-in did not create its mailbox source';
  end if;

  -- 2,000 messages; the first 1,000 are in Storm's mailbox as well.
  create temp table timing_items on commit drop as
    select g as n, gen_random_uuid() as id from generate_series(1, 2000) g;
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash, participants)
  select id, v_tenant, 'message', 'Project Timing ' || ((n - 1) / 100), now() - (n || ' minutes')::interval,
         '<timing-' || n || '@bank.example>', md5(n::text),
         jsonb_build_array(jsonb_build_object('role', 'from', 'address', 'ceo@target' || ((n - 1) / 100) || '.example'))
  from timing_items;
  insert into source_item_texts (source_item_id, body_text)
  select id, repeat('Body text of a deal-routed message. ', 40) from timing_items;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
  select id, v_src_a, 'a-' || n from timing_items;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
  select id, v_src_s, 's-' || n from timing_items where n <= 1000;

  -- 50,000 ledger rows on Alex's source: the 2,000 routed sightings and 48,000 unrouted ones.
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id)
  select v_src_a, 'a-' || g, md5(g::text),
         case when g <= 2000 then 'routed' else 'unrouted' end,
         case when g <= 2000 then 'codename' end,
         case when g <= 2000 then 0.9 end, v_run
  from generate_series(1, 50000) g;
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id)
  select v_src_s, 's-' || g, md5(g::text), 'routed', 'codename', 0.9, v_run from generate_series(1, 1000) g;
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
  select v_src_a, 'thread-' || g, 'rule-1', 1, 'a-' || g, v_run from generate_series(1, 50) g;
  -- The message index (#461 slice 5): a row per sighting the worker processed.
  insert into discovery_message_index (tenant_id, content_source_id, provider_item_ids, message_key, content_digest,
                                       rules_version)
  select v_tenant, source_id, array[provider_item_id],
         encode(sha256(convert_to('<timing-' || provider_item_id || '@bank.example>', 'UTF8')), 'hex'),
         'hmac-sha256:' || encode(sha256(convert_to(item_hash, 'UTF8')), 'hex'),
         'rules-timing'
  from routing_ledger where source_id in (v_src_a, v_src_s);

  -- 20 candidates of 100 items each, one assessment each.
  create temp table timing_cands on commit drop as
    select g as k, gen_random_uuid() as id from generate_series(0, 19) g;
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess, first_seen_at, last_seen_at, confidence)
  select id, v_tenant, 'codename:timing' || k, 'Project Timing ' || k, 'Project Timing ' || k, now() - interval '30 days', now(), 0.9
  from timing_cands;
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier)
  select c.id, i.id, 'codename', 0.9, 'firm'
  from timing_items i join timing_cands c on c.k = (i.n - 1) / 100;
  insert into model_calls (id, tenant_id, purpose, model, prompt_version, prompt_hash, source_item_id, content_hash,
                           transport, parsed, outcome)
  select id, v_tenant, 'milestone_extract', 'recorded-model', 'v1', 'ph', id, md5(n::text), 'recorded', '[]'::jsonb, 'ok'
  from timing_items;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id)
  select v_tenant, id, 'kickoff_held', current_date, 0, 10, 0.8, 'v1:recorded-model', id from timing_items;
  insert into stage_assessments (tenant_id, candidate_id, step_id, reason_text, confidence, engine_version, trigger)
  select v_tenant, id, 'p1-s1', 'Kickoff held', 0.8, 'v1', 'extraction' from timing_cands;
  perform discovery_refresh_candidate_visibility(id) from timing_cands;

  insert into fx values ('tenant', v_tenant), ('alex', v_alex), ('src_a', v_src_a), ('src_s', v_src_s);
  raise notice 'seeded in % ms', round(extract(epoch from clock_timestamp() - v_t0) * 1000);
end
$$;

-- Planner statistics for the seeded rows, as a live database would have them.
analyze source_items, source_item_sources, source_item_texts, routing_ledger, evidence_links,
        milestone_events, model_calls, deal_candidates, stage_assessments, discovery_thread_taints,
        discovery_message_index;

-- The banker's own call, under the banker's claims and the role's 8 s timeout.
do $$
declare
  v_alex uuid := (select v from fx where k = 'alex');
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_alex, 'session_id', v_alex, 'role', 'authenticated')::text, true);
end
$$;
set local role authenticated;
set local statement_timeout = '8s';
do $$
declare
  v_t0 timestamptz := clock_timestamp();
  v_ms numeric;
begin
  perform mailbox_consent_withdraw();
  v_ms := round(extract(epoch from clock_timestamp() - v_t0) * 1000);
  raise notice 'TIMING: mailbox_consent_withdraw() took % ms (%)', v_ms,
    case when v_ms <= 2000 then 'synchronous trigger holds: <= 2 s' else 'over 2 s: take the fallback' end;
end
$$;
reset statement_timeout;
reset role;

-- What the call deleted, so the time is for the whole purge.
do $$
declare
  v_tenant uuid := (select v from fx where k = 'tenant');
  v_detail jsonb;
begin
  if exists (select 1 from content_sources where id = (select v from fx where k = 'src_a')) then
    raise exception 'FAIL: Alex''s source survived';
  end if;
  if (select count(*) from source_items where tenant_id = v_tenant) <> 1000 then
    raise exception 'FAIL: expected the 1,000 shared items to remain, found %',
      (select count(*) from source_items where tenant_id = v_tenant);
  end if;
  if (select count(*) from deal_candidates where tenant_id = v_tenant) <> 10 then
    raise exception 'FAIL: expected the 10 shared candidates to remain';
  end if;
  select detail into v_detail from audit_log where tenant_id = v_tenant and action = 'discovery.mailbox_purged';
  raise notice 'TIMING: purge counts %', v_detail - 'sourceId' - 'consentId';
end
$$;

rollback;
