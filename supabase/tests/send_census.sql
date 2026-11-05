-- Phase 1 send census: coverage, frozen facts, access, window and validation. Rolled back.
begin;
-- F1: an archived ownerless source and its re-created successor never both count the same week.
do $$
declare
  t uuid := gen_random_uuid();
  old_src uuid := gen_random_uuid();
  new_src uuid := gen_random_uuid();
  w date := date_trunc('week', now() at time zone 'utc')::date;
begin
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, status, created_at, backfill_completed_at, last_synced_at,
                               archived_at, archived_from_address, send_census_from)
  values (old_src, t, 'mailbox', 'google', 'f1@example.test~abc', 'paused', w - interval '20 weeks', w - interval '19 weeks',
          w - interval '2 days', w - interval '2 days', 'F1@example.test', null),
         (new_src, t, 'mailbox', 'google', 'f1@example.test', 'active', w - interval '2 days', now(), now(), null, null, null);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id, sent_at)
  values (old_src, 'same', 'hash', 'unrouted', gen_random_uuid(), w - interval '20 days'),
         (new_src, 'same', 'hash', 'unrouted', gen_random_uuid(), w - interval '20 days');
  perform send_census_refresh(t, 8);
  if (select sum(native) from send_census_weekly where tenant_id = t and week = w - 21) is distinct from 1 then
    raise exception 'F1: archived and successor sources double-counted a week (%)',
      (select sum(native) from send_census_weekly where tenant_id = t and week = w - 21);
  end if;
  if exists (select 1 from send_census_weekly where tenant_id = t and source_id = new_src and week < w) then
    raise exception 'F1: successor covered weeks before its first Monday';
  end if;
  if not exists (select 1 from send_census_weekly where tenant_id = t and source_id = old_src and week = w - 21 and native = 1) then
    raise exception 'F1: archived source lost its pre-archive week';
  end if;
end;
$$;

-- F3: a policy skip fills a missing send fact on a routed or unrouted row, and changes nothing else on it.
do $$
declare
  t uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  w date := date_trunc('week', now() at time zone 'utc')::date;
  r routing_ledger%rowtype;
begin
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_completed_at, last_synced_at)
  values (a, t, 'mailbox', 'google', 'f3@example.test', now(), now());
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id)
  values (a, 'reread', 'hash', 'unrouted', gen_random_uuid());
  perform discovery_ledger_record_policy_skips(jsonb_build_array(jsonb_build_object(
    'source_id', a, 'provider_item_id', 'reread', 'item_hash', 'other-hash', 'skip_reason', 'policy_excluded',
    'provider_thread_id', 'thread', 'policy_version', 1, 'exclusion_rule', 'rule', 'run_id', gen_random_uuid(),
    'sent_at', w - interval '3 days', 'sent_recipient', 'non_deal')));
  select * into r from routing_ledger where source_id = a and provider_item_id = 'reread';
  if r.decision <> 'unrouted' or r.skip_reason is not null or r.item_hash <> 'hash' or r.policy_version is not null then
    raise exception 'F3: the policy skip rewrote a non-policy row';
  end if;
  if r.sent_at is distinct from w - interval '3 days' or r.sent_recipient is distinct from 'non_deal' then
    raise exception 'F3: the send fact was not filled on the unrouted row';
  end if;
end;
$$;

do $$
declare
  t uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  w date := date_trunc('week', now() at time zone 'utc')::date;
  out jsonb;
