# PL-02 handoff: finish per-firm agent tenancy

**Status (2026-09-23):** in progress. The seam work and Phases 1 to 4 are on branch `fix/agent-seam-tenant-and-run-binding`. Phases 5 to 7 below are specified but **not implemented**. Whoever picks this up runs them in order, one commit per phase, on this branch.

Issue: Conductia/Conductia #79 (related #159). Prelaunch audit PL-02 (BLOCKER, Critical). Audit decision **D-0**: each firm's agent runs, callbacks and agent data stay inside that firm's tenant.

## Context in one paragraph

Ignatious (`Conductia/conductia-agents-backend`) is the agent layer. Conductia triggers runs (MD Briefing, Presearch, Debrief, bench chat, twins) and Ignatious calls back into Conductia's `/v1/**` routes with a signed trigger token (PL-03, ADR-0015, PR #188). Before this branch, every firm's runs went out under one environment tenant (`IGNATIOUS_TENANT_ID || 'tn_demo'`). Callbacks loaded leads by deal id or code with no tenant filter, and agent-written personas, intel and documents all lived in one shared bucket. See `docs/03-engineering/finding-agent-seam-unsigned-token-2026-09-18.md`.

## What is already on the branch

| Commit | What it does |
|---|---|
| `f6e92cd` | Binds `executionId` to the deal or lead before acting on a run |
| `f388036` | `scope_denied` no longer echoes the expected tenant and lead |
| `72b1fa7` | Carries `conductiaTenantId` in the signed token; `requireConductiaLead` checks the lead's owner tenant against it |
| `304c7c4` | Partitions personas, filings and twins by the Conductia tenant (migration + backfill script) |
| Phase 1 commit | Renames the persona migration to a unique prefix and adds a CI guard (see below) |

## Before you start

1. **Keep the stack current.** The branch is stacked on #188 (`fix/agent-seam-unsigned-token`). On 2026-09-23 #188 was rebased onto `develop` (`c05d1306`) at `5c76c5b2`, renumbering its decision to ADR-0015 / D61, and this branch was rebased onto that tip. When #188 moves again, run `git rebase --onto origin/fix/agent-seam-unsigned-token <old #188 tip>`, then `git push --force-with-lease`. **Never push to `fix/agent-seam-unsigned-token` itself**, because a parallel task owns #188.
2. **You need Supabase locally**: the Supabase CLI and a working Docker daemon. Phases 2 to 4 cannot be proven without them. If you cannot run them, the CI `integration` job is the proof, but debugging a matrix through CI is slow.
3. `npm ci`, then confirm the baseline: `npm run lint` (0 errors, about 32 warnings), `npx tsc --noEmit` clean, `npm run build` passes, and `npx vitest run` passes. The only local-only failure is the `email-mark-asset` PNG mismatch, which is green in CI.
4. Read `CLAUDE.md` and `docs/03-engineering/delivery-model.md`. Do not rename the required CI jobs (`verify`, `integration`, `e2e`).

## Desired end state

