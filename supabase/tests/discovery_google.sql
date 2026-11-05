-- Google reader registration (20261002175000_google_reader_registrations.sql):
-- the table's shape, constraints and grants.
--
--   - RLS is on, and anon and authenticated hold no privilege on it
--   - an active registration needs consented_at
--   - the ingest group must be in the workspace domain
--   - the DWD and directory service accounts must differ
--   - the domain must be lowercase
--   - a valid row inserts
--
-- Phase 2 (20261002180000_discovery_google_sources.sql, plan D1, C5, C14, C15):
--   - a Google source needs a Google registration, restrict on delete, and
--     deleting one provider's registration never touches the other's sources
--   - the registration functions answer per provider; a Google mailbox never
--     passes on a Graph registration's domains
--   - a Google-only tenant keeps its firm, its CCO and its drift recipients
--   - a seated, consented Google user is allowed, and the guard judges the
--     source row and the provider
--
-- Phase 4 (20261002181000_discovery_google_connect.sql), folded into #262's
-- one-click opt-in (there is no separate connect RPC):
--   - mailbox_consent_grant (#262) under the member's own session creates the
--     provider = google source for a Google-domain member who is md or
--     deal_team on a deal of their own tenant, and notifies each firm admin
--     with the existing mailbox_connected event, no content in any payload
--   - the guard refuses not_in_provider_group until the member is in the group,
--     and the status RPC reports that as waitingForGroup (and the group name)
--   - the status is bound to auth.uid(): it answers only for the caller's own
--     live Google source, never for another provider's, an archived one, or
--     one that belongs to someone else; no session is a 42501
--   - pause and resume are the firm admin's alone (not a colleague, not another
--     tenant's admin, not a Microsoft or an archived source); pausing keeps the
--     source row and its provenance, the guard refuses source_paused, resuming
--     reads on, and each real change audits discovery.mailbox_access_changed
--   - a deal seat counts only on a deal of the caller's own tenant (grant)
--
-- First-sync status (20261016170000_discovery_google_mailbox_sync_status.sql, #341):
--   - the status adds state, backfillCompletedAt, lastSyncedAt and delegationRefused for
--     the caller's own source, and no other key (no read count, no subject, participant,
--     body or message id)
--   - state follows the ingestion health precedence over planted pass rows: not_started,
--     stale, reading, up_to_date, failing, delegation_broken, and switched_off, halted and
--     paused over a delegation_broken pass
--   - delegationRefused holds for a delegation_refused pass and for the worker's
--     'Google delegation refused' last error written at or after the latest pass started;
--     an error older than a later pass start (the admin fixed it, the backfill continues)
--     is not a refusal, nor is any refusal on a paused source
--   - a colleague who has not connected gets { connected: false } and no sync data
--
-- Reader liveness (20261008210000_discovery_restart_source.sql): restarting a
-- halted source (last_error = history_window_exceeded) is the firm admin's alone
--   - not the owner, a director without the admin role, another tenant's admin,
--     an archived source, a source that is not halted, an unknown id, or no
--     session: all one 42501 not_available
--   - the admin's restart clears the error, the cursor, the backfill marks and the
--     expiry streak, leaves status alone, and audits one
--     discovery.mailbox_access_changed with change restarted; a second call finds
--     nothing halted
--   - a source that halts again within 24 hours of its restart is refused the same
--     way, with no audit row and no source change; a restart older than that, or
--     a pause and resume within it, does not hold a source back
--   - any provider: a halted Microsoft source restarts too
--
-- Ingestion window (20261016120000_discovery_backfill_window.sql, #353):
--   - a Google source inserted without backfill_since gets 90 days before today
--     (UTC) by DEFAULT, through a plain insert and through the one-click opt-in
--   - a seed-style insert that names backfill_since null keeps null (whole mailbox)
--
-- Setting the window (20261018110000_discovery_set_source_window.sql, #353; owner
-- decision 2026-10-16): the firm admin's alone, before the first read
--   - not the CCO, a director without the admin role, another tenant's admin, a Microsoft or an archived
--     source, an unknown id, or no session: all one 42501 not_available
--   - out of range (today + 1, today - 731, null) is 22023 out_of_range; today and
--     today - 730 (UTC) are accepted
--   - with deal_discovery off even the admin is refused (42501 not_available): the
--     RPC holds the route's flag, since PostgREST reaches it directly
--   - each of delta_checkpoint, backfill_started_at and backfill_completed_at alone
--     locks it (55000 window_locked), with no change and no audit row
--   - the worker's first-read claim (backfill_started_at set before the first Gmail
--     request, no checkpoint yet) returns the window, then locks it: the RPC refuses
--     and health reports windowLocked true; an archived source gets no claim write
--   - a real change audits one discovery.mailbox_access_changed with change
--     window_set, from and to; setting the stored date again is changed false and
--     audits nothing
--   - recovery: halted -> pause -> restart -> set a shorter window -> resume, and
--     a second restart within 24 hours is still refused (cooldown unchanged)
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_google.sql
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
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.act_as_none()
returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.try_grant(p_user uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform mailbox_consent_grant();
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

create function pg_temp.try_set_status(p_user uuid, p_source uuid, p_status text)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform discovery_set_mailbox_source_status(p_source, p_status);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

create function pg_temp.try_restart(p_user uuid, p_source uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform discovery_restart_mailbox_source(p_source);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

create function pg_temp.try_set_window(p_user uuid, p_source uuid, p_since date)
returns text language plpgsql as $$
declare
  v_res jsonb;
begin
  perform pg_temp.act_as(p_user);
  v_res := discovery_set_mailbox_source_window(p_source, p_since);
  return 'ok:' || (v_res ->> 'changed');
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

create function pg_temp.status_as(p_user uuid)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return discovery_google_mailbox_status();
end;
$$;
-- Reader pass rows, shaped as discovery_health.sql plants them, at a chosen server time.
create function pg_temp.rp_iso(p timestamptz)
returns text language sql immutable as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
create function pg_temp.rp_start(p_source uuid, p_at timestamptz)
returns jsonb language sql as $$
  select jsonb_build_object('v', 1, 'passId', gen_random_uuid(), 'runId', gen_random_uuid(), 'jobId', null,
    'sourceId', p_source, 'startedAt', pg_temp.rp_iso(p_at),
    'worker', jsonb_build_object('deployment', 'local', 'revision', null));
$$;
create function pg_temp.rp_end(p_start jsonb, p_ended timestamptz, p_status text, p_reason text)
returns jsonb language sql as $$
  select p_start || jsonb_build_object('provider', 'google',
    'registration', jsonb_build_object('clientId', 'CANARYCLIENT', 'certThumbprint', null),
    'endedAt', pg_temp.rp_iso(p_ended), 'status', p_status, 'reason', p_reason,
    'pages', 1, 'fetched', 0, 'excluded', 0, 'stored', 0, 'checkpointAdvanced', true);
$$;
create function pg_temp.rp_plant(p_tenant uuid, p_action text, p_detail jsonb, p_ts timestamptz)
returns void language sql as $$
  insert into audit_log (action, tenant_id, actor_type, service_identity, detail, ts)
  values (p_action, p_tenant, 'service', 'discovery-worker', p_detail, p_ts);
$$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

do $$
declare
  v_tenant  uuid := gen_random_uuid();
  v_blocked boolean;
  v_rls     boolean;
begin
  select relrowsecurity into v_rls from pg_class
   where oid = 'public.google_reader_registrations'::regclass;
  if not coalesce(v_rls, false) then
    raise exception 'FAIL: google_reader_registrations has no row level security';
  end if;

  if has_table_privilege('anon', 'public.google_reader_registrations', 'select')
     or has_table_privilege('authenticated', 'public.google_reader_registrations', 'select')
     or has_table_privilege('anon', 'public.google_reader_registrations', 'insert')
     or has_table_privilege('authenticated', 'public.google_reader_registrations', 'insert')
     or has_table_privilege('authenticated', 'public.google_reader_registrations', 'update')
     or has_table_privilege('authenticated', 'public.google_reader_registrations', 'delete') then
    raise exception 'FAIL: anon or authenticated holds a privilege on google_reader_registrations';
  end if;
  if not has_table_privilege('service_role', 'public.google_reader_registrations', 'insert') then
    raise exception 'FAIL: service_role cannot write google_reader_registrations';
  end if;

  -- An active row without consent.
  v_blocked := false;
  begin
    insert into google_reader_registrations
      (tenant_id, workspace_domain, service_account_email, client_id,
       directory_service_account_email, allowlist_group, status)
    values
      (v_tenant, 'bank.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
       'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@bank.example', 'active');
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an active registration without consented_at was accepted'; end if;

  -- A group outside the domain.
  v_blocked := false;
  begin
    insert into google_reader_registrations
      (tenant_id, workspace_domain, service_account_email, client_id,
       directory_service_account_email, allowlist_group)
    values
      (v_tenant, 'bank.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
       'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@other.example');
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a group outside the workspace domain was accepted'; end if;

  -- The same service account for reading and for the directory.
  v_blocked := false;
  begin
    insert into google_reader_registrations
      (tenant_id, workspace_domain, service_account_email, client_id,
       directory_service_account_email, allowlist_group)
    values
      (v_tenant, 'bank.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
       'dwd-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@bank.example');
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: equal DWD and directory service accounts were accepted'; end if;

  -- An uppercase domain.
  v_blocked := false;
  begin
    insert into google_reader_registrations
      (tenant_id, workspace_domain, service_account_email, client_id,
       directory_service_account_email, allowlist_group)
    values
      (v_tenant, 'Bank.Example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
       'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@bank.example');
  exception when check_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an uppercase workspace domain was accepted'; end if;

  -- A valid pending row, then activation with consent.
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group)
  values
    (v_tenant, 'bank.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@bank.example');
  update google_reader_registrations
     set status = 'active', consented_at = now() where tenant_id = v_tenant;

  raise notice 'PASS: google_reader_registrations: RLS on, no user grants, consent, domain, identity split and case constraints hold';
end $$;

-- ── Phase 2: Google sources beside Graph ones ────────────────────────────────
do $$
declare
  v_none     uuid := gen_random_uuid();   -- a tenant with no registration at all
  v_t        uuid := gen_random_uuid();   -- a Google-only tenant
  v_b        uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_banker   uuid := gen_random_uuid();
  v_seated   uuid := gen_random_uuid();
  v_src_g    uuid := gen_random_uuid();
  v_src_ms   uuid := gen_random_uuid();
  v_blocked  boolean;
  v_firms    uuid[];
  v_providers text[];
begin
  -- A Google source without any registration is refused.
  v_blocked := false;
  begin
    insert into content_sources (tenant_id, kind, provider, address)
    values (v_none, 'mailbox', 'google', 'nobody@bank.example');
  exception when foreign_key_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a Google source without a Google registration was accepted'; end if;

  -- A Google source is a mailbox.
  v_blocked := false;
  begin
    insert into content_sources (tenant_id, kind, provider, address)
    values (v_none, 'sharepoint_site', 'google', 'site.example');
  exception when check_violation or foreign_key_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a Google site source was accepted'; end if;

  -- The Google-only tenant's fixture: a firm with a director, an admin, a CCO,
  -- a banker and one seated user who will consent.
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,    'gg-dir@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,  'gg-admin@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,    'gg-cco@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_banker, 'gg-banker@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_seated, 'gg-seated@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false
    where id in (v_dir, v_admin, v_cco, v_banker, v_seated);
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'GG Bank', 'bank');
  update users set company_id = v_b, company_role = 'director' where id = v_dir;
  update users set company_id = v_b, company_role = 'member' where id in (v_admin, v_cco, v_banker, v_seated);
  update users set firm_role = 'admin' where id = v_admin;
  update users set firm_role = 'cco'   where id = v_cco;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_t, 'seated@bank.example', v_dir, v_b, 'member', 'accepted', 'sent', now(), v_seated);
  -- The one-click opt-in is open to the MD and the deal team of a deal of the member's tenant (#262).
  with d as (
    insert into deals (tenant_id, code, codename, bank_id)
    values (v_t, 'GG-' || left(gen_random_uuid()::text, 8), 'Project Seat', v_b) returning id)
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by)
  select d.id, v_seated, (select id from roles where slug = 'deal_team'), 'deal_team', v_dir from d;

  -- A pending Google registration reads nothing and names no firm yet.
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id)
  values
    (v_t, 'bank.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@bank.example', v_b);
  perform pg_temp.expect_text(reader_registration_active(v_t, 'google')::text, 'false', 'a pending registration is not active');
  perform pg_temp.expect_text(array_to_string(reader_mailbox_domains(v_t, 'google'), ','), '',
    'a pending registration has no readable domains');
  -- ... but firm_company_ids counts it whatever its status (C15), so a paused
  -- reader does not strip the control room.
  perform pg_temp.expect_text(array_to_string(firm_company_ids(v_t), ','), v_b::text,
    'firm_company_ids counts a pending Google registration');
  update google_reader_registrations set status = 'active', consented_at = now() where tenant_id = v_t;

  -- A Google source in a Google-only tenant succeeds (C14).
  insert into content_sources (id, tenant_id, kind, provider, address, owner_user_id)
  values (v_src_g, v_t, 'mailbox', 'google', 'seated@bank.example', v_seated);
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and provider = 'google'), 1,
    'a Google-only tenant holds a Google source');
  -- #353: an insert that names no window gets the default, 90 days before today (UTC).
  perform pg_temp.expect_text((select backfill_since::text from content_sources where id = v_src_g),
    ((now() at time zone 'utc')::date - 90)::text, 'a new Google source reads from 90 days before today (UTC)');
  -- ... and the seed's explicit null stays null: a fixture mailbox is read whole.
  insert into content_sources (tenant_id, kind, provider, address, backfill_since)
  values (v_t, 'mailbox', 'google', 'seeded@bank.example', null);
  perform pg_temp.expect((select count(*) from content_sources
    where tenant_id = v_t and address = 'seeded@bank.example' and backfill_since is null), 1,
    'an explicit null window is kept');
  delete from content_sources where tenant_id = v_t and address = 'seeded@bank.example';

  -- Restrict: a registration with sources is disabled, not deleted.
  v_blocked := false;
  begin
    delete from google_reader_registrations where tenant_id = v_t;
  exception when foreign_key_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a Google registration with sources was deleted'; end if;

  -- The registration functions answer per provider.
  perform pg_temp.expect_text(reader_registration_active(v_t, 'google')::text, 'true', 'the Google registration is active');
  perform pg_temp.expect_text(reader_registration_active(v_t, 'microsoft')::text, 'false', 'no Graph registration is active');
  perform pg_temp.expect_text(array_to_string(reader_mailbox_domains(v_t, 'google'), ','), 'bank.example',
    'reader_mailbox_domains google is the workspace domain');
  perform pg_temp.expect_text(array_to_string(reader_mailbox_domains(v_t, 'microsoft'), ','), '',
    'reader_mailbox_domains microsoft is empty without a Graph registration');
  perform pg_temp.expect_text(array_to_string(reader_firm_company_ids(v_t, 'google'), ','), v_b::text,
    'reader_firm_company_ids google is the firm');
  perform pg_temp.expect_text(array_to_string(reader_firm_company_ids(v_t, 'microsoft'), ','), '',
    'reader_firm_company_ids microsoft is empty');

  -- A Graph registration in the same tenant does not change Google's answers,
  -- and a Google mailbox never passes on the Graph domains (C5 counter).
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{graph.example}', v_b);
  perform pg_temp.expect_text(array_to_string(reader_mailbox_domains(v_t, 'microsoft'), ','), 'graph.example',
    'the Graph domains are the Graph registration''s');
  perform pg_temp.expect_text(array_to_string(reader_mailbox_domains(v_t, 'google'), ','), 'bank.example',
    'the Google domains are unchanged by a Graph registration');
  v_providers := mailbox_reader_providers(v_t, 'someone@graph.example', v_b);
  perform pg_temp.expect_text(array_to_string(v_providers, ','), 'microsoft', 'a Graph-domain address is microsoft only');
  v_providers := mailbox_reader_providers(v_t, 'someone@bank.example', v_b);
  perform pg_temp.expect_text(array_to_string(v_providers, ','), 'google', 'a Google-domain address is google only');

  -- Deleting a Graph registration with no Graph sources leaves Google sources in place (C14).
  delete from graph_reader_registrations where tenant_id = v_t;
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and provider = 'google'), 1,
    'deleting a Graph registration leaves the Google source');
  -- ... and a Graph registration with a Graph source cannot be deleted.
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{graph.example}', v_b);
  insert into content_sources (id, tenant_id, kind, provider, address)
  values (v_src_ms, v_t, 'mailbox', 'microsoft', 'someone@graph.example');
  v_blocked := false;
  begin
    delete from graph_reader_registrations where tenant_id = v_t;
  exception when foreign_key_violation then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a Graph registration with sources was deleted'; end if;
  delete from content_sources where id = v_src_ms;
  delete from graph_reader_registrations where tenant_id = v_t;

  -- A disabled Google registration reads no domain.
  update google_reader_registrations set status = 'disabled' where tenant_id = v_t;
  perform pg_temp.expect_text(array_to_string(reader_mailbox_domains(v_t, 'google'), ','), '',
    'a disabled registration has no readable domains');
  perform pg_temp.expect_text(array_to_string(firm_company_ids(v_t), ','), v_b::text,
    'a disabled registration still names the firm for the control room');
  update google_reader_registrations set status = 'active' where tenant_id = v_t;

  -- The control room of a Google-only tenant (C15).
  v_firms := firm_company_ids(v_t);
  if not (v_b = any (v_firms)) then raise exception 'FAIL: firm_company_ids omits the Google firm'; end if;
  if not app_is_firm_cco(v_t, v_cco) then raise exception 'FAIL: the CCO of a Google-only tenant is not the control room'; end if;
  if app_is_firm_cco(v_t, v_banker) then raise exception 'FAIL: a banker passed app_is_firm_cco'; end if;
  perform pg_temp.act_as_none();
  perform discovery_record_allowlist_drift(v_t, 'google', 'drift', array['seated@bank.example'], '{}');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_allowlist_drift' and recipient_id in (v_admin, v_cco)), 2,
    'a Google drift notifies the firm''s admin and CCO');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_allowlist_drift' and recipient_id = v_banker), 0, 'the banker is not told');

  -- A seated user who consents appears in allowed_mailboxes as google, and the guard passes.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_seated), 'ok', 'the Google user opts in');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t and provider = 'google'), 1,
    'the seated, consented Google user is allowed as google');
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t and provider = 'microsoft'), 0,
    'and not as microsoft');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    null, 'the guard passes the Google mailbox');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', false, null, null, 'microsoft'),
    'provider_mismatch', 'the guard refuses the Google mailbox read through microsoft');

  -- Before the source row exists there is nothing to judge the address by.
  delete from content_sources where id = v_src_g;
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    'no_source', 'the guard refuses no_source before the source row exists');

  raise notice 'PASS: Google sources: per-provider restrict FKs, provider functions, Google-only control room, allowlist view and guard';