begin
  if not (select relrowsecurity from pg_class where oid = 'send_census_weekly'::regclass) then
    raise exception 'send census RLS is disabled';
  end if;
  if has_table_privilege('anon', 'send_census_weekly', 'select') or has_table_privilege('authenticated', 'send_census_weekly', 'select')
     or not has_table_privilege('service_role', 'send_census_weekly', 'insert') then
    raise exception 'send census table grants';
  end if;
  if has_function_privilege('anon', 'send_census_refresh(uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'send_census_refresh(uuid, integer)', 'execute')
     or not has_function_privilege('service_role', 'send_census_refresh(uuid, integer)', 'execute') then
    raise exception 'send census function grants';
  end if;
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_completed_at, last_synced_at, send_census_from)
  values (a, t, 'mailbox', 'google', 'a@example.test', now(), now(), null),
         (b, t, 'mailbox', 'google', 'b@example.test', now(), now(), w - 21),
         (c, t, 'mailbox', 'google', 'c@example.test', null, now(), null);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id, sent_at, sent_recipient)
  values (a, 'one', 'hash', 'unrouted', gen_random_uuid(), w - interval '1 day', 'non_deal');
  update routing_ledger set sent_at = w - interval '8 days', sent_recipient = 'deal_contact' where source_id = a and provider_item_id = 'one';
  if (select sent_at <> w - interval '1 day' or sent_recipient <> 'non_deal' from routing_ledger where source_id = a and provider_item_id = 'one') then
    raise exception 'sent fact was not frozen';
  end if;
  perform discovery_ledger_record_policy_skips(jsonb_build_array(jsonb_build_object(
    'source_id', a, 'provider_item_id', 'policy', 'item_hash', 'hash', 'skip_reason', 'policy_excluded',
    'provider_thread_id', 'thread', 'policy_version', 1, 'exclusion_rule', 'rule', 'run_id', gen_random_uuid(),
    'sent_at', w - interval '1 day', 'sent_recipient', 'non_deal')));
  perform discovery_ledger_record_policy_skips(jsonb_build_array(jsonb_build_object(
    'source_id', a, 'provider_item_id', 'policy', 'item_hash', 'hash', 'skip_reason', 'policy_excluded',
    'provider_thread_id', 'thread', 'policy_version', 2, 'exclusion_rule', 'rule', 'run_id', gen_random_uuid(),
    'sent_at', w - interval '8 days', 'sent_recipient', 'deal_contact')));
  if (select sent_at <> w - interval '1 day' or sent_recipient <> 'non_deal'
        from routing_ledger where source_id = a and provider_item_id = 'policy') then
    raise exception 'policy skip send fact was not frozen';
  end if;
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id)
  values (a, 'later', 'hash', 'unrouted', gen_random_uuid());
  update routing_ledger set sent_at = w - interval '2 days' where source_id = a and provider_item_id = 'later';
  if (select sent_at is null from routing_ledger where source_id = a and provider_item_id = 'later') then
    raise exception 'first send fact not accepted';
  end if;
  out := send_census_refresh(t, 8);
  if out->>'rows' <> '11' or (select count(*) from send_census_weekly where tenant_id = t and source_id = a) <> 8
     or (select count(*) from send_census_weekly where tenant_id = t and source_id = b) <> 3
     or exists (select 1 from send_census_weekly where source_id = c)
     or (select native from send_census_weekly where source_id = a and week = w - 7) <> 3
     or (select deal_contact from send_census_weekly where source_id = a and week = w - 7) <> 0
     or (select non_deal from send_census_weekly where source_id = a and week = w - 7) <> 2 then
    raise exception 'coverage or native counts incorrect: %', out;
  end if;
  update content_sources set send_census_from = null where id = b;
  perform send_census_refresh(t, 8);
  if (select count(*) from send_census_weekly where source_id = b) <> 8 then raise exception 'rebackfill coverage'; end if;
  begin
    perform send_census_refresh(t, 0);
    raise exception 'accepted zero weeks';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

-- Phase 2: relay timing, attribution and nullable native coverage.
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

create function pg_temp.relay(t uuid, sender uuid, created timestamptz, reviewed timestamptz,
                              state text default 'sent', transport text default 'resend')
returns void language sql as $$
  insert into outbound_messages (tenant_id, sender_id, to_emails, subject, body, verdict, status, provider, created_at, reviewed_at)
  values (t, sender, array['fixture@example.test'], 'fixture', 'fixture', 'compliant', state, transport, created, reviewed);
$$;

