-- Demo only (#460), G-02b (#173): the source owner asks to accept a model proposal as a proposed deal
-- (20261023140100_model_proposal_accepts.sql). Who may ask, what one call writes, what it refuses and what it leaves
-- alone, read as each user under the authenticated role.
--
--   Alice      owns mailbox A (allowlisted), where the proposals were read; also owns B, off the allowlist
--   Colleague  has a mailbox of their own, with proposals of their own; a member, so no authority to accept
--   CCO        the control room of the tenant: holds the authority (firm_role) but owns no mailbox
--   Admin      a firm admin, who connects the team inbox: the same
--   Outsider   the control room of another tenant
--   Tess       a reader of the team inbox deals@dm.example, which holds a team row (put in as service, so
--              this suite does not depend on G-01's writer); a member, so no authority until a section lends her one
--
-- This file is built in two slices. Slice 2a is section 1, the request RPC:
--   grants, shape, who, guard, validation, request, audit, idempotent, owner scope, covered, closed, limit, reads,
--   then the tail: owner-wide, purge, withdrawn, removed.
-- Slice 2b is sections 2 to 4, the accept job's lifecycle (the service-role definers of 20261023140300), between
-- section 1 and the tail:
--   2. grants and arguments, claim, token, renew, live keys, write-ahead (the keys it records are the keys this source
--      does not already hold), stored, lease, the fourth claim, expiry (a pending request; an in-flight one whose lease
--      lapsed on a source that is paused, archived or past its age; every tenant at once)
--   3. finish: the re-key, the correction, the index link and the audit row; a merged survivor, a closed candidate,
--      a given failure code
--   4. purge: only what the request newly stored, with no evidence exemption: a promoted candidate, a crash while
--      storing, a shared item, the clear ids restored, a message the source already held (rules-routed), a second
--      accept of a group already linked, an item that is a colleague's evidence, and the collector
-- Between them and the tail, a section for the origin reads (20261023140400_discovery_origin_read.sql): the grants, a
-- non-finder deal member, the merge chain and the two-viewer merge, overseers, callers who may not know, the cap.
-- Slice 2b's cases run as the table owner under service_role claims and put the fixture back when they end (see the
-- note at the start of its block). The tail MUST stay last: it redefines app_owns_mailbox_source for the rest of the
-- transaction and deletes Alice's source B (so B, and its heron row, are gone after it).
--
-- Fixture a later section can reuse (all rows 3 hours old, one run, deal outcome, model-only `m:` keys):
--   A (Alice):   heron x5 rows over 4 messages (2 in phase-2, 2 in phase-3, one message read twice, under two prompt
--                versions), kite x2 (phase-2), plover x2 (phase-2), rejected, merged, open, shared (phase-2 each)
--   B (Alice, off the allowlist): heron x1
--   colleague:   osprey, shared
--   team:        tealx
--   Tess's own mailbox: nothing until the tail
-- Handles: v_src_a, v_src_b, v_src_coll, v_src_team, v_src_tess; v_alice, v_colleague, v_cco, v_admin, v_outsider, v_tess.
-- Requests made by section 1 stay in place (heron, kite, plover, open and shared on A, shared on the colleague's
-- mailbox); a later section should count by operation id, or by a delta, not by the tenant's total.
--
-- Authority first (design R3): the RPC resolves the tenant's bank and asks app_can_create_deals before it reads a
-- row, so a member (the colleague, Tess) and a tenant with no bank (the outsider's, until the suite gives it one) get
-- 42501 on any key, and the CCO and the admin, who hold the authority, are the personas that reach the owner-only
-- guard and get P0002 (design R11). The guard section lends the colleague and Tess the authority (firm_role) for a
-- moment to pin that the guard alone refuses a reader who is not the source's owner.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_model_proposal_accepts.sql
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

create function pg_temp.expect_text(actual text, expected text, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, coalesce(expected, '<null>'), coalesce(actual, '<null>');
  end if;
end;
$$;

create function pg_temp.flag(p boolean) returns bigint language sql as $$ select case when p then 1 else 0 end::bigint $$;

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'session_id', p_user, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.act_as_service()
returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
$$;

-- A signed-in role with no user: auth.uid() is null.
create function pg_temp.act_as_nobody()
returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
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

-- The same, with the message: 'sqlstate:message', or 'ok' (R12: the message must never carry the key).
create function pg_temp.attempt_msg(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
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
  select id into v_deal from deals where code = 'pd-' || v_tenant::text;
  if v_deal is null then
    insert into deals (tenant_id, code, codename, bank_id)
    values (v_tenant, 'pd-' || v_tenant::text, 'Accept fixture', v_company) returning id into v_deal;
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values (v_deal, p_user, (select id from roles where slug = 'deal_team'), 'deal_team')
  on conflict (deal_id, user_id) do nothing;
end;
$$;

-- One live 'deal' proposal row, put in by the table owner with its own phase and prompt version (a message can be read
-- again under another version: the table is unique per message, version and model).
create function pg_temp.put(p_tenant uuid, p_source uuid, p_message text, p_key text, p_name text, p_at timestamptz,
                            p_phase text default 'phase-2', p_version text default 'v2')
returns uuid language sql as $$
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, sent_at, outcome,
                                         deal_key, deal_name, phase, p_deal, p_phase,
                                         model, prompt_version, prompt_hash, run_id, created_at, updated_at)
  values (p_tenant, p_source, encode(sha256(convert_to(p_message, 'UTF8')), 'hex'),
          encode(sha256(convert_to('text of ' || p_message, 'UTF8')), 'hex'), '2026-03-02T10:00:00Z', 'deal',
          p_key, p_name, p_phase, 0.9, 0.6,
          'anthropic/claude-haiku-5.5', p_version, 'hash-' || p_version, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d',
          p_at, p_at)
  returning id;
$$;

-- The accept RPC's answer as a row: (operation_id, request_count).
create function pg_temp.accept(p_key text, p_step text)
returns table (operation_id uuid, request_count integer) language sql as $$
  select * from discovery_accept_model_proposal(p_key, p_step);
$$;

-- The refusal as 'sqlstate:message', or 'ok'.
create function pg_temp.accept_msg(p_key text, p_step text)
returns text language sql as $$
  select pg_temp.attempt_msg(format('select * from discovery_accept_model_proposal(%L, %L)', p_key, p_step));
$$;

-- Live requests of one key on one source, as the table owner would count them.
create function pg_temp.live_requests(p_source uuid, p_key text)
returns bigint language sql as $$
  select count(*) from discovery_model_proposal_accepts
  where content_source_id = p_source and deal_key = p_key and state in ('pending', 'running', 'storing', 'stored');
$$;

create function pg_temp.accept_audits(p_tenant uuid)
returns bigint language sql as $$
  select count(*) from audit_log where tenant_id = p_tenant and action = 'discovery.model_proposal_accept_requested';
$$;

-- ── Helpers of sections 2 to 4 (slice 2b): the accept job's side ──
-- The key of a Message-ID, as the proposals' message_key and the finish definer both derive it.
create function pg_temp.mk(p_message text)
returns text language sql immutable as $$ select encode(sha256(convert_to(p_message, 'UTF8')), 'hex') $$;

-- Message n of a fixture deal prefix (the ids pg_temp.puts writes), and its key.
create function pg_temp.m(p_prefix text, p_n integer)
returns text language sql immutable as $$ select '<ac-' || p_prefix || '-' || p_n || '>' $$;
create function pg_temp.k(p_prefix text, p_n integer)
returns text language sql immutable as $$ select pg_temp.mk(pg_temp.m(p_prefix, p_n)) $$;

-- p_n live 'deal' rows of the key m:project-<prefix> on one source, one message each, all phase-2.
create function pg_temp.puts(p_tenant uuid, p_source uuid, p_prefix text, p_n integer, p_at timestamptz)
returns void language sql as $$
  select pg_temp.put(p_tenant, p_source, pg_temp.m(p_prefix, g), 'm:project-' || p_prefix,
                     'Project ' || initcap(p_prefix), p_at)
  from generate_series(1, p_n) g
$$;

-- Alice's accept of a key (phase-2 step), made as herself; answers the id of the pending request it wrote.
create function pg_temp.alice_accepts(p_alice uuid, p_key text, p_step text default 'p2-s26')
returns uuid language plpgsql as $$
declare
  v_n integer;
begin
  set local role authenticated;
  perform pg_temp.act_as(p_alice);
  select a.request_count into v_n from pg_temp.accept(p_key, p_step) a;
  reset role;
  perform pg_temp.act_as_service();
  if v_n is distinct from 1 then
    raise exception 'FAIL: the fixture accept wrote % requests, expected 1', v_n;
  end if;
  return (select r.id from discovery_model_proposal_accepts r
          where r.deal_key = p_key and r.requested_by = p_alice and r.state = 'pending'
          order by r.requested_at desc, r.id desc limit 1);
end;
$$;

-- What the job's persist leaves for one message of one source: the item (one per tenant and Message-ID, kept when
-- another source stored it first), its text, this source's holder row, and a routed ledger row under p_method.
create function pg_temp.store(p_tenant uuid, p_source uuid, p_message text, p_provider text, p_conv text default null,
                              p_method text default 'model_proposal')
returns uuid language plpgsql as $$
declare
  v_item uuid;
begin
  insert into source_items (tenant_id, kind, subject, sent_at, internet_message_id, conversation_id, content_hash, created_at)
  values (p_tenant, 'message', 'Subject ' || p_message, '2026-03-02T10:00:00Z', p_message, p_conv, 'h-' || p_message,
          now() - interval '1 hour')
  on conflict (tenant_id, internet_message_id) do update set content_hash = source_items.content_hash
  returning id into v_item;
  insert into source_item_texts (source_item_id, body_text) values (v_item, 'body of ' || p_message)
  on conflict (source_item_id) do nothing;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_item, p_source, p_provider);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id)
  values (p_source, p_provider, 'h-' || p_message, 'routed', p_method, 0.9, gen_random_uuid());
  return v_item;
end;
$$;

-- The message index row the page write leaves: one row per message and source, listing every provider id it was read as.
create function pg_temp.index_it(p_tenant uuid, p_source uuid, p_message text, p_providers text[])
returns void language sql as $$
  select discovery_message_index_record(p_tenant, p_source,
    (select jsonb_agg(jsonb_build_object('provider_item_id', p, 'internet_message_id', p_message,
                                         'sent_at', '2026-03-02T10:00:00Z',
                                         'content_digest', 'hmac-sha256:' || pg_temp.mk('digest ' || p_message),
                                         'rules_version', 'rules-1'))
     from unnest(p_providers) p))
$$;

-- A candidate of the owner's cluster for a slug (model:u:<owner>:project-<prefix>).
create function pg_temp.cand(p_tenant uuid, p_owner uuid, p_prefix text, p_state text default 'proposed')
returns uuid language sql as $$
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, proposed_name)
  values (p_tenant, 'model:u:' || p_owner::text || ':project-' || p_prefix, p_state, 'Project ' || initcap(p_prefix))
  returning id
$$;

-- A candidate of any cluster key, state, merge target and promoted deal (the origin reads' section).
create function pg_temp.oc(p_tenant uuid, p_key text, p_state text default 'proposed', p_into uuid default null,
                           p_deal uuid default null)
returns uuid language sql as $$
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, promoted_deal_id, proposed_name)
  values (p_tenant, p_key, p_state, p_into, p_deal, 'Origin fixture')
  returning id
$$;

-- A firm evidence link of a stored message to a candidate, as the upsert writes one.
create function pg_temp.link_item(p_tenant uuid, p_cand uuid, p_message text, p_method text default 'model_proposal')
returns void language plpgsql as $$
begin
  insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier, state)
  select p_cand, i.id, p_method, 0.9, 'firm', 'proposed'
  from source_items i where i.tenant_id = p_tenant and i.internet_message_id = p_message;
  if not found then
    raise exception 'FAIL: fixture: no stored item to link';
  end if;
end;
$$;

-- The candidate becomes visible to the owner of p_source: one stored message there, linked firm, visibility refreshed.
create function pg_temp.seen(p_tenant uuid, p_source uuid, p_cand uuid, p_tag text)
returns void language plpgsql as $$
begin
  perform pg_temp.store(p_tenant, p_source, '<ac-or-' || p_tag || '>', 'or-' || p_tag);
  perform pg_temp.link_item(p_tenant, p_cand, '<ac-or-' || p_tag || '>');
  perform discovery_refresh_candidate_visibility(p_cand);
end;
$$;

-- The origin the caller reads for each of the candidates, as 'id=origin' sorted; ids not answered are absent.
create function pg_temp.origins(p_ids uuid[])
returns text language sql as $$
  select coalesce(string_agg(o.candidate_id::text || '=' || o.origin, ',' order by o.candidate_id::text collate "C"), '')
  from discovery_candidate_origins(p_ids) o
$$;

-- Counts and states the sections read.
create function pg_temp.holders(p_source uuid, p_message text)
returns bigint language sql as $$
  select count(*) from source_item_sources s join source_items i on i.id = s.source_item_id
  where s.content_source_id = p_source and i.internet_message_id = p_message
$$;
create function pg_temp.items(p_message text)
returns bigint language sql as $$ select count(*) from source_items where internet_message_id = p_message $$;
create function pg_temp.texts(p_message text)
returns bigint language sql as $$
  select count(*) from source_item_texts t join source_items i on i.id = t.source_item_id
  where i.internet_message_id = p_message
$$;
create function pg_temp.index_rows(p_source uuid, p_message text)
returns bigint language sql as $$
  select count(*) from discovery_message_index where content_source_id = p_source and message_key = pg_temp.mk(p_message)
$$;
create function pg_temp.st(p_request uuid)
returns text language sql as $$ select state from discovery_model_proposal_accepts where id = p_request $$;
-- A ledger row as 'decision/method/conversation/message-id' ('-' for null), or null when there is none.
create function pg_temp.ledger(p_source uuid, p_provider text)
returns text language sql as $$
  select l.decision || '/' || coalesce(l.method, '-') || '/' || coalesce(l.conversation_id, '-') || '/'
         || coalesce(l.internet_message_id, '-')
  from routing_ledger l where l.source_id = p_source and l.provider_item_id = p_provider
$$;
create function pg_temp.finish_audits(p_request uuid)
returns bigint language sql as $$
  select count(*) from audit_log
  where action = 'discovery.model_proposal_accept_finished' and detail ->> 'requestId' = p_request::text
$$;
create function pg_temp.finished(p_request uuid)
returns jsonb language sql as $$
  select detail from audit_log
  where action = 'discovery.model_proposal_accept_finished' and detail ->> 'requestId' = p_request::text
  order by chain_seq limit 1
$$;
create function pg_temp.keys_of(p_detail jsonb)
returns text language sql as $$ select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(p_detail) k $$;

-- A key array as sorted, distinct text; null stays null (so a refusal is told from an empty answer).
create function pg_temp.skeys(p_keys text[])
returns text language sql immutable as $$
  select case when p_keys is null then null else array(select distinct x from unnest(p_keys) x order by x)::text end
$$;

-- The write-ahead of keys this source holds none of: the call must answer exactly those keys, so every one may be persisted.
create function pg_temp.mark_all(p_request uuid, p_token text, p_keys text[], p_label text)
returns void language plpgsql as $$
begin
  perform pg_temp.expect_text(
    pg_temp.skeys(discovery_mark_model_proposal_accept_storing(p_request, p_token, p_keys)), pg_temp.skeys(p_keys), p_label);
end;
$$;

-- A request row put in directly (another tenant's, which the accept RPC cannot reach as Alice), with a snapshot that
-- matches no proposal row: pending, or claimed by a job that is gone ('running', the lease lapsed a minute ago).
create function pg_temp.raw_request(p_tenant uuid, p_source uuid, p_user uuid, p_slug text, p_state text, p_age interval)
returns uuid language sql as $$
  insert into discovery_model_proposal_accepts (tenant_id, content_source_id, deal_key, operation_id, requested_by,
                                                requested_at, proposal_ids, message_keys, item_hashes, cluster_key,
                                                proposed_step_id, proposed_phase, placed_count, email_count,
                                                state, claim_token, lease_until, attempts)
  values (p_tenant, p_source, 'm:' || p_slug, gen_random_uuid(), p_user, now() - p_age,
          array[gen_random_uuid()], array[repeat('a', 64)], array[repeat('b', 64)],
          'model:u:' || p_user::text || ':' || p_slug, 'p2-s26', 'phase-2', 1, 1,
          p_state, case when p_state = 'pending' then null else 'raw-job' end,
          case when p_state = 'pending' then null else now() - interval '1 minute' end,
          case when p_state = 'pending' then 0 else 1 end)
  returning id
$$;

-- Alice's accept of a fresh key on mailbox A (p_n phase-2 messages), claimed by 'job-<prefix>' and taken to p_state:
-- 'running'; 'storing' (every key recorded in the write-ahead, the first p_stored persisted: holder, text, routed
-- ledger row); or 'stored' (the same, the persist marked done). Answers the request id.
create function pg_temp.drive(p_tenant uuid, p_source uuid, p_alice uuid, p_prefix text, p_n integer, p_state text,
                              p_stored integer)
returns uuid language plpgsql as $$
declare
  v_req uuid;
  v_i   integer;
begin
  perform pg_temp.puts(p_tenant, p_source, p_prefix, p_n, now() - interval '3 hours');
  v_req := pg_temp.alice_accepts(p_alice, 'm:project-' || p_prefix);
  perform count(*) from discovery_claim_model_proposal_accepts(p_source, 'job-' || p_prefix, interval '75 minutes');
  if p_state in ('storing', 'stored') then
    perform pg_temp.mark_all(v_req, 'job-' || p_prefix, array(select pg_temp.k(p_prefix, g) from generate_series(1, p_n) g),
                             p_prefix || ': write-ahead');
    for v_i in 1..p_stored loop
      perform pg_temp.store(p_tenant, p_source, pg_temp.m(p_prefix, v_i), p_prefix || '-' || v_i, 'conv-' || p_prefix);
    end loop;
  end if;
  if p_state = 'stored' then
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(v_req, 'job-' || p_prefix)), 1,
                           p_prefix || ': stored');
  end if;
  perform pg_temp.expect_text(pg_temp.st(v_req), p_state, p_prefix || ': driven to its state');
  return v_req;
end;
$$;

-- A request the expiry finished: failed source_unavailable under the expiry's own token, nothing found or changed, the
-- given number of holder rows purged, one finish audit row by the discovery worker with ids, an outcome word and counts.
create function pg_temp.expect_expired(p_request uuid, p_purged bigint, p_label text)
returns void language plpgsql as $$
declare
  v_detail jsonb := pg_temp.finished(p_request);
begin
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
      where id = p_request and state = 'failed' and failure_code = 'source_unavailable' and claim_token like 'expire:%'
        and found_count = 0 and changed_count = 0 and purged_count = p_purged and finished_at = now()
        and lease_until is null and candidate_id is null), 1,
    p_label || ': failed source_unavailable under the expiry''s token, purged ' || p_purged);
  perform pg_temp.expect(pg_temp.finish_audits(p_request), 1, p_label || ': one finish audit row');
  perform pg_temp.expect_text(pg_temp.keys_of(v_detail), 'changed,found,operationId,outcome,purged,requestId,requested,requestedBy',
    p_label || ': the audit row holds ids, an outcome word and counts only');
  perform pg_temp.expect_text(v_detail ->> 'outcome', 'source_unavailable', p_label || ': audited as source_unavailable');
  perform pg_temp.expect((v_detail ->> 'purged')::bigint, p_purged, p_label || ': the audit row counts the purge');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.model_proposal_accept_finished'
      and detail ->> 'requestId' = p_request::text and actor_type = 'service' and service_identity = 'discovery-worker'
      and actor_id is null and chain_seq is not null), 1, p_label || ': by the discovery worker, on the chain');
end;
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

