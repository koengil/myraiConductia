# Browser E2E Foundation — Design

**Date:** 2026-08-26
**Status:** Approved design, pending implementation plan
**Base branch:** `feat/md-briefing-ignatious`
**Working branch:** `feat/e2e-foundation`

## Problem

Nothing in this repository proves that a Managing Director can complete a deal
in a browser. The suites we have are strong at their own tiers and silent at
this one.

The unit tier is large and healthy: 188 vitest files under `tests/`. But
`tests/golden-path.test.tsx` — the file whose name claims the journey — renders
each destination **in isolation** with `next/navigation` mocked, asserting that
route-level composition survives. It never navigates, never carries state from
one surface to the next, and never touches a server.

The integration tier is honest about what it covers and deliberately narrow.
`tests/integration/phase1.e2e.test.ts` runs real route handlers against real
Postgres, but its own header states the boundary: "What is faked: ONLY the
browser session." There is no browser. Identity is switched in-process via
`actAs`.

So the cross-surface journey exists in exactly one form today: the manual
checklist in `docs/03-engineering/onboarding-demo-runbook.md`, which asks a
human to drive two browser profiles and an inbox for ten minutes. A regression
in the path from lead to close is currently detected by a person noticing it
during a demo.

With the Ignatious beta on Monday, Sep 7 2026 (ADR-0013 / D45), that is the
wrong detector.

## Evidence

Surveyed on `feat/md-briefing-ignatious`, 2026-08-26:

| Fact | Value |
|---|---|
| Vitest files under `tests/` | 188 |
| Browser E2E specs | 0 |
| Playwright / Cypress in `package.json` | absent |
| `playwright.config.ts` / `e2e/` | absent |
| CI jobs in `.github/workflows/ci.yml` | 3 (`verify`, `integration`, `security`) |
| `data-testid` occurrences in `src/` | 4 |
| `role="status"` / `role="alert"` / `role="dialog"` | 60 / 40 / 13 |
| `/api/v1` route handlers | 75 |

Two conclusions follow directly. First, the selector strategy must be
role-based, because the component tree is built for accessibility and not for
test hooks, and the existing vitest suite already queries it that way.
Second, the evidence layer needs no new endpoints: every read-back the spine
requires already exists under `/api/v1`.

## Scope

**In scope.** The foundation — runner, configuration, authentication, fixtures,
selector contract, evidence layer, CI wiring — and exactly one journey built on
it: the MD spine, single identity.

**Explicitly deferred.** The multi-identity onboarding journey (firm admin
invites an external director, who receives mail, accepts, verifies, and lands
in a scoped shell). It is the flow with the most demo risk and the one that is
manual today, so it is the intended second journey. It is deferred because it
requires mail interception and a second storage state, and building it
simultaneously with the harness would mean debugging both at once.

The foundation is designed so that journey is additive: a new spec file that
reuses existing steps under a different storage state. No configuration change,
no CI change.

## Decisions

These were settled during design and are recorded so they are not
re-litigated.

### D1 — Two tiers, one codebase; live-first, hermetic-second

The suite has a hermetic tier that gates merges and a live tier that runs
against real services. They are the same journey code under two Playwright
projects, not two implementations.

The hermetic tier is the eventual regression gate. The live tier is what
answers "is the app mostly working?" this week. Work proceeds live-first,
because the flows are still being wired to the backend and freezing fixtures
around them now would buy churn rather than signal.

### D2 — Authenticate by API; skip 2FA

E2E specs do not drive `/sign-in`. A setup project mints a Supabase session
with the service key and writes cookies into a stored browser state; journey
specs start already inside the shell.

The auth boundary is already covered at the unit tier by
`tests/middleware-mfa.test.ts`, `tests/sign-in-mfa.test.tsx`,
`tests/two-factor-page.test.tsx`, `tests/mfa-policy.test.ts`, and
`tests/mfa-bypass.test.ts`. Re-driving that UI in a browser would add cost
without adding coverage.

The product supports this safely. `isMfaRequiredForUser` honors
`MFA_ENFORCEMENT=invite_only`, and `isMfaBypassEnabled` accepts `DISABLE_MFA`
only when `NEXT_PUBLIC_APP_ENV=dev`, so the bypass cannot be enabled on staging
or production.

