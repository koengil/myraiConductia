-- #461 slice 3: the tenant purge (20261014140000_discovery_purge_tenant.sql).
--
--   Alex   a1 (his alone), sh (shared with Storm)
--   Storm  sh, s1, h1
--   Zed    z1, withdrawn before the purge (a per-banker purge and its audit row)
--   site   d1, a SharePoint document by jane@author.example
--   Cobra  sh + s1, renamed by the MD, assessed on sh's milestone
--   Mix    d1 + a1; parties author.example and mail.example; one assessment on
--          a1's milestone, one on d1's
--   Heron  h1, promoted to a deal under legal hold
--   fresh  a message with no provenance yet (a page in flight)
--   Other  a second tenant with its own mailbox, mail, candidate and caches
--   index  one row per sighting above, plus au (Alex read it, unrouted); Other
--          has one too (20261014150000_discovery_message_index.sql; the export,
--          20261014151000_discovery_message_index_export.sql)
--
-- 1. No role may run it, the service role included (the operator runs it as
--    its owner), and it refuses while a reader registration of the tenant is
--    active.
-- 2. Zero mail rows in every TENANT_PURGE_TABLES table, held residue aside:
--    mailbox sources with their provenance, ledger and taints; messages with
--    their texts, evidence, milestones and model calls; candidates with no
--    evidence and their visibility, recompute requests and corrections;
--    assessments citing a deleted milestone; mail guard rows, drift and group
--    absence.
-- 3. SharePoint survives: site source, document, provenance, ledger, the
--    candidate the document evidences and its document assessment equal their
--    before counts; Mix is rebased (no mail-only party, seen dates from d1) and
--    loses the assessment on a1's milestone.
-- 4. Consents and audit rows stay; one discovery.tenant_purged row, service
--    actor purge-tenant, ids and counts only; the result carries the message
--    index for the bank (no content, no held row) and the audit row does not.
-- 5. Legal hold: Heron and h1 stay, listed in heldResidue and counted per table;
--    after lift_legal_hold the collector deletes them.
-- 6. The other tenant is untouched; a second run deletes nothing more but the
--    index row the lifted hold had kept.
-- 7. index_at_tenant_end = 'keep' (20261014160000_tenant_retention_policy.sql):
--    the other tenant's purge exports its index and keeps it, counted as kept
--    by the policy (not as held), marked tenant_end_keep; the backstop, though
--    index_on_disconnect is 'delete', leaves it. The result carries the policy.
--    Back on export_then_delete, a second run deletes it.
-- 8. #173 G-07 slice 1c (20261023130300_discovery_purge_tombstone.sql): a
--    surviving candidate's stream whose latest assessment the purge deleted
--    gets exactly one tombstone in its own audience (shared, or its team
--    inbox's), each audited as discovery.stage_assessed (ids and the trigger
--    only), and the candidate one 'purge' recompute request; a stream whose
--    latest row survives is untouched; neither is a mail row the purge leaves.
--    heldResidueCounts carries milestone_detections, 0 while no detection
--    exists (the table arrives in G-07 slice 3b).
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_tenant_purge.sql
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

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user, 'role', 'authenticated')::text, true);
$$;

create temp table fx (k text primary key, v uuid);
create function pg_temp.fx(p_key text) returns uuid language sql as $$ select v from fx where k = p_key $$;

-- A seated banker who opted in through the RPC as themselves, which creates their mailbox source.
create function pg_temp.banker(p_tenant uuid, p_bank uuid, p_deal uuid, p_local text)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v, 'tpurge-' || p_local || '@example.test', jsonb_build_object('tenant_id', p_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = p_bank, company_role = 'member' where id = v;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
    values (p_tenant, p_local || '@bank.example', pg_temp.fx('dee'), p_bank, 'member', 'accepted', 'sent', now(), v);
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
    values (p_deal, v, (select id from roles where slug = 'deal_team'), 'deal_team');
  set local role authenticated;
  perform pg_temp.act_as(v);
  perform mailbox_consent_grant();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into fx values (p_local, v),
    ('src_' || p_local, (select id from content_sources where tenant_id = p_tenant and owner_user_id = v));
  return v;
end;
$$;

-- A stored item with its text, held by each source given.
create function pg_temp.item(p_tenant uuid, p_kind text, p_tag text, p_sent date, p_who text, p_sources uuid[])
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, drive_item_key, content_hash,
                            participants)
  values (v, p_tenant, p_kind, 'Item ' || p_tag, p_sent,
          case when p_kind = 'message' then '<' || p_tag || '@tp>' end,
          case when p_kind = 'document' then 'drive:' || p_tag end, 'h-' || p_tag,
          jsonb_build_array(jsonb_build_object('role', case when p_kind = 'document' then 'author' else 'from' end,
                                               'address', p_who)));
  insert into source_item_texts (source_item_id, body_text) values (v, p_tag || ' body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    select v, s, p_tag || '-' || n from unnest(p_sources) with ordinality u(s, n);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id)
    select s, p_tag || '-' || n, 'h-' || p_tag, 'routed', 'codename', 0.9, gen_random_uuid()
    from unnest(p_sources) with ordinality u(s, n);
  insert into fx values (p_tag, v);
  return v;
end;
$$;

create function pg_temp.cand(p_tenant uuid, p_tag text, p_name text, p_parties jsonb default '[]')
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess, parties,
                               first_seen_at, last_seen_at, confidence)
  values (v, p_tenant, 'codename:' || p_tag, p_name, p_name, p_parties, '2025-01-01', '2026-12-31', 0.95);
  insert into fx values (p_tag, v);
  return v;
