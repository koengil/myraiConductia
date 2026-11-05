-- #173 G-03, slice 1/4: the firm's read of its team inbox audit rows,
-- 20261023100300_team_mailbox_audit_read.sql (discovery_team_mailbox_audit), over the index of
-- 20261023100200_audit_log_tenant_action_idx.sql.
--
-- Its own fixture, two bank companies in one tenant (design R15): company A holds the tenant's Google reader
-- registration and connects a team inbox through the RPC; company B is named by the Graph registration, so
-- firm_company_ids() returns both, and its team inbox is inserted directly (connect would refuse a non-Google firm),
-- so the firm_company_id predicate is exercised rather than passed trivially. A second tenant holds its own inbox.
--
--   1. grants: a definer pinned to public, pg_temp, executable by authenticated and by neither anon nor PUBLIC
--   2. the gate: no session, an unknown user, an MD, an external admin and an admin of a bank with no team inbox are
--      refused 42501; so is a firm company that holds no team inbox (A before it connects, B before its row exists);
--      A's admin and CCO read; no reader registration has to name the company (B reads its inbox while none does)
--   3. isolation: A and B each see only their own inboxes, rows, passes and candidate rows in all three views, and B
--      never names A's registration or source; another tenant sees only its own; a personal refusal and a personal
--      access change are not team rows; Google group events go to the registration's company only, to nobody when
--      that column is null, and follow it when it is re-pointed
--   4. the views: every access change appears, the group-unreadable row is a firm event with no list and no '@', all
--      reads returns every pass record, the notable view drops an empty complete pass and takes an unfinished start
--      at 3601 s but not at 3599 s, the keyset walks every row once, the limit is clamped, a bad view or half a cursor
--      is 22023
--   5. the projection: no '@' anywhere in the rows, a non-code reason and a free-text service identity come back
--      absent and null, the pass's registration, worker, jobId, runId and passId never leave, names come from users
--   6. the plan: on a tenant with 600 pass rows, the access branch reads through audit_log_tenant_action_ts, and the
--      limit clamps to 200
--   7. history that outlives its source: a closed inbox whose source discovery_purge_identifiers deleted keeps its
--      reads in the trail, under that inbox (shown as "Removed inbox"), and B never sees them; a drift row naming one
--      of A's inboxes missing and another extra says both
--   8. attribution (G-03 4/4, 20261023100400_candidate_proposed_team_attribution.sql): a candidate the real
--      discovery_upsert_candidates creates from team mail records teamMailboxIds, sorted and distinct; a personal-only
--      one records no key; one spanning A's inbox and a person's mailbox records A's id alone; B2 then shows each row
--      to the firms its inboxes belong to and never the other; team mail joining an existing candidate writes nothing;
--      a candidate whose only team evidence is in a closed inbox still names it and still reaches that firm's trail
--   9. AI passes and capability switches (G-01, 20261023110400_team_mailbox_audit_proposals.sql): each firm sees its
--      own passes under the inbox and its own company's switches as firm events (all three capabilities; never Bank X's
--      or the other tenant's); path, outcome, the five counts (up to 1,000,000,000), capability and on only; never the
--      decision reference, the run or pass id or lastRenewedAt; malformed values dropped
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/team_mailbox_audit.sql
-- Everything rolls back.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed script does
-- (authorize_provisioned_profile over its metadata) and give it a live session whose id is the user id.
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

create function pg_temp.expect_true(actual boolean, label text)
returns void language plpgsql as $$
begin
  if actual is not true then
    raise exception 'FAIL: %', label;
  end if;
end;
$$;

create function pg_temp.act_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.act_as_none()
returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;

-- Calls the read as p_user and returns what it returned.
create function pg_temp.audit_as(p_user uuid, p_view text default 'access', p_limit integer default 200,
                                 p_before_ts timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return discovery_team_mailbox_audit(p_view, p_before_ts, p_before_id, p_limit);
end;
$$;

-- Calls it and returns the error as sqlstate:message, or 'ok'.
create function pg_temp.try_audit(p_user uuid, p_view text default 'access', p_limit integer default 50,
                                  p_before_ts timestamptz default null, p_before_id uuid default null)
returns text language plpgsql as $$
begin
  if p_user is null then
    perform pg_temp.act_as_none();
  else
    perform pg_temp.act_as(p_user);
  end if;
  perform discovery_team_mailbox_audit(p_view, p_before_ts, p_before_id, p_limit);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- The number of rows of a page, of one action or all.
create function pg_temp.n(p_page jsonb, p_action text default null)
returns bigint language sql as $$
  select count(*) from jsonb_array_elements(p_page -> 'rows') r where p_action is null or r ->> 'action' = p_action;
$$;

-- The first row of a page with this action and, if given, this detail value.
create function pg_temp.row_of(p_page jsonb, p_action text, p_key text default null, p_value text default null)
returns jsonb language sql as $$
  select r from jsonb_array_elements(p_page -> 'rows') with ordinality as e (r, i)
  where r ->> 'action' = p_action and (p_key is null or r -> 'detail' ->> p_key = p_value)
  order by i limit 1;
$$;

-- Whether the page's text holds a string anywhere (an id, a marker).
create function pg_temp.names(p_page jsonb, p_text text)
returns boolean language sql as $$
  select position(p_text in p_page::text) > 0;
$$;

-- The row ids of a page, in order.
create function pg_temp.ids(p_page jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(r ->> 'id' order by i), '{}')
  from jsonb_array_elements(p_page -> 'rows') with ordinality as e (r, i);
$$;

-- An audit row written past the writers, at a chosen server time, by a user or a service.
create function pg_temp.plant(p_tenant uuid, p_action text, p_detail jsonb, p_ts timestamptz,
                              p_actor uuid default null, p_service text default 'discovery-worker')
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  if p_actor is not null then
    insert into audit_log (tenant_id, actor_id, actor_type, action, detail, ts)
    values (p_tenant, p_actor, 'user', p_action, p_detail, p_ts) returning id into v_id;
  else
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail, ts)
    values (p_tenant, 'service', p_service, p_action, p_detail, p_ts) returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- Reader pass details in the writer's shape (supabase/tests/discovery_health.sql).
create function pg_temp.rp_iso(p timestamptz)
returns text language sql immutable as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
create function pg_temp.rp_start(p_pass uuid, p_source uuid, p_at timestamptz)
returns jsonb language sql as $$
  select jsonb_build_object('v', 1, 'passId', p_pass, 'runId', gen_random_uuid(), 'jobId', gen_random_uuid(),
    'sourceId', p_source, 'startedAt', pg_temp.rp_iso(p_at),
    'worker', jsonb_build_object('deployment', 'local', 'revision', null));
$$;
create function pg_temp.rp_end(p_start jsonb, p_ended timestamptz, p_status text, p_reason text,
                               p_fetched int, p_excluded int, p_stored int)
returns jsonb language sql as $$
  select p_start || jsonb_build_object('provider', 'google',
    'registration', jsonb_build_object('clientId', 'CANARYCLIENT', 'certThumbprint', null),
    'endedAt', pg_temp.rp_iso(p_ended), 'status', p_status, 'reason', p_reason,
    'pages', 1, 'fetched', p_fetched, 'excluded', p_excluded, 'stored', p_stored, 'checkpointAdvanced', true);
$$;

grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- The ids the plan section (6) needs after the top-level analyze, and the history (7) and attribution (8) sections.
create temp table audit_fx (k text primary key, v uuid not null);

-- ── 1. Grants ───────────────────────────────────────────────────────────────
do $$
declare
  v_fn  regprocedure := 'public.discovery_team_mailbox_audit(text,timestamptz,uuid,integer)'::regprocedure;
  v_res text;
begin
  perform pg_temp.expect_true(has_function_privilege('authenticated', v_fn, 'EXECUTE'),
    'authenticated executes the audit read');
  perform pg_temp.expect_true(not has_function_privilege('anon', v_fn, 'EXECUTE'), 'anon does not execute it');
  perform pg_temp.expect_true(not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                           where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    'PUBLIC does not execute it');
  perform pg_temp.expect_true((select p.prosecdef and p.provolatile = 's'
                                      and coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
                               from pg_proc p where p.oid = v_fn),
    'it is a stable definer pinned to public, pg_temp');

  -- The privilege refuses anon before the body runs.
  set local role anon;
  begin
    perform discovery_team_mailbox_audit();
  exception when others then
    v_res := sqlstate || ':' || sqlerrm;
  end;
  reset role;
  perform pg_temp.expect_text(v_res, '42501:permission denied for function discovery_team_mailbox_audit',
    'anon is refused by the privilege, not by the body');
  raise notice 'PASS: the audit read is a pinned definer for authenticated alone';
end
$$;

