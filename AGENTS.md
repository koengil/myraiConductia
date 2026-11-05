# Conductia: agent router

Read `README.md` first (what's built, current status), then this, then `docs/README.md`. The durable artifacts below are the source of truth, not any single conversation. `CLAUDE.md` imports this file; a gitignored `AGENTS.local.md` may add one person's local harness rules.

## What this is

A compliance-first M&A intelligence platform for **managing directors** (senior decision-makers, not junior analysts) running a sell-side process. The shell is **AI-native**: sign-in first; a signed-in user lands in the Command Center (`/` redirects to `/projects`), and deal work happens under `/projects/[projectId]`. `docs/` is co-equal with code.

## The thesis (do not drift from this)

- **Not Rogo.** Rogo answers "I want to buy Apple" with a data dump. Conductia surfaces only the *key decisions* an MD must make on a sell-side deal.
- **Compliance is the moat.** Every intent and every message visibly routes through compliance. The mandate intake itself is gated by a KYC→FINRA→MNPI screen.
- **You are the bank MD.** The user is the Managing Director running the deal (persona **Storm Duncan**). The sandbox deal is **Atlassian** (Mike Cannon-Brookes is the founder being *evaluated*, never the logged-in user).
- **Decisions, not data.** Sharp, surfaced, scored, never overwhelming.
- **Platform of destinations** (ADR-0004): reached from the persistent rail, not an auto-advancing slideshow.

## Engineering invariants (do not break)

- **Two contracts, kept apart:** M&A content goes through the typed `ConductiaAPI` seam (`src/lib/api/`; `MockConductiaAPI` returns fixtures; `docs/03-engineering/data-contracts.md`). Platform features (deals, members, documents, mail, discovery, rails) use versioned REST at `/api/v1/*`, which the UI also calls directly, through `apiV1` (`src/lib/api/v1Client.ts`), which throws on any non-2xx response. Never put platform calls inside the seam (`docs/03-engineering/api-v1.md`).
- **Scoring is deterministic:** acquirer scores are computed by a pure function (`src/lib/scoring/composite.ts`) over fixtures, never hardcoded.
- **Compliance is mounted exactly once:** the single live `[data-compliance-status]` instrument (`ComplianceRibbon`) is rendered by the top navigation (`TopBar`, or `TopNav` behind its flag) while inside a project. Routes and components dispatch `SET_COMPLIANCE` through the session store; they never self-display. The rail's compliance dot is decorative.
- **Project is URL state:** the active project is the `/projects/[projectId]` route segment, resolved through `useParams` (`src/lib/project/resolveProjectId.ts`), not session state. `/` redirects to `/projects` (the Command Center), which routes into it. Shell surfaces live under the `(authed)` route group, which only decides which routes get the shell chrome; authentication is enforced in `src/middleware.ts`.
- **Protected `/api/v1` handlers authenticate themselves:** most use `requireApiUser()` with the app-layer access predicates in `src/lib/api/v1/access.ts` and audit request-context events inline; discovery handlers use `requireApiUserScoped()` and row-level security instead. Follow the pattern of the route family you touch, and check its exceptions in `docs/03-engineering/api-v1.md`.
- **One team destination:** `/projects/[projectId]/team`. `/projects/[projectId]/working-group` is only a compatibility redirect, never a second surface.
- **SQL is the source of truth for enums:** TS constants in `src/lib/constants/*` mirror the SQL `CHECK` enums of the migrations.
- **Contrast contract:** light surfaces (`--surface*`) use dark ink (`--ink*`); dark surfaces (`--canvas-bg`) use light ink (`--ink-on-dark*`). Semantic type-ramp classes are wrapped in `@layer components` so Tailwind `text-[…]` utilities can override them (unlayered classes silently beat utilities: the root cause of past invisible-text bugs).
- **Design system:** new components and screens MUST compose from the Workbench register (`docs/design/workbench/`, start at `HANDOVER.md`).
- **Stack:** Next.js 16 (App Router), TypeScript, Tailwind 4 (custom CSS-variable tokens; shadcn patterns hand-rolled, not the dependency), Framer Motion, Vitest + RTL, Playwright, Supabase (Postgres + Auth). Fonts via `next/font`: Inter, Geist Mono for ids and figures, Georgia via `--font-display` for deal identity and source excerpts only.
- **Surgical changes only:** smallest correct change, follow the seam, no scope creep. Brand voice: senior, precise, decisive; statements, not questions; no em-dashes in visible copy (ARIA and regulatory separators excepted).

## Working rules

- **Done means merged to `develop` with the post-merge CI run green:** PR, one approval, the required checks green, squash merge. `develop` → `staging` → `main` move only by fast-forward (Promote Actions); `main` is the release snapshot, tagged `vX.Y.Z`.
- **Before pushing to a PR branch:** rebase onto the PR's **base** (`develop`, or the parent branch for a stacked slice), re-run the tests the change touches, then `git push --force-with-lease`. `develop` doesn't require an up-to-date branch to merge, so rebasing first keeps it green.
- **Keep CI cheap:** open PRs as drafts and mark them ready once; don't update many PRs from `develop` at once; Vercel skips previews for the owner's agent pushes, stacked slices and docs-only changes, and `[preview]` in a commit message forces one.
- **Append, don't rewrite:** add a decision-log or API-notes entry as its own paragraph or table row at the end of its section (`docs/07-decisions/decision-log.md` and `docs/03-engineering/api-v1.md` are the most-conflicted files).
- **Git identity:** commit under your own GitHub identity; CODEOWNERS requests review. Remote: `git@github.com:Conductia/Conductia.git`. Issue numbers restarted when the repo moved from `FutureProofingDev/intelibank` on 2026-09-03; older references are `intelibank#N`.
- **Parallel agents (D21):** subagents working in parallel get disjoint files, never run mutating git operations (stash, reset, checkout, worktree) and never commit; the conductor integrates, tests and commits.
- **Schema changes:** before writing a migration, read `supabase/AGENTS.md`. A migration file, merged through a PR, reaches hosted databases only through the Migrate database Action.
- **Repo guards:** a new script that spawns processes is listed in `tests/fixtures/mailboxReaderFence/nodeProcessModules.json`, and mailbox-derived table names appear only in the files `tests/agent-surfaces.test.ts` names as their homes.
- **Scope changes:** Storm approves them.

The full process (board, gates, releases) is in `docs/03-engineering/delivery-model.md`.

## Commands

`package.json` scripts are the source; the everyday ones:

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Lint / typecheck | `npm run lint` / `npx tsc --noEmit` |
| Unit tests | `npm test` (or `npx vitest run <paths>` for a targeted run) |
| Integration tests (local Supabase) | `npm run test:integration` |
| E2E (hermetic) | `npm run test:e2e` |
| Migration prefixes check | `npm run check:migrations` |

## Where things are

| Artifact | Path |
|---|---|
| What's built, current status | `README.md` |
| Docs map (all teams) | `docs/README.md` |
| Decisions and ADRs | `docs/07-decisions/decision-log.md` and `docs/07-decisions/ADR-*.md` |
| Engineering handbook (domain, governance, FINRA/SEC rulebook) | `docs/03-engineering/intelibank-handbook.html` |
| Design system of record | `docs/design/workbench/` (logos in `src/components/brand/assets/`) |
| What shipped, when | `CHANGELOG.md` |
| Raw verbatim source | `docs/99-source/` |
| Historical close-outs and reviews (point-in-time) | `docs/archive/` |