end;
$$;

create function pg_temp.link(p_cand uuid, p_item uuid, p_conf numeric default 0.9)
returns void language sql as $$
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier)
  values (p_cand, p_item, 'codename', p_conf, 'firm');
$$;

-- A milestone event on an item, with the model call that produced it.
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

-- The index rows of a source's sightings, through the worker's writer.
create function pg_temp.indexed(p_tenant uuid, p_source uuid, p_ids text[]) returns void language sql as $$
  select discovery_message_index_record(p_tenant, p_source, jsonb_agg(jsonb_build_object(
    'provider_item_id', i, 'internet_message_id', '<' || split_part(i, '-', 1) || '@tp>', 'content_digest', 'hmac-sha256:' || repeat('d', 64),
    'tags', jsonb_build_array('mnpi'), 'rules_version', 'rules-x')))
  from unnest(p_ids) i;
$$;

-- The tenant's rows per TENANT_PURGE_TABLES table (src/lib/constants/discovery.ts), the same predicates.
create function pg_temp.mail_rows(t uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'content_sources', (select count(*) from content_sources where tenant_id = t and kind = 'mailbox'),
    'routing_ledger', (select count(*) from routing_ledger r join content_sources s on s.id = r.source_id
                       where s.tenant_id = t and s.kind = 'mailbox'),
    'source_items', (select count(*) from source_items where tenant_id = t and kind = 'message'),
    'source_item_sources', (select count(*) from source_item_sources p join content_sources s on s.id = p.content_source_id
                            where s.tenant_id = t and s.kind = 'mailbox'),
    'source_item_texts', (select count(*) from source_item_texts x join source_items i on i.id = x.source_item_id
                          where i.tenant_id = t and i.kind = 'message'),
    'discovery_thread_taints', (select count(*) from discovery_thread_taints x join content_sources s on s.id = x.source_id
                                where s.tenant_id = t and s.kind = 'mailbox'),
    'evidence_links', (select count(*) from evidence_links l join source_items i on i.id = l.source_item_id
                       where i.tenant_id = t and i.kind = 'message'),
    'milestone_events', (select count(*) from milestone_events m join source_items i on i.id = m.source_item_id
                         where m.tenant_id = t and i.kind = 'message'),
    'model_calls', (select count(*) from model_calls m join source_items i on i.id = m.source_item_id
                    where m.tenant_id = t and i.kind = 'message'),
    'deal_candidates', (select count(*) from deal_candidates c where c.tenant_id = t
                        and not exists (select 1 from evidence_links l where l.candidate_id = c.id)),
    'stage_assessments', (select count(*) from stage_assessments sa where sa.tenant_id = t
                          and exists (select 1 from unnest(sa.evidence_event_ids) e
                                      where not exists (select 1 from milestone_events m where m.id = e))),
    'corrections', (select count(*) from corrections k where k.tenant_id = t
                    and not exists (select 1 from evidence_links l where l.candidate_id = k.candidate_id)),
    'mailbox_guard_state', (select count(*) from mailbox_guard_state where tenant_id = t and position('@' in address) > 0),
    'mailbox_allowlist_drift', (select count(*) from mailbox_allowlist_drift where tenant_id = t),
    'mailbox_group_absence', (select count(*) from mailbox_group_absence where tenant_id = t),
    'discovery_message_index', (select count(*) from discovery_message_index where tenant_id = t),
    'discovery_model_proposals', (select count(*) from discovery_model_proposals where tenant_id = t),
    'discovery_team_proposal_passes', (select count(*) from discovery_team_proposal_passes where tenant_id = t),
    'discovery_model_proposal_dismissals', (select count(*) from discovery_model_proposal_dismissals where tenant_id = t),
    'discovery_model_proposal_accepts', (select count(*) from discovery_model_proposal_accepts where tenant_id = t),
    'discovery_extract_budgets', (select count(*) from discovery_extract_budgets where tenant_id = t),
    'discovery_extract_budget_items', (select count(*) from discovery_extract_budget_items bi
                                       join discovery_extract_budgets b on b.id = bi.budget_id where b.tenant_id = t),
    'send_census_weekly', (select count(*) from send_census_weekly where tenant_id = t));
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

create temp table res (k text primary key, r jsonb);
grant all on res, fx to service_role;

do $$
declare
  t      uuid := gen_random_uuid();
  o      uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_dee  uuid := gen_random_uuid();
  v_deal uuid;
  v_held uuid;
  v_site uuid;
  v_osrc uuid;
  v_oi   uuid := gen_random_uuid();
  v_oc   uuid := gen_random_uuid();
  v_mix  uuid; v_cobra uuid; v_heron uuid;
