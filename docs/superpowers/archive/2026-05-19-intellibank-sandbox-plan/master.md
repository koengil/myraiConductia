# Conductia Sandbox — Master Ledger

> **READ THIS FIRST on any resume — by any session or subagent.**
> Execution state lives here, not in chat. Update this file at every phase
> boundary and commit it.

**Goal:** A guided, clickable, deployable Conductia sandbox demo (Atlassian
sell-side) plus the distilled `/docs` foundation library.

**Architecture:** Next.js 16 App Router client-driven guided flow. UI depends
only on a typed `ConductiaAPI`; a `MockConductiaAPI` returns fixtures.
Composite scoring + compliance checks are pure deterministic modules. Approach C
(ADR-0001): guided spine + one real hero canvas.

**Tech stack:** Next.js 16, TypeScript, Tailwind, Framer Motion, Vitest +
Testing Library, shadcn-style hand-rolled primitives.

---

## Resume protocol (do this every cold start)

1. Read this file (phase table + change log).
2. Read the spec: `docs/superpowers/specs/2026-05-19-intellibank-sandbox-design.md`.
3. Read `docs/07-decisions/decision-log.md` (D1–D11) + `ADR-0001`.
4. Read `plan.md` in this directory; resume at the first unchecked task of the
   first incomplete phase.
5. Never reconstruct intent from memory or chat — the repo is authoritative.

## Phase table

| # | Phase | Mode | Status | Verify gate |
|---|-------|------|--------|-------------|
| 0 | Foundation docs distillation (`docs/00`–`05`) | Sequential subagents | ☑ Done | Each doc traceable to `99-source/`; map updated — VERIFIED |
| 1 | App scaffold + design system + **the seam** (types, mock API, scoring, compliance, session) — strict TDD | Opus impl, parallel batches | ☑ Done | All Vitest pass; `getAcquirerScore` → 87/67 exact — VERIFIED (14/14 tests, tsc 0, build clean) |
| 2 | Compliance ribbon + session step machine + page orchestrator shell | Opus impl, sequential | ☑ Done | Stage machine transitions; ribbon 4 states — VERIFIED (25 tests, tsc 0, build clean) |
| 3 | Spine screens: cold open · intent · acquirer landscape + peer strip | Parallel Opus + conductor integ | ☑ Done | Golden path steps 1–3 click-through — VERIFIED (33 tests double-run stable, tsc 0, build clean) |
| 4 | Hero canvas: skill shelf · drag→transform→compliance→panel · 3 panels · paywall lock | Parallel Opus + integ + specialist swarm | ☑ Done | Step 4–5 wow beat lands; scores from module — VERIFIED (51 tests double-run, tsc 0, build clean, hardened) |
| 5 | Compliance theatre: team drawer · composer · clear/blocked beat | Opus impl + silent-failure-lens review | ☑ Done | Step 6 beat: clean sends, profane blocked — VERIFIED (56 tests double-run, tsc 0, build clean, send machine hang-proof) |
| 6 | Motion polish · pitch-prep CTA · graceful stubs · Vercel deploy config | Parallel Opus (6.1/6.3) + cross-cut 6.2 | ☑ Done | Full golden path no jank; CTA inert; build OK — VERIFIED (59 tests double-run, tsc 0, static build, golden-path smoke test) |
| 7 | Verification swarm vs spec §3 · surgical fixes · dry-run · hand-off | Parallel Opus swarm + hardening | ☑ Done | All §3 success criteria GREEN — VERIFIED; see FINAL-VERIFICATION.md |

Status legend: ☐ Not started · ◐ In progress · ☑ Done (verified).

## Verification protocol (return-to-plan, every phase boundary)

After the last task of a phase, BEFORE starting the next:

1. Re-read spec §3 success criteria + the phase's deliverables.
2. Confirm every phase task checkbox in `plan.md` is genuinely done (run the
   commands, see the output — evidence before assertion).
3. Surgical correction pass: smallest correct change only; follow the seam;
   no scope creep beyond the phase.
4. Update this file: set phase status, append a Change Log entry with the
   commit hash and any deviations/decisions.
5. Commit (`chore(ledger): phase N verified`).

## Subagent dispatch rules

- **Freeze shared contracts before parallel work:** Phase 1 must be ☑ before
  Phases 3/4 subagents run. `ConductiaAPI` types, design tokens, and the
  session store are the contract; subagents consume, never redefine them.
- Each subagent is dispatched with: this file + the spec + its specific
  `plan.md` task. It returns a diff + the verification output for its task.
- Only dispatch surfaces that are genuinely independent (distinct screens,
  distinct panels, distinct docs). Integration happens at the phase boundary,
  inline, with the verification protocol above.
