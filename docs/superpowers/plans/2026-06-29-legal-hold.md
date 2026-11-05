# Legal Hold / Freeze (S0.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a deal's regulatory record lockable from purge/expiry — a per-deal legal hold that physically blocks deletion of the deal and its documents at the database level, and audits place/lift.

**Architecture:** One idempotent SQL migration adds a `legal_holds` table (active = `lifted_at IS NULL`), a `deal_is_under_hold()` helper, BEFORE DELETE/TRUNCATE trigger guards on `deals` and `documents`, and `place_legal_hold()` / `lift_legal_hold()` functions that write `audit_log` rows under two new action values. A rolled-back SQL script proves the guarantees. No app code beyond mirroring the two new audit actions in a TS constant. CI (mocked vitest) is unaffected; empirical proof runs against the dev Supabase (RED→GREEN), exactly like #49.

**Tech Stack:** PostgreSQL (Supabase), plpgsql triggers/functions, psql, Supabase MCP (`apply_migration` + `execute_sql`), Vitest.

## Global Constraints

- GitHub issue: #50 (Epic #46, Step 0 — Pour the floor). Sibling of #49. Design of record: `docs/superpowers/specs/2026-06-29-legal-hold-design.md`.
- Approach A (table + trigger guards). Covered set: the **deal row** + **documents**. `audit_log` already covered by #49; `deal_memberships` excluded (its durable trail lives in the immutable `audit_log`, D33).
- Authority to place/lift is **CCO + admin**, enforced at the app layer (ADR-0008 belt). The SQL functions are the mechanism; the role gate + REST endpoint are an OUT-OF-SCOPE follow-up.
- Audit enum extension is **required** by the AC: add exactly `hold_placed` and `hold_lifted` to `audit_log.action`, mirrored in `src/lib/constants/audit.ts`.
- Migrations are idempotent (re-runnable): `create table if not exists`, `create or replace function`, `drop trigger if exists` before `create trigger`, `drop constraint if exists` before `add constraint`, `create unique index if not exists`.
- Migration filename: `YYYYMMDDHHMMSS_name.sql` in `supabase/migrations/`, applied in filename order by `scripts/migrate.sh`. Latest existing: `20260625120000` (#49). This one: `20260629120000_legal_hold.sql`.
- Co-Authored-By trailer kept on commits: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Local commits on branch `marcelo/s0.4-legal-hold` are fine; push/PR is gated to the finishing step (user approval).
- Empirical verification runs against the intelibank dev Supabase via MCP (no `confirm_cost` → no throwaway branch, same as #49). The DDL is idempotent and reversible.

## File Structure

- `supabase/tests/legal_hold.sql` — rolled-back verification script (the test). One responsibility: prove the guarantees, leave no data.
- `supabase/migrations/20260629120000_legal_hold.sql` — the migration (table, grants, helper, guards, functions, enum extension). One responsibility: the freeze mechanism.
- `src/lib/constants/audit.ts` — add `HOLD_PLACED` / `HOLD_LIFTED` to mirror the SQL enum.
- `tests/db/legal-hold.test.ts` — skipped-but-wired vitest that runs the verify script when `RUN_DB_TESTS=1`.
- `docs/03-engineering/legal-hold-design.md` — the engineering design doc (AC deliverable).

---

### Task 1: Verification script (the test) + RED proof

**Files:**
- Create: `supabase/tests/legal_hold.sql`

**Interfaces:**
- Consumes (existing schema): `companies(id, tenant_id, name, type)`, `auth.users(id, email)` + the `on_auth_user_created` mirror trigger → `public.users`, `deals(id, tenant_id, code, codename, bank_id, status)`, `documents(id, deal_id, name, classification, min_phase, uploaded_by)`, `audit_log(actor_id, action, deal_id, detail)`.
- Consumes (from Task 2, not yet existing → this is what makes the RED meaningful): `place_legal_hold(uuid, uuid, text) → uuid`, `lift_legal_hold(uuid, uuid) → void`, `deal_is_under_hold(uuid) → boolean`, table `legal_holds`.
- Produces: a psql-runnable script that exits non-zero (via `ON_ERROR_STOP`) on any violation, wrapped in `begin … rollback`.

- [ ] **Step 1: Write the verification script**

```sql
-- supabase/tests/legal_hold.sql
-- Verifies per-deal legal hold (Issue #50). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/legal_hold.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.
-- Raises (and, with ON_ERROR_STOP, exits non-zero) if any guarantee is violated.

begin;

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
  insert into documents (id, deal_id, name, classification, min_phase, uploaded_by)
    values (v_doc, v_deal, 's04-test.pdf', 1, 0, v_actor);

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

rollback;
```

- [ ] **Step 2: Run the script BEFORE the migration → expect RED**

Run via the Supabase MCP `execute_sql` (the `do $$ … $$;` body) against the intelibank dev project, OR locally if `DATABASE_URL` is set:
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/legal_hold.sql
```
Expected: FAIL — `function place_legal_hold(uuid, uuid, text) does not exist` (and `relation "legal_holds" does not exist`). This proves the script exercises the new objects, which do not exist yet.

- [ ] **Step 3: Commit the verification script**

```bash
git add supabase/tests/legal_hold.sql
git commit -m "test(db): legal hold verification script (S0.4, #50)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: The migration + audit-action mirror + GREEN proof

**Files:**
- Create: `supabase/migrations/20260629120000_legal_hold.sql`
- Modify: `src/lib/constants/audit.ts`
- Create: `tests/db/legal-hold.test.ts`

**Interfaces:**
- Consumes: `deals`, `documents`, `audit_log`, `users`, `service_role` from `20260604100000_permissions_schema.sql`.
- Produces: table `legal_holds`; `deal_is_under_hold(uuid) → boolean`; `place_legal_hold(uuid uuid text) → uuid`; `lift_legal_hold(uuid uuid) → void`; triggers `deals_no_delete_under_hold`, `documents_no_delete_under_hold`, `deals_no_truncate_under_hold`, `documents_no_truncate_under_hold`; widened `audit_log_action_check`; TS constants `AUDIT_ACTION.HOLD_PLACED='hold_placed'`, `AUDIT_ACTION.HOLD_LIFTED='hold_lifted'`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260629120000_legal_hold.sql
-- S0.4 (Issue #50, Epic #46): per-deal legal hold / freeze. A deal under hold cannot
-- have its record purged (deal/document deletes blocked); place/lift are audited.
-- Idempotent: safe to re-run. Sibling of #49 (audit_log append-only).

-- 1. Widen the audit action enum to include hold events (required by the AC).
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in ('view','download','upload','export','grant','revoke','hold_placed','hold_lifted'));

-- 2. The hold state table. Active hold = lifted_at IS NULL.
create table if not exists legal_holds (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals (id),
  reason      text not null,
  placed_by   uuid not null references users (id),
  placed_at   timestamptz not null default now(),
  lifted_by   uuid references users (id),
  lifted_at   timestamptz
);

create unique index if not exists legal_holds_one_active_per_deal
  on legal_holds (deal_id) where lifted_at is null;
create index if not exists legal_holds_deal_id_idx on legal_holds (deal_id);

-- Append/lift-only: service_role may read, place (insert), lift (update). NO delete,
-- so the freeze history cannot be erased.
grant select, insert, update on legal_holds to service_role;

-- 3. Helper: is this deal under an active hold?
create or replace function deal_is_under_hold(p_deal_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from legal_holds where deal_id = p_deal_id and lifted_at is null
  );
$$;

-- 4. Row guard: block deleting a held deal (this also stops the cascade to documents).
create or replace function block_deal_delete_under_hold()
returns trigger language plpgsql as $$
begin
  if deal_is_under_hold(old.id) then
    raise exception 'deal % is under legal hold (S0.4): delete is not permitted', old.id
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists deals_no_delete_under_hold on deals;
create trigger deals_no_delete_under_hold
  before delete on deals
  for each row execute function block_deal_delete_under_hold();

-- 5. Row guard: block deleting a document whose deal is held (direct deletes).
create or replace function block_document_delete_under_hold()
returns trigger language plpgsql as $$
begin
  if deal_is_under_hold(old.deal_id) then
    raise exception 'document % belongs to a deal under legal hold (S0.4): delete is not permitted', old.id
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists documents_no_delete_under_hold on documents;
create trigger documents_no_delete_under_hold
  before delete on documents
  for each row execute function block_document_delete_under_hold();

-- 6. Statement guard: TRUNCATE bypasses row triggers; block it on deals/documents
-- whenever ANY active hold exists.
create or replace function block_truncate_when_any_hold()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from legal_holds where lifted_at is null) then
    raise exception 'truncate blocked: a deal is under legal hold (S0.4)'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

drop trigger if exists deals_no_truncate_under_hold on deals;
create trigger deals_no_truncate_under_hold
  before truncate on deals
  for each statement execute function block_truncate_when_any_hold();

drop trigger if exists documents_no_truncate_under_hold on documents;
create trigger documents_no_truncate_under_hold
  before truncate on documents
  for each statement execute function block_truncate_when_any_hold();

-- 7. Place a hold: insert the row AND write the audit event.
create or replace function place_legal_hold(p_deal_id uuid, p_actor uuid, p_reason text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into legal_holds (deal_id, reason, placed_by)
    values (p_deal_id, p_reason, p_actor)
    returning id into v_id;
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor, 'hold_placed', p_deal_id,
            jsonb_build_object('reason', p_reason, 'hold_id', v_id));
  return v_id;
end;
$$;

-- 8. Lift the active hold: stamp lifted_*, AND write the audit event.
create or replace function lift_legal_hold(p_deal_id uuid, p_actor uuid)
returns void language plpgsql as $$
declare v_id uuid;
begin
  update legal_holds set lifted_by = p_actor, lifted_at = now()
    where deal_id = p_deal_id and lifted_at is null
    returning id into v_id;
  if v_id is null then
    raise exception 'no active legal hold on deal % to lift (S0.4)', p_deal_id
      using errcode = 'P0001';
  end if;
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor, 'hold_lifted', p_deal_id, jsonb_build_object('hold_id', v_id));
end;
$$;
```

- [ ] **Step 2: Mirror the two new audit actions in TypeScript**

Edit `src/lib/constants/audit.ts` — add the two entries to `AUDIT_ACTION`:

```typescript
export const AUDIT_ACTION = {
  VIEW: 'view',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  EXPORT: 'export',
  GRANT: 'grant',
  REVOKE: 'revoke',
  HOLD_PLACED: 'hold_placed',
  HOLD_LIFTED: 'hold_lifted',
} as const;
```

(`AuditAction` and `AUDIT_ACTIONS` derive automatically — no other edit needed.)

- [ ] **Step 3: Apply the migration to the dev Supabase**

Apply via the Supabase MCP `apply_migration` (name: `legal_hold`, query = the file body) against the intelibank project. This is the same path used for #49.

- [ ] **Step 4: Run the verification → expect GREEN**

Re-run the `do $$ … $$;` body via MCP `execute_sql` (or `psql … -f supabase/tests/legal_hold.sql` if `DATABASE_URL` is set).
Expected: PASS notice — `PASS: legal hold blocks deal/document delete, audits place/lift, enforces one active hold, releases on lift`. Throwaway rows roll back. This is the empirical proof of all three acceptance criteria.

- [ ] **Step 5: Wire the skipped-but-wired vitest test**

Create `tests/db/legal-hold.test.ts` (mirrors `tests/db/audit-log-immutability.test.ts`):

```typescript
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

