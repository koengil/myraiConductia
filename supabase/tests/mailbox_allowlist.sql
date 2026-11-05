-- Invitation-scoped mailbox access (20261001130000_mailbox_allowlist.sql, #262).
-- The allowlist views, the guard's reasons and audit rows, the two consent
-- RPCs, the seat-loss trigger and the grants.
--
-- The file runs top to bottom, and each count is asserted against the state at
-- its own step:
--   1. fixture setup, including `withdrawn`'s grant and withdrawal and
--      `reseated`'s removal and re-seat
--   2. the view truth table and the guard's reasons on that state, then
--      mailbox_consent_status() for the caller on the same state
--   3. the firm is only a same-tenant bank (savepoint)
--   4. owner and provider reasons, audit rows and dedupe
--   5. the sections that change state: `noconsent`'s grant, the not_eligible
--      refusals, the append-only probe, `reseated`'s re-grant, a role change
--   6. the fold check and the grants
--   7. Q1 = B: what an unread mailbox does to session reads (Phase 3), the
--      one-line switch to option A, and a withdrawal deleting the mail (#461)
--   8. Provider group drift (Phase 4), in its own do block and its own fixture
--   9. Tool reads (Phase 6): mailbox_items_visible_to and every-call audit for tool purposes
--  10. SharePoint sites (Phase 7, R23): the registry, site_guard_check, the validator and the grants
--  11. PR #300 review fixes: C11 source owner, C10 site registrant, C12 stale consent, C13 withdraw reason,
--      C20 opt-in creates the source, C5 ingestion health, C25 drift with no recipients
--  12. PR #300 follow-up: opt-in readiness (item 1), a stale site registrant (item 2), health on a tenant
--      whose registration names no firm (item 3)
-- Consent state changes only through the RPCs under act_as (audit round 1,
-- item 14: no writer but the owner's own session can insert a consent, and no
-- role but the table owner can even try). A state no eligible user can reach
-- directly (another domain, another bank, an earlier invite) is built by
-- changing the registration or the invites around the RPC call, never by a
-- direct insert.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/mailbox_allowlist.sql
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

-- A Google source needs a Google registration to exist (#259, plan D1). A pending one reads nothing
-- and names no firm, so a probe that only needs a google row leaves every other expectation unchanged.
create function pg_temp.pending_google(p_t uuid)
returns void language sql as $$
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values
    (p_t, 'gmail-only.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@gmail-only.example')
  on conflict (tenant_id) do nothing;
$$;

-- What the caller sees, as candidates/links/items/visibility rows/texts. Runs
-- as the caller (security invoker), so RLS applies.
create function pg_temp.snap()
returns text language sql as $$
  select (select count(*) from deal_candidates)::text || '/' || (select count(*) from evidence_links)::text || '/'
      || (select count(*) from source_items)::text || '/' || (select count(*) from candidate_visibility)::text || '/'
      || (select count(*) from source_item_texts)::text;
$$;

-- No session: auth.uid() is null, so audit rows are written as the service.
create function pg_temp.act_as_none()
returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;

-- Calls mailbox_consent_grant() as p_user and returns the error, or 'ok'.
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

-- Seats a user on a deal of their tenant (A2: the opt-in needs MD or deal team on one). One deal per tenant
-- ('mk-<tenant>', banked by the user's company), created on first use; idempotent. Run as the table owner.
create function pg_temp.on_deal(p_user uuid, p_deal_role text default 'deal_team')
returns uuid language plpgsql as $$
declare
  v_tenant uuid;
  v_company uuid;
  v_deal uuid;
begin
  select tenant_id, company_id into v_tenant, v_company from users where id = p_user;
  select id into v_deal from deals where code = 'mk-' || v_tenant::text;
  if v_deal is null then
    insert into deals (tenant_id, code, codename, bank_id)
    values (v_tenant, 'mk-' || v_tenant::text, 'Mailbox fixture', v_company) returning id into v_deal;
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values (v_deal, p_user, (select id from roles where slug = p_deal_role), p_deal_role)
  on conflict (deal_id, user_id) do update set deal_role = excluded.deal_role, role_id = excluded.role_id;
  return v_deal;
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

-- The same with a session for p_user, so a trigger that binds auth.uid() can be
-- exercised by a writer that would otherwise pass the privilege check.
create function pg_temp.try_sql_as(p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return pg_temp.try_sql(p_sql);
end;
$$;

-- The privileges the service role holds on a relation, as a sorted list.
create function pg_temp.svc_privs(p_rel text)
returns text language sql as $$
  select coalesce(string_agg(p, ',' order by p), '')
  from unnest(array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p
  where has_table_privilege('service_role', p_rel, p);
$$;

-- A tool read binds the source owner (item 3 of the round-1 audit): the helper
-- passes the allowlisted user as the owner, so an allowed mailbox stays allowed
-- and every other reason comes from the same branch as without an owner.
create function pg_temp.guard(p_tenant uuid, p_address text, p_provider text default 'microsoft')
returns text language sql as $$
  select mailbox_guard_check(p_tenant, p_address, 'agent_tool', 'sql-test', true,
    (select a.user_id from allowed_mailboxes a
      where a.tenant_id = p_tenant and a.address = lower(trim(p_address)) limit 1),
    p_provider => p_provider);
$$;

-- New functions no longer grant PUBLIC EXECUTE by default (#233); the
-- helpers above run as anon, authenticated and service_role. They are
-- security invoker, so a helper that calls a service-role-only function is
-- still refused under the calling role.
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_u        uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();   -- the firm: a bank in T that the registration names
  v_b2       uuid := gen_random_uuid();   -- a second bank in T (the Northwind shape)
  v_x        uuid := gen_random_uuid();   -- a counterparty in T
  v_ub       uuid := gen_random_uuid();   -- another tenant's bank
  v_dir_b    uuid := gen_random_uuid();
  v_dir_b2   uuid := gen_random_uuid();
  v_dir_x    uuid := gen_random_uuid();
  v_dir_u    uuid := gen_random_uuid();
  v_seated   uuid := gen_random_uuid();
  v_other    uuid := gen_random_uuid();   -- otherbank
  v_reseated uuid := gen_random_uuid();
  v_pending  uuid := gen_random_uuid();
  v_removed  uuid := gen_random_uuid();
  v_external uuid := gen_random_uuid();
  v_nocons   uuid := gen_random_uuid();
  v_withdr   uuid := gen_random_uuid();
  v_wrongdom uuid := gen_random_uuid();
  v_reinv    uuid := gen_random_uuid();
  v_foreign  uuid := gen_random_uuid();
  v_inv_seated   uuid := gen_random_uuid();
  v_inv_other    uuid := gen_random_uuid();
  v_inv_reseated uuid := gen_random_uuid();
  v_inv_removed  uuid := gen_random_uuid();
  v_inv_external uuid := gen_random_uuid();
  v_inv_nocons   uuid := gen_random_uuid();
  v_inv_withdr   uuid := gen_random_uuid();
  v_inv_wrongdom uuid := gen_random_uuid();
  v_inv_reinv1   uuid := gen_random_uuid();
  v_inv_reinv2   uuid := gen_random_uuid();
  v_inv_foreign  uuid := gen_random_uuid();
  v_consent      uuid;
  v_cco          uuid := gen_random_uuid();
  v_src_seated   uuid := gen_random_uuid();
  v_src_nocons   uuid := gen_random_uuid();
  v_item_a       uuid := gen_random_uuid();   -- seated's, on candidate 1
  v_item_b       uuid := gen_random_uuid();   -- noconsent's, on candidate 1
  v_item_c       uuid := gen_random_uuid();   -- seated's, on candidate 2
  v_cand1        uuid;
  v_cand2        uuid;
  v_result       jsonb;
  v_text         text;
  v_cnt          bigint;
  v_before       bigint;
  v_blocked      boolean;
begin
  -- ── 1. Fixture, as the table owner ───────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir_b,    'ma-dir-b@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir_b2,   'ma-dir-b2@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir_x,    'ma-dir-x@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir_u,    'ma-dir-u@example.test',    jsonb_build_object('tenant_id', v_u, 'department', 'ib')),
    (v_seated,   'ma-seated@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_other,    'ma-other@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_reseated, 'ma-reseated@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_pending,  'ma-pending@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_removed,  'ma-removed@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_external, 'ma-external@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_nocons,   'ma-nocons@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_withdr,   'ma-withdr@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_wrongdom, 'ma-wrongdom@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_reinv,    'ma-reinv@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_foreign,  'ma-foreign@example.test',  jsonb_build_object('tenant_id', v_u, 'department', 'ib'));
  update users set status = 'active', is_external = false
    where id in (v_dir_b, v_dir_b2, v_dir_x, v_dir_u, v_seated, v_other, v_reseated, v_pending, v_removed,
                 v_external, v_nocons, v_withdr, v_wrongdom, v_reinv, v_foreign);

  insert into companies (id, tenant_id, name, type) values
    (v_b,  v_t, 'MA Bank',         'bank'),
    (v_b2, v_t, 'MA Other Bank',   'bank'),
    (v_x,  v_t, 'MA Counterparty', 'counterparty'),
    (v_ub, v_u, 'MA Foreign Bank', 'bank');
  -- The director first: a company may not hold a member without one.
  update users set company_id = v_b,  company_role = 'director' where id = v_dir_b;
  update users set company_id = v_b2, company_role = 'director' where id = v_dir_b2;
  update users set company_id = v_x,  company_role = 'director', is_external = true where id = v_dir_x;
  update users set company_id = v_ub, company_role = 'director' where id = v_dir_u;
  update users set company_id = v_b,  company_role = 'member'
    where id in (v_seated, v_reseated, v_removed, v_nocons, v_withdr, v_wrongdom, v_reinv);
  update users set company_id = v_b2, company_role = 'member' where id = v_other;
  update users set company_id = v_x,  company_role = 'member', is_external = true where id = v_external;
  update users set company_id = v_ub, company_role = 'member' where id = v_foreign;
  -- A2: every member who opts in below is deal team on a deal of the tenant, which the one-click opt-in requires.
  perform pg_temp.on_deal(u) from unnest(array[v_seated, v_other, v_reseated, v_removed, v_nocons, v_withdr, v_wrongdom,
    v_reinv, v_pending, v_external]) u;

  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_b);

  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (v_inv_seated,   v_t, 'seated@bank.example',    v_dir_b,  v_b,  'member', 'accepted', 'sent', now(), v_seated),
    (v_inv_other,    v_t, 'otherbank@bank.example', v_dir_b2, v_b2, 'member', 'accepted', 'sent', now(), v_other),
    (v_inv_reseated, v_t, 'reseated@bank.example',  v_dir_b,  v_b,  'member', 'accepted', 'sent', now(), v_reseated),
    (v_inv_removed,  v_t, 'removed@bank.example',   v_dir_b,  v_b,  'member', 'accepted', 'sent', now(), v_removed),
    (v_inv_external, v_t, 'external@bank.example',  v_dir_x,  v_x,  'member', 'accepted', 'sent', now(), v_external),
    (v_inv_nocons,   v_t, 'noconsent@bank.example', v_dir_b,  v_b,  'member', 'accepted', 'sent', now(), v_nocons),
    (v_inv_withdr,   v_t, 'withdrawn@bank.example', v_dir_b,  v_b,  'member', 'accepted', 'sent', now(), v_withdr),
    (v_inv_wrongdom, v_t, 'wrongdomain@other.example', v_dir_b, v_b, 'member', 'accepted', 'sent', now(), v_wrongdom),
    (v_inv_reinv1,   v_t, 'reinvited@bank.example', v_dir_b,  v_b,  'member', 'accepted', 'sent', now() - interval '2 days', v_reinv),
    (v_inv_foreign,  v_u, 'foreign@bank.example',   v_dir_u,  v_ub, 'member', 'accepted', 'sent', now(), v_foreign);
  -- A pending invite only: the user has no seat and nothing accepted.
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status)
  values (v_t, 'pending@bank.example', v_dir_b, v_b, 'member', 'pending', 'sent');

  perform pg_temp.act_as_none();
  -- Every consent goes through mailbox_consent_grant() as its owner. A state the
  -- RPC cannot reach directly is built around the call.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_seated),   'ok', 'seated opts in');
  perform pg_temp.expect_text(pg_temp.try_grant(v_reseated), 'ok', 'reseated opts in');
  perform pg_temp.expect_text(pg_temp.try_grant(v_removed),  'ok', 'removed opts in');
  -- `reinvited` opts in on the earlier invite; the later one arrives after.
  perform pg_temp.expect_text(pg_temp.try_grant(v_reinv),    'ok', 'reinvited opts in on the earlier invite');
  reset role;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_inv_reinv2, v_t, 'reinvited@bank.example', v_dir_b, v_b, 'member', 'accepted', 'sent',
          now() - interval '1 day', v_reinv);
  -- `wrongdomain` opts in while its domain is registered; the registration then narrows.
  update graph_reader_registrations set mailbox_domains = '{bank.example,other.example}' where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_wrongdom), 'ok', 'wrongdomain opts in while its domain is registered');
  reset role;
  update graph_reader_registrations set mailbox_domains = '{bank.example}' where tenant_id = v_t;
  -- `otherbank` opts in while the registration names its bank; the registration then names B again.
  update graph_reader_registrations set firm_company_id = v_b2 where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_other), 'ok', 'otherbank opts in while its bank is the firm');
  reset role;
  update graph_reader_registrations set firm_company_id = v_b where tenant_id = v_t;

  -- `withdrawn`: consented and withdrawn through the RPCs, as the user.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_withdr), 'ok', 'withdrawn can grant');
  perform pg_temp.act_as(v_withdr);
  v_result := mailbox_consent_withdraw();
  perform pg_temp.expect_text(v_result->>'consented', 'false', 'the withdraw RPC answers consented false');
  reset role;
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_withdr and withdrawn_at is not null), 1,
    'withdrawn_at is set on the withdrawn row');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consent_withdrawn'
    and detail->>'address' = 'withdrawn@bank.example' and actor_type = 'user' and actor_id = v_withdr
    and detail->>'reason' = 'withdrawn'), 1, 'the user''s own withdrawal is one user-actor row with reason withdrawn');
  set local role authenticated;
  perform pg_temp.act_as(v_withdr);
  perform mailbox_consent_withdraw();
  reset role;
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consent_withdrawn'
    and detail->>'address' = 'withdrawn@bank.example'), 1, 'a second withdraw writes nothing');

  -- `removed` and `reseated` lose their seat (the members route's effect).
  perform pg_temp.act_as_none();
  update users set company_id = null, company_role = null, status = 'suspended' where id in (v_removed, v_reseated);
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id in (v_removed, v_reseated)
    and withdrawn_at is null), 0, 'seat loss withdrew both open consents');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consent_withdrawn'
    and detail->>'address' = 'reseated@bank.example' and actor_type = 'service'
    and service_identity = 'mailbox-consent' and detail->>'reason' = 'seat_lost'), 1,
    'seat loss writes one service row with reason seat_lost');
  -- `reseated` returns by the members route's re-seat.
  update users set company_id = v_b, company_role = 'member', status = 'active' where id = v_reseated;
  -- Losing the company deleted the member's deal memberships (the removal cascade), so the re-seat puts them back on a deal.
  perform pg_temp.on_deal(v_reseated);
  raise notice 'PASS: fixture built; withdrawn and seat-lost consents audited';

  -- ── 2. The view truth table and the guard's reasons ──────────────────────
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 1, 'only `seated` is allowed');
  perform pg_temp.expect_text((select address from allowed_mailboxes where tenant_id = v_t), 'seated@bank.example',
    'the one allowed address is seated''s');
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_u), 0, 'the other tenant has none');
  -- Each provider group mirrors its own mailboxes (audit round 1, item 22): the
  -- view names the provider, and every registered domain is a Graph one today.
  perform pg_temp.expect_text((select provider from allowed_mailboxes where tenant_id = v_t), 'microsoft',
    'the allowed address belongs to the microsoft group');

  -- Round 3, item 6: the guard refuses an address with no content_sources mailbox
  -- row (`no_source`), for every purpose, so each address judged below has its
  -- source, as production writes one before any read. `seated` and `noconsent`
  -- carry their owner; the ids are reused by section 7.
  -- Seven opt-ins above each created their owner's source (C20). Four of them
  -- (seated, wrongdomain, reinvited, otherbank) still exist; the three whose
  -- consent ended (removed, reseated, withdrawn) lost theirs with it (#461), and
  -- are written again here, owned as before, so the guard judges their consent
  -- and seat rather than the missing source. The rest, whose owners never opted
  -- in, are written here too, so eleven in all. `noconsent`'s is written with its
  -- owner; its opt-in in section 5 finds it.
  select id into v_src_seated from content_sources where tenant_id = v_t and address = 'seated@bank.example';
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t), 4,
    'the seven opt-ins created seven mailbox sources; the three ended consents deleted theirs');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t
    and address in ('removed@bank.example', 'reseated@bank.example', 'withdrawn@bank.example')), 0,
    'an ended consent deleted its mailbox source');
  insert into content_sources (tenant_id, kind, address, owner_user_id) values
    (v_t, 'mailbox', 'removed@bank.example', v_removed),
    (v_t, 'mailbox', 'reseated@bank.example', v_reseated),
    (v_t, 'mailbox', 'withdrawn@bank.example', v_withdr);
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and owner_user_id is not null
    and provider = 'microsoft' and status = 'active'), 7, 'each owned by its opt-in user, active, on microsoft');
  insert into content_sources (id, tenant_id, kind, address, owner_user_id) values
    (v_src_nocons, v_t, 'mailbox', 'noconsent@bank.example', v_nocons);
  insert into content_sources (tenant_id, kind, address) values
    (v_t, 'mailbox', 'pending@bank.example'),
    (v_t, 'mailbox', 'external@bank.example'),
    (v_t, 'mailbox', 'foreign@bank.example');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'pending@bank.example'),    'no_invite',    'pending: no_invite');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'removed@bank.example'),    'seat_inactive','removed: seat_inactive');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'external@bank.example'),   'external',     'external: external');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'otherbank@bank.example'),  'external',     'a bank the registration does not name: external');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'reseated@bank.example'),   'no_consent',   'reseated: no_consent (seat loss withdrew it)');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'noconsent@bank.example'),  'no_consent',   'noconsent: no_consent');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'withdrawn@bank.example'),  'no_consent',   'withdrawn: no_consent');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'wrongdomain@other.example'), 'domain',     'wrongdomain: domain');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'reinvited@bank.example'),  'no_consent',   'reinvited: the older consent does not revive');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'foreign@bank.example'),    'no_invite',    'another tenant''s address: no_invite');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example'),     null,           'seated: allowed');
  perform pg_temp.expect_text(pg_temp.guard(v_t, '  SEATED@Bank.Example '),  null,           'the address is trimmed and lowercased');

  -- Every refusal wrote one content-free row; the allowed call wrote none.
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_refused' and service_identity = 'sql-test'), 10, 'ten refusals, ten rows');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_refused' and actor_type = 'service' and chain_seq is not null), 10,
    'refusal rows are service rows on the hash chain');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and (select array_agg(k order by k) from jsonb_object_keys(detail) k) = array['address', 'purpose', 'reason']), 10,
    'refusal detail holds exactly address, reason and purpose');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail->>'address' = 'seated@bank.example'), 0, 'an allowed read writes no refusal');
  raise notice 'PASS: view truth table and guard reasons';

  -- ── 2b. mailbox_consent_status(): the caller's own answer (Phase 2) ───────
  -- Read-only, so it runs on the state of section 2: `seated` consented,
  -- `noconsent` eligible and not consented, the rest with no seat.
  set local role authenticated;
  perform pg_temp.act_as(v_seated);
  v_result := mailbox_consent_status();
  perform pg_temp.expect_text(v_result->>'eligible', 'true', 'status: seated is eligible');
  perform pg_temp.expect_text(v_result->>'consented', 'true', 'status: seated is consented');
  perform pg_temp.expect_text(v_result->>'address', 'seated@bank.example', 'status: seated''s address');
  perform pg_temp.expect_text((v_result->>'since' is null)::text, 'false', 'status: seated has a since');
  perform pg_temp.act_as(v_nocons);
  v_result := mailbox_consent_status();
  perform pg_temp.expect_text(v_result->>'eligible', 'true', 'status: noconsent is eligible');
  perform pg_temp.expect_text(v_result->>'consented', 'false', 'status: noconsent is not consented');
  perform pg_temp.expect_text(v_result->>'address', 'noconsent@bank.example', 'status: noconsent''s address');
  perform pg_temp.act_as(v_wrongdom);
  v_result := mailbox_consent_status();
  perform pg_temp.expect_text(v_result->>'eligible', 'false', 'status: wrongdomain is not eligible');
  perform pg_temp.expect_text(v_result->>'reason', 'domain', 'status: wrongdomain reason is domain');
  perform pg_temp.expect_text(v_result->>'address', 'wrongdomain@other.example', 'status: wrongdomain''s address');
  -- wrongdomain holds an open consent (written directly in the fixture), and the card must still offer withdrawal.
  perform pg_temp.expect_text(v_result->>'consented', 'true', 'status: an open consent is reported whatever the eligibility');
  -- No seat: external, otherbank, removed (seat lost) and pending (nothing accepted).
  perform pg_temp.act_as(v_external);
  perform pg_temp.expect_text(mailbox_consent_status()->>'eligible', 'false', 'status: external is not eligible');
  perform pg_temp.expect_text(mailbox_consent_status()->>'reason', 'no_invite', 'status: external reason is no_invite');
  perform pg_temp.act_as(v_other);
  perform pg_temp.expect_text(mailbox_consent_status()->>'eligible', 'false', 'status: otherbank is not eligible');
  perform pg_temp.expect_text(mailbox_consent_status()->>'reason', 'no_invite', 'status: otherbank reason is no_invite');
  perform pg_temp.act_as(v_removed);
  perform pg_temp.expect_text(mailbox_consent_status()->>'eligible', 'false', 'status: removed is not eligible');
  perform pg_temp.expect_text(mailbox_consent_status()->>'reason', 'no_invite', 'status: removed reason is no_invite');
  perform pg_temp.expect_text(mailbox_consent_status()->>'consented', 'false', 'status: removed holds no open consent (seat loss closed it)');
  perform pg_temp.act_as(v_pending);
  perform pg_temp.expect_text(mailbox_consent_status()->>'eligible', 'false', 'status: pending is not eligible');
  perform pg_temp.expect_text(mailbox_consent_status()->>'reason', 'no_invite', 'status: pending reason is no_invite');
  -- Callable by authenticated only, with a session.
  perform pg_temp.act_as_none();
  v_blocked := false;
  begin perform mailbox_consent_status();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a status call with no auth.uid() succeeded'; end if;
  reset role;
  set local role anon;
  v_blocked := false;
  begin perform mailbox_consent_status();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon ran mailbox_consent_status'; end if;
  reset role;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_refused' and service_identity = 'sql-test'), 10, 'status writes no audit row');
  raise notice 'PASS: mailbox_consent_status answers for the caller only';

  -- ── 3. The firm is only a same-tenant bank (R20) ─────────────────────────
  begin
    update graph_reader_registrations set firm_company_id = v_x where tenant_id = v_t;
    perform pg_temp.expect(coalesce(array_length(reader_firm_company_ids(v_t, 'microsoft'), 1), 0), 0,
      'a counterparty is not a firm');
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 0,
      'no firm, no allowed mailbox (counterparty)');
    update graph_reader_registrations set firm_company_id = v_ub where tenant_id = v_t;
    perform pg_temp.expect(coalesce(array_length(reader_firm_company_ids(v_t, 'microsoft'), 1), 0), 0,
      'another tenant''s bank is not a firm');
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 0,
      'no firm, no allowed mailbox (another tenant)');
    -- Disabled: reads stop, but the firm is still known to the control room.
    update graph_reader_registrations set firm_company_id = v_b, status = 'disabled' where tenant_id = v_t;
    perform pg_temp.expect(coalesce(array_length(reader_firm_company_ids(v_t, 'microsoft'), 1), 0), 0,
      'a disabled registration has no reading firm');
    perform pg_temp.expect(coalesce(array_length(firm_company_ids(v_t), 1), 0), 1,
      'a disabled registration still identifies the firm');
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 0,
      'a disabled registration allows no mailbox');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 1,
    'the savepoint rolled back: seated is allowed again');
  raise notice 'PASS: only a same-tenant bank the registration names is the firm';

  -- Consent resurrection is accepted as designed (audit round 1, item 19): the
  -- member consented and an admin paused the registration, so restoring it
  -- admits the mailbox again with no new opt-in and no new audit row. Only
  -- losing the seat (or deleting the invite) ends a consent.
  select count(*) into v_before from audit_log where tenant_id = v_t and action like 'discovery.mailbox_consent%';
  begin
    update graph_reader_registrations set mailbox_domains = '{}' where tenant_id = v_t;
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 0,
      'no registered domain, no allowed mailbox');
    perform pg_temp.expect((select count(*) from mailbox_consents where tenant_id = v_t and user_id = v_seated
      and withdrawn_at is null), 1, 'the consent stays open while the registration is paused');
    update graph_reader_registrations set mailbox_domains = '{bank.example}' where tenant_id = v_t;
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 1,
      'restoring the domains admits seated again');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
      and action like 'discovery.mailbox_consent%'), v_before, 'and writes no consent audit row');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  raise notice 'PASS: a paused and restored registration resurrects an open consent, by design';

  -- ── 3b. A mailbox is judged against its own provider's registration (C2, C5, C6) ──
  -- A `google` source on a Microsoft-registered domain is the case "a domain
  -- registered only under the other provider": the Graph registration must not
  -- admit it, in the view, the guard or the RLS helpers. (The Google source needs a
  -- Google registration to exist, #259 plan D1; the test adds a pending one.) The one-argument registration functions (the
  -- union of the providers) no longer exist.
  perform pg_temp.expect((select count(*) from pg_proc where proname in
    ('reader_mailbox_domains', 'reader_firm_company_ids') and pronargs = 1), 0,
    'no one-argument registration function is left to take the union');
  perform pg_temp.expect_text(to_regprocedure('reader_mailbox_domains(uuid, text)')::text, 'reader_mailbox_domains(uuid,text)',
    'the provider-aware domain function exists');
  perform pg_temp.expect_text(reader_mailbox_domains(v_t, 'microsoft')::text, '{bank.example}', 'microsoft: the registered domains');
  perform pg_temp.expect_text(reader_mailbox_domains(v_t, 'google')::text, '{}', 'google: no active registration, no domains');
  perform pg_temp.expect_text(reader_mailbox_domains(v_t, 'yahoo')::text, '{}', 'an unknown provider has no domains');
  perform pg_temp.expect_text(reader_firm_company_ids(v_t, 'microsoft')::text, ('{' || v_b || '}'), 'microsoft: the firm');
  perform pg_temp.expect_text(reader_firm_company_ids(v_t, 'google')::text, '{}', 'google: no active registration, no firm');
  perform pg_temp.expect_text(firm_company_ids(v_t)::text, ('{' || v_b || '}'), 'the union of firms today is the Graph registration''s');
  perform pg_temp.expect_text(reader_registration_active(v_t, 'microsoft')::text, 'true', 'microsoft: registration active');
  perform pg_temp.expect_text(reader_registration_active(v_t, 'google')::text, 'false', 'google: no registration');
  perform pg_temp.expect_text(mailbox_reader_providers(v_t, 'seated@bank.example', v_b)::text, '{microsoft}',
    'a bank.example address at the firm reads through microsoft only');
  perform pg_temp.expect_text(mailbox_reader_providers(v_t, 'seated@bank.example', v_b2)::text, '{}',
    'the same address at a bank the registration does not name reads through no one');
  perform pg_temp.expect_text(mailbox_reader_providers(v_t, 'wrongdomain@other.example', v_b)::text, '{}',
    'an unregistered domain reads through no one');
  begin
    -- A pending Google registration (#259, plan D1): a Google source needs one to exist. It
    -- reads nothing (pending) and names no firm, so every expectation below is unchanged.
    insert into google_reader_registrations
      (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
    values
      (v_t, 'gmail-only.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
       'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@gmail-only.example');
    update content_sources set provider = 'google' where tenant_id = v_t and address = 'seated@bank.example';
    -- The view is per address and provider: seated is still a Microsoft mailbox, and not a google one.
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t and provider = 'microsoft'), 1,
      'the view still shows seated for microsoft');
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t and provider = 'google'), 0,
      'the view shows no google row for a microsoft-registered domain');
    -- The guard resolves the source's provider and finds no google registration.
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example', 'google'), 'registration_inactive',
      'a google source on a microsoft-registered domain is refused: registration_inactive');
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test-provider', true, v_seated, p_provider => 'google'),
      'registration_inactive', 'provider_read is refused too');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
      and service_identity = 'sql-test-provider' and detail->>'reason' = 'registration_inactive'), 1,
      'the refusal is audited once with its reason');
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test-provider', true, v_seated, p_provider => 'google'),
      'registration_inactive', 'the same provider_read refusal again');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
      and service_identity = 'sql-test-provider'), 1, 'and the dedupe still holds');
    -- The caller's provider must be the source's (round 2, item 6): a Microsoft
    -- reader asking about the google source is refused before any allowlist test,
    -- and the refusal is audited with its reason.
    select count(*) into v_before from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused';
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example', 'microsoft'), 'provider_mismatch',
      'a microsoft caller on a google source: provider_mismatch');
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test-mismatch', true, v_seated, p_provider => 'microsoft'),
      'provider_mismatch', 'provider_read is refused with provider_mismatch too');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
      and detail->>'reason' = 'provider_mismatch'), 2, 'each mismatch is audited with its reason (agent_tool every time, provider_read once)');
    perform pg_temp.expect_text((select last_reason from mailbox_guard_state where tenant_id = v_t and address = 'seated@bank.example'),
      'provider_mismatch', 'the provider_read state records provider_mismatch (the CHECK admits it)');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'), v_before + 2,
      'and nothing else was audited');
    -- The source's own provider reaches the registration check, not the mismatch.
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example', 'google'), 'registration_inactive',
      'the google caller on the google source is judged by the registration');
    -- The same source, read as microsoft again, is allowed again.
    update content_sources set provider = 'microsoft' where tenant_id = v_t and address = 'seated@bank.example';
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example'), null, 'a microsoft source on its own registration is allowed');
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example', 'google'), 'provider_mismatch',
      'a google caller on a microsoft source: provider_mismatch');
    -- A provider that is not registered says so, whoever the address belongs to.
    update content_sources set provider = 'google' where tenant_id = v_t and address = 'seated@bank.example';
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'pending@bank.example'), 'no_invite',
      'a microsoft source is judged as microsoft (its own reasons)');
    -- The source's provider is the only one a caller may name, so a google caller
    -- fails closed instead of reading a mailbox its source does not name.
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'pending@bank.example', 'google'), 'provider_mismatch',
      'a microsoft source is provider_mismatch for a google caller');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  -- A disabled Graph registration is registration_inactive for a microsoft source too.
  begin
    update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example'), 'registration_inactive',
      'a disabled microsoft registration: registration_inactive');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example'), null, 'the savepoints restored the registration and the source');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t), 11,
    'and left only the eleven fixture sources behind');
  raise notice 'PASS: a mailbox is judged against its own provider''s registration';

  -- ── 4. Owner and provider reasons, and the audit dedupe ──────────────────
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', true, v_nocons, p_provider => 'microsoft'),
    'owner_mismatch', 'another owner: owner_mismatch');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', true, null, p_provider => 'microsoft'),
    'owner_mismatch', 'a null owner: owner_mismatch');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail->>'address' = 'seated@bank.example' and detail->>'purpose' = 'provider_read'), 1,
    'two identical provider_read refusals write one row');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', false, null, 'not_in_provider_group', p_provider => 'microsoft'),
    'not_in_provider_group', 'the provider group reason passes through');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail->>'address' = 'seated@bank.example' and detail->>'purpose' = 'provider_read'), 2,
    'a changed reason writes a second row');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', true, v_seated, p_provider => 'microsoft'),
    null, 'the owner reads');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'seated@bank.example', 'provider_read', 'sql-test', false, null, 'not_in_provider_group', p_provider => 'microsoft'),
    'not_in_provider_group', 'the provider group reason returns after an allowed read');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail->>'address' = 'seated@bank.example' and detail->>'purpose' = 'provider_read'), 3,
    'an allowed provider_read resets the state, so the next refusal audits again');
  -- Other purposes audit every refusal, never dedupe.
  perform pg_temp.guard(v_t, 'noconsent@bank.example');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail->>'address' = 'noconsent@bank.example' and detail->>'purpose' = 'agent_tool'), 2,
    'agent_tool refusals are audited every time');
  -- Bad inputs raise.
  v_blocked := false;
  begin perform mailbox_guard_check(v_t, 'x@bank.example', 'browse', 'sql-test', p_provider => 'microsoft');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown purpose was accepted'; end if;
  v_blocked := false;
  begin perform mailbox_guard_check(v_t, 'x@bank.example', 'provider_read', 'sql-test', false, null, 'no_consent', p_provider => 'microsoft');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown provider reason was accepted'; end if;
  v_blocked := false;
  begin perform mailbox_guard_check(v_t, 'x@bank.example', 'provider_read', 'sql-test', true, null);
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a call without a provider was accepted'; end if;
  v_blocked := false;
  begin perform mailbox_guard_check(v_t, 'x@bank.example', 'provider_read', 'sql-test', true, null, p_provider => 'yahoo');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown provider was accepted'; end if;
  v_blocked := false;
  begin perform mailbox_guard_check(v_t, 'x@bank.example', 'search', '', true, null, p_provider => 'microsoft');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an empty caller was accepted'; end if;
  -- Owner binding (audit round 1, item 3): a tool, search, retrieval or export
  -- read is refused unless the caller binds the source owner. Omitting the owner
  -- raises instead of skipping the check, and audits nothing.
  select count(*) into v_before from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused';
  foreach v_text in array array['agent_tool', 'search', 'retrieval', 'export'] loop
    v_blocked := false;
    begin perform mailbox_guard_check(v_t, 'seated@bank.example', v_text, 'sql-test', p_provider => 'microsoft');
    exception when sqlstate '22023' then v_blocked := true; end;
    if not v_blocked then raise exception 'FAIL: % without an owner check was accepted', v_text; end if;
    v_blocked := false;
    begin perform mailbox_guard_check(v_t, 'seated@bank.example', v_text, 'sql-test', false, v_seated, p_provider => 'microsoft');
    exception when sqlstate '22023' then v_blocked := true; end;
    if not v_blocked then raise exception 'FAIL: % with p_check_owner false was accepted', v_text; end if;
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'seated@bank.example', v_text, 'sql-test', true, v_seated, p_provider => 'microsoft'),
      null, v_text || ': the bound owner reads');
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'seated@bank.example', v_text, 'sql-test', true, v_nocons, p_provider => 'microsoft'),
      'owner_mismatch', v_text || ': another owner is refused');
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'seated@bank.example', v_text, 'sql-test', true, null, p_provider => 'microsoft'),
      'owner_mismatch', v_text || ': a null owner is refused');
  end loop;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'), v_before + 8,
    'the omitted-owner calls audited nothing; each owner mismatch audited once (4 purposes x 2)');
  raise notice 'PASS: tool purposes require the owner binding';
  raise notice 'PASS: owner and provider reasons, dedupe and input checks';

  -- ── 4b. No source, no read (round 3, item 6) ─────────────────────────────
  -- A mailbox with no content_sources row is refused `no_source` for every
  -- purpose, before any allowlist test: it is not judged as the default provider,
  -- even when the address is allowlisted and the caller is its owner.
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address = 'nosource@bank.example'), 0,
    'nosource has no source row');
  foreach v_text in array array['provider_read', 'agent_tool', 'search', 'retrieval', 'export'] loop
    select count(*) into v_before from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
      and detail->>'address' = 'nosource@bank.example' and detail->>'purpose' = v_text;
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'NoSource@bank.example ', v_text, 'sql-test-nosource', true, null, p_provider => 'microsoft'),
      'no_source', v_text || ': an address with no source is refused no_source');
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'nosource@bank.example', v_text, 'sql-test-nosource', true, v_seated, p_provider => 'google'),
      'no_source', v_text || ': no_source, not provider_mismatch, for a google caller');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
      and detail->>'address' = 'nosource@bank.example' and detail->>'purpose' = v_text and detail->>'reason' = 'no_source')
      - v_before, case when v_text = 'provider_read' then 1 else 2 end,
      v_text || ': audited (provider_read once on change, every call otherwise)');
  end loop;
  perform pg_temp.expect_text((select last_reason from mailbox_guard_state
    where tenant_id = v_t and address = 'nosource@bank.example'), 'no_source',
    'the provider_read state records no_source (the CHECK admits it)');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address = 'nosource@bank.example'), 0,
    'and the guard created no source row');
  -- An allowlisted address whose source row is gone is refused too: it used to pass as microsoft.
  begin
    delete from content_sources where tenant_id = v_t and address = 'seated@bank.example';
    perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t and address = 'seated@bank.example'), 1,
      'seated is still allowlisted with no source row');
    foreach v_text in array array['provider_read', 'agent_tool', 'search', 'retrieval', 'export'] loop
      perform pg_temp.expect_text(
        mailbox_guard_check(v_t, 'seated@bank.example', v_text, 'sql-test-nosource', true, v_seated, p_provider => 'microsoft'),
        'no_source', v_text || ': an allowlisted address with no source is refused no_source');
    end loop;
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example'), null, 'the savepoint restored seated''s source');
  raise notice 'PASS: no source, no read (every purpose)';

  -- ── 5. State changes through the consent RPCs ────────────────────────────
  -- `noconsent` opts in.
  set local role authenticated;
  perform pg_temp.act_as(v_nocons);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'consented', 'true', 'noconsent is consented');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consented'
    and actor_id = v_nocons and actor_type = 'user'), 1, 'the opt-in is one user-actor row');
  set local role authenticated;
  perform pg_temp.act_as(v_nocons);
  perform mailbox_consent_grant();
  reset role;
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consented'
    and actor_id = v_nocons), 1, 'a second grant writes nothing');
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_nocons), 1, 'and adds no row');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'noconsent@bank.example'), null, 'noconsent is now allowed');
  perform pg_temp.expect((select count(*) from allowed_mailboxes where tenant_id = v_t), 2, 'two mailboxes are allowed');

  -- Not eligible: external, another bank, another domain, no seat at all.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_external), '42501:not_eligible', 'external is not eligible');
  perform pg_temp.expect_text(pg_temp.try_grant(v_other),    '42501:not_eligible', 'another bank is not eligible');
  perform pg_temp.expect_text(pg_temp.try_grant(v_wrongdom), '42501:not_eligible', 'another domain is not eligible');
  perform pg_temp.expect_text(pg_temp.try_grant(v_pending),  '42501:not_eligible', 'a pending invitee is not eligible');
  reset role;
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_pending), 0,
    'the refusals inserted nothing');

  -- Anon may run neither RPC.
  set local role anon;
  v_blocked := false;
  begin perform mailbox_consent_grant();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon ran mailbox_consent_grant'; end if;
  v_blocked := false;
  begin perform mailbox_consent_withdraw();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon ran mailbox_consent_withdraw'; end if;
  reset role;
  -- A session-less authenticated call is refused.
  set local role authenticated;
  perform pg_temp.act_as_none();
  v_blocked := false;
  begin perform mailbox_consent_grant();
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a call with no auth.uid() succeeded'; end if;
  reset role;

  -- Append-only: a withdrawn row never reopens and never changes, even for the service role.
  set local role service_role;
  v_blocked := false;
  begin update mailbox_consents set withdrawn_at = null where user_id = v_withdr;
  exception when sqlstate 'P0001' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a withdrawn consent was reopened'; end if;
  v_blocked := false;
  begin update mailbox_consents set address = 'other@bank.example' where user_id = v_withdr;
  exception when sqlstate 'P0001' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a withdrawn consent changed address'; end if;
  reset role;

  -- Seat loss and re-consent: `reseated` needs a fresh opt-in.
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_reseated), 1,
    'reseated holds one (withdrawn) consent before re-consenting');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_reseated), 'ok', 'reseated can opt in again');
  reset role;
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_reseated), 2,
    'the re-consent is a new row');
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_reseated and withdrawn_at is null), 1,
    'and exactly one is open');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'reseated@bank.example'), null, 'reseated is allowed after re-consent');

  -- A role change inside the company keeps the consent and audits nothing.
  select count(*) into v_before from audit_log where tenant_id = v_t and action like 'discovery.mailbox_consent%';
  perform pg_temp.act_as_none();
  update users set company_role = 'director' where id = v_seated;
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_seated and withdrawn_at is null), 1,
    'a role change keeps the consent open');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action like 'discovery.mailbox_consent%'), v_before, 'and writes no consent audit row');
  perform pg_temp.expect_text(pg_temp.guard(v_t, 'seated@bank.example'), null, 'seated stays allowed');
  raise notice 'PASS: consent RPCs, not_eligible refusals, append-only and seat loss';

  -- ── 6. Only the owner's session writes a consent; the fold check ─────────
  -- Audit round 1, item 14: a service-role write used to forge a consent (the
  -- audit row named the service, the allowlist still admitted the mailbox).
  select count(*) into v_before from mailbox_consents where tenant_id = v_t;
  set local role service_role;
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'insert into mailbox_consents (tenant_id, user_id, invite_id, address) values (%L, %L, %L, %L)',
    v_t, v_removed, v_inv_removed, 'removed@bank.example')), 6), '42501:', 'the service role cannot insert a consent');
  reset role;
  -- The trigger is the second wall: a writer that holds the privilege (the table
  -- owner here) still needs auth.uid() = user_id.
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into mailbox_consents (tenant_id, user_id, invite_id, address) values (%L, %L, %L, %L)',
    v_t, v_removed, v_inv_removed, 'removed@bank.example')), 'P0001:mailbox_consent_not_by_owner',
    'a consent with no session is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_seated, format(
    'insert into mailbox_consents (tenant_id, user_id, invite_id, address) values (%L, %L, %L, %L)',
    v_t, v_removed, v_inv_removed, 'removed@bank.example')), 'P0001:mailbox_consent_not_by_owner',
    'a consent for another user is refused');
  perform pg_temp.act_as_none();
  perform pg_temp.expect((select count(*) from mailbox_consents where tenant_id = v_t), v_before,
    'the forged inserts left no row');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_consented' and actor_type = 'service'), 0,
    'and no service-actor opt-in exists: every opt-in names its owner');
  set local role service_role;
  v_blocked := false;
  begin delete from mailbox_consents where tenant_id = v_t;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: the service role deleted a consent'; end if;
  reset role;

  perform pg_temp.expect((select count(*) from mailbox_consents mc where mc.tenant_id = v_t
    and not exists (select 1 from audit_log a where a.action = 'discovery.mailbox_consented'
                    and a.detail->>'consentId' = mc.id::text)), 0, 'every consent has its opt-in audit row');
  perform pg_temp.expect((select count(*) from audit_log a where a.tenant_id = v_t
    and a.action = 'discovery.mailbox_consented'
    and not exists (select 1 from mailbox_consents mc where mc.id::text = a.detail->>'consentId')), 0,
    'every opt-in audit row has its consent');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_consented'),
    (select count(*) from mailbox_consents where tenant_id = v_t), 'one opt-in audit row per consent');
  perform pg_temp.expect(
    (select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_consent_withdrawn'),
    (select count(*) from mailbox_consents where tenant_id = v_t and withdrawn_at is not null),
    'one withdrawal audit row per withdrawn consent');
  perform pg_temp.expect((select count(*) from mailbox_consents mc where mc.tenant_id = v_t and mc.withdrawn_at is not null
    and not exists (select 1 from audit_log a where a.action = 'discovery.mailbox_consent_withdrawn'
                    and a.detail->>'consentId' = mc.id::text)), 0, 'every withdrawn consent has its audit row');
  raise notice 'PASS: the consents table is the fold of its audit rows';

  -- Audit round 1, item 13: deleting an invite used to cascade-delete its open
  -- consent with no audit row, so the table stopped being the fold of the log.
  -- A before-delete trigger withdraws the open consent first (one audit row).
  begin
    select id into v_consent from mailbox_consents where invite_id = v_inv_nocons and withdrawn_at is null;
    if v_consent is null then raise exception 'FAIL: fixture: noconsent holds no open consent'; end if;
    perform pg_temp.act_as_none();
    delete from invites where id = v_inv_nocons;
    perform pg_temp.expect((select count(*) from mailbox_consents where invite_id = v_inv_nocons), 0,
      'the invite took its consent rows with it');
    perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consent_withdrawn'
      and detail->>'consentId' = v_consent::text and detail->>'reason' = 'invite_deleted'
      and actor_type = 'service' and service_identity = 'mailbox-consent'), 1,
      'the deleted invite''s consent has one withdrawal audit row, reason invite_deleted');
    -- The fold: an opt-in with no withdrawal row is exactly an open consent.
    perform pg_temp.expect(
      (select count(*) from audit_log a where a.tenant_id = v_t and a.action = 'discovery.mailbox_consented'
         and not exists (select 1 from audit_log w where w.action = 'discovery.mailbox_consent_withdrawn'
                         and w.detail->>'consentId' = a.detail->>'consentId')),
      (select count(*) from mailbox_consents where tenant_id = v_t and withdrawn_at is null),
      'after an invite delete the open consents are still the fold of the audit rows');
    -- The ended consent purged the mailbox (#461): its source is gone, so the guard refuses no_source.
    perform pg_temp.expect((select count(*) from content_sources where id = v_src_nocons), 0,
      'the deleted invite''s mailbox source is purged');
    perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_purged'
      and detail->>'consentId' = v_consent::text and detail->>'reason' = 'invite_deleted'), 1,
      'the purge is audited with reason invite_deleted');
    perform pg_temp.expect_text(pg_temp.guard(v_t, 'noconsent@bank.example'), 'no_source',
      'the mailbox of a deleted invite is refused');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  perform pg_temp.expect((select count(*) from mailbox_consents where invite_id = v_inv_nocons and withdrawn_at is null), 1,
    'the savepoint rolled back: noconsent is consented again');
  raise notice 'PASS: deleting an invite withdraws its consent first, audited';

  -- ── Grants ───────────────────────────────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_seated);
  v_blocked := false;
  begin perform count(*) from allowed_mailboxes;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read allowed_mailboxes'; end if;
  v_blocked := false;
  begin perform count(*) from mailbox_seated_invites;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read mailbox_seated_invites'; end if;
  v_blocked := false;
  begin perform count(*) from mailbox_consents;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read mailbox_consents'; end if;
  v_blocked := false;
  begin perform count(*) from mailbox_guard_state;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read mailbox_guard_state'; end if;
  v_blocked := false;
  begin perform mailbox_guard_check(v_t, 'seated@bank.example', 'agent_tool', 'sql-test', p_provider => 'microsoft');
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran mailbox_guard_check'; end if;
  v_blocked := false;
  begin perform reader_mailbox_domains(v_t, 'microsoft');
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran reader_mailbox_domains'; end if;
  v_blocked := false;
  begin perform reader_firm_company_ids(v_t, 'microsoft');
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran reader_firm_company_ids'; end if;
  v_blocked := false;
  begin perform reader_registration_active(v_t, 'microsoft');
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran reader_registration_active'; end if;
  v_blocked := false;
  begin perform mailbox_reader_providers(v_t, 'seated@bank.example', v_b);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran mailbox_reader_providers'; end if;
  reset role;

  -- Audit round 1, item 17: Supabase's default privileges hand service_role ALL
  -- on every new relation, so each grant must follow a revoke that names it.
  -- The service role holds exactly what its writers need, on every relation the
  -- allowlist adds, so nothing can insert into a view, truncate a table or hang
  -- a trigger on it.
  perform pg_temp.expect_text(pg_temp.svc_privs('mailbox_seated_invites'), 'SELECT', 'service_role: mailbox_seated_invites');
  perform pg_temp.expect_text(pg_temp.svc_privs('allowed_mailboxes'),      'SELECT', 'service_role: allowed_mailboxes');
  perform pg_temp.expect_text(pg_temp.svc_privs('allowed_sites'),          'SELECT', 'service_role: allowed_sites');
  perform pg_temp.expect_text(pg_temp.svc_privs('mailbox_guard_state'),    'DELETE,INSERT,SELECT,UPDATE', 'service_role: mailbox_guard_state');
  perform pg_temp.expect_text(pg_temp.svc_privs('mailbox_allowlist_drift'), 'DELETE,INSERT,SELECT,UPDATE', 'service_role: mailbox_allowlist_drift');
  -- Consents and registrations are written by their RPCs and the audited triggers only.
  perform pg_temp.expect_text(pg_temp.svc_privs('mailbox_consents'),       'SELECT,UPDATE', 'service_role: mailbox_consents');
  perform pg_temp.expect_text(pg_temp.svc_privs('registered_sites'),       'SELECT,UPDATE', 'service_role: registered_sites');
  raise notice 'PASS: mailbox allowlist: views, guard, consent RPCs, seat loss and grants';

  -- ── 7. Q1 = B: session reads after a withdrawal (R15) ────────────────────
  -- `seated` and `noconsent` are both allowed here (section 5). Candidate 1 is
  -- backed by an item from each; candidate 2 by a second item of `seated` only.
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_cco, 'ma-cco@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'compliance'));
  update users set status = 'active', is_external = false, firm_role = 'cco' where id = v_cco;
  update users set company_id = v_b, company_role = 'member' where id = v_cco;
  -- The sources for `seated` and `noconsent` were written in section 2.
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_item_a, v_t, 'message', 'Q1 a', '2026-03-01', '<q1a@t>', 'q1a'),
    (v_item_b, v_t, 'message', 'Q1 b', '2026-03-02', '<q1b@t>', 'q1b'),
    (v_item_c, v_t, 'message', 'Q1 c', '2026-03-03', '<q1c@t>', 'q1c');
  insert into source_item_texts (source_item_id, body_text) values
    (v_item_a, 'a body'), (v_item_b, 'b body'), (v_item_c, 'c body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_item_a, v_src_seated, 'q1-a'), (v_item_b, v_src_nocons, 'q1-b'), (v_item_c, v_src_seated, 'q1-c');
  insert into deal_candidates (tenant_id, cluster_key, proposed_name) values (v_t, 'codename:q1-one', 'Q1 One')
    returning id into v_cand1;
  insert into deal_candidates (tenant_id, cluster_key, proposed_name) values (v_t, 'codename:q1-two', 'Q1 Two')
    returning id into v_cand2;
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence) values
    (v_cand1, v_item_a, 'codename', 'firm', 0.9),
    (v_cand1, v_item_b, 'codename', 'firm', 0.9),
    (v_cand2, v_item_c, 'codename', 'firm', 0.9);
  perform discovery_refresh_candidate_visibility(v_cand1);
  perform discovery_refresh_candidate_visibility(v_cand2);

  set local role authenticated;
  perform pg_temp.act_as(v_seated);
  perform pg_temp.expect_text(pg_temp.snap(), '2/3/3/2/2', 'before: seated sees both candidates and reads her two texts');
  perform pg_temp.act_as(v_nocons);
  perform pg_temp.expect_text(pg_temp.snap(), '1/2/2/1/1', 'before: the colleague sees candidate 1 and both of its items');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), '2/3/3/3/0', 'before: the CCO sees all metadata and no text');

  -- C5: a source whose provider is not the one that registered the mailbox is not
  -- an allowed source for the RLS helpers either.
  reset role;
  begin
    -- A pending Google registration (#259, plan D1): a Google source needs one to exist. It
    -- reads nothing (pending) and names no firm, so every expectation below is unchanged.
    insert into google_reader_registrations
      (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
    values
      (v_t, 'gmail-only.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
       'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@gmail-only.example');
    update content_sources set provider = 'google' where id = v_src_nocons;
    perform pg_temp.expect_text(app_item_has_allowed_source(v_item_b)::text, 'false',
      'a google source on a microsoft-registered mailbox is not an allowed source');
    perform pg_temp.expect_text(app_item_has_allowed_source(v_item_a)::text, 'true',
      'the other mailbox is unaffected');
    set local role authenticated;
    perform pg_temp.act_as(v_nocons);
    perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'the owner of the google-flagged source sees nothing');
    reset role;
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  set local role authenticated;

  -- B: a mailbox that is stored but read by no one. A withdrawal now deletes
  -- what it alone held (#461, below), so the state Q1 = B governs is built the
  -- way an archive leaves it: the source loses its owner. The colleague loses its
  -- item and link; the CCO keeps every metadata row and still gets no text.
  reset role;
  begin
    update content_sources set owner_user_id = null where id = v_src_seated;
    set local role authenticated;
    perform pg_temp.act_as(v_seated);
    perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'B: the former owner sees nothing');
    perform pg_temp.act_as(v_nocons);
    perform pg_temp.expect_text(pg_temp.snap(), '1/1/1/1/1', 'B: the colleague loses the unread mailbox''s item and link');
    perform pg_temp.expect((select count(*) from source_items where id in (v_item_a, v_item_c)), 0,
      'B: the colleague sees no item of the unread mailbox');
    perform pg_temp.expect((select count(*) from evidence_links where source_item_id = v_item_a), 0,
      'B: the colleague sees no link of the unread mailbox');
    perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand2), 0,
      'B: the colleague sees no candidate backed only by the unread mailbox');
    perform pg_temp.act_as(v_cco);
    perform pg_temp.expect_text(pg_temp.snap(), '2/3/3/3/0', 'B: the CCO keeps the metadata and reads no text');
    perform pg_temp.expect((select count(*) from source_item_texts), 0, 'B: the CCO reads no text');

    -- A, the one-line switch: the carve-out returns false, and the same rows go.
    reset role;
    create or replace function app_mailbox_retained_for_control_room(p_tenant_id uuid, p_user uuid)
    returns boolean language sql stable security definer set search_path = public as $f$ select false $f$;
    set local role authenticated;
    perform pg_temp.act_as(v_cco);
    perform pg_temp.expect((select count(*) from source_items where id in (v_item_a, v_item_c)), 0,
      'A: the CCO sees no item of the unread mailbox');
    perform pg_temp.expect((select count(*) from evidence_links where source_item_id in (v_item_a, v_item_c)), 0,
      'A: the CCO sees no link of the unread mailbox');
    perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand2), 0,
      'A: the CCO sees no candidate backed only by the unread mailbox');
    perform pg_temp.expect((select count(*) from source_items where id = v_item_b), 1,
      'A: the CCO still sees an allowlisted mailbox''s item');
    reset role;
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;
  -- The savepoint restored the owner and the carve-out.
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), '2/3/3/3/0', 'the savepoint restored option B');

  -- #461: a withdrawal deletes what the mailbox alone held, for everyone, the
  -- CCO included; the item a colleague's mailbox holds stays.
  perform pg_temp.act_as(v_seated);
  perform mailbox_consent_withdraw();
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'withdrawn: the owner sees nothing');
  perform pg_temp.act_as(v_nocons);
  perform pg_temp.expect_text(pg_temp.snap(), '1/1/1/1/1', 'withdrawn: the colleague keeps candidate 1 and their own item');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(pg_temp.snap(), '1/1/1/1/0', 'withdrawn: the CCO keeps only what a mailbox still holds');
  reset role;
  perform pg_temp.expect((select count(*) from source_items where id in (v_item_a, v_item_c)), 0,
    'withdrawn: the mailbox''s own items are deleted');
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand2), 0,
    'withdrawn: the candidate it alone backed is deleted');

  -- Spoof: the internal predicates are not callable by a signed-in user.
  set local role authenticated;
  perform pg_temp.act_as(v_seated);
  v_blocked := false;
  begin perform app_item_has_allowed_source(v_item_a);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran app_item_has_allowed_source'; end if;
  v_blocked := false;
  begin perform app_mailbox_retained_for_control_room(v_t, v_seated);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran app_mailbox_retained_for_control_room'; end if;
  v_blocked := false;
  begin perform app_is_firm_cco(v_t, v_seated);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran app_is_firm_cco'; end if;
  reset role;

  -- Audit round 1, item 18: the control-room branch of the link and visibility
  -- policies is the firm's CCO (active, internal, seated in the firm), not any
  -- user whose firm_role is 'cco'. The policies call app_is_control_room, the
  -- one predicate a signed-in role may run, so it must agree with app_is_firm_cco.
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(app_is_control_room(v_cco)::text, 'true', 'the firm''s active CCO is the control room');
  reset role;
  begin
    update users set status = 'suspended' where id = v_cco;
    set local role authenticated;
    perform pg_temp.act_as(v_cco);
    perform pg_temp.expect_text(app_is_control_room(v_cco)::text, 'false', 'a suspended CCO is not the control room');
    reset role;
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;
  begin
    update users set company_id = v_b2 where id = v_cco;
    set local role authenticated;
    perform pg_temp.act_as(v_cco);
    perform pg_temp.expect_text(app_is_control_room(v_cco)::text, 'false', 'a CCO seated in a second bank is not the control room');
    reset role;
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;
  begin
    update users set is_external = true where id = v_cco;
    set local role authenticated;
    perform pg_temp.act_as(v_cco);
    perform pg_temp.expect_text(app_is_control_room(v_cco)::text, 'false', 'an external CCO is not the control room');
    reset role;
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;
  -- A disabled reader keeps the firm known to the control room (round 5).
  begin
    update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
    set local role authenticated;
    perform pg_temp.act_as(v_cco);
    perform pg_temp.expect_text(app_is_control_room(v_cco)::text, 'true', 'a disabled reader leaves the CCO in the control room');
    reset role;
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;
  -- Nobody else's answer: a signed-in user asking about another user gets false.
  set local role authenticated;
  perform pg_temp.act_as(v_seated);
  perform pg_temp.expect_text(app_is_control_room(v_cco)::text, 'false', 'app_is_control_room answers for the caller only');
  reset role;
  raise notice 'PASS: the control-room predicate is the firm''s CCO';
  raise notice 'PASS: Q1 = B: an unread mailbox is hidden from colleagues, the CCO keeps the metadata, option A is one line, and a withdrawal deletes';
