-- Deal discovery milestones (20261002200000_discovery_milestones.sql): who reads
-- milestone events and stage assessments, what the extractor's batch returns,
-- when an item settles, and that the three service-role functions stay closed
-- to signed-in roles. Read as each user under the authenticated role.
--
--   Alice      owns one Falcon item and shares one with the colleague
--   Colleague  owns the shared item, a Falcon item of their own, a tentative
--              Falcon item and the only Cobra item
--   Bob        has a mailbox with no deal mail
--   CCO        the control room of the tenant
--   Admin      a firm admin (reads no content)
--   Outsider   the control room of another tenant
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_milestones.sql
-- Everything rolls back.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does (authorize_provisioned_profile over its metadata) and give it a
-- live session whose id is the user id, so impersonating claims can carry
-- session_id = sub.
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

create function pg_temp.expect(actual bigint, expected bigint, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
end;
$$;

create function pg_temp.expect_text(actual text, expected text, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, coalesce(expected, '<null>'), coalesce(actual, '<null>');
  end if;
end;
$$;

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user, 'role', 'authenticated')::text, true);
$$;
-- The batch as the extractor sees it: the item ids (as text, sorted) it returns.
create function pg_temp.batch_subjects(p_tenant uuid)
returns text language sql as $$
  select coalesce(string_agg(subject, ',' order by subject), '')
  from discovery_extract_batch(p_tenant, 'v1', 'test-model', 50);
$$;
-- Seats a user on a deal of their tenant as deal team (#262: the one-click opt-in needs MD or deal team on a
-- deal of the tenant). One helper deal per tenant, created on first use; it is not a promoted deal. Run as the table owner.
create function pg_temp.on_deal(p_user uuid)
returns void language plpgsql as $$
declare
  v_tenant uuid;
  v_company uuid;
  v_deal uuid;
begin
  select tenant_id, company_id into v_tenant, v_company from users where id = p_user;
  select id into v_deal from deals where code = 'dd-' || v_tenant::text;
  if v_deal is null then
    insert into deals (tenant_id, code, codename, bank_id)
    values (v_tenant, 'dd-' || v_tenant::text, 'Discovery fixture', v_company) returning id into v_deal;
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values (v_deal, p_user, (select id from roles where slug = 'deal_team'), 'deal_team')
  on conflict (deal_id, user_id) do nothing;
end;
$$;
-- What the stage engine is given: the number of events the service-role read returns for the
-- candidate, so a test can say whose events still count.
create function pg_temp.assessment_input_count(p_tenant uuid, p_candidate uuid)
returns bigint language sql as $$
  select count(*) from discovery_audience_assessment_inputs(p_tenant, array[p_candidate])
   where candidate_id = p_candidate and team_mailbox_id is null;
$$;
-- The budget probes (#261). A gateway call row written directly (as the table owner), so no audit row
-- joins the counts the settle rule asserts below.
create function pg_temp.gw_call(p_tenant uuid, p_item uuid, p_outcome text, p_code text, p_response text)
returns void language sql as $$
  insert into model_calls (tenant_id, purpose, model, prompt_version, prompt_hash, source_item_id, content_hash,
                           response_id, transport, outcome, error_code, attempt)
  select p_tenant, 'milestone_extract', 'test-model', 'v1', 'x', si.id, si.content_hash, p_response, 'gateway', p_outcome, p_code, 1
  from source_items si where si.id = p_item;
$$;
-- The answer an ok call stores in model_calls.parsed (discovery_record_extraction writes its p_events there),
-- rebuilt from the events a fixture wrote directly for the item at that version: the current-events rule
-- (20261023130400) names an event only when the chosen call's answer holds its (type, span_start).
create function pg_temp.parsed_like(p_item uuid, p_version text)
returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('type', me.type, 'occurred_at', me.occurred_at, 'span_start', me.span_start,
                                               'span_end', me.span_end, 'confidence', me.confidence)), '[]'::jsonb)
  from milestone_events me where me.source_item_id = p_item and me.extractor_version = p_version;
$$;
create function pg_temp.b_spent(p_tenant uuid) returns text language sql as $$
  select spent_usd::text from discovery_extract_budget_state(p_tenant);
$$;
create function pg_temp.b_unpriced(p_tenant uuid) returns bigint language sql as $$
  select unpriced from discovery_extract_budget_state(p_tenant);
$$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  v_tenant     uuid := gen_random_uuid();
  v_other      uuid := gen_random_uuid();
  v_alice      uuid := gen_random_uuid();
  v_colleague  uuid := gen_random_uuid();
  v_bob        uuid := gen_random_uuid();
  v_cco        uuid := gen_random_uuid();
  v_admin      uuid := gen_random_uuid();
  v_outsider   uuid := gen_random_uuid();
  v_src_alice  uuid;
  v_src_coll   uuid;
  v_src_bob    uuid;
  v_shared     uuid := gen_random_uuid();
  v_alice_item uuid := gen_random_uuid();
  v_coll_item  uuid := gen_random_uuid();
  v_tentative  uuid := gen_random_uuid();
  v_cobra_item uuid := gen_random_uuid();
  v_rejected   uuid := gen_random_uuid();
  v_foreign    uuid := gen_random_uuid();
  v_run        uuid := gen_random_uuid();
  v_bank       uuid := gen_random_uuid();
  v_inv_alice  uuid := gen_random_uuid();
  v_inv_coll   uuid := gen_random_uuid();
  v_inv_bob    uuid := gen_random_uuid();
  v_deal       uuid := gen_random_uuid();
  v_falcon     uuid;
  v_cobra      uuid;
  v_rejected_c uuid;
  v_call       uuid;
  v_groups     jsonb;
  v_cnt        bigint;
  v_blocked    boolean;
  v_changed    boolean;
  v_assess     jsonb;
  v_usage      uuid := gen_random_uuid();
  v_budget     uuid;
  v_budget2    uuid;
  v_late       uuid := gen_random_uuid();
  v_pending    integer;
  v_bytes      bigint;
  v_msg        text;
  v_codes      text[];