do $$
declare
  t uuid := gen_random_uuid();
  other_t uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
  v uuid := gen_random_uuid();
  no_box uuid := gen_random_uuid();
  uncovered_user uuid := gen_random_uuid();
  late_box uuid := gen_random_uuid();
  foreign_user uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  m uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  late_source uuid := gen_random_uuid();
  w timestamptz := date_trunc('week', now() at time zone 'utc') at time zone 'utc';
  result jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (u, 'census-u@example.test', jsonb_build_object('tenant_id', t)),
    (v, 'census-v@example.test', jsonb_build_object('tenant_id', t)),
    (no_box, 'census-none@example.test', jsonb_build_object('tenant_id', t)),
    (uncovered_user, 'census-uncovered@example.test', jsonb_build_object('tenant_id', t)),
    (late_box, 'census-late@example.test', jsonb_build_object('tenant_id', t)),
    (foreign_user, 'census-foreign@example.test', jsonb_build_object('tenant_id', other_t));
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id)
  values (t, 'census', 'census'), (other_t, 'census', 'census');
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, owner_user_id, created_at,
                               backfill_completed_at, last_synced_at, send_census_from)
  values
    (a, t, 'mailbox', 'google', 'census-a@example.test', u, w - interval '10 weeks', w, w, null),
    (c, t, 'mailbox', 'google', 'census-c@example.test', u, w - interval '2 days', null, null, null),
    (m, t, 'mailbox', 'microsoft', 'census-m@example.test', v, w - interval '10 weeks', null, null, null),
    (b, t, 'mailbox', 'google', 'census-b@example.test', uncovered_user, w - interval '10 weeks', w, w, (w - interval '1 week')::date),
    (late_source, t, 'mailbox', 'microsoft', 'census-late-source@example.test', late_box,
     w - interval '1 day', null, null, null);
  -- B is available but A is older and wins the tie; a second Google source never duplicates a send.
  perform pg_temp.relay(t, u, w - interval '4 days', null);
  perform pg_temp.relay(t, u, w - interval '3 days', null);
  perform pg_temp.relay(t, u, w - interval '11 days', w - interval '2 days');
  perform pg_temp.relay(t, u, w - interval '4 days', null, 'sent', 'noop');
  perform pg_temp.relay(t, u, w - interval '4 days', null, 'held');
  perform pg_temp.relay(t, u, w - interval '4 days', null, 'rejected');
  perform pg_temp.relay(t, v, w - interval '11 days', null);
  perform pg_temp.relay(t, uncovered_user, w - interval '18 days', null);
  perform pg_temp.relay(t, no_box, w - interval '2 days', null);
  perform pg_temp.relay(t, no_box, w - interval '3 days', null);
  perform pg_temp.relay(t, late_box, w - interval '2 days', null);
  perform pg_temp.relay(other_t, foreign_user, w - interval '2 days', null);
  result := send_census_refresh(t, 8);
  if result->>'unattributed' <> '2'
     or (select platform from send_census_weekly where source_id = a and week = (w - interval '1 week')::date) <> 3
     or (select native is not null from send_census_weekly where source_id = m and week = (w - interval '2 weeks')::date) is distinct from false
     or (select platform from send_census_weekly where source_id = m and week = (w - interval '2 weeks')::date) <> 1
     or (select native is not null from send_census_weekly where source_id = b and week = (w - interval '3 weeks')::date) is distinct from false
     or (select platform from send_census_weekly where source_id = b and week = (w - interval '3 weeks')::date) <> 1
     or (select sum(platform) from send_census_weekly where tenant_id = t) <> 5
     or exists (select 1 from send_census_weekly where source_id = c or source_id = late_source)
     or exists (select 1 from send_census_weekly where tenant_id = other_t) then
    raise exception 'relay attribution incorrect: %', result;
  end if;
  update content_sources set archived_at = w - interval '1 day' where id = a;
  perform pg_temp.relay(t, u, w - interval '12 hours', null);
  result := send_census_refresh(t, 8);
  if (select platform from send_census_weekly where source_id = a and week = (w - interval '1 week')::date) <> 3
     or (select platform from send_census_weekly where source_id = c and week = (w - interval '1 week')::date) <> 1
     or (select native is not null from send_census_weekly where source_id = c and week = (w - interval '1 week')::date) is distinct from false then
    raise exception 'archive moved past sends or lost new send: %', result;
  end if;