end;
$$;

-- ── 8. Provider group drift (20261001160000_mailbox_allowlist_drift.sql, R16, R20) ──
-- Its own fixture: a firm (B) with an admin, a CCO and a banker; a second bank
-- in the tenant (B2) with its own admin and CCO; an external admin seated in B;
-- and an active internal admin with no company.
do $$
declare
  v_t        uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();
  v_b2       uuid := gen_random_uuid();
  v_dir_b    uuid := gen_random_uuid();
  v_dir_b2   uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_banker   uuid := gen_random_uuid();
  v_admin_b2 uuid := gen_random_uuid();
  v_cco_b2   uuid := gen_random_uuid();
  v_ext_adm  uuid := gen_random_uuid();
  v_nocomp   uuid := gen_random_uuid();
  v_changed  boolean;
  v_blocked  boolean;
  v_health   jsonb;
  v_audit    bigint;
  v_bell     bigint;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir_b,    'dr-dir-b@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir_b2,   'dr-dir-b2@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin,    'dr-admin@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,      'dr-cco@example.test',      jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_banker,   'dr-banker@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_admin_b2, 'dr-admin-b2@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco_b2,   'dr-cco-b2@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_ext_adm,  'dr-ext-adm@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_nocomp,   'dr-nocomp@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin'));
  update users set status = 'active', is_external = false
    where id in (v_dir_b, v_dir_b2, v_admin, v_cco, v_banker, v_admin_b2, v_cco_b2, v_ext_adm, v_nocomp);
  insert into companies (id, tenant_id, name, type) values
    (v_b,  v_t, 'DR Bank',       'bank'),
    (v_b2, v_t, 'DR Other Bank', 'bank');
  update users set company_id = v_b,  company_role = 'director' where id = v_dir_b;
  update users set company_id = v_b2, company_role = 'director' where id = v_dir_b2;
  update users set company_id = v_b,  company_role = 'member' where id in (v_admin, v_cco, v_banker, v_ext_adm);
  update users set company_id = v_b2, company_role = 'member' where id in (v_admin_b2, v_cco_b2);
  update users set firm_role = 'admin' where id in (v_admin, v_admin_b2, v_ext_adm, v_nocomp);
  update users set firm_role = 'cco'   where id in (v_cco, v_cco_b2);
  update users set is_external = true where id = v_ext_adm;   -- seated in B, but external
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_b);

  -- First record: in_sync is not news, drift is.
  perform pg_temp.act_as_none();
  v_changed := discovery_record_allowlist_drift(v_t, 'microsoft', 'in_sync', '{}', '{}');
  if v_changed then raise exception 'FAIL: a first in_sync record was reported as a change'; end if;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.allowlist_drift'), 0,
    'a first in_sync record writes no audit row');
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'drift', array['A@bank.example'], '{}');
  if not v_changed then raise exception 'FAIL: a first drift record was not reported as a change'; end if;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.allowlist_drift'), 1,
    'a first drift record writes one audit row');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_allowlist_drift'), 2, 'a first drift record notifies the firm''s admin and CCO');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_allowlist_drift'
    and recipient_id in (v_admin, v_cco)), 2, 'the recipients are the firm''s admin and CCO');
  -- None of: the banker, B2's admin and CCO, the external admin seated in B, the admin with no company.
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_allowlist_drift'
    and recipient_id in (v_banker, v_admin_b2, v_cco_b2, v_ext_adm, v_nocomp, v_dir_b, v_dir_b2)), 0,
    'no notification for a banker, the second bank''s admin or CCO, an external admin, or an unseated admin');
  perform pg_temp.expect_text((select array_to_string(missing_in_group, ',') from mailbox_allowlist_drift
    where tenant_id = v_t and provider = 'google'), 'a@bank.example', 'the missing set is stored lower-cased');

  -- Repeating the same drift is not news.
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'drift', array['a@bank.example'], '{}');
  if v_changed then raise exception 'FAIL: the same drift was reported as a change'; end if;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.allowlist_drift'), 1,
    'the same drift writes no audit row');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_allowlist_drift'), 2, 'the same drift notifies nobody again');

  -- Changing the sets is news.
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'drift', array['a@bank.example'], array['x@bank.example']);
  if not v_changed then raise exception 'FAIL: a changed drift set was not reported'; end if;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.allowlist_drift'), 2,
    'a changed set writes a second audit row');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_allowlist_drift'), 4, 'a changed set notifies again');

  -- Unavailable notifies again; back in sync audits but notifies nobody.
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'unavailable', '{}', '{}');
  if not v_changed then raise exception 'FAIL: unavailable was not reported'; end if;
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_allowlist_drift'), 6, 'unavailable notifies again');
  v_changed := discovery_record_allowlist_drift(v_t, 'google', 'in_sync', '{}', '{}');
  if not v_changed then raise exception 'FAIL: recovery was not reported'; end if;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.allowlist_drift'), 4,
    'recovery is audited');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t
    and event_type = 'mailbox_allowlist_drift'), 6, 'recovery notifies nobody');

  -- Bad arguments raise.
  v_blocked := false;
  begin perform discovery_record_allowlist_drift(v_t, 'yahoo', 'drift', '{}', '{}');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown provider was accepted'; end if;
  v_blocked := false;
  begin perform discovery_record_allowlist_drift(v_t, 'microsoft', 'broken', '{}', '{}');
  exception when sqlstate '22023' then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unknown status was accepted'; end if;
  raise notice 'PASS: drift is recorded once per change and notifies only the firm''s admin and CCO';

  -- discovery_allowlist_health(): the firm's admin and CCO read it; nobody else.
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  v_health := discovery_allowlist_health();
  perform pg_temp.expect(jsonb_array_length(v_health), 2, 'the CCO reads both providers'' rows');
  perform pg_temp.expect_text(v_health->0->>'provider', 'google', 'the rows are ordered by provider');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect(jsonb_array_length(discovery_allowlist_health()), 2, 'the admin reads the rows');
  -- Refused: a banker, B2's admin and CCO, an external admin seated in B, an internal admin with no company.
  perform pg_temp.act_as(v_banker);
  v_blocked := false;
  begin perform discovery_allowlist_health(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a banker read the allowlist health'; end if;
  perform pg_temp.act_as(v_admin_b2);
  v_blocked := false;
  begin perform discovery_allowlist_health(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: the second bank''s admin read the allowlist health'; end if;
  perform pg_temp.act_as(v_cco_b2);
  v_blocked := false;
  begin perform discovery_allowlist_health(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: the second bank''s CCO read the allowlist health'; end if;
  perform pg_temp.act_as(v_ext_adm);
  v_blocked := false;
  begin perform discovery_allowlist_health(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an external admin read the allowlist health'; end if;
  perform pg_temp.act_as(v_nocomp);
  v_blocked := false;
  begin perform discovery_allowlist_health(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: an unseated admin read the allowlist health (the null-company case)'; end if;
  -- No session.
  perform pg_temp.act_as_none();
  v_blocked := false;
  begin perform discovery_allowlist_health(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: a call with no session read the allowlist health'; end if;

  -- A signed-in user cannot record drift, and cannot read the table.
  perform pg_temp.act_as(v_admin);
  v_blocked := false;
  begin perform discovery_record_allowlist_drift(v_t, 'microsoft', 'drift', '{}', '{}');
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran discovery_record_allowlist_drift'; end if;
  v_blocked := false;
  begin perform count(*) from mailbox_allowlist_drift;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated read mailbox_allowlist_drift'; end if;
  reset role;
  set local role anon;
  v_blocked := false;
  begin perform discovery_allowlist_health(); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon ran discovery_allowlist_health'; end if;
  reset role;
  raise notice 'PASS: discovery_allowlist_health answers the firm''s admin and CCO only';
end;
$$;

-- ── 9. Tool reads (20261001170000_mailbox_tool_visibility.sql, R22; Phase 6) ──
-- Its own fixture: a firm with two seated, consenting members (alice and
-- carol), one mailbox item each and no candidate, so a colleague sees nothing
-- of the other's mailbox. Consent changes only through the RPCs under act_as.
do $$
declare
  v_t        uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();
  v_dir      uuid := gen_random_uuid();
  v_alice    uuid := gen_random_uuid();
  v_carol    uuid := gen_random_uuid();
  v_src_a    uuid := gen_random_uuid();
  v_src_c    uuid := gen_random_uuid();
  v_item_a   uuid := gen_random_uuid();
  v_item_c   uuid := gen_random_uuid();
  v_visible  uuid[];
  v_blocked  boolean;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir,   'tv-dir@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_alice, 'tv-alice@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_carol, 'tv-carol@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false where id in (v_dir, v_alice, v_carol);
  insert into companies (id, tenant_id, name, type) values (v_b, v_t, 'TV Bank', 'bank');
  update users set company_id = v_b, company_role = 'director' where id = v_dir;
  update users set company_id = v_b, company_role = 'member' where id in (v_alice, v_carol);
  perform pg_temp.on_deal(v_alice);   -- A2: the opt-in needs MD or deal team on a deal
  perform pg_temp.on_deal(v_carol);
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
    values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_b);
  insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id) values
    (v_t, 'alice@bank.example', v_dir, v_b, 'member', 'accepted', 'sent', now(), v_alice),
    (v_t, 'carol@bank.example', v_dir, v_b, 'member', 'accepted', 'sent', now(), v_carol);

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_alice), 'ok', 'alice opts in');
  perform pg_temp.expect_text(pg_temp.try_grant(v_carol), 'ok', 'carol opts in');
  reset role;
  perform pg_temp.act_as_none();

  -- The opt-ins created both sources (C20).
  select id into v_src_a from content_sources where tenant_id = v_t and address = 'alice@bank.example' and owner_user_id = v_alice;
  select id into v_src_c from content_sources where tenant_id = v_t and address = 'carol@bank.example' and owner_user_id = v_carol;
  perform pg_temp.expect((select count(*) from content_sources where id in (v_src_a, v_src_c)), 2, 'the opt-ins created alice''s and carol''s sources');
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_item_a, v_t, 'message', 'TV a', '2026-04-01', '<tva@t>', 'tva'),
    (v_item_c, v_t, 'message', 'TV c', '2026-04-02', '<tvc@t>', 'tvc');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_item_a, v_src_a, 'tv-a'), (v_item_c, v_src_c, 'tv-c');

  -- As the service role, the visible set is what the acting user could see in a session.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  v_visible := mailbox_items_visible_to(v_carol, array[v_item_a, v_item_c]);
  perform pg_temp.expect(cardinality(v_visible), 1, 'the colleague may see one of the two items');
  perform pg_temp.expect_text(v_visible[1]::text, v_item_c::text, 'the colleague sees her own item, never alice''s');
  v_visible := mailbox_items_visible_to(v_alice, array[v_item_a, v_item_c]);
  perform pg_temp.expect_text(v_visible[1]::text, v_item_a::text, 'alice sees her own item');
  perform pg_temp.expect(cardinality(v_visible), 1, 'alice sees one of the two items');
  perform pg_temp.expect(cardinality(mailbox_items_visible_to(null, array[v_item_a])), 0, 'no user, no items');
  perform pg_temp.expect(cardinality(mailbox_items_visible_to(v_alice, null)), 0, 'no items, no items');
  reset role;

  -- A withdrawal takes the item out of the owner's own tool reads too.
  set local role authenticated;
  perform pg_temp.act_as(v_alice);
  perform mailbox_consent_withdraw();
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  perform pg_temp.expect(cardinality(mailbox_items_visible_to(v_alice, array[v_item_a])), 0,
    'a withdrawn mailbox''s item is not visible to its owner in a tool read');
  reset role;

  -- Signed-in roles cannot call it: the acting user would be theirs to choose.
  set local role authenticated;
  perform pg_temp.act_as(v_carol);
  v_blocked := false;
  begin perform mailbox_items_visible_to(v_alice, array[v_item_a]);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: authenticated ran mailbox_items_visible_to'; end if;
  reset role;
  set local role anon;
  v_blocked := false;
  begin perform mailbox_items_visible_to(v_alice, array[v_item_a]);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: anon ran mailbox_items_visible_to'; end if;
  reset role;
  raise notice 'PASS: mailbox_items_visible_to filters tool reads to what the acting user could see, service role only';

  -- "Every call" for tool purposes: a repeated agent_tool refusal writes a row each time.
  perform pg_temp.act_as_none();
  perform mailbox_guard_check(v_t, 'stranger@bank.example', 'agent_tool', 'agent-tool:sql-test', true, null, p_provider => 'microsoft');
  perform mailbox_guard_check(v_t, 'stranger@bank.example', 'agent_tool', 'agent-tool:sql-test', true, null, p_provider => 'microsoft');
  perform mailbox_guard_check(v_t, 'stranger@bank.example', 'agent_tool', 'agent-tool:sql-test', true, null, p_provider => 'microsoft');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_refused' and service_identity = 'agent-tool:sql-test'
    and detail->>'address' = 'stranger@bank.example' and detail->>'purpose' = 'agent_tool'), 3,
    'an agent_tool refusal repeated three times writes three audit rows');
  perform mailbox_guard_check(v_t, 'stranger@bank.example', 'search', 'agent-tool:sql-test', true, null, p_provider => 'microsoft');
  perform mailbox_guard_check(v_t, 'stranger@bank.example', 'retrieval', 'agent-tool:sql-test', true, null, p_provider => 'microsoft');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t
    and action = 'discovery.mailbox_refused' and detail->>'address' = 'stranger@bank.example'
    and detail->>'purpose' in ('search', 'retrieval')), 2, 'search and retrieval refusals are audited too');
  raise notice 'PASS: tool-purpose refusals are audited on every call';
