-- #461: a banker's stored mail is deleted when their consent ends
-- (20261014120500_discovery_purge.sql).
--
--   Alex   owns two messages no one else holds (a1, a2) and one shared with Storm (sh)
--   Storm  owns sh and one message of her own (s1)
--   Falcon is evidenced by a1 and a2 only; Cobra by sh and s1
--
-- 0. A purge that fails (forced 57014, as a timeout raises) rolls the
--    withdrawal back: the consent stays open, the source stays, no audit row.
-- 1. Alex withdraws through the real RPC as `authenticated`: his source, its
--    provenance, ledger and taints are gone; a1 and a2 are gone with their texts,
--    evidence, milestones and model calls; Falcon is gone with its assessment and
--    visibility. sh and Cobra stay with Storm, and Cobra no longer counts Alex.
-- 2. One discovery.mailbox_purged row: Alex as actor, reason withdrawn, ids and
--    counts only, after the consent_withdrawn row.
-- 3. A second withdraw is a no-op: nothing deleted, nothing audited.
-- 4. The collector's guards and grants: an in-flight orphan (fresh, no provenance)
--    survives the purge, an older orphan of another source does not, a document
--    is never collected, another tenant is never touched; only service_role may
--    call the collector and nobody may call the purge or its identifier delete
--    directly; a seat loss purges through the same trigger with reason seat_lost.
--
-- Sections 5 to 14 (there is no 11) run on a second tenant, one banker per case:
--  5. Two bankers share a thread: withdrawing Alex keeps Storm's provenance,
--     items, texts and evidence.
--  6. A candidate both back survives Alex's purge, rebased, and goes with Storm's.
--  7. A promoted candidate: the deal stays; the candidate, its assessments and
--     its promote correction go; the candidate_promoted audit row stays.
--  8. Legal hold: the held item and candidate stay, counted in heldSkipped;
--     after lift_legal_hold the collector deletes them.
--  9. The correction log's guard: service_role cannot delete, with or without
--     the purge GUC; update and truncate stay refused even under it.
-- 10. A deleted survivor's merged child, kept by its own evidence, is
--     un-merged and proposed; corrections naming the survivor go.
-- 12. One discovery.mailbox_purged row per purge, ids and counts only.
-- 13. SharePoint survives: a candidate on a site document and a mail item keeps
--     the document, loses the mail and the assessment citing its milestone; a
--     document with no provenance is never collected; site rows untouched.
-- 14. Rebase: parties, dates and confidence from the remaining evidence; an
--     unsupported name is neutralised unless the MD typed it; corrections that
--     carry an unsupported name, or name a deleted candidate, go.
--
-- Slice 2 (20261014130000_discovery_purge_wiring.sql), same tenant, new bankers:
-- 15. Group removal: a successful check records a sighting for each address it
--     saw in the group and an absence for each it then saw missing; an
--     unavailable one neither creates nor refreshes either; a re-added address
--     is present again. Only an address seen in the group whose absence is older
--     than the grace, seen within the hour, under the provider of the banker's
--     own source, withdraws (reason group_removed) and purges. A consent never
--     seen in the group, or re-consented after a purge, is not withdrawn. The
--     withdraw RPC returns what its purge deleted.
-- 16. The backstop: an old orphan message is collected in its tenant with one
--     discovery.content_collected row; a fresh one is kept; nothing to collect
--     audits nothing; only service_role runs it.
--
-- Slice 5 (20261014150000_discovery_message_index.sql; the collector's link refresh,
-- 20261014151000_discovery_message_index_export.sql), same tenant:
-- 17. The message index: one row per message per mailbox, keyed by the sha256
--     of the Message-ID and upserted in place, its tags categories only. A
--     copied message (a second provider id, the same Message-ID, the same
--     mailbox) is one row holding both provider ids, whether they arrive in one
--     call or two; the same message in two mailboxes is two rows. A sighting
--     without a Message-ID is not indexed. Only service_role writes it, and
--     never for a source that is not the tenant's live mailbox.
--     The link sets candidate and deal, the copy's row included. A purge deletes the banker's rows and
--     counts them; a colleague's row of a shared message stays; a row linked to
--     a deal under hold stays, and keeps its deal once the candidate goes.
--
-- Slice 7 (20261014160000_tenant_retention_policy.sql), same tenant:
-- 18. The retention policy: a missing row means the pilot values, and a row
--     written with no choice holds the same; only tenant_retention_policy_set
--     writes it (no direct write, even by service_role), with an operator and
--     a reason, a bad value is refused, and each write is one
--     discovery.retention_policy_set row naming the operator as the actor,
--     with the reason and the old and new values. Under index_on_disconnect =
--     'keep' a withdrawal keeps the banker's index rows, marked disconnect, and
--     the backstop keeps rows whose mailbox is gone; back on 'delete', the
--     backstop deletes them (and §17's row the lifted hold had kept), counted.
--     Under content_on_disconnect = 'keep' a withdrawal deletes nothing: the
--     source is archived (the index writer refuses it), and one
--     discovery.mailbox_retained row records it, with no purge row.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_purge.sql
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

create function pg_temp.expect(actual bigint, expected bigint, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
end;
$$;

-- A content digest in the form the worker writes (hmac-sha256: and 64 hex), from a short fixture label.
create function pg_temp.dg(label text) returns text language sql immutable as
  $$ select 'hmac-sha256:' || encode(sha256(convert_to(label, 'UTF8')), 'hex') $$;

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
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- The fixture's ids, read by every section.
create temp table fx (k text primary key, v uuid);

do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_other  uuid := gen_random_uuid();
  v_bank   uuid := gen_random_uuid();
  v_alex   uuid := gen_random_uuid();
  v_storm  uuid := gen_random_uuid();
  v_deal   uuid;
  v_src_a  uuid;
  v_src_s  uuid;
  v_a1     uuid := gen_random_uuid();
  v_a2     uuid := gen_random_uuid();
  v_sh     uuid := gen_random_uuid();
  v_s1     uuid := gen_random_uuid();
  v_fresh  uuid := gen_random_uuid();
  v_old    uuid := gen_random_uuid();
  v_doc    uuid := gen_random_uuid();
  v_far    uuid := gen_random_uuid();
  v_falcon uuid := gen_random_uuid();
  v_cobra  uuid := gen_random_uuid();
  v_run    uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alex,  'purge-alex@example.test',  jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_storm, 'purge-storm@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false where id in (v_alex, v_storm);
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status)
    values (v_tenant, 'fixture', 'fixture', 'active');
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'Purge Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director' where id = v_alex;
  update users set company_id = v_bank, company_role = 'member' where id = v_storm;
  update graph_reader_registrations set mailbox_domains = '{bank.example}', firm_company_id = v_bank
   where tenant_id = v_tenant;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (v_tenant, 'alex@bank.example',  v_alex, v_bank, 'director', 'accepted', 'sent', now(), v_alex),
    (v_tenant, 'storm@bank.example', v_alex, v_bank, 'member',   'accepted', 'sent', now(), v_storm);
  insert into deals (tenant_id, code, codename, bank_id)
    values (v_tenant, 'dp-' || v_tenant::text, 'Purge fixture', v_bank) returning id into v_deal;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  select v_deal, u, (select id from roles where slug = 'deal_team'), 'deal_team' from unnest(array[v_alex, v_storm]) u;

  -- Each opts in through the RPC as themselves, which creates their mailbox source.
  set local role authenticated;
  perform pg_temp.act_as(v_alex);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_storm);
  perform mailbox_consent_grant();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select id into v_src_a from content_sources where tenant_id = v_tenant and address = 'alex@bank.example' and owner_user_id = v_alex;
  select id into v_src_s from content_sources where tenant_id = v_tenant and address = 'storm@bank.example' and owner_user_id = v_storm;
  if v_src_a is null or v_src_s is null then
    raise exception 'FAIL: an opt-in did not create its mailbox source';
  end if;

  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash, created_at) values
    (v_a1,    v_tenant, 'message', 'Project Falcon: kickoff', '2026-02-03', '<a1@t>',    'h-a1', now()),
    (v_a2,    v_tenant, 'message', 'Project Falcon: buyers',  '2026-02-10', '<a2@t>',    'h-a2', now()),
    (v_sh,    v_tenant, 'message', 'Project Cobra: NDA',      '2026-02-11', '<sh@t>',    'h-sh', now()),
    (v_s1,    v_tenant, 'message', 'Project Cobra: bids',     '2026-02-12', '<s1@t>',    'h-s1', now()),
    -- No provenance yet: a page in flight wrote the item and not the link.
    (v_fresh, v_tenant, 'message', 'Project Cobra: LOI',      '2026-02-13', '<fresh@t>', 'h-fr', now()),
    -- No provenance for an hour: an orphan the in-flight guard no longer protects.
    (v_old,   v_tenant, 'message', 'Project Kite: teaser',    '2026-01-02', '<old@t>',   'h-ol', now() - interval '1 hour'),
    -- Another tenant's orphan: a purge here never reaches it.
    (v_far,   v_other,  'message', 'Project Far: teaser',     '2026-01-02', '<far@t>',   'h-fa', now() - interval '1 hour');
  -- A SharePoint document with no provenance: site content, never collected.
  insert into source_items (id, tenant_id, kind, subject, drive_item_key, content_hash, created_at)
    values (v_doc, v_tenant, 'document', 'Falcon model.xlsx', 'drive:doc-1', 'h-doc', now() - interval '1 hour');
  insert into source_item_texts (source_item_id, body_text)
    select id, 'body' from unnest(array[v_a1, v_a2, v_sh, v_s1, v_fresh, v_old, v_doc, v_far]) id;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_a1, v_src_a, 'a-1'), (v_a2, v_src_a, 'a-2'), (v_sh, v_src_a, 'a-3'),
    (v_sh, v_src_s, 's-1'), (v_s1, v_src_s, 's-2');
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id) values
    (v_src_a, 'a-1', 'h-a1', 'routed', 'codename', 0.9, v_run),
    (v_src_a, 'a-2', 'h-a2', 'routed', 'codename', 0.9, v_run),
    (v_src_a, 'a-3', 'h-sh', 'routed', 'codename', 0.9, v_run),
    (v_src_a, 'a-4', 'h-x',  'unrouted', null, null, v_run),
    (v_src_s, 's-1', 'h-sh', 'routed', 'codename', 0.9, v_run),
    (v_src_s, 's-2', 'h-s1', 'routed', 'codename', 0.9, v_run);
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
    values (v_src_a, 'thread-a', 'rule-1', 1, 'a-4', v_run),
           (v_src_s, 'thread-s', 'rule-1', 1, 's-9', v_run);

  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess) values
    (v_falcon, v_tenant, 'codename:falcon', 'Project Falcon', 'Project Falcon'),
    (v_cobra,  v_tenant, 'codename:cobra',  'Project Cobra',  'Project Cobra');
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier) values
    (v_falcon, v_a1, 'codename', 0.9, 'firm'), (v_falcon, v_a2, 'codename', 0.9, 'firm'),
    (v_cobra,  v_sh, 'codename', 0.9, 'firm'), (v_cobra,  v_s1, 'codename', 0.9, 'firm');
  insert into model_calls (id, tenant_id, purpose, model, prompt_version, prompt_hash, source_item_id, content_hash,
                           transport, parsed, outcome)
    select id, v_tenant, 'milestone_extract', 'recorded-model', 'v1', 'ph', id, 'h', 'recorded', '[]'::jsonb, 'ok'
    from unnest(array[v_a1, v_a2, v_sh]) id;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id)
    select v_tenant, id, 'kickoff_held', current_date, 0, 10, 0.8, 'v1:recorded-model', id
    from unnest(array[v_a1, v_a2, v_sh]) id;
  insert into stage_assessments (tenant_id, candidate_id, step_id, reason_text, confidence, engine_version, trigger)
    values (v_tenant, v_falcon, 'p1-s1', 'Kickoff held', 0.8, 'v1', 'extraction'),
           (v_tenant, v_cobra,  'p1-s1', 'Kickoff held', 0.8, 'v1', 'extraction');
  perform discovery_refresh_candidate_visibility(v_falcon);
  perform discovery_refresh_candidate_visibility(v_cobra);

  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cobra), 2,
    'fixture: Alex and Storm both see Cobra');

  insert into fx values ('tenant', v_tenant), ('other', v_other), ('alex', v_alex), ('storm', v_storm),
    ('src_a', v_src_a), ('src_s', v_src_s), ('a1', v_a1), ('a2', v_a2), ('sh', v_sh), ('s1', v_s1),
    ('fresh', v_fresh), ('old', v_old), ('doc', v_doc), ('far', v_far), ('falcon', v_falcon), ('cobra', v_cobra);
