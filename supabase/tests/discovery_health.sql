-- Deal discovery ingestion health (20260925150000_discovery_health.sql): the
-- firm admin sees counts and sync state, never content, and nobody outside
-- the admin and the control room sees even that.
--
--   Admin      a firm admin: health yes, candidates / items / text no (Q19)
--   CCO        the control room: health yes (and candidates, per phase 3)
--   Analyst    a banker with no firm role: health denied (42501)
--   Outsider   another tenant's admin: health of its own tenant only
--
-- Also covers the ledger's skipped-document shape, its thread ids (unrouted
-- messages only), document identity, and the discovery definer functions
-- authenticated may execute (the twenty-one in DISCOVERY_AUTHENTICATED_DEFINERS in
-- scripts/preflight-db.ts, eight of them the demo path's corrections, split,
-- reassign and dismiss, plus #581's team-inbox ones): each exists with that exact signature and
-- reads auth.uid(), and no other discovery definer function is open to it.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_health.sql
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
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
end;
$$;

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user, 'role', 'authenticated')::text, true);
$$;
-- New functions no longer grant PUBLIC EXECUTE by default (#233); the
-- helpers above run as authenticated.
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  v_tenant    uuid := gen_random_uuid();
  v_other     uuid := gen_random_uuid();
  v_admin     uuid := gen_random_uuid();
  v_cco       uuid := gen_random_uuid();
  v_analyst   uuid := gen_random_uuid();
  v_outsider  uuid := gen_random_uuid();
  v_bank       uuid := gen_random_uuid();
  v_bank_other uuid := gen_random_uuid();
  v_src_mail  uuid := gen_random_uuid();
  v_src_site  uuid := gen_random_uuid();
  v_src_idle  uuid := gen_random_uuid();
  v_item      uuid := gen_random_uuid();
  v_doc       uuid := gen_random_uuid();
  v_run       uuid := gen_random_uuid();
  v_health    jsonb;
  v_source    jsonb;
  v_blocked   boolean;
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin,    'dh-admin@example.test',    jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_cco,      'dh-cco@example.test',      jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance')),
    (v_analyst,  'dh-analyst@example.test',  jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_outsider, 'dh-outsider@example.test', jsonb_build_object('tenant_id', v_other, 'department', 'admin'));
  update users set status = 'active', is_external = false where id in (v_admin, v_cco, v_analyst, v_outsider);
  update users set firm_role = 'admin' where id in (v_admin, v_outsider);
  update users set firm_role = 'cco' where id = v_cco;

  -- #262 (C5): the health view is for an admin or CCO seated in the firm the
  -- registration names, so each tenant gets a bank, its registration names it,
  -- and the admin and CCO are seated there (company_role 'director' first: a
  -- company may not hold a member without one). The analyst stays unseated and
  -- denied on role alone. Before #262 the admin and CCO were unseated and the
  -- other tenant had no registration at all.
  insert into companies (id, tenant_id, name, type) values
    (v_bank, v_tenant, 'DH Bank', 'bank'),
    (v_bank_other, v_other, 'DH Other Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id = v_admin;
  update users set company_id = v_bank, company_role = 'member' where id = v_cco;
  update users set company_id = v_bank_other, company_role = 'director' where id = v_outsider;

  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, consented_at, firm_company_id) values
    (v_tenant, '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'active', '2026-09-20T10:00:00Z', v_bank),
    (v_other, '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'pending', null, v_bank_other);
  insert into content_sources
    (id, tenant_id, kind, address, owner_user_id, delta_checkpoint, backfill_completed_at, last_synced_at, last_error, last_error_at)
  values
    (v_src_mail, v_tenant, 'mailbox', 'storm.duncan@bank.example', v_analyst,
     '{"v":1,"kind":"graph-mail","folders":[]}', '2026-09-21T09:00:00Z', '2026-09-25T09:00:00Z', null, null),
    (v_src_site, v_tenant, 'sharepoint_site', 'bank.sharepoint.com,site,web', null,
     '{"v":1,"kind":"graph-drive","siteId":"s","drives":[]}', null, null, 'Graph 429 TooManyRequests (throttled)', '2026-09-25T09:05:00Z'),
    (v_src_idle, v_tenant, 'mailbox', 'alex.chen@bank.example', v_analyst, null, null, null, null, null);

  insert into source_items (id, tenant_id, kind, subject, participants, sent_at, internet_message_id, content_hash) values
    (v_item, v_tenant, 'message', 'Project Falcon: kickoff',
     '[{"role":"from","address":"storm.duncan@bank.example","name":"Storm"}]', '2026-02-03', '<falcon@t>', 'h1');
  insert into source_items (id, tenant_id, kind, subject, drive_item_key, drive_path, content_hash) values
    (v_doc, v_tenant, 'document', 'Falcon CIM.docx', 'drive-1:item-1', '/Deals/Falcon CIM.docx', 'h2');
  insert into source_item_texts (source_item_id, body_text) values (v_item, 'Project Falcon kicks off'), (v_doc, 'CIM text');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_item, v_src_mail, 'm-1'), (v_doc, v_src_site, 'item-1');

  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id) values
    (v_src_mail, 'm-1', 'h1', 'routed', 'codename', 0.95, v_run),
    (v_src_mail, 'm-3', 'h4', 'unrouted', null, null, v_run),
    (v_src_site, 'item-1', 'h2', 'routed', 'codename', 0.9, v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, run_id) values
    (v_src_site, 'item-2', 'h5', 'skipped', 'image_only', v_run),
    (v_src_site, 'item-3', 'h6', 'skipped', 'extraction_timeout', v_run);
  -- A reply read before the message that routes its thread: unrouted, with
  -- its thread ids and no text.
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, conversation_id,
                              internet_message_id, run_id) values
    (v_src_mail, 'm-2', 'h3', 'unrouted', 'conv-falcon', '<falcon-002@bank.example>', v_run);

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_upsert_candidates(v_tenant, v_run, jsonb_build_array(jsonb_build_object(
    'clusterKey', 'codename:falcon', 'proposedName', 'Project Falcon', 'codenameGuess', 'Project Falcon',
    'parties', jsonb_build_array(jsonb_build_object('name', 'Heliotrope', 'domain', 'heliotrope.example')),
    'firstSeenAt', '2026-02-03T00:00:00Z', 'lastSeenAt', '2026-02-03T00:00:00Z', 'confidence', 0.95,
    'links', jsonb_build_array(jsonb_build_object('sourceItemId', v_item, 'method', 'codename', 'confidence', 0.95)))));

  -- ── The ledger's shape ───────────────────────────────────────────────────
  v_blocked := false;
  begin
    insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id)
      values (v_src_site, 'item-9', 'h9', 'skipped', v_run);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a skipped ledger row without a reason was accepted'; end if;
  v_blocked := false;
  begin
    insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, run_id)
      values (v_src_site, 'item-9', 'h9', 'unrouted', 'image_only', v_run);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unrouted ledger row with a skip reason was accepted'; end if;
  v_blocked := false;
  begin
    insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, run_id)
      values (v_src_site, 'item-9', 'h9', 'skipped', 'too_blurry', v_run);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown skip reason was accepted'; end if;
  v_blocked := false;
  begin
    insert into source_items (tenant_id, kind, subject, drive_item_key, content_hash)
      values (v_tenant, 'document', 'Falcon CIM.docx', 'drive-1:item-1', 'h2');
  exception when unique_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a document was stored twice under one drive item'; end if;
  v_blocked := false;
  begin
    insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence,
                                conversation_id, run_id)
      values (v_src_mail, 'm-9', 'h9', 'routed', 'codename', 0.9, 'conv-falcon', v_run);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a routed ledger row with thread ids was accepted'; end if;
  v_blocked := false;
  begin
    insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason,
                                internet_message_id, run_id)
      values (v_src_site, 'item-9', 'h9', 'skipped', 'image_only', '<x@bank.example>', v_run);
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a skipped ledger row with thread ids was accepted'; end if;
  raise notice 'PASS: skipped ledger rows carry exactly one known reason; thread ids only on unrouted rows; a drive item is one document';

  -- ── The admin: counts and sync state, and no content anywhere ────────────
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_health := discovery_ingestion_health();

  perform pg_temp.expect_text(v_health #>> '{registration,status}', 'active', 'the admin sees the registration status');
  perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 3, 'the admin sees the three sources');
  perform pg_temp.expect((v_health #>> '{totals,itemsLedgered}')::bigint, 6, 'six items ledgered');
  perform pg_temp.expect((v_health #>> '{totals,itemsRouted}')::bigint, 2, 'two routed');
  perform pg_temp.expect((v_health #>> '{totals,itemsSkipped}')::bigint, 2, 'two skipped');
  perform pg_temp.expect((v_health #>> '{totals,itemsStored}')::bigint, 2, 'two stored');
  perform pg_temp.expect((v_health #>> '{totals,candidatesProposed}')::bigint, 1, 'one proposed candidate, as a count');

  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_mail::text;
  perform pg_temp.expect_text(v_source->>'checkpointState', 'incremental', 'a finished backfill reads changes only');
  perform pg_temp.expect((v_source->>'itemsLedgered')::bigint, 3, 'the mailbox ledgered three');
  perform pg_temp.expect((v_source->>'itemsRouted')::bigint, 1, 'the mailbox routed one');
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_site::text;
  perform pg_temp.expect_text(v_source->>'checkpointState', 'backfilling', 'a started backfill is part-way');
  perform pg_temp.expect_text(v_source->>'lastError', 'Graph 429 TooManyRequests (throttled)', 'the last error is reported');
  perform pg_temp.expect_text(v_source->>'ownerAssigned', 'false', 'an unowned site says so');
  perform pg_temp.expect((v_source->>'itemsSkipped')::bigint, 2, 'the site skipped two');
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_idle::text;
  perform pg_temp.expect_text(v_source->>'checkpointState', 'not_started', 'a source never read has not started');

  -- The payload carries no subject, text, participant, party, codename or
  -- checkpoint link.
  if v_health::text ~* '(falcon|heliotrope|kicks off|cim text|graph-mail|graph-drive|"name"|"participants")' then
    raise exception 'FAIL: the health payload leaks content: %', v_health::text;
  end if;
  if exists (select 1 from jsonb_array_elements(v_health->'sources') s
             where s ? 'deltaCheckpoint' or s ? 'ownerUserId' or s ? 'subject') then
    raise exception 'FAIL: the health payload carries a raw checkpoint or an owner id';
  end if;

  perform pg_temp.expect((select count(*) from deal_candidates), 0, 'the admin reads no candidate');
  perform pg_temp.expect((select count(*) from evidence_links), 0, 'the admin reads no link');
  perform pg_temp.expect((select count(*) from source_items), 0, 'the admin reads no item');
  perform pg_temp.expect((select count(*) from source_item_texts), 0, 'the admin reads no text');
  perform pg_temp.expect((select count(*) from candidate_visibility), 0, 'the admin reads no visibility row');
  v_blocked := false;
  begin perform 1 from content_sources limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: the admin read content_sources directly'; end if;
  v_blocked := false;
  begin perform 1 from routing_ledger limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: the admin read routing_ledger directly'; end if;
  raise notice 'PASS: the firm admin gets counts and sync state, and no content';

  -- ── The control room gets the same view ──────────────────────────────────
  perform pg_temp.act_as(v_cco);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 3, 'the CCO sees the three sources');

  -- ── An analyst is denied ─────────────────────────────────────────────────
  perform pg_temp.act_as(v_analyst);
  v_blocked := false;
  begin perform discovery_ingestion_health();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an analyst read ingestion health'; end if;

  -- ── Another tenant's admin sees its own (empty) tenant only ──────────────
  perform pg_temp.act_as(v_outsider);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 0, 'another tenant''s admin sees none of these sources');
  perform pg_temp.expect_text(v_health #>> '{registration,status}', 'pending',
    'another tenant''s admin sees their own registration, not this one');
  perform pg_temp.expect((v_health #>> '{totals,itemsStored}')::bigint, 0, 'another tenant''s admin counts nothing here');

  -- ── Nobody signed in ─────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  v_blocked := false;
  begin perform discovery_ingestion_health();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a session without a user read ingestion health'; end if;

  reset role;
  set local role anon;
  v_blocked := false;
  begin perform discovery_ingestion_health();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon ran the health function'; end if;
  v_blocked := false;
  begin perform 1 from pgboss.job limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon reached the job queue'; end if;
  reset role;

  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_blocked := false;
  begin perform 1 from pgboss.job limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a signed-in user reached the job queue'; end if;
  reset role;

  raise notice 'PASS: ingestion health: the admin and the CCO get counts only, an analyst and anon are denied, and the queue is out of reach';
end $$;

-- ── Google: registrations, group drift, guard reasons (#259, phase 5) ───────
-- A Google-only tenant: the admin and the CCO read the delegation status, the
-- group drift as counts, each source's provider, checkpoint age and waiting
-- reason, and "reconciliation: not_built". Nothing of the mail or the group's
-- members appears, and a paused source reports no stale reason. The gate is
-- #262's (C5): the caller must be seated in the firm the GOOGLE registration
-- names, so a Google-only tenant's admin and CCO are admitted, an unseated admin
-- and another bank's admin are not, and a tenant that names no firm gets the
-- no-registration shape. waitingFor is the database's own verdict, live, and
-- only then the worker's provider-group refusal.
do $$
declare
  v_t         uuid := gen_random_uuid();
  v_firm      uuid := gen_random_uuid();
  v_dir       uuid := gen_random_uuid();
  v_admin     uuid := gen_random_uuid();
  v_cco       uuid := gen_random_uuid();
  v_analyst   uuid := gen_random_uuid();
  v_u_wait    uuid := gen_random_uuid();
  v_u_ok      uuid := gen_random_uuid();
  v_unseated  uuid := gen_random_uuid();
  v_other_bk  uuid := gen_random_uuid();
  v_other_adm uuid := gen_random_uuid();
  v_nofirm_t  uuid := gen_random_uuid();
  v_nofirm_ad uuid := gen_random_uuid();
  v_src_wait  uuid := gen_random_uuid();
  v_src_ok    uuid := gen_random_uuid();
  v_src_pause uuid := gen_random_uuid();
  v_src_new   uuid := gen_random_uuid();
  v_src_arch  uuid := gen_random_uuid();
  v_item      uuid := gen_random_uuid();
  v_health    jsonb;
  v_source    jsonb;
  v_reg       jsonb;
  v_blocked   boolean;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,     'gh-dir@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,   'gh-admin@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,     'gh-cco@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_analyst, 'gh-analyst@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_u_wait,  'gh-uwait@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_u_ok,    'gh-uok@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_unseated, 'gh-unseated@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_other_adm, 'gh-otheradm@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_nofirm_ad, 'gh-nofirm@example.test', jsonb_build_object('tenant_id', v_nofirm_t, 'department', 'admin'));
  update users set status = 'active', is_external = false
   where id in (v_dir, v_admin, v_cco, v_analyst, v_u_wait, v_u_ok, v_unseated, v_other_adm, v_nofirm_ad);
  insert into companies (id, tenant_id, name, type) values (v_firm, v_t, 'GH Bank', 'bank');
  -- A second bank in the same tenant, which the Google registration does not name.
  insert into companies (id, tenant_id, name, type) values (v_other_bk, v_t, 'GH Other Bank', 'bank');
  update users set company_id = v_firm, company_role = 'director' where id = v_dir;
  update users set company_id = v_firm, company_role = 'member' where id in (v_admin, v_cco, v_analyst, v_u_wait, v_u_ok);
  update users set company_id = v_other_bk, company_role = 'director' where id = v_other_adm;
  update users set firm_role = 'admin' where id in (v_admin, v_unseated, v_other_adm, v_nofirm_ad);
  update users set firm_role = 'cco' where id = v_cco;

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email,
     allowlist_group, firm_company_id, status, consented_at, delegation_status, delegation_checked_at)
  values
    (v_t, 'gh.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@gh.example', v_firm, 'active',
     '2026-10-20T10:00:00Z', 'missing', '2026-10-21T09:00:00Z');

  -- Three Gmail mailboxes (waiting, reading, paused) and one never started.
  insert into content_sources
    (id, tenant_id, kind, provider, address, owner_user_id, status, delta_checkpoint,
     backfill_completed_at, checkpoint_updated_at, last_synced_at)
  values
    (v_src_wait, v_t, 'mailbox', 'google', 'waiting@gh.example', v_u_wait, 'active',
     '{"v":1,"kind":"gmail-mail","CANARYCHECKPOINT":"history-99"}', null, now() - interval '3 hours', null),
    (v_src_ok, v_t, 'mailbox', 'google', 'reading@gh.example', v_u_ok, 'active',
     '{"v":1,"kind":"gmail-mail","CANARYCHECKPOINT":"history-100"}', now() - interval '1 day',
     now() - interval '2 minutes', now() - interval '2 minutes'),
    (v_src_pause, v_t, 'mailbox', 'google', 'paused@gh.example', v_analyst, 'paused',
     '{"v":1,"kind":"gmail-mail","CANARYCHECKPOINT":"history-101"}', now() - interval '1 day',
     now() - interval '2 days', now() - interval '2 days'),
    (v_src_new, v_t, 'mailbox', 'google', 'new@gh.example', v_analyst, 'active', null, null, null, null);
  -- An orphaned source #262 archived: paused, renamed, closed for good.
  insert into content_sources (id, tenant_id, kind, provider, address, owner_user_id, status, archived_at, archived_from_address)
  values (v_src_arch, v_t, 'mailbox', 'google', 'gone@gh.example~abc', null, 'paused', now(), 'gone@gh.example');

  -- Two seated, consented mailboxes (the allowlist): one the worker found outside
  -- the provider group, one reading. new@ has no seat, so the database itself
  -- refuses it (no_invite), and the paused source's last reason is history: a
  -- paused source is never asked, so health must not report it as waiting.
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_t, 'waiting@gh.example', v_dir, v_firm, 'member', 'accepted', 'sent', now(), v_u_wait),
         (v_t, 'reading@gh.example', v_dir, v_firm, 'member', 'accepted', 'sent', now(), v_u_ok);
  -- A consent is the member's own act (auth.uid() = user_id), so each is written as that member.
  perform pg_temp.act_as(v_u_wait);
  insert into mailbox_consents (tenant_id, user_id, invite_id, address)
  select i.tenant_id, i.accepted_user_id, i.id, lower(i.email) from invites i
   where i.tenant_id = v_t and i.email = 'waiting@gh.example';
  perform pg_temp.act_as(v_u_ok);
  insert into mailbox_consents (tenant_id, user_id, invite_id, address)
  select i.tenant_id, i.accepted_user_id, i.id, lower(i.email) from invites i
   where i.tenant_id = v_t and i.email = 'reading@gh.example';
  insert into mailbox_guard_state (tenant_id, address, last_reason) values
    (v_t, 'waiting@gh.example', 'not_in_provider_group'),
    (v_t, 'reading@gh.example', 'no_consent'),   -- stale: the database admits it now
    (v_t, 'paused@gh.example', 'no_consent');

  -- Group drift with member addresses that must never leave the function.
  insert into mailbox_allowlist_drift (tenant_id, provider, status, missing_in_group, extra_in_group) values
    (v_t, 'google', 'drift', array['ghost.member@gh.example', 'second.ghost@gh.example'], array['stray.person@gh.example']);

  insert into source_items (id, tenant_id, kind, subject, participants, sent_at, internet_message_id, content_hash) values
    (v_item, v_t, 'message', 'CANARYSUBJECT Project Zephyr',
     '[{"role":"from","address":"reading@gh.example","name":"CANARYNAME"}]', '2026-10-01', '<zephyr@t>', 'zh1');
  insert into source_item_texts (source_item_id, body_text) values (v_item, 'CANARYBODY zephyr kicks off');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_item, v_src_ok, 'g-1');
  update content_sources set last_error = 'Google 403 forbidden', last_error_at = now() where id = v_src_wait;

  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_health := discovery_ingestion_health();

  -- Registrations: Google only, with its delegation status and time.
  perform pg_temp.expect(jsonb_array_length(v_health->'registrations'), 1, 'a Google-only tenant has one registration entry');
  v_reg := v_health #> '{registrations,0}';
  perform pg_temp.expect_text(v_reg->>'provider', 'google', 'the registration is Google''s');
  perform pg_temp.expect_text(v_reg->>'status', 'active', 'the Google registration status');
  perform pg_temp.expect_text(v_reg->>'delegationStatus', 'missing', 'the delegation status is reported');
  if (v_reg->>'delegationCheckedAt') is null or (v_reg->>'delegationCheckedAt')::timestamptz <> '2026-10-21T09:00:00Z'::timestamptz then
    raise exception 'FAIL: the delegation check time is not reported: %', v_reg->>'delegationCheckedAt';
  end if;
  -- The legacy Graph object stays null for this tenant, and the UI's old key is still present.
  if not (v_health ? 'registration') or v_health->'registration' <> 'null'::jsonb then
    raise exception 'FAIL: the Graph registration key must stay, null when there is none';
  end if;

  -- Group drift: counts, never addresses.
  perform pg_temp.expect(jsonb_array_length(v_health->'allowlist'), 1, 'one allowlist entry');
  perform pg_temp.expect_text(v_health #>> '{allowlist,0,provider}', 'google', 'the allowlist entry is Google''s');
  perform pg_temp.expect_text(v_health #>> '{allowlist,0,status}', 'drift', 'the drift status');
  perform pg_temp.expect((v_health #>> '{allowlist,0,missingCount}')::bigint, 2, 'two missing, as a count');
  perform pg_temp.expect((v_health #>> '{allowlist,0,extraCount}')::bigint, 1, 'one extra, as a count');

  -- Reconciliation is not built, and says so.
  perform pg_temp.expect_text(v_health->>'reconciliation', 'not_built', 'reconciliation is reported as not built');

  -- The admin may manage sources; the firm's CCO may not.
  perform pg_temp.expect_text(v_health->>'viewerCanManageSources', 'true', 'the firm admin may pause and resume');

  -- Sources: provider, checkpoint age, waiting reason.
  perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 5, 'five sources, the archived one included (develop lists it)');
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_arch::text;
  perform pg_temp.expect_text(v_source->>'archived', 'true', 'an archived source says so, so the panel offers no resume');
  if v_source->'waitingFor' <> 'null'::jsonb then raise exception 'FAIL: an archived source reported a waiting reason'; end if;
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_wait::text;
  perform pg_temp.expect_text(v_source->>'archived', 'false', 'a live source is not archived');
  perform pg_temp.expect_text(v_source->>'provider', 'google', 'the source names its provider');
  perform pg_temp.expect_text(v_source->>'waitingFor', 'not_in_provider_group', 'an active source reports the guard''s reason');
  if (v_source->>'checkpointAgeSeconds')::bigint not between 3 * 3600 - 60 and 3 * 3600 + 600 then
    raise exception 'FAIL: checkpoint age should be about three hours, got %', v_source->>'checkpointAgeSeconds';
  end if;
  perform pg_temp.expect_text(v_source->>'lastError', 'Google 403 forbidden', 'the last error is one content-free line');
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_ok::text;
  perform pg_temp.expect_text(v_source->>'waitingFor', null, 'a source the guard admits is not waiting, whatever stale state says');
  if v_source->'waitingFor' <> 'null'::jsonb then raise exception 'FAIL: waitingFor must be JSON null when admitted'; end if;
  if (v_source->>'checkpointAgeSeconds')::bigint > 600 then
    raise exception 'FAIL: a two-minute-old checkpoint reported as %', v_source->>'checkpointAgeSeconds';
  end if;
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_pause::text;
  perform pg_temp.expect_text(v_source->>'status', 'paused', 'a paused source says so');
  if v_source->'waitingFor' <> 'null'::jsonb then
    raise exception 'FAIL: a paused source reported a stale guard reason: %', v_source->>'waitingFor';
  end if;
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_new::text;
  if v_source->'checkpointAgeSeconds' <> 'null'::jsonb then
    raise exception 'FAIL: a source with no checkpoint reported an age';
  end if;
  perform pg_temp.expect_text(v_source->>'waitingFor', 'no_invite', 'the database''s own verdict is reported live, with no guard state at all');

  -- No content, checkpoint string, group member address or name leaves the function.
  if v_health::text ~* '(CANARY|zephyr|kicks off|ghost|stray|history-10|gmail-mail|"participants"|"subject"|deltaCheckpoint)' then
    raise exception 'FAIL: the Google health payload leaks content: %', v_health::text;
  end if;

  -- The CCO reads the same view but may not manage.
  perform pg_temp.act_as(v_cco);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 5, 'the CCO sees the five sources');
  perform pg_temp.expect_text(v_health->>'viewerCanManageSources', 'false', 'the CCO reads and does not manage');
  perform pg_temp.expect_text(v_health #>> '{registrations,0,delegationStatus}', 'missing', 'the CCO sees the delegation status');
  if v_health::text ~* '(CANARY|zephyr|ghost|stray)' then
    raise exception 'FAIL: the CCO payload leaks content';
  end if;

  -- An analyst is still denied, and so are an admin seated in no firm and an
  -- admin seated in another bank of the tenant (C5: the Google registration names one firm).
  perform pg_temp.act_as(v_analyst);
  v_blocked := false;
  begin perform discovery_ingestion_health();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an analyst read Google ingestion health'; end if;
  perform pg_temp.act_as(v_unseated);
  v_blocked := false;
  begin perform discovery_ingestion_health();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unseated admin read Google ingestion health'; end if;
  perform pg_temp.act_as(v_other_adm);
  v_blocked := false;
  begin perform discovery_ingestion_health();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: another bank''s admin read Google ingestion health'; end if;

  -- A tenant whose registrations name no firm: #262's no-registration shape, nothing of the tenant.
  perform pg_temp.act_as(v_nofirm_ad);
  v_health := discovery_ingestion_health();
  if v_health->'registration' <> 'null'::jsonb or jsonb_array_length(v_health->'sources') <> 0
     or jsonb_array_length(v_health->'registrations') <> 0 or (v_health #>> '{totals,sources}')::int <> 0 then
    raise exception 'FAIL: a tenant with no firm did not get the no-registration shape: %', v_health::text;
  end if;
  perform pg_temp.expect_text(v_health->>'viewerCanManageSources', 'false', 'no firm, nobody manages');
  -- Reader liveness: the no-registration shape has no reader line (the key is present, null).
  if not (v_health ? 'reader') or v_health->'reader' <> 'null'::jsonb then
    raise exception 'FAIL: the no-registration shape must carry reader null: %', v_health::text;
  end if;
  -- #263: the no-registration shape carries the exclusion keys empty, and nothing of any policy.
  if not (v_health ? 'policyVersion') or v_health->'policyVersion' <> 'null'::jsonb
     or (v_health #>> '{totals,itemsExcluded}')::int <> 0 then
    raise exception 'FAIL: the no-registration shape must carry policyVersion null and itemsExcluded 0: %', v_health::text;
  end if;

  -- The delegation status takes only its three words.
  reset role;
  v_blocked := false;
  begin update google_reader_registrations set delegation_status = 'clean' where tenant_id = v_t;
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown delegation status was accepted'; end if;

  raise notice 'PASS: Google health: delegation status, drift as counts, provider, checkpoint age and waiting reason, reconciliation not built, no content';
end $$;

-- ── Exclusion policy: the count and the version (#263, phase 4) ─────────────
-- discovery_ingestion_health() (20261003120000) adds itemsExcluded (per source and
-- in the totals) and policyVersion. The count covers EVERY policy version and
-- every policy reason, after-fetch included, and is a subset of itemsSkipped; the
-- version is the tenant's current one, a separate fact, never derived from the
-- count. Only those two numbers leave the function: no rule id, condition, thread
-- id or hash. Another tenant's policy never shows, and a tenant with no policy
-- reports null.
do $$
declare
  v_t         uuid := gen_random_uuid();
  v_firm      uuid := gen_random_uuid();
  v_dir       uuid := gen_random_uuid();
  v_admin     uuid := gen_random_uuid();
  v_o         uuid := gen_random_uuid();
  v_o_firm    uuid := gen_random_uuid();
  v_o_dir     uuid := gen_random_uuid();
  v_o_admin   uuid := gen_random_uuid();
  v_n         uuid := gen_random_uuid();
  v_n_firm    uuid := gen_random_uuid();
  v_n_dir     uuid := gen_random_uuid();
  v_n_admin   uuid := gen_random_uuid();
  v_src       uuid := gen_random_uuid();
  v_src_quiet uuid := gen_random_uuid();
  v_o_src     uuid := gen_random_uuid();
  v_run       uuid := gen_random_uuid();
  v_health    jsonb;
  v_source    jsonb;
  v_version   integer;
  v_blocked   boolean;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,     'xh-dir@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,   'xh-admin@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_o_dir,   'xh-odir@example.test',    jsonb_build_object('tenant_id', v_o, 'department', 'ib')),
    (v_o_admin, 'xh-oadmin@example.test',  jsonb_build_object('tenant_id', v_o, 'department', 'admin')),
    (v_n_dir,   'xh-ndir@example.test',    jsonb_build_object('tenant_id', v_n, 'department', 'ib')),
    (v_n_admin, 'xh-nadmin@example.test',  jsonb_build_object('tenant_id', v_n, 'department', 'admin'));
  update users set status = 'active', is_external = false
   where id in (v_dir, v_admin, v_o_dir, v_o_admin, v_n_dir, v_n_admin);
  insert into companies (id, tenant_id, name, type) values
    (v_firm, v_t, 'XH Bank', 'bank'), (v_o_firm, v_o, 'XH Other Bank', 'bank'), (v_n_firm, v_n, 'XH Quiet Bank', 'bank');
  update users set company_id = v_firm, company_role = 'director' where id = v_dir;
  update users set company_id = v_firm, company_role = 'member' where id = v_admin;
  update users set company_id = v_o_firm, company_role = 'director' where id = v_o_dir;
  update users set company_id = v_o_firm, company_role = 'member' where id = v_o_admin;
  update users set company_id = v_n_firm, company_role = 'director' where id = v_n_dir;
  update users set company_id = v_n_firm, company_role = 'member' where id = v_n_admin;
  update users set firm_role = 'admin' where id in (v_admin, v_o_admin, v_n_admin);

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email,
     allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'xh.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@xh.example', v_firm, 'active', '2026-10-20T10:00:00Z'),
    (v_o, 'xo.example', 'dwd-reader@proj-2.iam.gserviceaccount.com', '223456789012345678',
     'dir-reader@proj-2.iam.gserviceaccount.com', 'conductia-ingest@xo.example', v_o_firm, 'active', '2026-10-20T10:00:00Z'),
    (v_n, 'xn.example', 'dwd-reader@proj-3.iam.gserviceaccount.com', '323456789012345678',
     'dir-reader@proj-3.iam.gserviceaccount.com', 'conductia-ingest@xn.example', v_n_firm, 'active', '2026-10-20T10:00:00Z');
  insert into content_sources (id, tenant_id, kind, provider, address, status) values
    (v_src,       v_t, 'mailbox', 'google', 'busy@xh.example',  'active'),
    (v_src_quiet, v_t, 'mailbox', 'google', 'quiet@xh.example', 'active'),
    (v_o_src,     v_o, 'mailbox', 'google', 'other@xo.example', 'active');

  -- The tenant's policy: v1, then v2 (the writer is service_role's RPC).
  v_version := discovery_exclusion_policy_set(v_t,
    '[{"id":"CANARYRULE-counsel","category":"privileged","scope":"message","kind":"participant_domain","domains":["canary-counsel.example"]}]'::jsonb,
    0, 'xh-test');
  perform pg_temp.expect(v_version, 1, 'the first policy version is 1');
  -- Another tenant's policy, at a higher version, must never show here.
  perform discovery_exclusion_policy_set(v_o,
    '[{"id":"o1","category":"hr","scope":"message","kind":"participant_address","addresses":["hr@xo.example"]}]'::jsonb, 0, 'xo-test');
  perform discovery_exclusion_policy_set(v_o,
    '[{"id":"o1","category":"hr","scope":"message","kind":"participant_address","addresses":["hr@xo.example"]}]'::jsonb, 1, 'xo-test');
  perform discovery_exclusion_policy_set(v_o,
    '[{"id":"o1","category":"hr","scope":"message","kind":"participant_address","addresses":["hr@xo.example"]}]'::jsonb, 2, 'xo-test');

  -- Ledger: two exclusions under v1, two under v2 (the after-fetch one included),
  -- one other skip and one routed read. The ledger's rows carry the policy shape.
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason,
                              provider_thread_id, policy_version, exclusion_rule, run_id) values
    (v_src, 'x-1', 'CANARYHASH1', 'skipped', 'policy_excluded',              'CANARYTHREAD-1', 1, 'CANARYRULE-counsel', v_run),
    (v_src, 'x-2', 'CANARYHASH2', 'skipped', 'policy_thread_excluded',       'CANARYTHREAD-1', 1, 'CANARYRULE-counsel', v_run);
  v_version := discovery_exclusion_policy_set(v_t,
    '[{"id":"CANARYRULE-counsel","category":"privileged","scope":"message","kind":"participant_domain","domains":["canary-counsel.example"]},
      {"id":"CANARYRULE-hr","category":"hr","scope":"message","kind":"participant_address","addresses":["canary-hr@xh.example"]}]'::jsonb,
    1, 'xh-test');
  perform pg_temp.expect(v_version, 2, 'the second policy version is 2');
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason,
                              provider_thread_id, policy_version, exclusion_rule, run_id) values
    (v_src, 'x-3', 'CANARYHASH3', 'skipped', 'policy_unevaluable',           'CANARYTHREAD-2', 2, 'CANARYRULE-hr', v_run),
    (v_src, 'x-4', 'CANARYHASH4', 'skipped', 'policy_excluded_after_fetch',  'CANARYTHREAD-3', 2, 'CANARYRULE-hr', v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, run_id)
    values (v_src, 'x-5', 'h5', 'skipped', 'too_large', v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id)
    values (v_src, 'x-6', 'h6', 'routed', 'codename', 0.9, v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason,
                              provider_thread_id, policy_version, exclusion_rule, run_id)
    values (v_o_src, 'o-1', 'oh1', 'skipped', 'policy_excluded', 'o-thread', 3, 'o1', v_run);

  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_health := discovery_ingestion_health();

  -- The count spans both versions and all four reasons; the version is the current one.
  perform pg_temp.expect((v_health #>> '{totals,itemsExcluded}')::bigint, 4, 'four exclusions under v1 and v2 together');
  perform pg_temp.expect((v_health #>> '{totals,itemsSkipped}')::bigint, 5, 'the exclusions are a subset of the five skips');
  perform pg_temp.expect((v_health #>> '{totals,itemsLedgered}')::bigint, 6, 'six items ledgered');
  perform pg_temp.expect((v_health->>'policyVersion')::bigint, 2, 'the current policy version is 2, not the count');
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src::text;
  perform pg_temp.expect((v_source->>'itemsExcluded')::bigint, 4, 'the busy mailbox excluded four');
  perform pg_temp.expect((v_source->>'itemsSkipped')::bigint, 5, 'the busy mailbox skipped five');
  select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_src_quiet::text;
  perform pg_temp.expect((v_source->>'itemsExcluded')::bigint, 0, 'a quiet mailbox excluded none');

  -- Counts and a version only: no rule id, condition, thread id or hash.
  if v_health::text ~* '(CANARY|canary-counsel|canary-hr|"rules"|rulesSha256|exclusionRule|providerThreadId|itemHash)' then
    raise exception 'FAIL: the health payload leaks policy content: %', v_health::text;
  end if;
  v_blocked := false;
  begin perform 1 from discovery_exclusion_policies limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: the admin read the policy table directly'; end if;

  -- Another tenant sees only its own policy and its own count.
  perform pg_temp.act_as(v_o_admin);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect((v_health->>'policyVersion')::bigint, 3, 'another tenant sees its own version, not this one''s');
  perform pg_temp.expect((v_health #>> '{totals,itemsExcluded}')::bigint, 1, 'another tenant counts only its own exclusions');

  -- A tenant that never wrote a policy reports none, and zero exclusions.
  perform pg_temp.act_as(v_n_admin);
  v_health := discovery_ingestion_health();
  if not (v_health ? 'policyVersion') or v_health->'policyVersion' <> 'null'::jsonb then
    raise exception 'FAIL: a tenant with no policy must report policyVersion null: %', v_health::text;
  end if;
  perform pg_temp.expect((v_health #>> '{totals,itemsExcluded}')::bigint, 0, 'no policy, no exclusions');
  reset role;

  raise notice 'PASS: health reports the exclusion count across every policy version and reason, the current version apart, and no policy content';
end $$;

-- ── Reader passes (#370) ────────────────────────────────────────────────────
-- discovery_ingestion_health() (20261006130000) adds sources[].latestPass and
-- totals.passesLast24h. Rows are planted through discovery_record_reader_pass()
-- as service_role, or inserted directly where a test needs an old server ts or a
-- row the writer would refuse (service_role's direct INSERT is the trust limit,
-- and exactly what the robustness cases need). Every case is read through
-- discovery_ingestion_health(), as the admin and as the CCO.
--   W   a pass written through the writer: ended, completed
--   A   an older completed pass, then a newer failed one: the newest by server
--       ts wins even though its detail startedAt is earlier (within 10 minutes)
--   B   a start 59 minutes old with no end: in_progress
--   C   a start 61 minutes old with no end: no_end_recorded
--   D1-D5 a consistent start two hours old, and an end inserted directly that is
--       not its end: dated tomorrow, before its start, another runId, another
--       jobId, another worker; each reads no_end_recorded
--   E   starts that are malformed or time-inconsistent (ignored), and consistent
--       starts whose ends are malformed (pages -1, registration a string, an
--       array, an object with an extra key): health still answers
--   F   a start 25 hours old: outside the window, still its source's latest
create function pg_temp.rp_iso(p timestamptz)
returns text language sql immutable as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
create function pg_temp.rp_start(p_pass uuid, p_source uuid, p_run uuid, p_at timestamptz, p_job uuid default null)
returns jsonb language sql as $$
  select jsonb_build_object('v', 1, 'passId', p_pass, 'runId', p_run, 'jobId', p_job, 'sourceId', p_source,
    'startedAt', pg_temp.rp_iso(p_at), 'worker', jsonb_build_object('deployment', 'local', 'revision', null));
$$;
create function pg_temp.rp_end(p_start jsonb, p_ended timestamptz, p_status text, p_reason text,
                               p_fetched int, p_excluded int, p_stored int)
returns jsonb language sql as $$
  select p_start || jsonb_build_object('provider', 'google',
    'registration', jsonb_build_object('clientId', 'CANARYCLIENT', 'certThumbprint', null),
    'endedAt', pg_temp.rp_iso(p_ended), 'status', p_status, 'reason', p_reason,
    'pages', 1, 'fetched', p_fetched, 'excluded', p_excluded, 'stored', p_stored, 'checkpointAdvanced', true);
$$;
-- A row written past the writer, at a chosen server time.
create function pg_temp.rp_plant(p_tenant uuid, p_action text, p_detail jsonb, p_ts timestamptz)
returns void language sql as $$
  insert into audit_log (action, tenant_id, actor_type, service_identity, detail, ts)
  values (p_action, p_tenant, 'service', 'discovery-worker', p_detail, p_ts);
$$;
grant execute on all functions in schema pg_temp to service_role;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_o        uuid := gen_random_uuid();
  v_firm     uuid := gen_random_uuid();
  v_o_firm   uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_analyst  uuid := gen_random_uuid();
  v_o_dir    uuid := gen_random_uuid();
  v_o_admin  uuid := gen_random_uuid();
  v_w uuid := gen_random_uuid();  v_a uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();  v_e uuid := gen_random_uuid();  v_f uuid := gen_random_uuid();
  v_d1 uuid := gen_random_uuid(); v_d2 uuid := gen_random_uuid(); v_d3 uuid := gen_random_uuid();
  v_d4 uuid := gen_random_uuid(); v_d5 uuid := gen_random_uuid();
  v_o_src    uuid := gen_random_uuid();
  v_now      timestamptz := now();
  v_pass     uuid;
  v_start    jsonb;
  v_ts       timestamptz;
  v_health   jsonb;
  v_viewer   uuid;
  v_label    text;
  v_blocked  boolean;
  v_bad      jsonb;
  v_d        uuid;
  i          int;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,     'rh-dir@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,   'rh-admin@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,     'rh-cco@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_analyst, 'rh-analyst@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_o_dir,   'rh-odir@example.test',    jsonb_build_object('tenant_id', v_o, 'department', 'ib')),
    (v_o_admin, 'rh-oadmin@example.test',  jsonb_build_object('tenant_id', v_o, 'department', 'admin'));
  update users set status = 'active', is_external = false
   where id in (v_dir, v_admin, v_cco, v_analyst, v_o_dir, v_o_admin);
  insert into companies (id, tenant_id, name, type) values (v_firm, v_t, 'RH Bank', 'bank'), (v_o_firm, v_o, 'RH Other Bank', 'bank');
  update users set company_id = v_firm, company_role = 'director' where id = v_dir;
  update users set company_id = v_firm, company_role = 'member' where id in (v_admin, v_cco, v_analyst);
  update users set company_id = v_o_firm, company_role = 'director' where id = v_o_dir;
  update users set company_id = v_o_firm, company_role = 'member' where id = v_o_admin;
  update users set firm_role = 'admin' where id in (v_admin, v_o_admin);
  update users set firm_role = 'cco' where id = v_cco;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email,
     allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'rh.example', 'dwd-reader@proj-7.iam.gserviceaccount.com', '723456789012345678',
     'dir-reader@proj-7.iam.gserviceaccount.com', 'conductia-ingest@rh.example', v_firm, 'active', '2026-10-20T10:00:00Z'),
    (v_o, 'ro.example', 'dwd-reader@proj-8.iam.gserviceaccount.com', '823456789012345678',
     'dir-reader@proj-8.iam.gserviceaccount.com', 'conductia-ingest@ro.example', v_o_firm, 'active', '2026-10-20T10:00:00Z');
  insert into content_sources (id, tenant_id, kind, provider, address, status) values
    (v_w,  v_t, 'mailbox', 'google', 'w@rh.example',  'active'),
    (v_a,  v_t, 'mailbox', 'google', 'a@rh.example',  'active'),
    (v_b,  v_t, 'mailbox', 'google', 'b@rh.example',  'active'),
    (v_c,  v_t, 'mailbox', 'google', 'c@rh.example',  'active'),
    (v_d1, v_t, 'mailbox', 'google', 'd1@rh.example', 'active'),
    (v_d2, v_t, 'mailbox', 'google', 'd2@rh.example', 'active'),
    (v_d3, v_t, 'mailbox', 'google', 'd3@rh.example', 'active'),
    (v_d4, v_t, 'mailbox', 'google', 'd4@rh.example', 'active'),
    (v_d5, v_t, 'mailbox', 'google', 'd5@rh.example', 'active'),
    (v_e,  v_t, 'mailbox', 'google', 'e@rh.example',  'active'),
    (v_f,  v_t, 'mailbox', 'google', 'f@rh.example',  'active'),
    (v_o_src, v_o, 'mailbox', 'google', 'other@ro.example', 'active');

  -- W: through the writer, as the worker writes it.
  set local role service_role;
  v_pass := gen_random_uuid();
  v_start := pg_temp.rp_start(v_pass, v_w, v_pass, v_now);
  perform discovery_record_reader_pass('started', v_t, v_start);
  perform discovery_record_reader_pass('finished', v_t, pg_temp.rp_end(v_start, v_now, 'complete', null, 3, 1, 2));
  reset role;

  -- A: the older pass completed; the newer one (by server ts) failed, with an earlier detail startedAt.
  v_pass := gen_random_uuid();
  v_start := pg_temp.rp_start(v_pass, v_a, v_pass, v_now - interval '25 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '30 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '24 minutes', 'complete', null, 5, 0, 4), v_now - interval '24 minutes');
  v_pass := gen_random_uuid();
  v_start := pg_temp.rp_start(v_pass, v_a, v_pass, v_now - interval '33 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '28 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '30 minutes', 'failed', '23P01', 2, 1, 0), v_now - interval '27 minutes');

  -- B and C: a start with no end, either side of the discovery.sync expiry.
  v_pass := gen_random_uuid();
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
    pg_temp.rp_start(v_pass, v_b, v_pass, v_now - interval '59 minutes'), v_now - interval '59 minutes');
  v_pass := gen_random_uuid();
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
    pg_temp.rp_start(v_pass, v_c, v_pass, v_now - interval '61 minutes'), v_now - interval '61 minutes');

  -- D1-D5: a consistent start two hours old, and an end that is not its end.
  v_ts := v_now - interval '2 hours';
  foreach v_d in array array[v_d1, v_d2, v_d3, v_d4, v_d5] loop
    v_pass := gen_random_uuid();
    v_start := pg_temp.rp_start(v_pass, v_d, v_pass, v_ts, '44444444-4444-4444-8444-444444444444');
    perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_ts);
    perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
      case v_d
        when v_d1 then pg_temp.rp_end(v_start, v_now + interval '1 day', 'complete', null, 1, 0, 1)
        when v_d2 then pg_temp.rp_end(v_start, v_ts - interval '1 second', 'complete', null, 1, 0, 1)
        when v_d3 then pg_temp.rp_end(v_start, v_ts + interval '1 minute', 'complete', null, 1, 0, 1)
                       || jsonb_build_object('runId', gen_random_uuid())
        when v_d4 then pg_temp.rp_end(v_start, v_ts + interval '1 minute', 'complete', null, 1, 0, 1)
                       || '{"jobId": null}'::jsonb
        else pg_temp.rp_end(v_start, v_ts + interval '1 minute', 'complete', null, 1, 0, 1)
                       || '{"worker": {"deployment": "aws-elsewhere", "revision": null}}'::jsonb
      end,
      v_ts + interval '1 minute');
  end loop;

  -- E: malformed or time-inconsistent starts (ignored entirely) ...
  v_ts := v_now - interval '3 hours';
  v_pass := gen_random_uuid();
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
    pg_temp.rp_start(v_pass, v_e, v_pass, v_ts - interval '11 minutes'), v_ts);
  foreach v_bad in array array['"local"'::jsonb, '["local"]'::jsonb, 'null'::jsonb] loop
    v_pass := gen_random_uuid();
    perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
      pg_temp.rp_start(v_pass, v_e, v_pass, v_ts) || jsonb_build_object('worker', v_bad), v_ts);
  end loop;
  -- ... and consistent starts whose ends are malformed.
  i := 0;
  foreach v_bad in array array[
    '{"pages": -1}'::jsonb,
    '{"registration": "CANARYCLIENT"}'::jsonb,
    '{"registration": ["CANARYCLIENT"]}'::jsonb,
    '{"registration": {"clientId": "CANARYCLIENT", "certThumbprint": null, "secret": "x"}}'::jsonb
  ] loop
    i := i + 1;
    v_pass := gen_random_uuid();
    v_start := pg_temp.rp_start(v_pass, v_e, v_pass, v_ts + make_interval(mins => i));
    perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_ts + make_interval(mins => i));
    perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
      pg_temp.rp_end(v_start, v_ts + make_interval(mins => i + 1), 'complete', null, 7, 0, 7) || v_bad,
      v_ts + make_interval(mins => i + 1));
  end loop;

  -- F: a start 25 hours old, with its end: outside the window.
  v_pass := gen_random_uuid();
  v_start := pg_temp.rp_start(v_pass, v_f, v_pass, v_now - interval '25 hours');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '25 hours');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '25 hours', 'complete', null, 9, 9, 9), v_now - interval '25 hours');

  -- Read as the admin and as the CCO: the same answer.
  foreach v_viewer in array array[v_admin, v_cco] loop
    v_label := case when v_viewer = v_admin then 'admin' else 'CCO' end;
    set local role authenticated;
    perform pg_temp.act_as(v_viewer);
    v_health := discovery_ingestion_health();
    reset role;

    perform pg_temp.expect_text(
      (select s->'latestPass'->>'state' || '/' || (s->'latestPass'->>'group') from jsonb_array_elements(v_health->'sources') s
        where s->>'id' = v_w::text),
      'ended/completed', v_label || ': a pass written through the writer reads ended, completed');
    perform pg_temp.expect_text(
      (select (s->'latestPass')::text from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_w::text),
      jsonb_build_object('state', 'ended', 'group', 'completed', 'status', 'complete', 'reason', null,
        'startedAt', pg_temp.rp_iso(v_now), 'endedAt', pg_temp.rp_iso(v_now),
        'pages', 1, 'fetched', 3, 'excluded', 1, 'stored', 2, 'checkpointAdvanced', true)::text,
      v_label || ': the latest pass carries its outcome, its times and its counts, and nothing else');
    perform pg_temp.expect_text(
      (select s->'latestPass'->>'group' || '/' || (s->'latestPass'->>'reason') from jsonb_array_elements(v_health->'sources') s
        where s->>'id' = v_a::text),
      'failed/23P01', v_label || ': the newest pass by server time wins, whatever its startedAt');
    perform pg_temp.expect_text(
      (select s->'latestPass'->>'state' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_b::text),
      'in_progress', v_label || ': 59 minutes without an end is in progress');
    perform pg_temp.expect_text(
      (select s->'latestPass'->>'state' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_c::text),
      'no_end_recorded', v_label || ': 61 minutes without an end has no end recorded');
    if (select s->'latestPass'->'group' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_c::text) <> 'null'::jsonb then
      raise exception 'FAIL: %: a pass with no end has a group', v_label;
    end if;
    foreach v_d in array array[v_d1, v_d2, v_d3, v_d4, v_d5] loop
      perform pg_temp.expect_text(
        (select s->'latestPass'->>'state' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_d::text),
        'no_end_recorded',
        v_label || ': an end that is not this pass''s end (' ||
          case v_d when v_d1 then 'dated tomorrow' when v_d2 then 'before its start' when v_d3 then 'another runId'
                   when v_d4 then 'another jobId' else 'another worker' end || ') is ignored');
    end loop;
    perform pg_temp.expect_text(
      (select s->'latestPass'->>'state' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_e::text),
      'no_end_recorded', v_label || ': malformed starts and ends are ignored, and health still answers');
    perform pg_temp.expect_text(
      (select s->'latestPass'->>'startedAt' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_e::text),
      pg_temp.rp_iso(v_ts + interval '4 minutes'), v_label || ': the latest consistent start of E is its newest valid one');
    perform pg_temp.expect_text(
      (select s->'latestPass'->>'state' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_f::text),
      'ended', v_label || ': a source''s latest pass shows whatever its age');

    -- The window: W 1, A 2, B 1, C 1, D 5, E 4 consistent starts; F outside it.
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,passes}')::bigint, 14, v_label || ': fourteen passes in 24 hours');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,completed}')::bigint, 2, v_label || ': W and A''s older pass completed');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,failed}')::bigint, 1, v_label || ': only A''s real failure is counted');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,continued}')::bigint, 0, v_label || ': none continued');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,stopped}')::bigint, 0, v_label || ': none stopped');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,refused}')::bigint, 0, v_label || ': none refused');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,noEndRecorded}')::bigint, 10,
                           v_label || ': C, D1-D5 and E''s four have no end recorded; B is in progress');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,fetched}')::bigint, 10, v_label || ': fetched sums the ended passes only');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,excluded}')::bigint, 2, v_label || ': excluded sums the ended passes only');
    perform pg_temp.expect((v_health #>> '{totals,passesLast24h,stored}')::bigint, 6, v_label || ': stored sums the ended passes only');

    -- Outcomes and counts only: never the registration, the worker, a job or run id.
    if v_health::text ~* '(clientId|certThumbprint|CANARYCLIENT|"worker"|jobId|runId|passId|"deployment"|"revision")' then
      raise exception 'FAIL: %: the health payload carries pass identity meant for operators only: %', v_label, v_health::text;
    end if;
  end loop;

  -- The analyst is still denied; another tenant's admin sees none of this tenant's passes.
  set local role authenticated;
  perform pg_temp.act_as(v_analyst);
  v_blocked := false;
  begin perform discovery_ingestion_health();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an analyst read ingestion health'; end if;
  perform pg_temp.act_as(v_o_admin);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect((v_health #>> '{totals,passesLast24h,passes}')::bigint, 0, 'another tenant counts none of this tenant''s passes');
  if (select s->'latestPass' from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_o_src::text) <> 'null'::jsonb then
    raise exception 'FAIL: a source with no pass shows a latest pass';
  end if;
  reset role;

  -- The two health helpers run only inside the security-definer health function: no browser role executes them.
  if has_function_privilege('authenticated', 'discovery_reader_pass_group(text)', 'execute')
     or has_function_privilege('anon', 'discovery_reader_pass_group(text)', 'execute')
     or has_function_privilege('authenticated', 'discovery_reader_pass_end(uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'discovery_reader_pass_end(uuid,jsonb)', 'execute') then
    raise exception 'FAIL: a browser role may execute discovery_reader_pass_group or discovery_reader_pass_end';
  end if;

  raise notice 'PASS: health shows each source''s latest consistent pass by server time and the 24-hour totals, ignores rows that are malformed, inconsistent or not their start''s end, and leaks no pass identity';
end $$;

-- ── Reader liveness (#409): one evidence-based state per source ────────────
-- discovery_ingestion_health() (20261008220000) adds sources[].state, lastPassAt and
-- lastPassAgeSeconds. Three helpers carry the decision, none executable by a browser role:
-- discovery_reader_live (the one 900 s window), discovery_reader_pass_end_with_ts (a start's own
-- end and its server ts in one probe) and discovery_source_health_state (the precedence, pure
-- over booleans). now() is the transaction's start, so every age below is exact.
--   1  the helpers stay private
--   2  the window: 899 s live, 900 s and 901 s not, null not
--   3  the precedence by value: a table of labelled inputs and the state each must give
--   4  through the RPC on consented sources, one source per timing case (audit_log is
--      append-only), read as the admin and the CCO; then the switches
--   5  EXPLAIN on a seeded month: the two pass probes use audit_log_reader_pass_source

-- 1 + 2 + 3
do $$
declare
  r record;
  v_fn text;
begin
  foreach v_fn in array array[
    'discovery_reader_live(timestamptz)',
    'discovery_reader_pass_end_with_ts(uuid,jsonb)',
    'discovery_source_health_state(text,boolean,text,text,boolean,boolean,boolean,text,text,boolean,boolean,text)'
  ] loop
    if has_function_privilege('authenticated', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'FAIL: a browser role may execute %', v_fn;
    end if;
  end loop;

  if discovery_reader_live(now() - interval '899 seconds') is not true then raise exception 'FAIL: 899 s is not live'; end if;
  if discovery_reader_live(now() - interval '900 seconds') is not false then raise exception 'FAIL: 900 s is live'; end if;
  if discovery_reader_live(now() - interval '901 seconds') is not false then raise exception 'FAIL: 901 s is live'; end if;
  if discovery_reader_live(null) is not false then raise exception 'FAIL: null is live'; end if;

  for r in
    select * from (values
      -- label, expected, status, archived, last_error, waiting_for, reading, registration, has_pass, group, reason, unfinished_live, end_live, checkpoint
      ('paused beats halted',                       'paused',            'paused', false, 'history_window_exceeded', null,         true,  true,  true,  null,        null,                     false, false, 'incremental'),
      ('an archived source reads paused',           'paused',            'active', true,  null,                      null,         true,  true,  true,  null,        null,                     false, false, 'incremental'),
      ('halted beats a flag off',                   'halted',            'active', false, 'history_window_exceeded', null,         false, true,  true,  null,        null,                     false, false, 'incremental'),
      ('reading off beats delegation_refused',      'switched_off',      'active', false, null,                      null,         false, true,  true,  'failed',    'delegation_refused',     false, true,  'incremental'),
      ('registration off beats delegation_refused', 'switched_off',      'active', false, null,                      null,         true,  false, true,  'failed',    'delegation_refused',     false, true,  'incremental'),
      ('registration off beats google_500',         'switched_off',      'active', false, null,                      null,         true,  false, true,  'failed',    'google_500',             false, true,  'incremental'),
      ('switched_off beats waiting',                'switched_off',      'active', false, null,                      'no_consent', false, true,  true,  null,        null,                     false, false, 'incremental'),
      ('delegation_broken beats waiting',           'delegation_broken', 'active', false, null,                      'no_consent', true,  true,  true,  'failed',    'delegation_refused',     false, true,  'incremental'),
      ('waiting beats failing',                     'waiting',           'active', false, null,                      'no_consent', true,  true,  true,  'failed',    'google_500',             false, true,  'incremental'),
      ('failing with an old end (backoff)',         'failing',           'active', false, null,                      null,         true,  true,  true,  'failed',    'google_500',             false, false, 'incremental'),
      ('failing beats not_started',                 'failing',           'active', false, null,                      null,         true,  true,  true,  'failed',    'google_500',             false, false, 'not_started'),
      ('not_started: never read',                   'not_started',       'active', false, null,                      null,         true,  true,  false, null,        null,                     false, false, 'not_started'),
      ('not_started: the latest pass is the halt',  'not_started',       'active', false, null,                      null,         true,  true,  true,  'stopped',   'history_window_exceeded', false, true,  'not_started'),
      ('not_started: a source_halted pass',         'not_started',       'active', false, null,                      null,         true,  true,  true,  'stopped',   'source_halted',          false, true,  'not_started'),
      ('reading: an unfinished pass, live start',   'reading',           'active', false, null,                      null,         true,  true,  true,  null,        null,                     true,  false, 'incremental'),
      ('reading: continued with a live end',        'reading',           'active', false, null,                      null,         true,  true,  true,  'continued', null,                     false, true,  'backfilling'),
      ('reading: never checkpointed, live start',   'reading',           'active', false, null,                      null,         true,  true,  true,  null,        null,                     true,  false, 'not_started'),
      ('stale: an unfinished pass, start not live', 'stale',             'active', false, null,                      null,         true,  true,  true,  null,        null,                     false, false, 'incremental'),
      ('stale: completed, its own end is old',      'stale',             'active', false, null,                      null,         true,  true,  true,  'completed', null,                     false, false, 'incremental'),
      ('stale: incremental with no pass',           'stale',             'active', false, null,                      null,         true,  true,  false, null,        null,                     false, false, 'incremental'),
      ('stale: stopped (disabled), live end',       'stale',             'active', false, null,                      null,         true,  true,  true,  'stopped',   'disabled',               false, true,  'incremental'),
      ('stale: refused, live end',                  'stale',             'active', false, null,                      null,         true,  true,  true,  'refused',   'exclusion_not_enforced', false, true,  'incremental'),
      ('stale: stopped (paused), live end',         'stale',             'active', false, null,                      null,         true,  true,  true,  'stopped',   'paused',                 false, true,  'incremental'),
      ('stale: continued, old end',                 'stale',             'active', false, null,                      null,         true,  true,  true,  'continued', null,                     false, false, 'backfilling'),
      ('up_to_date: completed with a live end',     'up_to_date',        'active', false, null,                      null,         true,  true,  true,  'completed', null,                     false, true,  'incremental')
    ) as t(label, expected, status, archived, last_error, waiting_for, reading, registration, has_pass, grp, reason, unfinished_live, end_live, checkpoint)
  loop
    if discovery_source_health_state(r.status, r.archived, r.last_error, r.waiting_for, r.reading, r.registration,
         r.has_pass, r.grp, r.reason, r.unfinished_live, r.end_live, r.checkpoint) is distinct from r.expected then
      raise exception 'FAIL: % (expected %, got %)', r.label, r.expected,
        discovery_source_health_state(r.status, r.archived, r.last_error, r.waiting_for, r.reading, r.registration,
          r.has_pass, r.grp, r.reason, r.unfinished_live, r.end_live, r.checkpoint);
    end if;
  end loop;

  raise notice 'PASS: the liveness helpers are private, the window is 900 s, and the state precedence holds by value';
end $$;

-- 4: through the RPC.
create function pg_temp.lv_pick(p_health jsonb, p_id uuid)
returns jsonb language sql immutable as $$
  select s from jsonb_array_elements(p_health->'sources') s where s->>'id' = p_id::text
$$;
-- A consented, seated Gmail mailbox with a finished backfill, owned by its own member: waitingFor is null.
create function pg_temp.lv_source(p_tenant uuid, p_firm uuid, p_dir uuid, p_address text)
returns uuid language plpgsql as $$
declare
  v_u   uuid := gen_random_uuid();
  v_src uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_u, 'lv-' || v_u || '@example.test', jsonb_build_object('tenant_id', p_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = p_firm, company_role = 'member' where id = v_u;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status, accepted_at, accepted_user_id)
  values (p_tenant, p_address, p_dir, p_firm, 'member', 'accepted', 'sent', now(), v_u);
  -- A consent is the member's own act (auth.uid() = user_id).
  perform pg_temp.act_as(v_u);
  insert into mailbox_consents (tenant_id, user_id, invite_id, address)
  select i.tenant_id, i.accepted_user_id, i.id, lower(i.email) from invites i
   where i.tenant_id = p_tenant and i.email = p_address;
  insert into content_sources
    (id, tenant_id, kind, provider, address, owner_user_id, status, delta_checkpoint, backfill_completed_at, checkpoint_updated_at)
  values (v_src, p_tenant, 'mailbox', 'google', p_address, v_u, 'active', '{"v":1,"kind":"gmail-mail"}',
          now() - interval '1 day', now() - interval '1 day');
  return v_src;
end;
$$;

do $$
declare
  v_t       uuid := gen_random_uuid();
  v_firm    uuid := gen_random_uuid();
  v_oth     uuid := gen_random_uuid();
  v_dir     uuid := gen_random_uuid();
  v_admin   uuid := gen_random_uuid();
  v_cco     uuid := gen_random_uuid();
  v_analyst uuid := gen_random_uuid();
  v_oadm    uuid := gen_random_uuid();
  v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_e uuid; v_f uuid; v_g uuid; v_h uuid; v_i uuid; v_j uuid; v_k uuid;
  v_now     timestamptz := now();
  v_pass    uuid;
  v_start   jsonb;
  v_start2  jsonb;
  v_health  jsonb;
  v_cco_h   jsonb;
  v_blocked boolean;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,     'lv-dir@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,   'lv-admin@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,     'lv-cco@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_analyst, 'lv-analyst@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_oadm,    'lv-oadm@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin'));
  update users set status = 'active', is_external = false where id in (v_dir, v_admin, v_cco, v_analyst, v_oadm);
  insert into companies (id, tenant_id, name, type) values (v_firm, v_t, 'LV Bank', 'bank'), (v_oth, v_t, 'LV Other Bank', 'bank');
  update users set company_id = v_firm, company_role = 'director' where id = v_dir;
  update users set company_id = v_firm, company_role = 'member' where id in (v_admin, v_cco, v_analyst);
  update users set company_id = v_oth, company_role = 'director' where id = v_oadm;
  update users set firm_role = 'admin' where id in (v_admin, v_oadm);
  update users set firm_role = 'cco' where id = v_cco;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email,
     allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'lv.example', 'dwd-reader@proj-9.iam.gserviceaccount.com', '923456789012345678',
     'dir-reader@proj-9.iam.gserviceaccount.com', 'conductia-ingest@lv.example', v_firm, 'active', '2026-10-20T10:00:00Z');
  -- Both switches on (rolled back with the file).
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into feature_flags (key, enabled) values ('discovery_worker_enabled', true) on conflict (key) do update set enabled = true;

  v_a := pg_temp.lv_source(v_t, v_firm, v_dir, 'a@lv.example');
  v_b := pg_temp.lv_source(v_t, v_firm, v_dir, 'b@lv.example');
  v_c := pg_temp.lv_source(v_t, v_firm, v_dir, 'c@lv.example');
  v_d := pg_temp.lv_source(v_t, v_firm, v_dir, 'd@lv.example');
  v_e := pg_temp.lv_source(v_t, v_firm, v_dir, 'e@lv.example');
  v_f := pg_temp.lv_source(v_t, v_firm, v_dir, 'f@lv.example');
  v_g := pg_temp.lv_source(v_t, v_firm, v_dir, 'g@lv.example');
  v_h := pg_temp.lv_source(v_t, v_firm, v_dir, 'h@lv.example');
  v_i := pg_temp.lv_source(v_t, v_firm, v_dir, 'i@lv.example');
  v_j := pg_temp.lv_source(v_t, v_firm, v_dir, 'j@lv.example');
  v_k := pg_temp.lv_source(v_t, v_firm, v_dir, 'k@lv.example');

  -- a@: nothing planted.
  -- b@: complete, start -20 min, end -16 min.
  v_pass := gen_random_uuid(); v_start := pg_temp.rp_start(v_pass, v_b, v_pass, v_now - interval '20 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '20 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '16 minutes', 'complete', null, 3, 0, 3), v_now - interval '16 minutes');
  -- c@: complete, end -1 min.
  v_pass := gen_random_uuid(); v_start := pg_temp.rp_start(v_pass, v_c, v_pass, v_now - interval '2 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '2 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '1 minute', 'complete', null, 3, 0, 3), v_now - interval '1 minute');
  -- d@: failed google_500, end -40 s.
  v_pass := gen_random_uuid(); v_start := pg_temp.rp_start(v_pass, v_d, v_pass, v_now - interval '2 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '2 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '40 seconds', 'failed', 'google_500', 0, 0, 0), v_now - interval '40 seconds');
  -- e@: failed delegation_refused, end -30 s.
  v_pass := gen_random_uuid(); v_start := pg_temp.rp_start(v_pass, v_e, v_pass, v_now - interval '2 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '2 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '30 seconds', 'failed', 'delegation_refused', 0, 0, 0), v_now - interval '30 seconds');
  -- f@: start -20 s, no end.
  v_pass := gen_random_uuid();
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
    pg_temp.rp_start(v_pass, v_f, v_pass, v_now - interval '20 seconds'), v_now - interval '20 seconds');
  -- g@ (overlap 1): start A -80 min, start B -70 min, end A -1 min. B is past the 3600 s expiry, so only A's end
  -- could make it look live.
  v_pass := gen_random_uuid(); v_start := pg_temp.rp_start(v_pass, v_g, v_pass, v_now - interval '80 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '80 minutes');
  v_pass := gen_random_uuid();
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
    pg_temp.rp_start(v_pass, v_g, v_pass, v_now - interval '70 minutes'), v_now - interval '70 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '1 minute', 'complete', null, 1, 0, 1), v_now - interval '1 minute');
  -- h@ (overlap 2): start A -30 min, start B -20 min, end B -16 min (complete), end A -1 min.
  v_pass := gen_random_uuid(); v_start := pg_temp.rp_start(v_pass, v_h, v_pass, v_now - interval '30 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '30 minutes');
  v_pass := gen_random_uuid(); v_start2 := pg_temp.rp_start(v_pass, v_h, v_pass, v_now - interval '20 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start2, v_now - interval '20 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start2, v_now - interval '16 minutes', 'complete', null, 1, 0, 1), v_now - interval '16 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '1 minute', 'complete', null, 1, 0, 1), v_now - interval '1 minute');
  -- i@ (crashed worker): start -16 min, no end, no progress mark.
  v_pass := gen_random_uuid();
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
    pg_temp.rp_start(v_pass, v_i, v_pass, v_now - interval '16 minutes'), v_now - interval '16 minutes');
  -- k@ (a long page still moving): start -40 min, no end, its progress mark 2 minutes ago.
  v_pass := gen_random_uuid();
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started',
    pg_temp.rp_start(v_pass, v_k, v_pass, v_now - interval '40 minutes'), v_now - interval '40 minutes');
  update content_sources set reader_progress_at = v_now - interval '2 minutes' where id = v_k;
  -- j@: halted, with a fresh skipped / source_halted pass (a stray job after the halt).
  update content_sources set last_error = 'history_window_exceeded', last_error_at = v_now where id = v_j;
  v_pass := gen_random_uuid(); v_start := pg_temp.rp_start(v_pass, v_j, v_pass, v_now - interval '30 seconds');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, v_now - interval '30 seconds');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, v_now - interval '29 seconds', 'skipped', 'source_halted', 0, 0, 0), v_now - interval '29 seconds');

  -- Read as the admin, then as the CCO.
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_health := discovery_ingestion_health();
  perform pg_temp.act_as(v_cco);
  v_cco_h := discovery_ingestion_health();
  reset role;

  if (select jsonb_object_agg(s->>'id', s->>'state') from jsonb_array_elements(v_health->'sources') s)
     is distinct from (select jsonb_object_agg(s->>'id', s->>'state') from jsonb_array_elements(v_cco_h->'sources') s) then
    raise exception 'FAIL: the CCO and the admin read different states';
  end if;

  -- Each case begins with no waiting reason, so the evidence alone decides.
  if exists (select 1 from jsonb_array_elements(v_health->'sources') s where s->'waitingFor' <> 'null'::jsonb and s->>'id' <> v_j::text) then
    raise exception 'FAIL: a consented source reports a waiting reason: %', v_health::text;
  end if;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_a)->>'state', 'stale', 'a@: an incremental source with no pass is stale');
  if pg_temp.lv_pick(v_health, v_a)->'lastPassAt' <> 'null'::jsonb or pg_temp.lv_pick(v_health, v_a)->'lastPassAgeSeconds' <> 'null'::jsonb then
    raise exception 'FAIL: a@ has a last pass';
  end if;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_b)->>'state', 'stale', 'b@: completed 16 minutes ago is stale');
  perform pg_temp.expect((pg_temp.lv_pick(v_health, v_b)->>'lastPassAgeSeconds')::bigint, 960, 'b@: the last pass is 960 s old');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_c)->>'state', 'up_to_date', 'c@: completed a minute ago is up to date');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_d)->>'state', 'failing', 'd@: a failed pass is failing');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_e)->>'state', 'delegation_broken', 'e@: a refused delegation is delegation_broken');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_f)->>'state', 'reading', 'f@: a start 20 s old with no end is reading');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_g)->>'state', 'stale', 'g@: another pass''s end does not make this one live');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_g)->'latestPass'->>'startedAt', pg_temp.rp_iso(v_now - interval '70 minutes'),
    'g@: the latest pass is B');
  if abs((pg_temp.lv_pick(v_health, v_g)->>'lastPassAgeSeconds')::bigint - 60) > 5 then raise exception 'FAIL: g@ last pass age'; end if;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_h)->>'state', 'stale', 'h@: B''s old end decides, not A''s fresh one');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_h)->'latestPass'->>'state', 'ended', 'h@: the latest pass (B) ended');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_h)->'latestPass'->>'startedAt', pg_temp.rp_iso(v_now - interval '20 minutes'),
    'h@: the latest pass is B');
  if abs((pg_temp.lv_pick(v_health, v_h)->>'lastPassAgeSeconds')::bigint - 60) > 5 then raise exception 'FAIL: h@ last pass age'; end if;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_i)->>'state', 'stale', 'i@: a start 16 minutes old with no end or progress is stale');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_k)->>'state', 'reading', 'k@: a pass 40 minutes old that marked progress 2 minutes ago is reading');
  perform pg_temp.expect((pg_temp.lv_pick(v_health, v_k)->>'lastActivityAgeSeconds')::bigint, 120, 'k@: its activity is the progress mark');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_j)->>'state', 'halted', 'j@: a halted source stays halted whatever its stray skip');

  -- The reader line, right after c@ is planted and before any switch: sources read (f@) and are up to date (c@).
  perform pg_temp.expect_text(v_health #>> '{reader,state}', 'reading', 'the reader line reads reading');
  perform pg_temp.expect_text(v_health #>> '{reader,enabled}', 'true', 'the reader line is enabled');
  -- lastActiveAt is the newest pass row of a readable source: f@'s start 20 s ago, never j@'s stray skip (29 s).
  if abs((v_health #>> '{reader,lastActiveAgeSeconds}')::bigint - 20) > 5 then
    raise exception 'FAIL: the reader last active age is not f@''s start: %', v_health->'reader';
  end if;
  perform pg_temp.expect_text(v_health #>> '{reader,state}', v_cco_h #>> '{reader,state}', 'the CCO reads the same reader line');

  -- Restarting j@ clears the halt and the cursor: the stray skip is not evidence of reading.
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_restart_mailbox_source(v_j);
  v_health := discovery_ingestion_health();
  reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_j)->>'state', 'not_started', 'j@: a restarted source reads not started');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_c)->>'state', 'up_to_date', 'c@ is unchanged by the restart');

  -- The switches, on c@ (up to date) and e@ (delegation broken): never red, never read as a failure.
  update feature_flags set enabled = false where key = 'deal_discovery';
  set local role authenticated; perform pg_temp.act_as(v_admin); v_health := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_c)->>'state', 'switched_off', 'deal_discovery off: c@ is switched off');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_e)->>'state', 'switched_off', 'deal_discovery off: e@ is not delegation_broken');
  perform pg_temp.expect_text(v_health #>> '{reader,state}', 'switched_off', 'deal_discovery off: the reader line is switched off');
  perform pg_temp.expect_text(v_health #>> '{reader,enabled}', 'false', 'deal_discovery off: the reader line is not enabled');
  update feature_flags set enabled = true where key = 'deal_discovery';
  update feature_flags set enabled = false where key = 'discovery_worker_enabled';
  set local role authenticated; perform pg_temp.act_as(v_admin); v_health := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_c)->>'state', 'switched_off', 'worker flag off: c@ is switched off');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_e)->>'state', 'switched_off', 'worker flag off: e@ is not delegation_broken');
  perform pg_temp.expect_text(v_health #>> '{reader,state}', 'switched_off', 'worker flag off: the reader line is switched off');
  update feature_flags set enabled = true where key = 'discovery_worker_enabled';
  update google_reader_registrations set status = 'disabled' where tenant_id = v_t;
  set local role authenticated; perform pg_temp.act_as(v_admin); v_health := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_c)->>'state', 'switched_off', 'registration disabled: c@ is switched off');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_health, v_e)->>'state', 'switched_off', 'registration disabled: e@ is not delegation_broken');
  -- Every source is switched off, so none is readable: idle, not not_reading.
  perform pg_temp.expect_text(v_health #>> '{reader,state}', 'idle', 'registration disabled: no readable source is idle');
  update google_reader_registrations set status = 'active' where tenant_id = v_t;

  -- Every base key is still present; an analyst and a different bank's admin are still refused.
  if not (v_health ?& array['registration', 'registrations', 'allowlist', 'sources', 'viewerCanManageSources',
                            'reconciliation', 'policyVersion', 'totals', 'reader']) then
    raise exception 'FAIL: a base key left the health payload';
  end if;
  if exists (select 1 from jsonb_array_elements(v_health->'sources') s
             where not (s ?& array['id', 'kind', 'provider', 'address', 'status', 'archived', 'ownerAssigned', 'checkpointState',
                                   'backfillCompletedAt', 'checkpointUpdatedAt', 'checkpointAgeSeconds', 'lastSyncedAt', 'lastError',
                                   'lastErrorAt', 'waitingFor', 'itemsLedgered', 'itemsRouted', 'itemsSkipped', 'itemsExcluded',
                                   'latestPass', 'state', 'lastPassAt', 'lastPassAgeSeconds'])) then
    raise exception 'FAIL: a source key left the health payload';
  end if;
  set local role authenticated;
  foreach v_pass in array array[v_analyst, v_oadm] loop
    perform pg_temp.act_as(v_pass);
    v_blocked := false;
    begin perform discovery_ingestion_health();
    exception when insufficient_privilege then v_blocked := true; end;
    if not v_blocked then raise exception 'FAIL: a user outside the control room read ingestion health'; end if;
  end loop;
  reset role;

  raise notice 'PASS: health reports one evidence-based state per consented source, from each pass''s own end, and a switched-off reader is never red';
end $$;

-- 5: EXPLAIN on a seeded month (8640 passes, five minutes apart) for one source.
do $$
declare
  v_t      uuid := gen_random_uuid();
  v_src    uuid := gen_random_uuid();
  v_now    timestamptz := now();
  v_t0     timestamptz := clock_timestamp();
  v_act    text := '';
  v_lp     text := '';
  v_line   text;
begin
  create temp table lv_seed on commit drop as
    select gen_random_uuid() as pass_id, v_now - make_interval(mins => 5 * g) as ts from generate_series(1, 8640) g;
  insert into audit_log (action, tenant_id, actor_type, service_identity, detail, ts)
  select 'discovery.reader_pass_started', v_t, 'service', 'discovery-worker',
         pg_temp.rp_start(pass_id, v_src, pass_id, ts), ts from lv_seed;
  insert into audit_log (action, tenant_id, actor_type, service_identity, detail, ts)
  select 'discovery.reader_pass_finished', v_t, 'service', 'discovery-worker',
         pg_temp.rp_end(pg_temp.rp_start(pass_id, v_src, pass_id, ts), ts + interval '1 minute', 'complete', null, 1, 0, 1),
         ts + interval '1 minute' from lv_seed;
  analyze audit_log;
  raise notice 'seeded and analysed 17280 pass rows in % ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);

  for v_line in execute format(
    'explain select a.ts from audit_log a where a.tenant_id = %L and a.action in (''discovery.reader_pass_started'', ''discovery.reader_pass_finished'') '
    'and a.detail->>''sourceId'' = %L and discovery_reader_pass_consistent(a.action, a.detail, a.ts) order by a.ts desc limit 1', v_t, v_src::text)
  loop v_act := v_act || E'\n' || v_line; end loop;
  for v_line in execute format(
    'explain select s.detail, s.ts from audit_log s where s.tenant_id = %L and s.action = ''discovery.reader_pass_started'' '
    'and s.detail->>''sourceId'' = %L and discovery_reader_pass_consistent(s.action, s.detail, s.ts) '
    'order by s.ts desc, s.detail->>''startedAt'' desc limit 1', v_t, v_src::text)
  loop v_lp := v_lp || E'\n' || v_line; end loop;
  raise notice 'act probe plan:%', v_act;
  raise notice 'lp probe plan:%', v_lp;

  if v_act !~ 'Index Scan using audit_log_reader_pass_source' or v_act !~ 'Limit' then
    raise exception 'FAIL: the act probe does not use audit_log_reader_pass_source under a Limit: %', v_act;
  end if;
  if v_lp !~ 'audit_log_reader_pass_source' then
    raise exception 'FAIL: the lp probe does not use audit_log_reader_pass_source: %', v_lp;
  end if;
  raise notice 'lp probe uses an Incremental Sort: %', v_lp ~ 'Incremental Sort';
  raise notice 'PASS: both pass probes are served by audit_log_reader_pass_source on a seeded month';
end $$;

-- 6: the reader line (R4), derived from the readable sources alone. Each timing case runs in its own throwaway
-- tenant, planted from scratch, because audit_log is append-only (R2).
create function pg_temp.rl_tenant(p_label text)
returns table (tenant uuid, admin uuid, firm uuid, dir uuid) language plpgsql as $$
declare
  v_t     uuid := gen_random_uuid();
  v_firm  uuid := gen_random_uuid();
  v_dir   uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,   'rl-dir-' || p_label || '@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin, 'rl-admin-' || p_label || '@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin'));
  update users set status = 'active', is_external = false where id in (v_dir, v_admin);
  insert into companies (id, tenant_id, name, type) values (v_firm, v_t, 'RL Bank ' || p_label, 'bank');
  update users set company_id = v_firm, company_role = 'director' where id = v_dir;
  update users set company_id = v_firm, company_role = 'member', firm_role = 'admin' where id = v_admin;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email,
     allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, p_label || '.rl.example', 'dwd-reader@rl-' || p_label || '.iam.gserviceaccount.com',
     '7' || lpad(abs(hashtext(p_label))::text, 17, '0'),
     'dir-reader@rl-' || p_label || '.iam.gserviceaccount.com',
     'conductia-ingest@' || p_label || '.rl.example', v_firm, 'active', '2026-10-20T10:00:00Z');
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into feature_flags (key, enabled) values ('discovery_worker_enabled', true) on conflict (key) do update set enabled = true;
  return query select v_t, v_admin, v_firm, v_dir;
