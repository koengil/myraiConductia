-- Deal discovery RLS (20260925120000_discovery_core.sql): who sees which
-- candidate, link, item and text, read as each user under the authenticated
-- role, the way /api/v1/discovery/* reads.
--
--   Alice      owns two Falcon items (one shared with the colleague)
--   Colleague  owns the shared item, a Falcon item of their own, a tentative
--              Falcon item and the only Cobra item
--   Bob        has a mailbox with no deal mail
--   CCO        the control room of the tenant
--   Admin      a firm admin (runs operations, reads no content; registers the SharePoint site)
--   Outsider   the control room of another tenant
--
-- Then a team inbox (#581, 20261019160000_team_mailbox_visibility.sql), in a tenant of its own: only its
-- members see what discovery found in it (see the last block).
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_rls.sql
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

-- What the caller sees, as candidates/links/items/visibility rows/texts. Runs
-- as the caller (security invoker), so RLS applies.
create function pg_temp.snap()
returns text language sql as $$
  select (select count(*) from deal_candidates)::text || '/' || (select count(*) from evidence_links)::text || '/'
      || (select count(*) from source_items)::text || '/' || (select count(*) from candidate_visibility)::text || '/'
      || (select count(*) from source_item_texts)::text;
$$;

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user, 'role', 'authenticated')::text, true);
$$;
-- Seats a user on a deal of their tenant as deal team (PR #300 round 3, A2: the one-click opt-in needs MD or deal
-- team on a deal). One deal per tenant, created on first use. Run as the table owner.
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
-- New functions no longer grant PUBLIC EXECUTE by default (#233); the
-- helpers above run as authenticated.
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
  v_src_alice  uuid := gen_random_uuid();
  v_src_coll   uuid := gen_random_uuid();
  v_src_bob    uuid := gen_random_uuid();
  v_shared     uuid := gen_random_uuid();
  v_alice_item uuid := gen_random_uuid();
  v_coll_item  uuid := gen_random_uuid();
  v_tentative  uuid := gen_random_uuid();
  v_cobra_item uuid := gen_random_uuid();
  v_foreign    uuid := gen_random_uuid();
  v_run        uuid := gen_random_uuid();
  v_bank       uuid := gen_random_uuid();
  v_inv_alice  uuid := gen_random_uuid();
  v_inv_coll   uuid := gen_random_uuid();
  v_inv_bob    uuid := gen_random_uuid();
  v_falcon     uuid;
  v_cobra      uuid;
  v_bank2      uuid := gen_random_uuid();
  v_cco2       uuid := gen_random_uuid();
  v_snap_alice text;
  v_snap_coll  text;
  v_src_site   uuid := gen_random_uuid();
  v_site_item  uuid := gen_random_uuid();
  v_site       text := 'bank.sharepoint.com:/sites/deals';
  v_snap_reg   text;
  v_snap_admin text;
  v_snap_cco   text;
  v_groups     jsonb;
  v_result     jsonb;
  v_cnt        bigint;
  v_blocked    boolean;
  v_meta       record;
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alice,     'dd-alice@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_colleague, 'dd-colleague@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_bob,       'dd-bob@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_cco,       'dd-cco@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance')),
    (v_admin,     'dd-admin@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_outsider,  'dd-outsider@example.test',  jsonb_build_object('tenant_id', v_other, 'department', 'compliance'));
  update users set status = 'active', is_external = false
    where id in (v_alice, v_colleague, v_bob, v_cco, v_admin, v_outsider);
  update users set firm_role = 'cco' where id in (v_cco, v_outsider);
  update users set firm_role = 'admin' where id = v_admin;

  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values
    (v_tenant, 'fixture', 'fixture', 'active'),
    (v_other, 'fixture', 'fixture', 'active');

  -- #262: a mailbox is readable only for an invite-seated bank member who
  -- opted in. Seat Alice, the colleague, Bob, the admin and the CCO (the control
  -- room is the firm's seated CCO; the admin registers the site, R23), so the counts below hold.
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'DD Bank', 'bank');
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
  -- Each opts in through the RPC as themselves (audit round 1, item 14: no other writer can insert a consent).
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_colleague);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_bob);
  perform mailbox_consent_grant();
  reset role;
  -- Each opt-in created its owner's mailbox source (C20); look the three up.
  select id into v_src_alice from content_sources where tenant_id = v_tenant and address = 'alice@bank.example' and owner_user_id = v_alice;
  select id into v_src_coll  from content_sources where tenant_id = v_tenant and address = 'colleague@bank.example' and owner_user_id = v_colleague;
  select id into v_src_bob   from content_sources where tenant_id = v_tenant and address = 'bob@bank.example' and owner_user_id = v_bob;
  if v_src_alice is null or v_src_coll is null or v_src_bob is null then
    raise exception 'FAIL: an opt-in did not create its mailbox source';
  end if;

  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_shared,     v_tenant, 'message', 'Project Falcon: kickoff',   '2026-02-03', '<shared@t>',   'h1'),
    (v_alice_item, v_tenant, 'message', 'Heliotrope next steps',     '2026-02-10', '<alice@t>',    'h2'),
    (v_coll_item,  v_tenant, 'message', 'Project Falcon: buyers',    '2026-02-18', '<coll@t>',     'h3'),
    (v_tentative,  v_tenant, 'message', 'Board pack',                '2026-02-19', '<tent@t>',     'h4'),
    (v_cobra_item, v_tenant, 'message', 'Project Cobra: engagement', '2025-11-04', '<cobra@t>',    'h5'),
    (v_foreign,    v_other,  'message', 'Project Falcon elsewhere',  '2026-02-01', '<foreign@t>',  'h6');
  -- The participants are owner-only content (20261017100000), like the subject.
  update source_items set participants = jsonb_build_array(
      jsonb_build_object('role', 'to', 'address', 'alice@bank.example'),
      jsonb_build_object('role', 'from', 'name', 'Hana Ito', 'address', 'hana.ito@Heliotrope.example'))
    where id = v_coll_item;
  update source_items set participants = jsonb_build_array(
      jsonb_build_object('role', 'from', 'name', 'Alice', 'address', 'alice@bank.example')),
      drive_path = '/Deals/Heliotrope/notes.docx'
    where id = v_alice_item;
  insert into source_item_texts (source_item_id, body_text) values
    (v_shared, 'shared body'), (v_alice_item, 'alice body'), (v_coll_item, 'colleague body'),
    (v_tentative, 'tentative body'), (v_cobra_item, 'cobra body'), (v_foreign, 'foreign body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_shared, v_src_alice, 'a-1'), (v_shared, v_src_coll, 'c-1'),
    (v_alice_item, v_src_alice, 'a-2'),
    (v_coll_item, v_src_coll, 'c-2'), (v_tentative, v_src_coll, 'c-3'), (v_cobra_item, v_src_coll, 'c-4');

  -- ── The worker's RPC, as the service role ────────────────────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_groups := jsonb_build_array(
    jsonb_build_object(
      'clusterKey', 'codename:falcon', 'proposedName', 'Project Falcon', 'codenameGuess', 'Project Falcon',
      'parties', jsonb_build_array(jsonb_build_object('name', 'Heliotrope', 'domain', 'heliotrope.example')),
      'firstSeenAt', '2026-02-03T00:00:00Z', 'lastSeenAt', '2026-02-18T00:00:00Z', 'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_shared, 'method', 'codename', 'confidence', 0.95),
        jsonb_build_object('sourceItemId', v_alice_item, 'method', 'thread_continuation', 'confidence', 0.85),
        jsonb_build_object('sourceItemId', v_coll_item, 'method', 'codename', 'confidence', 0.95),
        -- Another tenant's item never becomes evidence here.
        jsonb_build_object('sourceItemId', v_foreign, 'method', 'codename', 'confidence', 0.95))),
    jsonb_build_object(
      'clusterKey', 'codename:cobra', 'proposedName', 'Project Cobra', 'codenameGuess', 'Project Cobra',
      'parties', '[]'::jsonb, 'firstSeenAt', '2025-11-04T00:00:00Z', 'lastSeenAt', '2025-11-04T00:00:00Z',
      'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_cobra_item, 'method', 'codename', 'confidence', 0.95))));

  v_result := discovery_upsert_candidates(v_tenant, v_run, v_groups);
  perform pg_temp.expect(jsonb_array_length(v_result), 2, 'the RPC answers for both groups');
  perform pg_temp.expect(
    (select count(*) from jsonb_array_elements(v_result) e where (e->>'created')::boolean), 2,
    'both candidates are new on the first run');
  select id into v_falcon from deal_candidates where tenant_id = v_tenant and cluster_key = 'codename:falcon';
  select id into v_cobra from deal_candidates where tenant_id = v_tenant and cluster_key = 'codename:cobra';

  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_falcon), 3,
    'Falcon has three firm links and no foreign item');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.candidate_proposed'
       and actor_type = 'service' and actor_id is null and service_identity = 'discovery-worker'
       and chain_seq is not null),
    2, 'each new candidate is audited once by the service, chained in its tenant');

  -- A re-run creates nothing and audits nothing.
  v_result := discovery_upsert_candidates(v_tenant, gen_random_uuid(), v_groups);
  perform pg_temp.expect(
    (select count(*) from jsonb_array_elements(v_result) e where (e->>'created')::boolean), 0,
    'a re-run creates no candidate');
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant), 2,
    'a re-run adds no candidate');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id in (v_falcon, v_cobra)), 4,
    'a re-run adds no link');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.candidate_proposed'), 2,
    'a re-run writes no audit row');

  -- A tentative route: the colleague's own item, never counted in visibility.
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence)
    values (v_falcon, v_tentative, 'codename', 'tentative', 0.4);
  perform discovery_refresh_candidate_visibility(v_falcon);

  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_falcon and person_id = v_alice), 2,
    'Alice holds two Falcon items');
  perform pg_temp.expect(
    (select source_item_count from candidate_visibility where candidate_id = v_falcon and person_id = v_colleague), 2,
    'the colleague holds two Falcon items; the tentative one does not count');
  perform pg_temp.expect((select count(*) from candidate_visibility where person_id = v_bob), 0,
    'Bob holds no evidence');

  -- A link names a candidate or a deal, never both and never neither.
  v_blocked := false;
  begin
    insert into evidence_links (source_item_id, method, route_tier) values (v_shared, 'codename', 'firm');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: a link with neither candidate nor deal was accepted'; end if;

  raise notice 'PASS: discovery worker RPC is idempotent and audits new candidates once';

  -- ── Reads as each user ───────────────────────────────────────────────────
  set local role authenticated;

  -- Alice: Falcon only. The colleague's firm item is metadata only; the
  -- colleague's tentative item and Cobra are invisible.
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from deal_candidates), 1, 'Alice sees one candidate');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_falcon), 1, 'Alice sees Falcon');
  perform pg_temp.expect((select count(*) from evidence_links), 3, 'Alice sees Falcon''s three firm links');
  perform pg_temp.expect((select count(*) from evidence_links where source_item_id = v_tentative), 0,
    'Alice does not see the colleague''s tentative link');
  perform pg_temp.expect((select count(*) from source_items), 3, 'Alice sees three item rows');
  perform pg_temp.expect((select count(*) from source_items where id = v_coll_item), 1,
    'Alice sees the colleague''s firm item as metadata');
  perform pg_temp.expect((select count(*) from source_items where id in (v_tentative, v_cobra_item, v_foreign)), 0,
    'Alice does not see the tentative, Cobra or foreign items');
  perform pg_temp.expect((select count(*) from source_item_texts), 2, 'Alice reads the text of her own two items');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_coll_item), 0,
    'Alice cannot read the colleague''s text');
  perform pg_temp.expect((select count(*) from candidate_visibility), 1, 'Alice sees only her own visibility row');
  if app_can_see_candidate(v_cobra, v_colleague) or app_owns_item(v_coll_item, v_colleague)
     or app_is_control_room(v_cco) or app_can_see_item(v_cobra_item, v_colleague) then
    raise exception 'FAIL: a helper answered Alice about another user';
  end if;
  if not app_can_see_candidate(v_falcon, v_alice) then
    raise exception 'FAIL: the helper denied Alice her own candidate';
  end if;

  -- The colleague: both candidates, their tentative link, and text only for
  -- their own items.
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from deal_candidates), 2, 'the colleague sees Falcon and Cobra');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_falcon), 4,
    'the colleague sees Falcon''s firm links and their own tentative one');
  perform pg_temp.expect((select count(*) from source_items), 5, 'the colleague sees five item rows');
  perform pg_temp.expect((select count(*) from source_item_texts), 4, 'the colleague reads their own four texts');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_alice_item), 0,
    'the colleague cannot read Alice''s text');

  -- Bob: nothing.
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from deal_candidates), 0, 'Bob sees no candidate');
  perform pg_temp.expect((select count(*) from evidence_links), 0, 'Bob sees no link');
  perform pg_temp.expect((select count(*) from source_items), 0, 'Bob sees no item');
  perform pg_temp.expect((select count(*) from source_item_texts), 0, 'Bob reads no text');
  perform pg_temp.expect((select count(*) from candidate_visibility), 0, 'Bob sees no visibility row');

  -- The control room: every candidate, link and item in its tenant, and no
  -- text by SELECT (that is the audited read of phase 6).
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from deal_candidates), 2, 'the CCO sees both candidates');
  perform pg_temp.expect((select count(*) from evidence_links), 5, 'the CCO sees every link, tentative included');
  perform pg_temp.expect((select count(*) from source_items), 5, 'the CCO sees every item of the tenant');
  perform pg_temp.expect((select count(*) from source_item_texts), 0, 'the CCO reads no text by SELECT');
  perform pg_temp.expect((select count(*) from candidate_visibility), 3, 'the CCO sees every visibility row');

  -- The firm admin: nothing (Q19).
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from deal_candidates), 0, 'the admin sees no candidate');
  perform pg_temp.expect((select count(*) from evidence_links), 0, 'the admin sees no link');
  perform pg_temp.expect((select count(*) from source_items), 0, 'the admin sees no item');
  perform pg_temp.expect((select count(*) from source_item_texts), 0, 'the admin reads no text');
  perform pg_temp.expect((select count(*) from candidate_visibility), 0, 'the admin sees no visibility row');

  -- Another tenant's control room: nothing.
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect((select count(*) from deal_candidates), 0, 'another tenant''s CCO sees no candidate');
  perform pg_temp.expect((select count(*) from source_items where tenant_id = v_tenant), 0,
    'another tenant''s CCO sees no item');

  -- ── The column wall (20261017100000): subject, participants and drive_path ─
  -- RLS admits the colleague's firm item to Alice as a row; the database, not
  -- the app, keeps its content to its owner. Direct reads of a walled column
  -- are refused for every authenticated caller; the definer answers it only to
  -- an owner.
  perform pg_temp.act_as(v_alice);
  v_blocked := false;
  begin
    perform subject from source_items where id = v_coll_item;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: Alice read the colleague''s subject directly'; end if;
  v_blocked := false;
  begin
    perform participants from source_items where id = v_coll_item;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: Alice read the colleague''s participants directly'; end if;
  v_blocked := false;
  begin
    perform drive_path from source_items where id = v_coll_item;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: Alice read a drive path directly'; end if;
  v_blocked := false;
  begin
    perform 1 from source_items where subject is not null;   -- a filter is a read too
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: Alice filtered on the subject column'; end if;
  -- The safe columns still read, through the same row policy.
  perform pg_temp.expect(
    (select count(*) from source_items
      where id = v_coll_item and kind = 'message' and sent_at = '2026-02-18' and internet_message_id = '<coll@t>'
        and content_hash = 'h3' and sensitivity = 'standard' and tenant_id = v_tenant
        and conversation_id is null and drive_item_key is null and created_at is not null),
    1, 'Alice still reads the colleague''s item''s safe columns');

  -- The owner's path: Alice's own item answers its content; the colleague's
  -- answers the row with the content nulled and the sender's domain only; an
  -- item the row policy hides answers nothing.
  perform pg_temp.expect(
    (select count(*) from discovery_item_metadata(array[v_alice_item, v_coll_item, v_cobra_item, v_foreign])), 2,
    'the definer answers only the rows the policy admits');
  select * into v_meta from discovery_item_metadata(array[v_alice_item]);
  if not v_meta.own or v_meta.subject is distinct from 'Heliotrope next steps'
     or v_meta.participants->0->>'address' is distinct from 'alice@bank.example'
     or v_meta.sender_domain is distinct from 'bank.example' then
    raise exception 'FAIL: the owner did not read her own item''s content (%)', row_to_json(v_meta);
  end if;
  select * into v_meta from discovery_item_metadata(array[v_coll_item]);
  if v_meta.own or v_meta.subject is not null or v_meta.participants is not null
     or v_meta.sender_domain is distinct from 'heliotrope.example'
     or v_meta.kind is distinct from 'message' or v_meta.sent_at is distinct from '2026-02-18'::timestamptz then
    raise exception 'FAIL: a non-owner read a colleague''s content through the definer (%)', row_to_json(v_meta);
  end if;
  -- The shared item has two owners; each reads it.
  perform pg_temp.expect(
    (select count(*) from discovery_item_metadata(array[v_shared]) m
      where m.own and m.subject = 'Project Falcon: kickoff'), 1, 'Alice reads the shared item she co-owns');

  -- The colleague owns their item and reads its content; not Alice's.
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect(
    (select count(*) from discovery_item_metadata(array[v_coll_item]) m
      where m.own and m.subject = 'Project Falcon: buyers' and m.participants->1->>'name' = 'Hana Ito'), 1,
    'the colleague reads their own item''s subject and participants');
  perform pg_temp.expect(
    (select count(*) from discovery_item_metadata(array[v_alice_item]) m where m.subject is null and not m.own), 1,
    'the colleague gets Alice''s item without its subject');

  -- The control room sees every row and, like source_item_texts, no content.
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect(
    (select count(*) from discovery_item_metadata(array[v_shared, v_alice_item, v_coll_item, v_tentative, v_cobra_item]) m
      where not m.own and m.subject is null and m.participants is null), 5,
    'the CCO gets every item of the tenant without subject or participants');

  -- Bob sees no row, so the definer answers him nothing.
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect((select count(*) from discovery_item_metadata(array[v_alice_item, v_coll_item])), 0,
    'Bob gets nothing from the definer');
  reset role;
  perform pg_temp.expect(
    (select count(*) from unnest(array['subject', 'participants', 'drive_path']) c
      where has_column_privilege('authenticated', 'public.source_items', c, 'SELECT')
         or has_column_privilege('anon', 'public.source_items', c, 'SELECT')), 0,
    'no API role holds SELECT on a walled column');
  if has_function_privilege('anon', 'discovery_item_metadata(uuid[])', 'EXECUTE') then
    raise exception 'FAIL: anon may execute discovery_item_metadata';
  end if;
  set local role authenticated;
  raise notice 'PASS: subject, participants and drive_path are owner-only in the database';

  -- ── #262: the allowlist, before and after (R15, Q1 = B) ──────────────────
  -- Baselines (candidates/links/items/visibility/texts), read above.
  perform pg_temp.act_as(v_alice);
  v_snap_alice := pg_temp.snap();
  perform pg_temp.expect_text(v_snap_alice, '1/3/3/1/2', 'baseline: Alice');
  perform pg_temp.act_as(v_colleague);
  v_snap_coll := pg_temp.snap();
  perform pg_temp.expect_text(v_snap_coll, '2/5/5/2/4', 'baseline: the colleague');
  perform pg_temp.act_as(v_cco);
  v_snap_cco := pg_temp.snap();
  perform pg_temp.expect_text(v_snap_cco, '2/5/5/3/0', 'baseline: the CCO');

  -- 1. Alice withdraws. authenticated has no table privilege on
  -- mailbox_consents, so it goes through the RPC. Withdrawal deletes the mail
  -- her mailbox alone held (#461): her own item and its link are gone for
  -- everyone, the CCO included. The shared item stays through the colleague's
  -- mailbox. (Q1 = B still holds for every state that keeps the mail: see 5.)
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_withdraw();
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'Alice withdrew: she sees nothing');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), '2/4/4/2/4', 'Alice withdrew: the colleague loses her item and its link');
  perform pg_temp.expect((select count(*) from source_items where id = v_shared), 1,
    'the shared item stays through the colleague''s mailbox');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), '2/4/4/2/0', 'Alice withdrew: the CCO loses the deleted item and its link, and reads no text');
  reset role;
  perform pg_temp.expect((select count(*) from source_items where id = v_alice_item), 0,
    'the withdrawn mailbox''s sole-held item is deleted');
  perform pg_temp.expect((select count(*) from evidence_links where source_item_id = v_alice_item), 0,
    'the withdrawn mailbox''s link is deleted');
  set local role authenticated;
  raise notice 'PASS: withdrawal deletes a mailbox''s sole-held mail and keeps what a colleague''s mailbox holds';

  -- 2. Re-consent opens a fresh, empty source (a new consent row); the counts
  -- return once the worker has read the mailbox again.
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_grant();
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'Alice re-consented: her fresh source holds nothing yet');
  reset role;
  select id into v_src_alice from content_sources where tenant_id = v_tenant and address = 'alice@bank.example' and owner_user_id = v_alice;
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_alice_item, v_tenant, 'message', 'Heliotrope next steps', '2026-02-10', '<alice@t>', 'h2');
  insert into source_item_texts (source_item_id, body_text) values (v_alice_item, 'alice body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_shared, v_src_alice, 'a-1'), (v_alice_item, v_src_alice, 'a-2');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, gen_random_uuid(), v_groups);
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_alice, 'Alice re-read: her counts return');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_coll, 'Alice re-read: the colleague''s counts return');

  -- 3. The colleague is removed (the members route's effect, as the owner).
  -- Seat loss ends the consent, so the colleague's sole-held mail is deleted
  -- with Cobra, which rested on it alone.
  reset role;
  update users set company_id = null, company_role = null, status = 'suspended' where id = v_colleague;
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'removed: the colleague sees nothing');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), '1/2/2/1/2', 'removed: Alice loses the colleague''s item and its link');
  perform pg_temp.expect((select count(*) from source_items where id = v_coll_item), 0,
    'the removed member''s item is gone for Alice');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), '1/2/2/1/0', 'removed: the CCO loses the deleted mail and Cobra');
  reset role;
  perform pg_temp.expect((select count(*) from source_items where id in (v_coll_item, v_tentative, v_cobra_item)), 0,
    'the removed member''s sole-held items are deleted');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cobra), 0, 'Cobra goes with its last evidence');
  -- Restoring the seat alone does not restore the counts; the opt-in and a fresh read do.
  update users set company_id = v_bank, company_role = 'member', status = 'active' where id = v_colleague;
  perform pg_temp.on_deal(v_colleague);   -- the removal deleted the colleague's deal memberships; the re-seat restores one
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'a restored seat alone reads nothing');
  perform mailbox_consent_grant();
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'a fresh opt-in starts from an empty source');
  reset role;
  select id into v_src_coll from content_sources where tenant_id = v_tenant and address = 'colleague@bank.example' and owner_user_id = v_colleague;
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_coll_item,  v_tenant, 'message', 'Project Falcon: buyers',    '2026-02-18', '<coll@t>',  'h3'),
    (v_tentative,  v_tenant, 'message', 'Board pack',                '2026-02-19', '<tent@t>',  'h4'),
    (v_cobra_item, v_tenant, 'message', 'Project Cobra: engagement', '2025-11-04', '<cobra@t>', 'h5');
  insert into source_item_texts (source_item_id, body_text) values
    (v_coll_item, 'colleague body'), (v_tentative, 'tentative body'), (v_cobra_item, 'cobra body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_shared, v_src_coll, 'c-1'), (v_coll_item, v_src_coll, 'c-2'), (v_tentative, v_src_coll, 'c-3'),
    (v_cobra_item, v_src_coll, 'c-4');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, gen_random_uuid(), v_groups);
  select id into v_cobra from deal_candidates where tenant_id = v_tenant and cluster_key = 'codename:cobra';
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence)
    values (v_falcon, v_tentative, 'codename', 'tentative', 0.4);
  perform discovery_refresh_candidate_visibility(v_falcon);
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_coll, 'a fresh opt-in and read restore the colleague''s counts');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_cco, 'and the CCO''s');
  raise notice 'PASS: removal deletes a member''s sole-held mail; only a fresh opt-in and read restore it';

  -- 4. Only the firm's active, internal CCO is the control room. A CCO of a
  -- second bank in the tenant, the firm's CCO once suspended, and once
  -- external each see nothing. (Setting status or is_external fires the
  -- seat-loss trigger; the CCO holds no consent, so it writes nothing.)
  reset role;
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_cco2, 'dd-cco2@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance'));
  update users set status = 'active', is_external = false, firm_role = 'cco' where id = v_cco2;
  insert into companies (id, tenant_id, name, type) values (v_bank2, v_tenant, 'DD Other Bank', 'bank');
  update users set company_id = v_bank2, company_role = 'director' where id = v_cco2;
  set local role authenticated;
  perform pg_temp.act_as(v_cco2);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'a CCO of a second bank is not the control room');
  reset role;
  update users set status = 'suspended' where id = v_cco;
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'a suspended CCO is not the control room');
  reset role;
  update users set status = 'active', is_external = true where id = v_cco;
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'an external CCO is not the control room');
  reset role;
  update users set is_external = false where id = v_cco;
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_cco, 'the restored firm CCO is the control room again');
  raise notice 'PASS: only the firm''s active, internal CCO is the control room';

  -- 5. Disabling the reader keeps Q1 = B: nothing is allowlisted, so members
  -- see nothing, and the firm's CCO keeps the metadata (any registration status).
  reset role;
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_tenant;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'reader disabled: Alice sees nothing');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'reader disabled: the colleague sees nothing');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_cco, 'reader disabled: the CCO keeps the metadata and reads no text');
  reset role;
  update graph_reader_registrations set status = 'active' where tenant_id = v_tenant;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_alice, 'reader re-enabled: Alice''s counts return');
  raise notice 'PASS: disabling the reader stops member reads and keeps the CCO''s metadata';

  -- 6. A registered SharePoint site (R23). The admin who registers it owns its
  -- items and reads their text; a colleague and the CCO see the item as
  -- metadata through its Falcon link; nobody's own mail backs Falcon through
  -- the site, so it never grants candidate visibility. The content source's
  -- owner_user_id (Bob), as #243's configuration might set it, is ignored.
  reset role;
  insert into content_sources (id, tenant_id, kind, address, owner_user_id)
    values (v_src_site, v_tenant, 'sharepoint_site', v_site, v_bob);
  insert into source_items (id, tenant_id, kind, subject, sent_at, content_hash)
    values (v_site_item, v_tenant, 'document', 'Falcon data room index', '2026-02-20', 'h7');
  insert into source_item_texts (source_item_id, body_text) values (v_site_item, 'site body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_site_item, v_src_site, 's-1');
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence)
    values (v_falcon, v_site_item, 'codename', 'firm', 0.9);
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_alice, 'site not registered: Alice''s counts are unchanged');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_coll, 'site not registered: the colleague''s counts are unchanged');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'site not registered: the admin sees nothing');

  perform pg_temp.act_as(v_admin);
  perform site_register(v_site);
  v_snap_admin := pg_temp.snap();
  perform pg_temp.expect_text(v_snap_admin, '0/0/1/0/1', 'registered: the admin sees the item and its text, no link or candidate');
  perform pg_temp.expect((select count(*) from source_items where id = v_site_item), 1, 'registered: the admin owns the site item');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_site_item), 1,
    'registered: the admin reads its text');
  perform pg_temp.expect((select count(*) from evidence_links where source_item_id = v_site_item), 0,
    'registered: the admin sees no link (no candidate is visible to the admin)');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_falcon), 0, 'registered: the admin sees no Falcon');
  perform pg_temp.act_as(v_cco);
  v_snap_reg := pg_temp.snap();
  perform pg_temp.expect_text(v_snap_reg, '2/6/6/3/0', 'registered: the CCO sees the item and its link, and no text');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_site_item), 0, 'registered: the CCO reads no site text');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), '2/6/6/2/4', 'registered: the colleague sees the item and its link as metadata');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_site_item), 0,
    'registered: the colleague reads no site text');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), '1/4/4/1/2', 'registered: Alice, a Falcon viewer, sees the item and its link');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'registered: Bob, the configured owner_user_id, sees nothing');

  -- After the admin unregisters: the members lose the item and link, the CCO keeps the metadata (Q1 = B).
  perform pg_temp.act_as(v_admin);
  perform site_unregister(v_site);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'unregistered: the admin sees nothing');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_coll, 'unregistered: the colleague loses the item and its link');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_alice, 'unregistered: Alice loses the item and its link');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_reg, 'unregistered: the CCO keeps the item and link and reads no text');

  -- Re-registration restores the counts.
  perform pg_temp.act_as(v_admin);
  perform site_register(v_site);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_admin, 're-registered: the admin''s counts return');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), '2/6/6/2/4', 're-registered: the colleague''s counts return');

  -- The admin loses the role (C10): the registration row stays open, but a site
  -- is open only while its registrant is still the firm's admin, so it closes
  -- for everyone at once: members lose the item and its link, the CCO keeps the
  -- metadata (Q1 = B), and the former admin reads nothing.
  reset role;
  update users set firm_role = null where id = v_admin;
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'no longer an admin: the former admin sees nothing');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_coll, 'no longer an admin: the colleague loses the item and its link');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_alice, 'no longer an admin: Alice loses the item and its link');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_reg, 'no longer an admin: the CCO keeps the metadata and reads no text');
  reset role;
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_tenant and address = v_site), 0,
    'no longer an admin: the site is closed');
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_tenant and address = v_site
    and unregistered_at is null), 1, 'no longer an admin: the registration row itself stays open');
  update users set firm_role = 'admin' where id = v_admin;
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.snap(), v_snap_admin, 'the admin role restored: their counts return');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.snap(), '2/6/6/2/4', 'the admin role restored: the colleague''s counts return');
  raise notice 'PASS: a registered site follows the same RLS as mail; unregistering removes it from members and keeps the CCO''s metadata';

  -- Nobody signed in reaches the worker's tables or writes anything.
  perform pg_temp.act_as(v_cco);
  v_blocked := false;
  begin perform 1 from content_sources limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read content_sources'; end if;
  v_blocked := false;
  begin perform 1 from graph_reader_registrations limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read graph_reader_registrations'; end if;
  v_blocked := false;
  begin perform 1 from routing_ledger limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read routing_ledger'; end if;
  v_blocked := false;
  begin perform 1 from source_item_sources limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read source_item_sources'; end if;
  v_blocked := false;
  begin
    insert into deal_candidates (tenant_id, cluster_key, proposed_name) values (v_tenant, 'codename:forged', 'Forged');
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated inserted a candidate'; end if;
  v_blocked := false;
  begin
    update deal_candidates set proposed_name = 'Renamed' where id = v_falcon;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated updated a candidate'; end if;
  v_blocked := false;
  begin perform discovery_upsert_candidates(v_tenant, gen_random_uuid(), v_groups);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran the worker RPC'; end if;
  v_blocked := false;
  begin perform discovery_refresh_candidate_visibility(v_falcon);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran the visibility refresh'; end if;

  reset role;
  set local role anon;
  v_blocked := false;
  begin perform 1 from deal_candidates limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon read deal_candidates'; end if;
  reset role;

  raise notice 'PASS: discovery RLS: Alice sees Falcon, Bob nothing, the CCO everything, the admin nothing, and a colleague''s item as metadata only';
end $$;

-- ── An archived orphan source (#262, PR #300 round 3, A1) ────────────────────
-- An address is reassigned while the earlier holder's source still holds items.
-- The next holder's opt-in archives that source instead of adopting it, so the
-- items and their text reach nobody: not the newcomer, not the firm admin, and
-- not the CCO's text (the CCO keeps metadata, Q1 = B). Only a firm admin's merge
-- hands them to the member who now holds the address.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();
  v_new uuid := gen_random_uuid();  v_adm uuid := gen_random_uuid();  v_cco uuid := gen_random_uuid();
  v_old uuid;  v_fresh uuid;  v_item uuid := gen_random_uuid();  v_cand uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_new, 'a1rls-new@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_adm, 'a1rls-adm@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco, 'a1rls-cco@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'compliance'));
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'A1 RLS Bank', 'bank');
  update users set status = 'active', is_external = false, company_id = v_b, company_role = 'director' where id = v_adm;
  update users set status = 'active', is_external = false, company_id = v_b, company_role = 'member' where id in (v_new, v_cco);
  update users set firm_role = 'admin' where id = v_adm;
  update users set firm_role = 'cco' where id = v_cco;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_b);
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status, accepted_at, accepted_user_id)
  values (v_t, 'a1rls-new@bank.example', v_adm, v_b, 'member', 'accepted', 'sent', now(), v_new);
  perform pg_temp.on_deal(v_new);

  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'a1rls-new@bank.example', null, 'microsoft') returning id into v_old;
  insert into source_items (id, tenant_id, kind, subject, internet_message_id, content_hash)
  values (v_item, v_t, 'message', 'Project Falcon: earlier holder', '<a1rls@t>', 'h');
  insert into source_item_texts (source_item_id, body_text) values (v_item, 'the earlier holder''s text');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_item, v_old, 'p1');
  insert into deal_candidates (tenant_id, cluster_key, proposed_name) values (v_t, 'a1rls', 'Falcon') returning id into v_cand;
  insert into evidence_links (candidate_id, source_item_id, method, route_tier) values (v_cand, v_item, 'codename', 'firm');

  set local role authenticated;
  perform pg_temp.act_as(v_new);
  v_fresh := (mailbox_consent_grant()->>'sourceId')::uuid;
  reset role;
  perform pg_temp.expect((select count(*) from content_sources where id = v_old and archived_at is not null and status = 'paused'), 1,
    'a1 rls: the orphan was archived');

  -- Before the merge.
  set local role authenticated;
  perform pg_temp.act_as(v_new);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'a1 rls: the newcomer sees nothing of the earlier holder''s mail');
  perform pg_temp.act_as(v_adm);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'a1 rls: the firm admin sees none of it either');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from source_item_texts), 0, 'a1 rls: the CCO never reads an archived item''s text');
  reset role;

  -- After the firm admin's merge the member's source holds it. The RPC checks deal_discovery itself.
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  perform discovery_unify_mailbox_sources(v_old, v_fresh);
  perform pg_temp.act_as(v_new);
  perform pg_temp.expect((select count(*) from source_items), 1, 'a1 rls: after the merge the member sees the item');
  perform pg_temp.expect((select count(*) from source_item_texts), 1, 'a1 rls: and reads its text');
  perform pg_temp.expect((select count(*) from deal_candidates), 1, 'a1 rls: and sees the candidate it backs');
  perform pg_temp.act_as(v_adm);
  perform pg_temp.expect((select count(*) from source_item_texts), 0, 'a1 rls: the admin still reads no text');
  reset role;
  raise notice 'PASS: an archived orphan source exposes nothing to the next holder until a firm admin merges it';
end $$;

-- ── A team inbox (#581, phase 10): its members, and only they, see what it holds ─────────────
--
--   Admin   the firm admin who connects deals@ and adds and removes people (reads no content)
--   Storm   a non-admin MD, the member
--   Bob     not a member; holds a personal copy of one message of the shared candidate
--   CCO     the control room: keeps the metadata, reads no text
--   Other   a colleague with nothing, then a member who is promoted to firm admin
--
--   Kestrel   team1 and team2 (team inbox only), shared (team inbox and Bob's mailbox), bob1 (Bob's mailbox only)
--   Osprey    osprey1 (team inbox only)
--
-- Each persona is read as snap_ms(): candidates/links/items/visibility rows/texts/milestones.
create function pg_temp.snap_ms()
returns text language sql as $$
  select pg_temp.snap() || '/' || (select count(*) from milestone_events)::text;
$$;
grant execute on function pg_temp.snap_ms() to authenticated;

do $$
declare
  v_t       uuid := gen_random_uuid();
  v_b       uuid := gen_random_uuid();
  v_admin   uuid := gen_random_uuid();
  v_storm   uuid := gen_random_uuid();
  v_bob     uuid := gen_random_uuid();
  v_cco     uuid := gen_random_uuid();
  v_other   uuid := gen_random_uuid();
  v_inv_bob uuid := gen_random_uuid();
  v_tm      uuid;
  v_src_tm  uuid;
  v_src_bob uuid;
  v_team1   uuid := gen_random_uuid();
  v_team2   uuid := gen_random_uuid();
  v_shared  uuid := gen_random_uuid();
  v_bob1    uuid := gen_random_uuid();
  v_osprey1 uuid := gen_random_uuid();
  v_kestrel uuid;
  v_osprey  uuid;
  v_out     jsonb;
  v_groups  jsonb;
  v_member  text := '2/5/5/2/4/2';   -- what a member sees
  v_none    text := '0/0/0/0/0/0';
  v_bobs    text := '1/2/2/1/2/1';   -- what Bob sees: his own two messages, whoever else holds them
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'tv-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_storm, 'tv-storm@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_bob,   'tv-bob@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_cco,   'tv-cco@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_other, 'tv-other@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id = v_t;
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'TV Bank', 'bank');
  -- The director first: company_has_director refuses a bank of members only.
  update users set company_id = v_b, company_role = 'director', firm_role = 'admin' where id = v_admin;
  update users set company_id = v_b, company_role = 'member' where tenant_id = v_t and id <> v_admin;
  update users set firm_role = 'cco' where id = v_cco;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'tv.example', 'dwd-reader@proj-11.iam.gserviceaccount.com', '623456789012345678',
     'dir-reader@proj-11.iam.gserviceaccount.com', 'conductia-ingest@tv.example', v_b, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_inv_bob, v_t, 'bob@tv.example', v_admin, v_b, 'member', 'accepted', 'sent', now(), v_bob);
  perform pg_temp.on_deal(v_bob);

  -- Bob opts in; the admin connects deals@ (no member yet).
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('deals@tv.example', 1);
  reset role;
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_tm := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  select id into v_src_bob from content_sources where tenant_id = v_t and owner_user_id = v_bob;
  if v_tm is null or v_src_tm is null or v_src_bob is null then
    raise exception 'FAIL: the team inbox or Bob''s mailbox source was not created';
  end if;
  -- The worker's Directory check confirms the address.
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-tv');

  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_team1,   v_t, 'message', 'Project Kestrel: mandate',  '2026-02-03', '<tv-team1@t>',   'tv1'),
    (v_team2,   v_t, 'message', 'Project Kestrel: buyers',   '2026-02-05', '<tv-team2@t>',   'tv2'),
    (v_shared,  v_t, 'message', 'Project Kestrel: kickoff',  '2026-02-07', '<tv-shared@t>',  'tv3'),
    (v_bob1,    v_t, 'message', 'Project Kestrel: Bob note', '2026-02-09', '<tv-bob1@t>',    'tv4'),
    (v_osprey1, v_t, 'message', 'Project Osprey: engagement', '2026-02-11', '<tv-osprey1@t>', 'tv5');
  insert into source_item_texts (source_item_id, body_text) values
    (v_team1, 'team1 body'), (v_team2, 'team2 body'), (v_shared, 'shared body'),
    (v_bob1, 'bob1 body'), (v_osprey1, 'osprey1 body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_team1, v_src_tm, 't-1'), (v_team2, v_src_tm, 't-2'), (v_shared, v_src_tm, 't-3'), (v_osprey1, v_src_tm, 't-4'),
    (v_shared, v_src_bob, 'b-1'), (v_bob1, v_src_bob, 'b-2');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_groups := jsonb_build_array(
    jsonb_build_object(
      'clusterKey', 'codename:kestrel', 'proposedName', 'Project Kestrel', 'codenameGuess', 'Project Kestrel',
      'parties', '[]'::jsonb, 'firstSeenAt', '2026-02-03T00:00:00Z', 'lastSeenAt', '2026-02-09T00:00:00Z', 'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_team1,  'method', 'codename', 'confidence', 0.95),
        jsonb_build_object('sourceItemId', v_team2,  'method', 'codename', 'confidence', 0.95),
        jsonb_build_object('sourceItemId', v_shared, 'method', 'codename', 'confidence', 0.95),
        jsonb_build_object('sourceItemId', v_bob1,   'method', 'codename', 'confidence', 0.95))),
    jsonb_build_object(
      'clusterKey', 'codename:osprey', 'proposedName', 'Project Osprey', 'codenameGuess', 'Project Osprey',
      'parties', '[]'::jsonb, 'firstSeenAt', '2026-02-11T00:00:00Z', 'lastSeenAt', '2026-02-11T00:00:00Z', 'confidence', 0.95,
      'links', jsonb_build_array(
        jsonb_build_object('sourceItemId', v_osprey1, 'method', 'codename', 'confidence', 0.95))));
  perform discovery_upsert_candidates(v_t, gen_random_uuid(), v_groups);
  select id into v_kestrel from deal_candidates where tenant_id = v_t and cluster_key = 'codename:kestrel';
  select id into v_osprey  from deal_candidates where tenant_id = v_t and cluster_key = 'codename:osprey';
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_kestrel), 4, 'Kestrel has four firm links');
  -- One extracted event on a team-only message and one on Bob's own.
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id) values
    (v_t, v_team1, 'kickoff_held', '2026-02-03', 0, 10, 0.9, 'v1:m', gen_random_uuid()),
    (v_t, v_bob1,  'kickoff_held', '2026-02-09', 0, 10, 0.9, 'v1:m', gen_random_uuid());
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id in (v_kestrel, v_osprey)), 1,
    'before any member the only visibility row is Bob''s, for Kestrel');

  -- ── 1. No member yet: nobody but Bob (his own two messages) and the CCO (metadata) sees anything ──
  set local role authenticated;
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_bobs,
    'no member: Bob sees Kestrel and only his own two messages, their links and their events, no team message');
  if app_owns_item(v_team1, v_bob) or app_can_see_item(v_team1, v_bob) or app_can_see_item(v_team2, v_bob)
     or app_can_see_item(v_osprey1, v_bob) or app_can_see_candidate(v_osprey, v_bob) then
    raise exception 'FAIL: Bob, who is not a member, reaches a team message or the team-only candidate';
  end if;
  if not app_can_see_item(v_shared, v_bob) or not app_owns_item(v_shared, v_bob) then
    raise exception 'FAIL: Bob lost his own copy of the shared message';
  end if;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'no member: Storm sees nothing yet');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'the firm admin sees nothing');
  perform pg_temp.act_as(v_other);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'a colleague with nothing sees nothing');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap_ms(), '2/5/5/1/0/2',
    'the CCO sees both candidates, every link, item and event as metadata, and no text');

  -- ── 2. The admin adds Storm: the team's rows and texts appear for Storm and for no one else ──
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_member,
    'added: Storm sees both candidates, five links and items, reads the four team texts, and both events');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id in (v_team1, v_team2, v_shared, v_osprey1)), 4,
    'added: Storm reads the team messages'' text');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_bob1), 0,
    'added: but not Bob''s own message, which he sees as metadata like any colleague');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_bobs, 'added: Bob, not a member, still sees no team message, link or event');
  perform pg_temp.act_as(v_other);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'added: nor does another colleague');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'added: nor does the firm admin');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap_ms(), '2/5/5/3/0/2', 'added: the CCO sees the new visibility rows and still reads no text');

  -- ── 3. How old the last check is changes nothing anyone sees (review round 2, M-A) ──
  reset role;
  update team_mailboxes set verified_at = now() - interval '66 minutes' where id = v_tm;
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_member, 'a 66 minute old check: Storm sees what he saw');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_bobs, 'a 66 minute old check: Bob sees what he saw');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap_ms(), '2/5/5/3/0/2', 'a 66 minute old check: the CCO sees what it saw');

  -- A definitive refusal takes the inbox off the allowlist: members see nothing of it until it is confirmed again.
  reset role;
  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'group', null);
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'refused: Storm sees nothing of the inbox');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_bobs, 'refused: Bob sees what he saw');
  reset role;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-tv');
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_member, 'confirmed again: Storm''s candidates are back with no new event');

  -- ── 4. The admin removes Storm: nothing of the inbox is left for him ──
  perform pg_temp.act_as(v_admin);
  perform discovery_remove_team_mailbox_member(v_tm, v_storm);
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'removed: Storm sees nothing');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap_ms(), '2/5/5/1/0/2', 'removed: the CCO''s visibility rows drop to Bob''s');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_bobs, 'removed: Bob sees what he saw');

  -- ── 5. A seat lost ends the membership, and a re-seat does not revive it ──
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_storm);
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_member, 're-added: Storm sees the inbox again');
  reset role;
  update users set status = 'suspended' where id = v_storm;
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'seat lost: Storm sees nothing');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap_ms(), '2/5/5/1/0/2', 'seat lost: his visibility rows are gone');
  reset role;
  update users set status = 'active' where id = v_storm;
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 're-seated: the closed membership is not revived');

  -- ── 6. A member promoted to firm admin reads nothing; demoted, the open membership reads again ──
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_other);
  perform pg_temp.act_as(v_other);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_member, 'another member sees the inbox');
  reset role;
  update users set firm_role = 'admin' where id = v_other;
  set local role authenticated;
  perform pg_temp.act_as(v_other);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_none, 'promoted to firm admin: nothing, at once, though their visibility rows are still there');
  reset role;
  update users set firm_role = null where id = v_other;
  set local role authenticated;
  perform pg_temp.act_as(v_other);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_member, 'demoted: the open membership reads again');
  perform pg_temp.act_as(v_bob);
  perform pg_temp.expect_text(pg_temp.snap_ms(), v_bobs, 'throughout: Bob sees what he saw');
  reset role;

  raise notice 'PASS: a team inbox reaches its members and nobody else; a non-member with personal evidence on the same candidate sees no team item, link or event';
end $$;

rollback;
