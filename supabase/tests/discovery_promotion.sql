-- Deal discovery promotion (20261002220000_discovery_promotion.sql): the service-role
-- promotion definer, the dismissal of the rail's evidence marker, and the two
-- deal-scoped read branches. Run as each role a caller really has, with
-- company_access_management on so deal-create authority is real.
--
--   Alice      a director of the bank: holds deal-create authority, owns the evidence
--   Colleague  a member whose mailbox shares one Kestrel item: sees the candidate, may not promote it
--   Dana       a director with no evidence: may create deals, cannot see the candidate
--   Bob        a member with no evidence, seated on the promoted deal afterwards
--   Outsider   the control room of another tenant
--
-- #262 review, E5 (c): the function itself refuses an actor who cannot see the
-- candidate (Dana) and one who cannot create deals (the colleague). E3: it is
-- granted to service_role alone.
--
-- The last block is a team inbox (#581, 20261019170000_team_mailbox_attach.sql): a member promotes a
-- team-evidenced candidate with a phase, and the promoted deal gains the inbox's later mail only while a
-- reader of the inbox is seated on it (discovery_item_owner_seated), and a seated non-reader sees none of it
-- (invite only, owner decision 2026-10-19).
--
-- The "shared-only writes" block (#173 G-07 slice 1b, 20261023130200_discovery_scoped_writes.sql): promotion,
-- set station and dismissal read only the shared assessment (team_mailbox_id null), a deal opens closed only on
-- a cited model closed event, and a scoped assessment cannot be dismissed yet.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_promotion.sql
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

create function pg_temp.act_as_service()
returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
$$;

-- Runs one statement and answers its SQLSTATE, or 'ok'. Runs under the caller's role.
create function pg_temp.attempt(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

create function pg_temp.expect_attempt(p_sql text, p_expected text, label text)
returns void language plpgsql as $$
declare v_got text := pg_temp.attempt(p_sql);
begin
  if v_got is distinct from p_expected then
    raise exception 'FAIL: % (expected %, got %)', label, p_expected, v_got;
  end if;
end;
$$;

-- One deal-routed message owned by the source's mailbox.
create function pg_temp.mk_item(p_tenant uuid, p_src uuid, p_tag text)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v, p_tenant, 'message', p_tag, '2026-03-01', '<' || p_tag || '@t>', 'h-' || p_tag);
  insert into source_item_texts (source_item_id, body_text) values (v, p_tag || ' body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v, p_src, 'p-' || p_tag);
  return v;
end;
$$;

create function pg_temp.grp(p_key text, p_name text, p_items uuid[])
returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'clusterKey', p_key, 'proposedName', p_name, 'codenameGuess', p_name, 'parties', '[]'::jsonb,
    'firstSeenAt', '2026-03-01T00:00:00Z', 'lastSeenAt', '2026-03-02T00:00:00Z', 'confidence', 0.9,
    'links', (select jsonb_agg(jsonb_build_object('sourceItemId', i, 'method', 'codename', 'confidence', 0.9))
              from unnest(p_items) i)));
$$;

create function pg_temp.cand(p_tenant uuid, p_key text)
returns uuid language sql as $$
  select id from deal_candidates where tenant_id = p_tenant and cluster_key = p_key;
$$;

-- The rail's 61 seed rows, as POST /api/v1/deals/from-discovery sends them.
create function pg_temp.steps()
returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object(
    'stepId', 'p' || ph || '-s' || n, 'seq', n, 'phaseIndex', ph, 'displayOrder', n) order by n)
  from (select n, case when n <= 25 then 1 when n <= 38 then 2 when n <= 44 then 3 when n <= 50 then 4 else 5 end as ph
        from generate_series(1, 61) n) s;
$$;

-- A promote call as SQL text: actor, tenant, bank, candidate, code name, entry seq and status.
create function pg_temp.promote_sql(p_actor uuid, p_tenant uuid, p_bank uuid, p_candidate uuid, p_code text,
                                    p_seq int, p_status text, p_members jsonb default '[]')
