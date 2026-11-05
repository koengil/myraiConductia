-- Demo only (#460), 20261014120000_discovery_model_proposals.sql: who reads
-- the proposal rows, what the one writer accepts, how a repeat answer and two
-- messages with one text are stored, and that the writer stays closed to
-- signed-in roles. Read as each user under the authenticated role.
--
--   Alice      owns the mailbox the proposals were read from
--   Colleague  has a mailbox of their own, with no proposals
--   CCO        the control room of the tenant (owner-only: sees nothing)
--   Admin      a firm admin
--   Outsider   the control room of another tenant
--
-- The next block (G-01 #173, 20261023110000) is the per-source barrier: what a source's prompt may
-- name (T6, the CCO, an owner's second source, withdrawal, the team branch, an ownerless source) and
-- the frozen signatures. It builds its own tenant. The next (20261023110100) is the shared
-- tenant approvals table: its closed capability list, owner-only audited writes, no delete or
-- truncate, frozen keys and the per-capability reader. G-07 and G-09 append their own cases there. The block after it
-- (20261023110200) is the team pass: the begin matrix, idempotence, concurrency and lapse, renew, end, roles and
-- signatures. It builds its own tenant. The last (20261023110300) is the team readers: who reads a team inbox's
-- proposals, the passless rows, the caller binding of both helpers and the writer's team branch. It builds its own tenant.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_model_proposals.sql
-- Everything rolls back. Deleted with the step when #459 lands.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does and give it a live session whose id is the user id.
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

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user, 'role', 'authenticated')::text, true);
$$;
-- Seats a user on a deal of their tenant (#262: the opt-in needs MD or deal team on a deal of the tenant).
create function pg_temp.on_deal(p_user uuid)
returns void language plpgsql as $$
declare
  v_tenant uuid;
  v_company uuid;
  v_deal uuid;
begin
  select tenant_id, company_id into v_tenant, v_company from users where id = p_user;
  select id into v_deal from deals where code = 'mp-' || v_tenant::text;
  if v_deal is null then
    insert into deals (tenant_id, code, codename, bank_id)
    values (v_tenant, 'mp-' || v_tenant::text, 'Proposal fixture', v_company) returning id into v_deal;
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values (v_deal, p_user, (select id from roles where slug = 'deal_team'), 'deal_team')
  on conflict (deal_id, user_id) do nothing;
end;
$$;
-- One proposal as the worker's store sends it (store.ts snake()), with overrides.
create function pg_temp.proposal(p_source uuid, p_message text, p_over jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'content_source_id', p_source,
    'message_key', encode(sha256(convert_to(p_message, 'UTF8')), 'hex'),
    'item_hash', encode(sha256(convert_to('text of ' || p_message, 'UTF8')), 'hex'),
    'sent_at', '2026-03-02T10:00:00Z',
    'party_domains', jsonb_build_array('bank.example', 'harbourline.example'),
    'outcome', 'deal', 'deal_key', 'm:project-heron', 'deal_name', 'Project Heron', 'candidate_id', null,
    'phase', 'phase-2', 'p_deal', 0.9, 'p_phase', 0.6,
    'model', 'anthropic/claude-haiku-5.5', 'prompt_version', 'v1', 'prompt_hash', 'hash-v1',
    'response_id', 'msg_1', 'run_id', '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d') || p_over;
$$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  v_tenant    uuid := gen_random_uuid();
  v_other     uuid := gen_random_uuid();
  v_alice     uuid := gen_random_uuid();
  v_colleague uuid := gen_random_uuid();
  v_cco       uuid := gen_random_uuid();
  v_admin     uuid := gen_random_uuid();
  v_outsider  uuid := gen_random_uuid();
  v_bank      uuid := gen_random_uuid();
  v_src_alice uuid;
  v_src_coll  uuid;
  v_src_other uuid := gen_random_uuid();
  v_falcon    uuid := gen_random_uuid();
  v_foreign_c uuid := gen_random_uuid();
  v_kestrel   uuid := gen_random_uuid();
  v_k_item    uuid := gen_random_uuid();
  v_cobra     uuid := gen_random_uuid();
  v_hidden    uuid := gen_random_uuid();
  v_c_item    uuid := gen_random_uuid();
  v_f_item    uuid := gen_random_uuid();
  v_id        uuid;
  v_id2       uuid;
  v_blocked   boolean;
begin
  -- ── Fixture, as the table owner (the seating of discovery_milestones.sql) ──
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alice,     'mp-alice@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_colleague, 'mp-colleague@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_cco,       'mp-cco@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance')),
    (v_admin,     'mp-admin@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_outsider,  'mp-outsider@example.test',  jsonb_build_object('tenant_id', v_other, 'department', 'compliance'));
  update users set status = 'active', is_external = false where id in (v_alice, v_colleague, v_cco, v_admin, v_outsider);
  update users set firm_role = 'cco' where id in (v_cco, v_outsider);
  update users set firm_role = 'admin' where id = v_admin;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values
    (v_tenant, 'fixture', 'fixture', 'active'),
    (v_other, 'fixture', 'fixture', 'active');
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'MP Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id = v_alice;
  update users set company_id = v_bank, company_role = 'member' where id in (v_colleague, v_cco, v_admin);
  update graph_reader_registrations set mailbox_domains = '{bank.example}', firm_company_id = v_bank where tenant_id = v_tenant;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (gen_random_uuid(), v_tenant, 'alice@bank.example',     v_alice, v_bank, 'director', 'accepted', 'sent', now(), v_alice),
    (gen_random_uuid(), v_tenant, 'colleague@bank.example', v_alice, v_bank, 'member',   'accepted', 'sent', now(), v_colleague);
  perform pg_temp.on_deal(u) from unnest(array[v_alice, v_colleague]) u;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_colleague);
  perform mailbox_consent_grant();
  reset role;
  select id into v_src_alice from content_sources where tenant_id = v_tenant and address = 'alice@bank.example' and owner_user_id = v_alice;
  select id into v_src_coll  from content_sources where tenant_id = v_tenant and address = 'colleague@bank.example' and owner_user_id = v_colleague;
  if v_src_alice is null or v_src_coll is null then raise exception 'FAIL: an opt-in did not create its mailbox source'; end if;
  insert into content_sources (id, tenant_id, kind, address, provider)
    values (v_src_other, v_other, 'mailbox', 'someone@other.example', 'microsoft');
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess)
    values (v_falcon, v_tenant, 'codename:falcon', 'Project Falcon', 'Project Falcon'),
           (v_hidden, v_tenant, 'codename:hidden', 'Project Hidden', 'Project Hidden'),
           (v_foreign_c, v_other, 'codename:foreign', 'Project Foreign', 'Project Foreign');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Falcon is backed by firm-routed mail in Alice's mailbox, so Alice (and only she) can see it. Hidden has no
  -- evidence, so nobody can.
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_f_item, v_tenant, 'message', 'falcon', '2026-02-20', '<falcon-1@harbourline.example>', 'hf');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_f_item, v_src_alice, 'a-f1');
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence)
    values (v_falcon, v_f_item, 'codename', 'firm', 0.9);
  perform discovery_refresh_candidate_visibility(v_falcon);

  -- ── The writer ────────────────────────────────────────────────────────────
  v_id := discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<heron-1@harbourline.example>'));
  perform pg_temp.expect((select count(*) from discovery_model_proposals where id = v_id and tenant_id = v_tenant
      and content_source_id = v_src_alice and outcome = 'deal' and phase = 'phase-2' and deal_key = 'm:project-heron'), 1,
    'a deal answer is stored with its deal key, name and phase');

  -- A repeat answer for the same source and message updates the row.
  v_id2 := discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<heron-1@harbourline.example>',
    jsonb_build_object('phase', 'phase-3', 'response_id', 'msg_2')));
  perform pg_temp.expect((case when v_id2 = v_id then 1 else 0 end), 1, 'a repeat answer upserts the same row');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), 1, 'one message in one mailbox is one row');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where id = v_id and phase = 'phase-3'
      and response_id = 'msg_2' and content_source_id = v_src_alice and updated_at >= created_at), 1,
    'the answer is updated in place');
  -- The same message read from a second mailbox is that mailbox's own row (review M3).
  v_id2 := discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_coll, '<heron-1@harbourline.example>',
    jsonb_build_object('deal_key', 'm:project-osprey', 'deal_name', 'Project Osprey')));
  perform pg_temp.expect((case when v_id2 <> v_id then 1 else 0 end), 1, 'a second mailbox''s answer is a second row');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), 2, 'one row per mailbox');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where id = v_id and deal_key = 'm:project-heron'), 1,
    'and the first mailbox''s answer is untouched');

  -- Two distinct messages with one text (the same item hash) are two rows.
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<heron-2@harbourline.example>',
    jsonb_build_object('item_hash', encode(sha256(convert_to('text of <heron-1@harbourline.example>', 'UTF8')), 'hex'))));
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant and deal_key = 'm:project-heron'), 2,
    'two messages with one text are two rows');
  perform pg_temp.expect((select count(distinct item_hash) from discovery_model_proposals where tenant_id = v_tenant and content_source_id = v_src_alice), 1,
    'in one mailbox');
  perform pg_temp.expect((select count(distinct item_hash) from discovery_model_proposals where tenant_id = v_tenant), 1,
    'and every row shares the item hash');

  -- A different prompt version or model is a different answer.
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<heron-1@harbourline.example>',
    jsonb_build_object('model', 'anthropic/other-model')));
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), 4,
    'another model answers in its own row');

  -- A listed candidate, a not-deal answer and an invalid one.
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<falcon-9@harbourline.example>',
    jsonb_build_object('deal_key', 'c:' || v_falcon, 'deal_name', 'Project Falcon', 'candidate_id', v_falcon)));
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<lunch@bank.example>',
    jsonb_build_object('outcome', 'not_deal', 'deal_key', null, 'deal_name', null, 'phase', null, 'p_phase', null)));
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<garbled@bank.example>',
    jsonb_build_object('outcome', 'invalid', 'deal_key', null, 'deal_name', null, 'phase', null, 'p_deal', null, 'p_phase', null)));
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant and candidate_id = v_falcon), 1,
    'a listed candidate is linked by id');

  -- The information barrier on write (review #509-5): a row may name only a candidate the source's owner can see.
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_coll, '<falcon-coll@harbourline.example>',
      jsonb_build_object('deal_key', 'c:' || v_falcon, 'deal_name', 'Project Falcon', 'candidate_id', v_falcon)));
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a proposal named a candidate its source owner cannot see (Falcon, colleague)'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<hidden-1@harbourline.example>',
      jsonb_build_object('deal_key', 'c:' || v_hidden, 'deal_name', 'Project Hidden', 'candidate_id', v_hidden)));
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a proposal named a candidate nobody can see'; end if;

  -- Refusals: another tenant's source or candidate, and a shape the table does not admit.
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_other, '<x1@x.example>'));
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a proposal was recorded on another tenant''s source'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<x2@x.example>',
      jsonb_build_object('deal_key', 'c:' || v_foreign_c, 'candidate_id', v_foreign_c)));
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a proposal was linked to another tenant''s candidate'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<x3@x.example>',
      jsonb_build_object('phase', null)));
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a deal answer without a phase was stored'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<x4@x.example>',
      jsonb_build_object('outcome', 'not_deal')));
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a not-deal answer carried a deal'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<x5@x.example>',
      jsonb_build_object('party_domains', jsonb_build_array('dana.fox@harbourline.example'))));
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an address was stored as a party domain'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<x6@x.example>',
      jsonb_build_object('message_key', '<x6@x.example>')));
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a raw message id was stored as the message key'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<x7@x.example>',
      jsonb_build_object('outcome', 'failed')));
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a failed call was stored'; end if;
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), 7,
    'no refused proposal left a row');

  -- ── Reads as each user ───────────────────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposals), 4,
    'the mailbox owner sees the live deal rows read from their mailbox');
  -- A row naming a candidate hidden from her, put in by the table owner (the writer refuses it): defence in depth.
  reset role;
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, outcome, deal_key, deal_name,
                                         candidate_id, phase, model, prompt_version, prompt_hash, run_id)
    values (v_tenant, v_src_alice, encode(sha256(convert_to('<hidden-direct@x>', 'UTF8')), 'hex'), encode(sha256('h'::bytea), 'hex'),
            'deal', 'c:' || v_hidden, 'Project Hidden', v_hidden, 'phase-1', 'm', 'v1', 'h', gen_random_uuid());
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_hidden), 0,
    'but not, read straight from the table, a row naming a candidate hidden from her');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where outcome <> 'deal'), 0,
    'and no not-deal or invalid row');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from discovery_model_proposals), 1, 'a colleague sees only the row read from their own mailbox');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where content_source_id <> v_src_coll), 0, 'and none of Alice''s');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from discovery_model_proposals), 0, 'the control room sees none (owner only)');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from discovery_model_proposals), 0, 'the firm admin sees none');
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect((select count(*) from discovery_model_proposals), 0, 'another tenant sees none');

  -- The helper answers only about the caller.
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((case when app_owns_mailbox_source(v_src_alice, v_tenant, v_alice) then 1 else 0 end), 0,
    'the ownership helper says nothing about another user');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((case when app_owns_mailbox_source(v_src_alice, v_tenant, v_alice) then 1 else 0 end), 1,
    'the ownership helper answers the caller truly');
  perform pg_temp.expect((case when app_owns_mailbox_source(v_src_alice, v_other, v_alice) then 1 else 0 end), 0,
    'the ownership helper checks the tenant');

  -- Nobody signed in writes a row or runs the writer.
  v_blocked := false;
  begin update discovery_model_proposals set phase = 'phase-5'; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user edited a proposal'; end if;
  v_blocked := false;
  begin delete from discovery_model_proposals; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user deleted a proposal'; end if;
  v_blocked := false;
  begin perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<y1@x.example>'));
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_record_model_proposal'; end if;
  reset role;

  set local role anon;
  v_blocked := false;
  begin perform 1 from discovery_model_proposals limit 1; exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon read discovery_model_proposals'; end if;
  reset role;

  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname = 'discovery_record_model_proposal'
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
            or not has_function_privilege('service_role', p.oid, 'execute'))),
    0, 'the writer is service_role only');
  perform pg_temp.expect(
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'discovery_model_proposals'
       and column_name ~ '(subject|body|address|participant|display_name|internet_message_id)'),
    0, 'the table has no text column');

  -- ── The known deals a run may name, per source (review M1) ───────────────
  -- Kestrel is backed by firm-routed mail in Alice's mailbox only, so only Alice can see it; Hidden has no evidence,
  -- so nobody can. Alice's mailbox holds model-named Heron, the colleague's holds Osprey.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess, last_seen_at)
    values (v_kestrel, v_tenant, 'codename:kestrel', 'Project Kestrel', 'Project Kestrel', now());
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_k_item, v_tenant, 'message', 'kestrel', '2026-03-01', '<kestrel-1@harbourline.example>', 'hk');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_k_item, v_src_alice, 'a-k1');
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence)
    values (v_kestrel, v_k_item, 'codename', 'firm', 0.9);
  perform discovery_refresh_candidate_visibility(v_kestrel);
  perform pg_temp.expect((select count(*) from discovery_proposal_known_deals(v_tenant, v_src_alice)
      where ref = 'c:' || v_kestrel and name = 'Project Kestrel' and candidate_id = v_kestrel), 1,
    'Alice''s mailbox is offered the candidate Alice can see');
  perform pg_temp.expect((select count(*) from discovery_proposal_known_deals(v_tenant, v_src_alice) where ref = 'm:project-heron'), 1,
    'and the deal the model named in her own mailbox');
  perform pg_temp.expect((select count(*) from discovery_proposal_known_deals(v_tenant, v_src_alice)
      where ref in ('c:' || v_hidden, 'm:project-osprey')), 0,
    'but not a candidate she cannot see, nor the colleague''s model-named deal');
  perform pg_temp.expect((select count(*) from discovery_proposal_known_deals(v_tenant, v_src_coll)
      where ref in ('c:' || v_kestrel, 'c:' || v_falcon, 'm:project-heron')), 0,
    'the colleague''s mailbox is offered none of Alice''s deals');
  perform pg_temp.expect((select count(*) from discovery_proposal_known_deals(v_tenant, v_src_coll) where ref = 'm:project-osprey'), 1,
    'only the colleague''s own');
  perform pg_temp.expect((select count(*) from discovery_proposal_known_deals(v_other, v_src_alice)), 0,
    'a source read under another tenant is offered nothing');
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname = 'discovery_proposal_known_deals'
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
            or not has_function_privilege('service_role', p.oid, 'execute'))),
    0, 'the known-deals read is service_role only');

  -- ── Archive, never delete, when a candidate goes away (review #509-3) ────
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<kestrel-9@harbourline.example>',
    jsonb_build_object('deal_key', 'c:' || v_kestrel, 'deal_name', 'Project Kestrel', 'candidate_id', v_kestrel)));
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_kestrel), 1,
    'a live row naming a candidate she can see is visible to the owner straight from the table');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess)
    values (v_cobra, v_tenant, 'codename:cobra', 'Project Cobra', 'Project Cobra');
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_c_item, v_tenant, 'message', 'cobra', '2026-02-25', '<cobra-1@harbourline.example>', 'hc');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_c_item, v_src_alice, 'a-c1');
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence)
    values (v_cobra, v_c_item, 'codename', 'firm', 0.9);
  perform discovery_refresh_candidate_visibility(v_cobra);
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<cobra-9@harbourline.example>',
    jsonb_build_object('deal_key', 'c:' || v_cobra, 'deal_name', 'Project Cobra', 'candidate_id', v_cobra)));
  update deal_candidates set discovery_state = 'rejected' where id = v_kestrel;
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_kestrel
      and archived_at is not null and deal_name = 'Project Kestrel' and candidate_id = v_kestrel), 1,
    'rejecting a candidate archives its proposals and keeps the key, name and id');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_kestrel), 0,
    'the owner cannot select an archived row straight from the table');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where archived_at is not null), 0,
    'nor any archived row');
  v_blocked := false;
  begin update discovery_model_proposals set archived_at = null where deal_key = 'c:' || v_kestrel;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an authenticated user restored an archived proposal'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- A run that read Kestrel as live before it was rejected: its late answer is written already archived.
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<kestrel-late@harbourline.example>',
    jsonb_build_object('deal_key', 'c:' || v_kestrel, 'deal_name', 'Project Kestrel', 'candidate_id', v_kestrel)));
  perform pg_temp.expect((select count(*) from discovery_model_proposals where message_key = encode(sha256(convert_to('<kestrel-late@harbourline.example>', 'UTF8')), 'hex')
      and archived_at is not null and deal_key = 'c:' || v_kestrel and deal_name = 'Project Kestrel' and candidate_id = v_kestrel), 1,
    'the writer archives an answer naming a candidate rejected since the run read it, and keeps key, name and id');
  update deal_candidates set proposed_name = 'Project Cobra Two' where id = v_cobra;
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_cobra and archived_at is null), 1,
    'a change that keeps the candidate live archives nothing');
  update deal_candidates set discovery_state = 'merged_into', merged_into_id = v_falcon where id = v_cobra;
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_cobra
      and archived_at is not null and deal_name = 'Project Cobra' and candidate_id = v_cobra), 1,
    'merging a candidate away archives its proposals the same way');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-heron' and archived_at is not null), 0,
    'a model-named deal is never archived by a candidate change');
  v_blocked := false;
  begin update discovery_model_proposals set archived_at = now() where deal_key = 'm:project-heron';
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a model-named row was archived'; end if;
  -- Recovery is one statement: clear archived_at.
  update discovery_model_proposals set archived_at = null where deal_key = 'c:' || v_kestrel;
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_kestrel and archived_at is null), 2,
    'archived proposals (the first answer and the late one) are restored by clearing archived_at');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_kestrel), 2,
    'and their owner sees them again');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update discovery_model_proposals set archived_at = now() where deal_key = 'c:' || v_kestrel;

  -- ── The allowlist and the purge reach the rows ───────────────────────────
  -- Cobra was merged into Falcon; release it so Falcon can be deleted, as a purge would.
  update deal_candidates set merged_into_id = null, discovery_state = 'rejected' where id = v_cobra;
  delete from deal_candidates where id = v_falcon;
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant and deal_key = 'c:' || v_falcon
      and deal_name = 'Project Falcon' and candidate_id = v_falcon and archived_at is not null), 1,
    'a deleted candidate archives its proposals and keeps the key, name and id');
  -- A late answer naming the deleted candidate is written already archived, not refused.
  perform discovery_record_model_proposal(v_tenant, pg_temp.proposal(v_src_alice, '<falcon-late@harbourline.example>',
    jsonb_build_object('deal_key', 'c:' || v_falcon, 'deal_name', 'Project Falcon', 'candidate_id', v_falcon)));
  perform pg_temp.expect((select count(*) from discovery_model_proposals where message_key = encode(sha256(convert_to('<falcon-late@harbourline.example>', 'UTF8')), 'hex')
      and archived_at is not null and deal_key = 'c:' || v_falcon and candidate_id = v_falcon), 1,
    'the writer archives an answer naming a candidate deleted since the run read it');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant and content_source_id = v_src_alice
      and archived_at is not null), 5, 'Alice''s mailbox holds five archived proposals before the purge');
  delete from content_sources where id = v_src_alice;
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant and content_source_id = v_src_alice), 0,
    'deleting the source deletes its proposals');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant and content_source_id = v_src_coll), 1,
    'and only its own');
  -- Withdrawing consent purges the banker's sole-held mail (#461), so it runs last: before #461 it only hid
  -- the rows, and the checks above need them. Alice's withdrawal leaves her colleague's proposal in place.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_withdraw();
  perform pg_temp.expect((select count(*) from discovery_model_proposals), 0, 'a withdrawn banker sees no proposals');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant and content_source_id = v_src_coll), 1,
    'a withdrawal leaves a colleague''s proposals');

  raise notice 'PASS: discovery model proposals: writer, upsert by source and message, RLS owner only, known deals per owner, closed writer, archive on candidate removal, purge';