end $$;


-- ── Phase 4: opt-in creates the Google source; status; pause and resume ────
do $$
declare
  v_t        uuid := gen_random_uuid();
  v_o        uuid := gen_random_uuid();   -- another tenant
  v_b        uuid := gen_random_uuid();
  v_ob       uuid := gen_random_uuid();
  v_deal     uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_admin2   uuid := gen_random_uuid();
  v_oadmin   uuid := gen_random_uuid();
  v_conn     uuid := gen_random_uuid();   -- deal_team: opts in
  v_md       uuid := gen_random_uuid();   -- md: opts in, then its source is archived
  v_reader   uuid := gen_random_uuid();   -- read_only only
  v_nomember uuid := gen_random_uuid();   -- on no deal
  v_noconsent uuid := gen_random_uuid();  -- deal_team, seated, never opts in
  v_noseat   uuid := gen_random_uuid();   -- deal_team, no invite
  v_external uuid := gen_random_uuid();   -- external, deal_team
  v_msconf   uuid := gen_random_uuid();   -- opts in, address already a Microsoft source
  v_role_dt  uuid;
  v_role_md  uuid;
  v_role_ro  uuid;
  v_res      text;
  v_status   jsonb;
  v_other    jsonb;
  v_start    jsonb;
  v_src      uuid;
  v_md_src   uuid;
  v_ms_src   uuid := gen_random_uuid();
