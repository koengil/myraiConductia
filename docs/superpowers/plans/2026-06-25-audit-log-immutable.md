# Audit Log Immutability (S0.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the business `audit_log` table physically append-only so records cannot be silently altered (SEC 17a-4).

**Architecture:** One idempotent SQL migration revokes `UPDATE`/`DELETE` from `service_role` and adds trigger guards that raise on any `UPDATE`/`DELETE`/`TRUNCATE`. A separate, rolled-back SQL verification script proves the guarantee. Empirical proof runs on a throwaway Supabase dev branch (never the live project). No application code changes; CI (mocked vitest) is unaffected.

**Tech Stack:** PostgreSQL (Supabase), plpgsql triggers, psql, Supabase MCP (branch + execute_sql).

## Global Constraints

- GitHub issue: #49 (Epic #46, Step 0 — Pour the floor). Assignee: mgumiero9.
- Scope is `UPDATE`/`DELETE` immutability only. Widening the `action` CHECK enum (`view|download|upload|export|grant|revoke`) to handbook verbs is OUT OF SCOPE — flag in the PR if Step 1 needs new verbs.
- Per D34, feature-flag changes are deliberately NOT audited; this targets the business `audit_log` spine only.
- Migrations are idempotent (re-runnable): `revoke` is a no-op if already revoked; `create or replace`; `drop trigger if exists` before `create trigger`.
- Migration filenames are `YYYYMMDDHHMMSS_name.sql` in `supabase/migrations/`, applied in filename order by `scripts/migrate.sh` (psql against `DATABASE_URL`). Latest existing: `20260612160000`.
- Brand/process: Co-Authored-By trailer kept on commits. Do NOT commit, push, or open a PR until the user explicitly approves (standing user constraint) — implement and verify first, then present.
- Verification touches a Supabase **dev branch only**. Never apply to the live `supabase` MCP project directly.

## Execution note (2026-06-25)

