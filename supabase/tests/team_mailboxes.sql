-- Admin-managed team inbox (#581), phase 1: 20261019100000_team_mailboxes.sql,
-- phase 2: 20261019110000_team_mailbox_audit_ids.sql, phase 3:
-- 20261019120000_team_mailbox_list.sql, phase 5: 20261019130000_team_mailbox_check.sql,
-- phase 7: 20261019140000_team_mailbox_guard.sql, phase 8: 20261019150000_team_mailbox_members.sql and
-- phase 10: 20261019160000_team_mailbox_visibility.sql and
-- phase 11: 20261019170000_team_mailbox_attach.sql; #173 G-04: 20261023100000_team_mailbox_refusal_notify.sql and
-- 20261023100100_team_mailbox_connect_notice_scope.sql.
-- The registry and the connect RPC. The guard refuses the ownerless team source the RPC
-- creates until the Directory has confirmed it (a new source is pending), and dedupes the
-- refusal. Phase 2: every audit row about a team source carries ids and fixed codes only
-- (section 7). Phase 3: the connect RPC reaches the signed-in role, and the firm admin lists
-- and removes registrations (sections 8 and 9). Phase 7: the guard reads a confirmed, fresh
-- team inbox for the worker's provider_read and for nothing else (section 11).
--
--   1. grants: team_mailboxes has RLS and no policy, the service role reads and updates
--      it, the signed-in roles hold nothing; the connect, list and remove RPCs are
--      executable by authenticated and by neither anon nor PUBLIC
--   2. refusals, each writing nothing: no session, not an admin (a CCO included), the
--      flag off, a bad address, a missing attestation, no provider, two providers,
--      Microsoft, a window out of range, a person's address (a user, a pending invite, an
--      accepted invite, a personal source)
--   3. connect: the registry row, the ownerless source, the window, the audit row (ids
--      only, no '@'), the notification to each admin and the CCO; idempotent
--   4. the default window; adopting an ownerless source with nothing attached; archiving
--      one with provenance (the audit row carries ids only)
--   5. the guard refuses the pending team source (team_mailbox_unverified) and audits the refusal once
--   6. the registry's own rules: append-only, close-once, the check columns' pairs, the
--      source's fixed owner and address; reconnecting after a close archives the old source
--   7. audit rows about a team source: pause, resume, restart, a guard refusal (also of a
--      tool read) and group drift name the registration and no address; the same rows for
--      a personal source, and a refusal for an address with no source, keep the address
--   8. the list: a firm admin only (a CCO, an MD, another tenant's admin and no session are
--      refused or see their own firm's), open registrations only, every field, removable
--   9. Remove: a never-verified registration with no mail closes and archives its source
--      (ids-only audit, guard state forgotten); a verified one, one holding mail, a closed
--      one and anyone else's are refused with nothing written; the address can be connected again
--  10. the worker's address check (phase 5): both functions are the service role's alone; the due rule at each
--      boundary (never checked, pending and refused at 4 minutes, verified at 15, a verified row with a recent
--      transient error); bad arguments write nothing; each outcome's effect on the registration (verified pins the
--      id and clears the reason and the error pair, refused keeps the id and the success time, a transient error
--      leaves the status alone, another id than the pinned one is identity_changed); the audit row is written on a
--      change of status or reason only, carries ids and fixed codes and no '@'; a closed registration and an
--      unknown id record nothing; the guard now reads a verified team source for the worker (phase 7, section 11)
--  11. the guard's team branch (phase 7): the verdict for a pending, refused, fresh, 64m59s, 65m and 66m old
--      confirmation; a transient error that cannot make a stale check fresh; a person's address added later (a user,
--      a pending or an accepted invite); a closed registration, a paused source, a disabled registration, a
--      domain the registration no longer lists; the purposes (only provider_read admits a null owner, a tool,
--      search, retrieval or export read of a team source is owner_mismatch, and so is any named owner who is no
--      reader of the inbox, phase 11 admits the readers: section 14); the
--      view stays non-empty and un-flipped when the check is 66 minutes old (no time term) and is the service
--      role's alone; the refusal is audited once by registration, forgotten when the check is renewed and audited
--      again when it goes stale again; the guard state takes the three team reasons; a personal source is judged
--      as before
--  12. members (phase 8, 20261019150000_team_mailbox_members.sql): the table and the readers view are the service
--      role's alone and the two RPCs the signed-in role's; every refusal (no session, not an admin, another tenant's,
--      no such inbox, and, for a person, an admin, the caller, an external, a suspended, an unseated, another bank's,
--      another tenant's, an unknown or no user) writes nothing; add is audited by ids, idempotent and refuses nobody
--      twice; remove closes the row with removed, is idempotent and the person can be added again; the rows are
--      append-only and their pairs hold; a seat lost (moved, suspended, made external) closes the row with seat_lost by
--      the service and a re-seat does not revive it, a role change in the firm keeps it; a promotion to firm admin
--      drops the reader but leaves the row open; Remove of an inbox closes its members with disconnected, and a
--      refused Remove closes none; every membership audit row is ids and a fixed reason; the add and a seat lost
--      hold the tenant's discovery lock (a second block, on fresh tenants)
--  13. visibility follows membership (phase 10, 20261019160000_team_mailbox_visibility.sql; the persona matrix over
--      candidates, links, items, texts and milestones is supabase/tests/discovery_rls.sql): the refresh trigger is
--      pinned, and fires ahead of the audit trigger; an add gives the member a visibility row for each candidate the
--      inbox evidences, a removal, a seat lost and a promotion to firm admin take it away, a person who also owns a
--      personal copy of the item keeps one row counting it once
--  14. a member's tool read (phase 11, 20261019170000_team_mailbox_attach.sql): the guard admits a named person for
--      agent_tool, search, retrieval and export exactly while they are a reader of that inbox, and refuses a
--      non-member, a removed member, a member who lost their seat or was promoted to firm admin, a member of another
--      inbox, another tenant's user and a null owner; the worker's provider_read with no owner still reads, and a
--      stale check, a paused source and a refused inbox still stop a reader; a refusal is audited by registration
--      with no '@'; the personal path is unchanged
--  15. a refusal tells the inbox's own firm (#173 G-04, 20261023100000_team_mailbox_refusal_notify.sql): two bank
--      companies of one tenant (A holds the Google registration, B the Graph one, so firm_company_ids names both);
--      entering refused tells A's active internal admin and CCO once each with {teamMailboxId, address, reason,
--      href} and no content, and tells B, a banker, an external, a suspended admin and another tenant nothing; the
--      same refusal, a transient error, a recovery and a first verify tell no one; a new reason, refused again after
--      a recovery and the pin mismatch (identity_changed) tell them again; B's refusal reaches only B; a bank with
--      nobody seated is told nothing and the audit row is the record; the connect notice (20261023100100) tells
--      A's admin and CCO of A's inboxes, with the payload unchanged, and tells B nothing
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/team_mailboxes.sql
-- Everything rolls back.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does (authorize_provisioned_profile over its metadata) and give it a
-- live session whose id is the user id.
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
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.act_as_none()
returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;

-- Calls the connect RPC as p_user and returns the error as sqlstate:message, or 'ok'.
create function pg_temp.try_connect(p_user uuid, p_address text, p_att integer default 1, p_since date default null)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform discovery_connect_team_mailbox(p_address, p_att, p_since);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- Calls it and returns what it returned.
create function pg_temp.connect_as(p_user uuid, p_address text, p_att integer default 1, p_since date default null)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return discovery_connect_team_mailbox(p_address, p_att, p_since);
end;
$$;