-- ── 2 to 5. Gate, isolation, views, projection ──────────────────────────────
do $$
declare
  v_t        uuid := gen_random_uuid();
  v_o        uuid := gen_random_uuid();
  v_ca       uuid := gen_random_uuid();   -- company A: holds the Google registration
  v_cb       uuid := gen_random_uuid();   -- company B: named by the Graph registration
  v_cx       uuid := gen_random_uuid();   -- a bank of T that no registration names
  v_co       uuid := gen_random_uuid();   -- the other tenant's bank
  v_a_admin  uuid := gen_random_uuid();
  v_a_cco    uuid := gen_random_uuid();
  v_a_md     uuid := gen_random_uuid();
  v_a_ext    uuid := gen_random_uuid();
  v_a_member uuid := gen_random_uuid();
  v_a_odd    uuid := gen_random_uuid();   -- a display name that is an address
  v_b_admin  uuid := gen_random_uuid();
  v_b_cco    uuid := gen_random_uuid();
  v_x_admin  uuid := gen_random_uuid();
  v_o_admin  uuid := gen_random_uuid();
  v_today    date := (now() at time zone 'utc')::date;
  v_out      jsonb;
  v_tm_a     uuid;
  v_src_a    uuid;
  v_tm_old   uuid;
  v_src_old  uuid;
  v_tm_b     uuid;
  v_src_b    uuid;
  v_tm_o     uuid;
  v_src_o    uuid;
  v_s        jsonb;
  v_p4       uuid;
  v_p5       uuid;
  v_a        jsonb;
  v_b        jsonb;
  v_x        jsonb;
  v_row      jsonb;
  v_view     text;
  v_walk     text[];
  v_cts      timestamptz;
  v_cid      uuid;
  v_i        integer;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_a_admin,  'ta-a-admin@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_a_cco,    'ta-a-cco@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_a_md,     'ta-a-md@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_a_ext,    'ta-a-ext@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_a_member, 'ta-a-member@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_a_odd,    'ta-a-odd@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_b_admin,  'ta-b-admin@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_b_cco,    'ta-b-cco@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_x_admin,  'ta-x-admin@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_o_admin,  'ta-o-admin@example.test',  jsonb_build_object('tenant_id', v_o, 'department', 'admin'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_o);
  insert into companies (id, tenant_id, name, type) values
    (v_ca, v_t, 'Audit Bank A', 'bank'), (v_cb, v_t, 'Audit Bank B', 'bank'),
    (v_cx, v_t, 'Audit Bank X', 'bank'), (v_co, v_o, 'Audit Other Bank', 'bank');
  -- Each bank's director first: company_has_director refuses a bank of members only.
  update users set company_id = v_ca, company_role = 'director' where id = v_a_admin;
  update users set company_id = v_ca, company_role = 'member' where id in (v_a_cco, v_a_md, v_a_ext, v_a_member, v_a_odd);
  update users set company_id = v_cb, company_role = 'director' where id = v_b_admin;
  update users set company_id = v_cb, company_role = 'member' where id = v_b_cco;
  update users set company_id = v_cx, company_role = 'director' where id = v_x_admin;
  update users set company_id = v_co, company_role = 'director' where id = v_o_admin;
  update users set firm_role = 'admin' where id in (v_a_admin, v_a_ext, v_b_admin, v_x_admin, v_o_admin);
  update users set firm_role = 'cco' where id in (v_a_cco, v_b_cco);
  update users set is_external = true where id = v_a_ext;
  update users set display_name = 'Avery Stone' where id = v_a_admin;
  update users set display_name = 'Jordan Reyes' where id = v_a_member;
  update users set display_name = 'odd@audit-a.example' where id = v_a_odd;

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'audit-a.example', 'dwd-reader@proj-31.iam.gserviceaccount.com', '313456789012345678',
     'dir-reader@proj-31.iam.gserviceaccount.com', 'conductia-ingest@audit-a.example', v_ca, 'active', now()),
    (v_o, 'audit-o.example', 'dwd-reader@proj-32.iam.gserviceaccount.com', '323456789012345678',
     'dir-reader@proj-32.iam.gserviceaccount.com', 'conductia-ingest@audit-o.example', v_co, 'active', now());
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{audit-b.example}', v_cb);
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;

  -- ── 2. The gate ────────────────────────────────────────────────────────────
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_audit(null), '42501:not_available', 'no session is refused');
  perform pg_temp.expect_text(pg_temp.try_audit(gen_random_uuid()), '42501:not_available', 'an unknown user is refused');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_md), '42501:not_available', 'an MD with no firm role is refused');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_member), '42501:not_available', 'a banker is refused');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_ext), '42501:not_available', 'an external admin is refused');
  perform pg_temp.expect_text(pg_temp.try_audit(v_x_admin), '42501:not_available',
    'an admin of a bank with no team inbox is refused');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_admin), '42501:not_available',
    'a firm with no team inbox has no trail (404, not an empty 200)');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_md, 'nonsense'), '42501:not_available',
    'the gate answers before the arguments are judged');
  reset role;

  -- A connects a team inbox through the RPC (its connect row and notification are the RPC's), and a second one it
  -- then removes, so A also holds a closed registration.
  set local role authenticated;
  perform pg_temp.act_as(v_a_admin);
  v_out := discovery_connect_team_mailbox('deals@audit-a.example', 1, v_today - 30);
  v_tm_a := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_a := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  v_out := discovery_connect_team_mailbox('old@audit-a.example', 1);
  v_tm_old := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_old := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  perform discovery_remove_team_mailbox(v_tm_old);
  reset role;
  perform pg_temp.act_as_none();

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_admin), 'ok', 'A''s admin reads once A holds a team inbox');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_cco), 'ok', 'A''s CCO reads too');
  perform pg_temp.expect_text(pg_temp.try_audit(v_b_admin), '42501:not_available',
    'B''s admin is refused while B holds no team inbox, though A does');
  perform pg_temp.expect_text(pg_temp.try_audit(v_b_cco), '42501:not_available', 'and so is B''s CCO');
  reset role;

  -- B's inbox, written directly: connect resolves the provider for the caller's firm and would refuse B.
  insert into team_mailboxes (tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
  values (v_t, v_cb, 'google', 'deals@audit-b.example', v_b_admin, 1) returning id into v_tm_b;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status, team_mailbox_id)
  values (v_t, 'mailbox', 'deals@audit-b.example', null, 'google', 'active', v_tm_b) returning id into v_src_b;
  -- The other tenant's inbox.
  insert into team_mailboxes (tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
  values (v_o, v_co, 'google', 'deals@audit-o.example', v_o_admin, 1) returning id into v_tm_o;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status, team_mailbox_id)
  values (v_o, 'mailbox', 'deals@audit-o.example', null, 'google', 'active', v_tm_o) returning id into v_src_o;

  -- A's rows. The two address checks are the worker's own writer's; the rest are planted in their writers' shapes.
  perform discovery_record_team_mailbox_check(v_tm_a, 'refused', 'directory_denied', null);
  perform discovery_record_team_mailbox_check(v_tm_a, 'verified', null, 'dir-audit-a-1');
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_member_added',
    jsonb_build_object('teamMailboxId', v_tm_a, 'userId', v_a_member), now() - interval '9 minutes', v_a_admin);
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_member_removed',
    jsonb_build_object('teamMailboxId', v_tm_a, 'userId', v_a_member, 'reason', 'seat_lost'),
    now() - interval '8 minutes', null, 'team-mailbox');
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_member_added',
    jsonb_build_object('teamMailboxId', v_tm_a, 'userId', v_a_odd), now() - interval '7 minutes', v_a_admin);
  perform pg_temp.plant(v_t, 'discovery.mailbox_access_changed',
    jsonb_build_object('change', 'paused', 'provider', 'google', 'sourceId', v_src_a, 'teamMailboxId', v_tm_a),
    now() - interval '6 minutes', v_a_admin);
  perform pg_temp.plant(v_t, 'discovery.mailbox_access_changed',
    jsonb_build_object('change', 'resumed', 'provider', 'google', 'sourceId', v_src_a, 'teamMailboxId', v_tm_a),
    now() - interval '5 minutes', v_a_admin);
  perform pg_temp.plant(v_t, 'discovery.mailbox_access_changed',
    jsonb_build_object('change', 'restarted', 'provider', 'google', 'sourceId', v_src_a, 'teamMailboxId', v_tm_a),
    now() - interval '4 minutes', v_a_admin);
  perform pg_temp.plant(v_t, 'discovery.mailbox_access_changed',
    jsonb_build_object('change', 'window_set', 'provider', 'google', 'sourceId', v_src_a,
                       'from', v_today - 30, 'to', v_today - 90, 'teamMailboxId', v_tm_a),
    now() - interval '3 minutes', v_a_admin);
  perform pg_temp.plant(v_t, 'discovery.mailbox_refused',
    jsonb_build_object('reason', 'team_mailbox_unverified', 'purpose', 'provider_read', 'teamMailboxId', v_tm_a),
    now() - interval '2 minutes');
  -- A reason that is not a code, from a caller that names itself in free text.
  perform pg_temp.plant(v_t, 'discovery.mailbox_refused',
    jsonb_build_object('reason', 'x y', 'purpose', 'provider_read', 'teamMailboxId', v_tm_a),
    now() - interval '1 minute', null, 'Free text caller!');
  -- Personal rows of the same tenant: they name an address, never a registration, and are not team rows.
  perform pg_temp.plant(v_t, 'discovery.mailbox_refused',
    jsonb_build_object('reason', 'not_allowlisted', 'purpose', 'provider_read', 'address', 'person@audit-a.example'),
    now() - interval '10 minutes');
  perform pg_temp.plant(v_t, 'discovery.mailbox_access_changed',
    jsonb_build_object('change', 'paused', 'provider', 'google', 'sourceId', gen_random_uuid(),
                       'address', 'person@audit-a.example'),
    now() - interval '10 minutes', v_a_admin);
  -- Candidates as G-03 4/4 records them: A's alone, B's alone, both, and one with no team evidence.
  perform pg_temp.plant(v_t, 'discovery.candidate_proposed',
    jsonb_build_object('candidateId', gen_random_uuid(), 'runId', gen_random_uuid(), 'evidenceCount', 3,
                       'teamMailboxIds', jsonb_build_array(v_tm_a)), now() - interval '11 minutes');
  perform pg_temp.plant(v_t, 'discovery.candidate_proposed',
    jsonb_build_object('candidateId', gen_random_uuid(), 'runId', gen_random_uuid(), 'evidenceCount', 2,
                       'teamMailboxIds', jsonb_build_array(v_tm_b)), now() - interval '12 minutes');
  perform pg_temp.plant(v_t, 'discovery.candidate_proposed',
    jsonb_build_object('candidateId', gen_random_uuid(), 'runId', gen_random_uuid(), 'evidenceCount', 4,
                       'teamMailboxIds', jsonb_build_array(v_tm_a, v_tm_b)), now() - interval '13 minutes');
  perform pg_temp.plant(v_t, 'discovery.candidate_proposed',
    jsonb_build_object('candidateId', gen_random_uuid(), 'runId', gen_random_uuid(), 'evidenceCount', 1),
    now() - interval '14 minutes');
  -- Group drift: Google rows (A's inbox missing, B's extra, a person's address; unreadable; back in sync) and a
  -- Microsoft row, which is not a team inbox event.
  perform pg_temp.plant(v_t, 'discovery.allowlist_drift',
    jsonb_build_object('provider', 'google', 'status', 'drift',
                       'missingInGroup', jsonb_build_array('team:' || v_tm_a, 'person@audit-a.example'),
                       'extraInGroup', jsonb_build_array('team:' || v_tm_b)), now() - interval '15 minutes');
  perform pg_temp.plant(v_t, 'discovery.allowlist_drift',
    jsonb_build_object('provider', 'google', 'status', 'unavailable', 'missingInGroup', '[]'::jsonb,
                       'extraInGroup', '[]'::jsonb), now() - interval '16 minutes');
  perform pg_temp.plant(v_t, 'discovery.allowlist_drift',
    jsonb_build_object('provider', 'google', 'status', 'in_sync', 'missingInGroup', '[]'::jsonb,
                       'extraInGroup', '[]'::jsonb), now() - interval '17 minutes');
  perform pg_temp.plant(v_t, 'discovery.allowlist_drift',
    jsonb_build_object('provider', 'microsoft', 'status', 'drift', 'missingInGroup', '[]'::jsonb,
                       'extraInGroup', jsonb_build_array('someone@audit-b.example')), now() - interval '18 minutes');
  -- A's passes: an empty complete one, one that stored and excluded mail, a failed one, and two starts with no end,
  -- one just past the hour and one just inside it.
  v_s := pg_temp.rp_start(gen_random_uuid(), v_src_a, now() - interval '50 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_started', v_s, now() - interval '50 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_s, now() - interval '49 minutes', 'complete', null, 0, 0, 0), now() - interval '49 minutes');
  v_s := pg_temp.rp_start(gen_random_uuid(), v_src_a, now() - interval '40 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_started', v_s, now() - interval '40 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_s, now() - interval '39 minutes', 'complete', null, 12, 3, 9), now() - interval '39 minutes');
  v_s := pg_temp.rp_start(gen_random_uuid(), v_src_a, now() - interval '30 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_started', v_s, now() - interval '30 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_s, now() - interval '29 minutes', 'failed', 'provider_error', 0, 0, 0), now() - interval '29 minutes');
  v_s := pg_temp.rp_start(gen_random_uuid(), v_src_a, now() - interval '3601 seconds');
  v_p4 := pg_temp.plant(v_t, 'discovery.reader_pass_started', v_s, now() - interval '3601 seconds');
  v_s := pg_temp.rp_start(gen_random_uuid(), v_src_a, now() - interval '3599 seconds');
  v_p5 := pg_temp.plant(v_t, 'discovery.reader_pass_started', v_s, now() - interval '3599 seconds');
  -- B's rows.
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_connected',
    jsonb_build_object('teamMailboxId', v_tm_b, 'sourceId', v_src_b, 'attestationVersion', 1),
    now() - interval '20 minutes', v_b_admin);
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_checked',
    jsonb_build_object('teamMailboxId', v_tm_b, 'status', 'verified'), now() - interval '19 minutes');
  v_s := pg_temp.rp_start(gen_random_uuid(), v_src_b, now() - interval '20 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_started', v_s, now() - interval '20 minutes');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_s, now() - interval '19 minutes', 'complete', null, 2, 0, 2), now() - interval '19 minutes');
  -- The other tenant: its own row, and two rows forged to name A's registration and A's source.
  perform pg_temp.plant(v_o, 'discovery.team_mailbox_checked',
    jsonb_build_object('teamMailboxId', v_tm_o, 'status', 'verified'), now() - interval '5 minutes');
  perform pg_temp.plant(v_o, 'discovery.mailbox_refused',
    jsonb_build_object('reason', 'team_mailbox_unverified', 'purpose', 'provider_read', 'teamMailboxId', v_tm_a),
    now() - interval '5 minutes');
  perform pg_temp.plant(v_o, 'discovery.reader_pass_started',
    pg_temp.rp_start(gen_random_uuid(), v_src_a, now() - interval '5 minutes'), now() - interval '5 minutes');

  insert into audit_fx (k, v) values ('t', v_t), ('a_admin', v_a_admin), ('tm_a', v_tm_a), ('tm_old', v_tm_old),
    ('src_a', v_src_a), ('src_old', v_src_old), ('b_admin', v_b_admin), ('tm_b', v_tm_b), ('src_b', v_src_b),
    ('a_member', v_a_member);

  -- ── 3. Isolation ───────────────────────────────────────────────────────────
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  v_b := pg_temp.audit_as(v_b_admin);
  reset role;

  -- A's inboxes: the open one with its address, the removed one without. (Both were connected in this
  -- transaction, so they share connected_at and their order is the ids'.)
  perform pg_temp.expect(jsonb_array_length(v_a -> 'inboxes'), 2, 'A lists its two registrations');
  perform pg_temp.expect_true(
    (select e from jsonb_array_elements(v_a -> 'inboxes') e where e ->> 'id' = v_tm_a::text)
      = jsonb_build_object('id', v_tm_a, 'address', 'deals@audit-a.example', 'open', true),
    'the open inbox names its address');
  perform pg_temp.expect_true(
    (select e from jsonb_array_elements(v_a -> 'inboxes') e where e ->> 'id' = v_tm_old::text)
      = jsonb_build_object('id', v_tm_old, 'address', null, 'open', false),
    'a removed inbox names no address');

  -- A's access view, action by action: its two connects, two checks, three membership rows, the removal, four
  -- access changes, two refusals, two candidates (its own and the shared one) and three Google group rows.
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_connected'), 2, 'A: both connects');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_checked'), 2, 'A: both checks');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_member_added'), 2, 'A: both additions');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_member_removed'), 1, 'A: the removal of a person');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_disconnected'), 1, 'A: the removed inbox');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.mailbox_access_changed'), 4,
    'A: the four access changes, and not the personal one');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.mailbox_refused'), 2,
    'A: the two team refusals, and neither the personal one nor the other tenant''s forged one');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.candidate_proposed'), 2, 'A: its candidate and the shared one');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.allowlist_drift'), 3, 'A: the three Google group rows, not Microsoft''s');
  perform pg_temp.expect(pg_temp.n(v_a), 19, 'A: nothing else in the access view');
  perform pg_temp.expect_true(v_a -> 'next' = 'null'::jsonb, 'A: one page holds it all');

  -- B's access view: its connect and check and the two candidates naming it; no group rows (A holds the registration).
  perform pg_temp.expect(jsonb_array_length(v_b -> 'inboxes'), 1, 'B lists its one registration');
  perform pg_temp.expect_text(v_b -> 'inboxes' -> 0 ->> 'id', v_tm_b::text, 'B''s own');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.team_mailbox_connected'), 1, 'B: its connect');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.team_mailbox_checked'), 1, 'B: its check');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.candidate_proposed'), 2, 'B: its candidate and the shared one');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.allowlist_drift'), 0, 'B: no Google group row');
  perform pg_temp.expect(pg_temp.n(v_b), 4, 'B: nothing else in the access view');

  -- Every row of each names only its own inboxes, in every view; B never names A's registrations or sources.
  foreach v_view in array array['access', 'reads', 'reads_notable'] loop
    set local role authenticated;
    v_a := pg_temp.audit_as(v_a_admin, v_view);
    v_b := pg_temp.audit_as(v_b_admin, v_view);
    v_x := pg_temp.audit_as(v_a_cco, v_view);
    reset role;
    perform pg_temp.expect_true(v_x = v_a, format('A''s CCO reads what A''s admin reads (%s)', v_view));
    perform pg_temp.expect((select count(*) from jsonb_array_elements(v_a -> 'rows') r
                            where not (coalesce(r ->> 'inboxId', '') = any (array[v_tm_a::text, v_tm_old::text])
                                       or (r ->> 'inboxId' is null and r ->> 'action' = 'discovery.allowlist_drift'))), 0,
      format('A: every row is one of A''s inboxes or a group event (%s)', v_view));
    perform pg_temp.expect((select count(*) from jsonb_array_elements(v_b -> 'rows') r
                            where r ->> 'inboxId' is distinct from v_tm_b::text), 0,
      format('B: every row is B''s inbox (%s)', v_view));
    perform pg_temp.expect_true(not (pg_temp.names(v_b, v_tm_a::text) or pg_temp.names(v_b, v_src_a::text)
                                     or pg_temp.names(v_b, v_tm_old::text) or pg_temp.names(v_b, v_src_old::text)),
      format('B never names A''s registrations or sources (%s)', v_view));
    perform pg_temp.expect_true(not (pg_temp.names(v_a, v_tm_b::text) or pg_temp.names(v_a, v_src_b::text)
                                     or pg_temp.names(v_a, v_tm_o::text) or pg_temp.names(v_a, v_src_o::text)),
      format('A never names B''s or the other tenant''s (%s)', v_view));
    -- ── 5. The projection holds in every view ─────────────────────────────────
    perform pg_temp.expect_true((v_a -> 'rows')::text !~ '@' and (v_b -> 'rows')::text !~ '@',
      format('no row carries an @ (%s)', v_view));
    perform pg_temp.expect_true(not pg_temp.names(v_a, 'CANARYCLIENT') and not pg_temp.names(v_a, 'team:'),
      format('no registration and no drift list leaves (%s)', v_view));
  end loop;

  -- The other tenant's admin sees its own inbox and row only, and nothing that names A's.
  set local role authenticated;
  v_x := pg_temp.audit_as(v_o_admin);
  reset role;
  perform pg_temp.expect(jsonb_array_length(v_x -> 'inboxes'), 1, 'the other tenant lists its own inbox');
  perform pg_temp.expect_text(v_x -> 'inboxes' -> 0 ->> 'id', v_tm_o::text, 'its own');
  perform pg_temp.expect(pg_temp.n(v_x), 1, 'the other tenant reads its one row, not the forged ones');
  perform pg_temp.expect_true(not pg_temp.names(v_x, v_tm_a::text) and not pg_temp.names(v_x, v_src_a::text),
    'the other tenant never names A''s registration or source');

  -- Google group events: nobody when the registration names no company. With the Graph registration on A, A is still
  -- seated and still reads its inbox rows, and no group row.
  update google_reader_registrations set firm_company_id = null where tenant_id = v_t;
  update graph_reader_registrations set firm_company_id = v_ca where tenant_id = v_t;
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  perform pg_temp.expect_text(pg_temp.try_audit(v_b_admin), 'ok',
    'B still reads its own inbox while no registration names it: the inbox set scopes, not the registrations');
  reset role;
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.allowlist_drift'), 0, 'a null Google holder: no company sees group rows');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_checked'), 2, 'A keeps its inbox rows');
  -- Re-pointed to B (and Graph to A, so both stay seated): the group rows, past and new, follow B; A keeps its own.
  update google_reader_registrations set firm_company_id = v_cb where tenant_id = v_t;
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  v_b := pg_temp.audit_as(v_b_admin);
  reset role;
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.allowlist_drift'), 0, 'A no longer sees the group rows');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_checked'), 2, 'A still sees its inbox rows');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.allowlist_drift'), 3, 'B sees the group rows now');
  perform pg_temp.expect_text(pg_temp.row_of(v_b, 'discovery.allowlist_drift', 'status', 'drift') -> 'detail' ->> 'thisInbox',
    'extra', 'for B, its own inbox is the extra one');
  perform pg_temp.expect_true(not pg_temp.names(v_b, v_tm_a::text) and (v_b -> 'rows')::text !~ '@',
    'and the group row still names nothing of A''s');
  update google_reader_registrations set firm_company_id = v_ca where tenant_id = v_t;
  update graph_reader_registrations set firm_company_id = v_cb where tenant_id = v_t;
  raise notice 'PASS: each firm company reads only its own team inbox rows';

  -- ── 4. The views ───────────────────────────────────────────────────────────
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  reset role;
  perform pg_temp.expect_text(
    (select string_agg(r -> 'detail' ->> 'change', ',' order by r -> 'detail' ->> 'change')
     from jsonb_array_elements(v_a -> 'rows') r where r ->> 'action' = 'discovery.mailbox_access_changed'),
    'paused,restarted,resumed,window_set', 'every access change appears');
  v_row := pg_temp.row_of(v_a, 'discovery.mailbox_access_changed', 'change', 'window_set');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('change', 'window_set', 'provider', 'google',
                                'sourceId', v_src_a, 'teamMailboxId', v_tm_a, 'from', v_today - 30, 'to', v_today - 90),
    'a window change carries its dates');
  v_row := pg_temp.row_of(v_a, 'discovery.allowlist_drift', 'status', 'unavailable');
  perform pg_temp.expect_true(v_row -> 'inboxId' = 'null'::jsonb, 'an unreadable group is a firm event, of no inbox');
  perform pg_temp.expect_true(v_row -> 'detail' = '{"provider": "google", "status": "unavailable"}'::jsonb,
    'and carries no list');
  v_row := pg_temp.row_of(v_a, 'discovery.allowlist_drift', 'status', 'drift');
  perform pg_temp.expect_true(v_row -> 'detail' = '{"provider": "google", "status": "drift", "thisInbox": "missing"}'::jsonb,
    'a drift row says only whether A''s inbox is missing or extra');
  perform pg_temp.expect_true(v_row -> 'inboxId' = 'null'::jsonb, 'and is a firm event too');

  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin, 'reads');
  v_b := pg_temp.audit_as(v_a_admin, 'reads_notable');
  reset role;
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.reader_pass_started'), 5, 'all reads: every start of A''s source');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.reader_pass_finished'), 3, 'all reads: every finish');
  perform pg_temp.expect(pg_temp.n(v_a), 8, 'all reads: nothing else, and not the other tenant''s forged start');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.reader_pass_finished'), 2,
    'notable: the pass that stored and excluded mail and the failed one, not the empty complete one');
  perform pg_temp.expect_true(pg_temp.row_of(v_b, 'discovery.reader_pass_finished', 'stored', '9') is not null,
    'notable: the pass that stored mail');
  perform pg_temp.expect_true(pg_temp.row_of(v_b, 'discovery.reader_pass_finished', 'status', 'failed') is not null,
    'notable: the failed pass');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.reader_pass_started'), 1, 'notable: one start with no end');
  perform pg_temp.expect_text(pg_temp.row_of(v_b, 'discovery.reader_pass_started') ->> 'id', v_p4::text,
    'the start 3601 s old, not the one 3599 s old');
  perform pg_temp.expect_true(not (pg_temp.ids(v_b) @> array[v_p5::text]), 'a start still inside the hour is not a problem');
  perform pg_temp.expect(pg_temp.n(v_b), 3, 'notable: nothing else');

  -- The keyset walks the access view five rows at a time and meets every row once, in order.
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  v_walk := '{}';
  v_i := 0;
  loop
    v_x := pg_temp.audit_as(v_a_admin, 'access', 5, v_cts, v_cid);
    v_walk := v_walk || pg_temp.ids(v_x);
    exit when v_x -> 'next' = 'null'::jsonb;
    perform pg_temp.expect(pg_temp.n(v_x), 5, 'a page that has a next is full');
    perform pg_temp.expect_text(v_x -> 'next' ->> 'id', v_x -> 'rows' -> 4 ->> 'id', 'next names the page''s last row');
    v_cts := (v_x -> 'next' ->> 'ts')::timestamptz;
    v_cid := (v_x -> 'next' ->> 'id')::uuid;
    v_i := v_i + 1;
    if v_i > 10 then raise exception 'FAIL: the keyset does not end'; end if;
  end loop;
  reset role;
  perform pg_temp.expect_true(v_walk = pg_temp.ids(v_a), 'the pages together are the whole view, each row once, in order');
  perform pg_temp.expect(v_i, 3, 'nineteen rows are four pages of five');

  -- The limit is clamped: 0 reads one row.
  set local role authenticated;
  v_x := pg_temp.audit_as(v_a_admin, 'access', 0);
  reset role;
  perform pg_temp.expect(pg_temp.n(v_x), 1, 'a limit of 0 reads one row');
  perform pg_temp.expect_true(v_x -> 'next' <> 'null'::jsonb, 'and says there is more');

  -- A bad view and half a cursor.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_admin, 'everything'), '22023:bad_view', 'an unknown view');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_admin, 'access', 50, now(), null), '22023:bad_cursor',
    'a cursor time with no id');
  perform pg_temp.expect_text(pg_temp.try_audit(v_a_admin, 'access', 50, null, gen_random_uuid()), '22023:bad_cursor',
    'a cursor id with no time');
  reset role;
  raise notice 'PASS: the three views, the keyset and the argument checks';

  -- ── 5. The projection, row by row ──────────────────────────────────────────
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  reset role;
  -- A user row names the person; a service row names its service when that is code-shaped.
  v_row := pg_temp.row_of(v_a, 'discovery.team_mailbox_connected', 'teamMailboxId', v_tm_a::text);
  perform pg_temp.expect_text(v_row ->> 'actorType', 'user', 'the connect is the admin''s');
  perform pg_temp.expect_text(v_row ->> 'actorName', 'Avery Stone', 'named from users');
  perform pg_temp.expect_true(v_row -> 'serviceIdentity' = 'null'::jsonb, 'a user row has no service identity');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a, 'sourceId', v_src_a),
    'the connect carries its ids and not the attestation version');
  v_row := pg_temp.row_of(v_a, 'discovery.team_mailbox_checked', 'status', 'refused');
  perform pg_temp.expect_text(v_row ->> 'serviceIdentity', 'discovery-worker', 'the check is the worker''s');
  perform pg_temp.expect_true(v_row -> 'actorName' = 'null'::jsonb, 'a service row names no person');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a, 'status', 'refused',
                                                                     'reason', 'directory_denied'),
    'the check carries its verdict and reason');
  v_row := pg_temp.row_of(v_a, 'discovery.team_mailbox_member_removed');
  perform pg_temp.expect_text(v_row ->> 'serviceIdentity', 'team-mailbox', 'a seat lost is the access rule''s');
  perform pg_temp.expect_text(v_row ->> 'subjectName', 'Jordan Reyes', 'the person whose access went, by name');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a, 'reason', 'seat_lost'),
    'and no user id');
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_a -> 'rows') r
                          where r ->> 'action' = 'discovery.team_mailbox_member_added'
                            and r ->> 'subjectName' = 'Jordan Reyes' and r ->> 'actorName' = 'Avery Stone'), 1,
    'an addition names who gave and who got access');
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_a -> 'rows') r
                          where r ->> 'action' = 'discovery.team_mailbox_member_added' and r -> 'subjectName' = 'null'::jsonb), 1,
    'a name that is an address is not returned');
  v_row := pg_temp.row_of(v_a, 'discovery.team_mailbox_disconnected');
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_old::text, 'the removal is the removed inbox''s');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_old, 'sourceId', v_src_old,
                                                                     'reason', 'never_verified'),
    'and carries its reason');
  -- A non-code reason and a free-text caller come back absent and null.
  v_row := pg_temp.row_of(v_a, 'discovery.mailbox_refused', 'reason', 'team_mailbox_unverified');
  perform pg_temp.expect_text(v_row ->> 'serviceIdentity', 'discovery-worker', 'a code-shaped caller is named');
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r
            where r ->> 'action' = 'discovery.mailbox_refused' and not (r -> 'detail' ? 'reason'));
  perform pg_temp.expect_true(v_row is not null, 'the refusal with a non-code reason comes back without it');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('purpose', 'provider_read', 'teamMailboxId', v_tm_a),
    'with its purpose and inbox only');
  perform pg_temp.expect_true(v_row -> 'serviceIdentity' = 'null'::jsonb, 'and a free-text caller comes back null');
  -- A candidate carries its evidence count and nothing that names a candidate or another firm's inbox.
  v_row := pg_temp.row_of(v_a, 'discovery.candidate_proposed', 'evidenceCount', '4');
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_a::text, 'the shared candidate is shown under A''s inbox');
  perform pg_temp.expect_true(v_row -> 'detail' = '{"evidenceCount": 4}'::jsonb, 'with its evidence count alone');
  -- The pass keys that never leave.
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin, 'reads');
  reset role;
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_a -> 'rows') r
                          where r -> 'detail' ?| array['registration', 'worker', 'jobId', 'runId', 'passId', 'startedAt',
                                                       'endedAt', 'pages', 'checkpointAdvanced', 'v']), 0,
    'no pass row carries the registration, the worker, the job, run or pass id, its times or its version');
  v_row := pg_temp.row_of(v_a, 'discovery.reader_pass_finished', 'stored', '9');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('sourceId', v_src_a, 'status', 'complete',
                                'provider', 'google', 'fetched', 12, 'excluded', 3, 'stored', 9),
    'a finished pass carries its source, outcome, provider and counts');
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_a::text, 'and its inbox, from the source');
  perform pg_temp.expect_true(pg_temp.row_of(v_a, 'discovery.reader_pass_finished', 'status', 'failed') -> 'detail' ->> 'reason'
                                = 'provider_error', 'a coded outcome reason is kept');
  perform pg_temp.expect_true((select bool_and(r -> 'detail' = jsonb_build_object('sourceId', v_src_a))
                               from jsonb_array_elements(v_a -> 'rows') r
                               where r ->> 'action' = 'discovery.reader_pass_started'),
    'a start carries its source alone');
  raise notice 'PASS: ids and fixed codes only, with names from users';