do $$
declare
  v_tenant     uuid := gen_random_uuid();
  v_other      uuid := gen_random_uuid();
  v_alice      uuid := gen_random_uuid();
  v_colleague  uuid := gen_random_uuid();
  v_cco        uuid := gen_random_uuid();
  v_admin      uuid := gen_random_uuid();
  v_outsider   uuid := gen_random_uuid();
  v_tess       uuid := gen_random_uuid();
  v_bank       uuid := gen_random_uuid();
  v_old        timestamptz := now() - interval '3 hours';
  v_out        jsonb;
  v_tm         uuid;
  v_src_a      uuid;
  v_src_b      uuid;
  v_src_coll   uuid;
  v_src_team   uuid;
  v_src_tess   uuid;
  v_props      bigint;
  v_n          integer;
  v_i          integer;
  v_key        text;
  v_who        uuid;
  v_op         uuid;
  v_op2        uuid;
  v_op_a       uuid;
  v_detail     jsonb;
  v_audit      bigint;
  v_cands      bigint;
  v_corr       bigint;
  v_items      bigint;
  v_deals      bigint;
  v_row        uuid;
  v_surv       uuid;
  v_surv_c     uuid;
  v_surv_r     uuid;
  v_mid        uuid;
  v_aux        uuid;
begin
  -- ── Fixture, as the table owner (the seating of discovery_model_proposal_dismissals.sql) ──
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alice,     'ac-alice@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_colleague, 'ac-colleague@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_cco,       'ac-cco@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance')),
    (v_admin,     'ac-admin@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_outsider,  'ac-outsider@example.test',  jsonb_build_object('tenant_id', v_other, 'department', 'compliance')),
    (v_tess,      'ac-tess@example.test',      jsonb_build_object('tenant_id', v_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false
   where id in (v_alice, v_colleague, v_cco, v_admin, v_outsider, v_tess);
  update users set firm_role = 'cco' where id in (v_cco, v_outsider);
  update users set firm_role = 'admin' where id = v_admin;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values
    (v_tenant, 'fixture', 'fixture', 'active'),
    (v_other, 'fixture', 'fixture', 'active');
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'AC Bank', 'bank');
  -- The director first: company_has_director refuses a bank of members only.
  update users set company_id = v_bank, company_role = 'director' where id = v_alice;
  update users set company_id = v_bank, company_role = 'member' where id in (v_colleague, v_cco, v_admin, v_tess);
  update graph_reader_registrations set mailbox_domains = '{bank.example}', firm_company_id = v_bank where tenant_id = v_tenant;
  -- The team inbox reader (Google), as in discovery_model_proposals.sql's barrier block.
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_tenant, 'dm.example', 'dwd-reader@proj-73.iam.gserviceaccount.com', '723456789012345670',
     'dir-reader@proj-73.iam.gserviceaccount.com', 'conductia-ingest@dm.example', v_bank, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (gen_random_uuid(), v_tenant, 'alice@bank.example',     v_alice, v_bank, 'director', 'accepted', 'sent', now(), v_alice),
    (gen_random_uuid(), v_tenant, 'colleague@bank.example', v_alice, v_bank, 'member',   'accepted', 'sent', now(), v_colleague),
    (gen_random_uuid(), v_tenant, 'tess@bank.example',      v_alice, v_bank, 'member',   'accepted', 'sent', now(), v_tess);
  perform pg_temp.on_deal(u) from unnest(array[v_alice, v_colleague, v_tess]) u;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_colleague);
  perform mailbox_consent_grant();
  perform pg_temp.act_as(v_tess);
  perform mailbox_consent_grant();
  -- The team inbox, connected by the firm admin and confirmed by the Directory check.
  perform pg_temp.act_as(v_admin);
  v_out := discovery_connect_team_mailbox('deals@dm.example', 1);
  reset role;
  perform pg_temp.act_as_service();
  v_tm       := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_team := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  select id into v_src_a    from content_sources where tenant_id = v_tenant and address = 'alice@bank.example' and owner_user_id = v_alice;
  select id into v_src_coll from content_sources where tenant_id = v_tenant and address = 'colleague@bank.example' and owner_user_id = v_colleague;
  select id into v_src_tess from content_sources where tenant_id = v_tenant and address = 'tess@bank.example' and owner_user_id = v_tess;
  if v_tm is null or v_src_team is null or v_src_a is null or v_src_coll is null or v_src_tess is null then
    raise exception 'FAIL: the fixture did not create its sources';
  end if;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-ac');
  -- Alice's second source B: hers, but off the allowlist (an owner has one allowlisted address).
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
    values (v_tenant, 'mailbox', 'alice.alt@bank.example', v_alice, 'microsoft') returning id into v_src_b;
  -- Tess reads the team inbox, as a member.
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_tess);
  reset role;
  perform pg_temp.act_as_service();

  -- The proposal rows, all created three hours ago.
  --   A:         heron (5 rows, 4 messages: phase-2 x2, phase-3 x2, and heron-1 read again under prompt v3),
  --              kite x2, plover x2, rejected, merged, open, shared
  --   B:         heron
  --   colleague: osprey, shared
  --   team:      tealx, put in as service
  perform pg_temp.put(v_tenant, v_src_a, '<ac-heron-1>', 'm:project-heron', 'Project Heron', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-heron-2>', 'm:project-heron', 'Project Heron', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-heron-3>', 'm:project-heron', 'Project Heron', v_old, 'phase-3');
  perform pg_temp.put(v_tenant, v_src_a, '<ac-heron-4>', 'm:project-heron', 'Project Heron', v_old, 'phase-3');
  perform pg_temp.put(v_tenant, v_src_a, '<ac-heron-1>', 'm:project-heron', 'Project Heron', v_old, 'phase-2', 'v3');
  perform pg_temp.put(v_tenant, v_src_a, '<ac-kite-1>', 'm:project-kite', 'Project Kite', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-kite-2>', 'm:project-kite', 'Project Kite', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-plover-1>', 'm:project-plover', 'Project Plover', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-plover-2>', 'm:project-plover', 'Project Plover', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-rejected-1>', 'm:project-rejected', 'Project Rejected', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-merged-1>', 'm:project-merged', 'Project Merged', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-open-1>', 'm:project-open', 'Project Open', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-shared-a>', 'm:project-shared', 'Project Shared', v_old);
  perform pg_temp.put(v_tenant, v_src_b, '<ac-heron-b>', 'm:project-heron', 'Project Heron', v_old);
  perform pg_temp.put(v_tenant, v_src_coll, '<ac-osprey-1>', 'm:project-osprey', 'Project Osprey', v_old);
  perform pg_temp.put(v_tenant, v_src_coll, '<ac-shared-c>', 'm:project-shared', 'Project Shared', v_old);
  perform pg_temp.put(v_tenant, v_src_team, '<ac-tealx-1>', 'm:project-tealx', 'Project Tealx', v_old);
  -- A live pass of the team inbox for the rows' run, as the table owner (G-01's begin definer needs a reviewed
  -- approval row): what makes the team rows readable to the inbox's readers under G-01's policy.
  insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id,
                                              path, lease_until)
    values (v_tenant, v_src_team, v_tm, v_bank, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d', 'recorded', now() + interval '30 minutes');
  select count(*) into v_props from discovery_model_proposals where tenant_id = v_tenant;
  perform pg_temp.expect(v_props, 17, 'fixture: seventeen proposal rows');

  perform pg_temp.expect(pg_temp.flag(app_owns_mailbox_source(v_src_a, v_tenant, v_alice)), 1,
    'premise: Alice owns mailbox A on the allowlist');
  perform pg_temp.expect(pg_temp.flag(app_owns_mailbox_source(v_src_b, v_tenant, v_alice)), 0,
    'premise: Alice''s mailbox B is off the allowlist, so she does not read it');
  perform pg_temp.expect(pg_temp.flag(app_can_read_model_proposal(v_src_a, v_tenant, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d',
      'm:project-heron', null, v_alice)), 1, 'premise: the read helper admits Alice on her heron rows');
  perform pg_temp.expect(pg_temp.flag(app_can_read_model_proposal(v_src_team, v_tenant, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d',
      'm:project-tealx', null, v_tess)), 1, 'premise: the helper admits the team reader on the team row');
  perform pg_temp.expect(pg_temp.flag(app_can_create_deals(v_alice, v_bank)), 1, 'premise: Alice, a director, may create deals');
  perform pg_temp.expect(pg_temp.flag(app_can_create_deals(v_colleague, v_bank)), 0, 'premise: a member may not');
  perform pg_temp.expect(pg_temp.flag(app_can_create_deals(v_tess, v_bank)), 0, 'premise: nor may the team reader');
  perform pg_temp.expect(pg_temp.flag(app_can_create_deals(v_cco, v_bank)), 1, 'premise: the CCO may (firm role)');
  perform pg_temp.expect(pg_temp.flag(app_can_create_deals(v_admin, v_bank)), 1, 'premise: the firm admin may');

  -- What the accept RPC must leave alone, counted once now.
  select count(*) into v_cands from deal_candidates where tenant_id = v_tenant;
  select count(*) into v_corr from corrections where tenant_id = v_tenant;
  select count(*) into v_items from source_items where tenant_id = v_tenant;
  select count(*) into v_deals from deals where tenant_id = v_tenant;
  raise notice 'PASS: fixture';

  -- ── Grants: nobody signed in writes a request; anon asks nothing ──────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts), 0, 'no request yet');
  perform pg_temp.expect_attempt(format(
      'insert into discovery_model_proposal_accepts (tenant_id, content_source_id, deal_key, operation_id, requested_by, proposal_ids, message_keys, item_hashes, cluster_key, proposed_step_id, proposed_phase, placed_count, email_count) values (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, 1, 1)',
      v_tenant, v_src_a, 'm:project-heron', gen_random_uuid(), v_alice, array[gen_random_uuid()],
      array[repeat('a', 64)], array[repeat('b', 64)], 'model:u:' || v_alice::text || ':project-heron', 'p3-s39', 'phase-3'),
    '42501', 'the owner cannot write a request straight into the table');
  perform pg_temp.expect_attempt('update discovery_model_proposal_accepts set state = ''done''', '42501', 'nor update one');
  perform pg_temp.expect_attempt('delete from discovery_model_proposal_accepts', '42501', 'nor delete one');
  reset role;
  set local role anon;
  perform pg_temp.expect_attempt('select 1 from discovery_model_proposal_accepts limit 1', '42501', 'anon cannot read requests');
  perform pg_temp.expect_attempt(format('select * from discovery_accept_model_proposal(%L, %L)', 'm:project-heron', 'p3-s39'),
    '42501', 'anon cannot accept');
  reset role;
  raise notice 'PASS: grants';

  -- ── Shape: a bad key or step is refused with a fixed message that never echoes it (R12) ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_i := 0;
  foreach v_key in array array['m:Project Heron', 'm:', 'x:project-heron', 'c:' || gen_random_uuid()::text, 'c:not-a-uuid',
                               'm:' || repeat('a', 65), 'm:project-heron;', ''] loop
    v_i := v_i + 1;
    perform pg_temp.expect_text(pg_temp.accept_msg(v_key, 'p3-s39'),
      '22023:invalid_deal_key', format('bad key %s is refused with the fixed message', v_i));
  end loop;
  perform pg_temp.expect_text(pg_temp.attempt_msg('select * from discovery_accept_model_proposal(null::text, ''p3-s39'')'),
    '22023:invalid_deal_key', 'a null key is refused the same way');
  v_i := 0;
  foreach v_key in array array['p0-s1', 'p6-s1', 'p3-s', 'p3-s1;', 'P3-S1', 'x', ''] loop
    v_i := v_i + 1;
    perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', v_key),
      '22023:invalid_proposed_step', format('bad step %s is refused with the fixed message', v_i));
  end loop;
  perform pg_temp.expect_text(pg_temp.attempt_msg('select * from discovery_accept_model_proposal(''m:project-heron'', null::text)'),
    '22023:invalid_proposed_step', 'a null step is refused the same way');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-nowhere', 'p3-s39'),
    'P0002:not_visible', 'a well-formed key with no row is not visible, and the message does not name it');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_tenant), 0,
    'the refusals wrote no request');
  raise notice 'PASS: shape';

  -- ── Who: the authority, then the owner of the personal source; nobody else ──
  set local role authenticated;
  perform pg_temp.act_as_nobody();
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    '42501:not_authenticated', 'a session with no user is refused');
  -- No authority: a member, on Alice's key and on their own; the team reader; another tenant (no bank to resolve).
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    '42501:no_authority', 'a member has no authority to accept (Alice''s key)');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-osprey', 'p2-s26'),
    '42501:no_authority', 'nor on their own key: the authority is judged before the rows');
  perform pg_temp.act_as(v_tess);
  perform pg_temp.expect_attempt(format('select * from discovery_accept_model_proposal(%L, %L)', 'm:project-tealx', 'p2-s26'), '42501',
    'the team reader, a member, has no authority');
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    '42501:no_authority', 'another tenant''s control room has no bank to resolve, so no authority');
  -- Authority, but not the owner: P0002, the same fixed message as a key with no row.
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    'P0002:not_visible', 'the CCO holds the authority but is not the owner of any source');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    'P0002:not_visible', 'nor the firm admin');
  reset role;
  -- The outsider's tenant gets a bank: now the authority resolves and the tenant boundary alone refuses.
  insert into companies (id, tenant_id, name, type) values (gen_random_uuid(), v_other, 'AC Other Bank', 'bank');
  set local role authenticated;
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    'P0002:not_visible', 'with a bank of their own, another tenant still cannot accept this tenant''s proposal');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id in (v_tenant, v_other)), 0,
    'the refusals wrote no request');
  perform pg_temp.expect(pg_temp.accept_audits(v_tenant), 0, 'and no audit row');
  raise notice 'PASS: who';

  -- ── Guard (R11): a reader with the authority who does not own the source is still refused ──
  -- The authority is lent for the section (firm_role): the owner-only guard alone stands between them and a request.
  update users set firm_role = 'admin' where id in (v_colleague, v_tess);
  perform pg_temp.expect(pg_temp.flag(app_can_create_deals(v_tess, v_bank)), 1, 'premise: Tess now holds the authority');
  set local role authenticated;
  perform pg_temp.act_as(v_tess);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-tealx', 'p2-s26'),
    'P0002:not_visible', 'the team reader the helper admits is refused a team row (R11)');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    'P0002:not_visible', 'and Alice''s key');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-tealx', 'p2-s26'),
    'P0002:not_visible', 'the CCO is refused a team row');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-tealx', 'p2-s26'),
    'P0002:not_visible', 'and the firm admin, who connected the inbox');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s39'),
    'P0002:not_visible', 'a colleague with the authority cannot accept Alice''s proposal');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-tealx', 'p2-s26'),
    'P0002:not_visible', 'nor a team row');
  reset role;
  update users set firm_role = null where id in (v_colleague, v_tess);
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_tenant), 0,
    'the owner-only guard wrote no request');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id = v_src_team), 0,
    'none on the team inbox');
  raise notice 'PASS: guard';

  -- ── Validation: the proposed phase is the group's highest; the step must belong to it ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  -- heron splits 2/2 over phase-2 and phase-3: the higher phase wins, so a phase-2 step is refused.
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p2-s26'),
    '22023:invalid_proposed_step', 'on a 2/2 split a step of the lower phase is refused');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p1-s7'),
    '22023:invalid_proposed_step', 'and so is a step of an absent phase');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p4-s46'),
    '22023:invalid_proposed_step', 'and of a higher one');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-kite', 'p3-s39'),
    '22023:invalid_proposed_step', 'a phase-2 group refuses a phase-3 step');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-kite', 'p1-s7'),
    '22023:invalid_proposed_step', 'and a phase-1 step');
  -- Only the canonical station of the phase (p1-s7, p2-s26, p3-s39, p4-s46, p5-s51) is accepted: another step of the
  -- right phase is refused too, as is a step that does not exist.
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s40'),
    '22023:invalid_proposed_step', 'a non-canonical step of the right phase (p3-s40) is refused');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s1'),
    '22023:invalid_proposed_step', 'and so is the first step of the phase (p3-s1)');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-kite', 'p2-s21'),
    '22023:invalid_proposed_step', 'a phase-2 group refuses another step of phase 2 (p2-s21)');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-kite', 'p2-s1'),
    '22023:invalid_proposed_step', 'and p2-s1');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-kite', 'p2-s999'),
    '22023:invalid_proposed_step', 'a step that does not exist (p2-s999) is refused the same way');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s999'),
    '22023:invalid_proposed_step', 'on a phase-3 group too (p3-s999)');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_tenant), 0,
    'the refusals wrote no request');
  perform pg_temp.expect(pg_temp.accept_audits(v_tenant), 0, 'and no audit row');
  raise notice 'PASS: validation';

  -- ── Request: one row per source, one operation, one audit row; nothing else is touched ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op, v_n from pg_temp.accept('m:project-heron', 'p3-s39');
  reset role;
  perform pg_temp.expect(v_n, 1, 'the owner''s call writes one request, for her one readable source');
  perform pg_temp.expect(pg_temp.flag(v_op is not null), 1, 'and returns its operation id');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_tenant), 1,
    'one request row is written');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts a
      where a.operation_id = v_op and a.tenant_id = v_tenant and a.content_source_id = v_src_a
        and a.deal_key = 'm:project-heron' and a.requested_by = v_alice and a.requested_at = now()
        and a.cluster_key = 'model:u:' || v_alice::text || ':project-heron'
        and a.proposed_step_id = 'p3-s39' and a.proposed_phase = 'phase-3'
        and a.placed_count = 2 and a.email_count = 4
        and a.state = 'pending' and a.attempts = 0 and a.claim_token is null and a.lease_until is null
        and a.storing_keys is null and a.candidate_id is null
        and a.found_count = 0 and a.changed_count = 0 and a.purged_count = 0
        and a.finished_at is null and a.failure_code is null), 1,
    'on mailbox A, by Alice, pending, proposing phase-3 with 2 of 4 messages placed there, nothing claimed or counted');
  perform pg_temp.expect_text((select proposal_ids::text from discovery_model_proposal_accepts where operation_id = v_op),
    (select array_agg(id order by id)::text from discovery_model_proposals
      where content_source_id = v_src_a and deal_key = 'm:project-heron'),
    'it lists exactly the five heron rows of mailbox A it read (the snapshot)');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts a
      cross join lateral unnest(a.proposal_ids, a.message_keys, a.item_hashes) as u(pid, mk, ih)
      join discovery_model_proposals p on p.id = u.pid and p.message_key = u.mk and p.item_hash = u.ih
      where a.operation_id = v_op), 5,
    'the three arrays run in parallel: each row''s id, message key and hash agree');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id = v_src_b), 0,
    'none on mailbox B, which she does not read');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id in (v_src_coll, v_src_team)), 0,
    'none on a colleague''s or the team''s');
  -- It stores the request and touches nothing else (design R3).
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), v_props,
    'the proposals are kept');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant
      and deal_key = 'm:project-heron' and archived_at is null and updated_at = created_at), 6,
    'and untouched: a request is its own row, never a change to a proposal');
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant), v_cands, 'no candidate is made');
  perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), v_corr, 'no correction');
  perform pg_temp.expect((select count(*) from source_items where tenant_id = v_tenant), v_items, 'no mail is read or stored');
  perform pg_temp.expect((select count(*) from deals where tenant_id = v_tenant), v_deals, 'no deal');
  perform pg_temp.expect((select count(*) from evidence_links l join deal_candidates c on c.id = l.candidate_id
      where c.tenant_id = v_tenant and c.cluster_key like 'model:%'), 0, 'no evidence link');

  -- A second key of the same source is its own request, under its own operation.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-kite', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, 'a second key of the source writes a request');
  perform pg_temp.expect(pg_temp.flag(v_op2 is distinct from v_op), 1, 'under a new operation');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where operation_id = v_op2
      and deal_key = 'm:project-kite' and content_source_id = v_src_a and proposed_phase = 'phase-2'
      and placed_count = 2 and email_count = 2 and cluster_key = 'model:u:' || v_alice::text || ':project-kite'), 1,
    'a phase-2 group of two messages, all placed in the proposed phase');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_tenant), 2,
    'two requests: heron and kite');
  raise notice 'PASS: request';

  -- ── Audit: one row per call, ids, a step id and counts only ───────────────
  perform pg_temp.expect(pg_temp.accept_audits(v_tenant), 2, 'one audit row per call');
  select detail into v_detail from audit_log where tenant_id = v_tenant
    and action = 'discovery.model_proposal_accept_requested' and detail ->> 'operationId' = v_op::text;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_accept_requested' and detail ->> 'operationId' = v_op::text
      and actor_id = v_alice and actor_type = 'user' and deal_id is null and chain_seq is not null), 1,
    'by the user, on the chain');
  perform pg_temp.expect_text((select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(v_detail) k),
    'messageCount,operationId,proposedStepId,requestIds,sourceCount', 'the detail keys are exactly the id, step and count set');
  perform pg_temp.expect_text(v_detail ->> 'operationId', v_op::text, 'it names the operation');
  perform pg_temp.expect_text((v_detail -> 'requestIds')::text,
    (select jsonb_build_array(id)::text from discovery_model_proposal_accepts where operation_id = v_op), 'and the request ids');
  perform pg_temp.expect_text(v_detail ->> 'proposedStepId', 'p3-s39', 'the proposed step id');
  perform pg_temp.expect((v_detail ->> 'sourceCount')::bigint, 1, 'one source');
  perform pg_temp.expect((v_detail ->> 'messageCount')::bigint, 4, 'four distinct messages, not five rows');
  perform pg_temp.expect(pg_temp.flag(v_detail::text ~* '(heron|project|kite|bank|example)'), 0,
    'no key, slug, deal name or address in the audit detail');
  raise notice 'PASS: audit';

  -- ── Idempotent: a repeat or a second tab writes nothing ──────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-heron', 'p3-s39');
  perform pg_temp.expect(v_n, 0, 'a repeat returns 0 requests');
  perform pg_temp.expect_text(v_op2::text, v_op::text, 'and the same operation');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p3-s2'), '22023:invalid_proposed_step',
    'a repeat is still validated: a non-canonical step of the right phase is refused, not answered');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-heron', 'p2-s26'), '22023:invalid_proposed_step',
    'and so is a step of the wrong phase');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_tenant), 2,
    'still two requests');
  perform pg_temp.expect(pg_temp.accept_audits(v_tenant), 2, 'still two audit rows');
  -- The backstop: a second live request of one source and key is refused by the partial unique index, even from the
  -- table owner.
  perform pg_temp.expect_attempt(
    'insert into discovery_model_proposal_accepts (tenant_id, content_source_id, deal_key, operation_id, requested_by, proposal_ids, message_keys, item_hashes, cluster_key, proposed_step_id, proposed_phase, placed_count, email_count)
     select tenant_id, content_source_id, deal_key, gen_random_uuid(), requested_by, proposal_ids, message_keys, item_hashes, cluster_key, proposed_step_id, proposed_phase, placed_count, email_count
     from discovery_model_proposal_accepts where deal_key = ''m:project-heron''',
    '23505', 'the index refuses a second live request of one source and key');
  raise notice 'PASS: idempotent';

  -- ── Owner scope: the owner's own sources only, never a colleague's ─────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op_a, v_n from pg_temp.accept('m:project-shared', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, 'Alice accepts a key the colleague also holds: one request');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where operation_id = v_op_a
      and content_source_id = v_src_a and email_count = 1), 1, 'on her own mailbox, her one message');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where deal_key = 'm:project-shared'
      and content_source_id = v_src_coll), 0, 'the colleague''s row is not in it');
  select detail into v_detail from audit_log where tenant_id = v_tenant
    and action = 'discovery.model_proposal_accept_requested' and detail ->> 'operationId' = v_op_a::text;
  perform pg_temp.expect((v_detail ->> 'sourceCount')::bigint, 1, 'one source in the audit row');
  perform pg_temp.expect((v_detail ->> 'messageCount')::bigint, 1, 'and one message');
  -- The colleague, lent the authority, accepts their own row of the same key: their own request, their own operation.
  update users set firm_role = 'admin' where id = v_colleague;
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-shared', 'p2-s26');
  reset role;
  update users set firm_role = null where id = v_colleague;
  perform pg_temp.expect(v_n, 1, 'the colleague, with the authority, accepts their own row of that key');
  perform pg_temp.expect(pg_temp.flag(v_op2 is distinct from v_op_a), 1, 'under their own operation');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where operation_id = v_op2
      and content_source_id = v_src_coll and requested_by = v_colleague
      and cluster_key = 'model:u:' || v_colleague::text || ':project-shared'), 1,
    'on their mailbox, for their cluster: the candidate is the owner''s, per slug');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where deal_key = 'm:project-shared'), 2,
    'two requests of the key, one per owner');
  perform pg_temp.expect(pg_temp.accept_audits(v_tenant), 4, 'four audit rows: heron, kite, and shared twice');
  raise notice 'PASS: owner scope';

  -- ── Covered: a row a live dismissal covers is not offered (the dismissals' link, 20261023120100) ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((discovery_dismiss_model_proposal('m:project-plover') ->> 'dismissed')::bigint, 1,
    'premise: Alice dismisses plover on mailbox A');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-plover', 'p2-s26'),
    'P0002:not_visible', 'a key whose every row is covered is not visible to accept');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where deal_key = 'm:project-plover'), 0,
    'and writes nothing');
  -- A row the dismissal never read is offered, and it alone is requested.
  v_row := pg_temp.put(v_tenant, v_src_a, '<ac-plover-3>', 'm:project-plover', 'Project Plover', v_old);
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-plover', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, 'a new row of the dismissed key brings it back');
  perform pg_temp.expect_text((select proposal_ids::text from discovery_model_proposal_accepts where operation_id = v_op2),
    array[v_row]::text, 'the request lists only the uncovered row');
  perform pg_temp.expect((select email_count from discovery_model_proposal_accepts where operation_id = v_op2), 1,
    'one message');
  perform pg_temp.expect((select (detail ->> 'messageCount')::bigint from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_accept_requested' and detail ->> 'operationId' = v_op2::text), 1,
    'and the audit row counts one');
  raise notice 'PASS: covered';

  -- ── Closed: the owner's candidate for this slug was rejected, or merged into a survivor that is not live (R3) ──
  -- A merge away closes the slug only when the chain's final survivor is not proposed or confirmed: the finish step
  -- routes new evidence to the survivor, so a candidate merged into a live one still accepts.
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, proposed_name) values
    (v_tenant, 'model:u:' || v_alice::text || ':project-rejected', 'rejected', 'Project Rejected'),
    (v_tenant, 'model:u:' || v_alice::text || ':project-open', 'proposed', 'Project Open'),
    -- Another owner's closed candidate of the same slug does not close Alice's.
    (v_tenant, 'model:u:' || v_colleague::text || ':project-open', 'rejected', 'Project Open');
  -- Survivors: proposed, confirmed, rejected.
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-survivor', 'proposed', 'Project Survivor')
    returning id into v_surv;
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-survivor-confirmed', 'confirmed', 'Project Survivor Confirmed')
    returning id into v_surv_c;
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-survivor-rejected', 'rejected', 'Project Survivor Rejected')
    returning id into v_surv_r;
  -- One hop: the slug's candidate is merged into a survivor.
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name) values
    (v_tenant, 'model:u:' || v_alice::text || ':project-merged', 'merged_into', v_surv, 'Project Merged'),
    (v_tenant, 'model:u:' || v_alice::text || ':project-mconf', 'merged_into', v_surv_c, 'Project Mconf'),
    (v_tenant, 'model:u:' || v_alice::text || ':project-mrej', 'merged_into', v_surv_r, 'Project Mrej');
  -- Two hops. A merge re-points what was merged into the merged candidate, so chains are flat in practice: these are
  -- built by direct insert as the table owner. chain -> mid -> proposed survivor; chainrej -> midrej -> rejected one.
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-mid', 'merged_into', v_surv, 'Project Mid')
    returning id into v_mid;
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-chain', 'merged_into', v_mid, 'Project Chain');
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-midrej', 'merged_into', v_surv_r, 'Project Midrej')
    returning id into v_mid;
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-chainrej', 'merged_into', v_mid, 'Project Chainrej');
  -- A cycle (impossible through the merge definer): loop -> loopb -> loop. It never reaches a live survivor.
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-loop', 'proposed', 'Project Loop')
    returning id into v_aux;
  insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name)
    values (v_tenant, 'model:u:' || v_alice::text || ':project-loopb', 'merged_into', v_aux, 'Project Loopb')
    returning id into v_mid;
  update deal_candidates set discovery_state = 'merged_into', merged_into_id = v_mid where id = v_aux;
  -- The keys' proposal rows (merged is part of the base fixture). These extra keys are removed again below.
  perform pg_temp.put(v_tenant, v_src_a, '<ac-mconf-1>', 'm:project-mconf', 'Project Mconf', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-mrej-1>', 'm:project-mrej', 'Project Mrej', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-chain-1>', 'm:project-chain', 'Project Chain', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-chainrej-1>', 'm:project-chainrej', 'Project Chainrej', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<ac-loop-1>', 'm:project-loop', 'Project Loop', v_old);
  v_audit := pg_temp.accept_audits(v_tenant);
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-rejected', 'p2-s26'),
    '55000:candidate_closed', 'a rejected candidate closes the slug');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-mrej', 'p2-s26'),
    '55000:candidate_closed', 'a candidate merged into a rejected survivor is closed');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-chainrej', 'p2-s26'),
    '55000:candidate_closed', 'and so is a two-hop chain that ends in a rejected survivor');
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-loop', 'p2-s26'),
    '55000:candidate_closed', 'a merge cycle never reaches a live survivor: closed, and the walk ends');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
      where deal_key in ('m:project-rejected', 'm:project-mrej', 'm:project-chainrej', 'm:project-loop')), 0,
    'the refusals wrote no request');
  perform pg_temp.expect(pg_temp.accept_audits(v_tenant), v_audit, 'and no audit row');
  -- Merged into a live survivor: not closed.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-merged', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, 'a candidate merged into a proposed survivor accepts: the finish step follows the merge');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where operation_id = v_op2
      and deal_key = 'm:project-merged' and state = 'pending' and proposed_step_id = 'p2-s26'
      and cluster_key = 'model:u:' || v_alice::text || ':project-merged'), 1, 'one pending request, on the merged slug');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-mconf', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, 'and one merged into a confirmed survivor');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-chain', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, 'and a two-hop chain that ends in a live survivor');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-open', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, 'a proposed candidate does not block: the accept links to it later');
  perform pg_temp.expect(pg_temp.accept_audits(v_tenant), v_audit + 4, 'four accepts, four audit rows (merged, mconf, chain, open)');
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant
      and cluster_key = 'model:u:' || v_alice::text || ':project-open' and discovery_state = 'proposed'
      and promoted_deal_id is null and merged_into_id is null), 1, 'the candidate is untouched by the request');
  perform pg_temp.expect((select count(*) from deal_candidates where tenant_id = v_tenant
      and cluster_key in ('model:u:' || v_alice::text || ':project-merged', 'model:u:' || v_alice::text || ':project-mconf',
                          'model:u:' || v_alice::text || ':project-chain')
      and discovery_state = 'merged_into'), 3, 'and the merged candidates stay merged: nothing is revived');
  perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), v_corr, 'and has no correction');
  -- Put the fixture back: the extra keys of this section are not for a later section (merged and open stay).
  delete from discovery_model_proposal_accepts
   where deal_key in ('m:project-mconf', 'm:project-mrej', 'm:project-chain', 'm:project-chainrej', 'm:project-loop');
  delete from discovery_model_proposals
   where deal_key in ('m:project-mconf', 'm:project-mrej', 'm:project-chain', 'm:project-chainrej', 'm:project-loop');
  raise notice 'PASS: closed';

  -- ── Limit: at most 500 rows of a key; more is refused whole ──────────────
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, sent_at, outcome,
                                         deal_key, deal_name, phase, p_deal, p_phase,
                                         model, prompt_version, prompt_hash, run_id, created_at, updated_at)
  select v_tenant, v_src_a, encode(sha256(convert_to('<ac-bulk-' || g || '>', 'UTF8')), 'hex'),
         encode(sha256(convert_to('text of <ac-bulk-' || g || '>', 'UTF8')), 'hex'), '2026-03-02T10:00:00Z', 'deal',
         'm:project-bulk', 'Project Bulk', 'phase-2', 0.9, 0.6,
         'anthropic/claude-haiku-5.5', 'v2', 'hash-v2', '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d', v_old, v_old
  from generate_series(1, 501) g;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-bulk', 'p2-s26'),
    '22023:too_many_proposals', '501 rows of one key are refused');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where deal_key = 'm:project-bulk'), 0,
    'and write nothing');
  delete from discovery_model_proposals where content_source_id = v_src_a and deal_key = 'm:project-bulk'
    and message_key = encode(sha256(convert_to('<ac-bulk-501>', 'UTF8')), 'hex');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-bulk', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 1, '500 rows are accepted');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where operation_id = v_op2
      and cardinality(proposal_ids) = 500 and cardinality(message_keys) = 500 and cardinality(item_hashes) = 500
      and email_count = 500 and placed_count = 500), 1, 'one request holding the 500 rows');
  -- Put the fixture back: the bulk key and its request are not for a later section.
  delete from discovery_model_proposal_accepts where deal_key = 'm:project-bulk';
  delete from discovery_model_proposals where deal_key = 'm:project-bulk';
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), v_props + 1,
    'the bulk rows are gone (the fixture, plus the plover row added in the covered section)');
  raise notice 'PASS: limit';

  -- ── Reads: RLS shows the owner their requests and nobody else's ───────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts), 6,
    'Alice reads her six requests (heron, kite, shared, plover, open, merged) and nothing of the colleague''s');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts), 1, 'the colleague reads their one');
  foreach v_who in array array[v_cco, v_admin, v_outsider, v_tess] loop
    perform pg_temp.act_as(v_who);
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts), 0,
      'nobody else reads them (CCO, admin, outsider, team reader)');
  end loop;
  reset role;
  raise notice 'PASS: reads';

  -- ══════════════════════════════════════════════════════════════════════════
  -- Slice 2b: sections 2 to 4, the accept job's side (the definers of 20261023140300), before the tail.
  --   2. claim, lease and token; live keys and the write-ahead; expiry
  --   3. finish: re-key, correction, index link, audit; the states a candidate can be in
  --   4. purge: this source's holder and ledger rows only, and only what the request newly stored; a shared item; the
  --      collector
  -- They run as the table owner under service_role claims (the definers are security definer), except where a role
  -- is named. Every request here is Alice's, on mailbox A, made through the real accept RPC (always with the canonical
  -- station of the phase, p2-s26); the evidence links and the candidate stand in for what discovery_upsert_candidates
  -- writes (it is the worker's, slice 3). A new key per case.
  -- Section 1's six requests on A (heron, kite, shared, plover, open, merged) are parked (running, lease far off) so a
  -- claim on A does not take them, and put back at the end; every request written here is deleted at the end (and the
  -- other tenant's source with its requests), so the tail's counts hold.
  -- ══════════════════════════════════════════════════════════════════════════
  declare
    j_parked uuid[];
    j_req    uuid;
    j_req2   uuid;
    j_req3   uuid;
    j_live   uuid;
    j_src_o  uuid;
    j_cand   uuid;
    j_cand2  uuid;
    j_surv   uuid;
    j_deal   uuid;
    j_n      bigint;
    j_i      integer;
    j_sql    text;
    j_role   text;
    j_detail jsonb;
    j_props  bigint;
    j_corr   bigint;
    j_deals  bigint;
    j_idx    bigint;
    j_ckpt   text;
  begin
    perform pg_temp.act_as_service();
    select coalesce(array_agg(id), '{}'::uuid[]) into j_parked
    from discovery_model_proposal_accepts where content_source_id = v_src_a;
    perform pg_temp.expect(cardinality(j_parked), 6,
      'premise: section 1 left six requests on mailbox A (heron, kite, shared, plover, open, merged)');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = any (j_parked) and state = 'pending'), 6, 'premise: all six are pending');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where content_source_id = v_src_coll and state = 'pending'), 1, 'premise: the colleague''s request is pending');
    update discovery_model_proposal_accepts
       set state = 'running', claim_token = 'parked', lease_until = now() + interval '30 days', attempts = 1
     where id = any (j_parked);

    -- ── 2. Grants and arguments: the worker's definers, nobody else's ─────────
    foreach j_role in array array['authenticated', 'anon'] loop
      execute format('set local role %I', j_role);
      perform pg_temp.act_as(v_alice);
      foreach j_sql in array array[
        format('select * from discovery_claim_model_proposal_accepts(%L, %L, interval ''1 hour'')', v_src_a, 'tok'),
        format('select discovery_renew_model_proposal_accept(%L, %L, interval ''1 hour'')', gen_random_uuid(), 'tok'),
        format('select * from discovery_model_proposal_accept_live_keys(%L, %L)', gen_random_uuid(), 'tok'),
        format('select discovery_mark_model_proposal_accept_storing(%L, %L, array[%L])', gen_random_uuid(), 'tok', repeat('a', 64)),
        format('select discovery_mark_model_proposal_accept_stored(%L, %L)', gen_random_uuid(), 'tok'),
        format('select discovery_finish_model_proposal_accept(%L, %L, null, null)', gen_random_uuid(), 'tok'),
        format('select discovery_expire_model_proposal_accepts(%L, interval ''1 day'')', v_tenant)] loop
        perform pg_temp.expect_attempt(j_sql, '42501', format('%s cannot call a worker definer', j_role));
      end loop;
      reset role;
    end loop;
    set local role service_role;
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(gen_random_uuid(), 'tok', interval '1 hour')), 0,
      'the service role may call them: an unknown request is not renewed');
    reset role;
    perform pg_temp.act_as_service();

    -- A malformed argument raises 22023 before any row is read.
    foreach j_sql in array array[
      'select * from discovery_claim_model_proposal_accepts(null::uuid, ''t'', interval ''1 hour'')',
      format('select * from discovery_claim_model_proposal_accepts(%L, null::text, interval ''1 hour'')', v_src_a),
      format('select * from discovery_claim_model_proposal_accepts(%L, ''  '', interval ''1 hour'')', v_src_a),
      format('select * from discovery_claim_model_proposal_accepts(%L, ''t'', interval ''0 seconds'')', v_src_a),
      format('select * from discovery_claim_model_proposal_accepts(%L, ''t'', interval ''-1 hour'')', v_src_a),
      format('select * from discovery_claim_model_proposal_accepts(%L, ''t'', null::interval)', v_src_a),
      format('select discovery_renew_model_proposal_accept(%L, ''t'', interval ''0 seconds'')', gen_random_uuid()),
      format('select discovery_renew_model_proposal_accept(%L, ''t'', null::interval)', gen_random_uuid()),
      format('select discovery_mark_model_proposal_accept_storing(%L, ''t'', array[]::text[])', gen_random_uuid()),
      format('select discovery_mark_model_proposal_accept_storing(%L, ''t'', null::text[])', gen_random_uuid()),
      format('select discovery_mark_model_proposal_accept_storing(%L, ''t'', array[''not-a-key''])', gen_random_uuid()),
      format('select discovery_mark_model_proposal_accept_storing(%L, ''t'', array[%L, null])', gen_random_uuid(), repeat('a', 64)),
      format('select discovery_finish_model_proposal_accept(%L, ''t'', null, ''bogus'')', gen_random_uuid()),
      -- A null tenant is not malformed: it means every tenant (pinned in the expiry sections below).
      format('select discovery_expire_model_proposal_accepts(%L, interval ''0 seconds'')', v_tenant),
      'select discovery_expire_model_proposal_accepts(null::uuid, interval ''0 seconds'')',
      'select discovery_expire_model_proposal_accepts(null::uuid, null::interval)',
      format('select discovery_expire_model_proposal_accepts(%L, null::interval)', v_tenant)] loop
      perform pg_temp.expect_attempt(j_sql, '22023', 'a malformed argument is refused');
    end loop;
    select count(*) into j_n from discovery_claim_model_proposal_accepts(gen_random_uuid(), 'tok', interval '1 hour');
    perform pg_temp.expect(j_n, 0, 'a source that does not exist has nothing to claim');
    raise notice 'PASS: worker grants';

    -- ── 2. One request through its lifecycle: claim, token, lease, live keys, write-ahead, stored ──
    perform pg_temp.puts(v_tenant, v_src_a, 'ibis', 4, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-ibis');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'pending', 'ibis: the accept left a pending request');
    -- Unclaimed, it answers no job.
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, 'job-x', interval '1 hour')), 0,
      'an unclaimed request is not renewed');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-x')), 0,
      'it has no live keys for a job');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-x', null, 'error')), 0,
      'and no job finishes what it never claimed');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'pending', 'still pending');

    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-ibis-1', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'a claim returns the one pending request of the source');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'running' and claim_token = 'job-ibis-1' and attempts = 1
          and lease_until = now() + interval '75 minutes' and storing_keys is null and finished_at is null), 1,
      'pending becomes running under the job id, with a lease and one attempt');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = any (j_parked) and state = 'running' and claim_token = 'parked' and attempts = 1), 6,
      'a request whose lease still runs is not claimed (the six parked)');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where content_source_id = v_src_coll and state = 'pending' and claim_token is null), 1,
      'and another source''s request is not touched');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-other', interval '75 minutes');
    perform pg_temp.expect(j_n, 0, 'a second job claims nothing while the lease runs');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and claim_token = 'job-ibis-1' and attempts = 1), 1, 'and the claim stays the first job''s');
    raise notice 'PASS: claim';

    -- A wrong token (another job's, or none) is a no-op on every definer.
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, 'job-other', interval '3 hours')), 0,
      'renew with another job''s token is refused');
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, null, interval '3 hours')), 0,
      'and with no token');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-other')), 0,
      'live keys: nothing for another job');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, null)), 0,
      'nor with no token');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_storing(j_req, 'job-other',
        array[pg_temp.k('ibis', 1)]) is null), 1, 'storing with another job''s token is refused (null, not an empty answer)');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_storing(j_req, null,
        array[pg_temp.k('ibis', 1)]) is null), 1, 'and with no token');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-other')), 0,
      'stored with another job''s token is refused');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-other', null, 'error')), 0,
      'finish with another job''s token is refused');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, null, null, 'error')), 0,
      'and with no token');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'running' and claim_token = 'job-ibis-1' and attempts = 1
          and lease_until = now() + interval '75 minutes' and storing_keys is null and finished_at is null), 1,
      'the request is exactly as the first job left it');
    perform pg_temp.expect(pg_temp.finish_audits(j_req), 0, 'and nothing is audited');
    raise notice 'PASS: token';

    -- Renew pushes the lease out, for this token only.
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, 'job-ibis-1', interval '2 hours')), 1,
      'the claiming job renews its lease');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and lease_until = now() + interval '2 hours' and attempts = 1), 1,
      'the lease runs two hours from now, and a renew is not an attempt');

    -- Live keys: the snapshot's messages whose proposal row still has the accepted key and hash.
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-ibis-1')), 4,
      'all four messages are live');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-ibis-1')), 0,
      'a running request is not stored: the write-ahead comes first');
    update discovery_model_proposals set item_hash = pg_temp.mk('changed text')
     where content_source_id = v_src_a and message_key = pg_temp.k('ibis', 4);
    update discovery_model_proposals set deal_key = 'm:project-ibis-moved'
     where content_source_id = v_src_a and message_key = pg_temp.k('ibis', 3);
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-ibis-1')), 2,
      'a row whose hash changed and a row that moved to another key drop out');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-ibis-1') l
        where (l.message_key = pg_temp.k('ibis', 1) and l.item_hash = pg_temp.mk('text of ' || pg_temp.m('ibis', 1))
               and l.sent_at = '2026-03-02T10:00:00Z')
           or (l.message_key = pg_temp.k('ibis', 2) and l.item_hash = pg_temp.mk('text of ' || pg_temp.m('ibis', 2))
               and l.sent_at = '2026-03-02T10:00:00Z')), 2,
      'the two left are the unchanged ones, with their hash and send time');
    raise notice 'PASS: live keys';

    -- The write-ahead: the keys are recorded before any text, and only live keys may be.
    perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_mark_model_proposal_accept_storing(%L, %L, array[%L, %L])',
        j_req, 'job-ibis-1', pg_temp.k('ibis', 1), pg_temp.k('ibis', 4))),
      '22023:keys_not_live', 'a key whose row changed is refused, and the live one with it');
    perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_mark_model_proposal_accept_storing(%L, %L, array[%L])',
        j_req, 'job-ibis-1', repeat('c', 64))),
      '22023:keys_not_live', 'and a key that was never in the snapshot');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'running' and storing_keys is null), 1, 'the refusals left the request running, with no keys');
    perform pg_temp.expect_text(pg_temp.skeys(discovery_mark_model_proposal_accept_storing(j_req, 'job-ibis-1',
        array[pg_temp.k('ibis', 2), pg_temp.k('ibis', 1), pg_temp.k('ibis', 1)])),
      pg_temp.skeys(array[pg_temp.k('ibis', 1), pg_temp.k('ibis', 2)]),
      'two live keys (one repeated) are accepted, and the call answers the two distinct keys it recorded');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'storing', 'running becomes storing');
    perform pg_temp.expect_text((select storing_keys::text from discovery_model_proposal_accepts where id = j_req),
      (select array(select x from unnest(array[pg_temp.k('ibis', 1), pg_temp.k('ibis', 2)]) x order by x)::text),
      'the write-ahead holds the two distinct keys, sorted');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('ibis', 1)) + pg_temp.items(pg_temp.m('ibis', 1)), 0,
      'recorded before any text is written');
    -- The job persists them.
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('ibis', 1), 'ib-1', 'conv-ibis');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('ibis', 2), 'ib-2', 'conv-ibis');
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('ibis', 1), array['ib-1']);
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('ibis', 2), array['ib-2']);
    -- A request that is storing is held to its write-ahead keys, even if another row is live again.
    update discovery_model_proposals set deal_key = 'm:project-ibis'
     where content_source_id = v_src_a and message_key = pg_temp.k('ibis', 3);
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-ibis-1')), 2,
      'storing: only the recorded keys, though a third row is live again');
    -- The retry is held to the keys already recorded (its answer is the intersection with them), even though the
    -- source now holds the stored text: a reclaimed request must not forget what the crashed attempt persisted.
    perform pg_temp.expect_text(pg_temp.skeys(discovery_mark_model_proposal_accept_storing(j_req, 'job-ibis-1',
        array[pg_temp.k('ibis', 1)])), pg_temp.skeys(array[pg_temp.k('ibis', 1)]),
      'a retry within the recorded keys answers those keys');
    perform pg_temp.expect_text(pg_temp.skeys(discovery_mark_model_proposal_accept_storing(j_req, 'job-ibis-1',
        array[pg_temp.k('ibis', 1), pg_temp.k('ibis', 2)])), pg_temp.skeys(array[pg_temp.k('ibis', 1), pg_temp.k('ibis', 2)]),
      'and so does a retry of both, though the source holds them now');
    perform pg_temp.expect_text((select storing_keys::text from discovery_model_proposal_accepts where id = j_req),
      (select array(select x from unnest(array[pg_temp.k('ibis', 1), pg_temp.k('ibis', 2)]) x order by x)::text),
      'and the record keeps both keys: the purge must cover everything ever persisted');
    perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_mark_model_proposal_accept_storing(%L, %L, array[%L])',
        j_req, 'job-ibis-1', pg_temp.k('ibis', 3))),
      '22023:keys_not_live', 'a retry beyond the recorded keys is refused');
    raise notice 'PASS: write-ahead';

    -- Stored: the persist returned.
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-other')), 0,
      'stored with another job''s token is still refused');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-ibis-1')), 1, 'storing becomes stored');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'stored', 'the request reads stored');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-ibis-1')), 1,
      'a repeat by the same job is true');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_storing(j_req, 'job-ibis-1',
        array[pg_temp.k('ibis', 1)]) is null), 1, 'a stored request takes no more keys (null)');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-ibis-1')), 0,
      'and has no live keys: a resumed request does not read again');
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, 'job-ibis-1', interval '75 minutes')), 1,
      'it is still renewed');

    -- Lease: an expired lease is reclaimed by the next job; the old job is shut out.
    update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute' where id = j_req;
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-ibis-2', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'a request whose lease ran out is claimed again');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'stored' and claim_token = 'job-ibis-2' and attempts = 2
          and lease_until = now() + interval '75 minutes'), 1,
      'it keeps its state (stored), with the new job''s token and a second attempt');
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, 'job-ibis-1', interval '75 minutes')), 0,
      'the first job can no longer renew');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-ibis-1')), 0,
      'nor mark');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-ibis-1', null, 'error')), 0,
      'nor finish');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'stored', 'the request is untouched by it');
    perform pg_temp.expect(pg_temp.finish_audits(j_req), 0, 'and nothing is audited');
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, 'job-ibis-2', interval '75 minutes')), 1,
      'the second job renews');
    update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute' where id = j_req;
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-ibis-3', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'a third claim is still returned');
    perform pg_temp.expect((select attempts from discovery_model_proposal_accepts where id = j_req), 3, 'at the third attempt');
    raise notice 'PASS: lease';

    -- The fourth claim fails the request instead of returning it, and purges the text it stored.
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('ibis', 1)) + pg_temp.holders(v_src_a, pg_temp.m('ibis', 2)), 2,
      'premise: the stored text has this source''s holder rows');
    update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute' where id = j_req;
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-ibis-4', interval '75 minutes');
    perform pg_temp.expect(j_n, 0, 'the fourth claim returns nothing');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'error' and claim_token = 'job-ibis-4' and attempts = 4
          and found_count = 0 and changed_count = 0 and purged_count = 2 and finished_at = now() and lease_until is null
          and candidate_id is null), 1, 'it is failed ''error'' in place, having purged two holders');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('ibis', 1)) + pg_temp.holders(v_src_a, pg_temp.m('ibis', 2)), 0,
      'this source''s holder rows of the stored messages are gone');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('ibis', 1)) + pg_temp.items(pg_temp.m('ibis', 2)), 2,
      'the items stay: deleting them is the collector''s, and only when no source holds them');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'ib-1'), 'unrouted/-/conv-ibis/' || pg_temp.m('ibis', 1),
      'the ledger goes back to unrouted, with the conversation and Message-ID restored from the item');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'ib-2'), 'unrouted/-/conv-ibis/' || pg_temp.m('ibis', 2), 'both of them');
    perform pg_temp.expect((select count(*) from routing_ledger where source_id = v_src_a
        and provider_item_id in ('ib-1', 'ib-2') and confidence is null), 2, 'with no confidence left');
    perform pg_temp.expect(pg_temp.index_rows(v_src_a, pg_temp.m('ibis', 1)) + pg_temp.index_rows(v_src_a, pg_temp.m('ibis', 2)), 2,
      'the message index keeps its rows');
    perform pg_temp.expect(pg_temp.live_requests(v_src_a, 'm:project-ibis'), 0, 'a failed request frees the one-live-request index');
    perform pg_temp.expect(pg_temp.finish_audits(j_req), 1, 'one finish audit row');
    j_detail := pg_temp.finished(j_req);
    perform pg_temp.expect_text(pg_temp.keys_of(j_detail), 'changed,found,operationId,outcome,purged,requestId,requested,requestedBy',
      'ids, an outcome word and counts only');
    perform pg_temp.expect_text(j_detail ->> 'outcome', 'error', 'the outcome');
    perform pg_temp.expect((j_detail ->> 'purged')::bigint, 2, 'two purged');
    perform pg_temp.expect((j_detail ->> 'found')::bigint, 0, 'none found');
    perform pg_temp.expect((j_detail ->> 'requested')::bigint, 4, 'of four requested');
    perform pg_temp.expect_text(j_detail ->> 'requestedBy', v_alice::text, 'by Alice');
    perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.model_proposal_accept_finished'
        and detail ->> 'requestId' = j_req::text and tenant_id = v_tenant and actor_type = 'service'
        and service_identity = 'discovery-worker' and actor_id is null and chain_seq is not null), 1,
      'as the discovery worker, on the chain');
    perform pg_temp.expect(pg_temp.flag(j_detail::text ~* '(project|ibis|bank|example)'), 0, 'no key, slug, name or address');
    perform pg_temp.expect((select count(*) from discovery_model_proposals where content_source_id = v_src_a
        and deal_key like 'm:project-ibis%' and candidate_id is null), 4, 'the proposal rows are kept under their keys');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-ibis-5', interval '75 minutes');
    perform pg_temp.expect(j_n, 0, 'a failed request is never claimed again');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-ibis-3', null, 'error')), 0,
      'and the job that lost it cannot finish it');
    perform pg_temp.expect(pg_temp.finish_audits(j_req), 1, 'still one audit row');
    raise notice 'PASS: fourth claim';

    -- A request that never stored anything fails the same way, with nothing to purge.
    perform pg_temp.puts(v_tenant, v_src_a, 'crane', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-crane');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-crane-1', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'crane: claimed');
    for j_i in 2..3 loop
      update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute' where id = j_req;
      select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-crane-' || j_i, interval '75 minutes');
      perform pg_temp.expect(j_n, 1, 'crane: reclaimed');
    end loop;
    perform pg_temp.expect_text(pg_temp.st(j_req), 'running', 'crane: still running at its third attempt');
    update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute' where id = j_req;
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-crane-4', interval '75 minutes');
    perform pg_temp.expect(j_n, 0, 'crane: the fourth claim returns nothing');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'error' and attempts = 4 and purged_count = 0
          and found_count = 0 and storing_keys is null), 1, 'crane: failed ''error'' with nothing to purge');
    perform pg_temp.expect_text(pg_temp.finished(j_req) ->> 'outcome', 'error', 'crane: audited');
    perform pg_temp.expect((pg_temp.finished(j_req) ->> 'purged')::bigint, 0, 'crane: nothing purged');

    -- ── 2. Expiry: the tick's backstop, first for a request no job claimed ──────
    -- exprun: claimed with a lease still running (so not the backstop's, however old). expold: pending and old.
    -- expyoung: pending and young.
    perform pg_temp.puts(v_tenant, v_src_a, 'exprun', 1, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-exprun');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-exprun', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'exprun: claimed');
    update discovery_model_proposal_accepts set requested_at = now() - interval '48 hours' where id = j_req;
    perform pg_temp.puts(v_tenant, v_src_a, 'expold', 1, v_old);
    perform pg_temp.puts(v_tenant, v_src_a, 'expyoung', 1, v_old);
    j_req2 := pg_temp.alice_accepts(v_alice, 'm:project-expold');
    j_req3 := pg_temp.alice_accepts(v_alice, 'm:project-expyoung');
    update discovery_model_proposal_accepts set requested_at = now() - interval '25 hours' where id = j_req2;
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    perform pg_temp.expect(j_n, 1, 'expiry fails the one pending request older than the age');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req2 and state = 'failed' and failure_code = 'source_unavailable' and finished_at = now()
          and attempts = 0 and claim_token is null and found_count = 0 and purged_count = 0 and candidate_id is null), 1,
      'expold: failed source_unavailable, never claimed');
    perform pg_temp.expect(pg_temp.finish_audits(j_req2), 1, 'and audited once');
    j_detail := pg_temp.finished(j_req2);
    perform pg_temp.expect_text(pg_temp.keys_of(j_detail), 'changed,found,operationId,outcome,purged,requestId,requested,requestedBy',
      'with ids, an outcome word and counts only');
    perform pg_temp.expect_text(j_detail ->> 'outcome', 'source_unavailable', 'the outcome');
    perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.model_proposal_accept_finished'
        and detail ->> 'requestId' = j_req2::text and actor_type = 'service' and service_identity = 'discovery-worker'), 1,
      'as the discovery worker');
    perform pg_temp.expect_text(pg_temp.st(j_req3), 'pending', 'expyoung: a young request on an active source stays pending');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'running', 'exprun: a claimed request is its job''s, however old');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where content_source_id = v_src_coll and state = 'pending'), 1, 'and so is another source''s young one');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = any (j_parked) and state = 'running' and claim_token = 'parked'), 6, 'the parked six are untouched');
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    perform pg_temp.expect(j_n, 0, 'a second run fails nothing');
    perform pg_temp.expect(pg_temp.finish_audits(j_req2), 1, 'and audits nothing');
    -- A source that is no longer active fails its pending requests whatever their age.
    update content_sources set status = 'paused' where id = v_src_a;
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    update content_sources set status = 'active' where id = v_src_a;
    perform pg_temp.expect(j_n, 1, 'a paused source fails its young pending request');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req3 and state = 'failed' and failure_code = 'source_unavailable' and finished_at = now()), 1,
      'expyoung: failed source_unavailable');
    perform pg_temp.expect(pg_temp.finish_audits(j_req3), 1, 'and audited');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'running', 'exprun: still its job''s');
    perform pg_temp.expect_text((select state from discovery_model_proposal_accepts where content_source_id = v_src_coll), 'pending',
      'the colleague''s source was active, so its request stays');
    -- exprun's job gives up on it.
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-exprun', null, 'source_unavailable')), 1,
      'exprun: its job finishes it');
    raise notice 'PASS: expiry';

    -- ── 2. Expiry of an in-flight request: the job crashed, and no job will serve its source again ──
    -- A claim happens only inside the SYNC job of an active source, so a request left running, storing or stored with a
    -- lapsed lease on a paused or archived source (or one past the age) would never finish. The expiry takes it under
    -- a token of its own and ends it through the finish as source_unavailable: the purge runs and the audit row is written.
    --   jrun   running, nothing recorded         jsto   storing: three keys recorded, two persisted
    --   jstd   stored: both persisted            jlive  storing, the lease still running
    j_req  := pg_temp.drive(v_tenant, v_src_a, v_alice, 'jrun', 2, 'running', 0);
    j_req2 := pg_temp.drive(v_tenant, v_src_a, v_alice, 'jsto', 3, 'storing', 2);
    j_req3 := pg_temp.drive(v_tenant, v_src_a, v_alice, 'jstd', 2, 'stored', 2);
    j_live := pg_temp.drive(v_tenant, v_src_a, v_alice, 'jlive', 2, 'storing', 1);
    update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute'
     where id in (j_req, j_req2, j_req3);
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where id = j_req2 and cardinality(storing_keys) = 3),
      1, 'premise: jsto recorded three keys');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('jsto', 1)) + pg_temp.holders(v_src_a, pg_temp.m('jsto', 2))
      + pg_temp.holders(v_src_a, pg_temp.m('jstd', 1)) + pg_temp.holders(v_src_a, pg_temp.m('jstd', 2)), 4,
      'premise: the persisted messages have this source''s holder rows');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('jsto', 3)) + pg_temp.items(pg_temp.m('jsto', 3)), 0,
      'premise: jsto-3 was recorded but never reached the store');

    -- The source is active and the requests are young: a lapsed lease is the next claim's to take, not the backstop's.
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    perform pg_temp.expect(j_n, 0, 'a lapsed lease on an active source, young: nothing to expire (0)');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where (id = j_req and state = 'running' and claim_token = 'job-jrun')
           or (id = j_req2 and state = 'storing' and claim_token = 'job-jsto')
           or (id = j_req3 and state = 'stored' and claim_token = 'job-jstd')), 3, 'jrun, jsto and jstd are exactly as their job left them');
    perform pg_temp.expect(pg_temp.finish_audits(j_req) + pg_temp.finish_audits(j_req2) + pg_temp.finish_audits(j_req3), 0,
      'and nothing is audited');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('jsto', 1)) + pg_temp.holders(v_src_a, pg_temp.m('jstd', 1)), 2,
      'and nothing is purged');

    -- Past the age, a lapsed request is finished whatever its source (jstd, on the active source).
    update discovery_model_proposal_accepts set requested_at = now() - interval '48 hours' where id = j_req3;
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    perform pg_temp.expect(j_n, 1, 'a lapsed request past the age is finished on an active source: one');
    perform pg_temp.expect_expired(j_req3, 2, 'jstd');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('jstd', 1)) + pg_temp.holders(v_src_a, pg_temp.m('jstd', 2)), 0,
      'jstd: this source''s holder rows of the stored text are gone');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('jstd', 1)) + pg_temp.items(pg_temp.m('jstd', 2))
      + pg_temp.texts(pg_temp.m('jstd', 1)) + pg_temp.texts(pg_temp.m('jstd', 2)), 4,
      'jstd: the items and their text stay for the collector');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'jstd-1'), 'unrouted/-/conv-jstd/' || pg_temp.m('jstd', 1),
      'jstd: the ledger is unrouted with the conversation and Message-ID restored');
    perform pg_temp.expect(pg_temp.live_requests(v_src_a, 'm:project-jstd'), 0, 'jstd: the one-live-request index is free');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-jstd' and candidate_id is null), 2,
      'jstd: its proposal rows stay under m:');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req3, 'job-jstd', null, 'error')), 0,
      'jstd: the job that lost it cannot finish it');
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req3, 'job-jstd', interval '75 minutes')), 0,
      'nor renew it');
    perform pg_temp.expect(pg_temp.finish_audits(j_req3), 1, 'and there is still one audit row');
    perform pg_temp.expect_text(pg_temp.st(j_req) || '/' || pg_temp.st(j_req2), 'running/storing',
      'the young ones on the active source are still their job''s');

    -- A paused source: jrun and jsto are finished; jlive, whose lease still runs, is not.
    update content_sources set status = 'paused' where id = v_src_a;
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    update content_sources set status = 'active' where id = v_src_a;
    perform pg_temp.expect(j_n, 2, 'a paused source: its two lapsed in-flight requests are finished');
    perform pg_temp.expect_expired(j_req, 0, 'jrun');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where id = j_req and storing_keys is null), 1,
      'jrun: it never recorded a key, so nothing was purged');
    perform pg_temp.expect_expired(j_req2, 2, 'jsto');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where id = j_req2 and cardinality(storing_keys) = 3), 1,
      'jsto: the three recorded keys are kept as the record');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('jsto', 1)) + pg_temp.holders(v_src_a, pg_temp.m('jsto', 2)), 0,
      'jsto: the holder rows of the two persisted messages are gone');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('jsto', 1)) + pg_temp.items(pg_temp.m('jsto', 2)), 2, 'jsto: their items stay');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'jsto-1'), 'unrouted/-/conv-jsto/' || pg_temp.m('jsto', 1),
      'jsto: the ledger goes back to unrouted');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'jsto-2'), 'unrouted/-/conv-jsto/' || pg_temp.m('jsto', 2), 'both of them');
    perform pg_temp.expect(pg_temp.live_requests(v_src_a, 'm:project-jrun') + pg_temp.live_requests(v_src_a, 'm:project-jsto'), 0,
      'both free the one-live-request index');
    perform pg_temp.expect_text(pg_temp.st(j_live), 'storing', 'jlive: an active-source request with a live lease is untouched');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_live and claim_token = 'job-jlive' and lease_until > now()), 1, 'with its job''s token and lease');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('jlive', 1)) + pg_temp.finish_audits(j_live), 1,
      'its holder row stays, and nothing is audited');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = any (j_parked) and state = 'running' and claim_token = 'parked'), 6, 'the parked six are untouched');

    -- An archived source, still marked active (the archive arm alone).
    j_req := pg_temp.drive(v_tenant, v_src_a, v_alice, 'jarc', 2, 'storing', 1);
    update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute' where id = j_req;
    perform pg_temp.expect((select count(*) from content_sources where id = v_src_a and status = 'active' and archived_at is null), 1,
      'premise: mailbox A is active and not archived');
    update content_sources set archived_at = now() where id = v_src_a;
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    update content_sources set archived_at = null where id = v_src_a;
    perform pg_temp.expect(j_n, 1, 'an archived source: its lapsed request is finished (jlive''s lease still runs)');
    perform pg_temp.expect_expired(j_req, 1, 'jarc');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('jarc', 1)), 0, 'jarc: the persisted message''s holder row is gone');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'jarc-1'), 'unrouted/-/conv-jarc/' || pg_temp.m('jarc', 1),
      'jarc: the ledger goes back to unrouted');
    perform pg_temp.expect_text(pg_temp.st(j_live), 'storing', 'jlive: still untouched');
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    perform pg_temp.expect(j_n, 0, 'nothing left to expire: 0');
    -- jlive's job gives up on it, and its purge is its own.
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_live, 'job-jlive', null, 'error')), 1,
      'jlive: its job finishes it');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_live and state = 'failed' and failure_code = 'error' and purged_count = 1), 1, 'purging its one persisted message');
    raise notice 'PASS: expiry in flight';

    -- ── 2. Expiry across tenants: a null tenant means every tenant ─────────────
    -- The other tenant's source is put in as the table owner, with requests put in directly (xother1 pending, xother2
    -- claimed by a job that is gone), both old. A tenant argument reaches that tenant alone.
    insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
      values (v_other, 'mailbox', 'ac-outsider@other.example', v_outsider, 'microsoft') returning id into j_src_o;
    perform pg_temp.puts(v_tenant, v_src_a, 'xten1', 1, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-xten1');
    update discovery_model_proposal_accepts set requested_at = now() - interval '48 hours' where id = j_req;
    j_req2 := pg_temp.raw_request(v_other, j_src_o, v_outsider, 'project-xother1', 'pending', interval '48 hours');
    j_req3 := pg_temp.raw_request(v_other, j_src_o, v_outsider, 'project-xother2', 'running', interval '48 hours');
    j_n := discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours');
    perform pg_temp.expect(j_n, 1, 'a tenant argument expires that tenant''s request alone');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'failed', 'xten1: failed');
    perform pg_temp.expect_text(pg_temp.st(j_req2) || '/' || pg_temp.st(j_req3), 'pending/running',
      'the other tenant''s two requests are untouched');
    perform pg_temp.expect(pg_temp.finish_audits(j_req2) + pg_temp.finish_audits(j_req3), 0, 'and not audited');
    perform pg_temp.expect(discovery_expire_model_proposal_accepts(gen_random_uuid(), interval '24 hours'), 0,
      'a tenant with no requests has nothing to expire: 0');
    perform pg_temp.puts(v_tenant, v_src_a, 'xten2', 1, v_old);
    j_live := pg_temp.alice_accepts(v_alice, 'm:project-xten2');
    update discovery_model_proposal_accepts set requested_at = now() - interval '48 hours' where id = j_live;
    j_n := discovery_expire_model_proposal_accepts(null::uuid, interval '24 hours');
    perform pg_temp.expect(pg_temp.flag(j_n >= 3), 1, 'a null tenant covers every tenant: this one''s request and the other''s two');
    perform pg_temp.expect_text(pg_temp.st(j_live), 'failed', 'xten2 (this tenant): failed');
    perform pg_temp.expect(pg_temp.finish_audits(j_live), 1, 'and audited once');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req2 and tenant_id = v_other and state = 'failed' and failure_code = 'source_unavailable'
          and claim_token is null and finished_at = now()), 1, 'xother1 (the other tenant, pending): failed source_unavailable, never claimed');
    perform pg_temp.expect(pg_temp.finish_audits(j_req2), 1, 'and audited once');
    perform pg_temp.expect_expired(j_req3, 0, 'xother2 (the other tenant, claimed)');
    perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.model_proposal_accept_finished'
        and tenant_id = v_other and detail ->> 'requestId' in (j_req2::text, j_req3::text)), 2,
      'the audit rows are on the other tenant''s chain');
    perform pg_temp.expect(discovery_expire_model_proposal_accepts(null::uuid, interval '24 hours'), 0,
      'a second null-tenant run has nothing to do: 0');
    perform pg_temp.expect(discovery_expire_model_proposal_accepts(v_tenant, interval '24 hours'), 0, 'nor a tenant''s own');
    -- Put the other tenant back: its source takes its requests with it.
    delete from content_sources where id = j_src_o;
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_other), 0,
      'the other tenant''s requests are gone with its source');
    raise notice 'PASS: expiry tenants';

    -- ── 3. Finish, success: the linked messages are re-keyed, the rest purged ──
    -- swan: four messages and five rows (swan-1 read under two prompt versions). Before the job runs, swan-4's row moves to
    -- another key. The job stores swan-1 to swan-3; the upsert links swan-1 and swan-2 only.
    perform pg_temp.puts(v_tenant, v_src_a, 'swan', 4, v_old);
    perform pg_temp.put(v_tenant, v_src_a, pg_temp.m('swan', 1), 'm:project-swan', 'Project Swan', v_old, 'phase-2', 'v3');
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-swan');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and cardinality(proposal_ids) = 5 and email_count = 4 and state = 'pending'), 1,
      'swan: five rows, four messages');
    update discovery_model_proposals set deal_key = 'm:project-swan-moved'
     where content_source_id = v_src_a and message_key = pg_temp.k('swan', 4);
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-swan', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'swan: claimed');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-swan')), 3,
      'swan: three live messages (swan-1 once, though read twice)');
    perform pg_temp.mark_all(j_req, 'job-swan',
        array[pg_temp.k('swan', 1), pg_temp.k('swan', 2), pg_temp.k('swan', 3)], 'swan: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('swan', 1), 'sw-1', 'conv-swan');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('swan', 2), 'sw-2', 'conv-swan');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('swan', 3), 'sw-3', 'conv-swan');
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('swan', 1), array['sw-1']);
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('swan', 2), array['sw-2']);
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('swan', 3), array['sw-3']);
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-swan')), 1, 'swan: stored');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'swan');
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('swan', 1));
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('swan', 2));
    perform discovery_refresh_candidate_visibility(j_cand);
    j_props := (select count(*) from discovery_model_proposals where tenant_id = v_tenant);
    j_corr := (select count(*) from corrections where tenant_id = v_tenant);
    j_deals := (select count(*) from deals where tenant_id = v_tenant);
    j_idx := (select count(*) from discovery_message_index where tenant_id = v_tenant and content_source_id = v_src_a);
    select delta_checkpoint into j_ckpt from content_sources where id = v_src_a;

    -- What finish refuses: a candidate that is not the request's, a code it does not know, a job that does not hold it.
    perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_finish_model_proposal_accept(%L, %L, %L, null)',
        j_req, 'job-swan', gen_random_uuid())), '22023:invalid_candidate', 'a candidate that does not exist is refused');
    perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_finish_model_proposal_accept(%L, %L, %L, null)',
        j_req, 'job-swan', pg_temp.cand(v_tenant, v_alice, 'swan-other'))), '22023:invalid_candidate',
      'and one of another cluster key');
    perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_finish_model_proposal_accept(%L, %L, %L, ''bogus'')',
        j_req, 'job-swan', j_cand)), '22023:invalid_failure', 'and a failure code it does not know');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-other', j_cand, null)), 0,
      'another job''s finish is a no-op');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'stored', 'the refusals left it stored');
    perform pg_temp.expect(pg_temp.finish_audits(j_req), 0, 'and wrote no audit row');

    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-swan', j_cand, null)), 1,
      'swan: the job finishes it');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'done' and failure_code is null and found_count = 2 and changed_count = 2
          and purged_count = 1 and candidate_id = j_cand and finished_at = now() and lease_until is null), 1,
      'done: two messages found, two of the five rows changed, one holder purged, the candidate recorded');
    -- Re-key: both the key and the candidate id, on the linked, still-matching rows only.
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'c:' || j_cand::text and candidate_id = j_cand
          and message_key in (pg_temp.k('swan', 1), pg_temp.k('swan', 2)) and archived_at is null), 3,
      'swan-1 (both rows) and swan-2 are under the candidate, with its id');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-swan' and candidate_id is null
          and message_key = pg_temp.k('swan', 3)), 1, 'swan-3, stored but not linked, stays under m:');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-swan-moved' and candidate_id is null), 1,
      'and swan-4, which moved, is not touched');
    perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), j_props,
      'no proposal row is added or removed');
    -- The person's accept, in the log.
    perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), j_corr + 1, 'one correction');
    perform pg_temp.expect((select count(*) from corrections
        where candidate_id = j_cand and action = 'accept_proposal' and actor_id = v_alice and tenant_id = v_tenant
          and (after ->> 'requestId') = j_req::text and (after ->> 'found') = '2' and (after ->> 'requested') = '4'), 1,
      'accept_proposal, by the requester, with the request id and the counts');
    -- Nothing about a station, a pin, a deal or the cursor.
    perform pg_temp.expect((select count(*) from deal_candidates
        where id = j_cand and discovery_state = 'proposed' and pinned = false and station_override_step_id is null
          and station_override_correction_id is null and promoted_deal_id is null and merged_into_id is null), 1,
      'the candidate has no station, no pin, no deal');
    perform pg_temp.expect((select count(*) from deals where tenant_id = v_tenant), j_deals, 'no deal is made');
    perform pg_temp.expect_text((select delta_checkpoint from content_sources where id = v_src_a), j_ckpt,
      'and the source''s cursor is where it was');
    -- The purge: the unlinked message, this source's rows only.
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('swan', 3)), 0, 'swan-3''s holder row is gone');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('swan', 3)), 1, 'its item stays for the collector');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'sw-3'), 'unrouted/-/conv-swan/' || pg_temp.m('swan', 3),
      'and its ledger row is unrouted, the clear ids restored');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'sw-1'), 'routed/model_proposal/-/-', 'swan-1 stays routed');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'sw-2'), 'routed/model_proposal/-/-', 'and swan-2');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('swan', 1)) + pg_temp.holders(v_src_a, pg_temp.m('swan', 2)), 2,
      'with their holder rows');
    -- The message index: the same rows, the linked messages pointing at the candidate.
    perform pg_temp.expect((select count(*) from discovery_message_index
        where tenant_id = v_tenant and content_source_id = v_src_a), j_idx, 'the index has the same rows');
    perform pg_temp.expect((select count(*) from discovery_message_index
        where content_source_id = v_src_a and candidate_id = j_cand
          and message_key in (pg_temp.k('swan', 1), pg_temp.k('swan', 2))), 2, 'the two linked messages name the candidate');
    perform pg_temp.expect((select count(*) from discovery_message_index
        where content_source_id = v_src_a and message_key = pg_temp.k('swan', 3) and candidate_id is null), 1,
      'and the purged one does not');
    -- The audit row.
    perform pg_temp.expect(pg_temp.finish_audits(j_req), 1, 'one finish audit row');
    j_detail := pg_temp.finished(j_req);
    perform pg_temp.expect_text(pg_temp.keys_of(j_detail),
      'candidateId,changed,found,operationId,outcome,purged,requestId,requested,requestedBy', 'ids, an outcome word and counts only');
    perform pg_temp.expect_text(j_detail ->> 'outcome', 'done', 'outcome done');
    perform pg_temp.expect_text(j_detail ->> 'candidateId', j_cand::text, 'naming the candidate');
    perform pg_temp.expect((j_detail ->> 'found')::bigint, 2, 'found 2');
    perform pg_temp.expect((j_detail ->> 'requested')::bigint, 4, 'requested 4');
    perform pg_temp.expect((j_detail ->> 'changed')::bigint, 2, 'changed 2');
    perform pg_temp.expect((j_detail ->> 'purged')::bigint, 1, 'purged 1');
    perform pg_temp.expect_text(j_detail ->> 'requestedBy', v_alice::text, 'requested by Alice');
    perform pg_temp.expect_text(j_detail ->> 'operationId', (select operation_id::text from discovery_model_proposal_accepts
      where id = j_req), 'and the operation');
    perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.model_proposal_accept_finished'
        and detail ->> 'requestId' = j_req::text and tenant_id = v_tenant and actor_type = 'service'
        and service_identity = 'discovery-worker' and actor_id is null and chain_seq is not null), 1,
      'as the discovery worker, on the chain');
    perform pg_temp.expect(pg_temp.flag(j_detail::text ~* '(project|swan|bank|example)'), 0, 'no key, slug, name or address');
    -- A repeat by the same job is true and writes nothing; another job's is false.
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-swan', j_cand, null)), 1,
      'a repeat by the same job answers true');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-other', j_cand, null)), 0,
      'another job''s finish of a done request is false');
    perform pg_temp.expect(pg_temp.finish_audits(j_req), 1, 'no second audit row');
    perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), j_corr + 1, 'no second correction');
    perform pg_temp.expect(pg_temp.flag(discovery_renew_model_proposal_accept(j_req, 'job-swan', interval '1 hour')), 0,
      'and a done request is not renewed');
    -- The owner reads what was linked, under her own session.
    set local role authenticated;
    perform pg_temp.act_as(v_alice);
    perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || j_cand::text), 3,
      'Alice reads the three re-keyed rows');
    perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-swan'), 1,
      'and the one still under m:');
    perform pg_temp.expect((select count(*) from deal_candidates where id = j_cand), 1, 'she sees the candidate');
    perform pg_temp.expect((select count(*) from corrections where candidate_id = j_cand and action = 'accept_proposal'), 1,
      'and the correction');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where id = j_req and state = 'done'), 1,
      'and her request reads done');
    perform pg_temp.act_as(v_colleague);
    perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || j_cand::text), 0,
      'a colleague reads none of them');
    perform pg_temp.expect((select count(*) from deal_candidates where id = j_cand), 0, 'nor the candidate');
    reset role;
    -- Rejecting the candidate archives the re-keyed rows and keeps them whole.
    update deal_candidates set discovery_state = 'rejected' where id = j_cand;
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where deal_key = 'c:' || j_cand::text and candidate_id = j_cand and archived_at is not null), 3,
      'a reject archives the three rows, keeping their key and candidate id');
    perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), j_props,
      'none is deleted');
    set local role authenticated;
    perform pg_temp.act_as(v_alice);
    perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || j_cand::text), 0,
      'and the owner no longer reads them');
    perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-swan'), 1,
      'while the row left under m: is still listed');
    reset role;
    perform pg_temp.act_as_service();
    raise notice 'PASS: finish';

    -- ── 3. Finish, the candidate's other states ───────────────────────────────
    -- lark: the cluster's candidate was merged into a live survivor; the links, the re-key and the correction go there.
    perform pg_temp.puts(v_tenant, v_src_a, 'lark', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-lark');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-lark', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'lark: claimed');
    perform pg_temp.mark_all(j_req, 'job-lark',
        array[pg_temp.k('lark', 1), pg_temp.k('lark', 2)], 'lark: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('lark', 1), 'lk-1');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('lark', 2), 'lk-2');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-lark')), 1, 'lark: stored');
    j_surv := pg_temp.cand(v_tenant, v_alice, 'lark-survivor');
    insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name)
      values (v_tenant, 'model:u:' || v_alice::text || ':project-lark', 'merged_into', j_surv, 'Project Lark')
      returning id into j_cand;
    perform pg_temp.link_item(v_tenant, j_surv, pg_temp.m('lark', 1));
    perform pg_temp.link_item(v_tenant, j_surv, pg_temp.m('lark', 2));
    perform discovery_refresh_candidate_visibility(j_surv);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-lark', j_cand, null)), 1,
      'lark: finished with the merged candidate');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'done' and found_count = 2 and changed_count = 0 and purged_count = 0
          and candidate_id = j_surv), 1, 'done on the survivor: two found, nothing changed or purged');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'c:' || j_surv::text and candidate_id = j_surv), 2,
      'the rows are re-keyed to the survivor');
    perform pg_temp.expect((select count(*) from corrections where candidate_id = j_surv and action = 'accept_proposal'), 1,
      'the correction is on the survivor');
    perform pg_temp.expect((select count(*) from corrections where candidate_id = j_cand), 0, 'and none on the merged candidate');
    perform pg_temp.expect_text(pg_temp.finished(j_req) ->> 'candidateId', j_surv::text, 'the audit row names the survivor');

    -- finch: merged into a survivor that was rejected since: nothing to link to.
    perform pg_temp.puts(v_tenant, v_src_a, 'finch', 1, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-finch');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-finch', interval '75 minutes');
    perform pg_temp.mark_all(j_req, 'job-finch',
        array[pg_temp.k('finch', 1)], 'finch: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('finch', 1), 'fc-1', 'conv-finch');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-finch')), 1, 'finch: stored');
    j_surv := pg_temp.cand(v_tenant, v_alice, 'finch-survivor', 'rejected');
    insert into deal_candidates (tenant_id, cluster_key, discovery_state, merged_into_id, proposed_name)
      values (v_tenant, 'model:u:' || v_alice::text || ':project-finch', 'merged_into', j_surv, 'Project Finch')
      returning id into j_cand;
    j_corr := (select count(*) from corrections where tenant_id = v_tenant);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-finch', j_cand, null)), 1,
      'finch: finished');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'candidate_closed' and found_count = 0 and purged_count = 1
          and candidate_id is null), 1, 'failed candidate_closed, the stored message purged');
    perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), j_corr, 'no correction');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-finch' and candidate_id is null), 1,
      'and the row stays under m:');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('finch', 1)), 0, 'with no holder row');

    -- rook: the cluster's candidate was rejected between the accept and the job.
    perform pg_temp.puts(v_tenant, v_src_a, 'rook', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-rook');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-rook', interval '75 minutes');
    perform pg_temp.mark_all(j_req, 'job-rook',
        array[pg_temp.k('rook', 1), pg_temp.k('rook', 2)], 'rook: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('rook', 1), 'rk-1', 'conv-rook');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('rook', 2), 'rk-2', 'conv-rook');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-rook')), 1, 'rook: stored');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'rook', 'rejected');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-rook', j_cand, null)), 1, 'rook: finished');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'candidate_closed' and found_count = 0 and purged_count = 2
          and candidate_id is null), 1, 'failed candidate_closed, both stored messages purged');
    perform pg_temp.expect((select count(*) from corrections where candidate_id = j_cand), 0, 'no correction');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-rook' and candidate_id is null), 2, 'the rows stay under m:');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('rook', 1)) + pg_temp.holders(v_src_a, pg_temp.m('rook', 2)), 0,
      'with no holder rows');
    perform pg_temp.expect_text(pg_temp.finished(j_req) ->> 'outcome', 'candidate_closed', 'audited as candidate_closed');
    perform pg_temp.expect(pg_temp.flag(pg_temp.finished(j_req) ? 'candidateId'), 0, 'with no candidate id');

    -- dove: nothing could be read, so nothing was stored; the job fails it from running.
    perform pg_temp.puts(v_tenant, v_src_a, 'dove', 1, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-dove');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-dove', interval '75 minutes');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-dove', null, 'none_readable')), 1,
      'dove: finished');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'none_readable' and found_count = 0 and purged_count = 0
          and storing_keys is null and candidate_id is null), 1, 'failed none_readable, with nothing to purge');
    perform pg_temp.expect_text(pg_temp.finished(j_req) ->> 'outcome', 'none_readable', 'audited as none_readable');
    -- With no failure code and no candidate, the same word.
    perform pg_temp.puts(v_tenant, v_src_a, 'dove2', 1, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-dove2');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-dove2', interval '75 minutes');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-dove2', null, null)), 1, 'dove2: finished');
    perform pg_temp.expect_text((select failure_code from discovery_model_proposal_accepts where id = j_req), 'none_readable',
      'no candidate and no code is none_readable');

    -- pipit: the guard refused on resume. A given code skips the linking, and the stored text is purged.
    perform pg_temp.puts(v_tenant, v_src_a, 'pipit', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-pipit');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-pipit', interval '75 minutes');
    perform pg_temp.mark_all(j_req, 'job-pipit',
        array[pg_temp.k('pipit', 1), pg_temp.k('pipit', 2)], 'pipit: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('pipit', 1), 'pp-1', 'conv-pipit');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('pipit', 2), 'pp-2', 'conv-pipit');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-pipit')), 1, 'pipit: stored');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'pipit');
    j_corr := (select count(*) from corrections where tenant_id = v_tenant);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-pipit', j_cand, 'source_unavailable')), 1,
      'pipit: finished with a code');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'source_unavailable' and found_count = 0 and purged_count = 2
          and candidate_id is null), 1, 'failed source_unavailable, both holders purged');
    perform pg_temp.expect((select count(*) from corrections where tenant_id = v_tenant), j_corr, 'no correction');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-pipit' and candidate_id is null), 2, 'the rows stay under m:');
    raise notice 'PASS: finish states';

    -- ── 4. Purge: success on a promoted candidate, an item no seat could link ──
    -- quail: the candidate was promoted since the accept. The upsert links only quail-1 (quail-2's owner is not seated), so
    -- quail-2 is stored and unlinked: purged even though the request succeeds.
    perform pg_temp.puts(v_tenant, v_src_a, 'quail', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-quail');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-quail', interval '75 minutes');
    perform pg_temp.mark_all(j_req, 'job-quail',
        array[pg_temp.k('quail', 1), pg_temp.k('quail', 2)], 'quail: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('quail', 1), 'qu-1', 'conv-quail');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('quail', 2), 'qu-2', 'conv-quail');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-quail')), 1, 'quail: stored');
    select id into j_deal from deals where code = 'pd-' || v_tenant::text;
    perform pg_temp.expect(pg_temp.flag(j_deal is not null), 1, 'premise: the tenant has a deal to promote to');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'quail');
    update deal_candidates set discovery_state = 'confirmed', promoted_deal_id = j_deal where id = j_cand;
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('quail', 1));
    perform discovery_refresh_candidate_visibility(j_cand);
    j_deals := (select count(*) from deals where tenant_id = v_tenant);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-quail', j_cand, null)), 1, 'quail: finished');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'done' and found_count = 1 and changed_count = 1 and purged_count = 1
          and candidate_id = j_cand), 1, 'done on the promoted candidate: one found, one purged');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('quail', 1)), 1, 'the linked message keeps its holder row');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('quail', 2)), 0, 'the unseated one loses it');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'qu-1'), 'routed/model_proposal/-/-', 'quail-1 stays routed');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'qu-2'), 'unrouted/-/conv-quail/' || pg_temp.m('quail', 2),
      'quail-2 is unrouted with its ids restored');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'c:' || j_cand::text and candidate_id = j_cand), 1,
      'only the linked row is re-keyed');
    perform pg_temp.expect((select count(*) from deal_candidates
        where id = j_cand and discovery_state = 'confirmed' and promoted_deal_id = j_deal and pinned = false
          and station_override_step_id is null), 1, 'the promoted candidate is as it was: no station, no pin');
    perform pg_temp.expect((select count(*) from deals where tenant_id = v_tenant), j_deals, 'and no deal is made');

    -- plume: a crash during the persist. The job wrote the first of two write-ahead keys, then died before 'stored'.
    -- A new job claims the storing request, is held to the recorded keys, and its guard refuses: the purge covers
    -- everything that was persisted.
    perform pg_temp.puts(v_tenant, v_src_a, 'plume', 3, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-plume');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-plume-1', interval '75 minutes');
    perform pg_temp.mark_all(j_req, 'job-plume-1',
        array[pg_temp.k('plume', 1), pg_temp.k('plume', 2)], 'plume: write-ahead of two keys');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('plume', 1), 'pl-1', 'conv-plume');
    update discovery_model_proposal_accepts set lease_until = now() - interval '1 minute' where id = j_req;
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-plume-2', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'plume: the next job reclaims it');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'storing' and claim_token = 'job-plume-2' and attempts = 2
          and cardinality(storing_keys) = 2), 1, 'still storing, with both recorded keys');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-plume-2')), 2,
      'and held to them: the third live message is not offered');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-plume-1', null, 'source_unavailable')), 0,
      'the crashed job cannot finish it');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-plume-2', null, 'source_unavailable')), 1,
      'the new job fails it from storing');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'source_unavailable' and purged_count = 1 and found_count = 0
          and cardinality(storing_keys) = 2), 1,
      'failed source_unavailable: one holder purged (the other key never reached the store), the keys kept as the record');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('plume', 1)), 0, 'plume-1''s holder row is gone');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'pl-1'), 'unrouted/-/conv-plume/' || pg_temp.m('plume', 1),
      'and its ledger row is unrouted');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('plume', 3)), 0, 'plume-3 was never stored');
    raise notice 'PASS: purge on success and from storing';

    -- ── 4. Purge: a shared item. Only this source's rows go ───────────────────
    -- gull-1 is also held by the colleague's mailbox (stored by the firm rules, with no evidence link), under the same
    -- provider id as Alice's copy: the purge must filter its ledger by source. gull-2 is Alice's alone. The write-ahead
    -- holds both keys, because the source it is judged against is Alice's: the colleague's holder row does not count.
    perform pg_temp.puts(v_tenant, v_src_a, 'gull', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-gull');
    perform pg_temp.store(v_tenant, v_src_coll, pg_temp.m('gull', 1), 'shared-prov-1', 'conv-gull', 'codename');
    perform pg_temp.index_it(v_tenant, v_src_coll, pg_temp.m('gull', 1), array['shared-prov-1']);
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-gull', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'gull: claimed');
    perform pg_temp.mark_all(j_req, 'job-gull',
        array[pg_temp.k('gull', 1), pg_temp.k('gull', 2)], 'gull: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('gull', 1), 'shared-prov-1', 'conv-gull');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('gull', 2), 'gl-2', 'conv-gull');
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('gull', 1), array['shared-prov-1']);
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('gull', 2), array['gl-2']);
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-gull')), 1, 'gull: stored');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('gull', 1)), 1, 'premise: one item for the shared message');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('gull', 1)) + pg_temp.holders(v_src_coll, pg_temp.m('gull', 1)), 2,
      'premise: held by both mailboxes');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'gull');
    j_props := (select count(*) from discovery_model_proposals where tenant_id = v_tenant);
    j_idx := (select count(*) from discovery_message_index where tenant_id = v_tenant);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-gull', j_cand, null)), 1,
      'gull: finished with a candidate that has no link');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'none_readable' and found_count = 0 and purged_count = 2
          and candidate_id is null), 1, 'failed none_readable: nothing linked, both of this source''s holders purged');
    -- This source's rows are gone; the colleague's are not.
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('gull', 1)), 0, 'Alice''s holder row of the shared item is gone');
    perform pg_temp.expect(pg_temp.holders(v_src_coll, pg_temp.m('gull', 1)), 1, 'the colleague''s holder row stays');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('gull', 1)) + pg_temp.texts(pg_temp.m('gull', 1)), 2,
      'and so do the shared item and its text');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'shared-prov-1'), 'unrouted/-/conv-gull/' || pg_temp.m('gull', 1),
      'Alice''s ledger row is unrouted, the clear ids restored');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_coll, 'shared-prov-1'), 'routed/codename/-/-',
      'the colleague''s ledger row, under the same provider id, is as it was');
    perform pg_temp.expect((select count(*) from routing_ledger where source_id = v_src_coll
        and provider_item_id = 'shared-prov-1' and confidence = 0.9), 1, 'with its confidence');
    perform pg_temp.expect(pg_temp.index_rows(v_src_coll, pg_temp.m('gull', 1)), 1, 'the colleague''s index row stays');
    -- gull-2 is nobody's now: the item is still there until the collector.
    perform pg_temp.expect(pg_temp.items(pg_temp.m('gull', 2)) + pg_temp.texts(pg_temp.m('gull', 2)), 2,
      'gull-2''s item and text are still stored: finish never deletes an item');
    perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), j_props,
      'proposals unchanged');
    perform pg_temp.expect((select count(*) from discovery_message_index where tenant_id = v_tenant), j_idx,
      'and the index has the same rows');
    raise notice 'PASS: shared item';

    -- ── 4. Purge: the clear ids come back for every provider id the source read the message under ──
    perform pg_temp.puts(v_tenant, v_src_a, 'kiwi', 1, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-kiwi');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-kiwi', interval '75 minutes');
    perform pg_temp.mark_all(j_req, 'job-kiwi',
        array[pg_temp.k('kiwi', 1)], 'kiwi: write-ahead');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('kiwi', 1), 'kw-1', 'conv-kiwi');
    -- The message was also read as a copy (a second provider id, the same Message-ID): the index lists both.
    insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, run_id)
      values (v_src_a, 'kw-1-copy', 'h-kiwi-copy', 'routed', 'model_proposal', 0.9, gen_random_uuid()),
             (v_src_a, 'kw-x', 'h-kiwi-other', 'routed', 'codename', 0.8, gen_random_uuid());
    perform pg_temp.index_it(v_tenant, v_src_a, pg_temp.m('kiwi', 1), array['kw-1', 'kw-1-copy']);
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-kiwi')), 1, 'kiwi: stored');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-kiwi', null, 'error')), 1,
      'kiwi: failed by the job');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'kw-1'), 'unrouted/-/conv-kiwi/' || pg_temp.m('kiwi', 1),
      'the holder''s provider id is reset');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'kw-1-copy'), 'unrouted/-/conv-kiwi/' || pg_temp.m('kiwi', 1),
      'and so is the copy''s, which the index lists');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'kw-x'), 'routed/codename/-/-', 'another message''s row is not touched');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'error' and purged_count = 1), 1,
      'purged_count counts the holder row deleted');
    perform pg_temp.expect(pg_temp.index_rows(v_src_a, pg_temp.m('kiwi', 1)), 1, 'and the index keeps its row');
    raise notice 'PASS: ledger reset';

    -- ── 4. Purge: a message this source already held is not the accept's to store or to undo ──
    -- wren-1 and wren-2 were stored by a normal pass and routed (codename) to the rules candidate X, yet each kept its m:
    -- proposal row, so both are live keys. The write-ahead leaves them out, because this source already holds them (not
    -- because of any evidence): the job neither stores nor purges them, so no accept, failed or not, can undo a route
    -- the source already had.
    insert into deal_candidates (tenant_id, cluster_key, proposed_name)
      values (v_tenant, 'codename:wren', 'Wren') returning id into j_surv;
    perform pg_temp.puts(v_tenant, v_src_a, 'wren', 2, v_old);
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('wren', 1), 'wr-1', 'conv-wren', 'codename');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('wren', 2), 'wr-2', 'conv-wren', 'codename');
    perform pg_temp.link_item(v_tenant, j_surv, pg_temp.m('wren', 1), 'codename');
    perform pg_temp.link_item(v_tenant, j_surv, pg_temp.m('wren', 2), 'codename');
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-wren');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-wren', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'wren: claimed');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req, 'job-wren')), 2,
      'wren: both messages are live keys');
    perform pg_temp.expect_text(pg_temp.skeys(discovery_mark_model_proposal_accept_storing(j_req, 'job-wren',
        array[pg_temp.k('wren', 1), pg_temp.k('wren', 2)])), '{}',
      'wren: the write-ahead answers no key: the source already holds both');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'storing' and storing_keys is not null and cardinality(storing_keys) = 0), 1,
      'and records none (an empty record, not a null one)');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-wren')), 1, 'wren: stored');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-wren', null, 'source_unavailable')), 1,
      'wren: failed by the job with a given code');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'source_unavailable' and found_count = 0 and purged_count = 0
          and cardinality(storing_keys) = 0), 1, 'failed with nothing purged: there was nothing the request had stored');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('wren', 1)) + pg_temp.holders(v_src_a, pg_temp.m('wren', 2)), 2,
      'both holder rows stay');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'wr-1'), 'routed/codename/-/-', 'wren-1 keeps its rules route');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'wr-2'), 'routed/codename/-/-', 'and so does wren-2');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('wren', 1)) + pg_temp.items(pg_temp.m('wren', 2))
      + pg_temp.texts(pg_temp.m('wren', 1)) + pg_temp.texts(pg_temp.m('wren', 2)), 4, 'the items and their text stay');
    perform pg_temp.expect((select count(*) from evidence_links where candidate_id = j_surv and method = 'codename'
        and state = 'proposed'), 2, 'and the rules candidate keeps both links');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-wren' and candidate_id is null), 2,
      'the proposal rows stay under m:');
    perform pg_temp.expect((pg_temp.finished(j_req) ->> 'purged')::bigint, 0, 'the audit row counts no purge');

    -- A successful accept that links one message and meets a held, rules-routed one: the write-ahead leaves that one out
    -- (so the persist never touches it), and the unlinked message the request did store is purged.
    perform pg_temp.puts(v_tenant, v_src_a, 'wren2', 3, v_old);
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('wren2', 1), 'w2-1', 'conv-wren2', 'codename');
    perform pg_temp.link_item(v_tenant, j_surv, pg_temp.m('wren2', 1), 'codename');
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-wren2');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-wren2', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'wren2: claimed');
    perform pg_temp.expect_text(pg_temp.skeys(discovery_mark_model_proposal_accept_storing(j_req, 'job-wren2',
        array[pg_temp.k('wren2', 1), pg_temp.k('wren2', 2), pg_temp.k('wren2', 3)])),
      pg_temp.skeys(array[pg_temp.k('wren2', 2), pg_temp.k('wren2', 3)]),
      'wren2: the write-ahead answers the two keys the source does not hold, and leaves the held one out');
    perform pg_temp.expect_text((select storing_keys::text from discovery_model_proposal_accepts where id = j_req),
      pg_temp.skeys(array[pg_temp.k('wren2', 2), pg_temp.k('wren2', 3)]), 'and records exactly those two');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('wren2', 2), 'w2-2', 'conv-wren2');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('wren2', 3), 'w2-3', 'conv-wren2');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-wren2')), 1, 'wren2: stored');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'wren2');
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('wren2', 2));
    perform discovery_refresh_candidate_visibility(j_cand);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-wren2', j_cand, null)), 1,
      'wren2: finished with the candidate');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'done' and found_count = 1 and changed_count = 2 and purged_count = 1
          and candidate_id = j_cand), 1, 'done: one linked, one purged; the held message is neither (it was never recorded)');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('wren2', 1)), 1, 'the rules-routed message keeps its holder row');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'w2-1'), 'routed/codename/-/-', 'and its rules route');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('wren2', 1)) + pg_temp.texts(pg_temp.m('wren2', 1)), 2, 'with its item and text');
    perform pg_temp.expect((select count(*) from evidence_links l join source_items i on i.id = l.source_item_id
        where l.candidate_id = j_surv and i.internet_message_id = pg_temp.m('wren2', 1)), 1, 'and its rules evidence');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-wren2' and candidate_id is null
          and message_key = pg_temp.k('wren2', 1)), 1, 'its proposal row stays under m: (it was not linked to the accept''s candidate)');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('wren2', 2)), 1, 'the linked message keeps its holder row');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('wren2', 3)), 0, 'the accept-only unlinked one loses it');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'w2-3'), 'unrouted/-/conv-wren2/' || pg_temp.m('wren2', 3),
      'and goes back to unrouted with its ids restored');
    raise notice 'PASS: rules-routed messages kept';

    -- ── 4. Purge: a second accept of a group an earlier accept already linked ─────
    -- lynx: Alice's first accept stored lynx-1 and lynx-2 and linked both. The proposal writer then read lynx-1 again
    -- under a new prompt version, which left a fresh m: row for it (the first accept re-keyed only the rows it held), so
    -- the group is offered again. That second accept holds lynx-1 already, so its write-ahead records nothing; when it
    -- fails, nothing is purged: the first accept's holder rows, ledger rows, items and evidence all survive.
    perform pg_temp.puts(v_tenant, v_src_a, 'lynx', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-lynx');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-lynx-1', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'lynx: the first accept is claimed');
    perform pg_temp.mark_all(j_req, 'job-lynx-1', array[pg_temp.k('lynx', 1), pg_temp.k('lynx', 2)],
      'lynx: the first write-ahead records both keys');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('lynx', 1), 'ly-1', 'conv-lynx');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('lynx', 2), 'ly-2', 'conv-lynx');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-lynx-1')), 1, 'lynx: stored');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'lynx');
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('lynx', 1));
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('lynx', 2));
    perform discovery_refresh_candidate_visibility(j_cand);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-lynx-1', j_cand, null)), 1,
      'lynx: the first accept finishes');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'done' and found_count = 2 and changed_count = 0 and purged_count = 0
          and candidate_id = j_cand), 1, 'done: both linked');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'c:' || j_cand::text and candidate_id = j_cand), 2,
      'and both rows are re-keyed');
    -- The writer reads lynx-1 under a new prompt version: a fresh m: row, which the first accept's re-key never touched.
    perform pg_temp.put(v_tenant, v_src_a, pg_temp.m('lynx', 1), 'm:project-lynx', 'Project Lynx', v_old, 'phase-2', 'v4');
    j_req2 := pg_temp.alice_accepts(v_alice, 'm:project-lynx');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req2 and email_count = 1 and cardinality(proposal_ids) = 1 and state = 'pending'), 1,
      'lynx: the group is offered again, with the one new row');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-lynx-2', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'lynx: the second accept is claimed');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accept_live_keys(j_req2, 'job-lynx-2')), 1,
      'its one live key is lynx-1');
    perform pg_temp.expect_text(pg_temp.skeys(discovery_mark_model_proposal_accept_storing(j_req2, 'job-lynx-2',
        array[pg_temp.k('lynx', 1)])), '{}', 'lynx: the write-ahead answers no key: the source holds lynx-1 already');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req2 and state = 'storing' and storing_keys is not null and cardinality(storing_keys) = 0
          and not (pg_temp.k('lynx', 1) = any (storing_keys))), 1, 'and lynx-1 is not in the second request''s storing_keys');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req2, 'job-lynx-2')), 1, 'lynx: stored');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req2, 'job-lynx-2', null, 'none_readable')), 1,
      'lynx: the second accept fails with a given code');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req2 and state = 'failed' and failure_code = 'none_readable' and found_count = 0 and changed_count = 0
          and purged_count = 0 and candidate_id is null), 1, 'failed none_readable, with nothing purged');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('lynx', 1)) + pg_temp.holders(v_src_a, pg_temp.m('lynx', 2)), 2,
      'both of the first accept''s holder rows survive');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'ly-1'), 'routed/model_proposal/-/-', 'lynx-1 is still routed');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'ly-2'), 'routed/model_proposal/-/-', 'and lynx-2');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('lynx', 1)) + pg_temp.items(pg_temp.m('lynx', 2))
      + pg_temp.texts(pg_temp.m('lynx', 1)) + pg_temp.texts(pg_temp.m('lynx', 2)), 4, 'the items and their text survive');
    perform pg_temp.expect((select count(*) from evidence_links where candidate_id = j_cand and state = 'proposed'), 2,
      'and so does the evidence');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'c:' || j_cand::text and candidate_id = j_cand), 2,
      'the first accept''s re-keyed rows are as they were');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-lynx' and candidate_id is null
          and message_key = pg_temp.k('lynx', 1) and prompt_version = 'v4'), 1, 'and the fresh row stays under m:');
    perform pg_temp.expect((pg_temp.finished(j_req2) ->> 'purged')::bigint, 0, 'the audit row counts no purge');

    -- otter: the same group offered again, and this time the second accept succeeds. It links otter-1 over the
    -- snapshot's keys, though it stored nothing, and re-keys the fresh row.
    perform pg_temp.puts(v_tenant, v_src_a, 'otter', 2, v_old);
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-otter');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-otter-1', interval '75 minutes');
    perform pg_temp.mark_all(j_req, 'job-otter-1', array[pg_temp.k('otter', 1), pg_temp.k('otter', 2)],
      'otter: the first write-ahead records both keys');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('otter', 1), 'ot-1', 'conv-otter');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('otter', 2), 'ot-2', 'conv-otter');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-otter-1')), 1, 'otter: stored');
    j_cand := pg_temp.cand(v_tenant, v_alice, 'otter');
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('otter', 1));
    perform pg_temp.link_item(v_tenant, j_cand, pg_temp.m('otter', 2));
    perform discovery_refresh_candidate_visibility(j_cand);
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-otter-1', j_cand, null)), 1,
      'otter: the first accept finishes');
    perform pg_temp.put(v_tenant, v_src_a, pg_temp.m('otter', 1), 'm:project-otter', 'Project Otter', v_old, 'phase-2', 'v4');
    j_req2 := pg_temp.alice_accepts(v_alice, 'm:project-otter');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-otter-2', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'otter: the second accept is claimed');
    perform pg_temp.expect_text(pg_temp.skeys(discovery_mark_model_proposal_accept_storing(j_req2, 'job-otter-2',
        array[pg_temp.k('otter', 1)])), '{}', 'otter: the write-ahead answers no key: otter-1 is held already');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req2, 'job-otter-2')), 1, 'otter: stored');
    j_corr := (select count(*) from corrections where candidate_id = j_cand and action = 'accept_proposal');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req2, 'job-otter-2', j_cand, null)), 1,
      'otter: the second accept finishes with the candidate');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req2 and state = 'done' and found_count = 1 and changed_count = 0 and purged_count = 0
          and candidate_id = j_cand and cardinality(storing_keys) = 0), 1,
      'done: otter-1 is linked though it was not stored, nothing changed, nothing purged');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'c:' || j_cand::text and candidate_id = j_cand), 3,
      'three rows are under the candidate: the first accept''s two and the fresh one');
    perform pg_temp.expect((select count(*) from discovery_model_proposals
        where content_source_id = v_src_a and deal_key = 'm:project-otter'), 0, 'and none is left under m:');
    perform pg_temp.expect(j_corr + 1, (select count(*) from corrections
        where candidate_id = j_cand and action = 'accept_proposal'), 'a correction records the second accept');
    perform pg_temp.expect((select count(*) from corrections
        where candidate_id = j_cand and action = 'accept_proposal' and (after ->> 'requestId') = j_req2::text
          and (after ->> 'found') = '1' and (after ->> 'requested') = '1'), 1, 'with its request id and counts');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('otter', 1)) + pg_temp.holders(v_src_a, pg_temp.m('otter', 2)), 2,
      'the holder rows survive');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'ot-1'), 'routed/model_proposal/-/-', 'and the ledger rows');
    j_detail := pg_temp.finished(j_req2);
    perform pg_temp.expect((j_detail ->> 'found')::bigint, 1, 'the audit row: found 1');
    perform pg_temp.expect((j_detail ->> 'purged')::bigint, 0, 'purged 0');
    perform pg_temp.expect_text(j_detail ->> 'outcome', 'done', 'outcome done');
    raise notice 'PASS: second accept';

    -- ── 4. Purge: an item that is another candidate's evidence is no reason to keep this request's holder row ──
    -- pika-1 is the colleague's accepted message: stored by the colleague's mailbox, evidence of the colleague's own
    -- candidate. Alice's mailbox does not hold it, so her accept's write-ahead records it, her job stores it, and when
    -- the accept fails her new holder row goes, however the item is used elsewhere. The colleague's side is untouched.
    perform pg_temp.puts(v_tenant, v_src_a, 'pika', 2, v_old);
    perform pg_temp.store(v_tenant, v_src_coll, pg_temp.m('pika', 1), 'pk-c1', 'conv-pika');
    j_cand2 := pg_temp.cand(v_tenant, v_colleague, 'pika');
    perform pg_temp.link_item(v_tenant, j_cand2, pg_temp.m('pika', 1));
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('pika', 1)), 0, 'premise: Alice''s mailbox does not hold pika-1');
    perform pg_temp.expect(pg_temp.holders(v_src_coll, pg_temp.m('pika', 1)), 1, 'premise: the colleague''s does');
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-pika');
    select count(*) into j_n from discovery_claim_model_proposal_accepts(v_src_a, 'job-pika', interval '75 minutes');
    perform pg_temp.expect(j_n, 1, 'pika: claimed');
    perform pg_temp.mark_all(j_req, 'job-pika', array[pg_temp.k('pika', 1), pg_temp.k('pika', 2)],
      'pika: the write-ahead records both keys (the colleague''s holder row does not count)');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('pika', 1), 'pk-a1', 'conv-pika');
    perform pg_temp.store(v_tenant, v_src_a, pg_temp.m('pika', 2), 'pk-a2', 'conv-pika');
    perform pg_temp.expect(pg_temp.flag(discovery_mark_model_proposal_accept_stored(j_req, 'job-pika')), 1, 'pika: stored');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('pika', 1)), 1, 'premise: one item for the shared message');
    perform pg_temp.expect(pg_temp.flag(discovery_finish_model_proposal_accept(j_req, 'job-pika', null, 'error')), 1,
      'pika: the job fails it');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where id = j_req and state = 'failed' and failure_code = 'error' and found_count = 0 and purged_count = 2
          and cardinality(storing_keys) = 2), 1, 'failed, and purged_count counts both holder rows, pika-1 included');
    perform pg_temp.expect(pg_temp.holders(v_src_a, pg_temp.m('pika', 1)) + pg_temp.holders(v_src_a, pg_temp.m('pika', 2)), 0,
      'Alice''s new holder rows are gone');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_a, 'pk-a1'), 'unrouted/-/conv-pika/' || pg_temp.m('pika', 1),
      'her ledger row for pika-1 is unrouted, the clear ids restored');
    perform pg_temp.expect(pg_temp.holders(v_src_coll, pg_temp.m('pika', 1)), 1, 'the colleague''s holder row survives');
    perform pg_temp.expect_text(pg_temp.ledger(v_src_coll, 'pk-c1'), 'routed/model_proposal/-/-', 'and their ledger row');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('pika', 1)) + pg_temp.texts(pg_temp.m('pika', 1)), 2,
      'the shared item and its text survive');
    perform pg_temp.expect((select count(*) from evidence_links l join source_items i on i.id = l.source_item_id
        where l.candidate_id = j_cand2 and i.internet_message_id = pg_temp.m('pika', 1)), 1,
      'and the colleague''s evidence');
    perform pg_temp.expect((pg_temp.finished(j_req) ->> 'purged')::bigint, 2, 'the audit row counts both');
    raise notice 'PASS: shared evidence';

    -- ── 4. The collector removes an item no source holds, and only that ───────
    -- Every purged message above lost its holder; gull-1 still has the colleague's. The collector's default guard
    -- (15 minutes) is passed by the fixture's hour-old items.
    j_n := (select count(*) from source_items i
            where i.tenant_id = v_tenant and i.kind = 'message' and i.created_at <= now() - interval '15 minutes'
              and not exists (select 1 from source_item_sources s where s.source_item_id = i.id));
    perform pg_temp.expect(pg_temp.flag(j_n >= 10), 1, 'premise: the purged messages are orphans now');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('gull', 2)), 1, 'premise: gull-2 is still stored');
    j_props := (select count(*) from discovery_model_proposals where tenant_id = v_tenant);
    j_idx := (select count(*) from discovery_message_index where tenant_id = v_tenant);
    j_detail := discovery_collect_orphans(v_tenant);
    perform pg_temp.expect((j_detail ->> 'items')::bigint, j_n, 'the collector deletes exactly the orphans');
    perform pg_temp.expect((j_detail ->> 'evidence')::bigint, 0, 'none of which carried evidence');
    perform pg_temp.expect((j_detail ->> 'candidates')::bigint, 0, 'so no candidate is deleted');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('gull', 2)) + pg_temp.texts(pg_temp.m('gull', 2)), 0,
      'gull-2 and its text are deleted');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('ibis', 1)) + pg_temp.items(pg_temp.m('swan', 3))
      + pg_temp.items(pg_temp.m('quail', 2)) + pg_temp.items(pg_temp.m('kiwi', 1)), 0, 'and so are the other purged ones');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('pika', 2)) + pg_temp.items(pg_temp.m('jsto', 1))
      + pg_temp.items(pg_temp.m('jsto', 2)) + pg_temp.items(pg_temp.m('jstd', 1)) + pg_temp.items(pg_temp.m('jstd', 2))
      + pg_temp.items(pg_temp.m('jarc', 1)) + pg_temp.items(pg_temp.m('jlive', 1)), 0,
      'and the ones an expiry or a failed accept left with no holder');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('gull', 1)) + pg_temp.texts(pg_temp.m('gull', 1)), 2,
      'the shared item and its text stay, the colleague holding them');
    perform pg_temp.expect(pg_temp.holders(v_src_coll, pg_temp.m('gull', 1)), 1, 'with the colleague''s holder row');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('pika', 1)) + pg_temp.texts(pg_temp.m('pika', 1)), 2,
      'pika-1, the colleague''s evidence, stays too');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('swan', 1)) + pg_temp.items(pg_temp.m('swan', 2))
      + pg_temp.items(pg_temp.m('quail', 1)) + pg_temp.items(pg_temp.m('lark', 1)), 4, 'held and linked items are untouched');
    perform pg_temp.expect(pg_temp.items(pg_temp.m('lynx', 1)) + pg_temp.items(pg_temp.m('lynx', 2))
      + pg_temp.items(pg_temp.m('otter', 1)) + pg_temp.items(pg_temp.m('otter', 2))
      + pg_temp.items(pg_temp.m('wren', 1)) + pg_temp.items(pg_temp.m('wren', 2)), 6,
      'so are the ones a failed second accept and a rules route left held');
    perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), j_props,
      'proposals unchanged');
    perform pg_temp.expect((select count(*) from discovery_message_index where tenant_id = v_tenant), j_idx,
      'and the index has the same rows');
    j_detail := discovery_collect_orphans(v_tenant);
    perform pg_temp.expect((j_detail ->> 'items')::bigint, 0, 'a second run deletes nothing');
    raise notice 'PASS: collector';

    -- ── A failed request can be asked again ───────────────────────────────────
    j_req := pg_temp.alice_accepts(v_alice, 'm:project-ibis');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where content_source_id = v_src_a and deal_key = 'm:project-ibis'), 2,
      'ibis: a new request beside the failed one');
    perform pg_temp.expect_text(pg_temp.st(j_req), 'pending', 'which is pending');

    -- ── Put the fixture back for the tail ─────────────────────────────────────
    -- Every request this part wrote goes (the other tenant's source went with its requests); section 1's six come off
    -- the parking and are pending again, and mailbox A is active and not archived, as the fixture made it.
    delete from discovery_model_proposal_accepts where content_source_id = v_src_a and not (id = any (j_parked));
    update discovery_model_proposal_accepts
       set state = 'pending', claim_token = null, lease_until = null, attempts = 0
     where id = any (j_parked);
    perform pg_temp.expect((select count(*) from content_sources
        where id = v_src_a and status = 'active' and archived_at is null), 1, 'mailbox A is active and not archived');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where tenant_id = v_other), 0,
      'no request is left on the other tenant');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id = v_src_a), 6,
      'only section 1''s six requests remain on mailbox A');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where content_source_id = v_src_a and state = 'pending' and claim_token is null and lease_until is null
          and attempts = 0 and finished_at is null), 6, 'all pending, as section 1 left them');
    perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts
        where content_source_id = v_src_coll and state = 'pending' and attempts = 0), 1, 'and the colleague''s');
    perform pg_temp.expect(pg_temp.live_requests(v_src_a, 'm:project-heron'), 1, 'heron is live on A, as the tail expects');
  end;

  -- ══════════════════════════════════════════════════════════════════════════
  -- Origin reads (20261023140400_discovery_origin_read.sql): where a candidate or a deal came from, past RLS.
  -- Every model-origin deal gets the pop-up (design R1, R14, TH-7), so the answer must not depend on what the asker's
  -- RLS shows: a deal member or overseer who is not the finder, and a viewer who cannot see a merged-away `model:`
  -- candidate, are both told model_proposal. Only the word leaves, never a cluster key or another candidate's id.
  -- Personas as above: Alice (the finder, sees what her mailbox A evidences), the colleague (sees what theirs does; a
  -- member of the deals seated below), Tess (a member of another deal only), the CCO and the admin (overseers), the
  -- outsider (an overseer of another tenant). Every row is new and rolls back with the transaction.
  -- ══════════════════════════════════════════════════════════════════════════
  declare
    o_deal_m  uuid;  -- promoted from a model candidate
    o_deal_r  uuid;  -- promoted from a rules candidate
    o_deal_s  uuid;  -- promoted from a rules survivor that a model candidate was merged into
    o_deal_e  uuid;  -- nothing promoted to it
    o_deal_x  uuid;  -- promoted from a model candidate; the colleague is not seated on it
    o_m1      uuid;  -- model candidate, Alice sees it
    o_r1      uuid;  -- rules candidate, Alice sees it
    o_s1      uuid;  -- rules survivor, Alice and the colleague see it
    o_mm1     uuid;  -- model candidate merged into o_s1, only Alice sees it
    o_t1      uuid;  -- survivor of a two-hop chain: t3 (model) -> t2 -> t1
    o_t2      uuid;
    o_t3      uuid;
    o_u1      uuid;  -- rules survivor of a rules-only chain
    o_u2      uuid;
    o_x1      uuid;  -- a cycle of rules candidates
    o_x2      uuid;
    o_d       uuid[] := '{}';  -- a ten-deep chain, the model candidate at the bottom
    o_pm      uuid;  -- promoted to o_deal_m, model; only Alice sees it
    o_pr      uuid;  -- promoted to o_deal_r, rules
    o_ps      uuid;  -- promoted to o_deal_s, rules, with a merged model candidate
    o_pms     uuid;
    o_px      uuid;  -- promoted to o_deal_x, model
    o_role    uuid := (select id from roles where slug = 'deal_team');
    o_ids     uuid[];
    o_who     uuid;
    o_deal    uuid;
    o_i       integer;
    o_msg     text;
  begin
    reset role;
    perform pg_temp.act_as_service();

    -- ── Fixture ───────────────────────────────────────────────────────────────
    insert into deals (tenant_id, code, codename, bank_id) values (v_tenant, 'od-m-' || left(v_tenant::text, 8), 'Origin M', v_bank)
      returning id into o_deal_m;
    insert into deals (tenant_id, code, codename, bank_id) values (v_tenant, 'od-r-' || left(v_tenant::text, 8), 'Origin R', v_bank)
      returning id into o_deal_r;
    insert into deals (tenant_id, code, codename, bank_id) values (v_tenant, 'od-s-' || left(v_tenant::text, 8), 'Origin S', v_bank)
      returning id into o_deal_s;
    insert into deals (tenant_id, code, codename, bank_id) values (v_tenant, 'od-e-' || left(v_tenant::text, 8), 'Origin E', v_bank)
      returning id into o_deal_e;
    insert into deals (tenant_id, code, codename, bank_id) values (v_tenant, 'od-x-' || left(v_tenant::text, 8), 'Origin X', v_bank)
      returning id into o_deal_x;
    -- The colleague sits on four of the five (not X). Tess sits on none of them. Alice sits on none either: she is the
    -- finder, so she reads her candidates through their evidence, not through a seat.
    insert into deal_memberships (deal_id, user_id, role_id, deal_role)
      select d, v_colleague, o_role, 'deal_team' from unnest(array[o_deal_m, o_deal_r, o_deal_s, o_deal_e]) d;

    -- Plain candidates, one model and one rules, each evidenced in Alice's mailbox A.
    o_m1 := pg_temp.oc(v_tenant, 'model:u:' || v_alice::text || ':project-or-m1');
    o_r1 := pg_temp.oc(v_tenant, 'codename:or-r1');
    perform pg_temp.seen(v_tenant, v_src_a, o_m1, 'm1');
    perform pg_temp.seen(v_tenant, v_src_a, o_r1, 'r1');
    -- The two-viewer merge: the survivor is evidenced in both mailboxes, the merged-away model candidate only in Alice's.
    o_s1  := pg_temp.oc(v_tenant, 'codename:or-s1');
    o_mm1 := pg_temp.oc(v_tenant, 'model:u:' || v_alice::text || ':project-or-mm1', 'merged_into', o_s1);
    perform pg_temp.seen(v_tenant, v_src_a, o_s1, 's1a');
    perform pg_temp.seen(v_tenant, v_src_coll, o_s1, 's1c');
    perform pg_temp.seen(v_tenant, v_src_a, o_mm1, 'mm1');
    -- Two hops: t3 (model) merged into t2 merged into t1.
    o_t1 := pg_temp.oc(v_tenant, 'codename:or-t1');
    o_t2 := pg_temp.oc(v_tenant, 'codename:or-t2', 'merged_into', o_t1);
    o_t3 := pg_temp.oc(v_tenant, 'model:u:' || v_alice::text || ':project-or-t3', 'merged_into', o_t2);
    perform pg_temp.seen(v_tenant, v_src_a, o_t1, 't1a');
    perform pg_temp.seen(v_tenant, v_src_coll, o_t1, 't1c');
    perform pg_temp.seen(v_tenant, v_src_a, o_t3, 't3');
    -- Rules only, merged: stays rules.
    o_u1 := pg_temp.oc(v_tenant, 'codename:or-u1');
    o_u2 := pg_temp.oc(v_tenant, 'codename:or-u2', 'merged_into', o_u1);
    perform pg_temp.seen(v_tenant, v_src_a, o_u1, 'u1');
    -- A cycle of rules candidates (impossible through the merge definer): the walk stops, and the answer is rules.
    o_x1 := pg_temp.oc(v_tenant, 'codename:or-x1');
    o_x2 := pg_temp.oc(v_tenant, 'codename:or-x2', 'merged_into', o_x1);
    update deal_candidates set discovery_state = 'merged_into', merged_into_id = o_x2 where id = o_x1;
    perform pg_temp.seen(v_tenant, v_src_a, o_x1, 'x1');
    -- A ten-deep chain of rules candidates with a model candidate at the bottom: d0 <- d1 <- ... <- d10 (model).
    o_d := array[pg_temp.oc(v_tenant, 'codename:or-d0')];
    for o_i in 1..10 loop
      o_d := o_d || pg_temp.oc(v_tenant,
        case when o_i = 10 then 'model:u:' || v_alice::text || ':project-or-d10' else 'codename:or-d' || o_i end,
        'merged_into', o_d[o_i]);
    end loop;
    perform pg_temp.seen(v_tenant, v_src_a, o_d[1], 'd0');
    -- Promoted candidates, evidenced in Alice's mailbox only. The colleague reads them through the deals.
    o_pm  := pg_temp.oc(v_tenant, 'model:u:' || v_alice::text || ':project-or-pm', 'confirmed', null, o_deal_m);
    o_pr  := pg_temp.oc(v_tenant, 'codename:or-pr', 'confirmed', null, o_deal_r);
    o_ps  := pg_temp.oc(v_tenant, 'codename:or-ps', 'confirmed', null, o_deal_s);
    o_pms := pg_temp.oc(v_tenant, 'model:u:' || v_alice::text || ':project-or-pms', 'merged_into', o_ps);
    o_px  := pg_temp.oc(v_tenant, 'model:u:' || v_alice::text || ':project-or-px', 'confirmed', null, o_deal_x);
    perform pg_temp.seen(v_tenant, v_src_a, o_pm, 'pm');
    perform pg_temp.seen(v_tenant, v_src_a, o_pr, 'pr');
    perform pg_temp.seen(v_tenant, v_src_a, o_ps, 'ps');
    perform pg_temp.seen(v_tenant, v_src_a, o_pms, 'pms');
    perform pg_temp.seen(v_tenant, v_src_a, o_px, 'px');

    -- Premises: what each persona reads under RLS, so the cases below test the definers and not the fixture.
    set local role authenticated;
    perform pg_temp.act_as(v_alice);
    perform pg_temp.expect((select count(*) from deal_candidates where id = any (array[o_m1, o_r1, o_s1, o_mm1, o_pm, o_px])), 6,
      'premise: Alice reads her candidates');
    perform pg_temp.act_as(v_colleague);
    perform pg_temp.expect((select count(*) from deal_candidates where id = o_s1), 1, 'premise: the colleague reads the survivor');
    perform pg_temp.expect((select count(*) from deal_candidates where id = any (array[o_mm1, o_t3, o_pm, o_pr, o_ps, o_pms, o_px, o_m1])), 0,
      'premise: the colleague reads none of the model candidates, merged-away or promoted, and none of the deals'' candidates');
    perform pg_temp.expect(pg_temp.flag(app_is_deal_member(o_deal_m, v_colleague)), 1, 'premise: the colleague sits on deal M');
    perform pg_temp.expect(pg_temp.flag(app_is_deal_member(o_deal_x, v_colleague)), 0, 'premise: and not on deal X');
    perform pg_temp.act_as(v_cco);
    perform pg_temp.expect(pg_temp.flag(app_is_deal_overseer(o_deal_x, v_cco)), 1, 'premise: the CCO oversees deal X');
    perform pg_temp.act_as(v_outsider);
    perform pg_temp.expect(pg_temp.flag(app_is_deal_overseer(o_deal_x, v_outsider)), 0, 'premise: another tenant''s CCO does not');
    reset role;

    -- ── Grants and shape ──────────────────────────────────────────────────────
    set local role anon;
    perform pg_temp.expect_attempt(format('select * from discovery_candidate_origins(array[%L]::uuid[])', o_m1), '42501',
      'anon cannot ask for candidate origins');
    perform pg_temp.expect_attempt(format('select discovery_deal_origin(%L)', o_deal_m), '42501', 'nor for a deal''s');
    reset role;
    perform pg_temp.expect_text(
      (select pg_get_function_result(p.oid) from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_candidate_origins'),
      'TABLE(candidate_id uuid, origin text)', 'the batch answers an id and the word, nothing else');
    perform pg_temp.expect_text(
      (select pg_get_function_result(p.oid) from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_deal_origin'),
      'text', 'the deal read answers one word');
    raise notice 'PASS: origin grants';

    -- ── Candidates the caller sees ────────────────────────────────────────────
    set local role authenticated;
    perform pg_temp.act_as(v_alice);
    perform pg_temp.expect_text(pg_temp.origins(array[o_m1, o_r1]),
      (select string_agg(x, ',' order by x collate "C") from unnest(array[o_m1::text || '=model_proposal', o_r1::text || '=rules']) x),
      'Alice: the model candidate is model_proposal, the rules one is rules');
    perform pg_temp.expect_text(pg_temp.origins(array[o_m1, o_m1, o_m1]), o_m1::text || '=model_proposal', 'a repeated id answers one row');
    perform pg_temp.expect_text(pg_temp.origins(array[o_s1]), o_s1::text || '=model_proposal',
      'Alice, who sees the merged-away model candidate: the survivor is model_proposal');
    perform pg_temp.expect_text(pg_temp.origins(array[o_u1]), o_u1::text || '=rules', 'a survivor of rules candidates only is rules');
    perform pg_temp.expect_text(pg_temp.origins(array[o_x1]), o_x1::text || '=rules', 'a cycle of rules candidates ends, and is rules');
    perform pg_temp.expect_text(pg_temp.origins(array[o_d[1]]), o_d[1]::text || '=model_proposal',
      'a model candidate ten merges down is found');
    perform pg_temp.expect_text(pg_temp.origins(array[o_t1]), o_t1::text || '=model_proposal', 'and two merges down');

    -- The second viewer sees only the survivor, and gets the same answer for it. The merged-away candidate is not theirs.
    perform pg_temp.act_as(v_colleague);
    perform pg_temp.expect_text(pg_temp.origins(array[o_s1]), o_s1::text || '=model_proposal',
      'the colleague, who cannot see the merged-away model candidate: the survivor is still model_proposal');
    perform pg_temp.expect_text(pg_temp.origins(array[o_t1]), o_t1::text || '=model_proposal', 'a chain they cannot see into: model_proposal');
    perform pg_temp.expect_text(pg_temp.origins(array[o_mm1, o_t3, o_t2, o_m1]), '',
      'and the merged-away candidates, and one they never saw, are omitted: nothing is named');
    perform pg_temp.expect_text(pg_temp.origins(array[o_s1, o_mm1]), o_s1::text || '=model_proposal',
      'a mixed ask answers only the one they may know');
    reset role;

    -- ── Candidates promoted to a deal the caller sits on or oversees ──────────
    set local role authenticated;
    perform pg_temp.act_as(v_colleague);
    perform pg_temp.expect_text(pg_temp.origins(array[o_pm]), o_pm::text || '=model_proposal',
      'a deal member who is not the finder: the promoted model candidate they cannot read is model_proposal');
    perform pg_temp.expect_text(pg_temp.origins(array[o_pr]), o_pr::text || '=rules', 'a promoted rules candidate is rules');
    perform pg_temp.expect_text(pg_temp.origins(array[o_ps]), o_ps::text || '=model_proposal',
      'a promoted survivor with a merged model candidate, which the member cannot read, is model_proposal');
    perform pg_temp.expect_text(pg_temp.origins(array[o_pms]), '', 'the merged-away candidate itself is omitted: it is promoted to no deal');
    perform pg_temp.expect_text(pg_temp.origins(array[o_px]), '', 'a promoted candidate of a deal they do not sit on is omitted');
    foreach o_who in array array[v_cco, v_admin] loop
      perform pg_temp.act_as(o_who);
      perform pg_temp.expect_text(pg_temp.origins(array[o_pm, o_px]),
        (select string_agg(x, ',' order by x collate "C") from unnest(array[o_pm::text || '=model_proposal', o_px::text || '=model_proposal']) x),
        'an overseer reads the model-origin deals'' candidates, a seat or not');
      perform pg_temp.expect_text(pg_temp.origins(array[o_pr]), o_pr::text || '=rules', 'and a rules one as rules');
    end loop;
    reset role;

    -- ── Callers who may not know ──────────────────────────────────────────────
    set local role authenticated;
    o_ids := array[o_pm, o_pr, o_ps, o_px, o_m1, o_s1, o_mm1, o_t1, o_d[1]];
    foreach o_who in array array[v_tess, v_outsider] loop
      perform pg_temp.act_as(o_who);
      perform pg_temp.expect_text(pg_temp.origins(o_ids), '', 'a member of no such deal, or an overseer of another tenant, is told nothing');
    end loop;
    perform pg_temp.act_as_nobody();
    perform pg_temp.expect_text(pg_temp.origins(o_ids), '', 'no user: no rows');
    -- Tess sits on another deal of the tenant (the fixture's pd deal), not on these: a seat elsewhere opens nothing.
    reset role;
    -- A seat, newly given, opens the deal's candidates; taking it away closes them again.
    insert into deal_memberships (deal_id, user_id, role_id, deal_role) values (o_deal_x, v_tess, o_role, 'deal_team');
    set local role authenticated;
    perform pg_temp.act_as(v_tess);
    perform pg_temp.expect_text(pg_temp.origins(array[o_px]), o_px::text || '=model_proposal', 'a new seat on the deal opens its candidate');
    reset role;
    delete from deal_memberships where deal_id = o_deal_x and user_id = v_tess;
    set local role authenticated;
    perform pg_temp.act_as(v_tess);
    perform pg_temp.expect_text(pg_temp.origins(array[o_px]), '', 'and losing the seat closes it');
    reset role;

    -- ── The cap, and nothing else in the answer ───────────────────────────────
    set local role authenticated;
    perform pg_temp.act_as(v_alice);
    perform pg_temp.expect((select count(*) from discovery_candidate_origins(
        array(select gen_random_uuid() from generate_series(1, 200)))), 0, '200 ids are accepted (none is a candidate)');
    o_msg := pg_temp.attempt_msg(format('select * from discovery_candidate_origins(array(select gen_random_uuid() from generate_series(1, 201)))'));
    perform pg_temp.expect_text(o_msg, '22023:too_many_candidates', '201 ids are refused with a fixed message');
    perform pg_temp.expect((select count(*) from discovery_candidate_origins(null)), 0, 'a null array answers nothing');
    perform pg_temp.expect((select count(*) from discovery_candidate_origins('{}')), 0, 'an empty array answers nothing');
    perform pg_temp.expect((select count(*) from discovery_candidate_origins(array[null, o_m1]::uuid[])), 1, 'a null id is skipped');
    perform pg_temp.expect((select count(*) from discovery_candidate_origins(array[o_m1, o_r1, o_s1, o_pm, o_px, o_d[1]])
        where origin not in ('model_proposal', 'rules')), 0, 'every answer is one of the two words');
    perform pg_temp.expect_text(
      (select string_agg(distinct o::text, ',') from discovery_candidate_origins(array[o_m1, o_s1, o_pm]) o
        where o::text like '%model:%' or o::text like '%codename:%'), null, 'no row carries a cluster key');
    reset role;
    raise notice 'PASS: candidate origins';

    -- ── One deal ──────────────────────────────────────────────────────────────
    set local role authenticated;
    perform pg_temp.act_as(v_colleague);
    perform pg_temp.expect_text(discovery_deal_origin(o_deal_m), 'model_proposal', 'a member who is not the finder: model deal');
    perform pg_temp.expect_text(discovery_deal_origin(o_deal_r), 'rules', 'a rules deal');
    perform pg_temp.expect_text(discovery_deal_origin(o_deal_s), 'model_proposal',
      'a deal promoted from a survivor with a merged model candidate the member cannot read');
    perform pg_temp.expect_text(discovery_deal_origin(o_deal_e), 'rules', 'a deal nothing was promoted to is rules');
    perform pg_temp.expect_text(discovery_deal_origin(o_deal_x), null, 'a deal they do not sit on is null');
    perform pg_temp.expect_text(discovery_deal_origin(gen_random_uuid()), null, 'a deal that does not exist is null');
    perform pg_temp.expect_text(discovery_deal_origin(null), null, 'a null deal is null');
    foreach o_who in array array[v_cco, v_admin] loop
      perform pg_temp.act_as(o_who);
      perform pg_temp.expect_text(discovery_deal_origin(o_deal_x), 'model_proposal', 'an overseer reads a deal they hold no seat on');
      perform pg_temp.expect_text(discovery_deal_origin(o_deal_r), 'rules', 'and a rules deal as rules');
      perform pg_temp.expect_text(discovery_deal_origin(o_deal_e), 'rules', 'and an empty one');
    end loop;
    foreach o_who in array array[v_alice, v_tess, v_outsider] loop
      perform pg_temp.act_as(o_who);
      perform pg_temp.expect_text(discovery_deal_origin(o_deal_m), null,
        'the finder with no seat, a member of another deal, and another tenant''s overseer: null');
    end loop;
    perform pg_temp.act_as_nobody();
    perform pg_temp.expect_text(discovery_deal_origin(o_deal_m), null, 'no user: null');
    -- The same predicate as the deals' select policy: a caller gets an answer exactly for the deals they read.
    foreach o_who in array array[v_alice, v_colleague, v_tess, v_cco, v_admin, v_outsider] loop
      perform pg_temp.act_as(o_who);
      foreach o_deal in array array[o_deal_m, o_deal_r, o_deal_s, o_deal_e, o_deal_x] loop
        perform pg_temp.expect(pg_temp.flag(discovery_deal_origin(o_deal) is not null),
          pg_temp.flag(exists (select 1 from deals d where d.id = o_deal)),
          'the origin is answered for a deal exactly when the deals policy shows it');
      end loop;
    end loop;
    reset role;
    raise notice 'PASS: deal origin';

    -- Authorization is the caller's own: Alice reads deal M's candidate through her evidence alone, and when that visibility
    -- goes (and she holds no seat) she is told nothing, while a member of the deal is still told the same word.
    set local role authenticated;
    perform pg_temp.act_as(v_alice);
    perform pg_temp.expect_text(pg_temp.origins(array[o_pm]), o_pm::text || '=model_proposal', 'premise: the finder reads it');
    reset role;
    perform pg_temp.act_as_service();
    delete from candidate_visibility where candidate_id = o_pm;
    set local role authenticated;
    perform pg_temp.act_as(v_alice);
    perform pg_temp.expect_text(pg_temp.origins(array[o_pm]), '', 'without the visibility row, and with no seat, the finder is told nothing');
    perform pg_temp.act_as(v_colleague);
    perform pg_temp.expect_text(pg_temp.origins(array[o_pm]), o_pm::text || '=model_proposal', 'a member of the deal still is told');
    reset role;
    raise notice 'PASS: origin reads';
  end;

  -- ══ TAIL: keep last. It redefines app_owns_mailbox_source and deletes Alice's source B. ══

  -- ── Owner-wide: one call writes a request on each personal mailbox its owner reads ──
  -- Today an owner reads one mailbox. Make Alice read B too: app_owns_mailbox_source as 20261014120000 defines it,
  -- plus B for Alice (rolled back with the rest).
  execute format($redef$
    create or replace function app_owns_mailbox_source(p_source uuid, p_tenant uuid, p_user uuid)
    returns boolean language sql security definer stable set search_path = public as $body$
      select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
         and (exists (
                select 1
                from content_sources c
                join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
                join allowed_mailboxes a on a.tenant_id = c.tenant_id
                                        and a.address = lower(c.address)
                                        and a.user_id = c.owner_user_id
                                        and a.provider = c.provider
                where c.id = p_source and c.tenant_id = p_tenant and c.kind = 'mailbox' and c.owner_user_id = p_user)
              or (p_source = %L and p_tenant = %L and p_user = %L));
    $body$
    $redef$, v_src_b, v_tenant, v_alice);
  perform pg_temp.act_as_service();
  perform pg_temp.expect(pg_temp.flag(app_owns_mailbox_source(v_src_b, v_tenant, v_alice)), 1,
    'premise: Alice now reads mailbox B as well');
  perform pg_temp.put(v_tenant, v_src_a, '<ac-egret-a>', 'm:project-egret', 'Project Egret', v_old);
  perform pg_temp.put(v_tenant, v_src_b, '<ac-egret-b>', 'm:project-egret', 'Project Egret', v_old);
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op, v_n from pg_temp.accept('m:project-egret', 'p2-s26');
  reset role;
  perform pg_temp.expect(v_n, 2, 'one call writes a request on each mailbox');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where operation_id = v_op
      and ((content_source_id = v_src_a and email_count = 1) or (content_source_id = v_src_b and email_count = 1))), 2,
    'under one operation, each holding its own mailbox''s message');
  select detail into v_detail from audit_log where tenant_id = v_tenant
    and action = 'discovery.model_proposal_accept_requested' and detail ->> 'operationId' = v_op::text;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_accept_requested' and detail ->> 'operationId' = v_op::text), 1,
    'one audit row for the operation');
  perform pg_temp.expect((v_detail ->> 'sourceCount')::bigint, 2, 'naming two sources');
  perform pg_temp.expect((v_detail ->> 'messageCount')::bigint, 2, 'and two messages');
  perform pg_temp.expect((jsonb_array_length(v_detail -> 'requestIds'))::bigint, 2, 'and two request ids');
  -- A key live on A and not on B: a repeat finds A's request and writes B's alone.
  perform pg_temp.expect(pg_temp.live_requests(v_src_a, 'm:project-heron'), 1, 'premise: heron is live on A');
  perform pg_temp.expect(pg_temp.live_requests(v_src_b, 'm:project-heron'), 0, 'and not on B');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op2, v_n from pg_temp.accept('m:project-heron', 'p3-s39');
  reset role;
  perform pg_temp.expect(v_n, 1, 'a repeat writes the source that has none');
  perform pg_temp.expect(pg_temp.flag(v_op2 is distinct from (select operation_id from discovery_model_proposal_accepts
      where content_source_id = v_src_a and deal_key = 'm:project-heron')), 1, 'under a new operation');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where operation_id = v_op2
      and content_source_id = v_src_b and proposed_phase = 'phase-3' and placed_count = 0 and email_count = 1), 1,
    'on B: the group''s highest phase, none of B''s messages placed in it');
  perform pg_temp.expect(pg_temp.live_requests(v_src_a, 'm:project-heron'), 1, 'and A''s request is the one it was');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  select operation_id, request_count into v_op, v_n from pg_temp.accept('m:project-heron', 'p3-s39');
  reset role;
  perform pg_temp.expect(v_n, 0, 'now both sources hold one: a repeat writes none');
  perform pg_temp.expect(pg_temp.flag(v_op in (select operation_id from discovery_model_proposal_accepts
      where deal_key = 'm:project-heron' and state = 'pending')), 1, 'and answers with one of the live operations');
  raise notice 'PASS: owner-wide';

  -- ── Purge: deleting a source cascades its requests, and only its own ──────
  select count(*) into v_audit from audit_log where tenant_id = v_tenant
    and action = 'discovery.model_proposal_accept_requested';
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id = v_src_b), 2,
    'Alice''s other source holds two requests before the purge (egret, heron)');
  delete from content_sources where id = v_src_b;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id = v_src_b), 0,
    'deleting the source deletes its requests');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id = v_src_a), 7,
    'her mailbox A keeps its seven (heron, kite, shared, plover, open, merged, egret)');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where content_source_id = v_src_coll), 1,
    'and the colleague''s mailbox its one');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_accept_requested'), v_audit, 'the audit rows stay (ids only)');
  raise notice 'PASS: purge';

  -- ── Withdrawn: the mailbox leaves the allowlist between the list and the click ──
  perform pg_temp.put(v_tenant, v_src_tess, '<ac-tern-1>', 'm:project-tern', 'Project Tern', v_old);
  update users set firm_role = 'admin' where id = v_tess;
  set local role authenticated;
  perform pg_temp.act_as(v_tess);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-tern'), 1,
    'premise: Tess lists tern from her own mailbox');
  perform mailbox_consent_withdraw();
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-tern', 'p2-s26'),
    'P0002:not_visible', 'after withdrawing the mailbox, accepting what the list showed is refused');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where deal_key = 'm:project-tern'), 0,
    'and writes nothing');
  update users set firm_role = null where id = v_tess;
  raise notice 'PASS: withdrawn';

  -- ── Removed: the user loses their seat between the list and the click ──────
  update users set firm_role = 'admin' where id = v_colleague;
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-osprey'), 1,
    'premise: the colleague lists osprey from their own mailbox');
  reset role;
  update users set status = 'suspended' where id = v_colleague;
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.accept_msg('m:project-osprey', 'p2-s26'),
    'P0002:not_visible', 'a user removed after the list showed is refused');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_accepts where deal_key = 'm:project-osprey'), 0,
    'and nothing is written');
  update users set firm_role = null where id = v_colleague;
  raise notice 'PASS: removed';

  raise notice 'PASS: model proposal accepts: grants, shape, who, guard, validation, request, audit, idempotent, owner scope, covered, closed, limit, reads, worker grants, claim, token, live keys, write-ahead, lease, fourth claim, expiry, expiry in flight, expiry tenants, finish, finish states, purge on success and from storing, shared item, ledger reset, rules-routed messages kept, second accept, shared evidence, collector, origin reads, owner-wide, purge, withdrawn, removed';
end $$;

rollback;