-- Runs p_sql and returns 'ok' or sqlstate:message.
create function pg_temp.try_sql(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- Calls the list RPC as p_user and returns what it returned.
create function pg_temp.list_as(p_user uuid)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return discovery_team_mailboxes();
end;
$$;

-- Calls the list RPC as p_user and returns the error as sqlstate:message, or 'ok'.
create function pg_temp.try_list(p_user uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform discovery_team_mailboxes();
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- Calls the remove RPC as p_user and returns the error as sqlstate:message, or 'ok'.
create function pg_temp.try_remove(p_user uuid, p_id uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform discovery_remove_team_mailbox(p_id);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- Calls the remove RPC as p_user and returns what it returned.
create function pg_temp.remove_as(p_user uuid, p_id uuid)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return discovery_remove_team_mailbox(p_id);
end;
$$;

-- The entry of a list for one address, or null.
create function pg_temp.entry(p_list jsonb, p_address text)
returns jsonb language sql as $$
  select e from jsonb_array_elements(p_list) e where e ->> 'address' = p_address;
$$;

-- The privileges the service role holds on a relation, as a sorted list.
create function pg_temp.svc_privs(p_rel text)
returns text language sql as $$
  select coalesce(string_agg(p, ',' order by p), '')
  from unnest(array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p
  where has_table_privilege('service_role', p_rel, p);
$$;

grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- ── 1. Grants ───────────────────────────────────────────────────────────────
do $$
begin
  if not coalesce((select relrowsecurity from pg_class where oid = 'public.team_mailboxes'::regclass), false) then
    raise exception 'FAIL: team_mailboxes has no row level security';
  end if;
  perform pg_temp.expect((select count(*) from pg_policy where polrelid = 'public.team_mailboxes'::regclass), 0,
    'team_mailboxes has no policy');
  if has_table_privilege('anon', 'public.team_mailboxes', 'select, insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'public.team_mailboxes', 'select, insert, update, delete, truncate') then
    raise exception 'FAIL: anon or authenticated holds a privilege on team_mailboxes';
  end if;
  perform pg_temp.expect_text(pg_temp.svc_privs('public.team_mailboxes'), 'SELECT,UPDATE',
    'the service role reads and updates the registry, nothing more');

  -- The connect, list and remove RPCs are the signed-in role's, and neither anon's nor PUBLIC's.
  if not has_function_privilege('authenticated', 'public.discovery_connect_team_mailbox(text,integer,date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.discovery_team_mailboxes()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.discovery_remove_team_mailbox(uuid)', 'EXECUTE') then
    raise exception 'FAIL: the team inbox RPCs must be executable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.discovery_connect_team_mailbox(text,integer,date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.discovery_team_mailboxes()', 'EXECUTE')
     or has_function_privilege('anon', 'public.discovery_remove_team_mailbox(uuid)', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid in ('public.discovery_connect_team_mailbox(text,integer,date)'::regprocedure,
                                'public.discovery_team_mailboxes()'::regprocedure,
                                'public.discovery_remove_team_mailbox(uuid)'::regprocedure)
                  and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'FAIL: a team inbox RPC is executable by anon or PUBLIC';
  end if;
  if (select count(*) from pg_proc p
      where p.oid in ('public.discovery_connect_team_mailbox(text,integer,date)'::regprocedure,
                      'public.discovery_team_mailboxes()'::regprocedure,
                      'public.discovery_remove_team_mailbox(uuid)'::regprocedure)
        and p.prosecdef and coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']) <> 3 then
    raise exception 'FAIL: the team inbox RPCs must be definers pinned to public, pg_temp';
  end if;
end
$$;

-- Anon cannot run them: the privilege check fails before the body does.
do $$
declare
  v_connect text;
  v_list    text;
  v_remove  text;
begin
  set local role anon;
  begin perform discovery_connect_team_mailbox('deals@tm.example', 1);
  exception when others then v_connect := sqlstate || ':' || sqlerrm; end;
  begin perform discovery_team_mailboxes();
  exception when others then v_list := sqlstate || ':' || sqlerrm; end;
  begin perform discovery_remove_team_mailbox(gen_random_uuid());
  exception when others then v_remove := sqlstate || ':' || sqlerrm; end;
  reset role;
  perform pg_temp.expect_text(v_connect, '42501:permission denied for function discovery_connect_team_mailbox',
    'anon cannot execute the connect RPC, and it is the privilege that refuses, not the body');
  perform pg_temp.expect_text(v_list, '42501:permission denied for function discovery_team_mailboxes',
    'anon cannot execute the list RPC');
  perform pg_temp.expect_text(v_remove, '42501:permission denied for function discovery_remove_team_mailbox',
    'anon cannot execute the remove RPC');
end
$$;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_o        uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();   -- the firm: a bank in T that the registrations name
  v_ob       uuid := gen_random_uuid();   -- another tenant's bank
  v_dir      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_admin2   uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_md       uuid := gen_random_uuid();   -- an MD who is not an admin
  v_bob      uuid := gen_random_uuid();   -- a person on the firm's domain
  v_oadmin   uuid := gen_random_uuid();   -- another tenant's admin
  v_invited  uuid := gen_random_uuid();   -- accepted an invite at the firm's domain
  v_today    date := (now() at time zone 'utc')::date;
  v_res      text;
  v_out      jsonb;
  v_tm       uuid;
  v_src      uuid;
  v_adopt    uuid := gen_random_uuid();
  v_arch     uuid := gen_random_uuid();
  v_item     uuid := gen_random_uuid();
  v_tm_def   uuid;
  v_src_def  uuid;
  v_tm_def2  uuid;
  v_n        bigint;
  v_tm_deals  uuid;
  v_src_deals uuid;
  v_src_pers  uuid;
  v_drift     jsonb;
  v_changed   boolean;
  v_list      jsonb;
  v_entry     jsonb;
  v_item2     uuid := gen_random_uuid();
  v_tm_ver    uuid;
  v_tm_mail   uuid;
  v_src_mail  uuid;
  v_tm_rm     uuid;
  v_src_rm    uuid;
  v_tm_other  uuid;
  v_before    bigint;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,     'tm-dir@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,   'tm-admin@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_admin2,  'tm-admin2@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,     'tm-cco@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_md,      'tm-md@example.test',      jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_bob,     'bob@tm.example',          jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_oadmin,  'tm-oadmin@example.test',  jsonb_build_object('tenant_id', v_o, 'department', 'admin')),
    (v_invited, 'tm-invited@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_o);
  insert into companies (id, tenant_id, name, type) values
    (v_b, v_t, 'TM Bank', 'bank'), (v_ob, v_o, 'TM Other Bank', 'bank');
  update users set company_id = v_b, company_role = 'director' where id = v_dir;
  update users set company_id = v_b, company_role = 'member'
    where id in (v_admin, v_admin2, v_cco, v_md, v_bob, v_invited);
  update users set company_id = v_ob, company_role = 'director' where id = v_oadmin;
  update users set firm_role = 'admin' where id in (v_admin, v_admin2, v_oadmin);
  update users set firm_role = 'cco' where id = v_cco;

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'tm.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@tm.example', v_b, 'active', now()),
    (v_o, 'other.example', 'dwd-reader@proj-2.iam.gserviceaccount.com', '223456789012345678',
     'dir-reader@proj-2.iam.gserviceaccount.com', 'conductia-ingest@other.example', v_ob, 'active', now());
  -- A Microsoft registration on a different domain, for the provider cases.
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{ms.tm.example}', v_b);
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;

  -- A person's address of each kind: a user (bob@tm.example, above), an accepted invite, a
  -- pending invite, a source a person owns.
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_t, 'accepted@tm.example', v_dir, v_b, 'member', 'accepted', 'sent', now(), v_invited);
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status)
  values (v_t, 'pending@tm.example', v_dir, v_b, 'member', 'pending', 'sent');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'sourced@tm.example', v_md, 'google');

  -- ── 2. Refusals, each writing nothing ──────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as_none();
  v_res := null;
  begin perform discovery_connect_team_mailbox('deals@tm.example', 1);
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_authenticated', 'no session is refused');
  perform pg_temp.expect_text(pg_temp.try_connect(v_md, 'deals@tm.example'), '42501:not_eligible',
    'an MD who is not an admin is refused');
  perform pg_temp.expect_text(pg_temp.try_connect(v_cco, 'deals@tm.example'), '42501:not_eligible',
    'a CCO is not an admin');
  perform pg_temp.expect_text(pg_temp.try_connect(gen_random_uuid(), 'deals@tm.example'), '42501:not_eligible',
    'an unknown user is refused');
  perform pg_temp.expect_text(pg_temp.try_connect(v_oadmin, 'deals@tm.example'), '22023:provider_unresolved',
    'another tenant''s admin cannot register an address on this tenant''s domain');
  reset role;

  -- The flag.
  update feature_flags set enabled = false where key = 'deal_discovery';
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@tm.example'), 'P0001:discovery_disabled',
    'discovery off refuses the connect');
  reset role;
  update feature_flags set enabled = true where key = 'deal_discovery';

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'not an address'), '22023:invalid_address', 'a bad address');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'a@b'), '22023:invalid_address', 'an address with no dotted domain');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals~x@tm.example'), '22023:invalid_address',
    'a tilde is reserved for the archive suffix');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@tm.example', 0), '22023:attestation_required',
    'no attestation');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@tm.example', null), '22023:attestation_required',
    'a null attestation');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@nowhere.example'), '22023:provider_unresolved',
    'a domain no registration lists');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@ms.tm.example'), '22023:provider_unsupported',
    'a Microsoft address is refused for now');
  reset role;
  -- Two providers list the domain: the operator picks, so nothing is registered.
  update graph_reader_registrations set mailbox_domains = '{ms.tm.example,tm.example}' where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@tm.example'), '22023:provider_unresolved',
    'two providers for one domain is unresolved');
  reset role;
  update graph_reader_registrations set mailbox_domains = '{ms.tm.example}' where tenant_id = v_t;

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@tm.example', 1, v_today + 1), '22023:out_of_range',
    'a window in the future');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'deals@tm.example', 1, v_today - 731), '22023:out_of_range',
    'a window past two years');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'bob@tm.example'), '23505:person_address',
    'a user''s address is a person''s');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'accepted@tm.example'), '23505:person_address',
    'an accepted invite''s address is a person''s');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'pending@tm.example'), '23505:person_address',
    'a pending invite''s address is a person''s');
  perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'sourced@tm.example'), '23505:person_address',
    'a personal source''s address is a person''s');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from team_mailboxes where tenant_id = v_t), 0, 'no refusal registered anything');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and team_mailbox_id is not null), 0,
    'no refusal created a team source');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and kind = 'mailbox'), 1,
    'no refusal touched the sources (the personal one is the only one)');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action like 'discovery.team_mailbox%'), 0,
    'no refusal was audited as a connect');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 0,
    'no refusal notified anyone');

  -- ── 3. Connect ─────────────────────────────────────────────────────────────
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'Deals@TM.example ', 1, v_today - 30);
  reset role;
  perform pg_temp.act_as_none();
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  v_tm_deals := v_tm;
  v_src_deals := v_src;
  perform pg_temp.expect_text(v_out ->> 'created', 'true', 'the first connect creates');
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'address', 'deals@tm.example', 'the address is normalized');
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'checkStatus', 'pending', 'a new registration is pending');
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'provider', 'google', 'it is a Google inbox');
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'backfillSince', (v_today - 30)::text, 'the window is returned');
  perform pg_temp.expect((select count(*) from team_mailboxes
    where id = v_tm and tenant_id = v_t and firm_company_id = v_b and provider = 'google' and address = 'deals@tm.example'
      and connected_by = v_admin and attestation_version = 1 and disconnected_at is null
      and check_status = 'pending' and check_reason is null and checked_at is null and verified_at is null
      and directory_user_id is null and last_check_error is null), 1,
    'the registry row is the firm''s, connected by the admin, pending and unchecked');
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_src and tenant_id = v_t and kind = 'mailbox' and provider = 'google' and status = 'active'
      and owner_user_id is null and team_mailbox_id = v_tm and address = 'deals@tm.example'
      and backfill_since = v_today - 30 and delta_checkpoint is null and archived_at is null), 1,
    'the source is ownerless, active, on Google, with the window');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.team_mailbox_connected' and actor_id = v_admin
    and detail ->> 'teamMailboxId' = v_tm::text and detail ->> 'sourceId' = v_src::text
    and (detail ->> 'attestationVersion')::int = 1
    and (detail - 'teamMailboxId' - 'sourceId' - 'attestationVersion') = '{}'::jsonb
    and detail::text !~ '@'), 1, 'one connect row: ids and the attestation version, no address');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_source_archived'), 0,
    'a new source archives nothing');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id in (v_admin, v_admin2, v_cco)
    and payload ->> 'teamMailboxId' = v_tm::text and payload ->> 'sourceId' = v_src::text
    and payload ->> 'outcome' = 'team_connected' and payload ->> 'provider' = 'google'
    and not (payload ?| array['subject', 'body', 'snippet', 'text'])), 3,
    'each admin and the CCO is told, with no content');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 3,
    'nobody else is told');
  perform pg_temp.expect((select count(*) from notifications where event_type = 'mailbox_connected' and recipient_id = v_oadmin), 0,
    'another tenant''s admin is not told');

  -- Idempotent: the open registration comes back as it is, from any admin, with any window.
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin2, 'deals@tm.example', 1, v_today - 5);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_out ->> 'created', 'false', 'a second connect creates nothing');
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'id', v_tm::text, 'it names the same registration');
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'sourceId', v_src::text, 'and the same source');
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'backfillSince', (v_today - 30)::text, 'the window is not rewritten');
  perform pg_temp.expect((select count(*) from team_mailboxes where tenant_id = v_t), 1, 'still one registration');
  perform pg_temp.expect((select count(*) from content_sources where team_mailbox_id = v_tm), 1, 'still one source');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action like 'discovery.team_mailbox%'), 1,
    'a repeat is not audited');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 3,
    'a repeat tells no one');
  -- The case folds: the same address in capitals is the same registration.
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'DEALS@tm.example');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'id', v_tm::text, 'capitals fold to the same registration');

  -- Another firm's open registration of an address (only a direct write can make one: connect resolves the
  -- provider for the caller's firm) is refused, never handed back. Rolled back, so the counts below hold.
  begin
    insert into companies (id, tenant_id, name, type) values ('0e5a1b3c-0000-4000-8000-000000000581', v_t, 'Other Firm', 'bank');
    insert into team_mailboxes (tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
    values (v_t, '0e5a1b3c-0000-4000-8000-000000000581', 'google', 'other@tm.example', v_admin2, 1);
    set local role authenticated;
    perform pg_temp.expect_text(pg_temp.try_connect(v_admin, 'other@tm.example'), '42501:not_eligible',
      'another firm''s open registration is not handed back');
    reset role;
    raise exception 'rollback_other_firm';
  exception when raise_exception then
    if sqlerrm <> 'rollback_other_firm' then raise; end if;
  end;

  -- ── 4. The default window, adopt, archive ──────────────────────────────────
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'default@tm.example');
  reset role;
  perform pg_temp.act_as_none();
  v_tm_def := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_def := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'backfillSince', (v_today - 90)::text,
    'no window means 90 days before today (UTC)');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src_def and backfill_since = v_today - 90), 1,
    'and the source carries it');

  -- Adopt: an ownerless source with nothing attached keeps its row and starts fresh.
  insert into content_sources (id, tenant_id, kind, address, provider, status, delta_checkpoint, last_error,
                               backfill_completed_at, checkpoint_updated_at, last_synced_at, last_error_at,
                               backfill_started_at, history_expiry_streak)
  values (v_adopt, v_t, 'mailbox', 'adopt@tm.example', 'google', 'paused', 'cp-1', 'boom',
          now(), now(), now(), now(), now(), 2);
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'adopt@tm.example', 1, v_today - 7);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_out -> 'teamMailbox' ->> 'sourceId', v_adopt::text, 'the ownerless source is adopted, not replaced');
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_adopt and team_mailbox_id = (v_out -> 'teamMailbox' ->> 'id')::uuid and owner_user_id is null
      and status = 'active' and provider = 'google' and backfill_since = v_today - 7 and archived_at is null
      and delta_checkpoint is null and last_error is null and last_error_at is null and backfill_completed_at is null
      and checkpoint_updated_at is null and last_synced_at is null and backfill_started_at is null
      and history_expiry_streak = 0), 1,
    'the adopted source is active, in the window, and its sync state is cleared');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and lower(address) = 'adopt@tm.example'), 1,
    'adopting made no second source');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_source_archived'), 0,
    'adopting archives nothing');

  -- Archive: an ownerless source holding provenance is the earlier holder's, so it is archived.
  insert into content_sources (id, tenant_id, kind, address, provider)
  values (v_arch, v_t, 'mailbox', 'archive@tm.example', 'google');
  insert into source_items (id, tenant_id, kind, content_hash) values (v_item, v_t, 'message', 'tm-hash-1');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_item, v_arch, 'pid-1');
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'archive@tm.example', 1, v_today - 7);
  reset role;
  perform pg_temp.act_as_none();
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  perform pg_temp.expect_text((v_src <> v_arch)::text, 'true', 'a fresh source is created');
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_arch and address like 'archive@tm.example~%' and status = 'paused' and archived_at is not null
      and archived_from_address = 'archive@tm.example' and team_mailbox_id is null and owner_user_id is null), 1,
    'the earlier holder''s source is renamed, paused and stamped');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_arch), 1,
    'its provenance stays with it');
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_src and address = 'archive@tm.example' and team_mailbox_id = v_tm and owner_user_id is null
      and status = 'active' and backfill_since = v_today - 7 and delta_checkpoint is null), 1,
    'the fresh source is the registration''s');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_src), 0,
    'and holds nothing of the earlier one');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_source_archived'
    and detail ->> 'sourceId' = v_arch::text and detail ->> 'freshSourceId' = v_src::text
    and detail ->> 'teamMailboxId' = v_tm::text
    and (detail - 'sourceId' - 'freshSourceId' - 'teamMailboxId') = '{}'::jsonb
    and detail::text !~ '@' and detail::text !~ '~'), 1,
    'the archive row carries ids only: no address, no archived address');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_connected'
    and detail ->> 'teamMailboxId' = v_tm::text and detail::text !~ '@'), 1, 'and so does the connect row');

  -- ── 5. The guard refuses the pending team source, and dedupes the refusal ─────
  -- The team source is ownerless and no allowed_mailboxes row stands behind its address. Its
  -- registration has not been confirmed by the Directory yet (a new one is pending), so the
  -- guard's team branch refuses it: team_mailbox_unverified.
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'deals@tm.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    'team_mailbox_unverified', 'the guard refuses a team source nobody has confirmed');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'deals@tm.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    'team_mailbox_unverified', 'and refuses it again');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm_deals::text and detail ->> 'purpose' = 'provider_read'
    and detail ->> 'reason' = 'team_mailbox_unverified'), 1, 'the repeated provider_read refusal is audited once, by registration');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, 'deals@tm.example', null, true, v_md), 'team_mailbox_unverified',
    'the member-facing verdict refuses it too');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'deals@tm.example', 'agent_tool', 'sql-test', true, v_md, null, 'google'),
    'team_mailbox_unverified', 'a tool read of it is refused');
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t and address like '%deals@%'), 0,
    'a team address never reaches allowed_mailboxes');

  -- ── 6. The registry's own rules ────────────────────────────────────────────
  -- The source keeps its owner and address while the registration is open.
  perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set owner_user_id = %L where id = %L', v_bob, v_src_def)),
    'P0001:team_source_fixed', 'an open team source cannot be given an owner');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set address = %L where id = %L', 'x@tm.example', v_src_def)),
    'P0001:team_source_fixed', 'nor renamed');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set team_mailbox_id = null where id = %L', v_src_def)),
    'P0001:team_source_fixed', 'nor released from its registration');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set team_mailbox_id = %L where id = %L', v_tm, v_src_def)),
    'P0001:team_source_fixed', 'nor moved to another');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set status = %L where id = %L', 'paused', v_src_def)),
    'ok', 'but it can be paused');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'insert into content_sources (tenant_id, kind, address, owner_user_id, provider, team_mailbox_id) values (%L, %L, %L, %L, %L, %L)',
    v_t, 'mailbox', 'owned@tm.example', v_bob, 'google', v_tm_def)), 5),
    '23514', 'a team source with an owner is refused');
  -- A personal opt-in cannot take a team source: the grant adopts and archives by exactly these updates.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update content_sources set owner_user_id = %L, delta_checkpoint = null where id = %L and owner_user_id is null', v_bob, v_src_def)),
    'P0001:team_source_fixed', 'an opt-in''s adopt is refused');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update content_sources set address = address || %L, status = %L, archived_at = now(), archived_from_address = address where id = %L',
    '~abc', 'paused', v_src_def)),
    'P0001:team_source_fixed', 'an opt-in''s archive is refused');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('delete from team_mailboxes where id = %L', v_tm_def)), 5),
    '23503', 'a registration with a source cannot be deleted');

  -- The registry is append-only, and the check columns keep their pairs.
  perform pg_temp.expect_text(pg_temp.try_sql(format('update team_mailboxes set address = %L where id = %L', 'other@tm.example', v_tm_def)),
    'P0001:team mailbox registrations are append-only', 'the address is fixed');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update team_mailboxes set connected_by = %L where id = %L', v_admin2, v_tm_def)),
    'P0001:team mailbox registrations are append-only', 'so is who connected it');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('update team_mailboxes set check_status = %L where id = %L', 'verified', v_tm_def)), 5),
    '23514', 'verified needs verified_at');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('update team_mailboxes set check_status = %L where id = %L', 'refused', v_tm_def)), 5),
    '23514', 'refused needs a reason');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('update team_mailboxes set check_reason = %L where id = %L', 'group', v_tm_def)), 5),
    '23514', 'a reason needs a refusal');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('update team_mailboxes set check_status = %L, check_reason = %L where id = %L', 'refused', 'nope', v_tm_def)), 5),
    '23514', 'a reason is one of the fixed codes');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('update team_mailboxes set last_check_error = %L where id = %L', 'directory_error', v_tm_def)), 5),
    '23514', 'an error needs its time');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update team_mailboxes set check_status = %L, check_reason = %L, checked_at = now() where id = %L', 'refused', 'group', v_tm_def)),
    'ok', 'a refusal with a reason is accepted');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update team_mailboxes set check_status = %L, check_reason = null, checked_at = now(), verified_at = now(), directory_user_id = %L where id = %L',
    'verified', 'dir-1', v_tm_def)), 'ok', 'a verification is accepted');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update team_mailboxes set last_check_error = %L, last_check_error_at = now() where id = %L', 'directory_error', v_tm_def)),
    'ok', 'a transient error is accepted beside a verified status');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'update team_mailboxes set last_check_error = %L where id = %L', 'something else', v_tm_def)), 5),
    '23514', 'an error is one of the fixed codes');

  -- Close once: the pair is all or nothing, a close is written once, and a closed registration frees its address.
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('update team_mailboxes set disconnected_at = now() where id = %L', v_tm_def)), 5),
    '23514', 'a close names who and why');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'update team_mailboxes set disconnected_at = now(), disconnected_by = %L, disconnected_reason = %L where id = %L',
    v_admin, 'bogus', v_tm_def)), 5), '23514', 'the reason is a fixed code');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update team_mailboxes set disconnected_at = now(), disconnected_by = %L, disconnected_reason = %L where id = %L',
    v_admin, 'never_verified', v_tm_def)), 'ok', 'a registration closes');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update team_mailboxes set disconnected_at = now() + interval ''1 minute'' where id = %L', v_tm_def)),
    'P0001:a closed team mailbox registration cannot change', 'a close is written once');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update team_mailboxes set check_status = %L, check_reason = %L where id = %L', 'refused', 'alias', v_tm_def)),
    'ok', 'the check columns stay free after a close');

  -- Connecting the address again after the close registers it anew, and archives the closed one's source.
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin2, 'default@tm.example', 1, v_today - 3);
  reset role;
  perform pg_temp.act_as_none();
  v_tm_def2 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  perform pg_temp.expect_text(v_out ->> 'created', 'true', 'a closed address can be connected again');
  perform pg_temp.expect_text((v_tm_def2 <> v_tm_def)::text, 'true', 'as a new registration');
  perform pg_temp.expect((select count(*) from team_mailboxes where tenant_id = v_t and address = 'default@tm.example'), 2,
    'the closed registration stays');
  perform pg_temp.expect((select count(*) from team_mailboxes where tenant_id = v_t and address = 'default@tm.example'
    and disconnected_at is null), 1, 'with one open');
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_src_def and address like 'default@tm.example~%' and status = 'paused' and archived_at is not null
      and team_mailbox_id = v_tm_def), 1, 'the closed registration''s source is archived and keeps its registration');
  perform pg_temp.expect((select count(*) from content_sources
    where team_mailbox_id = v_tm_def2 and address = 'default@tm.example' and backfill_since = v_today - 3
      and status = 'active' and owner_user_id is null), 1, 'the new registration has a fresh source');

  -- ── 7. Audit rows about a team source carry ids only (phase 2) ─────────────
  -- v_src_deals is the active, ownerless team source of deals@tm.example (v_tm_deals).
  -- Pause and resume, by a firm admin.
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_set_mailbox_source_status(v_src_deals, 'paused');
  perform discovery_set_mailbox_source_status(v_src_deals, 'paused');
  perform discovery_set_mailbox_source_status(v_src_deals, 'active');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_access_changed'
    and detail ->> 'sourceId' = v_src_deals::text and detail ->> 'teamMailboxId' = v_tm_deals::text
    and detail ->> 'change' = 'paused' and detail ->> 'provider' = 'google'
    and (detail - 'change' - 'provider' - 'sourceId' - 'teamMailboxId') = '{}'::jsonb), 1,
    'pausing a team source is audited once, by registration, with no address');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_access_changed'
    and detail ->> 'sourceId' = v_src_deals::text and detail ->> 'teamMailboxId' = v_tm_deals::text
    and detail ->> 'change' = 'resumed' and not (detail ? 'address')), 1,
    'resuming a team source is audited the same way');

  -- Restart, by a firm admin, of a halted team source.
  update content_sources set last_error = 'history_window_exceeded', last_error_at = now() where id = v_src_deals;
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_restart_mailbox_source(v_src_deals);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_access_changed'
    and detail ->> 'sourceId' = v_src_deals::text and detail ->> 'teamMailboxId' = v_tm_deals::text
    and detail ->> 'change' = 'restarted' and not (detail ? 'address')
    and (detail - 'change' - 'provider' - 'sourceId' - 'teamMailboxId') = '{}'::jsonb), 1,
    'restarting a team source is audited by registration, with no address');
  -- The 24 hour cooldown keys on sourceId, which the team row still carries.
  update content_sources set last_error = 'history_window_exceeded', last_error_at = now() where id = v_src_deals;
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_res := null;
  begin perform discovery_restart_mailbox_source(v_src_deals);
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_res, '42501:not_available', 'a second restart of a team source is held by the cooldown');

  -- The first-read window (#353's RPC, restated here), by a firm admin, before the first read. Rolled back, so the
  -- window later sections read is the one connect set.
  begin
    set local role authenticated;
    perform pg_temp.act_as(v_admin);
    perform discovery_set_mailbox_source_window(v_src_deals, v_today - 10);
    reset role;
    perform pg_temp.act_as_none();
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_access_changed'
      and detail ->> 'sourceId' = v_src_deals::text and detail ->> 'teamMailboxId' = v_tm_deals::text
      and detail ->> 'change' = 'window_set' and detail ->> 'to' = (v_today - 10)::text and not (detail ? 'address')
      and (detail - 'change' - 'provider' - 'sourceId' - 'teamMailboxId' - 'from' - 'to') = '{}'::jsonb
      and detail::text !~ '@'), 1,
      'a team source''s window change is audited by registration, with no address');
    raise exception 'rollback_window';
  exception when raise_exception then
    if sqlerrm <> 'rollback_window' then raise; end if;
  end;

  -- The guard's refusal, by registration. The first refusal in section 5 is the provider_read
  -- one; the tool read refused there is audited on every call and is by registration too.
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm_deals::text and detail ->> 'purpose' = 'agent_tool'
    and (detail - 'reason' - 'purpose' - 'teamMailboxId') = '{}'::jsonb), 1,
    'a refused tool read of a team source is audited by registration');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm_deals::text and detail::text ~ '@'), 0,
    'no refusal of a team source carries an address');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'address' = 'deals@tm.example'), 0, 'and none names the team address under any key');
  -- Every purpose is audited the same way: a search read is refused and audited on each call.
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'deals@tm.example', 'search', 'sql-test', true, v_md, null, 'google'),
    'team_mailbox_unverified', 'a search read of a team source is refused');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm_deals::text and detail ->> 'purpose' = 'search'
    and not (detail ? 'address')), 1, 'a refused search of a team source is audited by registration');

  -- The same rows for a personal source keep the address, key for key.
  select id into v_src_pers from content_sources where tenant_id = v_t and lower(address) = 'sourced@tm.example';
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_set_mailbox_source_status(v_src_pers, 'paused');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_access_changed'
    and detail ->> 'sourceId' = v_src_pers::text and detail ->> 'change' = 'paused'
    and detail ->> 'address' = 'sourced@tm.example' and not (detail ? 'teamMailboxId')
    and (detail - 'change' - 'provider' - 'sourceId' - 'address') = '{}'::jsonb), 1,
    'pausing a personal source still names the address');
  update content_sources set last_error = 'history_window_exceeded', last_error_at = now() where id = v_src_pers;
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform discovery_restart_mailbox_source(v_src_pers);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_access_changed'
    and detail ->> 'sourceId' = v_src_pers::text and detail ->> 'change' = 'restarted'
    and detail ->> 'address' = 'sourced@tm.example' and not (detail ? 'teamMailboxId')), 1,
    'restarting a personal source still names the address');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'sourced@tm.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    'no_invite', 'the guard refuses a personal source nobody opted in');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'address' = 'sourced@tm.example' and detail ->> 'reason' = 'no_invite'
    and detail ->> 'purpose' = 'provider_read' and not (detail ? 'teamMailboxId')
    and (detail - 'reason' - 'purpose' - 'address') = '{}'::jsonb), 1,
    'a personal refusal still names the address');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'ghost@tm.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    'no_source', 'an address with no source is refused');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'address' = 'ghost@tm.example' and detail ->> 'reason' = 'no_source'
    and not (detail ? 'teamMailboxId')), 1, 'and the refusal of a sourceless address keeps the address');

  -- Group drift. default@tm.example has an open registration (v_tm_def2) and a pending check;
  -- deals@tm.example is the other. The allowlist the worker compares is people's today, so a
  -- team address shows up as extra (in the group, not allowed) or missing once a later phase
  -- allows it; either way it is recorded by registration.
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'drift',
    array['Deals@tm.example', 'missing@tm.example'], array['extra@tm.example', 'DEFAULT@tm.example']);
  perform pg_temp.expect_text(v_changed::text, 'true', 'a first drift record is a change');
  select detail into v_drift from audit_log
  where tenant_id = v_t and action = 'discovery.allowlist_drift';
  perform pg_temp.expect_text((v_drift -> 'missingInGroup')::text,
    jsonb_build_array('missing@tm.example'::text, 'team:' || v_tm_deals::text)::text,
    'a team address in the missing list is recorded as team:<registration>; others are unchanged');
  perform pg_temp.expect_text((v_drift -> 'extraInGroup')::text,
    jsonb_build_array('extra@tm.example'::text, 'team:' || v_tm_def2::text)::text,
    'and so is one in the extra list');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.allowlist_drift'
    and detail::text ~ 'deals@|default@'), 0, 'no drift row names a team address');
  perform pg_temp.expect((select count(*) from mailbox_allowlist_drift where tenant_id = v_t and provider = 'google'
    and missing_in_group = array['missing@tm.example', 'team:' || v_tm_deals::text]
    and extra_in_group = array['extra@tm.example', 'team:' || v_tm_def2::text]), 1,
    'the stored drift state is by registration too');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_allowlist_drift'
    and recipient_id in (v_admin, v_admin2, v_cco) and (payload ->> 'missingCount')::int = 2
    and (payload ->> 'extraCount')::int = 2 and payload::text !~ '@'), 3,
    'the notification counts both lists and names no address');
  -- The same sets again are not news (the comparison is on what is recorded).
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'drift',
    array['deals@tm.example', 'missing@tm.example'], array['extra@tm.example', 'default@tm.example']);
  perform pg_temp.expect_text(v_changed::text, 'false', 'the same drift again is not a change');
  -- A closed registration still names its address for the trail (audit item 8): no person's source
  -- holds it, so it is recorded by that registration, as before the close.
  update team_mailboxes set disconnected_at = now(), disconnected_by = v_admin, disconnected_reason = 'never_verified'
  where id = v_tm_def2;
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'drift',
    array['deals@tm.example', 'missing@tm.example'], array['extra@tm.example', 'default@tm.example']);
  perform pg_temp.expect_text(v_changed::text, 'false', 'closing a registration does not change what is recorded');
  perform pg_temp.expect((select count(*) from mailbox_allowlist_drift where tenant_id = v_t and provider = 'google'
    and extra_in_group = array['extra@tm.example', 'team:' || v_tm_def2::text]), 1,
    'a closed registration''s address is still recorded by registration');
  -- What follows archives the closed registration's source and gives the address to a person: rolled back, so the
  -- sections after this one see the fixture as it was.
  begin
    -- Its source archived away (as Remove does), no source holds the address: the refusal names the registration.
    update content_sources set address = 'default@tm.example~zz9', status = 'paused', archived_at = now(),
           archived_from_address = address
    where team_mailbox_id = v_tm_def2;
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'default@tm.example', 'provider_read', 'sql-test', false, null, null, 'google'),
      'no_source', 'a closed registration''s address with no source is refused');
    -- Both of default@'s registrations are closed, and inside one transaction they share their timestamps, so either
    -- is the latest: the row names one of them, never the address.
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
      and detail ->> 'reason' = 'no_source' and detail ->> 'teamMailboxId' in (v_tm_def::text, v_tm_def2::text)
      and not (detail ? 'address') and detail::text !~ '@'), 1,
      'and the refusal names a closed registration of the address, not the address');
    -- A person's source for the address afterwards is that person's: named by its address, as any personal one.
    insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
    values (v_t, 'mailbox', 'default@tm.example', v_md, 'google', 'active');
    v_changed := discovery_record_allowlist_drift(v_t, 'google', 'drift',
      array['deals@tm.example', 'missing@tm.example'], array['extra@tm.example', 'default@tm.example']);
    perform pg_temp.expect_text(v_changed::text, 'true', 'a person''s source for the address changes what is recorded');
    perform pg_temp.expect((select count(*) from mailbox_allowlist_drift where tenant_id = v_t and provider = 'google'
      and extra_in_group = array['default@tm.example', 'extra@tm.example']), 1,
      'the address a person''s source now holds is recorded as it is');
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'default@tm.example', 'provider_read', 'sql-test', false, null, null, 'google'),
      'no_invite', 'the person''s source is refused until they opt in');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
      and detail ->> 'reason' = 'no_invite' and detail ->> 'address' = 'default@tm.example'
      and not (detail ? 'teamMailboxId')), 1, 'and that refusal names the person''s address');
    raise exception 'rollback_closed_registration';
  exception when raise_exception then
    if sqlerrm <> 'rollback_closed_registration' then raise; end if;
  end;
  -- The absence bookkeeping is keyed by the addresses and is not touched by a team address.
  perform pg_temp.expect((select count(*) from mailbox_group_absence where tenant_id = v_t), 0,
    'a team address leaves no group absence row');

  -- ── 8. The list (phase 3) ──────────────────────────────────────────────────
  -- Open here: deals@ (pending, a 30 day window), adopt@ and archive@. default@ was closed above.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_list(v_md), '42501:not_available', 'an MD who is not an admin cannot list');
  perform pg_temp.expect_text(pg_temp.try_list(v_cco), '42501:not_available', 'nor can the CCO');
  perform pg_temp.expect_text(pg_temp.try_list(gen_random_uuid()), '42501:not_available', 'nor an unknown user');
  perform pg_temp.act_as_none();
  v_res := null;
  begin perform discovery_team_mailboxes();
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_available', 'nor a request with no session');
  v_list := pg_temp.list_as(v_oadmin);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect(jsonb_array_length(v_list), 0, 'another tenant''s admin lists none of this firm''s registrations');

  set local role authenticated;
  v_list := pg_temp.list_as(v_admin2);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect(jsonb_array_length(v_list), 3, 'any admin of the firm lists its three open registrations');
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_list) e where e ->> 'address' like 'default@%'), 0,
    'a closed registration is not listed');
  perform pg_temp.expect_text(
    (select jsonb_agg(e ->> 'id' order by ord) from jsonb_array_elements(v_list) with ordinality t(e, ord))::text,
    (select jsonb_agg(id::text order by connected_at, id) from team_mailboxes
      where tenant_id = v_t and disconnected_at is null)::text,
    'oldest first, ties by id');
  v_entry := pg_temp.entry(v_list, 'deals@tm.example');
  perform pg_temp.expect_text(v_entry ->> 'id', v_tm_deals::text, 'the entry carries the registration id');
  perform pg_temp.expect_text(v_entry ->> 'provider', 'google', 'and the provider');
  perform pg_temp.expect_text(v_entry ->> 'checkStatus', 'pending', 'and the check status');
  perform pg_temp.expect_text(v_entry ->> 'checkReason', null, 'with no reason yet');
  perform pg_temp.expect_text(v_entry ->> 'checkedAt', null, 'and no check time');
  perform pg_temp.expect_text(v_entry ->> 'lastCheckError', null, 'and no transient error');
  perform pg_temp.expect_text(((v_entry ->> 'connectedAt') is not null)::text, 'true', 'and when it was connected');
  perform pg_temp.expect_text(v_entry ->> 'sourceId', v_src_deals::text, 'and its source');
  perform pg_temp.expect_text(v_entry ->> 'sourceStatus', 'active', 'with the source''s status');
  perform pg_temp.expect_text(v_entry ->> 'backfillSince', (v_today - 30)::text, 'and its window');
  perform pg_temp.expect_text(v_entry ->> 'removable', 'true', 'a pending registration with no mail is removable');
  perform pg_temp.expect_text(pg_temp.entry(v_list, 'adopt@tm.example') ->> 'sourceId', v_adopt::text,
    'an adopted source is the registration''s source');
  perform pg_temp.expect_text(pg_temp.entry(v_list, 'adopt@tm.example') ->> 'backfillSince', (v_today - 7)::text,
    'with the window it was adopted with');
  perform pg_temp.expect_text(pg_temp.entry(v_list, 'archive@tm.example') ->> 'sourceId',
    (select id::text from content_sources where team_mailbox_id = (pg_temp.entry(v_list, 'archive@tm.example') ->> 'id')::uuid),
    'a registration that replaced an archived source lists the fresh one');
  -- The list says nothing of the earlier holder's archived source.
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_list) e where e ->> 'sourceId' = v_arch::text), 0,
    'the archived source is not listed');

  -- A refused check with a transient error beside it, and a registration holding mail, and one that verified.
  update team_mailboxes set check_status = 'refused', check_reason = 'group', checked_at = now(),
         last_check_error = 'directory_error', last_check_error_at = now()
  where tenant_id = v_t and address = 'adopt@tm.example' and disconnected_at is null;
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'mail@tm.example', 1, v_today - 5);
  v_tm_mail := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_mail := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  v_out := pg_temp.connect_as(v_admin, 'verified@tm.example');
  v_tm_ver := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_out := pg_temp.connect_as(v_oadmin, 'deals@other.example');
  v_tm_other := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  reset role;
  perform pg_temp.act_as_none();
  insert into source_items (id, tenant_id, kind, content_hash) values (v_item2, v_t, 'message', 'tm-hash-2');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_item2, v_src_mail, 'pid-2');
  update team_mailboxes set check_status = 'verified', checked_at = now(), verified_at = now(), directory_user_id = 'dir-v'
  where id = v_tm_ver;

  set local role authenticated;
  v_list := pg_temp.list_as(v_admin);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect(jsonb_array_length(v_list), 5, 'five open registrations now');
  v_entry := pg_temp.entry(v_list, 'adopt@tm.example');
  perform pg_temp.expect_text(v_entry ->> 'checkStatus', 'refused', 'a refusal is listed');
  perform pg_temp.expect_text(v_entry ->> 'checkReason', 'group', 'with its reason');
  perform pg_temp.expect_text(((v_entry ->> 'checkedAt') is not null)::text, 'true', 'and when it was checked');
  perform pg_temp.expect_text(v_entry ->> 'lastCheckError', 'directory_error', 'and the transient error beside it');
  perform pg_temp.expect_text(v_entry ->> 'removable', 'true', 'a refusal that never verified is removable (deals@ was a group)');
  perform pg_temp.expect_text(pg_temp.entry(v_list, 'mail@tm.example') ->> 'removable', 'false',
    'a registration whose source holds mail is not removable');
  v_entry := pg_temp.entry(v_list, 'verified@tm.example');
  perform pg_temp.expect_text(v_entry ->> 'checkStatus', 'verified', 'a verified registration is listed as such');
  perform pg_temp.expect_text(v_entry ->> 'removable', 'true', 'and, holding no mail, is removable too (audit item 9)');
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_list) e where e ->> 'id' = v_tm_other::text), 0,
    'another tenant''s registration is not listed');
  perform pg_temp.expect_text((v_list::text !~ '~')::text, 'true', 'no archived address leaks into the list');

  set local role authenticated;
  v_list := pg_temp.list_as(v_oadmin);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect(jsonb_array_length(v_list), 1, 'another tenant''s admin lists their own registration');
  perform pg_temp.expect_text(v_list -> 0 ->> 'id', v_tm_other::text, 'and only it');

  -- ── 9. Remove (phase 3) ────────────────────────────────────────────────────
  -- Open here: deals@, adopt@ (refused, never verified), archive@, mail@ (holds mail), verified@.
  select count(*) into v_before from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_disconnected';
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_remove(v_md, v_tm_deals), '42501:not_available', 'an MD who is not an admin cannot remove');
  perform pg_temp.expect_text(pg_temp.try_remove(v_cco, v_tm_deals), '42501:not_available', 'nor can the CCO');
  perform pg_temp.expect_text(pg_temp.try_remove(gen_random_uuid(), v_tm_deals), '42501:not_available', 'nor an unknown user');
  perform pg_temp.expect_text(pg_temp.try_remove(v_oadmin, v_tm_deals), '42501:not_available',
    'nor another tenant''s admin, who learns nothing of the registration');
  perform pg_temp.expect_text(pg_temp.try_remove(v_admin, v_tm_other), '42501:not_available',
    'nor can this firm''s admin remove another tenant''s registration');
  perform pg_temp.expect_text(pg_temp.try_remove(v_admin, gen_random_uuid()), '42501:not_available', 'no such registration');
  perform pg_temp.act_as_none();
  v_res := null;
  begin perform discovery_remove_team_mailbox(v_tm_deals);
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_available', 'nor a request with no session');
  perform pg_temp.expect_text(pg_temp.try_remove(v_admin, v_tm_mail), '55000:not_removable', 'nor one whose source holds mail');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from team_mailboxes
    where id in (v_tm_deals, v_tm_ver, v_tm_mail, v_tm_other) and disconnected_at is null), 4, 'no refusal closed a registration');
  perform pg_temp.expect((select count(*) from content_sources
    where id in (v_src_deals, v_src_mail) and archived_at is null and status = 'active'), 2, 'and none archived a source');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_disconnected'),
    v_before, 'no refusal was audited as a disconnect');

  -- A verified registration that holds no mail is removable (audit item 9: a typo, an identity that changed),
  -- closed as no_mail. Rolled back, so verified@ stays open for what follows.
  begin
    set local role authenticated;
    perform pg_temp.expect_text(pg_temp.try_remove(v_admin, v_tm_ver), 'ok', 'a verified registration with no mail is removable');
    reset role;
    perform pg_temp.act_as_none();
    perform pg_temp.expect((select count(*) from team_mailboxes
      where id = v_tm_ver and disconnected_at is not null and disconnected_reason = 'no_mail'), 1,
      'it is closed as no_mail, not never_verified');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_disconnected'
      and detail ->> 'teamMailboxId' = v_tm_ver::text and detail ->> 'reason' = 'no_mail' and detail::text !~ '@'), 1,
      'and audited with that reason, ids only');
    raise exception 'rollback_remove_verified';
  exception when raise_exception then
    if sqlerrm <> 'rollback_remove_verified' then raise; end if;
  end;

  -- A never-verified registration with no mail: closed by any admin of the firm, its source archived.
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'remove@tm.example', 1, v_today - 10);
  reset role;
  perform pg_temp.act_as_none();
  v_tm_rm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src_rm := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'remove@tm.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    'team_mailbox_unverified', 'the guard refused the new source and remembers why');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = 'remove@tm.example'), 1,
    'the refusal is held in the guard state');
  set local role authenticated;
  v_out := pg_temp.remove_as(v_admin2, v_tm_rm);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_out ->> 'id', v_tm_rm::text, 'remove names the registration');
  perform pg_temp.expect_text(v_out ->> 'sourceId', v_src_rm::text, 'and its source');
  perform pg_temp.expect_text(v_out ->> 'removed', 'true', 'and says it is removed');
  perform pg_temp.expect((select count(*) from team_mailboxes
    where id = v_tm_rm and disconnected_at is not null and disconnected_by = v_admin2
      and disconnected_reason = 'never_verified'), 1, 'the registration is closed by the admin who removed it, never_verified');
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_src_rm and address like 'remove@tm.example~%' and status = 'paused' and archived_at is not null
      and archived_from_address = 'remove@tm.example' and team_mailbox_id = v_tm_rm and owner_user_id is null), 1,
    'the source is renamed, paused and stamped, and keeps its registration');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_disconnected'
    and actor_id = v_admin2 and actor_type = 'user'
    and detail = jsonb_build_object('teamMailboxId', v_tm_rm, 'sourceId', v_src_rm, 'reason', 'never_verified')
    and detail::text !~ '@'), 1, 'one disconnect row: ids and the fixed reason, no address');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_source_archived'
    and detail ->> 'sourceId' = v_src_rm::text), 0, 'the archive is part of the disconnect row, not a second one');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = 'remove@tm.example'), 0,
    'the guard''s last refusal for the address is forgotten');
  set local role authenticated;
  v_list := pg_temp.list_as(v_admin);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_list) e where e ->> 'id' = v_tm_rm::text), 0,
    'a removed registration is no longer listed');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_remove(v_admin, v_tm_rm), '42501:not_available', 'removing it again finds nothing');
  reset role;

  -- The address is free again: connecting it registers anew, with a fresh source.
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'remove@tm.example', 1, v_today - 2);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_out ->> 'created', 'true', 'a removed address can be connected again');
  perform pg_temp.expect_text(((v_out -> 'teamMailbox' ->> 'id')::uuid <> v_tm_rm)::text, 'true', 'as a new registration');
  perform pg_temp.expect_text(((v_out -> 'teamMailbox' ->> 'sourceId')::uuid <> v_src_rm)::text, 'true', 'with a fresh source');
  perform pg_temp.expect((select count(*) from content_sources
    where team_mailbox_id = (v_out -> 'teamMailbox' ->> 'id')::uuid and address = 'remove@tm.example'
      and backfill_since = v_today - 2 and status = 'active' and archived_at is null), 1, 'that carries the new window');

  -- The refused group: deals@ turned out to be a Google Group, so the admin removes the registration.
  select id into v_tm_rm from team_mailboxes where tenant_id = v_t and address = 'adopt@tm.example' and disconnected_at is null;
  set local role authenticated;
  v_out := pg_temp.remove_as(v_admin, v_tm_rm);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_out ->> 'sourceId', v_adopt::text, 'removing a refused registration archives the adopted source');
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_adopt and address like 'adopt@tm.example~%' and status = 'paused' and archived_at is not null), 1,
    'which is renamed and paused');
  perform pg_temp.expect((select count(*) from team_mailboxes where id = v_tm_rm and disconnected_reason = 'never_verified'), 1,
    'and the registration is closed');

  -- ── The audit trail of the whole run says nothing of a team address ────────
  select count(*) into v_n from audit_log
  where tenant_id = v_t and action in ('discovery.team_mailbox_connected', 'discovery.mailbox_source_archived')
    and detail::text ~ '@';
  perform pg_temp.expect(v_n, 0, 'no connect or archive row carries an address');
  select count(*) into v_n from audit_log
  where tenant_id = v_t and detail::text ~* 'deals@|archive@|adopt@';
  perform pg_temp.expect(v_n, 0, 'no audit row of the run names a team address (default@ was freed by its close, above)');