end;
$$;
-- A source with no consent (it reads waiting, which is still readable), optionally halted or paused.
create function pg_temp.rl_plain(p_tenant uuid, p_address text, p_status text default 'active', p_halted boolean default false)
returns uuid language plpgsql as $$
declare v_src uuid := gen_random_uuid();
begin
  insert into content_sources (id, tenant_id, kind, provider, address, status, last_error, last_error_at)
  values (v_src, p_tenant, 'mailbox', 'google', p_address, p_status,
          case when p_halted then 'history_window_exceeded' end, case when p_halted then now() end);
  return v_src;
end;
$$;
-- A pass (start and end) for a source, the end at a chosen age.
create function pg_temp.rl_pass(p_tenant uuid, p_source uuid, p_start_ago interval, p_end_ago interval,
                                p_status text, p_reason text)
returns void language plpgsql as $$
declare
  v_pass  uuid := gen_random_uuid();
  v_start jsonb := pg_temp.rp_start(v_pass, p_source, v_pass, now() - p_start_ago);
begin
  perform pg_temp.rp_plant(p_tenant, 'discovery.reader_pass_started', v_start, now() - p_start_ago);
  perform pg_temp.rp_plant(p_tenant, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, now() - p_end_ago, p_status, p_reason, 0, 0, 0), now() - p_end_ago);
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  v_t   record;
  v_s   uuid;
  v_s2  uuid;
  v_h   jsonb;