end
$$;

-- ── 6. The plan ─────────────────────────────────────────────────────────────
-- 600 pass rows on A's source, as about a day of five-minute passes leaves, beside the sparse access rows.
do $$
declare
  v_t   uuid := (select v from audit_fx where k = 't');
  v_src uuid := (select v from audit_fx where k = 'src_a');
  v_at  timestamptz;
begin
  for i in 1..600 loop
    v_at := now() - make_interval(mins => 120 + i);
    perform pg_temp.plant(v_t, 'discovery.reader_pass_started', pg_temp.rp_start(gen_random_uuid(), v_src, v_at), v_at);
  end loop;
end
$$;

analyze audit_log;

do $$
declare
  v_t      uuid := (select v from audit_fx where k = 't');
  v_admin  uuid := (select v from audit_fx where k = 'a_admin');
  v_tm     uuid := (select v from audit_fx where k = 'tm_a');
  v_tm_old uuid := (select v from audit_fx where k = 'tm_old');
  v_line   text;
  v_plan   text := '';
  v_page   jsonb;
begin
  -- The access branch's own shape (B1). A sequential scan is ruled out so the choice is between the indexes alone:
  -- on a small CI table the planner may otherwise prefer reading every page.
  perform set_config('enable_seqscan', 'off', true);
  for v_line in execute format($q$
    explain (costs off)
    select a.id
    from audit_log a
    where a.tenant_id = %L::uuid
      and a.action = any (array['discovery.team_mailbox_connected', 'discovery.team_mailbox_checked',
                                'discovery.team_mailbox_member_added', 'discovery.team_mailbox_member_removed',
                                'discovery.team_mailbox_disconnected', 'discovery.mailbox_access_changed',
                                'discovery.mailbox_refused'])
      and a.detail ->> 'teamMailboxId' = any (%L::text[])
    order by a.ts desc, a.id desc
    limit 51$q$, v_t, array[v_tm::text, v_tm_old::text])
  loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  perform set_config('enable_seqscan', 'on', true);
  if position('audit_log_tenant_action_ts' in v_plan) = 0 then
    raise exception 'FAIL: the access view does not read through audit_log_tenant_action_ts:%', E'\n' || v_plan;
  end if;

  -- 608 pass rows: the limit is clamped to 200, and the default is 50.
  set local role authenticated;
  v_page := pg_temp.audit_as(v_admin, 'reads', 500);
  perform pg_temp.expect(pg_temp.n(v_page), 200, 'a limit of 500 reads 200 rows');
  perform pg_temp.expect_true(v_page -> 'next' <> 'null'::jsonb, 'and says there is more');
  v_page := pg_temp.audit_as(v_admin, 'reads', null);
  perform pg_temp.expect(pg_temp.n(v_page), 50, 'no limit reads 50 rows');
  reset role;
  raise notice 'PASS: the access view reads through audit_log_tenant_action_ts, and the limit is clamped';