end
$$;

-- ── 10. The worker's address check (phase 5) ───────────────────────────────
-- The due test as text, for the boundary cases.
create function pg_temp.due_of(p_src uuid)
returns text language sql as $$
  select (discovery_team_mailbox_check_due(p_src) ->> 'due');
$$;

do $$
declare
  v_t      uuid := gen_random_uuid();
  v_b      uuid := gen_random_uuid();
  v_admin  uuid := gen_random_uuid();
  v_out    jsonb;
  v_tm1    uuid;   -- deals@: the registration the scenario walks through
  v_src1   uuid;
  v_tm2    uuid;   -- refuse@: never verified
  v_src2   uuid;
  v_tm3    uuid;   -- closed@: closed before any answer
  v_src3   uuid;
  v_src_p  uuid;   -- a person's source
  v_res    jsonb;
  v_row    team_mailboxes%rowtype;
  v_n      bigint;
  v_sql    text;
  v_err    text;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'chk-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin'));
  update users set status = 'active', is_external = false where tenant_id = v_t;
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'Check Bank', 'bank');
  -- The bank's only active user, so its director (company_has_director refuses a company of members only).
  update users set company_id = v_b, company_role = 'director', firm_role = 'admin' where id = v_admin;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'chk.example', 'dwd-reader@proj-3.iam.gserviceaccount.com', '323456789012345678',
     'dir-reader@proj-3.iam.gserviceaccount.com', 'conductia-ingest@chk.example', v_b, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'person@chk.example', v_admin, 'google') returning id into v_src_p;

  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals@chk.example', 1, (now() at time zone 'utc')::date - 30);
  v_tm1 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src1 := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  v_out := pg_temp.connect_as(v_admin, 'refuse@chk.example');
  v_tm2 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src2 := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  v_out := pg_temp.connect_as(v_admin, 'closed@chk.example');
  v_tm3 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src3 := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  reset role;
  perform pg_temp.act_as_none();

  -- ── 10a. Grants: the service role's alone ────────────────────────────────
  if not has_function_privilege('service_role', 'public.discovery_team_mailbox_check_due(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.discovery_record_team_mailbox_check(uuid,text,text,text)', 'EXECUTE') then
    raise exception 'FAIL: the service role must execute the team inbox check functions';
  end if;
  if has_function_privilege('anon', 'public.discovery_team_mailbox_check_due(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.discovery_team_mailbox_check_due(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.discovery_record_team_mailbox_check(uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.discovery_record_team_mailbox_check(uuid,text,text,text)', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid in ('public.discovery_team_mailbox_check_due(uuid)'::regprocedure,
                                'public.discovery_record_team_mailbox_check(uuid,text,text,text)'::regprocedure)
                  and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'FAIL: a team inbox check function is executable by anon, authenticated or PUBLIC';
  end if;
  if (select count(*) from pg_proc p
      where p.oid in ('public.discovery_team_mailbox_check_due(uuid)'::regprocedure,
                      'public.discovery_record_team_mailbox_check(uuid,text,text,text)'::regprocedure)
        and p.prosecdef and coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']) <> 2 then
    raise exception 'FAIL: the team inbox check functions must be definers pinned to public, pg_temp';
  end if;
  set local role authenticated;
  v_err := pg_temp.try_sql(format('select discovery_team_mailbox_check_due(%L)', v_src1));
  perform pg_temp.expect_text(v_err, '42501:permission denied for function discovery_team_mailbox_check_due',
    'a signed-in role cannot ask whether a check is due');
  v_err := pg_temp.try_sql(format('select discovery_record_team_mailbox_check(%L, %L, null, %L)', v_tm1, 'verified', 'dir-1'));
  perform pg_temp.expect_text(v_err, '42501:permission denied for function discovery_record_team_mailbox_check',
    'a signed-in role cannot record a check');
  reset role;

  -- ── 10b. When a check is due ─────────────────────────────────────────────
  v_res := discovery_team_mailbox_check_due(v_src1);
  perform pg_temp.expect_text(v_res ->> 'due', 'true', 'a registration never checked is due');
  perform pg_temp.expect_text(v_res ->> 'teamMailboxId', v_tm1::text, 'and names the registration');
  perform pg_temp.expect_text(v_res ->> 'address', 'deals@chk.example', 'and the address to verify');
  perform pg_temp.expect_text(v_res ->> 'pinnedId', null, 'with nothing pinned yet');

  -- pending: retried once the last attempt is more than 4 minutes old.
  update team_mailboxes set checked_at = now() - interval '3 minutes 59 seconds' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'false', 'pending, tried 3m59s ago: not due');
  update team_mailboxes set checked_at = now() - interval '4 minutes' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'false', 'pending, tried exactly 4m ago: not due (strictly older)');
  update team_mailboxes set checked_at = now() - interval '4 minutes 1 second' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'true', 'pending, tried 4m1s ago: due');

  -- refused: the same rule.
  update team_mailboxes set check_status = 'refused', check_reason = 'group', checked_at = now() - interval '3 minutes' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'false', 'refused, tried 3m ago: not due');
  update team_mailboxes set checked_at = now() - interval '4 minutes 1 second' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'true', 'refused, tried 4m1s ago: due (retried every tick)');

  -- verified: renewed once the last success is more than 15 minutes old, whatever the last attempt.
  update team_mailboxes
     set check_status = 'verified', check_reason = null, verified_at = now() - interval '14 minutes 59 seconds',
         checked_at = now(), directory_user_id = 'dir-pin'
   where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'false', 'verified 14m59s ago: not due');
  update team_mailboxes set verified_at = now() - interval '15 minutes' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'false', 'verified exactly 15m ago: not due (strictly older)');
  update team_mailboxes set verified_at = now() - interval '15 minutes 1 second' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'true', 'verified 15m1s ago: due');
  perform pg_temp.expect_text(discovery_team_mailbox_check_due(v_src1) ->> 'pinnedId', 'dir-pin', 'and the pinned id comes with it');
  update team_mailboxes set verified_at = now() - interval '20 minutes', checked_at = now(),
         last_check_error = 'directory_error', last_check_error_at = now() where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'true',
    'a verified row whose last attempt failed just now is still due: it keys on the last success');

  -- no open registration: never due.
  v_res := discovery_team_mailbox_check_due(v_src_p);
  perform pg_temp.expect_text(v_res ->> 'due', 'false', 'a person''s source is never due');
  perform pg_temp.expect_text(v_res ->> 'teamMailboxId', null, 'and names no registration');
  perform pg_temp.expect_text(v_res ->> 'address', null, 'or address');
  perform pg_temp.expect_text(pg_temp.due_of(gen_random_uuid()), 'false', 'an unknown source is never due');
  update team_mailboxes set disconnected_at = now(), disconnected_by = v_admin, disconnected_reason = 'never_verified'
   where id = v_tm3;
  perform pg_temp.expect_text(pg_temp.due_of(v_src3), 'false', 'a source whose registration is closed is never due');

  -- ── 10c. Recording an outcome ────────────────────────────────────────────
  update team_mailboxes
     set check_status = 'pending', check_reason = null, checked_at = null, verified_at = null,
         directory_user_id = null, last_check_error = null, last_check_error_at = null
   where id = v_tm1;
  select count(*) into v_n from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_checked';
  perform pg_temp.expect(v_n, 0, 'no check has been audited yet');

  -- Arguments that cannot be a check are refused with nothing written.
  foreach v_sql in array array[
    format('select discovery_record_team_mailbox_check(null, %L, null, null)', 'error'),
    format('select discovery_record_team_mailbox_check(%L, %L, null, null)', v_tm1, 'bogus'),
    format('select discovery_record_team_mailbox_check(%L, null, null, null)', v_tm1),
    format('select discovery_record_team_mailbox_check(%L, %L, null, null)', v_tm1, 'verified'),
    format('select discovery_record_team_mailbox_check(%L, %L, %L, %L)', v_tm1, 'verified', 'group', 'dir-1'),
    format('select discovery_record_team_mailbox_check(%L, %L, null, %L)', v_tm1, 'verified', 'someone@chk.example'),
    format('select discovery_record_team_mailbox_check(%L, %L, null, %L)', v_tm1, 'verified', 'dir 1'),
    format('select discovery_record_team_mailbox_check(%L, %L, null, %L)', v_tm1, 'verified', ''),
    format('select discovery_record_team_mailbox_check(%L, %L, null, null)', v_tm1, 'refused'),
    format('select discovery_record_team_mailbox_check(%L, %L, %L, null)', v_tm1, 'refused', 'banana'),
    format('select discovery_record_team_mailbox_check(%L, %L, %L, null)', v_tm1, 'refused', 'directory_error'),
    format('select discovery_record_team_mailbox_check(%L, %L, %L, %L)', v_tm1, 'refused', 'group', 'dir-1'),
    format('select discovery_record_team_mailbox_check(%L, %L, null, null)', v_tm1, 'error'),
    format('select discovery_record_team_mailbox_check(%L, %L, %L, null)', v_tm1, 'error', 'group'),
    format('select discovery_record_team_mailbox_check(%L, %L, %L, %L)', v_tm1, 'error', 'directory_error', 'dir-1')
  ] loop
    perform pg_temp.expect_text(pg_temp.try_sql(v_sql), '22023:discovery_record_team_mailbox_check: bad arguments',
      'refused as bad arguments: ' || v_sql);
  end loop;
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text(v_row.check_status, 'pending', 'the refusals left the status');
  perform pg_temp.expect_text(v_row.checked_at::text, null, 'and the check time');
  select count(*) into v_n from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_checked';
  perform pg_temp.expect(v_n, 0, 'and audited nothing');

  -- Verified, first time: the id is pinned, the registration is Ready.
  v_res := discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-1');
  perform pg_temp.expect_text(v_res ->> 'recorded', 'true', 'verified is recorded');
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'as a change');
  perform pg_temp.expect_text(v_res ->> 'status', 'verified', 'to verified');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text(v_row.check_status, 'verified', 'the registration is verified');
  perform pg_temp.expect_text(v_row.check_reason, null, 'with no reason');
  perform pg_temp.expect_text((v_row.verified_at = now())::text, 'true', 'verified now');
  perform pg_temp.expect_text((v_row.checked_at = now())::text, 'true', 'and checked now');
  perform pg_temp.expect_text(v_row.directory_user_id, 'dir-1', 'the Directory id is pinned');
  perform pg_temp.expect_text(v_row.last_check_error, null, 'with no transient error');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_checked'), 1,
    'one check row');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked' and actor_type = 'service'
      and service_identity = 'discovery-worker' and actor_id is null
      and detail = jsonb_build_object('teamMailboxId', v_tm1, 'status', 'verified')), 1,
    'by the worker, with the registration id and the status only (no reason on a success)');

  -- The same answer again is not news; the success time moves.
  update team_mailboxes set verified_at = now() - interval '20 minutes', checked_at = now() - interval '20 minutes' where id = v_tm1;
  v_res := discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-1');
  perform pg_temp.expect_text(v_res ->> 'changed', 'false', 'a repeated success is not a change');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text((v_row.verified_at = now())::text, 'true', 'but renews the success time');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_checked'), 1,
    'and is not audited');

  -- A transient error leaves Ready alone.
  update team_mailboxes set verified_at = now() - interval '20 minutes', checked_at = now() - interval '1 hour' where id = v_tm1;
  v_res := discovery_record_team_mailbox_check(v_tm1, 'error', 'directory_error', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'false', 'a transient error is not a change');
  perform pg_temp.expect_text(v_res ->> 'status', 'verified', 'the status is still verified');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text(v_row.check_status, 'verified', 'Ready stays Ready');
  perform pg_temp.expect_text((v_row.verified_at = now() - interval '20 minutes')::text, 'true', 'with the success time it had');
  perform pg_temp.expect_text((v_row.checked_at = now())::text, 'true', 'the attempt is recorded');
  perform pg_temp.expect_text(v_row.last_check_error, 'directory_error', 'with the error beside the status');
  perform pg_temp.expect_text((v_row.last_check_error_at = now())::text, 'true', 'and when it happened');
  perform pg_temp.expect_text(v_row.directory_user_id, 'dir-1', 'and the pinned id kept');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_checked'), 1,
    'and is not audited');
  perform pg_temp.expect_text(pg_temp.due_of(v_src1), 'true', 'it is due again on the next tick');

  -- A success clears the error pair.
  v_res := discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-1');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text(v_row.last_check_error, null, 'a success clears the error');
  perform pg_temp.expect_text(v_row.last_check_error_at::text, null, 'and its time, as a pair');
  perform pg_temp.expect_text((v_row.verified_at = now())::text, 'true', 'and renews the success time');

  -- A definitive refusal flips Ready, keeps the id and the success time, and clears a transient error.
  perform discovery_record_team_mailbox_check(v_tm1, 'error', 'directory_error', null);
  v_res := discovery_record_team_mailbox_check(v_tm1, 'refused', 'alias', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'a refusal after a success is a change');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text(v_row.check_status, 'refused', 'the registration is refused');
  perform pg_temp.expect_text(v_row.check_reason, 'alias', 'with its reason');
  perform pg_temp.expect_text(v_row.directory_user_id, 'dir-1', 'the pinned id is kept across the refusal');
  perform pg_temp.expect_text((v_row.verified_at is not null)::text, 'true', 'and so is the success time');
  perform pg_temp.expect_text(v_row.last_check_error, null, 'a definitive answer clears the transient error');
  perform pg_temp.expect_text(v_row.last_check_error_at::text, null, 'and its time, as a pair');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked'
      and detail = jsonb_build_object('teamMailboxId', v_tm1, 'status', 'refused', 'reason', 'alias')), 1,
    'the refusal is audited with its reason');

  -- The same refusal again: no new row; a different reason: a new row.
  update team_mailboxes set checked_at = now() - interval '1 hour' where id = v_tm1;
  v_res := discovery_record_team_mailbox_check(v_tm1, 'refused', 'alias', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'false', 'the same refusal is not a change');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text((v_row.checked_at = now())::text, 'true', 'though the attempt is recorded');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_checked'), 2,
    'and not audited again');
  v_res := discovery_record_team_mailbox_check(v_tm1, 'refused', 'group', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'a different reason is a change');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_checked'), 3,
    'and audited');

  -- An answer for another account than the pinned one is an identity change, whatever the caller said.
  v_res := discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-2');
  perform pg_temp.expect_text(v_res ->> 'status', 'refused', 'a different Directory id is refused');
  perform pg_temp.expect_text(v_res ->> 'reason', 'identity_changed', 'as identity_changed');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text(v_row.check_reason, 'identity_changed', 'on the registration');
  perform pg_temp.expect_text(v_row.directory_user_id, 'dir-1', 'and the pin does not move');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked'
      and detail = jsonb_build_object('teamMailboxId', v_tm1, 'status', 'refused', 'reason', 'identity_changed')), 1,
    'and is audited');

  -- The pinned account answers again: Ready, with the reason cleared.
  v_res := discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-1');
  perform pg_temp.expect_text(v_res ->> 'status', 'verified', 'the pinned id verifies again');
  select * into v_row from team_mailboxes where id = v_tm1;
  perform pg_temp.expect_text(v_row.check_status, 'verified', 'Ready');
  perform pg_temp.expect_text(v_row.check_reason, null, 'with the reason cleared');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked'
      and detail = jsonb_build_object('teamMailboxId', v_tm1, 'status', 'verified')), 2,
    'and audited as a second verification');

  -- A registration that has not verified yet: an error leaves it pending; a refusal leaves no success time;
  -- the first success pins the id.
  v_res := discovery_record_team_mailbox_check(v_tm2, 'error', 'directory_error', null);
  select * into v_row from team_mailboxes where id = v_tm2;
  perform pg_temp.expect_text(v_row.check_status, 'pending', 'a transient error leaves a pending registration pending');
  perform pg_temp.expect_text(v_row.check_reason, null, 'with no reason');
  perform pg_temp.expect_text((v_row.checked_at = now())::text, 'true', 'it records the attempt');
  perform pg_temp.expect_text(v_row.last_check_error, 'directory_error', 'and the error');
  perform pg_temp.expect_text(v_row.verified_at::text, null, 'there is no success time');
  perform pg_temp.expect_text(pg_temp.due_of(v_src2), 'false', 'and a retry is not due until it is 4 minutes old');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked' and detail ->> 'teamMailboxId' = v_tm2::text), 0,
    'an error on a pending registration is not audited');
  perform discovery_record_team_mailbox_check(v_tm2, 'refused', 'directory_denied', null);
  select * into v_row from team_mailboxes where id = v_tm2;
  perform pg_temp.expect_text(v_row.check_status, 'refused', 'a definitive refusal flips pending to refused');
  perform pg_temp.expect_text(v_row.check_reason, 'directory_denied', 'with its reason');
  perform pg_temp.expect_text(v_row.verified_at::text, null, 'still no success time');
  perform pg_temp.expect_text(v_row.directory_user_id, null, 'and nothing pinned');
  perform pg_temp.expect_text(v_row.last_check_error, null, 'the transient error is cleared');
  perform pg_temp.expect_text(
    (select (e ->> 'removable') from jsonb_array_elements(pg_temp.list_as(v_admin)) e where e ->> 'address' = 'refuse@chk.example'),
    'true', 'a refused registration that never verified is still removable');
  perform pg_temp.act_as_none();
  perform discovery_record_team_mailbox_check(v_tm2, 'verified', null, 'dir-9');
  select * into v_row from team_mailboxes where id = v_tm2;
  perform pg_temp.expect_text(v_row.check_status, 'verified', 'granting the directory read turns a refusal Ready on its own');
  perform pg_temp.expect_text(v_row.directory_user_id, 'dir-9', 'and pins the id (it was null)');
  perform pg_temp.expect_text(v_row.check_reason, null, 'with the reason cleared');

  -- A closed registration and an unknown id record nothing.
  v_res := discovery_record_team_mailbox_check(v_tm3, 'verified', null, 'dir-3');
  perform pg_temp.expect_text(v_res ->> 'recorded', 'false', 'a closed registration records nothing');
  select * into v_row from team_mailboxes where id = v_tm3;
  perform pg_temp.expect_text(v_row.check_status, 'pending', 'and stays as it was');
  perform pg_temp.expect_text(v_row.verified_at::text, null, 'with no success time');
  perform pg_temp.expect_text(v_row.directory_user_id, null, 'or pin');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked' and detail ->> 'teamMailboxId' = v_tm3::text), 0,
    'and audits nothing');
  v_res := discovery_record_team_mailbox_check(gen_random_uuid(), 'verified', null, 'dir-x');
  perform pg_temp.expect_text(v_res ->> 'recorded', 'false', 'an unknown registration records nothing');

  -- The service role runs both, as the worker does.
  set local role service_role;
  v_res := discovery_team_mailbox_check_due(v_src2);
  perform pg_temp.expect_text(v_res ->> 'teamMailboxId', v_tm2::text, 'the service role asks whether a check is due');
  v_res := discovery_record_team_mailbox_check(v_tm2, 'error', 'directory_error', null);
  reset role;
  perform pg_temp.expect_text(v_res ->> 'recorded', 'true', 'and records a check');

  -- ── 10d. The audit trail and the guard ───────────────────────────────────
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked'
      and (actor_type <> 'service' or service_identity is distinct from 'discovery-worker'
           or detail::text ~ '@' or detail::text ~* 'chk\.example'
           or (detail - 'teamMailboxId' - 'status' - 'reason') <> '{}'::jsonb)), 0,
    'every check row is the worker''s, with ids and fixed codes and no address');
  -- The registration was just confirmed (the pinned account answered again, above), so the guard now reads it
  -- for the worker's provider_read (phase 7; section 11 walks the whole matrix).
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'deals@chk.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    null, 'a team source confirmed just now is read by the guard');
end
$$;