end $$;

-- ── The per-source barrier (G-01 #173, slice 1: 20261023110000_discovery_proposal_own_source.sql) ──
-- A source's prompt, and the candidate a proposal row may name, are judged per SOURCE through
-- discovery_proposal_may_name: an unrejected, firm-routed or confirmed link to an item read from THAT source, while the
-- source is readable (a team inbox the allowlist admits, or a personal mailbox its owner still holds on the allowlist).
--
--   Bea     a banker with a personal mailbox A (bea@bank.example) and a reader of the team inbox
--   Bea B   a second source Bea owns, off the allowlist (an owner has one allowlisted address)
--   CCO     the firm's CCO, who also owns a personal mailbox (the control room sees every candidate)
--   Team    the team inbox deals@tm.example (verified), Orphan an ownerless source that is no team inbox
--
-- Teal is backed by the team inbox only, Beta by Bea's mailbox A only, Both by each, Cobalt by the CCO's mailbox,
-- Alt by Bea B, Orphan by the ownerless source, Weak by a tentative link, Rejected by a rejected one.
create function pg_temp.expect_text(actual text, expected text, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, coalesce(expected, '<null>'), coalesce(actual, '<null>');
  end if;
end;
$$;
create function pg_temp.flag(p boolean) returns bigint language sql as $$ select case when p then 1 else 0 end::bigint $$;
create function pg_temp.has_ref(p_tenant uuid, p_source uuid, p_ref text) returns bigint language sql as $$
  select count(*) from discovery_proposal_known_deals(p_tenant, p_source) where ref = p_ref
$$;
create function pg_temp.n_known(p_tenant uuid, p_source uuid) returns bigint language sql as $$
  select count(*) from discovery_proposal_known_deals(p_tenant, p_source)
$$;
-- The writer's outcome as 'ok' or sqlstate:message.
create function pg_temp.try_write(p_tenant uuid, p_proposal jsonb) returns text language plpgsql as $$
begin
  perform discovery_record_model_proposal(p_tenant, p_proposal);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;
-- One item read from p_source that backs p_cand through a link of the given tier and state.
create function pg_temp.back(p_tenant uuid, p_cand uuid, p_source uuid, p_key text,
                             p_tier text default 'firm', p_state text default 'proposed')
returns void language plpgsql as $$
declare
  v_item uuid := gen_random_uuid();
begin
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_item, p_tenant, 'message', p_key, '2026-03-01', '<' || p_key || '@g01.example>', 'h-' || p_key);
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_item, p_source, 'p-' || p_key);
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence, state)
    values (p_cand, v_item, 'codename', p_tier, 0.9, p_state);