end
$$;

-- ── 0. A purge that fails takes the withdrawal back with it ───────────────────
-- The purge runs inside the withdrawal's statement, so a timeout (57014, which
-- the 8 s limit or a long wait on the tenant lock raises) leaves the consent
-- open, the mail in place and no audit row. The banker retries.
create or replace function pg_temp.probe_refuse_delete() returns trigger language plpgsql as $f$
begin
  raise exception 'probe: the purge fails' using errcode = '57014';
end
$f$;
create trigger zz_probe_refuse_delete before delete on content_sources
  for each row execute function pg_temp.probe_refuse_delete();
do $$
declare
  v_tenant uuid := (select v from fx where k = 'tenant');
  v_alex   uuid := (select v from fx where k = 'alex');
  v_open   bigint := (select count(*) from mailbox_consents where user_id = v_alex and withdrawn_at is null);
  v_audit  bigint := (select count(*) from audit_log where tenant_id = v_tenant);
  v_failed boolean := false;
begin
  if v_open = 0 then raise exception 'FAIL: 0 fixture: Alex holds an open consent'; end if;
  set local role authenticated;
  perform pg_temp.act_as(v_alex);
  begin
    perform mailbox_consent_withdraw();
  exception when query_canceled then
    v_failed := true;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if not v_failed then raise exception 'FAIL: 0 the forced purge failure did not surface'; end if;
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_alex and withdrawn_at is null), v_open,
    '0 the consent stays open');
  perform pg_temp.expect((select count(*) from content_sources where id = (select v from fx where k = 'src_a')), 1,
    '0 Alex''s source is still there');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant), v_audit, '0 nothing is audited');
  raise notice 'PASS: 0 a failed purge rolls the withdrawal back';
end
$$;
drop trigger zz_probe_refuse_delete on content_sources;

-- ── 1. Alex withdraws: his sole-held mail goes, the shared message stays ─────
do $$
declare
  v_tenant uuid := (select v from fx where k = 'tenant');
  v_alex   uuid := (select v from fx where k = 'alex');
  v_storm  uuid := (select v from fx where k = 'storm');
  v_src_a  uuid := (select v from fx where k = 'src_a');
  v_src_s  uuid := (select v from fx where k = 'src_s');
  v_alexs  uuid[] := array[(select v from fx where k = 'a1'), (select v from fx where k = 'a2')];
  v_sh     uuid := (select v from fx where k = 'sh');
  v_falcon uuid := (select v from fx where k = 'falcon');
  v_cobra  uuid := (select v from fx where k = 'cobra');
begin
  -- authenticated holds no privilege on mailbox_consents: the RPC is the way in.
  set local role authenticated;
  perform pg_temp.act_as(v_alex);
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '', true);

  perform pg_temp.expect((select count(*) from content_sources where id = v_src_a), 0, 'Alex''s source is deleted');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_src_a), 0, 'Alex''s provenance is deleted');
  perform pg_temp.expect((select count(*) from routing_ledger where source_id = v_src_a), 0, 'Alex''s ledger is deleted');
  perform pg_temp.expect((select count(*) from discovery_thread_taints where source_id = v_src_a), 0, 'Alex''s taints are deleted');
  perform pg_temp.expect((select count(*) from source_items where id = any (v_alexs)), 0, 'Alex''s sole-held items are deleted');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = any (v_alexs)), 0, 'their texts are deleted');
  perform pg_temp.expect((select count(*) from evidence_links where source_item_id = any (v_alexs)), 0, 'their evidence is deleted');
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = any (v_alexs)), 0, 'their milestones are deleted');
  perform pg_temp.expect((select count(*) from model_calls where source_item_id = any (v_alexs)), 0, 'their model calls are deleted');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_falcon), 0, 'Falcon, evidenced by Alex alone, is deleted');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_falcon), 0, 'Falcon''s assessment is deleted');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_falcon), 0, 'Falcon''s visibility is deleted');

  -- Storm's mailbox still holds the shared message.
  perform pg_temp.expect((select count(*) from source_items where id = v_sh), 1, 'the shared item stays');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_sh), 1, 'the shared text stays');
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = v_sh), 1, 'the shared milestone stays');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_src_s), 2, 'Storm''s provenance stays');
  perform pg_temp.expect((select count(*) from routing_ledger where source_id = v_src_s), 2, 'Storm''s ledger stays');
  perform pg_temp.expect((select count(*) from discovery_thread_taints where source_id = v_src_s), 1, 'Storm''s taint stays');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cobra), 2, 'Cobra keeps both links');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_cobra), 1, 'Cobra keeps its assessment');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cobra and person_id = v_alex), 0,
    'Alex no longer counts toward Cobra''s visibility');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cobra and person_id = v_storm), 1,
    'Storm still sees Cobra');
  -- The consent record stays: it is the record of who opted in.
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_alex and withdrawn_at is not null), 1,
    'Alex''s consent row stays, withdrawn');
  raise notice 'PASS: 1 withdrawal deletes a sole holder''s mail and keeps what a colleague''s mailbox holds';
end
$$;

-- ── 2. One audit row, ids and counts only ─────────────────────────────────
do $$
declare
  v_tenant uuid := (select v from fx where k = 'tenant');
  v_alex   uuid := (select v from fx where k = 'alex');
  v_row    audit_log%rowtype;
  v_keys   text[];
begin
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant and action = 'discovery.mailbox_purged'), 1,
    'one discovery.mailbox_purged row');
  select * into v_row from audit_log where tenant_id = v_tenant and action = 'discovery.mailbox_purged';
  if v_row.actor_id is distinct from v_alex or v_row.actor_type <> 'user' then
    raise exception 'FAIL: 2 the purge row names Alex as the actor (got %, %)', v_row.actor_id, v_row.actor_type;
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(v_row.detail) k;
  if v_keys is distinct from array['candidates', 'consentId', 'corrections', 'evidence', 'heldSkipped', 'indexRows',
                                   'items', 'ledger', 'milestones', 'modelCalls', 'provenance', 'reason', 'runId',
                                   'sourceId', 'taints', 'texts'] then
    raise exception 'FAIL: 2 detail keys are ids and counts only, got %', v_keys;
  end if;
  if v_row.detail->>'sourceId' <> (select v from fx where k = 'src_a')::text
     or v_row.detail->>'consentId' <> (select id::text from mailbox_consents where user_id = v_alex)
     or v_row.detail->>'reason' <> 'withdrawn' then
    raise exception 'FAIL: 2 detail names the source, the consent and the reason, got %', v_row.detail;
  end if;
  -- a1, a2 and the hour-old orphan; their texts; a1 and a2's links, milestones and calls; Falcon.
  if v_row.detail - 'sourceId' - 'consentId' - 'reason' - 'runId' <> jsonb_build_object(
       'provenance', 3, 'ledger', 4, 'taints', 1, 'indexRows', 0, 'items', 3, 'texts', 3, 'evidence', 2,
       'milestones', 2, 'modelCalls', 2, 'candidates', 1, 'corrections', 0, 'heldSkipped', 0) then
    raise exception 'FAIL: 2 counts, got %', v_row.detail;
  end if;
  if v_row.chain_seq <= (select chain_seq from audit_log
                         where tenant_id = v_tenant and action = 'discovery.mailbox_consent_withdrawn') then
    raise exception 'FAIL: 2 the purge row follows the withdrawal row';
  end if;
  raise notice 'PASS: 2 one discovery.mailbox_purged row, ids and counts only';
end
$$;

-- ── 3. A second withdraw is a no-op ───────────────────────────────────────
do $$
declare
  v_tenant uuid := (select v from fx where k = 'tenant');
  v_items  bigint := (select count(*) from source_items where tenant_id = v_tenant);
  v_audit  bigint := (select count(*) from audit_log where tenant_id = v_tenant);
  v_alex   uuid := (select v from fx where k = 'alex');
begin
  set local role authenticated;
  perform pg_temp.act_as(v_alex);
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect((select count(*) from source_items where tenant_id = v_tenant), v_items, 'a second withdraw deletes nothing');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant), v_audit, 'a second withdraw audits nothing');
  raise notice 'PASS: 3 a second withdraw is a no-op';
end
$$;

-- ── 4. Guards, grants, and the seat-loss path ─────────────────────────────
do $$
declare
  v_tenant uuid := (select v from fx where k = 'tenant');
  v_storm  uuid := (select v from fx where k = 'storm');
  v_consent uuid := (select id from mailbox_consents where user_id = (select v from fx where k = 'storm'));
  v_denied boolean;
  v_counts jsonb;
  v_row    audit_log%rowtype;
  v_bare   uuid := gen_random_uuid();
begin
  perform pg_temp.expect((select count(*) from source_items where id = (select v from fx where k = 'fresh')), 1,
    'an in-flight orphan younger than the guard survives the purge');
  perform pg_temp.expect((select count(*) from source_items where id = (select v from fx where k = 'old')), 0,
    'an orphan older than the guard is collected by the purge');
  perform pg_temp.expect((select count(*) from source_items where id = (select v from fx where k = 'doc')), 1,
    'a document with no provenance is never collected');
  perform pg_temp.expect((select count(*) from source_items where id = (select v from fx where k = 'far')), 1,
    'another tenant''s orphan is untouched');

  -- A candidate with no link (the upsert commits one when it refuses every link) is not this run's to delete.
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name)
    values (v_bare, v_tenant, 'codename:bare', 'Project Bare');

  -- Nobody but the service role runs the collector; nobody runs the purge directly.
  set local role authenticated;
  perform pg_temp.act_as(v_storm);
  begin
    perform discovery_collect_orphans(v_tenant, interval '0');
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  if not v_denied then raise exception 'FAIL: 4 authenticated ran the collector'; end if;

  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    perform discovery_purge_mailbox(v_consent);
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL: 4 service_role ran the purge directly'; end if;
  begin
    perform discovery_purge_identifiers(v_tenant, (select v from fx where k = 'src_s'));
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL: 4 service_role ran the identifier delete directly'; end if;

  -- The service role's collector run: the guard keeps the fresh orphan, zero takes it, documents never.
  v_counts := discovery_collect_orphans(v_tenant);
  perform pg_temp.expect((v_counts->>'items')::bigint, 0, 'the default guard keeps the in-flight orphan');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_bare), 1,
    'a run deletes only the candidates its own deletions emptied');
  v_counts := discovery_collect_orphans(v_tenant, interval '0');
  perform pg_temp.expect((v_counts->>'items')::bigint, 1, 'a zero guard collects the in-flight orphan');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_bare), 0,
    'a zero-guard run (tenant end) deletes every linkless candidate');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect((select count(*) from source_items where id = (select v from fx where k = 'doc')), 1,
    'the document survives a zero-guard run');
  perform pg_temp.expect((select count(*) from source_items where id = (select v from fx where k = 'far')), 1,
    'another tenant''s orphan survives a zero-guard run');

  -- Storm loses her seat (the members route's effect, as the owner): the same trigger purges.
  update users set company_id = null, company_role = null, status = 'suspended' where id = v_storm;
  perform pg_temp.expect((select count(*) from content_sources where id = (select v from fx where k = 'src_s')), 0,
    'seat loss deletes Storm''s source');
  perform pg_temp.expect((select count(*) from source_items where tenant_id = v_tenant and kind = 'message'), 0,
    'no message is left once no mailbox holds it');
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant), 0,
    'Cobra goes with its last evidence');
  select * into v_row from audit_log
  where tenant_id = v_tenant and action = 'discovery.mailbox_purged' and detail->>'sourceId' = (select v from fx where k = 'src_s')::text;
  if v_row.detail->>'reason' <> 'seat_lost' or v_row.actor_type <> 'service' or v_row.service_identity <> 'mailbox-consent' then
    raise exception 'FAIL: 4 seat loss is audited as seat_lost by the service, got % % %',
      v_row.detail->>'reason', v_row.actor_type, v_row.service_identity;
  end if;
  raise notice 'PASS: 4 the collector keeps in-flight orphans, documents and other tenants; only the trigger purges';