end
$$;


-- ── 7. History that outlives its source ─────────────────────────────────────
do $$
declare
  v_t       uuid := (select v from audit_fx where k = 't');
  v_admin   uuid := (select v from audit_fx where k = 'a_admin');
  v_b_admin uuid := (select v from audit_fx where k = 'b_admin');
  v_tm_a    uuid := (select v from audit_fx where k = 'tm_a');
  v_tm_old  uuid := (select v from audit_fx where k = 'tm_old');
  v_src_old uuid := (select v from audit_fx where k = 'src_old');
  v_s       jsonb;
  v_pass    uuid := gen_random_uuid();
  v_a       jsonb;
  v_b       jsonb;
  v_row     jsonb;
begin
  -- A pass of the closed inbox's source, then the purge that deletes the source row (the registration and every
  -- audit row stay).
  v_s := pg_temp.rp_start(v_pass, v_src_old, now() - interval '20 seconds');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_started', v_s, now() - interval '20 seconds');
  perform pg_temp.plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_s, now() - interval '19 seconds', 'complete', null, 4, 1, 3), now() - interval '19 seconds');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src_old), 1, 'the closed inbox''s source is there');
  perform discovery_purge_identifiers(v_t, v_src_old);
  perform pg_temp.expect((select count(*) from content_sources where id = v_src_old), 0, 'and the purge deleted it');
  perform pg_temp.expect((select count(*) from team_mailboxes where id = v_tm_old and disconnected_at is not null), 1,
    'the closed registration stays');

  set local role authenticated;
  v_a := pg_temp.audit_as(v_admin, 'reads');
  v_b := pg_temp.audit_as(v_b_admin, 'reads');
  reset role;
  v_row := pg_temp.row_of(v_a, 'discovery.reader_pass_finished', 'sourceId', v_src_old::text);
  perform pg_temp.expect_true(v_row is not null, 'A still reads the purged source''s pass');
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_old::text, 'under the closed inbox');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('sourceId', v_src_old, 'status', 'complete',
                                'provider', 'google', 'fetched', 4, 'excluded', 1, 'stored', 3),
    'with its counts and no pass internals');
  perform pg_temp.expect_true(pg_temp.row_of(v_a, 'discovery.reader_pass_started', 'sourceId', v_src_old::text) is not null,
    'and its start');
  perform pg_temp.expect_true(
    (select i from jsonb_array_elements(v_a -> 'inboxes') i where i ->> 'id' = v_tm_old::text)
      = jsonb_build_object('id', v_tm_old, 'address', null, 'open', false),
    'the inbox is listed closed, with no address (shown as Removed inbox)');
  perform pg_temp.expect_true(not pg_temp.names(v_b, v_src_old::text) and not pg_temp.names(v_b, v_tm_old::text),
    'B never sees the purged source or its inbox');
  set local role authenticated;
  v_a := pg_temp.audit_as(v_admin, 'reads_notable');
  reset role;
  perform pg_temp.expect_true(pg_temp.row_of(v_a, 'discovery.reader_pass_finished', 'sourceId', v_src_old::text) is not null,
    'the notable view keeps the purged source''s pass that stored mail');

  -- One drift row, one of A's inboxes missing from the group and another (closed) extra: the row says both.
  perform pg_temp.plant(v_t, 'discovery.allowlist_drift',
    jsonb_build_object('provider', 'google', 'status', 'drift',
                       'missingInGroup', jsonb_build_array('team:' || v_tm_a),
                       'extraInGroup', jsonb_build_array('team:' || v_tm_old, 'person@audit-a.example')),
    now() - interval '10 seconds');
  set local role authenticated;
  v_a := pg_temp.audit_as(v_admin);
  v_b := pg_temp.audit_as(v_b_admin);
  reset role;
  v_row := pg_temp.row_of(v_a, 'discovery.allowlist_drift', 'thisInbox', 'both');
  perform pg_temp.expect_true(v_row -> 'detail' = '{"provider": "google", "status": "drift", "thisInbox": "both"}'::jsonb,
    'a drift row with one of A''s inboxes missing and another extra says both');
  perform pg_temp.expect_true(v_row -> 'inboxId' = 'null'::jsonb, 'and stays a firm event');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.allowlist_drift'), 0, 'B, which holds no Google registration, sees no group row');
  raise notice 'PASS: a purged inbox keeps its reads in the trail, and a drift row can say both';