The planned throwaway dev-branch proof was infeasible (this Supabase MCP server exposes
no `confirm_cost`, so `create_branch` can't run; no branch existed). Since `execute_sql`/
`apply_migration` connect directly to the intelibank project, we ran the proof against
that (shared dev) Supabase with the user's approval — RED→GREEN, empirically:

- **RED (pre-migration):** `verify.sql`'s checks in a rolled-back transaction failed with
  `service_role still has UPDATE on audit_log` — confirming the table was mutable, and
  validating the script (the auth→users mirror + audit insert succeeded before the assertion).
- **Applied** the migration via MCP `apply_migration` (also recorded in Supabase's own
  migration history as `audit_log_immutable`; the repo's manual `migrate.sh` flow is
  separate and the DDL is idempotent, so re-applying the committed file later is harmless).
- **GREEN (post-migration):** the full `verify.sql` completed clean — privilege check
  passed, UPDATE/DELETE blocked, all six INSERTs succeeded — throwaway rows rolled back.

`audit_log` is now append-only on the intelibank Supabase (reversible: drop the two
triggers + re-grant). All three acceptance criteria are empirically verified. The
skipped-but-wired vitest test (`tests/db/audit-log-immutability.test.ts`, `RUN_DB_TESTS=1`)
remains for a future pgTAP / Postgres-in-CI lane (Track B), since CI has no DB.

---

### Task 1: Immutability verification script (the test) + RED proof

**Files:**
- Create: `supabase/tests/audit_log_immutability.sql`

**Interfaces:**
- Consumes: existing schema — `audit_log(actor_id uuid not null → users.id, action text check (...), ...)`, `users(id → auth.users.id, tenant_id, email, full_name, ...)`, `auth.users(id)` (only `id` is required).
- Produces: a psql-runnable script that exits non-zero (via `ON_ERROR_STOP`) if any immutability guarantee is violated, and leaves no data behind (wrapped in `begin … rollback`).

- [ ] **Step 1: Write the verification script**

```sql
-- supabase/tests/audit_log_immutability.sql
-- Verifies audit_log is append-only (Issue #49). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/audit_log_immutability.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.
-- Raises (and, with ON_ERROR_STOP, exits non-zero) if any guarantee is violated.

begin;

do $$
declare
  v_user    uuid := gen_random_uuid();
  v_audit   uuid;
  v_blocked boolean;
begin
  -- Throwaway actor: audit_log.actor_id -> users.id -> auth.users.id
  insert into auth.users (id) values (v_user);
  insert into public.users (id, tenant_id, email, full_name)
    values (v_user, gen_random_uuid(), 's03-immutability-test@example.com', 'S0.3 Test');

  -- INSERT must still work (sentinel row)
  insert into audit_log (actor_id, action) values (v_user, 'view') returning id into v_audit;

  -- service_role must no longer hold UPDATE/DELETE (the grant half of AC1)
  if has_table_privilege('service_role', 'public.audit_log', 'UPDATE') then
    raise exception 'FAIL: service_role still has UPDATE on audit_log';
  end if;
  if has_table_privilege('service_role', 'public.audit_log', 'DELETE') then
    raise exception 'FAIL: service_role still has DELETE on audit_log';
  end if;

  -- UPDATE must be blocked by the trigger (the trigger half of AC1)
  v_blocked := false;
  begin
    update audit_log set action = 'download' where id = v_audit;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: UPDATE on audit_log was not blocked';
  end if;

  -- DELETE must be blocked by the trigger
  v_blocked := false;
  begin
    delete from audit_log where id = v_audit;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: DELETE on audit_log was not blocked';
  end if;

  -- INSERT must still work for every current action value (AC2)
  insert into audit_log (actor_id, action) values
    (v_user, 'view'), (v_user, 'download'), (v_user, 'upload'),
    (v_user, 'export'), (v_user, 'grant'), (v_user, 'revoke');

  raise notice 'PASS: audit_log is append-only (service_role UPDATE/DELETE revoked, trigger blocks UPDATE/DELETE, INSERT ok)';
end $$;

rollback;
```

- [ ] **Step 2: Create a Supabase dev branch (throwaway) for empirical proof**

Use the Supabase MCP (`supabase` server = intelibank). First `confirm_cost` (branch), then `create_branch` with `name: "s03-audit-immutable"`. Capture the branch `project_ref`. The branch applies all migrations from main but carries NO data — so the verify script's throwaway-user setup is required.

- [ ] **Step 3: Run the script on the branch BEFORE the migration → expect RED**

Run the script body (the `do $$ … $$;` block) on the branch via MCP `execute_sql`.
Expected: FAIL — `UPDATE on audit_log was not blocked` (current schema is mutable). This proves the test detects the gap.

---

### Task 2: The immutability migration + GREEN proof

**Files:**
- Create: `supabase/migrations/20260625120000_audit_log_immutable.sql`

**Interfaces:**
- Consumes: `audit_log` table + the `service_role` grant from `20260604100000_permissions_schema.sql:235`.
- Produces: revoked `UPDATE`/`DELETE` on `audit_log` for `service_role`; function `audit_log_block_mutation()`; triggers `audit_log_no_update_delete` (row, before update/delete) and `audit_log_no_truncate` (statement, before truncate).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260625120000_audit_log_immutable.sql
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
```

- [ ] **Step 2: Apply the migration to the dev branch**

Apply via MCP `apply_migration` (name: `audit_log_immutable`, query = the file body) against the `s03-audit-immutable` branch `project_ref`.

- [ ] **Step 3: Re-run the verification on the branch → expect GREEN**

Run the `do $$ … $$;` block again via MCP `execute_sql` on the branch.
Expected: PASS notice — `audit_log is append-only (...)`, no exception. This is the empirical proof for AC1 + AC2 + AC3.

- [ ] **Step 4: Confirm app-side suite still green**

Run: `npm test`
Expected: PASS (no DB; mocked vitest is unaffected by the migration).

---

### Task 3: Wrap-up (held for user approval)

**Files:** none (git + GitHub actions only).

- [ ] **Step 1: Present results to the user**

Show: the two files, the RED-then-GREEN branch output, and `npm test` result. Do NOT commit/push/PR yet.

- [ ] **Step 2: On user approval — branch, commit, PR**

```bash
git checkout -b marcelo/s0.3-audit-immutable develop
git add supabase/migrations/20260625120000_audit_log_immutable.sql supabase/tests/audit_log_immutability.sql docs/superpowers/plans/2026-06-25-audit-log-immutable.md
git commit -m "feat(db): make audit_log physically append-only (S0.3, #49)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin marcelo/s0.3-audit-immutable
```

Then open a PR into `develop` (closes #49). PR body flags the out-of-scope `action` enum note.

- [ ] **Step 3: Delete the dev branch**

Delete the `s03-audit-immutable` Supabase branch via MCP `delete_branch` to avoid lingering cost.

---

## Self-Review

- **Spec coverage:** AC1 (UPDATE/DELETE rejected at DB) → Task 2 (revoke + triggers), proven Task 1/2 (catalog assert + behavioral). AC2 (existing inserts still pass) → verify script inserts all 6 actions + `npm test`. AC3 (test demonstrates immutability) → `supabase/tests/audit_log_immutability.sql` + branch RED→GREEN. Scope guard (enum) → noted in Global Constraints + PR. ✓
- **Placeholder scan:** none — full SQL in every step. ✓
- **Type consistency:** trigger names (`audit_log_no_update_delete`, `audit_log_no_truncate`) and function (`audit_log_block_mutation`) match between migration and prose. Action values match `src/lib/constants/audit.ts`. ✓