- **Review-depth split (decided 2026-05-19, Lance-approved):**
  - **Prose docs (Phase 0):** front-loaded hard authoring rubric (recurring
    failure modes + curated cross-doc ownership) → ONE combined verification
    subagent (spec-accuracy + quality) → fix once, controller verifies the fix
    diff directly (no extra review subagent for trivial fixes). Lean, ~2–3
    dispatches/doc.
  - **Code (Phase 1+):** FULL two-stage adversarial review retained —
    implementer → spec-compliance reviewer → code-quality reviewer → fix loops
    until both ✅. Correctness-critical (deterministic scoring, the seam,
    compliance gating); do NOT lean this out.

## Anti-context-loss protocol

Authoritative, committed, never chat-only: this ledger · `plan.md` · the spec ·
`99-source/` (verbatim) · `07-decisions/`. Memory pointer:
`project_intellibank.md`. Any session reconstructs from these alone.

## Open dependencies (non-blocking)

- Martín's research → `docs/06-research/` (feeds skills catalog, scoring methodology).
- Martín's GitHub username (WhatsApp) → collaborator add.
- GitHub remote creation → **Lance's checkpoint**; commands handed off at Phase 7.

## Change log

_(Append one entry per phase verification. Newest at bottom.)_

- 2026-05-19 — Plan + ledger created and committed. Phases 0–7 defined. No code yet.
- 2026-05-19 — **Method change (Lance-approved):** the literal per-task
  two-stage adversarial review proved too heavy for low-risk prose (≈7
  dispatches/doc on 0.1–0.2, all catching preventable authoring issues).
  Switched Phase-0 docs to: front-loaded hard rubric → 1 combined verification
  → fix-once with controller-verified diff. Full two-stage adversarial review
  is RETAINED for Phase 1+ code (correctness-critical). Phase-0 mode in the
  table updated Parallel→Sequential (subagent-driven-development forbids
  parallel implementers).
- 2026-05-19 — **Phase 0 ☑ DONE & VERIFIED.** Commits: 0.1 `e9e0587`+`aaa5b30`;
  0.2 `5a5500f`+`98e9ec8`+`9d4fa5f`; 0.3 `d333673`+`b5bc2d3`; 0.4 `ffe177e`+`1837f4e`;
  0.5 `373f4dd`. `docs/00`–`05` distilled, every section source-cited to
  `99-source/` or spec/plan/decision-log, no transcript paste, no fabrication,
  no cross-doc duplication; `docs/README.md` all rows → Distilled; visual
  tokens extracted from rogo.ai with observed-vs-assumed flagged; type contract
  reproduced verbatim in `03-engineering/data-contracts.md`. Next: Phase 1
  (code, strict TDD + full two-stage review) — freeze the `ConductiaAPI`
  contract before any Phase 3/4 fan-out.
- 2026-05-19 — **FINALIZED EXECUTION MODEL (Lance-directed, autonomous run).**
  Implementers + fix agents + per-phase consolidated reviews + specialist
  agents = **Opus** (the important pieces). Sonnet only for trivial mechanical
  checks. File-disjoint, contract-frozen tasks dispatched in **parallel
  batches**; parallel agents do NOT commit (conductor commits sequentially to
  avoid git races). Per task-batch/phase: **one consolidated review** (not
  per-task review→fix→review loops) + objective gates (full `vitest run` +
  `tsc --noEmit` + `next build`) as primary correctness signal; surgical
  `/docs`-anchored fixes, once. Specialist agents (pr-review-toolkit
  code-reviewer · silent-failure-hunter · code-simplifier) deployed at
  high-risk checkpoints (Phase 4 hero canvas, Phase 7 swarm). Conductor
  anchors every dispatch on `master.md`/`plan.md`/spec/`99-source` + the
  distilled `/docs`. Mandate: complete Phases 2–7 autonomously; then produce
  a full per-phase/sub-phase verification checklist proving completion +
  adherence to `/docs`/master/spec/`99-source`, demo-ready & fully functional.
- 2026-05-19 — **Phase 1 ☑ DONE & VERIFIED.** Commits `805cf01` (types) →
  `674c34e` (fixtures) → `5b7b049` (scoring) → `825d1c2` (compliance) →
  `5af4ca6` (session) → `c095372` (mock+seam); + scaffold `999d707`/`22f22e0`,
  Next.js-16 adoption `1f182ea` (D12). Consolidated Phase-1 review: PASS —
  14/14 tests (6 files), `tsc` 0, `next build` clean; `types.ts` verbatim vs
  `data-contracts.md`; 87/67 deterministic via `computeCompositeScore` (no
  hardcode, no `Math.random`); 5-skill contract + premium lock + FINRA-2210
  compliance + single `getApi()` seam all verified; zero scope creep. The
  `ConductiaAPI` contract is now FROZEN — Phase 2/3/4 fan-out authorized.
  Next: Phase 2 (ribbon + orchestrator shell).