begin
  insert into fx values ('t', t), ('o', o), ('dee', v_dee);
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_dee, 'tpurge-dee@example.test', jsonb_build_object('tenant_id', t, 'department', 'ib'));
  insert into companies (id, tenant_id, name, type) values (v_bank, t, 'Tenant Purge Bank', 'bank');
  update users set status = 'active', is_external = false, company_id = v_bank, company_role = 'director' where id = v_dee;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (t, 'fixture', 'fixture', 'active', '{bank.example}', v_bank);
  insert into deals (tenant_id, code, codename, bank_id) values (t, 'tp-' || t, 'Seats', v_bank) returning id into v_deal;
  perform pg_temp.banker(t, v_bank, v_deal, n) from unnest(array['alex', 'storm', 'zed']) n;
  insert into content_sources (tenant_id, kind, address) values (t, 'sharepoint_site', 'bank.sharepoint.com:/sites/tp')
    returning id into v_site;
  insert into fx values ('site', v_site);

  perform pg_temp.item(t, 'message', 'sh', '2026-03-02', 'ceo@acme.example', array[pg_temp.fx('src_alex'), pg_temp.fx('src_storm')]);
  perform pg_temp.item(t, 'message', 'a1', '2026-04-01', 'bob@mail.example', array[pg_temp.fx('src_alex')]);
  perform pg_temp.item(t, 'message', 's1', '2026-03-05', 'cfo@acme.example', array[pg_temp.fx('src_storm')]);
  perform pg_temp.item(t, 'message', 'h1', '2026-03-06', 'gc@heron.example', array[pg_temp.fx('src_storm')]);
  perform pg_temp.item(t, 'message', 'z1', '2026-03-07', 'z@zed.example', array[pg_temp.fx('src_zed')]);
  perform pg_temp.item(t, 'message', 'fresh', '2026-03-08', 'new@acme.example', '{}');
  perform pg_temp.item(t, 'document', 'd1', '2026-02-01', 'jane@author.example', array[v_site]);
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
    values (pg_temp.fx('src_alex'), 'thread-a', 'rule-1', 1, 'a-9', gen_random_uuid());

  v_cobra := pg_temp.cand(t, 'cobra', 'Project Cobra', '[{"name": "Acme", "domain": "acme.example"}]');
  perform pg_temp.link(v_cobra, pg_temp.fx('sh'));
  perform pg_temp.link(v_cobra, pg_temp.fx('s1'));
  perform pg_temp.assess(t, v_cobra, array[pg_temp.event(t, pg_temp.fx('sh'))]);
  insert into corrections (tenant_id, candidate_id, actor_id, action, before, after)
    values (t, v_cobra, v_dee, 'rename', '{"name": "Project Cobra"}', '{"name": "Cobra (MD)"}');

  v_mix := pg_temp.cand(t, 'mix', 'Project Mix',
    '[{"name": "Author Co", "domain": "author.example"}, {"name": "Mail Co", "domain": "mail.example"}]');
  perform pg_temp.link(v_mix, pg_temp.fx('d1'), 0.6);
  perform pg_temp.link(v_mix, pg_temp.fx('a1'), 0.95);
  insert into fx values ('assess_a1', pg_temp.assess(t, v_mix, array[pg_temp.event(t, pg_temp.fx('a1'))])),
                        ('assess_d1', pg_temp.assess(t, v_mix, array[pg_temp.event(t, pg_temp.fx('d1'))]));

  v_heron := pg_temp.cand(t, 'heron', 'Project Heron');
  perform pg_temp.link(v_heron, pg_temp.fx('h1'));
  perform pg_temp.assess(t, v_heron, array[pg_temp.event(t, pg_temp.fx('h1'))]);
  insert into deals (tenant_id, code, codename, bank_id) values (t, 'tph-' || t, 'Heron', v_bank) returning id into v_held;
  update deal_candidates set discovery_state = 'confirmed', promoted_deal_id = v_held where id = v_heron;
  perform place_legal_hold(v_held, v_dee, 'litigation');
  insert into fx values ('held_deal', v_held);
  perform discovery_refresh_candidate_visibility(c) from unnest(array[v_cobra, v_mix, v_heron]) c;

  -- The mail-address caches, and one site guard row (keyed by the site id, no '@').
  insert into mailbox_guard_state (tenant_id, address, last_reason) values
    (t, 'alex@bank.example', 'not_in_provider_group'), (t, 'bank.sharepoint.com:/sites/tp', 'site_not_registered');
  insert into mailbox_allowlist_drift (tenant_id, provider, status, missing_in_group)
    values (t, 'microsoft', 'drift', '{alex@bank.example}');
  insert into mailbox_group_absence (tenant_id, provider, address) values (t, 'microsoft', 'alex@bank.example');
  perform pg_temp.indexed(t, pg_temp.fx('src_alex'), array['sh-1', 'a1-1', 'a1-2', 'au-1']);  -- a1-2 is a copy of a1: one row, two provider ids
  perform pg_temp.indexed(t, pg_temp.fx('src_storm'), array['sh-2', 's1-1', 'h1-1']);
  perform pg_temp.indexed(t, pg_temp.fx('src_zed'), array['z1-1']);

  -- Zed withdraws first: his per-banker purge deletes z1 and leaves a mailbox_purged row.
  perform pg_temp.act_as(pg_temp.fx('zed'));
  set local role authenticated;
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('z1')), 0,
    'fixture: Zed''s purge deleted z1');
  perform pg_temp.expect((select count(*) from discovery_message_index where content_source_id = pg_temp.fx('src_zed')), 0,
    'fixture: Zed''s purge deleted his index row');

  -- The other tenant: its own mailbox, message, candidate and caches.
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values (o, 'fixture', 'fixture', 'disabled');
  insert into content_sources (tenant_id, kind, address) values (o, 'mailbox', 'far@other.example') returning id into v_osrc;
  insert into source_items (id, tenant_id, kind, subject, internet_message_id, content_hash) values (v_oi, o, 'message', 'Far', '<far@tp>', 'h-far');
  insert into source_item_texts (source_item_id, body_text) values (v_oi, 'far body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_oi, v_osrc, 'far-1');
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name) values (v_oc, o, 'codename:far', 'Project Far');
  perform pg_temp.link(v_oc, v_oi);
  insert into mailbox_guard_state (tenant_id, address, last_reason) values (o, 'far@other.example', 'no_consent');
  insert into mailbox_allowlist_drift (tenant_id, provider, status) values (o, 'microsoft', 'in_sync');
  perform pg_temp.indexed(o, v_osrc, array['far-1']);
  insert into fx values ('o_src', v_osrc), ('o_item', v_oi), ('o_cand', v_oc);
  -- #261: an extraction budget per tenant, each with one cohort row. The purge deletes the tenant's, not o's.
  with b as (insert into discovery_extract_budgets (tenant_id, model, prompt_version, item_count, est_cost_usd, stop_at_usd, estimate)
             values (t, 'test-model', 'v1', 1, 0.1, 0.2, '{}'::jsonb), (o, 'test-model', 'v1', 1, 0.1, 0.2, '{}'::jsonb)
             returning id, tenant_id)
  insert into discovery_extract_budget_items (budget_id, source_item_id, ceiling_usd)
  select b.id, case when b.tenant_id = t then pg_temp.fx('a1') else v_oi end, 0.1 from b;

  insert into res values
    ('mail_before', pg_temp.mail_rows(t)),
    ('other_before', pg_temp.mail_rows(o)),
    ('site_before', discovery_tenant_site_counts(t)),
    ('kept_before', jsonb_build_object(
       'consents', (select count(*) from mailbox_consents where tenant_id = t),
       'audit', (select count(*) from audit_log where tenant_id = t),
       'deals', (select count(*) from deals where tenant_id = t)));
  raise notice 'PASS: fixture';