end;
$$;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_bea      uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_bank     uuid := gen_random_uuid();
  v_out      jsonb;
  v_tm       uuid;
  v_src_bea  uuid;
  v_src_cco  uuid;
  v_src_b    uuid;
  v_src_team uuid;
  v_src_orph uuid;
  v_teal     uuid := gen_random_uuid();
  v_beta     uuid := gen_random_uuid();
  v_both     uuid := gen_random_uuid();
  v_cobalt   uuid := gen_random_uuid();
  v_alt      uuid := gen_random_uuid();
  v_orphan   uuid := gen_random_uuid();
  v_weak     uuid := gen_random_uuid();
  v_rejected uuid := gen_random_uuid();
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,   'g1-dir@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin, 'g1-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_bea,   'g1-bea@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_cco,   'g1-cco@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance'));
  update users set status = 'active', is_external = false where tenant_id = v_t;
  insert into companies (id, tenant_id, name, type) values (v_bank, v_t, 'G1 Bank', 'bank');
  -- The director first: company_has_director refuses a bank of members only.
  update users set company_id = v_bank, company_role = 'director' where id = v_dir;
  update users set company_id = v_bank, company_role = 'member' where tenant_id = v_t and id <> v_dir;
  update users set firm_role = 'admin' where id = v_admin;
  update users set firm_role = 'cco' where id = v_cco;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_bank);
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'tm.example', 'dwd-reader@proj-91.iam.gserviceaccount.com', '923456789012345678',
     'dir-reader@proj-91.iam.gserviceaccount.com', 'conductia-ingest@tm.example', v_bank, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (gen_random_uuid(), v_t, 'bea@bank.example', v_dir, v_bank, 'member', 'accepted', 'sent', now(), v_bea),
    (gen_random_uuid(), v_t, 'cco@bank.example', v_dir, v_bank, 'member', 'accepted', 'sent', now(), v_cco);
  perform pg_temp.on_deal(u) from unnest(array[v_bea, v_cco]) u;
  set local role authenticated;
  perform pg_temp.act_as(v_bea);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_cco);
  perform mailbox_consent_grant();
  -- The team inbox, connected by the firm admin and confirmed by the Directory check.
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('deals@tm.example', 1);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_tm       := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_team := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  select id into v_src_bea from content_sources where tenant_id = v_t and address = 'bea@bank.example' and owner_user_id = v_bea;
  select id into v_src_cco from content_sources where tenant_id = v_t and address = 'cco@bank.example' and owner_user_id = v_cco;
  if v_tm is null or v_src_team is null or v_src_bea is null or v_src_cco is null then
    raise exception 'FAIL: the barrier fixture did not create its sources';
  end if;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-g01');
  -- The writer asks a team source for a live team_proposals approval and an open pass of the row's run (slice 4,
  -- 20261023110300): give the inbox both, under the run id pg_temp.proposal() writes.
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_bank, 'team_proposals', 'g01-barrier');
  perform discovery_begin_proposal_source(v_t, v_src_team, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d'::uuid, 'recorded', array[v_bank]);
  -- Bea's second source (off the allowlist) and a source nobody owns that is no team inbox.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
    values (v_t, 'mailbox', 'bea.alt@bank.example', v_bea, 'microsoft') returning id into v_src_b;
  insert into content_sources (tenant_id, kind, address, provider)
    values (v_t, 'mailbox', 'orphan@bank.example', 'microsoft') returning id into v_src_orph;

  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess, last_seen_at) values
    (v_teal,     v_t, 'codename:teal',     'Project Teal',     'Project Teal',     now()),
    (v_beta,     v_t, 'codename:beta',     'Project Beta',     'Project Beta',     now()),
    (v_both,     v_t, 'codename:both',     'Project Both',     'Project Both',     now()),
    (v_cobalt,   v_t, 'codename:cobalt',   'Project Cobalt',   'Project Cobalt',   now()),
    (v_alt,      v_t, 'codename:alt',      'Project Alt',      'Project Alt',      now()),
    (v_orphan,   v_t, 'codename:orphan',   'Project Orphan',   'Project Orphan',   now()),
    (v_weak,     v_t, 'codename:weak',     'Project Weak',     'Project Weak',     now()),
    (v_rejected, v_t, 'codename:rejected', 'Project Rejected', 'Project Rejected', now());
  perform pg_temp.back(v_t, v_teal,     v_src_team, 'g1-teal');
  perform pg_temp.back(v_t, v_beta,     v_src_bea,  'g1-beta');
  perform pg_temp.back(v_t, v_both,     v_src_team, 'g1-both-t');
  perform pg_temp.back(v_t, v_both,     v_src_bea,  'g1-both-b');
  perform pg_temp.back(v_t, v_cobalt,   v_src_cco,  'g1-cobalt');
  perform pg_temp.back(v_t, v_alt,      v_src_b,    'g1-alt');
  perform pg_temp.back(v_t, v_orphan,   v_src_orph, 'g1-orphan');
  perform pg_temp.back(v_t, v_weak,     v_src_bea,  'g1-weak', 'tentative', 'proposed');
  perform pg_temp.back(v_t, v_rejected, v_src_bea,  'g1-rejected', 'firm', 'rejected');
  perform discovery_refresh_candidate_visibility(c)
    from unnest(array[v_teal, v_beta, v_both, v_cobalt, v_alt, v_orphan, v_weak, v_rejected]) c;
  -- Bea reads the team inbox, as a member.
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_bea);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── The leaks, as premises: the owner-wide test admits what the per-source test must not ──
  perform pg_temp.expect(pg_temp.flag(app_can_see_candidate(v_teal, v_bea)), 1,
    'premise (T6): a banker who reads a team inbox sees its candidate');
  perform pg_temp.expect(pg_temp.flag(app_can_see_candidate(v_beta, v_cco)), 1,
    'premise: the firm CCO sees a candidate only another banker''s mailbox backs');

  -- ── may_name, source by source ───────────────────────────────────────────
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_bea, v_beta)), 1, 'a personal source may name its own candidate');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_bea, v_both)), 1, 'and one backed by both inboxes');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_bea, v_teal)), 0,
    'T6: a personal source may not name a candidate only a team inbox backs, though its owner reads that inbox');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_cco, v_beta)), 0,
    'the CCO''s personal source may not name a candidate the CCO sees through the control room');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_cco, v_cobalt)), 1, 'but its own');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_b, v_beta)), 0,
    'a second source of the same owner may not name the first one''s candidate');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_b, v_alt)), 0,
    'and a source off the allowlist names nothing, its own evidence included');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_orph, v_orphan)), 0, 'an ownerless source that is no team inbox names nothing');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_team, v_teal)), 1, 'a team source may name a candidate its inbox backs');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_team, v_both)), 1, 'and one backed by both');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_team, v_beta)), 0, 'but not one only a personal mailbox backs');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_bea, v_weak)), 0, 'a tentative, unconfirmed link does not back a name');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_bea, v_rejected)), 0, 'nor does a rejected one');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(gen_random_uuid(), v_beta)), 0, 'an unknown source names nothing');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_bea, null)), 0, 'and no candidate is no name');

  -- ── The writer: a row names only a candidate its own source backs ────────
  perform pg_temp.expect_text(left(pg_temp.try_write(v_t, pg_temp.proposal(v_src_bea, '<g1-w1>',
      jsonb_build_object('deal_key', 'c:' || v_teal, 'deal_name', 'Project Teal', 'candidate_id', v_teal))), 5), '22023',
    'T6 on write: a personal source may not record a team-only candidate');
  perform pg_temp.expect_text(left(pg_temp.try_write(v_t, pg_temp.proposal(v_src_cco, '<g1-w2>',
      jsonb_build_object('deal_key', 'c:' || v_beta, 'deal_name', 'Project Beta', 'candidate_id', v_beta))), 5), '22023',
    'the CCO''s source may not record a candidate it sees only through the control room');
  perform pg_temp.expect_text(left(pg_temp.try_write(v_t, pg_temp.proposal(v_src_b, '<g1-w3>',
      jsonb_build_object('deal_key', 'c:' || v_beta, 'deal_name', 'Project Beta', 'candidate_id', v_beta))), 5), '22023',
    'owner A and B: the writer refuses A''s candidate on B');
  perform pg_temp.expect_text(left(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1-w4>',
      jsonb_build_object('deal_key', 'c:' || v_beta, 'deal_name', 'Project Beta', 'candidate_id', v_beta))), 5), '22023',
    'a team source may not record a candidate only a personal mailbox backs');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_bea, '<g1-w5>',
      jsonb_build_object('deal_key', 'c:' || v_beta, 'deal_name', 'Project Beta', 'candidate_id', v_beta))), 'ok',
    'a personal source records its own candidate');
  -- Slice 1 refused every team write (review F1); slice 4 admits one under a live approval and an open pass of the
  -- row's run, both given to the inbox above.
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1-w6>',
      jsonb_build_object('deal_key', 'c:' || v_teal, 'deal_name', 'Project Teal', 'candidate_id', v_teal))), 'ok',
    'a team source records a candidate its inbox backs');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_orph, '<g1-w7>')),
    '22023:discovery_record_model_proposal: source has no reader',
    'an ownerless source that is no team inbox has no reader: nothing is recorded, even without a candidate');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where content_source_id = v_src_orph), 0, 'and no row is left');

  -- ── The deals a run may name: this source's own mail, nothing else ───────
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_bea, '<g1-heron>')), 'ok', 'Bea''s mailbox A names Heron');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_b, '<g1-bee>',
      jsonb_build_object('deal_key', 'm:project-bee', 'deal_name', 'Project Bee'))), 'ok', 'her second source names Bee');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1-tealx>',
      jsonb_build_object('deal_key', 'm:project-tealx', 'deal_name', 'Project Tealx'))), 'ok', 'the team inbox names Tealx');
  -- A team row put in by the table owner (as an older build could have written it), to pin what a run may name.
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, outcome, deal_key, deal_name,
                                         phase, model, prompt_version, prompt_hash, run_id)
    values (v_t, v_src_team, encode(sha256(convert_to('<g1-tealx-old>', 'UTF8')), 'hex'), encode(sha256('tx'::bytea), 'hex'),
            'deal', 'm:project-tealx', 'Project Tealx', 'phase-1', 'm', 'v1', 'h', gen_random_uuid());
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_bea), 3, 'Bea''s mailbox A is offered three deals');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_bea, 'c:' || v_beta), 1, 'its own Beta');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_bea, 'c:' || v_both), 1, 'Both');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_bea, 'm:project-heron'), 1, 'and the deal the model named in it');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_bea, 'c:' || v_teal), 0, 'T6: not the team inbox''s candidate');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_bea, 'm:project-tealx'), 0, 'nor the team inbox''s model-named deal');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_bea, 'm:project-bee'), 0, 'nor the model-named deal of her other source');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_bea, 'c:' || v_weak) + pg_temp.has_ref(v_t, v_src_bea, 'c:' || v_rejected), 0,
    'nor a candidate its links do not back (tentative, rejected)');
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_b), 0,
    'owner A and B: the second source is offered none of the first one''s deals, nor its own while it is off the allowlist');
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_cco), 1, 'the CCO''s mailbox is offered one deal');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_cco, 'c:' || v_cobalt), 1, 'its own, and not a control-room candidate');
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_team), 3, 'the team inbox is offered three deals');
  perform pg_temp.expect(pg_temp.has_ref(v_t, v_src_team, 'c:' || v_teal) + pg_temp.has_ref(v_t, v_src_team, 'c:' || v_both)
      + pg_temp.has_ref(v_t, v_src_team, 'm:project-tealx'), 3, 'its inbox-backed candidates and its own model-named deal');
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_orph), 0, 'an ownerless source that is no team inbox is offered nothing');
  perform pg_temp.expect(pg_temp.n_known(v_t, gen_random_uuid()), 0, 'and an unknown source');

  -- ── The frozen signatures (design R10) ───────────────────────────────────
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_proposal_may_name(uuid,uuid)'::regprocedure),
    'p_source uuid, p_candidate uuid', 'may_name takes a source and a candidate');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_proposal_may_name(uuid,uuid)'::regprocedure), 'boolean',
    'and answers a boolean');
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_proposal_known_deals(uuid,uuid)'::regprocedure),
    'p_tenant_id uuid, p_source uuid', 'known_deals takes a tenant and a source');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_proposal_known_deals(uuid,uuid)'::regprocedure),
    'TABLE(ref text, name text, candidate_id uuid)', 'and returns refs, names and candidate ids');
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_record_model_proposal(uuid,jsonb)'::regprocedure),
    'p_tenant_id uuid, p_proposal jsonb', 'the writer takes a tenant and a proposal');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_record_model_proposal(uuid,jsonb)'::regprocedure), 'uuid',
    'and returns the row id');
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname = 'discovery_proposal_may_name'
       and (not p.prosecdef
            or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
            or not has_function_privilege('service_role', p.oid, 'execute'))),
    0, 'may_name is a definer, service_role only');

  -- ── The team inbox refused: it names nothing, and nothing is recorded for it ──
  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'alias', null);
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_team, v_teal)), 0, 'a refused inbox names nothing');
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_team), 0,
    'and is offered none of its candidates or its own model-named deals');
  perform pg_temp.expect_text(left(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1-w8>',
      jsonb_build_object('deal_key', 'c:' || v_teal, 'deal_name', 'Project Teal', 'candidate_id', v_teal))), 5), '22023',
    'and the writer refuses its candidate');

  -- ── Withdrawal: a source whose owner left the allowlist names nothing ────
  -- Path 1: the consent is closed while the source is kept (the retention policy keeps content, or the purge has not
  -- run yet). The purge trigger is switched off for the statement to hold that state.
  alter table mailbox_consents disable trigger mailbox_consents_purge;
  update mailbox_consents set withdrawn_at = now() where user_id = v_bea and withdrawn_at is null;
  alter table mailbox_consents enable trigger mailbox_consents_purge;
  perform pg_temp.expect((select count(*) from content_sources where id = v_src_bea), 1, 'the source is kept');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_bea, v_beta)), 0, 'a source whose consent is closed names nothing');
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_bea), 0,
    'and is offered none of its candidates or its own model-named deals');
  perform pg_temp.expect_text(left(pg_temp.try_write(v_t, pg_temp.proposal(v_src_bea, '<g1-w9>',
      jsonb_build_object('deal_key', 'c:' || v_beta, 'deal_name', 'Project Beta', 'candidate_id', v_beta))), 5), '22023',
    'and the writer refuses its candidate');
  -- Path 2: mailbox_consent_withdraw(), with the purge it runs.
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_cco), 1, 'before the CCO withdraws, their source is offered Cobalt');
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect(pg_temp.n_known(v_t, v_src_cco), 0, 'after mailbox_consent_withdraw() it is offered nothing');
  perform pg_temp.expect(pg_temp.flag(discovery_proposal_may_name(v_src_cco, v_cobalt)), 0, 'and names nothing');
  perform pg_temp.expect_text(left(pg_temp.try_write(v_t, pg_temp.proposal(v_src_cco, '<g1-w10>',
      jsonb_build_object('deal_key', 'c:' || v_cobalt, 'deal_name', 'Project Cobalt', 'candidate_id', v_cobalt))), 5), '22023',
    'and the writer refuses its candidate');

  raise notice 'PASS: discovery model proposals: per-source barrier (T6, CCO, owner A/B, withdrawal, team branch, team writes refused, ownerless, signatures)';