end
$$;

-- ── Sections 5 to 14: a second tenant, one banker per case ───────────────
-- Each banker's mail backs one case, so each withdrawal exercises one thing.
--   alex, storm  §5-6   a shared thread (sh) and Alex's own a1; Cobra on both
--   pia          §7     Kestrel, promoted
--   hal          §8     Heron, promoted to a deal under legal hold
--   mo           §10    Survivor, with a merged child kept by a document
--   xi           §13    Mix, evidenced by a SharePoint document and Xi's mail
--   yu           §14    Ren, PinX and New lose Yu's mail; Sur names New
-- The SharePoint site source holds every document (d*).

create function pg_temp.fx(p_key text) returns uuid language sql as $$ select v from fx where k = p_key $$;

-- A seated banker of the tenant who opted in through the RPC as themselves.
create function pg_temp.banker(p_tenant uuid, p_bank uuid, p_deal uuid, p_local text)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v, 'purge2-' || p_local || '@example.test', jsonb_build_object('tenant_id', p_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = p_bank, company_role = 'member' where id = v;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
    values (p_tenant, p_local || '@bank.example', pg_temp.fx('p2_dee'), p_bank, 'member', 'accepted', 'sent', now(), v);
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
    values (p_deal, v, (select id from roles where slug = 'deal_team'), 'deal_team');
  set local role authenticated;
  perform pg_temp.act_as(v);
  perform mailbox_consent_grant();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into fx values ('p2_' || p_local, v),
    ('p2_src_' || p_local, (select id from content_sources where tenant_id = p_tenant and owner_user_id = v));
  return v;
end;
$$;

-- A stored item with its text, held by each source given. A message carries a
-- sender, a document its author.
create function pg_temp.item(p_tenant uuid, p_kind text, p_tag text, p_sent date, p_who text, p_sources uuid[],
                             p_age interval default '0')
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, drive_item_key, content_hash,
                            participants, created_at)
  values (v, p_tenant, p_kind, 'Item ' || p_tag, p_sent,
          case when p_kind = 'message' then '<' || p_tag || '@p2>' end,
          case when p_kind = 'document' then 'drive:' || p_tag end, 'h-' || p_tag,
          jsonb_build_array(jsonb_build_object('role', case when p_kind = 'document' then 'author' else 'from' end,
                                               'address', p_who)),
          now() - p_age);
  insert into source_item_texts (source_item_id, body_text) values (v, p_tag || ' body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    select v, s, p_tag || '-' || n from unnest(p_sources) with ordinality u(s, n);
  insert into fx values ('p2_' || p_tag, v);
  return v;
end;
$$;

create function pg_temp.cand(p_tenant uuid, p_tag text, p_name text, p_parties jsonb default '[]',
                             p_key text default null, p_pinned boolean default false)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess, parties, pinned,
                               first_seen_at, last_seen_at, confidence)
  values (v, p_tenant, coalesce(p_key, 'codename:' || p_tag), p_name, p_name, p_parties, p_pinned,
          '2025-01-01', '2026-12-31', 0.95);
  insert into fx values ('p2_' || p_tag, v);
  return v;
end;
$$;

-- An evidence link; a link a correction pinned is the MD's confirmed choice.
create function pg_temp.link(p_cand uuid, p_item uuid, p_pin uuid default null, p_conf numeric default 0.9)
returns void language sql as $$
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier, state, pinned_by_correction_id)
  values (p_cand, p_item, 'codename', p_conf, 'firm', case when p_pin is null then 'proposed' else 'confirmed' end, p_pin);
$$;

-- A milestone event on an item (with the model call that produced it).
create function pg_temp.event(p_tenant uuid, p_item uuid) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into model_calls (id, tenant_id, purpose, model, prompt_version, prompt_hash, source_item_id, content_hash,
                           transport, parsed, outcome)
  values (v, p_tenant, 'milestone_extract', 'recorded-model', 'v1', 'ph', p_item, 'h', 'recorded', '[]'::jsonb, 'ok');
  insert into milestone_events (id, tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, model_call_id)
  values (v, p_tenant, p_item, 'kickoff_held', current_date, 0, 10, 0.8, 'v1:recorded-model', v);
  return v;
end;
$$;

create function pg_temp.assess(p_tenant uuid, p_cand uuid, p_events uuid[]) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into stage_assessments (tenant_id, candidate_id, step_id, reason_text, evidence_event_ids, confidence,
                                 engine_version, trigger)
  values (p_tenant, p_cand, 'p1-s1', 'Kickoff held', p_events, 0.8, 'v1', 'extraction') returning id into v;
  return v;
end;
$$;

create function pg_temp.corr(p_tenant uuid, p_cand uuid, p_action text, p_before jsonb, p_after jsonb,
                             p_deal uuid default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into corrections (tenant_id, candidate_id, deal_id, actor_id, action, before, after)
  values (p_tenant, p_cand, p_deal, pg_temp.fx('p2_dee'), p_action, p_before, p_after) returning id into v;
  return v;
end;
$$;

create function pg_temp.withdraw(p_user uuid) returns void language plpgsql as $$
begin
  set local role authenticated;
  perform pg_temp.act_as(p_user);
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The discovery.mailbox_purged detail for a banker's source.
create function pg_temp.purge_row(p_local text) returns jsonb language sql as $$
  select a.detail from audit_log a
  where a.action = 'discovery.mailbox_purged' and a.detail->>'sourceId' = pg_temp.fx('p2_src_' || p_local)::text;
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

do $$
declare
  t      uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_dee  uuid := gen_random_uuid();
  v_deal uuid;
  v_site uuid;
  v_kes  uuid; v_her uuid; v_sur uuid; v_child uuid; v_mix uuid; v_ren uuid; v_pinx uuid; v_srv uuid; v_new uuid;
  v_dk   uuid; v_dh   uuid; v_c    uuid; v_rc   uuid; v_ex   uuid; v_ed   uuid;
begin
  insert into fx values ('p2_t', t), ('p2_dee', v_dee), ('p2_bank', v_bank);
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_dee, 'purge2-dee@example.test', jsonb_build_object('tenant_id', t, 'department', 'ib'));
  insert into companies (id, tenant_id, name, type) values (v_bank, t, 'Purge Two Bank', 'bank');
  update users set status = 'active', is_external = false, company_id = v_bank, company_role = 'director' where id = v_dee;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (t, 'fixture', 'fixture', 'active', '{bank.example}', v_bank);
  insert into deals (tenant_id, code, codename, bank_id) values (t, 'p2-' || t, 'Seats', v_bank) returning id into v_deal;
  insert into fx values ('p2_deal', v_deal);

  perform pg_temp.banker(t, v_bank, v_deal, n) from unnest(array['alex', 'storm', 'pia', 'hal', 'mo', 'xi', 'yu']) n;
  insert into content_sources (tenant_id, kind, address) values (t, 'sharepoint_site', 'bank.sharepoint.com:/sites/purge')
    returning id into v_site;
  insert into fx values ('p2_site', v_site);

  -- §5-6: sh is in Alex's and Storm's mailboxes; a1 in Alex's only. Cobra rests on both.
  perform pg_temp.item(t, 'message', 'sh', '2026-03-02', 'ceo@acme.example', array[pg_temp.fx('p2_src_alex'), pg_temp.fx('p2_src_storm')]);
  perform pg_temp.item(t, 'message', 'a1', '2026-03-09', 'ops@alexonly.example', array[pg_temp.fx('p2_src_alex')]);
  perform pg_temp.cand(t, 'cobra', 'Project Cobra',
    '[{"name": "Acme", "domain": "acme.example"}, {"name": "Alex Only", "domain": "alexonly.example"}]');
  perform pg_temp.link(pg_temp.fx('p2_cobra'), pg_temp.fx('p2_sh'));
  perform pg_temp.link(pg_temp.fx('p2_cobra'), pg_temp.fx('p2_a1'));
  perform pg_temp.event(t, pg_temp.fx('p2_sh'));

  -- §7: Kestrel rests on Pia's p1 and was promoted (the effect of discovery_promote_candidate).
  perform pg_temp.item(t, 'message', 'p1', '2026-03-03', 'cfo@kestrel.example', array[pg_temp.fx('p2_src_pia')]);
  v_kes := pg_temp.cand(t, 'kestrel', 'Project Kestrel');
  perform pg_temp.link(v_kes, pg_temp.fx('p2_p1'));
  insert into deals (tenant_id, code, codename, bank_id) values (t, 'p2k-' || t, 'Kestrel', v_bank) returning id into v_dk;
  update deal_candidates set discovery_state = 'confirmed', promoted_deal_id = v_dk where id = v_kes;
  perform pg_temp.assess(t, v_kes, array[pg_temp.event(t, pg_temp.fx('p2_p1'))]);
  v_c := pg_temp.corr(t, v_kes, 'promote', '{"state": "proposed"}', jsonb_build_object('dealId', v_dk), v_dk);
  insert into audit_log (tenant_id, actor_type, service_identity, action, deal_id, detail)
    values (t, 'service', 'purge-probe', 'discovery.candidate_promoted', v_dk,
            jsonb_build_object('candidateId', v_kes, 'dealId', v_dk, 'correctionId', v_c));
  insert into fx values ('p2_dk', v_dk);

  -- §8: Heron rests on Hal's h1, promoted to a deal under legal hold.
  perform pg_temp.item(t, 'message', 'h1', '2026-03-04', 'gc@heron.example', array[pg_temp.fx('p2_src_hal')]);
  v_her := pg_temp.cand(t, 'heron', 'Project Heron');
  perform pg_temp.link(v_her, pg_temp.fx('p2_h1'));
  insert into deals (tenant_id, code, codename, bank_id) values (t, 'p2h-' || t, 'Heron', v_bank) returning id into v_dh;
  update deal_candidates set discovery_state = 'confirmed', promoted_deal_id = v_dh where id = v_her;
  perform place_legal_hold(v_dh, v_dee, 'litigation');
  insert into fx values ('p2_dh', v_dh);

  -- §10: Survivor rests on Mo's m1 alone, renamed and stationed by the MD. Child was merged into it
  -- and keeps its own document.
  perform pg_temp.item(t, 'message', 'm1', '2026-03-05', 'md@survivor.example', array[pg_temp.fx('p2_src_mo')]);
  perform pg_temp.item(t, 'document', 'dc', '2026-03-05', 'jo@child.example', array[v_site]);
  v_sur := pg_temp.cand(t, 'survivor', 'Survivor (MD)', '[]', null, true);
  v_child := pg_temp.cand(t, 'child', 'Project Child');
  perform pg_temp.link(v_sur, pg_temp.fx('p2_m1'));
  perform pg_temp.link(v_child, pg_temp.fx('p2_dc'));
  perform pg_temp.corr(t, v_sur, 'rename', '{"name": "Project Survivor"}', '{"name": "Survivor (MD)"}');
  v_c := pg_temp.corr(t, v_sur, 'set_station', '{"stepId": null}', '{"stepId": "p1-s2"}');
  update deal_candidates set station_override_step_id = 'p1-s2', station_override_correction_id = v_c where id = v_sur;
  update deal_candidates set discovery_state = 'merged_into', merged_into_id = v_sur where id = v_child;
  perform pg_temp.corr(t, v_child, 'merge', '{"state": "proposed", "name": "Project Child"}',
                       jsonb_build_object('survivorId', v_sur, 'survivorName', 'Survivor (MD)'));

  -- §13: Mix rests on a site document (d1) and Xi's message (x1). An assessment cites x1's milestone,
  -- another d1's. An older document has no provenance at all.
  perform pg_temp.item(t, 'document', 'd1', '2026-02-01', 'jane@author.example', array[v_site]);
  perform pg_temp.item(t, 'message', 'x1', '2026-04-01', 'bob@mail.example', array[pg_temp.fx('p2_src_xi')]);
  perform pg_temp.item(t, 'document', 'dorphan', '2026-01-01', 'old@author.example', '{}', interval '1 hour');
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id)
    values (v_site, 'd1-1', 'h-d1', 'routed', 'codename', 0.9, gen_random_uuid()),
           (v_site, 'dc-1', 'h-dc', 'routed', 'codename', 0.9, gen_random_uuid());
  v_mix := pg_temp.cand(t, 'mix', 'Project Mix',
    '[{"name": "Author Co", "domain": "author.example"}, {"name": "Mail Co", "domain": "mail.example"}]');
  perform pg_temp.link(v_mix, pg_temp.fx('p2_d1'), null, 0.6);
  perform pg_temp.link(v_mix, pg_temp.fx('p2_x1'), null, 0.95);
  v_ex := pg_temp.event(t, pg_temp.fx('p2_x1'));
  v_ed := pg_temp.event(t, pg_temp.fx('p2_d1'));
  insert into fx values ('p2_assess_x', pg_temp.assess(t, v_mix, array[v_ex])),
                        ('p2_assess_d', pg_temp.assess(t, v_mix, array[v_ed]));

  -- §14: Yu's y1, y2, y3.
  --   Ren   d2 by reassign (pinned) + y1 routed; a reassign correction names it, a station one does not
  --   PinX  d3 by reassign (pinned) + y3 routed; renamed by the MD
  --   New   y2 alone, created by a split of Sur (cluster 'correction:<id>')
  --   Sur   d4 routed, untouched; its split correction names New
  perform pg_temp.item(t, 'message', n, '2026-05-01', 'y@yu.example', array[pg_temp.fx('p2_src_yu')])
    from unnest(array['y1', 'y2', 'y3']) n;
  perform pg_temp.item(t, 'document', n, '2026-05-02', 'kim@doc.example', array[v_site])
    from unnest(array['d2', 'd3', 'd4']) n;
  v_ren := pg_temp.cand(t, 'ren', 'Project Ren', '[{"name": "Doc Co", "domain": "doc.example"}]');
  v_pinx := pg_temp.cand(t, 'pinx', 'Falcon (MD)', '[]', null, true);
  v_srv := pg_temp.cand(t, 'sur', 'Project Sur');
  v_rc := gen_random_uuid();
  v_new := pg_temp.cand(t, 'new', 'New deal', '[]', 'correction:' || v_rc, true);
  perform pg_temp.link(v_ren, pg_temp.fx('p2_d2'), gen_random_uuid());
  perform pg_temp.link(v_ren, pg_temp.fx('p2_y1'));
  perform pg_temp.link(v_pinx, pg_temp.fx('p2_d3'), gen_random_uuid());
  perform pg_temp.link(v_pinx, pg_temp.fx('p2_y3'));
  perform pg_temp.link(v_srv, pg_temp.fx('p2_d4'));
  perform pg_temp.link(v_new, pg_temp.fx('p2_y2'), v_rc);
  insert into fx values
    ('p2_ren_reassign', pg_temp.corr(t, v_ren, 'reassign',
       jsonb_build_object('name', 'Project Ren', 'linkId', gen_random_uuid(), 'sourceItemId', gen_random_uuid()),
       jsonb_build_object('targetCandidateId', v_srv, 'targetName', 'Project Sur'))),
    ('p2_ren_station', pg_temp.corr(t, v_ren, 'set_station', '{"stepId": null}', '{"stepId": "p1-s3"}')),
    ('p2_pinx_rename', pg_temp.corr(t, v_pinx, 'rename', '{"name": "Project PinX"}', '{"name": "Falcon (MD)"}')),
    ('p2_sur_split', pg_temp.corr(t, v_srv, 'split', '{"name": "Project Sur"}',
       jsonb_build_object('newCandidateId', v_new, 'newName', 'New deal', 'itemCount', 1))),
    ('p2_sur_station', pg_temp.corr(t, v_srv, 'set_station', '{"stepId": null}', '{"stepId": "p1-s4"}'));

  perform discovery_refresh_candidate_visibility(c) from unnest(array[pg_temp.fx('p2_cobra'), v_kes, v_her, v_sur,
    v_child, v_mix, v_ren, v_pinx, v_srv, v_new]) c;
  raise notice 'PASS: fixture 5-14';
