# Ignatious skill library → Conductia — integration map

> **What this is.** The vertical skill library Ignatious handed to RTS on
> 2026-07-09 (Dan Dima-ala), reviewed and placed here as **reference / build
> input — not wired into the running app.** These are skill *definitions*
> (prompts, reference files, a couple of Python helpers), not application code.
> The platform *runs* skills through the orchestration spine
> (`docs/03-engineering/orchestration-spine.md`); RTS/FP build that mapping
> deliberately and surgically. Nothing here touches the Next.js runtime, so it
> cannot regress the product.
>
> Read `WALKTHROUGH.md` first (Dan's verbatim handoff). This file is our read on
> **where it fits and what to do with it.**

## What landed here (and what didn't)

| In the repo (text, 476 KB) | Kept OUT of the repo (binary, ~13.6 MB) |
|---|---|
| All 15 `SKILL.md` + 39 reference `.md` + 2 Python scripts (`validate_dcf.py`, `extract_numbers.py`) | The branded `.potx` template, sample decks (`.pptx`/`.pdf`), logos, images |
| The orchestrator agent def (`pitch-agent/agents/ignatious-pitch-agent.md`) + plugin manifest | — |
| Dan's walkthrough + one text sample | — |

**The binaries live in the shared Ignatious OneDrive / asset store** (the link in
Dan's email). They are not version-controllable and would bloat the repo; the
skills reference them by path. When a skill needs the template
(`references/Ignatious Powerpoint Template May 2026 for Claude.potx`), pull it
from the shared store — do not commit it here.

## The 15 skills, by provenance and maturity

Provenance matters for how much RTS trusts each as-is (Dan, §2/§4):

**★ Ignatious-original IP (battle-tested — study these closely):**
- `ignatious-partner-review` — 12-person SP panel + 6 specialist lenses + Storm/Kevin/Chris preferences → prioritized partner critique.
- `narrative-arc-positioning` — canonical IPO narrative arc distilled from 12 roadshow decks (13 company references included).
- `pptx-ignatious-branding-v6` — diagnose off-brand elements, apply brand XML → on-brand deck. *(brand XML/scripts reference the out-of-repo `.potx`.)*
- `ignatious-skill-calibrator` — meta-skill that tunes partner-review as new SP feedback arrives (prevents skill bloat).

**Solid QA reviewers (the reviewer-gating pattern — see below):**
- `audit-xls` (model integrity), `ib-check-deck` (deck consistency).

**Forked from Anthropic's `financial-services` plugin (starting points, not yet Ignatious-grade):**
- `dcf-model` (most engineered — ships `validate_dcf.py` + `TROUBLESHOOTING.md`), `comps-analysis`, `lbo-model`, `3-statement-model`, `sector-overview`, `pitch-deck`, `deck-refresh`, `pptx-author`, `xlsx-author`.

## How it maps onto our platform

Ignatious's **WAT** (Workflows + Agents + Tools) is, essentially, what our
**orchestration spine** already is:

| Ignatious (WAT) | Conductia |
|---|---|
| Workflow (markdown SOP) | A horizontal **rail** / workflow (the 5-phase, 65-step spine) |
| Agent (Claude coordinator) | The **Orchestrator** state machine (`src/lib/orchestration/orchestrator.ts`) |
| Tool (deterministic Python) | The `CapabilityAgent` swap-seam — deterministic execution behind the contract |
| Skill (one unit of capability) | A **vertical step-skill** on the rail (RTS builds these) |
| Reviewer/QA skill gates output | The **ComplianceSupervisor** + the paired-reviewer gating pattern (`skill-authoring-rules.md`, rule 5–6) |
| `ignatious-pitch-agent` (chains 12 skills) | A **workflow rail** an MD runs (e.g. the pitch/CIM path) |

The two problems Dan asks RTS to own map to work our platform is already shaped for:

- **5a Reliability / determinism** → push execution into tools + structured output contracts + a golden-output eval harness. Our seam already forces a typed `CapabilityAgent` contract and an `auditRecord`; the eval/regression harness is greenfield (they have none) and high-leverage. See `skill-authoring-rules.md` rules 1–2, 6.
- **5b Orchestration / chaining** → state, typed hand-offs, retry, cost budgets, **reviewer-agent gating**. This *is* the orchestration spine (`orchestration-spine.md`): deterministic orchestrator, leashed actors, compliance supervisor over the graph, `AWAIT_SIGNOFF` gates, `TokenMeter`. Their v0.1 markdown-SOP orchestrator is the thing our spine replaces.

## Recommended next steps for FP + RTS (surgical, non-breaking)

1. **Adopt the skill contract.** Have each skill conform to `skill-authoring-rules.md` (the io contract + compliance/audit/gating). The 3 IP skills are the reference quality bar.
2. **Map skills → rail steps.** Cross-walk the 15 skills onto the 65-step rail (`docs/06-research/hv-extraction/ledger/hv-ledger.json`) — several already line up (partner-review ↔ the review/QC steps; narrative-arc ↔ teaser/CIM; comps/dcf/lbo ↔ the valuation steps).
3. **Wire the pitch chain into the spine** as the first workflow rail — replacing the v0.1 SOP with the deterministic orchestrator + reviewer gating.
4. **Stand up the eval harness** (golden outputs per skill) — the single highest-leverage gap Dan flags, and the thing that makes "reliability" measurable.
5. **Supply/stub the missing helper deps** Dan lists (§6): `recalc.py`, `examples/*.xlsx`, `scripts/office/` — inherited Anthropic-host assumptions; note them per skill before running standalone.

## What NOT to do

- **Do not wire these into the Next.js app runtime.** They are backend/orchestration inputs; the front-end product is untouched.
- **Do not commit the binaries** (template, sample decks, logos) — reference the shared store.
- **Do not treat the forked financial skills as hardened** — they need Ignatious-grade hardening (Dan, §4/§6).
- **Do not act on the external skills-registry URL** as anything but reference (https://ignatious-skills-registry.vercel.app/ — their 48-skill planning registry).

---

*Reviewed & placed 2026-07-10. Source: Ignatious "06. Ignatious Skills Handoff
for RTS" (Dan Dima-ala, v1 2026-07-09). Related: `WALKTHROUGH.md` (verbatim),
`docs/02-product/skill-authoring-rules.md`, `docs/03-engineering/orchestration-spine.md`.*