end;
$$;

-- ── 10. SharePoint sites (20261001180000_site_allowlist.sql, R23; Phase 7) ──
-- Its own fixture: tenant T with the firm B (the registration's), a second
-- bank B2 and a counterparty X; tenant U with its own bank UB. Consent state is
-- not involved (a site has no per-user consent); firm admins register sites.
create function pg_temp.site_guard(p_tenant uuid, p_address text, p_purpose text default 'agent_tool')
returns text language sql as $$
  select site_guard_check(p_tenant, p_address, p_purpose, 'sql-test');
$$;
grant execute on function pg_temp.site_guard(uuid, text, text) to anon, authenticated, service_role;

do $$
declare
  v_t        uuid := gen_random_uuid();
  v_u        uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();   -- the firm the registration names
  v_b2       uuid := gen_random_uuid();   -- a second bank in T
  v_x        uuid := gen_random_uuid();   -- a counterparty in T
  v_ub       uuid := gen_random_uuid();   -- tenant U's bank
  v_dir_b    uuid := gen_random_uuid();
  v_dir_b2   uuid := gen_random_uuid();
  v_dir_x    uuid := gen_random_uuid();
  v_dir_u    uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();   -- an active, internal admin seated in B
  v_admin2   uuid := gen_random_uuid();   -- the same, seated in B2
  v_admin_u  uuid := gen_random_uuid();   -- the same, seated in tenant U's bank
  v_susp     uuid := gen_random_uuid();   -- an admin of B, suspended
  v_ext      uuid := gen_random_uuid();   -- an admin of B, external
  v_x_admin  uuid := gen_random_uuid();   -- an admin of the counterparty
  v_banker   uuid := gen_random_uuid();   -- a member of B, no firm role
  v_cco      uuid := gen_random_uuid();
  v_viewer   uuid := gen_random_uuid();   -- a candidate viewer through own mail
  v_inv_view uuid := gen_random_uuid();
  v_src_view uuid := gen_random_uuid();
  v_src_site uuid := gen_random_uuid();
  v_item_v   uuid := gen_random_uuid();   -- the viewer's mail, on the candidate
  v_item_t   uuid := gen_random_uuid();   -- a T item from the site (control)
  v_item_u   uuid := gen_random_uuid();   -- a tenant-U item linked to T's site
  v_item_f   uuid := gen_random_uuid();   -- a tenant-U item hung on the viewer's own mailbox
  v_cand_f   uuid := gen_random_uuid();   -- a candidate whose only evidence is v_item_f
  v_cand     uuid := gen_random_uuid();
  v_site     text := 'bank.sharepoint.com:/sites/deals';
  v_other    text := 'bank.sharepoint.com:/sites/other';
  v_dedupe   text := 'bank.sharepoint.com:/sites/dedupe';
  v_reg      uuid;
  v_result   jsonb;
  v_delete   text;
  v_cnt      bigint;
  v_blocked  boolean;
  v_text     text;
begin
  -- ── Fixture, as the table owner ──────────────────────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_dir_b,   'st-dir-b@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir_b2,  'st-dir-b2@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir_x,   'st-dir-x@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_dir_u,   'st-dir-u@example.test',   jsonb_build_object('tenant_id', v_u, 'department', 'ib')),
    (v_admin,   'st-admin@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_admin2,  'st-admin2@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_admin_u, 'st-admin-u@example.test', jsonb_build_object('tenant_id', v_u, 'department', 'admin')),
    (v_susp,    'st-susp@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_ext,     'st-ext@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_x_admin, 'st-x-admin@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_banker,  'st-banker@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_cco,     'st-cco@example.test',     jsonb_build_object('tenant_id', v_t, 'department', 'compliance')),
    (v_viewer,  'st-viewer@example.test',  jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false
    where id in (v_dir_b, v_dir_b2, v_dir_x, v_dir_u, v_admin, v_admin2, v_admin_u, v_susp, v_ext, v_x_admin,
                 v_banker, v_cco, v_viewer);
  insert into companies (id, tenant_id, name, type) values
    (v_b,  v_t, 'ST Bank',         'bank'),
    (v_b2, v_t, 'ST Other Bank',   'bank'),
    (v_x,  v_t, 'ST Counterparty', 'counterparty'),
    (v_ub, v_u, 'ST Foreign Bank', 'bank');
  update users set company_id = v_b,  company_role = 'director' where id = v_dir_b;
  update users set company_id = v_b2, company_role = 'director' where id = v_dir_b2;
  update users set company_id = v_x,  company_role = 'director', is_external = true where id = v_dir_x;
  update users set company_id = v_ub, company_role = 'director' where id = v_dir_u;
  update users set company_id = v_b,  company_role = 'member' where id in (v_admin, v_susp, v_ext, v_banker, v_cco, v_viewer);
  update users set company_id = v_b2, company_role = 'member' where id = v_admin2;
  update users set company_id = v_x,  company_role = 'member', is_external = true where id = v_x_admin;
  update users set company_id = v_ub, company_role = 'member' where id = v_admin_u;
  update users set firm_role = 'admin' where id in (v_admin, v_admin2, v_admin_u, v_susp, v_ext, v_x_admin);
  update users set firm_role = 'cco' where id = v_cco;
  update users set status = 'suspended' where id = v_susp;
  update users set is_external = true where id = v_ext;

  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (v_t, 'fixture', 'fixture', 'active', '{bank.example}', v_b),
         (v_u, 'fixture', 'fixture', 'active', '{bank.example}', v_ub);

  -- ── A. Not registered ────────────────────────────────────────────────────
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_site), 'site_not_registered', 'an unregistered site is refused');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'
    and service_identity = 'sql-test'), 1, 'the refusal writes one discovery.site_refused row');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'
    and (select array_agg(k order by k) from jsonb_object_keys(detail) k) = array['address', 'purpose', 'reason']), 1,
    'the refusal detail holds exactly address, reason and purpose');
  raise notice 'PASS: an unregistered site is refused and audited';

  -- ── B. A firm admin registers a site ─────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_result := site_register('Bank.SharePoint.com:/sites/Deals');
  reset role;
  perform pg_temp.expect_text(v_result->>'registered', 'true', 'site_register answers registered');
  perform pg_temp.expect_text(v_result->>'address', v_site, 'the address is stored lower-cased');
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_site
    and unregistered_at is null and firm_company_id = v_b and registered_by = v_admin), 1, 'one open registration for B');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_registered'
    and actor_type = 'user' and actor_id = v_admin and detail->>'address' = v_site), 1,
    'one user-actor discovery.site_registered row, the admin as actor');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform site_register(v_site);
  reset role;
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_registered'), 1,
    'a second registration writes nothing');
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_site), 1,
    'a second registration adds no row');
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_site), null, 'a registered site is allowed');
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, '  BANK.sharepoint.com:/sites/DEALS '), null,
    'the address is trimmed and lower-cased');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'), 1,
    'an allowed read writes no refusal');
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t and address = v_site), 1,
    'allowed_sites lists the registered site');
  raise notice 'PASS: a firm admin registers a site, audited, idempotent';

  -- ── C. Another firm ──────────────────────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_admin2);
  v_text := pg_temp.try_sql(format('select site_register(%L)', v_other));
  perform pg_temp.expect_text(v_text, '42501:not_authorized', 'B2''s admin cannot register: B2 is not the registration''s firm');
  reset role;
  -- A registration naming B2 is a real one, but not the reader's firm. Its own
  -- admin registers it through the RPC while B2 is the firm, then the reader's
  -- firm is B again (audit round 1, item 15: no direct insert exists).
  update graph_reader_registrations set firm_company_id = v_b2 where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.act_as(v_admin2);
  perform site_register(v_other);
  reset role;
  update graph_reader_registrations set firm_company_id = v_b where tenant_id = v_t;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_other), 'site_wrong_firm', 'another firm''s registration is site_wrong_firm');
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t and address = v_other), 0,
    'the other firm''s site is not allowed');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_registered'
    and actor_type = 'user' and actor_id = v_admin2 and detail->>'address' = v_other), 1,
    'the other firm''s registration is audited with its admin as actor');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  v_text := pg_temp.try_sql(format('select site_register(%L)', v_other));
  perform pg_temp.expect_text(v_text, 'P0001:registered_by_other_firm', 'B''s admin cannot take over another firm''s address');
  perform site_unregister(v_other);
  reset role;
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_other
    and unregistered_at is null), 1, 'B''s site_unregister leaves the B2 row open');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_unregistered'), 0,
    'nothing was unregistered, so nothing is audited');
  raise notice 'PASS: another firm''s registration is refused as site_wrong_firm and cannot be touched';

  -- ── D. Unregister and re-register ────────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform site_unregister(v_site);
  reset role;
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_site
    and unregistered_at is not null and unregistered_by = v_admin), 1, 'the registration is closed by the admin');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_unregistered'
    and actor_type = 'user' and actor_id = v_admin and detail->>'address' = v_site), 1,
    'one user-actor discovery.site_unregistered row');
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_site), 'registration_inactive', 'an unregistered site: registration_inactive');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform site_register(v_site);
  reset role;
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_site), 2,
    're-registering inserts a new row');
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_site), null, 'a re-registered site is allowed again');
  raise notice 'PASS: unregistering stops reads; re-registering restores them';

  -- ── E. The reader is inactive ────────────────────────────────────────────
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_site), 'registration_inactive', 'a disabled reader: registration_inactive');
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t), 0, 'a disabled reader allows no site');
  update graph_reader_registrations set status = 'active' where tenant_id = v_t;
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_site), null, 'the re-enabled reader allows the site again');
  raise notice 'PASS: disabling the reader stops site reads';

  -- ── F. provider_read dedupe (shared mailbox_guard_state) ─────────────────
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_dedupe, 'provider_read'), 'site_not_registered', 'first provider_read refusal');
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_dedupe, 'provider_read'), 'site_not_registered', 'the same refusal again');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'
    and detail->>'address' = v_dedupe), 1, 'two identical provider_read refusals write one row');
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform site_register(v_dedupe);
  perform site_unregister(v_dedupe);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_dedupe, 'provider_read'), 'registration_inactive', 'a changed reason');
  perform pg_temp.expect_text(pg_temp.site_guard(v_t, v_dedupe, 'provider_read'), 'registration_inactive', 'the changed reason again');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'
    and detail->>'address' = v_dedupe), 2, 'a changed reason writes a second row, and no more');
  -- Other purposes audit every call.
  perform pg_temp.site_guard(v_t, v_dedupe, 'agent_tool');
  perform pg_temp.site_guard(v_t, v_dedupe, 'agent_tool');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'
    and detail->>'address' = v_dedupe and detail->>'purpose' = 'agent_tool'), 2, 'an agent_tool refusal audits every call');
  -- Bad arguments raise.
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select site_guard_check(%L, %L, %L, %L)', v_t, v_site, 'bogus', 'sql-test')), 6),
    '22023:', 'an unknown purpose raises');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select site_guard_check(%L, %L, %L, %L)', v_t, v_site, 'agent_tool', '  ')), 6),
    '22023:', 'a blank caller raises');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select site_guard_check(%L, %L, %L, %L)', v_t, '  ', 'agent_tool', 'sql-test')), 6),
    '22023:', 'a blank address raises');
  raise notice 'PASS: site refusals dedupe on change for provider_read and audit every call otherwise';

  -- ── G. The validator and the session binding ────────────────────────────
  -- Audit round 1, item 15: registered_by (and unregistered_by) must be the
  -- session's own user. The service role has no INSERT privilege at all, and
  -- the trigger binds every writer that does (here the table owner).
  set local role service_role;
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_admin, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/forged', v_admin)), 6), '42501:', 'the service role cannot insert a registration');
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/forged', v_admin)), 'P0001:site_admin_not_session',
    'a registration with no session is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_banker, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/forged', v_admin)), 'P0001:site_admin_not_session',
    'a registration naming an admin other than the session user is refused');
  perform pg_temp.act_as_none();
  -- An unregistration is bound the same way (the RPC, the control, is used throughout).
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update registered_sites set unregistered_at = now(), unregistered_by = %L where address = %L and unregistered_at is null',
    v_admin, v_site)), 'P0001:site_admin_not_session',
    'an unregistration with no session is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_banker, format(
    'update registered_sites set unregistered_at = now(), unregistered_by = %L where address = %L and unregistered_at is null',
    v_admin, v_site)), 'P0001:site_admin_not_session',
    'an unregistration naming another admin is refused');
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_site
    and unregistered_at is null), 1, 'the forged unregistrations closed nothing');
  perform pg_temp.act_as_none();

  -- The validator, each writer with its own session.
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_banker, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/v1', v_banker)), 'P0001:site_admin_not_firm_admin', 'a non-admin cannot register');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_susp, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/v2', v_susp)), 'P0001:site_admin_not_firm_admin', 'a suspended admin cannot register');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_ext, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/v3', v_ext)), 'P0001:site_admin_not_firm_admin', 'an external admin cannot register');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_x_admin, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_x, 'bank.sharepoint.com:/sites/v4', v_x_admin)), 'P0001:site_firm_not_bank', 'a counterparty cannot be the firm');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_admin_u, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/v5', v_admin_u)), 'P0001:site_admin_not_firm_admin', 'another tenant''s admin cannot register');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_admin_u, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_ub, 'bank.sharepoint.com:/sites/v6', v_admin_u)), 'P0001:site_firm_not_bank', 'another tenant''s bank is not this tenant''s firm');
  -- A row is born open.
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_admin, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by, unregistered_by, unregistered_at) values (%L, %L, %L, %L, %L, now())',
    v_t, v_b, 'bank.sharepoint.com:/sites/v7', v_admin, v_admin)), 'P0001:registered_sites rows start open', 'a row born unregistered is refused');
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_admin, format(
    'insert into registered_sites (tenant_id, firm_company_id, address, registered_by, unregistered_at) values (%L, %L, %L, %L, now())',
    v_t, v_b, 'bank.sharepoint.com:/sites/v8', v_admin)), 6), 'P0001:', 'a row born half-unregistered is refused');
  perform pg_temp.act_as_none();
  set local role service_role;
  -- Only unregistered_* may change, once.
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'update registered_sites set address = %L where tenant_id = %L and address = %L and unregistered_at is null',
    'bank.sharepoint.com:/sites/renamed', v_t, v_site)), 6), 'P0001:', 'the address cannot change');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'update registered_sites set unregistered_at = null, unregistered_by = null where tenant_id = %L and address = %L and unregistered_at is not null',
    v_t, v_dedupe)), 6), 'P0001:', 'an unregistered row cannot be re-opened');
  -- No delete, for the service role, on either append-only table.
  perform pg_temp.expect_text(left(pg_temp.try_sql('delete from registered_sites where false'), 6), '42501:',
    'DELETE on registered_sites is revoked from the service role');
  perform pg_temp.expect_text(left(pg_temp.try_sql('delete from mailbox_consents where false'), 6), '42501:',
    'DELETE on mailbox_consents is revoked from the service role');
  reset role;
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address like 'bank.sharepoint.com:/sites/v_'), 0,
    'no validator-refused row exists');
  perform pg_temp.expect((select count(*) from registered_sites where address = 'bank.sharepoint.com:/sites/forged'), 0,
    'no forged row exists');
  raise notice 'PASS: the validator refuses non-admins, non-firms and rewrites, the session binds both writers, and DELETE is revoked';

  -- ── H. Cross-tenant provenance never exposes an item ─────────────────────
  -- The viewer opts in through the RPC, holds one mailbox item on a candidate.
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_inv_view, v_t, 'viewer@bank.example', v_dir_b, v_b, 'member', 'accepted', 'sent', now(), v_viewer);
  perform pg_temp.on_deal(v_viewer);   -- A2: the opt-in needs MD or deal team on a deal
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_viewer), 'ok', 'the viewer opts in');
  reset role;
  perform pg_temp.act_as_none();
  -- The viewer's opt-in created the mailbox source (C20); the site's is written here.
  select id into v_src_view from content_sources where tenant_id = v_t and address = 'viewer@bank.example'
    and owner_user_id = v_viewer;
  insert into content_sources (id, tenant_id, kind, address, owner_user_id) values
    (v_src_site, v_t, 'sharepoint_site', v_site, null);

  -- ── H2. Constraints and hardening (round 2, items 7 and 8) ────────────────
  -- Item 7: the site guard reads through the Graph reader only, so a site row
  -- of another provider cannot exist. A google mailbox row still can.
  perform pg_temp.expect_text(left(pg_temp.try_sql(format(
    'insert into content_sources (tenant_id, kind, address, provider) values (%L, ''sharepoint_site'', %L, ''google'')',
    v_t, 'google.sharepoint.com:/sites/nope')), 6), '23514:', 'a google sharepoint_site row is rejected');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into content_sources (tenant_id, kind, address, provider) values (%L, ''sharepoint_site'', %L, ''microsoft'')',
    v_t, 'ms.sharepoint.com:/sites/fine')), 'ok', 'a microsoft sharepoint_site row is accepted');
  -- A Google source needs a Google registration (#259, plan D1); a pending one reads nothing.
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values
    (v_t, 'gmail-only.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@gmail-only.example');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into content_sources (tenant_id, kind, address, provider) values (%L, ''mailbox'', ''g@bank.example'', ''google'')',
    v_t)), 'ok', 'a google mailbox row is accepted');
  -- Item 8: a user with a consent row cannot be deleted, so the fold invariant
  -- (the table is the fold of its audit rows) does not lean on another table's
  -- foreign key. Today the consent's own audit row (audit_log.actor_id) and the
  -- accepted invite (invites.accepted_user_id) also block the delete. Those keys
  -- are NO ACTION, which passes when the statement that deletes the user puts
  -- the same id back; RESTRICT refuses regardless. So the probe deletes and
  -- re-inserts the user in one statement: every other foreign key is satisfied
  -- and the consent alone refuses it. The admin, with audit rows and a
  -- registration but no consent, is the control. No DDL: dropping a shared
  -- table's foreign key here deadlocked the parallel DB probes (#262).
  perform pg_temp.expect(least((select count(*) from audit_log where actor_id = v_admin), 1)
    + least((select count(*) from registered_sites where registered_by = v_admin), 1), 2,
    'control: the admin is referenced by audit_log and registered_sites');
  begin
    v_delete := pg_temp.try_sql(format(
      'with gone as (delete from users where id = %L returning *) insert into users select * from gone', v_admin));
    perform pg_temp.expect_text(v_delete, 'ok', 'control: the same statement passes every NO ACTION foreign key');
    v_delete := pg_temp.try_sql(format(
      'with gone as (delete from users where id = %L returning *) insert into users select * from gone', v_viewer));
    raise exception 'consent_delete_probe';
  exception when raise_exception then
    if sqlerrm <> 'consent_delete_probe' then raise; end if;
  end;
  perform pg_temp.expect_text(left(v_delete, 6), '23503:', 'deleting a user with a consent row is refused');
  perform pg_temp.expect_text(case when v_delete like '%mailbox_consents%' then 'consent' else v_delete end, 'consent',
    'the refusal names mailbox_consents');
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id = v_viewer), 1,
    'the consent row survives the refused delete');
  raise notice 'PASS: sharepoint_site is Microsoft-only and a consenting user cannot be deleted';
  insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash) values
    (v_item_v, v_t, 'message',  'ST viewer mail', '2026-04-01', '<stv@t>', 'stv'),
    (v_item_t, v_t, 'document', 'ST site doc',    '2026-04-02', null,      'stt'),
    (v_item_u, v_u, 'document', 'ST foreign doc', '2026-04-03', null,      'stu'),
    (v_item_f, v_u, 'message',  'ST foreign mail', '2026-04-04', '<stf@u>', 'stf');
  insert into source_item_texts (source_item_id, body_text) values
    (v_item_v, 'viewer body'), (v_item_t, 'site body'), (v_item_u, 'foreign body'), (v_item_f, 'foreign mail body');
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_item_v, v_src_view, 'st-v'), (v_item_t, v_src_site, 'st-t');
  insert into deal_candidates (id, tenant_id, cluster_key, proposed_name)
    values (v_cand, v_t, 'codename:st', 'Project ST'),
           (v_cand_f, v_t, 'codename:st-foreign', 'Project ST Foreign');
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence) values
    (v_cand, v_item_v, 'codename', 'firm', 0.9),
    (v_cand, v_item_t, 'codename', 'firm', 0.9);
  insert into candidate_visibility (candidate_id, person_id, source_item_count) values (v_cand, v_viewer, 1);

  -- Audit round 1, item 16: provenance and evidence rows are tenant-checked when
  -- they are written, so a cross-tenant one cannot be built through the normal
  -- path. Each refusal is a P0001, and none leaves a row.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (%L, %L, %L)',
    v_item_u, v_src_site, 'st-u')), 'P0001:source_item_sources: item and source must share a tenant',
    'a tenant-U item cannot be attributed to a tenant-T site');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (%L, %L, %L)',
    v_item_f, v_src_view, 'st-f')), 'P0001:source_item_sources: item and source must share a tenant',
    'a tenant-U item cannot be attributed to a tenant-T mailbox');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence) values (%L, %L, %L, %L, 0.9)',
    v_cand_f, v_item_f, 'codename', 'firm')), 'P0001:evidence_links: item and candidate must share a tenant',
    'a tenant-U item cannot be evidence for a tenant-T candidate');
  perform pg_temp.expect((select count(*) from source_item_sources where source_item_id in (v_item_u, v_item_f)), 0,
    'the refused provenance rows do not exist');
  -- The read side must hold even for a row that predates the triggers or got
  -- around them, so the rows are forced in with the triggers off.
  alter table source_item_sources disable trigger source_item_sources_tenant_match;
  alter table evidence_links disable trigger evidence_links_tenant_match;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_item_u, v_src_site, 'st-u'),   -- a tenant-U item hung on T's site
    (v_item_f, v_src_view, 'st-f');   -- a tenant-U item hung on the viewer's own mailbox
  insert into evidence_links (candidate_id, source_item_id, method, route_tier, confidence) values
    (v_cand, v_item_u, 'codename', 'firm', 0.9),
    (v_cand_f, v_item_f, 'codename', 'firm', 0.9);   -- the candidate's ONLY evidence is foreign
  alter table source_item_sources enable trigger source_item_sources_tenant_match;
  alter table evidence_links enable trigger evidence_links_tenant_match;
  insert into candidate_visibility (candidate_id, person_id, source_item_count) values (v_cand_f, v_viewer, 1);

  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect((select count(*) from source_items where id = v_item_t), 1, 'control: the admin sees the T site item');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_item_t), 1,
    'control: the admin reads the T site item''s text');
  perform pg_temp.expect((select count(*) from source_items where id = v_item_u), 0, 'the admin does not see the tenant-U item');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_item_u), 0, 'the admin does not read its text');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect((select count(*) from source_items where id = v_item_t), 1, 'control: the CCO sees the T site item');
  perform pg_temp.expect((select count(*) from source_items where id = v_item_u), 0, 'the CCO does not see the tenant-U item');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id = v_item_u), 0, 'the CCO reads none of its text');
  perform pg_temp.expect((select count(*) from evidence_links where source_item_id = v_item_u), 0, 'the CCO sees none of its links');
  perform pg_temp.act_as(v_viewer);
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand), 1, 'control: the viewer sees the candidate');
  perform pg_temp.expect((select count(*) from source_items where id = v_item_t), 1, 'control: the viewer sees the T site item as metadata');
  perform pg_temp.expect((select count(*) from source_items where id = v_item_u), 0, 'the viewer does not see the tenant-U item');
  perform pg_temp.expect((select count(*) from source_item_texts where source_item_id in (v_item_t, v_item_u)), 0,
    'the viewer reads no site text');
  perform pg_temp.expect((select count(*) from evidence_links where source_item_id = v_item_u), 0, 'the viewer sees none of its links');
  -- A candidate whose only evidence is a foreign-tenant item is not visible,
  -- although the item hangs on the viewer's own allowlisted mailbox (item 16).
  perform pg_temp.expect((select count(*) from deal_candidates where id = v_cand_f), 0,
    'the viewer does not see a candidate whose only evidence is a foreign-tenant item');
  perform pg_temp.expect((select count(*) from source_items where id = v_item_f), 0,
    'the viewer does not see the foreign-tenant item on their own mailbox');
  perform pg_temp.expect((select count(*) from evidence_links where candidate_id = v_cand_f), 0,
    'and none of that candidate''s links');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand_f), 0,
    'nor the visibility row that names the viewer');
  reset role;
  perform pg_temp.act_as(v_viewer);
  perform pg_temp.expect(
    (select count(*) from deal_candidates where id = v_cand_f and app_can_see_candidate(id, v_viewer)), 0,
    'app_can_see_candidate refuses it for the viewer');
  raise notice 'PASS: a cross-tenant provenance row never exposes an item';

  -- ── I. Grants ────────────────────────────────────────────────────────────
  set local role authenticated;
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(left(pg_temp.try_sql('select count(*) from registered_sites'), 6), '42501:',
    'authenticated cannot select registered_sites');
  perform pg_temp.expect_text(left(pg_temp.try_sql('select count(*) from allowed_sites'), 6), '42501:',
    'authenticated cannot select allowed_sites');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select site_guard_check(%L, %L, %L, %L)', v_t, v_site, 'agent_tool', 'x')), 6),
    '42501:', 'authenticated cannot run site_guard_check');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('insert into registered_sites (tenant_id, firm_company_id, address, registered_by) values (%L, %L, %L, %L)',
    v_t, v_b, 'bank.sharepoint.com:/sites/direct', v_admin)), 6), '42501:', 'authenticated cannot write registered_sites');
  -- The RPCs check the role: a banker is refused, and the CCO lists but cannot register.
  perform pg_temp.act_as(v_banker);
  perform pg_temp.expect_text(pg_temp.try_sql('select discovery_site_registrations()'), '42501:not_authorized',
    'a banker cannot list registrations');
  perform pg_temp.expect_text(pg_temp.try_sql(format('select site_register(%L)', v_site)), '42501:not_authorized', 'a banker cannot register');
  perform pg_temp.expect_text(pg_temp.try_sql(format('select site_unregister(%L)', v_site)), '42501:not_authorized', 'a banker cannot unregister');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect(jsonb_array_length(discovery_site_registrations()), 1, 'the CCO lists the firm''s open registrations');
  perform pg_temp.expect_text(pg_temp.try_sql(format('select site_register(%L)', 'bank.sharepoint.com:/sites/cco')), '42501:not_authorized',
    'the CCO cannot register (admins only)');
  perform pg_temp.act_as(v_admin);
  v_result := discovery_site_registrations();
  perform pg_temp.expect(jsonb_array_length(v_result), 1, 'the admin lists one open registration of B');
  perform pg_temp.expect_text(v_result->0->>'address', v_site, 'it is the registered site');
  -- Suspended, external, unseated-in-firm and another firm's admins are refused too.
  perform pg_temp.act_as(v_susp);
  perform pg_temp.expect_text(pg_temp.try_sql('select discovery_site_registrations()'), '42501:not_authorized', 'a suspended admin cannot list');
  perform pg_temp.act_as(v_ext);
  perform pg_temp.expect_text(pg_temp.try_sql(format('select site_register(%L)', 'bank.sharepoint.com:/sites/ext')), '42501:not_authorized',
    'an external admin cannot register');
  perform pg_temp.act_as(v_admin2);
  perform pg_temp.expect_text(pg_temp.try_sql('select discovery_site_registrations()'), '42501:not_authorized',
    'the second bank''s admin cannot list (B2 is not the registration''s firm)');
  perform pg_temp.act_as(v_admin_u);
  perform pg_temp.expect(jsonb_array_length(discovery_site_registrations()), 0, 'tenant U''s admin lists only tenant U''s (none)');
  -- A malformed address is refused before anything is written.
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_text(pg_temp.try_sql(format('select site_register(%L)', 'https://evil.example/sites/x')), '22023:invalid_site_address',
    'a non-SharePoint address is refused');
  perform pg_temp.expect_text(pg_temp.try_sql(format('select site_register(%L)', 'bank.sharepoint.com,0f5a8e4c-1111-4222-8333-444455556666,0f5a8e4c-1111-4222-8333-444455556667')),
    'ok', 'a Graph site id is accepted');
  -- No session: no auth.uid().
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.try_sql('select discovery_site_registrations()'), '42501:not_authorized', 'no session cannot list');
  perform pg_temp.expect_text(pg_temp.try_sql(format('select site_register(%L)', v_site)), '42501:not_authenticated', 'no session cannot register');
  reset role;
  set local role anon;
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select site_register(%L)', v_site)), 6), '42501:', 'anon cannot register');
  perform pg_temp.expect_text(left(pg_temp.try_sql(format('select site_unregister(%L)', v_site)), 6), '42501:', 'anon cannot unregister');
  perform pg_temp.expect_text(left(pg_temp.try_sql('select discovery_site_registrations()'), 6), '42501:', 'anon cannot list');
  reset role;
  raise notice 'PASS: only the firm''s admins register, the firm''s admins and CCO list, and nobody signed in reads the registry';

  -- ── J. Fold: the registry is the fold of its audit rows ──────────────────
  perform pg_temp.expect((select count(*) from registered_sites r where r.tenant_id = v_t
    and (select count(*) from audit_log a where a.action = 'discovery.site_registered'
         and a.detail->>'registrationId' = r.id::text) <> 1), 0,
    'every registration has exactly one discovery.site_registered row');
  perform pg_temp.expect((select count(*) from registered_sites r where r.tenant_id = v_t
    and (select count(*) from audit_log a where a.action = 'discovery.site_unregistered'
         and a.detail->>'registrationId' = r.id::text) <> (case when r.unregistered_at is null then 0 else 1 end)), 0,
    'every unregistered row has exactly one discovery.site_unregistered row, and no open row has one');
  raise notice 'PASS: registered_sites is the fold of its audit rows';