end
$$;

-- ── 5. Two bankers, a shared thread: Alex's purge keeps Storm's ──────────
do $$
declare
  t uuid := pg_temp.fx('p2_t');
  v_cobra uuid := pg_temp.fx('p2_cobra');
begin
  perform pg_temp.withdraw(pg_temp.fx('p2_alex'));
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_a1')), 0, '5 Alex''s own a1 is deleted');
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_sh')), 1, '5 the shared item stays');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = pg_temp.fx('p2_sh')), 1, '5 its text stays');
  perform pg_temp.expect((select count(*) from source_item_sources
    where source_item_id = pg_temp.fx('p2_sh') and content_source_id = pg_temp.fx('p2_src_storm')), 1, '5 Storm''s provenance stays');
  perform pg_temp.expect((select count(*) from source_item_sources where source_item_id = pg_temp.fx('p2_sh')), 1,
    '5 Alex''s provenance on the shared item is gone');
  perform pg_temp.expect((select count(*) from evidence_links where source_item_id = pg_temp.fx('p2_sh')), 1, '5 the shared evidence stays');
  perform pg_temp.expect((select count(*) from milestone_events where source_item_id = pg_temp.fx('p2_sh')), 1, '5 the shared milestone stays');
  raise notice 'PASS: 5 withdrawing Alex keeps everything Storm''s mailbox holds';
end
$$;

-- ── 6. A candidate both mailboxes back survives the first purge only ─────
do $$
declare
  v_cobra uuid := pg_temp.fx('p2_cobra');
begin
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cobra), 1, '6 Cobra survives Alex''s purge');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cobra), 1, '6 Cobra keeps only the shared link');
  perform pg_temp.expect_text((select parties::text from deal_candidates where id = v_cobra),
    '[{"name": "Acme", "domain": "acme.example"}]', '6 Cobra''s parties are rebased on the shared item');
  perform pg_temp.expect_text((select proposed_name from deal_candidates where id = v_cobra), 'Project Cobra',
    '6 a routed link keeps Cobra''s name');
  perform pg_temp.withdraw(pg_temp.fx('p2_storm'));
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_sh')), 0, '6 the shared item goes with its last mailbox');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cobra), 0, '6 Cobra goes with its last evidence');
  raise notice 'PASS: 6 a candidate is deleted only when no mailbox backs it';
end
$$;

-- ── 7. A promoted candidate: the deal stays, the mail-derived rows go ────
do $$
declare
  t     uuid := pg_temp.fx('p2_t');
  v_kes uuid := pg_temp.fx('p2_kestrel');
  v_dk  uuid := pg_temp.fx('p2_dk');
begin
  perform pg_temp.withdraw(pg_temp.fx('p2_pia'));
  perform pg_temp.expect((select count(*) from deals where id = v_dk), 1, '7 the promoted deal stays');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_kes), 0, '7 the promoted candidate is deleted');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_kes or deal_id = v_dk), 0,
    '7 its assessments are deleted');
  perform pg_temp.expect((select count(*) from corrections where deal_id = v_dk), 0, '7 its promote correction is deleted');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = t and action = 'discovery.candidate_promoted'
    and deal_id = v_dk), 1, '7 the candidate_promoted audit row stays');
  perform pg_temp.expect((pg_temp.purge_row('pia')->>'corrections')::bigint, 1, '7 the purge counts one correction');
  raise notice 'PASS: 7 a promoted deal keeps the deal and loses the candidate, its assessments and its promote correction';
end
$$;

-- ── 8. Legal hold wins, is counted, and lets go when lifted ──────────────
do $$
declare
  t      uuid := pg_temp.fx('p2_t');
  v_her  uuid := pg_temp.fx('p2_heron');
  v_h1   uuid := pg_temp.fx('p2_h1');
  v_counts jsonb;
begin
  perform pg_temp.withdraw(pg_temp.fx('p2_hal'));
  perform pg_temp.expect((select count(*) from content_sources where id = pg_temp.fx('p2_src_hal')), 0, '8 Hal''s source is detached');
  perform pg_temp.expect((select count(*) from source_items where id = v_h1), 1, '8 the held item stays');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_her), 1, '8 the held candidate stays');
  perform pg_temp.expect((pg_temp.purge_row('hal')->>'heldSkipped')::bigint, 1, '8 heldSkipped counts the held item');
  perform pg_temp.expect((pg_temp.purge_row('hal')->>'items')::bigint, 0, '8 nothing held is deleted');

  perform lift_legal_hold(pg_temp.fx('p2_dh'), pg_temp.fx('p2_dee'));
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_counts := discovery_collect_orphans(t, interval '0');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect((v_counts->>'items')::bigint, 1, '8 after the lift the collector deletes the item');
  perform pg_temp.expect((v_counts->>'candidates')::bigint, 1, '8 and the candidate');
  perform pg_temp.expect((v_counts->>'heldSkipped')::bigint, 0, '8 nothing is held any more');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_her), 0, '8 Heron is gone');
  perform pg_temp.expect((select count(*) from deals where id = pg_temp.fx('p2_dh')), 1, '8 the deal stays');
  raise notice 'PASS: 8 a legal hold keeps its evidence, counted, until it is lifted';
end
$$;

-- ── 9. The correction log opens for a purge's DELETE only ────────────────
do $$
declare
  v_corr  uuid := pg_temp.fx('p2_sur_station');
  v_state text;
begin
  -- The service role holds select and insert on corrections only, so it deletes nothing, with or
  -- without the purge switch.
  if has_table_privilege('service_role', 'corrections', 'delete') or has_table_privilege('service_role', 'corrections', 'update')
     or has_table_privilege('service_role', 'corrections', 'truncate') then
    raise exception 'FAIL: 9 service_role holds delete, update or truncate on corrections';
  end if;
  set local role service_role;
  begin
    delete from corrections where id = v_corr;
    v_state := 'ok';
  exception when insufficient_privilege then v_state := 'denied';
  end;
  perform pg_temp.expect_text(v_state, 'denied', '9 service_role cannot delete a correction');
  perform set_config('conductia.discovery_purge', 'forged', true);
  begin
    delete from corrections where id = v_corr;
    v_state := 'ok';
  exception when insufficient_privilege then v_state := 'denied';
  end;
  perform pg_temp.expect_text(v_state, 'denied', '9 the purge switch set from a client deletes nothing');
  reset role;
  -- Even the owner, under the switch, may not update or truncate.
  begin
    update corrections set reason = 'changed' where id = v_corr;
    v_state := 'ok';
  exception when raise_exception then v_state := sqlerrm;
  end;
  perform pg_temp.expect_text(v_state, 'the correction log is append-only: UPDATE is not permitted', '9 update stays refused');
  begin
    truncate corrections cascade;
    v_state := 'ok';
  exception when raise_exception then v_state := sqlerrm;
  end;
  perform pg_temp.expect_text(v_state, 'the correction log is append-only: TRUNCATE is not permitted', '9 truncate stays refused');
  perform set_config('conductia.discovery_purge', '', true);
  begin
    delete from corrections where id = v_corr;
    v_state := 'ok';
  exception when raise_exception then v_state := sqlerrm;
  end;
  perform pg_temp.expect_text(v_state, 'the correction log is append-only: DELETE is not permitted', '9 delete outside a purge stays refused');
  perform pg_temp.expect((select count(*) from corrections where id = v_corr), 1, '9 the correction is untouched');
  raise notice 'PASS: 9 only a purge deletes corrections; update and truncate stay refused';