end
$$;

-- ── 1. Grants, and the refusal while a registration is active ─────────────
do $$
declare
  t uuid := pg_temp.fx('t');
  v_denied boolean;
  v_state text;
begin
  foreach v_state in array array['anon', 'authenticated', 'service_role'] loop
    execute format('set local role %I', v_state);
    begin
      perform discovery_purge_tenant(t, 'probe');
      v_denied := false;
    exception when insufficient_privilege then
      v_denied := true;
    end;
    reset role;
    if not v_denied then raise exception 'FAIL: 1 % ran the tenant purge', v_state; end if;
  end loop;

  begin
    perform discovery_purge_tenant(t, 'probe');
    v_state := 'ran';
  exception when sqlstate '55000' then
    v_state := sqlerrm;
  end;
  if v_state not like '%registration of the tenant is active%' then
    raise exception 'FAIL: 1 the purge ran while the registration was active (%)', v_state;
  end if;
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = t and kind = 'mailbox'), 2,
    'the refused purge deleted nothing');
  raise notice 'PASS: 1 owner only; refused while a registration is active';
end
$$;

-- The operator stops reading, then purges as the owner.
update graph_reader_registrations set status = 'disabled' where tenant_id = pg_temp.fx('t');
insert into res select 'purge', discovery_purge_tenant(pg_temp.fx('t'), 'purge-tenant');

-- ── 2. Zero mail rows, held residue aside ─────────────────────────────────
do $$
declare
  t uuid := pg_temp.fx('t');
  v_after   jsonb := pg_temp.mail_rows(t);
  v_residue jsonb := (select r->'heldResidueCounts' from res where k = 'purge');
  v_bad     text;
begin
  select string_agg(a.key || ' ' || a.value || ' (held ' || coalesce(v_residue->>a.key, '0') || ')', ', ') into v_bad
  from jsonb_each_text(v_after) a
  where a.value::bigint <> coalesce((v_residue->>a.key)::bigint, 0);
  if v_bad is not null then
    raise exception 'FAIL: 2 mail rows remain beyond the held residue: %', v_bad;
  end if;
  -- The residue is exactly Heron's message, what hangs off it, and Storm's index row of it.
  if v_residue <> jsonb_build_object('source_items', 1, 'source_item_texts', 1, 'evidence_links', 1,
       'milestone_events', 1, 'model_calls', 1, 'milestone_detections', 0, 'stage_assessments', 0, 'deal_candidates', 0,
       'candidate_visibility', 0, 'discovery_recompute_requests', 0, 'corrections', 0, 'discovery_message_index', 1) then
    raise exception 'FAIL: 2 held residue counts, got %', v_residue;
  end if;
  perform pg_temp.expect((select count(*) from source_items where tenant_id = t and kind = 'message'
                                                             and id <> pg_temp.fx('h1')), 0, 'no message but the held one');
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('fresh')), 0,
    'the in-flight orphan is collected at once');
  perform pg_temp.expect((select count(*) from deal_candidates where id = pg_temp.fx('cobra')), 0, 'Cobra is deleted');
  perform pg_temp.expect((select count(*) from corrections where tenant_id = t), 0, 'Cobra''s rename correction is deleted');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = t), 1, 'only the site guard row stays');
  perform pg_temp.expect((select count(*) from discovery_message_index where tenant_id = t and 'h1-1' = any(provider_item_ids)
                            and deal_id = pg_temp.fx('held_deal')), 1, 'the index row of the held message stays, linked');
  raise notice 'PASS: 2 zero mail rows in every purged table, held residue aside';
end
$$;

-- ── 3. SharePoint survives; Mix is rebased ────────────────────────────────
do $$
declare
  t uuid := pg_temp.fx('t');
  v_r jsonb := (select r from res where k = 'purge');
  v_mix deal_candidates%rowtype;
