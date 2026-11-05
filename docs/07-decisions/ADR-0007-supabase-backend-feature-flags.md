# ADR-0007 — Supabase as the backend; feature flags as the first slice

- **Status:** Proposed (Marcelo Gumiero; Lance + Martín acknowledgement pending). Implemented. *Later:* the `admin`/`cco` write policy described below was dropped; `feature_flags` is service-role only (D63, `supabase/migrations/20260928120000_rls_deal_scoped_policies.sql`), and flag changes are not audited (D34).
- **Date:** 2026-06-03
- **Deciders:** Marcelo Gumiero (proposal + implementation); Lance Marks / Martin Casado (acknowledgement pending)
- **Source:** Lance's directive in `#internal-intelibank` 2026-06-02 ("build the schema foundation… i assume we'll use supabase and ensure we have RLS across tables"); the permissions model in `docs/03-engineering/permissions_schema_v3-full.md`; extends D8 (the seam) without reversing it.
- **How-to:** for creating, configuring, and consuming flags, see [`../03-engineering/feature-flags.md`](../03-engineering/feature-flags.md).

## Context

The build is mock-only and client-driven: no server actions, no database, no network calls (`docs/03-engineering/architecture.md`, `docs/03-engineering/sandbox-vs-production.md`). The single product data boundary is the typed `ConductiaAPI` seam (D8); `MockConductiaAPI` returns deterministic fixtures.

The team now has three Supabase projects standing up the real backend:

- `Conductia-dev` — `lknjzkvvhmqdmhdnnmwb` (us-east-1) — **the primary build target; all first development happens here**
- `futureproofing-staging` — `cnxnqsxjmysowewfazyr` (us-east-1)
- `futureproofing-prod` — `fhdqjfgknpevzvissycu` (us-east-1)

> **Update 2026-09-25:** these three project refs are deprecated. The only active Supabase projects are **prod `fsaucpwponmzajupvsey`** and **dev `sqyjqdjazefceixkjtdp`**; there is no separate staging project. Where this ADR says `Conductia-dev`, read the dev project; where it says staging or prod, read the prod project. The decision itself (separation by project, no `environment` column) is unchanged.

> **Update 2026-10-13:** staging has its own Supabase project again, `sfiqfmqecormenlfoklc`, migrated by *Promote develop to staging* (decision-log D84). The active projects are prod `fsaucpwponmzajupvsey`, staging `sfiqfmqecormenlfoklc` and dev `sqyjqdjazefceixkjtdp`. The staging deployment keeps reading the dev project until its Vercel variables are moved (`docs/04-operations/production-bootstrap.md`, The staging database).

> **Update 2026-10-14:** the staging deployment now reads the staging project, from a Vercel environment of its own (`docs/04-operations/production-bootstrap.md`, The staging database). Preview deployments, `develop` included, read the dev project; production reads prod.

The first concrete backend task is **dynamic feature-flag management** so non-deploy toggling of in-progress capabilities is possible while the team sprints the MVP foundation and layers features week by week (Lance, 2026-06-02). Because this is the *first* real backend dependency the repo takes on, the choice of where flags live, how they are read, and how environments are separated sets the pattern every later backend slice inherits. That makes it ADR-worthy.

## Decision

Adopt **Supabase (Postgres + RLS)** as the backend, and ship **feature flags as the first slice**, shaped as follows.