end
$$;

-- ── 10. A deleted survivor un-merges its child ───────────────────────────
do $$
declare
  v_sur   uuid := pg_temp.fx('p2_survivor');
  v_child uuid := pg_temp.fx('p2_child');
begin
  perform pg_temp.withdraw(pg_temp.fx('p2_mo'));
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_sur), 0, '10 the survivor is deleted');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_sur), 0, '10 its corrections are deleted');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_child and discovery_state = 'proposed'
    and merged_into_id is null), 1, '10 the child is un-merged and proposed');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_child), 1, '10 the child keeps its document');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_child), 0,
    '10 the child''s merge correction, naming the deleted survivor, is deleted');
  perform pg_temp.expect((pg_temp.purge_row('mo')->>'corrections')::bigint, 3, '10 the purge counts three corrections');
  raise notice 'PASS: 10 deleting a survivor un-merges a child that keeps evidence';
end
$$;

-- ── 12. One audit row per purge, ids and counts only ─────────────────────
do $$
declare
  t uuid := pg_temp.fx('p2_t');
begin
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = t and action = 'discovery.mailbox_purged'),
    (select count(*) from mailbox_consents where tenant_id = t and withdrawn_at is not null), '12 one purge row per ended consent');
  perform pg_temp.expect((select count(*) from audit_log a where a.tenant_id = t and a.action = 'discovery.mailbox_purged'
    and (select array_agg(k order by k) from jsonb_object_keys(a.detail) k) is distinct from
        array['candidates', 'consentId', 'corrections', 'evidence', 'heldSkipped', 'indexRows', 'items', 'ledger',
              'milestones', 'modelCalls', 'provenance', 'reason', 'runId', 'sourceId', 'taints', 'texts']), 0,
    '12 every purge row holds ids and counts only');
  perform pg_temp.expect((select count(*) from audit_log a, jsonb_each(a.detail) d
    where a.tenant_id = t and a.action = 'discovery.mailbox_purged'
      and d.key not in ('sourceId', 'consentId', 'runId', 'reason') and jsonb_typeof(d.value) <> 'number'), 0,
    '12 every count is a number');
  raise notice 'PASS: 12 one discovery.mailbox_purged row per purge, ids and counts only';
end
$$;

-- ── 13. SharePoint survives; a mixed candidate loses its mail ────────────
do $$
declare
  v_site uuid := pg_temp.fx('p2_site');
  v_mix  uuid := pg_temp.fx('p2_mix');
  v_prov bigint := (select count(*) from source_item_sources where content_source_id = pg_temp.fx('p2_site'));
  v_ledg bigint := (select count(*) from routing_ledger where source_id = pg_temp.fx('p2_site'));
begin
  perform pg_temp.withdraw(pg_temp.fx('p2_xi'));
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_x1')), 0, '13 Xi''s message is deleted');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_mix), 1, '13 Mix survives on its document');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_mix), 1, '13 Mix keeps only the document link');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_mix and source_item_id = pg_temp.fx('p2_d1')), 1,
    '13 the document link stays');
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('p2_assess_x')), 0,
    '13 the assessment citing the mail milestone is deleted');
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('p2_assess_d')), 1,
    '13 the assessment citing the document milestone stays');
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_dorphan')), 1,
    '13 a document with no provenance is never collected');
  perform pg_temp.expect((select count(*) from content_sources where id = v_site), 1, '13 the site source stays');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_site), v_prov, '13 site provenance is untouched');
  perform pg_temp.expect((select count(*) from routing_ledger where source_id = v_site), v_ledg, '13 the site ledger is untouched');
  raise notice 'PASS: 13 SharePoint content survives, and a mixed candidate loses its mail evidence and mail assessment';
end
$$;

-- ── 14. Rebase: what the remaining evidence supports, and nothing more ───
do $$
declare
  v_mix  uuid := pg_temp.fx('p2_mix');
  v_ren  uuid := pg_temp.fx('p2_ren');
  v_pinx uuid := pg_temp.fx('p2_pinx');
  v_sur  uuid := pg_temp.fx('p2_sur');
  v_row  deal_candidates%rowtype;
begin
  -- Mix (from §13): the document author's domain only, the document's dates, its name kept.
  select * into v_row from deal_candidates where id = v_mix;
  perform pg_temp.expect_text(v_row.parties::text, '[{"name": "Author Co", "domain": "author.example"}]',
    '14 Mix''s parties are the document author''s domain only');
  if v_row.first_seen_at <> '2026-02-01' or v_row.last_seen_at <> '2026-02-01' or v_row.confidence <> 0.6 then
    raise exception 'FAIL: 14 Mix''s dates and confidence are the document''s, got % % %',
      v_row.first_seen_at, v_row.last_seen_at, v_row.confidence;
  end if;
  perform pg_temp.expect_text(v_row.proposed_name || '|' || v_row.codename_guess || '|' || v_row.cluster_key,
    'Project Mix|Project Mix|codename:mix', '14 a routed document link keeps Mix''s name');

  perform pg_temp.withdraw(pg_temp.fx('p2_yu'));
  -- Ren keeps only a reassign-pinned document: nothing supports its name.
  select * into v_row from deal_candidates where id = v_ren;
  perform pg_temp.expect_text(v_row.proposed_name, 'Unnamed candidate', '14 Ren''s unsupported name is neutralised');
  perform pg_temp.expect_text(coalesce(v_row.codename_guess, '<null>'), '<null>', '14 Ren''s codename guess is cleared');
  perform pg_temp.expect_text(v_row.cluster_key, 'purged:' || v_ren, '14 Ren''s cluster key cannot re-attach mail-era state');
  perform pg_temp.expect_text(v_row.parties::text, '[{"name": "Doc Co", "domain": "doc.example"}]', '14 Ren keeps the document''s party');
  perform pg_temp.expect((select count(*) from corrections where id = pg_temp.fx('p2_ren_reassign')), 0,
    '14 Ren''s name-carrying correction is deleted');
  perform pg_temp.expect((select count(*) from corrections where id = pg_temp.fx('p2_ren_station')), 1,
    '14 Ren''s station correction, which names nothing, stays');
  -- PinX: the MD typed its name, so it stays; the rename's record of the old name goes.
  select * into v_row from deal_candidates where id = v_pinx;
  perform pg_temp.expect_text(v_row.proposed_name || '|' || v_row.cluster_key, 'Falcon (MD)|purged:' || v_pinx,
    '14 an MD-typed name is kept');
  perform pg_temp.expect((select count(*) from corrections where id = pg_temp.fx('p2_pinx_rename')), 0,
    '14 the rename naming the model''s old name is deleted');
  -- New had only Yu's message: deleted. Sur, untouched, loses the split correction that named it.
  perform pg_temp.expect((select count(*) from deal_candidates where id = pg_temp.fx('p2_new')), 0, '14 New is deleted');
  perform pg_temp.expect((select count(*) from corrections where id = pg_temp.fx('p2_sur_split')), 0,
    '14 a surviving candidate''s correction naming a deleted candidate is deleted');
  perform pg_temp.expect((select count(*) from corrections where id = pg_temp.fx('p2_sur_station')), 1,
    '14 Sur''s other correction stays');
  perform pg_temp.expect_text((select proposed_name || '|' || cluster_key from deal_candidates where id = v_sur),
    'Project Sur|codename:sur', '14 Sur itself is untouched');
  raise notice 'PASS: 14 survivors are rebased on their remaining evidence; unsupported names and the corrections naming them go';
end
$$;

-- ── 15. Group removal withdraws after the grace, on a fresh check ────────
-- gw joined the group and was then removed: it qualifies. gv consented and was
-- never added (the group setup may take days): it is never withdrawn. gs's
-- absence is stale (no check within the hour); gn is inside the grace; gp is
-- missing from the other provider's group only; gr is re-added; gu is reported
-- only by an unavailable check; go has a sighting that does not precede its
-- absence. The breaker holds every due consent under the pilot default and more
-- than 30% of the open ones, at least 3, under the general rule. A check records
-- a sighting from p_present (the addresses it saw in the group), never from the
-- allowlist minus the missing.
do $$
declare
  t      uuid := pg_temp.fx('p2_t');
  v_gw   uuid;
  v_gs   uuid;
  v_n    integer;
  v_seen timestamptz;
  v_denied boolean;
  v_row  jsonb;