end;
$$;

-- ── 11. PR #300 review fixes (C5, C10, C11, C12, C13, C20, C25) ──────────────
-- Each block has its own tenant. The helpers build a bank firm the registration
-- names (domain bank.example), then members seated in it through an accepted
-- invite. Consent changes only through the RPCs, under act_as.
create function pg_temp.mk_firm(p_t uuid, p_b uuid, p_dir uuid, p_tag text)
returns void language plpgsql as $$
begin
  insert into companies (id, tenant_id, name, type) values (p_b, p_t, p_tag || ' Bank', 'bank');
  insert into auth.users (id, email, raw_user_meta_data)
  values (p_dir, p_tag || '-dir@example.test', jsonb_build_object('tenant_id', p_t, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = p_b, company_role = 'director' where id = p_dir;
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values (p_t, 'fixture', 'fixture', 'active', '{bank.example}', p_b);
end;
$$;

-- A member seated at p_b from an accepted invite to <p_local>@bank.example.
-- Returns the invite id.
-- A2: the member is also seated on a deal of the tenant as p_deal_role (default deal_team, so the opt-in is open
-- to them); null leaves them on no deal.
create function pg_temp.mk_member(p_t uuid, p_b uuid, p_dir uuid, p_id uuid, p_local text, p_firm_role text default null,
                                  p_deal_role text default 'deal_team')
returns uuid language plpgsql as $$
declare
  v_invite uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (p_id, 'c300-' || p_local || '@example.test', jsonb_build_object('tenant_id', p_t, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = p_b, company_role = 'member',
                   firm_role = p_firm_role where id = p_id;
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_invite, p_t, p_local || '@bank.example', p_dir, p_b, 'member', 'accepted', 'sent', now(), p_id);
  if p_deal_role is not null then
    perform pg_temp.on_deal(p_id, p_deal_role);
  end if;
  return v_invite;
end;
$$;
grant execute on function pg_temp.mk_firm(uuid, uuid, uuid, text), pg_temp.mk_member(uuid, uuid, uuid, uuid, text, text, text)
  to anon, authenticated, service_role;

-- C11: the guard binds the source's CURRENT owner, for every purpose. The
-- reader asks before every page with the owner it read when the pass began, so
-- a source handed to someone else mid-backfill must stop the old owner's pass.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_m1 uuid := gen_random_uuid(); v_m2 uuid := gen_random_uuid();
  v_purpose text;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'c11');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_m1, 'c11-m1');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_m2, 'c11-m2');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_m1), 'ok', 'c11: m1 opts in');
  reset role;
  -- The source is written explicitly (its creation by the grant is C20's test).
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'c11-m1@bank.example', v_m1, 'microsoft')
  on conflict (tenant_id, kind, lower(address)) do update set owner_user_id = excluded.owner_user_id;

  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c11-m1@bank.example', 'provider_read', 'c11', true, v_m1, p_provider => 'microsoft'),
    null, 'c11: the source owner reads');
  -- The source changes hands between two pages.
  update content_sources set owner_user_id = v_m2 where tenant_id = v_t and address = 'c11-m1@bank.example';
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c11-m1@bank.example', 'provider_read', 'c11', true, v_m1, p_provider => 'microsoft'),
    'owner_mismatch', 'c11: the owner the pass began with is refused once the source has another owner');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c11-m1@bank.example', 'provider_read', 'c11', true, v_m2, p_provider => 'microsoft'),
    'owner_mismatch', 'c11: the source''s new owner is not the allowlisted user either');
  -- Every purpose, with or without the caller's own owner binding.
  foreach v_purpose in array array['agent_tool', 'search', 'retrieval', 'export'] loop
    perform pg_temp.expect_text(
      mailbox_guard_check(v_t, 'c11-m1@bank.example', v_purpose, 'c11', true, v_m1, p_provider => 'microsoft'),
      'owner_mismatch', 'c11: ' || v_purpose || ' is refused when the source owner changed');
  end loop;
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c11-m1@bank.example', 'provider_read', 'c11', false, null, p_provider => 'microsoft'),
    'owner_mismatch', 'c11: provider_read without the caller''s owner binding still binds the source''s owner');
  -- A source with no owner at all is not readable either.
  update content_sources set owner_user_id = null where tenant_id = v_t and address = 'c11-m1@bank.example';
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c11-m1@bank.example', 'provider_read', 'c11', true, v_m1, p_provider => 'microsoft'),
    'owner_mismatch', 'c11: an ownerless source is refused');
  -- Handed back, it reads again.
  update content_sources set owner_user_id = v_m1 where tenant_id = v_t and address = 'c11-m1@bank.example';
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c11-m1@bank.example', 'provider_read', 'c11', true, v_m1, p_provider => 'microsoft'),
    null, 'c11: the allowlisted user reads again once the source is theirs');
  raise notice 'PASS: C11 the guard binds the source''s current owner';