end $$;

-- ── The shared approvals (G-01 #173, slice 2: 20261023110100_discovery_tenant_approvals.sql) ──
-- One table for every capability an owner approves for one firm company in one tenant (G-07 and G-09 append their own
-- capability cases below). It is written by reviewed migrations only: here the block runs as the table's owner, the
-- way a migration does. No API role writes it; every change writes one audit row; a row is revoked, never deleted.
create function pg_temp.try_sql(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;
create function pg_temp.n_approval_audit(p_tenant uuid, p_on boolean default null) returns bigint language sql as $$
  select count(*) from audit_log
  where tenant_id = p_tenant and action = 'discovery.tenant_approval_changed'
    and (p_on is null or (detail ->> 'on')::boolean = p_on)
$$;
create function pg_temp.cap_on(p_tenant uuid, p_firm uuid, p_cap text) returns bigint language sql as $$
  select pg_temp.flag(app_tenant_capability_on(p_tenant, p_firm, p_cap))
$$;

do $$
declare
  v_t       uuid := gen_random_uuid();
  v_t2      uuid := gen_random_uuid();
  v_firm    uuid := gen_random_uuid();
  v_firm2   uuid := gen_random_uuid();
  v_firm_t2 uuid := gen_random_uuid();
  v_client  uuid := gen_random_uuid();
  v_phantom uuid := gen_random_uuid();
  v_where   text;
  v_denied  boolean;
  v_n       bigint;
  v_detail  jsonb;
begin
  insert into companies (id, tenant_id, name, type) values
    (v_firm,    v_t,  'Approvals Bank',   'bank'),
    (v_firm2,   v_t,  'Approvals Bank 2', 'bank'),
    (v_firm_t2, v_t2, 'Approvals Bank T2', 'bank'),
    (v_client,  v_t,  'Approvals Client', 'client');
  v_where := format('where tenant_id = %L and firm_company_id = %L and capability = %L', v_t, v_firm, 'team_proposals');

  -- ── Nothing is on until a reviewed migration says so ─────────────────────
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm, 'team_proposals'), 0, 'with no row, a capability is off');
  perform pg_temp.expect(pg_temp.cap_on(null, v_firm, 'team_proposals') + pg_temp.cap_on(v_t, null, 'team_proposals')
                         + pg_temp.cap_on(v_t, v_firm, null), 0, 'and a null argument is off');

  -- ── The capability list is closed, the decision reference is bounded, the firm company exists ──
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (%L, %L, %L, %L)',
      v_t, v_firm, 'send_everything', 'ref')), 5), '23514', 'the CHECK rejects a fourth capability');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (%L, %L, %L, %L)',
      v_t, v_firm, 'team_proposals', '')), 5), '23514', 'an empty decision reference is refused');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (%L, %L, %L, %L)',
      v_t, v_firm, 'team_proposals', repeat('x', 81))), 5), '23514', 'and one over 80 characters');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (%L, %L, %L, %L)',
      v_t, v_phantom, 'team_proposals', 'ref')), 5), '23000', 'a firm company that does not exist is refused');
  -- Review F3: the firm company must be a bank of the row's own tenant.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (%L, %L, %L, %L)',
      v_t, v_firm_t2, 'team_proposals', 'ref')),
    '23000:discovery_tenant_approvals: the firm company is not a bank of this tenant',
    'another tenant''s firm company is refused under this tenant''s id');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (%L, %L, %L, %L)',
      v_t, v_client, 'team_proposals', 'ref')), 5), '23000', 'and so is a company of the tenant that is not a bank');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref, revoked_at) values (%L, %L, %L, %L, now())',
      v_t, v_firm, 'team_proposals', 'ref')), 5), '23000', 'a new approval is on: one inserted already revoked is refused');
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t), 0, 'a refused insert writes no audit row');

  -- ── The owner's insert is one audited approval ───────────────────────────
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_firm, 'team_proposals', 'g01-test-1');
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t), 1, 'the owner''s insert writes one tenant_approval_changed row');
  select a.detail into v_detail from audit_log a
    where a.tenant_id = v_t and a.action = 'discovery.tenant_approval_changed' order by a.chain_seq desc limit 1;
  perform pg_temp.expect_text(v_detail ->> 'capability', 'team_proposals', 'the audit row names the capability');
  perform pg_temp.expect_text(v_detail ->> 'firmCompanyId', v_firm::text, 'the firm company');
  perform pg_temp.expect_text(v_detail ->> 'decisionRef', 'g01-test-1', 'the decision reference');
  perform pg_temp.expect_text(v_detail ->> 'on', 'true', 'and that it is on');
  perform pg_temp.expect((select count(*) from jsonb_object_keys(v_detail)), 4, 'with those four keys and nothing else');
  perform pg_temp.expect((select count(*) from audit_log a where a.tenant_id = v_t and a.action = 'discovery.tenant_approval_changed'
                            and a.actor_type = 'service' and a.actor_id is null and a.service_identity is not null), 1,
    'written as a service row that names its identity');

  -- ── app_tenant_capability_on is per tenant, firm company and capability ──
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm, 'team_proposals'), 1, 'a live row is on');
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm, 'milestone_rules'), 0, 'another capability''s row does not turn it on');
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm2, 'team_proposals'), 0, 'another firm company of the tenant is off');
  perform pg_temp.expect(pg_temp.cap_on(v_t2, v_firm, 'team_proposals'), 0, 'another tenant is off');
  perform pg_temp.expect(pg_temp.cap_on(v_t2, v_firm_t2, 'team_proposals'), 0, 'and so is its own firm company');

  -- ── The same firm company can hold each capability on its own ────────────
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_firm, 'milestone_rules', 'g01-test-2');
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm, 'milestone_rules'), 1, 'a second capability is its own row');
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t, true), 2, 'each approval is audited');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref) values (%L, %L, %L, %L)',
      v_t, v_firm, 'team_proposals', 'again')), 5), '23505', 'a second row for one key is refused');

  -- ── No API role writes it; the worker reads it ───────────────────────────
  set local role service_role;
  select count(*) into v_n from discovery_tenant_approvals where tenant_id = v_t;
  if v_n <> 2 then raise exception 'FAIL: service_role reads the approvals (got %)', v_n; end if;
  if app_tenant_capability_on(v_t, v_firm, 'team_proposals') is not true then
    raise exception 'FAIL: service_role may ask whether a capability is on';
  end if;
  v_denied := false;
  begin
    insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
      values (v_t, v_firm2, 'team_proposals', 'sneaky');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: service_role may not insert an approval'; end if;
  v_denied := false;
  begin
    update discovery_tenant_approvals set revoked_at = now() where tenant_id = v_t;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: service_role may not update an approval'; end if;
  v_denied := false;
  begin
    delete from discovery_tenant_approvals where tenant_id = v_t;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: service_role may not delete an approval'; end if;
  v_denied := false;
  begin
    truncate discovery_tenant_approvals;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: service_role may not truncate the approvals'; end if;
  reset role;

  set local role authenticated;
  perform pg_temp.act_as(gen_random_uuid());
  v_denied := false;
  begin
    perform count(*) from discovery_tenant_approvals;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not read the approvals'; end if;
  v_denied := false;
  begin
    insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
      values (v_t, v_firm2, 'team_proposals', 'sneaky');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not insert an approval'; end if;
  v_denied := false;
  begin
    update discovery_tenant_approvals set revoked_at = now() where tenant_id = v_t;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not update an approval'; end if;
  v_denied := false;
  begin
    delete from discovery_tenant_approvals where tenant_id = v_t;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not delete an approval'; end if;
  v_denied := false;
  begin
    truncate discovery_tenant_approvals;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not truncate the approvals'; end if;
  v_denied := false;
  begin
    perform app_tenant_capability_on(v_t, v_firm, 'team_proposals');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not call app_tenant_capability_on'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t), 2, 'the refused writes left no audit row');

  -- ── A row is revoked, never deleted: even its owner is refused ───────────
  perform pg_temp.expect_text(pg_temp.try_sql('delete from discovery_tenant_approvals ' || v_where),
    '23000:discovery_tenant_approvals: approvals are revoked, never deleted', 'a delete is refused, even for the owner');
  perform pg_temp.expect_text(pg_temp.try_sql('delete from discovery_tenant_approvals'),
    '23000:discovery_tenant_approvals: approvals are revoked, never deleted', 'so is a delete of every row');
  perform pg_temp.expect_text(pg_temp.try_sql('truncate discovery_tenant_approvals'),
    '23000:discovery_tenant_approvals: approvals are revoked, never deleted', 'and a truncate');
  perform pg_temp.expect((select count(*) from discovery_tenant_approvals where tenant_id = v_t), 2, 'both rows survive');

  -- ── The key columns are frozen, and an update is a revoke or a new approval ──
  perform pg_temp.expect_text(pg_temp.try_sql('update discovery_tenant_approvals set capability = ''firm_name_alias'' ' || v_where),
    '23000:discovery_tenant_approvals: the key columns are frozen', 'the capability cannot change');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update discovery_tenant_approvals set firm_company_id = %L %s', v_firm2, v_where)),
    '23000:discovery_tenant_approvals: the key columns are frozen', 'nor the firm company');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update discovery_tenant_approvals set tenant_id = %L %s', v_t2, v_where)),
    '23000:discovery_tenant_approvals: the key columns are frozen', 'nor the tenant');
  perform pg_temp.expect_text(left(pg_temp.try_sql('update discovery_tenant_approvals set decision_ref = ''edited'' ' || v_where), 5), '23000',
    'a live row''s decision reference cannot be rewritten');
  perform pg_temp.expect_text(left(pg_temp.try_sql('update discovery_tenant_approvals set approved_at = now() - interval ''1 day'' ' || v_where), 5),
    '23000', 'nor its approval time');
  perform pg_temp.expect_text(left(pg_temp.try_sql('update discovery_tenant_approvals set decision_ref = decision_ref ' || v_where), 5), '23000',
    'and an update that changes nothing is refused rather than audited');
  perform pg_temp.expect_text(left(pg_temp.try_sql('update discovery_tenant_approvals set decision_ref = ''edited'', revoked_at = now() ' || v_where), 5),
    '23000', 'a revoke changes revoked_at alone');
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t), 2, 'no refused update wrote an audit row');

  -- ── Revoking: one audit row, the row survives, only that capability goes off ──
  update discovery_tenant_approvals set revoked_at = now() where tenant_id = v_t and firm_company_id = v_firm and capability = 'team_proposals';
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t), 3, 'the owner''s revoke writes one tenant_approval_changed row');
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t, false), 1, 'saying it is off');
  select a.detail into v_detail from audit_log a
    where a.tenant_id = v_t and a.action = 'discovery.tenant_approval_changed' and (a.detail ->> 'on')::boolean = false;
  perform pg_temp.expect_text(v_detail ->> 'capability', 'team_proposals', 'for the revoked capability');
  perform pg_temp.expect_text(v_detail ->> 'decisionRef', 'g01-test-1', 'under the decision it was approved by');
  perform pg_temp.expect((select count(*) from discovery_tenant_approvals where tenant_id = v_t and firm_company_id = v_firm
                            and capability = 'team_proposals' and revoked_at is not null), 1, 'the revoked row survives, stamped');
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm, 'team_proposals'), 0, 'a revoked row is off');
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm, 'milestone_rules'), 1, 'and another capability of the same firm stays on');
  perform pg_temp.expect_text(left(pg_temp.try_sql('update discovery_tenant_approvals set revoked_at = now() ' || v_where), 5), '23000',
    'a revoked row is not revoked twice');
  perform pg_temp.expect_text(pg_temp.try_sql('update discovery_tenant_approvals set revoked_at = null ' || v_where),
    '23000:discovery_tenant_approvals: approving again needs a new decision_ref', 'approving it again needs a new decision reference');
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t), 3, 'the refused updates wrote nothing');

  -- ── Approving again, under a new decision ────────────────────────────────
  update discovery_tenant_approvals set revoked_at = null, decision_ref = 'g01-test-3' where tenant_id = v_t and firm_company_id = v_firm and capability = 'team_proposals';
  perform pg_temp.expect(pg_temp.cap_on(v_t, v_firm, 'team_proposals'), 1, 'a revoked row approved again is on');
  perform pg_temp.expect(pg_temp.n_approval_audit(v_t), 4, 'and the second approval is audited');
  select a.detail into v_detail from audit_log a
    where a.tenant_id = v_t and a.action = 'discovery.tenant_approval_changed' order by a.chain_seq desc limit 1;
  perform pg_temp.expect_text(v_detail ->> 'decisionRef', 'g01-test-3', 'with its new decision reference');
  perform pg_temp.expect_text(v_detail ->> 'on', 'true', 'and on');

  -- ── Review F4: an approval starts when it is written, never at a chosen time ──
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref, approved_at)
    values (v_t2, v_firm_t2, 'team_proposals', 'g01-test-4', now() - interval '30 days');
  perform pg_temp.expect((select count(*) from discovery_tenant_approvals where tenant_id = v_t2 and firm_company_id = v_firm_t2
                            and capability = 'team_proposals' and approved_at = now()), 1,
    'an insert that names an earlier approval time is stamped with the statement''s time');

  -- ── The signature the later tasks call (design R10) ──────────────────────
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.app_tenant_capability_on(uuid,uuid,text)'::regprocedure),
    'p_tenant uuid, p_firm uuid, p_capability text', 'app_tenant_capability_on takes a tenant, a firm company and a capability');
  perform pg_temp.expect_text(pg_get_function_result('public.app_tenant_capability_on(uuid,uuid,text)'::regprocedure), 'boolean',
    'and answers a boolean');

  raise notice 'PASS: discovery model proposals: shared tenant approvals (closed capability list, a bank of the row''s own tenant, no backdating, owner-only audited writes, no delete or truncate, frozen keys, per-capability reader)';
