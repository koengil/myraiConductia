-- Deal discovery corrections (20261002210000_discovery_corrections.sql): the
-- append-only log, the four correction RPCs, the authority read, and every
-- branch of the upsert that learned pinned, merged, confirmed, promoted and
-- rejected candidates. Read and written as each user under the authenticated
-- role, with company_access_management on so deal-create authority is real.
--
--   Alice      a director of the bank: holds every company permission
--   Colleague  a member: sees a shared candidate but may not act on it
--   Bob        a member whose mailbox holds no deal mail
--   CCO        the control room of the tenant (firm_role passes the authority check)
--   Admin      a firm admin (sees no candidate)
--   Outsider   the control room of another tenant
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_corrections.sql
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

-- One classification group, with a firm link per item.
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

create function pg_temp.links(p_candidate uuid)
returns bigint language sql as $$
  select count(*) from evidence_links where candidate_id = p_candidate;
$$;

-- Seats a user on a deal of their tenant as deal team (#262: the one-click opt-in needs MD or deal team on a
-- deal of the tenant). One helper deal per tenant, created on first use; it is never promoted. Run as the table owner.
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

grant execute on all functions in schema pg_temp to authenticated, anon;

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
  v_run        uuid := gen_random_uuid();
  v_bank       uuid := gen_random_uuid();
  v_inv_alice  uuid := gen_random_uuid();
  v_inv_coll   uuid := gen_random_uuid();
  v_inv_bob    uuid := gen_random_uuid();
  v_deal       uuid := gen_random_uuid();
  v_kes_a      uuid; v_kes_shared uuid; v_kes_new uuid;
  v_har_a      uuid; v_har2_a uuid;
  v_har3_a     uuid; v_har3_c uuid;
  v_ren_shared uuid; v_ren_new uuid;
  v_rej_a      uuid; v_rej_new uuid;
  v_sta_a      uuid;
  v_con_a      uuid; v_con_new uuid;
  v_pro_a      uuid; v_pro_seated uuid; v_pro_unseated uuid;
  v_unp_a      uuid; v_unp_new uuid;
  v_fresh_a    uuid; v_orphan_new uuid;
  v_kes uuid; v_har uuid; v_har2 uuid; v_har3 uuid; v_ren uuid; v_rej uuid; v_sta uuid;
  v_con uuid; v_pro uuid; v_unp uuid;
  v_corr       uuid;
  v_count      bigint;
  v_spl_1 uuid; v_spl_2 uuid; v_spl_3 uuid; v_spl_c uuid;
  v_rsrc_a uuid; v_rsrc_b uuid; v_rsrc_u uuid; v_rdst_a uuid;
  v_spl uuid; v_spl_new uuid; v_rsrc uuid; v_rdst uuid;
  v_link uuid; v_before bigint;
  v_vis_a uuid; v_vis_w uuid; v_vis_s uuid; v_vis uuid;