begin
  -- ── Fixture, as the table owner (the same seating as discovery_rls.sql) ──
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alice,     'dm-alice@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_colleague, 'dm-colleague@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_bob,       'dm-bob@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_cco,       'dm-cco@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance')),
    (v_admin,     'dm-admin@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_outsider,  'dm-outsider@example.test',  jsonb_build_object('tenant_id', v_other, 'department', 'compliance'));
  update users set status = 'active', is_external = false
    where id in (v_alice, v_colleague, v_bob, v_cco, v_admin, v_outsider);
  update users set firm_role = 'cco' where id in (v_cco, v_outsider);
  update users set firm_role = 'admin' where id = v_admin;

  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values
    (v_tenant, 'fixture', 'fixture', 'active'),
    (v_other, 'fixture', 'fixture', 'active');

  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'DM Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id = v_alice;
  update users set company_id = v_bank, company_role = 'member' where id in (v_colleague, v_bob, v_cco, v_admin);
  update graph_reader_registrations set mailbox_domains = '{bank.example}', firm_company_id = v_bank
   where tenant_id = v_tenant;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (v_inv_alice, v_tenant, 'alice@bank.example',     v_alice, v_bank, 'director', 'accepted', 'sent', now(), v_alice),
    (v_inv_coll,  v_tenant, 'colleague@bank.example', v_alice, v_bank, 'member',   'accepted', 'sent', now(), v_colleague),
    (v_inv_bob,   v_tenant, 'bob@bank.example',       v_alice, v_bank, 'member',   'accepted', 'sent', now(), v_bob);
  perform pg_temp.on_deal(u) from unnest(array[v_alice, v_colleague, v_bob]) u;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_colleague);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_bob);
  perform mailbox_consent_grant();
  reset role;
  -- Each opt-in created its owner's mailbox source; look the three up.
  select id into v_src_alice from content_sources where tenant_id = v_tenant and address = 'alice@bank.example' and owner_user_id = v_alice;
  select id into v_src_coll  from content_sources where tenant_id = v_tenant and address = 'colleague@bank.example' and owner_user_id = v_colleague;
  select id into v_src_bob   from content_sources where tenant_id = v_tenant and address = 'bob@bank.example' and owner_user_id = v_bob;
  if v_src_alice is null or v_src_coll is null or v_src_bob is null then
    raise exception 'FAIL: an opt-in did not create its mailbox source';
  end if;

  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_shared,     v_tenant, 'message', 'shared',   '2026-02-03', '<shared@t>',  'h1'),
    (v_alice_item, v_tenant, 'message', 'alice',    '2026-02-10', '<alice@t>',   'h2'),
    (v_coll_item,  v_tenant, 'message', 'coll',     '2026-02-18', '<coll@t>',    'h3'),
    (v_tentative,  v_tenant, 'message', 'tentative','2026-02-19', '<tent@t>',    'h4'),
    (v_cobra_item, v_tenant, 'message', 'cobra',    '2025-11-04', '<cobra@t>',   'h5'),
    (v_rejected,   v_tenant, 'message', 'rejected', '2025-10-04', '<rej@t>',     'h6'),
    (v_foreign,    v_other,  'message', 'foreign',  '2026-02-01', '<foreign@t>', 'h7');
  insert into source_item_texts (source_item_id, body_text) values
    (v_shared, 'shared body'), (v_alice_item, 'alice body'), (v_coll_item, 'colleague body'),
    (v_tentative, 'tentative body'), (v_cobra_item, 'cobra body'), (v_rejected, 'rejected body'),
    (v_foreign, 'foreign body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_shared, v_src_alice, 'a-1'), (v_shared, v_src_coll, 'c-1'),
    (v_alice_item, v_src_alice, 'a-2'),
    (v_coll_item, v_src_coll, 'c-2'), (v_tentative, v_src_coll, 'c-3'), (v_cobra_item, v_src_coll, 'c-4'),
    (v_rejected, v_src_coll, 'c-5');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_groups := jsonb_build_array(
    jsonb_build_object(
      'clusterKey', 'codename:falcon', 'proposedName', 'Project Falcon', 'codenameGuess', 'Project Falcon',
      'parties', '[]'::jsonb, 'firstSeenAt', '2026-02-03T00:00:00Z', 'lastSeenAt', '2026-02-18T00:00:00Z', 'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_shared, 'method', 'codename', 'confidence', 0.95),
        jsonb_build_object('sourceItemId', v_alice_item, 'method', 'thread_continuation', 'confidence', 0.85),
        jsonb_build_object('sourceItemId', v_coll_item, 'method', 'codename', 'confidence', 0.95))),
    jsonb_build_object(
      'clusterKey', 'codename:cobra', 'proposedName', 'Project Cobra', 'codenameGuess', 'Project Cobra',
      'parties', '[]'::jsonb, 'firstSeenAt', '2025-11-04T00:00:00Z', 'lastSeenAt', '2025-11-04T00:00:00Z',
      'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_cobra_item, 'method', 'codename', 'confidence', 0.95))),
    jsonb_build_object(
      'clusterKey', 'codename:rejected', 'proposedName', 'Project Rejected', 'codenameGuess', 'Project Rejected',
      'parties', '[]'::jsonb, 'firstSeenAt', '2025-10-04T00:00:00Z', 'lastSeenAt', '2025-10-04T00:00:00Z',
      'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_rejected, 'method', 'codename', 'confidence', 0.95))));
  perform discovery_upsert_candidates(v_tenant, v_run, v_groups);
  select id into v_falcon from deal_candidates where tenant_id = v_tenant and cluster_key = 'codename:falcon';
  select id into v_cobra from deal_candidates where tenant_id = v_tenant and cluster_key = 'codename:cobra';
  select id into v_rejected_c from deal_candidates where tenant_id = v_tenant and cluster_key = 'codename:rejected';
  -- A tentative route never reaches the extractor.
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence)
    values (v_falcon, v_tentative, 'codename', 'tentative', 0.4);
  perform discovery_refresh_candidate_visibility(v_falcon);
  -- A rejected candidate's mail is not extracted.
  update deal_candidates set discovery_state = 'rejected' where id = v_rejected_c;

  -- ── The batch: firm, unrejected, allowlisted, unsettled ──────────────────
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), 'alice,cobra,coll,shared',
    'the batch holds the firm items of live candidates, and not the tentative, rejected or foreign ones');
  perform pg_temp.expect((select attempt from discovery_extract_batch(v_tenant, 'v1', 'test-model', 50) where subject = 'alice'), 1,
    'a fresh item is attempt 1');
  perform pg_temp.expect(
    (select count(*) from discovery_extract_batch(v_tenant, 'v1', 'test-model', 2)), 2, 'the limit holds');
  perform pg_temp.expect(
    (select count(*) from discovery_extract_batch(v_other, 'v1', 'test-model', 50)), 0,
    'another tenant has no candidate, so no batch');

  -- The estimate (#261): with nothing settled and no item in back-off, pending is exactly what the batch
  -- selects, and the stats carry numbers only.
  perform pg_temp.expect(
    (select count(*) from discovery_extract_pending(v_tenant, 'v1', 'test-model')),
    (select count(*) from discovery_extract_batch(v_tenant, 'v1', 'test-model', 200)),
    'pending counts what the batch selects');
  perform pg_temp.expect(
    (select count(*) from discovery_extract_pending(v_tenant, 'v1', 'test-model') p
      where p.source_item_id not in (select b.item_id from discovery_extract_batch(v_tenant, 'v1', 'test-model', 200) b)),
    0, 'pending selects no item the batch would not');
  perform pg_temp.expect(
    ((discovery_extract_stats(v_tenant, 'v1', 'test-model'))->'bodyBytes'->>'total')::bigint,
    (select coalesce(sum(octet_length(b.body_text)), 0) from discovery_extract_batch(v_tenant, 'v1', 'test-model', 200) b),
    'stats sum the selected bodies'' byte length');
  perform pg_temp.expect(
    (select count(*) from jsonb_each(discovery_extract_stats(v_tenant, 'v1', 'test-model')) e where jsonb_typeof(e.value) = 'string'),
    0, 'stats carry no strings');
  perform pg_temp.expect(
    (select count(*) from discovery_extract_pending(v_other, 'v1', 'test-model')), 0, 'another tenant has nothing pending');

  -- ── The budget (#261): opens once with its cohort, the batch keeps to it, and the state counts from the opening ──
  select count(*)::int into v_pending from discovery_extract_pending(v_tenant, 'v1', 'test-model');
  perform pg_temp.expect(v_pending, 4, 'four items are pending before the budget opens');
  perform pg_temp.expect((select count(*) from discovery_extract_budget_state(v_tenant)), 0, 'no open budget, no state');
  select coalesce(sum(p.subject_bytes + p.body_bytes), 0) into v_bytes from discovery_extract_pending(v_tenant, 'v1', 'test-model') p;
  -- The caller's estimate must match the pending set by item count AND by total bytes (m-4): either way, no budget.
  if discovery_extract_budget_open(v_tenant, 'test-model', 'v1', v_pending + 1, v_bytes, 1.000000, 1.250000, '{"items":1}'::jsonb, 2420, 2.0, 0.000002, 0.02048) is not null then
    raise exception 'FAIL: a budget opened for a pending set of another size';
  end if;
  if discovery_extract_budget_open(v_tenant, 'test-model', 'v1', v_pending, v_bytes - 1, 1.000000, 1.250000, '{"items":1}'::jsonb, 2420, 2.0, 0.000002, 0.02048) is not null then
    raise exception 'FAIL: a budget opened for an equal count of smaller bodies (the estimate was short)';
  end if;
  if discovery_extract_budget_open(v_tenant, 'test-model', 'v1', v_pending, v_bytes + 1, 1.000000, 1.250000, '{"items":1}'::jsonb, 2420, 2.0, 0.000002, 0.02048) is not null then
    raise exception 'FAIL: a budget opened for an equal count of larger bodies (the estimate was long)';
  end if;
  perform pg_temp.expect((select count(*) from discovery_extract_budgets where tenant_id = v_tenant), 0, 'a refused open leaves no budget');
  v_budget := discovery_extract_budget_open(v_tenant, 'test-model', 'v1', v_pending, v_bytes, 1.000000, 1.250000, '{"items":1}'::jsonb, 2420, 2.0, 0.000002, 0.02048);
  perform pg_temp.expect((select count(*) from discovery_extract_budget_items where budget_id = v_budget), v_pending, 'the cohort is the pending set');
  perform pg_temp.expect((select item_count from discovery_extract_budgets where id = v_budget), v_pending, 'the budget counts its cohort');
  perform pg_temp.expect_text(discovery_extract_budget_open(v_tenant, 'test-model', 'v1', 0, 0, 0, 0, '{}'::jsonb, 0, 1, 0, 0)::text,
    v_budget::text, 'a second open returns the open budget');
  perform pg_temp.expect((select count(*) from discovery_extract_budgets where tenant_id = v_tenant), 1, 'one open budget per tenant');
  -- An open budget for another model or prompt version is not handed back (m-3): a distinct error, no new budget.
  v_msg := null;
  begin perform discovery_extract_budget_open(v_tenant, 'other-model', 'v1', 0, 0, 0, 0, '{}'::jsonb, 0, 1, 0, 0);
  exception when sqlstate 'P0004' then get stacked diagnostics v_msg = message_text; end;
  perform pg_temp.expect_text(v_msg, 'budget_model_mismatch', 'an open budget for another model is refused');
  v_msg := null;
  begin perform discovery_extract_budget_open(v_tenant, 'test-model', 'v2', 0, 0, 0, 0, '{}'::jsonb, 0, 1, 0, 0);
  exception when sqlstate 'P0004' then get stacked diagnostics v_msg = message_text; end;
  perform pg_temp.expect_text(v_msg, 'budget_model_mismatch', 'an open budget for another prompt version is refused');
  perform pg_temp.expect_text((select model || '/' || prompt_version from discovery_extract_budget_state(v_tenant)), 'test-model/v1',
    'the state names the model and prompt the budget was opened for');
  perform pg_temp.expect((select count(*) from discovery_extract_budgets where tenant_id = v_tenant), 1, 'a refused reopen leaves one budget');
  -- Ceiling of one item at 2.0 bytes per token: ceil((2420 + 5 + 10) / 2.0) = 1218 tokens in, at 0.000002, plus 0.02048 out.
  perform pg_temp.expect_text((select ceiling_usd::text from discovery_extract_budget_items where budget_id = v_budget and source_item_id = v_alice_item),
    '0.022916', 'a ceiling is the input tokens at the input price plus the output ceiling');
  -- The one ceiling function, held to tests/fixtures/discovery/extract/ceiling-cases.json (the vitest suite reads these literals).
  perform pg_temp.expect_text(discovery_extract_ceiling_usd(213, 2420, 2.0, 0.000002, 0.02048)::text, '0.023114', 'ceiling: small body');
  perform pg_temp.expect_text(discovery_extract_ceiling_usd(10040, 2420, 2.0, 0.000002, 0.02048)::text, '0.032940', 'ceiling: mid body');
  perform pg_temp.expect_text(discovery_extract_ceiling_usd(200080, 2420, 2.0, 0.000002, 0.02048)::text, '0.222980', 'ceiling: large body, about 200 KB');
  perform pg_temp.expect(
    (select count(*) from discovery_extract_batch(v_tenant, 'v1', 'test-model', 200, v_budget) b
      where b.item_id not in (select source_item_id from discovery_extract_budget_items where budget_id = v_budget)),
    0, 'the batch selects only the cohort');
  -- Mail that arrives after the opening: the batch without a budget sees it, the batch with the budget does not.
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_late, v_tenant, 'message', 'late', '2026-02-20', '<late@t>', 'h8');
  insert into source_item_texts (source_item_id, body_text) values (v_late, 'late body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_late, v_src_alice, 'a-late');
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence) values (v_falcon, v_late, 'codename', 'firm', 0.9);
  perform pg_temp.expect((select count(*) from discovery_extract_pending(v_tenant, 'v1', 'test-model') where source_item_id = v_late), 1,
    'new mail is pending');
  -- While a budget is open the batch answers only a call that names it: no budget, or another one, selects nothing.
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), '', 'an open budget: a batch that names none selects nothing');
  perform pg_temp.expect((select count(*) from discovery_extract_batch(v_tenant, 'v1', 'test-model', 200, gen_random_uuid())), 0,
    'an open budget: a batch that names another budget selects nothing');
  perform pg_temp.expect_text(
    (select coalesce(string_agg(subject, ',' order by subject), '') from discovery_extract_batch(v_tenant, 'v1', 'test-model', 200, v_budget)),
    'alice,cobra,coll,shared', 'new mail waits for the next budget');
  v_blocked := false;
  begin perform discovery_extract_budget_open(gen_random_uuid(), 'm', 'v1', 0, 0, 0, 0, '[]'::jsonb, 0, 1, 0, 0);
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a non-object estimate was accepted'; end if;
  v_blocked := false;
  begin insert into discovery_extract_budgets (tenant_id, model, prompt_version, item_count, est_cost_usd, stop_at_usd, estimate)
    values (v_tenant, 'm', 'v1', 0, 0, 0, '{}'::jsonb);
  exception when unique_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a second open budget was inserted for one tenant'; end if;

  -- State, counted from the opening. Move the opening back so the rows below fall inside it.
  update discovery_extract_budgets set opened_at = now() - interval '1 hour' where id = v_budget;
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.000000', 'no spend yet');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'nothing unpriced yet');
  -- A reservation (M-1, B2): the service role sets and clears inflight_since only through discovery_extract_reserve
  -- and discovery_extract_settle, and writes no cohort column directly.
  perform pg_temp.expect((select count(*) from discovery_extract_budget_items where budget_id = v_budget and inflight_since is not null), 0,
    'nothing is in flight on a new cohort');
  set local role service_role;
  v_blocked := false;
  begin update discovery_extract_budget_items set inflight_since = now() where budget_id = v_budget; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: service_role set a reservation directly'; end if;
  v_blocked := false;
  begin update discovery_extract_budget_items set ceiling_usd = 0 where budget_id = v_budget; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: service_role updated a ceiling'; end if;
  v_blocked := false;
  begin delete from discovery_extract_budget_items where budget_id = v_budget; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: service_role deleted a cohort row'; end if;
  -- The codes, called as the service role (compared after the reset: the helpers are not the service role's).
  v_codes := array[discovery_extract_reserve(gen_random_uuid(), v_alice_item), discovery_extract_reserve(v_budget, v_tentative)];
  v_codes := v_codes || discovery_extract_reserve(v_budget, v_alice_item);
  v_codes := v_codes || discovery_extract_reserve(v_budget, v_alice_item);
  v_codes := v_codes || discovery_extract_reserve(v_budget, v_coll_item);
  reset role;
  perform pg_temp.expect_text(v_codes[1], 'closed', 'reserve: no open budget by that id');
  perform pg_temp.expect_text(v_codes[2], 'not_in_cohort', 'reserve: an item outside the cohort');
  perform pg_temp.expect_text(v_codes[3], 'ok', 'reserve: an item that fits under the line');
  perform pg_temp.expect_text(v_codes[4], 'busy', 'reserve: the same item again');
  perform pg_temp.expect_text(v_codes[5], 'busy', 'reserve: another item while one is in flight');
  perform pg_temp.expect((select count(*) from discovery_extract_budget_items where budget_id = v_budget and inflight_since is not null), 1,
    'only the ok reserve wrote a reservation');
  -- Reserved and never settled: the item counts at its ceiling, and the state is unpriced (fail closed).
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant),
    (select ceiling_usd::text from discovery_extract_budget_items where budget_id = v_budget and source_item_id = v_alice_item),
    'a reserved item counts at its ceiling');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 1, 'a reserved item is unpriced: its outcome is unknown');
  update discovery_extract_budget_items set inflight_since = now() where budget_id = v_budget and source_item_id = v_coll_item;
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 2, 'each reserved item counts');
  update discovery_extract_budget_items set inflight_since = null where budget_id = v_budget and source_item_id = v_coll_item;
  set local role service_role;
  perform discovery_extract_settle(v_budget, v_alice_item);
  v_blocked := false;
  begin perform discovery_extract_settle(v_budget, v_tentative); exception when sqlstate 'P0002' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a settle that matched no cohort row did not raise'; end if;
  reset role;
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.000000', 'a settled reservation counts nothing');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'settled, nothing is unpriced');
  -- A priced call: a ledger row first, then its model_calls row with the same response id.
  insert into ai_usage (tenant_id, actor_id, source, task, model, cost_usd, external_id) values
    (v_tenant, null, 'discovery_extract', 'milestone_extract', 'claude-sonnet-5', 0.40, 'bt-1'),
    (gen_random_uuid(), null, 'discovery_extract', 'milestone_extract', 'claude-sonnet-5', 9.00, 'bt-other');
  perform pg_temp.gw_call(v_tenant, v_alice_item, 'ok', null, 'bt-1');
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.400000', 'priced spend, this tenant only');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'a priced call with its call row is not unpriced');
  perform pg_temp.expect_text(discovery_extract_reserve(v_budget, v_alice_item), 'busy',
    'reserve: an item answered since the opening (a stale batch in another process) is not sent again');
  update discovery_extract_budgets set est_cost_usd = 0, stop_at_usd = 0.41 where id = v_budget;
  perform pg_temp.expect_text(discovery_extract_reserve(v_budget, v_coll_item), 'over_estimate',
    'reserve: spent plus the item''s ceiling crosses the line');
  update discovery_extract_budgets set est_cost_usd = 1, stop_at_usd = 1.25 where id = v_budget;
  -- The batch's retry rule holds at the reservation too, so a stale batch cannot resend a failed item early.
  perform pg_temp.gw_call(v_tenant, v_coll_item, 'failed', 'timeout', null);
  perform pg_temp.expect_text(discovery_extract_reserve(v_budget, v_coll_item), 'busy',
    'reserve: a failure inside the 30-second back-off');
  update model_calls set created_at = now() - interval '5 minutes' where tenant_id = v_tenant and source_item_id = v_coll_item;
  perform pg_temp.gw_call(v_tenant, v_coll_item, 'failed', 'timeout', null);
  perform pg_temp.gw_call(v_tenant, v_coll_item, 'failed', 'timeout', null);
  update model_calls set created_at = now() - interval '5 minutes' where tenant_id = v_tenant and source_item_id = v_coll_item;
  perform pg_temp.expect_text(discovery_extract_reserve(v_budget, v_coll_item), 'busy',
    'reserve: an item at three failures, past its back-off');
  delete from model_calls where tenant_id = v_tenant and source_item_id = v_coll_item;
  -- A failed call for a cohort item adds its ceiling; one with no_key, and one for an item outside the cohort, add nothing.
  perform pg_temp.gw_call(v_tenant, v_coll_item, 'failed', 'timeout', null);
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant),
    (0.40 + (select ceiling_usd from discovery_extract_budget_items where budget_id = v_budget and source_item_id = v_coll_item))::numeric(12,6)::text,
    'a timed-out call counts at its ceiling');
  perform pg_temp.gw_call(v_tenant, v_cobra_item, 'failed', 'no_key', null);
  perform pg_temp.gw_call(v_tenant, v_late, 'failed', 'timeout', null);
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant),
    (0.40 + (select ceiling_usd from discovery_extract_budget_items where budget_id = v_budget and source_item_id = v_coll_item))::numeric(12,6)::text,
    'a no_key failure and an item outside the cohort add nothing');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'failed calls are priced at their ceiling, not unpriced');
  delete from model_calls where tenant_id = v_tenant and outcome = 'failed';
  -- An ok call with a response id and no ledger row is unpriced; its ledger row clears it.
  perform pg_temp.gw_call(v_tenant, v_shared, 'ok', null, 'bt-2');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 1, 'an ok call with no ledger row is unpriced');
  perform pg_temp.expect_text(discovery_extract_reserve(v_budget, v_coll_item), 'unpriced', 'reserve: a cost the ledger cannot see');
  perform pg_temp.expect((select count(*) from discovery_extract_budget_items where budget_id = v_budget and inflight_since is not null), 0,
    'a refused reserve writes nothing');
  insert into ai_usage (tenant_id, actor_id, source, task, model, cost_usd, external_id)
    values (v_tenant, null, 'discovery_extract', 'milestone_extract', 'claude-sonnet-5', 0.10, 'bt-2');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'its ledger row clears it');
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.500000', 'both priced rows count');
  -- An ok call whose reply had no id (stored null) has no row to match: unpriced.
  perform pg_temp.gw_call(v_tenant, v_cobra_item, 'ok', null, null);
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 1, 'an ok call with no response id is unpriced');
  -- A null-cost ledger row (no usage, no price, or an id-less reply) is unpriced, and adds no dollars.
  insert into ai_usage (tenant_id, actor_id, source, task, model, cost_usd, external_id)
    values (v_tenant, null, 'discovery_extract', 'milestone_extract', 'claude-sonnet-5', null, 'local:bt-3');
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.500000', 'a null-cost row adds no dollars');
  if pg_temp.b_unpriced(v_tenant) < 1 then raise exception 'FAIL: a null-cost ledger row was not unpriced'; end if;
  delete from model_calls where tenant_id = v_tenant and response_id is null;
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 1, 'the null-cost row alone is unpriced');
  delete from ai_usage where external_id = 'local:bt-3';
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'clean again');
  -- A priced ledger row with no model_calls row: the call was billed and its row never saved. Unpriced, and its dollars count.
  insert into ai_usage (tenant_id, actor_id, source, task, model, cost_usd, external_id)
    values (v_tenant, null, 'discovery_extract', 'milestone_extract', 'claude-sonnet-5', 0.05, 'bt-orphan');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 1, 'a priced ledger row with no call row is unpriced');
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.550000', 'the orphan''s dollars are in the spend');
  perform pg_temp.gw_call(v_tenant, v_cobra_item, 'invalid', 'span_not_found', 'bt-orphan');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'its call row clears it');
  -- The proposal step's ledger rows (task deal_proposal, no model_calls row) are not extraction's: priced or
  -- not, they add no dollars and nothing unpriced, so they never lock the budget.
  insert into ai_usage (tenant_id, actor_id, source, task, model, cost_usd, external_id) values
    (v_tenant, null, 'discovery_extract', 'deal_proposal', 'claude-haiku-5.5', 0.07, 'bt-proposal'),
    (v_tenant, null, 'discovery_extract', 'deal_proposal', 'claude-haiku-5.5', null, 'bt-proposal-unpriced');
  perform pg_temp.expect(pg_temp.b_unpriced(v_tenant), 0, 'a proposal row is not unpriced extraction spend');
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.550000', 'a proposal row adds no dollars');
  delete from ai_usage where external_id in ('bt-proposal', 'bt-proposal-unpriced');
  -- A ledger row from before the opening is not state.
  update ai_usage set created_at = now() - interval '2 hours' where external_id = 'bt-orphan';
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.500000', 'a row from before the opening is not spend');
  -- Closing the budget ends its state; the next open is a new budget and a new cohort.
  update discovery_extract_budgets set closed_at = now() where id = v_budget;
  perform pg_temp.expect((select count(*) from discovery_extract_budget_state(v_tenant)), 0, 'a closed budget is not state');
  -- (now() is the transaction's time, so age the earlier rows before the new opening.)
  update ai_usage set created_at = now() - interval '2 hours' where external_id in ('bt-1', 'bt-2');
  update model_calls set created_at = now() - interval '2 hours' where tenant_id = v_tenant;
  select count(*)::int into v_pending from discovery_extract_pending(v_tenant, 'v1', 'test-model');
  select coalesce(sum(p.subject_bytes + p.body_bytes), 0) into v_bytes from discovery_extract_pending(v_tenant, 'v1', 'test-model') p;
  v_budget2 := discovery_extract_budget_open(v_tenant, 'test-model', 'v1', v_pending, v_bytes, 1, 2, '{}'::jsonb, 2420, 2.0, 0.000002, 0.02048);
  if v_budget2 is null or v_budget2 = v_budget then raise exception 'FAIL: a closed budget was not replaced by a new one'; end if;
  perform pg_temp.expect((select count(*) from discovery_extract_budget_items where budget_id = v_budget2 and source_item_id = v_late), 1,
    'the next budget''s cohort holds the late mail');
  perform pg_temp.expect_text(pg_temp.b_spent(v_tenant), '0.000000', 'a new budget counts from its own opening');
  -- Leave the fixture as the settle rule below expects it.
  delete from discovery_extract_budgets where tenant_id = v_tenant;
  delete from model_calls where tenant_id = v_tenant;
  delete from ai_usage where external_id in ('bt-1', 'bt-2', 'bt-other', 'bt-orphan');
  delete from evidence_links where source_item_id = v_late;
  delete from source_items where id = v_late;

  -- ok with events settles and writes the events and one audit row.
  v_call := discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_alice_item, 'content_hash', 'h2', 'response_id', null, 'transport', 'recorded',
      'outcome', 'ok', 'error_code', null, 'attempt', 1),
    jsonb_build_array(jsonb_build_object('type', 'loi_signed', 'occurred_at', '2026-02-10', 'span_start', 0, 'span_end', 5, 'confidence', 0.9)));
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = v_alice_item), 1, 'one event stored');
  perform pg_temp.expect_text((select extractor_version from milestone_events where source_item_id = v_alice_item),
    'v1:test-model', 'the extractor version names prompt and model');
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), 'cobra,coll,shared', 'an ok call settles the item');

  -- ok with zero events settles too; invalid settles; the event is written once.
  perform discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_shared, 'content_hash', 'h1', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 1), '[]'::jsonb);
  perform discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_coll_item, 'content_hash', 'h3', 'transport', 'recorded', 'outcome', 'invalid',
      'error_code', 'span_not_found', 'attempt', 1), '[]'::jsonb);
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), 'cobra', 'ok with no events and invalid both settle');
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = v_coll_item), 0, 'an invalid call stores no event');

  -- A changed content hash is unsettled again (the item was edited upstream).
  update source_items set content_hash = 'h2b' where id = v_shared;
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), 'cobra,shared', 'new content is extracted again');
  update source_items set content_hash = 'h1' where id = v_shared;

  -- failed retries: hidden for 30 s, then back with attempt n + 1, and three settle it.
  perform discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_cobra_item, 'content_hash', 'h5', 'transport', 'gateway', 'outcome', 'failed',
      'error_code', 'http', 'attempt', 1), '[]'::jsonb);
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), '', 'a fresh failure waits 30 seconds');
  update model_calls set created_at = now() - interval '1 minute' where source_item_id = v_cobra_item;
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), 'cobra', 'an aged failure is retried');
  perform pg_temp.expect((select attempt from discovery_extract_batch(v_tenant, 'v1', 'test-model', 50)), 2, 'the retry is attempt 2');
  perform discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_cobra_item, 'content_hash', 'h5', 'transport', 'gateway', 'outcome', 'failed',
      'error_code', 'http', 'attempt', 2), '[]'::jsonb);
  perform discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_cobra_item, 'content_hash', 'h5', 'transport', 'gateway', 'outcome', 'failed',
      'error_code', 'http', 'attempt', 3), '[]'::jsonb);
  update model_calls set created_at = now() - interval '1 minute' where source_item_id = v_cobra_item;
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), '', 'three failed rows settle the item');

  -- Audit: one row per ok or invalid call, none for failed; the model identity, ids and counts only.
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.milestone_extracted'
       and actor_type = 'model' and service_identity = 'model-gateway' and actor_id is null and chain_seq is not null),
    3, 'the three settled calls are audited by the model identity, none of the failed ones');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.milestone_extracted'
       and detail::text ~* '(loi|letter|quote|body)'), 0, 'the audit detail holds no text');

  -- A call for another tenant's item is refused.
  v_blocked := false;
  begin
    perform discovery_record_extraction(v_tenant, jsonb_build_object(
        'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
        'source_item_id', v_foreign, 'content_hash', 'h7', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 1), '[]'::jsonb);
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an extraction was recorded for another tenant''s item'; end if;

  -- Give the colleague's and Cobra's items an event each, so the matrix below has rows to see.
  perform discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_coll_item, 'content_hash', 'h3', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 2),
    jsonb_build_array(jsonb_build_object('type', 'closed', 'occurred_at', '2026-02-18', 'span_start', 0, 'span_end', 5, 'confidence', 0.9)));
  perform discovery_record_extraction(v_tenant, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'test-model', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_cobra_item, 'content_hash', 'h5', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 4),
    jsonb_build_array(jsonb_build_object('type', 'signed', 'occurred_at', '2025-11-04', 'span_start', 3, 'span_end', 9, 'confidence', 0.8)));

  -- ── Assessments: insert on change only, audited, deal_id copied ──────────
  v_assess := jsonb_build_object('stepId', 'p4-s48', 'station', 44, 'lifecycle', 'live', 'reason', 'LOI Review because LOI signed on 10 Feb 2026 (1 email)',
    'evidenceEventIds', (select jsonb_agg(id) from milestone_events where source_item_id = v_alice_item),
    'confidence', 0.9, 'flags', '[]'::jsonb, 'engineVersion', 'stage-engine/v1');
  v_changed := discovery_record_assessment(v_tenant, v_falcon, v_assess, 'extraction');
  if not v_changed then raise exception 'FAIL: a first assessment was not inserted'; end if;
  v_changed := discovery_record_assessment(v_tenant, v_falcon, v_assess, 'rerun');
  if v_changed then raise exception 'FAIL: an unchanged assessment was inserted again'; end if;
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_falcon), 1, 'one assessment after a repeat');
  v_changed := discovery_record_assessment(v_tenant, v_falcon, v_assess || jsonb_build_object('stepId', 'p5-s51', 'station', 47), 'extraction');
  if not v_changed then raise exception 'FAIL: a changed step was not inserted'; end if;
  v_changed := discovery_record_assessment(v_tenant, v_falcon,
    v_assess || jsonb_build_object('stepId', 'p5-s51', 'station', 47, 'flags', '["conflict"]'::jsonb), 'extraction');
  if not v_changed then raise exception 'FAIL: a changed flag set was not inserted'; end if;
  perform discovery_record_assessment(v_tenant, v_cobra,
    v_assess || jsonb_build_object('stepId', 'p5-s57', 'station', 53, 'lifecycle', 'closed'), 'extraction');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_falcon), 3, 'three assessments for three changes');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.stage_assessed'
       and actor_type = 'service' and service_identity = 'discovery-worker' and actor_id is null and chain_seq is not null),
    4, 'each inserted assessment is audited once by the service');
  v_blocked := false;
  begin perform discovery_record_assessment(v_other, v_falcon, v_assess, 'extraction');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an assessment was recorded for another tenant''s candidate'; end if;
  v_blocked := false;
  begin perform discovery_record_assessment(v_tenant, v_falcon, v_assess, 'sometimes');
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown trigger was accepted'; end if;
  v_blocked := false;
  begin perform discovery_record_assessment(v_tenant, v_falcon,
      v_assess || jsonb_build_object('stepId', 'p1-s12', 'flags', '["invented"]'::jsonb), 'extraction');
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown flag was accepted'; end if;

  -- The deal_id trigger copies the candidate's promoted deal on every insert.
  insert into deals (id, tenant_id, code, codename, bank_id) values (v_deal, v_tenant, 'DM-TEST-1', 'Falcon', v_bank);
  update deal_candidates set promoted_deal_id = v_deal, discovery_state = 'confirmed' where id = v_falcon;
  perform discovery_record_assessment(v_tenant, v_falcon,
    v_assess || jsonb_build_object('stepId', 'p5-s52', 'station', 48), 'extraction');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_falcon and deal_id = v_deal), 1,
    'an assessment made after promotion carries the deal');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_falcon and deal_id is null), 3,
    'earlier assessments stay unattached');

  -- ── The ai_usage actor rule (T13) ────────────────────────────────────────
  insert into ai_usage (tenant_id, actor_id, source, task, external_id, model)
    values (v_tenant, null, 'discovery_extract', 'milestone_extract', 'msg_' || v_usage, 'claude-sonnet-5');
  v_blocked := false;
  begin
    insert into ai_usage (tenant_id, actor_id, source, task, external_id) values (v_tenant, null, 'screen', 'mail_screen', 'x-' || v_usage);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a screen usage row with no actor was accepted'; end if;
  v_blocked := false;
  begin
    insert into ai_usage (tenant_id, actor_id, source, task, external_id) values (v_tenant, v_alice, 'invented', 'x', 'y-' || v_usage);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown usage source was accepted'; end if;
  raise notice 'PASS: the batch, the settle rule, the audit rows and the assessment writer hold';

  -- ── Reads as each user ───────────────────────────────────────────────────
  set local role authenticated;

  -- Alice: Falcon's two visible items (her own, the colleague's as metadata); not Cobra's.
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from milestone_events), 2, 'Alice sees the events of Falcon''s items');
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = v_cobra_item), 0, 'Alice does not see Cobra''s event');
  perform pg_temp.expect((select count(*) from stage_assessments), 4, 'Alice sees Falcon''s four assessments');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_cobra), 0, 'Alice does not see Cobra''s assessment');

  -- The colleague: their own items' events, Alice's through Falcon, and Cobra's.
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from milestone_events), 3, 'the colleague sees every event on their candidates');
  perform pg_temp.expect((select count(*) from stage_assessments), 5, 'the colleague sees both candidates'' assessments');

  -- Bob, the admin and the other tenant's control room: nothing.
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from milestone_events) + (select count(*) from stage_assessments), 0, 'Bob sees no event or assessment');
  -- The firm admin oversees the promoted deal (app_is_deal_overseer), so after promotion (20261002220000)
  -- it reads the one assessment that carries the deal, for the rail's marker, and nothing else: no event,
  -- no assessment of a candidate that was never promoted, and no assessment left unattached.
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from milestone_events), 0, 'the admin sees no event');
  perform pg_temp.expect((select count(*) from stage_assessments), 1, 'the admin reads only the assessment that carries the promoted deal');
  perform pg_temp.expect((select count(*) from stage_assessments where deal_id is null), 0, 'the admin reads no unattached assessment');
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect((select count(*) from milestone_events) + (select count(*) from stage_assessments), 0, 'another tenant''s CCO sees nothing');

  -- The control room: the tenant.
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from milestone_events), 3, 'the CCO sees every event of the tenant');
  perform pg_temp.expect((select count(*) from stage_assessments), 5, 'the CCO sees every assessment of the tenant');

  -- Nobody signed in reads the ledger or the outbox, and nobody writes anything.
  perform pg_temp.act_as(v_cco);
  v_blocked := false;
  begin perform 1 from model_calls limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user read model_calls'; end if;
  v_blocked := false;
  begin perform 1 from discovery_recompute_requests limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user read the recompute outbox'; end if;
  v_blocked := false;
  begin insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, model_call_id)
    values (v_tenant, v_alice_item, 'closed', '2026-01-01', 0, 1, 0.5, 'x', v_call);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user inserted an event'; end if;
  v_blocked := false;
  begin update stage_assessments set reason_text = 'edited'; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user edited an assessment'; end if;

  -- The extractor's functions and the trigger function are closed to signed-in roles.
  v_blocked := false;
  begin perform 1 from discovery_extract_batch(v_tenant, 'v1', 'test-model', 50); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_batch'; end if;
  v_blocked := false;
  begin perform discovery_record_extraction(v_tenant, '{}'::jsonb, '[]'::jsonb); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_record_extraction'; end if;
  v_blocked := false;
  begin perform discovery_record_assessment(v_tenant, v_falcon, v_assess, 'extraction'); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_record_assessment'; end if;
  v_blocked := false;
  begin perform 1 from discovery_assessment_inputs(v_tenant, array[v_falcon]); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_assessment_inputs'; end if;
  v_blocked := false;
  begin perform 1 from discovery_extract_pending(v_tenant, 'v1', 'test-model'); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_pending'; end if;
  v_blocked := false;
  begin perform discovery_extract_stats(v_tenant, 'v1', 'test-model'); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_stats'; end if;
  v_blocked := false;
  begin perform discovery_extract_budget_open(v_tenant, 'test-model', 'v1', 0, 0, 0, 0, '{}'::jsonb, 0, 1, 0, 0); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_budget_open'; end if;
  v_blocked := false;
  begin perform discovery_extract_ceiling_usd(1, 1, 1, 1, 1); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_ceiling_usd'; end if;
  v_blocked := false;
  begin perform 1 from discovery_extract_budget_state(v_tenant); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_budget_state'; end if;
  v_blocked := false;
  begin perform discovery_extract_reserve(gen_random_uuid(), v_alice_item); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_reserve'; end if;
  v_blocked := false;
  begin perform discovery_extract_settle(gen_random_uuid(), v_alice_item); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_extract_settle'; end if;
  v_blocked := false;
  begin perform 1 from discovery_extract_budgets limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user read the extract budgets'; end if;
  v_blocked := false;
  begin perform 1 from discovery_extract_budget_items limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user read the extract budget items'; end if;
  -- Writes, as a signed-in user: refused by privilege, not merely by RLS finding no row.
  v_blocked := false;
  begin update discovery_extract_budgets set closed_at = now(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user updated the extract budgets'; end if;
  v_blocked := false;
  begin delete from discovery_extract_budgets; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user deleted the extract budgets'; end if;
  v_blocked := false;
  begin insert into discovery_extract_budgets (tenant_id, model, prompt_version, item_count, est_cost_usd, stop_at_usd, estimate)
    values (v_tenant, 'm', 'v1', 0, 0, 0, '{}'::jsonb); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user inserted an extract budget'; end if;
  v_blocked := false;
  begin update discovery_extract_budget_items set inflight_since = null; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user updated the extract budget items'; end if;
  v_blocked := false;
  begin delete from discovery_extract_budget_items; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user deleted the extract budget items'; end if;
  v_blocked := false;
  begin insert into discovery_extract_budget_items (budget_id, source_item_id, ceiling_usd)
    values (gen_random_uuid(), gen_random_uuid(), 0); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user inserted an extract budget item'; end if;
  reset role;
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('discovery_extract_batch', 'discovery_record_extraction', 'discovery_record_assessment', 'discovery_assessment_inputs', 'stage_assessments_copy_deal_id',
                         'discovery_extract_pending', 'discovery_extract_stats', 'discovery_extract_budget_open', 'discovery_extract_budget_state',
                         'discovery_extract_ceiling_usd', 'discovery_extract_reserve', 'discovery_extract_settle')
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
    0, 'no signed-in role may execute any of the twelve functions');

  -- anon reads nothing.
  set local role anon;
  v_blocked := false;
  begin perform 1 from milestone_events limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon read milestone_events'; end if;
  v_blocked := false;
  begin perform 1 from stage_assessments limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon read stage_assessments'; end if;
  -- anon and the extract budget tables: no read, no write.
  v_blocked := false;
  begin perform 1 from discovery_extract_budgets limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon read the extract budgets'; end if;
  v_blocked := false;
  begin perform 1 from discovery_extract_budget_items limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon read the extract budget items'; end if;
  v_blocked := false;
  begin update discovery_extract_budgets set closed_at = now(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon updated the extract budgets'; end if;
  v_blocked := false;
  begin delete from discovery_extract_budgets; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon deleted the extract budgets'; end if;
  v_blocked := false;
  begin insert into discovery_extract_budgets (tenant_id, model, prompt_version, item_count, est_cost_usd, stop_at_usd, estimate)
    values (gen_random_uuid(), 'm', 'v1', 0, 0, 0, '{}'::jsonb); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon inserted an extract budget'; end if;
  v_blocked := false;
  begin update discovery_extract_budget_items set inflight_since = null; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon updated the extract budget items'; end if;
  v_blocked := false;
  begin delete from discovery_extract_budget_items; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon deleted the extract budget items'; end if;
  v_blocked := false;
  begin insert into discovery_extract_budget_items (budget_id, source_item_id, ceiling_usd)
    values (gen_random_uuid(), gen_random_uuid(), 0); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon inserted an extract budget item'; end if;
  reset role;

  -- ── The stage engine's inputs follow the allowlist (#262 R15) ─────────────
  -- Falcon holds Alice's and the colleague's events, Cobra the colleague's. A withdrawn or lost mailbox's
  -- events must stop counting toward a new assessment, whose reason and evidence ids its readers see.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_falcon), 2, 'Falcon counts its two events while both mailboxes are allowed');
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_cobra), 1, 'Cobra counts its event while the colleague''s mailbox is allowed');
  perform pg_temp.expect(
    (select count(*) from discovery_assessment_inputs(v_other, array[v_falcon, v_cobra])), 0, 'another tenant is given no input for these candidates');
  perform pg_temp.expect(
    (select count(*) from discovery_assessment_inputs(v_tenant, array[v_rejected_c]) where source_item_id = v_rejected), 0,
    'an item with no event contributes no row');
  perform pg_temp.expect(
    (select count(*) from discovery_assessment_inputs(v_tenant, array[v_falcon]) where source_item_id = v_tentative), 0,
    'a tentative link contributes nothing');

  -- ── A withdrawn consent drops the item from the batch; the shared one stays ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- The inputs first, while the items' ok calls still stand: an event counts only through its item's current
  -- model call (discovery_current_event_ids, 20261023130400), and the batch check below deletes the calls.
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_falcon), 1,
    'after Alice withdrew, her event no longer counts toward Falcon; the colleague''s still does');
  perform pg_temp.expect(
    (select count(*) from discovery_audience_assessment_inputs(v_tenant, array[v_falcon]) where source_item_id = v_alice_item), 0,
    'the withdrawn mailbox''s item is not among the assessment inputs');
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_cobra), 1, 'Cobra is untouched by Alice''s withdrawal');

  -- Open every item again, so the batch shows only what the allowlist still admits.
  delete from model_calls where tenant_id = v_tenant;
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), 'cobra,coll,shared',
    'a withdrawn consent drops Alice''s own item; the shared item stays through the colleague''s mailbox');
  perform pg_temp.expect((select count(*) from discovery_extract_batch(v_tenant, 'v1', 'test-model', 50) where item_id = v_alice_item), 0,
    'after consent withdrawal the batch no longer returns the item of the withdrawn mailbox');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.mailbox_consent_withdrawn'
      and detail->>'address' = 'alice@bank.example' and actor_type = 'user' and detail->>'reason' = 'withdrawn'), 1,
    'Alice''s exit was a withdrawal, not a seat loss');

  -- With no ok call left, no event is current: the inputs are empty though the events are stored. Put the
  -- colleague's and Cobra's calls back (as the table owner, ok, for the items' current content), so the seat-loss
  -- checks below see the allowlist and not a missing call.
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_falcon) + pg_temp.assessment_input_count(v_tenant, v_cobra), 0,
    'no event counts without an ok call for its item''s current content');
  perform pg_temp.gw_call(v_tenant, i, 'ok', null, null) from unnest(array[v_coll_item, v_cobra_item]) i;
  update model_calls mc set parsed = pg_temp.parsed_like(mc.source_item_id, mc.prompt_version || ':' || mc.model)
   where mc.tenant_id = v_tenant and mc.outcome = 'ok' and mc.parsed is null;
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_falcon) + pg_temp.assessment_input_count(v_tenant, v_cobra), 2,
    'the colleague''s and Cobra''s events count again once their calls stand');

  -- ── A lost seat drops the items of that mailbox, separately from a withdrawal ──
  -- The colleague still holds their consent; the firm removes their seat (the
  -- members route's effect). The seat-loss trigger withdraws the open consent,
  -- so the mailbox leaves the allowlist and everything only it carried drops.
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_colleague and withdrawn_at is null), 1,
    'the colleague still holds an open consent before the seat is lost');
  update users set company_id = null, company_role = null, status = 'suspended' where id = v_colleague;
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_colleague and withdrawn_at is null), 0,
    'seat loss closed the colleague''s consent');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.mailbox_consent_withdrawn'
      and detail->>'address' = 'colleague@bank.example' and actor_type = 'service' and detail->>'reason' = 'seat_lost'), 1,
    'the colleague''s exit was a seat loss, not a withdrawal');
  -- The inputs first, while the ok calls stand, so the zero below is the allowlist's.
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_falcon), 0, 'after the seat is lost no Falcon event counts');
  perform pg_temp.expect(pg_temp.assessment_input_count(v_tenant, v_cobra), 0, 'after the seat is lost no Cobra event counts');

  delete from model_calls where tenant_id = v_tenant;
  perform pg_temp.expect_text(pg_temp.batch_subjects(v_tenant), '',
    'after the seat is lost no item returns: the shared, colleague and Cobra items were carried by that mailbox alone');
  perform pg_temp.expect((select count(*) from discovery_extract_batch(v_tenant, 'v1', 'test-model', 50)
      where item_id in (v_shared, v_coll_item, v_cobra_item)), 0,
    'the batch no longer returns the shared item once both its mailboxes are gone');

  -- The batch runs for the one role meant to run it, and only that role.
  set local role service_role;
  select count(*) into v_cnt from discovery_extract_batch(v_tenant, 'v1', 'test-model', 50);
  reset role;
  perform pg_temp.expect(v_cnt, 0, 'service_role may execute the batch (it answers empty here)');

  raise notice 'PASS: discovery milestones: RLS matrix, closed functions, settle rule, audit rows';