end;
$$;

-- C10: a site is open only while its registrant is still an active, internal
-- admin seated in the firm the registration names.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid(); v_b2 uuid := gen_random_uuid();
  v_site text := 'bank.sharepoint.com:/sites/c10';
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'c10');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'c10-adm', 'admin');
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  perform site_register(v_site);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'provider_read', 'c10'), null, 'c10: the registered site is allowed');
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t), 1, 'c10: allowed_sites lists it');

  -- Suspended.
  update users set status = 'suspended' where id = v_adm;
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t), 0, 'c10: a suspended registrant closes the site in the view');
  perform pg_temp.expect_text((site_guard_check(v_t, v_site, 'provider_read', 'c10') is not null)::text, 'true',
    'c10: the guard refuses a site whose registrant is suspended');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'), 1,
    'c10: and audits the refusal');
  update users set status = 'active' where id = v_adm;
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'agent_tool', 'c10'), null, 'c10: reinstated, the site reads again');

  -- Lost the admin role.
  update users set firm_role = null where id = v_adm;
  perform pg_temp.expect_text((site_guard_check(v_t, v_site, 'agent_tool', 'c10') is not null)::text, 'true',
    'c10: a registrant who lost the admin role closes the site');
  update users set firm_role = 'admin' where id = v_adm;

  -- Became external.
  update users set is_external = true where id = v_adm;
  perform pg_temp.expect_text((site_guard_check(v_t, v_site, 'agent_tool', 'c10') is not null)::text, 'true',
    'c10: an external registrant closes the site');
  update users set is_external = false where id = v_adm;

  -- Moved out of the firm (the members route clears company_id on removal).
  update users set company_id = null, company_role = null, status = 'suspended' where id = v_adm;
  perform pg_temp.expect_text((site_guard_check(v_t, v_site, 'agent_tool', 'c10') is not null)::text, 'true',
    'c10: a registrant removed from the firm closes the site');
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t), 0, 'c10: and the view drops it');
  -- The registration itself is still open: only the registrant's standing changed.
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and unregistered_at is null), 1,
    'c10: the registration row is untouched');
  raise notice 'PASS: C10 a site closes when its registrant loses the seat or the role';
end;
$$;

-- C12: consent status follows the CURRENT seated invite.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_m uuid := gen_random_uuid();
  v_inv1 uuid;
  v_inv2 uuid := gen_random_uuid();
  v_status jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'c12');
  v_inv1 := pg_temp.mk_member(v_t, v_b, v_dir, v_m, 'c12-m');
  update invites set accepted_at = now() - interval '2 days' where id = v_inv1;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_m), 'ok', 'c12: m opts in on the first invite');
  perform pg_temp.act_as(v_m);
  v_status := mailbox_consent_status();
  perform pg_temp.expect_text(v_status->>'consented', 'true', 'c12: consented on the seated invite');
  perform pg_temp.expect_text(coalesce(v_status->>'staleConsent', 'false'), 'false', 'c12: no stale consent yet');
  reset role;

  -- A later invite to the same person at the same firm becomes the seat.
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, status, delivery_status,
                       accepted_at, accepted_user_id)
  values (v_inv2, v_t, 'c12-m@bank.example', v_dir, v_b, 'member', 'accepted', 'sent', now() - interval '1 day', v_m);
  set local role authenticated;
  perform pg_temp.act_as(v_m);
  v_status := mailbox_consent_status();
  perform pg_temp.expect_text(v_status->>'eligible', 'true', 'c12: still eligible on the new invite');
  perform pg_temp.expect_text(v_status->>'consented', 'false', 'c12: the older invite''s consent is not consent on the seated invite');
  perform pg_temp.expect_text(v_status->>'staleConsent', 'true', 'c12: the card is told an older consent is still open');
  perform pg_temp.expect_text(v_status->>'address', 'c12-m@bank.example', 'c12: the status names the seat''s address');
  -- Connect on the seated invite, then the status is consented and not stale.
  perform pg_temp.expect_text(pg_temp.try_grant(v_m), 'ok', 'c12: m connects on the new invite');
  perform pg_temp.act_as(v_m);
  v_status := mailbox_consent_status();
  perform pg_temp.expect_text(v_status->>'consented', 'true', 'c12: consented on the new invite');
  perform pg_temp.expect_text(coalesce(v_status->>'staleConsent', 'false'), 'false', 'c12: and nothing is stale once the seated invite is consented');
  reset role;

  -- No seat at all (the registration is paused) with an open consent: the
  -- consent is not current, but the card must still be able to stop it.
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.act_as(v_m);
  v_status := mailbox_consent_status();
  perform pg_temp.expect_text(v_status->>'eligible', 'false', 'c12: no seat while the registration is paused');
  perform pg_temp.expect_text(v_status->>'staleConsent', 'true', 'c12: an open consent with no seat is reported so it can be stopped');
  reset role;
  update graph_reader_registrations set status = 'active' where tenant_id = v_t;
  raise notice 'PASS: C12 consent status follows the current seated invite';
end;
$$;

-- C13: a voluntary withdrawal while the registration is paused is audited as
-- withdrawn, not seat_lost (the seated view is empty while the registration is paused).
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_w uuid := gen_random_uuid();
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'c13');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_w, 'c13-w');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_w), 'ok', 'c13: w opts in');
  reset role;
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.act_as(v_w);
  perform mailbox_consent_withdraw();
  reset role;
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consent_withdrawn'
    and detail->>'address' = 'c13-w@bank.example' and detail->>'reason' = 'withdrawn'
    and actor_type = 'user' and actor_id = v_w), 1,
    'c13: a voluntary withdrawal during a registration pause is reason withdrawn, actor the user');
  -- The seat-derived reason stays for trigger paths.
  update graph_reader_registrations set status = 'active' where tenant_id = v_t;
  perform pg_temp.expect_text(current_setting('conductia.mailbox_withdraw_reason', true), '',
    'c13: the reason switch is reset after the withdrawal');
  raise notice 'PASS: C13 a voluntary withdrawal is audited as withdrawn';
end;
$$;

-- C20: the opt-in creates the mailbox source.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_m uuid := gen_random_uuid();  v_other uuid := gen_random_uuid();  v_orphan uuid := gen_random_uuid();
  v_multi uuid := gen_random_uuid();
  v_src uuid;
  v_src2 uuid;
  v_result jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'c20');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_m, 'c20-m');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_other, 'c20-other');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_orphan, 'c20-orphan');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_multi, 'c20-multi');

  -- Create once.
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t), 0, 'c20: no source before the opt-in');
  set local role authenticated;
  perform pg_temp.act_as(v_m);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and kind = 'mailbox'
    and address = 'c20-m@bank.example' and owner_user_id = v_m and provider = 'microsoft' and status = 'active'
    and delta_checkpoint is null and backfill_completed_at is null), 1,
    'c20: the opt-in creates one active mailbox source owned by the member on the registration''s provider');
  select id into v_src from content_sources where tenant_id = v_t and address = 'c20-m@bank.example';
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'true', 'c20: the grant says it created the source');
  perform pg_temp.expect_text(v_result->>'sourceId', v_src::text, 'c20: and names it');
  perform pg_temp.expect_text(v_result->>'consented', 'true', 'c20: the grant still answers consented');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consented'
    and actor_id = v_m and detail->>'sourceId' = v_src::text and detail->>'sourceCreated' = 'true'), 1,
    'c20: the consent audit row carries sourceId and sourceCreated');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'create'
    and detail::text like '%' || v_src::text || '%'), 0, 'c20: no separate audit action for the source');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c20-m@bank.example', 'provider_read', 'c20', true, v_m, p_provider => 'microsoft'),
    null, 'c20: the new source reads straight away');

  -- Idempotent.
  set local role authenticated;
  perform pg_temp.act_as(v_m);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'false', 'c20: a second grant creates nothing');
  perform pg_temp.expect_text(v_result->>'sourceId', v_src::text, 'c20: and names the same source');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address = 'c20-m@bank.example'), 1,
    'c20: still one source');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consented' and actor_id = v_m), 1,
    'c20: and no second audit row');

  -- Withdrawal deletes the source with the mail it held (#461); the guard refuses
  -- no_source. A re-consent creates a fresh one.
  set local role authenticated;
  perform pg_temp.act_as(v_m);
  perform mailbox_consent_withdraw();
  reset role;
  perform pg_temp.expect((select count(*) from content_sources where id = v_src), 0, 'c20: withdrawal deletes the source');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c20-m@bank.example', 'provider_read', 'c20', true, v_m, p_provider => 'microsoft'),
    'no_source', 'c20: a withdrawn mailbox is refused no_source');
  set local role authenticated;
  perform pg_temp.act_as(v_m);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'true', 'c20: a re-consent creates a fresh source');
  perform pg_temp.expect_text(((v_result->>'sourceId')::uuid <> v_src)::text, 'true', 'c20: a new one');
  v_src := (v_result->>'sourceId')::uuid;
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consented'
    and actor_id = v_m and detail->>'sourceCreated' = 'true' and detail->>'sourceId' = v_src::text), 1,
    'c20: the re-consent''s audit row says the source was created');

  -- Someone else's row is untouched, and the guard refuses it.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
  values (v_t, 'mailbox', 'c20-other@bank.example', v_m, 'microsoft', 'paused');
  select id into v_src2 from content_sources where tenant_id = v_t and address = 'c20-other@bank.example';
  set local role authenticated;
  perform pg_temp.act_as(v_other);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'consented', 'true', 'c20: the opt-in is recorded');
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'false', 'c20: an existing row is not created again');
  perform pg_temp.expect_text(v_result->>'sourceId', v_src2::text, 'c20: and is named');
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'false', 'c20: someone else''s row is never adopted');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src2 and owner_user_id = v_m and status = 'paused'), 1,
    'c20: someone else''s row keeps its owner and status');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c20-other@bank.example', 'provider_read', 'c20', true, v_other, p_provider => 'microsoft'),
    'owner_mismatch', 'c20: the guard refuses it owner_mismatch (C11)');
  -- An ownerless row is left alone too.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'c20-orphan@bank.example', null, 'microsoft');
  set local role authenticated;
  perform pg_temp.act_as(v_orphan);
  v_result := mailbox_consent_grant();
  reset role;
  -- An ownerless row is adopted (item 1): the address is the caller's verified invite email, so the
  -- member's own opt-in may claim a row nobody owns. Otherwise the guard refuses it forever (owner_mismatch).
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'false', 'c20: an ownerless row is not created again');
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'true', 'c20: an ownerless row is adopted by the opt-in');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address = 'c20-orphan@bank.example'
    and owner_user_id = v_orphan), 1, 'c20: it now belongs to the member who opted in');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'c20-orphan@bank.example', 'provider_read', 'c20', true, v_orphan, p_provider => 'microsoft'),
    null, 'c20: and the adopted source reads');

  -- More than one eligible provider: create nothing, leave it to the operator.
  begin
    create or replace function mailbox_reader_providers(p_tenant_id uuid, p_address text, p_company_id uuid)
    returns text[] language sql stable security definer set search_path = public as $f$
      select array['google', 'microsoft']::text[];
    $f$;
    set local role authenticated;
    perform pg_temp.act_as(v_multi);
    v_result := mailbox_consent_grant();
    reset role;
    perform pg_temp.expect_text(v_result->>'consented', 'true', 'c20: with two providers the opt-in is still recorded');
    perform pg_temp.expect_text(v_result->>'sourceCreated', 'false', 'c20: with two providers nothing is created');
    perform pg_temp.expect_text(coalesce(v_result->>'sourceId', '<null>'), '<null>', 'c20: and no source is named');
    perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address = 'c20-multi@bank.example'), 0,
      'c20: no row exists for the multi-provider address');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;
  perform pg_temp.expect_text(mailbox_reader_providers(v_t, 'c20-m@bank.example', v_b)::text, '{microsoft}',
    'c20: the probe restored mailbox_reader_providers');
  raise notice 'PASS: C20 the opt-in creates the mailbox source once';
end;
$$;

-- C5: discovery_ingestion_health() admits an active, internal admin or CCO
-- seated in the firm the registration names, and nobody else.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_b2 uuid := gen_random_uuid(); v_dir2 uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();  v_cco uuid := gen_random_uuid();  v_banker uuid := gen_random_uuid();
  v_adm2 uuid := gen_random_uuid(); v_susp uuid := gen_random_uuid();  v_ext uuid := gen_random_uuid();
  v_nocomp uuid := gen_random_uuid();
  v_t2 uuid := gen_random_uuid();  v_b3 uuid := gen_random_uuid();  v_dir3 uuid := gen_random_uuid();
  v_adm3 uuid := gen_random_uuid();
  v_health jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'c5');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'c5-adm', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_cco, 'c5-cco', 'cco');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_banker, 'c5-banker');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_susp, 'c5-susp', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_ext, 'c5-ext', 'admin');
  update users set status = 'suspended' where id = v_susp;
  update users set is_external = true where id = v_ext;
  -- A second bank in the same tenant, with its own admin (the Northwind shape).
  insert into companies (id, tenant_id, name, type) values (v_b2, v_t, 'c5 Other Bank', 'bank');
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_dir2, 'c5-dir2@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = v_b2, company_role = 'director' where id = v_dir2;
  perform pg_temp.mk_member(v_t, v_b2, v_dir2, v_adm2, 'c5-adm2', 'admin');
  -- An active internal admin with no company.
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_nocomp, 'c5-nocomp@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'admin'));
  update users set status = 'active', is_external = false, firm_role = 'admin' where id = v_nocomp;
  -- Another tenant whose registration names no firm at all.
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values (v_t2, 'fixture', 'fixture', 'active');
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_adm3, 'c5-adm3@example.test', jsonb_build_object('tenant_id', v_t2, 'department', 'admin'));
  update users set status = 'active', is_external = false, firm_role = 'admin' where id = v_adm3;
  insert into companies (id, tenant_id, name, type) values (v_b3, v_t2, 'c5 T2 Bank', 'bank');
  update users set company_id = v_b3, company_role = 'director' where id = v_adm3;

  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect_text((v_health ? 'sources' and v_health ? 'totals' and v_health ? 'registration')::text, 'true',
    'c5: the firm admin reads the health (shape unchanged)');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text((discovery_ingestion_health() ? 'totals')::text, 'true', 'c5: the firm CCO reads it too');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_banker, 'select discovery_ingestion_health()'), '42501:discovery_ingestion_health: not available to this user',
    'c5: a banker with no firm role is refused');
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_adm2, 'select discovery_ingestion_health()'), 6), '42501:',
    'c5: a second bank''s admin gets nothing');
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_susp, 'select discovery_ingestion_health()'), 6), '42501:',
    'c5: a suspended admin gets nothing');
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_ext, 'select discovery_ingestion_health()'), 6), '42501:',
    'c5: an external admin gets nothing');
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_nocomp, 'select discovery_ingestion_health()'), 6), '42501:',
    'c5: an unseated admin gets nothing');
  -- A tenant whose registration names no firm has no seated firm to judge anyone
  -- by, so its admin gets develop's no-registration shape: no registration, no
  -- sources, no counts, never 42501 (the panel shows "No reader registration").
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm3, 'select discovery_ingestion_health()'), 'ok',
    'c5: an admin of a tenant whose registration names no firm gets the empty shape, not 42501');
  perform pg_temp.act_as(v_adm3);
  perform pg_temp.expect_text(jsonb_typeof(discovery_ingestion_health()->'registration'), 'null',
    'c5: the empty shape names no registration');
  perform pg_temp.expect(jsonb_array_length(discovery_ingestion_health()->'sources'), 0,
    'c5: and lists no source');
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(left(pg_temp.try_sql('select discovery_ingestion_health()'), 6), '42501:', 'c5: no session gets nothing');
  reset role;
  -- A disabled registration still identifies the firm (Q1 = B keeps the metadata).
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  perform pg_temp.expect_text((discovery_ingestion_health() ? 'totals')::text, 'true',
    'c5: a disabled registration does not strip the firm admin of the health view');
  reset role;
  raise notice 'PASS: C5 the ingestion health is the seated firm admin''s and CCO''s only';
end;
$$;

-- C25: drift with nobody to notify keeps its audit row and notifies no one.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_b2 uuid := gen_random_uuid(); v_dir2 uuid := gen_random_uuid();
  v_banker uuid := gen_random_uuid();  v_adm2 uuid := gen_random_uuid();  v_susp uuid := gen_random_uuid();
  v_cco uuid := gen_random_uuid();
  v_changed boolean;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'c25');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_banker, 'c25-banker');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_susp, 'c25-susp', 'admin');
  update users set status = 'suspended' where id = v_susp;
  insert into companies (id, tenant_id, name, type) values (v_b2, v_t, 'c25 Other Bank', 'bank');
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_dir2, 'c25-dir2@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = v_b2, company_role = 'director' where id = v_dir2;
  perform pg_temp.mk_member(v_t, v_b2, v_dir2, v_adm2, 'c25-adm2', 'admin');

  perform pg_temp.act_as_none();
  v_changed := discovery_record_allowlist_drift(v_t, 'microsoft', 'drift', array['a@bank.example'], '{}');
  perform pg_temp.expect_text(v_changed::text, 'true', 'c25: drift with no recipients is still a change');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.allowlist_drift'), 1,
    'c25: and its audit row is kept');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_allowlist_drift'), 0,
    'c25: no notification goes to a banker, a suspended admin or the second bank''s admin, and no fallback principal is invented');
  perform pg_temp.expect((select count(*) from mailbox_allowlist_drift where tenant_id = v_t and provider = 'microsoft'
    and status = 'drift'), 1, 'c25: the drift state is recorded');
  -- A seated CCO arrives: the next change notifies exactly that person.
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_cco, 'c25-cco', 'cco');
  v_changed := discovery_record_allowlist_drift(v_t, 'microsoft', 'drift', array['a@bank.example', 'b@bank.example'], '{}');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_allowlist_drift'
    and recipient_id = v_cco), 1, 'c25: once a CCO is seated the next change notifies them');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_allowlist_drift'), 1,
    'c25: and only them');
  raise notice 'PASS: C25 drift with no recipients keeps its audit row';
end;
$$;


