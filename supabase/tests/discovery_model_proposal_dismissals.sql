-- Demo only (#460), G-02a (#173): the source owner dismisses a model proposal, archive-not-delete
-- (20261023120100_model_proposal_dismissals.sql). Who may dismiss, what one call writes, the covered rule, the
-- operator restore and the purge, read as each user under the authenticated role.
--
--   Alice      owns mailbox A (allowlisted), where the proposals were read; also owns B, off the allowlist
--   Colleague  has a mailbox of their own, with proposals of their own
--   CCO        the control room of the tenant (proposals are owner-only: sees none)
--   Admin      a firm admin, who connects the team inbox
--   Outsider   the control room of another tenant
--   Tess       a reader of the team inbox deals@dm.example, which holds a team row (put in as service, so
--              this suite does not depend on G-01's writer)
--
-- Sections: grants, parity, shape, who, audit, idempotent, `c:` key, covered, owner scope, restore, known deals,
-- owner-wide, guard, purge, withdrawn, removed.
--
-- Known deals (slice 3, 20261023120200_known_deals_skip_dismissed.sql): discovery_proposal_known_deals stops
-- offering a source an `m:` key while every live row of it on that source is covered by a dismissal on that
-- source. Per source, not owner-wide: a personal dismissal never changes a team source's list.
--
-- Parity (TH1-1): for every persona, the proposal rows the select policy shows them equal the rows for which
-- app_can_read_model_proposal(..., persona) is true, called as service. A migration that widens the policy
-- (G-01 slice 4) fails here until it widens the helper too. Parity does not enable dismissal: the RPC also
-- asks for the owner of a personal source (design R6), so a reader of a team row still gets P0002.
--
-- Covered is the link (audit D1): a live dismissal on the row's source, of its current key, listing its id. The
-- clock plays no part, so the covered section stamps rows on both sides of the dismissal's now(): a row the
-- dismissal never read shows though stamped before it (its writer began first and committed after the read), and
-- a row it read is covered though stamped after it. The two-session versions of those races, and two tabs racing
-- one dismiss, are in tests/integration/discovery-model-proposal-dismiss-race.test.ts.
--
-- Owner-wide: one call covers every readable row of the key on every personal source its owner reads. Today an
-- owner reads exactly one personal source (mailbox_seated_invites keeps one address per person, and
-- content_sources is unique per address). The owner-wide section makes Alice read her mailbox B too, by
-- redefining app_owns_mailbox_source inside this rolled-back transaction; it comes after every section that relies
-- on the real function, and rolls back with the rest.
--
-- G-01 (#727-#731), which this stack sits on, widens the select policy: a reader of a team inbox reads its rows of a
-- run that holds a pass (app_reads_proposal_source), and the read helper is widened with it. The fixture opens a
-- pass for the team rows' run, so the team reader and the firm's CCO read them through the real policy and helper,
-- and the owner-only guard in the dismiss RPC alone refuses them (audit D4).
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_model_proposal_dismissals.sql
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
    values (v_tenant, 'pd-' || v_tenant::text, 'Dismissal fixture', v_company) returning id into v_deal;
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values (v_deal, p_user, (select id from roles where slug = 'deal_team'), 'deal_team')
  on conflict (deal_id, user_id) do nothing;
end;
$$;

-- One live 'deal' proposal row, put in by the table owner with its own created_at (see "Covered is the link" above).
create function pg_temp.put(p_tenant uuid, p_source uuid, p_message text, p_key text, p_name text, p_at timestamptz,
                            p_candidate uuid default null, p_archived timestamptz default null)
returns uuid language sql as $$
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, sent_at, outcome,
                                         deal_key, deal_name, candidate_id, phase, p_deal, p_phase,
                                         model, prompt_version, prompt_hash, run_id, created_at, updated_at, archived_at)
  values (p_tenant, p_source, encode(sha256(convert_to(p_message, 'UTF8')), 'hex'),
          encode(sha256(convert_to('text of ' || p_message, 'UTF8')), 'hex'), '2026-03-02T10:00:00Z', 'deal',
          p_key, p_name, p_candidate, 'phase-2', 0.9, 0.6,
          'anthropic/claude-haiku-5.5', 'v2', 'hash-v2', '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d', p_at, p_at, p_archived)
  returning id;
$$;

-- The reader's covered rule, run under the caller's session (RLS on both tables): the visible rows of the key that
-- no live dismissal on their source, of their key, lists.
create function pg_temp.open_rows(p_key text)
returns bigint language sql as $$
  select count(*)
  from discovery_model_proposals p
  where p.deal_key = p_key
    and not exists (select 1 from discovery_model_proposal_dismissals d
                    where d.content_source_id = p.content_source_id and d.deal_key = p.deal_key
                      and d.restored_at is null and p.id = any (d.proposal_ids));
$$;

-- The dismiss RPC's count of dismissal rows written ({dismissed, operationId}).
create function pg_temp.dismissed(p_key text)
returns integer language sql as $$
  select (discovery_dismiss_model_proposal(p_key) ->> 'dismissed')::integer;
$$;

-- The id of one proposal row, by its message.
create function pg_temp.row_id(p_source uuid, p_message text)
returns uuid language sql as $$
  select id from discovery_model_proposals
  where content_source_id = p_source and message_key = encode(sha256(convert_to(p_message, 'UTF8')), 'hex');
$$;

-- The propose step's deal list for one source (service_role only): whether it offers a ref, and the whole list.
create function pg_temp.has_ref(p_tenant uuid, p_source uuid, p_ref text)
returns bigint language sql as $$
  select count(*) from discovery_proposal_known_deals(p_tenant, p_source) where ref = p_ref;
$$;

create function pg_temp.known_list(p_tenant uuid, p_source uuid)
returns text language sql as $$
  select coalesce(string_agg(k.ref || '=' || k.name, ',' order by k.ref collate "C"), '')
  from discovery_proposal_known_deals(p_tenant, p_source) k;
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
  v_kestrel    uuid := gen_random_uuid();
  v_hidden     uuid := gen_random_uuid();
  v_teal       uuid := gen_random_uuid();
  v_k_item     uuid := gen_random_uuid();
  v_t_item     uuid := gen_random_uuid();
  v_old        timestamptz := now() - interval '3 hours';
  v_out        jsonb;
  v_tm         uuid;
  v_src_a      uuid;
  v_src_b      uuid;
  v_src_coll   uuid;
  v_src_team   uuid;
  v_props      bigint;
  v_n          integer;
  v_i          integer;
  v_key        text;
  v_who        uuid;
  v_seen       uuid[];
  v_read       uuid[];
  v_counts     bigint[] := '{}';
  v_d          uuid;
  v_op         uuid;
  v_op2        uuid;
  v_detail     jsonb;
  v_d_shared_a uuid;
  v_d_shared_c uuid;
  v_audit      bigint;
  v_ret        jsonb;
  v_row        uuid;
  v_row2       uuid;
  v_src_tess   uuid;
  v_team_list  text;
  v_d_curlew   uuid;
begin
  -- ── Fixture, as the table owner (the seating of discovery_model_proposals.sql) ──
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_alice,     'pd-alice@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_colleague, 'pd-colleague@example.test', jsonb_build_object('tenant_id', v_tenant, 'department', 'ib')),
    (v_cco,       'pd-cco@example.test',       jsonb_build_object('tenant_id', v_tenant, 'department', 'compliance')),
    (v_admin,     'pd-admin@example.test',     jsonb_build_object('tenant_id', v_tenant, 'department', 'admin')),
    (v_outsider,  'pd-outsider@example.test',  jsonb_build_object('tenant_id', v_other, 'department', 'compliance')),
    (v_tess,      'pd-tess@example.test',      jsonb_build_object('tenant_id', v_tenant, 'department', 'ib'));
  update users set status = 'active', is_external = false
   where id in (v_alice, v_colleague, v_cco, v_admin, v_outsider, v_tess);
  update users set firm_role = 'cco' where id in (v_cco, v_outsider);
  update users set firm_role = 'admin' where id = v_admin;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values
    (v_tenant, 'fixture', 'fixture', 'active'),
    (v_other, 'fixture', 'fixture', 'active');
  insert into companies (id, tenant_id, name, type) values (v_bank, v_tenant, 'PD Bank', 'bank');
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
  if v_tm is null or v_src_team is null or v_src_a is null or v_src_coll is null then
    raise exception 'FAIL: the fixture did not create its sources';
  end if;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-pd');
  -- Alice's second source B: hers, but off the allowlist (an owner has one allowlisted address).
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
    values (v_tenant, 'mailbox', 'alice.alt@bank.example', v_alice, 'microsoft') returning id into v_src_b;
  -- Tess reads the team inbox, as a member.
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_add_team_mailbox_member(v_tm, v_tess);
  reset role;
  perform pg_temp.act_as_service();

  -- Kestrel is backed by firm-routed mail in Alice's mailbox A, so Alice can see it; Hidden has no evidence, so
  -- nobody can; Teal is backed by the team inbox only, so its reader Tess can.
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name, codename_guess) values
    (v_kestrel, v_tenant, 'codename:kestrel', 'Project Kestrel', 'Project Kestrel'),
    (v_hidden,  v_tenant, 'codename:hidden',  'Project Hidden',  'Project Hidden'),
    (v_teal,    v_tenant, 'codename:teal',    'Project Teal',    'Project Teal');
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_k_item, v_tenant, 'message', 'kestrel', '2026-03-01', '<pd-kestrel-1@harbourline.example>', 'pd-hk'),
    (v_t_item, v_tenant, 'message', 'teal',    '2026-03-01', '<pd-teal-1@harbourline.example>',    'pd-ht');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_k_item, v_src_a, 'pd-a-k1'),
    (v_t_item, v_src_team, 'pd-t-t1');
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence) values
    (v_kestrel, v_k_item, 'codename', 'firm', 0.9),
    (v_teal,    v_t_item, 'codename', 'firm', 0.9);
  perform discovery_refresh_candidate_visibility(c) from unnest(array[v_kestrel, v_hidden, v_teal]) c;

  perform pg_temp.expect(pg_temp.flag(app_owns_mailbox_source(v_src_a, v_tenant, v_alice)), 1,
    'premise: Alice owns mailbox A on the allowlist');
  perform pg_temp.expect(pg_temp.flag(app_owns_mailbox_source(v_src_b, v_tenant, v_alice)), 0,
    'premise: Alice''s mailbox B is off the allowlist, so she does not read it');
  perform pg_temp.expect(pg_temp.flag(app_can_see_candidate(v_kestrel, v_alice)), 1, 'premise: Alice sees Kestrel');
  perform pg_temp.expect(pg_temp.flag(app_can_see_candidate(v_hidden, v_alice)), 0, 'premise: nobody sees Hidden');
  perform pg_temp.expect(pg_temp.flag(app_can_see_candidate(v_teal, v_tess)), 1,
    'premise: the team inbox''s reader sees its candidate');

  -- The proposal rows, all created three hours ago.
  --   A:         heron x2, kestrel (c:), hidden (c:, a candidate she cannot see), an archived kestrel row,
  --              a not-deal row, shared, wren
  --   B:         heron (a mailbox she does not read)
  --   colleague: osprey, shared
  --   team:      tealx (m:), teal (c:), put in as service
  perform pg_temp.put(v_tenant, v_src_a, '<pd-heron-1>', 'm:project-heron', 'Project Heron', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<pd-heron-2>', 'm:project-heron', 'Project Heron', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<pd-kestrel-1>', 'c:' || v_kestrel, 'Project Kestrel', v_old, v_kestrel);
  perform pg_temp.put(v_tenant, v_src_a, '<pd-hidden-1>', 'c:' || v_hidden, 'Project Hidden', v_old, v_hidden);
  perform pg_temp.put(v_tenant, v_src_a, '<pd-kestrel-old>', 'c:' || v_kestrel, 'Project Kestrel', v_old, v_kestrel, v_old);
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, outcome, p_deal,
                                         model, prompt_version, prompt_hash, run_id, created_at, updated_at)
    values (v_tenant, v_src_a, encode(sha256(convert_to('<pd-lunch>', 'UTF8')), 'hex'),
            encode(sha256(convert_to('text of <pd-lunch>', 'UTF8')), 'hex'), 'not_deal', 0.1,
            'anthropic/claude-haiku-5.5', 'v2', 'hash-v2', gen_random_uuid(), v_old, v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<pd-shared-a>', 'm:project-shared', 'Project Shared', v_old);
  perform pg_temp.put(v_tenant, v_src_a, '<pd-wren-1>', 'm:project-wren', 'Project Wren', v_old);
  perform pg_temp.put(v_tenant, v_src_b, '<pd-heron-b>', 'm:project-heron', 'Project Heron', v_old);
  perform pg_temp.put(v_tenant, v_src_coll, '<pd-osprey-1>', 'm:project-osprey', 'Project Osprey', v_old);
  perform pg_temp.put(v_tenant, v_src_coll, '<pd-shared-c>', 'm:project-shared', 'Project Shared', v_old);
  perform pg_temp.put(v_tenant, v_src_team, '<pd-tealx-1>', 'm:project-tealx', 'Project Tealx', v_old);
  perform pg_temp.put(v_tenant, v_src_team, '<pd-teal-1>', 'c:' || v_teal, 'Project Teal', v_old, v_teal);
  -- A live pass of the team inbox for the rows' run, as the table owner (G-01's begin definer needs a reviewed
  -- approval row): what makes the team rows readable to the inbox's readers under G-01's policy.
  insert into discovery_team_proposal_passes (tenant_id, content_source_id, team_mailbox_id, firm_company_id, run_id,
                                              path, lease_until)
    values (v_tenant, v_src_team, v_tm, v_bank, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d', 'recorded', now() + interval '30 minutes');
  select count(*) into v_props from discovery_model_proposals where tenant_id = v_tenant;
  perform pg_temp.expect(v_props, 13, 'fixture: thirteen proposal rows');
  raise notice 'PASS: fixture';

  -- ── Grants: nobody signed in writes a dismissal, restores one or asks the helper ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals), 0, 'no dismissal yet');
  perform pg_temp.expect_attempt(format(
      'insert into discovery_model_proposal_dismissals (tenant_id, content_source_id, deal_key, dismissed_by, operation_id) values (%L, %L, %L, %L, %L)',
      v_tenant, v_src_a, 'm:project-heron', v_alice, gen_random_uuid()), '42501',
    'the owner cannot write a dismissal straight into the table');
  perform pg_temp.expect_attempt('update discovery_model_proposal_dismissals set restored_at = now()', '42501',
    'nor update one');
  perform pg_temp.expect_attempt('delete from discovery_model_proposal_dismissals', '42501', 'nor delete one');
  perform pg_temp.expect_attempt(format('select app_can_read_model_proposal(%L, %L, %L, %L, null, %L)',
      v_src_a, v_tenant, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d', 'm:project-heron', v_alice), '42501',
    'a signed-in user cannot call the read helper');
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, array[%L]::uuid[], %L, %L)',
      v_tenant, gen_random_uuid(), v_alice, 'self-serve'), '42501',
    'nor the operator restore');
  reset role;
  set local role anon;
  perform pg_temp.expect_attempt('select 1 from discovery_model_proposal_dismissals limit 1', '42501', 'anon cannot read dismissals');
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-heron'), '42501',
    'anon cannot dismiss');
  reset role;
  raise notice 'PASS: grants';

  -- ── Parity (TH1-1): what RLS shows each persona is what the helper admits ──
  foreach v_who in array array[v_alice, v_colleague, v_cco, v_admin, v_outsider, v_tess] loop
    set local role authenticated;
    perform pg_temp.act_as(v_who);
    v_seen := array(select p.id from discovery_model_proposals p order by p.id);
    reset role;
    perform pg_temp.act_as_service();
    v_read := array(select p.id from discovery_model_proposals p
                    where p.tenant_id in (v_tenant, v_other) and p.outcome = 'deal' and p.archived_at is null
                      and app_can_read_model_proposal(p.content_source_id, p.tenant_id, p.run_id, p.deal_key,
                                                      p.candidate_id, v_who)
                    order by p.id);
    if v_seen is distinct from v_read then
      raise exception 'FAIL: parity: persona % sees % rows under RLS, the helper admits %',
        v_who, cardinality(v_seen), cardinality(v_read);
    end if;
    v_counts := v_counts || cardinality(v_seen)::bigint;
  end loop;
  -- Not vacuous, under this base's owner-only policy and under G-01's widened one alike (audit D3): Alice's five
  -- live readable rows (heron x2, kestrel, shared, wren; not hidden, the archived row, the not-deal row or B's) and
  -- the colleague's two are personal rows either policy shows them, and the outsider, of another tenant, reads
  -- none. The CCO, the admin and the team reader are left to the comparison above: G-01 may show them team rows.
  perform pg_temp.expect(v_counts[1], 5, 'parity is not vacuous: Alice reads her five rows');
  perform pg_temp.expect(v_counts[2], 2, 'and the colleague their two');
  perform pg_temp.expect(v_counts[5], 0, 'and the outsider none');
  raise notice 'PASS: parity';

  -- ── Shape: a bad key is refused with a fixed message that never echoes it (R12) ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_i := 0;
  foreach v_key in array array['m:Project Heron', 'm:', 'x:project-heron', 'c:not-a-uuid', 'm:' || repeat('a', 65),
                               'm:project-heron;', ''] loop
    v_i := v_i + 1;
    perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_dismiss_model_proposal(%L)', v_key)),
      '22023:invalid_deal_key', format('bad key %s is refused with the fixed message', v_i));
  end loop;
  perform pg_temp.expect_text(pg_temp.attempt_msg('select discovery_dismiss_model_proposal(null::text)'),
    '22023:invalid_deal_key', 'a null key is refused the same way');
  perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_dismiss_model_proposal(%L)', 'm:project-nowhere')),
    'P0002:not_visible', 'a well-formed key with no row is not visible, and the message does not name it');
  reset role;
  raise notice 'PASS: shape';

  -- ── Who: the owner of the personal source dismisses; nobody else does ──────
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_dismiss_model_proposal(%L)', 'm:project-heron')),
    'P0002:not_visible', 'a colleague cannot dismiss Alice''s proposal');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-heron'), 'P0002',
    'the CCO cannot dismiss it');
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'c:' || v_kestrel), 'P0002',
    'nor a `c:` proposal of a candidate the control room may see');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-heron'), 'P0002',
    'the firm admin cannot dismiss it');
  perform pg_temp.act_as(v_outsider);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-heron'), 'P0002',
    'another tenant cannot dismiss it');
  -- R6: the team inbox's reader reads the team rows (G-01's policy, the fixture's pass), yet gets P0002 on them:
  -- the owner-only guard. The guard section below pins that the helper admits her, so the guard alone refuses.
  perform pg_temp.act_as(v_tess);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-tealx'), 'P0002',
    'the team reader cannot dismiss a team row');
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'c:' || v_teal), 'P0002',
    'nor a team row naming a candidate the reader sees');
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-heron'), 'P0002',
    'nor Alice''s');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'c:' || v_hidden), 'P0002',
    'the owner cannot dismiss a row of her mailbox naming a candidate she cannot see (the helper)');
  perform pg_temp.act_as_nobody();
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-heron'), '42501',
    'a session with no user is refused');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where tenant_id = v_tenant), 0,
    'the refusals wrote no dismissal');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissed'), 0, 'and no audit row');

  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_ret := discovery_dismiss_model_proposal('m:project-heron');
  reset role;
  perform pg_temp.expect((v_ret ->> 'dismissed')::bigint, 1, 'the owner dismisses: one dismissal row, for her one readable source');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where tenant_id = v_tenant), 1,
    'one dismissal row is written');
  select id, operation_id into v_d, v_op from discovery_model_proposal_dismissals where tenant_id = v_tenant;
  perform pg_temp.expect_text(v_ret ->> 'operationId', v_op::text, 'the call returns its operation id, the restore reference');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where id = v_d
      and content_source_id = v_src_a and deal_key = 'm:project-heron' and dismissed_by = v_alice
      and dismissed_at = now() and operation_id is not null
      and restored_at is null and restored_by_identity is null and restore_requested_by is null), 1,
    'on mailbox A, by Alice, now, live');
  perform pg_temp.expect_text((select proposal_ids::text from discovery_model_proposal_dismissals where id = v_d),
    (select array_agg(id order by id)::text from discovery_model_proposals
      where content_source_id = v_src_a and deal_key = 'm:project-heron'),
    'it lists exactly the two heron rows of mailbox A it read (the link)');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_b), 0,
    'and none on mailbox B, which she does not read');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant), v_props,
    'the proposals are kept');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where tenant_id = v_tenant
      and deal_key = 'm:project-heron' and archived_at is null and updated_at = created_at), 3,
    'and untouched: a dismissal is its own row, never a change to a proposal');
  raise notice 'PASS: who';

  -- ── Audit: one row, ids and counts only ────────────────────────────────────
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissed'), 1, 'one audit row');
  select detail into v_detail from audit_log where tenant_id = v_tenant and action = 'discovery.model_proposal_dismissed';
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissed' and actor_id = v_alice and actor_type = 'user'
      and deal_id is null and chain_seq is not null), 1, 'by the user, on the chain');
  perform pg_temp.expect_text((select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(v_detail) k),
    'dismissalIds,keyKind,operationId,rowCount,sourceCount', 'an `m:` dismissal''s detail keys are exactly the id and count set');
  perform pg_temp.expect_text(v_detail ->> 'operationId', v_op::text, 'it names the operation');
  perform pg_temp.expect_text((v_detail -> 'dismissalIds')::text, jsonb_build_array(v_d)::text, 'and the dismissal ids');
  perform pg_temp.expect_text(v_detail ->> 'keyKind', 'm', 'the key kind, not the key');
  perform pg_temp.expect((v_detail ->> 'sourceCount')::bigint, 1, 'one source');
  perform pg_temp.expect((v_detail ->> 'rowCount')::bigint, 2, 'the two live rows it covered');
  perform pg_temp.expect(pg_temp.flag(v_detail::text ~* '(heron|project|shared|wren)'), 0,
    'no key, slug or deal name in the audit detail');
  raise notice 'PASS: audit';

  -- ── Idempotent: a repeat or a second tab writes nothing ───────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_ret := discovery_dismiss_model_proposal('m:project-heron');
  perform pg_temp.expect_text(v_ret::text, '{"dismissed": 0, "operationId": null}',
    'a repeat returns 0 and no operation');
  -- The reader's rule, under her session: every heron row she reads is covered, and she reads her dismissal.
  perform pg_temp.expect(pg_temp.open_rows('m:project-heron'), 0, 'the reader hides every heron row she reads');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals), 1, 'the owner reads her dismissal');
  foreach v_who in array array[v_colleague, v_cco, v_admin, v_outsider, v_tess] loop
    perform pg_temp.act_as(v_who);
    perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals), 0,
      'nobody else reads it (colleague, CCO, admin, outsider, team reader)');
  end loop;
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where tenant_id = v_tenant), 1,
    'still one dismissal set');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissed'), 1, 'still one audit row');
  raise notice 'PASS: idempotent';

  -- ── A `c:` key: dismissed like any other, and the candidate is never touched ──
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_n := pg_temp.dismissed('c:' || v_kestrel);
  reset role;
  perform pg_temp.expect(v_n, 1, 'the owner dismisses a `c:` proposal');
  select detail into v_detail from audit_log where tenant_id = v_tenant and action = 'discovery.model_proposal_dismissed'
    and detail ->> 'keyKind' = 'c';
  perform pg_temp.expect_text((select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(v_detail) k),
    'candidateId,dismissalIds,keyKind,operationId,rowCount,sourceCount', 'a `c:` dismissal''s detail adds the candidate id');
  perform pg_temp.expect_text(v_detail ->> 'candidateId', v_kestrel::text, 'it names the candidate by id');
  perform pg_temp.expect((v_detail ->> 'rowCount')::bigint, 1, 'and covers the live row only, not the archived one');
  perform pg_temp.expect(pg_temp.flag(strpos(v_detail::text, 'c:' || v_kestrel::text) > 0 or v_detail::text ~* 'kestrel'), 0,
    'no key or name in it');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_kestrel and discovery_state = 'proposed'
      and promoted_deal_id is null and proposed_name = 'Project Kestrel'), 1, 'the candidate is untouched');
  perform pg_temp.expect((select count(*) from corrections where candidate_id = v_kestrel), 0, 'and has no correction');
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'c:' || v_kestrel
      and archived_at is null), 1, 'its live proposal row stays live');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissed'), 2, 'two dismissals, two audit rows');
  raise notice 'PASS: c: key';

  -- ── Covered: the link, not the clock (audit D1) ───────────────────────────
  -- heron-3 is stamped an hour BEFORE the dismissal: its writer began first and committed after the dismissal read.
  -- The dismissal never listed it, so it shows.
  v_row := pg_temp.put(v_tenant, v_src_a, '<pd-heron-3>', 'm:project-heron', 'Project Heron', now() - interval '1 hour');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposals where deal_key = 'm:project-heron'), 3,
    'Alice reads three heron rows');
  perform pg_temp.expect(pg_temp.open_rows('m:project-heron'), 1,
    'a row the dismissal never read shows, though stamped before it');
  v_n := pg_temp.dismissed('m:project-heron');
  perform pg_temp.expect(v_n, 1, 'a re-dismiss writes a new dismissal');
  perform pg_temp.expect(pg_temp.open_rows('m:project-heron'), 0, 'and covers it');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_a
      and deal_key = 'm:project-heron' and restored_at is null), 2,
    'two live dismissals of one key on one source (the index is not unique)');
  select operation_id into v_op2 from discovery_model_proposal_dismissals
   where content_source_id = v_src_a and deal_key = 'm:project-heron' and id <> v_d;
  perform pg_temp.expect(pg_temp.flag(v_op2 is distinct from v_op), 1, 'each with its own operation');
  perform pg_temp.expect_text((select proposal_ids::text from discovery_model_proposal_dismissals where operation_id = v_op2),
    array[v_row]::text, 'listing only the row it newly covered');
  perform pg_temp.expect((select (detail ->> 'rowCount')::bigint from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissed' and detail ->> 'operationId' = v_op2::text), 1,
    'the re-dismiss covered the one new row');
  -- heron-4 is stamped AFTER the dismissal's now(): its writer began after the dismisser's transaction and committed
  -- before the dismissal read. The dismissal lists it, so it is covered, and a retry writes nothing.
  v_row2 := pg_temp.put(v_tenant, v_src_a, '<pd-heron-4>', 'm:project-heron', 'Project Heron', now() + interval '1 second');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_n := pg_temp.dismissed('m:project-heron');
  perform pg_temp.expect(v_n, 1, 'the dismissal reads the later-stamped row');
  perform pg_temp.expect(pg_temp.open_rows('m:project-heron'), 0, 'and covers it, though stamped after it');
  v_n := pg_temp.dismissed('m:project-heron');
  perform pg_temp.expect(v_n, 0, 'so a retry writes nothing');
  reset role;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissed'), 4, 'four dismissals, four audit rows: the retry wrote none');
  -- The writer upserts in place on a re-run of one prompt version. A row that keeps its key stays covered; a row
  -- whose key changes no longer matches its dismissal, and shows under its new key.
  update discovery_model_proposals set phase = 'phase-3', updated_at = now() where id = v_row;
  update discovery_model_proposals set deal_key = 'm:project-heronx', deal_name = 'Project Heronx', updated_at = now()
   where id = v_row2;
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect(pg_temp.open_rows('m:project-heron'), 0, 'a covered row updated in place under its key stays covered');
  perform pg_temp.expect(pg_temp.open_rows('m:project-heronx'), 1, 'a covered row whose key changed shows under the new key');
  reset role;
  update discovery_model_proposals set deal_key = 'm:project-heron', deal_name = 'Project Heron' where id = v_row2;
  raise notice 'PASS: covered';

  -- ── Owner scope: the owner's readable sources, never a colleague's, never a mailbox she does not read ──
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_b), 0,
    'her heron row on B, a mailbox she does not read, was never dismissed by her');
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  v_n := pg_temp.dismissed('m:project-shared');
  perform pg_temp.expect(v_n, 1, 'the colleague dismisses their own row of a key Alice also holds');
  perform pg_temp.expect(pg_temp.open_rows('m:project-shared'), 0, 'their row is covered');
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect(pg_temp.open_rows('m:project-shared'), 1,
    'Alice''s row of that key still shows: a dismissal covers its owner''s rows, not the tenant''s');
  v_n := pg_temp.dismissed('m:project-shared');
  perform pg_temp.expect(v_n, 1, 'so Alice''s own dismissal writes a row');
  reset role;
  -- A dismissal of wren on B (put in by the table owner, as if made while B was her mailbox), forged to list her
  -- wren row on A: a link counts only on the row's own source.
  insert into discovery_model_proposal_dismissals (tenant_id, content_source_id, deal_key, dismissed_by, dismissed_at,
                                                   operation_id, proposal_ids)
    values (v_tenant, v_src_b, 'm:project-wren', v_alice, now(), gen_random_uuid(),
            array[pg_temp.row_id(v_src_a, '<pd-wren-1>')]);
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_b), 0,
    'she does not read a dismissal on a mailbox she does not read');
  perform pg_temp.expect(pg_temp.open_rows('m:project-wren'), 1, 'so it covers none of her rows for the reader');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposals p
      where p.content_source_id = v_src_a and p.deal_key = 'm:project-wren'
        and exists (select 1 from discovery_model_proposal_dismissals d
                    where d.content_source_id = p.content_source_id and d.deal_key = p.deal_key
                      and d.restored_at is null and p.id = any (d.proposal_ids))), 0,
    'nor as the table owner: listed on another source, the row is not covered');
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_n := pg_temp.dismissed('m:project-wren');
  perform pg_temp.expect(v_n, 1, 'nor for the RPC: dismissing wren writes a row on A');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals), 6,
    'Alice reads her six dismissals (heron x3, kestrel, shared, wren)');
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals), 1, 'the colleague reads their one');
  reset role;
  raise notice 'PASS: owner scope';

  -- ── Restore: the operator's, at the owner's request; marks, never deletes ──
  select id into v_d_shared_a from discovery_model_proposal_dismissals where content_source_id = v_src_a and deal_key = 'm:project-shared';
  select id into v_d_shared_c from discovery_model_proposal_dismissals where content_source_id = v_src_coll and deal_key = 'm:project-shared';
  perform pg_temp.expect_attempt(format('update discovery_model_proposal_dismissals set restored_at = now() where id = %L', v_d_shared_a),
    '23514', 'a half-restored row is refused (restored_at, identity and requester go together)');
  perform pg_temp.expect_attempt(format(
      'insert into discovery_model_proposal_dismissals (tenant_id, content_source_id, deal_key, dismissed_by, operation_id, proposal_ids) values (%L, %L, %L, %L, %L, %L)',
      v_tenant, v_src_a, 'm:Project Heron', v_alice, gen_random_uuid(), array[gen_random_uuid()]), '23514',
    'a dismissal row holds a key of the proposals'' shape only');
  perform pg_temp.expect_attempt(format(
      'insert into discovery_model_proposal_dismissals (tenant_id, content_source_id, deal_key, dismissed_by, operation_id, proposal_ids) values (%L, %L, %L, %L, %L, %L)',
      v_tenant, v_src_a, 'm:project-heron', v_alice, gen_random_uuid(), '{}'), '23514',
    'and lists at least one proposal row');
  set local role service_role;
  perform pg_temp.act_as_service();
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, array[%L]::uuid[], %L, %L)',
      v_tenant, v_d_shared_a, v_colleague, 'ops-g02-runbook'), '22023', 'a requester who is not the source''s owner is refused');
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, array[%L, %L]::uuid[], %L, %L)',
      v_tenant, v_d_shared_a, v_d_shared_c, v_alice, 'ops-g02-runbook'), '22023',
    'a list holding one dismissal that is not the requester''s is refused whole');
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, array[%L]::uuid[], %L, %L)',
      v_tenant, gen_random_uuid(), v_alice, 'ops-g02-runbook'), '22023', 'an unknown dismissal is refused');
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, array[%L]::uuid[], %L, %L)',
      v_other, v_d_shared_a, v_alice, 'ops-g02-runbook'), '22023', 'another tenant''s id is refused');
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, array[%L]::uuid[], %L, %L)',
      v_tenant, v_d_shared_a, v_alice, '   '), '22023', 'a blank operator identity is refused');
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, %L::uuid[], %L, %L)',
      v_tenant, '{}', v_alice, 'ops-g02-runbook'), '22023', 'an empty list is refused');
  perform pg_temp.expect_attempt(format('select discovery_restore_model_proposal_dismissals(%L, array[%L]::uuid[], null, %L)',
      v_tenant, v_d_shared_a, 'ops-g02-runbook'), '22023', 'a missing requester is refused');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where tenant_id = v_tenant
      and restored_at is not null), 0, 'the refusals restored nothing');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissal_restored'), 0, 'and audited nothing');

  set local role service_role;
  perform pg_temp.act_as_service();
  v_n := discovery_restore_model_proposal_dismissals(v_tenant, array[v_d_shared_a], v_alice, 'ops-g02-runbook');
  perform pg_temp.expect(v_n, 1, 'the operator restores Alice''s dismissal at her request');
  v_n := discovery_restore_model_proposal_dismissals(v_tenant, array[v_d_shared_a], v_alice, 'ops-g02-runbook');
  perform pg_temp.expect(v_n, 0, 'a repeat restores nothing');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where id = v_d_shared_a
      and restored_at = now() and restored_by_identity = 'ops-g02-runbook' and restore_requested_by = v_alice), 1,
    'the row is marked: when, the operator''s identity, and who asked');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where tenant_id = v_tenant), 8,
    'nothing is deleted (A: heron x3, kestrel, shared, wren; B: wren; the colleague: shared)');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where id = v_d_shared_c
      and restored_at is null), 1, 'the colleague''s dismissal of the same key stays live');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissal_restored'), 1, 'one restore audit row, the repeat wrote none');
  select detail into v_detail from audit_log where tenant_id = v_tenant and action = 'discovery.model_proposal_dismissal_restored';
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action = 'discovery.model_proposal_dismissal_restored' and actor_type = 'service' and actor_id is null
      and service_identity = 'ops-g02-runbook' and chain_seq is not null), 1, 'audited as the service, under the operator''s identity');
  perform pg_temp.expect_text((select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(v_detail) k),
    'dismissalIds,operationIds,requestedBy', 'its detail keys are exactly the ids and the requester');
  perform pg_temp.expect_text(v_detail ->> 'requestedBy', v_alice::text, 'it records who asked');
  perform pg_temp.expect_text((v_detail -> 'dismissalIds')::text, jsonb_build_array(v_d_shared_a)::text, 'and which dismissal');
  perform pg_temp.expect_text((v_detail -> 'operationIds')::text,
    (select jsonb_build_array(operation_id)::text from discovery_model_proposal_dismissals where id = v_d_shared_a),
    'and its operation');
  -- A restored dismissal covers nothing: the row shows again and can be dismissed again.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect(pg_temp.open_rows('m:project-shared'), 1, 'after the restore her shared row shows again');
  v_n := pg_temp.dismissed('m:project-shared');
  perform pg_temp.expect(v_n, 1, 'and she can dismiss it again');
  reset role;
  raise notice 'PASS: restore';

  -- ── Known deals: an `m:` name is not offered while every live row of it on the source is covered (slice 3) ──
  -- Curlew is named in Alice's mailbox A and in the team inbox, both three hours ago.
  perform pg_temp.put(v_tenant, v_src_a, '<pd-curlew-1>', 'm:project-curlew', 'Project Curlew', v_old);
  perform pg_temp.put(v_tenant, v_src_team, '<pd-curlew-t>', 'm:project-curlew', 'Project Curlew', v_old);
  perform pg_temp.act_as_service();
  perform pg_temp.expect(pg_temp.has_ref(v_tenant, v_src_a, 'm:project-curlew'), 1, 'premise: mailbox A is offered Curlew');
  perform pg_temp.expect(pg_temp.has_ref(v_tenant, v_src_team, 'm:project-curlew'), 1, 'premise: so is the team inbox');
  v_team_list := pg_temp.known_list(v_tenant, v_src_team);
  perform pg_temp.expect_text(v_team_list,
    'c:' || v_teal || '=Project Teal,m:project-curlew=Project Curlew,m:project-tealx=Project Tealx',
    'premise: the team inbox is offered its candidate and its two model-named deals');

  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_n := pg_temp.dismissed('m:project-curlew');
  reset role;
  perform pg_temp.expect(v_n, 1, 'Alice dismisses Curlew');
  perform pg_temp.act_as_service();
  perform pg_temp.expect(pg_temp.has_ref(v_tenant, v_src_a, 'm:project-curlew'), 0,
    'an `m:` key whose every live row on A is covered is not offered to A');
  perform pg_temp.expect_text(pg_temp.known_list(v_tenant, v_src_team), v_team_list,
    'the team source''s list is identical before and after a personal dismissal of the same key');
  -- Every other `m:` key of A is covered by now (heron, shared, wren), and Kestrel's `c:` proposal was dismissed
  -- in the `c:` section: a `c:` key stays offered, since dismissing a proposal never touches its candidate.
  perform pg_temp.expect_text(pg_temp.known_list(v_tenant, v_src_a), 'c:' || v_kestrel || '=Project Kestrel',
    'mailbox A is offered its candidate only: no covered `m:` key, the dismissed `c:` key kept');

  -- A row the dismissal never listed brings the key back, whatever its created_at: this one is stamped before
  -- every other (its writer began first and committed after the dismissal read).
  v_row := pg_temp.put(v_tenant, v_src_a, '<pd-curlew-2>', 'm:project-curlew', 'Project Curlew', v_old - interval '1 hour');
  perform pg_temp.act_as_service();
  perform pg_temp.expect(pg_temp.has_ref(v_tenant, v_src_a, 'm:project-curlew'), 1,
    'offered again while one live row of the key on A is not covered, though stamped before the dismissal');

  -- A re-dismiss hides it again; restoring that dismissal brings it back (it uncovers only the row it listed).
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  v_n := pg_temp.dismissed('m:project-curlew');
  reset role;
  perform pg_temp.expect(v_n, 1, 'Alice dismisses the unseen row');
  perform pg_temp.act_as_service();
  perform pg_temp.expect(pg_temp.has_ref(v_tenant, v_src_a, 'm:project-curlew'), 0, 'and it is not offered');
  select id into v_d_curlew from discovery_model_proposal_dismissals
   where content_source_id = v_src_a and deal_key = 'm:project-curlew' and proposal_ids = array[v_row];
  set local role service_role;
  perform pg_temp.act_as_service();
  v_n := discovery_restore_model_proposal_dismissals(v_tenant, array[v_d_curlew], v_alice, 'ops-g02-runbook');
  reset role;
  perform pg_temp.expect(v_n, 1, 'the operator restores that Curlew dismissal');
  perform pg_temp.act_as_service();
  perform pg_temp.expect(pg_temp.has_ref(v_tenant, v_src_a, 'm:project-curlew'), 1,
    'a restored dismissal no longer covers the row it listed, and the other live one covers only its own');
  perform pg_temp.expect_text(pg_temp.known_list(v_tenant, v_src_team), v_team_list, 'the team source''s list never moved');
  raise notice 'PASS: known deals';

  -- ── Owner-wide: one call covers the key on every personal mailbox its owner reads (audit D5) ──
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
  v_row := pg_temp.put(v_tenant, v_src_a, '<pd-plover-a>', 'm:project-plover', 'Project Plover', v_old);
  v_row2 := pg_temp.put(v_tenant, v_src_b, '<pd-plover-b>', 'm:project-plover', 'Project Plover', v_old);
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform pg_temp.expect(pg_temp.open_rows('m:project-plover'), 2, 'Alice reads plover on both mailboxes');
  v_ret := discovery_dismiss_model_proposal('m:project-plover');
  perform pg_temp.expect((v_ret ->> 'dismissed')::bigint, 2, 'one call writes a dismissal on each mailbox');
  perform pg_temp.expect(pg_temp.open_rows('m:project-plover'), 0, 'and covers both rows');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals
      where operation_id = (v_ret ->> 'operationId')::uuid
        and ((content_source_id = v_src_a and proposal_ids = array[v_row])
             or (content_source_id = v_src_b and proposal_ids = array[v_row2]))), 2,
    'under one operation, each listing its own mailbox''s row');
  select detail into v_detail from audit_log where tenant_id = v_tenant and action = 'discovery.model_proposal_dismissed'
    and detail ->> 'operationId' = v_ret ->> 'operationId';
  perform pg_temp.expect((v_detail ->> 'sourceCount')::bigint, 2, 'one audit row, naming two sources');
  perform pg_temp.expect((v_detail ->> 'rowCount')::bigint, 2, 'and two rows');
  raise notice 'PASS: owner-wide';

  -- ── Guard (audit D4): a team reader the read helper admits is still refused ──
  -- G-01's policy and the read helper admit the inbox's reader on the team rows (the fixture's pass). Only the
  -- owner-only guard in the dismiss RPC stands between her and a dismissal.
  perform pg_temp.act_as_service();
  perform pg_temp.expect(pg_temp.flag(app_can_read_model_proposal(v_src_team, v_tenant, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d',
      'm:project-tealx', null, v_tess)), 1, 'premise: the helper admits the team reader on the team row');
  perform pg_temp.expect(pg_temp.flag(app_can_read_model_proposal(v_src_team, v_tenant, '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d',
      'c:' || v_teal, v_teal, v_tess)), 1,
    'and on the team row naming a candidate she sees');
  set local role authenticated;
  perform pg_temp.act_as(v_tess);
  perform pg_temp.expect_text(pg_temp.attempt_msg(format('select discovery_dismiss_model_proposal(%L)', 'm:project-tealx')),
    'P0002:not_visible', 'the owner-only guard alone refuses the team reader');
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'c:' || v_teal), 'P0002',
    'on the `c:` team row too');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_team), 0,
    'no dismissal on the team inbox');
  raise notice 'PASS: guard';

  -- ── Purge: deleting a source cascades its dismissals, and only its own ─────
  select count(*) into v_audit from audit_log where tenant_id = v_tenant
    and action in ('discovery.model_proposal_dismissed', 'discovery.model_proposal_dismissal_restored');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_a), 10,
    'mailbox A holds ten dismissals before the purge (heron x3, kestrel, shared x2, wren, curlew x2, plover)');
  delete from content_sources where id = v_src_a;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_a), 0,
    'deleting the source deletes its dismissals');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_coll), 1,
    'a colleague''s dismissal survives');
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where content_source_id = v_src_b), 2,
    'and so do the two on the owner''s other source');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_tenant
      and action in ('discovery.model_proposal_dismissed', 'discovery.model_proposal_dismissal_restored')), v_audit,
    'the audit rows stay (ids only)');
  raise notice 'PASS: purge';

  -- ── Withdrawn: the mailbox leaves the allowlist between the list and the click (audit D5) ──
  set local role authenticated;
  perform pg_temp.act_as(v_colleague);
  perform pg_temp.expect(pg_temp.open_rows('m:project-osprey'), 1, 'premise: the colleague lists osprey');
  perform mailbox_consent_withdraw();
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-osprey'), 'P0002',
    'after withdrawing the mailbox, dismissing what the list showed is refused');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where deal_key = 'm:project-osprey'), 0,
    'and writes nothing');
  raise notice 'PASS: withdrawn';

  -- ── Removed: the user loses their seat between the list and the click (audit D5) ──
  select id into v_src_tess from content_sources where tenant_id = v_tenant and address = 'tess@bank.example' and owner_user_id = v_tess;
  perform pg_temp.put(v_tenant, v_src_tess, '<pd-tern-1>', 'm:project-tern', 'Project Tern', v_old);
  set local role authenticated;
  perform pg_temp.act_as(v_tess);
  perform pg_temp.expect(pg_temp.open_rows('m:project-tern'), 1, 'premise: Tess lists tern from her own mailbox');
  reset role;
  update users set status = 'suspended' where id = v_tess;
  set local role authenticated;
  perform pg_temp.act_as(v_tess);
  perform pg_temp.expect_attempt(format('select discovery_dismiss_model_proposal(%L)', 'm:project-tern'), 'P0002',
    'a user removed after the list showed is refused');
  reset role;
  perform pg_temp.expect((select count(*) from discovery_model_proposal_dismissals where deal_key = 'm:project-tern'), 0,
    'and nothing is written');
  raise notice 'PASS: removed';

  raise notice 'PASS: model proposal dismissals: grants, parity, shape, who, audit, idempotent, c: key, covered, owner scope, restore, known deals, owner-wide, guard, purge, withdrawn, removed';
end $$;

rollback;
