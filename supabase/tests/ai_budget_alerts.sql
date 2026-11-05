-- supabase/tests/ai_budget_alerts.sql
-- Verifies the monthly AI budget alerts (D83, 20261009180000_ai_budget_alerts.sql).
-- Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ai_budget_alerts.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.
--
-- The tenant registers no mail reader on purpose: the CCO and admins must be
-- alerted whether or not the firm has connected a mailbox.

begin;
create or replace function pg_temp.authorize_fixture() returns trigger language plpgsql as $fx$
begin
  perform public.authorize_provisioned_profile(new.id, new.raw_user_meta_data);
  return new;
end
$fx$;
drop trigger if exists zz_authorize_fixture on auth.users;
create trigger zz_authorize_fixture after insert on auth.users
  for each row execute function pg_temp.authorize_fixture();

do $$
declare
  v_tenant     uuid := '00000000-0000-4000-8000-0000000000d8';
  v_elsewhere  uuid := '00000000-0000-4000-8000-0000000000d9';
  v_banker     uuid := gen_random_uuid();
  v_banker2    uuid := gen_random_uuid();
  v_banker3    uuid := gen_random_uuid();
  v_cco        uuid := gen_random_uuid();
  v_admin      uuid := gen_random_uuid();
  v_suspended  uuid := gen_random_uuid();
  v_external   uuid := gen_random_uuid();
  v_other_cco  uuid := gen_random_uuid();
  v_month      timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_got        smallint[];
  v_cnt        int;
  v_label      text;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_banker,    'd83-banker@example.com',    jsonb_build_object('full_name','Bea Banker','department','ib','tenant_id',v_tenant)),
    (v_banker2,   'd83-banker2@example.com',   jsonb_build_object('full_name','Ben Banker','department','ib','tenant_id',v_tenant)),
    (v_banker3,   'd83-banker3@example.com',   jsonb_build_object('full_name','Bo Banker','department','ib','tenant_id',v_tenant)),
    (v_cco,       'd83-cco@example.com',       jsonb_build_object('full_name','Cora Vance','firm_role','cco','department','compliance','tenant_id',v_tenant)),
    (v_admin,     'd83-admin@example.com',     jsonb_build_object('full_name','Ada Admin','firm_role','admin','tenant_id',v_tenant)),
    (v_suspended, 'd83-suspended@example.com', jsonb_build_object('full_name','Sue Spended','firm_role','cco','tenant_id',v_tenant)),
    (v_external,  'd83-external@example.com',  jsonb_build_object('full_name','Ed External','firm_role','admin','tenant_id',v_tenant)),
    (v_other_cco, 'd83-other@example.com',     jsonb_build_object('full_name','Otto Other','firm_role','cco','tenant_id',v_elsewhere));
  update users set status = 'active', is_external = false
    where id in (v_banker, v_banker2, v_banker3, v_cco, v_admin, v_external, v_other_cco);
  update users set status = 'suspended', is_external = false where id = v_suspended;
  update users set is_external = true where id = v_external;

  -- No budget: nothing to compare against.
  insert into ai_usage (tenant_id, actor_id, source, task, cost_usd, external_id)
    values (v_tenant, v_banker, 'screen', 'mail_screen', 90, gen_random_uuid()::text);
  v_got := ai_budget_check(v_tenant, v_banker);
  if v_got <> '{}' then raise exception 'FAIL: no budget alerted %', v_got; end if;

  insert into ai_budgets (tenant_id, monthly_limit_usd, updated_by) values (v_tenant, 100, v_cco);

  -- 90% of 100: the 80% alert, to the banker, the CCO and the admin only.
  v_got := ai_budget_check(v_tenant, v_banker);
  if v_got <> '{80}' then raise exception 'FAIL: at 90%% expected {80}, got %', v_got; end if;
  select count(*) into v_cnt from notifications where event_type = 'ai_budget_threshold';
  if v_cnt <> 3 then raise exception 'FAIL: expected 3 notifications, found %', v_cnt; end if;
  if exists (select 1 from notifications where event_type = 'ai_budget_threshold'
               and recipient_id in (v_suspended, v_external, v_other_cco)) then
    raise exception 'FAIL: a suspended, external or other-tenant overseer was notified';
  end if;
  select payload->>'destinationLabel' into v_label from notifications
    where event_type = 'ai_budget_threshold' and recipient_id = v_cco;
  if v_label <> 'Bea Banker: 80% of the $100.00 monthly AI budget, $90.00 spent this month' then
    raise exception 'FAIL: overseer label was %', v_label;
  end if;
  select payload->>'destinationLabel' into v_label from notifications
    where event_type = 'ai_budget_threshold' and recipient_id = v_banker;
  if v_label <> '80% of the $100.00 monthly AI budget, $90.00 spent this month' then
    raise exception 'FAIL: banker label was %', v_label;
  end if;

  -- Once per threshold per month.
  v_got := ai_budget_check(v_tenant, v_banker);
  if v_got <> '{}' then raise exception 'FAIL: repeated check alerted %', v_got; end if;

  -- Past the limit: the 100% alert.
  insert into ai_usage (tenant_id, actor_id, source, task, cost_usd, external_id)
    values (v_tenant, v_banker, 'screen', 'mail_screen', 15.5, gen_random_uuid()::text);
  v_got := ai_budget_check(v_tenant, v_banker);
  if v_got <> '{100}' then raise exception 'FAIL: at 105.5%% expected {100}, got %', v_got; end if;

  -- Last month's spend does not count.
  insert into ai_usage (tenant_id, actor_id, source, task, cost_usd, external_id, created_at)
    values (v_tenant, v_banker2, 'screen', 'mail_screen', 500, gen_random_uuid()::text, v_month - interval '1 second'),
           (v_tenant, v_banker2, 'screen', 'mail_screen', 10, gen_random_uuid()::text, v_month);
  v_got := ai_budget_check(v_tenant, v_banker2);
  if v_got <> '{}' then raise exception 'FAIL: last month counted, got %', v_got; end if;

  -- One jump past both thresholds alerts both.
  insert into ai_usage (tenant_id, actor_id, source, task, cost_usd, external_id)
    values (v_tenant, v_banker3, 'screen', 'mail_screen', 150, gen_random_uuid()::text);
  v_got := ai_budget_check(v_tenant, v_banker3);
  if v_got <> '{80,100}' then raise exception 'FAIL: one jump expected {80,100}, got %', v_got; end if;

  -- An overseer over their own budget hears once, not twice.
  insert into ai_usage (tenant_id, actor_id, source, task, cost_usd, external_id)
    values (v_tenant, v_cco, 'screen', 'mail_screen', 81, gen_random_uuid()::text);
  v_got := ai_budget_check(v_tenant, v_cco);
  if v_got <> '{80}' then raise exception 'FAIL: CCO spend expected {80}, got %', v_got; end if;
  select count(*) into v_cnt from notifications
    where event_type = 'ai_budget_threshold' and recipient_id = v_cco and (payload->>'actorId') is null
      and payload->>'threshold' = '80';
  if v_cnt <> 1 then raise exception 'FAIL: CCO self alert count %', v_cnt; end if;
  select count(*) into v_cnt from notifications
    where event_type = 'ai_budget_threshold' and (payload->>'actorId') = v_cco::text;
  if v_cnt <> 1 then raise exception 'FAIL: expected only the admin to hear about the CCO, found %', v_cnt; end if;

  -- The CHECKs: a limit must be positive, a threshold 80 or 100.
  begin
    insert into ai_budgets (tenant_id, monthly_limit_usd, updated_by) values (v_elsewhere, 0, v_other_cco);
    raise exception 'FAIL: a zero limit was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into ai_budget_alerts (tenant_id, actor_id, period, threshold) values (v_tenant, v_banker, v_month::date, 50);
    raise exception 'FAIL: a 50%% threshold was accepted';
  exception when check_violation then null;
  end;

  -- Closed to the publishable key and to signed-in sessions.
  if has_table_privilege('anon', 'public.ai_budgets', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('authenticated', 'public.ai_budgets', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('authenticated', 'public.ai_budget_alerts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 'FAIL: budget tables granted to anon or authenticated';
  end if;
  if has_function_privilege('authenticated', 'public.ai_budget_check(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ai_budget_check(uuid, uuid)', 'EXECUTE') then
    raise exception 'FAIL: ai_budget_check executable outside service_role';
  end if;

  raise notice 'PASS: ai_budget_alerts';
end
$$;

rollback;
