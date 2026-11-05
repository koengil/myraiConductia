-- AI budget alerts (plan v5 W4, "keep AI costs under control, set up alerts"; D83).
--
-- One monthly USD limit per banker, set by the firm's CCO or admin. When a
-- banker's recorded spend this calendar month (UTC) crosses 80% and then 100%
-- of it, the banker and the firm's own CCOs and admins get one bell
-- notification each. Alerts only: nothing is refused at the limit.
--
-- ai_budget_check() runs after every ledger write (src/lib/ai/usage.ts). The
-- alert row's primary key is what makes a threshold fire once per banker per
-- month, even when two AI calls land at the same moment.

create table if not exists ai_budgets (
  tenant_id          uuid primary key,
  monthly_limit_usd  numeric(12,2) not null check (monthly_limit_usd > 0),
  updated_by         uuid not null references users (id),
  updated_at         timestamptz not null default now()
);

alter table ai_budgets enable row level security;
-- No policy: closed to anon and authenticated, grants included (TRUNCATE ignores RLS).
revoke all on table ai_budgets from public, anon, authenticated;
grant select, insert, update, delete on ai_budgets to service_role;

create table if not exists ai_budget_alerts (
  tenant_id   uuid not null,
  actor_id    uuid not null references users (id),
  -- First day of the UTC month the alert belongs to.
  period      date not null,
  threshold   smallint not null check (threshold in (80, 100)),
  created_at  timestamptz not null default now(),
  -- tenant_id is in the key because the spend sum is per (tenant, banker).
  primary key (tenant_id, actor_id, period, threshold)
);

alter table ai_budget_alerts enable row level security;
revoke all on table ai_budget_alerts from public, anon, authenticated;
grant select, insert, update, delete on ai_budget_alerts to service_role;

-- The month-to-date sum reads one banker's rows from the start of the month.
-- Built without CONCURRENTLY (a SHARE lock blocks ledger writes while it
-- builds); fine at the ledger's current size. On a large ledger, run it by
-- hand as `create index concurrently` outside a transaction first.
create index if not exists ai_usage_actor_idx on ai_usage (tenant_id, actor_id, created_at desc);

alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed',
    'access_requested','access_approved','access_denied',
    'mailbox_allowlist_drift',
    'mailbox_connected',
    'rail_template_updated',
    'ai_budget_threshold'
  ))
  not valid;

-- Compare one banker's spend this month with the firm's limit and send the
-- alerts not yet sent. Returns the thresholds newly alerted (empty when there
-- is no limit, the limit is not reached, or the alerts already went out).
create or replace function ai_budget_check(p_tenant_id uuid, p_actor_id uuid)
returns smallint[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit     numeric;
  v_period    date := date_trunc('month', now() at time zone 'utc')::date;
  v_spent     numeric;
  v_name      text;
  v_threshold smallint;
  v_inserted  int;
  v_label     text;
  v_alerted   smallint[] := '{}';
begin
  select monthly_limit_usd into v_limit from ai_budgets where tenant_id = p_tenant_id;
  if v_limit is null then
    return v_alerted;
  end if;

  select coalesce(sum(cost_usd), 0) into v_spent
  from ai_usage
  where tenant_id = p_tenant_id
    and actor_id = p_actor_id
    and created_at >= (v_period::timestamp at time zone 'utc');

  select coalesce(nullif(trim(display_name), ''), nullif(trim(full_name), ''), email)
    into v_name
  from users where id = p_actor_id;

  foreach v_threshold in array array[80, 100]::smallint[] loop
    continue when v_spent < v_limit * v_threshold / 100;

    insert into ai_budget_alerts (tenant_id, actor_id, period, threshold)
    values (p_tenant_id, p_actor_id, v_period, v_threshold)
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    continue when v_inserted = 0;

    v_label := format('%s%% of the $%s monthly AI budget, $%s spent this month',
                      v_threshold,
                      to_char(v_limit, 'FM999,999,990.00'),
                      to_char(v_spent, 'FM999,999,990.00'));

    -- The banker, about their own spend.
    insert into notifications (tenant_id, recipient_id, event_type, payload)
    values (p_tenant_id, p_actor_id, 'ai_budget_threshold',
            jsonb_build_object('destinationLabel', v_label, 'threshold', v_threshold,
                               'spentUsd', v_spent, 'limitUsd', v_limit, 'period', v_period));

    -- The firm's CCOs and admins: the same people the AI Costs page answers
    -- (firmMailAccess), internal and active in this tenant, one tenant per
    -- firm. Not firm_company_ids(): that lists only firms with a mail reader
    -- registered, so a firm without one would never hear. The banker's name
    -- leads the line, where the bell's truncation cannot cut it.
    insert into notifications (tenant_id, recipient_id, event_type, payload)
    select p_tenant_id, u.id, 'ai_budget_threshold',
           jsonb_build_object('destinationLabel', coalesce(v_name, 'A banker') || ': ' || v_label,
                              'href', '/ai-costs', 'threshold', v_threshold, 'spentUsd', v_spent,
                              'limitUsd', v_limit, 'period', v_period, 'actorId', p_actor_id)
    from users u
    where u.tenant_id = p_tenant_id and u.status = 'active' and u.firm_role in ('admin', 'cco')
      and u.is_external = false
      and u.id <> p_actor_id;

    v_alerted := v_alerted || v_threshold;
  end loop;

  return v_alerted;
end;
$$;

revoke all on function ai_budget_check(uuid, uuid) from public, anon, authenticated;
grant execute on function ai_budget_check(uuid, uuid) to service_role;