-- ── 11. The guard's team branch (phase 7) ───────────────────────────────────
-- The verdict of one address as the worker asks it: mailbox_guard_verdict's default purpose is provider_read.
create function pg_temp.verdict_of(p_tenant uuid, p_address text)
returns text language sql as $$
  select mailbox_guard_verdict(p_tenant, p_address, 'google', false, null);
$$;

-- The guard as a caller asks it, returning the reason (or null).
create function pg_temp.guard_as(p_tenant uuid, p_address text, p_purpose text, p_owner uuid)
returns text language sql as $$
  select mailbox_guard_check(p_tenant, p_address, p_purpose, 'sql-test', true, p_owner, null, 'google');
$$;

do $$
declare
  v_t       uuid := gen_random_uuid();
  v_b       uuid := gen_random_uuid();
  v_ob      uuid := gen_random_uuid();
  v_admin   uuid := gen_random_uuid();
  v_md      uuid := gen_random_uuid();
  v_since   date := (now() at time zone 'utc')::date - 5;
  v_out     jsonb;
  v_tm      uuid;
  v_src     uuid;
  v_src_p   uuid;
  v_md_mail text := 'g-md@example.test';
  v_res_purpose text;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'g-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_md,    v_md_mail,              jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id = v_t;
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'Guard Bank', 'bank'), (v_ob, v_t, 'Other Guard Bank', 'bank');
  -- Director first: company_has_director refuses a bank of members only.
  update users set company_id = v_b, company_role = 'director' where id = v_admin;
  update users set company_id = v_b, company_role = 'member' where id = v_md;
  update users set firm_role = 'admin' where id = v_admin;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'gd.example', 'dwd-reader@proj-4.iam.gserviceaccount.com', '423456789012345678',
     'dir-reader@proj-4.iam.gserviceaccount.com', 'conductia-ingest@gd.example', v_b, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  -- A person's source on the same domain, for the personal path.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'person@gd.example', v_md, 'google') returning id into v_src_p;

  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals@gd.example', 1, v_since);
  reset role;
  perform pg_temp.act_as_none();
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;

  -- ── 11a. The view is the service role's alone ────────────────────────────
  if has_table_privilege('anon', 'public.allowed_team_mailboxes', 'select')
     or has_table_privilege('authenticated', 'public.allowed_team_mailboxes', 'select') then
    raise exception 'FAIL: anon or authenticated can read allowed_team_mailboxes';
  end if;
  perform pg_temp.expect_text(pg_temp.svc_privs('public.allowed_team_mailboxes'), 'SELECT', 'service_role: allowed_team_mailboxes, read only');
  set local role authenticated;
  perform pg_temp.expect_text(left(pg_temp.try_sql('select count(*) from allowed_team_mailboxes'), 5), '42501',
    'a signed-in role cannot read the view');
  reset role;
  -- The verdict and the guard keep the service role alone (the six-argument function replaced the five-argument one).
  perform pg_temp.expect((select count(*) from pg_proc where proname = 'mailbox_guard_verdict'), 1, 'one verdict function, not two');
  if has_function_privilege('authenticated', 'public.mailbox_guard_verdict(uuid,text,text,boolean,uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.mailbox_guard_verdict(uuid,text,text,boolean,uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.mailbox_guard_verdict(uuid,text,text,boolean,uuid,text)', 'EXECUTE') then
    raise exception 'FAIL: mailbox_guard_verdict must be executable by the service role alone';
  end if;
  if (select count(*) from pg_proc p
      where p.oid in ('public.mailbox_guard_verdict(uuid,text,text,boolean,uuid,text)'::regprocedure,
                      'public.mailbox_guard_check(uuid,text,text,text,boolean,uuid,text,text)'::regprocedure)
        and p.prosecdef and coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']) <> 2 then
    raise exception 'FAIL: the verdict and the guard must be definers pinned to public, pg_temp';
  end if;

  -- ── 11b. Pending, refused and confirmed ──────────────────────────────────
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_unverified', 'a pending registration is refused');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 0, 'and is not in the view');

  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'group', null);
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_unverified', 'a registration refused before it ever verified is refused');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 0, 'and is not in the view');

  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-1');
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'a registration confirmed just now is read');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t and address = 'deals@gd.example'
    and team_mailbox_id = v_tm and provider = 'google' and firm_company_id = v_b and verified_at = now()), 1,
    'it is in the view, once, as a Google inbox of the firm');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t and provider = 'microsoft'), 0,
    'and not as a Microsoft one');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, 'deals@gd.example', 'microsoft', false, null), 'provider_mismatch',
    'a caller reading through another provider is refused before the team branch');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, 'deals@gd.example'), null, 'the provider is optional, as for a person');

  -- ── 11c. How old the confirmation is: the guard only ─────────────────────
  update team_mailboxes set verified_at = now() - interval '64 minutes 59 seconds' where id = v_tm;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'confirmed 64m59s ago: still read');
  update team_mailboxes set verified_at = now() - interval '65 minutes' where id = v_tm;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_unverified', 'confirmed exactly 65m ago: refused');
  update team_mailboxes set verified_at = now() - interval '66 minutes' where id = v_tm;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_unverified', 'confirmed 66m ago: refused');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t and address = 'deals@gd.example'), 1,
    'but the view is unchanged at 66 minutes: the clock is the guard''s, not the allowlist''s');
  perform pg_temp.expect_text(
    (select string_agg(a.address, ',') from allowed_team_mailboxes a where a.tenant_id = v_t),
    'deals@gd.example', 'so the group mirror still expects it, and drift does not flip');
  -- A transient error is recorded beside the old confirmation and cannot make it fresh.
  perform discovery_record_team_mailbox_check(v_tm, 'error', 'directory_error', null);
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_unverified', 'a directory error does not renew a stale confirmation');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 1, 'and does not take the inbox out of the view');
  -- A fresh confirmation with an error recorded after it is still read: Ready stays Ready.
  update team_mailboxes set verified_at = now() - interval '20 minutes' where id = v_tm;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'a 20 minute old confirmation with a recorded error is read');
  -- A definitive refusal after a confirmation takes it out of the view at once, whatever its age.
  perform discovery_record_team_mailbox_check(v_tm, 'refused', 'alias', null);
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 0, 'a refusal removes it from the view');
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_unverified', 'and the guard refuses it, though it was confirmed 20 minutes ago');
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-1');
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'a renewed confirmation is read again');

  -- ── 11d. The purposes, and the owner ─────────────────────────────────────
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), null,
    'the worker''s provider_read names no owner and is read');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'deals@gd.example', 'provider_read', 'sql-test', false, null, null, 'google'), null,
    'with or without the owner check');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', v_md), 'owner_mismatch',
    'a provider_read that names a person who is no reader is refused: nobody owns a team source');
  foreach v_res_purpose in array array['agent_tool', 'search', 'retrieval', 'export'] loop
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', v_res_purpose, null), 'owner_mismatch',
      v_res_purpose || ' with no owner is refused (review M-B)');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', v_res_purpose, v_md), 'owner_mismatch',
      v_res_purpose || ' on behalf of a person who is no reader of the inbox is refused (readers are section 14)');
  end loop;
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, 'deals@gd.example', 'google', true, v_md), 'owner_mismatch',
    'the member-facing verdict (the default purpose, a non-reader as owner) is refused too');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, 'deals@gd.example', 'google', true, null), null,
    'and the worker''s own question (the owner check on, nobody named) is read');

  -- ── 11d'. The ingest group (audit item 3): the admin's list names the worker's refusal ───────────────
  -- Live, the worker passes the group's verdict: a Ready inbox that is not a direct member is refused.
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'deals@gd.example', 'provider_read', 'sql-test', false, null, 'not_in_provider_group', 'google'),
    'not_in_provider_group', 'a verified inbox outside the ingest group is refused by the group''s verdict');
  set local role authenticated;
  v_out := pg_temp.list_as(v_admin);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text((select e ->> 'readRefusal' from jsonb_array_elements(v_out) e where e ->> 'address' = 'deals@gd.example'),
    'not_in_provider_group', 'the admin''s list says why it is not read');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), null,
    'added to the group, the next read is allowed');
  set local role authenticated;
  v_out := pg_temp.list_as(v_admin);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text((select e ->> 'readRefusal' from jsonb_array_elements(v_out) e where e ->> 'address' = 'deals@gd.example'),
    null, 'and the list no longer names a refusal');

  -- ── 11e. The refusal is audited once, forgotten on renewal, audited again when it goes stale again ─────
  update team_mailboxes set verified_at = now() - interval '70 minutes' where id = v_tm;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), 'team_mailbox_unverified', 'stale: refused');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), 'team_mailbox_unverified', 'and refused again');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm::text and detail ->> 'reason' = 'team_mailbox_unverified'
    and detail ->> 'purpose' = 'provider_read' and detail::text !~ '@'), 1, 'one refusal row, by registration, no address');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = 'deals@gd.example'
    and last_reason = 'team_mailbox_unverified'), 1, 'the guard state takes the reason');
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-1');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), null, 'renewed mid-pass: the guard allows the next page');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = 'deals@gd.example'
    and last_reason is null), 1, 'and forgets the refusal');
  update team_mailboxes set verified_at = now() - interval '70 minutes' where id = v_tm;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), 'team_mailbox_unverified', 'stale again: refused');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm::text and detail ->> 'reason' = 'team_mailbox_unverified'), 2,
    'and audited again, as a new refusal');
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-1');

  -- ── 11f. The source and the registration ────────────────────────────────
  update content_sources set status = 'paused' where id = v_src;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'source_paused', 'a paused source is refused');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 1, 'and still in the view: a pause hides nothing');
  update content_sources set status = 'active' where id = v_src;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'resumed: read');

  update google_reader_registrations set status = 'disabled' where tenant_id = v_t;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'registration_inactive', 'a disabled reader registration is refused');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 0, 'and out of the view');
  update google_reader_registrations set status = 'active' where tenant_id = v_t;

  update google_reader_registrations
     set workspace_domain = 'other-gd.example', allowlist_group = 'conductia-ingest@other-gd.example' where tenant_id = v_t;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'domain', 'a domain the registration no longer lists is refused');
  update google_reader_registrations
     set workspace_domain = 'gd.example', allowlist_group = 'conductia-ingest@gd.example' where tenant_id = v_t;
  update google_reader_registrations set firm_company_id = v_ob where tenant_id = v_t;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'domain', 'a registration that names another firm is refused');
  update google_reader_registrations set firm_company_id = v_b where tenant_id = v_t;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'put back: read');

  -- ── 11g. An address that became a person's ───────────────────────────────
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status)
  values (v_t, 'deals@gd.example', v_admin, v_b, 'member', 'pending', 'sent');
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_person', 'a pending invite to the address makes it a person''s');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 0, 'and takes it out of the view');
  delete from invites where tenant_id = v_t and email = 'deals@gd.example';
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'the invite gone: read');
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status, accepted_at, accepted_user_id)
  values (v_t, 'deals@gd.example', v_admin, v_b, 'member', 'accepted', 'sent', now(), v_md);
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_person', 'an accepted one too');
  delete from invites where tenant_id = v_t and email = 'deals@gd.example';
  update users set email = 'deals@gd.example' where id = v_md;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_person', 'a user with the address makes it a person''s');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), 'team_mailbox_person', 'and the guard says so');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = 'deals@gd.example'
    and last_reason = 'team_mailbox_person'), 1, 'the guard state takes that reason');
  update users set email = v_md_mail where id = v_md;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), null, 'the person gone: read');

  -- ── 11h. A personal source is judged as before ───────────────────────────
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'person@gd.example'), 'no_invite',
    'a personal source nobody opted in is refused by the personal path, as before');
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'ghost@gd.example'), 'no_source', 'and an address with no source by no_source');

  -- ── 11i. A closed registration ───────────────────────────────────────────
  update team_mailboxes set disconnected_at = now(), disconnected_by = v_admin, disconnected_reason = 'never_verified' where id = v_tm;
  perform pg_temp.expect_text(pg_temp.verdict_of(v_t, 'deals@gd.example'), 'team_mailbox_disconnected', 'a closed registration is refused');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t), 0, 'and is not in the view');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@gd.example', 'provider_read', null), 'team_mailbox_disconnected', 'and the guard says so');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = 'deals@gd.example'
    and last_reason = 'team_mailbox_disconnected'), 1, 'the guard state takes that reason too');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'address' = 'deals@gd.example'), 0, 'and no refusal of the run names the address');