- The persona migration is `20260930100000_lead_personas_conductia_tenant.sql`, and a duplicate 14-digit prefix fails `verify`. **(Done, Phase 1.)**
- `tests/integration/agent-seam-tenancy.test.ts` runs in the `integration` job. It shows that firm A's signed token is refused on firm B's lead (reads, writes, documents, intel, personas) on both the deal path and the company path, that B's rows are unchanged afterwards, and that every A-on-A control returns 200.
- `requireConductiaLead` refuses a signed token whose lead has no owner tenant, or which carries no tenant claim, with the same 404 as a tenant mismatch, and refuses the shared `api_key` credential (401). **(Done, Phase 4.)**
- With `VERCEL_ENV=production` and `IGNATIOUS_LEAD_ID` set, `readIgnatiousConfig()` logs one reason and returns `null`, so agent routes return 503.
- (Only with Storm's approval) A control-plane or bench base URL ending in `/v1` is normalised to the bare origin.
- `ADR-0016` (Proposed) and a `D62` (Proposed) row describe D-1. A stacked PR is open against `fix/agent-seam-unsigned-token` with CI green.

## ✅ Phase 1: Unique migration prefix, guarded in CI (done)

- `supabase/migrations/20260919120000_…` was renamed with `git mv` to `20260922120000_lead_personas_conductia_tenant.sql`. The SQL is byte-for-byte unchanged.
- The header of `scripts/backfill-persona-tenant.sql` now names the new file.
- The guard is PL-23's `check:migrations` step in `verify` (#195, on `develop`). This branch briefly carried its own vitest guard for the same rule and dropped it after rebasing onto `develop`.
- No other reference to the old prefixes remains.
- Verified 2026-09-23: `supabase db reset --local` applies the full chain on a local stack.
- `20260922120000` is still the latest prefix on `develop` (`20260922100000` is next newest). Bump it before merge if a later one lands first.
- Bumped 2026-09-29 to `20260930100000` after later migrations landed on `develop` (review on #232). The SQL is idempotent (`if not exists` throughout), so an environment that applied it under the old name re-applies it harmlessly.

## ✅ Phase 2: Two-tenant integration test, deal path (done)

Shipped as specified, plus a second layer with the tokens a real firm A run holds (a deal run's token stops at `{field: dealId}`, a company run's at the tenant wall). The tenant refusals in the table below answered 403 `{field: tenantId}` until Phase 4, which changed them to the missing-lead 404. The `{field: dealId}` refusal moved to the same 404 in the Phase 4 follow-up.

The first time the seam runs against real Postgres: seed rows, then the real `/v1` handlers, `requireConductiaLead`, `loadConductiaLead`, and a DB re-read. **Deal path only** (lead id = `deals.code`), so the harness is proven before the matrix grows. **No production code changes.**

New file `tests/integration/agent-seam-tenancy.test.ts`. Use `tests/integration/phase1.e2e.test.ts` as the pattern source.

- `seed()`: tenant A and tenant B, each with a bank company, a deal (with `code`), a `lead_intel` row and `lead_documents`.
- `seamRequest(path, bearer, leadId, init?)`: sets the four `x-conductia-*` headers. Lift it from `tests/conductia-seam-tenant.test.ts`.
- `tokenFor(tenant, leadId)`: `mintTriggerToken` with the full md-briefing scope set.
- `afterAll`: delete child rows first, in the phase1 cleanup order.
- Env via `vi.stubEnv` inside the test: `IGNATIOUS_CONTROL_PLANE_URL`, `IGNATIOUS_API_KEY`, `IGNATIOUS_TENANT_ID=tn_demo`, `CONDUCTIA_TRIGGER_TOKEN_SECRET`. The `integration` job already supplies the Supabase URL and service key, so `ci.yml` does not change.

Every refused call has an A-on-A twin that must return 200:

| Route (`src/app/v1/leads/[leadId]/…`) | A's token on B's deal | After the call |
|---|---|---|
| `GET route` (lead + intel) | 403 `{field: tenantId}` | |
| `GET documents` | 403 | |
| `POST notes` | 403 | B's `lead_intel` re-read, unchanged |
| `PATCH fields` | 403 | B's `lead_intel` re-read, unchanged |
| `POST documents` | 403 | B's `lead_documents` count unchanged |

**Watch out:** A's token must name B's deal code as its `dealId` claim, so the claim binds to the path. Otherwise the binding check refuses first with `{field: dealId}` and the test never reaches the tenant check. Assert `field: 'tenantId'` on every 403, so you know which check fired.

Verify:
- `supabase start && supabase db reset --local`, then `npm run test:integration`
- `npx tsc --noEmit`, `npm run lint`
- Sanity check: temporarily comment out the tenant comparison in `src/lib/conductia/route.ts`, confirm the deal-path rows fail, then restore it

## ✅ Phase 3: Company path and personas in the integration test (done)

Still no production code. Extend the Phase 2 file:

- `seed()` also creates a company-only lead per tenant (a company with no deal) plus its `lead_intel` and `lead_documents`, and one `lead_personas` row per tenant with `conductia_tenant_id` set and `tenant_id = tn_demo`.
- `describe('company path')`: the same rows as the deal path, with lead id = `companies.id` (the fall-through in `loadConductiaLead`). Company-scoped agents mint the company id as the `dealId` claim; these rows name the path lead itself as the claim, so they pass `claimBindsToLead` on equality and reach the tenant check. (Since the lead-binding follow-up, a company claim binds only to that company, or to a deal whose target it is; an unresolvable claim or path is refused, and a failed read answers 503.)
- `describe('personas')`:
  - `GET /v1/personas`: A sees its own persona and never B's
  - `GET /v1/personas/[B]`: 404
  - `PATCH /v1/personas/[B]`: 404, B's row re-read unchanged
  - `POST /v1/personas/[A]/links` pointing at B's lead: 403, A's links unchanged

Verify:
- `npm run test:integration`
- Sanity check: temporarily drop the `.eq('conductia_tenant_id', …)` filter in `src/lib/conductia/personas.ts`, confirm the persona rows fail, then restore it

## ✅ Phase 4: Close the lead gate's fail-open branches (null owner, `api_key`) (done)

The first production-code change in this handoff. In `requireConductiaLead` (`src/lib/conductia/route.ts`):

```diff
   requireConductiaScope(...)
+  if scope.credential === 'api_key'  → 401 (same shape as the persona gate's missing claim)
   createSupabaseAdminClient()
-  if signed_token: claimBindsToLead → 403 {field: dealId}
+  if signed_token: claimBindsToLead → 404, the missing-lead body
   loadConductiaLead → 404
-  if claim && ownerTenantId && owner !== claim → 403 {field: tenantId}
+  if signed_token && (!claim || !ownerTenantId || owner !== claim) → 404, the missing-lead body
```

- **The tenant refusal answers 404, not 403** (decided 2026-09-23). A company-scoped token passes the binding on any deal code, so a distinct answer on another firm's deal would let it enumerate `PREFIX-YEAR-NNN` codes. The log keeps the reason: `tenant_binding` (mismatch), `tenant_claim_missing`, `tenant_owner_missing`, and `api_key` for the key refusal.
- **The binding refusal answers the same 404** (follow-up, 2026-09-23). A deal-scoped token is refused only on a code that resolves to a deal, and the binding stands down on a code nobody holds, so the old 403 `{field: dealId}` on another firm's code against a 404 on an unused one was a second enumeration oracle. The log keeps `binding`. This changes the refusal #188's `tests/conductia-seam-binding.test.ts` pinned; that assertion moves to 404 on this branch, not on #188's. The integration test tells the two walls apart by the logged reason, since the responses are now identical.
- `loadConductiaLeadFromCompany` returns null for a non-uuid id. Before, a deal code nobody holds reached `companies.id` (a uuid column), Postgres rejected it, and the gate answered 500, which told an unused code apart from another firm's.
- `POST /v1/personas/[personaId]/links` checks `link.leadId` against the lead's owner (`loadConductiaLead(...).ownerTenantId`), not `resolveLeadCompany`'s target-company tenant. The integration test seeds a deal firm B owns whose target is under firm A's tenant, and the link is refused.
- `legacy_unsigned` keeps its current behaviour. It only exists under `observe`, and ADR-0015's rollout owns it. `/v1/library` stays on the base gate.
- `tests/conductia-callback.test.ts:42-62` uses the key against `requireConductiaScope` directly and keeps passing. The base gate still accepts the key; only the lead gate refuses it.

Verify:
- `npx vitest run tests/conductia-seam-*.test.ts tests/conductia-persona-tenant.test.ts tests/conductia-callback.test.ts tests/api-v1-ignatious-idor.test.ts`
- `npm run test:integration`
- `npx vitest run` (full), `npx tsc --noEmit`, `npm run lint`

## Phase 5: Refuse `IGNATIOUS_LEAD_ID` in production

In `readIgnatiousConfig()` (`src/lib/ignatious/config.ts`), after the missing URL and key checks:

```ts
if (leadIdOverride && process.env.VERCEL_ENV === 'production') {
  console.error('[ignatious] IGNATIOUS_LEAD_ID is set in production; refusing agent runs (PL-02)');
  return null;
}
```

`routeContext.ts` already turns a `null` config into a 503, and `tests/api-v1-ignatious-idor.test.ts` covers that path. So the only new tests go in `tests/ignatious-control-plane.test.ts`:
- `'refuses the lead override on a production deploy'`: returns `null`, `console.error` called once
- `'keeps the lead override on a preview deploy'`: `VERCEL_ENV=preview` still maps to the override
- The existing local-defaults test (no `VERCEL_ENV`) stays unchanged.

Verify: `npx vitest run tests/ignatious-control-plane.test.ts`, `npx tsc --noEmit`, `npm run lint`.

## Phase 6: Normalise a `/v1`-suffixed base URL (needs Storm's approval first)

This fixes the production error `no route POST /v1/v1/agents/md-briefing/runs`. The backend serves `/v1/*` and `/v1/bench/*` from the bare origin, so a `/v1` suffix is never correct. **Do not ship this phase without explicit approval.** Keep it in its own commit so it can be dropped.

- `trimUrl` also feeds `CONDUCTIA_PUBLIC_URL`, which must keep its path, so leave `trimUrl` alone. Add `ignatiousOrigin(value)` (`trimUrl`, then strip one trailing `/v1` segment) and use it only for the control-plane, API and bench override URLs.
- `.env.example`: the `IGNATIOUS_*` URL comment says "bare origin, no /v1".
- Tests in `tests/ignatious-control-plane.test.ts`: `'strips a trailing /v1 from the control plane and bench URLs'` (`https://host/v1` and `https://host/v1/`). Also `createControlPlane` with a `/v1` base, where fetch must be called with `https://host/v1/agents/md-briefing/runs`.

Verify: `npx vitest run tests/ignatious-control-plane.test.ts tests/ignatious-bench.test.ts`, `npx tsc --noEmit`, `npm run lint`.

## Phase 7: D-1 ADR proposal, decision log, stacked PR

No code. First confirm that `ADR-0016` and `D62` are still free on `develop`, on #188's branch and on this branch. ADR-0015 and D61 are #188's seam signing decision, and D58 is taken on `codex/172-recipient-relationships`.

`docs/07-decisions/ADR-0016-ignatious-tenant-per-conductia-tenant.md`, Status: Proposed, same layout as ADR-0015:

```text
ADR-0016: One Ignatious tenant per Conductia tenant
  Context      two namespaces (tn_demo handle vs conductiaTenantId), backend passes tenantId through, pooled stores
  Decision     target: per-firm wire tenantId derived from the Conductia uuid; seam checks header vs signed claim
  Interim      tn_demo constant + signed claim as the only firm boundary (this PR)
  Cutover      send per-firm handle, accept either → backend partitions → drop the constant
  Open asks    handle format, provisioning vs pass-through, quotas/rate limits, per-tenant keys
  References   ADR-0015, finding-agent-seam-unsigned-token-2026-09-18.md, this PR, backend trigger.ts / RestConductia
```

Add a `D62` (Proposed) row to `docs/07-decisions/decision-log.md` that cites ADR-0016 and the PR.

Open the PR with `gh pr create --base fix/agent-seam-unsigned-token`. The description covers:
- **Closes PL-02:** signed claim, lead and persona tenant checks, run binding and store partitioning, proven by the integration test. Unique migration prefix, prod `IGNATIOUS_LEAD_ID` refusal, and the `/v1` fix if Phase 6 ships.
- **Behaviour change:** the `api_key` credential is refused on lead routes. A caller that sends the key instead of the trigger token must switch to the token.
- **Rollout order:** apply migration → backfill census → backfill → verify → deploy. Rollback is safe (additive column).
- **Stays open:** D-1 with the agents-backend team, #159 (separate PR), `IGNATIOUS_API_KEY` rotation, deal-scoped RLS (#78/#79).
- **Merges after** the PL-23 migration gate. Retarget to `develop` once #188 merges.

Verify:
- `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`
- `gh pr checks <n>`: `Lint, typecheck, test, build`, `Phase 1 integration test (local Supabase)`, `E2E (hermetic)` and `Dependency vulnerability audit` all green
- No em-dashes in user-visible copy added by this branch (the new log line and error messages)
- Storm reviews the ADR wording before the PR leaves draft

## Known loose end

`.env.example` on this branch documents `CONDUCTIA_TRIGGER_TOKEN_SECRET` and `CONDUCTIA_TRIGGER_TOKEN_MODE`. Keep that block. A local working copy had it deleted by accident, and that deletion was not committed.
