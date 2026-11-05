# Conductia

**The compliance-first M&A intelligence platform for managing directors.**

Conductia surfaces the *decisions* a Managing Director must make running a sell-side M&A process — not the data dump a junior analyst would assemble. Every intent and message passes, visibly, through a compliance layer. That is the structural differentiator versus generalist finance-AI tooling (and versus Rogo, the named competitor: it answers with a data dump; we answer with screened decisions).

> This repo is **two deliverables in one**: a working sandbox-grade product *and* the foundation library (the `docs/` tree) that every future product, engineering, brand, and growth contributor builds on.

---

## Status

> **Build from `develop`.** Work is done when it merges to `develop`. `main` is a release snapshot and may lag; see [`docs/03-engineering/delivery-model.md`](docs/03-engineering/delivery-model.md).

| | |
|---|---|
| **Shipped** | **Ignatious beta live at app.conductia.com** since Sep 7, 2026 (`v0.5.6`, [Labor Day scope](docs/02-product/labor-day-mvp-2026-08-03.md), ADR-0013 / D45). Current release **`v0.8.0`** (released to production Oct 15; `v0.7.0` shipped Oct 7 and was tagged Oct 13). What each release carried is in its GitHub release notes and `CHANGELOG.md`. |
| **Next target** | **MVP 2, Friday Oct 30, 2026**: custom rails, skill builder, email safety, beta hardening, cost tracking, first skills wave, compliance controls + Outlook, buyer/seller invitations (the written scope is not on `develop`: PR #146 closed unmerged on Sep 30, and the current scope is to be recorded as a decision). Weekly gates W2-W7 are the repo milestones; work is tracked on the [Conductia delivery board](https://github.com/orgs/Conductia/projects/1). |
| What's built | Sign-in with MFA, invite onboarding, project picker and Gate 0 wizard with code names, the **deal rail** of 5 phases and 65 steps, 61 of them on the MVP rail (`src/lib/rail/dealRail.ts`; owners, status, proof, skip with reason; MD Briefing and Teaser run live skills against the agents backend), Book view with the seven lifecycle stages, Box data room and deal folder, pre-send mail screening (Riskpatcher, risk bands, four-eyes, Storm's lexicon) with Microsoft 365 mailbox connect, audit trail, CCO notifications, leads / CRM / relationship pathing, AI cost ledger per deal / person / task / model, company access management. |
| Backend | Supabase permissions schema with **one tenant per firm**; auth mirrored into `users`; versioned **`/api/v1`** beside the seam ([`api-v1.md`](docs/03-engineering/api-v1.md), ADR-0008). Skills and agents run in [`Conductia/conductia-agents-backend`](https://github.com/Conductia/conductia-agents-backend) (`agents.conductia.com`). App-layer access predicates, with deal-scoped RLS policies as the backstop (ADR-0016, `20260928120000_rls_deal_scoped_policies.sql`, #78, #79). |
| Still mock-backed | The M&A analytics surface behind the `ConductiaAPI` seam (acquirer scoring, DCF, skills catalogue) is fixture-backed (#82). |
| Tests | `npm test` on `develop` (Vitest, about 750 test files), the Phase 1 integration suite, the hermetic Playwright journeys and the dependency audit: the four checks required to merge to `develop`. Promotion to `staging` also requires the secret scan (`scripts/ci/required-checks.mjs`). |
| Skill enhancement and version selection (2026-09-14) | A rail step's skill version is selectable, once-off or as its standing default, and a skill is enhanced in place through the shipped skill builder rather than authored from scratch, behind the `skill_authoring` flag. Every skill-backed step now runs through one converged runner; `BenchStepRunner` is gone. Not yet run end to end against a live Ignatious service. Skill runs and their results are recorded per step (`deal_step_skill_runs`), with output revisions behind `skill_output_revisions`. |

---

## The user journey

1. **Sign in** (`/sign-in`) — outside the shell. Authentication is enforced in `src/middleware.ts`.
2. **Conductor Center** (`/projects`; `/` redirects here) — inside the shell. For the bank it opens on what needs the caller's judgment, then lists their deals as one list (phase, percent done, current step, who is on it), each linking into its project. With `platform_onboarding` on, an external member with one deal who is not a company director goes straight into that deal. The walkthrough changes are in [`docs/02-product/walkthrough-changes-2026-10-22.md`](docs/02-product/walkthrough-changes-2026-10-22.md).
3. **Mandate** (`/projects/[projectId]`) — the project dashboard: live vitals (pipeline / top fit / team / compliance) and a compliance-event feed.
4. **Acquirers** (`/projects/[projectId]/acquirers`) — a sortable ranked table of who could buy the seller, plus the comparable-company set.
5. **Deep-dive** (`/projects/[projectId]/acquirers/[id]`) — the deep-dive workspace: drag a skill onto the canvas (it routes through compliance), and read the analysis as segmented artifacts (Valuation / Culture / Synergy / Founder).
6. **Team** (`/projects/[projectId]/team`) — the canonical roster, invitation, access, and team-communication destination. With platform onboarding enabled it uses the authoritative membership and invite APIs; the flag-off demo retains per-recipient compliant threads.
7. **Skills** (`/projects/[projectId]/skills`) — the governed library of the rail's step skills, grouped by phase, each with its approval state. There is no paywall or self-serve toggle on this surface.

Other project destinations: the rail (`rail`), Book (`book`), mail (`mail`), the deal folder and data room (`deal-folder`, `data-room`), audit (`audit`) and chat (`chat`).

Routes split into two layers by route group: the unguarded `sign-in` / dev tools at the top of `src/app/`, and the shell surfaces under `src/app/(authed)/` (`/projects` and everything under `/projects/[projectId]`). The route group only decides which routes get the shell; auth lives in middleware. The shell is persistent chrome composed by **`AppShell`**: the top navigation (`TopNav` with the workbench top-nav flag on, otherwise the left `Sidebar` plus `TopBar`) and, below md, the `AppNav` bottom bar. Inside a project the top navigation carries the single live `ComplianceRibbon`. Fixed viewport — only the content column scrolls.

---

## Running it locally

CI runs on every pull request and on pushes to `develop` and `main`: lint, `tsc`, Vitest and `next build`; the Phase 1 integration suite on a local Supabase; the hermetic Playwright journeys; and a dependency audit (see `.github/workflows/ci.yml`). Feature PRs target **`develop`**, need one approving review and the four required checks green, and auto-merge once they have both; squash is the only merge method. `develop` → `staging` → `main` move only by fast-forward, through the promotion Actions (rulesets, see [`delivery-model.md`](docs/03-engineering/delivery-model.md)).

Requires **Node 22.12 or later** (`package.json` engines; `.nvmrc` selects the newest 22.x). With [nvm](https://github.com/nvm-sh/nvm), run `nvm use` from the repo root before install; `fnm` / `asdf` read `.nvmrc` the same way.

```sh
git checkout develop && git pull origin develop
```

### Configuration

Copy the example env file and fill in your Supabase `-dev` project credentials:

```sh
cp .env.example .env.local
```

Edit `.env.local`. requesting proeper value to one of the admin.

```sh
nvm use          # Node 22 — required for Vitest 4 and the build toolchain
npm install
cp .env.example .env.local   # first run only — then edit with Supabase keys
npm run dev      # http://localhost:3000

npm run build    # production build (Next 16 Turbopack)
npm test         # vitest run
npx tsc --noEmit # type-check
npx eslint .     # lint
```

### Phase 1 backend (auth, deals, audit)

After the Supabase migrations are applied, seed the per-role dev accounts + a
sample deal, then explore the API:

```sh
# .env.local needs SEED_PASSWORD (min 8 chars) for the auth seed
npm run seed       # seed:flags + seed:users (idempotent)
npm run check:db   # verify the permissions schema + role seed are present
npm run dev        # then open http://localhost:3000/dev-api
```

`/dev-api` is a dev-only Swagger explorer for `/api/v1`: type any account on the
database you are pointed at (a freshly seeded one signs in with `SEED_PASSWORD`),
sign in, and exercise the endpoints. Full reference:
[`docs/03-engineering/api-v1.md`](docs/03-engineering/api-v1.md).

To verify Db connection, open your terminal and run the following curl:
```sh
curl -s http://localhost:3000/api/health/supabase
```

A healthy `-dev` project returns `"ok": true` with auth latency and version.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind 4 (custom CSS-variable token system; shadcn patterns hand-rolled in `src/components/atoms`, not the dependency) · Framer Motion · Vitest + Testing Library. Self-hosted type via `next/font`: Inter (sans) / Geist Mono (mono). The serif moment is Georgia from the palette (`--font-display`), reserved for deal identity and source excerpts (D48).

> Local note: `localhost` accumulates cookies across dev apps and can hit an HTTP 431 (headers too large). Use an incognito window or clear `localhost` cookies.

---

## Engineering invariants — do not drift

- **The seam.** M&A content goes through the typed `ConductiaAPI`; `MockConductiaAPI` returns fixtures. It is the content contract (D35; `docs/03-engineering/data-contracts.md`), not the whole backend.
- **Platform spine beside the seam.** Identity, deals, memberships, documents, and audit are *not* product content; they live in the versioned `/api/v1` REST layer (ADR-0008), never inside the `ConductiaAPI` seam. The UI also calls `/api/v1` directly. Handlers self-authenticate; access is enforced in app code, with deal-scoped RLS as the backstop (ADR-0016).
- **Deterministic scoring.** Anthropic 87 / Salesforce 67 come from a pure function (`src/lib/scoring/composite.ts`) over fixtures. Never hardcoded.
- **Compliance, once.** The single live `[data-compliance-status]` instrument is the `ComplianceRibbon`, rendered by the top navigation (`TopBar`, or `TopNav` behind its flag) inside a project. Components dispatch `SET_COMPLIANCE` via the session store; they never self-display. The rail dot is decorative.
- **Project as URL.** The active project is the `/projects/[projectId]` segment — the source of truth, not session state. `/` redirects to `/projects`, which routes into it; the sandbox resolves any id to the Atlassian dataset. Shell surfaces live under the `(authed)` route group; auth itself is enforced in middleware.
- **Contrast contract.** Light surfaces → dark `--ink*`; dark surfaces (`--canvas-bg`, ink #191919 under the Workbench palette, D48) → light `--ink-on-dark*`. Semantic type-ramp classes are in `@layer components` so utility color overrides win.
- **Surgical, on-voice.** Smallest correct change; statements not questions; no em-dashes in visible copy (ARIA/regulatory separators excepted).

---

## Skill publication operations

Skill publication moves a candidate from `skill_authoring_candidates` through `skill_publication_operations` to a live rail step. This section covers reading and recovering that state. Execution, run history, results, and generated files remain unimplemented until Part D.

### Counts by state and safe error code

```sql
select state, status_code, count(*)
from skill_publication_operations
group by state, status_code
order by state, status_code;
```

`status_code` is null while an operation is in progress; it is set only from the bounded, non-secret codes the processor writes (for example `candidate_invalid`, `receipt_conflict`).

### Operation age

```sql
select id, deal_id, draft_id, state, created_at, now() - created_at as age
from skill_publication_operations
where state not in ('published', 'failed')
order by created_at asc;
```

An old, non-terminal row is the signal to check the processor and the correlation-id lookup below before assuming data loss; the five-minute sweep advances anything recoverable on its own.

### Correlation-id lookup

Every command from the browser to Conductia to Ignatious carries the same `client_request_id`. Look an operation up by it directly:

```sql
select *
from skill_publication_operations
where client_request_id = '<client-request-id>';
```

### Recovery sweep

The recovery sweep is a Vercel cron job declared in `vercel.json`: every five minutes Vercel sends `GET /api/v1/internal/skill-publications/process` with `Authorization: Bearer $CRON_SECRET` to the production deployment. Set `CRON_SECRET` on the Vercel project; the route accepts it beside `SKILL_PUBLICATION_PROCESSOR_TOKEN` (and `_PREVIOUS` during rotation).

Vercel runs cron jobs only against the production deployment, so preview branches get no automatic sweep. To drive one by hand, POST the same route with an empty body and the processor token:

```sh
curl --fail-with-body -sS -X POST -H "Authorization: Bearer $SKILL_PUBLICATION_PROCESSOR_TOKEN" "$DEPLOYMENT_URL/api/v1/internal/skill-publications/process"
```

### Before enabling `skill_authoring` in an environment

- verify the deployed environment's operational Postgres is reachable and holds the `skill_publication_operations` schema;
- verify immutable package storage for published skill versions is configured and reachable.

### Running recovery mode 1 locally

The cross-service recovery suite's mode 1 (`tests/integration/skill-publication-recovery.test.ts`) drives Conductia's processor against a real Ignatious publication HTTP server started from an Ignatious checkout, with an in-memory Conductia persistence fake standing in for Postgres. It is gated by `RUN_PUBLICATION_E2E=1` and needs `IGNATIOUS_REPO` (an absolute path to an Ignatious checkout) and `SKILL_BENCH_DATABASE_URL` (Ignatious's own loopback Postgres, port 55439 only, used solely for the spawned server's own unique schema):

```bash
RUN_PUBLICATION_E2E=1 IGNATIOUS_REPO=/path/to/ignatious SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform \
  npx vitest run --config vitest.integration.config.ts tests/integration/skill-publication-recovery.test.ts
```

The suite is skipped unless `RUN_PUBLICATION_E2E=1` is set. It covers the eleven approved recovery scenarios (normal publish and attach; a weak active match with a comparison set that changes after confirmation; exact active and exact removed duplicates; a lost publish response recovered by lookup, with the version the server actually committed and exactly one publish call; a transient attachment failure, where the fault is in Conductia's local attach step, not an HTTP call; a lost attachment response that commits the step before the reply is lost, then converges to the same step by request-id idempotency; a removed anchor followed by replacement placement; permission loss before publication, and again after a live receipt where it no longer matters because attaching never re-checks access; the feature flag disabled before publication, and again after an ambiguous publish call whose reply was lost but that the server actually committed; and same-name isolation across projects, published through the real server on both sides) with faults injected at the HTTP boundary, never at a real model provider.

### Running recovery mode 2 locally

The cross-service recovery suite's mode 2 (`tests/integration/skill-publication-recovery-mode2.test.ts`, a separate file from mode 1) drives the same real Ignatious server against real Conductia persistence: a Supabase admin client built from `CONDUCTIA_SUPABASE_E2E_URL` and `CONDUCTIA_SUPABASE_E2E_SERVICE_ROLE_KEY`, pointed at a disposable loopback Supabase stack with every migration applied. It also needs `IGNATIOUS_REPO` and `SKILL_BENCH_DATABASE_URL`, the same variables mode 1 uses, because it spawns the same real Ignatious server:

```bash
CONDUCTIA_SUPABASE_E2E_URL=http://127.0.0.1:<disposable-stack-port> \
  CONDUCTIA_SUPABASE_E2E_SERVICE_ROLE_KEY=<disposable-stack-service-role-key> \
  IGNATIOUS_REPO=/path/to/ignatious \
  SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform \
  npx vitest run --config vitest.integration.config.ts tests/integration/skill-publication-recovery-mode2.test.ts
```

A validation helper rejects any non-loopback host, any non-http(s) URL, and ports 54321 and 54322 (the shared local stack's API and database ports), and requires the service-role key to be set. It runs only the normal-flow smoke scenario, not the other ten; those stay mode-1-only. It is skipped unless `CONDUCTIA_SUPABASE_E2E_URL` is set, and is meant for your own local run, never CI or a shared stack.

---

## Foundation — where to read next

- **`AGENTS.md`** — the agent/engineer router (thesis, invariants, working rules, commands); `CLAUDE.md` imports it. Dated history is in `CHANGELOG.md`.
- **`ARCHITECTURE.md`** — implementation contract for Claude/Cursor coworkers (how to apply the architecture safely).
- **`docs/README.md`** — the docs map (folder-by-folder; `00`–`06` distilled, `07-decisions/` and `08-security/` seeded, `99-source/` verbatim).
- **`docs/07-decisions/`** — the decision log + ADRs (why we chose what we chose); Labor Day scope lock in ADR-0013.
- **`docs/03-engineering/delivery-model.md`** — branches (`develop` = done), rulesets, releases and tags, the delivery board, weekly scorecard.
- **MVP 2 scope (Oct 30, 2026)** — not yet on `develop`; the proposal (PR #146) closed unmerged, and the scope is to be recorded as a decision.
- **`docs/02-product/labor-day-mvp-2026-08-03.md`** — the delivered Ignatious beta scope (historical).
- **`docs/04-operations/production-bootstrap.md`** — how production was stood up and how migrations reach it.
- **Historical, point-in-time (bannered):** archived under `docs/archive/` — `FINAL-VERIFICATION.md` (pre-merge close-out), `MERGE-FINAL-VERIFICATION.md` (merge close-out), `MERGE-REVIEW.md` + `VISUAL-REVIEW.md` (the reviews that drove the merge + the navy pivot). These record past states; this README is the current source of truth.

---

## Ownership & git

| | |
|---|---|
| Org | [Conductia](https://github.com/Conductia) |
| Repository | [`Conductia/Conductia`](https://github.com/Conductia/Conductia) (moved from `FutureProofingDev/intelibank` on 2026-09-03; issue and PR numbers restarted, see [delivery model](docs/03-engineering/delivery-model.md#issue-numbering)). npm package name `conductia`. Agents backend: [`Conductia/conductia-agents-backend`](https://github.com/Conductia/conductia-agents-backend). Marketing site: [`Conductia/conductia-site`](https://github.com/Conductia/conductia-site) |
| Clone (SSH) | `git@github.com:Conductia/Conductia.git` |
| PR reviews | `.github/CODEOWNERS` requests `@lance-fp`, `@martin-fp`, `@robdll`, `@mgumiero9`, `@charleswvs`, `@guillermo-alc`. The `develop` ruleset requires one approval and the four required CI checks. |