1. **Flags are infrastructure, not product data.** They do **not** enter the `ConductiaAPI` product seam (that contract is the M&A domain: sellers, acquirers, skills, compliance). They get their own typed module at `src/lib/flags/` (flat, matching the repo's `src/lib/*` convention), with a single read entry point `isEnabled(key: FlagKey)`. The shared Supabase connection lives in `src/lib/supabase/` (the foundation from PR #3: config single-source + browser/server/admin clients + health check); the flag read path uses its `createSupabaseAdminClient()` (secret key, bypasses RLS). `FlagKey` is a TypeScript string-literal union — flag keys are type-checked, never stringly-typed (per `conventions.md`).

2. **Dynamic, DB-backed.** Flags are toggled at runtime via a `feature_flags` table, with no redeploy required. Env vars are reserved for connection config only, never for the flags themselves.

3. **Server-side evaluation by default.** Next.js App Router server components / route handlers read flags using the **Supabase Secret key (`sb_secret_…`), which stays server-only**. (This is Supabase's new key system; the legacy `anon` / `service_role` keys are deprecating. The publishable key replaces `anon` for any future browser-safe read; the secret key replaces `service_role` and bypasses RLS for server use.) Client components receive resolved flag values through a provider hydrated from the server. The secret key is never shipped to the browser.

4. **RLS from day one** (Lance's directive). Read access to enabled flags is permitted broadly; **write access is restricted to `admin` / `cco`**, matching the role model in `permissions_schema_v3-full.md`.

5. **Environment separation comes from the separate projects.** Dev flags live in the `Conductia-dev` project (the first build target); staging flags in the staging project; prod flags in the prod project. No `environment` column is needed. Connection is wired per environment (`SUPABASE_URL` / service role key via Vercel env scoping; `Conductia-dev` for local development); keys are never committed (`.env*.local` is git-ignored).

6. **Fail-closed.** If `isEnabled(key)` cannot resolve a row, it returns `false` — never an error, never `true`. Unknown or unreachable state must not silently enable a capability.

7. **A seed is the code↔DB bridge.** An idempotent seed (`upsert` by `key`, updating metadata only, never overwriting a runtime `enabled` toggle) materialises the canonical `FlagKey` set into each project. Adding a flag = add to the `FlagKey` union + add to the seed.

The management UI is owned by a separate team; this slice delivers the migration (table + RLS), the typed read module, and the seed that the UI consumes.

## Alternatives considered

- **Third-party flag service (LaunchDarkly / Flagsmith / PostHog).** Full-featured, but adds a new subprocessor that sees flag-evaluation context — an extra surface to audit for a compliance-first product pursuing SOC 2 / ISO. Rejected: hosting flags inside the team's own Supabase (already inside the SOC 2 perimeter) avoids the new subprocessor, and the MVP needs do not justify the vendor.
- **Env vars / config file only.** Simplest, zero infra. Rejected: build-time only — cannot be "managed" (toggled at runtime without a deploy), which is the explicit requirement. Env vars are retained for connection config, not for the flags.
- **Put flags inside the `ConductiaAPI` seam.** Lowest number of boundaries. Rejected: pollutes the M&A domain contract with infrastructure concerns, violates one-responsibility-per-file, and couples flag reads to the product mock. Flags get their own module.
- **Targeting / percentage rollout now (`rules jsonb`).** Maximum flexibility. Rejected as YAGNI: boolean `enabled` resolves the MVP; the jsonb targeting column is added only when a real gradual-rollout need appears.

## Consequences

- New dependency `@supabase/supabase-js` enters `package.json` (the repo's first backend client).
- A `feature_flags` table + RLS policies are created in both Supabase projects via a versioned migration; an idempotent seed accompanies it.
- New module `src/lib/flags/` (flat) is added: a typed `FlagKey` union, the `FlagSource` interface, `isEnabled()`, the Supabase-backed source (consuming `createSupabaseAdminClient()` from the `src/lib/supabase/` foundation merged from PR #3), and a hydration path for client components. Built TDD-first per `conventions.md` (logic = strict TDD). Ops tooling stays at the repo root (`scripts/`, `supabase/migrations/`).
- Connection secrets are managed per environment outside the repo (`.env.local` locally; Vercel env scoping for deploys). Creating/holding the production keys follows D3 (outward/infra actions are Lance's checkpoint).
- D8 is extended, not reversed: the product seam remains mock-backed and unchanged; feature flags are a *parallel* infrastructure boundary. The first real `ConductiaAPI` live implementation remains a future, separate decision.
- This ADR sets the reusable pattern (own typed module · server-side eval · RLS · fail-closed · per-project env separation) for every subsequent backend slice.

## Open questions

1. **Seed default per environment.** ✅ **Resolved (2026-06-03):** seed every flag `enabled = false` in all environments; flip on per environment via the management UI. No per-environment default in the seed.
2. **Audit transport for toggles.** ✅ **Resolved (2026-06-12): dropped.** Feature-flag changes are internal/dev config, not business events, so they are NOT written to the business `audit_log` (D34). The control on who can change flags is the `admin`/`cco` write RLS policy (point 4), not an audit trail.
3. **Read path for client hydration.** ✅ **Resolved (2026-06-03):** Option 2 — server-side evaluation + hydration (no anon-key client reads). Automatic refresh required: short-TTL revalidation as the baseline + on-demand `revalidateTag('feature-flags')` when the management UI writes. Browser Realtime is the deferred escape hatch, only if instant client-side propagation is ever required (YAGNI now).
4. **Wiring the hydration provider (static → dynamic).** ⏸️ **Deferred (2026-06-03).** `resolveFlags()` + `FlagsProvider`/`useFlag` are shipped but **intentionally not wired into a layout**. Wiring them so client components can read flags requires resolving flags at request time, which opts the app out of its current fully-static render (it would render dynamically). Server components can already gate via `isEnabled`/`resolveFlags` with no wiring. Decision (go dynamic app-wide vs. scope per-route vs. wait for a concrete client-side consumer) is left to the team; update `docs/03-engineering/sandbox-vs-production.md` when it changes.