begin
  if v_r->'site'->'before' <> v_r->'site'->'after'
     or v_r->'site'->'before' <> (select r from res where k = 'site_before')
     or discovery_tenant_site_counts(t) <> (select r from res where k = 'site_before') then
    raise exception 'FAIL: 3 site rows changed: %', v_r->'site';
  end if;
  if (select r from res where k = 'site_before') <> jsonb_build_object('siteSources', 1, 'siteProvenance', 1,
       'siteLedger', 1, 'documents', 1, 'documentTexts', 1, 'documentEvidence', 1, 'documentMilestones', 1,
       'documentCandidates', 1) then
    raise exception 'FAIL: 3 site counts measure the fixture, got %', (select r from res where k = 'site_before');
  end if;
  select * into v_mix from deal_candidates where id = pg_temp.fx('mix');
  if v_mix.id is null then raise exception 'FAIL: 3 Mix, evidenced by a document, was deleted'; end if;
  if v_mix.parties <> '[{"name": "Author Co", "domain": "author.example"}]'::jsonb then
    raise exception 'FAIL: 3 Mix keeps only the document author''s party, got %', v_mix.parties;
  end if;
  if v_mix.first_seen_at::date <> '2026-02-01' or v_mix.last_seen_at::date <> '2026-02-01' then
    raise exception 'FAIL: 3 Mix''s seen dates come from the document, got % %', v_mix.first_seen_at, v_mix.last_seen_at;
  end if;
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('assess_a1')), 0,
    'the assessment on a1''s milestone is deleted');
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('assess_d1')), 1,
    'the assessment on d1''s milestone stays');
  raise notice 'PASS: 3 site rows unchanged; the document-evidenced candidate is rebased';
end
$$;

-- ── 4. Consents and audit kept; one tenant_purged row, ids and counts only ──
do $$
declare
  t uuid := pg_temp.fx('t');
  v_r    jsonb := (select r from res where k = 'purge');
  v_kept jsonb := (select r from res where k = 'kept_before');
  v_row  audit_log%rowtype;
  v_keys text[];
begin
  perform pg_temp.expect((select count(*) from mailbox_consents where tenant_id = t), (v_kept->>'consents')::bigint,
    'every consent row stays');
  perform pg_temp.expect((select count(*) from deals where tenant_id = t), (v_kept->>'deals')::bigint, 'every deal stays');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = t), (v_kept->>'audit')::bigint + 1,
    'every audit row stays, and one is added');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = t and action = 'discovery.mailbox_purged'), 1,
    'Zed''s mailbox_purged row stays');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = t and action = 'discovery.tenant_purged'), 1,
    'one discovery.tenant_purged row');
  select * into v_row from audit_log where tenant_id = t and action = 'discovery.tenant_purged';
  if v_row.id::text <> v_r->>'auditId' or v_row.actor_type <> 'service' or v_row.service_identity <> 'purge-tenant'
     or v_row.actor_id is not null then
    raise exception 'FAIL: 4 the row is the service purge-tenant''s and its id is returned, got % % %',
      v_row.actor_type, v_row.service_identity, v_r->>'auditId';
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(v_row.detail) k;
  if v_keys is distinct from array['absenceRows', 'budgets', 'candidates', 'corrections', 'driftRows', 'evidence', 'guardRows',
                                   'heldSkipped', 'indexRows', 'items', 'ledger', 'milestones', 'modelCalls',
                                   'provenance', 'runId', 'sources', 'taints', 'texts'] then
    raise exception 'FAIL: 4 detail keys are ids and counts only, got %', v_keys;
  end if;
  if v_row.detail::text like '%@%' then
    raise exception 'FAIL: 4 the detail names no address and no Message-ID, got %', v_row.detail;
  end if;
  -- Alex and Storm's sources; sh twice, a1, s1, h1; ledger as provenance; Alex's taint; a1, sh, s1 and the
  -- fresh orphan deleted (h1 held) with their texts, three links (fresh has none), two milestones and calls
  -- (a1, sh); Cobra; Cobra's rename; five index rows (h1-1 held).
  if v_row.detail - 'runId' <> jsonb_build_object('sources', 2, 'provenance', 5, 'ledger', 5, 'taints', 1, 'indexRows', 5,
       'items', 4, 'texts', 4, 'evidence', 3, 'milestones', 2, 'modelCalls', 2, 'candidates', 1, 'corrections', 1,
       'heldSkipped', 1, 'guardRows', 1, 'driftRows', 1, 'absenceRows', 1, 'budgets', 1) then
    raise exception 'FAIL: 4 counts, got %', v_row.detail;
  end if;
  if v_r->'deleted' <> v_row.detail - 'runId' or v_r->>'runId' <> v_row.detail->>'runId' then
    raise exception 'FAIL: 4 the function returns what the audit row records';
  end if;

  -- The result: counts, site counts, held residue, and the index for the bank.
  select array_agg(k order by k) into v_keys from jsonb_object_keys(v_r) k;
  if v_keys is distinct from array['auditId', 'deleted', 'heldResidue', 'heldResidueCounts', 'messageIndex', 'policy',
                                   'policyKeptCounts', 'runId', 'site'] then
    raise exception 'FAIL: 4 result keys, got %', v_keys;
  end if;
  if v_r->'policy' <> '{"lifecycle": "pilot", "contentOnDisconnect": "delete", "indexOnDisconnect": "delete",
                        "indexAtTenantEnd": "export_then_delete"}'::jsonb then
    raise exception 'FAIL: 4 the result carries the pilot policy of a tenant with no row, got %', v_r->'policy';
  end if;
  if jsonb_array_length(v_r->'messageIndex') <> 5
     or (select string_agg(p, ',' order by p) from jsonb_array_elements(v_r->'messageIndex') m,
                                                     jsonb_array_elements_text(m->'providerItemIds') p)
          <> 'a1-1,a1-2,au-1,s1-1,sh-1,sh-2' then
    raise exception 'FAIL: 4 the export is every unheld index row, with every provider id, got %', v_r->'messageIndex';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_r->'messageIndex') m
                 where m->>'messageKey' = encode(sha256(convert_to('<a1@tp>', 'UTF8')), 'hex') and m->'providerItemIds' = '["a1-1", "a1-2"]') then
    raise exception 'FAIL: 4 a copied message is one exported row holding both provider ids, got %', v_r->'messageIndex';
  end if;
  if (select array_agg(m->>'sourceId' order by ord) from jsonb_array_elements(v_r->'messageIndex') with ordinality t(m, ord))
       is distinct from (select array_agg(m->>'sourceId' order by m->>'sourceId') from jsonb_array_elements(v_r->'messageIndex') m) then
    raise exception 'FAIL: 4 the export is ordered by mailbox source, got %', v_r->'messageIndex';
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(v_r->'messageIndex'->0) k;
  if v_keys is distinct from array['dealId', 'messageKey', 'model', 'processedAt', 'promptVersion', 'providerItemIds',
                                   'rulesVersion', 'sentAt', 'sourceId', 'tags'] then
    raise exception 'FAIL: 4 an exported row holds identifiers, dates, tags and versions only, got %', v_keys;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_r->'messageIndex') m
                 where m->>'messageKey' = encode(sha256(convert_to('<sh@tp>', 'UTF8')), 'hex') and m->>'sourceId' = pg_temp.fx('src_alex')::text
                   and m->'tags' = '["mnpi"]') then
    raise exception 'FAIL: 4 the export carries the hashed Message-ID, the source and the tags';
  end if;
  raise notice 'PASS: 4 consents and audit kept; one tenant_purged row, ids and counts only';