end
$$;

-- ── 12. Members (phase 8) ───────────────────────────────────────────────────
-- 20261019150000_team_mailbox_members.sql. Helpers: the add and remove RPCs as a user, as a result or as an error.
create function pg_temp.add_member_as(p_user uuid, p_tm uuid, p_member uuid)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return discovery_add_team_mailbox_member(p_tm, p_member);
end;
$$;

create function pg_temp.try_add_member(p_user uuid, p_tm uuid, p_member uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform discovery_add_team_mailbox_member(p_tm, p_member);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

create function pg_temp.remove_member_as(p_user uuid, p_tm uuid, p_member uuid)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return discovery_remove_team_mailbox_member(p_tm, p_member);
end;
$$;

create function pg_temp.try_remove_member(p_user uuid, p_tm uuid, p_member uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform discovery_remove_team_mailbox_member(p_tm, p_member);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- The user ids of one key ('members' or 'eligible') of a list entry, sorted, comma separated.
create function pg_temp.ids_of(p_entry jsonb, p_key text)
returns text language sql as $$
  select coalesce(string_agg(e ->> 'userId', ',' order by e ->> 'userId'), '')
  from jsonb_array_elements(p_entry -> p_key) e;
$$;

-- The same for a list of uuids.
create function pg_temp.sorted_ids(p_ids uuid[])
returns text language sql as $$
  select coalesce(string_agg(x::text, ',' order by x::text), '') from unnest(p_ids) x;
$$;

-- The open members of an inbox, and the readers view's rows for it (both read as the table owner).
create function pg_temp.open_members(p_tm uuid)
returns text language sql as $$
  select coalesce(string_agg(user_id::text, ',' order by user_id::text), '')
  from team_mailbox_members where team_mailbox_id = p_tm and removed_at is null;
$$;

create function pg_temp.readers(p_tm uuid)
returns text language sql as $$
  select coalesce(string_agg(user_id::text, ',' order by user_id::text), '')
  from team_mailbox_readers where team_mailbox_id = p_tm;
$$;

-- Whether this session holds the tenant's discovery lock (discovery_lock_tenant's key). pg_locks shows a bigint
-- advisory key as two halves: the high one in classid, the low one in objid.
create function pg_temp.holds_tenant_lock(p_tenant uuid)
returns boolean language sql as $$
  select exists (
    select 1 from pg_locks
    where locktype = 'advisory' and pid = pg_backend_pid() and granted
      and (((classid::text::bigint) << 32) | (objid::text::bigint)) = hashtextextended('discovery_candidates:' || p_tenant::text, 0));
$$;

grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_o        uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();   -- the firm
  v_b2       uuid := gen_random_uuid();   -- another bank of the same tenant
  v_ob       uuid := gen_random_uuid();   -- another tenant's bank
  v_admin    uuid := gen_random_uuid();
  v_admin2   uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_storm    uuid := gen_random_uuid();   -- a non-admin MD
  v_bob      uuid := gen_random_uuid();
  v_promo    uuid := gen_random_uuid();   -- a member who is later promoted to firm admin
  v_lose1    uuid := gen_random_uuid();   -- members who lose their seat: moved, suspended, made external
  v_lose2    uuid := gen_random_uuid();
  v_lose3    uuid := gen_random_uuid();
  v_ext      uuid := gen_random_uuid();
  v_susp     uuid := gen_random_uuid();
  v_unseated uuid := gen_random_uuid();
  v_b2user   uuid := gen_random_uuid();
  v_oadmin   uuid := gen_random_uuid();
  v_ouser    uuid := gen_random_uuid();
  v_out      jsonb;
  v_m        jsonb;
  v_list     jsonb;
  v_entry    jsonb;
  v_tm       uuid;
  v_tm_o     uuid;
  v_tm2      uuid;
  v_tm3      uuid;
  v_res      text;
  v_n        bigint;
  v_open     uuid;
  v_closed   uuid;
  v_row      team_mailbox_members%rowtype;
  v_sql      text;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin,    'mm-admin@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_admin2,   'mm-admin2@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,      'mm-cco@example.test',      jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_storm,    'mm-storm@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_bob,      'mm-bob@example.test',      jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_promo,    'mm-promo@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_lose1,    'mm-lose1@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_lose2,    'mm-lose2@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_lose3,    'mm-lose3@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_ext,      'mm-ext@example.test',      jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_susp,     'mm-susp@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_unseated, 'mm-unseated@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_b2user,   'mm-b2user@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_oadmin,   'mm-oadmin@example.test',   jsonb_build_object('tenant_id', v_o, 'department', 'admin')),
    (v_ouser,    'mm-ouser@example.test',    jsonb_build_object('tenant_id', v_o, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_o);
  insert into companies (id, tenant_id, name, type) values
    (v_b, v_t, 'MM Bank', 'bank'), (v_b2, v_t, 'MM Other Bank', 'bank'), (v_ob, v_o, 'MM Foreign Bank', 'bank');
  -- Each bank's director first: company_has_director refuses a bank of members only. Nothing here reads
  -- company_role.
  update users set company_id = v_b, company_role = 'director' where id = v_admin;
  update users set company_id = v_b, company_role = 'member'
    where id in (v_admin2, v_cco, v_storm, v_bob, v_promo, v_lose1, v_lose2, v_lose3, v_ext, v_susp);
  update users set company_id = v_b2, company_role = 'director' where id = v_b2user;
  update users set company_id = v_ob, company_role = 'director' where id = v_oadmin;
  update users set company_id = v_ob, company_role = 'member' where id = v_ouser;
  update users set firm_role = 'admin' where id in (v_admin, v_admin2, v_oadmin);
  update users set firm_role = 'cco' where id = v_cco;
  update users set is_external = true where id = v_ext;
  update users set status = 'suspended' where id = v_susp;
  update users set display_name = 'Storm Duncan' where id = v_storm;

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'mm.example', 'dwd-reader@proj-8.iam.gserviceaccount.com', '823456789012345678',
     'dir-reader@proj-8.iam.gserviceaccount.com', 'conductia-ingest@mm.example', v_b, 'active', now()),
    (v_o, 'foreign-mm.example', 'dwd-reader@proj-9.iam.gserviceaccount.com', '923456789012345678',
     'dir-reader@proj-9.iam.gserviceaccount.com', 'conductia-ingest@foreign-mm.example', v_ob, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;

  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals@mm.example');
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_out := pg_temp.connect_as(v_oadmin, 'deals@foreign-mm.example');
  v_tm_o := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  reset role;
  perform pg_temp.act_as_none();

  -- ── 12a. Grants ──────────────────────────────────────────────────────────
  if not coalesce((select relrowsecurity from pg_class where oid = 'public.team_mailbox_members'::regclass), false) then
    raise exception 'FAIL: team_mailbox_members has no row level security';
  end if;
  perform pg_temp.expect((select count(*) from pg_policy where polrelid = 'public.team_mailbox_members'::regclass), 0,
    'team_mailbox_members has no policy');
  if has_table_privilege('anon', 'public.team_mailbox_members', 'select, insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'public.team_mailbox_members', 'select, insert, update, delete, truncate')
     or has_table_privilege('anon', 'public.team_mailbox_readers', 'select')
     or has_table_privilege('authenticated', 'public.team_mailbox_readers', 'select') then
    raise exception 'FAIL: anon or authenticated holds a privilege on the members table or the readers view';
  end if;
  perform pg_temp.expect_text(pg_temp.svc_privs('public.team_mailbox_members'), 'SELECT',
    'the service role reads the members table, nothing more');
  perform pg_temp.expect_text(pg_temp.svc_privs('public.team_mailbox_readers'), 'SELECT',
    'and the readers view, nothing more');
  set local role authenticated;
  perform pg_temp.expect_text(left(pg_temp.try_sql('select count(*) from team_mailbox_members'), 5), '42501',
    'a signed-in role cannot read the members');
  perform pg_temp.expect_text(left(pg_temp.try_sql('select count(*) from team_mailbox_readers'), 5), '42501',
    'nor the readers view');
  reset role;
  if not has_function_privilege('authenticated', 'public.discovery_add_team_mailbox_member(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.discovery_remove_team_mailbox_member(uuid,uuid)', 'EXECUTE') then
    raise exception 'FAIL: the member RPCs must be executable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.discovery_add_team_mailbox_member(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.discovery_remove_team_mailbox_member(uuid,uuid)', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid in ('public.discovery_add_team_mailbox_member(uuid,uuid)'::regprocedure,
                                'public.discovery_remove_team_mailbox_member(uuid,uuid)'::regprocedure)
                  and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'FAIL: a member RPC is executable by anon or PUBLIC';
  end if;
  if (select count(*) from pg_proc p
      where p.oid in ('public.discovery_add_team_mailbox_member(uuid,uuid)'::regprocedure,
                      'public.discovery_remove_team_mailbox_member(uuid,uuid)'::regprocedure,
                      'public.team_mailbox_members_audit()'::regprocedure,
                      'public.team_mailbox_members_close_on_seat_loss()'::regprocedure,
                      'public.team_mailbox_members_lock_on_seat_loss()'::regprocedure)
        and p.prosecdef and coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']) <> 5 then
    raise exception 'FAIL: the member RPCs and their definer triggers must be pinned to public, pg_temp';
  end if;
  -- Audit item 4: the seat-loss lock is a BEFORE row trigger on users (tgtype bit 2), so it runs ahead of every
  -- after-row trigger that writes audit, mailbox_consents_close_on_seat_loss included.
  if not exists (select 1 from pg_trigger t
                 where t.tgrelid = 'public.users'::regclass and t.tgname = 'team_mailbox_members_lock_on_seat_loss'
                   and not t.tgisinternal and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1 and (t.tgtype & 16) = 16) then
    raise exception 'FAIL: the seat-loss tenant lock must be a BEFORE UPDATE row trigger on users';
  end if;
  set local role anon;
  v_res := null;
  begin perform discovery_add_team_mailbox_member(gen_random_uuid(), gen_random_uuid());
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:permission denied for function discovery_add_team_mailbox_member',
    'anon cannot execute the add RPC, and it is the privilege that refuses, not the body');
  v_res := null;
  begin perform discovery_remove_team_mailbox_member(gen_random_uuid(), gen_random_uuid());
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:permission denied for function discovery_remove_team_mailbox_member',
    'anon cannot execute the remove RPC');
  reset role;

  -- ── 12b. Refusals, each writing nothing ──────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as_none();
  v_res := null;
  begin perform discovery_add_team_mailbox_member(v_tm, v_storm);
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_available', 'add: no session is refused');
  v_res := null;
  begin perform discovery_remove_team_mailbox_member(v_tm, v_storm);
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_available', 'remove: no session is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_storm, v_tm, v_bob), '42501:not_available',
    'add: an MD who is not an admin is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_cco, v_tm, v_bob), '42501:not_available', 'add: the CCO is not an admin');
  perform pg_temp.expect_text(pg_temp.try_add_member(gen_random_uuid(), v_tm, v_bob), '42501:not_available',
    'add: an unknown user is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_oadmin, v_tm, v_bob), '42501:not_available',
    'add: another tenant''s admin learns nothing of the inbox');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm_o, v_storm), '42501:not_available',
    'add: nor can this firm''s admin reach another tenant''s inbox');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, gen_random_uuid(), v_storm), '42501:not_available',
    'add: no such inbox');
  perform pg_temp.expect_text(pg_temp.try_remove_member(v_storm, v_tm, v_bob), '42501:not_available',
    'remove: an MD who is not an admin is refused');
  perform pg_temp.expect_text(pg_temp.try_remove_member(v_cco, v_tm, v_bob), '42501:not_available', 'remove: nor the CCO');
  perform pg_temp.expect_text(pg_temp.try_remove_member(v_oadmin, v_tm, v_bob), '42501:not_available',
    'remove: nor another tenant''s admin');
  perform pg_temp.expect_text(pg_temp.try_remove_member(v_admin, v_tm_o, v_storm), '42501:not_available',
    'remove: nor another tenant''s inbox');
  perform pg_temp.expect_text(pg_temp.try_remove_member(v_admin, gen_random_uuid(), v_storm), '42501:not_available',
    'remove: no such inbox');
  -- A person who cannot be a member: the other firm admin, the caller, an external, a suspended user, someone with no
  -- seat, another bank's colleague, another tenant's user, an unknown id, no id.
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_admin2), '22023:not_eligible_member', 'a firm admin is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_admin), '22023:not_eligible_member', 'self-add is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_ext), '22023:not_eligible_member', 'an external is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_susp), '22023:not_eligible_member', 'a suspended user is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_unseated), '22023:not_eligible_member',
    'someone with no seat is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_b2user), '22023:not_eligible_member',
    'a colleague of another bank is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_ouser), '22023:not_eligible_member',
    'another tenant''s user is refused');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_oadmin, v_tm_o, v_storm), '22023:not_eligible_member',
    'and so is this tenant''s user, by another tenant''s admin');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, gen_random_uuid()), '22023:not_eligible_member', 'an unknown user');
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, null), '22023:not_eligible_member', 'no user');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from team_mailbox_members where team_mailbox_id in (v_tm, v_tm_o)), 0,
    'no refusal wrote a membership');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id in (v_t, v_o) and action like 'discovery.team_mailbox_member%'), 0,
    'and none audited anything');

  -- ── 12c. Add ──────────────────────────────────────────────────────────────
  set local role authenticated;
  v_m := pg_temp.add_member_as(v_admin, v_tm, v_storm);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_m ->> 'added', 'true', 'the first add creates the membership');
  perform pg_temp.expect_text(v_m -> 'member' ->> 'userId', v_storm::text, 'and names the person');
  perform pg_temp.expect_text(v_m -> 'member' ->> 'name', 'Storm Duncan', 'by display name');
  perform pg_temp.expect_text(v_m -> 'member' ->> 'email', 'mm-storm@example.test', 'and email');
  perform pg_temp.expect_text(((v_m -> 'member' ->> 'addedAt') is not null)::text, 'true', 'and when');
  perform pg_temp.expect((select count(*) from team_mailbox_members
    where team_mailbox_id = v_tm and user_id = v_storm and added_by = v_admin
      and removed_at is null and removed_by is null and removed_reason is null), 1,
    'one open row, added by the admin');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.team_mailbox_member_added' and actor_type = 'user' and actor_id = v_admin
    and service_identity is null
    and detail = jsonb_build_object('teamMailboxId', v_tm, 'userId', v_storm)
    and detail::text !~ '@'), 1,
    'one audit row by the admin: the inbox and the person by id, no address');

  -- Again, by the other admin: nothing changes, nothing is audited.
  set local role authenticated;
  v_m := pg_temp.add_member_as(v_admin2, v_tm, v_storm);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_m ->> 'added', 'false', 'adding a member again is not an addition');
  perform pg_temp.expect_text(v_m -> 'member' ->> 'userId', v_storm::text, 'and returns the member');
  perform pg_temp.expect((select count(*) from team_mailbox_members where team_mailbox_id = v_tm and user_id = v_storm), 1,
    'no second row');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_member_added'), 1,
    'and no second audit row');

  set local role authenticated;
  perform pg_temp.add_member_as(v_admin, v_tm, v_bob);
  perform pg_temp.add_member_as(v_admin2, v_tm, v_promo);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.open_members(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'three open members; a pending inbox takes members too');
  perform pg_temp.expect_text(pg_temp.readers(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'and the readers view has the same three');

  -- ── 12d. The list ─────────────────────────────────────────────────────────
  set local role authenticated;
  v_list := pg_temp.list_as(v_admin2);
  reset role;
  perform pg_temp.act_as_none();
  v_entry := pg_temp.entry(v_list, 'deals@mm.example');
  perform pg_temp.expect_text(pg_temp.ids_of(v_entry, 'members'), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'the entry lists the open members');
  perform pg_temp.expect_text(pg_temp.ids_of(v_entry, 'eligible'),
    pg_temp.sorted_ids(array[v_storm, v_bob, v_promo, v_lose1, v_lose2, v_lose3, v_cco]),
    'and everyone who could be one: seated, active, internal colleagues of the firm who are not admins (members included)');
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_entry -> 'members') e
    where (e ->> 'addedAt') is not null
      and (e ->> 'email') = (select u.email from users u where u.id = (e ->> 'userId')::uuid)
      and (e ->> 'name') = (select coalesce(u.display_name, u.full_name) from users u where u.id = (e ->> 'userId')::uuid)), 3,
    'each member carries a name, an email and the time they were added');
  perform pg_temp.expect_text(
    (select e ->> 'name' from jsonb_array_elements(v_entry -> 'eligible') e where e ->> 'userId' = v_storm::text),
    'Storm Duncan', 'an eligible person is named by display name');
  perform pg_temp.expect_text((v_list::text !~ 'mm-oadmin|mm-ouser|mm-admin|mm-ext|mm-susp|mm-unseated|mm-b2user')::text, 'true',
    'no admin, external, suspended, unseated, other-bank or other-tenant user is listed');
  set local role authenticated;
  v_list := pg_temp.list_as(v_oadmin);
  reset role;
  perform pg_temp.act_as_none();
  v_entry := pg_temp.entry(v_list, 'deals@foreign-mm.example');
  perform pg_temp.expect_text(pg_temp.ids_of(v_entry, 'members'), '', 'another tenant''s inbox has no members');
  perform pg_temp.expect_text(pg_temp.ids_of(v_entry, 'eligible'), v_ouser::text, 'and offers its own people only');
  perform pg_temp.expect_text(jsonb_typeof(v_entry -> 'members'), 'array', 'members is an array even when empty');

  -- ── 12e. Remove ───────────────────────────────────────────────────────────
  set local role authenticated;
  v_m := pg_temp.remove_member_as(v_admin2, v_tm, v_bob);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_m ->> 'removed', 'true', 'the other admin removes a member');
  select * into v_row from team_mailbox_members where team_mailbox_id = v_tm and user_id = v_bob;
  perform pg_temp.expect_text((v_row.removed_at = now())::text, 'true', 'the row is closed now');
  perform pg_temp.expect_text(v_row.removed_by::text, v_admin2::text, 'by the admin who removed');
  perform pg_temp.expect_text(v_row.removed_reason, 'removed', 'with the reason removed');
  perform pg_temp.expect_text(v_row.added_by::text, v_admin::text, 'and the row still says who added them');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.team_mailbox_member_removed' and actor_type = 'user' and actor_id = v_admin2
    and detail = jsonb_build_object('teamMailboxId', v_tm, 'userId', v_bob, 'reason', 'removed')
    and detail::text !~ '@'), 1, 'one audit row: ids and the fixed reason');
  perform pg_temp.expect_text(pg_temp.readers(v_tm), pg_temp.sorted_ids(array[v_storm, v_promo]), 'the readers view drops them at once');

  set local role authenticated;
  v_m := pg_temp.remove_member_as(v_admin, v_tm, v_bob);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_m ->> 'removed', 'false', 'removing them again changes nothing');
  set local role authenticated;
  v_m := pg_temp.remove_member_as(v_admin, v_tm, v_cco);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_m ->> 'removed', 'false', 'nor does removing someone who never was a member');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_member_removed'), 1,
    'and neither is audited');

  -- Added again: a new row; the closed one stays.
  set local role authenticated;
  v_m := pg_temp.add_member_as(v_admin, v_tm, v_bob);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_m ->> 'added', 'true', 'a removed person can be added again');
  perform pg_temp.expect((select count(*) from team_mailbox_members where team_mailbox_id = v_tm and user_id = v_bob), 2,
    'as a new row beside the closed one');
  perform pg_temp.expect((select count(*) from team_mailbox_members
    where team_mailbox_id = v_tm and user_id = v_bob and removed_at is null), 1, 'only one of them open');

  -- ── 12f. The rows are append-only, and the pairs hold ────────────────────
  select id into v_closed from team_mailbox_members where team_mailbox_id = v_tm and user_id = v_bob and removed_at is not null;
  select id into v_open from team_mailbox_members where team_mailbox_id = v_tm and user_id = v_storm and removed_at is null;
  foreach v_sql in array array[
    format('update team_mailbox_members set user_id = %L where id = %L', v_storm, v_closed),
    format('update team_mailbox_members set added_by = %L where id = %L', v_admin2, v_open),
    format('update team_mailbox_members set team_mailbox_id = %L where id = %L', v_tm_o, v_open),
    format('update team_mailbox_members set added_at = now() - interval ''1 day'' where id = %L', v_open),
    format('update team_mailbox_members set removed_reason = ''disconnected'' where id = %L', v_closed),
    format('update team_mailbox_members set removed_at = null, removed_by = null, removed_reason = null where id = %L', v_closed)
  ] loop
    perform pg_temp.expect_text(pg_temp.try_sql(v_sql), 'P0001:team mailbox members are append-only', 'append-only: ' || v_sql);
  end loop;
  foreach v_sql in array array[
    -- a removal by an admin names the admin, and a removal says why
    format('update team_mailbox_members set removed_at = now(), removed_reason = ''removed'' where id = %L', v_open),
    format('update team_mailbox_members set removed_at = now(), removed_reason = ''bogus'', removed_by = %L where id = %L', v_admin, v_open),
    format('update team_mailbox_members set removed_at = now() where id = %L', v_open),
    format('update team_mailbox_members set removed_reason = ''removed'', removed_by = %L where id = %L', v_admin, v_open),
    format('update team_mailbox_members set removed_by = %L where id = %L', v_admin, v_open),
    -- a seat lost is no admin's act
    format('update team_mailbox_members set removed_at = now(), removed_reason = ''seat_lost'', removed_by = %L where id = %L', v_admin, v_open)
  ] loop
    perform pg_temp.expect_text(left(pg_temp.try_sql(v_sql), 5), '23514', 'check violated: ' || v_sql);
  end loop;
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'insert into team_mailbox_members (team_mailbox_id, user_id, added_by) values (%L, %L, %L)', v_tm, v_storm, v_admin)), 5), '23505',
    'one open row per person and inbox');
  perform pg_temp.expect_text(pg_temp.open_members(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'none of those changed a membership');

  -- ── 12g. Losing the seat closes the membership ───────────────────────────
  set local role authenticated;
  perform pg_temp.add_member_as(v_admin, v_tm, v_lose1);
  perform pg_temp.add_member_as(v_admin, v_tm, v_lose2);
  perform pg_temp.add_member_as(v_admin, v_tm, v_lose3);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from team_mailbox_members where team_mailbox_id = v_tm and removed_at is null), 6,
    'six open members before the seats go');
  select count(*) into v_n from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_member_removed';
  update users set company_id = v_b2 where id = v_lose1;                 -- moved to another bank
  update users set status = 'suspended' where id = v_lose2;              -- suspended
  update users set is_external = true where id = v_lose3;                -- made external
  perform pg_temp.expect((select count(*) from team_mailbox_members
    where user_id in (v_lose1, v_lose2, v_lose3) and removed_at = now() and removed_reason = 'seat_lost' and removed_by is null), 3,
    'each is closed with seat_lost, by nobody');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.team_mailbox_member_removed' and actor_type = 'service' and service_identity = 'team-mailbox'
    and actor_id is null and detail ->> 'reason' = 'seat_lost' and detail ->> 'teamMailboxId' = v_tm::text
    and (detail - 'teamMailboxId' - 'userId' - 'reason') = '{}'::jsonb and detail::text !~ '@'), 3,
    'and audited by the service, with ids and the fixed reason');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_member_removed'),
    v_n + 3, 'three new removal rows, no more');
  perform pg_temp.expect_text(pg_temp.open_members(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]), 'the other members are untouched');
  perform pg_temp.expect_text(pg_temp.readers(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]), 'and so are the readers');
  -- Back in the firm: a re-seat does not revive the old membership.
  update users set company_id = v_b where id = v_lose1;
  update users set status = 'active' where id = v_lose2;
  update users set is_external = false where id = v_lose3;
  perform pg_temp.expect_text(pg_temp.open_members(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'a person back in the firm is not a member again until an admin adds them');
  perform pg_temp.expect_text(pg_temp.readers(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]), 'nor a reader');
  -- A change of role inside the firm keeps the membership.
  update users set company_role = 'director' where id = v_storm;
  perform pg_temp.expect_text(pg_temp.open_members(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'a role change inside the firm keeps the membership');
  -- Someone who never was a member losing their seat writes nothing.
  update users set status = 'suspended' where id = v_cco;
  update users set status = 'active' where id = v_cco;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_member_removed'),
    v_n + 3, 'a non-member losing a seat is not audited');

  -- ── 12h. A promotion to firm admin: the view is the truth ────────────────
  update users set firm_role = 'admin' where id = v_promo;
  perform pg_temp.expect_text(pg_temp.readers(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob]),
    'a member promoted to firm admin stops being a reader on the next read');
  perform pg_temp.expect_text(pg_temp.open_members(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'though the row is still open (no trigger closes it)');
  set local role authenticated;
  v_list := pg_temp.list_as(v_admin);
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm, v_promo), '22023:not_eligible_member',
    'and they cannot be added again while they are an admin');
  reset role;
  perform pg_temp.act_as_none();
  v_entry := pg_temp.entry(v_list, 'deals@mm.example');
  perform pg_temp.expect_text(pg_temp.ids_of(v_entry, 'members'), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'the list still shows them as a member, for the admin to remove');
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_entry -> 'eligible') e where e ->> 'userId' = v_promo::text), 0,
    'but not as someone who could be added');
  update users set firm_role = null where id = v_promo;
  perform pg_temp.expect_text(pg_temp.readers(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob, v_promo]),
    'demoted, they read again: the view decides on every read');
  set local role authenticated;
  perform pg_temp.remove_member_as(v_admin, v_tm, v_promo);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.readers(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob]), 'removed for good');

  -- ── 12i. Removing the inbox closes its members ───────────────────────────
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals2@mm.example');
  v_tm2 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  perform pg_temp.add_member_as(v_admin, v_tm2, v_storm);
  perform pg_temp.add_member_as(v_admin, v_tm2, v_bob);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.readers(v_tm2), pg_temp.sorted_ids(array[v_storm, v_bob]),
    'a person can be a member of more than one inbox');
  set local role authenticated;
  perform pg_temp.remove_as(v_admin2, v_tm2);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from team_mailboxes where id = v_tm2 and disconnected_at is not null), 1,
    'the empty inbox is removed');
  perform pg_temp.expect((select count(*) from team_mailbox_members
    where team_mailbox_id = v_tm2 and removed_at = now() and removed_by = v_admin2 and removed_reason = 'disconnected'), 2,
    'and its two members are closed with disconnected, by the admin who removed it');
  perform pg_temp.expect_text(pg_temp.open_members(v_tm2), '', 'none left open');
  perform pg_temp.expect_text(pg_temp.readers(v_tm2), '', 'no readers of a closed inbox');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.team_mailbox_member_removed' and actor_type = 'user' and actor_id = v_admin2
    and detail ->> 'teamMailboxId' = v_tm2::text and detail ->> 'reason' = 'disconnected'
    and (detail - 'teamMailboxId' - 'userId' - 'reason') = '{}'::jsonb), 2,
    'each closing is audited with ids and the fixed reason');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.team_mailbox_disconnected' and detail ->> 'teamMailboxId' = v_tm2::text), 1,
    'beside the one disconnect row');
  perform pg_temp.expect_text(pg_temp.open_members(v_tm), pg_temp.sorted_ids(array[v_storm, v_bob]),
    'the other inbox''s members are untouched');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_add_member(v_admin, v_tm2, v_storm), '42501:not_available', 'a closed inbox takes no member');
  perform pg_temp.expect_text(pg_temp.try_remove_member(v_admin, v_tm2, v_storm), '42501:not_available', 'and loses none');
  v_list := pg_temp.list_as(v_admin);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_list) e where e ->> 'id' = v_tm2::text), 0,
    'and is not listed');

  -- A refused Remove changes nothing: an inbox that holds mail keeps its members.
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals3@mm.example');
  v_tm3 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  perform pg_temp.add_member_as(v_admin, v_tm3, v_storm);
  reset role;
  perform pg_temp.act_as_none();
  perform discovery_record_team_mailbox_check(v_tm3, 'verified', null, 'dir-mm');
  -- One message attached: holding mail is what keeps a registration from Remove (audit item 9), verified or not.
  with i as (
    insert into source_items (tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_t, 'message', 'MM deals3', now(), '<mm-deals3@integration.test>', 'mm-deals3') returning id)
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
  select i.id, cs.id, 'mm-deals3-1' from i join content_sources cs on cs.team_mailbox_id = v_tm3;
  select count(*) into v_n from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_member_removed';
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_remove(v_admin, v_tm3), '55000:not_removable', 'an inbox that holds mail is not removable');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.open_members(v_tm3), v_storm::text, 'so its member stays');
  perform pg_temp.expect_text(pg_temp.readers(v_tm3), v_storm::text, 'and reads');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.team_mailbox_member_removed'), v_n,
    'with nothing audited');

  -- ── 12j. Everything audited about membership is ids and fixed codes ──────
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id in (v_t, v_o) and action in ('discovery.team_mailbox_member_added', 'discovery.team_mailbox_member_removed')
      and (detail::text ~ '@' or detail::text ~* 'mm-|storm|deals|\.example'
           or (detail - 'teamMailboxId' - 'userId' - 'reason') <> '{}'::jsonb
           or (action = 'discovery.team_mailbox_member_added' and detail ? 'reason')
           or (action = 'discovery.team_mailbox_member_removed'
               and detail ->> 'reason' not in ('removed', 'seat_lost', 'disconnected')))), 0,
    'no membership audit row carries an address, a name or anything but ids and a fixed reason');