returns text language sql as $$
  select format(
    'select discovery_promote_candidate(%L, %L, %L, %L, %L, %L, %s, %s, %L, %L::jsonb, %L::jsonb, %L::jsonb, %L, %L::jsonb)',
    p_actor, p_tenant, p_bank, p_candidate, p_code, 'Synthetic Target', p_seq,
    case when p_seq <= 25 then 1 when p_seq <= 38 then 2 when p_seq <= 44 then 3 when p_seq <= 50 then 4 else 5 end,
    p_status, p_members::text, '{"verdict":"compliant","reasons":[]}', pg_temp.steps()::text, 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
$$;

-- Seats a user on a deal of their tenant as deal team (#262: the one-click opt-in needs MD or deal team on a
-- deal of the tenant). One helper deal per tenant, code 'dd-<tenant>', created on first use. It is not a promoted
-- deal, so the deal counts below exclude it (pg_temp.promoted_deals). Run as the table owner.
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

-- The deals a promotion created: every deal of the tenant but the helper deal.
create function pg_temp.promoted_deals(p_tenant uuid)
returns bigint language sql as $$
  select count(*) from deals where tenant_id = p_tenant and code <> 'dd-' || p_tenant::text;
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

do $$
declare
  v_tenant     uuid := gen_random_uuid();
  v_other      uuid := gen_random_uuid();
  v_alice      uuid := gen_random_uuid();
  v_colleague  uuid := gen_random_uuid();
  v_dana       uuid := gen_random_uuid();
  v_bob        uuid := gen_random_uuid();
  v_outsider   uuid := gen_random_uuid();
  v_src_alice  uuid;
  v_src_coll   uuid;
  v_run        uuid := gen_random_uuid();
  v_bank       uuid := gen_random_uuid();
  v_other_bank uuid := gen_random_uuid();
  v_target_co  uuid := gen_random_uuid();
  v_inv_alice  uuid := gen_random_uuid();
  v_inv_coll   uuid := gen_random_uuid();
  v_kes_a      uuid; v_kes_shared uuid; v_osp_a uuid; v_spa_a uuid; v_rej_a uuid; v_ext_a uuid;
  v_kes uuid; v_osp uuid; v_spa uuid; v_rej uuid; v_ext uuid;
  v_res        jsonb;
  v_deal       uuid;
  v_osp_deal   uuid;
  v_spa_deal   uuid;
  v_assess     uuid;
  v_osp_assess uuid;
  v_osp_closed uuid;
  v_corr       uuid;
  v_got        text;
begin
  -- ── Fixture, as the table owner (the seating of discovery_corrections.sql) ─
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alice,     'pr-alice@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_colleague, 'pr-colleague@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_dana,      'pr-dana@example.test',      jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_bob,       'pr-bob@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_outsider,  'pr-outsider@example.test',  jsonb_build_object('tenant_id', v_other, 'department', 'compliance'));
  update users set status = 'active', is_external = false where id in (v_alice, v_colleague, v_dana, v_bob, v_outsider);
  update users set firm_role = 'cco' where id = v_outsider;

  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values
    (v_tenant, 'fixture', 'fixture', 'active'),
    (v_other, 'fixture', 'fixture', 'active');

  insert into companies (id, tenant_id, name, type) values
    (v_bank, v_tenant, 'PR Bank', 'bank'),
    (v_other_bank, v_other, 'PR Other Bank', 'bank'),
    (v_target_co, v_tenant, 'PR Client Co', 'target');
  update users set company_id = v_bank, company_role = 'director' where id in (v_alice, v_dana);
  update users set company_id = v_bank, company_role = 'member' where id in (v_colleague, v_bob);
  update graph_reader_registrations set mailbox_domains = '{bank.example}', firm_company_id = v_bank
   where tenant_id = v_tenant;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (v_inv_alice, v_tenant, 'alice@bank.example',     v_alice, v_bank, 'director', 'accepted', 'sent', now(), v_alice),
    (v_inv_coll,  v_tenant, 'colleague@bank.example', v_alice, v_bank, 'member',   'accepted', 'sent', now(), v_colleague);
  perform pg_temp.on_deal(u) from unnest(array[v_alice, v_colleague]) u;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_colleague);
  perform mailbox_consent_grant();
  reset role;
  -- Each opt-in created its owner's mailbox source; look the two up.
  select id into v_src_alice from content_sources where tenant_id = v_tenant and address = 'alice@bank.example' and owner_user_id = v_alice;
  select id into v_src_coll  from content_sources where tenant_id = v_tenant and address = 'colleague@bank.example' and owner_user_id = v_colleague;
  if v_src_alice is null or v_src_coll is null then
    raise exception 'FAIL: an opt-in did not create its mailbox source';
  end if;

  -- Deal-create authority is real from here on: the directors hold it, the members do not.
  insert into feature_flags (key, description, enabled)
    values ('company_access_management', 'probe', true)
    on conflict (key) do update set enabled = true;

  -- ── Items, candidates and assessments ───────────────────────────────────
  v_kes_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'kes-a');
  v_kes_shared := pg_temp.mk_item(v_tenant, v_src_alice, 'kes-shared');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_kes_shared, v_src_coll, 'c-kes-shared');
  v_osp_a := pg_temp.mk_item(v_tenant, v_src_alice, 'osp-a');
  v_spa_a := pg_temp.mk_item(v_tenant, v_src_alice, 'spa-a');
  v_rej_a := pg_temp.mk_item(v_tenant, v_src_alice, 'rej-a');
  v_ext_a := pg_temp.mk_item(v_tenant, v_src_alice, 'ext-a');

  perform pg_temp.act_as_service();
  perform discovery_upsert_candidates(v_tenant, v_run,
    pg_temp.grp('k:kes', 'Project Kestrel', array[v_kes_a, v_kes_shared])
    || pg_temp.grp('k:osp', 'Project Osprey', array[v_osp_a])
    || pg_temp.grp('k:spa', 'Project Sparrow', array[v_spa_a])
    || pg_temp.grp('k:rej', 'Project Rejected', array[v_rej_a])
    || pg_temp.grp('k:ext', 'Project Exempt', array[v_ext_a]));
  v_kes := pg_temp.cand(v_tenant, 'k:kes'); v_osp := pg_temp.cand(v_tenant, 'k:osp');
  v_spa := pg_temp.cand(v_tenant, 'k:spa'); v_rej := pg_temp.cand(v_tenant, 'k:rej');
  v_ext := pg_temp.cand(v_tenant, 'k:ext');
  update deal_candidates set discovery_state = 'rejected' where id = v_rej;

  perform discovery_record_assessment(v_tenant, v_kes, jsonb_build_object(
    'stepId', 'p4-s48', 'station', 44, 'lifecycle', 'live', 'reason', 'LOI Review because LOI signed on 18 Sep 2026 (3 emails)',
    'evidenceEventIds', '[]'::jsonb, 'confidence', 0.9, 'flags', '[]'::jsonb, 'engineVersion', 'stage-engine/v1'), 'extraction');
  -- Osprey's closed assessment cites a model closed event: since G-07 slice 1b (20261023130200)
  -- a deal opens closed only on a cited model-basis closed event (written directly, as discovery_rls.sql does).
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id)
    values (v_tenant, v_osp_a, 'closed', '2025-07-15', 0, 5, 0.9, 'v1:m', gen_random_uuid()) returning id into v_osp_closed;
  perform discovery_record_assessment(v_tenant, v_osp, jsonb_build_object(
    'stepId', 'p5-s57', 'station', 53, 'lifecycle', 'closed', 'reason', 'Closing Checklist because closing on 15 Jul 2025 (1 email)',
    'evidenceEventIds', jsonb_build_array(v_osp_closed), 'confidence', 0.9, 'flags', '[]'::jsonb, 'engineVersion', 'stage-engine/v1'), 'extraction');
  select id into v_osp_assess from stage_assessments where candidate_id = v_osp;

  -- An earlier decision on Kestrel: Bob must never read it through the deal.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform discovery_rename_candidate(v_kes, 'Project Kestrel', 'Keep the client''s spelling');
  reset role;
  perform pg_temp.expect(pg_temp.promoted_deals(v_tenant), 0, 'fixture: no promoted deal yet (the helper deal is not one)');
  raise notice 'PASS: fixture';

  -- ── Grants: the promotion is the service role's alone (E3) ───────────────
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_promote_candidate'
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
            or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'))),
    0, 'promote is executable by neither anon, authenticated nor PUBLIC');
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_promote_candidate'
       and has_function_privilege('service_role', p.oid, 'execute')), 1, 'promote is executable by service_role');
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_dismiss_suggestion'
       and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')),
    1, 'dismiss is the signed-in role''s, not anon''s');

  -- A direct call from a signed-in session is refused before the function runs, whoever the actor is.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), '42501',
    'Alice cannot call the promotion directly');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_dana, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), '42501',
    'a signed-in user cannot name another actor');
  reset role;
  set local role anon;
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), '42501',
    'anon cannot call the promotion');
  reset role;
  raise notice 'PASS: promote is service-role only';

  -- ── Refusals, each as the service role, each leaving nothing behind ──────
  set local role service_role;
  perform pg_temp.act_as_service();
  perform pg_temp.expect_attempt(pg_temp.promote_sql(null, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), '42501', 'no actor is refused');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_bank, gen_random_uuid(), 'Project Kestrel', 48, 'active'), 'P0002', 'an unknown candidate is not visible');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_other, v_bank, v_kes, 'Project Kestrel', 48, 'active'), 'P0002', 'another tenant id does not match the candidate');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_outsider, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), 'P0002', 'an actor of another tenant is refused');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_other_bank, v_kes, 'Project Kestrel', 48, 'active'), 'P0002', 'another tenant''s bank is refused');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_target_co, v_kes, 'Project Kestrel', 48, 'active'), 'P0002', 'a company that is not a bank is refused');
  -- E5 (c): Dana can create deals but cannot see Kestrel; the colleague sees it but cannot create deals.
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_dana, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), 'P0002', 'an actor who cannot see the candidate is refused');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_bob, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), 'P0002', 'a member with no evidence is refused as not visible');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_colleague, v_tenant, v_bank, v_kes, 'Project Kestrel', 48, 'active'), '42501', 'an actor who cannot create deals is refused');
  -- A state that cannot be promoted.
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_bank, v_rej, 'Project Rejected', 48, 'active'), '55000', 'a rejected candidate cannot be promoted');
  reset role;

  perform pg_temp.expect(pg_temp.promoted_deals(v_tenant), 0, 'refused calls created no deal');
  perform pg_temp.expect((select count(*) from corrections where action = 'promote' and tenant_id = v_tenant), 0, 'refused calls wrote no promote row');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.candidate_promoted'), 0, 'refused calls wrote no promotion audit row');
  perform pg_temp.expect_text((select discovery_state from deal_candidates where id = v_kes), 'proposed', 'Kestrel is still proposed');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_kes and promoted_deal_id is null), 1, 'Kestrel has no deal');
  raise notice 'PASS: refusals';

  -- ── Promote Kestrel at station 44 (seq 48), seating Bob ─────────────────
  set local role service_role;
  perform pg_temp.act_as_service();
  v_res := discovery_promote_candidate(v_alice, v_tenant, v_bank, v_kes, 'Project Kestrel', 'Synthetic Target', 48, 4, 'active',
    jsonb_build_array(jsonb_build_object('userId', v_bob, 'dealRole', 'deal_team')),
    '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  reset role;
  v_deal := (v_res->'deal'->>'id')::uuid;

  perform pg_temp.expect((select count(*) from deal_steps where deal_id = v_deal), 61, 'the deal is seeded with 61 steps');
  perform pg_temp.expect((select count(*) from deal_steps where deal_id = v_deal and seq < 48 and status = 'skipped_entry'), 47, 'every step below seq 48 is skipped_entry');
  perform pg_temp.expect((select count(*) from deal_steps where deal_id = v_deal and seq = 48 and status = 'current'), 1, 'seq 48 is current');
  perform pg_temp.expect((select count(*) from deal_steps where deal_id = v_deal and seq > 48 and status = 'pending'), 13, 'the rest is pending');
  perform pg_temp.expect((select current_step_seq from deals where id = v_deal), 48, 'the cursor sits at 48');
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_deal), 'live', 'a live assessment opens a live deal');
  perform pg_temp.expect_text((select status from deals where id = v_deal), 'active', 'a phase 4 entry opens an active deal');
  perform pg_temp.expect((select count(*) from deal_memberships where deal_id = v_deal and user_id = v_alice and deal_role = 'md'), 1, 'the actor is the MD');
  perform pg_temp.expect((select count(*) from deal_memberships where deal_id = v_deal and user_id = v_bob), 1, 'Bob is seated');
  perform pg_temp.expect((select count(*) from deals where id = v_deal and mandate_owner_id = v_alice), 1, 'the actor owns the mandate');
  perform pg_temp.expect_text((select discovery_state from deal_candidates where id = v_kes), 'confirmed', 'the candidate is confirmed');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_kes and promoted_deal_id = v_deal), 1, 'the candidate names its deal');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kes and deal_id is distinct from v_deal), 0, 'existing assessments gain the deal');
  perform pg_temp.expect(
    (select count(*) from corrections where candidate_id = v_kes and action = 'promote' and deal_id = v_deal and actor_id = v_alice), 1, 'one promote row, by the actor');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.candidate_promoted' and actor_id = v_alice
        and actor_type = 'user' and deal_id = v_deal and chain_seq is not null
        and detail->>'suggestedStepId' = 'p4-s48' and (detail->>'chosenStepSeq')::int = 48), 1, 'one promotion audit row, by the user');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.candidate_promoted'
        and detail::text ~* '(kestrel|synthetic target)'), 0, 'the promotion audit holds ids only');
  perform pg_temp.expect((select count(*) from audit_log where deal_id = v_deal and action = 'create'), 1, 'Gate 0''s own create audit row is written');
  perform pg_temp.expect((select count(*) from audit_log where deal_id = v_deal and action = 'attest'), 1, 'Gate 0''s conflicts attestation is written');
  perform pg_temp.expect(
    (select count(*) from notifications where deal_id = v_deal and event_type = 'deal_created'), 2, 'Gate 0''s compliance notice is sent (the bank''s two directors)');

  -- A later assessment of the promoted deal copies the deal by trigger.
  perform pg_temp.act_as_service();
  perform discovery_record_assessment(v_tenant, v_kes, jsonb_build_object(
    'stepId', 'p5-s51', 'station', 47, 'lifecycle', 'live', 'reason', 'Signing / Announcement Prep because signing on 26 Oct 2026 (1 email)',
    'evidenceEventIds', '[]'::jsonb, 'confidence', 0.9, 'flags', '[]'::jsonb, 'engineVersion', 'stage-engine/v1'), 'extraction');
  select id into v_assess from stage_assessments where candidate_id = v_kes and step_id = 'p5-s51';
  perform pg_temp.expect((select count(*) from stage_assessments where id = v_assess and deal_id = v_deal), 1, 'a new assessment copies the deal by trigger');
  raise notice 'PASS: promote Kestrel';

  -- ── A second promotion is refused ────────────────────────────────────────
  set local role service_role;
  perform pg_temp.act_as_service();
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_bank, v_kes, 'Project Kestrel Again', 48, 'active'), '23505', 'a second promotion raises already_promoted');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_alice, v_tenant, v_bank, v_ext, 'Project Kestrel', 48, 'active'), '23505', 'a code name live on another deal is refused by Gate 0 (the route tells it from already_promoted by message)');
  reset role;
  perform pg_temp.expect(pg_temp.promoted_deals(v_tenant), 1, 'the refusals created no second deal');
  perform pg_temp.expect_text((select discovery_state from deal_candidates where id = v_ext), 'proposed', 'a refusal by Gate 0 leaves the candidate proposed');
  raise notice 'PASS: second promotion';

  -- ── What a deal member may read (R9) ─────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_kes), 0, 'Bob still cannot read the candidate');
  perform pg_temp.expect((select count(*) from stage_assessments where deal_id = v_deal), 2, 'Bob reads the deal''s assessments');
  perform pg_temp.expect((select count(*) from corrections where deal_id = v_deal and action = 'promote'), 1, 'Bob reads the promote row');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_kes and action = 'rename'), 0, 'Bob does not read the candidate''s other corrections');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_kes), 1, 'the promote row is the only one Bob reads');
  perform pg_temp.act_as(v_dana);
  perform pg_temp.expect((select count(*) from stage_assessments where deal_id = v_deal), 0, 'an unseated director reads no assessment');
  perform pg_temp.expect((select count(*) from corrections where deal_id = v_deal), 0, 'an unseated director reads no promote row');
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect((select count(*) from stage_assessments where deal_id = v_deal), 0, 'another tenant reads no assessment');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_kes), 2, 'Alice reads the rename and the promote row through the candidate');
  reset role;
  raise notice 'PASS: reads';

  -- ── Dismissing the marker: the MD only, with a reason ────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_suggestion(%L, %L, %L)', v_deal, v_assess, 'Not mine to dismiss'), '42501', 'a member who is not the MD cannot dismiss');
  perform pg_temp.act_as(v_dana);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_suggestion(%L, %L, %L)', v_deal, v_assess, 'Not seated'), '42501', 'an unseated user cannot dismiss');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_suggestion(%L, %L, %L)', v_deal, v_assess, '  '), '22023', 'a dismissal needs a reason');
  perform pg_temp.expect_attempt(format('select discovery_dismiss_suggestion(%L, %L, %L)', v_deal, gen_random_uuid(), 'Unknown'), 'P0002', 'an unknown assessment is not found');
  perform pg_temp.expect_attempt(format('select discovery_dismiss_suggestion(%L, %L, %L)', v_deal, v_osp_assess, 'Another deal''s'), 'P0002', 'an assessment of another candidate is not found');
  v_corr := discovery_dismiss_suggestion(v_deal, v_assess, '  Signing slipped to November  ');
  reset role;
  set local role anon;
  perform pg_temp.expect_attempt(format('select discovery_dismiss_suggestion(%L, %L, %L)', v_deal, v_assess, 'Anon'), '42501', 'anon cannot dismiss');
  reset role;
  perform pg_temp.expect_text((select reason from corrections where id = v_corr), 'Signing slipped to November', 'the reason is trimmed and stored');
  perform pg_temp.expect_text((select after->>'assessmentId' from corrections where id = v_corr), v_assess::text, 'the log names the assessment');
  perform pg_temp.expect_text((select before->>'stepId' from corrections where id = v_corr), 'p5-s51', 'the log keeps the suggested step');
  perform pg_temp.expect((select count(*) from corrections where id = v_corr and deal_id = v_deal and actor_id = v_alice and action = 'dismiss_suggestion'), 1, 'the row carries the deal and the actor');
  perform pg_temp.expect(
    (select count(*) from audit_log where deal_id = v_deal and action = 'discovery.correction' and actor_id = v_alice
        and detail->>'action' = 'dismiss_suggestion' and detail->>'correctionId' = v_corr::text), 1, 'the dismissal is audited once with ids');
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from corrections where deal_id = v_deal and action = 'dismiss_suggestion'), 1, 'Bob sees that the suggestion was dismissed');
  perform pg_temp.act_as(v_dana);
  perform pg_temp.expect((select count(*) from corrections where deal_id = v_deal and action = 'dismiss_suggestion'), 0, 'an unseated director does not');
  reset role;
  raise notice 'PASS: dismiss';

  -- ── A closed assessment opens a closed deal; a phase 1 entry is intake ───
  set local role service_role;
  perform pg_temp.act_as_service();
  v_res := discovery_promote_candidate(v_alice, v_tenant, v_bank, v_osp, 'Project Osprey', 'Synthetic Target', 57, 5, 'active',
    '[]'::jsonb, '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  v_osp_deal := (v_res->'deal'->>'id')::uuid;
  v_res := discovery_promote_candidate(v_alice, v_tenant, v_bank, v_spa, 'Project Sparrow', 'Synthetic Target', 5, 1, 'intake',
    '[]'::jsonb, '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  v_spa_deal := (v_res->'deal'->>'id')::uuid;
  reset role;
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_osp_deal), 'closed', 'a closed assessment opens a closed lifecycle');
  perform pg_temp.expect_text((select status from deals where id = v_osp_deal), 'closed', 'and a closed status');
  perform pg_temp.expect((select count(*) from deal_steps where deal_id = v_osp_deal and seq = 57 and status = 'current'), 1, 'Osprey is at seq 57');
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_spa_deal), 'live', 'no assessment opens a live deal');
  perform pg_temp.expect_text((select status from deals where id = v_spa_deal), 'intake', 'a phase 1 entry opens an intake deal');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.candidate_promoted'), 3, 'three promotions, three audit rows');
  raise notice 'PASS: lifecycle and status';

  v_got := 'ok';