begin
  select id into v_role_dt from roles where slug = 'deal_team';
  select id into v_role_md from roles where slug = 'md';
  select id into v_role_ro from roles where slug = 'read_only';

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,       'gc-dir@example.test',       jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,     'gc-admin@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_admin2,    'gc-admin2@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_oadmin,    'gc-oadmin@example.test',    jsonb_build_object('tenant_id', v_o, 'department', 'admin')),
    (v_conn,      'gc-conn@example.test',      jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_md,        'gc-md@example.test',        jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_reader,    'gc-reader@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_nomember,  'gc-nomember@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_noconsent, 'gc-noconsent@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_noseat,    'gc-noseat@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_external,  'gc-external@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_msconf,    'gc-msconf@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where tenant_id in (v_t, v_o);
  update users set is_external = true where id = v_external;
  insert into companies (id, tenant_id, name, type) values
    (v_b, v_t, 'GC Bank', 'bank'), (v_ob, v_o, 'Other Bank', 'bank');
  update users set company_id = v_b, company_role = 'director' where id = v_dir;
  update users set company_id = v_b, company_role = 'member'
    where id in (v_admin, v_admin2, v_conn, v_md, v_reader, v_nomember, v_noconsent, v_noseat, v_external, v_msconf);
  update users set company_id = v_ob, company_role = 'director' where id = v_oadmin;
  update users set firm_role = 'admin' where id in (v_admin, v_admin2, v_oadmin);

  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'gc.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@gc.example', v_b, 'active', now());
  -- The other tenant is a firm too, so its admin is a real admin of a real bank.
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_o, 'other.example', 'dwd-reader@proj-2.iam.gserviceaccount.com', '223456789012345678',
     'dir-reader@proj-2.iam.gserviceaccount.com', 'conductia-ingest@other.example', v_ob, 'active', now());

  -- Seats: accepted invites on the Google domain.
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  select v_t, x.email, v_dir, v_b, 'member', 'accepted', 'sent', now(), x.uid
    from (values
      ('conn@gc.example', v_conn), ('md@gc.example', v_md), ('reader@gc.example', v_reader),
      ('nomember@gc.example', v_nomember), ('noconsent@gc.example', v_noconsent),
      ('external@gc.example', v_external), ('msconf@gc.example', v_msconf)) as x(email, uid);

  -- Deal seats. Only md and deal_team qualify (#262: mailbox_member_on_a_deal).
  insert into deals (id, tenant_id, code, codename, bank_id)
  values (v_deal, v_t, 'GC-' || left(gen_random_uuid()::text, 8), 'Project Connect', v_b);
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by) values
    (v_deal, v_conn,      v_role_dt, 'deal_team', v_dir),
    (v_deal, v_md,        v_role_md, 'md',        v_dir),
    (v_deal, v_reader,    v_role_ro, 'read_only', v_dir),
    (v_deal, v_noconsent, v_role_dt, 'deal_team', v_dir),
    (v_deal, v_noseat,    v_role_dt, 'deal_team', v_dir),
    (v_deal, v_external,  v_role_dt, 'deal_team', v_dir),
    (v_deal, v_msconf,    v_role_dt, 'deal_team', v_dir);

  -- An address that is already a Microsoft source, owned by its member, before the opt-in.
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{ms.example}', v_b);
  insert into content_sources (id, tenant_id, kind, provider, address, owner_user_id)
  values (v_ms_src, v_t, 'mailbox', 'microsoft', 'msconf@gc.example', v_msconf);

  -- Before any opt-in nobody has a Google source, and the status says so.
  set local role authenticated;
  v_status := pg_temp.status_as(v_md);
  perform pg_temp.expect_text(v_status ->> 'connected', 'false', 'before the opt-in the status is not connected');
  v_status := pg_temp.status_as(v_noseat);
  perform pg_temp.expect_text(v_status ->> 'connected', 'false', 'a seatless user is not connected');
  -- The one-click opt-in refuses the ineligible with 42501 not_eligible, creating nothing.
  perform pg_temp.expect_text(pg_temp.try_grant(v_reader),   '42501:not_eligible', 'a read_only member cannot opt in');
  perform pg_temp.expect_text(pg_temp.try_grant(v_nomember), '42501:not_eligible', 'a member on no deal cannot opt in');
  perform pg_temp.expect_text(pg_temp.try_grant(v_noseat),   '42501:not_eligible', 'a user without a seat cannot opt in');
  perform pg_temp.expect_text(pg_temp.try_grant(v_external), '42501:not_eligible', 'an external user cannot opt in');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and provider = 'google'), 0,
    'no refusal created a Google source');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 0,
    'no refusal notified anyone');

  -- A deal_team member opts in: the source is created on Google, owned by them.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_conn), 'ok', 'the deal_team user opts in');
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  select id into v_src from content_sources where tenant_id = v_t and lower(address) = 'conn@gc.example';
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_src and provider = 'google' and kind = 'mailbox' and status = 'active' and owner_user_id = v_conn), 1,
    'the opt-in created a Google mailbox source owned by the member');
  perform pg_temp.expect_text(v_status ->> 'connected', 'true', 'the status is connected after the opt-in');
  perform pg_temp.expect_text(v_status ->> 'address', 'conn@gc.example', 'the status names the address');
  perform pg_temp.expect_text(v_status ->> 'group', 'conductia-ingest@gc.example', 'the status names the ingest group');
  perform pg_temp.expect_text(v_status ->> 'domain', 'gc.example', 'the status names the workspace domain');
  perform pg_temp.expect_text(v_status ->> 'paused', 'false', 'the source is not paused');
  perform pg_temp.expect_text(v_status ->> 'waitingForGroup', 'false', 'no refusal is on record yet');
  perform pg_temp.expect_text((v_status - 'connected' - 'address' - 'group' - 'domain' - 'paused' - 'waitingForGroup'
    - 'state' - 'backfillCompletedAt' - 'lastSyncedAt' - 'delegationRefused')::text, '{}',
    'the status carries nothing else: no subject, participant, body or message id');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed'), 0, 'opting in audits as the consent, not as an access change');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_connected' and recipient_id in (v_admin, v_admin2)), 2,
    'each firm admin is notified once, with #262''s mailbox_connected');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_connected'), 2, 'nobody else is notified');
  perform pg_temp.expect((select count(*) from notifications where event_type = 'mailbox_connected'
    and recipient_id = v_oadmin), 0, 'another tenant''s admin is not notified');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_connected'
    and payload ->> 'address' = 'conn@gc.example' and payload ->> 'provider' = 'google'
    and payload ->> 'outcome' = 'created' and payload ->> 'sourceId' = v_src::text
    and not (payload ?| array['subject', 'body', 'snippet', 'text'])), 2,
    'a notification names the address, provider and source, and carries no content');

  -- A second opt-in changes nothing.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_conn), 'ok', 'a second opt-in succeeds');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and provider = 'google'), 1,
    'a second opt-in adds no source');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_connected'), 2, 'a second opt-in notifies nobody');

  -- The status answers only for the caller's own live Google source.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_msconf), 'ok', 'the member with a Microsoft source opts in');
  perform pg_temp.expect_text(pg_temp.try_grant(v_md), 'ok', 'the md opts in');
  v_status := pg_temp.status_as(v_msconf);
  perform pg_temp.expect_text(v_status ->> 'connected', 'false', 'a Microsoft source is not a Google one');
  v_status := pg_temp.status_as(v_noconsent);
  perform pg_temp.expect_text(v_status ->> 'connected', 'false', 'a seated member who never opted in is not connected');
  perform pg_temp.act_as_none();
  v_res := null;
  begin perform discovery_google_mailbox_status();
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_available', 'no session is refused');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_ms_src and provider = 'microsoft'), 1,
    'the Microsoft source is untouched by the opt-in');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and lower(address) = 'msconf@gc.example'), 1,
    'the opt-in made no second source for the address');

  -- The group: the guard refuses not_in_provider_group until the member is in it.
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'conn@gc.example', 'provider_read', 'sql-test', false, null, 'not_in_provider_group', 'google'),
    'not_in_provider_group', 'the guard waits for the group');
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'waitingForGroup', 'true', 'the status shows the group refusal');
  perform pg_temp.expect_text(mailbox_guard_check(v_t, 'conn@gc.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    null, 'the guard allows once the member is in the group');
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'waitingForGroup', 'false', 'the refusal clears with the first read');
  -- Another member's refusal is not this member's.
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'md@gc.example', 'provider_read', 'sql-test', false, null, 'not_in_provider_group', 'google'),
    'not_in_provider_group', 'the guard waits for the md');
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'waitingForGroup', 'false', 'a colleague''s refusal is not reported to this member');

  -- Pause and resume: the firm admin only.
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id)
  values (v_src, 'gmail-item-1', 'hash-1', 'unrouted', gen_random_uuid());
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_status(v_conn, v_src, 'paused'), '42501:not_available',
    'the mailbox owner is not a firm admin');
  perform pg_temp.expect_text(pg_temp.try_set_status(v_dir, v_src, 'paused'), '42501:not_available',
    'a director without the admin role cannot pause');
  perform pg_temp.expect_text(pg_temp.try_set_status(v_oadmin, v_src, 'paused'), '42501:not_available',
    'another tenant''s admin cannot pause');
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, v_ms_src, 'paused'), '42501:not_available',
    'a Microsoft source cannot be paused here');
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, gen_random_uuid(), 'paused'), '42501:not_available',
    'an unknown source answers like a refused one');
  perform pg_temp.expect_text(left(pg_temp.try_set_status(v_admin, v_src, 'deleted'), 6), '22023:',
    'an unknown status is refused');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and status = 'active'), 1,
    'refused calls changed nothing');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed'), 0, 'refused calls audited nothing');

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, v_src, 'paused'), 'ok', 'the firm admin pauses');
  v_status := pg_temp.status_as(v_conn);
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, v_src, 'paused'), 'ok', 'pausing twice is fine');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'paused', 'true', 'the member sees the source as paused');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and status = 'paused'), 1,
    'pausing keeps the source row');
  perform pg_temp.expect((select count(*) from routing_ledger where source_id = v_src), 1, 'pausing keeps the provenance');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed' and detail ->> 'change' = 'paused' and actor_id = v_admin
    and detail ->> 'provider' = 'google' and detail ->> 'address' = 'conn@gc.example'
    and detail ->> 'sourceId' = v_src::text), 1,
    'one pause audit row, by the admin, and none for the repeat');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'conn@gc.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    'source_paused', 'the guard refuses a paused source');
  -- Opting in again does not revive a paused source.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_conn), 'ok', 'the member opting in again is accepted');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and status = 'paused'), 1,
    'opting in again does not resume a paused source');

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin2, v_src, 'active'), 'ok', 'a firm admin resumes');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and status = 'active'), 1, 'the source is active again');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed' and detail ->> 'change' = 'resumed' and actor_id = v_admin2), 1,
    'one resume audit row');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'conn@gc.example', 'provider_read', 'sql-test', false, null, null, 'google'),
    null, 'the guard allows a resumed source');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed' and detail ->> 'change' = 'connected'), 0,
    'no audit row ever says connected');

  -- First-sync status (#341): the caller's own source, by the ingestion health precedence.
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  insert into feature_flags (key, enabled) values ('discovery_worker_enabled', true) on conflict (key) do update set enabled = true;
  update content_sources set delta_checkpoint = null, backfill_completed_at = null, last_synced_at = null,
                             last_error = null, last_error_at = null
   where id = v_src;
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'not_started', 'a source never read has not started');
  perform pg_temp.expect_text(v_status ->> 'backfillCompletedAt', null, 'no first read has finished');
  perform pg_temp.expect_text(v_status ->> 'lastSyncedAt', null, 'nothing has synced');
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'false', 'no delegation refusal is on record');

  -- A completed pass whose end is outside the liveness window: stale.
  v_start := pg_temp.rp_start(v_src, now() - interval '40 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, now() - interval '40 minutes');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, now() - interval '35 minutes', 'complete', null), now() - interval '35 minutes');
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'stale', 'a completed pass with no live end is stale');

  -- A live unfinished pass: reading.
  v_start := pg_temp.rp_start(v_src, now() - interval '1 minute');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, now() - interval '1 minute');
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'reading', 'a live unfinished pass is reading');

  -- That pass completes now, and the first read is done: up to date, with its timestamps.
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished', pg_temp.rp_end(v_start, now(), 'complete', null), now());
  update content_sources set backfill_completed_at = now(), last_synced_at = now() where id = v_src;
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'up_to_date', 'a live completed pass is up to date');
  perform pg_temp.expect((v_status ->> 'backfillCompletedAt' is not null)::int, 1, 'the first read''s end is reported');
  perform pg_temp.expect((v_status ->> 'lastSyncedAt' is not null)::int, 1, 'the last sync is reported');
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'false', 'an up to date source is not refused');

  -- The worker's delegation error on the active source: refused, whatever the pass row says.
  update content_sources set last_error = 'Google delegation refused', last_error_at = now() where id = v_src;
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'true', 'the worker''s delegation error is a refusal');

  -- The admin grants delegation and a later pass starts reading. last_error clears only when a sync completes, so a
  -- pass that is still running (or ends at the page limit) leaves the old refusal stored: it predates the pass, so
  -- it is no longer a refusal. Both times are the worker's clock (last_error_at, detail.startedAt).
  update content_sources set last_error_at = now() - interval '45 seconds' where id = v_src;
  v_start := pg_temp.rp_start(v_src, now() - interval '30 seconds');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, now() - interval '30 seconds');
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'reading', 'a later live pass with no end is reading');
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'false',
    'a refusal written before the latest pass started does not outlive the fix');
  -- That same running pass is refused: the error is newer than its start, so it is a refusal again.
  update content_sources set last_error_at = now() - interval '10 seconds' where id = v_src;
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'true', 'a refusal written during the latest pass is a refusal');
  update content_sources set last_error = null, last_error_at = null where id = v_src;

  -- A pass that failed for another reason: failing, and not a refusal.
  v_start := pg_temp.rp_start(v_src, now() - interval '20 seconds');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, now() - interval '20 seconds');
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, now() - interval '15 seconds', 'failed', 'google_500'), now() - interval '15 seconds');
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'failing', 'a pass that failed for another reason is failing');
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'false', 'a failing pass is not a refusal');

  -- A pass that failed delegation_refused: delegation_broken, and refused.
  v_start := pg_temp.rp_start(v_src, now());
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_started', v_start, now());
  perform pg_temp.rp_plant(v_t, 'discovery.reader_pass_finished',
    pg_temp.rp_end(v_start, now(), 'failed', 'delegation_refused'), now());
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  -- A colleague who never connected learns nothing of this source.
  v_other := pg_temp.status_as(v_noconsent);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'delegation_broken', 'a delegation_refused pass is delegation_broken');
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'true', 'and it is a refusal');
  perform pg_temp.expect_text(v_other::text, '{"connected": false}', 'another member gets no sync data');

  -- The precedence the card and the banner rely on, over that delegation_broken pass: a switch-off and a halt beat it.
  update feature_flags set enabled = false where key = 'discovery_worker_enabled';
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'switched_off', 'a switch-off beats a delegation_broken pass');
  update feature_flags set enabled = true where key = 'discovery_worker_enabled';
  update content_sources set last_error = 'history_window_exceeded', last_error_at = now() where id = v_src;
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'halted', 'a halt beats a delegation_broken pass');
  -- A paused source is never refused, even with the worker's delegation error newer than the latest pass.
  update content_sources set status = 'paused', last_error = 'Google delegation refused', last_error_at = now() where id = v_src;
  set local role authenticated;
  v_status := pg_temp.status_as(v_conn);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(v_status ->> 'state', 'paused', 'a paused source is paused');
  perform pg_temp.expect_text(v_status ->> 'delegationRefused', 'false', 'a paused source is not a refusal');
  update content_sources set status = 'active', last_error = null, last_error_at = null where id = v_src;

  -- An archived source (#262: an orphaned source renamed address~xyz on the next holder's opt-in)
  -- is closed for good: pause and resume answer like an unknown id and never reopen it, and the
  -- member's status does not report it.
  select id into v_md_src from content_sources where tenant_id = v_t and lower(address) = 'md@gc.example';
  -- Halted first (the database refuses sync-state writes once a source is archived), so the restart
  -- block below can show an archived halted source is still refused.
  update content_sources set last_error = 'history_window_exceeded' where id = v_md_src;
  update content_sources
     set address = address || '~abc', status = 'paused', archived_at = now(), archived_from_address = address
   where id = v_md_src;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, v_md_src, 'active'), '42501:not_available',
    'an archived source cannot be resumed');
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, v_md_src, 'paused'), '42501:not_available',
    'an archived source cannot be paused either');
  v_status := pg_temp.status_as(v_md);
  perform pg_temp.expect_text(v_status ->> 'connected', 'false', 'the status does not report an archived source');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources
    where id = v_md_src and status = 'paused' and archived_at is not null), 1, 'the archived source stays archived and paused');

  -- Restart a halted source (reader liveness): the firm admin only, a halted, unarchived mailbox only.
  update content_sources
     set last_error = 'history_window_exceeded', last_error_at = now(), history_expiry_streak = 2,
         delta_checkpoint = '{"v":1}', backfill_started_at = now() - interval '1 day', backfill_completed_at = now()
   where id = v_src;
  -- The archived source was halted before it was archived (see above), so its refusal is about the archive, not the halt (r10).
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_restart(v_conn, v_src), '42501:not_available', 'the owner cannot restart');
  perform pg_temp.expect_text(pg_temp.try_restart(v_dir, v_src), '42501:not_available', 'a director cannot restart');
  perform pg_temp.expect_text(pg_temp.try_restart(v_oadmin, v_src), '42501:not_available', 'another tenant''s admin cannot');
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_md_src), '42501:not_available', 'an archived halted source cannot');
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_ms_src), '42501:not_available', 'a source that is not halted cannot');
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, gen_random_uuid()), '42501:not_available', 'an unknown id');
  perform pg_temp.act_as_none();
  v_res := null;
  begin perform discovery_restart_mailbox_source(v_src);
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_available', 'no session is refused');
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_src), 'ok', 'the firm admin restarts');
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_src), '42501:not_available', 'a restarted source is no longer halted');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_src
    and last_error is null and last_error_at is null and delta_checkpoint is null and backfill_started_at is null
    and backfill_completed_at is null and history_expiry_streak = 0 and status = 'active'), 1, 'the halt and cursor are cleared');
  perform pg_temp.expect((select count(*) from content_sources where id = v_md_src
    and last_error = 'history_window_exceeded' and archived_at is not null), 1, 'the archived source is untouched');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed' and detail ->> 'change' = 'restarted' and actor_id = v_admin
    and detail ->> 'sourceId' = v_src::text and detail ->> 'address' = 'conn@gc.example'), 1, 'one restart audit row');
  -- The cooldown: the source halts again at once, and a second restart within 24 hours is refused.
  update content_sources
     set last_error = 'history_window_exceeded', last_error_at = now(), history_expiry_streak = 2, delta_checkpoint = '{"v":2}'
   where id = v_src;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_src), '42501:not_available', 'a second restart within 24 hours is refused');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_src
    and last_error = 'history_window_exceeded' and history_expiry_streak = 2 and delta_checkpoint = '{"v":2}'), 1,
    'the refused restart changes no source column');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed' and detail ->> 'change' = 'restarted'
    and detail ->> 'sourceId' = v_src::text), 1, 'the refused restart writes no audit row');
  -- A restart 25 hours ago does not hold the Microsoft source back, and neither does a pause and a resume of it a
  -- minute ago (written as discovery_set_mailbox_source_status writes them): only a restart starts the cooldown.
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail, ts)
  values (v_t, v_admin, 'user', 'discovery.mailbox_access_changed',
          jsonb_build_object('change', 'restarted', 'provider', 'microsoft', 'address', 'old@gc.example', 'sourceId', v_ms_src),
          now() - interval '25 hours'),
         (v_t, v_admin, 'user', 'discovery.mailbox_access_changed',
          jsonb_build_object('change', 'paused', 'provider', 'microsoft', 'address', 'old@gc.example', 'sourceId', v_ms_src),
          now() - interval '2 minutes'),
         (v_t, v_admin, 'user', 'discovery.mailbox_access_changed',
          jsonb_build_object('change', 'resumed', 'provider', 'microsoft', 'address', 'old@gc.example', 'sourceId', v_ms_src),
          now() - interval '1 minute');
  update content_sources set last_error = 'history_window_exceeded' where id = v_ms_src;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_ms_src), 'ok', 'a halted Microsoft source restarts (provider-agnostic)');
  reset role;
  perform pg_temp.act_as_none();

  raise notice 'PASS: Gmail: one-click opt-in creates the Google source and notifies admins, status, group refusal, pause and resume, archived sources, restart of a halted source';