-- ── 12. PR #300 follow-up ─────────────────────────────────────────────────────
-- Item 1: the opt-in reports whether the guard allows the mailbox (database eligibility, A3). `reading`
-- is true only when the member holds an open consent on the seated invite and a
-- source exists for the seated address, is owned by the member, is active and
-- belongs to a provider that may read the address. Otherwise `readingReason` is
-- the guard's reason (A3, section 15 pins the equivalence): no_invite (no seat),
-- domain (seated, but no provider's registration lists the domain for the firm),
-- then the guard's own order: no_source, no_consent, owner_mismatch, source_paused,
-- and the refusals of a source on a provider that may not read the address.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_adopt uuid := gen_random_uuid();  v_owner uuid := gen_random_uuid();  v_owned uuid := gen_random_uuid();
  v_paused uuid := gen_random_uuid();  v_prov uuid := gen_random_uuid();  v_lost uuid := gen_random_uuid();
  v_noown uuid := gen_random_uuid();  v_fresh uuid := gen_random_uuid();  v_multi uuid := gen_random_uuid();
  v_src uuid;
  v_result jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'r1');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adopt, 'r1-adopt');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_owner, 'r1-owner');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_owned, 'r1-owned');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_paused, 'r1-paused');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_prov, 'r1-prov');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_lost, 'r1-lost');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_noown, 'r1-noown');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_fresh, 'r1-fresh');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_multi, 'r1-multi');

  -- Before any opt-in: nothing is read, because there is no consent.
  set local role authenticated;
  perform pg_temp.act_as(v_fresh);
  v_result := mailbox_consent_status();
  perform pg_temp.expect_text(v_result->>'reading', 'false', 'r1: no consent, not reading');
  perform pg_temp.expect_text(v_result->>'readingReason', 'no_source', 'r1: the reason is the guard''s first, no_source (A3)');
  reset role;

  -- An ownerless source is adopted by the member's own opt-in, and then it reads.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'r1-adopt@bank.example', null, 'microsoft') returning id into v_src;
  set local role authenticated;
  perform pg_temp.act_as(v_adopt);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'true', 'r1: the grant says it adopted the ownerless source');
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'false', 'r1: and that it created nothing');
  perform pg_temp.expect_text(v_result->>'sourceId', v_src::text, 'r1: and names the source');
  perform pg_temp.expect_text(v_result->>'reading', 'true', 'r1: reading is true once the member owns an active source');
  perform pg_temp.expect_text(v_result->>'readingReason', null, 'r1: no reason when reading');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and owner_user_id = v_adopt and status = 'active'), 1,
    'r1: the source now belongs to the member');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consented' and actor_id = v_adopt
    and detail->>'sourceId' = v_src::text and detail->>'sourceAdopted' = 'true' and detail->>'sourceCreated' = 'false'), 1,
    'r1: the consent audit row says the source was adopted');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'r1-adopt@bank.example', 'provider_read', 'r1', true, v_adopt, p_provider => 'microsoft'),
    null, 'r1: the adopted source passes the guard');
  set local role authenticated;
  perform pg_temp.act_as(v_adopt);
  v_result := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_result->>'reading', 'true', 'r1: the status agrees');
  -- A second grant adopts nothing.
  set local role authenticated;
  perform pg_temp.act_as(v_adopt);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'false', 'r1: a repeat grant adopts nothing');
  perform pg_temp.expect_text(v_result->>'reading', 'true', 'r1: and still reads');

  -- A created source reads straight away.
  set local role authenticated;
  perform pg_temp.act_as(v_noown);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'true', 'r1: a missing source is created');
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'false', 'r1: a created source is not an adoption');
  perform pg_temp.expect_text(v_result->>'reading', 'true', 'r1: a created source reads');

  -- Someone else's source is untouched, and the member is told why nothing is read.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'r1-owned@bank.example', v_owner, 'microsoft') returning id into v_src;
  set local role authenticated;
  perform pg_temp.act_as(v_owned);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'false', 'r1: a row owned by someone else is not adopted');
  perform pg_temp.expect_text(v_result->>'reading', 'false', 'r1: and is not read');
  perform pg_temp.expect_text(v_result->>'readingReason', 'owner_mismatch', 'r1: the reason is owner_mismatch');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and owner_user_id = v_owner), 1,
    'r1: the owner is unchanged');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'r1-owned@bank.example', 'provider_read', 'r1', true, v_owned, p_provider => 'microsoft'),
    'owner_mismatch', 'r1: the guard agrees');

  -- An ownerless but paused source is adopted, and not read.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
  values (v_t, 'mailbox', 'r1-paused@bank.example', null, 'microsoft', 'paused') returning id into v_src;
  set local role authenticated;
  perform pg_temp.act_as(v_paused);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'true', 'r1: a paused ownerless source is adopted');
  perform pg_temp.expect_text(v_result->>'reading', 'false', 'r1: a paused source is not read');
  perform pg_temp.expect_text(v_result->>'readingReason', 'source_paused', 'r1: the reason is source_paused');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and status = 'paused'), 1,
    'r1: adoption does not resume it');

  -- A source on a provider that may not read the address. A Google source needs a Google
  -- registration (#259, plan D1); a pending one reads nothing, so the reason below stays
  -- registration_inactive.
  insert into google_reader_registrations
    (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values
    (v_t, 'gmail-only.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678',
     'dir-reader@proj-1.iam.gserviceaccount.com', 'conductia-ingest@gmail-only.example');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'r1-prov@bank.example', v_prov, 'google');
  set local role authenticated;
  perform pg_temp.act_as(v_prov);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'reading', 'false', 'r1: a source on another provider is not read');
  perform pg_temp.expect_text(v_result->>'readingReason', 'registration_inactive', 'r1: the reason is the source''s provider having no registration');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'r1-prov@bank.example', 'provider_read', 'r1', true, v_prov, p_provider => 'microsoft'),
    'provider_mismatch', 'r1: the guard agrees');

  -- The status follows later changes to the source.
  set local role authenticated;
  perform pg_temp.act_as(v_lost);
  perform mailbox_consent_grant();
  reset role;
  delete from content_sources where tenant_id = v_t and address = 'r1-lost@bank.example';
  set local role authenticated;
  perform pg_temp.act_as(v_lost);
  v_result := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_result->>'reading', 'false', 'r1: a consented member whose source is gone is not read');
  perform pg_temp.expect_text(v_result->>'readingReason', 'no_source', 'r1: the reason is no_source');
  update content_sources set owner_user_id = null where tenant_id = v_t and address = 'r1-noown@bank.example';
  set local role authenticated;
  perform pg_temp.act_as(v_noown);
  v_result := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_result->>'readingReason', 'owner_mismatch', 'r1: a source that lost its owner says owner_mismatch');
  update content_sources set owner_user_id = v_noown, status = 'paused' where tenant_id = v_t and address = 'r1-noown@bank.example';
  set local role authenticated;
  perform pg_temp.act_as(v_noown);
  v_result := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_result->>'readingReason', 'source_paused', 'r1: a source paused after the opt-in says source_paused');

  -- No seat: the registration is paused.
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.act_as(v_adopt);
  v_result := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_result->>'reading', 'false', 'r1: no seat, not reading');
  perform pg_temp.expect_text(v_result->>'readingReason', 'no_invite', 'r1: the reason is no_invite');
  update graph_reader_registrations set status = 'active' where tenant_id = v_t;
  -- Seated on a domain the registration no longer lists.
  update graph_reader_registrations set mailbox_domains = '{elsewhere.example}' where tenant_id = v_t;
  set local role authenticated;
  perform pg_temp.act_as(v_adopt);
  v_result := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_result->>'eligible', 'false', 'r1: a domain the registration dropped is not eligible');
  perform pg_temp.expect_text(v_result->>'readingReason', 'domain', 'r1: and is named');
  update graph_reader_registrations set mailbox_domains = '{bank.example}' where tenant_id = v_t;

  -- Two providers could read it and there is no source: nothing is created.
  begin
    create or replace function mailbox_reader_providers(p_tenant_id uuid, p_address text, p_company_id uuid)
    returns text[] language sql stable security definer set search_path = public as $f$
      select array['google', 'microsoft']::text[];
    $f$;
    set local role authenticated;
    perform pg_temp.act_as(v_multi);
    v_result := mailbox_consent_grant();
    reset role;
    perform pg_temp.expect_text(v_result->>'reading', 'false', 'r1: with two providers nothing is read');
    perform pg_temp.expect_text(v_result->>'readingReason', 'no_source', 'r1: the reason is no_source (the guard has no word for the operator''s choice)');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;
  raise notice 'PASS: R1 the opt-in adopts an ownerless source and reports whether the guard reads it';
end;
$$;

-- Item 2: a site whose registrant lost admin standing is not registered. The
-- next firm admin to register it replaces the stale row.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_a1 uuid := gen_random_uuid();  v_a2 uuid := gen_random_uuid();  v_a3 uuid := gen_random_uuid();
  v_cco uuid := gen_random_uuid();
  v_site  text := 'bank.sharepoint.com:/sites/r2-role';
  v_site3 text := 'bank.sharepoint.com:/sites/r2-gone';
  v_old uuid;  v_old3 uuid;
  v_result jsonb;
  v_list jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'r2');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_a1, 'r2-a1', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_a2, 'r2-a2', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_a3, 'r2-a3', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_cco, 'r2-cco', 'cco');
  set local role authenticated;
  perform pg_temp.act_as(v_a1);
  perform site_register(v_site);
  perform pg_temp.act_as(v_a3);
  perform site_register(v_site3);
  perform pg_temp.act_as(v_a2);
  v_list := discovery_site_registrations();
  perform pg_temp.expect_text(v_list->0->>'stale', 'false', 'r2: a registration whose registrant stands is not stale');
  reset role;
  select id into v_old  from registered_sites where tenant_id = v_t and address = v_site  and unregistered_at is null;
  select id into v_old3 from registered_sites where tenant_id = v_t and address = v_site3 and unregistered_at is null;

  -- a1 loses the admin role; a3 is removed from the firm.
  update users set firm_role = null where id = v_a1;
  update users set company_id = null, company_role = null, status = 'suspended' where id = v_a3;
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t), 0, 'r2: neither site reads');
  set local role authenticated;
  perform pg_temp.act_as(v_cco);
  v_list := discovery_site_registrations();
  reset role;
  perform pg_temp.expect((select count(*) from jsonb_array_elements(v_list) e where e->>'stale' = 'true'), 2,
    'r2: the listing flags both registrations as stale');

  -- Another admin registers the same site: the stale row is closed and replaced.
  set local role authenticated;
  perform pg_temp.act_as(v_a2);
  v_result := site_register(v_site);
  reset role;
  perform pg_temp.expect_text(v_result->>'registered', 'true', 'r2: the registration is answered');
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_site and unregistered_at is null
    and registered_by = v_a2 and id <> v_old), 1, 'r2: a new open row belongs to the caller');
  perform pg_temp.expect((select count(*) from registered_sites where id = v_old and unregistered_by = v_a2 and unregistered_at is not null), 1,
    'r2: the stale row is closed, and the closer is the caller');
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t and address = v_site and registered_by = v_a2), 1,
    'r2: the site reads under the new registrant');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_unregistered'
    and actor_id = v_a2 and actor_type = 'user' and detail->>'registrationId' = v_old::text
    and detail->>'reason' = 'registrant_lost_standing' and detail->>'registeredBy' = v_a1::text), 1,
    'r2: the close is audited, by the caller, with the reason and the lapsed registrant');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_registered'
    and actor_id = v_a2 and detail->>'address' = v_site), 1, 'r2: the re-registration is audited');

  -- A healthy registration is returned as it is: no second row, no new audit row.
  set local role authenticated;
  perform pg_temp.act_as(v_a2);
  perform site_register(v_site);
  reset role;
  perform pg_temp.expect((select count(*) from registered_sites where tenant_id = v_t and address = v_site), 2,
    'r2: registering again adds nothing');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_registered'
    and detail->>'address' = v_site), 2, 'r2: and audits nothing new');

  -- The removed registrant's site is replaced the same way.
  set local role authenticated;
  perform pg_temp.act_as(v_a2);
  perform site_register(v_site3);
  reset role;
  perform pg_temp.expect((select count(*) from registered_sites where id = v_old3 and unregistered_by = v_a2), 1,
    'r2: a registrant who left the firm is replaced too');
  perform pg_temp.expect((select count(*) from allowed_sites where tenant_id = v_t), 2, 'r2: both sites read again');
  -- The registry is still the fold of its audit rows.
  perform pg_temp.expect((select count(*) from registered_sites r where r.tenant_id = v_t
    and (select count(*) from audit_log a where a.action = 'discovery.site_registered'
         and a.detail->>'registrationId' = r.id::text) <> 1), 0, 'r2: every registration has one registered row');
  perform pg_temp.expect((select count(*) from registered_sites r where r.tenant_id = v_t
    and (select count(*) from audit_log a where a.action = 'discovery.site_unregistered'
         and a.detail->>'registrationId' = r.id::text) <> (case when r.unregistered_at is null then 0 else 1 end)), 0,
    'r2: every closed row has one unregistered row');
  raise notice 'PASS: R2 a stale site registration is replaced by the next firm admin';
end;
$$;

-- Item 3: ingestion health on a tenant whose registration names no firm.
do $$
declare
  v_t uuid := gen_random_uuid();   -- no registration at all
  v_t2 uuid := gen_random_uuid();  -- a registration that names no firm
  v_adm uuid := gen_random_uuid();  v_cco uuid := gen_random_uuid();  v_banker uuid := gen_random_uuid();
  v_susp uuid := gen_random_uuid();  v_ext uuid := gen_random_uuid();  v_adm2 uuid := gen_random_uuid();
  v_health jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_adm,    'r3-adm@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_cco,    'r3-cco@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_banker, 'r3-banker@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib')),
    (v_susp,   'r3-susp@example.test',   jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_ext,    'r3-ext@example.test',    jsonb_build_object('tenant_id', v_t, 'department', 'admin')),
    (v_adm2,   'r3-adm2@example.test',   jsonb_build_object('tenant_id', v_t2, 'department', 'admin'));
  update users set status = 'active', is_external = false where id in (v_adm, v_cco, v_banker, v_susp, v_ext, v_adm2);
  update users set firm_role = 'admin' where id in (v_adm, v_susp, v_ext, v_adm2);
  update users set firm_role = 'cco' where id = v_cco;
  update users set status = 'suspended' where id = v_susp;
  update users set is_external = true where id = v_ext;
  -- A half-finished registration run wrote a registration and its sources but named no firm: they must not be shown.
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values (v_t2, 'fixture', 'fixture', 'active');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t2, 'mailbox', 'r3-y@bank.example', null, 'microsoft');

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, 'select discovery_ingestion_health()'), 'ok',
    'r3: the admin of a tenant with no registration is not refused');
  perform pg_temp.act_as(v_adm);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect_text(jsonb_typeof(v_health->'registration'), 'null', 'r3: no registration is reported');
  perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 0, 'r3: no source is listed');
  perform pg_temp.expect((v_health #>> '{totals,sources}')::bigint, 0, 'r3: the totals are empty');
  perform pg_temp.expect((v_health #>> '{totals,itemsStored}')::bigint, 0, 'r3: and count nothing stored');
  perform pg_temp.act_as(v_cco);
  perform pg_temp.expect_text(jsonb_typeof(discovery_ingestion_health()->'registration'), 'null', 'r3: the CCO gets the same shape');
  -- A registration that names no firm: still the empty shape, with its sources kept out.
  perform pg_temp.act_as(v_adm2);
  v_health := discovery_ingestion_health();
  perform pg_temp.expect_text(jsonb_typeof(v_health->'registration'), 'null', 'r3: a registration that names no firm is not shown');
  perform pg_temp.expect(jsonb_array_length(v_health->'sources'), 0, 'r3: and its sources are not listed');
  -- Everyone else is still refused.
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_banker, 'select discovery_ingestion_health()'), 6), '42501:',
    'r3: a banker with no firm role is refused');
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_susp, 'select discovery_ingestion_health()'), 6), '42501:',
    'r3: a suspended admin is refused');
  perform pg_temp.expect_text(left(pg_temp.try_sql_as(v_ext, 'select discovery_ingestion_health()'), 6), '42501:',
    'r3: an external admin is refused');
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(left(pg_temp.try_sql('select discovery_ingestion_health()'), 6), '42501:', 'r3: no session is refused');
  reset role;
  raise notice 'PASS: R3 an admin or CCO of a tenant with no named firm gets the empty health shape';
end;
$$;

-- ── 13. PR #300 round 3, A1: an orphaned source is archived, never inherited ──
-- Audit-3 H1. Adopting an ownerless source used to hand its stored items to the
-- member who opted in next: the visibility rule treats items attached to a source
-- as its owner's. Now an ownerless source with provenance rows is archived (its
-- address becomes <address>~xyz, paused, never read, never owned) and the member
-- gets a fresh source. A source with no provenance rows is still taken over. A
-- firm admin may merge the archived history into the member's source
-- (discovery_unify_mailbox_sources), and only a firm admin may.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_t2 uuid := gen_random_uuid(); v_b2 uuid := gen_random_uuid(); v_dir2 uuid := gen_random_uuid();
  v_take uuid := gen_random_uuid();  v_new uuid := gen_random_uuid();  v_adm uuid := gen_random_uuid();
  v_plain uuid := gen_random_uuid(); v_nc uuid := gen_random_uuid();  v_adm2 uuid := gen_random_uuid();
  v_m2 uuid := gen_random_uuid();
  v_src uuid;  v_old uuid;  v_fresh uuid;  v_mm uuid;  v_nt uuid;  v_nt2 uuid;  v_x uuid;  v_t2src uuid;  v_nc_src uuid;
  v_i1 uuid;  v_i2 uuid;  v_i3 uuid;  v_cand uuid;
  v_result jsonb;  v_unified jsonb;
  v_addr text;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'a1');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_take, 'a1-take');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_new, 'a1-new');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'a1-adm', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_plain, 'a1-plain');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_nc, 'a1-nc');
  perform pg_temp.mk_firm(v_t2, v_b2, v_dir2, 'a1x');
  perform pg_temp.mk_member(v_t2, v_b2, v_dir2, v_adm2, 'a1x-adm', 'admin');
  perform pg_temp.mk_member(v_t2, v_b2, v_dir2, v_m2, 'a1x-m2');

  -- (1) No provenance rows: the source is taken over, as before. Nothing is archived.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'a1-take@bank.example', null, 'microsoft') returning id into v_src;
  set local role authenticated;
  perform pg_temp.act_as(v_take);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'true', 'a1: an ownerless source with no items is taken over');
  perform pg_temp.expect_text(v_result->>'sourceId', v_src::text, 'a1: and it is the same source');
  perform pg_temp.expect_text(v_result->>'archivedSourceId', null, 'a1: nothing was archived');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address like '%~%'), 0,
    'a1: no archived row exists');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_source_archived'), 0,
    'a1: and no archive audit row');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'a1-take@bank.example', 'provider_read', 'a1', true, v_take, p_provider => 'microsoft'),
    null, 'a1: the taken-over source reads');

  -- (2) Provenance rows: the earlier holder's mailbox, left behind with three
  -- items, two of them evidence for a candidate.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, delta_checkpoint, last_synced_at)
  values (v_t, 'mailbox', 'a1-new@bank.example', null, 'microsoft', 'old-checkpoint', now()) returning id into v_old;
  insert into source_items (tenant_id, kind, subject, content_hash, internet_message_id) values
    (v_t, 'message', 'Falcon one', 'h1', '<a1-1@old>') returning id into v_i1;
  insert into source_items (tenant_id, kind, subject, content_hash, internet_message_id) values
    (v_t, 'message', 'Falcon two', 'h2', '<a1-2@old>') returning id into v_i2;
  insert into source_items (tenant_id, kind, subject, content_hash, internet_message_id) values
    (v_t, 'message', 'Unrouted', 'h3', '<a1-3@old>') returning id into v_i3;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values
    (v_i1, v_old, 'p1'), (v_i2, v_old, 'p2'), (v_i3, v_old, 'p3');
  insert into deal_candidates (tenant_id, cluster_key, proposed_name) values (v_t, 'a1-falcon', 'Falcon') returning id into v_cand;
  insert into evidence_links (candidate_id, source_item_id, method, route_tier) values
    (v_cand, v_i1, 'codename', 'firm'), (v_cand, v_i2, 'codename', 'firm');

  set local role authenticated;
  perform pg_temp.act_as(v_new);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'consented', 'true', 'a1: the opt-in is recorded');
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'false', 'a1: a source with items is not adopted');
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'true', 'a1: the member gets a fresh source');
  perform pg_temp.expect_text(v_result->>'archivedSourceId', v_old::text, 'a1: the grant names the archived source');
  v_fresh := (v_result->>'sourceId')::uuid;
  perform pg_temp.expect((v_fresh is not null and v_fresh <> v_old)::int, 1, 'a1: the fresh source is a different row');
  perform pg_temp.expect_text(v_result->>'reading', 'true', 'a1: the fresh source reads');

  select address into v_addr from content_sources where id = v_old;
  perform pg_temp.expect((v_addr ~ '^a1-new@bank\.example~[a-z0-9]{3}$')::int, 1, 'a1: the archived address is <address>~xyz, got ' || v_addr);
  perform pg_temp.expect((select count(*) from content_sources where id = v_old and status = 'paused' and owner_user_id is null
    and archived_at is not null and archived_from_address = 'a1-new@bank.example'), 1,
    'a1: the archived row is paused, ownerless and records when and from what address');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 3,
    'a1: the history stays on the archived row');
  perform pg_temp.expect((select count(*) from content_sources where id = v_fresh and status = 'active' and owner_user_id = v_new
    and address = 'a1-new@bank.example' and delta_checkpoint is null and archived_at is null and provider = 'microsoft'), 1,
    'a1: the fresh source is active, the member''s, at the plain address, with no checkpoint');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_fresh), 0,
    'a1: and has no history');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_source_archived'
    and actor_id = v_new and detail->>'sourceId' = v_old::text and detail->>'freshSourceId' = v_fresh::text
    and detail->>'address' = 'a1-new@bank.example'), 1, 'a1: the archive is audited, in the member''s name');
  perform pg_temp.expect((select count(*) from audit_log where action = 'discovery.mailbox_consented' and actor_id = v_new
    and detail->>'archivedSourceId' = v_old::text and detail->>'sourceId' = v_fresh::text and detail->>'sourceCreated' = 'true'), 1,
    'a1: the consent audit row names the archived source');

  -- The newcomer sees none of the earlier holder's items, candidates or text.
  perform pg_temp.expect((select count(*) from source_items where tenant_id = v_t), 3, 'a1: the items exist');
  set local role authenticated;
  perform pg_temp.act_as(v_new);
  perform pg_temp.expect_text(pg_temp.snap(), '0/0/0/0/0', 'a1: the newcomer sees no candidates, links, items, visibility or text');
  perform pg_temp.expect((select app_owns_item(v_i1, v_new))::int, 0, 'a1: the newcomer owns no item');
  reset role;
  -- Not even the firm's admin: an archived source is nobody's.
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  perform pg_temp.expect((select count(*) from source_items), 0, 'a1: the admin sees none of the archived items either');
  reset role;
  -- The guard: the real address reaches the fresh source; the archived address never passes.
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'a1-new@bank.example', 'provider_read', 'a1', true, v_new, p_provider => 'microsoft'),
    null, 'a1: the real address reads the fresh source');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, v_addr, 'provider_read', 'a1', true, v_new, p_provider => 'microsoft'),
    'no_invite', 'a1: the archived key is refused, for any caller');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, v_addr, 'agent_tool', 'a1', true, v_new, p_provider => 'microsoft'),
    'no_invite', 'a1: and refused for every purpose');

  -- A repeat grant archives nothing more.
  set local role authenticated;
  perform pg_temp.act_as(v_new);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'archivedSourceId', null, 'a1: a repeat grant archives nothing');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address like 'a1-new@%'), 2,
    'a1: two rows remain for the address: the fresh one and the archived one');

  -- (3) Unify. Refusals first; each leaves the history where it was. The RPC checks deal_discovery itself
  -- (audit round 4, Claude 6), so the flag is on for the rest of this block.
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  -- An archived row for another address, and targets that cannot take it.
  -- (stamped after its link: an archived source takes no link, audit round 4, Codex 3)
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
  values (v_t, 'mailbox', 'a1-mm@bank.example~zzz', null, 'microsoft', 'paused') returning id into v_mm;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_i3, v_mm, 'q3');
  update content_sources set archived_at = now(), archived_from_address = 'a1-mm@bank.example' where id = v_mm;
  -- a1-nt: an archived row whose address has a target that nobody on the allowlist owns.
  -- (stamped after its link: an archived source takes no link, audit round 4, Codex 3)
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
  values (v_t, 'mailbox', 'a1-nt@bank.example~yyy', null, 'microsoft', 'paused') returning id into v_nt;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_i3, v_nt, 'r3');
  update content_sources set archived_at = now(), archived_from_address = 'a1-nt@bank.example' where id = v_nt;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'a1-nt@bank.example', null, 'microsoft') returning id into v_x;
  -- a1-nc: the target's owner is seated but has not opted in.
  -- (stamped after its link: an archived source takes no link, audit round 4, Codex 3)
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)
  values (v_t, 'mailbox', 'a1-nc@bank.example~xxx', null, 'microsoft', 'paused') returning id into v_nt2;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_i3, v_nt2, 's3');
  update content_sources set archived_at = now(), archived_from_address = 'a1-nc@bank.example' where id = v_nt2;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'a1-nc@bank.example', v_nc, 'microsoft') returning id into v_nc_src;
  -- another tenant's source, with the same address as the target
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t2, 'mailbox', 'a1-new@bank.example', v_m2, 'microsoft') returning id into v_t2src;

  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_plain, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    '42501:not_authorized', 'a1: a member who is not a firm admin is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_new, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    '42501:not_authorized', 'a1: the target''s own owner is not an admin either');
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(pg_temp.try_sql(format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    '42501:not_authenticated', 'a1: no session is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm2, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    'P0001:unify_source_not_found', 'a1: another tenant''s firm admin cannot name this tenant''s sources');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_t2src)),
    'P0001:unify_source_not_found', 'a1: a target in another tenant is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_fresh, v_fresh)),
    'P0001:unify_not_archived', 'a1: a source that is not archived cannot be merged away');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_mm, v_fresh)),
    'P0001:unify_address_mismatch', 'a1: an archived row of another address is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_nt, v_x)),
    'P0001:unify_target_not_allowlisted', 'a1: a target nobody on the allowlist owns is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_nt2, v_nc_src)),
    'P0001:unify_target_not_allowlisted', 'a1: a target whose owner has not opted in is refused');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, 'select discovery_unify_mailbox_sources(null, null)'),
    '22023:invalid_unify_request', 'a1: missing ids are refused');
  reset role;
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 3, 'a1: the refusals moved nothing');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_sources_unified'), 0,
    'a1: and audited no merge');

  -- The two sources share an item once the member's mailbox has read it again.
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_i1, v_fresh, 'n1');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand), 0,
    'a1: nobody has a visibility row for the candidate before the merge');

  -- The firm admin merges the history into the member's source.
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  v_unified := discovery_unify_mailbox_sources(v_old, v_fresh);
  reset role;
  perform pg_temp.expect_text(v_unified->>'archivedSourceId', v_old::text, 'a1: the result names the archived source');
  perform pg_temp.expect_text(v_unified->>'targetSourceId', v_fresh::text, 'a1: and the target');
  perform pg_temp.expect_text(v_unified->>'moved', '2', 'a1: two links moved');
  perform pg_temp.expect_text(v_unified->>'alreadyLinked', '1', 'a1: the item both sources hold is not duplicated');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_fresh), 3,
    'a1: the member''s source now holds the three items once each');
  perform pg_temp.expect((select count(distinct source_item_id) from source_item_sources where content_source_id = v_fresh), 3,
    'a1: with no duplicate');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 0,
    'a1: the archived row has no links left');
  perform pg_temp.expect((select count(*) from content_sources where id = v_old and status = 'paused' and owner_user_id is null
    and archived_at is not null and address = v_addr), 1, 'a1: the archived row stays paused, ownerless and under its archive key');
  perform pg_temp.expect((select count(*) from candidate_visibility where candidate_id = v_cand and person_id = v_new
    and source_item_count = 2), 1, 'a1: the candidate''s visibility was refreshed for the target''s owner');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_sources_unified'
    and actor_id = v_adm and actor_type = 'user' and detail->>'archivedSourceId' = v_old::text
    and detail->>'targetSourceId' = v_fresh::text and detail->>'moved' = '2' and detail->>'alreadyLinked' = '1'), 1,
    'a1: the merge is audited, in the admin''s name');
  set local role authenticated;
  perform pg_temp.act_as(v_new);
  perform pg_temp.expect((select count(*) from source_items), 3, 'a1: the member now sees the merged items');
  perform pg_temp.expect((select count(*) from deal_candidates), 1, 'a1: and the candidate they back');
  reset role;
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, v_addr, 'provider_read', 'a1', true, v_new, p_provider => 'microsoft'),
    'no_invite', 'a1: the archived key is still refused after the merge');

  -- A second merge of the same row is refused.
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    'P0001:unify_already_unified', 'a1: a second merge of the same row is refused');
  raise notice 'PASS: A1 an orphaned source is archived with its history, the newcomer sees none of it, and a firm admin can merge it';
end;
$$;