end
$$;

-- ── 5. Legal hold keeps Heron, listed, until the hold lifts ───────────────
do $$
declare
  t uuid := pg_temp.fx('t');
  v_r jsonb := (select r from res where k = 'purge');
  v_counts jsonb;
begin
  if v_r->'heldResidue' <> jsonb_build_array(jsonb_build_object('candidateId', pg_temp.fx('heron'),
                                                                'dealId', pg_temp.fx('held_deal'), 'messages', 1)) then
    raise exception 'FAIL: 5 heldResidue lists Heron and its deal, got %', v_r->'heldResidue';
  end if;
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('h1')), 1, 'the held message stays');
  perform pg_temp.expect((select count(*) from deal_candidates where id = pg_temp.fx('heron')), 1, 'Heron stays');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = pg_temp.fx('heron')), 1,
    'Heron''s assessment stays');

  perform lift_legal_hold(pg_temp.fx('held_deal'), pg_temp.fx('dee'));
  set local role service_role;
  v_counts := discovery_collect_orphans(t, interval '0');
  reset role;
  perform pg_temp.expect((v_counts->>'items')::bigint, 1, 'the lifted hold lets the collector take h1');
  perform pg_temp.expect((select count(*) from deal_candidates where id = pg_temp.fx('heron')), 0, 'Heron goes with it');
  perform pg_temp.expect((select count(*) from deals where id = pg_temp.fx('held_deal')), 1, 'the deal stays');
  perform pg_temp.expect((select count(*) from source_items where tenant_id = t and kind = 'message'), 0,
    'no message is left');
  raise notice 'PASS: 5 legal hold keeps its residue, listed, until lifted';
end
$$;

-- ── 6. The other tenant is untouched; a second run deletes nothing more ───
do $$
declare
  t uuid := pg_temp.fx('t');
  o uuid := pg_temp.fx('o');
  v_r jsonb;
begin
  if pg_temp.mail_rows(o) <> (select r from res where k = 'other_before') then
    raise exception 'FAIL: 6 the other tenant changed: % -> %', (select r from res where k = 'other_before'), pg_temp.mail_rows(o);
  end if;
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = pg_temp.fx('o_src')), 1,
    'the other tenant''s provenance stays');
  perform pg_temp.expect((select count(*) from deal_candidates where id = pg_temp.fx('o_cand')), 1,
    'the other tenant''s candidate stays');

  v_r := discovery_purge_tenant(t, 'purge-tenant');
  if exists (select 1 from jsonb_each_text(v_r->'deleted') d where d.value::bigint <> case d.key when 'indexRows' then 1 else 0 end)
     or jsonb_array_length(v_r->'messageIndex') <> 1 then
    raise exception 'FAIL: 6 a second run deletes only the index row the hold kept, got %', v_r->'deleted';
  end if;
  perform pg_temp.expect((select count(*) from discovery_message_index where tenant_id = t), 0, 'no index row is left');
  raise notice 'PASS: 6 the other tenant is untouched; a second run deletes only what the lifted hold kept';
end
$$;

-- ── 7. index_at_tenant_end = 'keep' exports the index and keeps it ────────
do $$
declare
  o uuid := pg_temp.fx('o');
  v_r jsonb;