// Issue #50: proves the legal hold guarantees by running the canonical SQL probe
// (supabase/tests/legal_hold.sql) against a real Postgres.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, so CI (mocked, no DB) and normal local
// `npm test` runs are unaffected — and it can never fire against the live DB by accident.
// To run it (after the migration is applied to the target DB):
//   RUN_DB_TESTS=1 DATABASE_URL=postgres://... npm test
//
// Future: flip this into a permanent DB-test lane (pgTAP / Postgres-in-CI) so it always
// runs — tracked by the DB-test-capability follow-up.
const RUN = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN)('legal hold (#50)', () => {
  it('blocks deal/document delete under hold and audits place/lift (verify.sql exits 0)', () => {
    const db = process.env.DATABASE_URL;
    expect(db, 'DATABASE_URL must be set when RUN_DB_TESTS=1').toBeTruthy();
    expect(() =>
      execFileSync(
        'psql',
        [db!, '-v', 'ON_ERROR_STOP=1', '-f', 'supabase/tests/legal_hold.sql'],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});
```

- [ ] **Step 6: Confirm the app suite is still green**

Run: `npm test`
Expected: PASS (no DB; the new test is skipped; mocked vitest is unaffected by the migration). The prior run was 220 passed, 1 skipped (#49); expect 220+ passed, 2 skipped.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260629120000_legal_hold.sql src/lib/constants/audit.ts tests/db/legal-hold.test.ts
git commit -m "feat(db): per-deal legal hold / freeze (S0.4, #50)

Adds legal_holds + DB trigger guards blocking deal/document delete (and
truncate) while held; place/lift functions audit via new hold_placed/
hold_lifted actions. Mirrors the two actions in constants/audit.ts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Engineering design doc (AC deliverable)

**Files:**
- Create: `docs/03-engineering/legal-hold-design.md`

**Interfaces:**
- Consumes: the committed migration + verify script (link them).
- Produces: the docs/03-engineering/ design artifact the issue's AC requires.

- [ ] **Step 1: Write the engineering doc**

Write a concise design doc (derive from the spec; do not paste the spec verbatim). It MUST contain:
- A one-paragraph statement of the freeze and why (SEC 17a-4 / regulator-can-demand-intact-record).
- The covered set (deal row + documents) and why `audit_log` (#49) and `deal_memberships` (D33) are not re-covered.
- The mechanism: `legal_holds` (active = `lifted_at IS NULL`), the four trigger guards, `place_legal_hold`/`lift_legal_hold`, the two new audit actions.
- Authority: CCO/admin at the app layer (ADR-0008), with a one-line forward note that the REST endpoint + `userCanManageLegalHold` predicate and deal-scoped RLS (#22) are follow-ups.
- The retention-job contract: any future retention/expiry job MUST check `deal_is_under_hold(deal_id)` (or `legal_holds` with `lifted_at IS NULL`) and skip held deals.
- Cross-links: #49, D33, D34, ADR-0008, and the spec/plan paths.

- [ ] **Step 2: Commit**

```bash
git add docs/03-engineering/legal-hold-design.md
git commit -m "docs(engineering): legal hold design note (S0.4, #50)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wrap-up (held for user approval)

**Files:** none (git + GitHub actions only).

- [ ] **Step 1: Present results to the user**

Show: the four files, the RED→GREEN dev-Supabase output, and the `npm test` result. Note that the migration is applied on the dev DB (reversible: drop the four triggers + the table + the two functions, and re-narrow the audit check). Do NOT push/PR yet.

- [ ] **Step 2: On user approval — finish the branch**

Use superpowers:finishing-a-development-branch. The branch `marcelo/s0.4-legal-hold` is already committed; expected choice is push + open a PR into `develop` (closes #50). The PR body flags the OUT-OF-SCOPE follow-ups (REST endpoint + CCO/admin predicate, RLS, retention engine, orchestration-entity coverage).

---

## Self-Review

- **Spec coverage:**
  - Data model (`legal_holds` + active-hold index + grants) → Task 2 Step 1 (parts 2). ✓
  - Enforcement (deal/document delete guards + truncate guards) → Task 2 Step 1 (parts 4–6); proven Task 1/Task 2 Step 4. ✓
  - Place/lift + audit → Task 2 Step 1 (parts 7–8) + enum (part 1) + TS mirror (Step 2). ✓
  - Covered set / exclusions → Global Constraints + Task 3. ✓
  - Verification (verify.sql + skipped vitest) → Task 1 + Task 2 Step 5. ✓
  - Engineering doc (AC) → Task 3. ✓
  - Out-of-scope (endpoint, RLS, retention engine) → Global Constraints + Task 4 PR body. ✓
- **Placeholder scan:** none — full SQL/TS in every code step. ✓
- **Type consistency:** action values `hold_placed` / `hold_lifted` identical across the migration CHECK, the functions, `audit.ts`, and `legal_hold.sql`. Function signatures `place_legal_hold(uuid,uuid,text)→uuid`, `lift_legal_hold(uuid,uuid)→void`, `deal_is_under_hold(uuid)→boolean` identical between the migration and the verify script. Trigger names consistent. Migration filename `20260629120000_legal_hold.sql` consistent throughout. ✓