begin
  perform pg_temp.banker(t, pg_temp.fx('p2_bank'), pg_temp.fx('p2_deal'), n)
  from unnest(array['gw', 'gs', 'gn', 'gp', 'gr', 'gu', 'gv', 'go']) n;
  perform pg_temp.item(t, 'message', 'g1', '2026-05-01', 'x@grp.example', array[pg_temp.fx('p2_src_gw')]);
  v_gw := pg_temp.fx('p2_gw');
  v_gs := pg_temp.fx('p2_gs');

  -- First check: gv is not in the group yet; the others are. A sighting is a row with nothing missing.
  perform discovery_record_allowlist_drift(t, 'microsoft', 'drift', array['gv@bank.example'], '{}',
    array['GW@bank.example', 'gs@bank.example', 'gn@bank.example', 'gr@bank.example', 'gp@bank.example', 'go@bank.example']);
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t), 6,
    '15 a successful check records a sighting for each address it saw in the group');
  perform pg_temp.expect((select count(*) from mailbox_group_absence
                          where tenant_id = t and missing_since is null and last_seen_missing is null), 6,
    '15 a sighting has no absence');
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address = 'gv@bank.example'), 0,
    '15 an address never seen in the group gets no row');

  -- gw, gs, gn, gr and go go missing; gv still is. gv still gets no row.
  perform discovery_record_allowlist_drift(t, 'microsoft', 'drift',
    array['gw@bank.example', 'gs@bank.example', 'gn@bank.example', 'gr@bank.example', 'go@bank.example', 'gv@bank.example'], '{}',
    array['gp@bank.example']);
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and missing_since is not null), 5,
    '15 a successful check records the absence of each address it had seen');
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address = 'gv@bank.example'), 0,
    '15 a missing address that was never seen still gets no row');

  -- An unavailable check is no evidence: it neither creates a sighting nor refreshes an absence.
  update mailbox_group_absence set last_seen_missing = now() - interval '2 hours'
   where tenant_id = t and address = 'gw@bank.example';
  perform discovery_record_allowlist_drift(t, 'microsoft', 'unavailable', array['gu@bank.example', 'gw@bank.example'], '{}',
    array['gu@bank.example', 'gv@bank.example']);
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address in ('gu@bank.example', 'gv@bank.example')), 0,
    '15 an unavailable check creates no sighting');
  select last_seen_missing into v_seen from mailbox_group_absence where tenant_id = t and address = 'gw@bank.example';
  if v_seen <> now() - interval '2 hours' then
    raise exception 'FAIL: 15 an unavailable check refreshed an absence';
  end if;

  -- A sighting is a fact about the allowlist as it is now: an address no consent allows leaves no row.
  perform discovery_record_allowlist_drift(t, 'microsoft', 'in_sync', '{}', '{}', array['stranger@bank.example']);
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address = 'stranger@bank.example'), 0,
    '15 a member no consent allows gets no sighting');

  -- gr is back in the group: it is present again. The others are seen missing again, missing_since kept.
  update mailbox_group_absence set missing_since = now() - interval '5 days' where tenant_id = t and address = 'gw@bank.example';
  perform discovery_record_allowlist_drift(t, 'microsoft', 'drift',
    array['gw@bank.example', 'gs@bank.example', 'gn@bank.example', 'go@bank.example', 'gv@bank.example'], '{}',
    array['gr@bank.example', 'gp@bank.example']);
  perform pg_temp.expect((select count(*) from mailbox_group_absence
                          where tenant_id = t and address = 'gr@bank.example'
                            and missing_since is null and last_seen_missing is null), 1,
    '15 a re-added address is present again');
  select last_seen_missing into v_seen from mailbox_group_absence where tenant_id = t and address = 'gw@bank.example';
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address = 'gw@bank.example'
                            and missing_since = now() - interval '5 days' and last_seen_missing = now()), 1,
    '15 a later check keeps missing_since and refreshes last_seen_missing');

  -- Back-date what the sightings and absences would have been: every sighting is old, every absence follows its sighting.
  update mailbox_group_absence set first_seen_in_group = now() - interval '200 hours' where tenant_id = t;
  update mailbox_group_absence set missing_since = now() - interval '100 hours', last_seen_missing = now() - interval '2 hours'
   where tenant_id = t and address = 'gs@bank.example';
  update mailbox_group_absence set missing_since = now() - interval '10 hours' where tenant_id = t and address = 'gn@bank.example';
  -- go: a sighting that comes after the absence is no sighting before it.
  update mailbox_group_absence set first_seen_in_group = now() - interval '1 hour', missing_since = now() - interval '100 hours'
   where tenant_id = t and address = 'go@bank.example';
  -- gp's source is a Microsoft one: an old, fresh absence from the Google group never withdraws it.
  insert into mailbox_group_absence (tenant_id, provider, address, first_seen_in_group, missing_since, last_seen_missing)
    values (t, 'google', 'gp@bank.example', now() - interval '200 hours', now() - interval '100 hours', now());

  -- Only the service role runs the withdrawal.
  set local role authenticated;
  perform pg_temp.act_as(v_gw);
  begin
    perform discovery_withdraw_group_removed();
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if not v_denied then raise exception 'FAIL: 15 authenticated ran the group-removal withdrawal'; end if;

  -- The pilot rule is the default (owner, 2026-10-17): even one due consent is held for the operator. Rolled back.
  begin
    set local role service_role;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_row := discovery_withdraw_group_removed();
    reset role;
    perform set_config('request.jwt.claims', '', true);
    -- gw has been missing 120 hours: due 48 hours ago, so the hold is overdue (unreleased past 24 hours).
    if v_row <> jsonb_build_object('held', 1, 'withdrawn', 0,
                                   'holds', jsonb_build_array(jsonb_build_object('tenant', t, 'due', 1, 'overdue', true))) then
      raise exception 'FAIL: 15 the pilot default holds a single due consent, overdue past 24 hours, got %', v_row;
    end if;
    perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_gw and withdrawn_at is null), 1,
      '15 under the pilot default gw''s consent stays open');
    raise exception 'probe_rollback';
  exception when raise_exception then
    if sqlerrm <> 'probe_rollback' then raise; end if;
  end;

  -- The general rule (30%, at least 3): one due consent is withdrawn.
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_n := (discovery_withdraw_group_removed(p_max_share => 0.3, p_min_due => 3)->>'withdrawn')::integer;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect(v_n, 1, '15 one consent withdrawn');
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_gw and withdrawn_at is null), 0,
    '15 gw''s consent is withdrawn');
  perform pg_temp.expect((select count(*) from content_sources where id = pg_temp.fx('p2_src_gw')), 0, '15 gw''s source is purged');
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_g1')), 0, '15 gw''s sole-held mail is deleted');
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address = 'gw@bank.example'), 0,
    '15 the purge deletes gw''s absence row');
  perform pg_temp.expect((select count(*) from mailbox_consents
                          where user_id in (pg_temp.fx('p2_gs'), pg_temp.fx('p2_gn'), pg_temp.fx('p2_gp'), pg_temp.fx('p2_gr'),
                                            pg_temp.fx('p2_gu'), pg_temp.fx('p2_go'))
                            and withdrawn_at is null), 6,
    '15 a stale absence, one inside the grace, one under the other provider, a present one, a never-checked one and a sighting after the absence withdraw nothing');
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = pg_temp.fx('p2_gv') and withdrawn_at is null), 1,
    '15 a consent whose address was never seen in the group is never withdrawn');
  v_row := pg_temp.purge_row('gw');
  if v_row->>'reason' <> 'group_removed' or (v_row->>'items')::int <> 1 then
    raise exception 'FAIL: 15 the purge row says group_removed and one item, got %', v_row;
  end if;
  perform pg_temp.expect((select count(*) from audit_log
                          where tenant_id = t and action = 'discovery.mailbox_consent_withdrawn'
                            and detail->>'reason' = 'group_removed' and actor_type = 'service'), 1,
    '15 the withdrawal is audited as group_removed by the service');

  -- The withdraw RPC returns what its purge deleted, and null when there was no source to purge.
  set local role authenticated;
  perform pg_temp.act_as(v_gs);
  v_row := mailbox_consent_withdraw();
  if (mailbox_consent_withdraw())->'purged' is distinct from 'null'::jsonb then
    raise exception 'FAIL: 15 a second withdraw returns purged null';
  end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if v_row->>'consented' <> 'false' or v_row->'purged'->>'provenance' <> '0' or v_row->'purged' ? 'runId'
     or (select array_agg(k order by k) from jsonb_object_keys(v_row->'purged') k)
        <> array['candidates', 'corrections', 'evidence', 'heldSkipped', 'indexRows', 'items', 'ledger', 'milestones',
                 'modelCalls', 'provenance', 'taints', 'texts'] then
    raise exception 'FAIL: 15 the withdraw RPC returns its purge counts, got %', v_row;
  end if;

  -- gw consents again after the purge. The purge took its sighting, so being missing from the group is not
  -- enough: the address is withdrawn only after a fresh check sees it in the group and then not.
  set local role authenticated;
  perform pg_temp.act_as(v_gw);
  perform mailbox_consent_grant();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform discovery_record_allowlist_drift(t, 'microsoft', 'drift', array['gw@bank.example'], '{}', '{}');
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address = 'gw@bank.example'), 0,
    '15 a re-consent has no sighting, so a missing check records nothing');
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_n := (discovery_withdraw_group_removed(p_max_share => 0.3, p_min_due => 3)->>'withdrawn')::integer;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect(v_n, 0, '15 nothing is withdrawn for the re-consent that was never seen in the group');
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_gw and withdrawn_at is null), 1,
    '15 the re-consent stays open');
  perform discovery_record_allowlist_drift(t, 'microsoft', 'in_sync', '{}', '{}', array['gw@bank.example']);
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = t and address = 'gw@bank.example'
                            and missing_since is null), 1,
    '15 a fresh check that sees the re-consent in the group records its sighting');

  -- The breaker: gn and go both qualify at once. Under the pilot default they are held, nothing is withdrawn, one
  -- audit row a day; an operator's p_max_share => 1 releases them. Rolled back, so the later tests see the tenant as
  -- it was. Missing 80 hours, they fell due 8 hours ago: held, not overdue.
  begin
    update mailbox_group_absence
       set first_seen_in_group = now() - interval '200 hours', missing_since = now() - interval '80 hours',
           last_seen_missing = now()
     where tenant_id = t and address in ('gn@bank.example', 'go@bank.example');
    set local role service_role;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_row := discovery_withdraw_group_removed();
    perform discovery_withdraw_group_removed();
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if v_row <> jsonb_build_object('held', 1, 'withdrawn', 0,
                                   'holds', jsonb_build_array(jsonb_build_object('tenant', t, 'due', 2, 'overdue', false))) then
      raise exception 'FAIL: 15 two due consents are held under the pilot default, not overdue, got %', v_row;
    end if;
    perform pg_temp.expect((select count(*) from mailbox_consents
                            where user_id in (pg_temp.fx('p2_gn'), pg_temp.fx('p2_go')) and withdrawn_at is null), 2,
      '15 a held tenant keeps its consents');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = t and action = 'discovery.group_removal_held'), 1,
      '15 a hold is audited once a day');
    -- The hold's age is its oldest due consent's: gn missing 97 hours fell due 25 hours ago, so the hold is overdue.
    update mailbox_group_absence set missing_since = now() - interval '97 hours'
     where tenant_id = t and address = 'gn@bank.example';
    set local role service_role;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_row := discovery_withdraw_group_removed();
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if v_row->'holds' <> jsonb_build_array(jsonb_build_object('tenant', t, 'due', 2, 'overdue', true)) then
      raise exception 'FAIL: 15 a hold unreleased 24 hours past due is overdue, got %', v_row;
    end if;
    set local role service_role;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_row := discovery_withdraw_group_removed(p_max_share => 1);
    reset role;
    perform set_config('request.jwt.claims', '', true);
    perform pg_temp.expect((v_row->>'withdrawn')::bigint, 2, '15 the operator''s release withdraws them');
    raise exception 'probe_rollback';
  exception when raise_exception then
    if sqlerrm <> 'probe_rollback' then raise; end if;
  end;

  -- The rule's arithmetic (owner, 2026-10-17): the general rule holds more than 30% of the open consents, and at
  -- least 3; the pilot holds every one; the operator's release holds none.
  if discovery_group_removal_holds(2, 4, 0.3, 3) then raise exception 'FAIL: 15 2 of 4 due trips the general rule'; end if;
  if not discovery_group_removal_holds(3, 4, 0.3, 3) then raise exception 'FAIL: 15 3 of 4 due does not trip the general rule'; end if;
  if discovery_group_removal_holds(3, 10, 0.3, 3) then raise exception 'FAIL: 15 exactly 30%% trips the general rule'; end if;
  if not discovery_group_removal_holds(4, 10, 0.3, 3) then raise exception 'FAIL: 15 4 of 10 due does not trip the general rule'; end if;
  if discovery_group_removal_holds(2, 2, 0.3, 3) then raise exception 'FAIL: 15 2 of 2 due trips the general rule'; end if;
  if not discovery_group_removal_holds(1, 40, 0, 1) then raise exception 'FAIL: 15 the pilot rule lets one withdrawal through'; end if;
  if discovery_group_removal_holds(4, 4, 1, 1) then raise exception 'FAIL: 15 the operator''s release holds'; end if;
  raise notice 'PASS: 15 group removal withdraws only a seen address, after the grace, on a fresh check, under the source''s provider';
end
$$;

-- ── 16. The backstop collects orphans in every tenant ────────────────────
do $$
declare
  t       uuid := pg_temp.fx('p2_t');
  v_old   uuid;
  v_fresh uuid;
  v_audit bigint;
  v_denied boolean;
  v_row   audit_log%rowtype;
  v_gn    uuid := pg_temp.fx('p2_gn');