end
$$;

-- ── 8. Attribution: the writer names the team inboxes behind a new candidate ──
-- G-03 4/4. The real discovery_upsert_candidates, not a planted row: it writes teamMailboxIds into
-- discovery.candidate_proposed when it creates a candidate, and B2 of the read then shows the row to the firms whose
-- inboxes formed it. Its rows are the newest of the tenant (the transaction's now()), after every earlier section.

-- One firm-rules group in the worker's shape (src/lib/discovery/persist.ts), linking the given items.
create function pg_temp.attr_group(p_key text, p_items uuid[])
returns jsonb language sql as $$
  select jsonb_build_object(
    'clusterKey', p_key, 'proposedName', 'Project Attribution', 'codenameGuess', 'Project Attribution',
    'parties', '[]'::jsonb, 'firstSeenAt', '2026-10-01T00:00:00Z', 'lastSeenAt', '2026-10-01T00:00:00Z',
    'confidence', 0.9,
    'links', (select jsonb_agg(jsonb_build_object('sourceItemId', i, 'method', 'codename', 'confidence', 0.9))
              from unnest(p_items) i));
$$;

do $$
declare
  v_t       uuid := (select v from audit_fx where k = 't');
  v_a_admin uuid := (select v from audit_fx where k = 'a_admin');
  v_b_admin uuid := (select v from audit_fx where k = 'b_admin');
  v_owner   uuid := (select v from audit_fx where k = 'a_member');
  v_tm_a    uuid := (select v from audit_fx where k = 'tm_a');
  v_src_a   uuid := (select v from audit_fx where k = 'src_a');
  v_tm_b    uuid := (select v from audit_fx where k = 'tm_b');
  v_src_b   uuid := (select v from audit_fx where k = 'src_b');
  v_run     uuid := gen_random_uuid();
  v_i       uuid[] := array(select gen_random_uuid() from generate_series(1, 8));
  v_src_own uuid;
  v_c_team  uuid;
  v_c_own   uuid;
  v_c_mixed uuid;
  v_r_team  uuid;
  v_r_own   uuid;
  v_r_mixed uuid;
  v_d_team  jsonb;
  v_d_own   jsonb;
  v_d_mixed jsonb;
  v_a       jsonb;
  v_b       jsonb;
  v_row     jsonb;
  v_tm_shut uuid;
  v_src_shut uuid;
  v_c_shut  uuid;
  v_r_shut  uuid;
  v_shut    uuid := gen_random_uuid();
begin
  -- A person's own mailbox in company A, beside A's and B's team sources.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
    values (v_t, 'mailbox', 'owner@audit-a.example', v_owner, 'google') returning id into v_src_own;
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
  select v_i[n], v_t, 'message', 'Project Attribution: note ' || n, '2026-10-01'::timestamptz, '<attr' || n || '@t>', 'attr' || n
  from generate_series(1, 8) n;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    -- Team: two messages in A's inbox and one in B's.
    (v_i[1], v_src_a, 'attr-a1'), (v_i[2], v_src_a, 'attr-a2'), (v_i[3], v_src_b, 'attr-b3'),
    -- Personal only.
    (v_i[4], v_src_own, 'attr-o4'), (v_i[5], v_src_own, 'attr-o5'),
    -- Mixed: one message held by both A's inbox and the person's mailbox, one by the person's alone.
    (v_i[6], v_src_a, 'attr-a6'), (v_i[6], v_src_own, 'attr-o6'), (v_i[7], v_src_own, 'attr-o7'),
    -- Team mail that arrives later, for the personal candidate.
    (v_i[8], v_src_a, 'attr-a8');

  perform discovery_upsert_candidates(v_t, v_run, jsonb_build_array(
    pg_temp.attr_group('codename:attr-team', array[v_i[1], v_i[2], v_i[3]]),
    pg_temp.attr_group('codename:attr-own', array[v_i[4], v_i[5]]),
    pg_temp.attr_group('codename:attr-mixed', array[v_i[6], v_i[7]])));
  select id into v_c_team from deal_candidates where tenant_id = v_t and cluster_key = 'codename:attr-team';
  select id into v_c_own from deal_candidates where tenant_id = v_t and cluster_key = 'codename:attr-own';
  select id into v_c_mixed from deal_candidates where tenant_id = v_t and cluster_key = 'codename:attr-mixed';
  perform pg_temp.expect((select count(*) from audit_log
                          where tenant_id = v_t and action = 'discovery.candidate_proposed'
                            and detail ->> 'candidateId' = any (array[v_c_team::text, v_c_own::text, v_c_mixed::text])), 3,
    'each new candidate is proposed once');
  select id, detail into v_r_team, v_d_team from audit_log
   where tenant_id = v_t and action = 'discovery.candidate_proposed' and detail ->> 'candidateId' = v_c_team::text;
  select id, detail into v_r_own, v_d_own from audit_log
   where tenant_id = v_t and action = 'discovery.candidate_proposed' and detail ->> 'candidateId' = v_c_own::text;
  select id, detail into v_r_mixed, v_d_mixed from audit_log
   where tenant_id = v_t and action = 'discovery.candidate_proposed' and detail ->> 'candidateId' = v_c_mixed::text;

  -- The written detail, exactly.
  perform pg_temp.expect_true(
    v_d_team = jsonb_build_object('candidateId', v_c_team, 'runId', v_run, 'evidenceCount', 3,
                                  'teamMailboxIds', (select jsonb_agg(x order by x) from unnest(array[v_tm_a, v_tm_b]) x)),
    'a candidate from team mail names its inboxes, sorted, each once though A''s holds two of its messages');
  perform pg_temp.expect_true(
    v_d_own = jsonb_build_object('candidateId', v_c_own, 'runId', v_run, 'evidenceCount', 2),
    'a personal-only candidate records no teamMailboxIds key');
  perform pg_temp.expect_true(
    v_d_mixed = jsonb_build_object('candidateId', v_c_mixed, 'runId', v_run, 'evidenceCount', 2,
                                   'teamMailboxIds', jsonb_build_array(v_tm_a)),
    'a candidate spanning A''s inbox and a person''s mailbox records A''s id alone');
  perform pg_temp.expect_true(
    (select bool_and(jsonb_typeof(e) = 'string') from jsonb_array_elements(v_d_team -> 'teamMailboxIds') e),
    'the ids are strings, the shape B2 matches with ?|');
  perform pg_temp.expect_true(v_d_team::text !~ '@' and v_d_own::text !~ '@' and v_d_mixed::text !~ '@',
    'no written detail carries an @');

  -- B2: each row reaches the firms whose inboxes formed it, under that firm's own inbox, with its count alone.
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  v_b := pg_temp.audit_as(v_b_admin);
  reset role;
  perform pg_temp.expect_true(pg_temp.ids(v_a) @> array[v_r_team::text, v_r_mixed::text],
    'A reads both candidates its inbox formed');
  perform pg_temp.expect_true(not (pg_temp.ids(v_a) @> array[v_r_own::text]), 'A does not read the personal-only one');
  perform pg_temp.expect_true(pg_temp.ids(v_b) @> array[v_r_team::text], 'B reads the one its inbox shares');
  perform pg_temp.expect_true(not (pg_temp.ids(v_b) && array[v_r_mixed::text, v_r_own::text]),
    'B never reads the one A''s inbox formed alone, nor the personal one');
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r where r ->> 'id' = v_r_team::text);
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_a::text, 'for A the shared candidate is under A''s inbox');
  perform pg_temp.expect_true(v_row -> 'detail' = '{"evidenceCount": 3}'::jsonb,
    'with its evidence count alone: the ids and the candidate never leave');
  perform pg_temp.expect_text(v_row ->> 'serviceIdentity', 'discovery-worker', 'and it is the worker''s');
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r where r ->> 'id' = v_r_mixed::text);
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_a::text, 'the mixed candidate is under A''s inbox');
  v_row := (select r from jsonb_array_elements(v_b -> 'rows') r where r ->> 'id' = v_r_team::text);
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_b::text, 'for B the shared candidate is under B''s inbox');
  perform pg_temp.expect_true(not pg_temp.names(v_b, v_tm_a::text) and not pg_temp.names(v_b, v_src_a::text)
                              and (v_b -> 'rows')::text !~ '@',
    'and B''s page still names nothing of A''s');

  -- The limit (design R17, thread T4): team mail joining an existing candidate later writes no row.
  perform discovery_upsert_candidates(v_t, gen_random_uuid(), jsonb_build_array(
    pg_temp.attr_group('codename:attr-own', array[v_i[4], v_i[5], v_i[8]])));
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_c_own), 3,
    'the later team message is linked to the existing candidate');
  perform pg_temp.expect((select count(*) from audit_log
                          where tenant_id = v_t and action = 'discovery.candidate_proposed'
                            and detail ->> 'candidateId' = v_c_own::text), 1,
    'but no second proposal is written');
  perform pg_temp.expect_true(
    (select detail from audit_log where id = v_r_own) = v_d_own,
    'and the first one is as it was, with no key');

  -- A closed inbox's mail: a candidate whose only team evidence is in an inbox A has since removed still names it,
  -- and still reaches A's trail, under that inbox (a closed one is shown as "Removed inbox"); B never reads it.
  insert into team_mailboxes (tenant_id, firm_company_id, provider, address, connected_by, attestation_version,
                              disconnected_by, disconnected_at, disconnected_reason)
  values (v_t, (select company_id from users where id = v_a_admin), 'google', 'closed@audit-a.example', v_a_admin, 1,
          v_a_admin, now() - interval '1 day', 'never_verified')
  returning id into v_tm_shut;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status, team_mailbox_id)
  values (v_t, 'mailbox', 'closed@audit-a.example', null, 'google', 'paused', v_tm_shut) returning id into v_src_shut;
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
  values (v_shut, v_t, 'message', 'Project Attribution: closed', '2026-10-01'::timestamptz, '<attr-shut@t>', 'attr-shut');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
  values (v_shut, v_src_shut, 'attr-shut'), (v_i[7], v_src_shut, 'attr-shut7');
  perform discovery_upsert_candidates(v_t, gen_random_uuid(), jsonb_build_array(
    pg_temp.attr_group('codename:attr-shut', array[v_shut])));
  select id into v_c_shut from deal_candidates where tenant_id = v_t and cluster_key = 'codename:attr-shut';
  select id into v_r_shut from audit_log
   where tenant_id = v_t and action = 'discovery.candidate_proposed' and detail ->> 'candidateId' = v_c_shut::text;
  perform pg_temp.expect_true(
    (select detail -> 'teamMailboxIds' from audit_log where id = v_r_shut) = jsonb_build_array(v_tm_shut),
    'a candidate from a closed inbox''s mail names that inbox');
  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  v_b := pg_temp.audit_as(v_b_admin);
  reset role;
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r where r ->> 'id' = v_r_shut::text);
  perform pg_temp.expect_true(v_row is not null, 'and A still reads it');
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_shut::text, 'under the closed inbox');
  perform pg_temp.expect_true(
    (select i from jsonb_array_elements(v_a -> 'inboxes') i where i ->> 'id' = v_tm_shut::text)
      = jsonb_build_object('id', v_tm_shut, 'address', null, 'open', false),
    'which the page lists closed, with no address');
  perform pg_temp.expect_true(not (pg_temp.ids(v_b) @> array[v_r_shut::text]) and not pg_temp.names(v_b, v_tm_shut::text),
    'B never reads it');
  raise notice 'PASS: a new candidate records the team inboxes that formed it, and only their firms read it';