end $$;

-- ── The team audience (#173 G-07 slice 1a, 20261023130100) ─────────────────────────────────
-- An assessment row may be scoped to a team inbox's audience. Until G-07 slice 4 opens scoped rows
-- to that audience, nobody reads one (fail closed). The inputs tag every event with its audience
-- and its basis; the writer compares per (candidate, audience), takes the tenant lock and refuses
-- an inbox that is not allowed in the row's tenant; the composite reference refuses a direct insert.
--
--   Admin   the firm admin who connects deals@ (reads no content; oversees the promoted deal)
--   Storm   a member of deals@
--   Bob     not a member; holds a personal copy of the shared message, so sees the candidate
--   CCO     the control room
--
--   Kestrel   team1 (deals@ only), shared (deals@ and Bob's mailbox), bob1 (Bob's mailbox only)
do $$
declare
  v_t         uuid := gen_random_uuid();
  v_b         uuid := gen_random_uuid();
  v_other_t   uuid := gen_random_uuid();
  v_other_b   uuid := gen_random_uuid();
  v_admin     uuid := gen_random_uuid();
  v_storm     uuid := gen_random_uuid();
  v_bob       uuid := gen_random_uuid();
  v_cco       uuid := gen_random_uuid();
  v_inv_bob   uuid := gen_random_uuid();
  v_tm        uuid;
  v_src_tm    uuid;
  v_src_bob   uuid;
  v_other_tm  uuid := gen_random_uuid();
  v_team1     uuid := gen_random_uuid();
  v_shared    uuid := gen_random_uuid();
  v_bob1      uuid := gen_random_uuid();
  v_deal      uuid := gen_random_uuid();
  v_kestrel   uuid;
  v_out       jsonb;
  v_groups    jsonb;
  v_ev_team1  uuid;
  v_ev_shared uuid;
  v_ev_bob1   uuid;
  v_assess    jsonb;
  v_changed   boolean;
  v_blocked   boolean;
  v_shared_n  bigint;
  v_persona   uuid;
  v_ev_rule   uuid;
  v_scoped_n  bigint;
  v_b2_dir    uuid := gen_random_uuid();
  v_b2_cco    uuid := gen_random_uuid();
  v_o_cco     uuid := gen_random_uuid();
  v_det       uuid;
  v_det2      uuid;
  v_det3      uuid;
  v_fn_def    text;
  v_b2        uuid := gen_random_uuid();
  v_run       uuid;
begin
  -- ── Fixture, as the table owner (the team block of discovery_rls.sql) ──
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'g7-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_storm, 'g7-storm@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_bob,   'g7-bob@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_cco,   'g7-cco@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    -- A second firm's director and CCO in this tenant, and another tenant's CCO (slice 4's negative reads).
    (v_b2_dir, 'g7-b2-dir@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_b2_cco, 'g7-b2-cco@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_o_cco,  'g7-o-cco@example.test',  jsonb_build_object('tenant_id', v_other_t, 'department', 'compliance'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_other_t);
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'G7 Bank', 'bank');
  -- The director first: company_has_director refuses a bank of members only.
  update users set company_id = v_b, company_role = 'director', firm_role = 'admin' where id = v_admin;
  update users set company_id = v_b, company_role = 'member' where tenant_id = v_t and id not in (v_admin, v_b2_dir, v_b2_cco);
  update users set firm_role = 'cco' where id = v_cco;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'g7.example', 'dwd-reader@proj-17.iam.gserviceaccount.com', '723456789012345678',
     'dir-reader@proj-17.iam.gserviceaccount.com', 'conductia-ingest@g7.example', v_b, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_inv_bob, v_t, 'bob@g7.example', v_admin, v_b, 'member', 'accepted', 'sent', now(), v_bob);
  perform pg_temp.on_deal(v_bob);

  -- Bob opts in; the admin connects deals@ and adds Storm.
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('deals@g7.example', 1);
  reset role;
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_tm := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  select id into v_src_bob from content_sources where tenant_id = v_t and owner_user_id = v_bob;
  if v_tm is null or v_src_tm is null or v_src_bob is null then
    raise exception 'FAIL: the team inbox or Bob''s mailbox source was not created';
  end if;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-g7');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  reset role;

  -- Another tenant's inbox, registered directly (never verified, never allowed anywhere).
  insert into companies (id, tenant_id, name, type) values (v_other_b, v_other_t, 'G7 Other Bank', 'bank');
  update users set company_id = v_other_b, company_role = 'director', firm_role = 'cco' where id = v_o_cco;
  -- A second firm of this tenant, reading through Microsoft, with its own CCO: a firm CCO, but not deals@'s firm.
  insert into companies (id, tenant_id, name, type) values (v_b2, v_t, 'G7 Second Bank', 'bank');
  update users set company_id = v_b2, company_role = 'director' where id = v_b2_dir;
  update users set company_id = v_b2, company_role = 'member', firm_role = 'cco' where id = v_b2_cco;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (v_t, 'g7-second', 'g7-second', 'active', '{g7-second.example}', v_b2);
  insert into team_mailboxes (id, tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
  values (v_other_tm, v_other_t, v_other_b, 'google', 'deals@g7-other.example', v_admin, 1);

  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_team1,  v_t, 'message', 'Project Kestrel: teaser',  '2026-02-03', '<g7-team1@t>',  'g71'),
    (v_shared, v_t, 'message', 'Project Kestrel: kickoff', '2026-02-07', '<g7-shared@t>', 'g72'),
    (v_bob1,   v_t, 'message', 'Project Kestrel: note',    '2026-02-09', '<g7-bob1@t>',   'g73');
  insert into source_item_texts (source_item_id, body_text) values
    (v_team1, 'team1 body'), (v_shared, 'shared body'), (v_bob1, 'bob1 body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_team1, v_src_tm, 't-1'), (v_shared, v_src_tm, 't-2'),
    (v_shared, v_src_bob, 'b-1'), (v_bob1, v_src_bob, 'b-2');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_groups := jsonb_build_array(
    jsonb_build_object(
      'clusterKey', 'codename:kestrel', 'proposedName', 'Project Kestrel', 'codenameGuess', 'Project Kestrel',
      'parties', '[]'::jsonb, 'firstSeenAt', '2026-02-03T00:00:00Z', 'lastSeenAt', '2026-02-09T00:00:00Z', 'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_team1,  'method', 'codename', 'confidence', 0.95),
        jsonb_build_object('sourceItemId', v_shared, 'method', 'codename', 'confidence', 0.95),
        jsonb_build_object('sourceItemId', v_bob1,   'method', 'codename', 'confidence', 0.95))));
  perform discovery_upsert_candidates(v_t, gen_random_uuid(), v_groups);
  select id into v_kestrel from deal_candidates where tenant_id = v_t and cluster_key = 'codename:kestrel';
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_kestrel), 3, 'team: Kestrel has three firm links');
  -- One model event per message (written directly, as discovery_rls.sql does), each under an ok call of its version
  -- for the message's current content, so the current-events rule (20261023130400) counts it.
  insert into model_calls (tenant_id, purpose, model, prompt_version, prompt_hash, source_item_id, content_hash, transport, outcome)
  select v_t, 'milestone_extract', 'm', 'v1', 'x', si.id, si.content_hash, 'recorded', 'ok'
    from source_items si where si.id in (v_team1, v_shared, v_bob1);
  update model_calls set created_at = now() - interval '1 minute' where tenant_id = v_t;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id)
    values (v_t, v_team1, 'teaser_drafted', '2026-02-03', 0, 10, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_team1;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id)
    values (v_t, v_shared, 'kickoff_held', '2026-02-07', 0, 10, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_shared;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id)
    values (v_t, v_bob1, 'kickoff_held', '2026-02-09', 0, 10, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_bob1;
  update model_calls mc set parsed = pg_temp.parsed_like(mc.source_item_id, mc.prompt_version || ':' || mc.model)
   where mc.tenant_id = v_t and mc.outcome = 'ok' and mc.parsed is null;

  -- ── The inputs: one shared row per allowed personal item, one T row per item in T ──
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_shared and team_mailbox_id is null), 1, 'team: a mixed item gives one shared row');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_shared and team_mailbox_id = v_tm), 1, 'team: and one row for its inbox');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_team1 and team_mailbox_id is null), 0, 'team: a team-only item gives no shared row');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_team1 and team_mailbox_id = v_tm), 1, 'team: a team-only item gives its inbox''s row');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_bob1 and team_mailbox_id is null), 1, 'team: a personal-only item gives a shared row');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_bob1 and team_mailbox_id is not null), 0, 'team: and no inbox row');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])), 4,
    'team: four rows in all, two shared and two for the inbox');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel]) where basis is distinct from 'model'), 0,
    'team: every event from a model call has basis model');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_other_t, array[v_kestrel])), 0,
    'team: another tenant is given no input for the candidate');

  -- Deploy skew (audit S2): the shared-only inputs a worker from before 20261023130100 reads keep their shape and
  -- give no team row, so such a worker never feeds team mail into a shared assessment.
  perform pg_temp.expect_text(pg_get_function_result('discovery_assessment_inputs(uuid, uuid[])'::regprocedure),
    'TABLE(candidate_id uuid, source_item_id uuid, event_id uuid, type text, occurred_at date, confidence numeric, extractor_version text, created_at timestamp with time zone)',
    'team: the shared-only inputs keep their shape');
  perform pg_temp.expect((select count(*) from discovery_assessment_inputs(v_t, array[v_kestrel]) where source_item_id = v_team1), 0,
    'team: the shared-only inputs give nothing for a team-only item');
  perform pg_temp.expect((select count(*) from discovery_assessment_inputs(v_t, array[v_kestrel])), 2,
    'team: the shared-only inputs give the two shared rows, one per event');

  -- The latest-row index swap (audit S1): the per-audience index is valid and the old one is gone.
  perform pg_temp.expect((select count(*) from pg_index
                           where indexrelid = to_regclass('public.stage_assessments_audience_latest_idx') and indisvalid), 1,
    'team: the per-audience latest-row index is valid');
  perform pg_temp.expect((select count(*) from pg_class where oid = to_regclass('public.stage_assessments_latest_idx')), 0,
    'team: the old latest-row index is dropped');

  -- Promote first, so every assessment below carries the deal and the admin reads the shared ones as overseer.
  insert into deals (id, tenant_id, code, codename, bank_id) values (v_deal, v_t, 'G7-TEST-1', 'Kestrel', v_b);
  update deal_candidates set promoted_deal_id = v_deal, discovery_state = 'confirmed' where id = v_kestrel;

  -- ── The writer: insert on change per (candidate, audience) ──
  v_assess := jsonb_build_object('stepId', 'p2-s28', 'station', 25, 'lifecycle', 'live', 'reason', 'Kickoff because kickoff held on 9 Feb 2026 (2 emails)',
    'evidenceEventIds', jsonb_build_array(v_ev_shared, v_ev_bob1),
    'confidence', 0.9, 'flags', '[]'::jsonb, 'engineVersion', 'stage-engine/v1', 'basis', 'model');
  v_changed := discovery_record_assessment(v_t, v_kestrel, v_assess, 'extraction');
  if not v_changed then raise exception 'FAIL: team: a first shared assessment was not inserted'; end if;
  v_changed := discovery_record_assessment(v_t, v_kestrel, v_assess, 'extraction', v_tm);
  if not v_changed then raise exception 'FAIL: team: an equal row for another audience was not inserted'; end if;
  v_changed := discovery_record_assessment(v_t, v_kestrel, v_assess, 'rerun', v_tm);
  if v_changed then raise exception 'FAIL: team: an unchanged scoped assessment was inserted again'; end if;
  v_changed := discovery_record_assessment(v_t, v_kestrel, v_assess, 'rerun');
  if v_changed then raise exception 'FAIL: team: an unchanged shared assessment was inserted again'; end if;
  v_changed := discovery_record_assessment(v_t, v_kestrel,
    v_assess || jsonb_build_object('stepId', 'p2-s36', 'station', 33, 'evidenceEventIds', jsonb_build_array(v_ev_team1)), 'extraction', v_tm);
  if not v_changed then raise exception 'FAIL: team: a changed scoped assessment was not inserted'; end if;
  v_changed := discovery_record_assessment(v_t, v_kestrel, v_assess, 'rerun');
  if v_changed then raise exception 'FAIL: team: a scoped change made the shared stream insert again'; end if;
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kestrel and team_mailbox_id is null), 1,
    'team: one shared row');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kestrel and team_mailbox_id = v_tm), 2,
    'team: two scoped rows, one per change');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kestrel and deal_id = v_deal), 3,
    'team: every row carries the promoted deal');
  -- The tombstone trigger of a purge (slice 1c) is accepted, per audience.
  v_changed := discovery_record_assessment(v_t, v_kestrel,
    jsonb_build_object('stepId', null, 'station', null, 'lifecycle', null, 'reason', 'No milestones extracted yet',
      'evidenceEventIds', '[]'::jsonb, 'confidence', 0, 'flags', '[]'::jsonb, 'engineVersion', 'stage-engine/v1'), 'purge', v_tm);
  if not v_changed then raise exception 'FAIL: team: a purge tombstone was not inserted'; end if;
  -- The audit: ids and codes, with the audience on a scoped row only.
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.stage_assessed'
      and detail->>'teamMailboxId' = v_tm::text), 3, 'team: each scoped row is audited with its inbox');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.stage_assessed'
      and detail->>'teamMailboxId' = v_tm::text and detail->>'basis' = 'model'), 2, 'team: and with its basis when given');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.stage_assessed'
      and not (detail ? 'teamMailboxId')), 1, 'team: the shared row''s audit names no inbox');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.stage_assessed'
      and detail->>'trigger' = 'purge' and not (detail ? 'basis')), 1, 'team: a row given no basis is audited without one');

  -- Refusals: an inbox not allowed in the tenant, another tenant's inbox, an unknown basis.
  v_blocked := false;
  begin perform discovery_record_assessment(v_t, v_kestrel, v_assess, 'extraction', gen_random_uuid());
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: team: the writer took an inbox that does not exist'; end if;
  v_blocked := false;
  begin perform discovery_record_assessment(v_t, v_kestrel, v_assess, 'extraction', v_other_tm);
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: team: the writer took another tenant''s inbox'; end if;
  v_blocked := false;
  begin perform discovery_record_assessment(v_t, v_kestrel, v_assess || '{"basis":"guess","stepId":"p1-s12"}'::jsonb, 'extraction');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: team: the writer took an unknown basis'; end if;
  -- The composite reference: a row of this tenant cannot name another tenant's inbox, even written directly.
  v_blocked := false;
  begin
    insert into stage_assessments (tenant_id, candidate_id, reason_text, confidence, engine_version, trigger, team_mailbox_id)
    values (v_t, v_kestrel, 'x', 0, 'x', 'rerun', v_other_tm);
  exception when foreign_key_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: team: an assessment of one tenant named another tenant''s inbox'; end if;
  v_blocked := false;
  begin
    insert into corrections (tenant_id, candidate_id, actor_id, action, deal_id, team_mailbox_id)
    values (v_t, v_kestrel, v_storm, 'dismiss_suggestion', v_deal, v_other_tm);
  exception when foreign_key_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: team: a correction of one tenant named another tenant''s inbox'; end if;
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kestrel), 4, 'team: the refusals wrote nothing');

  -- ── Reads: a scoped row (and a scoped dismissal) is read by its inbox's audience alone (slice 4, 20261023130700) ──
  -- One more scoped row, written directly as the table owner, and a shared and a scoped dismissal.
  insert into stage_assessments (tenant_id, candidate_id, step_id, station, lifecycle_suggestion, reason_text,
                                 evidence_event_ids, confidence, engine_version, trigger, team_mailbox_id)
  values (v_t, v_kestrel, 'p2-s36', 33, 'live', 'Teaser because teaser drafted on 3 Feb 2026 (1 email)',
          array[v_ev_team1], 0.9, 'stage-engine/v1', 'extraction', v_tm);
  insert into corrections (tenant_id, candidate_id, actor_id, action, deal_id, reason) values
    (v_t, v_kestrel, v_storm, 'dismiss_suggestion', v_deal, 'shared dismissal');
  insert into corrections (tenant_id, candidate_id, actor_id, action, deal_id, reason, team_mailbox_id) values
    (v_t, v_kestrel, v_storm, 'dismiss_suggestion', v_deal, 'scoped dismissal', v_tm);
  select count(*) into v_shared_n from stage_assessments where candidate_id = v_kestrel and team_mailbox_id is null;
  perform pg_temp.expect(v_shared_n, 1, 'team: the shared stream holds one row');
  select count(*) into v_scoped_n from stage_assessments where candidate_id = v_kestrel and team_mailbox_id = v_tm;

  set local role authenticated;
  -- The inbox's reader and the CCO of its firm read every scoped row and the scoped dismissal, and every id a row
  -- they read cites resolves for them (assessmentsKeepInviteOnly: cited minus resolved is 0).
  foreach v_persona in array array[v_storm, v_cco] loop
    perform pg_temp.act_as(v_persona);
    perform pg_temp.expect((select count(*) from stage_assessments where team_mailbox_id = v_tm), v_scoped_n,
      'team: the inbox''s audience reads every scoped assessment (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from corrections where team_mailbox_id = v_tm), 1,
      'team: and the scoped dismissal (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from stage_assessments sa cross join unnest(sa.evidence_event_ids) e
                            where sa.candidate_id = v_kestrel and not exists (select 1 from milestone_events m where m.id = e)), 0,
      'team: every cited id resolves (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kestrel and team_mailbox_id is null), v_shared_n,
      'team: the shared row stays readable (persona ' || v_persona || ')');
  end loop;
  -- A colleague who is not a reader, and the firm admin, read the shared rows only.
  foreach v_persona in array array[v_bob, v_admin] loop
    perform pg_temp.act_as(v_persona);
    perform pg_temp.expect((select count(*) from stage_assessments where team_mailbox_id is not null), 0,
      'team: no scoped assessment is readable outside the inbox''s audience (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from corrections where team_mailbox_id is not null), 0,
      'team: no scoped dismissal is readable outside it (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kestrel), v_shared_n,
      'team: the shared row stays readable (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from corrections where candidate_id = v_kestrel and reason = 'shared dismissal'), 1,
      'team: the shared dismissal stays readable (persona ' || v_persona || ')');
  end loop;
  -- At the policy level, so a rewrite of the reader view or a tenant-wide CCO branch cannot widen it silently: the CCO
  -- of another firm of this tenant (a firm CCO, but not deals@'s firm) and another tenant's CCO read no scoped row.
  reset role;
  perform pg_temp.expect_text(app_is_firm_cco(v_t, v_b2_cco)::text, 'true', 'team: the second firm''s CCO is a firm CCO of the tenant');
  set local role authenticated;
  foreach v_persona in array array[v_b2_cco, v_o_cco] loop
    perform pg_temp.act_as(v_persona);
    perform pg_temp.expect((select count(*) from stage_assessments where team_mailbox_id is not null), 0,
      'team: another firm''s or tenant''s CCO reads no scoped assessment (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from corrections where team_mailbox_id is not null), 0,
      'team: nor a scoped dismissal (persona ' || v_persona || ')');
  end loop;
  perform pg_temp.act_as(v_o_cco);
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kestrel), 0,
    'team: another tenant''s CCO reads no row of the candidate at all');
  -- A removed reader reads nothing scoped at once; added again, they read it again (no job in between).
  perform pg_temp.act_as(v_admin);
  perform discovery_remove_team_mailbox_member(v_tm, v_storm);
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect((select count(*) from stage_assessments where team_mailbox_id is not null), 0,
    'team: a removed reader reads no scoped assessment');
  perform pg_temp.expect((select count(*) from corrections where team_mailbox_id is not null), 0,
    'team: nor the scoped dismissal');
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect((select count(*) from stage_assessments where team_mailbox_id = v_tm), v_scoped_n,
    'team: added again, the reader reads the scoped assessments again');
  reset role;

  raise notice 'PASS: the team audience: inputs per audience, the writer per audience, scoped rows read by their inbox''s audience';

  -- ── One rule for an item's current events (#173 G-07 slice 2a, 20261023130400) ──
  -- discovery_current_event_ids: the latest ok model call for the item's current content decides, even with no
  -- event; rule events count only through an approved firm, and no firm is approved yet. The inputs and the
  -- signed-in read discovery_item_current_events both go through it.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_team1, null)::text, 'false', 'current: no firm approves rules for the shared audience');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_team1, v_tm)::text, 'false', 'current: no firm approves rules for an inbox');
  perform pg_temp.expect_text((select string_agg(basis || ':' || (event_id = v_ev_shared)::text, ',') from discovery_current_event_ids(v_t, v_shared, null)),
    'model:true', 'current: a mixed item''s model event is current for the shared audience');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, v_tm) where event_id = v_ev_shared), 1,
    'current: and for its inbox');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_other_t, v_shared, null)), 0,
    'current: an item outside the tenant has no current event');
  -- A newer invalid call does not displace the ok one; an edit of the content does, until it is answered again.
  perform discovery_record_extraction(v_t, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'm3', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_shared, 'content_hash', 'g72', 'transport', 'recorded', 'outcome', 'invalid',
      'error_code', 'schema', 'attempt', 1), '[]'::jsonb);
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null)), 1,
    'current: a newer invalid call leaves the ok call''s events current');
  update source_items set content_hash = 'g72-edited' where id = v_shared;
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null)), 0,
    'current: edited content has no ok call yet, so no current event');
  update source_items set content_hash = 'g72' where id = v_shared;
  perform pg_temp.expect_text(pg_get_function_result('discovery_item_current_events(uuid[])'::regprocedure),
    'TABLE(item_id uuid, event_id uuid, basis text)', 'current: the read answers ids and a basis only');

  -- The read, bound to the caller: only items app_can_see_item admits for auth.uid(), never another person's view.
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_team1, v_shared])
      where (item_id, event_id) in ((v_team1, v_ev_team1), (v_shared, v_ev_shared)) and basis = 'model'), 2,
    'current: the member reads the team-only and the mixed item''s current events');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_team1])), 0,
    'current: a non-member asking for a team-only item gets nothing');
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_shared, v_bob1])), 2,
    'current: the non-member reads their own items'' current events');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_team1, v_shared, v_bob1])), 0,
    'current: the firm admin reads no item, so no current event');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(distinct item_id) from discovery_item_current_events(array[v_team1, v_shared, v_bob1])), 3,
    'current: the control room reads every item''s current events');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_team1, v_shared, v_bob1])), 0,
    'current: with no signed-in caller the read answers nothing');
  v_blocked := false;
  set local role anon;
  begin perform 1 from discovery_item_current_events(array[v_shared]); exception when insufficient_privilege then v_blocked := true; end;
  reset role;
  if not v_blocked then raise exception 'FAIL: current: anon ran discovery_item_current_events'; end if;
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  v_blocked := false;
  begin perform 1 from discovery_current_event_ids(v_t, v_shared, null); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: current: authenticated ran discovery_current_event_ids'; end if;
  v_blocked := false;
  begin perform discovery_rule_firm_ok(v_t, v_shared, null); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: current: authenticated ran discovery_rule_firm_ok'; end if;
  reset role;

  -- The zero-event case: Bob's item had a kickoff under model m; a later ok call under model m2 found nothing.
  -- That answer is current, so the item feeds no assessment and shows no milestone, though its event is stored.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel]) where source_item_id = v_bob1), 1,
    'current: before the new answer, Bob''s item gives its shared row');
  perform discovery_record_extraction(v_t, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'm2', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_bob1, 'content_hash', 'g73', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 1), '[]'::jsonb);
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel]) where source_item_id = v_bob1), 0,
    'current: an ok zero-event answer under a new model leaves the item nothing in the inputs');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_bob1, null)), 0,
    'current: and nothing current');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel]) where source_item_id <> v_bob1), 3,
    'current: the other items'' inputs are unchanged');
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = v_bob1), 1,
    'current: Bob still reads the stored event');
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_bob1])), 0,
    'current: but the read names it no longer');
  reset role;

  -- ── Zero means zero on a same-version re-extract (audit S4) ──
  -- The mixed item's content changes and the same prompt and model answer again. The earlier answer's kickoff
  -- stays stored (on conflict do nothing keys on the version, not the call), so only the chosen call's own answer
  -- can say which events are current.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update source_items set content_hash = 'g72-s4a' where id = v_shared;
  perform discovery_record_extraction(v_t, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'm', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_shared, 'content_hash', 'g72-s4a', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 1), '[]'::jsonb);
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null)), 0,
    'current: a same-version answer that finds nothing for edited content names no event');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel]) where source_item_id = v_shared), 0,
    'current: so the edited item feeds no audience''s inputs');
  update source_items set content_hash = 'g72-s4b' where id = v_shared;
  perform discovery_record_extraction(v_t, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'm', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_shared, 'content_hash', 'g72-s4b', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 1),
    jsonb_build_array(jsonb_build_object('type', 'kickoff_held', 'occurred_at', '2026-02-07', 'span_start', 0, 'span_end', 10, 'confidence', 0.9),
                      jsonb_build_object('type', 'teaser_drafted', 'occurred_at', '2026-02-08', 'span_start', 20, 'span_end', 30, 'confidence', 0.9)));
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null) where event_id = v_ev_shared), 1,
    'current: an answer that finds the same event again keeps the stored row current');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null)), 2,
    'current: and adds the one it found anew');
  update source_items set content_hash = 'g72-s4c' where id = v_shared;
  perform discovery_record_extraction(v_t, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'm', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_shared, 'content_hash', 'g72-s4c', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 1),
    jsonb_build_array(jsonb_build_object('type', 'teaser_drafted', 'occurred_at', '2026-02-08', 'span_start', 20, 'span_end', 30, 'confidence', 0.9)));
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null) where event_id = v_ev_shared), 0,
    'current: an answer that no longer finds an event drops it, though the row is stored');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null)), 1,
    'current: and names only what it found');
  -- Back to the fixture's content: its own ok call (the kickoff alone) decides again.
  update source_items set content_hash = 'g72' where id = v_shared;
  perform pg_temp.expect_text((select string_agg(event_id::text, ',') from discovery_current_event_ids(v_t, v_shared, null)),
    v_ev_shared::text, 'current: the original content''s answer names its kickoff alone again');

  -- ── Milestone rules behind the per-firm approval (#173 G-07 slice 3b, 20261023130600) ──
  -- The real approval test, batch, writer and ledger. Approvals are written as the table's owner, as a reviewed
  -- migration would, and the transaction rolls them back.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_shared, null)::text, 'false', 'rules: no approval, no shared audience');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_team1, v_tm)::text, 'false', 'rules: no approval, no team audience');
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50)), 0, 'rules: no approval, an empty batch');
  v_blocked := false;
  begin
    perform discovery_record_detection(v_t, jsonb_build_object('source_item_id', v_team1, 'content_hash', 'g71', 'rules_version', 'rules/v1'), '[]'::jsonb);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: rules: the writer recorded a detection with no approval'; end if;

  -- Another firm of the tenant, or another capability of this firm, lights none of this firm's sources.
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_b2, 'milestone_rules', 'g7-test-other-firm'), (v_t, v_b, 'team_proposals', 'g7-test-other-capability');
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50)), 0,
    'rules: another firm''s approval, or another capability''s, lights none of this firm''s sources');

  -- This firm approved: each audience counts through its own source's firm.
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_b, 'milestone_rules', 'g7-test');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_team1, v_tm)::text, 'true', 'rules: the approved firm''s inbox counts');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_team1, null)::text, 'false', 'rules: a team-only item has no shared audience to approve');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_bob1, null)::text, 'true', 'rules: a seated banker''s mailbox of the firm counts for the shared audience');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_bob1, v_tm)::text, 'false', 'rules: an item outside the inbox has no team audience in it');
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50)), 3, 'rules: the batch is the three live-linked messages');
  perform pg_temp.expect_text((select team_mailbox_ids::text from discovery_detect_batch(v_t, 'rules/v1', 50) where item_id = v_team1),
    array[v_tm]::text, 'rules: the team-only item names its approved inbox');
  perform pg_temp.expect_text((select team_mailbox_ids::text from discovery_detect_batch(v_t, 'rules/v1', 50) where item_id = v_bob1),
    '{}', 'rules: the personal-only item names no inbox');
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_other_t, 'rules/v1', 50)), 0, 'rules: another tenant''s batch is empty');

  -- A detection of content no model has answered: one ledger row, its event and one audit row, settled once.
  update source_items set content_hash = 'g71-rules' where id = v_team1;
  v_det := discovery_record_detection(v_t, jsonb_build_object('source_item_id', v_team1, 'content_hash', 'g71-rules', 'rules_version', 'rules/v1'),
    jsonb_build_array(jsonb_build_object('type', 'loi_signed', 'occurred_at', '2026-03-02', 'span_start', 0, 'span_end', 10, 'confidence', 0.5)));
  select id into v_ev_rule from milestone_events where detection_id = v_det;
  perform pg_temp.expect((select count(*) from milestone_events where detection_id = v_det and model_call_id is null and extractor_version = 'rules/v1'), 1,
    'rules: the writer stores one rule event under its detection');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.milestone_detected'
      and detail->>'detectionId' = v_det::text and (detail->>'eventCount')::int = 1 and detail->>'rulesVersion' = 'rules/v1'), 1,
    'rules: one audit row with ids, a count and the version');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.milestone_detected'
      and detail::text ~* '(body|loi|letter)'), 0, 'rules: the audit detail holds no text');
  perform pg_temp.expect_text(discovery_record_detection(v_t, jsonb_build_object('source_item_id', v_team1, 'content_hash', 'g71-rules', 'rules_version', 'rules/v1'),
      '[]'::jsonb)::text, v_det::text, 'rules: a settled detection answers its own id again');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.milestone_detected'), 1,
    'rules: and writes no second audit row');
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50) where item_id = v_team1), 0,
    'rules: a settled item leaves the batch');

  -- The rule event counts for deals@'s audience alone, and reaches the inputs as that audience's rules row.
  perform pg_temp.expect_text((select string_agg(basis || ':' || (event_id = v_ev_rule)::text, ',') from discovery_current_event_ids(v_t, v_team1, v_tm)),
    'rules:true', 'rules: the rule event is current for the approved inbox');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_team1, null)), 0, 'rules: and not for the shared audience');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_team1 and team_mailbox_id = v_tm and basis = 'rules'), 1, 'rules: the inputs carry it for deals@ alone');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel])
      where source_item_id = v_team1 and team_mailbox_id is null), 0, 'rules: never as a shared row');

  -- A model answer for the same content beats the rule event, even one that found nothing.
  perform discovery_record_extraction(v_t, jsonb_build_object(
      'purpose', 'milestone_extract', 'model', 'm', 'prompt_version', 'v1', 'prompt_hash', 'x',
      'source_item_id', v_team1, 'content_hash', 'g71-rules', 'transport', 'recorded', 'outcome', 'ok', 'attempt', 1), '[]'::jsonb);
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_team1, v_tm)), 0,
    'rules: an ok zero-event model answer for the same content leaves the rule event nothing');

  -- New content detected again: the same rule finds the same event (one stored row, kept by on conflict do nothing),
  -- and the newer detection's own answer makes it current.
  update source_items set content_hash = 'g71-rules-b' where id = v_team1;
  v_det2 := discovery_record_detection(v_t, jsonb_build_object('source_item_id', v_team1, 'content_hash', 'g71-rules-b', 'rules_version', 'rules/v1'),
    jsonb_build_array(jsonb_build_object('type', 'loi_signed', 'occurred_at', '2026-03-02', 'span_start', 0, 'span_end', 10, 'confidence', 0.5)));
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = v_team1 and extractor_version = 'rules/v1'), 1,
    'rules: the same rule event is stored once');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_team1, v_tm) where event_id = v_ev_rule), 1,
    'rules: the newer detection''s answer names it current again');

  -- An edit that moves the date at the same offset moves the event's date (audit round on #753): the rule event takes
  -- the newest detection's date and names that detection. Undoing the edit re-detects the earlier content, and its
  -- date comes back. The model event of the same item, under its own version, is never touched.
  update source_items set content_hash = 'g71-rules-d' where id = v_team1;
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50) where item_id = v_team1), 1,
    'rules: edited content is detected again');
  v_det3 := discovery_record_detection(v_t, jsonb_build_object('source_item_id', v_team1, 'content_hash', 'g71-rules-d', 'rules_version', 'rules/v1'),
    jsonb_build_array(jsonb_build_object('type', 'loi_signed', 'occurred_at', '2026-03-05', 'span_start', 0, 'span_end', 10, 'confidence', 0.5)));
  perform pg_temp.expect_text((select occurred_at::text || '|' || (detection_id = v_det3)::text from milestone_events where id = v_ev_rule),
    '2026-03-05|true', 'rules: the edit''s date replaces the old one on the same event, under the newest detection');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_team1, v_tm) where event_id = v_ev_rule), 1,
    'rules: and that event is current');
  update source_items set content_hash = 'g71-rules-b' where id = v_team1;
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50) where item_id = v_team1), 1,
    'rules: content edited back to an earlier version is detected again');
  perform pg_temp.expect_text(discovery_record_detection(v_t, jsonb_build_object('source_item_id', v_team1, 'content_hash', 'g71-rules-b', 'rules_version', 'rules/v1'),
      jsonb_build_array(jsonb_build_object('type', 'loi_signed', 'occurred_at', '2026-03-02', 'span_start', 0, 'span_end', 10, 'confidence', 0.5)))::text,
    v_det2::text, 'rules: and its earlier detection is renewed, not duplicated');
  perform pg_temp.expect_text((select occurred_at::text from milestone_events where id = v_ev_rule), '2026-03-02',
    'rules: the earlier content''s date comes back');
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50) where item_id = v_team1), 0,
    'rules: and the item is settled again');
  perform pg_temp.expect_text((select occurred_at::text || '|' || (model_call_id is not null)::text from milestone_events where id = v_ev_team1),
    '2026-02-03|true', 'rules: the item''s model event keeps its own date and origin');

  -- One run's pass over a team inbox: ids and counts, for an allowed inbox of the tenant only.
  v_run := gen_random_uuid();
  perform discovery_record_team_detection_pass(v_t, v_tm, v_run, '{"items": 1, "events": 1}'::jsonb);
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_milestones_detected'
      and detail->>'runId' = v_run::text and detail->>'teamMailboxId' = v_tm::text
      and (detail->>'items')::int = 1 and (detail->>'events')::int = 1), 1, 'rules: one pass row per inbox per run');
  v_blocked := false;
  begin perform discovery_record_team_detection_pass(v_t, v_other_tm, v_run, '{"items": 1, "events": 0}'::jsonb);
  exception when invalid_parameter_value then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: rules: a pass was recorded for another tenant''s inbox'; end if;
  v_blocked := false;
  begin perform discovery_record_team_detection_pass(v_t, v_tm, v_run, '{"items": -1, "events": 0}'::jsonb);
  exception when invalid_parameter_value then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: rules: a pass with a negative count was recorded'; end if;

  -- Exactly one origin per event: a model call or a detection, never both and never neither.
  v_blocked := false;
  begin
    insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version)
      values (v_t, v_team1, 'signed', '2026-03-03', 20, 30, 0.5, 'rules/v1');
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: rules: an event with no origin was stored'; end if;
  v_blocked := false;
  begin
    insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version,
                                  model_call_id, detection_id)
      values (v_t, v_team1, 'signed', '2026-03-03', 20, 30, 0.5, 'rules/v1', gen_random_uuid(), v_det2);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: rules: an event with two origins was stored'; end if;

  -- The revoke: the row is revoked, never deleted. Rule events stop counting at once and the writer refuses.
  update discovery_tenant_approvals set revoked_at = now()
   where tenant_id = v_t and firm_company_id = v_b and capability = 'milestone_rules';
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_team1, v_tm)), 0, 'rules: after the revoke the rule event is not current');
  perform pg_temp.expect((select count(*) from discovery_audience_assessment_inputs(v_t, array[v_kestrel]) where source_item_id = v_team1), 0,
    'rules: and leaves the inputs');
  perform pg_temp.expect((select count(*) from discovery_detect_batch(v_t, 'rules/v1', 50)), 0, 'rules: the batch is empty again');
  update source_items set content_hash = 'g71-rules-c' where id = v_team1;
  v_blocked := false;
  begin
    perform discovery_record_detection(v_t, jsonb_build_object('source_item_id', v_team1, 'content_hash', 'g71-rules-c', 'rules_version', 'rules/v1'), '[]'::jsonb);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: rules: the writer recorded a detection after the revoke'; end if;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.tenant_approval_changed'
      and detail->>'capability' = 'milestone_rules' and detail->>'on' = 'false'), 1, 'rules: the revoke is audited');
  update source_items set content_hash = 'g71' where id = v_team1;

  -- ── A team audience's rule events reach that audience only (audit S5) ──
  -- The fixture is one firm, so a real approval lights the shared and the team audience together. To show the read
  -- keeps them apart, the approval test is replaced here, inside this rolled-back transaction, by one that holds for
  -- one audience, named in a setting; the ledger and the rule event are the real ones (slice 3b). The mixed item gets
  -- content no model has answered, so the rules decide, and one rule event is detected.
  -- The real definition is kept and restored at the end of this section, so later sections test the real rule.
  v_fn_def := pg_get_functiondef('discovery_rule_firm_ok(uuid, uuid, uuid)'::regprocedure);
  create or replace function discovery_rule_firm_ok(p_tenant_id uuid, p_item_id uuid, p_team_mailbox_id uuid)
  returns boolean language sql stable security definer set search_path = public, pg_temp as $f$
    select coalesce(p_team_mailbox_id::text, 'shared') = current_setting('g7.approved_audience', true);
  $f$;
  update source_items set content_hash = 'g72-rules' where id = v_shared;
  insert into milestone_detections (tenant_id, source_item_id, content_hash, rules_version, events, parsed)
    values (v_t, v_shared, 'g72-rules', 'rules/v1', 1, jsonb_build_array(jsonb_build_object('type', 'loi_signed', 'span_start', 40)))
    returning id into v_det;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, detection_id)
    values (v_t, v_shared, 'loi_signed', '2026-03-02', 40, 60, 0.5, 'rules/v1', v_det) returning id into v_ev_rule;
  perform set_config('g7.approved_audience', v_tm::text, true);
  perform pg_temp.expect_text((select string_agg(basis || ':' || (event_id = v_ev_rule)::text, ',') from discovery_current_event_ids(v_t, v_shared, v_tm)),
    'rules:true', 'rules: deals@''s approval makes the rule event current for deals@''s audience');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_shared, null)), 0,
    'rules: and for no other audience');
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_shared]) where event_id = v_ev_rule), 1,
    'rules: a reader of deals@ reads the rule event');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_shared]) where event_id = v_ev_rule), 1,
    'rules: the CCO of deals@''s firm reads it');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_shared])), 0,
    'rules: a banker who sees the mixed item through their own mailbox, outside deals@, never reads deals@''s rule event');
  reset role;
  perform set_config('g7.approved_audience', 'shared', true);
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from discovery_item_current_events(array[v_shared]) where event_id = v_ev_rule), 1,
    'rules: once the shared audience''s firm approves, the same banker reads it as a shared event');
  reset role;
  update source_items set content_hash = 'g72' where id = v_shared;
  execute v_fn_def;  -- the real approval test again


  raise notice 'PASS: one rule for an item''s current events: model beats rules, zero means zero, the read is caller-bound';

  -- ── Team access per item (#173 G-07 slice 2b, 20261023130500) ──
  -- discovery_item_team_access: team is true where the caller reads the item through a team inbox they are a member
  -- of and through no mailbox of their own. Bound to the caller like the reads above; ids and a flag only.
  perform pg_temp.expect_text(pg_get_function_result('discovery_item_team_access(uuid[])'::regprocedure),
    'TABLE(item_id uuid, team boolean)', 'team access: the read answers ids and a flag only');
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text((select string_agg(case item_id when v_team1 then 'team1' when v_shared then 'shared' else 'bob1' end
        || ':' || team::text, ',' order by item_id = v_bob1, item_id = v_shared)
      from discovery_item_team_access(array[v_team1, v_shared, v_bob1])),
    'team1:true,shared:true,bob1:false',
    'team access: the member reads team-only mail and mail held also by a colleague as team mail, a colleague''s own mail as not');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from discovery_item_team_access(array[v_team1])), 0,
    'team access: a non-member asking for a team-only item gets nothing');
  perform pg_temp.expect((select count(*) from discovery_item_team_access(array[v_shared, v_bob1]) where not team), 2,
    'team access: the non-member''s own mail, mixed or not, is not team mail');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from discovery_item_team_access(array[v_team1, v_shared, v_bob1])), 3,
    'team access: the control room is answered for every item');
  perform pg_temp.expect((select count(*) from discovery_item_team_access(array[v_team1, v_shared, v_bob1]) where team), 0,
    'team access: and none of it is team mail it reads as a member');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from discovery_item_team_access(array[v_team1, v_shared, v_bob1])), 0,
    'team access: the firm admin reads no item, so is answered nothing');
  -- A member who also holds the message in their own mailbox reads it as their own mail.
  perform discovery_add_team_mailbox_member(v_tm, v_bob);
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text((select string_agg(team::text, ',' order by item_id = v_shared) from discovery_item_team_access(array[v_team1, v_shared])),
    'true,false', 'team access: once a member, Bob reads team-only mail as team mail and his own copy as his own');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect((select count(*) from discovery_item_team_access(array[v_team1, v_shared, v_bob1])), 0,
    'team access: with no signed-in caller the read answers nothing');
  v_blocked := false;
  set local role anon;
  begin perform 1 from discovery_item_team_access(array[v_shared]); exception when insufficient_privilege then v_blocked := true; end;
  reset role;
  if not v_blocked then raise exception 'FAIL: team access: anon ran discovery_item_team_access'; end if;

  -- Once the inbox is refused, its former reader and its firm's CCO read no scoped row and no scoped dismissal: the
  -- reader test admits an allowed inbox only (slice 4). Last, because the inbox stays refused.
  perform pg_temp.expect((select count(*) from stage_assessments where team_mailbox_id = v_tm), v_scoped_n,
    'team: before the refusal the scoped rows are there');
  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'group');
  set local role authenticated;
  foreach v_persona in array array[v_storm, v_cco] loop
    perform pg_temp.act_as(v_persona);
    perform pg_temp.expect((select count(*) from stage_assessments where team_mailbox_id is not null), 0,
      'team: a refused inbox''s former audience reads no scoped assessment (persona ' || v_persona || ')');
    perform pg_temp.expect((select count(*) from corrections where team_mailbox_id is not null), 0,
      'team: nor its scoped dismissal (persona ' || v_persona || ')');
  end loop;
  reset role;

  raise notice 'PASS: team access per item: team mail is the member''s alone, own mail wins, the read is caller-bound';
