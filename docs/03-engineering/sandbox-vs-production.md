> **Superseded / historical.** Written for the May 2026 mocked sandbox. The product has run on Supabase + `/api/v1` since 2026-06-05 (ADR-0008) and in production at app.conductia.com since 2026-09-07 (`docs/04-operations/production-bootstrap.md`). Only the `MockConductiaAPI` method list and the swap procedure below are still accurate; retiring the mock is tracked in #82.

# Sandbox vs. Production — Conductia

The sandbox is mocked end-to-end. No network calls, no real data. It is not a
prototype to be thrown away — it is built behind a typed interface that IS the
future backend **content** contract (the M&A intelligence surface), so the swap
from mock to real requires no UI rewrite. Two more layers sit beside the seam: the
*platform* contract `/api/v1` (identity, deals, audit; ADR-0008) and the
*agent-governance* spine `src/lib/orchestration/` (#42), whose design narrative is
the engineering handbook ([`intelibank-handbook.html`](./intelibank-handbook.html)). See decision-log **D35** for
how the three relate.

---

## What is mocked

Everything. `MockConductiaAPI` returns deterministic fixtures for all API calls:

- `getSeller()` — Atlassian (Mike Cannon-Brookes persona)
- `getAcquirers()` — five acquirers with fixture `FitInputs` (Anthropic, Salesforce,
  and three others)
- `getPeers()` — Figma, Canva
- `getSkills()` — five skills; four free, one premium-locked
- `getTeam()` — MD, CFO, M&A Advisor
- `getAcquirerScore(id)` — delegates to `computeCompositeScore(fitInputs)`, a pure
  deterministic function (no `Math.random`, no hardcoded return values)
- `runSkill(skillId, acquirerId)` — returns `{ locked:true }` for the premium skill;
  otherwise returns a panel payload derived from fixtures + the scoring module
- `checkMessageCompliance(body)` — delegates to `checkMessage()`, a pure function
  implementing FINRA Rule 2210
- `sendMessage(input)` — delegates to `checkMessage()`; delivers or blocks
  deterministically based on message content

Source: design spec § 3/§ 9; decision-log D8; plan Task 1.6

---

## Where the seam is

`src/lib/api/index.ts` is the single swap point. It exports one function:

```typescript
export function getApi(): ConductiaAPI
```

In the sandbox, `getApi()` returns a `MockConductiaAPI` instance. No UI component
imports `MockConductiaAPI`, `fixtures`, or any concrete implementation — only
`getApi()` and the `ConductiaAPI` type from `types.ts`.

The full interface contract: [`data-contracts.md`](./data-contracts.md).

Source: design spec § 9; decision-log D8; plan Task 1.6

---

## The swap procedure

To connect a real backend — no UI rewrite required:

1. Implement `ConductiaAPI` in a new class (e.g. `src/lib/api/live.ts`).
2. Change `getApi()` in `src/lib/api/index.ts` to return that class.
3. Done.

Every stage component, every domain component, and every panel already depends only
on the interface. The mock and the real implementation are interchangeable at the
single `getApi()` call site.

Source: design spec § 9; decision-log D8

---

## Deferred

The pitch-preparation workflow (pre-call research, transcription analysis, psychology-profiled pitch deck) is documented as a future capability. It is not a destination in the current build; the "Begin Pitch Preparation" CTA that previously sat at the end of the retired spine was removed in Phase F of the front-end overhaul. Pitch prep is referenced in the Mandate roadmap line ("Pitch composition. Next on the roadmap.") and nowhere else.

Source: design spec § 3 (Deferred); decision-log D10; the front-end overhaul ledger Phase F closure (`fbf10a0`).

---

## Out of scope — vision only

The following are documented in `docs/00-vision/` as the long-term direction. They
are not built, not stubbed, and not referenced by any implementation code:

- Real backend, middleware, data integrations
- Reinforcement-learning compliance training and false-positive correction loops
- Marketplace billing, revenue share, third-party skills
- Onboarding flow
- Email / WhatsApp ingestion
- Bank partnerships

Source: design spec § 3 (Out of scope); decision-log D10

---

## Deployment

A deployed URL is documented in the design spec as part of the in-scope deliverable. **Creating the GitHub remote and deploying are Lance's manual gates, not the agent's.** Per decision-log **D3**, the GitHub remote, collaborator add, and any push/deploy are Lance's checkpoint. The agent builds local-only and has **not** created a remote, logged into Vercel, or deployed. The steps below are for Lance to run when he chooses.

### Zero runtime configuration

The seam (see "Where the seam is" above) means there is **nothing to configure at
deploy time**:

- **No environment variables.** `MockConductiaAPI` is fully self-contained:
  deterministic fixtures + pure scoring/compliance functions. No API keys, no
  database URL, no secrets. The deploy has zero runtime config.
- **No `vercel.json`.** Next.js 16 on Vercel is zero-config for a standard App
  Router build. The framework is auto-detected; build command and output are
  inferred. None was added (it would be speculative — YAGNI).
- **No `next.config` changes.** `next.config.ts` is intentionally empty. The build
  is fully static (see route table below); no rewrites, headers, or runtime
  options are needed.

### Build output (verified clean post-F5)

`npm run build` (`next build`, Turbopack) produces a fully static export across all eight routes. Every route prerenders as static content; no dynamic-server bail, no Suspense/CSR bailout:

```
Route (app)
┌ ○ /                    (Mandate)
├ ○ /_not-found
├ ○ /acquirers           (Landscape)
├ ● /acquirers/[id]      (Deep-dive — dynamic segment, prerendered per fixture)
├ ○ /dev-primitives
├ ○ /icon.svg
├ ○ /skills              (Catalogue)
└ ○ /team                (Compliance theatre)

○  (Static)         prerendered as static content
●  (SSG)            prerendered with generateStaticParams
```

There are no `ƒ` (server-rendered) routes. The dynamic `/acquirers/[id]` segment prerenders per fixture acquirer at build time.

### Steps for Lance (do not run unprompted — D3)

Either path works; both are zero-config.

**Option A — Vercel CLI** (from the repo root, authenticated as `lance-fp`):

```bash
vercel            # first run: link/create the project (preview deploy)
vercel --prod     # promote to production
```

- Build command: `next build` (Vercel auto-detects; no override needed).
- Install command: `npm install` (auto-detected from `package-lock.json`).
- Output: static `.next` build, served on Vercel's CDN.
- Environment variables: **none**.

**Option B — Vercel dashboard import:** create the GitHub remote first (Lance's
D3 checkpoint), push, then "Add New → Project → Import" the repo on
vercel.com under the `lance-fp` account. Accept all auto-detected defaults
(Next.js, `next build`, no env vars). Deploy.

### What the agent did NOT do

The agent did **not**: create or push a GitHub remote, run `vercel login`, run
`vercel` / `vercel --prod`, or otherwise deploy. It only ran a local read-only
`npm run build` to verify the output is static and deploy-ready. The remote and
deploy remain Lance's manual gates per D3.

Source: design spec § 3 ("In scope" — deployed URL) / § 9 (the seam = zero
runtime config); decision-log D3 (remote + deploy = Lance's checkpoint) / D8;
plan Task 6.3.

---

Source: design spec § 3/§ 9/§ 12; decision-log D3/D8/D9/D10; plan Task 1.6/6.3