end
$$;

-- ── 9. AI passes and capability switches (G-01, 20261023110400_team_mailbox_audit_proposals.sql) ──
-- The access view also shows the AI proposal passes over the firm's own inboxes (B1) and the owner's capability
-- switches for the caller's own firm company (B7, a firm event). A switch is written by the real trigger (an owner
-- insert, then a revoke); the passes are planted in begin's and end's shapes (20261023110200). Each firm sees only its
-- own; the decision reference, the run and pass ids and lastRenewedAt never leave; a malformed outcome or count is
-- dropped.
do $$
declare
  v_t       uuid := (select v from audit_fx where k = 't');
  v_a_admin uuid := (select v from audit_fx where k = 'a_admin');
  v_b_admin uuid := (select v from audit_fx where k = 'b_admin');
  v_tm_a    uuid := (select v from audit_fx where k = 'tm_a');
  v_src_a   uuid := (select v from audit_fx where k = 'src_a');
  v_tm_b    uuid := (select v from audit_fx where k = 'tm_b');
  v_src_b   uuid := (select v from audit_fx where k = 'src_b');
  v_ca      uuid := (select company_id from users where id = (select v from audit_fx where k = 'a_admin'));
  v_cb      uuid := (select company_id from users where id = (select v from audit_fx where k = 'b_admin'));
  -- Bank X: a bank of the same tenant that holds no team inbox. The other tenant's bank.
  v_cx      uuid := (select c.id from companies c where c.tenant_id = (select v from audit_fx where k = 't')
                       and c.name = 'Audit Bank X');
  v_co      uuid := (select c.id from companies c
                       where c.name = 'Audit Other Bank' and c.tenant_id <> (select v from audit_fx where k = 't')
                       order by c.created_at desc limit 1);
  v_o       uuid := (select c.tenant_id from companies c where c.id = v_co);
  v_big     uuid;
  v_run     uuid := gen_random_uuid();
  v_pass    uuid := gen_random_uuid();
  v_odd     uuid;
  v_unc     uuid;
  v_a       jsonb;
  v_b       jsonb;
  v_reads   jsonb;
  v_row     jsonb;
  v_base    jsonb;