end $$;

-- ── Phase 4 audit fix: a deal seat counts only on a deal of the caller's own tenant ──
do $$
declare
  v_t       uuid := gen_random_uuid();
  v_o       uuid := gen_random_uuid();   -- another tenant, which owns the deal below
  v_b       uuid := gen_random_uuid();
  v_ob      uuid := gen_random_uuid();
  v_deal    uuid := gen_random_uuid();   -- a deal in the caller's tenant
  v_odeal   uuid := gen_random_uuid();   -- a deal in ANOTHER tenant
  v_dir     uuid := gen_random_uuid();
  v_own     uuid := gen_random_uuid();   -- deal_team on a deal of its own tenant: control
  v_foreign uuid := gen_random_uuid();   -- md and deal_team only on the other tenant's deal
  v_role_dt uuid;
  v_role_md uuid;
  v_status  jsonb;
begin
  select id into v_role_dt from roles where slug = 'deal_team';
  select id into v_role_md from roles where slug = 'md';

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,     'xt-dir@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_own,     'xt-own@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_foreign, 'xt-foreign@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where id in (v_dir, v_own, v_foreign);
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'XT Bank', 'bank'), (v_ob, v_o, 'XT Other Bank', 'bank');
  update users set company_id = v_b, company_role = 'director' where id = v_dir;
  update users set company_id = v_b, company_role = 'member' where id in (v_own, v_foreign);
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'xt.example', 'dwd-reader@proj-3.iam.gserviceaccount.com', '323456789012345678',
     'dir-reader@proj-3.iam.gserviceaccount.com', 'conductia-ingest@xt.example', v_b, 'active', now());
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_t, 'own@xt.example',     v_dir, v_b, 'member', 'accepted', 'sent', now(), v_own),
         (v_t, 'foreign@xt.example', v_dir, v_b, 'member', 'accepted', 'sent', now(), v_foreign);

  insert into deals (id, tenant_id, code, codename, bank_id)
  values (v_deal,  v_t, 'XT-' || left(gen_random_uuid()::text, 8), 'Project Own',     v_b),
         (v_odeal, v_o, 'XO-' || left(gen_random_uuid()::text, 8), 'Project Foreign', v_ob);
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, added_by) values
    (v_deal,  v_own,     v_role_dt, 'deal_team', v_dir),
    (v_odeal, v_foreign, v_role_md, 'md',        v_dir);

  set local role authenticated;
  -- A seat only on another tenant's deal does not open the one-click opt-in, however senior the role.
  perform pg_temp.expect_text(pg_temp.try_grant(v_foreign), '42501:not_eligible',
    'a seat only on another tenant''s deal cannot opt in');
  -- Control: a seat on a deal of the caller's own tenant still qualifies.
  perform pg_temp.expect_text(pg_temp.try_grant(v_own), 'ok', 'the same-tenant deal_team user opts in');
  v_status := pg_temp.status_as(v_own);
  perform pg_temp.expect_text(v_status ->> 'connected', 'true', 'the same-tenant member is connected');
  v_status := pg_temp.status_as(v_foreign);
  perform pg_temp.expect_text(v_status ->> 'connected', 'false', 'the refused member is not connected');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and provider = 'google'), 1,
    'only the same-tenant user has a source');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and lower(address) = 'foreign@xt.example'), 0,
    'the refused opt-in created no source');
  -- #353: the opt-in's insert names no window, so its source gets the default.
  perform pg_temp.expect_text((select backfill_since::text from content_sources where tenant_id = v_t and lower(address) = 'own@xt.example'),
    ((now() at time zone 'utc')::date - 90)::text, 'an opted-in Google source reads from 90 days before today (UTC)');

  raise notice 'PASS: Gmail: a deal seat in another tenant does not open the opt-in, and the status follows the caller only';