end;
$$;
-- F2: a relay send from before the banker's mailbox existed goes to that mailbox when its census covers the week.
do $$
declare
  t uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
  gone uuid := gen_random_uuid();
  s uuid := gen_random_uuid();
  old_s uuid := gen_random_uuid();
  w date := date_trunc('week', now() at time zone 'utc')::date;
  result jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (u, 'census-f2@example.test', jsonb_build_object('tenant_id', t)),
    (gone, 'census-f2-gone@example.test', jsonb_build_object('tenant_id', t));
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, owner_user_id, created_at,
                               backfill_completed_at, last_synced_at, archived_at, send_census_from)
  values (s, t, 'mailbox', 'google', 'census-f2@example.test', u, w - interval '2 days', now(), now(), null, null),
         -- Archived before the send's week ended: its census does not cover the week, so it takes nothing.
         (old_s, t, 'mailbox', 'google', 'census-f2-gone@example.test', gone, w - interval '10 weeks',
          w - interval '9 weeks', w - interval '4 weeks', w - interval '4 weeks', null);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id, sent_at)
  values (s, 'native', 'hash', 'unrouted', gen_random_uuid(), w - interval '20 days');
  perform pg_temp.relay(t, u, w - interval '19 days', null);
  perform pg_temp.relay(t, gone, w - interval '19 days', null);
  result := send_census_refresh(t, 8);
  if (select count(*) from send_census_weekly where tenant_id = t and week = w - 21) <> 1
     or not exists (select 1 from send_census_weekly where tenant_id = t and source_id = s and week = w - 21
                      and native = 1 and platform = 1) then
    raise exception 'F2: pre-connection relay send not attributed to the covering mailbox: %', result;
  end if;
  if result->>'unattributed' <> '1' then
    raise exception 'F2: a sender with no covering mailbox must stay unattributed: %', result;
  end if;
end;
$$;

-- Phase 3: counts remain frozen, including unclassified sends and nullable native weeks.
do $$
declare
  t uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  w date := date_trunc('week', now() at time zone 'utc')::date;
begin
  if has_function_privilege('anon', 'send_census_deal_contacts(uuid)', 'execute')
     or has_function_privilege('authenticated', 'send_census_deal_contacts(uuid)', 'execute')
     or not has_function_privilege('service_role', 'send_census_deal_contacts(uuid)', 'execute') then
    raise exception 'contact lookup grants';
  end if;
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_completed_at, last_synced_at, send_census_from)
  values (a, t, 'mailbox', 'google', 'recipient@example.test', now(), now(), null);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id, sent_at, sent_recipient)
  values (a, 'contact', 'hash', 'unrouted', gen_random_uuid(), w - 1, 'deal_contact'),
         (a, 'ordinary', 'hash', 'unrouted', gen_random_uuid(), w - 1, 'non_deal'),
         (a, 'unknown', 'hash', 'unrouted', gen_random_uuid(), w - 1, null);
  update routing_ledger set sent_recipient = 'deal_contact' where source_id = a and provider_item_id = 'ordinary';
  perform send_census_refresh(t, 8);
  if (select native <> 3 or deal_contact <> 1 or non_deal <> 1 or deal_sensitive is not null
        from send_census_weekly where source_id = a and week = w - 7) then
    raise exception 'recipient split or frozen classification incorrect';
  end if;
end;
$$;
-- Phase 3 contact sources: named contacts survive deal closure, domains do not.
do $$
declare
  t uuid := gen_random_uuid();
  foreign_t uuid := gen_random_uuid();
  bank uuid := gen_random_uuid();
  buyer uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  banker uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  foreign_member uuid := gen_random_uuid();
  active_deal uuid := gen_random_uuid();
  intake_deal uuid := gen_random_uuid();
  paused_deal uuid := gen_random_uuid();
  closed_deal uuid := gen_random_uuid();
  foreign_deal uuid := gen_random_uuid();
  pending uuid := gen_random_uuid();
  accepted uuid := gen_random_uuid();
  revoked uuid := gen_random_uuid();
  r uuid;