end $$;

-- ── The team pass (G-01 #173, slice 3: 20261023110200_discovery_team_proposal_pass.sql) ──
-- begin, renew and end: the audited pass a team source holds before any model call. The block builds its own tenant:
--
--   Bea     a banker with a personal mailbox (bea@bank.example), allowlisted
--   Team    the team inbox deals@tp.example (verified); Alt a second source Bea owns, off the allowlist;
--           Orphan an ownerless source that is no team inbox
--   Bank    the inbox's firm company, Bank2 another firm company of the tenant
--
-- The whole file runs in one transaction, so now() does not move: a lease is "now() + 30 minutes", and a lapsed one is
-- made by backdating it, as the table's owner.
create function pg_temp.try_begin(p_tenant uuid, p_source uuid, p_run uuid, p_firms uuid[], p_path text default 'recorded')
returns text language plpgsql as $$
begin
  return 'ok:' || (discovery_begin_proposal_source(p_tenant, p_source, p_run, p_path, p_firms) ->> 'scope');
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;
create function pg_temp.try_renew(p_tenant uuid, p_source uuid, p_run uuid, p_firms uuid[], p_counts jsonb default '{}'::jsonb)
returns text language plpgsql as $$
begin
  return 'ok:' || (discovery_renew_proposal_source(p_tenant, p_source, p_run, p_firms, p_counts) ->> 'scope');
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;
-- The passes of one source: all of them, the open ones, or the closed ones.
create function pg_temp.n_pass(p_source uuid, p_open boolean default null) returns bigint language sql as $$
  select count(*) from discovery_team_proposal_passes
  where content_source_id = p_source and (p_open is null or (closed_at is null) = p_open)
$$;
create function pg_temp.n_pass_audit(p_tenant uuid, p_action text) returns bigint language sql as $$
  select count(*) from audit_log where tenant_id = p_tenant and action = p_action
$$;
-- The newest audit row of an action for a tenant.
create function pg_temp.last_pass_audit(p_tenant uuid, p_action text) returns jsonb language sql as $$
  select detail from audit_log where tenant_id = p_tenant and action = p_action order by chain_seq desc limit 1
$$;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_bea      uuid := gen_random_uuid();
  v_bank     uuid := gen_random_uuid();
  v_bank2    uuid := gen_random_uuid();
  v_out      jsonb;
  v_json     jsonb;
  v_detail   jsonb;
  v_tm       uuid;
  v_src_team uuid;
  v_src_bea  uuid;
  v_src_alt  uuid;
  v_src_orph uuid;
  v_run1     uuid := gen_random_uuid();
  v_run2     uuid := gen_random_uuid();
  v_run3     uuid := gen_random_uuid();
  v_run4     uuid := gen_random_uuid();
  v_run5     uuid := gen_random_uuid();
  v_run6     uuid := gen_random_uuid();
  v_run7     uuid := gen_random_uuid();
  v_run8     uuid := gen_random_uuid();
  v_run9     uuid := gen_random_uuid();
  v_run10    uuid := gen_random_uuid();
  v_lease    timestamptz;
  v_renewed  timestamptz;
  v_pass     uuid;
  v_denied   boolean;
  v_n        bigint;
  v_started constant text := 'discovery.team_mailbox_proposal_started';
  v_finished constant text := 'discovery.team_mailbox_proposal_finished';
  v_counts  constant jsonb := '{"asked":3,"deal":1,"notDeal":1,"invalid":1,"failed":0}'::jsonb;
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,   'g1p-dir@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin, 'g1p-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_bea,   'g1p-bea@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id = v_t;
  insert into companies (id, tenant_id, name, type) values (v_bank, v_t, 'G1 Pass Bank', 'bank'), (v_bank2, v_t, 'G1 Pass Bank 2', 'bank');
  -- The director first: company_has_director refuses a bank of members only.
  update users set company_id = v_bank, company_role = 'director' where id = v_dir;
  update users set company_id = v_bank, company_role = 'member' where tenant_id = v_t and id <> v_dir;
  update users set firm_role = 'admin' where id = v_admin;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_bank);
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'tp.example', 'dwd-reader@proj-92.iam.gserviceaccount.com', '923456789012345679',
     'dir-reader@proj-92.iam.gserviceaccount.com', 'conductia-ingest@tp.example', v_bank, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (gen_random_uuid(), v_t, 'bea@bank.example', v_dir, v_bank, 'member', 'accepted', 'sent', now(), v_bea);
  perform pg_temp.on_deal(v_bea);
  set local role authenticated;
  perform pg_temp.act_as(v_bea);
  perform mailbox_consent_grant();
  -- The team inbox, connected by the firm admin and confirmed by the Directory check.
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('deals@tp.example', 1);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_tm       := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_team := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  select id into v_src_bea from content_sources where tenant_id = v_t and address = 'bea@bank.example' and owner_user_id = v_bea;
  if v_tm is null or v_src_team is null or v_src_bea is null then
    raise exception 'FAIL: the pass fixture did not create its sources';
  end if;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-g01-pass');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
    values (v_t, 'mailbox', 'bea.alt@bank.example', v_bea, 'microsoft') returning id into v_src_alt;
  insert into content_sources (tenant_id, kind, address, provider)
    values (v_t, 'mailbox', 'orphan@bank.example', 'microsoft') returning id into v_src_orph;

  -- ── begin refuses, and leaves no pass and no started row ─────────────────
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_orph, v_run1, array[v_bank]), '42501:no_reader',
    'an ownerless source that is no team inbox has no reader');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_alt, v_run1, array[v_bank]), '42501:no_reader',
    'nor has a personal source its owner holds off the allowlist');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, gen_random_uuid(), v_run1, array[v_bank]), '22023:source not in tenant', 'an unknown source');
  perform pg_temp.expect_text(pg_temp.try_begin(gen_random_uuid(), v_src_team, v_run1, array[v_bank]), '22023:source not in tenant',
    'a source of another tenant');
  perform pg_temp.expect_text(left(pg_temp.try_begin(v_t, v_src_team, null, array[v_bank]), 5), '22023', 'a run is required');
  perform pg_temp.expect_text(left(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank], 'live'), 5), '22023', 'and a known path');

  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank]), '42501:team_not_approved',
    'the reviewed firm list alone is not enough: no approval row');
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_bank2, 'team_proposals', 'g01-pass-a');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank, v_bank2]), '42501:team_not_approved',
    'another firm company''s row does not approve this inbox');
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_bank, 'milestone_rules', 'g01-pass-b');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank]), '42501:team_not_approved',
    'nor does another capability''s row');
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_bank, 'team_proposals', 'g01-pass-c');
  update discovery_tenant_approvals set revoked_at = now()
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank]), '42501:team_not_approved', 'nor does a revoked row');
  update discovery_tenant_approvals set revoked_at = null, decision_ref = 'g01-pass-d'
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[]::uuid[]), '42501:team_not_approved',
    'the row alone is not enough: an empty reviewed list');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, null), '42501:team_not_approved', 'no list at all');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank2]), '42501:team_not_approved',
    'a list that names another firm company');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[null::uuid]), '42501:team_not_approved', 'a list of nothing');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team), 0, 'no refusal left a pass');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 0, 'and none wrote a started row');

  -- ── begin, with both halves set: one pass, one started row ──────────────
  v_json := discovery_begin_proposal_source(v_t, v_src_team, v_run1, 'recorded', array[v_bank]);
  perform pg_temp.expect_text(v_json ->> 'scope', 'team', 'both halves open a team pass');
  v_lease := (v_json ->> 'leaseUntil')::timestamptz;
  perform pg_temp.expect(pg_temp.flag(v_lease = now() + interval '30 minutes'), 1, 'with a 30-minute lease');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'one open pass');
  select id into v_pass from discovery_team_proposal_passes where content_source_id = v_src_team;
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where id = v_pass and tenant_id = v_t and team_mailbox_id = v_tm and firm_company_id = v_bank
                            and run_id = v_run1 and path = 'recorded' and counts = '{}'::jsonb
                            and closed_at is null and outcome is null and lease_until = v_lease), 1,
    'it names the inbox, its firm company and the run, and carries no counts yet');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 1, 'one started row');
  v_detail := pg_temp.last_pass_audit(v_t, v_started);
  perform pg_temp.expect((select count(*) from jsonb_object_keys(v_detail)), 6, 'with six keys and nothing else');
  perform pg_temp.expect_text(v_detail ->> 'passId', v_pass::text, 'the pass id');
  perform pg_temp.expect_text(v_detail ->> 'sourceId', v_src_team::text, 'the source');
  perform pg_temp.expect_text(v_detail ->> 'teamMailboxId', v_tm::text, 'the inbox');
  perform pg_temp.expect_text(v_detail ->> 'firmCompanyId', v_bank::text, 'its firm company');
  perform pg_temp.expect_text(v_detail ->> 'runId', v_run1::text, 'the run');
  perform pg_temp.expect_text(v_detail ->> 'path', 'recorded', 'and the path');
  perform pg_temp.expect((select count(*) from audit_log a where a.tenant_id = v_t and a.action = v_started
                            and a.actor_type = 'service' and a.actor_id is null and a.service_identity is not null), 1,
    'written as a service row that names its identity');

  -- ── Begin again by the same run is idempotent ────────────────────────────
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank]), 'ok:team', 'the same run may begin again');
  v_json := discovery_begin_proposal_source(v_t, v_src_team, v_run1, 'recorded', array[v_bank]);
  perform pg_temp.expect(pg_temp.flag((v_json ->> 'leaseUntil')::timestamptz = v_lease), 1, 'it gets its own lease back');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team), 1, 'and opens no second pass');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 1, 'or a second started row');

  -- ── A personal source needs no pass ──────────────────────────────────────
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_bea, v_run1, array[]::uuid[]), 'ok:personal',
    'a personal source on the allowlist is answered at once, with no firm list');
  perform pg_temp.expect(pg_temp.n_pass(v_src_bea), 0, 'it opens no pass');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 1, 'and writes no started row');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_bea, v_run1, array[]::uuid[]), 'ok:personal', 'renew answers the same');

  -- ── Another run: a fresh lease holds the source; the unique index backs it ──
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run2, array[v_bank]), '55P03:pass_in_progress',
    'another run cannot begin under a fresh lease');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'the first pass is still the only one');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 1, 'and the refused begin wrote no started row');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id, path, lease_until) '
      'values (%L, %L, %L, %L, %L, ''recorded'', now())', v_t, v_src_team, v_tm, v_bank, v_run3)), 5), '23505',
    'the partial unique index: one open pass per source');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id, path, lease_until) '
      'values (%L, %L, %L, %L, %L, ''recorded'', now())', v_t, v_src_team, v_tm, v_bank, v_run1)), 5), '23505',
    'and one pass per run and source');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run2, array[v_bank]), '42501:pass_not_open',
    'a run that holds no pass cannot renew the first one''s');
  perform discovery_end_proposal_source(v_t, v_src_team, v_run2, 'complete', '{}'::jsonb);
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'nor end it: ending as a foreign run closes nothing');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), 0, 'and writes no finished row');

  -- ── renew: once per page, the same three checks, the lease and the counts ──
  update discovery_team_proposal_passes set lease_until = now() + interval '1 minute' where id = v_pass;
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run1, array[v_bank], v_counts), 'ok:team', 'the run renews its pass');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where id = v_pass and lease_until = now() + interval '30 minutes' and renewed_at = now()
                            and counts = v_counts and closed_at is null), 1, 'the lease is 30 minutes again and the counts are kept');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run1, array[v_bank],
      '{"asked":-1,"deal":1.5,"notDeal":"x","invalid":null,"failed":99999999999,"extra":7}'::jsonb), 'ok:team', 'a renew with bad counts still renews');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where id = v_pass and counts = '{"asked":0,"deal":0,"notDeal":0,"invalid":0,"failed":0}'::jsonb), 1,
    'bad counts are cleaned to zero, and no other key is kept');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run1, array[v_bank], null), 'ok:team', 'null counts are cleaned too');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run1, array[v_bank], v_counts), 'ok:team', 'the last good counts are kept');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run1, array[]::uuid[], v_counts), '42501:team_not_approved',
    'renew checks the reviewed list again');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, gen_random_uuid(), v_run1, array[v_bank]), '22023:source not in tenant', 'and the source');

  -- ── Revoked mid-pass: the next renew and begin refuse, and the lease is not extended ──
  update discovery_team_proposal_passes set lease_until = now() + interval '1 minute' where id = v_pass;
  update discovery_tenant_approvals set revoked_at = now()
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run1, array[v_bank], v_counts), '42501:team_not_approved',
    'renew refuses once the approval is revoked');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run1, array[v_bank]), '42501:team_not_approved',
    'and so does the same run''s begin');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where id = v_pass and lease_until = now() + interval '1 minute' and closed_at is null), 1,
    'the pass stays open, its lease not extended');
  update discovery_tenant_approvals set revoked_at = null, decision_ref = 'g01-pass-e'
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';

  -- ── A lapsed lease: the next run's begin closes the old pass as unclosed ──
  v_renewed := now() - interval '40 minutes';
  update discovery_team_proposal_passes set renewed_at = v_renewed, lease_until = now() - interval '1 minute' where id = v_pass;
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run2, array[v_bank]), 'ok:team', 'a lapsed lease no longer holds the source');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team), 2, 'two passes now');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'one of them open');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where id = v_pass and outcome = 'unclosed' and closed_at = now() and counts = v_counts), 1,
    'the old pass is closed unclosed, with the last counts it kept');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes where content_source_id = v_src_team
                            and run_id = v_run2 and closed_at is null and lease_until = now() + interval '30 minutes'), 1,
    'and the new run holds a fresh pass');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 2, 'the new pass is started');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), 1, 'and the old one is finished');
  v_detail := pg_temp.last_pass_audit(v_t, v_finished);
  perform pg_temp.expect_text(v_detail ->> 'outcome', 'unclosed', 'as unclosed');
  perform pg_temp.expect_text(v_detail ->> 'runId', v_run1::text, 'for the first run');
  perform pg_temp.expect_text(v_detail ->> 'passId', v_pass::text, 'and the first pass');
  perform pg_temp.expect(pg_temp.flag((v_detail ->> 'lastRenewedAt')::timestamptz = v_renewed), 1, 'naming when it was last renewed');
  perform pg_temp.expect(pg_temp.flag((v_detail -> 'counts') = v_counts), 1, 'and its last counts');
  perform pg_temp.expect((select count(*) from jsonb_object_keys(v_detail)), 9, 'with nine keys and nothing else');
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run1, array[v_bank], v_counts), '42501:pass_not_open',
    'the first run can no longer renew its closed pass');
  perform discovery_end_proposal_source(v_t, v_src_team, v_run1, 'complete', v_counts);
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), 1, 'nor end it again');

  -- ── end: one finished row, once ──────────────────────────────────────────
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run3, array[v_bank]), '55P03:pass_in_progress',
    'the second run''s lease is fresh');
  perform discovery_end_proposal_source(v_t, v_src_team, v_run2, 'complete', '{"asked":5,"deal":2,"notDeal":2,"invalid":1,"failed":0}'::jsonb);
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 0, 'ending closes the pass');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where content_source_id = v_src_team and run_id = v_run2 and outcome = 'complete' and closed_at = now()
                            and counts = '{"asked":5,"deal":2,"notDeal":2,"invalid":1,"failed":0}'::jsonb), 1,
    'with its outcome and counts');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), 2, 'and one finished row');
  v_detail := pg_temp.last_pass_audit(v_t, v_finished);
  perform pg_temp.expect_text(v_detail ->> 'outcome', 'complete', 'the finished row says how it ended');
  perform pg_temp.expect_text(v_detail ->> 'runId', v_run2::text, 'for the second run');
  perform pg_temp.expect((select count(*) from jsonb_object_keys(v_detail)), 8, 'with eight keys and nothing else');
  perform pg_temp.expect(pg_temp.flag((v_detail -> 'counts') = '{"asked":5,"deal":2,"notDeal":2,"invalid":1,"failed":0}'::jsonb), 1,
    'and the integer counts');
  perform discovery_end_proposal_source(v_t, v_src_team, v_run2, 'error', '{}'::jsonb);
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), 2, 'ending again is a no-op');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes where run_id = v_run2 and outcome = 'complete'), 1,
    'it does not rewrite the outcome');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select discovery_end_proposal_source(%L, %L, %L, %L, %L)',
      v_t, v_src_team, v_run3, 'bogus', '{}')), 5), '22023', 'an unknown outcome is refused');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select discovery_end_proposal_source(%L, %L, %L, %L, %L)',
      v_t, v_src_team, v_run3, 'unclosed', '{}')), 5), '22023', 'and unclosed is a later begin''s alone to write');
  perform pg_temp.expect_text(pg_temp.try_sql(format('select discovery_end_proposal_source(%L, %L, %L, %L, %L)',
      v_t, v_src_alt, v_run3, 'complete', '{}')), 'ok', 'ending a source with no pass is a no-op');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run2, array[v_bank]), '42501:pass_closed',
    'a run does not reopen the pass it ended');

  -- ── A revoked approval still lets the pass be closed ─────────────────────
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run3, array[v_bank]), 'ok:team', 'a new run opens a new pass');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 3, 'with its own started row');
  update discovery_tenant_approvals set revoked_at = now()
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  perform discovery_end_proposal_source(v_t, v_src_team, v_run3, 'revoked', v_counts);
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where content_source_id = v_src_team and run_id = v_run3 and outcome = 'revoked'), 1,
    'end asks no approval: a revoked source can still be closed');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), 3, 'and is audited');
  update discovery_tenant_approvals set revoked_at = null, decision_ref = 'g01-pass-f'
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';

  -- ── A refused inbox: renew and begin refuse, end still closes ────────────
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run4, array[v_bank]), 'ok:team', 'a fourth run opens a pass');
  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'alias', null);
  perform pg_temp.expect_text(pg_temp.try_renew(v_t, v_src_team, v_run4, array[v_bank], v_counts), '42501:team_inbox_not_allowed',
    'renew refuses once the inbox is refused');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run5, array[v_bank]), '42501:team_inbox_not_allowed',
    'and so does a new run''s begin, before it looks at the open pass');
  perform discovery_end_proposal_source(v_t, v_src_team, v_run4, 'refused', v_counts);
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where content_source_id = v_src_team and run_id = v_run4 and outcome = 'refused'), 1,
    'end closes the pass of a refused inbox');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run5, array[v_bank]), '42501:team_inbox_not_allowed', 'and no new pass opens');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_started), 4, 'four passes were started');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), 4, 'and all four finished');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 0, 'none is left open');

  -- ── The audit rows hold ids and codes only ───────────────────────────────
  perform pg_temp.expect((select count(*) from audit_log a
                          where a.tenant_id = v_t and a.action in (v_started, v_finished)
                            and (a.detail::text ilike '%tp.example%' or a.detail::text ilike '%deals@%')), 0, 'no audit row names the inbox address');
  perform pg_temp.expect((select count(*) from audit_log a
                          where a.tenant_id = v_t and a.action in (v_started, v_finished)
                            and a.actor_type = 'service' and a.actor_id is null and a.service_identity is not null), 8,
    'every pass row is a service row that names its identity');

  -- ── The table keeps its own invariants ───────────────────────────────────
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'update discovery_team_proposal_passes set outcome = null where run_id = %L', v_run2)), 5), '23514',
    'a closed pass always says how it ended');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'update discovery_team_proposal_passes set outcome = ''bogus'' where run_id = %L', v_run2)), 5), '23514', 'with one of the listed outcomes');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
      'update discovery_team_proposal_passes set counts = ''[1]''::jsonb where run_id = %L', v_run2)), 5), '23514', 'and its counts are an object');
  perform pg_temp.expect_text((select confdeltype::text from pg_constraint
                               where conrelid = 'public.discovery_team_proposal_passes'::regclass and contype = 'f'
                                 and confrelid = 'public.content_sources'::regclass),
    'c', 'a pass goes with its source (on delete cascade)');

  -- ── Roles: the worker runs them, a signed-in user cannot ─────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_bea);
  v_denied := false;
  begin
    perform discovery_begin_proposal_source(v_t, v_src_bea, v_run5, 'recorded', array[v_bank]);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not call begin'; end if;
  v_denied := false;
  begin
    perform discovery_renew_proposal_source(v_t, v_src_bea, v_run5, array[v_bank], '{}'::jsonb);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not call renew'; end if;
  v_denied := false;
  begin
    perform discovery_end_proposal_source(v_t, v_src_bea, v_run5, 'complete', '{}'::jsonb);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not call end'; end if;
  v_denied := false;
  begin
    perform count(*) from discovery_team_proposal_passes;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not read the passes'; end if;
  reset role;
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if discovery_begin_proposal_source(v_t, v_src_bea, v_run5, 'recorded', array[]::uuid[]) ->> 'scope' is distinct from 'personal' then
    raise exception 'FAIL: the service role may call begin';
  end if;
  select count(*) into v_n from discovery_team_proposal_passes where tenant_id = v_t;
  if v_n <> 4 then raise exception 'FAIL: the service role reads the passes (got %)', v_n; end if;
  v_denied := false;
  begin
    insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id, path, lease_until)
      values (v_t, v_src_team, v_tm, v_bank, gen_random_uuid(), 'recorded', now());
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: the service role may not write a pass directly'; end if;
  v_denied := false;
  begin
    update discovery_team_proposal_passes set lease_until = now() where tenant_id = v_t;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: the service role may not update a pass directly'; end if;
  v_denied := false;
  begin
    delete from discovery_team_proposal_passes where tenant_id = v_t;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: the service role may not delete a pass directly'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── The signatures the worker calls ──────────────────────────────────────
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_begin_proposal_source(uuid,uuid,uuid,text,uuid[])'::regprocedure),
    'p_tenant uuid, p_source uuid, p_run uuid, p_path text, p_firm_ids uuid[]', 'begin takes a tenant, a source, a run, a path and the reviewed firm list');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_begin_proposal_source(uuid,uuid,uuid,text,uuid[])'::regprocedure),
    'jsonb', 'and answers a scope');
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_renew_proposal_source(uuid,uuid,uuid,uuid[],jsonb)'::regprocedure),
    'p_tenant uuid, p_source uuid, p_run uuid, p_firm_ids uuid[], p_counts jsonb', 'renew takes the list and the counts');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_renew_proposal_source(uuid,uuid,uuid,uuid[],jsonb)'::regprocedure),
    'jsonb', 'and answers a scope');
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_end_proposal_source(uuid,uuid,uuid,text,jsonb)'::regprocedure),
    'p_tenant uuid, p_source uuid, p_run uuid, p_outcome text, p_counts jsonb', 'end takes an outcome and the counts');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_end_proposal_source(uuid,uuid,uuid,text,jsonb)'::regprocedure),
    'void', 'and answers nothing');

  -- ── Review F5: a crashed pass is closed even when nobody may begin again ──
  -- The inbox is refused (above). A pass a crashed run left open, put in by the table owner: its lease has lapsed.
  insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id, path,
                                              renewed_at, lease_until, counts)
    values (v_t, v_src_team, v_tm, v_bank, v_run6, 'recorded', now() - interval '40 minutes', now() - interval '10 minutes', v_counts);
  -- Crash + refusal: the next run's begin refuses, and its refusal rolls back anything it closed.
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run7, array[v_bank]), '42501:team_inbox_not_allowed',
    'after a crash, a refused inbox refuses the next begin');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'so begin cannot close the crashed pass');
  v_n := pg_temp.n_pass_audit(v_t, v_finished);
  perform pg_temp.expect(discovery_close_lapsed_proposal_passes(v_t), 1, 'the sweep closes it');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes
                          where run_id = v_run6 and outcome = 'unclosed' and closed_at = now() and counts = v_counts), 1,
    'as unclosed, with the last counts it kept');
  perform pg_temp.expect(pg_temp.n_pass_audit(v_t, v_finished), v_n + 1, 'and audits it as finished');
  v_detail := pg_temp.last_pass_audit(v_t, v_finished);
  perform pg_temp.expect_text(v_detail ->> 'outcome', 'unclosed', 'the finished row says unclosed');
  perform pg_temp.expect_text(v_detail ->> 'runId', v_run6::text, 'for the crashed run');
  perform pg_temp.expect(pg_temp.flag(v_detail ? 'lastRenewedAt'), 1, 'with the last renewal it saw');
  perform pg_temp.expect(discovery_close_lapsed_proposal_passes(v_t), 0, 'a second sweep finds nothing');

  -- Crash + permanent revoke (and the TS entry removed): begin refuses on the switch, the sweep still closes the pass.
  insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id, path,
                                              renewed_at, lease_until, counts)
    values (v_t, v_src_team, v_tm, v_bank, v_run8, 'recorded', now() - interval '40 minutes', now() - interval '1 second', v_counts);
  update discovery_tenant_approvals set revoked_at = now()
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run9, array[v_bank]), '42501:team_not_approved',
    'after a crash, a revoked approval refuses the next begin');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run9, array[]::uuid[]), '42501:team_not_approved',
    'and so does an emptied TS list');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'and the crashed pass stays open after both refusals');
  perform pg_temp.expect(discovery_close_lapsed_proposal_passes(v_t), 1, 'the sweep closes it without asking the switch');
  perform pg_temp.expect((select count(*) from discovery_team_proposal_passes where run_id = v_run8 and outcome = 'unclosed'), 1,
    'as unclosed');

  -- A fresh lease is left alone, and the sweep is per tenant.
  insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id, path, lease_until)
    values (v_t, v_src_team, v_tm, v_bank, v_run10, 'recorded', now() + interval '10 minutes');
  perform pg_temp.expect(discovery_close_lapsed_proposal_passes(v_t), 0, 'a pass whose lease is fresh is not closed');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'it stays open');
  update discovery_team_proposal_passes set lease_until = now() - interval '1 minute' where run_id = v_run10;
  perform pg_temp.expect(discovery_close_lapsed_proposal_passes(gen_random_uuid()), 0, 'another tenant''s sweep closes nothing');
  perform pg_temp.expect(pg_temp.n_pass(v_src_team, true), 1, 'not even a lapsed pass of this one');
  perform pg_temp.expect_text(left(pg_temp.try_sql('select discovery_close_lapsed_proposal_passes(null)'), 5), '22023',
    'and a sweep needs a tenant');
  set local role authenticated;
  perform pg_temp.act_as(v_bea);
  v_denied := false;
  begin
    perform discovery_close_lapsed_proposal_passes(v_t);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user may not call the sweep'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_close_lapsed_proposal_passes(uuid)'::regprocedure),
    'p_tenant uuid', 'the sweep takes a tenant');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_close_lapsed_proposal_passes(uuid)'::regprocedure),
    'integer', 'and answers how many it closed');

  raise notice 'PASS: discovery model proposals: team pass (begin matrix, idempotence, concurrency, renew, lapse, end, roles, signatures, the lapsed-pass sweep)';