**Consequence, accepted:** no browser test covers sign-in or `/two-factor`.

### D3 — Every step asserts a visible outcome and a durable consequence

Each step of a journey asserts what the MD sees **and** reads the resulting row
back through `/api/v1` — the deal, the membership, the document, the outbox
receipt, the audit entry.

Compliance is this product's stated moat. A journey that clicks through without
checking the audit trail proves the wrong thing.

Exhaustive assertion on copy, scores, and ordering is rejected for now: the UI
is being actively rewired, so pinning that surface produces churn.

### D4 — No test that depends on a third-party service may block a merge

The blocking tier fakes every external dependency at a seam that already exists
in the repository. The tier that exercises real Box, Resend, Microsoft 365, or
the Ignatious skill API runs in a separate workflow with **no `pull_request`
trigger**, so it is structurally incapable of gating a merge.

An outage, a rate limit, or a rotated credential on someone else's system must
never wedge a pull request, because that failure carries no information about
the change under review.

### D5 — CI jobs are defined per tier, never per journey

One job runs the whole hermetic suite; one job runs the whole live suite. Job
names describe the tier, not its current contents.

Adding a journey must mean adding a spec file, not editing a workflow. When the
suite outgrows its timeout, it scales with a shard matrix
(`--shard=${{ matrix.shard }}/N`), never by splitting journeys into named jobs.

### D6 — Ignatious stays unconfigured in the hermetic tier, and its degraded state is asserted

The base branch carries the Ignatious integration (`src/lib/ignatious/`), so
the rail's skill runners are live on the surfaces the spine walks through. The
hermetic tier does not configure it and does not stub it. Instead the spine
asserts the degraded state as a first-class outcome; real skill execution is
live-tier only.

This is safe, and it was verified rather than assumed. `readIgnatiousConfig()`
returns `null` when `IGNATIOUS_CONTROL_PLANE_URL` or `IGNATIOUS_API_KEY` is
absent, and **every** server-side caller checks for it and degrades to a clean
`503` with an explanatory message — never a throw:

| Caller | Null-config behavior |
|---|---|
| `src/lib/ignatious/routeContext.ts` | `jsonError('Ignatious is not configured…', 503)` before any deal resolution |
| `src/app/api/v1/bench/skills/route.ts` | same `503`, after `requireApiUser` |
| `src/lib/conductia/auth.ts` | `conductiaError('server_error', 'Ignatious is not configured on this Conductia instance.', 503)` |

On the client, the runners surface that message as visible error state rather
than crashing — `BenchStepRunner.tsx` stores it in `error` and renders it. So
the hermetic assertion for any skill-bearing surface is: the surface renders,
the unconfigured message is visible, nothing throws, and no `console.error`
escapes.

Stubbing a local bench on `IGNATIOUS_SKILL_BENCH_URL` (which already defaults
to `http://localhost:4212`) was considered and rejected for now. A stub asserts
the shape of our own fake, while the degraded path is real behavior the beta
can actually hit when credentials lapse — and it costs nothing to maintain.

## Architecture

### Layout

```
playwright.config.ts            # repo root
e2e/
  auth/
    session.ts                  # mint a Supabase session, produce cookies
    setup.ts                    # setup project: writes storage state per role
    .state/                     # gitignored
  support/
    fixtures.ts                 # custom test fixture: page, evidence, runId
    evidence.ts                 # typed thin client over /api/v1
    runId.ts                    # per-run unique suffix for created entities
    selectors.ts                # selector-contract helpers
  steps/
    registerLead.ts
    createDeal.ts
    openDealFolder.ts
    uploadToDataRoom.ts
    composeAndSendMail.ts
    closeDeal.ts
  journeys/
    md-spine.spec.ts
  assets/
    e2e-fixture.pdf             # upload payload
```

`e2e/` is separate from `tests/`, which remains vitest's. The two runners never
see each other's files.

### Runner and projects

`@playwright/test`, chromium only. `playwright.config.ts` defines three
projects:

- **`setup`** — no browser assertions. Mints sessions and writes storage state.
- **`hermetic`** — depends on `setup`. Boots the app through Playwright's
  `webServer` (`reuseExistingServer: !process.env.CI`) with the fake-seam env
  block below.