begin
  insert into companies (id, tenant_id, name, type) values
    (bank, t, 'Census Bank', 'bank'), (buyer, t, 'Census Buyer', 'acquirer'),
    (outsider, foreign_t, 'Other Tenant Buyer', 'acquirer');
  insert into auth.users (id, email, raw_user_meta_data) values
    (banker, 'census-banker@bank.example', jsonb_build_object('tenant_id', t)),
    (member, 'census-member@buyer.example', jsonb_build_object('tenant_id', t)),
    (foreign_member, 'census-foreign@other.example', jsonb_build_object('tenant_id', foreign_t));
  update users set company_id = bank, company_role = 'director', tenant_id = t where id = banker;
  update users set company_id = buyer, company_role = 'director', tenant_id = t where id = member;
  update users set company_id = outsider, company_role = 'director', tenant_id = foreign_t where id = foreign_member;
  insert into deals (id, tenant_id, bank_id, code, codename, status) values
    (active_deal, t, bank, active_deal::text, 'Live buyer', 'active'),
    (intake_deal, t, bank, intake_deal::text, 'Intake buyer', 'intake'),
    (paused_deal, t, bank, paused_deal::text, 'Paused buyer', 'paused'),
    (closed_deal, t, bank, closed_deal::text, 'Closed buyer', 'closed'),
    (foreign_deal, foreign_t, outsider, foreign_deal::text, 'Foreign deal', 'active');
  insert into deal_parties (deal_id, company_id, party_role) values
    (active_deal, buyer, 'acquirer_shortlist'), (intake_deal, buyer, 'acquirer_shortlist'),
    (paused_deal, buyer, 'acquirer_shortlist'), (closed_deal, buyer, 'acquirer_shortlist'),
    (foreign_deal, outsider, 'acquirer_shortlist');
  select id into r from roles where slug = 'buyer';
  insert into deal_memberships (deal_id, user_id, role_id, deal_role) values
    (active_deal, member, r, 'buyer'), (active_deal, banker, r, 'buyer'),
    (closed_deal, member, r, 'buyer'), (foreign_deal, foreign_member, r, 'buyer');
  insert into company_verified_domains (tenant_id, company_id, domain, source) values
    (t, buyer, 'buyer.example', 'test'), (foreign_t, outsider, 'other.example', 'test');
  insert into invites (id, tenant_id, email, invited_by, company_id, company_role, deal_id, deal_role, status)
  values (pending, t, 'pending@buyer.example', banker, buyer, 'member', closed_deal, 'buyer', 'pending'),
         (accepted, t, 'accepted@buyer.example', banker, buyer, 'member', closed_deal, 'buyer', 'accepted'),
         (revoked, t, 'revoked@buyer.example', banker, buyer, 'member', closed_deal, 'buyer', 'revoked');
  insert into deal_recipient_affiliations
    (tenant_id, deal_id, normalized_email, company_id, affiliation, user_id, created_by, updated_by)
  values (t, closed_deal, 'census-member@buyer.example', buyer, 'counterparty', member, banker, banker);
  if not exists (select 1 from send_census_deal_contacts(t) where kind = 'address' and value = 'census-member@buyer.example')
     or not exists (select 1 from send_census_deal_contacts(t) where kind = 'address' and value = 'pending@buyer.example')
     or exists (select 1 from send_census_deal_contacts(t) where kind = 'address'
                   and value in ('census-banker@bank.example', 'accepted@buyer.example', 'revoked@buyer.example', 'census-foreign@other.example'))
     or not exists (select 1 from send_census_deal_contacts(t) where kind = 'domain' and value = 'buyer.example')
     or exists (select 1 from send_census_deal_contacts(t) where kind = 'domain' and value = 'other.example') then
    raise exception 'deal contact source or tenant filter incorrect';
  end if;
  delete from deal_parties where deal_id in (active_deal, intake_deal) and company_id = buyer;
  if exists (select 1 from send_census_deal_contacts(t) where kind = 'domain' and value = 'buyer.example')
     or not exists (select 1 from send_census_deal_contacts(t) where kind = 'address' and value = 'census-member@buyer.example') then
    raise exception 'paused and closed deal contact rules incorrect';
  end if;
  insert into deal_parties (deal_id, company_id, party_role) values (active_deal, buyer, 'acquirer_shortlist');
  if not exists (select 1 from send_census_deal_contacts(t) where kind = 'domain' and value = 'buyer.example') then
    raise exception 'active party domain not restored';
  end if;
  update deals set status = 'closed' where id = active_deal;
  if exists (select 1 from send_census_deal_contacts(t) where kind = 'domain' and value = 'buyer.example') then
    raise exception 'closed deal retained its party domain';
  end if;
  -- The trigger normally forces the company's tenant. Bypass it within the rollback to probe defence in depth.
  alter table company_verified_domains disable trigger prepare_company_verified_domain_row;
  insert into company_verified_domains (tenant_id, company_id, domain, source)
  values (foreign_t, buyer, 'wrongtenant.example', 'test');
  alter table company_verified_domains enable trigger prepare_company_verified_domain_row;
  insert into deal_parties (deal_id, company_id, party_role) values (intake_deal, buyer, 'acquirer_shortlist');
  alter table company_verified_domains drop constraint company_verified_domains_domain_check;
  insert into company_verified_domains (tenant_id, company_id, domain, source) values (t, buyer, 'gmail.com', 'test');
  if exists (select 1 from send_census_deal_contacts(t) where kind = 'domain'
                    and value in ('wrongtenant.example', 'gmail.com'))
     or not exists (select 1 from send_census_deal_contacts(t) where kind = 'domain' and value = 'buyer.example') then
    raise exception 'verified domain tenant or freemail filter incorrect';
  end if;