end $$;

-- ── Milestone rules across two firms of one tenant (#173 G-07 slice 3b, audit round on #753) ──
-- Firm A reads through Google and firm B through Microsoft, each with a banker whose own mailbox is allowed. A rule
-- event lights the shared audience only when every firm that holds the message is approved: the shared audience's
-- readers include every holder's firm, so an unapproved firm's bankers never read a rule event through it.
--   Ann  a banker of firm A (Google), holds m-a and m-ab
--   Ben  a banker of firm B (Microsoft), holds m-ab
do $$
declare
  v_t      uuid := gen_random_uuid();
  v_fa     uuid := gen_random_uuid();
  v_fb     uuid := gen_random_uuid();
  v_a_dir  uuid := gen_random_uuid();
  v_b_dir  uuid := gen_random_uuid();
  v_ann    uuid := gen_random_uuid();
  v_ben    uuid := gen_random_uuid();
  v_src_a  uuid;
  v_src_b  uuid;
  v_m_a    uuid := gen_random_uuid();
  v_m_ab   uuid := gen_random_uuid();
  v_det    uuid;
  v_item   uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_a_dir, 'g7f-a-dir@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_b_dir, 'g7f-b-dir@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_ann,   'g7f-ann@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_ben,   'g7f-ben@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id = v_t;
  insert into companies (id, tenant_id, name, type) values (v_fa, v_t, 'G7F Bank A', 'bank'), (v_fb, v_t, 'G7F Bank B', 'bank');
  -- The directors first: company_has_director refuses a bank of members only.
  update users set company_id = v_fa, company_role = 'director' where id = v_a_dir;
  update users set company_id = v_fb, company_role = 'director' where id = v_b_dir;
  update users set company_id = v_fa, company_role = 'member' where id = v_ann;
  update users set company_id = v_fb, company_role = 'member' where id = v_ben;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'g7a.example', 'dwd-reader@proj-71.iam.gserviceaccount.com', '723456789012345671',
     'dir-reader@proj-71.iam.gserviceaccount.com', 'conductia-ingest@g7a.example', v_fa, 'active', now());
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (v_t, 'g7f-fixture', 'g7f-fixture', 'active', '{g7b.example}', v_fb);
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status, accepted_at, accepted_user_id)
  values (v_t, 'ann@g7a.example', v_a_dir, v_fa, 'member', 'accepted', 'sent', now(), v_ann),
         (v_t, 'ben@g7b.example', v_b_dir, v_fb, 'member', 'accepted', 'sent', now(), v_ben);
  perform pg_temp.on_deal(v_ann);
  perform pg_temp.on_deal(v_ben);
  set local role authenticated;
  perform pg_temp.act_as(v_ann);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_ben);
  perform mailbox_consent_grant();
  reset role;
  select id into v_src_a from content_sources where tenant_id = v_t and owner_user_id = v_ann;
  select id into v_src_b from content_sources where tenant_id = v_t and owner_user_id = v_ben;
  if v_src_a is null or v_src_b is null then raise exception 'FAIL: firms: a banker''s mailbox source was not created'; end if;
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 2, 'firms: both bankers'' mailboxes are allowed');
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_m_a,  v_t, 'message', 'Project Wren: LOI',      '2026-03-02', '<g7f-m-a@t>',  'g7f-a'),
    (v_m_ab, v_t, 'message', 'Project Wren: LOI (cc)', '2026-03-02', '<g7f-m-ab@t>', 'g7f-ab');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_m_a, v_src_a, 'a-1'), (v_m_ab, v_src_a, 'a-2'), (v_m_ab, v_src_b, 'b-1');
  -- One rule event on each message, under a detection of its current content (written as the table owner).
  foreach v_item in array array[v_m_a, v_m_ab] loop
    insert into milestone_detections (tenant_id, source_item_id, content_hash, rules_version, events, parsed)
      select v_t, si.id, si.content_hash, 'rules/v1', 1, jsonb_build_array(jsonb_build_object('type', 'loi_signed', 'span_start', 0))
      from source_items si where si.id = v_item
      returning id into v_det;
    insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, detection_id)
      values (v_t, v_item, 'loi_signed', '2026-03-02', 0, 10, 0.5, 'rules/v1', v_det);
  end loop;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Firm A alone approved: its own message counts; the message firm B also holds does not.
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (v_t, v_fa, 'milestone_rules', 'g7f-a');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_m_a, null)::text, 'true', 'firms: A approved, A''s own message counts');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_m_a, null)), 1, 'firms: and its rule event is current');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_m_ab, null)::text, 'false',
    'firms: A approved and B not, the message both hold lights nothing in the shared audience');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_m_ab, null)), 0, 'firms: and its rule event is not current');
  -- Both approved: it counts.
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (v_t, v_fb, 'milestone_rules', 'g7f-b');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_m_ab, null)::text, 'true', 'firms: both approved, the shared message counts');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_m_ab, null)), 1, 'firms: and its rule event is current');
  -- A revoked: both messages stop.
  update discovery_tenant_approvals set revoked_at = now() where tenant_id = v_t and firm_company_id = v_fa and capability = 'milestone_rules';
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_m_a, null)::text, 'false', 'firms: A revoked, A''s message stops');
  perform pg_temp.expect_text(discovery_rule_firm_ok(v_t, v_m_ab, null)::text, 'false', 'firms: and so does the one both hold');
  perform pg_temp.expect((select count(*) from discovery_current_event_ids(v_t, v_m_a, null)) + (select count(*) from discovery_current_event_ids(v_t, v_m_ab, null)), 0,
    'firms: no rule event is current after the revoke');

  raise notice 'PASS: milestone rules across two firms: the shared audience counts only when every holding firm is approved';
end $$;

rollback;
