-- supabase/tests/notifications.sql
-- Verifies the G3 notifications spine (Issue #69). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/notifications.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.

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

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-000000000004';
  v_company   uuid := gen_random_uuid();
  v_cco       uuid := gen_random_uuid();
  v_other     uuid := gen_random_uuid();
  v_deal      uuid := gen_random_uuid();
  v_note      uuid := gen_random_uuid();
  v_cnt       int;
  v_blocked   boolean;
begin
  -- Throwaway recipients: mirror into public.users via the auth trigger.
  insert into auth.users (id, email) values (v_cco,   'g3-cco@example.com');
  insert into auth.users (id, email) values (v_other, 'g3-other@example.com');

  insert into companies (id, tenant_id, name, type)
    values (v_company, v_tenant, 'G3 Test Bank', 'bank');
  insert into deals (id, tenant_id, code, codename, bank_id)
    values (v_deal, v_tenant, 'G3-TEST-001', 'Project Kestrel', v_company);

  -- A deal_created notification for the CCO. COMPLIANCE: payload carries code +
  -- code name, never the target company name.
  insert into notifications (id, tenant_id, deal_id, recipient_id, event_type, payload)
    values (v_note, v_tenant, v_deal, v_cco, 'deal_created',
            jsonb_build_object('code', 'G3-TEST-001', 'codename', 'Project Kestrel',
                               'actor', 'Storm Duncan'));

  -- The row exists and is unread.
  select count(*) into v_cnt from notifications
    where recipient_id = v_cco and read_at is null;
  if v_cnt <> 1 then
    raise exception 'FAIL: expected 1 unread notification for the CCO, found %', v_cnt;
  end if;

  -- An invalid event_type must be rejected by the CHECK.
  v_blocked := false;
  begin
    insert into notifications (tenant_id, deal_id, recipient_id, event_type)
      values (v_tenant, v_deal, v_cco, 'not_a_real_event');
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: invalid event_type was not rejected by the CHECK';
  end if;

  -- RLS: recipient sees only their own rows. Exercise the policy as each user.
  -- (service_role bypasses RLS, so switch to the authenticated role + set the JWT
  --  claim the policy reads via auth.uid().)
  set local role authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub', v_cco, 'session_id', v_cco)::text, true);
  select count(*) into v_cnt from notifications;
  if v_cnt <> 1 then
    raise exception 'FAIL: CCO should see exactly their 1 notification under RLS, saw %', v_cnt;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'session_id', v_other)::text, true);
  select count(*) into v_cnt from notifications;
  if v_cnt <> 0 then
    raise exception 'FAIL: a non-recipient must see 0 notifications under RLS, saw %', v_cnt;
  end if;

  reset role;
  raise notice 'PASS: notifications insert + unread index, event_type CHECK, RLS recipient-only visibility';
end $$;

rollback;