- 2026-05-19 — **Phase 2 ☑ DONE & VERIFIED.** Commits `7f50c23` (brand
  primitives + design tokens), `9cbc7b7` (ComplianceRibbon — 4 states,
  compliance-pulse motion), `4f6c901` (stage orchestrator shell +
  GuidedControls). Consolidated Phase-2 review (Opus): PASS — 25 tests
  (9 files), `tsc` 0, `next build` clean, no Suspense/CSR bailout. Token
  fidelity exact vs `visual-language.md`; ScoreDial Score-Reveal motion;
  ribbon reads `useSession` (presentational, blocked-reason correctly
  deferred to Phase 5); layout wraps `SessionProvider`+ribbon; `page.tsx`
  exhaustive 6-stage switch (throwaway stubs); GuidedControls Next/Back via
  `STAGE_ORDER` + `?present=1` (no `useSearchParams` bailout). `src/lib/**`
  + frozen contract UNMODIFIED; no new deps. Plan correction: preview route
  `__primitives`→`dev-primitives` (Next private-folder rule; route verified
  200). `CLAUDE.md` "Next.js 15"→"16" corrected at this gate (D12 consistency).
  Next: Phase 3 (spine screens — parallel Opus fan-out: ColdOpen · Intent ·
  Landscape).
- 2026-05-19 — **Phase 3 ☑ DONE & VERIFIED.** 3 stages built in parallel
  (Opus), conductor-integrated commit `eeddba5`. Consolidated review (Opus):
  PASS — 12 files / 33 tests double-run stable, tsc 0, `next build` clean.
  ColdOpen (pre-onboarded MCB/Atlassian, no onboarding) · Intent (prefilled
  mandate → scanning → FINRA/MNPI/KYC cascade → clear → NEXT, motion-language
  timing) · Landscape (live `getAcquirerScore` → Anthropic 87 / Salesforce 67,
  ranked desc, peer strip, select → SELECT_ACQUIRER+NEXT). `page.tsx` wires
  real coldOpen/intent/landscape + `data-stage` wrapper; deepDive/
  complianceTheatre/pitchCta still stubs. Frozen contract + `src/lib/**`
  UNMODIFIED; no new deps. **Engineering knowledge (anti-context-loss):** the
  `intent.test` full-suite timeout root cause = Framer Motion's process-global
  RAF frame-loop orphaned when a later file swaps to vitest fake timers
  (jsdom has no `matchMedia` so Framer takes the animated path); fixed
  STRUCTURALLY by stubbing `matchMedia`→reduced-motion in that test (RAF-free
  deterministic path), NOT by raising the timeout. **Known latent item (not
  blocking; `isolate:true` default makes it moot today):** `src/test/setup.ts`
  lacks a global `afterEach(cleanup)`; only matters if a future phase moves to
  a non-isolated vitest pool — add `import {cleanup} from
  '@testing-library/react'; afterEach(cleanup)` then. Next: Phase 4 (hero
  canvas — high-risk; specialist agents code-reviewer + silent-failure-hunter
  + code-simplifier at the gate).
- 2026-05-19 — **Phase 4 ☑ DONE & VERIFIED.** Batch-A parallel Opus (shelf
  `4.1`, panels `4.3`, paywall `4.4`) → cohesive Canvas+DeepDive+page wiring
  commit `d587786` → **specialist swarm** (code-reviewer APPROVED;
  silent-failure-hunter found CRITICAL unguarded `handleDrop` →
  permanent-`scanning` dead-canvas hang; code-simplifier P1/P2; consolidated
  PASS) → **hardening pass** `97da47e`: Canvas `try/catch/finally` recovery
  (compliance always leaves `scanning`, `busyRef`/stream always reset),
  shared loud+validated `resolveAcquirerId` (no silent `?? 'anthropic'`),
  guarded `DeepDive.load()` (explicit loading/ready/error), guarded
  `SkillShelf` load, DRY `src/lib/util/clamp.ts`, `useReducedMotion`
  consistency, + a regression test (bad drop → recovers to `idle` → next
  valid drop still works). Conductor gate (first-hand): 16 files / 51 tests
  double-run stable, tsc 0, `next build` clean; net diff = Phase-4 components
  + 2 additive utils + tests; **frozen contract (`src/lib/api|scoring|
  compliance|session`) grep-confirmed UNMODIFIED**. Severity lesson recorded:
  "can't happen on the happy path" ≠ "safe for a live founder demo" — async
  state machines get error-recovery before demo. **Deferred (not blocking,
  noted for future):** simplifier P3 (Icon primitive), P5 (CultureRadar
  `count`/clamp-once), P6 (`cn` util) — YAGNI now, revisit if a 5th
  glyph/util need arises. Next: Phase 5 (compliance theatre — headline
  compliance proof; consolidated review + silent-failure pass).