end $$;

-- ── #353: a firm admin sets the window before the first read, audited ──────
do $$
declare
  v_t      uuid := gen_random_uuid();
  v_o      uuid := gen_random_uuid();   -- another tenant
  v_b      uuid := gen_random_uuid();
  v_ob     uuid := gen_random_uuid();
  v_admin  uuid := gen_random_uuid();
  v_cco    uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();   -- the bank's director, with no firm role
  v_oadmin uuid := gen_random_uuid();
  v_src    uuid := gen_random_uuid();   -- a live Google mailbox that has never read
  v_ms     uuid := gen_random_uuid();   -- a Microsoft mailbox
  v_arch   uuid := gen_random_uuid();   -- an archived Google mailbox
  v_today  date := (now() at time zone 'utc')::date;
  v_res    text;
  v_col    text;
  v_n      integer;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin,  'win-admin@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,    'win-cco@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_member, 'win-member@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_oadmin, 'win-oadmin@example.test', jsonb_build_object('tenant_id', v_o, 'department', 'admin'));
  update users set status = 'active', is_external = false where id in (v_admin, v_cco, v_member, v_oadmin);
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'Win Bank', 'bank'), (v_ob, v_o, 'Win Other Bank', 'bank');
  update users set company_id = v_b, company_role = 'director' where id = v_member;
  update users set company_id = v_b, company_role = 'member' where id in (v_admin, v_cco);
  update users set company_id = v_ob, company_role = 'director' where id = v_oadmin;
  update users set firm_role = 'admin' where id in (v_admin, v_oadmin);
  update users set firm_role = 'cco' where id = v_cco;
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id,
     directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
  values
    (v_t, 'win.example', 'dwd-reader@proj-5.iam.gserviceaccount.com', '523456789012345678',
     'dir-reader@proj-5.iam.gserviceaccount.com', 'conductia-ingest@win.example', v_b, 'active', now()),
    (v_o, 'winother.example', 'dwd-reader@proj-6.iam.gserviceaccount.com', '623456789012345678',
     'dir-reader@proj-6.iam.gserviceaccount.com', 'conductia-ingest@winother.example', v_ob, 'active', now());
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{winms.example}', v_b);
  insert into content_sources (id, tenant_id, kind, provider, address) values
    (v_src,  v_t, 'mailbox', 'google',    'Reader@Win.example'),
    (v_ms,   v_t, 'mailbox', 'microsoft', 'ms@winms.example'),
    (v_arch, v_t, 'mailbox', 'google',    'gone@win.example');
  update content_sources
     set address = address || '~win', status = 'paused', archived_at = now(), archived_from_address = address
   where id = v_arch;
  perform pg_temp.expect_text((select backfill_since::text from content_sources where id = v_src), (v_today - 90)::text,
    'the never-read source starts on the default window');

  -- The route's flag is held in the RPC too (audit r1 item 3): with deal_discovery off, even the admin is refused.
  insert into feature_flags (key, enabled) values ('deal_discovery', false) on conflict (key) do update set enabled = false;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 30), '42501:not_available',
    'the admin cannot set the window with deal_discovery off');
  reset role;
  perform pg_temp.act_as_none();
  update feature_flags set enabled = true where key = 'deal_discovery';

  -- Refusals of the caller or the source: one 42501, whoever asks about whatever.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_window(v_cco, v_src, v_today - 30), '42501:not_available', 'the CCO cannot set the window');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_member, v_src, v_today - 30), '42501:not_available', 'a director without the admin role cannot');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_oadmin, v_src, v_today - 30), '42501:not_available', 'another tenant''s admin cannot');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_ms, v_today - 30), '42501:not_available', 'not on a Microsoft source');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_arch, v_today - 30), '42501:not_available', 'not on an archived source');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, gen_random_uuid(), v_today - 30), '42501:not_available', 'an unknown id');
  -- A stranger learns nothing from the date either: the role is judged first.
  perform pg_temp.expect_text(pg_temp.try_set_window(v_cco, v_src, v_today + 1), '42501:not_available', 'the CCO with a bad date');
  perform pg_temp.act_as_none();
  v_res := null;
  begin perform discovery_set_mailbox_source_window(v_src, v_today - 30);
  exception when others then v_res := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.expect_text(v_res, '42501:not_available', 'no session is refused');

  -- Bounds (owner decision 2026-10-16): today back to 730 days before it, in UTC.
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today + 1), '22023:out_of_range', 'tomorrow is out of range');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 731), '22023:out_of_range', '731 days back is out of range');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, null), '22023:out_of_range', 'no date is out of range');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and backfill_since = v_today - 90), 1,
    'no refusal changed the window');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed'), 0, 'no refusal wrote an audit row');

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 730), 'ok:true', 'the admin sets the window 730 days back');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 730), 'ok:false', 'the same date again is a no-op');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today), 'ok:true', 'and today is accepted');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text((select backfill_since::text from content_sources where id = v_src), v_today::text,
    'the source holds the last date set');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed' and detail ->> 'change' = 'window_set'), 2,
    'one audit row per real change, none for the no-op');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_access_changed' and detail ->> 'change' = 'window_set' and actor_id = v_admin
    and actor_type = 'user' and detail ->> 'sourceId' = v_src::text and detail ->> 'provider' = 'google'
    and detail ->> 'address' = 'reader@win.example'
    and detail ->> 'from' = (v_today - 90)::text and detail ->> 'to' = (v_today - 730)::text), 1,
    'the first change names who, which source, from and to');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and detail ->> 'change' = 'window_set'
    and detail ->> 'from' = (v_today - 730)::text and detail ->> 'to' = v_today::text), 1,
    'the second change too');
  perform pg_temp.expect((select count(*) from audit_log a where a.tenant_id = v_t and detail ->> 'change' = 'window_set'
    and (select array_agg(k order by k) from jsonb_object_keys(a.detail) k)
        = array['address', 'change', 'from', 'provider', 'sourceId', 'to']), 2, 'the audit detail carries nothing else');

  -- Once reading has started the window is fixed: each of the three columns locks it alone.
  foreach v_col in array array['delta_checkpoint', 'backfill_started_at', 'backfill_completed_at'] loop
    execute format('update content_sources set %I = %s where id = $1', v_col,
                   case when v_col = 'delta_checkpoint' then quote_literal('{"v":1}') else 'now()' end) using v_src;
    set local role authenticated;
    perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 10), '55000:window_locked',
      v_col || ' alone locks the window');
    reset role;
    perform pg_temp.act_as_none();
    execute format('update content_sources set %I = null where id = $1', v_col) using v_src;
  end loop;
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and backfill_since = v_today), 1,
    'a locked window is unchanged');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and detail ->> 'change' = 'window_set'), 2,
    'a locked refusal writes no audit row');

  -- A pass that has started with no checkpoint yet (audit r1 item 1): the worker's first-read claim
  -- (worker/sync.ts firstReadClaim) is this statement, run before the reader's first Gmail request. It returns the
  -- window the reader then uses, and from then on the RPC refuses and health reports the window locked.
  update content_sources set backfill_started_at = now()
   where id = v_src and tenant_id = v_t and archived_at is null returning backfill_since::text into v_res;
  perform pg_temp.expect_text(v_res, v_today::text, 'the claim returns the window the reader will read');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src
    and delta_checkpoint is null and backfill_completed_at is null and backfill_started_at is not null), 1,
    'a started pass with no checkpoint');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 10), '55000:window_locked',
    'a started pass with no checkpoint locks the window');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text((select s ->> 'windowLocked' from jsonb_array_elements(discovery_ingestion_health() -> 'sources') s
    where s ->> 'id' = v_src::text), 'true', 'and health reports it locked');
  reset role;
  perform pg_temp.act_as_none();
  -- An archived source matches no row: the claim writes nothing to it (#262).
  update content_sources set backfill_started_at = now()
   where id = v_arch and tenant_id = v_t and archived_at is null;
  get diagnostics v_n = row_count;
  perform pg_temp.expect(v_n, 0, 'the claim writes nothing to an archived source');
  update content_sources set backfill_started_at = null where id = v_src;

  -- Recovery of a long read that halted: pause, restart, set a shorter window, resume. A paused source is never
  -- queued, so nothing locks the window between restart and edit.
  update content_sources
     set last_error = 'history_window_exceeded', last_error_at = now(), history_expiry_streak = 1,
         delta_checkpoint = '{"v":1}', backfill_started_at = now() - interval '6 days', backfill_completed_at = now()
   where id = v_src;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 30), '55000:window_locked', 'a halted source is locked');
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, v_src, 'paused'), 'ok', 'the admin pauses it');
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_src), 'ok', 'restarts it');
  perform pg_temp.expect_text(pg_temp.try_set_window(v_admin, v_src, v_today - 30), 'ok:true', 'sets a shorter window');
  perform pg_temp.expect_text(pg_temp.try_set_status(v_admin, v_src, 'active'), 'ok', 'and resumes it');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and status = 'active'
    and backfill_since = v_today - 30 and last_error is null and delta_checkpoint is null
    and backfill_started_at is null and backfill_completed_at is null), 1, 'the source reads again from the shorter window');
  -- It halts again at once: the restart cooldown still holds, so the recovery is once per 24 hours per source.
  update content_sources
     set last_error = 'history_window_exceeded', last_error_at = now(), history_expiry_streak = 2, delta_checkpoint = '{"v":2}'
   where id = v_src;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_restart(v_admin, v_src), '42501:not_available',
    'a second restart within 24 hours is refused');
  reset role;
  perform pg_temp.act_as_none();

  raise notice 'PASS: Gmail: the firm admin sets the window before the first read, within 730 days (UTC), audited; locked once reading starts; pause, restart, shorten, resume recovers once per 24 hours';
end $$;

rollback;