begin
  -- ── Fixture, as the table owner (the seating of discovery_rls.sql) ───────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alice,     'cr-alice@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_colleague, 'cr-colleague@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_bob,       'cr-bob@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_cco,       'cr-cco@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance')),
    (v_admin,     'cr-admin@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_outsider,  'cr-outsider@example.test',  jsonb_build_object('tenant_id', v_other, 'department', 'compliance'));
  update users set status = 'active', is_external = false
    where id in (v_alice, v_colleague, v_bob, v_cco, v_admin, v_outsider);
  update users set firm_role = 'cco' where id in (v_cco, v_outsider);
  update users set firm_role = 'admin' where id = v_admin;

  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values
    (v_tenant, 'fixture', 'fixture', 'active'),
    (v_other, 'fixture', 'fixture', 'active');

  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'CR Bank', 'bank');
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

  -- Deal-create authority is real from here on: Alice (a director) holds it,
  -- the colleague and Bob (members) do not, the CCO does through firm_role.
  insert into feature_flags (key, description, enabled)
    values ('company_access_management', 'probe', true)
    on conflict (key) do update set enabled = true;

  -- ── Items and candidates ────────────────────────────────────────────────
  v_kes_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'kes-a');
  v_kes_shared := pg_temp.mk_item(v_tenant, v_src_alice, 'kes-shared');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_kes_shared, v_src_coll, 'c-kes-shared');
  v_kes_new    := pg_temp.mk_item(v_tenant, v_src_alice, 'kes-new');
  v_har_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'har-a');
  v_har2_a     := pg_temp.mk_item(v_tenant, v_src_alice, 'har2-a');
  v_har3_a     := pg_temp.mk_item(v_tenant, v_src_alice, 'har3-a');
  v_har3_c     := pg_temp.mk_item(v_tenant, v_src_coll, 'har3-c');
  v_ren_shared := pg_temp.mk_item(v_tenant, v_src_alice, 'ren-shared');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_ren_shared, v_src_coll, 'c-ren-shared');
  v_ren_new    := pg_temp.mk_item(v_tenant, v_src_alice, 'ren-new');
  v_rej_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'rej-a');
  v_rej_new    := pg_temp.mk_item(v_tenant, v_src_alice, 'rej-new');
  v_sta_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'sta-a');
  v_con_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'con-a');
  v_con_new    := pg_temp.mk_item(v_tenant, v_src_alice, 'con-new');
  v_pro_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'pro-a');
  v_pro_seated := pg_temp.mk_item(v_tenant, v_src_alice, 'pro-seated');
  v_pro_unseated := pg_temp.mk_item(v_tenant, v_src_coll, 'pro-unseated');
  v_unp_a      := pg_temp.mk_item(v_tenant, v_src_alice, 'unp-a');
  v_unp_new    := pg_temp.mk_item(v_tenant, v_src_alice, 'unp-new');
  v_fresh_a    := pg_temp.mk_item(v_tenant, v_src_alice, 'fresh-a');
  v_orphan_new := pg_temp.mk_item(v_tenant, v_src_alice, 'orphan-new');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run,
    pg_temp.grp('k:kes',  'Project Kestrel', array[v_kes_a, v_kes_shared])
    || pg_temp.grp('k:har',  'Project Harbor',  array[v_har_a])
    || pg_temp.grp('k:har2', 'Project Harbor Two', array[v_har2_a])
    || pg_temp.grp('k:har3', 'Project Harbor Three', array[v_har3_a, v_har3_c])
    || pg_temp.grp('k:ren',  'Project Renamable', array[v_ren_shared])
    || pg_temp.grp('k:rej',  'Project Rejectable', array[v_rej_a])
    || pg_temp.grp('k:sta',  'Project Stationary', array[v_sta_a])
    || pg_temp.grp('k:con',  'Project Confirmed', array[v_con_a])
    || pg_temp.grp('k:pro',  'Project Promoted', array[v_pro_a])
    || pg_temp.grp('k:unp',  'Project Unpinned', array[v_unp_a]));
  v_kes := pg_temp.cand(v_tenant, 'k:kes');   v_har := pg_temp.cand(v_tenant, 'k:har');
  v_har2 := pg_temp.cand(v_tenant, 'k:har2'); v_har3 := pg_temp.cand(v_tenant, 'k:har3');
  v_ren := pg_temp.cand(v_tenant, 'k:ren');   v_rej := pg_temp.cand(v_tenant, 'k:rej');
  v_sta := pg_temp.cand(v_tenant, 'k:sta');   v_con := pg_temp.cand(v_tenant, 'k:con');
  v_pro := pg_temp.cand(v_tenant, 'k:pro');   v_unp := pg_temp.cand(v_tenant, 'k:unp');

  -- A confirmed candidate, and a confirmed one promoted to a deal Alice is seated on.
  update deal_candidates set discovery_state = 'confirmed' where id = v_con;
  insert into deals (id, tenant_id, code, codename, bank_id) values (v_deal, v_tenant, 'CR-TEST-1', 'Promoted', v_bank);
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
    values (v_deal, v_alice, (select id from roles where slug = 'md'), 'md');
  update deal_candidates set discovery_state = 'confirmed', promoted_deal_id = v_deal where id = v_pro;

  perform pg_temp.expect(pg_temp.links(v_kes), 2, 'fixture: Kestrel holds two links');
  raise notice 'PASS: fixture';

  -- ── The seat filter and the tenant lock are closed to signed-in roles ────
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('discovery_lock_tenant', 'discovery_item_owner_seated', 'discovery_authorize_correction')
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
    0, 'the lock, the seat filter and the prelude are service-role only');
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('discovery_rename_candidate', 'discovery_reject_candidate', 'discovery_set_station',
                         'discovery_merge_candidates', 'discovery_correction_authority')
       and has_function_privilege('anon', p.oid, 'execute')),
    0, 'anon executes none of the five');
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('discovery_rename_candidate', 'discovery_reject_candidate', 'discovery_set_station',
                         'discovery_merge_candidates', 'discovery_correction_authority')
       and has_function_privilege('authenticated', p.oid, 'execute')),
    5, 'authenticated executes the five');

  -- ── Refusals: anon, another tenant, an invisible candidate, no authority ──
  set local role anon;
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_kes, 'Nope'), '42501', 'anon cannot rename');
  perform pg_temp.expect_attempt(format('select discovery_reject_candidate(%L, %L)', v_kes, 'Nope'), '42501', 'anon cannot reject');
  perform pg_temp.expect_attempt(format('select discovery_set_station(%L, %L, %L)', v_kes, 'p4-s48', 'Nope'), '42501', 'anon cannot set a station');
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har, v_kes, 'Nope'), '42501', 'anon cannot merge');
  perform pg_temp.expect_attempt(format('select discovery_correction_authority(%L)', v_kes), '42501', 'anon cannot read authority');
  reset role;

  set local role authenticated;
  -- Another tenant's control room: the candidate does not exist for it.
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_kes, 'Nope'), 'P0002', 'another tenant cannot rename');
  perform pg_temp.expect_attempt(format('select discovery_reject_candidate(%L, %L)', v_kes, 'Nope'), 'P0002', 'another tenant cannot reject');
  perform pg_temp.expect_attempt(format('select discovery_set_station(%L, %L, %L)', v_kes, 'p4-s48', 'Nope'), 'P0002', 'another tenant cannot set a station');
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har, v_kes, 'Nope'), 'P0002', 'another tenant cannot merge');
  -- Bob holds no evidence; the firm admin sees no candidate.
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_kes, 'Nope'), 'P0002', 'Bob cannot rename what he cannot see');
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har, v_kes, 'Nope'), 'P0002', 'Bob cannot merge what he cannot see');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_kes, 'Nope'), 'P0002', 'the firm admin cannot rename');
  -- The colleague sees Kestrel through the shared item but holds no deal-create authority.
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_kes, 'Nope'), '42501', 'the colleague has no authority to rename');
  perform pg_temp.expect_attempt(format('select discovery_reject_candidate(%L, %L)', v_kes, 'Nope'), '42501', 'the colleague has no authority to reject');
  perform pg_temp.expect_attempt(format('select discovery_set_station(%L, %L, %L)', v_kes, 'p4-s48', 'Nope'), '42501', 'the colleague has no authority to set a station');
  -- The colleague cannot see Harbor, so merging it is invisible before it is unauthorized.
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har, v_kes, 'Nope'), 'P0002', 'the colleague cannot merge what he cannot see');
  -- A candidate that does not exist.
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', gen_random_uuid(), 'Nope'), 'P0002', 'an unknown candidate is not visible');
  reset role;
  perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), 0, 'refused calls wrote nothing');
  perform pg_temp.expect((select count(*) from discovery_recompute_requests where tenant_id = v_tenant), 0, 'refused calls asked for no recompute');
  raise notice 'PASS: refusals';

  -- ── discovery_correction_authority answers for each case ─────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(discovery_correction_authority(v_kes), null, 'Alice may act on Kestrel');
  perform pg_temp.expect_text(discovery_correction_authority(gen_random_uuid()), 'not_visible', 'an unknown candidate is not visible');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(discovery_correction_authority(v_kes), 'no_authority', 'the colleague sees Kestrel but may not act');
  perform pg_temp.expect_text(discovery_correction_authority(v_har), 'not_visible', 'the colleague does not see Harbor');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(discovery_correction_authority(v_kes), 'not_visible', 'Bob does not see Kestrel');
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect_text(discovery_correction_authority(v_kes), 'not_visible', 'another tenant does not see Kestrel');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(discovery_correction_authority(v_kes), null, 'the control room may act');
  -- A promoted candidate keeps the corrections its RPCs allow (rename, station, split, reassign) and loses the
  -- ones that end a proposal: promote, reject and merge answer candidate_state once promoted_deal_id is set.
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(discovery_correction_authority(v_pro), null, 'Alice may still correct a promoted candidate');
  perform pg_temp.expect_text(discovery_correction_authority(v_pro, 'rename'), null, 'a promoted candidate may be renamed');
  perform pg_temp.expect_text(discovery_correction_authority(v_pro, 'promote'), 'candidate_state', 'a promoted candidate cannot be promoted again');
  perform pg_temp.expect_text(discovery_correction_authority(v_pro, 'reject'), 'candidate_state', 'a promoted candidate cannot be rejected');
  perform pg_temp.expect_text(discovery_correction_authority(v_pro, 'merge'), 'candidate_state', 'a promoted candidate cannot be merged away');
  perform pg_temp.expect_text(discovery_correction_authority(v_kes, 'reject'), null, 'a proposed candidate may be rejected');
  perform pg_temp.expect_text(discovery_correction_authority(v_kes, 'promote'), null, 'a proposed candidate may be promoted');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(discovery_correction_authority(v_kes, 'reject'), 'no_authority', 'authority is judged before state');
  perform pg_temp.expect_attempt(format('select discovery_correction_authority(%L, %L)', v_kes, 'launch'), '22023', 'an unknown action is refused');
  reset role;

  -- ── Rename: pins, audits, asks for a recompute, and the candidate keeps gaining links ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_ren, '   '), '22023', 'a blank name is refused');
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_ren, repeat('x', 121)), '22023', 'a name over 120 characters is refused');
  v_corr := discovery_rename_candidate(v_ren, '  Project Renamed  ', 'Client prefers this name');
  reset role;
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_ren), 'Project Renamed', 'the name is trimmed and stored');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_ren and pinned), 1, 'a rename pins');
  perform pg_temp.expect_text((select before->>'name' from corrections where id = v_corr), 'Project Renamable', 'the log keeps the name before');
  perform pg_temp.expect_text((select after->>'name' from corrections where id = v_corr), 'Project Renamed', 'the log keeps the name after');
  perform pg_temp.expect_text((select reason from corrections where id = v_corr), 'Client prefers this name', 'the log keeps the reason');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.correction'
       and actor_type = 'user' and actor_id = v_alice and chain_seq is not null
       and detail->>'correctionId' = v_corr::text and detail->>'action' = 'rename'), 1, 'a rename is audited once, by the user');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.correction'
       and detail::text ~* '(renamed|renamable|kestrel)'), 0, 'the audit detail holds ids only, no name');
  perform pg_temp.expect(
    (select count(*) from discovery_recompute_requests where candidate_id = v_ren and reason = 'correction'), 1, 'a rename asks for one recompute');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:ren', 'Project Renamable', array[v_ren_shared, v_ren_new]));
  perform pg_temp.expect(pg_temp.links(v_ren), 2, 'a pinned candidate keeps gaining links');
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_ren), 'Project Renamed', 'a re-run does not rename it back');
  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_ren and person_id = v_alice), 2, 'Alice''s visibility counts the new link');
  raise notice 'PASS: rename';

  -- ── Reject: leaves the list, takes no more evidence, cannot be repeated ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_reject_candidate(%L, %L)', v_rej, ' '), '22023', 'a reject needs a reason');
  v_corr := discovery_reject_candidate(v_rej, 'Not a real mandate');
  perform pg_temp.expect((select count(*) from deal_candidates where discovery_state = 'proposed' and id = v_rej), 0, 'a rejected candidate leaves the proposed list');
  perform pg_temp.expect_attempt(format('select discovery_reject_candidate(%L, %L)', v_rej, 'Again'), '55000', 'a rejected candidate cannot be rejected again');
  perform pg_temp.expect_attempt(format('select discovery_rename_candidate(%L, %L)', v_rej, 'Late name'), '55000', 'a rejected candidate cannot be renamed');
  perform pg_temp.expect_text(discovery_correction_authority(v_rej), 'candidate_state', 'the authority read names the state');
  reset role;
  perform pg_temp.expect_text((select before->>'state' from corrections where id = v_corr), 'proposed', 'the log keeps the state before');
  perform pg_temp.expect_text((select after->>'state' from corrections where id = v_corr), 'rejected', 'the log keeps the state after');
  perform pg_temp.expect((select count(*) from discovery_recompute_requests where candidate_id = v_rej), 0, 'a rejected candidate is not recomputed');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:rej', 'Project Rejectable', array[v_rej_a, v_rej_new]));
  perform pg_temp.expect(pg_temp.links(v_rej), 1, 'a rejected candidate gains nothing');
  perform pg_temp.expect_text((select discovery_state from deal_candidates where id = v_rej), 'rejected', 'a re-run leaves it rejected');
  raise notice 'PASS: reject';

  -- ── Set station: stores the override, pins, keeps what changed ───────────
  insert into stage_assessments (tenant_id, candidate_id, step_id, station, lifecycle_suggestion, reason_text, confidence, engine_version, trigger)
    values (v_tenant, v_sta, 'p4-s47', 43, 'live', 'Bid Review because bids received on 1 Mar 2026 (1 email)', 0.9, 'stage-engine/v1', 'extraction');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_set_station(%L, %L, %L)', v_sta, 'p4-s48', ''), '22023', 'a station needs a reason');
  perform pg_temp.expect_attempt(format('select discovery_set_station(%L, %L, %L)', v_sta, 'LOI Review', 'Why'), '22023', 'a station must look like a step id');
  perform pg_temp.expect_attempt(format('select discovery_set_station(%L, %L, %L)', v_sta, 'p9-s48', 'Why'), '22023', 'a phase outside 1 to 5 is refused');
  v_corr := discovery_set_station(v_sta, 'p4-s48', 'Term sheet countersigned by phone');
  reset role;
  perform pg_temp.expect_text((select station_override_step_id from deal_candidates where id = v_sta), 'p4-s48', 'the override is stored');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_sta and station_override_correction_id = v_corr and pinned), 1, 'the override points at its correction and pins');
  perform pg_temp.expect_text((select before->>'suggestedStepId' from corrections where id = v_corr), 'p4-s47', 'the log keeps the suggestion before');
  perform pg_temp.expect_text((select after->>'stepId' from corrections where id = v_corr), 'p4-s48', 'the log keeps the step after');
  perform pg_temp.expect((select count(*) from discovery_recompute_requests where candidate_id = v_sta and reason = 'correction'), 1, 'a station asks for one recompute');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_corr := discovery_set_station(v_sta, 'p5-s51', 'Signing moved up');
  reset role;
  perform pg_temp.expect_text((select before->>'stepId' from corrections where id = v_corr), 'p4-s48', 'the second change keeps the previous override');
  perform pg_temp.expect_text((select station_override_step_id from deal_candidates where id = v_sta), 'p5-s51', 'the latest override wins');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:sta', 'Project Stationary', array[v_sta_a]));
  perform pg_temp.expect_text((select station_override_step_id from deal_candidates where id = v_sta), 'p5-s51', 'a re-run keeps the override');
  raise notice 'PASS: set station';

  -- ── Merge: copies links, keeps the originals, re-points a chain ──────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har, v_kes, ''), '22023', 'a merge needs a reason');
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har, v_har, 'Same'), '22023', 'a candidate cannot merge into itself');
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har, v_rej, 'Into a rejected one'), '55000', 'a rejected survivor is refused');
  -- Harbor Two into Harbor first, so a chain exists when Harbor merges into Kestrel.
  v_corr := discovery_merge_candidates(v_har2, v_har, 'Same client, earlier codename');
  reset role;
  perform pg_temp.expect(pg_temp.links(v_har), 2, 'Harbor gained Harbor Two''s link');
  perform pg_temp.expect(pg_temp.links(v_har2), 1, 'the merged candidate keeps its own link');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_har2, v_kes, 'Already merged'), '55000', 'a merged candidate cannot merge again');
  perform pg_temp.expect_attempt(format('select discovery_merge_candidates(%L, %L, %L)', v_kes, v_har2, 'Into a merged one'), '55000', 'a merged survivor is refused');
  v_corr := discovery_merge_candidates(v_har, v_kes, 'Harbor is the Kestrel process');
  reset role;
  perform pg_temp.expect(pg_temp.links(v_kes), 4, 'Kestrel gained Harbor''s two links');
  perform pg_temp.expect(pg_temp.links(v_har), 2, 'Harbor keeps its links after the merge');
  perform pg_temp.expect_text((select discovery_state from deal_candidates where id = v_har), 'merged_into', 'Harbor is merged');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_har and merged_into_id = v_kes), 1, 'Harbor points at Kestrel');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_har2 and merged_into_id = v_kes), 1, 'the chain follows to the survivor');
  perform pg_temp.expect_text((select after->>'survivorId' from corrections where id = v_corr), v_kes::text, 'the log names the survivor');
  perform pg_temp.expect_text((select after->>'survivorName' from corrections where id = v_corr), 'Project Kestrel', 'the log names the survivor''s name');
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_kes), 'Project Kestrel', 'Kestrel keeps its name');
  perform pg_temp.expect(
    (select count(*) from discovery_recompute_requests where candidate_id = v_kes and reason = 'correction'), 1,
    'a merge asks for a recompute of the survivor');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.correction'
       and detail->>'action' = 'merge' and detail->>'survivorId' = v_kes::text), 1, 'a merge is audited with ids');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_har and discovery_state = 'proposed'), 0, 'Harbor leaves the proposed list');
  reset role;

  -- Merging into a promoted survivor copies only items whose owner is seated on its deal (Q21).
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_corr := discovery_merge_candidates(v_har3, v_pro, 'Harbor Three belongs to the promoted deal');
  reset role;
  perform pg_temp.expect(
    (select count(*) from evidence_links where candidate_id = v_pro and source_item_id = v_har3_a), 1, 'the seated owner''s item joined the promoted survivor');
  perform pg_temp.expect(
    (select count(*) from evidence_links where candidate_id = v_pro and source_item_id = v_har3_c), 0, 'the unseated owner''s item did not');
  perform pg_temp.expect(pg_temp.links(v_har3), 2, 'the merged candidate keeps both links');
  raise notice 'PASS: merge';

  -- ── Every upsert branch ──────────────────────────────────────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- proposed, not pinned: metadata refreshes, new links attach.
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:unp', 'Project Unpinned Refreshed', array[v_unp_a, v_unp_new]));
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_unp), 'Project Unpinned Refreshed', 'an unpinned proposed candidate refreshes');
  perform pg_temp.expect(pg_temp.links(v_unp), 2, 'an unpinned proposed candidate gains links');
  -- merged_into: new evidence lands on the survivor, whose name is not refreshed.
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:har', 'Project Harbor Renamed By Mail', array[v_har_a, v_kes_new]));
  perform pg_temp.expect(pg_temp.links(v_kes), 5, 'a merged candidate''s new mail lands on the survivor');
  perform pg_temp.expect(pg_temp.links(v_har), 2, 'the merged candidate gains nothing itself');
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_kes), 'Project Kestrel', 'the survivor''s name is not refreshed');
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_har), 'Project Harbor', 'the merged candidate''s name is not refreshed');
  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_kes and person_id = v_alice), 5, 'the survivor''s visibility is refreshed');
  -- confirmed, not promoted: gains links.
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:con', 'Project Confirmed', array[v_con_a, v_con_new]));
  perform pg_temp.expect(pg_temp.links(v_con), 2, 'a confirmed candidate gains links');
  -- confirmed and promoted: only seated owners' items.
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:pro', 'Project Promoted', array[v_pro_a, v_pro_seated, v_pro_unseated]));
  perform pg_temp.expect(
    (select count(*) from evidence_links where candidate_id = v_pro and source_item_id = v_pro_seated), 1, 'a promoted candidate gains the seated owner''s item');
  perform pg_temp.expect(
    (select count(*) from evidence_links where candidate_id = v_pro and source_item_id = v_pro_unseated), 0, 'a promoted candidate does not gain the unseated owner''s item');
  -- merged into a survivor that is now rejected: nothing lands anywhere.
  update deal_candidates set discovery_state = 'rejected' where id = v_kes;
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:har2', 'Project Harbor Two', array[v_har2_a, v_orphan_new]));
  perform pg_temp.expect(pg_temp.links(v_kes), 5, 'a merged candidate with a rejected survivor gains nothing');
  update deal_candidates set discovery_state = 'proposed' where id = v_kes;
  -- a brand new cluster is created, audited once, and starts proposed and unpinned.
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:fresh', 'Project Fresh', array[v_fresh_a]));
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant and cluster_key = 'k:fresh' and discovery_state = 'proposed' and not pinned), 1, 'a new cluster starts proposed and unpinned');
  raise notice 'PASS: every upsert branch';

  -- ── The log: read under the candidate's RLS, closed to writers, append-only ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_ren), 1, 'Alice reads the rename');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_har), 1, 'Alice reads the merge on Harbor');
  -- The colleague sees Renamable through the shared item, and not Harbor.
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_ren), 1, 'the colleague reads the rename on a candidate he sees');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_har), 0, 'the colleague does not read Harbor''s merge');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from corrections), 0, 'Bob reads no correction');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from corrections), 0, 'the firm admin reads no correction');
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect((select count(*) from corrections), 0, 'another tenant reads no correction');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from corrections), 7, 'the control room reads every correction of the tenant');
  perform pg_temp.expect_attempt(
    format('insert into corrections (tenant_id, candidate_id, actor_id, action) values (%L, %L, %L, %L)', v_tenant, v_kes, v_cco, 'rename'),
    '42501', 'a signed-in user cannot insert a correction');
  perform pg_temp.expect_attempt('update corrections set reason = ''edited''', '42501', 'a signed-in user cannot edit a correction');
  reset role;
  set local role anon;
  perform pg_temp.expect_attempt('select count(*) from corrections', '42501', 'anon cannot read the log');
  reset role;

  perform pg_temp.expect_attempt('update corrections set reason = ''edited''', 'P0001', 'the log refuses an update, even from the owner');
  perform pg_temp.expect_attempt('delete from corrections', 'P0001', 'the log refuses a delete, even from the owner');
  -- A plain truncate is refused earlier still (deal_candidates references the log); CASCADE reaches the trigger.
  perform pg_temp.expect_attempt('truncate corrections', '0A000', 'the log cannot be truncated while a foreign key names it');
  perform pg_temp.expect_attempt('truncate corrections cascade', 'P0001', 'the log refuses a cascading truncate, even from the owner');
  select count(*) into v_count from corrections where tenant_id = v_tenant;
  perform pg_temp.expect(v_count, 7, 'seven corrections stand: rename, reject, two stations, three merges');
  perform pg_temp.expect(
    (select count(*) from corrections where tenant_id = v_tenant and action = 'merge'), 3, 'the merge log counts three merges (Harbor Two, Harbor, Harbor Three)');

  -- ── Split and reassign (20261002230000_discovery_split_reassign.sql) ─────
  v_spl_1  := pg_temp.mk_item(v_tenant, v_src_alice, 'spl-1');
  v_spl_2  := pg_temp.mk_item(v_tenant, v_src_alice, 'spl-2');
  v_spl_3  := pg_temp.mk_item(v_tenant, v_src_alice, 'spl-3');
  v_spl_c  := pg_temp.mk_item(v_tenant, v_src_coll, 'spl-c');
  v_rsrc_a := pg_temp.mk_item(v_tenant, v_src_alice, 'rsrc-a');
  v_rsrc_b := pg_temp.mk_item(v_tenant, v_src_alice, 'rsrc-b');
  v_rsrc_u := pg_temp.mk_item(v_tenant, v_src_coll, 'rsrc-u');
  v_rdst_a := pg_temp.mk_item(v_tenant, v_src_alice, 'rdst-a');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run,
    pg_temp.grp('k:spl',  'Project Splittable', array[v_spl_1, v_spl_2, v_spl_3, v_spl_c])
    || pg_temp.grp('k:rsrc', 'Project Reassign Source', array[v_rsrc_a, v_rsrc_b, v_rsrc_u])
    || pg_temp.grp('k:rdst', 'Project Reassign Target', array[v_rdst_a]));
  v_spl := pg_temp.cand(v_tenant, 'k:spl'); v_rsrc := pg_temp.cand(v_tenant, 'k:rsrc'); v_rdst := pg_temp.cand(v_tenant, 'k:rdst');
  perform pg_temp.expect(pg_temp.links(v_spl), 4, 'fixture: Splittable holds four links');

  -- Refusals.
  set local role anon;
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1], 'Nope', 'Nope'), '42501', 'anon cannot split');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', gen_random_uuid(), v_rdst, 'Nope'), '42501', 'anon cannot reassign');
  reset role;
  select id into v_link from evidence_links where candidate_id = v_rsrc and source_item_id = v_rsrc_a;
  set local role authenticated;
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1], 'Nope', 'Nope'), 'P0002', 'another tenant cannot split');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rdst, 'Nope'), 'P0002', 'another tenant cannot reassign');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1], 'Nope', 'Nope'), 'P0002', 'Bob cannot split what he cannot see');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rdst, 'Nope'), 'P0002', 'Bob cannot reassign what he cannot see');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1], 'Nope', 'Nope'), 'P0002', 'the firm admin cannot split');
  -- The colleague sees Splittable through spl-c but holds no deal-create authority.
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_c], 'Nope', 'Nope'), '42501', 'the colleague has no authority to split');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rdst, 'Nope'), '42501', 'the colleague has no authority to reassign');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', gen_random_uuid(), v_rdst, 'Nope'), 'P0002', 'an unknown link is not visible');
  reset role;
  perform pg_temp.expect((select count(*) from corrections where action in ('split', 'reassign')), 0, 'refused calls wrote nothing');

  -- Validation and the all-or-nothing rules.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1], 'New', ' '), '22023', 'a split needs a reason');
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1], ' ', 'Why'), '22023', 'a split needs a name');
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1], repeat('x', 121), 'Why'), '22023', 'a split name over 120 characters is refused');
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, '{}'::uuid[], 'New', 'Why'), '22023', 'a split needs at least one item');
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_rsrc_a], 'New', 'Why'), '22023', 'an item that is not on the candidate cannot be split off it');
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_1, v_spl_2, v_spl_3, v_spl_c], 'New', 'Why'), '22023', 'a split cannot move every item');
  -- Alice cannot open a candidate made only of her colleague's mail.
  select count(*) into v_before from deal_candidates where tenant_id = v_tenant;
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_c], 'Colleague only', 'Why'), '22023', 'a split the caller could not open is refused');
  reset role;
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant), v_before, 'the refused split created no candidate');
  perform pg_temp.expect(pg_temp.links(v_spl), 4, 'the refused split left the links alone');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_spl and state = 'rejected'), 0, 'the refused split rejected nothing');

  -- A split: two of Alice's items and the colleague's move to a new proposed deal.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_corr := discovery_split_candidate(v_spl, array[v_spl_2, v_spl_3, v_spl_3], '  Project Splinter  ', 'Two different processes');
  reset role;
  v_spl_new := (select (after->>'newCandidateId')::uuid from corrections where id = v_corr);
  perform pg_temp.expect_text((select action from corrections where id = v_corr), 'split', 'the log holds a split');
  perform pg_temp.expect((select candidate_id = v_spl from corrections where id = v_corr)::int, 1, 'the split is recorded on the original');
  perform pg_temp.expect_text((select after->>'itemCount' from corrections where id = v_corr), '2', 'the log counts the distinct items moved');
  perform pg_temp.expect_text((select after->>'newName' from corrections where id = v_corr), 'Project Splinter', 'the log keeps the trimmed name');
  perform pg_temp.expect_text((select before->>'name' from corrections where id = v_corr), 'Project Splittable', 'the log keeps the original name');
  perform pg_temp.expect_text((select reason from corrections where id = v_corr), 'Two different processes', 'the log keeps the reason');
  perform pg_temp.expect_text((select cluster_key from deal_candidates where id = v_spl_new), 'correction:' || v_corr, 'the new candidate has a correction key, never a worker key');
  perform pg_temp.expect_text((select discovery_state from deal_candidates where id = v_spl_new), 'proposed', 'the new candidate is proposed');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_spl_new and pinned), 1, 'the new candidate is pinned');
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_spl_new), 'Project Splinter', 'the new candidate has the chosen name');
  perform pg_temp.expect(pg_temp.links(v_spl_new), 2, 'the new candidate holds the two moved links');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_spl_new and state = 'confirmed' and pinned_by_correction_id = v_corr), 2, 'the new links are confirmed and pinned by the correction');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_spl and state = 'rejected' and pinned_by_correction_id = v_corr), 2, 'the original links are rejected and pinned by the correction');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_spl and state <> 'rejected'), 2, 'the original keeps the rest');
  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_spl_new and person_id = v_alice), 2, 'Alice sees two items of the new candidate');
  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_spl and person_id = v_alice), 1, 'Alice''s original count dropped');
  perform pg_temp.expect(
    (select count(*) from candidate_visibility where candidate_id = v_spl and person_id = v_colleague), 1, 'the colleague still sees the original (his spl-c stayed)');
  perform pg_temp.expect(
    (select count(*) from discovery_recompute_requests where reason = 'correction' and candidate_id in (v_spl, v_spl_new)), 2, 'a split asks for a recompute of both');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.correction' and actor_type = 'user'
       and detail->>'correctionId' = v_corr::text and detail->>'action' = 'split' and detail->>'newCandidateId' = v_spl_new::text), 1, 'a split is audited once, with ids');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.correction' and detail::text ~* '(splinter|splittable)'), 0, 'the audit detail holds no name');
  -- The moved item cannot be split again (its link on the original is rejected).
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_spl, array[v_spl_2], 'Again', 'Why'), '22023', 'a moved item is no longer live on the original');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_spl_new and discovery_state = 'proposed'), 1, 'Alice lists the new proposed deal');
  reset role;

  -- A split survives a re-run: the worker routes the same items to the same cluster again.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:spl', 'Project Splittable', array[v_spl_1, v_spl_2, v_spl_3, v_spl_c]));
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_spl and state = 'rejected'), 2, 'a re-run keeps the split-off links rejected');
  perform pg_temp.expect(pg_temp.links(v_spl_new), 2, 'a re-run leaves the new candidate''s links');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_spl_new and state = 'confirmed'), 2, 'a re-run keeps the new links confirmed');
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_spl_new), 'Project Splinter', 'a re-run leaves the new candidate''s name');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_spl_new), 2, 'Alice reads the new candidate''s links');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_spl and action = 'split'), 1, 'Alice reads the split');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_spl_new), 0, 'the colleague sees no new candidate (no item of his moved)');
  reset role;
  raise notice 'PASS: split';

  -- Reassign: one link moves from the source to another proposed deal.
  select id into v_link from evidence_links where candidate_id = v_rsrc and source_item_id = v_rsrc_a;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rdst, ''), '22023', 'a reassign needs a reason');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rsrc, 'Same'), '22023', 'a link cannot move to its own candidate');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rej, 'Into a rejected one'), '55000', 'a rejected target is refused');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_har, 'Into a merged one'), '55000', 'a merged target is refused');
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, gen_random_uuid(), 'Nowhere'), 'P0002', 'an unknown target is not visible');
  v_corr := discovery_reassign_link(v_link, v_rdst, 'This email is about the other deal');
  reset role;
  perform pg_temp.expect_text((select state from evidence_links where id = v_link), 'rejected', 'the old link is rejected');
  perform pg_temp.expect((select count(*) from evidence_links where id = v_link and pinned_by_correction_id = v_corr), 1, 'the old link is pinned by the correction');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_rdst and source_item_id = v_rsrc_a
                            and state = 'confirmed' and pinned_by_correction_id = v_corr), 1, 'the target holds a confirmed, pinned link');
  perform pg_temp.expect_text((select candidate_id::text from corrections where id = v_corr), v_rsrc::text, 'the reassign is recorded on the source');
  perform pg_temp.expect_text((select after->>'targetCandidateId' from corrections where id = v_corr), v_rdst::text, 'the log names the target');
  perform pg_temp.expect_text((select after->>'targetName' from corrections where id = v_corr), 'Project Reassign Target', 'the log names the target''s name');
  perform pg_temp.expect_text((select before->>'name' from corrections where id = v_corr), 'Project Reassign Source', 'the log names the source');
  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_rdst and person_id = v_alice), 2, 'the target''s visibility is refreshed');
  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_rsrc and person_id = v_alice), 1, 'the source''s visibility is refreshed');
  perform pg_temp.expect(
    (select count(*) from discovery_recompute_requests where reason = 'correction' and candidate_id in (v_rsrc, v_rdst)), 2, 'a reassign asks for a recompute of both');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.correction' and actor_type = 'user'
       and detail->>'action' = 'reassign' and detail->>'targetCandidateId' = v_rdst::text), 1, 'a reassign is audited once, with ids');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rdst, 'Again'), '55000', 'a rejected link cannot move again');
  reset role;
  -- A re-run leaves the moved item on the target.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:rsrc', 'Project Reassign Source', array[v_rsrc_a, v_rsrc_b, v_rsrc_u]));
  perform pg_temp.expect_text((select state from evidence_links where id = v_link), 'rejected', 'a re-run keeps the old link rejected');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_rdst and source_item_id = v_rsrc_a and state = 'confirmed'), 1, 'a re-run keeps the target link');
  -- Moving it back confirms the rejected link the target's return path leaves behind.
  select id into v_link from evidence_links where candidate_id = v_rdst and source_item_id = v_rsrc_a;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_corr := discovery_reassign_link(v_link, v_rsrc, 'Moving it back');
  reset role;
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_rsrc and source_item_id = v_rsrc_a and state = 'confirmed'), 1, 'moving back re-confirms the link on the source');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_rsrc and source_item_id = v_rsrc_a), 1, 'moving back keeps one link per item');

  -- Q21: a promoted target gains only items whose owner is seated on its deal.
  select id into v_link from evidence_links where candidate_id = v_rsrc and source_item_id = v_rsrc_u;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_pro, 'Unseated owner'), '42501', 'an unseated owner''s item cannot join a promoted deal');
  select id into v_link from evidence_links where candidate_id = v_rsrc and source_item_id = v_rsrc_b;
  v_corr := discovery_reassign_link(v_link, v_pro, 'Seated owner');
  reset role;
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_pro and source_item_id = v_rsrc_b and state = 'confirmed'), 1, 'a seated owner''s item joined the promoted deal');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_pro and source_item_id = v_rsrc_u), 0, 'the unseated owner''s item did not');
  perform pg_temp.expect_text((select state from evidence_links where candidate_id = v_rsrc and source_item_id = v_rsrc_u), 'proposed', 'the refused reassign left the source link alone');
  raise notice 'PASS: reassign';

  -- P4: a split or a reassign needs the caller to be able to open every email it moves, not only the
  -- candidate. vis-w belongs to Bob, who then withdraws consent: the candidate stays open to Alice
  -- through vis-a, but vis-w is deleted with Bob's mailbox (#461), so she can no longer open it and a
  -- split or reassign naming it is refused as not visible.
  -- P5: vis-s is carried by Bob (seated on the promoted deal) and by the colleague (not seated). Once
  -- Bob withdraws, no seated owner is still reading it, so it cannot join the promoted deal.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
    values (v_deal, v_bob, (select id from roles where slug = 'deal_team'), 'deal_team');
  v_vis_a := pg_temp.mk_item(v_tenant, v_src_alice, 'vis-a');
  v_vis_w := pg_temp.mk_item(v_tenant, v_src_bob, 'vis-w');
  v_vis_s := pg_temp.mk_item(v_tenant, v_src_bob, 'vis-s');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_vis_s, v_src_coll, 'c-vis-s');
  perform discovery_upsert_candidates(v_tenant, v_run, pg_temp.grp('k:vis', 'Project Visible', array[v_vis_a, v_vis_w, v_vis_s]));
  v_vis := pg_temp.cand(v_tenant, 'k:vis');
  perform pg_temp.expect(pg_temp.links(v_vis), 3, 'fixture: the visibility candidate holds three links');
  select id into v_link from evidence_links where candidate_id = v_vis and source_item_id = v_vis_w;
  perform pg_temp.expect((select count(*) from (select 1 where discovery_item_owner_seated(v_vis_s, v_deal)) t), 1,
    'before the withdrawal Bob''s seat on the promoted deal carries vis-s');
  perform pg_temp.expect((select count(*) from (select 1 where discovery_item_owner_seated(v_vis_a, v_deal)) t), 1,
    'Alice''s seat carries her own item');
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.expect((select count(*) from (select 1 where discovery_item_owner_seated(v_vis_s, v_deal)) t), 0,
    'a seated owner who withdrew consent no longer carries an item onto the deal');
  perform pg_temp.expect((select count(*) from (select 1 where discovery_item_owner_seated(v_vis_a, v_deal)) t), 1,
    'the seated owner who still reads keeps carrying theirs');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_vis), 1, 'Alice still opens the candidate through vis-a');
  perform pg_temp.expect((select count(*) from source_items where id = v_vis_w), 0, 'Alice can no longer open the withdrawn mailbox''s item');
  reset role;
  perform pg_temp.expect((select count(*) from source_items where id = v_vis_w), 0, 'the withdrawn mailbox''s sole-held item is deleted (#461)');
  perform pg_temp.expect((select count(*) from source_items where id = v_vis_s), 1, 'vis-s, still in the colleague''s mailbox, stays');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_vis, array[v_vis_w], 'Withdrawn item', 'Why'),
    'P0002', 'a split of an item the caller cannot open is not visible');
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_vis, array[v_vis_a, v_vis_w], 'Mixed', 'Why'),
    'P0002', 'one unreadable item refuses the whole split');
  perform pg_temp.expect_attempt(format('select discovery_split_candidate(%L, %L, %L, %L)', v_vis, array[gen_random_uuid()], 'Unknown', 'Why'),
    'P0002', 'an unknown item is not visible');
  reset role;
  perform pg_temp.expect(pg_temp.links(v_vis), 2, 'the refused splits created no link (vis-w''s went with its item)');
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant and proposed_name in ('Withdrawn item', 'Mixed', 'Unknown')), 0,
    'the refused splits created no candidate');
  -- v_link is vis-w's link, read before the withdrawal deleted it.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_rdst, 'Withdrawn item'),
    'P0002', 'a reassign of an item the caller cannot open is not visible');
  select id into v_link from evidence_links where candidate_id = v_vis and source_item_id = v_vis_s;
  perform pg_temp.expect_attempt(format('select discovery_reassign_link(%L, %L, %L)', v_link, v_pro, 'No seated owner left'),
    '42501', 'a seated owner who withdrew consent cannot have the item join a promoted deal');
  reset role;
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_pro and source_item_id = v_vis_s), 0,
    'the refused reassign left the promoted candidate alone');
  perform pg_temp.expect_text((select state from evidence_links where id = v_link), 'proposed', 'the refused reassign left the source link alone');
  raise notice 'PASS: visibility of moved items, and the seated owner who still reads';

  -- The two new RPCs are the banker's session alone.
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('discovery_split_candidate', 'discovery_reassign_link')
       and has_function_privilege('anon', p.oid, 'execute')), 0, 'anon executes neither split nor reassign');
  perform pg_temp.expect(
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('discovery_split_candidate', 'discovery_reassign_link')
       and has_function_privilege('authenticated', p.oid, 'execute')), 2, 'authenticated executes both');

  raise notice 'PASS: discovery corrections: refusals, the four RPCs, split and reassign, the authority read, every upsert branch, the log';
end $$;

rollback;