- 2026-05-19 — **Phase 5 ☑ DONE & VERIFIED.** Commit `89a63e2` (sole Opus
  impl). TeamDrawer (guarded `getTeam`; explicit loading/ready/error) +
  MessageComposer (Send `try/catch/finally` — catch→`idle`+visible notice,
  finally clears `sending` every path, unmount-safe; Phase-4 hardening lesson
  applied PROACTIVELY) + ComplianceTheatre; `page.tsx` wires complianceTheatre
  (only `pitchCta` stub remains). Blocked reason rendered inline from the live
  `sendMessage` result `compliance.reasons[0]` (frozen `rules.ts` FINRA-2210),
  NOT a store/type extension — Phase-2 deferral honored. Consolidated review
  with explicit silent-failure lens (Opus): PASS — 17 files / 56 tests
  double-run stable, tsc 0, build clean; Step-6 spine exact; diff `096c0f6..
  89a63e2` = 6 files, ZERO `src/lib/**`/ribbon/primitive/dep changes. Cosmetic
  note: spec literal `fromId:'md'` vs fixture MD id `'mcb'` — frozen mock
  ignores from/to ids (compliance keys off body only), functionally inert;
  honored spec verbatim, flagged for a future real backend. Next: Phase 6
  (PitchCta inert + cross-cutting motion/graceful-stub polish + deploy config;
  6.1 & 6.3 parallel Opus, then 6.2 cross-cutting).
- 2026-05-19 — **Phase 6 ☑ DONE & VERIFIED.** 6.1 PitchCta inert dead-end +
  full page wiring (commit `7596cfc`, ALL 6 stages real, zero stubs,
  `orchestrator.test` STUB_STAGES=[]); 6.3 deploy doc (`8ea23c4`, zero-config
  /zero-env confirmed, static build, remote+deploy = Lance D3 gate, agent did
  NOT deploy); 6.2 cross-cutting polish (`edb0409`) — fixed 2 real motion
  defects (SkillCard missing the §2 lift beat; PitchCta ad-hoc easing →
  documented §2 250ms easeOut), graceful-stub audit clean (no dead-ends; all
  inert controls captioned), `?present=1` confirmed app-wide, + new
  `tests/golden-path.test.tsx` driving coldOpen→…→pitchCta through REAL
  components asserting ribbon status at every beat and failing on any
  `console.error`. Conductor gate (first-hand): 19 files / 59 tests double-run
  stable, tsc 0, `next build` static-clean; Phase-6 diff = stages/page/
  skillcard/docs/tests only; frozen `src/lib/(api|scoring|compliance|session)`
  grep-confirmed UNMODIFIED. The full demo now runs end-to-end. Next: Phase 7
  (comprehensive verification swarm — code-reviewer + silent-failure-hunter +
  code-simplifier + spec-§3 coverage in parallel; golden-path dry-run; Lance
  hand-off + the full per-phase/sub-phase demo-readiness verification report).
- 2026-05-19 — **Phase 7 ☑ DONE & VERIFIED — BUILD COMPLETE, DEMO-READY.**
  7.1 whole-app swarm (Opus): code-reviewer APPROVED; silent-failure-hunter
  found 2 CRITICAL pre-existing gaps (ColdOpen + Landscape async loads
  unguarded — predate the Phase-4 hardening lesson); code-simplifier R1;
  spec/`99-source` fidelity verifier = DEMO-READY YES (full matrix). →
  Pre-demo hardening `0f28aa6`: ColdOpen + Landscape retrofitted to the
  proven DeepDive/TeamDrawer `LoadState` tri-state + explicit non-hanging
  error UI + loud missing-MD fallback; dead `streamTransition` removed;
  Canvas dead `?? 'anthropic'` seed dropped; **eslint 7 errors → 0**; R1
  shared `_shared/motion.ts`; +3 regression tests (Landscape/ColdOpen error
  paths + loud-missing-MD). 7.2 conductor final gate (first-hand): **62/62
  tests (19 files) double-run stable, tsc 0, eslint 0, `next build`
  static-clean, golden-path test passes**; `src/lib/**` = **+534/−0 vs main**
  (contract additive-only, never mutated post-creation). 7.3 →
  `FINAL-VERIFICATION.md` (full per-phase/sub-phase checklist + spec §3 matrix
  + `99-source` fidelity matrix + integrity proof + deferred items + Lance
  hand-off). **All 7 phases ☑.** Remaining = HUMAN gates only (D3: Lance
  creates GitHub remote via `github.com-fp`, adds Martín, deploys to Vercel —
  exact commands in FINAL-VERIFICATION.md §7). `main` clean at foundation;
  all build work on `build/intellibank-sandbox` (37 commits).