-- ── 14. PR #300 round 3, A2: one click needs a deal; the owner is told ─────────
-- The opt-in is open to a seated member who is MD or deal team on at least one deal in their tenant, for every
-- provider (D3). The role check is a grant-time precondition only (conductor decision, a choice the owner can
-- flip): mailbox_guard_check does not test it, so a member already consented who leaves every deal keeps being
-- read until they withdraw or lose the seat. Status says `not_on_a_deal` only for a member with no open consent.
-- A grant that binds a source for the member (created, taken over, or fresh after an archive) tells every
-- active, internal firm admin and the firm's CCO once (owner decision, audit round 4); a CCO who is suspended,
-- external, seated in a second bank or in another tenant is not told. An idempotent re-grant, or a re-consent
-- over the member's own source, tells no one. Taking over an ownerless source with no items resets its sync state, so the new holder backfills.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_t2 uuid := gen_random_uuid(); v_b2 uuid := gen_random_uuid(); v_dir2 uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();  v_cco uuid := gen_random_uuid();  v_off uuid := gen_random_uuid();
  v_ext uuid := gen_random_uuid();  v_adm2 uuid := gen_random_uuid();
  v_nodeal uuid := gen_random_uuid(); v_legal uuid := gen_random_uuid(); v_ro uuid := gen_random_uuid();
  v_xdeal uuid := gen_random_uuid();  v_md uuid := gen_random_uuid();    v_dt uuid := gen_random_uuid();
  v_take uuid := gen_random_uuid();   v_arch uuid := gen_random_uuid();  v_wd uuid := gen_random_uuid();
  v_dom uuid := gen_random_uuid();    v_leaver uuid := gen_random_uuid();
  v_deal2 uuid := gen_random_uuid();
  v_b3 uuid := gen_random_uuid();     v_cco2 uuid := gen_random_uuid();  v_cco3 uuid := gen_random_uuid();
  v_cco4 uuid := gen_random_uuid();   v_cco5 uuid := gen_random_uuid();
  v_src uuid;  v_old uuid;  v_item uuid;
  v_result jsonb;  v_status jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'a2');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'a2-adm', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_cco, 'a2-cco', 'cco');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_off, 'a2-off', 'admin');
  update users set status = 'suspended' where id = v_off;
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_nodeal, 'a2-nodeal', null, null);
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_legal, 'a2-legal', null, 'legal');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_ro, 'a2-ro', null, 'read_only');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_xdeal, 'a2-xdeal', null, null);
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_md, 'a2-md', null, 'md');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_dt, 'a2-dt');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_take, 'a2-take');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_arch, 'a2-arch');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_wd, 'a2-wd');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_leaver, 'a2-leaver');
  -- CCOs who are not the firm's control room: seated in a second bank of the tenant (the registration names
  -- v_b, not v_b3), suspended, external. Each must hear nothing.
  insert into companies (id, tenant_id, name, type) values (v_b3, v_t, 'a2 Second Bank', 'bank');
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_cco2, 'a2-cco2@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = false, company_id = v_b3, company_role = 'director', firm_role = 'cco'
    where id = v_cco2;
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_cco3, 'a2-cco3', 'cco', null);
  update users set status = 'suspended' where id = v_cco3;
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_cco4, 'a2-cco4', 'cco', null);
  update users set is_external = true where id = v_cco4;
  -- A member on a domain the registration does not list: the domain reason wins over the deal one.
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_dom, 'a2-dom', null, null);
  update invites set email = 'a2-dom@elsewhere.example' where accepted_user_id = v_dom;
  -- An admin of a counterparty in the same tenant: not the firm, never told.
  insert into companies (id, tenant_id, name, type) values (v_b2, v_t, 'a2 Counterparty', 'counterparty');
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_ext, 'a2-ext@example.test', jsonb_build_object('tenant_id', v_t, 'department', 'ib'));
  update users set status = 'active', is_external = true, company_id = v_b2, company_role = 'director', firm_role = 'admin'
    where id = v_ext;
  -- Another tenant: a firm admin who must hear nothing, and a deal that does not count for this tenant's member.
  perform pg_temp.mk_firm(v_t2, gen_random_uuid(), v_dir2, 'a2x');
  perform pg_temp.mk_member(v_t2, (select company_id from users where id = v_dir2), v_dir2, v_adm2, 'a2x-adm', 'admin');
  perform pg_temp.mk_member(v_t2, (select company_id from users where id = v_dir2), v_dir2, v_cco5, 'a2x-cco', 'cco', null);
  insert into deals (id, tenant_id, code, codename, bank_id)
  values (v_deal2, v_t2, 'a2x-' || v_t2::text, 'Other tenant', (select company_id from users where id = v_dir2));
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values (v_deal2, v_xdeal, (select id from roles where slug = 'md'), 'md');


  -- (1) Not on a deal: refused, with nothing written. Status says why.
  set local role authenticated;
  perform pg_temp.act_as(v_nodeal);
  v_status := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_status->>'eligible', 'false', 'a2: a member on no deal is not eligible to connect');
  perform pg_temp.expect_text(v_status->>'reason', 'not_on_a_deal', 'a2: and status says why');
  perform pg_temp.expect_text(v_status->>'readingReason', 'not_on_a_deal', 'a2: the reading reason says the same');
  perform pg_temp.expect_text(v_status->>'consented', 'false', 'a2: and nothing is consented');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_nodeal), '42501:not_eligible', 'a2: a member on no deal is refused not_eligible');
  perform pg_temp.expect_text(pg_temp.try_grant(v_legal), '42501:not_eligible', 'a2: a legal member is refused');
  perform pg_temp.expect_text(pg_temp.try_grant(v_ro), '42501:not_eligible', 'a2: a read-only member is refused');
  perform pg_temp.expect_text(pg_temp.try_grant(v_xdeal), '42501:not_eligible', 'a2: an MD on another tenant''s deal only is refused');
  perform pg_temp.act_as(v_xdeal);
  v_status := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_status->>'readingReason', 'not_on_a_deal', 'a2: the other tenant''s deal does not count in status either');
  perform pg_temp.expect((select count(*) from mailbox_consents where user_id in (v_nodeal, v_legal, v_ro, v_xdeal)), 0,
    'a2: the refusals recorded no consent');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t
    and address in ('a2-nodeal@bank.example', 'a2-legal@bank.example', 'a2-ro@bank.example', 'a2-xdeal@bank.example')), 0,
    'a2: and created no source');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action in
    ('discovery.mailbox_consented', 'discovery.mailbox_source_archived')), 0, 'a2: and audited nothing');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 0,
    'a2: and told no one');
  -- The domain comes first.
  set local role authenticated;
  perform pg_temp.act_as(v_dom);
  v_status := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_status->>'reason', 'domain', 'a2: a member on an unregistered domain is told domain, not the deal');

  -- (2) MD and deal team connect; each binding tells the firm's active, internal admin once.
  set local role authenticated;
  perform pg_temp.act_as(v_md);
  v_status := mailbox_consent_status();
  perform pg_temp.expect_text(v_status->>'eligible', 'true', 'a2: an MD is eligible');
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'consented', 'true', 'a2: an MD connects');
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'true', 'a2: and gets a source');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 2,
    'a2: two notifications for one binding: the firm admin and the CCO');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id = v_adm and read_at is null and payload->>'address' = 'a2-md@bank.example'
    and payload->>'outcome' = 'created' and payload->>'sourceId' = v_result->>'sourceId'), 1,
    'a2: one goes to the firm admin, names the address and how the source was bound');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id = v_cco and read_at is null and payload->>'address' = 'a2-md@bank.example'
    and payload->>'outcome' = 'created' and payload->>'sourceId' = v_result->>'sourceId'), 1,
    'a2: one goes to the CCO seated in the firm, once');
  perform pg_temp.expect((select count(*) from notifications where event_type = 'mailbox_connected'
    and recipient_id in (v_off, v_ext, v_adm2, v_cco5, v_cco2, v_cco3, v_cco4, v_md, v_dir)), 0,
    'a2: not to a suspended admin, an external admin, another tenant''s admin or CCO, a CCO of a second bank, a suspended or external CCO, or the member');
  -- An idempotent re-grant binds nothing and tells no one.
  set local role authenticated;
  perform pg_temp.act_as(v_md);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceCreated', 'false', 'a2: a re-grant creates nothing');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 2,
    'a2: and sends no second notification to either');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_dt), 'ok', 'a2: deal team connects');
  reset role;
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id = v_adm), 2, 'a2: a second member, a second notification');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id = v_cco), 2, 'a2: for the CCO too');
  -- Withdraw and connect again: the withdrawal deleted the member's source (#461), so
  -- connecting again binds a fresh one, and both are told again.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_wd), 'ok', 'a2: wd connects');
  perform pg_temp.act_as(v_wd);
  perform mailbox_consent_withdraw();
  reset role;
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 6,
    'a2: three bindings so far, two recipients each');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_wd), 'ok', 'a2: wd connects again');
  reset role;
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 8,
    'a2: a re-consent after a withdrawal binds a fresh source and tells both again');

  -- (3) Taking over an ownerless source with no items resets its sync state.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider, delta_checkpoint, backfill_completed_at,
                               checkpoint_updated_at, last_synced_at, last_error, last_error_at)
  values (v_t, 'mailbox', 'a2-take@bank.example', null, 'microsoft', 'old-delta-link', now() - interval '3 days',
          now() - interval '2 days', now() - interval '1 day', 'graph 429', now() - interval '1 day')
  returning id into v_src;
  set local role authenticated;
  perform pg_temp.act_as(v_take);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'sourceAdopted', 'true', 'a2: the ownerless source is taken over');
  perform pg_temp.expect_text(v_result->>'sourceId', v_src::text, 'a2: the same row');
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and owner_user_id = v_take
    and delta_checkpoint is null and backfill_completed_at is null and checkpoint_updated_at is null
    and last_synced_at is null and last_error is null and last_error_at is null), 1,
    'a2: the takeover cleared the checkpoint and every sync field, so the new holder backfills afresh');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id in (v_adm, v_cco) and payload->>'address' = 'a2-take@bank.example' and payload->>'outcome' = 'taken_over'), 2,
    'a2: a takeover tells the admin and the CCO, as taken_over');
  -- An owned source's state is never reset by a re-grant: the owner keeps theirs. A withdrawal deletes
  -- it with its checkpoint (#461), so connecting again starts a fresh backfill.
  update content_sources set delta_checkpoint = 'mine' where id = v_src;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_take), 'ok', 'a2: take grants again while connected');
  reset role;
  perform pg_temp.expect((select count(*) from content_sources where id = v_src and delta_checkpoint = 'mine'), 1,
    'a2: a member''s own source keeps its checkpoint on a re-grant');
  set local role authenticated;
  perform pg_temp.act_as(v_take);
  perform mailbox_consent_withdraw();
  perform pg_temp.expect_text(pg_temp.try_grant(v_take), 'ok', 'a2: take connects again');
  reset role;
  perform pg_temp.expect((select count(*) from content_sources where id = v_src), 0,
    'a2: the withdrawal deleted the source with its checkpoint');
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address = 'a2-take@bank.example'
    and owner_user_id = v_take and delta_checkpoint is null), 1, 'a2: connecting again binds a fresh source');

  -- (4) An archived orphan: the fresh source is a binding and tells the admin.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'a2-arch@bank.example', null, 'microsoft') returning id into v_old;
  insert into source_items (tenant_id, kind, subject, content_hash, internet_message_id)
  values (v_t, 'message', 'Left behind', 'a2h', '<a2-1@old>') returning id into v_item;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_item, v_old, 'p1');
  set local role authenticated;
  perform pg_temp.act_as(v_arch);
  v_result := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_result->>'archivedSourceId', v_old::text, 'a2: the orphan with history is archived');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id in (v_adm, v_cco) and payload->>'address' = 'a2-arch@bank.example' and payload->>'outcome' = 'archived_previous'
    and payload->>'sourceId' = v_result->>'sourceId'), 2,
    'a2: a fresh source after an archive tells the admin and the CCO, naming the fresh source');
  -- ... and the archived one, so an admin can find the history to merge (audit round 4, Claude 5).
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and recipient_id in (v_adm, v_cco) and payload->>'address' = 'a2-arch@bank.example'
    and payload->>'archivedSourceId' = v_old::text), 2,
    'a2: an archive notification names the archived source');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
    and payload->>'outcome' <> 'archived_previous' and payload ? 'archivedSourceId'), 0,
    'a2: and no other outcome carries an archivedSourceId');
  perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'), 14,
    'a2: seven bindings, two recipients each');
  -- No mail content in any of them: the payload keys are the address, the outcome, the source and the archived source.
  -- This tenant's only, like the counts above: committed fixtures of other suites (a team inbox's connect, #581,
  -- adds teamMailboxId) must not reach into this one.
  perform pg_temp.expect((select count(*) from notifications n, jsonb_object_keys(n.payload) k
    where n.tenant_id = v_t and n.event_type = 'mailbox_connected' and k not in ('address', 'outcome', 'sourceId', 'provider', 'archivedSourceId')), 0,
    'a2: the payload holds an address, an outcome, the sources and a provider, nothing else');

  -- (5) The role check is a grant-time precondition only. A member already consented who leaves every deal
  -- keeps being read until they withdraw; status then follows the ordinary ladder, not not_on_a_deal.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_leaver), 'ok', 'a2: leaver connects while on a deal');
  reset role;
  delete from deal_memberships where user_id = v_leaver;
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'a2-leaver@bank.example', 'provider_read', 'a2', true, v_leaver, p_provider => 'microsoft'),
    null, 'a2: the guard still reads a consented member who left every deal');
  set local role authenticated;
  perform pg_temp.act_as(v_leaver);
  v_status := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_status->>'consented', 'true', 'a2: the consent stays');
  perform pg_temp.expect_text(v_status->>'reading', 'true', 'a2: and is still read');
  perform pg_temp.expect_text(v_status->>'readingReason', null, 'a2: the reading reason follows the ladder, not not_on_a_deal');
  set local role authenticated;
  perform pg_temp.act_as(v_leaver);
  perform mailbox_consent_withdraw();
  v_status := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_status->>'readingReason', 'not_on_a_deal', 'a2: after withdrawing, with no deal, status says not_on_a_deal');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_leaver), '42501:not_eligible', 'a2: and the next connect is refused');
  reset role;
  raise notice 'PASS: A2 one click needs MD or deal team on a deal, the firm admin is told per binding, a takeover starts a fresh backfill';
end;
$$;

-- ── 15. PR #300 round 3, A3 (H2, M6): `reading` is database eligibility, one decision ──
-- mailbox_guard_check and mailbox_consent_status().readingReason are two views of ONE decision
-- (mailbox_guard_verdict), so for every state `reading` is true exactly when the guard allows, and the reason
-- is the guard's, in the guard's order: no_source before no_consent, a paused source refused source_paused.
-- Three reasons are member-facing only, because they are about the member and not the address:
--   no_invite      the member has no seat, whatever the guard's cause (no_invite, external, seat_inactive,
--                  registration_inactive), and also with no source, where the guard says no_source
--   domain         seated on a domain no provider lists; with no source the guard says no_source
--   not_on_a_deal  no open consent and MD or deal team on no deal (a grant-time precondition the guard never
--                  tests); the guard says no_source, or no_consent when the source exists
-- Everything else is asserted equal. The helper also asserts every purpose gives the same verdict, so the
-- narrowing (a paused source) holds for tools, search, retrieval and export as well as the worker.
create function pg_temp.mx(p_label text, p_tenant uuid, p_member uuid, p_address text, p_provider text,
                           p_guard text, p_status text default '=')
returns void language plpgsql as $$
declare
  v_guard   text;
  v_purpose text;
  v_status  jsonb;
begin
  v_guard := mailbox_guard_check(p_tenant, p_address, 'provider_read', 'mx', true, p_member, p_provider => p_provider);
  perform pg_temp.expect_text(v_guard, p_guard, p_label || ': the guard says ' || coalesce(p_guard, 'allowed'));
  foreach v_purpose in array array['agent_tool', 'search', 'retrieval', 'export'] loop
    perform pg_temp.expect_text(
      mailbox_guard_check(p_tenant, p_address, v_purpose, 'mx', true, p_member, p_provider => p_provider),
      p_guard, p_label || ': ' || v_purpose || ' agrees with provider_read');
  end loop;
  set local role authenticated;
  perform pg_temp.act_as(p_member);
  v_status := mailbox_consent_status();
  reset role;
  perform pg_temp.expect_text(v_status->>'readingReason', case when p_status = '=' then p_guard else p_status end,
    p_label || ': readingReason is ' || case when p_status = '=' then 'the guard''s' else 'the documented ' || p_status end);
  perform pg_temp.expect_text(v_status->>'reading', (v_guard is null)::text, p_label || ': reading is whether the guard allows');
end;
$$;
grant execute on function pg_temp.mx(text, uuid, uuid, text, text, text, text) to anon, authenticated, service_role;

do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_ok uuid := gen_random_uuid();     v_ncns uuid := gen_random_uuid();   v_nc uuid := gen_random_uuid();
  v_ns uuid := gen_random_uuid();     v_oo uuid := gen_random_uuid();     v_own uuid := gen_random_uuid();
  v_pa uuid := gen_random_uuid();     v_pr uuid := gen_random_uuid();     v_mp uuid := gen_random_uuid();
  v_noseat uuid := gen_random_uuid(); v_susp uuid := gen_random_uuid();   v_ext uuid := gen_random_uuid();
  v_nsns uuid := gen_random_uuid();   v_dom uuid := gen_random_uuid();    v_dom2 uuid := gen_random_uuid();
  v_nd uuid := gen_random_uuid();     v_nd2 uuid := gen_random_uuid();    v_wd uuid := gen_random_uuid();
  v_res jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'mx');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_ok, 'mx-ok');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_ncns, 'mx-ncns');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_nc, 'mx-nc');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_ns, 'mx-ns');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_oo, 'mx-oo');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_own, 'mx-own');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_pa, 'mx-pa');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_pr, 'mx-pr');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_mp, 'mx-mp');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_noseat, 'mx-noseat');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_susp, 'mx-susp');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_ext, 'mx-ext');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_nsns, 'mx-nsns');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_dom, 'mx-dom');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_dom2, 'mx-dom2');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_nd, 'mx-nd', null, null);
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_nd2, 'mx-nd2', null, null);
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_wd, 'mx-wd');

  -- Allowed: consent on the seated invite, an active source of the member's own.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_ok), 'ok', 'mx: the allowed member connects');
  reset role;
  perform pg_temp.mx('allowed', v_t, v_ok, 'mx-ok@bank.example', 'microsoft', null);

  -- No consent and no source: the guard's first reason is no_source (the audit's example), and status agrees.
  perform pg_temp.mx('no consent, no source', v_t, v_ncns, 'mx-ncns@bank.example', 'microsoft', 'no_source');
  -- No consent, with a source: no_consent.
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'mx-nc@bank.example', v_nc, 'microsoft');
  perform pg_temp.mx('no consent, with source', v_t, v_nc, 'mx-nc@bank.example', 'microsoft', 'no_consent');
  -- Consent withdrawn: the withdrawal deleted the source (#461), so the guard's first reason is no_source.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_wd), 'ok', 'mx: wd connects');
  perform pg_temp.act_as(v_wd);
  perform mailbox_consent_withdraw();
  reset role;
  perform pg_temp.mx('withdrawn', v_t, v_wd, 'mx-wd@bank.example', 'microsoft', 'no_source');

  -- Consent, and the source is gone.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_ns), 'ok', 'mx: ns connects');
  reset role;
  delete from content_sources where tenant_id = v_t and address = 'mx-ns@bank.example';
  perform pg_temp.mx('consent, no source', v_t, v_ns, 'mx-ns@bank.example', 'microsoft', 'no_source');

  -- Owned by someone else, and ownerless.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_oo), 'ok', 'mx: oo connects');
  perform pg_temp.expect_text(pg_temp.try_grant(v_own), 'ok', 'mx: own connects');
  reset role;
  update content_sources set owner_user_id = v_ok where tenant_id = v_t and address = 'mx-oo@bank.example';
  perform pg_temp.mx('other owner', v_t, v_oo, 'mx-oo@bank.example', 'microsoft', 'owner_mismatch');
  update content_sources set owner_user_id = null where tenant_id = v_t and address = 'mx-own@bank.example';
  perform pg_temp.mx('ownerless', v_t, v_own, 'mx-own@bank.example', 'microsoft', 'owner_mismatch');

  -- Paused (M6): the worker skipped it and the card said paused while the guard said nothing. One verdict now.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_pa), 'ok', 'mx: pa connects');
  reset role;
  update content_sources set status = 'paused' where tenant_id = v_t and address = 'mx-pa@bank.example';
  perform pg_temp.mx('paused', v_t, v_pa, 'mx-pa@bank.example', 'microsoft', 'source_paused');
  update content_sources set status = 'active' where tenant_id = v_t and address = 'mx-pa@bank.example';
  perform pg_temp.mx('resumed', v_t, v_pa, 'mx-pa@bank.example', 'microsoft', null);

  -- A source on a provider that may not read the address. Judged by its own provider's registration, which is
  -- not active, so the guard and status say registration_inactive; a caller reading through another provider
  -- is told provider_mismatch, which is the caller's input and not part of the member's status.
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_pr), 'ok', 'mx: pr connects');
  reset role;
  perform pg_temp.pending_google(v_t);
  update content_sources set provider = 'google' where tenant_id = v_t and address = 'mx-pr@bank.example';
  perform pg_temp.mx('provider', v_t, v_pr, 'mx-pr@bank.example', 'google', 'registration_inactive');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'mx-pr@bank.example', 'provider_read', 'mx', true, v_pr, p_provider => 'microsoft'),
    'provider_mismatch', 'provider: a caller on another provider is refused provider_mismatch');

  -- Two providers could read it and there is no source: the guard has no vocabulary for the operator's choice.
  begin
    create or replace function mailbox_reader_providers(p_tenant_id uuid, p_address text, p_company_id uuid)
    returns text[] language sql stable security definer set search_path = public as $f$
      select array['google', 'microsoft']::text[];
    $f$;
    set local role authenticated;
    perform pg_temp.expect_text(pg_temp.try_grant(v_mp), 'ok', 'mx: mp connects');
    reset role;
    perform pg_temp.mx('multi-provider, no source', v_t, v_mp, 'mx-mp@bank.example', 'microsoft', 'no_source');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  reset role;

  -- No seat. The guard's cause varies; status says no_invite for all of them.
  delete from invites where accepted_user_id = v_noseat;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'mx-noseat@bank.example', null, 'microsoft');
  perform pg_temp.mx('no invite', v_t, v_noseat, 'mx-noseat@bank.example', 'microsoft', 'no_invite');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'mx-susp@bank.example', null, 'microsoft');
  update users set status = 'suspended' where id = v_susp;
  perform pg_temp.mx('suspended', v_t, v_susp, 'mx-susp@bank.example', 'microsoft', 'seat_inactive', 'no_invite');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'mx-ext@bank.example', null, 'microsoft');
  update users set is_external = true where id = v_ext;
  perform pg_temp.mx('external', v_t, v_ext, 'mx-ext@bank.example', 'microsoft', 'external', 'no_invite');
  delete from invites where accepted_user_id = v_nsns;
  perform pg_temp.mx('no seat, no source', v_t, v_nsns, 'mx-nsns@bank.example', 'microsoft', 'no_source', 'no_invite');
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
  perform pg_temp.mx('registration inactive', v_t, v_ok, 'mx-ok@bank.example', 'microsoft', 'registration_inactive', 'no_invite');
  update graph_reader_registrations set status = 'active' where tenant_id = v_t;
  perform pg_temp.mx('registration restored', v_t, v_ok, 'mx-ok@bank.example', 'microsoft', null);

  -- Seated on a domain no provider lists.
  update invites set email = 'mx-dom@elsewhere.example' where accepted_user_id = v_dom;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'mx-dom@elsewhere.example', v_dom, 'microsoft');
  perform pg_temp.mx('domain', v_t, v_dom, 'mx-dom@elsewhere.example', 'microsoft', 'domain');
  update invites set email = 'mx-dom2@elsewhere.example' where accepted_user_id = v_dom2;
  perform pg_temp.mx('domain, no source', v_t, v_dom2, 'mx-dom2@elsewhere.example', 'microsoft', 'no_source', 'domain');

  -- A grant-time precondition the guard never tests: no open consent, on no deal.
  perform pg_temp.mx('not on a deal, no source', v_t, v_nd, 'mx-nd@bank.example', 'microsoft', 'no_source', 'not_on_a_deal');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'mx-nd2@bank.example', v_nd2, 'microsoft');
  perform pg_temp.mx('not on a deal, with source', v_t, v_nd2, 'mx-nd2@bank.example', 'microsoft', 'no_consent', 'not_on_a_deal');

  -- The grant's own report is the same decision.
  set local role authenticated;
  perform pg_temp.act_as(v_ok);
  v_res := mailbox_consent_grant();
  reset role;
  perform pg_temp.expect_text(v_res->>'reading', 'true', 'mx: the grant reports reading for the allowed member');
  raise notice 'PASS: A3 reading and readingReason are the guard''s own verdict, state by state';
end;
$$;

