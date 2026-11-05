# Legal Hold / Freeze — Engineering Design

Status: shipped, S0.4 (2026-06-29). Author: Marcelo.
Issue: #50 (Epic #46). Migration: `supabase/migrations/20260629120000_legal_hold.sql`.
Spec (full rationale): `docs/superpowers/specs/2026-06-29-legal-hold-design.md`.

---

## What and why

A deal's regulatory record must be lockable against purge or expiry. SEC Rule 17a-4 and FINRA 4511 — and equivalent regulator authority in cross-border M&A — allow an authority to demand an intact deal record years after a transaction closes or terminates. Retention-expiry logic cannot safely run without first checking whether a deal is frozen. Legal hold provides the freeze state: a per-deal flag that blocks all deletion paths and marks every placement and lift in the immutable audit trail.

---

## Covered set

| Record | Covered by hold | Rationale |
|---|---|---|
| `deals` row | Yes — BEFORE DELETE trigger | The main purge vector: deleting the deal row cascades to documents and memberships. Blocking the deal row blocks the cascade. |
| `documents` | Yes — BEFORE DELETE trigger (direct deletes) | Documents may be deleted directly, independently of the deal cascade. |
| `audit_log` | Not re-covered — already append-only (#49) | The immutability work in #49 physically removes the delete grant on `audit_log`. Also, `audit_log.deal_id` has no ON DELETE CASCADE: it already restricts deleting an audited deal via FK. |
| `deal_memberships` | Not covered by hold | Per D33, a seat is hard-deleted when revoked; the durable trail lives in the immutable `audit_log`. That history is already protected by #49 — the membership row itself carries no regulatory substance beyond what the audit event records. |

---

## Mechanism

### Hold state table — `legal_holds`

```
legal_holds
  id          uuid PK
  deal_id     uuid → deals(id)   (NOT NULL; restrict FK — a held deal cannot be silently deleted)
  reason      text               (NOT NULL)
  placed_by   uuid → users(id)   (NOT NULL)
  placed_at   timestamptz        (NOT NULL, default now())
  lifted_by   uuid → users(id)
  lifted_at   timestamptz
```

**Active hold = `lifted_at IS NULL`.** A partial unique index (`where lifted_at is null`) enforces at most one active hold per deal — `place_legal_hold` raises a unique-violation if one is already active.

`service_role` is granted `SELECT, INSERT, UPDATE` only — no `DELETE`. Hold history is append/lift-only and cannot be erased.

Row level security is on with no policy, `anon` and `authenticated` hold no privilege on the table (`20260929170000_close_definer_function_grants.sql`), and `place_legal_hold`, `lift_legal_hold` and `deal_is_under_hold` are executable by `service_role` only (`20260930170000_legal_holds_rls.sql`, from the #230 review). `supabase/tests/public_rls_coverage.sql` fails CI if any `public` table lands with RLS off.

### Helper

`deal_is_under_hold(deal_id uuid) → boolean` — a stable SQL function that checks `legal_holds` for an active row. All trigger guards call this.

### Trigger guards (four, two tables)

| Trigger | Table | Type | What it blocks |
|---|---|---|---|
| `deals_no_delete_under_hold` | `deals` | BEFORE DELETE, per-row | Delete of a held deal. Stopping the deal row also stops the ON DELETE CASCADE to `documents` and `deal_memberships`. |
| `documents_no_delete_under_hold` | `documents` | BEFORE DELETE, per-row | Direct document delete when its deal is held. |
| `deals_no_truncate_under_hold` | `deals` | BEFORE TRUNCATE, per-statement | TRUNCATE bypasses row triggers; blocked when any active hold exists. |
| `documents_no_truncate_under_hold` | `documents` | BEFORE TRUNCATE, per-statement | Same bulk-wipe defence on the documents table. |

All four raise `SQLSTATE P0001` with a message that includes `(S0.4)` for traceability.

### Place and lift

`place_legal_hold(deal_id, actor, reason) → uuid` and `lift_legal_hold(deal_id, actor)` are atomic SQL functions. Each inserts the `legal_holds` row (or stamps `lifted_at`) **and** writes an `audit_log` event in the same execution, so the hold state and its audit trail are never out of sync.

Two new audit actions extend the `audit_log.action` CHECK enum:

| Constant (`src/lib/constants/audit.ts`) | SQL value | Written by |
|---|---|---|
| `AUDIT_ACTION.HOLD_PLACED` | `'hold_placed'` | `place_legal_hold` |
| `AUDIT_ACTION.HOLD_LIFTED` | `'hold_lifted'` | `lift_legal_hold` |

Both values are also mirrored in the `AUDIT_ACTION` constant object and the `AuditAction` union type. The CHECK was widened by dropping and re-adding the constraint in the same migration (idempotent).

---

## Authority

Who may call `place_legal_hold` / `lift_legal_hold` is enforced at the **app layer** (ADR-0008 "belt"): CCO and admin firm-roles only. The MD role is deliberately excluded — legal hold is a compliance authority action, not a deal-execution action (D34).

Follow-up (own issue/PR): a `/api/v1/deals/{id}/legal-hold` POST/DELETE endpoint with a `userCanManageLegalHold` predicate in `src/lib/api/v1/access.ts`, and deal-scoped RLS on `legal_holds` (#22).

---

## Retention-job contract

No retention or expiry job exists yet. When one is built, it **MUST** check `deal_is_under_hold(deal_id)` — or query `legal_holds WHERE deal_id = ? AND lifted_at IS NULL` directly — and skip any held deal entirely. Proceeding without this check is a compliance defect. This is the forward contract the hold mechanism defines.

The first deletion job that honours it is the discovery mail purge (#461, `20261014120500_discovery_purge.sql`; Proposed, D93). It is a deletion on a consent's end and at pilot end, not a retention expiry. Its collector, `discovery_collect_orphans`, calls `deal_is_under_hold(promoted_deal_id)` for every promoted candidate of the tenant and skips both the candidate and every stored message that evidences it, counting them as `heldSkipped` in the audit row. The content-free message index (`discovery_message_index`) follows the same rule: `discovery_purge_identifiers` keeps every index row linked to a deal under hold (`20261014150000_discovery_message_index.sql`). The worker's backstop retries each tick, so the held mail, and under the pilot retention policy its index rows, are deleted on the first tick after `lift_legal_hold` (`20261014160000_tenant_retention_policy.sql`). The tenant purge (`discovery_purge_tenant`) lists the held residue per candidate and deal in its report, and leaves held index rows out of the index it exports. The runbook section is [Deleting stored mail](../04-operations/discovery-worker-aws-runbook.md#deleting-stored-mail).

---

## Cross-references

- **#49** — `audit_log` append-only (sibling; closes the deletion vector on the audit trail)
- **D33** — decision to hard-delete memberships and keep the trail in `audit_log` (why memberships are excluded from hold coverage)
- **D34** — CCO/admin write authority over sensitive config (grounds the authority model above)
- **ADR-0008** — Phase 1 backend; the app-layer access-control "belt" this hold plugs into
- **Full spec**: `docs/superpowers/specs/2026-06-29-legal-hold-design.md`
- **Implementation plan**: `docs/superpowers/plans/2026-06-29-legal-hold.md`
- **Verify script**: `supabase/tests/legal_hold.sql`
- **Wired test**: `tests/db/legal-hold.test.ts` (skipped in CI; requires `RUN_DB_TESTS=1 + DATABASE_URL`)