end $$;

-- ── The team readers and the writer's team branch (G-01 #173, slice 4: 20261023110300_discovery_team_proposal_read.sql) ──
-- Who reads the proposals of a team inbox (app_reads_team_mailbox, app_reads_proposal_source and the select policy on
-- them) and what the writer asks of a team source (a live team_proposals approval and an open pass of the row's run).
-- The block builds its own tenant:
--
--   Mia     an open reader of the inbox          Rob   a reader the admin removed again
--   Eve     a banker of the firm, never added    Admin the firm admin (reads nothing)
--   CCO     the CCO of the inbox's firm company  CCO2  a CCO seated in ANOTHER company of the tenant
--   Far     a CCO of another tenant              Bea   a banker with a personal mailbox (rows unchanged)
--
-- Team rows are made the only way they can be: an approval, `begin`, then the writer. A row with no pass is put in by the
-- table owner, as a build without `begin` would have left it.
create function pg_temp.reads(p_user uuid) returns bigint language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return (select count(*) from discovery_model_proposals);
end;
$$;
create function pg_temp.reads_src(p_user uuid, p_source uuid) returns bigint language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return (select count(*) from discovery_model_proposals where content_source_id = p_source);
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_far_t    uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_dir2     uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_mia      uuid := gen_random_uuid();
  v_rob      uuid := gen_random_uuid();
  v_eve      uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_cco2     uuid := gen_random_uuid();
  v_far      uuid := gen_random_uuid();
  v_bea      uuid := gen_random_uuid();
  v_bank     uuid := gen_random_uuid();
  v_bank2    uuid := gen_random_uuid();
  v_out      jsonb;
  v_tm       uuid;
  v_tm2      uuid;
  v_src_team uuid;
  v_src_bea  uuid;
  v_src_orph uuid;
  v_teal     uuid := gen_random_uuid();
  v_run_a    uuid := gen_random_uuid();
  v_run_b    uuid := gen_random_uuid();
  v_run_x    uuid := gen_random_uuid();
  v_denied   boolean;
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,   'g1r-dir@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir2,  'g1r-dir2@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin, 'g1r-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_mia,   'g1r-mia@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_rob,   'g1r-rob@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_eve,   'g1r-eve@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_cco,   'g1r-cco@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_cco2,  'g1r-cco2@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_bea,   'g1r-bea@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_far,   'g1r-far@example.test',   jsonb_build_object('tenant_id', v_far_t, 'department', 'compliance'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_far_t);
  insert into companies (id, tenant_id, name, type) values (v_bank, v_t, 'G1 Read Bank', 'bank'), (v_bank2, v_t, 'G1 Read Bank 2', 'bank');
  -- The directors first: company_has_director refuses a bank of members only.
  update users set company_id = v_bank,  company_role = 'director' where id = v_dir;
  update users set company_id = v_bank2, company_role = 'director' where id = v_dir2;
  update users set company_id = v_bank,  company_role = 'member' where id in (v_admin, v_mia, v_rob, v_eve, v_cco, v_bea);
  update users set company_id = v_bank2, company_role = 'member' where id = v_cco2;
  update users set firm_role = 'admin' where id = v_admin;
  update users set firm_role = 'cco' where id in (v_cco, v_cco2, v_far);
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_bank);
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values (v_far_t, 'fixture', 'fixture', 'active');
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'tr.example', 'dwd-reader@proj-93.iam.gserviceaccount.com', '923456789012345680',
     'dir-reader@proj-93.iam.gserviceaccount.com', 'conductia-ingest@tr.example', v_bank, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (gen_random_uuid(), v_t, 'bea@bank.example', v_dir, v_bank, 'member', 'accepted', 'sent', now(), v_bea);
  perform pg_temp.on_deal(v_bea);
  set local role authenticated;
  perform pg_temp.act_as(v_bea);
  perform mailbox_consent_grant();
  -- The team inbox, connected by the firm admin and confirmed by the Directory check; Mia and Rob are added, Rob removed.
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('deals@tr.example', 1);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_tm       := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_team := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  select id into v_src_bea from content_sources where tenant_id = v_t and address = 'bea@bank.example' and owner_user_id = v_bea;
  if v_tm is null or v_src_team is null or v_src_bea is null then
    raise exception 'FAIL: the reader fixture did not create its sources';
  end if;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-g01-read');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_mia);
  perform discovery_add_team_mailbox_member(v_tm, v_rob);
  perform discovery_remove_team_mailbox_member(v_tm, v_rob);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into content_sources (tenant_id, kind, address, provider)
    values (v_t, 'mailbox', 'orphan@bank.example', 'microsoft') returning id into v_src_orph;
  -- Teal is a candidate only the team inbox backs.
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess, last_seen_at)
    values (v_teal, v_t, 'codename:g1r-teal', 'Project Teal', 'Project Teal', now());
  perform pg_temp.back(v_t, v_teal, v_src_team, 'g1r-teal');
  perform discovery_refresh_candidate_visibility(v_teal);
  perform pg_temp.expect(pg_temp.flag(app_can_see_candidate(v_teal, v_mia)), 1, 'premise: an open reader sees the inbox''s candidate');
  perform pg_temp.expect(pg_temp.flag(app_can_see_candidate(v_teal, v_cco)), 1, 'premise: so does the inbox firm''s CCO');

  -- ── The writer's team branch ─────────────────────────────────────────────
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w0>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'a team source is refused while no approval row exists');
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_bank2, 'team_proposals', 'g01-read-a'), (v_t, v_bank, 'milestone_rules', 'g01-read-b');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w0>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'another firm company''s row and another capability''s row do not approve it');
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_bank, 'team_proposals', 'g01-read-c');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w0>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'an approval without an open pass is not enough');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where content_source_id = v_src_team), 0, 'no refusal left a row');
  perform pg_temp.expect_text(pg_temp.try_begin(v_t, v_src_team, v_run_a, array[v_bank]), 'ok:team', 'begin opens the run''s pass');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w1>', jsonb_build_object('run_id', v_run_a,
      'deal_key', 'm:project-one', 'deal_name', 'Project One'))), 'ok', 'with both, the team source is written');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w2>', jsonb_build_object('run_id', v_run_a,
      'deal_key', 'm:project-two', 'deal_name', 'Project Two'))), 'ok', 'again');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w3>', jsonb_build_object('run_id', v_run_a,
      'deal_key', 'c:' || v_teal, 'deal_name', 'Project Teal', 'candidate_id', v_teal))), 'ok', 'and a candidate its inbox backs');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w4>', jsonb_build_object('run_id', v_run_a,
      'outcome', 'not_deal', 'deal_key', null, 'deal_name', null, 'phase', null, 'p_phase', null))), 'ok', 'and a not-deal answer');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w5>', jsonb_build_object('run_id', v_run_b))),
    '42501:team_not_approved', 'a run that holds no pass cannot write');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w5>', jsonb_build_object('run_id', null))),
    '42501:team_not_approved', 'nor can a row with no run');
  update discovery_tenant_approvals set revoked_at = now()
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w5>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'a revoked approval stops the writer though the pass is still open');
  update discovery_tenant_approvals set revoked_at = null, decision_ref = 'g01-read-d'
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  -- Review F6: an open pass whose lease has lapsed admits no write (the table's owner backdates it, then restores it).
  update discovery_team_proposal_passes set lease_until = now() - interval '1 second'
    where content_source_id = v_src_team and run_id = v_run_a;
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w5>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'an open pass whose lease has lapsed admits no write');
  update discovery_team_proposal_passes set lease_until = now()
    where content_source_id = v_src_team and run_id = v_run_a;
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w5>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'nor one whose lease ends this instant');
  update discovery_team_proposal_passes set lease_until = now() + interval '30 minutes'
    where content_source_id = v_src_team and run_id = v_run_a;
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_orph, '<g1r-w6>')),
    '22023:discovery_record_model_proposal: source has no reader', 'an ownerless source that is no team inbox is refused first');
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_bea, '<g1r-w7>', jsonb_build_object('run_id', v_run_b))),
    'ok', 'a personal source is written with no approval and no pass, as before');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where content_source_id = v_src_team), 4,
    'the team source holds its four rows');
  -- A row the table's owner put in with no pass, as a build without `begin` would have left it.
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, outcome, deal_key, deal_name,
                                         phase, model, prompt_version, prompt_hash, run_id)
    values (v_t, v_src_team, encode(sha256(convert_to('<g1r-passless>', 'UTF8')), 'hex'), encode(sha256('p'::bytea), 'hex'),
            'deal', 'm:project-ghost', 'Project Ghost', 'phase-1', 'm', 'v1', 'h', v_run_x);

  -- ── app_reads_team_mailbox, on its own (asked as the service role, about anyone) ──
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_mia)), 1, 'an open member reads the inbox');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_cco)), 1, 'and so does the inbox firm''s CCO, with no membership');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_admin)), 0, 'a firm admin does not');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_rob)), 0, 'nor a removed member');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_eve)), 0, 'nor a banker of the firm who was never added');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_cco2)), 0, 'nor a CCO of another firm company');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_far)), 0, 'nor another tenant''s user');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, null)), 0, 'nor nobody');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(gen_random_uuid(), v_cco)), 0, 'nor anyone, for an inbox that does not exist');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(null, v_cco)), 0, 'or for no inbox');
  update users set status = 'suspended' where id = v_cco;
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_cco)), 0, 'a CCO who is no longer active reads nothing');
  update users set status = 'active' where id = v_cco;
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_cco)), 1, 'and reads again once the seat is back');

  -- ── app_reads_proposal_source, on its own ────────────────────────────────
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_a, v_mia)), 1, 'a reader reads the source''s rows of a run that holds a pass');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_a, v_cco)), 1, 'and so does the CCO');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_x, v_mia)), 0, 'but not those of a run with no pass');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, null, v_mia)), 0, 'or of no run');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_far_t, v_run_a, v_mia)), 0, 'a tenant that does not own the source reads nothing');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_a, v_admin)), 0, 'a firm admin does not');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_a, v_cco2)), 0, 'nor a CCO of another firm company');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_bea, v_t, v_run_b, v_bea)), 1, 'a personal source is read by its owner');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_bea, v_t, v_run_b, v_cco)), 0, 'and not by the CCO');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_orph, v_t, v_run_a, v_cco)), 0, 'an ownerless source that is no team inbox is read by nobody');

  -- ── Who reads the rows, through the policy ───────────────────────────────
  set local role authenticated;
  perform pg_temp.expect(pg_temp.reads(v_mia), 3, 'an open member sees the inbox''s three deal rows (two named, one candidate), not the passless row nor the not-deal one');
  perform pg_temp.expect(pg_temp.reads_src(v_mia, v_src_team), 3, 'all of them read from the inbox');
  perform pg_temp.expect(pg_temp.reads(v_cco), 3, 'the inbox firm''s CCO sees the same three');
  perform pg_temp.expect(pg_temp.reads(v_cco2), 0, 'a CCO of another firm company sees none');
  perform pg_temp.expect(pg_temp.reads(v_admin), 0, 'the firm admin sees none');
  perform pg_temp.expect(pg_temp.reads(v_rob), 0, 'a removed member sees none');
  perform pg_temp.expect(pg_temp.reads(v_eve), 0, 'a banker of the firm who was never added sees none');
  perform pg_temp.expect(pg_temp.reads(v_far), 0, 'another tenant''s CCO sees none');
  perform pg_temp.expect(pg_temp.reads(v_bea), 1, 'Bea sees her one personal row and nothing of the inbox');
  perform pg_temp.expect(pg_temp.reads_src(v_bea, v_src_bea), 1, 'read from her own mailbox');
  perform pg_temp.expect(pg_temp.reads(v_dir), 0, 'a director who reads no inbox sees none');
  -- Passless rows are invisible to everyone who reads the inbox.
  perform pg_temp.act_as(v_mia);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-ghost'), 0, 'a team row with no pass is invisible to a reader');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-ghost'), 0, 'and to the CCO');

  -- ── The helpers answer only about the caller ─────────────────────────────
  perform pg_temp.act_as(v_mia);
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_mia)), 1, 'a reader asking about themself is answered truly');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_cco)), 0, 'and told nothing about the CCO');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_a, v_mia)), 1, 'the source helper answers the caller truly');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_a, v_cco)), 0, 'and tells a reader nothing about the CCO');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_mia)), 0, 'the admin cannot ask about a member');
  perform pg_temp.expect(pg_temp.flag(app_reads_proposal_source(v_src_team, v_t, v_run_a, v_mia)), 0, 'nor about a member''s rows');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_mia)), 0, 'nor can the CCO ask about a member');
  -- Nobody signed in changes or runs anything new.
  v_denied := false;
  begin update discovery_model_proposals set phase = 'phase-5'; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user edited a proposal'; end if;
  v_denied := false;
  begin perform discovery_record_model_proposal(v_t, pg_temp.proposal(v_src_team, '<g1r-y1>', jsonb_build_object('run_id', v_run_a)));
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: a signed-in user ran the writer'; end if;
  reset role;
  set local role anon;
  v_denied := false;
  begin perform app_reads_team_mailbox(v_tm, v_mia); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: anon ran app_reads_team_mailbox'; end if;
  v_denied := false;
  begin perform app_reads_proposal_source(v_src_team, v_t, v_run_a, v_mia); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL: anon ran app_reads_proposal_source'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── Reading needs the pass, not a live approval; the inbox decides the rest ──
  perform discovery_end_proposal_source(v_t, v_src_team, v_run_a, 'revoked', '{}'::jsonb);
  update discovery_tenant_approvals set revoked_at = now()
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  set local role authenticated;
  perform pg_temp.expect(pg_temp.reads(v_mia), 3, 'a revoked approval and an ended pass leave the rows readable to the same audience');
  perform pg_temp.expect(pg_temp.reads(v_cco), 3, 'the CCO too');
  perform pg_temp.expect(pg_temp.reads(v_eve), 0, 'and no one else');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w8>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'but nothing more is written under the closed pass');
  update discovery_tenant_approvals set revoked_at = null, decision_ref = 'g01-read-e'
    where tenant_id = v_t and firm_company_id = v_bank and capability = 'team_proposals';
  perform pg_temp.expect_text(pg_temp.try_write(v_t, pg_temp.proposal(v_src_team, '<g1r-w8>', jsonb_build_object('run_id', v_run_a))),
    '42501:team_not_approved', 'and a live approval does not reopen a closed pass');

  -- ── A removed inbox: nobody reads it, the CCO included ───────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('spare@tr.example', 1);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_tm2 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  perform discovery_record_team_mailbox_check(v_tm2, 'verified', null, 'dir-g01-read-spare');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm2, v_cco)), 1, 'the CCO reads a second, verified inbox of the firm');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_remove_team_mailbox(v_tm2);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm2, v_cco)), 0, 'and no longer once the inbox is removed');

  -- ── A refused inbox: nobody reads it, rows included ──────────────────────
  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'alias', null);
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_mia)), 0, 'a refused inbox has no reader: not the member');
  perform pg_temp.expect(pg_temp.flag(app_reads_team_mailbox(v_tm, v_cco)), 0, 'not the CCO');
  set local role authenticated;
  perform pg_temp.expect(pg_temp.reads(v_mia), 0, 'and its rows are read by nobody');
  perform pg_temp.expect(pg_temp.reads(v_cco), 0, 'the CCO included');
  perform pg_temp.expect(pg_temp.reads(v_bea), 1, 'while a personal mailbox is read as before');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── Grants, search path, policy and the frozen signature ─────────────────
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('app_reads_team_mailbox', 'app_reads_proposal_source')
       and (not p.prosecdef or p.provolatile <> 's'
            or array_to_string(p.proconfig, ',') not like '%search_path=public, pg_temp%'
            or has_function_privilege('anon', p.oid, 'execute')
            or not has_function_privilege('authenticated', p.oid, 'execute')
            or not has_function_privilege('service_role', p.oid, 'execute'))),
    0, 'both helpers are stable definers with a pinned search path, executable by signed-in users and the worker, not by anon');
  perform pg_temp.expect(
    (select count(*) from pg_policy where polrelid = 'public.discovery_model_proposals'::regclass
       and polname = 'discovery_model_proposals_select' and pg_get_expr(polqual, polrelid) like '%app_reads_proposal_source%'), 1,
    'the select policy asks the source helper');
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.app_reads_team_mailbox(uuid,uuid)'::regprocedure),
    'p_team_mailbox uuid, p_user uuid', 'app_reads_team_mailbox takes an inbox and a user');
  perform pg_temp.expect_text(pg_get_function_result('public.app_reads_team_mailbox(uuid,uuid)'::regprocedure), 'boolean', 'and answers a boolean');
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.app_reads_proposal_source(uuid,uuid,uuid,uuid)'::regprocedure),
    'p_source uuid, p_tenant uuid, p_run uuid, p_user uuid', 'app_reads_proposal_source takes a source, a tenant, a run and a user');
  perform pg_temp.expect_text(pg_get_function_result('public.app_reads_proposal_source(uuid,uuid,uuid,uuid)'::regprocedure), 'boolean', 'and answers a boolean');
  perform pg_temp.expect_text(pg_get_function_identity_arguments('public.discovery_record_model_proposal(uuid,jsonb)'::regprocedure),
    'p_tenant_id uuid, p_proposal jsonb', 'the writer''s signature is unchanged');
  perform pg_temp.expect_text(pg_get_function_result('public.discovery_record_model_proposal(uuid,jsonb)'::regprocedure), 'uuid', 'and its result');

  raise notice 'PASS: discovery model proposals: team readers (reader matrix, passless rows, helper caller-binding, refused and removed inbox) and the writer''s team branch';
end $$;

rollback;
