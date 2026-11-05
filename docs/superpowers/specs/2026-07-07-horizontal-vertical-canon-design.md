# Horizontal/Vertical Canon → Two Deliverables — Design

**Date:** 2026-07-07
**Author:** Lance + Claude (brainstorming session)
**Status:** Awaiting Lance approval
**Branch:** `develop-design` (off `develop` @ 9d5665d)

---

## 1. Problem & Goal

Two teams build Conductia for Ignatious (Storm's firm): **Futureproofing** owns the horizontal layer (workflow engine, rails, orchestration, audit) and **RTS** (Markus, Svetozar) owns the vertical layer (per-step agents and skills). The process knowledge lives scattered across draft docs (Dan's Master Process 2.0 + Execution Guide), whiteboard photos, lifecycle diagrams, call notes, and the repo's own product docs. Nothing is canonical, the horizontal/vertical split is not yet agreed, and the current app on `develop` predates the rails-first framing.

Two deliverables, one source of truth:

- **D1 — Team alignment doc + diagram** (due to Storm EOD 2026-07-07/08): a simple, accurate horizontal/vertical timeline of the entire sell-side deal lifecycle — every phase, every step (~82), owners, inputs/outputs, human-vs-agent split. Format: interactive HTML one-pager + Google-Docs-ready text doc. Storm reviews 1-on-1 before the wider group.
- **D2 — `develop-design` vision app**: full vision rebuild of the Conductia app where the horizontal rails timeline is THE core surface and vertical skills layer onto each step, with Rogo-grade UI/UX. Mock data, polish-first; a design/alignment artifact for both teams.

**North star:** one canonical dataset (the *extraction ledger*) consumed twice — rendered for humans (D1) and rendered as software (D2). Storm's D1 review validates the dataset before the app build invests in it.

## 2. Source Material

