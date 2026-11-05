# Legal Hold / Freeze (S0.4) Design

Status: approved design, ready for implementation plan (2026-06-29). Author: Marcelo.
Issue: #50 (Epic #46, Step 0 — Pour the floor). Sibling of #49 (audit_log immutable, shipped).

## Goal

Let a deal's regulatory record be locked from purge/expiry. A regulator can demand the
intact record years later, so retention expiry must be overridable per deal. This delivers
the design doc (the issue's acceptance criterion) plus a working, testable DB slice that
enforces the freeze at the database level.

## Background — current state (reconciled on `develop`)

- No legal-hold or retention concept exists in the schema today. Net-new.
- The persisted records a hold would cover: `audit_log`, `documents`, `deal_memberships`.
  Handbook entities `ModelCall` / `Approval` / `Communication` live in the orchestration
  spine in-memory and are not yet persisted (D35), so they are out of the initial hold scope.
- Key deletion vectors in the schema (`supabase/migrations/20260604100000_permissions_schema.sql`):
  - `documents.deal_id` and `deal_memberships.deal_id` are `on delete cascade` from `deals`.
    So deleting a deal row cascade-purges its documents and memberships. **This is the main
    purge vector a hold must block.**
  - `audit_log.deal_id` references `deals(id)` with no cascade, and `audit_log` is already
    physically append-only (#49) — it cannot be deleted, and its FK already restricts deleting
    an audited deal.
- No retention/purge job exists yet. The hold is therefore partly forward-looking: it defines
  the freeze state and enforces deletion blocks now, and documents the contract a future
  retention job must honor.

## Decisions (locked in brainstorming)

1. **Approach A — `legal_holds` table + trigger guards** (over a boolean column on `deals`),
   because legal hold is inherently a compliance-history artifact ("when frozen, by whom, why,
   when lifted"). The table answers that natively; the cost over a column is trivial.
2. **Who can place/lift: CCO + admin firm-roles** — grounded in repo precedent: D34 (the control
   on sensitive config is the `admin`/`cco` write policy), ADR-0008 (CCO/admin firm-roles are the
   tenant-wide oversight authority; MD is deal execution), and the copilot-surface-action-map
   (the security signal goes to Eng/CCO, not the MD). Deliberately excludes the deal MD.
3. **Covered set: the deal row + `documents`.** `audit_log` is already covered by #49.
   `deal_memberships` is excluded: per D33 a seat is hard-deleted with its durable trail kept in
   the (immutable) `audit_log`, so the history is already protected.
4. **Audit enum extension (required by the AC).** `audit_log.action` today is
   `view|download|upload|export|grant|revoke` with no hold verb. Place/lift must be auditable, so
   add **`hold_placed`** and **`hold_lifted`** to the CHECK enum and mirror them in
   `src/lib/constants/audit.ts`. Unlike feature flags (deliberately not audited, D34), legal hold
   is a business/regulatory event and belongs in `audit_log`.
5. **PR scope: DB slice only** — table + guards + place/lift SQL functions + enum extension +
   verify script + skipped-but-wired vitest test. The `/api/v1` endpoint and the CCO/admin access
   predicate are a tight follow-up (own issue/PR), matching the DB-only shape of #49.

## Data model

New migration `supabase/migrations/20260629120000_legal_hold.sql` (idempotent). Latest existing
migration is `20260625120000` (#49).

```sql
create table if not exists legal_holds (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals (id),
  reason      text not null,
  placed_by   uuid not null references users (id),
  placed_at   timestamptz not null default now(),
  lifted_by   uuid references users (id),
  lifted_at   timestamptz
);

-- A deal is "under hold" iff it has a legal_holds row with lifted_at IS NULL.
-- At most one ACTIVE hold per deal:
create unique index if not exists legal_holds_one_active_per_deal
  on legal_holds (deal_id) where lifted_at is null;

create index if not exists legal_holds_deal_id_idx on legal_holds (deal_id);

-- Grants: service_role may read, place (insert) and lift (update). NO delete:
-- a hold is never removed, only lifted, so the freeze history is preserved.
grant select, insert, update on legal_holds to service_role;
```

`deal_id` uses the default (restrict) FK behavior, mirroring `audit_log.deal_id`: a deal that
has ever been held is not silently hard-deletable. `legal_holds` rows are append/lift-only
(no `delete` grant): the freeze history itself cannot be erased.

## Enforcement (physical DB guards, same family as #49)

```sql
-- Helper: is this deal under an active hold?
create or replace function deal_is_under_hold(p_deal_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from legal_holds where deal_id = p_deal_id and lifted_at is null
  );
$$;

-- Row guard: block deleting a held deal (this also stops the cascade to documents/memberships).
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

-- Row guard: block deleting a document whose deal is held (direct deletes).
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

-- Statement guard: TRUNCATE bypasses row triggers, so block truncating deals/documents
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
```

When `DELETE FROM deals` runs for a held deal, the BEFORE DELETE on `deals` raises before the
cascade fires, so documents/memberships are never reached. The document-level guard covers
direct document deletes. The truncate guards close the bulk-wipe hole.

## Place / lift (atomic, with audit)

```sql
-- Place a hold: insert the row AND write the audit event in one statement-set.
create or replace function place_legal_hold(p_deal_id uuid, p_actor uuid, p_reason text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into legal_holds (deal_id, reason, placed_by)
    values (p_deal_id, p_reason, p_actor)
    returning id into v_id;
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor, 'hold_placed', p_deal_id, jsonb_build_object('reason', p_reason, 'hold_id', v_id));
  return v_id;
end;
$$;

-- Lift the active hold: stamp lifted_*, AND write the audit event.
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

Permission (CCO/admin) is enforced at the app layer (ADR-0008 "belt"); these functions are the
mechanism. The unique partial index guarantees `place_legal_hold` cannot create a second active
hold on the same deal (it will raise a unique-violation).

## Audit enum extension

In the same migration, widen the `audit_log.action` CHECK to include `hold_placed` and
`hold_lifted`, and mirror them in `src/lib/constants/audit.ts` (`HOLD_PLACED`, `HOLD_LIFTED`).
The CHECK is recreated (`drop constraint if exists` + `add constraint`) since Postgres has no
"alter check"; idempotent.

## Verification

`supabase/tests/legal_hold.sql` — wrapped in `begin … rollback`, run via psql with
`ON_ERROR_STOP=1` (same pattern as #49's `audit_log_immutability.sql`). Proves:

1. Setup: throwaway CCO user (via `auth.users` → mirror trigger), a throwaway deal + document.
2. `place_legal_hold` creates a `legal_holds` row AND an `audit_log` row with action `hold_placed`.
3. A second `place_legal_hold` on the same deal raises (one-active-hold index).
4. `DELETE` of the document is blocked.
5. `DELETE` of the deal is blocked.
6. `lift_legal_hold` stamps `lifted_at` AND writes an `audit_log` row with action `hold_lifted`.
7. After lift, `deal_is_under_hold` is false (protection released).

`tests/db/legal-hold.test.ts` — skipped-but-wired vitest (`RUN_DB_TESTS=1` + `DATABASE_URL`),
identical pattern to #49's `tests/db/audit-log-immutability.test.ts`. CI has no Postgres, so it
stays skipped there; the proof is run via the Supabase MCP / psql against the dev DB (RED→GREEN).

## Engineering doc (AC deliverable)

`docs/03-engineering/legal-hold-design.md` — a concise version of this design for the engineering
docs set (the issue's "Design documented in docs/03-engineering/" criterion), cross-linking #49,
D33, D34, ADR-0008, and the future retention-job contract.

## Out of scope / follow-ups

- `/api/v1/deals/{id}/legal-hold` POST/DELETE endpoints + a `userCanManageLegalHold` predicate in
  `src/lib/api/v1/access.ts` (CCO/admin) — tight follow-up issue/PR.
- Deal-scoped RLS for `legal_holds` (rides the #22 RLS work).
- The retention/expiry engine the hold overrides — separate, larger, not Step 0.
- Extending coverage to orchestration entities (`ModelCall`/`Approval`/`Communication`) once
  they are persisted (post-D35).

## Acceptance criteria mapping

- *A deal under legal hold cannot have covered records purged or expired* → deal-delete guard
  (kills cascade) + document-delete guard + truncate guards; proven by `legal_hold.sql` steps 4–5.
- *Hold place/lift is auditable* → `place_legal_hold`/`lift_legal_hold` write `hold_placed`/
  `hold_lifted` rows to the immutable `audit_log`; proven by steps 2 and 6.
- *Design documented in docs/03-engineering/* → `docs/03-engineering/legal-hold-design.md`.