- **`live`** — depends on `setup`. `baseURL` from `E2E_BASE_URL`, no
  `webServer`, real service credentials from the environment.

`testDir` for both journey projects is `e2e/journeys/`, globbing
`**/*.spec.ts`. Journey specs are project-agnostic: the same file runs under
both tiers.

### The step model

Steps are modules, not page objects. A page object organizes by screen, but the
subject under test is a journey, and the same screen means different things at
different points in it.

Each step module exports three functions over a shared context:

```ts
export const createDeal = {
  act:      async (ctx) => { /* drive the UI */ },
  assertUi: async (ctx) => { /* the visible outcome */ },
  verify:   async (ctx) => { /* the durable consequence, via /api/v1 */ },
};
```

A journey is an ordered list of steps. Each step's `verify()` runs only after
its `assertUi()` passes, so a failure reports the earliest true cause rather
than a cascade.

This is the composability requirement: the deferred onboarding journey reuses
`uploadToDataRoom` verbatim under a different storage state, and a debugging
run can execute one step against a pre-built context.

### Evidence layer

The `evidence` fixture is a Playwright `APIRequestContext` constructed from the
**same** storage state as the browser context, so `/api/v1` handlers
authenticate it through the normal `requireApiUser` path.

This is deliberate. Reading back with the service key would prove a row exists.
Reading back as the MD proves the row exists *and* is visible to the identity
that created it, which exercises the access predicates in
`src/lib/api/v1/access.ts` as a side effect.

`evidence.ts` is a thin typed wrapper with one function per read below — not a
general-purpose HTTP client.

Audit assertions go through one shared helper,
`expectAudit(dealId, { action, actor, since })`. The `since` bound is the run's
start timestamp, so a shared database carrying other people's rows cannot
produce a false positive.

### Selector contract

In priority order:

1. `getByRole(role, { name })` — matches how the existing vitest suite queries,
   and keeps E2E pressure pointed at accessibility.
2. `getByLabel` / `getByPlaceholder` for form fields.
3. `data-testid` **only** where roles genuinely cannot disambiguate: repeated
   cards, a rail item, one row among identical rows. Adding one is a normal
   product change in the same commit as the step that needs it.
4. Never CSS or structural selectors. Never assert on marketing copy — brand
   voice is actively edited, and pinning it guarantees churn.

`data-testid` is used rather than a newly invented attribute because the
repository already contains four of them, plus the `[data-compliance-status]`
instrument precedent.

**One deliberate exception.** The compliance ribbon is asserted by its
instrument attribute `[data-compliance-status]`, not by role. It is mounted
exactly once by invariant, that invariant is the thing worth testing, and the
attribute is already the sanctioned hook for it. Every `verify()` asserts the
count is exactly one, so the invariant is checked continuously rather than
once.

### Data strategy

Journeys create their own deal through the UI under a run-unique name
(`E2E Spine {runId}`), on top of the seeded tenant. Seeded fixtures are
read-only backdrop.

The hermetic tier resets the database per run and would not strictly need
uniquing. The live tier requires it, because it runs against a shared database
somebody may be demonstrating on. The journey code is shared, so `runId` is
always on; in the hermetic case it costs nothing.

## CI

### Hermetic — a required check

`ci.yml` gains one job, **"E2E (hermetic)"**, modeled on the existing
`integration` job and reusing its Supabase CLI pin (`2.114.0`, pinned because
`latest` flakes under the releases-API rate limit):

```yaml
  e2e:
    name: E2E (hermetic)
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - checkout / setup-node / npm ci
      - npx playwright install --with-deps chromium
      - supabase setup-cli (2.114.0) / init --force / start / db reset --local
      - eval "$(supabase status -o env)" && npm run seed:flags && npm run seed:users
      - npm run test:e2e
      - upload-artifact (trace + HTML report) if: failure()
```

The `webServer` env block:

```
NEXT_PUBLIC_APP_ENV=dev
DISABLE_MFA=1
MFA_ENFORCEMENT=invite_only
STORAGE_PROVIDER=local
EMAIL_PROVIDER=noop
# IGNATIOUS_* and ANTHROPIC_API_KEY deliberately unset (see D6)
```

Zero third-party credentials, by construction. A third-party outage cannot fail
this job, and a leaked secret cannot make it pass differently.