| Source | Role |
|---|---|
| `~/Downloads/intelibank-101/` (9 files: Product Blueprint v11, Seed Deck 10, Vision 2-pager, handbook HTML, Founders Planning Session, RTS meeting notes, Rob demo notes, Rogo one-pager) | The canon. Read FIRST; grounds every downstream agent. |
| `~/Downloads/intelibank-horizontal-vertical/` (Master Process & Build Sequence 2026-07-08 v2, Execution Guide 2026-07-08 v2, Compliance Build Plan, deal-lifecycle.png, deal-lifecycle-notes.png, whiteboard 2026-07-07.png) | Primary extraction target. Docx files are authoritative over PNGs (Lance's instruction). |
| Lance's call notes (Ignatious workflows & pain points — in this session) | Authoritative on: 4 pre-deal gates, MVP definition, skip/edit semantics, versioned outputs, team responsibilities. |
| Repo `docs/02-product/` (deal-lifecycle-rails.md, skills-catalog.md, rogo-skills-gap-map.md, experience-spine.md, etc.) | Team's current understanding. Cross-check input — conflicts flagged, not silently resolved. |
| `~/Downloads/rogo-research/` (teardown/skills-library/what's-new HTMLs, webarchive, 10 screenshots, Slack + Q&A rtf notes, one-pager PDF) | UI/UX + skills-platform reference for D2. Local archive first; live Rogo login (provided) only if gaps. |
| Repo `develop` branch code | Current app reality: IA, seam, components, orchestration. |

## 3. Architecture: The Extraction Ledger

All extraction lands in `docs/06-research/hv-extraction/` on `develop-design`:

```
docs/06-research/hv-extraction/
  sources/            # converted text of every source file (traceability)
  digests/
    101-canon.md      # the Conductia 101 digest every agent reads first
    rogo-ui-findings.md
    rogo-skills-inventory.md
    codebase-map.md
  ledger/
    hv-ledger.json    # THE canonical dataset (schema below)
    conflict-log.md   # source disagreements → questions for Storm
    verification.md   # adversarial verification results
```

### 3.1 Ledger schema (per step)

```jsonc
{
  "id": "P3-S04",             // phase-scoped stable id
  "seq": 27,                   // global order on the horizontal timeline
  "phase": "marketing",       // canonical phase (see 3.2)
  "subPhase": "outreach",     // optional grouping within a phase
  "name": "...",
  "description": "...",
  "layer": "horizontal | vertical | hybrid",  // hybrid = vertical built by horizontal team (e.g. deal onboarding routing)
  "buildOwner": "futureproofing | rts | ignatious-process",
  "executor": "human | agent | human+agent",
  "io": {                      // Markus's input/output framework
    "inputs": [{ "what": "...", "format": "...", "source": "api|file|human|prior-step" }],
    "transformation": "...",
    "outputs": [{ "what": "...", "format": "..." }],
    "constraints": ["...edge cases, guardrails for AI..."]
  },
  "tools": ["..."],            // tools/systems used at this step (from the Ignatious sell-side card + guides)
  "approval": { "required": true, "by": "md|compliance|client" },
  "compliance": ["...touchpoints..."],
  "skippable": { "allowed": true, "requiresApproval": true, "skipRoutesTo": "P3-S06" },
  "editableAfterComplete": true,
  "versionedOutputs": ["Pitch Valuation V1", "Advocacy Valuation V2"],  // where applicable
  "sourceRefs": [{ "doc": "master-process-v2", "loc": "§4.2" }],        // EVERY step traces to sources
  "confidence": "high | medium | low",
  "conflicts": []              // ids into conflict-log.md
}
```

Ledger top level also carries: `phases[]` (canonical phase list with names/order), `gate0` (the 4 pre-deal actions: assign team, create code name, notify compliance + management, confirm lifecycle entry point), `openQuestions[]`.

### 3.2 Canon resolution rules

- Docx v2 files (dated 2026-07-08 — freshest) > lifecycle PNGs > repo docs > older 101 decks, for **process facts**.
- Lance's call notes are authoritative for **semantics** (skip/edit rules, gate 0, MVP framing, team split).
- The 7-phase lifecycle PNG (mandate → preparation → marketing → diligence → negotiation → signing → close) vs. any 5-phase mapping in the Master Process: extract BOTH, propose a canonical mapping, log the conflict for Storm.
- No source disagreement is ever silently resolved. Conflict log entries carry both readings + a recommendation.

## 4. Phase Plan

Multi-agent orchestration via the Workflow tool (explicitly requested). Hard gates marked ⛔. Every agent prompt REQUIRES reading `digests/101-canon.md` (and later, the ledger) before its own task — this is how "the same agent's context" carries across the program.

### Phase 0 — Source conversion (inline, no agents)
pandoc/textutil/unzip: docx→md, pptx→text (slide XML extraction), rtf→txt, webarchive→html, into `sources/`. PDFs and PNGs are read natively by agents. Sanity-check each conversion is non-empty/legible.

### Phase 1 — Extraction fleet ⛔
1. **101 sweep** (3 parallel agents, distinct lenses): product vision/strategy; process & workflow facts; teams/roles/build responsibilities + Rob-demo/RTS-meeting signals. Synthesis agent merges → `digests/101-canon.md`.
2. **H/V sweep** (parallel, each reads 101-canon first): one agent per source — Master Process v2, Execution Guide v2, Compliance Build Plan, PNG trio (multimodal), call notes — each emits candidate ledger entries (structured output) + candidate conflicts. Plus a **repo-docs cross-checker** over `docs/02-product/`.
3. **Ledger synthesis** (1 agent): merge candidates → `hv-ledger.json` + `conflict-log.md`, applying §3.2 rules.
4. **Adversarial verification** (parallel verifiers, one per phase of the lifecycle): sample every step, check source traceability, step count vs. sources (~82), gate 0 presence, H/V classification justified, io fields non-empty for high-confidence steps. Failures → fix → re-verify.
**Gate:** verification green.

### Phase 2 — Build D1 ⛔
- **HTML one-pager** (`docs/02-product/horizontal-vertical-timeline.html`, self-contained): horizontal timeline of phases → steps; gate-0 block before step 1; vertical skill stacks per step; owner badges (FP/RTS) + executor badges (human/agent/both); filters (team, phase, executor, layer); print-friendly. Renders from the ledger JSON embedded inline. Also deployed as a private Artifact link for easy sharing.
- **Google-Doc text** (`docs/02-product/horizontal-vertical-map.md`): exec summary; the H/V model in plain language; phase-by-phase step tables (id, name, owner, executor, inputs→outputs, layer); gate 0; build-responsibility split (FP vs RTS vs Ignatious); open questions for Storm. Paste-ready for Google Docs.
- **Render verification** (1 agent): diff both artifacts against the ledger — every step present, none invented, counts match, badges correct.
**Gate:** Lance review → Storm 1-on-1. Storm's corrections are applied to the LEDGER (not the artifacts), then D1 re-renders.

### Phase 3 — Rogo + codebase research (runs during the Phase-2 review window)
- **Rogo fleet** (parallel): teardown reader; skills-library reader; what's-new + one-pager reader; webarchive reader; 2 multimodal screenshot analysts (5 PNGs each — layout, nav, chat/skill-runner patterns, model/source pickers, tables/artifacts); Slack + Q&A notes reader. Synthesis → `digests/rogo-ui-findings.md` (design language: layout system, nav, color/type, component patterns, interaction flows) + `digests/rogo-skills-inventory.md` (skills taxonomy, how skills are invoked/configured, model + internal/external source selection, Felix-style flows). Live login (credentials held by Lance, supplied in-session, never committed) used ONLY if the archive leaves material gaps, via Chrome tools.
- **Codebase fleet** (parallel): IA/route mapper ((authed) routes, navigation, page inventory); design-system auditor (tokens, Tailwind config, components/ui-atoms-molecules, brand); seam + orchestration analyst (API layer, types, orchestration tests, supabase schema); build/test infra surveyor. Synthesis → `digests/codebase-map.md`.

### Phase 4 — Design synthesis ⛔
Design spec for the vision app (separate spec doc, same folder): IA + screen inventory; the rails timeline surface (Focus view = current step; Full Array = all 82 on the horizontal rail — mirrors Roberto's two-view pattern, elevated); step detail with vertical skill runners (Rogo-style invocation, model/source affordances where relevant); 4-gate deal-creation wizard; skip-with-approval flow; versioned outputs on steps (Valuation V1/V2); edit-completed-steps; omnipresent compliance ribbon + audit trail; ledger-driven fixture layer. A small judge panel scores the draft against: ledger fidelity, Rogo design parity, team mergeability, simplicity.
**Gate:** Lance approves the design spec.

### Phase 5 — Build on `develop-design` ⛔
writing-plans → subagent-driven execution in workstreams: (1) fixture/data layer from ledger JSON; (2) app shell + nav; (3) rails timeline; (4) step detail + skills; (5) creation wizard + skip/approval/versioning flows; (6) compliance/audit surfaces. Integration + polish pass at the end.
Exit criteria: `tsc` 0, eslint 0, build clean, existing tests green (updated where the vision legitimately changes behavior), full browser walkthrough of the golden path (create deal → gate 0 → walk rails → run skill → approve → complete step → skip flow → versioned output → audit view).
**Gate:** Lance final review. Nothing pushed to origin until Lance says push.

### Phase 6 — Closeout
Session report, memory update, archive scratch, share-ready summary for the team.

## 5. Timing

- **Today (07-07):** Phases 0–2. D1 in Lance's hands for the Storm sync.
- **Review window:** Phase 3 runs while Storm reviews.
- **After Storm's corrections:** ledger updated → D1 re-rendered → Phases 4–5.

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Source conflicts (phase count, step ordering, H/V classification not yet agreed) | Conflict log + open-questions section in D1; docx-v2-over-PNG precedence; Storm decides — the process is designed around his review. |
| Step count ≠ exactly 82 | Report actual count with per-source breakdown; no padding to hit a number. |
| pptx/webarchive conversion fidelity | Phase-0 sanity checks; multimodal reads of PNGs; live Rogo login as fallback for archive gaps. |
| Team-repo etiquette (org repo, other collaborators) | All work stays on `develop-design`, local until Lance pushes. Repo docs in 02-product get NEW files; existing team docs are cross-referenced, not rewritten, until the team aligns. |
| D1 deadline pressure | D1 depends only on Phases 0–2; Rogo/codebase work deferred to the review window; HTML artifact + md doc are cheap to re-render from the ledger after corrections. |
| Rogo credential use | Only if archive is insufficient; read-only browsing; never committed to the repo. |

## 7. Out of Scope

- Backend/real data integration for D2 (mock/fixture-driven by design).
- Modifying the team's existing `docs/02-product/*.md` content.
- Building actual RTS skills — D2 shows where skills live and how they're invoked, not their implementations.
- Pushing/merging to `develop`; PR creation happens only on Lance's instruction.