end
$$;

-- The tenant's discovery lock is taken before membership is written (design R5): a fresh tenant holds none, and
-- holds it after an add; a seat lost takes the lock of its tenant as well.
do $$
declare
  v_t      uuid := gen_random_uuid();
  v_b      uuid := gen_random_uuid();
  v_t2     uuid := gen_random_uuid();
  v_b2     uuid := gen_random_uuid();
  v_admin  uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_leaver uuid := gen_random_uuid();
  v_out    jsonb;
  v_tm     uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin,  'lk-admin@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_member, 'lk-member@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_leaver, 'lk-leaver@example.test', jsonb_build_object('tenant_id', v_t2, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_t2);
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'LK Bank', 'bank'), (v_b2, v_t2, 'LK Other Bank', 'bank');
  -- Each bank's director first: company_has_director refuses a bank of members only.
  update users set company_id = v_b, company_role = 'director' where id = v_admin;
  update users set company_id = v_b, company_role = 'member' where id = v_member;
  update users set company_id = v_b2, company_role = 'director' where id = v_leaver;
  update users set firm_role = 'admin' where id = v_admin;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'lk.example', 'dwd-reader@proj-10.iam.gserviceaccount.com', '523456789012345678',
     'dir-reader@proj-10.iam.gserviceaccount.com', 'conductia-ingest@lk.example', v_b, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;

  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals@lk.example');
  reset role;
  perform pg_temp.act_as_none();
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  perform pg_temp.expect_text(pg_temp.holds_tenant_lock(v_t)::text, 'false', 'nothing so far has taken the tenant''s discovery lock');
  perform pg_temp.expect_text(pg_temp.holds_tenant_lock(v_t2)::text, 'false', 'nor the other tenant''s');

  set local role authenticated;
  perform pg_temp.add_member_as(v_admin, v_tm, v_member);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.holds_tenant_lock(v_t)::text, 'true', 'an add holds the tenant''s discovery lock');
  perform pg_temp.expect_text(pg_temp.holds_tenant_lock(v_t2)::text, 'false', 'and only that tenant''s');

  update users set status = 'suspended' where id = v_leaver;
  perform pg_temp.expect_text(pg_temp.holds_tenant_lock(v_t2)::text, 'true', 'a seat lost takes the discovery lock of its tenant');