Each fake rides a seam that already exists:

| Service | Seam | Hermetic behavior |
|---|---|---|
| Box | `src/lib/storage/index.ts` — `resolveStorageProvider` | Falls back to `LocalStorage`; the source comment already commits to "dev/CI must work without Box credentials (spec c.15)" |
| Resend / M365 | `src/lib/email/transport.ts` | `noop` provider: send succeeds and is marked `simulated`, so screen → verdict → outbox is still exercised end to end |
| Anthropic screening | `SCREEN_LLM_MODEL` unset | Unconfigured fallback |
| Ignatious skills | `readIgnatiousConfig()` returns `null` | Every caller degrades to a `503`; the UI shows the unconfigured message, which the spine asserts (D6) |

### Live — never a gate

`e2e-live.yml` is a separate workflow with `workflow_dispatch` and a nightly
`schedule` trigger, **no `pull_request` trigger**, and `continue-on-error:
true`. It targets `E2E_BASE_URL`, passes real service credentials from repository
secrets, uploads the HTML report, and on failure opens or updates a single
tracking issue listing the failing steps.

Its output is a list, not a verdict.

### Cost

Roughly six to ten minutes of additional PR wall clock, running in parallel
with existing jobs, so it should not extend the critical path beyond the
existing twenty-minute `integration` job.

## The MD spine

| # | Step | `act()` | `assertUi()` | `verify()` |
|---|---|---|---|---|
| 1 | `registerLead` | `/leads`, register `E2E Lead {runId}` | The lead appears in the list | `GET /companies` — a `client`-type company with that name |
| 2 | `createDeal` | Create a deal against that lead | Lands on `/projects/{id}`; the rail renders | `GET /deals/{id}` and `/audit` — deal row, creation entry, MD as member |
| 3 | `openDealFolder` | Rail → deal folder | Steps and phases render; the active phase is marked | `GET /deals/{id}/steps` and `/progress` — the displayed phase matches the server |
| 4 | `uploadToDataRoom` | `/data-room`, upload the fixture PDF | The document appears in the room | `GET /deals/{id}/documents` — row exists; `/audit` — the event is recorded |
| 5 | `composeAndSendMail` | `/mail`, compose, clear the pre-send screen, send | The verdict is shown; the message reaches the outbox | `GET /outbox` — receipt present, `simulated: true` under the hermetic tier |
| 6 | `closeDeal` | Advance the deal to close | Status reflects closed | `GET /deals/{id}` status and `/audit` — the transition is recorded |

Every evidence endpoint above exists on the base branch today; the journey
requires no new API surface.

### When a step is not yet wired

If a step turns out not to be connected to the backend, the correct response is
`test.fixme()` carrying the issue number — never a weakened assertion. The
suite's job is to make that visible, not to absorb it.

## Open questions, to be resolved during implementation

These are flagged rather than assumed, and each is a task in the plan.

1. **Is the unconfigured screening fallback deterministic?** Step 5 crosses the
   pre-send screen, which consults `SCREEN_LLM_MODEL`. If the fallback verdict
   is not deterministic without credentials, the hermetic assertion weakens to
   "a verdict was produced and recorded" rather than naming the verdict. The
   live tier is unaffected.

2. **Does deal creation from a registered lead exist as a UI path today?** `/leads` persists a lead as a `client` company via
   `POST /api/v1/companies`, and its source comment says registered leads
   "become selectable in Task 3's Gate 0 target step." Step 2 must be written
   against the path that actually ships, not the one the comment anticipates.

3. **What does step 6 mean concretely?** `deals/[dealId]` and `/progress` exist,
   but the specific close transition the UI offers needs to be read before the
   assertion is written.

Ignatious was a fourth question on this list and has been resolved; see D6.

## Done when

- `npm run test:e2e` runs the MD spine green against a local hermetic stack
  with no third-party credentials present.
- The "E2E (hermetic)" job passes on a pull request and is registered as a
  required status check.
- `e2e-live.yml` runs on demand against the deployed dev environment and
  reports its breaks as a list.
- The selector contract and the tier rules (D4, D5) are documented under
  `docs/03-engineering/` so the next journey follows them without asking.
- Adding a second journey requires no change to `playwright.config.ts` or to
  either workflow.