begin
  -- A late page's items: written, then refused their provenance when the source was purged.
  v_old := pg_temp.item(t, 'message', 'late-old', '2026-05-02', 'x@late.example', '{}', interval '1 hour');
  v_fresh := pg_temp.item(t, 'message', 'late-new', '2026-05-03', 'x@late.example', '{}');

  set local role authenticated;
  perform pg_temp.act_as(v_gn);
  begin
    perform discovery_collect_orphans_all();
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if not v_denied then raise exception 'FAIL: 16 authenticated ran the backstop'; end if;

  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_collect_orphans_all();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect((select count(*) from source_items where id = v_old), 0, '16 the old orphan is collected');
  perform pg_temp.expect((select count(*) from source_items where id = v_fresh), 1, '16 the in-flight orphan is kept');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = t and action = 'discovery.content_collected'), 1,
    '16 one discovery.content_collected row');
  select * into v_row from audit_log where tenant_id = t and action = 'discovery.content_collected';
  if v_row.actor_type <> 'service' or v_row.service_identity <> 'discovery-worker' or (v_row.detail->>'items')::int <> 1
     or (select array_agg(k order by k) from jsonb_object_keys(v_row.detail) k)
        <> array['candidates', 'corrections', 'evidence', 'heldSkipped', 'indexRows', 'items', 'milestones',
                 'modelCalls', 'runId', 'texts'] then
    raise exception 'FAIL: 16 the row is the worker''s, ids and counts only, got % %', v_row.service_identity, v_row.detail;
  end if;

  v_audit := (select count(*) from audit_log where tenant_id = t);
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform discovery_collect_orphans_all();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = t), v_audit, '16 nothing to collect audits nothing');
  raise notice 'PASS: 16 the backstop collects old orphans per tenant and audits each run that deleted something';
end
$$;

-- ── 17. The message index ───────────────────────────────────────────────
-- ia holds ix (shared with ib), iy and iz, and read iu unrouted (no item).
-- Ixion rests on ix and iy; Ilex on iz, promoted to a deal under legal hold.
do $$
declare
  t      uuid := pg_temp.fx('p2_t');
  v_ia   uuid;
  v_sa   uuid;
  v_sb   uuid;
  v_ix   uuid;
  v_ixion uuid;
  v_ilex uuid;
  v_dil  uuid;
  v_n    integer;
  v_seen timestamptz;
  v_state text;
  v_gone uuid := pg_temp.fx('p2_src_gw');
begin
  perform pg_temp.banker(t, pg_temp.fx('p2_bank'), pg_temp.fx('p2_deal'), n) from unnest(array['ia', 'ib']) n;
  v_ia := pg_temp.fx('p2_ia');
  v_sa := pg_temp.fx('p2_src_ia');
  v_sb := pg_temp.fx('p2_src_ib');
  v_ix := pg_temp.item(t, 'message', 'ix', '2026-06-01', 'x@ix.example', array[v_sa, v_sb]);
  perform pg_temp.item(t, 'message', 'iy', '2026-06-02', 'y@ix.example', array[v_sa]);
  perform pg_temp.item(t, 'message', 'iz', '2026-06-03', 'z@il.example', array[v_sa]);
  v_ixion := pg_temp.cand(t, 'ixion', 'Project Ixion');
  perform pg_temp.link(v_ixion, v_ix);
  perform pg_temp.link(v_ixion, pg_temp.fx('p2_iy'));
  v_ilex := pg_temp.cand(t, 'ilex', 'Project Ilex');
  perform pg_temp.link(v_ilex, pg_temp.fx('p2_iz'));
  insert into deals (tenant_id, code, codename, bank_id) values (t, 'p2i-' || t, 'Ilex', pg_temp.fx('p2_bank'))
    returning id into v_dil;
  update deal_candidates set discovery_state = 'confirmed', promoted_deal_id = v_dil where id = v_ilex;
  perform place_legal_hold(v_dil, pg_temp.fx('p2_dee'), 'litigation');

  -- Only the service role writes the index, and only for the tenant's live mailbox source.
  set local role authenticated;
  perform pg_temp.act_as(v_ia);
  begin
    perform discovery_message_index_record(t, v_sa, '[]');
    v_state := 'ran';
  exception when insufficient_privilege then
    v_state := 'denied';
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if v_state <> 'denied' then raise exception 'FAIL: 17 authenticated wrote the index'; end if;

  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_n := discovery_message_index_record(t, v_sa, jsonb_build_array(
    jsonb_build_object('provider_item_id', 'ix-1', 'internet_message_id', '<ix@p2>', 'sent_at', '2026-06-01',
                       'content_digest', pg_temp.dg('h-old'), 'tags', jsonb_build_array('mnpi'), 'rules_version', 'rules-x'),
    jsonb_build_object('provider_item_id', 'iy-1', 'internet_message_id', '<iy@p2>', 'content_digest', pg_temp.dg('h-iy'),
                       'rules_version', 'rules-x'),
    -- A copy of iy in the same page: the same Message-ID under a second provider id.
    jsonb_build_object('provider_item_id', 'iy-1b', 'internet_message_id', '<iy@p2>', 'content_digest', pg_temp.dg('h-iy'),
                       'rules_version', 'rules-x'),
    jsonb_build_object('provider_item_id', 'iz-1', 'internet_message_id', '<iz@p2>', 'content_digest', pg_temp.dg('h-iz'),
                       'rules_version', 'rules-x'),
    jsonb_build_object('provider_item_id', 'iu-1', 'internet_message_id', '<iu@p2>', 'content_digest', pg_temp.dg('h-iu'),
                       'rules_version', 'rules-x')));
  perform pg_temp.expect(v_n, 4, '17 one row per message, the in-page copy collapsed');
  select processed_at into v_seen from discovery_message_index where content_source_id = v_sa and 'ix-1' = any(provider_item_ids);
  -- A later read of the same sighting refreshes its row in place.
  perform discovery_message_index_record(t, v_sa, jsonb_build_array(
    jsonb_build_object('provider_item_id', 'ix-1', 'internet_message_id', '<ix@p2>', 'sent_at', '2026-06-01',
                       'content_digest', pg_temp.dg('h-ix'), 'tags', jsonb_build_array('mnpi', 'promissory'), 'rules_version', 'rules-y')));
  perform discovery_message_index_record(t, v_sb, jsonb_build_array(
    jsonb_build_object('provider_item_id', 'ix-2', 'internet_message_id', '<ix@p2>', 'content_digest', pg_temp.dg('h-ix'),
                       'rules_version', 'rules-y')));
  -- The copy of ix arrives in a later page, in ia's mailbox: the same row, now holding both provider ids.
  perform discovery_message_index_record(t, v_sa, jsonb_build_array(
    jsonb_build_object('provider_item_id', 'ix-1c', 'internet_message_id', '<ix@p2>', 'content_digest', pg_temp.dg('h-ix'),
                       'tags', jsonb_build_array('mnpi', 'promissory'), 'rules_version', 'rules-y')));
  -- No Message-ID, no row.
  v_n := discovery_message_index_record(t, v_sa, jsonb_build_array(
    jsonb_build_object('provider_item_id', 'no-id', 'content_digest', pg_temp.dg('h'), 'rules_version', 'r'),
    jsonb_build_object('provider_item_id', 'blank-id', 'internet_message_id', '  ', 'content_digest', pg_temp.dg('h'), 'rules_version', 'r')));
  perform pg_temp.expect(v_n, 0, '17 a sighting without a Message-ID is not indexed');
  begin
    perform discovery_message_index_record(t, v_gone, '[]');
    v_state := 'ran';
  exception when sqlstate 'P0001' then
    v_state := sqlerrm;
  end;
  if v_state <> 'source_archived' then raise exception 'FAIL: 17 a purged source was indexed (%)', v_state; end if;
  begin
    perform discovery_message_index_record(t, v_sa, jsonb_build_array(jsonb_build_object(
      'provider_item_id', 'iv-1', 'internet_message_id', '<iv@p2>', 'content_digest', pg_temp.dg('h'), 'rules_version', 'r',
      'tags', jsonb_build_array('mnpi: walk-away'))));
    v_state := 'ran';
  exception when check_violation then
    v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL: 17 a tag carrying a term was stored'; end if;
  -- The digest is keyed (owner, 2026-10-17): an unsalted sha256 hex, or text, is refused.
  foreach v_state in array array[encode(sha256(convert_to('h', 'UTF8')), 'hex'), 'hmac-sha256:Project Falcon'] loop
    begin
      perform discovery_message_index_record(t, v_sa, jsonb_build_array(jsonb_build_object(
        'provider_item_id', 'iw-1', 'internet_message_id', '<iw@p2>', 'content_digest', v_state, 'rules_version', 'r')));
      raise exception 'FAIL: 17 an unkeyed or text digest was stored';
    exception when check_violation then
      null;
    end;
  end loop;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  perform pg_temp.expect((select count(*) from discovery_message_index where content_source_id = v_sa), 4,
    '17 the refresh adds no row');
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where content_source_id = v_sa and provider_item_ids = '{ix-1,ix-1c}' and content_digest = pg_temp.dg('h-ix')
                            and tags = '{mnpi,promissory}' and rules_version = 'rules-y' and processed_at >= v_seen
                            and message_key = '4d9cdc623861466ff4e82fbe2f20592e649cfd40d56ca0d55d4d7e6375dc8cb4'), 1,
    '17 one row for the message and its copy, refreshed; its key is #460''s messageKey of the Message-ID');
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where content_source_id = v_sa and provider_item_ids = '{iy-1,iy-1b}'), 1,
    '17 a copy in the same page is one row with both provider ids');
  perform pg_temp.expect((select count(*) from discovery_message_index where message_key = encode(sha256(convert_to('<ix@p2>', 'UTF8')), 'hex')
                                                                       and content_source_id in (v_sa, v_sb)), 2,
    '17 the same message in two mailboxes is two rows');

  -- The link: candidate and deal from the evidence; the unrouted sighting has none.
  set local role service_role;
  perform discovery_message_index_link(t);
  reset role;
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where message_key in (encode(sha256(convert_to('<ix@p2>', 'UTF8')), 'hex'), encode(sha256(convert_to('<iy@p2>', 'UTF8')), 'hex')) and candidate_id = v_ixion and deal_id is null), 3,
    '17 the shared and the sole message link to Ixion, the copied one included');
  -- The provenance keeps one provider id per mailbox (ix-1); the row that also holds ix-1c is linked all the same.
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where content_source_id = v_sa and 'ix-1c' = any(provider_item_ids) and candidate_id = v_ixion), 1,
    '17 a message with two provider ids in one mailbox gets its link');
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where 'iz-1' = any(provider_item_ids) and candidate_id = v_ilex and deal_id = v_dil), 1,
    '17 iz links to Ilex and its deal');
  perform pg_temp.expect((select count(*) from discovery_message_index where 'iu-1' = any(provider_item_ids) and candidate_id is null), 1,
    '17 the unrouted sighting links to nothing');

  -- ia withdraws: their rows go, but the one a held deal needs.
  perform pg_temp.withdraw(v_ia);
  perform pg_temp.expect((select count(*) from discovery_message_index where content_source_id = v_sa), 1,
    '17 ia''s rows go but the held one');
  perform pg_temp.expect((pg_temp.purge_row('ia')->>'indexRows')::bigint, 3, '17 the purge counts the index rows it deleted');
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where content_source_id = v_sb and 'ix-2' = any(provider_item_ids) and candidate_id = v_ixion), 1,
    '17 ib''s row of the shared message stays, linked');

  -- The hold lifts: the collector takes iz and Ilex; the row keeps the deal.
  perform lift_legal_hold(v_dil, pg_temp.fx('p2_dee'));
  set local role service_role;
  perform discovery_collect_orphans(t, interval '0');
  reset role;
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_ilex), 0, '17 Ilex goes with iz');
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where 'iz-1' = any(provider_item_ids) and candidate_id is null and deal_id = v_dil), 1,
    '17 the row keeps its deal once the candidate is gone');
  raise notice 'PASS: 17 the message index is written per message and mailbox, linked, and deleted with the banker''s mailbox';
end
$$;

-- ── 18. The retention policy ────────────────────────────────────────────
-- ka and kb each hold one message, read with one more unrouted (index only).
do $$
declare
  t       uuid := pg_temp.fx('p2_t');
  v_ka    uuid;
  v_kb    uuid;
  v_state text;
  v_row   jsonb;
  v_audit audit_log%rowtype;
  v_src   uuid;
  v_kbc   uuid;
  v_sees  boolean;