-- ── 15c. Round 4, Claude 8: the verdict's inputs the matrix above holds fixed ──
-- pg_temp.mx always asks as provider_read with the owner check on and a known provider. These cases pin the rest of
-- the guard's input space as it already behaves (coverage; each passes against the unchanged functions): the owner
-- check off, an owner the caller names that is not the allowlisted user, a paused source against the worker's
-- provider-group reason, and a provider the guard does not know.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();  v_other uuid := gen_random_uuid();  v_nc uuid := gen_random_uuid();
  v_addr text := 'mxg-a@bank.example';
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'mxg');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_a, 'mxg-a');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_other, 'mxg-other');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_nc, 'mxg-nc');
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_grant(v_a), 'ok', 'mxg: a connects');
  reset role;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (v_t, 'mailbox', 'mxg-nc@bank.example', v_nc, 'microsoft');

  -- The owner check off: a provider_read does not compare the caller's owner, so any p_owner_user_id passes.
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', false, null, p_provider => 'microsoft'),
    null, 'mxg: owner check off, no owner named, allowed');
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', false, v_other, p_provider => 'microsoft'),
    null, 'mxg: owner check off, another owner named, still allowed (the caller''s owner is not compared)');
  -- The source's own current owner is compared whatever the caller says (C11).
  update content_sources set owner_user_id = v_other where tenant_id = v_t and address = v_addr;
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', false, v_a, p_provider => 'microsoft'),
    'owner_mismatch', 'mxg: owner check off, a source handed to someone else is still owner_mismatch');
  update content_sources set owner_user_id = v_a where tenant_id = v_t and address = v_addr;

  -- The owner check on: the named owner must be the allowlisted user, and naming none is a mismatch.
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', true, v_a, p_provider => 'microsoft'),
    null, 'mxg: owner check on, the allowlisted owner named, allowed');
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', true, v_other, p_provider => 'microsoft'),
    'owner_mismatch', 'mxg: owner check on, a mismatched owner is owner_mismatch');
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', true, null, p_provider => 'microsoft'),
    'owner_mismatch', 'mxg: owner check on, no owner named is owner_mismatch');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, v_addr, null, true, v_other), 'owner_mismatch',
    'mxg: the verdict says the same without a provider');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, v_addr, null, false, v_other), null,
    'mxg: and allows with the check off');

  -- Paused against the worker's provider-group reason: the database's verdict comes first, and the group
  -- reason is the caller's input that applies only when the database allows.
  update content_sources set status = 'paused' where tenant_id = v_t and address = v_addr;
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', true, v_a, 'not_in_provider_group', 'microsoft'),
    'source_paused', 'mxg: a paused source is source_paused, not the group reason');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', true, v_a, 'mirror_unavailable', 'microsoft'),
    'source_paused', 'mxg: and not mirror_unavailable either');
  update content_sources set status = 'active' where tenant_id = v_t and address = v_addr;
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, v_addr, 'provider_read', 'mxg', true, v_a, 'not_in_provider_group', 'microsoft'),
    'not_in_provider_group', 'mxg: an active allowed source takes the group reason');
  perform pg_temp.expect_text(
    mailbox_guard_check(v_t, 'mxg-nc@bank.example', 'provider_read', 'mxg', true, v_nc, 'not_in_provider_group', 'microsoft'),
    'no_consent', 'mxg: a database refusal wins over the group reason');

  -- A provider the guard does not know: the guard raises, and the verdict, given one, finds it is not the source's.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'select mailbox_guard_check(%L, %L, ''provider_read'', ''mxg'', true, %L, null, ''yahoo'')', v_t, v_addr, v_a)),
    '22023:mailbox_guard_check: a known provider is required', 'mxg: an unknown provider is refused');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'select mailbox_guard_check(%L, %L, ''provider_read'', ''mxg'', true, %L, null, null)', v_t, v_addr, v_a)),
    '22023:mailbox_guard_check: a known provider is required', 'mxg: and so is none');
  perform pg_temp.expect_text(mailbox_guard_verdict(v_t, v_addr, 'yahoo', true, v_a), 'provider_mismatch',
    'mxg: the verdict names an unknown provider a provider_mismatch');
  raise notice 'PASS: 15c the guard''s owner-check, owner, group-reason and provider inputs behave as documented';
end;
$$;

-- ── 15b. L8: a stale site registrant is its own refusal, not site_wrong_firm ───
-- An open registration whose registrant no longer stands (suspended, removed, external, not an admin) admits
-- nothing. The refusal says so (site_registrant_lost) and the audit row carries that reason, so it does not
-- accuse a correctly registered site of belonging to the wrong firm. Another firm's registration whose
-- registrant stands in that firm stays site_wrong_firm (section 10). The reader being inactive still comes first.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();
  v_site text := 'bank.sharepoint.com:/sites/l8';
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'l8');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'l8-adm', 'admin');
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  perform site_register(v_site);
  reset role;
  perform pg_temp.act_as_none();
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'provider_read', 'l8'), null, 'l8: the registered site is allowed');

  update users set status = 'suspended' where id = v_adm;
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'provider_read', 'l8'), 'site_registrant_lost',
    'l8: a suspended registrant is site_registrant_lost');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'
    and detail->>'reason' = 'site_registrant_lost' and detail->>'address' = v_site), 1,
    'l8: the refusal is audited as site_registrant_lost');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.site_refused'
    and detail->>'reason' = 'site_wrong_firm'), 0, 'l8: and not as site_wrong_firm');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = v_site
    and last_reason = 'site_registrant_lost'), 1, 'l8: the provider_read dedupe state accepts the reason');
  -- Every purpose says the same.
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'agent_tool', 'l8'), 'site_registrant_lost', 'l8: a tool read says it too');

  update users set status = 'active' where id = v_adm;
  update users set firm_role = null where id = v_adm;
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'agent_tool', 'l8'), 'site_registrant_lost', 'l8: a registrant who lost the admin role');
  update users set firm_role = 'admin' where id = v_adm;
  update users set is_external = true where id = v_adm;
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'agent_tool', 'l8'), 'site_registrant_lost', 'l8: an external registrant');
  update users set is_external = false where id = v_adm;
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'agent_tool', 'l8'), null, 'l8: reinstated, the site reads again');

  -- The reader's own registration inactive wins, as before.
  update users set status = 'suspended' where id = v_adm;
  update graph_reader_registrations set status = 'disabled' where tenant_id = v_t;
  perform pg_temp.expect_text(site_guard_check(v_t, v_site, 'agent_tool', 'l8'), 'registration_inactive',
    'l8: an inactive reader is still registration_inactive');
  raise notice 'PASS: L8 a stale site registrant is site_registrant_lost';
end;
$$;

-- ── 16. PR #300 round 4: unify and the archive, tightened ──────────────────────
-- Findings of audit 4: the fresh source's provider (Claude 1); unify needs an active target on the archived
-- row's provider (Codex 1, Claude 4); the new holder's first refusal is audited (Claude 3); the notification
-- names the archived source (Claude 5, asserted in section 14 and in 2c below); unify checks deal_discovery
-- itself (Claude 6); a database that ran an earlier version of the migration takes source_paused and
-- site_registrant_lost (Claude 2).
-- An ownerless mailbox source holding one stored item, left by an earlier holder of <p_local>@bank.example.
create function pg_temp.r4_orphan(p_t uuid, p_local text, p_provider text default 'microsoft')
returns uuid language plpgsql as $$
declare
  v_src uuid;
  v_item uuid;
begin
  if p_provider = 'google' then perform pg_temp.pending_google(p_t); end if;
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider)
  values (p_t, 'mailbox', p_local || '@bank.example', null, p_provider) returning id into v_src;
  insert into source_items (tenant_id, kind, subject, content_hash, internet_message_id)
  values (p_t, 'message', p_local, 'h-' || p_local, '<' || p_local || '@old>') returning id into v_item;
  insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (v_item, v_src, 'p1');
  return v_src;
end;
$$;

-- Claude 4 / Codex 1: the merge target must be active and on the archived row's provider.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();  v_new uuid := gen_random_uuid();
  v_old uuid;  v_fresh uuid;  v_result jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'r41');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'r41-adm', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_new, 'r41-new');
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  v_old := pg_temp.r4_orphan(v_t, 'r41-new');
  perform pg_temp.act_as(v_new);
  v_result := mailbox_consent_grant();
  v_fresh := (v_result->>'sourceId')::uuid;
  perform pg_temp.expect_text(v_result->>'archivedSourceId', v_old::text, 'r4-1: the orphan is archived');

  update content_sources set status = 'paused' where id = v_fresh;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    'P0001:unify_target_not_active', 'r4-1: a paused target is refused');
  reset role;
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 1,
    'r4-1: the refusal moved nothing');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_fresh), 0,
    'r4-1: and the paused target holds nothing, so its owner sees nothing through RLS');

  perform pg_temp.pending_google(v_t);
  update content_sources set status = 'active', provider = 'google' where id = v_fresh;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    'P0001:unify_provider_mismatch', 'r4-1: a target on another provider than the archived row is refused');
  reset role;
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 1,
    'r4-1: that refusal moved nothing either');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_sources_unified'), 0,
    'r4-1: and audited no merge');

  -- Active and on the archived row's provider: the merge goes through.
  update content_sources set provider = 'microsoft' where id = v_fresh;
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  v_result := discovery_unify_mailbox_sources(v_old, v_fresh);
  reset role;
  perform pg_temp.expect_text(v_result->>'moved', '1', 'r4-1: an active target on the same provider takes the history');
  raise notice 'PASS: r4-1 unify refuses a paused target and a target on another provider';
end;
$$;

-- Claude 6: unify checks deal_discovery itself, failing closed, and says nothing of the flag to a non-admin.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();  v_new uuid := gen_random_uuid();  v_plain uuid := gen_random_uuid();
  v_old uuid;  v_fresh uuid;  v_result jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'r48');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'r48-adm', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_new, 'r48-new');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_plain, 'r48-plain');
  v_old := pg_temp.r4_orphan(v_t, 'r48-new');
  perform pg_temp.act_as(v_new);
  v_fresh := (mailbox_consent_grant()->>'sourceId')::uuid;

  insert into feature_flags (key, enabled) values ('deal_discovery', false) on conflict (key) do update set enabled = false;
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    'P0001:unify_discovery_disabled', 'r4-8: a merge is refused while deal_discovery is off');
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_plain, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    '42501:not_authorized', 'r4-8: a non-admin still hears not_authorized, not the flag');
  reset role;
  delete from feature_flags where key = 'deal_discovery';
  set local role authenticated;
  perform pg_temp.expect_text(pg_temp.try_sql_as(v_adm, format('select discovery_unify_mailbox_sources(%L, %L)', v_old, v_fresh)),
    'P0001:unify_discovery_disabled', 'r4-8: with no flag row it fails closed');
  reset role;
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 1,
    'r4-8: the refusals moved nothing');

  insert into feature_flags (key, enabled) values ('deal_discovery', true);
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  v_result := discovery_unify_mailbox_sources(v_old, v_fresh);
  reset role;
  perform pg_temp.expect_text(v_result->>'moved', '1', 'r4-8: with the flag on the merge goes through');
  raise notice 'PASS: r4-8 unify checks deal_discovery itself and fails closed';
end;
$$;

-- Claude 1: the fresh source's provider after an archive. The old provider only while a registration of it may
-- still read the address; else the one eligible provider; else no source (the operator picks).
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();  v_cco uuid := gen_random_uuid();
  v_m1 uuid := gen_random_uuid();  v_m2 uuid := gen_random_uuid();  v_m3 uuid := gen_random_uuid();
  v_old uuid;  v_result jsonb;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'r42');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'r42-adm', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_m1, 'r42-m1');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_m2, 'r42-m2');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_m3, 'r42-m3');

  -- (a) The archived row's provider is not one that may read the address (only microsoft is registered):
  -- the fresh source is the one eligible provider's, and it reads.
  v_old := pg_temp.r4_orphan(v_t, 'r42-m2', 'google');
  perform pg_temp.act_as(v_m2);
  v_result := mailbox_consent_grant();
  perform pg_temp.expect_text(v_result->>'archivedSourceId', v_old::text, 'r4-2a: the google orphan is archived');
  perform pg_temp.expect((select count(*) from content_sources where id = (v_result->>'sourceId')::uuid
    and provider = 'microsoft' and status = 'active' and owner_user_id = v_m2 and address = 'r42-m2@bank.example'), 1,
    'r4-2a: the fresh source is on the one eligible provider, not the archived row''s');
  perform pg_temp.expect_text(v_result->>'reading', 'true', 'r4-2a: and it reads');
  perform pg_temp.expect((select count(*) from content_sources where id = v_old and provider = 'google'), 1,
    'r4-2a: the archived row keeps its own provider');

  -- (b) Two providers could read the address and the archived row's is one of them: it keeps its provider.
  begin
    create or replace function mailbox_reader_providers(p_tenant_id uuid, p_address text, p_company_id uuid)
    returns text[] language sql stable security definer set search_path = public as $f$
      select array['google', 'microsoft']::text[];
    $f$;
    v_old := pg_temp.r4_orphan(v_t, 'r42-m1', 'google');
    perform pg_temp.act_as(v_m1);
    v_result := mailbox_consent_grant();
    perform pg_temp.expect_text(v_result->>'archivedSourceId', v_old::text, 'r4-2b: the orphan is archived');
    perform pg_temp.expect((select count(*) from content_sources where id = (v_result->>'sourceId')::uuid
      and provider = 'google' and owner_user_id = v_m1), 1,
      'r4-2b: the archived row''s provider is eligible, so the fresh source keeps it');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;

  -- (c) The archived row's provider is not eligible and more than one other could be: no source is created, as
  -- when no row existed. The history is still archived, the consent is recorded, the guard says no_source, and
  -- the admin is told so someone can place a source.
  begin
    create or replace function mailbox_reader_providers(p_tenant_id uuid, p_address text, p_company_id uuid)
    returns text[] language sql stable security definer set search_path = public as $f$
      select array['google', 'other']::text[];
    $f$;
    v_old := pg_temp.r4_orphan(v_t, 'r42-m3', 'microsoft');
    perform pg_temp.act_as(v_m3);
    v_result := mailbox_consent_grant();
    perform pg_temp.expect_text(v_result->>'consented', 'true', 'r4-2c: the opt-in is recorded');
    perform pg_temp.expect_text(v_result->>'archivedSourceId', v_old::text, 'r4-2c: the orphan is still archived');
    perform pg_temp.expect_text(v_result->>'sourceCreated', 'false', 'r4-2c: but no fresh source is created');
    perform pg_temp.expect_text(v_result->>'sourceId', null, 'r4-2c: and none is named');
    perform pg_temp.expect_text(v_result->>'readingReason', 'no_source', 'r4-2c: the guard says no_source');
    perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and lower(address) = 'r42-m3@bank.example'), 0,
      'r4-2c: nothing holds the live address');
    perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_source_archived'
      and detail->>'sourceId' = v_old::text and detail->>'freshSourceId' is null), 1,
      'r4-2c: the archive is audited with no fresh source');
    perform pg_temp.expect((select count(*) from notifications where tenant_id = v_t and event_type = 'mailbox_connected'
      and recipient_id = v_adm and payload->>'outcome' = 'archived_previous' and payload->>'sourceId' is null
      and payload->>'archivedSourceId' = v_old::text and payload->>'address' = 'r42-m3@bank.example'), 1,
      'r4-2c: the admin is told of the archive although nothing fresh was bound');
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  raise notice 'PASS: r4-2 the fresh source takes the old provider only while it is eligible, else the one eligible, else none';
end;
$$;

-- Claude 3: an archive forgets the guard's last refusal for the live address, so the new holder's first
-- refusal is audited even when it has the same reason.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_st uuid := gen_random_uuid();  v_old uuid;
  v_addr text := 'r45-st@bank.example';
  v_before bigint;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'r45');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_st, 'r45-st');
  v_old := pg_temp.r4_orphan(v_t, 'r45-st');
  -- The earlier holder's last refusal: the address is seated but nobody has opted in.
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'r45', true, v_st, p_provider => 'microsoft'),
    'no_consent', 'r4-5: the orphan is refused no_consent');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = v_addr
    and last_reason = 'no_consent'), 1, 'r4-5: and the refusal is remembered');

  perform pg_temp.act_as(v_st);
  perform pg_temp.expect_text(mailbox_consent_grant()->>'archivedSourceId', v_old::text, 'r4-5: the member''s opt-in archives it');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t and address = v_addr), 0,
    'r4-5: and forgets the earlier refusal');
  perform mailbox_consent_withdraw();
  -- The withdrawal deleted the fresh source (#461). An owned source is put back, so the guard judges the
  -- withdrawn consent, the same reason it gave the earlier holder.
  perform pg_temp.expect((select count(*) from content_sources where tenant_id = v_t and address = v_addr), 0,
    'r4-5: the withdrawal deleted the new holder''s source');
  insert into content_sources (tenant_id, kind, address, owner_user_id, provider) values (v_t, 'mailbox', v_addr, v_st, 'microsoft');

  select count(*) into v_before from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail->>'address' = v_addr;
  perform pg_temp.expect_text(mailbox_guard_check(v_t, v_addr, 'provider_read', 'r45', true, v_st, p_provider => 'microsoft'),
    'no_consent', 'r4-5: the new holder, withdrawn, is refused no_consent again');
  perform pg_temp.expect((select count(*) from audit_log where tenant_id = v_t and action = 'discovery.mailbox_refused'
    and detail->>'address' = v_addr), v_before + 1, 'r4-5: and that first refusal of the new holder is audited');
  raise notice 'PASS: r4-5 the new holder''s first refusal is audited after an archive';
end;
$$;

-- Codex 3: nothing the worker held in flight lands on an archived source. A trigger rejects a provenance link
-- insert for it and a write of its checkpoint or sync state, with source_archived (P0001). The archive step,
-- the merge (which moves links from the archived row to a live one) and everything on a live row still work.
do $$
declare
  v_t uuid := gen_random_uuid();  v_b uuid := gen_random_uuid();  v_dir uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();  v_new uuid := gen_random_uuid();
  v_old uuid;  v_fresh uuid;  v_item2 uuid;  v_result jsonb;  v_set text;
begin
  perform pg_temp.mk_firm(v_t, v_b, v_dir, 'r43');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_adm, 'r43-adm', 'admin');
  perform pg_temp.mk_member(v_t, v_b, v_dir, v_new, 'r43-new');
  insert into feature_flags (key, enabled) values ('deal_discovery', true) on conflict (key) do update set enabled = true;
  v_old := pg_temp.r4_orphan(v_t, 'r43-new');
  -- The earlier holder's resume point is on the row when the archive stamps it: the archive step does not write
  -- it, so the trigger lets the archive through.
  update content_sources set delta_checkpoint = 'earlier', backfill_completed_at = now(), last_synced_at = now() where id = v_old;
  insert into source_items (tenant_id, kind, subject, content_hash, internet_message_id)
  values (v_t, 'message', 'late', 'h-late', '<r43-late@old>') returning id into v_item2;

  -- A live source takes links and checkpoints as ever.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (%L, %L, ''p-live'')', v_item2, v_old)),
    'ok', 'r4-3: before the archive the old source takes a link');
  delete from source_item_sources where content_source_id = v_old and provider_item_id = 'p-live';

  perform pg_temp.act_as(v_new);
  v_result := mailbox_consent_grant();
  v_fresh := (v_result->>'sourceId')::uuid;
  perform pg_temp.expect_text(v_result->>'archivedSourceId', v_old::text, 'r4-3: the archive step itself is not blocked');
  perform pg_temp.expect((select count(*) from content_sources where id = v_old and archived_at is not null
    and delta_checkpoint = 'earlier'), 1, 'r4-3: the archived row keeps its checkpoint');

  -- An in-flight worker's link for the archived source is refused.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (%L, %L, ''p2'')', v_item2, v_old)),
    'P0001:source_archived', 'r4-3: a link insert for an archived source is refused');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (%L, %L, ''p2'') on conflict do nothing', v_item2, v_old)),
    'P0001:source_archived', 'r4-3: and so is an upsert that would be ignored on conflict');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 1,
    'r4-3: the archived row still holds only the history it was archived with');

  -- ... and each checkpoint or sync-state write to it.
  foreach v_set in array array[
    'delta_checkpoint = ''late''', 'backfill_completed_at = now()', 'checkpoint_updated_at = now()',
    'last_synced_at = now()', 'last_error = ''Graph 503''', 'last_error_at = now()',
    'last_synced_at = now(), last_error = null, last_error_at = null, backfill_completed_at = now()']
  loop
    perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set %s where id = %L', v_set, v_old)),
      'P0001:source_archived', 'r4-3: an archived source refuses ' || v_set);
  end loop;
  perform pg_temp.expect((select count(*) from content_sources where id = v_old and delta_checkpoint = 'earlier'), 1,
    'r4-3: the refusals changed nothing');
  -- The columns that are not sync state are not covered: pausing an archived row still works.
  perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set status = ''paused'' where id = %L', v_old)),
    'ok', 'r4-3: a write to a column that is not sync state is not refused');

  -- The live source of the address is unaffected.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (%L, %L, ''p-fresh'')', v_item2, v_fresh)),
    'ok', 'r4-3: the live source takes a link');
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'update content_sources set delta_checkpoint = ''fresh'', checkpoint_updated_at = now(), last_synced_at = now(), last_error = null where id = %L', v_fresh)),
    'ok', 'r4-3: and a checkpoint write');
  delete from source_item_sources where content_source_id = v_fresh and provider_item_id = 'p-fresh';

  -- The merge moves links from the archived row to the live one, which the trigger does not stand in the way of.
  set local role authenticated;
  perform pg_temp.act_as(v_adm);
  v_result := discovery_unify_mailbox_sources(v_old, v_fresh);
  reset role;
  perform pg_temp.expect_text(v_result->>'moved', '1', 'r4-3: the merge still moves the history');
  perform pg_temp.expect((select count(*) from source_item_sources where content_source_id = v_old), 0,
    'r4-3: the archived row is empty after it');
  -- Closed for good: a late write after the merge is refused too, so the archive cannot refill.
  perform pg_temp.expect_text(pg_temp.try_sql(format(
    'insert into source_item_sources (source_item_id, content_source_id, provider_item_id) values (%L, %L, ''p3'')', v_item2, v_old)),
    'P0001:source_archived', 'r4-3: after the merge the archived row still takes no link');
  perform pg_temp.expect_text(pg_temp.try_sql(format('update content_sources set last_synced_at = now() where id = %L', v_old)),
    'P0001:source_archived', 'r4-3: and no sync-state write');
  raise notice 'PASS: r4-3 an archived source takes no late link and no sync-state write; the archive and the merge still work';
end;
$$;

-- #581 phase 7: 20261019140000 restates the guard's remembered-reason CHECK with the three team reasons. It takes them,
-- keeps every earlier reason, and still refuses an unknown one. (The personal cases above are the proof that the verdict's
-- personal path is unchanged: they ran against the new verdict.) The next section re-applies the original migration and
-- clears the table first, so these rows do not outlive this block.
do $$
declare
  v_t   uuid := gen_random_uuid();
  v_res text;
begin
  insert into mailbox_guard_state (tenant_id, address, last_reason) values
    (v_t, 'a@bank.example', 'team_mailbox_unverified'),
    (v_t, 'b@bank.example', 'team_mailbox_disconnected'),
    (v_t, 'c@bank.example', 'team_mailbox_person'),
    (v_t, 'd@bank.example', 'no_consent'),
    (v_t, 'e@bank.example', 'source_paused'),
    (v_t, 'f@bank.example', 'site_registrant_lost');
  perform pg_temp.expect((select count(*) from mailbox_guard_state where tenant_id = v_t), 6,
    'p7-1: the guard state takes the three team reasons and keeps the earlier ones');
  begin
    insert into mailbox_guard_state (tenant_id, address, last_reason) values (v_t, 'g@bank.example', 'team_mailbox_nope');
    v_res := 'accepted';
  exception when check_violation then
    v_res := 'refused';
  end;
  perform pg_temp.expect_text(v_res, 'refused', 'p7-1: and refuses an unknown team reason');
  perform pg_temp.expect((select count(*) from pg_proc where proname = 'mailbox_guard_verdict'), 1,
    'p7-2: there is one verdict function: the six-argument one replaced the five-argument one');
  raise notice 'PASS: p7 the guard state takes the team reasons; one verdict function';
end;
$$;

-- Claude 2: a database that ran an earlier version of 20261001130000 keeps the table (create table if not
-- exists) and with it the narrower last_reason CHECK. Re-applying the migration must widen it. The test
-- builds that database (drops the CHECK, adds the earlier list, shows it refuses the two newer reasons),
-- re-runs the real migration file, and then writes both reasons.
create function pg_temp.r4_state_insert(p_reason text)
returns text language plpgsql as $$
begin
  insert into mailbox_guard_state (tenant_id, address, last_reason) values (gen_random_uuid(), 'r46@bank.example', p_reason);
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;
delete from mailbox_guard_state;   -- the earlier sections left rows the earlier CHECK would not have allowed
alter table mailbox_guard_state drop constraint mailbox_guard_state_last_reason_check;
alter table mailbox_guard_state add constraint mailbox_guard_state_last_reason_check check (last_reason in (
  'no_invite', 'seat_inactive', 'external', 'no_consent', 'domain', 'owner_mismatch', 'not_in_provider_group',
  'mirror_unavailable', 'registration_inactive', 'provider_mismatch', 'no_source',
  'site_not_registered', 'site_wrong_firm'));
select pg_temp.expect_text(pg_temp.r4_state_insert('source_paused'), '23514', 'r4-6: the earlier CHECK refuses source_paused');
select pg_temp.expect_text(pg_temp.r4_state_insert('site_registrant_lost'), '23514', 'r4-6: and site_registrant_lost');
select pg_temp.expect_text(pg_temp.r4_state_insert('no_consent'), 'ok', 'r4-6: but still takes an earlier reason');
set client_min_messages = warning;
\o /dev/null
\ir ../migrations/20261001130000_mailbox_allowlist.sql
\o
reset client_min_messages;
select pg_temp.expect_text(pg_temp.r4_state_insert('source_paused'), 'ok', 'r4-6: after re-applying the migration, source_paused is accepted');
select pg_temp.expect_text(pg_temp.r4_state_insert('site_registrant_lost'), 'ok', 'r4-6: and site_registrant_lost');
select pg_temp.expect_text(pg_temp.r4_state_insert('not_a_reason'), '23514', 'r4-6: and an unknown reason is still refused');
do $$ begin raise notice 'PASS: r4-6 re-applying the migration widens an earlier last_reason CHECK'; end $$;

rollback;
