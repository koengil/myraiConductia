# develop-design Vision Build — Plan (lean, token-budgeted)

> Executes `docs/superpowers/specs/2026-07-08-develop-design-vision-spec.md`. Conductor-driven subagents (file-disjoint, no git ops in agents; conductor integrates, verifies, commits). Deviation from full TDD-format plan noted deliberately: token budget; the spec carries the contracts; exit criteria are the spec §6 gates.

**Verify commands:** `npx tsc --noEmit` · `npm run lint` · `npm run test` · `npm run build`

## WS0 (conductor, inline): ledger → rail generator
`scripts/hv/ledger_to_rail.py` emits `src/lib/rail/railData.generated.ts`: `GeneratedPhase[5]` (num, name, roles, tools), `GeneratedStep[65]` (seq, id `p{phase}-s{seq}`, phase, name, description, layer, buildOwner, executionClass, io, tools, priorityBuild), `GATE0_ACTIONS[4]`, `ALWAYS_ON_APPS[21]` (name, what, osBuildNum, priorityBuild). Types exported from the generated file; regeneration = Storm-correction path.

## WS1 (agent A): rail domain surgery — `src/lib/rail/`
- Files: `src/lib/rail/dealRail.ts`, `src/lib/rail/deals.ts`, `tests/**` that pin 26/7 or old step ids.
- Re-census `DEAL_RAIL` to 5 phases / 65 steps consuming `railData.generated.ts`. Extend `RailStep` with the generated fields + `skillId?` + keep `reality`, `agentFeatures`, cursor helpers, `railProgress`, `estimateTokens`, always-on split.
- Re-key `STEP_FEATURES` + `AgentFeature`s onto nearest canonical steps (teaser→seq 36 `live`; keep ≈2 features/step where sensible; unmapped steps `planned`). `FixtureDeal`: add `entryStepSeq`, `gate0Complete`.
- Update every test that breaks; suite green before handoff. NO UI changes.

## WS2+3 (agent B): the horizontal rail + step drawer — `src/components/rail/`, `src/app/(authed)/projects/[projectId]/rail/`
- New components: `RailTimeline` (horizontal scroll, phase lanes, scroll-snap, minimap/progress), `StationCard` (seq/name/owner/class chips, ★, reality badge, state marker, receipt line), `StepDrawer` (contract lanes: description, io, tools, approval, compliance; actions Run / Mark complete / Skip…; versions list), unified `StepRunner` (spine-backed for live teaser step via existing `TeaserRunner` internals; canned degraded mode from `AgentFeatureModal`; verdict → ONE ComplianceRibbon via `SET_COMPLIANCE`; collapse to receipt).
- Views: Full Array (timeline) ↔ Focus (current step elevated) toggle; always-on band (21 chips + popover).
- Skip flow: approval modal (approver, reason) → `skipped` state. Edit-after-complete affordance + versioned outputs (fixture versions).
- Keep navy tokens; gold single-accent duty; `@layer components` for any new semantic classes; reduced-motion.

## WS4 (agent C): gate-0 wizard + shell — `src/components/wizard/` (new), portfolio, Sidebar/AppNav/ProfileMenu
- `Gate0Wizard` 4 sub-steps (code name w/ existing mask+suggestions → team/permissions → notify compliance+mgmt as screened receipt → lifecycle entry point picker) → creates `FixtureDeal` (localStorage) → routes to rail at entry step. Portfolio "New mandate" CTA opens it.
- Sidebar: add Rail as first/primary deal destination; wire Logout to `supabase.auth.signOut()` (pattern in `ProfileMenu.tsx:66-71`); align mobile AppNav list. No other shell changes.

## WS5 (agent D): skills destination — `src/app/(authed)/projects/[projectId]/skills/`
- Governed library grouped by ledger phase: 65 step-skill cards (owner chip, class chip, ★, approval-state chip Proposed/Approved/Active — the 5 seam skills Active on their steps), detail = skill contract (io/tools/constraints). Rogo card grammar; no self-serve toggles.

## WS6 (conductor): integrate, verify, walk
tsc/lint/test/build gates; browser golden path per spec §6; fix-forward; commit per workstream; session close-out.

**Order:** WS0 → WS1 → (WS2+3 ∥ WS4 ∥ WS5) → WS6.