begin
  -- The switches: A's team_proposals approved then revoked and its firm_name_alias approved, B's milestone_rules
  -- approved, and a switch each for Bank X (same tenant, no inbox) and the other tenant's bank. The trigger writes
  -- every row.
  if v_cx is null or v_co is null or v_o is null then raise exception 'FAIL: section 9 fixture: Bank X or the other bank'; end if;
  insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
    values (v_t, v_ca, 'team_proposals', 'g01-trail-ref-a'), (v_t, v_ca, 'firm_name_alias', 'g01-trail-ref-a2'),
           (v_t, v_cb, 'milestone_rules', 'g01-trail-ref-b'), (v_t, v_cx, 'milestone_rules', 'g01-trail-ref-x'),
           (v_o, v_co, 'team_proposals', 'g01-trail-ref-o');
  update discovery_tenant_approvals set revoked_at = now()
   where tenant_id = v_t and firm_company_id = v_ca and capability = 'team_proposals';

  -- A's pass: started, then finished complete with its counts. B's inbox has a pass of its own.
  v_base := jsonb_build_object('passId', v_pass, 'sourceId', v_src_a, 'teamMailboxId', v_tm_a, 'firmCompanyId', v_ca,
                               'runId', v_run, 'path', 'recorded');
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_proposal_started', v_base, now());
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_proposal_finished',
    v_base || jsonb_build_object('outcome', 'complete',
                                 'counts', jsonb_build_object('asked', 3, 'deal', 1, 'notDeal', 1, 'invalid', 1, 'failed', 0)),
    now());
  -- A lapsed pass a later run closed: unclosed, with its last renewal.
  v_unc := pg_temp.plant(v_t, 'discovery.team_mailbox_proposal_finished',
    v_base || jsonb_build_object('runId', gen_random_uuid(), 'outcome', 'unclosed', 'lastRenewedAt', now() - interval '40 minutes',
                                 'counts', jsonb_build_object('asked', 2, 'deal', 0, 'notDeal', 2, 'invalid', 0, 'failed', 0)),
    now());
  -- A malformed row: an outcome that is no code and a count that is a string.
  v_odd := pg_temp.plant(v_t, 'discovery.team_mailbox_proposal_finished',
    v_base || jsonb_build_object('runId', gen_random_uuid(), 'outcome', 'Bad Outcome!',
                                 'counts', jsonb_build_object('asked', '3', 'deal', -1)),
    now());
  -- The writer's bound: a count of exactly 1,000,000,000 is kept, one over it is dropped.
  v_big := pg_temp.plant(v_t, 'discovery.team_mailbox_proposal_finished',
    v_base || jsonb_build_object('runId', gen_random_uuid(), 'outcome', 'page_limit',
                                 'counts', jsonb_build_object('asked', 1000000000, 'deal', 1000000001, 'notDeal', 0,
                                                              'invalid', 0, 'failed', 0)),
    now());
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_proposal_started',
    jsonb_build_object('passId', gen_random_uuid(), 'sourceId', v_src_b, 'teamMailboxId', v_tm_b, 'firmCompanyId', v_cb,
                       'runId', gen_random_uuid(), 'path', 'recorded'),
    now());

  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  v_b := pg_temp.audit_as(v_b_admin);
  v_reads := pg_temp.audit_as(v_a_admin, 'reads');
  reset role;
  perform pg_temp.act_as_none();

  -- The switches: each firm sees its own, as firm events, with the capability and on, never the decision reference.
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.tenant_approval_changed'), 3,
    'A sees its approval, its revoke and its firm_name_alias approval, and no other firm''s switch');
  perform pg_temp.expect_true(
    (select array_agg(distinct r -> 'detail' ->> 'capability' order by r -> 'detail' ->> 'capability')
       from jsonb_array_elements(v_a -> 'rows') r where r ->> 'action' = 'discovery.tenant_approval_changed')
      = array['firm_name_alias', 'team_proposals'],
    'A''s switches are its own two capabilities');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.tenant_approval_changed')
                         + pg_temp.n(v_b, 'discovery.tenant_approval_changed'), 4,
    'Bank X''s switch and the other tenant''s reach neither A nor B');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.tenant_approval_changed'), 1, 'B sees its own switch alone');
  v_row := pg_temp.row_of(v_a, 'discovery.tenant_approval_changed', 'on', 'false');
  perform pg_temp.expect_true(v_row is not null, 'the revoke says off');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('capability', 'team_proposals', 'on', false),
    'a switch carries its capability and on, and nothing else');
  perform pg_temp.expect_true(v_row -> 'inboxId' = 'null'::jsonb, 'a switch is a firm event, under no inbox');
  perform pg_temp.expect_text(v_row ->> 'serviceIdentity', 'discovery-tenant-approvals', 'written by the approvals trigger');
  perform pg_temp.expect_true(pg_temp.row_of(v_a, 'discovery.tenant_approval_changed', 'on', 'true') is not null,
    'the approval says on');
  perform pg_temp.expect_true(pg_temp.row_of(v_b, 'discovery.tenant_approval_changed', 'capability', 'milestone_rules') is not null,
    'B''s switch names its own capability');
  perform pg_temp.expect_true(not pg_temp.names(v_a, 'g01-trail-ref') and not pg_temp.names(v_b, 'g01-trail-ref'),
    'no decision reference leaves');
  perform pg_temp.expect_true(not pg_temp.names(v_a, 'milestone_rules'), 'A never sees B''s or Bank X''s milestone_rules switch');
  perform pg_temp.expect_true(not pg_temp.names(v_b, 'team_proposals'), 'B never sees A''s switch');

  -- The passes: under the inbox, with path, outcome and counts; never the run, the pass or the last renewal.
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_proposal_started'), 1, 'A sees its started pass');
  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_proposal_finished'), 4, 'and its four finished rows');
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r where r ->> 'id' = v_big::text);
  perform pg_temp.expect_text(v_row -> 'detail' ->> 'asked', '1000000000', 'a count of 1,000,000,000 is kept, as the writer allows');
  perform pg_temp.expect_true(not (v_row -> 'detail' ? 'deal'), 'one over the bound is dropped');
  v_row := pg_temp.row_of(v_a, 'discovery.team_mailbox_proposal_finished', 'outcome', 'complete');
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_a::text, 'a pass is under its inbox');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a, 'sourceId', v_src_a,
      'path', 'recorded', 'outcome', 'complete', 'asked', 3, 'deal', 1, 'notDeal', 1, 'invalid', 1, 'failed', 0),
    'a finished pass carries its inbox, source, path, outcome and five counts, and nothing else');
  v_row := pg_temp.row_of(v_a, 'discovery.team_mailbox_proposal_started');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a, 'sourceId', v_src_a, 'path', 'recorded'),
    'a started pass carries its inbox, source and path');
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r where r ->> 'id' = v_unc::text);
  perform pg_temp.expect_text(v_row -> 'detail' ->> 'outcome', 'unclosed', 'a swept pass says unclosed');
  perform pg_temp.expect_true(not (v_row -> 'detail' ? 'lastRenewedAt'), 'without its last renewal');
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r where r ->> 'id' = v_odd::text);
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a, 'sourceId', v_src_a, 'path', 'recorded'),
    'a malformed outcome and malformed counts are dropped');
  perform pg_temp.expect_true(not pg_temp.names(v_a, v_run::text) and not pg_temp.names(v_a, v_pass::text),
    'no run or pass id leaves');
  perform pg_temp.expect_true(not pg_temp.names(v_a, v_tm_b::text), 'A never sees B''s pass');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.team_mailbox_proposal_started'), 1, 'B sees its own pass');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.team_mailbox_proposal_finished'), 0, 'and none of A''s');
  perform pg_temp.expect(pg_temp.n(v_reads, 'discovery.team_mailbox_proposal_started')
                         + pg_temp.n(v_reads, 'discovery.team_mailbox_proposal_finished')
                         + pg_temp.n(v_reads, 'discovery.tenant_approval_changed'), 0,
    'the reads view is the reader passes alone');
  raise notice 'PASS: the trail shows the firm''s own AI passes and capability switches, ids and codes only';