end
$$;

-- ── 13. Visibility follows membership (phase 10) ────────────────────────────
-- 20261019160000_team_mailbox_visibility.sql. A membership change refreshes the visibility rows of the candidates the inbox
-- evidences, under the tenant's discovery lock and ahead of the audit row. What those rows let a person SEE is
-- supabase/tests/discovery_rls.sql's.
do $$
declare
  v_t       uuid := gen_random_uuid();
  v_b       uuid := gen_random_uuid();
  v_admin   uuid := gen_random_uuid();
  v_member  uuid := gen_random_uuid();
  v_member2 uuid := gen_random_uuid();
  v_owner   uuid := gen_random_uuid();   -- a member who also owns a personal copy of the item
  v_out     jsonb;
  v_tm      uuid;
  v_src     uuid;
  v_src_own uuid;
  v_item    uuid := gen_random_uuid();
  v_cand    uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin,   'vz-admin@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_member,  'vz-member@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_member2, 'vz-member2@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_owner,   'vz-owner@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id = v_t;
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'VZ Bank', 'bank');
  -- The director first: company_has_director refuses a bank of members only.
  update users set company_id = v_b, company_role = 'director', firm_role = 'admin' where id = v_admin;
  update users set company_id = v_b, company_role = 'member' where tenant_id = v_t and id <> v_admin;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'vz.example', 'dwd-reader@proj-12.iam.gserviceaccount.com', '723456789012345678',
     'dir-reader@proj-12.iam.gserviceaccount.com', 'conductia-ingest@vz.example', v_b, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;

  -- ── 13a. The trigger: pinned, nobody's, and ahead of the audit trigger ─────
  perform pg_temp.expect_text(
    (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
     where t.tgrelid = 'public.team_mailbox_members'::regclass and not t.tgisinternal
       and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 4) <> 0),
    'team_mailbox_members_aa_visibility,team_mailbox_members_audit',
    'after an insert the refresh fires ahead of the audit row: lock, refresh, then audit');
  perform pg_temp.expect_text(
    (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
     where t.tgrelid = 'public.team_mailbox_members'::regclass and not t.tgisinternal
       and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 16) <> 0),
    'team_mailbox_members_aa_visibility,team_mailbox_members_audit',
    'and after a closing update');
  if (select count(*) from pg_proc p
      where p.oid = 'public.team_mailbox_members_refresh_visibility()'::regprocedure
        and p.prosecdef and coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']) <> 1 then
    raise exception 'FAIL: the refresh trigger function must be a definer pinned to public, pg_temp';
  end if;
  if has_function_privilege('anon', 'public.team_mailbox_members_refresh_visibility()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.team_mailbox_members_refresh_visibility()', 'EXECUTE') then
    raise exception 'FAIL: a signed-in role can execute the refresh trigger function';
  end if;

  -- ── 13b. A verified inbox with one candidate ─────────────────────────────
  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals@vz.example');
  reset role;
  perform pg_temp.act_as_none();
  v_tm := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  perform discovery_record_team_mailbox_check(v_tm, 'verified', null, 'dir-vz');
  -- v_owner also holds the same message in a personal mailbox of their own.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
    values (v_t, 'mailbox', 'owner@vz.example', v_owner, 'google') returning id into v_src_own;
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
    values (v_item, v_t, 'message', 'Project Heron: kickoff', '2026-02-03', '<vz1@t>', 'vz1');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
    values (v_item, v_src, 'vz-t1'), (v_item, v_src_own, 'vz-o1');
  perform discovery_upsert_candidates(v_t, gen_random_uuid(), jsonb_build_array(jsonb_build_object(
    'clusterKey', 'codename:heron', 'proposedName', 'Project Heron', 'codenameGuess', 'Project Heron',
    'parties', '[]'::jsonb, 'firstSeenAt', '2026-02-03T00:00:00Z', 'lastSeenAt', '2026-02-03T00:00:00Z', 'confidence', 0.9,
    'links', jsonb_build_array(jsonb_build_object('sourceItemId', v_item, 'method', 'codename', 'confidence', 0.9)))));
  select id into v_cand from deal_candidates where tenant_id = v_t and cluster_key = 'codename:heron';
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand), 1,
    'with no member the only visibility row is the personal owner''s');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id = v_owner), 1,
    'it is the owner''s');

  -- ── 13c. Add: the member gets a row; an owner who is also a member keeps one row, counting the item once ──
  set local role authenticated;
  perform pg_temp.add_member_as(v_admin, v_tm, v_member);
  perform pg_temp.add_member_as(v_admin, v_tm, v_owner);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select source_item_count from candidate_visibility where candidate_id = v_cand and person_id = v_member), 1,
    'an added member holds a visibility row for the inbox''s candidate');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id = v_owner), 1,
    'a member who also owns a personal copy still has one row');
  perform pg_temp.expect((select source_item_count from candidate_visibility where candidate_id = v_cand and person_id = v_owner), 1,
    'and it counts the one message once, not once per source');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand), 2, 'nobody else holds one');
  perform pg_temp.expect((select count(*) from candidate_visibility where person_id = v_admin), 0, 'the admin who added them holds none');
  -- Adding someone who is a member already changes nothing.
  set local role authenticated;
  perform pg_temp.add_member_as(v_admin, v_tm, v_member);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand), 2, 'a repeated add changes nothing');

  -- ── 13d. Remove: the row goes; the owner's personal row stays ─────────────
  set local role authenticated;
  perform pg_temp.remove_member_as(v_admin, v_tm, v_member);
  perform pg_temp.remove_member_as(v_admin, v_tm, v_owner);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id = v_member), 0,
    'a removed member holds no visibility row');
  perform pg_temp.expect((select source_item_count from candidate_visibility where candidate_id = v_cand and person_id = v_owner), 1,
    'a removed member who owns a personal copy keeps that row');

  -- ── 13e. A seat lost takes the row; a promotion to firm admin takes it at the next refresh ──
  set local role authenticated;
  perform pg_temp.add_member_as(v_admin, v_tm, v_member);
  perform pg_temp.add_member_as(v_admin, v_tm, v_member2);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id in (v_member, v_member2)), 2,
    'two members hold rows');
  update users set status = 'suspended' where id = v_member;
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id = v_member), 0,
    'a seat lost takes the row with the membership');
  perform pg_temp.expect((select count(*) from team_mailbox_members
    where team_mailbox_id = v_tm and user_id = v_member and removed_reason = 'seat_lost'), 1, 'the membership is closed seat_lost');
  update users set firm_role = 'admin' where id = v_member2;
  perform pg_temp.expect_text(pg_temp.readers(v_tm), '', 'a firm admin is no reader (the view)');
  perform discovery_refresh_candidate_visibility(v_cand);
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id = v_member2), 0,
    'and a refresh gives them no row, though their membership row is open');
end
$$;

-- ── 14. A member's tool read (phase 11) ─────────────────────────────────────
-- 20261019170000_team_mailbox_attach.sql. A tool, search, retrieval or export read acts for a person, so the guard is
-- asked with that person named (pg_temp.guard_as). It admits them exactly while they are a reader of THAT inbox
-- (team_mailbox_readers), and everything else phase 7 decided still stops a reader: a stale check, a pause, a
-- refusal, a closed registration. Whether a reader's rows then come back is the RLS helpers' (discovery_rls.sql).
do $$
declare
  v_t        uuid := gen_random_uuid();
  v_t2       uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();
  v_b2       uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_reader   uuid := gen_random_uuid();   -- a member of deals@ only
  v_reader2  uuid := gen_random_uuid();   -- a member of ops@ only
  v_outsider uuid := gen_random_uuid();   -- a colleague who is no member of anything
  v_lost     uuid := gen_random_uuid();   -- a member who loses their seat
  v_promo    uuid := gen_random_uuid();   -- a member who is promoted to firm admin
  v_stranger uuid := gen_random_uuid();   -- another tenant's user
  v_out      jsonb;
  v_tm1      uuid;
  v_tm2      uuid;
  v_src1     uuid;
  v_purpose  text;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin,    'tr-admin@example.test',    jsonb_build_object('tenant_id', v_t,  'department', 'admin')),
    (v_reader,   'tr-reader@example.test',   jsonb_build_object('tenant_id', v_t,  'department', 'ib')),
    (v_reader2,  'tr-reader2@example.test',  jsonb_build_object('tenant_id', v_t,  'department', 'ib')),
    (v_outsider, 'tr-outsider@example.test', jsonb_build_object('tenant_id', v_t,  'department', 'ib')),
    (v_lost,     'tr-lost@example.test',     jsonb_build_object('tenant_id', v_t,  'department', 'ib')),
    (v_promo,    'tr-promo@example.test',    jsonb_build_object('tenant_id', v_t,  'department', 'ib')),
    (v_stranger, 'tr-stranger@example.test', jsonb_build_object('tenant_id', v_t2, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_t2);
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'TR Bank', 'bank'), (v_b2, v_t2, 'TR Other Bank', 'bank');
  -- Each bank's director first: company_has_director refuses a bank of members only.
  update users set company_id = v_b, company_role = 'director', firm_role = 'admin' where id = v_admin;
  update users set company_id = v_b, company_role = 'member' where tenant_id = v_t and id <> v_admin;
  update users set company_id = v_b2, company_role = 'director' where id = v_stranger;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'tr.example', 'dwd-reader@proj-13.iam.gserviceaccount.com', '623456789012345679',
     'dir-reader@proj-13.iam.gserviceaccount.com', 'conductia-ingest@tr.example', v_b, 'active', now());
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  -- A personal source on the same domain, owned by the outsider, for the personal path.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'person@tr.example', v_outsider, 'google');

  set local role authenticated;
  v_out := pg_temp.connect_as(v_admin, 'deals@tr.example');
  v_tm1 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_src1 := (v_out -> 'teamMailbox' ->> 'sourceId')::uuid;
  v_out := pg_temp.connect_as(v_admin, 'ops@tr.example');
  v_tm2 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  perform pg_temp.add_member_as(v_admin, v_tm1, v_reader);
  perform pg_temp.add_member_as(v_admin, v_tm1, v_lost);
  perform pg_temp.add_member_as(v_admin, v_tm1, v_promo);
  perform pg_temp.add_member_as(v_admin, v_tm2, v_reader2);
  reset role;
  perform pg_temp.act_as_none();
  perform discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-tr1');
  perform discovery_record_team_mailbox_check(v_tm2, 'verified', null, 'dir-tr2');

  -- ── 14a. A reader is admitted for every tool purpose; nobody else is ─────
  foreach v_purpose in array array['agent_tool', 'search', 'retrieval', 'export'] loop
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', v_purpose, v_reader), null,
      v_purpose || ': a reader of the inbox is read for');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', v_purpose, v_outsider), 'owner_mismatch',
      v_purpose || ': a colleague who is no member is refused');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', v_purpose, v_admin), 'owner_mismatch',
      v_purpose || ': the firm admin who manages the members is no reader');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', v_purpose, v_reader2), 'owner_mismatch',
      v_purpose || ': a reader of another inbox of the same firm is refused');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', v_purpose, v_stranger), 'owner_mismatch',
      v_purpose || ': another tenant''s user is refused');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', v_purpose, null), 'owner_mismatch',
      v_purpose || ': a null owner is refused (review M-B): only the worker''s provider_read names nobody');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'ops@tr.example', v_purpose, v_reader2), null,
      v_purpose || ': and the other inbox admits its own reader');
    perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'ops@tr.example', v_purpose, v_reader), 'owner_mismatch',
      v_purpose || ': but not the first inbox''s');
  end loop;
  -- The worker's own read: nobody named is read; a reader named is read too; a non-reader named is refused.
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'provider_read', null), null,
    'the worker''s provider_read names nobody and is read');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'provider_read', v_reader), null,
    'a provider_read that names a reader is read');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'provider_read', v_outsider), 'owner_mismatch',
    'a provider_read that names a non-reader is refused');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, 'deals@tr.example', 'google', true, v_reader), null,
    'the member-facing verdict (the default purpose) admits a reader');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, 'deals@tr.example', 'google', true, v_outsider), 'owner_mismatch',
    'and refuses a non-reader');

  -- ── 14b. The refusals are audited by registration, with no address ───────
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm1::text and detail ->> 'reason' = 'owner_mismatch'
    and detail ->> 'purpose' = 'search'), 5, 'each refused search read is a row of its own: one per refused person, and the null owner');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail::text ~ '@'), 0, 'and no refusal row of the run names an address');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail ->> 'teamMailboxId' = v_tm1::text and detail::text like '%' || v_reader::text || '%'), 0,
    'nor the person it refused');

  -- ── 14c. Membership is the truth on every read ───────────────────────────
  set local role authenticated;
  perform pg_temp.remove_member_as(v_admin, v_tm1, v_reader);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'agent_tool', v_reader), 'owner_mismatch', 'removed: refused at once');
  set local role authenticated;
  perform pg_temp.add_member_as(v_admin, v_tm1, v_reader);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'agent_tool', v_reader), null, 'added again: read for again');

  update users set status = 'suspended' where id = v_lost;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'agent_tool', v_lost), 'owner_mismatch', 'a seat lost: refused');
  update users set status = 'active' where id = v_lost;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'agent_tool', v_lost), 'owner_mismatch',
    're-seated: the closed membership is not revived');

  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'agent_tool', v_promo), null, 'before the promotion: read for');
  update users set firm_role = 'admin' where id = v_promo;
  perform pg_temp.expect((select count(*) from team_mailbox_members where team_mailbox_id = v_tm1 and user_id = v_promo and removed_at is null), 1,
    'a promotion to firm admin leaves the membership row open');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'agent_tool', v_promo), 'owner_mismatch',
    'but the readers view drops them, and so the guard');
  update users set firm_role = null where id = v_promo;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'agent_tool', v_promo), null,
    'demoted: the open membership reads again');

  -- ── 14d. Everything phase 7 decided still stops a reader ─────────────────
  update team_mailboxes set verified_at = now() - interval '66 minutes' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_reader), 'team_mailbox_unverified',
    'a check 66 minutes old stops a reader');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_outsider), 'team_mailbox_unverified',
    'and a non-reader is told the same: the freshness is judged first');
  perform pg_temp.expect((select count(*) from allowed_team_mailboxes where tenant_id = v_t and team_mailbox_id = v_tm1), 1,
    'while the allowlist, and so what the member sees, is unchanged');
  perform discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-tr1');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_reader), null, 'renewed: read for again');

  update content_sources set status = 'paused' where id = v_src1;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_reader), 'source_paused', 'a paused source stops a reader');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_outsider), 'owner_mismatch', 'and still refuses a non-reader as one');
  update content_sources set status = 'active' where id = v_src1;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_reader), null, 'resumed: read for');

  perform discovery_record_team_mailbox_check(v_tm1, 'refused', 'group', null);
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_reader), 'team_mailbox_unverified',
    'an inbox the Directory now refuses stops a reader');
  perform discovery_record_team_mailbox_check(v_tm1, 'verified', null, 'dir-tr1');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_reader), null, 'confirmed again: read for');

  -- ── 14e. The personal path is unchanged ──────────────────────────────────
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'person@tr.example', 'search', v_reader), 'no_invite',
    'a personal source nobody opted in is refused by the personal path, whoever is named');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'person@tr.example', 'search', v_outsider), 'no_invite',
    'including its own owner, as before the team inbox');
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'ghost@tr.example', 'search', v_reader), 'no_source', 'and an address with no source by no_source');

  -- ── 14f. A closed registration admits nobody ─────────────────────────────
  update team_mailboxes set disconnected_at = now(), disconnected_by = v_admin, disconnected_reason = 'never_verified' where id = v_tm1;
  perform pg_temp.expect_text(pg_temp.guard_as(v_t, 'deals@tr.example', 'search', v_reader), 'team_mailbox_disconnected',
    'a closed registration stops its reader');
  perform pg_temp.expect((select count(*) from team_mailbox_readers where team_mailbox_id = v_tm1), 0, 'and has no readers');