begin
  -- T1: one waiting source, a refused pass ended 899 s ago: the worker is at work, nothing reads.
  select * into v_t from pg_temp.rl_tenant('t1');
  v_s := pg_temp.rl_plain(v_t.tenant, 'a@t1.rl.example');
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '900 seconds', interval '899 seconds', 'refused', 'exclusion_not_enforced');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'waiting', 'T1: the source is waiting');
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'active', 'T1: a refused pass 899 s ago is active (all waiting)');
  perform pg_temp.expect_text(v_h #>> '{reader,enabled}', 'true', 'T1: enabled');

  -- T2: the same, ended 901 s ago.
  select * into v_t from pg_temp.rl_tenant('t2');
  v_s := pg_temp.rl_plain(v_t.tenant, 'a@t2.rl.example');
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '902 seconds', interval '901 seconds', 'refused', 'exclusion_not_enforced');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'not_reading', 'T2: a refused pass 901 s ago is not reading');
  if abs((v_h #>> '{reader,lastActiveAgeSeconds}')::bigint - 901) > 5 then raise exception 'FAIL: T2 age: %', v_h->'reader'; end if;

  -- T3 (crashed worker): only a start 16 minutes ago.
  select * into v_t from pg_temp.rl_tenant('t3');
  v_s := pg_temp.rl_plain(v_t.tenant, 'a@t3.rl.example');
  perform pg_temp.rp_plant(v_t.tenant, 'discovery.reader_pass_started',
    pg_temp.rp_start(gen_random_uuid(), v_s, gen_random_uuid(), now() - interval '16 minutes'), now() - interval '16 minutes');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'not_reading', 'T3: a lone start 16 minutes ago is not reading');

  -- T4: a readable source whose pass ended 20 minutes ago, and a halted source with a fresh stray skip.
  select * into v_t from pg_temp.rl_tenant('t4');
  v_s  := pg_temp.rl_plain(v_t.tenant, 'a@t4.rl.example');
  v_s2 := pg_temp.rl_plain(v_t.tenant, 'h@t4.rl.example', 'active', true);
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '21 minutes', interval '20 minutes', 'refused', 'exclusion_not_enforced');
  perform pg_temp.rl_pass(v_t.tenant, v_s2, interval '30 seconds', interval '29 seconds', 'skipped', 'source_halted');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s2)->>'state', 'halted', 'T4: the stray skip leaves the source halted');
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'not_reading', 'T4: a halted source''s fresh skip does not count');
  if abs((v_h #>> '{reader,lastActiveAgeSeconds}')::bigint - 1200) > 5 then
    raise exception 'FAIL: T4 lastActiveAt is not the readable source''s: %', v_h->'reader';
  end if;

  -- T5 (all in backoff): one consented source, a failed google_500 pass ended 20 minutes ago.
  select * into v_t from pg_temp.rl_tenant('t5');
  v_s := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'a@t5.rl.example');
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '21 minutes', interval '20 minutes', 'failed', 'google_500');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'failing', 'T5: a failed pass in backoff is failing, not stale');
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'not_reading', 'T5: nothing recorded for 20 minutes is not reading');

  -- T6: only a paused source and a halted source: nothing is readable.
  select * into v_t from pg_temp.rl_tenant('t6');
  v_s  := pg_temp.rl_plain(v_t.tenant, 'p@t6.rl.example', 'paused');
  v_s2 := pg_temp.rl_plain(v_t.tenant, 'h@t6.rl.example', 'active', true);
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'paused', 'T6: paused');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s2)->>'state', 'halted', 'T6: halted');
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'idle', 'T6: no readable source is idle');
  if v_h #> '{reader,lastActiveAt}' <> 'null'::jsonb or v_h #> '{reader,lastActiveAgeSeconds}' <> 'null'::jsonb then
    raise exception 'FAIL: T6 idle reader has a last active time: %', v_h->'reader';
  end if;

  raise notice 'PASS: the reader line is derived from readable sources alone, with one 900 s window';