begin
  set local role service_role;
  perform tenant_retention_policy_set(o, 'ops', 'probe', p_lifecycle => 'decommissioning', p_index_at_tenant_end => 'keep');
  reset role;
  v_r := discovery_purge_tenant(o, 'purge-tenant');  -- as the owner (#520)
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('o_item')), 0, '7 the mail goes');
  perform pg_temp.expect((select count(*) from discovery_message_index where tenant_id = o and orphaned_by = 'tenant_end_keep'),
    1, '7 the index row stays, marked kept at tenant end');
  if (v_r->'deleted'->>'indexRows')::int <> 0 or jsonb_array_length(v_r->'messageIndex') <> 1
     or (v_r->'heldResidueCounts'->>'discovery_message_index')::int <> 0
     or (v_r->'policyKeptCounts'->>'discovery_message_index')::int <> 1
     or v_r->'policy'->>'indexAtTenantEnd' <> 'keep' or v_r->'policy'->>'lifecycle' <> 'decommissioning' then
    raise exception 'FAIL: 7 exported, kept, counted as kept by the policy, policy in the result; got %', v_r - 'site';
  end if;

  -- The backstop (index_on_disconnect is 'delete') leaves what the tenant-end policy keeps.
  set local role service_role;
  perform discovery_collect_orphans_all(interval '0');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_message_index where tenant_id = o), 1,
    '7 the backstop keeps the row the tenant-end policy keeps');

  set local role service_role;
  perform tenant_retention_policy_set(o, 'ops', 'probe', p_index_at_tenant_end => 'export_then_delete');
  reset role;
  v_r := discovery_purge_tenant(o, 'purge-tenant');  -- as the owner (#520)
  perform pg_temp.expect((v_r->'deleted'->>'indexRows')::bigint, 1, '7 back on export_then_delete, the kept row goes');
  perform pg_temp.expect((select count(*) from discovery_message_index where tenant_id = o), 0, '7 no index row is left');
  raise notice 'PASS: 7 index_at_tenant_end keep exports the index and keeps it';
end
$$;

-- ── 8. A deleted latest assessment leaves a tombstone, audited, with a recompute ──
-- #173 G-07 slice 1c. A third tenant, so the counts above stay as they are:
--   wm1   a message in the tenant's one mailbox (purged)
--   wd1   a SharePoint document (survives)
--   Wren  wm1 + wd1. Shared stream: an older row on wd1's milestone, the latest on wm1's.
--         deals@'s stream: one row, on wm1's milestone (a scoped row, written as the owner).
--   Lark  wm1 + wd1. Shared stream: an older row on wm1's milestone, the latest on wd1's.
do $$
declare
  w       uuid := gen_random_uuid();
  v_bank  uuid := gen_random_uuid();
  v_user  uuid := gen_random_uuid();
  v_tm    uuid := gen_random_uuid();
  v_src   uuid;
  v_site  uuid;
  v_wren  uuid;
  v_lark  uuid;
  v_ev_m  uuid;
  v_ev_d  uuid;
begin
  insert into fx values ('w', w), ('w_tm', v_tm);
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_user, 'tpurge-wren@example.test', jsonb_build_object('tenant_id', w, 'department', 'ib'));
  insert into companies (id, tenant_id, name, type) values (v_bank, w, 'Tombstone Bank', 'bank');
  -- A Microsoft source needs its tenant's registration (content_sources_ms_registration_fkey); disabled, because
  -- discovery_purge_tenant refuses a tenant whose registration is active.
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values (w, 'fixture', 'fixture', 'disabled');
  update users set status = 'active', is_external = false, company_id = v_bank, company_role = 'director' where id = v_user;
  insert into team_mailboxes (id, tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
    values (v_tm, w, v_bank, 'google', 'deals@tombstone.example', v_user, 1);
  insert into content_sources (tenant_id, kind, address) values (w, 'mailbox', 'wren@tombstone.example') returning id into v_src;
  insert into content_sources (tenant_id, kind, address) values (w, 'sharepoint_site', 'tombstone.sharepoint.com:/sites/w')
    returning id into v_site;
  perform pg_temp.item(w, 'message', 'wm1', '2026-05-01', 'ceo@wren.example', array[v_src]);
  perform pg_temp.item(w, 'document', 'wd1', '2026-04-01', 'jane@author.example', array[v_site]);
  v_ev_m := pg_temp.event(w, pg_temp.fx('wm1'));
  v_ev_d := pg_temp.event(w, pg_temp.fx('wd1'));

  v_wren := pg_temp.cand(w, 'wren', 'Project Wren');
  perform pg_temp.link(v_wren, pg_temp.fx('wm1'));
  perform pg_temp.link(v_wren, pg_temp.fx('wd1'));
  insert into fx values ('wren_old', pg_temp.assess(w, v_wren, array[v_ev_d])),
                        ('wren_latest', pg_temp.assess(w, v_wren, array[v_ev_m]));
  insert into stage_assessments (tenant_id, candidate_id, step_id, reason_text, evidence_event_ids, confidence,
                                 engine_version, trigger, team_mailbox_id)
    values (w, v_wren, 'p1-s1', 'Kickoff held', array[v_ev_m], 0.8, 'v1', 'extraction', v_tm);

  v_lark := pg_temp.cand(w, 'lark', 'Project Lark');
  perform pg_temp.link(v_lark, pg_temp.fx('wm1'));
  perform pg_temp.link(v_lark, pg_temp.fx('wd1'));
  insert into fx values ('lark_old', pg_temp.assess(w, v_lark, array[v_ev_m])),
                        ('lark_latest', pg_temp.assess(w, v_lark, array[v_ev_d]));

  perform pg_temp.expect((select count(*) from stage_assessments where tenant_id = w), 5, '8 fixture: five assessments');
  insert into res values ('purge_w', discovery_purge_tenant(w, 'purge-tenant'));  -- as the owner (#520)
  raise notice 'PASS: 8 fixture';
end
$$;

do $$
declare
  w      uuid := pg_temp.fx('w');
  v_tm   uuid := pg_temp.fx('w_tm');
  v_wren uuid := pg_temp.fx('wren');
  v_lark uuid := pg_temp.fx('lark');
  v_r    jsonb := (select r from res where k = 'purge_w');
  v_tomb stage_assessments%rowtype;
  v_bad  text;
begin
  perform pg_temp.expect((select count(*) from source_items where id = pg_temp.fx('wm1')), 0, '8 the message goes');
  perform pg_temp.expect((select count(*) from deal_candidates where id in (v_wren, v_lark)), 2,
    '8 Wren and Lark survive on the document');

  -- Wren's shared stream: its latest row went, so one tombstone is now its latest; the older row stays behind it.
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('wren_latest')), 0,
    '8 Wren''s latest shared row, on the deleted milestone, is deleted');
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('wren_old')), 1,
    '8 Wren''s older shared row, on the document''s milestone, stays');
  perform pg_temp.expect((select count(*) from stage_assessments
                          where candidate_id = v_wren and team_mailbox_id is null and trigger = 'purge'), 1,
    '8 Wren''s shared stream gets exactly one tombstone');
  select * into v_tomb from stage_assessments where candidate_id = v_wren and team_mailbox_id is null
   order by as_of desc, id desc limit 1;
  if v_tomb.trigger <> 'purge' or v_tomb.step_id is not null or v_tomb.station is not null
     or v_tomb.lifecycle_suggestion is not null or v_tomb.evidence_event_ids <> '{}'::uuid[] or v_tomb.flags <> '{}'::text[]
     or v_tomb.reason_text <> 'No milestones extracted yet' or v_tomb.tenant_id <> w then
    raise exception 'FAIL: 8 the shared tombstone is Wren''s latest row, with no step and no evidence, got %', row_to_json(v_tomb);
  end if;

  -- Wren's deals@ stream: its only row went, and its tombstone keeps the stream's own audience.
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_wren and team_mailbox_id = v_tm), 1,
    '8 Wren''s scoped stream holds only its tombstone');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_wren and team_mailbox_id = v_tm
                            and trigger = 'purge' and step_id is null and evidence_event_ids = '{}'::uuid[]), 1,
    '8 the scoped tombstone carries the stream''s own team_mailbox_id');

  -- Lark's latest row survives: nothing is written for it.
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('lark_old')), 0,
    '8 Lark''s older row, on the deleted milestone, is deleted');
  perform pg_temp.expect((select count(*) from stage_assessments where candidate_id = v_lark), 1,
    '8 Lark keeps only its latest row, and no tombstone');
  perform pg_temp.expect((select count(*) from stage_assessments where id = pg_temp.fx('lark_latest')), 1,
    '8 Lark''s latest row stays');

  -- One audit row per tombstone, as the writer audits an assessment: ids and the trigger, the inbox when scoped.
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = w and action = 'discovery.stage_assessed'), 2,
    '8 two tombstones, two stage_assessed rows');
  perform pg_temp.expect((select count(*) from audit_log a join stage_assessments sa on sa.id = (a.detail->>'assessmentId')::uuid
                          where a.tenant_id = w and a.action = 'discovery.stage_assessed'
                            and a.actor_type = 'service' and a.service_identity = 'discovery-worker' and a.actor_id is null
                            and a.detail->>'trigger' = 'purge' and a.detail->>'candidateId' = v_wren::text
                            and sa.trigger = 'purge' and sa.candidate_id = v_wren
                            and (a.detail->>'teamMailboxId') is not distinct from sa.team_mailbox_id::text), 2,
    '8 each tombstone is audited by the service, naming its candidate, its row and its inbox');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = w and action = 'discovery.stage_assessed'
                            and (select array_agg(k order by k) from jsonb_object_keys(detail) k)
                                not in (array['assessmentId', 'candidateId', 'trigger'],
                                        array['assessmentId', 'candidateId', 'teamMailboxId', 'trigger'])), 0,
    '8 a tombstone''s audit holds ids and the trigger only');

  -- One recompute request per candidate with a tombstone, none for Lark.
  perform pg_temp.expect((select count(*) from discovery_recompute_requests where candidate_id = v_wren and reason = 'purge'), 1,
    '8 Wren gets one purge recompute request');
  perform pg_temp.expect((select count(*) from discovery_recompute_requests where tenant_id = w), 1,
    '8 and Lark gets none');

  -- Neither the tombstones nor the request are mail rows the purge leaves behind.
  select string_agg(a.key || ' ' || a.value, ', ') into v_bad
  from jsonb_each_text(pg_temp.mail_rows(w)) a where a.value::bigint <> 0;
  if v_bad is not null then raise exception 'FAIL: 8 mail rows remain: %', v_bad; end if;

  -- The held residue names the detector's ledger, 0 while no detection exists.
  if not (v_r->'heldResidueCounts' ? 'milestone_detections')
     or (v_r->'heldResidueCounts'->>'milestone_detections')::int <> 0 then
    raise exception 'FAIL: 8 heldResidueCounts.milestone_detections is 0, got %', v_r->'heldResidueCounts';
  end if;

  -- A second run deletes no assessment, so it writes no tombstone.
  perform discovery_purge_tenant(w, 'purge-tenant');
  perform pg_temp.expect((select count(*) from stage_assessments where tenant_id = w and trigger = 'purge'), 2,
    '8 a second run writes no tombstone');
  perform pg_temp.expect((select count(*) from discovery_recompute_requests where tenant_id = w), 1,
    '8 and asks for no recompute');
  raise notice 'PASS: 8 a deleted latest assessment leaves an audited tombstone and a recompute; a surviving one is untouched';
end
$$;

rollback;