end
$$;

-- ── A team inbox (#581, phase 11): a member promotes what it found, and the deal gains the inbox's later mail ──
--
--   FAdmin  the firm admin who connects deals@ and adds people (holds no candidate list)
--   Storm   a non-admin director, the member: sees the inbox's candidate, promotes it, is the deal's MD
--   Dana    a director who is no member: cannot see the team-only candidate, so cannot promote it
--   Bob     seated on the promoted deal, but no reader of the inbox: sees the deal and nothing of its team mail
--
-- 20261019170000_team_mailbox_attach.sql restates discovery_item_owner_seated (Q21: a promoted deal gains only items
-- whose owner is seated on it) with a team disjunct: some reader of the item's inbox holds a seat on the deal. The
-- upsert asks it for every new link of a promoted candidate, so it decides what "attach" means for a team item.
do $$
declare
  v_tenant   uuid := gen_random_uuid();
  v_bank     uuid := gen_random_uuid();
  v_fadmin   uuid := gen_random_uuid();
  v_storm    uuid := gen_random_uuid();
  v_dana     uuid := gen_random_uuid();
  v_bob      uuid := gen_random_uuid();
  v_run      uuid := gen_random_uuid();
  v_out      jsonb;
  v_res      jsonb;
  v_tm       uuid;
  v_src_tm   uuid;
  v_t1       uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_t5 uuid;
  v_cand     uuid;
  v_deal     uuid;
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_fadmin, 'tp-fadmin@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_storm,  'tp-storm@example.test',  jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_dana,   'tp-dana@example.test',   jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_bob,    'tp-bob@example.test',    jsonb_build_object('tenant_id', v_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id = v_tenant;
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'TP Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id in (v_storm, v_dana);
  update users set company_id = v_bank, company_role = 'member' where id in (v_fadmin, v_bob);
  update users set firm_role = 'admin' where id = v_fadmin;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_tenant, 'tp.example', 'dwd-reader@proj-14.iam.gserviceaccount.com', '523456789012345679',
     'dir-reader@proj-14.iam.gserviceaccount.com', 'conductia-ingest@tp.example', v_bank, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into feature_flags (key, description, enabled) values ('company_access_management', 'probe', true)
    on conflict (key) do update set enabled = true;

  -- The admin connects deals@, the worker confirms it, the admin adds Storm.
  set local role authenticated;
  perform pg_temp.act_as(v_fadmin);
  v_out := discovery_connect_team_mailbox('deals@tp.example', 1);
  reset role;
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_tm := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  if v_tm is null or v_src_tm is null then
    raise exception 'FAIL: the team inbox was not connected';
  end if;
  perform pg_temp.act_as_service();
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-tp');
  set local role authenticated;
  perform pg_temp.act_as(v_fadmin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  reset role;

  -- Five team messages; the first two evidence the candidate.
  v_t1 := pg_temp.mk_item(v_tenant, v_src_tm, 'tp-t1');
  v_t2 := pg_temp.mk_item(v_tenant, v_src_tm, 'tp-t2');
  v_t3 := pg_temp.mk_item(v_tenant, v_src_tm, 'tp-t3');
  v_t4 := pg_temp.mk_item(v_tenant, v_src_tm, 'tp-t4');
  v_t5 := pg_temp.mk_item(v_tenant, v_src_tm, 'tp-t5');
  perform pg_temp.act_as_service();
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:heron', 'Project Heron', array[v_t1, v_t2]));
  v_cand := pg_temp.cand(v_tenant, 'k:heron');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand), 2, 'team fixture: Heron has two links');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id = v_storm), 1,
    'team fixture: the member holds a visibility row');
  raise notice 'PASS: team fixture';

  -- ── Who may promote: the member, and not a director who is no member ─────
  set local role service_role;
  perform pg_temp.act_as_service();
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_dana, v_tenant, v_bank, v_cand, 'Project Heron', 48, 'active'), 'P0002',
    'a director who is no member cannot see the team-only candidate, so cannot promote it');
  perform pg_temp.expect_attempt(pg_temp.promote_sql(v_fadmin, v_tenant, v_bank, v_cand, 'Project Heron', 48, 'active'), 'P0002',
    'nor can the firm admin');
  reset role;
  perform pg_temp.expect(pg_temp.promoted_deals(v_tenant), 0, 'the refusals created no deal');

  -- ── The member promotes it with a phase ──────────────────────────────────
  set local role service_role;
  perform pg_temp.act_as_service();
  v_res := discovery_promote_candidate(v_storm, v_tenant, v_bank, v_cand, 'Project Heron', 'Synthetic Target', 48, 4, 'active',
    jsonb_build_array(jsonb_build_object('userId', v_bob, 'dealRole', 'deal_team')),
    '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  reset role;
  v_deal := (v_res->'deal'->>'id')::uuid;
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand and promoted_deal_id = v_deal and discovery_state = 'confirmed'), 1,
    'the member promoted the team-evidenced candidate');
  perform pg_temp.expect((select count(*) from deal_steps where deal_id = v_deal and seq = 48 and status = 'current'), 1, 'at the phase the member chose');
  perform pg_temp.expect((select count(*) from deal_memberships where deal_id = v_deal and user_id = v_storm and deal_role = 'md'), 1, 'the member is the MD');
  perform pg_temp.expect((select count(*) from deal_memberships where deal_id = v_deal and user_id = v_bob), 1, 'Bob, no reader, is seated on it');
  raise notice 'PASS: a member promotes a team-evidenced candidate';

  -- ── The predicate: a reader on the deal carries the inbox's items; nobody else does ──
  perform pg_temp.act_as_service();
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t3, v_deal)::text, 'true', 'a reader of the inbox is seated on the deal: its item may attach');
  perform pg_temp.expect_text(discovery_item_owner_seated(gen_random_uuid(), v_deal)::text, 'false', 'an item of no source never attaches');
  -- (A deal Storm is not on.)
  perform pg_temp.on_deal(v_bob);
  perform pg_temp.expect_text(
    discovery_item_owner_seated(v_t3, (select id from deals where code = 'dd-' || v_tenant::text))::text, 'false',
    'a deal only a non-reader is on does not take the inbox''s items');

  -- ── Attach: a later team message joins the promoted candidate ────────────
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:heron', 'Project Heron', array[v_t1, v_t2, v_t3]));
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand), 3, 'a later team message attaches to the promoted candidate');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand and source_item_id = v_t3), 1, 'it is the new one');

  -- ── Invite only (owner decision 2026-10-19): a seat on the deal shows a non-reader nothing of the inbox ──
  -- Attaching decides which items the deal's candidate holds; who reads them is still the item rule
  -- (app_can_see_candidate, app_can_see_item, app_owns_item), and no branch of it consults a deal seat.
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from deals where id = v_deal), 1, 'Bob, no reader, is seated on the promoted deal and sees it');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand), 0, 'Bob does not see the promoted team candidate');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand), 0, 'nor any of its links, the one attached after promotion included');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand), 0, 'nor a visibility row');
  perform pg_temp.expect((select count(*) from source_items where id in (v_t1, v_t2, v_t3)), 0, 'nor the team items');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id in (v_t1, v_t2, v_t3)), 0, 'nor their text');
  perform pg_temp.expect((select count(*) from discovery_item_metadata(array[v_t1, v_t2, v_t3])), 0,
    'nor their date, subject or sender through the deal email''s metadata read');
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand), 1, 'Storm, a reader seated on the deal, sees the candidate');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand), 3, 'and its three links');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id in (v_t1, v_t2, v_t3)), 3, 'and reads the three messages');
  perform pg_temp.expect((select count(*) from discovery_item_metadata(array[v_t1, v_t2, v_t3]) m where m.own and m.subject is not null), 3,
    'with their subjects, as his own');
  reset role;
  perform pg_temp.act_as_service();

  -- ── A removed member no longer carries the inbox onto the deal ───────────
  set local role authenticated;
  perform pg_temp.act_as(v_fadmin);
  perform discovery_remove_team_mailbox_member(v_tm, v_storm);
  reset role;
  perform pg_temp.act_as_service();
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t4, v_deal)::text, 'false', 'removed: Storm no longer carries the inbox, though still on the deal');
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:heron', 'Project Heron', array[v_t1, v_t2, v_t3, v_t4]));
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand), 3, 'removed: a later team message does not attach');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand and source_item_id = v_t4), 0, 'the new one is not a link');

  -- Added again, the same message attaches on the next pass.
  set local role authenticated;
  perform pg_temp.act_as(v_fadmin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  reset role;
  perform pg_temp.act_as_service();
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t4, v_deal)::text, 'true', 'added again: Storm carries the inbox again');
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:heron', 'Project Heron', array[v_t1, v_t2, v_t3, v_t4]));
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand and source_item_id = v_t4), 1, 'added again: it attaches');

  -- ── The reader test is the view's, not just the row's ───────────────────
  reset role;
  update users set firm_role = 'admin' where id = v_storm;
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'false', 'promoted to firm admin: no longer a reader, so no longer carries the inbox');
  update users set firm_role = null where id = v_storm;
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'true', 'demoted: the open membership carries it again');
  update users set status = 'suspended' where id = v_storm;
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'false', 'a seat lost: the membership is closed');
  update users set status = 'active' where id = v_storm;
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'false', 're-seated: the closed membership is not revived');

  -- ── The allowlist decides too: an inbox the Directory refuses carries nothing, until it is confirmed again ──
  set local role authenticated;
  perform pg_temp.act_as(v_fadmin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  reset role;
  perform pg_temp.act_as_service();
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'true', 'a new membership: it carries again');
  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'group', null);
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'false', 'a refused inbox carries nothing');
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-tp');
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'true', 'confirmed again: it carries again');
  -- How old the check is changes nothing: the predicate has no clock (review round 2, M-A).
  update team_mailboxes set verified_at = now() - interval '66 minutes' where id = v_tm;
  perform pg_temp.expect_text(discovery_item_owner_seated(v_t5, v_deal)::text, 'true', 'a 66 minute old check: a pause or an outage does not unseat the deal''s mail');
  raise notice 'PASS: a promoted deal gains the inbox''s mail only through a reader who is on it';
