# ADR-0005 — Sandbox merge disposition: what was kept from each repo

- **Status:** Accepted on 2026-05-20 (closed in Phase H of the merge ledger; pending Lance acknowledgement before any merge to `main`). *Later:* the font trio below changed with D48 (Fraunces dropped; Georgia via `--font-display`).
- **Date:** 2026-05-20 (drafted + accepted same day at Phase H close)
- **Commit hash range:** `9ae79c6` (Phase 0 scaffolding) → `0503fc5` (Phase G3 close). Phase H close-out commit lands this ADR's status flip + `MERGE-FINAL-VERIFICATION.md` at repo root.
- **Deciders:** Martin Casado (conductor + acceptance); Lance Marks acknowledgement pending before any push to `main` per D3.
- **Source:** `docs/archive/MERGE-REVIEW.md`; `docs/superpowers/plans/2026-05-21-sandbox-merge/master.md`; `MERGE-FINAL-VERIFICATION.md`.

## Context

Two repos were maintained in parallel during the front-end overhaul period: `intellibank` (Lance's, the foundation) and `intelibank-sandbox` (Martin's, an earlier exploration that retained unique technical bets and analytical content). A four-agent comparative review (engineering, product/UX, brand/visual/copy, docs/research) was performed on 2026-05-20 and synthesized to `docs/archive/MERGE-REVIEW.md`.

The review's overall conclusion: `intellibank` is the foundation on every infrastructure axis (seam architecture, brand system, IA, motion contracts, tests, docs, ledger discipline). `intelibank-sandbox` contributes substantive product and research content that the foundation lacks (compliance rule pack, weighted scoring + sliders, four analytical panels, editorial layout patterns, research substrate citing Bain / McKinsey).

This ADR is the *meta-record* of the merge: which artifacts crossed over, which did not, and why. It is the artifact a future maintainer reads to understand the divergence and its resolution.

## Decision

The merge keeps `intellibank` as the trunk and ports from `intelibank-sandbox` exactly the artifacts listed in `MERGE-REVIEW.md §Merge plan`, executed across phases B–G of the merge ledger.

Concretely, **kept from `intellibank`** (the foundation):
- The typed `ConductiaAPI` seam (`src/lib/api/`).
- The single-mount `ComplianceRibbon` contract (`[data-compliance-status]` mounted exactly once in the chrome).
- The deterministic composite-scoring function (pure, fixture-driven), extended per ADR-0002 to accept editable weights.
- The four-destination IA (`/` Mandate, `/acquirers`, `/team`, `/skills`) per D17 / ADR-0004.
- The 16-token brand contract, frozen Fraunces / Inter / Geist Mono trio (D14), motion contracts (`04-brand/motion-language.md`), and editorial-institutional voice rules (`04-brand/brand-foundations.md`).
- The docs skeleton (`00-vision` through `99-source`, superpowers ledger + spec pattern), the decision log (D1–D21 + new D22–D25), and the FINAL-VERIFICATION template.
- All 13 vitest test files, the golden-path lockstep policy, and the §4 em-dash policy from the front-end overhaul ledger.

