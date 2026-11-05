# develop-design Vision Spec — The Rail Becomes the Product

**Date:** 2026-07-08 · **Branch:** `develop-design` · **Status:** approved for build (Lance delegated; final review at end)
**Inputs:** `hv-ledger.json` (verified: 5 phases / 65 steps / 21 apps / gate 0 / 16 priorities), `conflict-log.md`, `digests/codebase-map.md`, `digests/rogo-ui-findings.md`, `digests/rogo-skills-inventory.md`, repo CLAUDE.md invariants.

## 1. Thesis

The horizontal rail IS the deal. This build replaces the vertical 7-phase/26-step checklist (PR #62) with the canonical **5-phase / 65-step horizontal timeline**, adds the **Gate 0 wizard**, hangs **vertical skills** off every step, and surfaces the **always-on layer** — with Rogo's trust plumbing (receipts, provenance, governed skills) fused onto Conductia's compliance-first identity. Mock data; polish-first; a vision artifact both teams can align on.

**Rogo synthesis in one line:** steal the skill-contract format, receipts grammar, single-accent discipline, and governed-library card grammar; generalize Rogo's one object-bound skill into all 65 steps; refuse prompt-dependence, model opacity, cost opacity, and compliance-as-footnote.

## 2. Invariants (unchanged, from repo CLAUDE.md + codebase map)

Seam (`ConductiaAPI` only), deterministic scoring, ONE `ComplianceRibbon` via `SET_COMPLIANCE`, project = URL state, contrast contract + `@layer components` ramp, token/palette matrix untouched (re-skin values only where specified), motion system + reduced-motion, brand voice (no em-dashes in visible copy), Next 16 / Tailwind 4 / Vitest. Nothing pushed to origin.

## 3. Data layer (WS1) — the single most important change

- **Generator script** `scripts/hv/ledger_to_rail.py`: `hv-ledger.json` → `src/lib/rail/railData.generated.ts` (typed const). Deterministic; regenerating after Storm's corrections re-skins the app.
- **Type surgery on `src/lib/rail/dealRail.ts`:** re-census 7/26 → **5 phases (1–5) / 65 steps**; extend `RailStep` with `seq, layer ('vertical'|'hybrid'), buildOwner ('rts'|'futureproofing-os'), executionClass ('A'|'A+H'|'H+A'|'H'), io {inputs, transformation, outputs, constraints}, tools: string[], priorityBuild: boolean, skillId?: string` (typed id replacing the free-text `skill:` label — unifies rail step ↔ seam `Skill.id` ↔ workflow name). Phases carry `roles`/`tools` (whiteboard panels). Keep: `reality` axis (live/schema/planned), cursor-derived `state`, `stepAgentFeatures()` precedence, localStorage persistence (vision build).
- **Gate 0 model:** `GATE0_ACTIONS` (4, from ledger) + `FixtureDeal.entryStepSeq` (lifecycle entry point) + per-deal `gate0Complete`.
- **Reality mapping:** `draft-teaser`-equivalent step (Seq 36 Teaser) = `live` (TeaserRunner); steps with existing canned `AgentFeature`s = `schema`; rest = `planned`. Render the axis honestly (it exists in data today but is invisible).

## 4. Surfaces

### 4.1 The Rail (WS2) — `/projects/[id]/rail`, horizontal
- **Full Array view:** horizontal scroll timeline — continuous rail line, 5 phase lanes (serif phase headers: numeral, name, roles-today), 65 station cards (seq, name, owner chip FP/RTS, class chip mono, ★ priority, reality badge, state marker done/active/todo), phase jump minimap + progress ("n of 65 · Phase 2"). Scroll-snap per phase; keyboard navigable; virtualized only if needed (65 cards is fine unvirtualized).
- **Focus view:** the current step as a full card (the D1 drawer content elevated): description, io contract lanes, tools, approval gate, compliance notes, deadline/priority tag, versioned outputs list, actions (Run skill / Mark complete / Skip…). Prev/next station strip.
- **Always-on band** below the rail: 21 apps as chips (★ on the 4 priorities), click → detail popover. Grammar from D1 timeline.
- Design: existing navy tokens; **gold on single-accent duty** (primary actions, ★, cleared-provenance marks — Rogo steal #1); timeline gutter grammar (Rogo steal #11); hairlines over boxes.

### 4.2 Step drawer + unified runner (WS3)
- One **StepDrawer** (right panel, earned like Rogo's sources panel) replacing the divergent `AgentFeatureModal` vs `TeaserRunner` paths: loader → artifact → compliance verdict → audit line, backed by the orchestration spine where live (Teaser), canned features as degraded mode.
- **Receipts grammar (Rogo steal #3):** every run collapses to "Screened · KYC ✓ FINRA ✓ MNPI ✓ · 12s ›" expandable receipt on the station card; routes through the ONE ComplianceRibbon.
- **Skip flow:** logged approval modal (approver + reason; reason routes onward) → station renders `skipped` state. **Edit-after-complete:** completed steps stay editable; outputs listed as versions (Valuation V1/V2 pattern).
- **No model exposure** (Rogo skip #2): runner shows depth in plain language if anything.

### 4.3 Gate 0 wizard (WS4)
- 4 sub-steps from the ledger: code name (reuse `/insight` mask validation + deterministic suggestions) → team & permissions (roles from fixtures) → notify compliance & management (rendered as a logged, screened notification receipt) → lifecycle entry point (pick the entering phase/step → sets cursor). Entry: portfolio "New mandate" CTA. Writes `FixtureDeal` (localStorage; `POST /api/v1/deals` swap stays mechanical).
- Completing Gate 0 lands on the Rail at the entry step, ribbon green.

### 4.4 Navigation + shell (WS4)
- Sidebar: **Rail becomes the deal's primary destination** (first entry, default landing for a deal); wire the inert Logout to `supabase.auth.signOut()` (stranded in ProfileMenu); keep other destinations. Mobile AppNav list aligned to Sidebar's.
- Mandate dashboard demoted to vitals panel (nav order after Rail); no rebuild, just order + copy.

### 4.5 Skills destination reframe (WS5)
- Governed library (Rogo steal #8): cards grouped **by phase from the ledger** (65 step-skills; RTS-owned vertical + FP hybrid marked), card grammar = icon, name, 2-line description, owner chip, class chip, ★, **approval state chip (Proposed / Approved / Active)** instead of self-serve toggles. The 5 live seam skills map to their steps as `Active`; detail view shows the skill contract (io, tools, constraints — Markus's framework, from ledger).

## 5. Out of scope (protected)

No backend/API wiring beyond what exists; no CIM/model-building skills (canon exclusion); no chat-as-home; no model pickers; no prompt-per-column tables; no per-party rail derivation (stays 3-persona fixture); no new palette system; landing page untouched; existing tests preserved (updated only where the rail census legitimately changes them).

## 6. Exit criteria

`npx tsc --noEmit` 0 · `npm run lint` 0 · `npm run test` green (rail-census tests updated) · `npm run build` clean · browser golden path: portfolio → New mandate → Gate 0 (4 sub-steps) → Rail (Full Array ↔ Focus) → run Teaser step → receipt + ribbon → mark complete → skip a step with reason → versioned output visible → always-on band → skills library by phase.

## 7. Workstreams & order

WS1 data (blocks all) → WS2 rail surface + WS3 drawer/runner (one agent, same files) ∥ WS4 wizard+nav ∥ WS5 skills — file-disjoint — → WS6 conductor integration + verify + browser walk.