end;
$$;
-- Martin's review (points 1, 2): a send first ledgered without a recipient class (a failed contact lookup) gains one
-- later, by a plain update or by the policy-skip writer; the send time and a known class still never change.
do $$
declare
  t uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  w date := date_trunc('week', now() at time zone 'utc')::date;
  r routing_ledger%rowtype;
begin
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, backfill_completed_at, last_synced_at)
  values (a, t, 'mailbox', 'google', 'nullrecipient@example.test', now(), now());
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, run_id, sent_at, sent_recipient)
  values (a, 'plain', 'hash', 'unrouted', gen_random_uuid(), w - interval '2 days', null),
         (a, 'skip', 'hash', 'unrouted', gen_random_uuid(), w - interval '2 days', null);
  update routing_ledger set sent_at = w - interval '9 days', sent_recipient = 'deal_contact'
   where source_id = a and provider_item_id = 'plain';
  select * into r from routing_ledger where source_id = a and provider_item_id = 'plain';
  if r.sent_at is distinct from w - interval '2 days' or r.sent_recipient is distinct from 'deal_contact' then
    raise exception 'null recipient: update did not fill the class or moved the send time';
  end if;
  update routing_ledger set sent_recipient = 'non_deal' where source_id = a and provider_item_id = 'plain';
  if (select sent_recipient from routing_ledger where source_id = a and provider_item_id = 'plain') is distinct from 'deal_contact' then
    raise exception 'null recipient: a known class was overwritten';
  end if;
  update routing_ledger set sent_recipient = null where source_id = a and provider_item_id = 'plain';
  if (select sent_recipient from routing_ledger where source_id = a and provider_item_id = 'plain') is distinct from 'deal_contact' then
    raise exception 'null recipient: a known class was cleared';
  end if;
  perform discovery_ledger_record_policy_skips(jsonb_build_array(jsonb_build_object(
    'source_id', a, 'provider_item_id', 'skip', 'item_hash', 'other-hash', 'skip_reason', 'policy_excluded',
    'provider_thread_id', 'thread', 'policy_version', 1, 'exclusion_rule', 'rule', 'run_id', gen_random_uuid(),
    'sent_at', w - interval '9 days', 'sent_recipient', 'non_deal')));
  select * into r from routing_ledger where source_id = a and provider_item_id = 'skip';
  if r.decision <> 'unrouted' or r.item_hash <> 'hash' or r.sent_at is distinct from w - interval '2 days'
     or r.sent_recipient is distinct from 'non_deal' then
    raise exception 'null recipient: the policy-skip writer did not fill the class alone';
  end if;
end;
$$;
-- Martin's review (point 3): of the sender's mailboxes active when a relay send left, one whose census covers the
-- week takes it, so the week's native and platform sit on one row.
do $$
declare
  t uuid := gen_random_uuid();
  x uuid := gen_random_uuid();
  uncovered uuid := gen_random_uuid();
  covered uuid := gen_random_uuid();
  w timestamptz := date_trunc('week', now() at time zone 'utc') at time zone 'utc';
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (x, 'census-grid@example.test', jsonb_build_object('tenant_id', t));
  insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group)
  values (t, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example');
  insert into content_sources (id, tenant_id, kind, provider, address, owner_user_id, created_at,
                               backfill_completed_at, last_synced_at, send_census_from)
  values
    (uncovered, t, 'mailbox', 'google', 'census-grid-old@example.test', x, w - interval '10 weeks', null, null, null),
    (covered, t, 'mailbox', 'google', 'census-grid-new@example.test', x, w - interval '3 weeks', w, w, null);
  perform pg_temp.relay(t, x, w - interval '4 days', null);
  perform send_census_refresh(t, 8);
  if exists (select 1 from send_census_weekly where source_id = uncovered)
     or (select platform from send_census_weekly where source_id = covered and week = (w - interval '1 week')::date) <> 1 then
    raise exception 'relay attribution skipped the mailbox whose census covers the week';
  end if;
end;
$$;
rollback;