**Ported from `intelibank-sandbox`** (in priority order, executed in phases B–G):
- The compliance rule pack (`screen.ts`) with three-state verdict and rewrite suggestions — ADR-0003.
- The weighted-mean scoring primitive with editable weights and the slider UI — ADR-0002.
- Four analytical panels: Football Field (valuation envelope), Synergy Stress-Test (mgmt claim vs Bain/McKinsey base rates), Founder Read (post-deal scenarios + retention-risk ladder), Culture toggle (Salesforce ↔ Anthropic with Bain four-fault-lines).
- Rotating-phase screening overlay during compliance scanning (timing trimmed from 6s to ~1.5s).
- `MandateBanner` tile + italic open-question pattern (re-rendered in Fraunces against `--ink` on `--surface-warm` with a `--positive-deep` hairline).
- `reqToken` async race-cancellation pattern (replaces A's `active` boolean guard).
- The network-boundary architectural lesson: a thin `/api/intellibank/*` route handler layer wrapping `MockConductiaAPI`.
- The `Skill.panel` refactor lesson: panel rendering belongs on the client, not in the wire contract.
- `app-pill-dot` pulse (mapped to A's `--positive-deep`).
- Research substrate from B's fixtures and commit history (Bain four fault lines, McKinsey synergy base rates, real May-2026 financials for the Atlassian fixture) — landed under `docs/06-research/` per the docs-review agent's recommendation.
- The NEEDS-DATA discipline (codified in `docs/03-engineering/conventions.md`).

**Explicitly not ported from `intelibank-sandbox`** (and why):
- `app/page.tsx` `DealRoom` single-surface composition — rejected by ADR-0004.
- `AppBar.tsx` "Sandbox · v0" branding and the footer "Sandbox · fixture data, real screening." — demo-tells (D19).
- Spelling "Conductia" (single L) — D18 enforces the double-L canonical spelling on every ported asset.
- Em-dashes in prose strings — D15 / §4 policy stripped at port time.
- 6-second artificial think delay magnitude — pattern ported, magnitude trimmed (hostility removed).
- `lib/llm/prompts/.gitkeep` — aspirational dead space.
- Google CDN font loading — A's `next/font` self-hosting is strictly better.
- Tailwind 3 + JetBrains Mono — A is on Tailwind 4 + Geist Mono.
- Navy color register — pending Phase G call (drop entirely, or admit as `data-surface="cinematic"` for specific panels).

## Alternatives considered

- **Adopt `intelibank-sandbox` as the trunk, port `intellibank` into it.** Rejected: A wins on every infrastructure axis (seam, brand, IA, tests, docs); inverting the trunk would re-do months of foundation work and lose D1–D21 of accumulated decisions.
- **Maintain both repos in parallel indefinitely.** Rejected: duplicates maintenance burden, splits the persona research substrate across two surfaces, and turns "which repo is canonical?" into a recurring question. The merge resolves it permanently.
- **Cherry-pick only the compliance rule pack and the four panels, leave everything else.** Rejected: the weighted-scoring mechanic is the single most "MD-grade" interaction available (per the review); leaving it would ship a less compelling product for no real reason.

## Consequences

- `intellibank` becomes the single canonical repo. `intelibank-sandbox` remains untouched as a historical reference (its commits encode design decisions worth preserving as artifacts).
- The merge ledger (`docs/superpowers/plans/2026-05-21-sandbox-merge/master.md`) is the durable execution record. Every phase commits to the feature branch `merge/sandbox-2026-05-21`; the branch is the merge surface.
- `docs/06-research/` (previously empty) is populated with the research substrate from B during Phase D / E.
- Four stale `intellibank` docs (`02-product/experience-spine.md`, `03-engineering/architecture.md`, `03-engineering/data-contracts.md`, `03-engineering/sandbox-vs-production.md`) are corrected in Phase A; their staleness predates this merge and is captured separately in the merge ledger's Phase A entry.
- This ADR is the source for any future "why was X / why not Y" question about the merge.

## Acceptance

**Accepted 2026-05-20** at Phase H close of the merge ledger. Every port landed; every verify gate green (tsc 0, eslint 0, vitest 19 files / 114 passed / 1 documented skip, `next build` Turbopack static-clean across 9 routes). `MERGE-FINAL-VERIFICATION.md` written at repo root. Commit hash range: `9ae79c6` (Phase 0 scaffolding) → Phase H close commit.

**The merge as planned in this ADR is now the merge as shipped on the feature branch.** Two scope evolutions beyond the original ADR-0005 plan landed during execution and are recorded here:

1. **`.nvmrc` pinning Node 22** (commit `f8aa01f`) — added between Phase A and Phase B after Phase B's `vitest 4` requirement exposed the user's default Node 20.12.2 as below the required engine. Pins the runtime so any future contributor / CI picks up the right Node version automatically.
2. **Phase G2 + G3 brand register pivot** (commits `09dd055`, `0503fc5`) — inserted between Phase G and Phase H after the user's visual walk-through and the supplied brand logo made it clear that the Editorial Institutional spec Lance authored (D13) was structurally producing a magazine-blog feel for the persona. The pivot is documented in ADR-0006 and reverses D13. Voice rules + four-destination IA + all B–G functional work survive intact under the new tokens. **Lance acknowledgement on ADR-0006 is the only remaining gate before any push to `main`** (per D3 — see open Lance gates in `MERGE-FINAL-VERIFICATION.md`).

These additions are honest evolutions, not scope creep — both were responses to verifiable signals (a broken Node engine; a real brand artifact arriving mid-merge). The ledger and `MERGE-FINAL-VERIFICATION.md` carry the full trail.