end
$$;

-- ── 10. Rule detector passes (#173 G-07 slice 5, 20261023130800_team_mailbox_audit_detections.sql) ──
-- The access view also shows each rule detector pass over the firm's own inboxes (B1), in the shape
-- discovery_record_team_detection_pass writes (20261023130600): the inbox, the run, and two counts. Each firm sees
-- only its own inbox's passes, with the counts; the run id never leaves; a malformed count is dropped.
do $$
declare
  v_t       uuid := (select v from audit_fx where k = 't');
  v_a_admin uuid := (select v from audit_fx where k = 'a_admin');
  v_b_admin uuid := (select v from audit_fx where k = 'b_admin');
  v_a_cco   uuid := (select id from users where email = 'ta-a-cco@example.test');
  v_tm_a    uuid := (select v from audit_fx where k = 'tm_a');
  v_tm_b    uuid := (select v from audit_fx where k = 'tm_b');
  v_run     uuid := gen_random_uuid();
  v_odd     uuid;
  v_a       jsonb;
  v_b       jsonb;
  v_cco     jsonb;
  v_reads   jsonb;
  v_row     jsonb;
begin
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_milestones_detected',
    jsonb_build_object('teamMailboxId', v_tm_a, 'runId', v_run, 'items', 12, 'events', 3), now());
  v_odd := pg_temp.plant(v_t, 'discovery.team_mailbox_milestones_detected',
    jsonb_build_object('teamMailboxId', v_tm_a, 'runId', gen_random_uuid(), 'items', '12', 'events', -1), now());
  perform pg_temp.plant(v_t, 'discovery.team_mailbox_milestones_detected',
    jsonb_build_object('teamMailboxId', v_tm_b, 'runId', gen_random_uuid(), 'items', 4, 'events', 0), now());

  set local role authenticated;
  v_a := pg_temp.audit_as(v_a_admin);
  v_b := pg_temp.audit_as(v_b_admin);
  v_cco := pg_temp.audit_as(v_a_cco);
  v_reads := pg_temp.audit_as(v_a_admin, 'reads');
  reset role;
  perform pg_temp.act_as_none();

  perform pg_temp.expect(pg_temp.n(v_a, 'discovery.team_mailbox_milestones_detected'), 2, 'A sees its own inbox''s two detection passes');
  perform pg_temp.expect_true(v_a_cco is not null, 'A''s CCO is in the fixture');
  perform pg_temp.expect(pg_temp.n(v_cco, 'discovery.team_mailbox_milestones_detected'), 2, 'A''s CCO sees the same two passes');
  perform pg_temp.expect_true(v_cco = v_a, 'A''s CCO reads what A''s admin reads, detection passes included');
  v_row := pg_temp.row_of(v_a, 'discovery.team_mailbox_milestones_detected', 'items', '12');
  perform pg_temp.expect_text(v_row ->> 'inboxId', v_tm_a::text, 'a detection pass is under its inbox');
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a, 'items', 12, 'events', 3),
    'a detection pass carries its inbox and its two counts, and nothing else');
  v_row := (select r from jsonb_array_elements(v_a -> 'rows') r where r ->> 'id' = v_odd::text);
  perform pg_temp.expect_true(v_row -> 'detail' = jsonb_build_object('teamMailboxId', v_tm_a), 'malformed counts are dropped');
  perform pg_temp.expect_true(not pg_temp.names(v_a, v_run::text), 'no run id leaves');
  perform pg_temp.expect_true(not pg_temp.names(v_a, v_tm_b::text), 'A never sees B''s detection pass');
  perform pg_temp.expect(pg_temp.n(v_b, 'discovery.team_mailbox_milestones_detected'), 1, 'B sees its own pass alone');
  perform pg_temp.expect(pg_temp.n(v_reads, 'discovery.team_mailbox_milestones_detected'), 0, 'the reads view is the reader passes alone');
  raise notice 'PASS: the trail shows the firm''s own rule detector passes, ids and counts only';
end
$$;

rollback;