end
$$;

-- ── Shared-only writes (#173 G-07 slice 1b, 20261023130200_discovery_scoped_writes.sql) ──
-- Every write that people outside a team inbox's audience can read is built from the shared assessment
-- (team_mailbox_id null): the deal's lifecycle and status, the promotion audit, set station's
-- before.suggestedStepId and the dismissal. A deal opens closed only when the shared row says closed and cites
-- a model closed event. A scoped row cannot be dismissed until G-07 slice 4 opens it to its audience. Scoped
-- rows are written directly as the table owner, since no code writes one yet.
--
--   Admin  the firm admin who connects deals@: oversees every promoted deal and reads its audit
--   Storm  a director and a member of deals@: sees the candidates, sets a station, promotes, is the MD
--   Bob    a member, no reader of deals@, with personal copies of the mixed messages: sees the candidates
--          through his own mail and is seated on Finch (the seated non-reader)
--
--   Finch  f-shared (deals@ and Bob: kickoff_held) and f-team (deals@ only: closed). Its shared row says live at
--          p2-s28; a newer scoped row for deals@ says closed at p5-s57, the team-derived step.
--   Wren   w-shared (deals@ and Bob: signed, and a closed event the row does not cite). Its shared row says
--          closed but cites only the signed event: the shape of a close followed by a regression the engine
--          leads with (audit S3), which opens live by design (R5).
--   Lark   l-shared (deals@ and Bob: closed). Its shared row says closed and cites the model closed event.
do $$
declare
  v_tenant        uuid := gen_random_uuid();
  v_bank          uuid := gen_random_uuid();
  v_admin         uuid := gen_random_uuid();
  v_storm         uuid := gen_random_uuid();
  v_bob           uuid := gen_random_uuid();
  v_inv_bob       uuid := gen_random_uuid();
  v_run           uuid := gen_random_uuid();
  v_out           jsonb;
  v_res           jsonb;
  v_tm            uuid;
  v_src_tm        uuid;
  v_src_bob       uuid;
  v_f_shared      uuid; v_f_team uuid; v_w_shared uuid; v_l_shared uuid; v_r_shared uuid;
  v_finch         uuid; v_wren uuid; v_lark uuid; v_robin uuid;
  v_r_det         uuid; v_ev_r_closed uuid; v_robin_deal uuid;
  v_ev_f_shared   uuid; v_ev_f_team uuid; v_ev_w_signed uuid; v_ev_w_closed uuid; v_ev_l_closed uuid;
  v_shared_assess uuid;
  v_scoped_assess uuid;
  v_corr          uuid;
  v_deal          uuid;
  v_wren_deal     uuid;
  v_lark_deal     uuid;
  v_corr_n        bigint;
  v_audit_n       bigint;
begin
  -- ── Fixture, as the table owner (the team block above, plus Bob's personal mailbox) ──
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'sw-admin@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_storm, 'sw-storm@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_bob,   'sw-bob@example.test',   jsonb_build_object('tenant_id', v_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id = v_tenant;
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'SW Bank', 'bank');
  -- The director first: company_has_director refuses a bank of members only.
  update users set company_id = v_bank, company_role = 'director' where id = v_storm;
  update users set company_id = v_bank, company_role = 'member' where id in (v_admin, v_bob);
  update users set firm_role = 'admin' where id = v_admin;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_tenant, 'sw.example', 'dwd-reader@proj-19.iam.gserviceaccount.com', '923456789012345670',
     'dir-reader@proj-19.iam.gserviceaccount.com', 'conductia-ingest@sw.example', v_bank, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into feature_flags (key, description, enabled) values ('company_access_management', 'probe', true)
    on conflict (key) do update set enabled = true;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_inv_bob, v_tenant, 'bob@sw.example', v_admin, v_bank, 'member', 'accepted', 'sent', now(), v_bob);
  perform pg_temp.on_deal(v_bob);

  -- Bob opts in; the admin connects deals@, the worker confirms it, the admin adds Storm.
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('deals@sw.example', 1);
  reset role;
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_tm := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  select id into v_src_bob from content_sources where tenant_id = v_tenant and owner_user_id = v_bob;
  if v_tm is null or v_src_tm is null or v_src_bob is null then
    raise exception 'FAIL: shared-only: the team inbox or Bob''s mailbox source was not created';
  end if;
  perform pg_temp.act_as_service();
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-sw');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  reset role;

  -- Three mixed messages (deals@ and Bob) and one team-only message.
  v_f_shared := pg_temp.mk_item(v_tenant, v_src_tm, 'sw-f-shared');
  v_f_team   := pg_temp.mk_item(v_tenant, v_src_tm, 'sw-f-team');
  v_w_shared := pg_temp.mk_item(v_tenant, v_src_tm, 'sw-w-shared');
  v_l_shared := pg_temp.mk_item(v_tenant, v_src_tm, 'sw-l-shared');
  v_r_shared := pg_temp.mk_item(v_tenant, v_src_tm, 'sw-r-shared');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_f_shared, v_src_bob, 'b-f-shared'), (v_w_shared, v_src_bob, 'b-w-shared'), (v_l_shared, v_src_bob, 'b-l-shared'),
    (v_r_shared, v_src_bob, 'b-r-shared');
  perform pg_temp.act_as_service();
  perform discovery_upsert_candidates(v_tenant, v_run,
    pg_temp.grp('k:finch', 'Project Finch', array[v_f_shared, v_f_team])
    || pg_temp.grp('k:wren', 'Project Wren', array[v_w_shared])
    || pg_temp.grp('k:lark', 'Project Lark', array[v_l_shared])
    || pg_temp.grp('k:robin', 'Project Robin', array[v_r_shared]));
  v_finch := pg_temp.cand(v_tenant, 'k:finch'); v_wren := pg_temp.cand(v_tenant, 'k:wren'); v_lark := pg_temp.cand(v_tenant, 'k:lark');
  v_robin := pg_temp.cand(v_tenant, 'k:robin');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_finch and person_id in (v_storm, v_bob)), 2,
    'shared-only fixture: Storm (through deals@) and Bob (through his own copy) both see Finch');

  -- Model events (model_call_id set), written directly as discovery_rls.sql does.
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, model_call_id)
    values (v_tenant, v_f_shared, 'kickoff_held', '2026-03-01', 0, 5, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_f_shared;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, model_call_id)
    values (v_tenant, v_f_team, 'closed', '2026-03-01', 0, 5, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_f_team;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, model_call_id)
    values (v_tenant, v_w_shared, 'signed', '2026-03-01', 0, 5, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_w_signed;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, model_call_id)
    values (v_tenant, v_w_shared, 'closed', '2026-03-01', 6, 9, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_w_closed;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, model_call_id)
    values (v_tenant, v_l_shared, 'closed', '2026-03-01', 0, 5, 0.9, 'v1:m', gen_random_uuid()) returning id into v_ev_l_closed;
  -- Robin: a rule-basis closed event (#173 G-07 slice 3b), under its detection rather than a model call.
  insert into milestone_detections (tenant_id, source_item_id, content_hash, rules_version, events, parsed)
    select v_tenant, v_r_shared, si.content_hash, 'rules/v1', 1, jsonb_build_array(jsonb_build_object('type', 'closed', 'span_start', 0))
    from source_items si where si.id = v_r_shared
    returning id into v_r_det;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence, extractor_version, detection_id)
    values (v_tenant, v_r_shared, 'closed', '2026-03-01', 0, 5, 0.5, 'rules/v1', v_r_det) returning id into v_ev_r_closed;

  -- Finch: the shared row through the writer, then a newer scoped row as the table owner.
  perform discovery_record_assessment(v_tenant, v_finch, jsonb_build_object(
    'stepId', 'p2-s28', 'station', 25, 'lifecycle', 'live', 'reason', 'Kickoff because kickoff held on 1 Mar 2026 (1 email)',
    'evidenceEventIds', jsonb_build_array(v_ev_f_shared), 'confidence', 0.9, 'flags', '[]'::jsonb,
    'engineVersion', 'stage-engine/v1', 'basis', 'model'), 'extraction');
  select id into v_shared_assess from stage_assessments where candidate_id = v_finch and team_mailbox_id is null;
  insert into stage_assessments (tenant_id, candidate_id, step_id, station, lifecycle_suggestion, reason_text,
                                 evidence_event_ids, confidence, engine_version, trigger, team_mailbox_id)
  values (v_tenant, v_finch, 'p5-s57', 53, 'closed', 'Closing Checklist because closing on 1 Mar 2026 (1 email)',
          array[v_ev_f_team], 0.9, 'stage-engine/v1', 'extraction', v_tm)
  returning id into v_scoped_assess;
  perform pg_temp.expect((select count(*) from stage_assessments s where s.id = v_scoped_assess
      and s.as_of > (select as_of from stage_assessments where id = v_shared_assess)), 1,
    'shared-only fixture: the scoped row is newer than the shared row');
  -- Wren: closed, citing only a signed event. Lark: closed, citing a model closed event. Robin: closed, citing a
  -- rule closed event.
  perform discovery_record_assessment(v_tenant, v_robin, jsonb_build_object(
    'stepId', 'p5-s57', 'station', 53, 'lifecycle', 'closed', 'reason', 'Closing Checklist because closing on 1 Mar 2026 (1 email)',
    'evidenceEventIds', jsonb_build_array(v_ev_r_closed), 'confidence', 0.5, 'flags', '[]'::jsonb,
    'engineVersion', 'stage-engine/v2', 'basis', 'rules'), 'extraction');
  perform discovery_record_assessment(v_tenant, v_wren, jsonb_build_object(
    'stepId', 'p5-s57', 'station', 53, 'lifecycle', 'closed', 'reason', 'Closing Checklist because signing on 1 Mar 2026 (1 email)',
    'evidenceEventIds', jsonb_build_array(v_ev_w_signed), 'confidence', 0.9, 'flags', '[]'::jsonb,
    'engineVersion', 'stage-engine/v1', 'basis', 'model'), 'extraction');
  perform discovery_record_assessment(v_tenant, v_lark, jsonb_build_object(
    'stepId', 'p5-s57', 'station', 53, 'lifecycle', 'closed', 'reason', 'Closing Checklist because closing on 1 Mar 2026 (1 email)',
    'evidenceEventIds', jsonb_build_array(v_ev_l_closed), 'confidence', 0.9, 'flags', '[]'::jsonb,
    'engineVersion', 'stage-engine/v1', 'basis', 'model'), 'extraction');
  raise notice 'PASS: shared-only fixture';

  -- ── Set station records the shared suggestion, not the newer scoped one ──
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  v_corr := discovery_set_station(v_finch, 'p4-s49', 'Disclosure schedules are out');
  reset role;
  perform pg_temp.expect_text((select before->>'suggestedStepId' from corrections where id = v_corr), 'p2-s28',
    'shared-only: set station''s before.suggestedStepId is the shared step');
  perform pg_temp.expect((select count(*) from corrections where id = v_corr and team_mailbox_id is null), 1,
    'shared-only: the set station correction is a shared row');
  raise notice 'PASS: shared-only: set station';

  -- ── Promotion: deal state and audit from the shared row; closed only on a cited model closed event ──
  set local role service_role;
  perform pg_temp.act_as_service();
  v_res := discovery_promote_candidate(v_storm, v_tenant, v_bank, v_finch, 'Project Finch', 'Synthetic Target', 48, 4, 'active',
    jsonb_build_array(jsonb_build_object('userId', v_bob, 'dealRole', 'deal_team')),
    '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  v_deal := (v_res->'deal'->>'id')::uuid;
  v_res := discovery_promote_candidate(v_storm, v_tenant, v_bank, v_wren, 'Project Wren', 'Synthetic Target', 57, 5, 'active',
    '[]'::jsonb, '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  v_wren_deal := (v_res->'deal'->>'id')::uuid;
  v_res := discovery_promote_candidate(v_storm, v_tenant, v_bank, v_lark, 'Project Lark', 'Synthetic Target', 57, 5, 'active',
    '[]'::jsonb, '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  v_lark_deal := (v_res->'deal'->>'id')::uuid;
  v_res := discovery_promote_candidate(v_storm, v_tenant, v_bank, v_robin, 'Project Robin', 'Synthetic Target', 57, 5, 'active',
    '[]'::jsonb, '{"verdict":"compliant","reasons":[]}', pg_temp.steps(), 'test-1x61',
    '{"approvedBy":"Avery Lindqvist","approvedOn":"2026-09-01"}');
  v_robin_deal := (v_res->'deal'->>'id')::uuid;
  reset role;

  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_deal), 'live',
    'shared-only: a newer scoped closed row leaves the deal live (the shared row says live)');
  perform pg_temp.expect_text((select status from deals where id = v_deal), 'active', 'shared-only: and active');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.candidate_promoted' and deal_id = v_deal
        and detail->>'suggestedStepId' = 'p2-s28' and detail->>'lifecycleCategory' = 'live'), 1,
    'shared-only: the promotion audit names the shared step and the shared lifecycle');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_finch and deal_id is distinct from v_deal), 0,
    'shared-only: every Finch row, the scoped one included, carries the deal');
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_wren_deal), 'live',
    'shared-only: a shared closed row that cites no closed event opens a live deal');
  perform pg_temp.expect_text((select status from deals where id = v_wren_deal), 'active', 'shared-only: and an active one');
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_lark_deal), 'closed',
    'shared-only: a shared closed row that cites a model closed event opens a closed deal');
  perform pg_temp.expect_text((select status from deals where id = v_lark_deal), 'closed', 'shared-only: and a closed status');
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_robin_deal), 'live',
    'shared-only: a shared closed row that cites a rule closed event opens a live deal (#173 G-07 slice 3b)');
  raise notice 'PASS: shared-only: promotion';

  -- ── Dismissal: an MD outside the inbox's audience is refused and nothing is written; a reader dismisses it ──
  -- (#173 G-07 slice 4, 20261023130700.) Storm leaves deals@ for the refusal and rejoins for the dismissal.
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_remove_team_mailbox_member(v_tm, v_storm);
  reset role;
  select count(*) into v_corr_n from corrections where tenant_id = v_tenant;
  select count(*) into v_audit_n from audit_log where tenant_id = v_tenant;
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_suggestion(%L, %L, %L)', v_deal, v_scoped_assess, 'Not the shared suggestion'),
    '42501', 'shared-only: an MD who does not read the inbox cannot dismiss its scoped assessment');
  reset role;
  perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), v_corr_n, 'shared-only: the refusal wrote no correction');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant), v_audit_n, 'shared-only: and no audit row');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  perform pg_temp.act_as(v_storm);
  v_corr := discovery_dismiss_suggestion(v_deal, v_scoped_assess, 'The inbox suggestion is stale');
  perform pg_temp.expect((select count(*) from corrections where id = v_corr and team_mailbox_id = v_tm
                            and after->>'assessmentId' = v_scoped_assess::text), 1,
    'shared-only: a reader of the inbox dismisses its scoped assessment, and the correction carries the inbox');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from corrections where id = v_corr), 0,
    'shared-only: a colleague outside the inbox does not read the scoped dismissal');
  reset role;
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  v_corr := discovery_dismiss_suggestion(v_deal, v_shared_assess, 'Kickoff is long past');
  reset role;
  perform pg_temp.expect(
    (select count(*) from corrections where id = v_corr and team_mailbox_id is null and before->>'stepId' = 'p2-s28'
        and after->>'assessmentId' = v_shared_assess::text), 1,
    'shared-only: the shared dismissal is a shared row naming the shared step');
  raise notice 'PASS: shared-only: dismissal';

  -- ── The seated non-reader and the firm admin read no team-derived step or id ──
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_finch), 3,
    'shared-only: Bob reads Finch''s set station, promote and dismiss rows');
  perform pg_temp.expect(
    (select count(*) from corrections where candidate_id = v_finch
        and (coalesce(before::text, '') || coalesce(after::text, '')) ~ ('p5-s57|' || v_scoped_assess::text)), 0,
    'shared-only: no correction Bob reads holds the team-derived step or the scoped row');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action like 'discovery.%'
        and (detail->>'candidateId' = v_finch::text or deal_id = v_deal)
        and detail::text ~ ('p5-s57|' || v_scoped_assess::text)), 0,
    'shared-only: no Finch audit row Bob reads holds them');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_finch and team_mailbox_id is not null), 0,
    'shared-only: Bob reads no scoped row');
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_deal), 'live', 'shared-only: Bob reads a live deal');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_finch), 2,
    'shared-only: the admin reads Finch''s promote and dismiss rows through the deal');
  perform pg_temp.expect(
    (select count(*) from corrections where candidate_id = v_finch
        and (coalesce(before::text, '') || coalesce(after::text, '')) ~ ('p5-s57|' || v_scoped_assess::text)), 0,
    'shared-only: no correction the admin reads holds the team-derived step or the scoped row');
  perform pg_temp.expect(
    (select count(*) from audit_log where deal_id = v_deal and action = 'discovery.candidate_promoted'
        and detail->>'suggestedStepId' = 'p2-s28'), 1,
    'shared-only: the admin reads Finch''s promotion audit, with the shared step');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action like 'discovery.%'
        and (detail->>'candidateId' = v_finch::text or deal_id = v_deal)
        and detail::text ~ ('p5-s57|' || v_scoped_assess::text)), 0,
    'shared-only: no Finch audit row the admin reads holds them');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_finch and team_mailbox_id is not null), 0,
    'shared-only: the admin reads no scoped row');
  perform pg_temp.expect_text((select lifecycle_category from deals where id = v_deal), 'live', 'shared-only: the admin reads a live deal');
  reset role;
  raise notice 'PASS: shared-only writes: deal state, the promotion audit and corrections come from the shared assessment';
end
$$;

rollback;
