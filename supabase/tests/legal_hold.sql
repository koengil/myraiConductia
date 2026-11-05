-- supabase/tests/legal_hold.sql
-- Verifies per-deal legal hold (Issue #50). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/legal_hold.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.
-- Raises (and, with ON_ERROR_STOP, exits non-zero) if any guarantee is violated.

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
  v_tenant  uuid := '00000000-0000-4000-8000-000000000001';
  v_actor   uuid := gen_random_uuid();
  v_company uuid := gen_random_uuid();
  v_deal    uuid := gen_random_uuid();
  v_doc     uuid := gen_random_uuid();
  v_hold    uuid;
  v_blocked boolean;
  v_cnt     int;
begin
  -- Throwaway actor: insert into auth.users; on_auth_user_created mirrors it into
  -- public.users (Option A). Email satisfies the mirrored NOT NULL columns.
  insert into auth.users (id, email) values (v_actor, 's04-legal-hold-test@example.com');

  -- Throwaway company (deals.bank_id FK), deal, and document.
  insert into companies (id, tenant_id, name, type)
    values (v_company, v_tenant, 'S0.4 Test Bank', 'bank');
  insert into deals (id, tenant_id, code, codename, bank_id)
    values (v_deal, v_tenant, 'S04-TEST-001', 'Project S04 Test', v_company);
  insert into documents (id, deal_id, name, room, classification, min_phase, uploaded_by)
    values (v_doc, v_deal, 's04-test.pdf', 'internal', 1, 0, v_actor);

  -- Place a hold.
  v_hold := place_legal_hold(v_deal, v_actor, 'regulatory inquiry');

  -- An active hold row exists.
  select count(*) into v_cnt from legal_holds where deal_id = v_deal and lifted_at is null;
  if v_cnt <> 1 then
    raise exception 'FAIL: expected exactly 1 active hold, found %', v_cnt;
  end if;

  -- place wrote a hold_placed audit row.
  select count(*) into v_cnt from audit_log
    where deal_id = v_deal and action = 'hold_placed';
  if v_cnt <> 1 then
    raise exception 'FAIL: expected 1 hold_placed audit row, found %', v_cnt;
  end if;

  -- A second place on the same deal must be blocked (one active hold per deal).
  v_blocked := false;
  begin
    perform place_legal_hold(v_deal, v_actor, 'second attempt');
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: second active hold on the same deal was not blocked';
  end if;

  -- DELETE of the document must be blocked while under hold.
  v_blocked := false;
  begin
    delete from documents where id = v_doc;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: document delete under hold was not blocked';
  end if;

  -- DELETE of the deal must be blocked while under hold (also kills the cascade).
  v_blocked := false;
  begin
    delete from deals where id = v_deal;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: deal delete under hold was not blocked';
  end if;

  -- Lift the hold.
  perform lift_legal_hold(v_deal, v_actor);

  -- lifted_at is stamped and a hold_lifted audit row exists.
  select count(*) into v_cnt from legal_holds where deal_id = v_deal and lifted_at is not null;
  if v_cnt <> 1 then
    raise exception 'FAIL: expected the hold to be lifted, found % lifted rows', v_cnt;
  end if;
  select count(*) into v_cnt from audit_log where deal_id = v_deal and action = 'hold_lifted';
  if v_cnt <> 1 then
    raise exception 'FAIL: expected 1 hold_lifted audit row, found %', v_cnt;
  end if;

  -- Protection is released.
  if deal_is_under_hold(v_deal) then
    raise exception 'FAIL: deal still under hold after lift';
  end if;

  raise notice 'PASS: legal hold blocks deal/document delete, audits place/lift, enforces one active hold, releases on lift';
end $$;

-- Review of #230: legal_holds has RLS on and its functions are service-role
-- only. Table grants are asserted by definer_grants.sql.
do $$
declare
  v_role     text;
  v_function text;
begin
  if not (select relrowsecurity from pg_class where oid = 'legal_holds'::regclass) then
    raise exception 'FAIL: legal_holds must enable row level security';
  end if;

  foreach v_role in array array['anon', 'authenticated']
  loop
    foreach v_function in array array[
      'place_legal_hold(uuid, uuid, text)',
      'lift_legal_hold(uuid, uuid)',
      'deal_is_under_hold(uuid)'
    ]
    loop
      if has_function_privilege(v_role, v_function, 'execute') then
        raise exception 'FAIL: % must not execute %', v_role, v_function;
      end if;
    end loop;
  end loop;

  raise notice 'PASS: legal_holds has RLS on and its functions are not executable by anon or authenticated';
end $$;

rollback;
