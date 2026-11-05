-- S0.3 (Issue #49, Epic #46): make the business audit_log physically append-only
-- (SEC 17a-4 "permits recreation if modified"). Idempotent: safe to re-run.

-- 1. Drop mutation privileges from service_role (keep select, insert).
revoke update, delete on audit_log from service_role;

-- 2. Guard function: reject any mutation with a clear, attributable error.
create or replace function audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only (S0.3): % is not permitted', tg_op
    using errcode = 'P0001';
end;
$$;

-- 3. Row-level guard for UPDATE/DELETE.
drop trigger if exists audit_log_no_update_delete on audit_log;
create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each row execute function audit_log_block_mutation();

-- 4. Statement-level guard for TRUNCATE (TRUNCATE bypasses row triggers).
drop trigger if exists audit_log_no_truncate on audit_log;
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_log_block_mutation();
