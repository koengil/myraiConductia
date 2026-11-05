-- supabase/tests/deal_gate0_lifecycle.sql
-- Verifies the G2 Gate 0 lifecycle migration (Issue #68). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/deal_gate0_lifecycle.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.

begin;

do $$
declare
  v_tenant  uuid := '00000000-0000-4000-8000-000000000002';
  v_tenant2 uuid := '00000000-0000-4000-8000-000000000003';
  v_company uuid := gen_random_uuid();
  v_deal    uuid := gen_random_uuid();
  v_seq     int;
  v_cur     int;
  v_blocked boolean;
begin
  -- Throwaway bank company (deals.bank_id FK).
  insert into companies (id, tenant_id, name, type)
    values (v_company, v_tenant, 'G2 Test Bank', 'bank');

  -- A deal created WITHOUT the new columns defaults entry/current to 1.
  insert into deals (id, tenant_id, code, codename, bank_id)
    values (v_deal, v_tenant, 'G2-TEST-001', 'Project Falcon', v_company);

  select entry_step_seq, current_step_seq into v_seq, v_cur
    from deals where id = v_deal;
  if v_seq <> 1 or v_cur <> 1 then
    raise exception 'FAIL: expected entry/current step seq to default to 1, got %/%', v_seq, v_cur;
  end if;

  -- A second ACTIVE deal with the same code name (case-insensitive) in the same
  -- tenant must be blocked by the partial unique index.
  v_blocked := false;
  begin
    insert into deals (tenant_id, code, codename, bank_id, status)
      values (v_tenant, 'G2-TEST-002', 'project FALCON', v_company, 'active');
  exception when unique_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: duplicate live code name in the same tenant was not blocked';
  end if;

  -- The same code name IS allowed once the first deal is closed (name freed).
  update deals set status = 'closed' where id = v_deal;
  begin
    insert into deals (tenant_id, code, codename, bank_id, status)
      values (v_tenant, 'G2-TEST-003', 'Project Falcon', v_company, 'active');
  exception when others then
    raise exception 'FAIL: code name reuse after close was blocked but should be allowed';
  end;

  -- The same live code name is allowed in a DIFFERENT tenant.
  begin
    insert into companies (id, tenant_id, name, type)
      values (gen_random_uuid(), v_tenant2, 'G2 Test Bank 2', 'bank');
    insert into deals (tenant_id, code, codename, bank_id, status)
      values (v_tenant2, 'G2-TEST-004', 'Project Falcon', v_company, 'active');
  exception when others then
    raise exception 'FAIL: same live code name in a different tenant was blocked';
  end;

  raise notice 'PASS: gate0 lifecycle columns default correctly; codename unique per tenant while live, reusable once closed';
end $$;

rollback;