end $$;

-- 7: rules the stack audit pinned (#409, S4), each through the RPC in its own throwaway tenant (R2).
--   T7  every readable source failing, the worker recorded a minute ago: the line reads active, never reading
--   T8  every readable source stale, the worker recorded a minute ago: active
--   T9  lastPassAt is the newest pass row, read with index scans off over rows planted out of ts order
--   T10 a missing flag row is off: either switch's row deleted reads switched_off, line and sources
--   T11 a never-checkpointed source with an unfinished live pass reads reading, not not_started
do $$
declare
  v_t   record;
  v_s   uuid;
  v_s2  uuid;
  v_h   jsonb;
  v_key text;
begin
  select * into v_t from pg_temp.rl_tenant('t7');
  v_s  := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'a@t7.rl.example');
  v_s2 := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'b@t7.rl.example');
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '2 minutes', interval '1 minute', 'failed', 'google_500');
  perform pg_temp.rl_pass(v_t.tenant, v_s2, interval '3 minutes', interval '2 minutes', 'failed', 'google_500');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'failing', 'T7: a@ is failing');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s2)->>'state', 'failing', 'T7: b@ is failing');
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'active', 'T7: all failing with a live worker is active, not reading');

  select * into v_t from pg_temp.rl_tenant('t8');
  v_s  := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'a@t8.rl.example');
  v_s2 := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'b@t8.rl.example');
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '2 minutes', interval '1 minute', 'refused', 'exclusion_not_enforced');
  perform pg_temp.rl_pass(v_t.tenant, v_s2, interval '3 minutes', interval '2 minutes', 'disabled', 'flag_off');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'stale', 'T8: a@ is stale');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s2)->>'state', 'stale', 'T8: b@ is stale');
  perform pg_temp.expect_text(v_h #>> '{reader,state}', 'active', 'T8: all stale with a live worker is active, not reading');

  -- Planted middle, newest, oldest: heap order is not ts order, and with index scans off nothing but the probe's
  -- order by can find the newest.
  select * into v_t from pg_temp.rl_tenant('t9');
  v_s := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'a@t9.rl.example');
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '11 minutes', interval '10 minutes', 'complete', null);
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '2 minutes', interval '1 minute', 'complete', null);
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '31 minutes', interval '30 minutes', 'complete', null);
  perform set_config('enable_indexscan', 'off', true);
  perform set_config('enable_bitmapscan', 'off', true);
  perform set_config('enable_indexonlyscan', 'off', true);
  -- The RPC's plans are cached from the reads above, under the old settings: plan it again.
  discard plans;
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform set_config('enable_indexscan', 'on', true);
  perform set_config('enable_bitmapscan', 'on', true);
  perform set_config('enable_indexonlyscan', 'on', true);
  perform pg_temp.expect((pg_temp.lv_pick(v_h, v_s)->>'lastPassAgeSeconds')::bigint, 60, 'T9: lastPassAt is the newest pass row');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'up_to_date', 'T9: the newest pass decides the state');

  -- Each switch's row deleted, one at a time (rolled back with the file), then restored on.
  select * into v_t from pg_temp.rl_tenant('t10');
  v_s := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'a@t10.rl.example');
  perform pg_temp.rl_pass(v_t.tenant, v_s, interval '2 minutes', interval '1 minute', 'complete', null);
  foreach v_key in array array['deal_discovery', 'discovery_worker_enabled'] loop
    delete from feature_flags where key = v_key;
    set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
    perform pg_temp.expect_text(v_h #>> '{reader,state}', 'switched_off', format('T10: no %s row: the line is switched off', v_key));
    perform pg_temp.expect_text(v_h #>> '{reader,enabled}', 'false', format('T10: no %s row: not enabled', v_key));
    perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'switched_off', format('T10: no %s row: the source is switched off', v_key));
    insert into feature_flags (key, enabled) values (v_key, true) on conflict (key) do update set enabled = true;
  end loop;
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'up_to_date', 'T10: both rows back: up to date');

  select * into v_t from pg_temp.rl_tenant('t11');
  v_s := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'a@t11.rl.example');
  update content_sources set delta_checkpoint = null, backfill_completed_at = null where id = v_s;
  perform pg_temp.rp_plant(v_t.tenant, 'discovery.reader_pass_started',
    pg_temp.rp_start(gen_random_uuid(), v_s, gen_random_uuid(), now() - interval '20 seconds'), now() - interval '20 seconds');
  set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'checkpointState', 'not_started', 'T11: never checkpointed');
  perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', 'reading', 'T11: a first read under way is reading, not not_started');

  raise notice 'PASS: active when nothing is healthy, lastPassAt is the newest row, a missing flag is off, and a first read reads reading';
