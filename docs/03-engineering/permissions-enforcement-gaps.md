> **Superseded / historical.** Snapshot from branch `engineering/migrate-permissions-schema` (June 2026). The buyer phase-gating, audit read-back and notifications gaps recorded here were closed by D38/D39/D43/D44. Deal-scoped RLS policies (#78, #79) landed later (ADR-0016, `20260928120000_rls_deal_scoped_policies.sql`), so "0 RLS policies" below is historical. Still open: the `department` fail-open in `userCanSearchCompanies` (#159).

# Permissions — Enforcement Gaps (Phase 1)

Status of the permissions slice on branch `engineering/migrate-permissions-schema`,
captured for the Sunday team sync ahead of the Storm call. Schema reference:
[`permissions_schema_v3-full.md`](permissions_schema_v3-full.md). Migration:
`supabase/migrations/20260604100000_permissions_schema.sql`.

**One line:** roles, users, and deal memberships are seeded and *coarse* deal-scoped
access is enforced in the API layer — but the *fine-grained* permissions (document
classification, phase-gating, thread ownership) are declared in data only and are
**not enforced yet**.

---

## Seed accounts (live in Conductia-dev)

8 users, 8 memberships, 3 deals, 1 document. **0 RLS policies.**

| Account | Person | `deal_role` | `firm_role` | External |
|---|---|---|---|---|
| `md.intelibank@dev.com` | Storm Duncan | md | — | no |
| `deal-team.intelibank@dev.com` | Alex Chen | deal_team | — | no |
| `legal.intelibank@dev.com` | Jordan Blake | legal | — | no |
| `cco.intelibank@dev.com` | Pat Rivera | — | cco | no |
| `admin.intelibank@dev.com` | Platform Admin | — | admin | no |
| `seller.intelibank@dev.com` | Mike Cannon-Brookes | seller | — | yes |
| `buyer.intelibank@dev.com` | Buyer Contact | buyer | — | yes |
| `read-only.intelibank@dev.com` | Observer One | read_only | — | no |

`admin` and `cco` have no deal membership — they reach deals through a `firm_role`
override in code, not through membership.

---

## Two layers, and where each stands

**Layer 1 — Postgres RLS: effectively off.** RLS is `enabled` on every table, but
there are **zero policies** (the migration defers them in a comment that says
"ticket #3" — an informal note, not a GitHub issue; the roadmap home is issue #7).
With RLS on and no policy, only the **secret key** (service_role, which bypasses
RLS) can read or write. The publishable/anon key sees nothing. So the DB itself
enforces no per-role rule today.

**Layer 2 — API layer (`src/lib/api/v1/access.ts`): on, but coarse.** Routes use the
secret key and apply their own checks in code:

- `requireApiUser()` — must be authenticated, else 401.
- `userCanAccessDeal()` — CCO and ADMIN see **all** deals; everyone else needs a
  `deal_membership` row for that deal.
- `userIsDealMd()` — only the deal's MD (or ADMIN) can add members (`POST /members`).
- `listDealsForUser()` — CCO/ADMIN see all deals in the tenant; others see only
  deals they belong to.

---

## Declared vs. enforced — who sees what today

| Role | Declared (`roles.permissions`) | Enforced today |
|---|---|---|
| **MD** | deal:full, acquirer:full, scoring:edit, team:manage, compliance:verdicts | ✅ sees deal + docs, adds members |
| **Deal Team** | deal:read, acquirer:scores, document:read:class1-3, thread:own | ⚠️ sees deal + **all** docs (classification not filtered) |
| **Legal** | nda:manage, engagement_letter:manage, document:read:class1-3, thread:own | ⚠️ sees deal + all docs; NDA tables not in Phase 1 |
| **CCO** | deal:read:all, compliance:full, audit:full, nda:read | ✅ sees **all** deals (override); audit table exists, no UI |
| **Admin** | user:manage, tenant:manage | ✅ sees all + adds members; `user:manage` has no endpoint |
| **Seller** | document:upload:class1-3 | ⚠️ sees deal; upload not implemented |
| **Buyer** | document:read:phase_gated | 🔴 sees deal + **all** docs — phase-gating NOT applied |
| **Read-only** | deal:read, document:read:class1-2 | ⚠️ read-only only because no write endpoint exists for it, not by rule |

---

## Gaps to close

Ordered by compliance risk. Each maps to an existing roadmap issue rather than a
new ticket (there is no GitHub "ticket #3"; that string is only a migration comment).
Homes: **#7** (Phase 1 access rules), **#10** (Phase 2 buyer stage-gating + deal
isolation), **#14** (Phase 2 three-level protection), **#19 / #15** (Phase 3 per-file
access + secure data room), **#8 / #25** (audit log).

1. **🔴 Buyer phase-gating** *(#10, #15)*. `GET /deals/{id}/documents` returns every
   document to any deal member. Buyers should see only documents whose
   `min_phase <=` the buyer's membership `phase`. This is a real disclosure gap, not
   cosmetic.
2. **🔴 Document classification filter** *(#14, #19)*. Deal-team / legal capped at
   class 1-3, read-only at class 1-2. Today classification is ignored on read. Apply
   the `document:read:classN` ceiling per role.
3. **🟠 RLS policies** *(#7)*. Add policies so the DB enforces deal-scoped access
   independently of the API layer (defense in depth). Until then a direct
   secret-key path has no backstop.
4. **🟠 Write-path coverage** *(#19)*. Seller upload (`document:upload:class1-3`) and
   the read-only/observer write-deny are implied by missing endpoints, not enforced.
   Make the deny explicit when those endpoints land.
5. **🟡 Audit surfacing** *(#8, #25)*. `audit_log` is written on document view/grant
   but never read back. CCO has `audit:full` declared with nowhere to see it.
6. **🟡 Admin `user:manage` / `tenant:manage`**. Declared, no endpoints. Decide
   whether Phase 1 needs them or they move to Phase 2.

**Not in Phase 1 (acknowledged):** `nda:*`, `engagement_letter:*`, `thread:own`,
`compliance_events`, `notifications` — these reference tables that do not exist yet.

---

## For the Storm call

- The "who can do what" story holds at the **deal-membership** level today (MD runs
  the deal, deal team + legal + observer are members, CCO/admin oversee everything).
- The **honest gap** to name: external parties (buyer especially) are not yet walled
  off by phase or document class. That is the next enforcement step, and it is the
  part that makes "compliance is the floor" true rather than asserted.
- Tie-in to Lance's open question (manual input vs. automated): the document
  classification + phase a buyer is gated to is exactly the kind of state that must
  be set somewhere — by the MD, by a rule, or at upload. Worth deciding on the call.