begin
  v_row := to_jsonb(tenant_retention_policy(t));
  if v_row - 'tenant_id' - 'updated_by' - 'updated_at' <> '{"lifecycle": "pilot", "content_on_disconnect": "delete",
       "index_on_disconnect": "delete", "index_at_tenant_end": "export_then_delete"}'::jsonb then
    raise exception 'FAIL: 18 a missing row reads as the pilot values, got %', v_row;
  end if;
  perform pg_temp.banker(t, pg_temp.fx('p2_bank'), pg_temp.fx('p2_deal'), n) from unnest(array['ka', 'kb']) n;
  v_ka := pg_temp.fx('p2_ka');
  v_kb := pg_temp.fx('p2_kb');
  perform pg_temp.item(t, 'message', 'k1', '2026-07-01', 'k@k.example', array[pg_temp.fx('p2_src_ka')]);
  perform pg_temp.item(t, 'message', 'k2', '2026-07-02', 'k@k.example', array[pg_temp.fx('p2_src_kb')]);
  perform discovery_message_index_record(t, pg_temp.fx('p2_src_' || n), jsonb_build_array(
    jsonb_build_object('provider_item_id', n || '-1', 'internet_message_id', '<' || m || '@p2>', 'content_digest', pg_temp.dg('h'),
                       'rules_version', 'r'),
    jsonb_build_object('provider_item_id', n || '-u', 'internet_message_id', '<' || n || '-u@p2>', 'content_digest', pg_temp.dg('h'),
                       'rules_version', 'r')))
  from (values ('ka', 'k1'), ('kb', 'k2')) as v(n, m);

  -- A row written with no choice holds the pilot values, as a missing row reads.
  set local role service_role;
  perform tenant_retention_policy_set(t, 'ops', 'review 0');
  reset role;
  v_row := to_jsonb(tenant_retention_policy(t));
  if v_row - 'tenant_id' - 'updated_by' - 'updated_at' <> tenant_retention_pilot_policy() then
    raise exception 'FAIL: 18 a row written with no choice holds the pilot values, got %', v_row;
  end if;

  -- Only the setter writes the policy: not a member, not a direct service_role write.
  set local role authenticated;
  perform pg_temp.act_as(v_ka);
  begin
    perform tenant_retention_policy_set(t, 'ka', 'mine', p_index_on_disconnect => 'keep');
    v_state := 'ran';
  exception when insufficient_privilege then
    v_state := 'denied';
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if v_state <> 'denied' then raise exception 'FAIL: 18 authenticated wrote the policy'; end if;
  set local role service_role;
  begin
    update tenant_retention_policies set index_on_disconnect = 'keep', updated_by = 'ops' where tenant_id = t;
    v_state := 'ran';
  exception when insufficient_privilege then
    v_state := 'denied';
  end;
  if v_state <> 'denied' then raise exception 'FAIL: 18 service_role wrote the policy table directly'; end if;
  -- The operator and the reason are required; the database refuses a value outside its choices.
  begin
    perform tenant_retention_policy_set(t, 'ops', ' ', p_index_on_disconnect => 'keep');
    v_state := 'ran';
  exception when invalid_parameter_value then
    v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL: 18 a policy write without a reason ran'; end if;
  begin
    perform tenant_retention_policy_set(t, null, 'review', p_index_on_disconnect => 'keep');
    v_state := 'ran';
  exception when invalid_parameter_value then
    v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL: 18 a policy write without an operator ran'; end if;
  begin
    perform tenant_retention_policy_set(t, 'ops', 'review', p_content_on_disconnect => 'archive');
    v_state := 'ran';
  exception when check_violation then
    v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL: 18 a bad policy value was stored'; end if;
  perform tenant_retention_policy_set(t, 'ops', 'review 1', p_index_on_disconnect => 'keep');
  reset role;
  if (select count(*) from audit_log where tenant_id = t and action = 'discovery.retention_policy_set') <> 2
     or (select detail->'old' from audit_log where tenant_id = t and action = 'discovery.retention_policy_set'
         order by chain_seq limit 1) <> 'null'::jsonb then
    raise exception 'FAIL: 18 one audit row per write, the first with old null';
  end if;
  select * into v_audit from audit_log where tenant_id = t and action = 'discovery.retention_policy_set'
  order by chain_seq desc limit 1;
  if v_audit.actor_type <> 'service' or v_audit.service_identity <> 'ops'
     or v_audit.detail->>'operator' <> 'ops' or v_audit.detail->>'reason' <> 'review 1'
     or v_audit.detail->'old'->>'index_on_disconnect' <> 'delete'
     or v_audit.detail->'new' <> '{"lifecycle": "pilot", "content_on_disconnect": "delete", "index_on_disconnect": "keep",
          "index_at_tenant_end": "export_then_delete", "updated_by": "ops"}'::jsonb then
    raise exception 'FAIL: 18 the write is audited with its operator as actor, the reason, old and new, got % %',
      v_audit.service_identity, v_audit.detail;
  end if;

  -- Index kept on disconnect: ka's content goes, ka's index rows stay, and the backstop keeps them.
  perform pg_temp.withdraw(v_ka);
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_k1')), 0, '18 ka''s message goes');
  perform pg_temp.expect((select count(*) from discovery_message_index where content_source_id = pg_temp.fx('p2_src_ka')), 2,
    '18 ka''s index rows stay under index_on_disconnect keep');
  perform pg_temp.expect((pg_temp.purge_row('ka')->>'indexRows')::bigint, 0, '18 the purge deleted no index row');
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where content_source_id = pg_temp.fx('p2_src_ka') and orphaned_by = 'disconnect'), 2,
    '18 ka''s kept index rows are marked for the backstop');
  set local role service_role;
  perform discovery_collect_orphans_all();
  reset role;
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where content_source_id in (pg_temp.fx('p2_src_ka'), pg_temp.fx('p2_src_ia'))), 3,
    '18 the backstop keeps rows whose mailbox is gone under keep');

  -- Back to delete (a second audit row): the backstop deletes them, §17's lifted-hold row too, and counts them.
  set local role service_role;
  perform tenant_retention_policy_set(t, 'ops', 'review 2', p_index_on_disconnect => 'delete');
  reset role;
  if (select detail->'old'->>'index_on_disconnect' || '>' || (detail->'new'->>'index_on_disconnect')
      from audit_log where tenant_id = t and action = 'discovery.retention_policy_set' order by chain_seq desc limit 1)
     <> 'keep>delete' then
    raise exception 'FAIL: 18 the update is audited with the old and new values';
  end if;
  set local role service_role;
  v_row := discovery_collect_orphans_all();
  reset role;
  perform pg_temp.expect((select count(*) from discovery_message_index
                          where content_source_id in (pg_temp.fx('p2_src_ka'), pg_temp.fx('p2_src_ia'))), 0,
    '18 the backstop deletes index rows whose mailbox is gone');
  perform pg_temp.expect((v_row->>'indexRows')::bigint, 3, '18 the backstop counts them');
  perform pg_temp.expect((select (detail->>'indexRows')::bigint from audit_log
                          where tenant_id = t and action = 'discovery.content_collected' order by chain_seq desc limit 1), 3,
    '18 its content_collected row counts them');
  perform pg_temp.expect((select count(*) from discovery_message_index where content_source_id = pg_temp.fx('p2_src_kb')), 2,
    '18 a live mailbox''s rows stay');

  -- A candidate kb's message evidences: kb sees it while the consent is open.
  v_kbc := pg_temp.cand(t, 'kbc', 'Project Kestrel B');
  perform pg_temp.link(v_kbc, pg_temp.fx('p2_k2'));
  perform discovery_refresh_candidate_visibility(v_kbc);
  set local role authenticated;
  perform pg_temp.act_as(v_kb);
  v_sees := app_can_see_candidate(v_kbc, v_kb);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if not v_sees then raise exception 'FAIL: 18 fixture: kb sees the candidate their message evidences'; end if;

  -- Content kept on disconnect: kb's withdrawal deletes nothing, archives the source and audits the retention.
  set local role service_role;
  perform tenant_retention_policy_set(t, 'ops', 'review 3', p_content_on_disconnect => 'keep');
  reset role;
  if (select (detail->'new'->>'content_on_disconnect') || '/' || (detail->>'reason') from audit_log
      where tenant_id = t and action = 'discovery.retention_policy_set' order by chain_seq desc limit 1)
     <> 'keep/review 3' then
    raise exception 'FAIL: 18 content_on_disconnect keep is set and audited before kb''s withdrawal';
  end if;
  set local role authenticated;
  perform pg_temp.act_as(v_kb);
  v_row := mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if v_row->'purged' <> 'null'::jsonb then raise exception 'FAIL: 18 kb''s withdrawal reports a purge: %', v_row; end if;
  -- #530 review: the kept withdrawal leaves kb's visibility row (the record of who saw it stays with the retained
  -- mail), but kb no longer sees the candidate: access needs an allowed mailbox, and the archived source is none.
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_kbc and person_id = v_kb), 1,
    '18 a kept withdrawal leaves the visibility row');
  set local role authenticated;
  perform pg_temp.act_as(v_kb);
  v_sees := app_can_see_candidate(v_kbc, v_kb);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if v_sees then raise exception 'FAIL: 18 kb still sees the candidate after withdrawing'; end if;
  perform pg_temp.expect((select count(*) from content_sources
                          where id = pg_temp.fx('p2_src_kb') and archived_at is not null and status = 'paused'
                            and archived_from_address = 'kb@bank.example' and address like 'kb@bank.example~%'), 1,
    '18 kb''s source stays, archived');
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('p2_k2')), 1, '18 kb''s message stays');
  perform pg_temp.expect((select count(*) from discovery_message_index where content_source_id = pg_temp.fx('p2_src_kb')), 2,
    '18 kb''s index rows stay');
  perform pg_temp.expect(coalesce((select 1 from audit_log where action = 'discovery.mailbox_purged'
                                     and detail->>'sourceId' = pg_temp.fx('p2_src_kb')::text), 0), 0,
    '18 no mailbox_purged row');
  select * into v_audit from audit_log where tenant_id = t and action = 'discovery.mailbox_retained';
  if (select count(*) from audit_log where tenant_id = t and action = 'discovery.mailbox_retained') <> 1
     or v_audit.actor_type <> 'user' or v_audit.actor_id <> v_kb
     or v_audit.detail->>'sourceId' <> pg_temp.fx('p2_src_kb')::text
     or v_audit.detail->>'consentId' <> (select id::text from mailbox_consents where user_id = v_kb
                                         order by withdrawn_at desc nulls last limit 1)
     or v_audit.detail->>'reason' <> 'withdrawn'
     or v_audit.detail->'policy' <> '{"lifecycle": "pilot", "contentOnDisconnect": "keep", "indexOnDisconnect": "delete"}'::jsonb
  then
    raise exception 'FAIL: 18 one mailbox_retained row with the consent, source, reason and policy, got %', v_audit.detail;
  end if;
  -- A page in flight for kb's source is refused, so nothing is indexed after the withdrawal. The fixture
  -- table is the owner's: its id is read before the role switch.
  v_src := pg_temp.fx('p2_src_kb');
  set local role service_role;
  begin
    perform discovery_message_index_record(t, v_src, jsonb_build_array(jsonb_build_object(
      'provider_item_id', 'kb-late', 'internet_message_id', '<kb-late@p2>', 'content_digest', pg_temp.dg('h'), 'rules_version', 'r')));
    v_state := 'ran';
  exception when raise_exception then
    v_state := case when sqlerrm = 'source_archived' then 'refused' else sqlerrm end;
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL: 18 a page after the withdrawal was indexed: %', v_state; end if;
  raise notice 'PASS: 18 the retention policy decides what a disconnect deletes; the backstop follows it';
end
$$;

rollback;
