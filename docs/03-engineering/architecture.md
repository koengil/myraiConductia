# Architecture — Conductia Sandbox

The build is a Next.js 16 App Router application. The **product content** layer is
client-driven: it flows through a typed API interface (the seam) backed by
deterministic mocks. Since ADR-0007 (feature flags) and ADR-0008 (the Phase 1
auth/deals/audit spine) the app also has a real **backend** — Supabase (Postgres +
RLS) — reached through two boundaries that sit *beside* the seam, never inside it:
`src/lib/flags/` (infrastructure) and `/api/v1/*` (the platform: identity, deals,
memberships, documents, audit). See the [Backend (Phase 1)](#backend-phase-1)
section below.

For what the application does — the platform experience — see
[`../02-product/experience-spine.md`](../02-product/experience-spine.md). For the
scoring formula and factor methodology, see
[`../02-product/matrices.md`](../02-product/matrices.md). This document covers
how it is built.

---

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Tailwind · Framer Motion ·
hand-rolled primitives (no shadcn dependency) · Supabase (Postgres, Auth, Storage) · Vitest + @testing-library/react · Playwright

Source: design spec § 9; decision-log D7

---

## The seam

The single most important structural decision (D8):

`src/lib/api/index.ts` exports one function:

```typescript
export function getApi(): ConductiaAPI
```

`getApi()` returns a `MockConductiaAPI` instance. Every UI component calls
`getApi()` and depends only on the `ConductiaAPI` interface — never on fixtures,
never on the mock class directly. This is the swap point. To connect a real backend:
implement `ConductiaAPI`, change `getApi()`, touch nothing else. Zero UI rewrite.

The full interface definition lives in [`data-contracts.md`](./data-contracts.md).

Source: design spec § 9; decision-log D8; plan Task 1.6

---

## Backend (Phase 1)

The seam stays mock-backed; the backend is reached through two boundaries beside it.

- **`src/lib/flags/`** (ADR-0007) — infrastructure feature flags over a
  `feature_flags` table. See [`feature-flags.md`](./feature-flags.md).
- **`/api/v1/*`** (ADR-0008) — the platform spine: identity, deals, memberships,
  documents, and audit, over the migrated permissions schema
  (`supabase/migrations/20260604100000_permissions_schema.sql`). Route handlers
  self-authenticate (`src/lib/api/v1/http.ts`), enforce access with app-layer
  predicates (`src/lib/api/v1/access.ts`), and audit request-context events
  inline. The endpoint reference, auth model, and dev explorer (`/dev-api`) are in
  [`api-v1.md`](./api-v1.md).

Identity is Supabase Auth, mirrored into `public.users` by a trigger. Auth is
gated in `src/middleware.ts` (redirect to `/sign-in`); the active project is the
`/projects/[projectId]` URL segment (`src/lib/project/resolveProjectId.ts`), not
session state. The shell is mounted by the `(authed)` route group.

Source: ADR-0007, ADR-0008; decision-log D27, D28.

---

## Component layers

Four layers, each depending only on the layer below:

**Atoms** (`src/components/atoms/`): `AvatarInitials`, `Button`, `Card`, `Badge`,
`Pill`, `ScoreDial`, `SegmentedControl`. Branded base UI components. No API calls.

**Shell** (`src/components/shell/` + `src/components/compliance/` + `src/components/brand/` + `src/components/profile/`): the chrome that stays mounted across every route. `AppRail`, `AppShell`, `AppNav`, `ComplianceRibbon`, `ProfileMenu`, `Wordmark`. Composed by `AppShell` in the `(authed)` route-group layout (`src/app/(authed)/layout.tsx`); `src/app/layout.tsx` only sets the palette and fonts.

**Domain components** (`src/components/`): consume `ConductiaAPI` and session
state; render the destinations. Key components:

| Component | Responsibility |
|---|---|
| `AppHeader` / `AppNav` / `ProfileMenu` | Chrome; mounted once in layout |
| `ComplianceRibbon` | Single mounted `[data-compliance-status]`; reads `complianceStatus` from session |
| `SkillShelf` / `SkillCard` / `Canvas` | Skill catalogue + drag-and-drop workspace; orchestrates skill run → compliance → panel |
| `FinancialMatrixPanel` / `CultureRadarPanel` / `ScoreBreakdownPanel` | Analysis output panels |
| `AcquirerCard` / `AcquirerLandscape` / `PeerStrip` | Acquirer ranking and peer context |
| `TeamDrawer` / `MessageComposer` | Compliance theatre |
| `PaywallLock` | Premium skill gate modal |
| `CatalogueSkillCard` | Catalogue tile (free vs Pro treatment) |

**Route segments** (`src/app/(authed)/**/page.tsx`): the project picker at `/` and one segment per destination under `/projects/[projectId]` (`acquirers`, `acquirers/[id]`, `team`, `skills`). Each composes shell + domain components for that destination. Unguarded routes (`sign-in`, `dev-api`, `dev-primitives`) sit at the top of `src/app/`, outside the `(authed)` shell. (2026-06-05 routing reframe — ADR-0008.)

Source: design spec § 9 + § 10; the front-end overhaul ledger Phase F closure (`fbf10a0`).

---

## Session store

A single client-side React context (`src/lib/session/store.ts`) carries ephemeral session state across destinations. The store holds compliance status, accumulated canvas panels, the selected acquirer id, and (for now) a residual `stage` field. A pure `sessionReducer` handles transitions.

Navigation between destinations is done by Next.js App Router segments — not by a state machine. Phase F of the front-end overhaul (commit `fbf10a0`, 2026-05-20) deleted the six stage UI components (`src/components/stages/*`) and the spine chrome (`GuidedControls`, `ProgressSpine`) along with seven spine-only tests when the platform replaced the linear demo flow. The reducer machinery that *drove* those components (the `Stage` discriminated union in `types.ts`, `STAGE_ORDER` in `session/store.ts`, the `SessionState.stage` field, and the `NEXT` / `BACK` actions) was **not** deleted in F5 — it survives as residue. No UI surface dispatches `NEXT` or `BACK` post-F5; no component reads `state.stage`. The residue continues to be exercised only by `tests/session.test.ts`, which still asserts the stage cycling behavior.

The store itself is genuinely load-bearing: compliance status and panel accumulation are still cross-destination concerns, and `useSession()` is the access point for them. Components dispatch via `useSession().dispatch({ type: 'SET_COMPLIANCE', status: 'scanning' })`, `ADD_PANEL`, `SELECT_ACQUIRER`, `RESET`. The `NEXT` / `BACK` / `stage` parts are awaiting a dedicated cleanup phase.

Source: design spec § 9; the front-end overhaul ledger Phase F closure; sandbox-merge ledger Phase A correction entry (2026-05-20).

---

## Pure logic modules

Two modules carry no React and no side effects:

- `src/lib/scoring/composite.ts` — `computeCompositeScore(fitInputs): CompositeScore`.
  Pure function; the 87 (Anthropic) and 67 (Salesforce) are computed from fixture
  inputs, never hardcoded in the view layer (D9).
- `src/lib/compliance/screen.ts` — `screenMessage(body): ComplianceCheckResult`. Pure
  function; the three-state rule screen (ADR-0003; FINRA Rule 2210 communications
  standards). It replaced `rules.ts` in Phase B.

`MockConductiaAPI` delegates `getAcquirerScore` and `sendMessage` to these modules.

Source: design spec § 9; decision-log D9; plan Tasks 1.4/1.5/1.6

---

## State model

Two layers. The M&A content behind the `ConductiaAPI` seam is client state over
fixtures (`MockConductiaAPI`, #82). The platform state (identity, deals, rail steps,
documents, mail, audit, flags) is persisted in Supabase and reached through the
versioned `/api/v1` route handlers (ADR-0008, `api-v1.md`); there are no server
actions. The `SessionProvider` (`src/lib/session/store.ts`) wraps `useReducer` and is
mounted in the `(authed)` layout, alongside `FlagsProvider`.

Source: design spec § 9; plan Task 1.7

---

Source: design spec § 9; plan File structure + Tasks 1.1/1.6/1.7