end
$$;

-- ── 15. A refusal tells the inbox's own firm (#173 G-04) ────────────────────
-- 20261023100000_team_mailbox_refusal_notify.sql. Two bank companies share one tenant: A holds the Google
-- registration and connects its inbox through the RPC; B is named by the Graph registration, so
-- firm_company_ids() returns both, and its inbox is inserted directly (connect refuses B: its provider is not
-- Google). A third bank, C, has an inbox and nobody seated as admin or CCO. The refusal notice must follow the
-- inbox's firm_company_id, never firm_company_ids(). So must the connect notice (#173 G-04 2/2,
-- 20261023100100_team_mailbox_connect_notice_scope.sql), checked on A's two connects before any refusal.
create function pg_temp.refusal_notices(p_tm uuid)
returns bigint language sql as $$
  select count(*) from notifications
  where event_type = 'team_mailbox_refused' and payload ->> 'teamMailboxId' = p_tm::text;
$$;

-- The recipients of the refusal notices about one inbox, one entry per notice, sorted.
create function pg_temp.refusal_recipients(p_tm uuid, p_reason text default null)
returns text language sql as $$
  select coalesce(string_agg(recipient_id::text, ',' order by recipient_id::text), '')
  from notifications
  where event_type = 'team_mailbox_refused' and payload ->> 'teamMailboxId' = p_tm::text
    and (p_reason is null or payload ->> 'reason' = p_reason);
$$;

do $$
declare
  v_t       uuid := gen_random_uuid();
  v_o       uuid := gen_random_uuid();
  v_a       uuid := gen_random_uuid();   -- company A: holds the Google registration, connects its inbox
  v_bb      uuid := gen_random_uuid();   -- company B: the same tenant's other bank, named by the Graph registration
  v_c       uuid := gen_random_uuid();   -- company C: a bank of the tenant with no admin or CCO seated
  v_ob      uuid := gen_random_uuid();   -- another tenant's bank
  v_a_admin uuid := gen_random_uuid();
  v_a_cco   uuid := gen_random_uuid();
  v_a_md    uuid := gen_random_uuid();   -- a banker of A, no firm role
  v_a_ext   uuid := gen_random_uuid();   -- an external seated in A, with a CCO role
  v_a_susp  uuid := gen_random_uuid();   -- a suspended admin of A
  v_b_admin uuid := gen_random_uuid();
  v_b_cco   uuid := gen_random_uuid();
  v_c_dir   uuid := gen_random_uuid();
  v_o_admin uuid := gen_random_uuid();
  v_o_cco   uuid := gen_random_uuid();
  v_out     jsonb;
  v_res     jsonb;
  v_tm_a    uuid;   -- deals@: A's inbox, the one the scenario walks through
  v_tm_a2   uuid;   -- second@: A's other inbox, never refused
  v_tm_b    uuid;   -- teamb@: B's inbox
  v_tm_c    uuid;   -- teamc@: C's inbox
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_a_admin, 'rn-a-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_a_cco,   'rn-a-cco@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_a_md,    'rn-a-md@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_a_ext,   'rn-a-ext@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_a_susp,  'rn-a-susp@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_b_admin, 'rn-b-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_b_cco,   'rn-b-cco@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_c_dir,   'rn-c-dir@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_o_admin, 'rn-o-admin@example.test', jsonb_build_object('tenant_id', v_o, 'department', 'admin')),
    (v_o_cco,   'rn-o-cco@example.test',   jsonb_build_object('tenant_id', v_o, 'department', 'compliance'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_o);
  insert into companies (id, tenant_id, name, type) values
    (v_a, v_t, 'RN Bank A', 'bank'), (v_bb, v_t, 'RN Bank B', 'bank'), (v_c, v_t, 'RN Bank C', 'bank'),
    (v_ob, v_o, 'RN Foreign Bank', 'bank');
  -- Each bank's director first: company_has_director refuses a bank of members only.
  update users set company_id = v_a, company_role = 'director' where id = v_a_admin;
  update users set company_id = v_a, company_role = 'member' where id in (v_a_cco, v_a_md, v_a_ext, v_a_susp);
  update users set company_id = v_bb, company_role = 'director' where id = v_b_admin;
  update users set company_id = v_bb, company_role = 'member' where id = v_b_cco;
  update users set company_id = v_c, company_role = 'director' where id = v_c_dir;
  update users set company_id = v_ob, company_role = 'director' where id = v_o_admin;
  update users set company_id = v_ob, company_role = 'member' where id = v_o_cco;
  update users set firm_role = null where tenant_id in (v_t, v_o);
  update users set firm_role = 'admin' where id in (v_a_admin, v_a_susp, v_b_admin, v_o_admin);
  update users set firm_role = 'cco' where id in (v_a_cco, v_a_ext, v_b_cco, v_o_cco);
  update users set is_external = true where id = v_a_ext;
  update users set status = 'suspended' where id = v_a_susp;

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'rn.example', 'dwd-reader@proj-15.iam.gserviceaccount.com', '153456789012345678',
     'dir-reader@proj-15.iam.gserviceaccount.com', 'conductia-ingest@rn.example', v_a, 'active', now());
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{ms.rn.example}', v_bb);
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  perform pg_temp.expect((select count(*) from unnest(firm_company_ids(v_t)) as f(c) where f.c in (v_a, v_bb)), 2,
    'the premise: firm_company_ids names both banks, so a recipient test on it would reach B');

  set local role authenticated;
  v_out := pg_temp.connect_as(v_a_admin, 'deals@rn.example');
  v_tm_a := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  v_out := pg_temp.connect_as(v_a_admin, 'second@rn.example');
  v_tm_a2 := (v_out -> 'teamMailbox' ->> 'id')::uuid;
  reset role;
  perform pg_temp.act_as_none();
  insert into team_mailboxes (tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
  values (v_t, v_bb, 'google', 'teamb@rn.example', v_b_admin, 1) returning id into v_tm_b;
  insert into team_mailboxes (tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
  values (v_t, v_c, 'google', 'teamc@rn.example', v_c_dir, 1) returning id into v_tm_c;
  perform pg_temp.expect((select count(*) from team_mailboxes where id in (v_tm_a, v_tm_a2) and firm_company_id = v_a), 2,
    'A''s inboxes are A''s');
  perform pg_temp.expect((select count(*) from notifications where event_type = 'team_mailbox_refused' and tenant_id in (v_t, v_o)), 0,
    'nothing is refused yet, so nobody is told of a refusal');

  -- ── 15·connect. The connect notice tells A's admin and CCO, and not B (#173 G-04 2/2, 20261023100100) ──
  -- Connect told every bank firm_company_ids() names until 20261023100100; the premise above shows that would
  -- reach B. It now follows the new registration's firm_company_id, as the refusal notice does.
  perform pg_temp.expect_text(
    (select coalesce(string_agg(recipient_id::text, ',' order by recipient_id::text), '') from notifications
     where event_type = 'mailbox_connected' and payload ->> 'teamMailboxId' = v_tm_a::text),
    pg_temp.sorted_ids(array[v_a_admin, v_a_cco]), 'connecting A''s inbox tells A''s active internal admin and CCO, once each');
  perform pg_temp.expect_text(
    (select coalesce(string_agg(recipient_id::text, ',' order by recipient_id::text), '') from notifications
     where event_type = 'mailbox_connected' and payload ->> 'teamMailboxId' = v_tm_a2::text),
    pg_temp.sorted_ids(array[v_a_admin, v_a_cco]), 'and so does connecting A''s other inbox');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'mailbox_connected' and recipient_id in (v_b_admin, v_b_cco)), 0,
    'B''s admin and CCO, of the same tenant''s other bank, are not told of A''s inboxes');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'mailbox_connected' and recipient_id in (v_a_md, v_a_ext, v_a_susp, v_c_dir, v_o_admin, v_o_cco)), 0,
    'nor is a banker, an external CCO, a suspended admin, another bank''s director or another tenant');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'mailbox_connected' and tenant_id = v_t and deal_id is null
      and payload = jsonb_build_object('address', 'deals@rn.example', 'outcome', 'team_connected', 'provider', 'google',
                                       'sourceId', (select id from content_sources where team_mailbox_id = v_tm_a),
                                       'teamMailboxId', v_tm_a)), 2,
    'the connect payload is unchanged: the address, the outcome, the provider and the two ids');
  perform pg_temp.expect((select count(*) from notifications where event_type = 'mailbox_connected' and tenant_id = v_t), 4,
    'four connect notices in all: two inboxes, two recipients each (B''s and C''s rows were written directly)');

  -- ── 15a. Entering refused tells A's admin and CCO, once each, and nobody else ──
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'refused', 'directory_denied', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'pending to refused is a change');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 2, 'one notice each for A''s admin and CCO');
  perform pg_temp.expect_text(pg_temp.refusal_recipients(v_tm_a), pg_temp.sorted_ids(array[v_a_admin, v_a_cco]),
    'to A''s active internal admin and CCO, exactly');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'team_mailbox_refused' and tenant_id = v_t and deal_id is null and read_at is null
      and payload = jsonb_build_object('teamMailboxId', v_tm_a, 'address', 'deals@rn.example',
                                       'reason', 'directory_denied', 'href', '/discovery')), 2,
    'the payload is the registration id, the address, the fixed reason and the link, and nothing else');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'team_mailbox_refused' and payload ?| array['subject', 'body', 'snippet', 'text']), 0,
    'no refusal notice carries mail content');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'team_mailbox_refused' and recipient_id in (v_b_admin, v_b_cco)), 0,
    'B''s admin and CCO, of the same tenant''s other bank, are not told of A''s inbox');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'team_mailbox_refused' and recipient_id in (v_a_md, v_a_ext, v_a_susp, v_c_dir, v_o_admin, v_o_cco)), 0,
    'nor is a banker, an external CCO, a suspended admin, another bank''s director or another tenant');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked' and actor_id is null
      and detail = jsonb_build_object('teamMailboxId', v_tm_a, 'status', 'refused', 'reason', 'directory_denied')), 1,
    'the audit row is written as before, with ids and a fixed code');

  -- ── 15b. A recheck that finds the same refusal, or an error, tells no one; a new reason tells them again ──
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'refused', 'directory_denied', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'false', 'the same refusal again is not a change');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 2, 'and tells no one (no spam on the 4-minute recheck)');
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'error', 'directory_error', null);
  perform pg_temp.expect_text(v_res ->> 'status', 'refused', 'a transient error leaves the refusal');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 2, 'and tells no one');
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'refused', 'group', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'a different reason is a change');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 4, 'and tells them again');
  perform pg_temp.expect_text(pg_temp.refusal_recipients(v_tm_a, 'group'), pg_temp.sorted_ids(array[v_a_admin, v_a_cco]),
    'once each, with the new reason');

  -- ── 15c. A recovery tells no one; refused again after it tells them on the new entry ──
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'verified', null, 'dir-a1');
  perform pg_temp.expect_text(v_res ->> 'status', 'verified', 'the inbox recovers');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 4, 'a recovery tells no one (the trail records it)');
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'verified', null, 'dir-a1');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 4, 'nor does a repeated success');
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'refused', 'group', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'refused after a recovery is a change');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 6, 'and tells them');
  perform pg_temp.expect_text(pg_temp.refusal_recipients(v_tm_a, 'group'),
    pg_temp.sorted_ids(array[v_a_admin, v_a_admin, v_a_cco, v_a_cco]),
    'refused, verified, refused with the same reason tells each of them twice, once per entry');

  -- ── 15d. The pin mismatch tells them as identity_changed ──────────────────
  perform discovery_record_team_mailbox_check(v_tm_a, 'verified', null, 'dir-a1');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 6, 'the pinned account answers: no notice');
  v_res := discovery_record_team_mailbox_check(v_tm_a, 'verified', null, 'dir-a2');
  perform pg_temp.expect_text(v_res ->> 'reason', 'identity_changed', 'another account than the pinned one is refused');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a), 8, 'and tells them');
  perform pg_temp.expect_text(pg_temp.refusal_recipients(v_tm_a, 'identity_changed'),
    pg_temp.sorted_ids(array[v_a_admin, v_a_cco]), 'once each, as identity_changed');

  -- ── 15e. A first verify, and an error on a pending inbox, tell no one ─────
  perform discovery_record_team_mailbox_check(v_tm_a2, 'error', 'directory_error', null);
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a2), 0, 'a transient error on a pending inbox tells no one');
  v_res := discovery_record_team_mailbox_check(v_tm_a2, 'verified', null, 'dir-a9');
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'a first verify is a change');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_a2), 0, 'that tells no one');

  -- ── 15f. A refusal of B's inbox reaches only B ──────────────────────────
  v_res := discovery_record_team_mailbox_check(v_tm_b, 'refused', 'not_found', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'B''s inbox is refused');
  perform pg_temp.expect_text(pg_temp.refusal_recipients(v_tm_b), pg_temp.sorted_ids(array[v_b_admin, v_b_cco]),
    'B''s admin and CCO are told, once each');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'team_mailbox_refused' and recipient_id in (v_a_admin, v_a_cco)
      and payload ->> 'teamMailboxId' = v_tm_b::text), 0,
    'A''s admin and CCO are not told of B''s inbox');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'team_mailbox_refused' and payload ->> 'teamMailboxId' = v_tm_b::text
      and payload = jsonb_build_object('teamMailboxId', v_tm_b, 'address', 'teamb@rn.example',
                                       'reason', 'not_found', 'href', '/discovery')), 2,
    'with B''s address and reason');

  -- ── 15g. With nobody seated, nobody is told; the audit row is the record ──
  v_res := discovery_record_team_mailbox_check(v_tm_c, 'refused', 'suspended', null);
  perform pg_temp.expect_text(v_res ->> 'changed', 'true', 'C''s inbox is refused');
  perform pg_temp.expect(pg_temp.refusal_notices(v_tm_c), 0, 'C has no admin or CCO, so nobody is told (no fallback)');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked' and detail ->> 'teamMailboxId' = v_tm_c::text), 1,
    'and the refusal is audited');

  -- ── 15h. The whole run ───────────────────────────────────────────────────
  perform pg_temp.expect((select count(*) from notifications where event_type = 'team_mailbox_refused' and tenant_id = v_t), 10,
    'ten notices: four entries for A''s inbox and one for B''s, two recipients each');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_o), 0, 'another tenant is told nothing');
  perform pg_temp.expect((select count(*) from notifications
    where event_type = 'team_mailbox_refused' and tenant_id = v_t
      and ((payload - 'teamMailboxId' - 'address' - 'reason' - 'href') <> '{}'::jsonb
           or payload::text ~ 'dir-a' or payload ->> 'href' is distinct from '/discovery')), 0,
    'no notice carries the Directory id or any key beyond the four');
  perform pg_temp.expect((select count(*) from audit_log
    where tenant_id = v_t and action = 'discovery.team_mailbox_checked' and detail::text ~ '@'), 0,
    'the check rows still carry no address');
end
$$;

rollback;