end $$;

-- 8: one liveness rule (#409, owner decision on the two clocks). An unfinished pass reads reading while its last
-- progress mark (content_sources.reader_progress_at, made after it started) or its start is within the 900 s window;
-- the reader line is not_reading when no readable source's activity (pass row or progress mark) is. Each state below
-- runs in its own throwaway tenant (R2), and in every one the row and the line agree: a readable source reads reading
-- or up to date exactly when the line reads reading, and never while the line reads not_reading.
create function pg_temp.rl_agree(p_h jsonb, p_label text)
returns void language plpgsql as $$
declare
  v_healthy int;
  v_line text := p_h #>> '{reader,state}';
begin
  select count(*) into v_healthy from jsonb_array_elements(p_h->'sources') s
   where s->>'state' in ('reading', 'up_to_date');
  if (v_healthy > 0) is distinct from (v_line = 'reading') or (v_healthy > 0 and v_line = 'not_reading') then
    raise exception 'FAIL: %: the rows (% healthy) and the line (%) disagree', p_label, v_healthy, v_line;
  end if;
end;
$$;

do $$
declare
  v_t   record;
  v_s   uuid;
  v_h   jsonb;
  r     record;
begin
  for r in
    select * from (values
      -- label,                                         start ago,            progress ago,          end ago, end status, row,          line
      ('a crashed worker: its last mark 20 min ago',    interval '30 minutes', interval '20 minutes', null::interval, null::text, 'stale',      'not_reading'),
      ('a long page still marking: 2 min ago',          interval '40 minutes', interval '2 minutes',  null,     null,       'reading',    'reading'),
      ('the first page: started 1 min ago, no mark yet', interval '1 minute',  null,                  null,     null,       'reading',    'reading'),
      ('a mark 899 s ago is live',                      interval '40 minutes', interval '899 seconds', null,    null,       'reading',    'reading'),
      ('a mark 901 s ago is not',                       interval '40 minutes', interval '901 seconds', null,    null,       'stale',      'not_reading'),
      -- A mark older than this pass's start does not hide the start: the newer of the two decides (greatest, not coalesce).
      ('a mark from before this pass started',          interval '1 minute',   interval '20 minutes', null,     null,       'reading',    'reading'),
      ('completed a minute ago',                        interval '2 minutes',  interval '90 seconds', interval '1 minute', 'complete', 'up_to_date', 'reading'),
      ('completed 20 min ago',                          interval '21 minutes', interval '20 minutes', interval '20 minutes', 'complete', 'stale', 'not_reading')
    ) as t(label, start_ago, progress_ago, end_ago, end_status, row_state, line_state)
  loop
    -- The source's address is on the tenant's workspace domain, so a consent admits it (waitingFor null).
    select * into v_t from pg_temp.rl_tenant('p' || left(md5(r.label), 12));
    v_s := pg_temp.lv_source(v_t.tenant, v_t.firm, v_t.dir, 'a@p' || left(md5(r.label), 12) || '.rl.example');
    if r.end_ago is null then
      perform pg_temp.rp_plant(v_t.tenant, 'discovery.reader_pass_started',
        pg_temp.rp_start(gen_random_uuid(), v_s, gen_random_uuid(), now() - r.start_ago), now() - r.start_ago);
    else
      perform pg_temp.rl_pass(v_t.tenant, v_s, r.start_ago, r.end_ago, r.end_status, null);
    end if;
    if r.progress_ago is not null then
      update content_sources set reader_progress_at = now() - r.progress_ago where id = v_s;
    end if;
    set local role authenticated; perform pg_temp.act_as(v_t.admin); v_h := discovery_ingestion_health(); reset role;
    perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'state', r.row_state, r.label || ': the row');
    -- The pass badge's flag follows the same rule: live exactly when an unfinished pass makes the row read reading.
    perform pg_temp.expect_text(pg_temp.lv_pick(v_h, v_s)->>'latestPassLive',
      (r.end_ago is null and r.row_state = 'reading')::text, r.label || ': latestPassLive');
    perform pg_temp.expect_text(v_h #>> '{reader,state}', r.line_state, r.label || ': the line');
    perform pg_temp.rl_agree(v_h, r.label);
  end loop;

  raise notice 'PASS: one liveness rule: an unfinished pass reads reading while it marks progress within 900 s, and the row and the reader line agree in every state';
end $$;

-- ── Ingestion window (#353, 20261018100000) ─────────────────────────────────
-- Each Google mailbox reports its window (backfillSince, 'YYYY-MM-DD', null for
-- the whole mailbox); a Microsoft mailbox reports null whatever its column holds,
-- because the Graph reader does not honour it yet. windowLocked is the set-window
-- RPC's own predicate: false on a fresh row, true for each of delta_checkpoint,
-- backfill_started_at and backfill_completed_at alone, the last-but-one being the
-- shape a history-expiry reset leaves (checkpointState not_started, yet locked).
-- The CCO reads the same values. The function keeps a pinned search_path.
do $$
declare
  v_t        uuid := gen_random_uuid();
  v_firm     uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_fresh    uuid := gen_random_uuid();
  v_whole    uuid := gen_random_uuid();
  v_delta    uuid := gen_random_uuid();
  v_started  uuid := gen_random_uuid();
  v_done     uuid := gen_random_uuid();
  v_ms       uuid := gen_random_uuid();
  v_viewer   uuid;
  v_health   jsonb;
  v_source   jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,   'win-dir@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin, 'win-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,   'win-cco@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance'));
  update users set status = 'active', is_external = false where id in (v_dir, v_admin, v_cco);
  insert into companies (id, tenant_id, name, type) values (v_firm, v_t, 'Window Bank', 'bank');
  update users set company_id = v_firm, company_role = 'director' where id = v_dir;
  update users set company_id = v_firm, company_role = 'member' where id in (v_admin, v_cco);
  update users set firm_role = 'admin' where id = v_admin;
  update users set firm_role = 'cco' where id = v_cco;

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email,
     allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'win.example', 'dwd-reader@proj-9.iam.gserviceaccount.com', '923456789012345678',
     'dir-reader@proj-9.iam.gserviceaccount.com', 'conductia-ingest@win.example', v_firm, 'active', now());
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, consented_at, firm_company_id)
  values (v_t, '99999999-1111-1111-1111-111111111111', '99999999-2222-2222-2222-222222222222', 'active', now(), v_firm);

  -- A fresh Google mailbox takes the column DEFAULT (today - 90); a seeded one reads whole (explicit null).
  insert into content_sources (id, tenant_id, kind, provider, address) values
    (v_fresh, v_t, 'mailbox', 'google', 'fresh@win.example');
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_since) values
    (v_whole, v_t, 'mailbox', 'google', 'whole@win.example', null);
  -- Each lock column alone. backfill_started_at alone is what the history-expiry reset leaves.
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_since, delta_checkpoint) values
    (v_delta, v_t, 'mailbox', 'google', 'delta@win.example', '2026-07-17', '{"v":1,"kind":"gmail-mail"}');
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_since, backfill_started_at) values
    (v_started, v_t, 'mailbox', 'google', 'started@win.example', '2026-07-17', now() - interval '6 days');
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_since, backfill_completed_at) values
    (v_done, v_t, 'mailbox', 'google', 'done@win.example', '2026-07-17', now() - interval '1 day');
  -- A Microsoft mailbox gets the DEFAULT too, but its reader ignores it, so health reports none.
  insert into content_sources (id, tenant_id, kind, provider, address) values
    (v_ms, v_t, 'mailbox', 'microsoft', 'ms@win.example');
  if (select backfill_since from content_sources where id = v_ms) is null then
    raise exception 'FAIL: fixture: the Microsoft row should hold the column DEFAULT';
  end if;

  set local role authenticated;
  foreach v_viewer in array array[v_admin, v_cco] loop
    perform pg_temp.act_as(v_viewer);
    v_health := discovery_ingestion_health();
    perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 6, 'the six window sources');

    select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_fresh::text;
    perform pg_temp.expect_text(v_source->>'backfillSince',
      to_char((now() at time zone 'utc')::date - 90, 'YYYY-MM-DD'), 'a fresh Google mailbox reads from today - 90');
    perform pg_temp.expect_text(v_source->>'windowLocked', 'false', 'a fresh mailbox''s window is open');
    perform pg_temp.expect_text(v_source->>'checkpointState', 'not_started', 'a fresh mailbox has not started');

    select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_whole::text;
    if not (v_source ? 'backfillSince') or v_source->'backfillSince' <> 'null'::jsonb then
      raise exception 'FAIL: a whole-mailbox source must report backfillSince null, got %', v_source->'backfillSince';
    end if;
    perform pg_temp.expect_text(v_source->>'windowLocked', 'false', 'a never-read whole-mailbox source is open');

    select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_delta::text;
    perform pg_temp.expect_text(v_source->>'backfillSince', '2026-07-17', 'the window is a plain date');
    perform pg_temp.expect_text(v_source->>'windowLocked', 'true', 'a checkpoint alone locks the window');

    select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_started::text;
    perform pg_temp.expect_text(v_source->>'windowLocked', 'true', 'backfill_started_at alone locks the window');
    perform pg_temp.expect_text(v_source->>'checkpointState', 'not_started',
      'the reset shape reads not_started, which is why the lock is its own key');

    select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_done::text;
    perform pg_temp.expect_text(v_source->>'windowLocked', 'true', 'backfill_completed_at alone locks the window');

    select s into v_source from jsonb_array_elements(v_health->'sources') s where s->>'id' = v_ms::text;
    if not (v_source ? 'backfillSince') or v_source->'backfillSince' <> 'null'::jsonb then
      raise exception 'FAIL: a Microsoft mailbox must report no window, got %', v_source->'backfillSince';
    end if;
    perform pg_temp.expect_text(v_source->>'windowLocked', 'false', 'a fresh Microsoft mailbox still reports the lock');
  end loop;
  reset role;

  -- #312's form (threads T3): a later create or replace must not drop the pin.
  if not (select coalesce(proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
            from pg_proc where oid = 'public.discovery_ingestion_health()'::regprocedure) then
    raise exception 'FAIL: discovery_ingestion_health does not pin search_path = public, pg_temp';
  end if;
  raise notice 'PASS: health shows each Google mailbox''s window (none for Microsoft) and the set-window lock, to the admin and the CCO alike';
end $$;

-- ── The discovery definer allowlist ────────────────────────────────────────
do $$
declare
  v_expected text[] := array[
    'public.app_is_control_room(p_user uuid)',
    'public.app_owns_item(p_item uuid, p_user uuid)',
    'public.app_can_see_candidate(p_candidate uuid, p_user uuid)',
    'public.app_can_see_item(p_item uuid, p_user uuid)',
    'public.discovery_ingestion_health()',
    -- #262: the firm admin's and CCO's allowlist drift and site registrations,
    -- each bound to auth.uid() (supabase/tests/mailbox_allowlist.sql covers them).
    'public.discovery_allowlist_health()',
    'public.discovery_site_registrations()',
    -- #262 round 3: the firm admin's merge of an archived mailbox source into the live one.
    'public.discovery_unify_mailbox_sources(p_archived uuid, p_target uuid)',
    -- Corrections (20261002210000_discovery_corrections.sql): the banker's own
    -- session, each bound to auth.uid() with tenant, visibility and deal-create
    -- authority checked in the body (supabase/tests/discovery_corrections.sql).
    'public.discovery_rename_candidate(p_candidate uuid, p_name text, p_reason text)',
    'public.discovery_reject_candidate(p_candidate uuid, p_reason text)',
    'public.discovery_set_station(p_candidate uuid, p_step_id text, p_reason text)',
    'public.discovery_merge_candidates(p_merged uuid, p_survivor uuid, p_reason text)',
    'public.discovery_correction_authority(p_candidate uuid, p_action text)',
    -- Split and reassign (20261002230000_discovery_split_reassign.sql): the same
    -- contract (supabase/tests/discovery_corrections.sql).
    'public.discovery_split_candidate(p_candidate uuid, p_source_item_ids uuid[], p_name text, p_reason text)',
    'public.discovery_reassign_link(p_link uuid, p_target_candidate uuid, p_reason text)',
    -- Promotion (20261002220000_discovery_promotion.sql): the MD dismisses the rail's
    -- marker on their own session (supabase/tests/discovery_promotion.sql).
    -- discovery_promote_candidate is service_role only and is deliberately absent.
    'public.discovery_dismiss_suggestion(p_deal_id uuid, p_assessment_id uuid, p_reason text)',
    -- #259 phase 4: a Gmail member's own source status, and a firm admin's pause and resume of a
    -- Google source (supabase/tests/discovery_google.sql covers them).
    'public.discovery_google_mailbox_status()',
    'public.discovery_set_mailbox_source_status(p_source_id uuid, p_status text)',
    -- #353's first-read window, restated by #581 (supabase/tests/discovery_google.sql covers it,
    -- supabase/tests/team_mailboxes.sql the team branch).
    'public.discovery_set_mailbox_source_window(p_source_id uuid, p_since date)',
    -- Reader liveness: a firm admin restarts a halted mailbox source (supabase/tests/discovery_google.sql covers it).
    'public.discovery_restart_mailbox_source(p_source_id uuid)',
    -- The column wall (20261017100000_source_items_column_wall.sql): the owner's read of an
    -- item's subject and participants, bound to auth.uid() (supabase/tests/discovery_rls.sql covers it).
    'public.discovery_item_metadata(p_items uuid[])',
    -- The Deal email thread's own-mailbox filter (20261021141000): acts on auth.uid() only.
    'public.discovery_own_mailbox_items(p_items uuid[])',
    -- The current-events read (20261023130400, #173 G-07): acts on auth.uid() only, ids and a basis
    -- (supabase/tests/discovery_milestones.sql covers it).
    'public.discovery_item_current_events(p_item_ids uuid[])',
    -- The team-access read (20261023130500, #173 G-07): acts on auth.uid() only, ids and a flag
    -- (supabase/tests/discovery_milestones.sql covers it).
    'public.discovery_item_team_access(p_item_ids uuid[])',
    -- #581: the firm admin's team inboxes: connect, list and Remove, each bound to auth.uid()
    -- (supabase/tests/team_mailboxes.sql covers them).
    'public.discovery_connect_team_mailbox(p_address text, p_attestation_version integer, p_backfill_since date)',
    'public.discovery_team_mailboxes()',
    'public.discovery_remove_team_mailbox(p_id uuid)',
    -- #581: the firm admin adds and removes a team inbox's people, bound to auth.uid() the same way.
    'public.discovery_add_team_mailbox_member(p_id uuid, p_user uuid)',
    'public.discovery_remove_team_mailbox_member(p_id uuid, p_user uuid)',
    -- #173 G-03: the team inbox audit trail, bound to auth.uid(): an active, internal admin or CCO of the company
    -- that holds the inboxes reads only their rows (supabase/tests/team_mailbox_audit.sql covers it).
    'public.discovery_team_mailbox_audit(p_view text, p_before_ts timestamp with time zone, p_before_id uuid, p_limit integer)',
    -- G-02a (#173, 20261023120100): the source owner dismisses a model proposal on their own session
    -- (supabase/tests/definer_grants.sql pins its grants). Its read helper and the operator restore are
    -- service_role only and are deliberately absent.
    'public.discovery_dismiss_model_proposal(p_deal_key text)',
    -- G-02b (#173, 20261023140100): the source owner asks to accept a model-only proposal on their own session
    -- (supabase/tests/definer_grants.sql pins its grants). The worker's definers (slice 1b) are service_role only and
    -- are deliberately absent.
    'public.discovery_accept_model_proposal(p_deal_key text, p_proposed_step_id text)',
    -- G-02b (#173, 20261023140400): where a candidate or a deal came from, past RLS, bound to auth.uid(): a caller who
    -- sees the candidate or sits on (or oversees) its deal gets the word 'model_proposal' or 'rules', never a cluster key
    -- (supabase/tests/discovery_model_proposal_accepts.sql covers it).
    'public.discovery_candidate_origins(p_candidate_ids uuid[])',
    'public.discovery_deal_origin(p_deal_id uuid)'
  ];
  v_sig  text;
  v_fn   record;
  v_open text[];
begin
  foreach v_sig in array v_expected loop
    select p.oid, p.prosecdef, p.prosrc into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) = v_sig;
    if not found then raise exception 'FAIL: % does not exist with that signature', v_sig; end if;
    if not v_fn.prosecdef then raise exception 'FAIL: % is not security definer', v_sig; end if;
    if v_fn.prosrc not like '%auth.uid()%' then raise exception 'FAIL: % does not read auth.uid()', v_sig; end if;
    if not has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
      raise exception 'FAIL: authenticated cannot execute %', v_sig;
    end if;
    if has_function_privilege('anon', v_fn.oid, 'EXECUTE') then
      raise exception 'FAIL: anon can execute %', v_sig;
    end if;
  end loop;

  select array_agg(sig order by sig) into v_open
  from (
    select format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and (p.proname like 'discovery\_%' or p.proname in
           ('app_is_control_room', 'app_owns_item', 'app_can_see_candidate', 'app_can_see_item'))
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) s
  where sig <> all (v_expected);
  if v_open is not null then
    raise exception 'FAIL: discovery definer functions open to authenticated beyond the allowlist: %', v_open;
  end if;
  raise notice 'PASS: the % allowlisted discovery definer functions are session-bound, and no other is open to authenticated',
    cardinality(v_expected);
end $$;

rollback;
