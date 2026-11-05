# Ignatious AI Skills & Agents — Handoff for RTS Labs
### Prepared for RTS Labs engineering (Sveto, Markus, Kyle) · following the 07/09 current-applications call
**Author:** Dan Dima-ala (Junior Partner, Ignatious) · **Audience:** RTS Labs engineering · **Version:** 2026-07-09 v1

> **How to use this.** On the call you asked us to export our skills and give you the context around them — what we're trying to do, what "good" looks like, and where they work well vs. where they miss. This doc is that context. It's a banker's-eye account of the skill library we run today, how it's built, and the two things we most need you to solve: **reliability (non-determinism)** and **orchestration (stringing skills together).** The actual skill files ship alongside this doc — the manifest is in §7. Nothing here is theoretical; every skill named exists in the repo today.

---

## 1. What we're trying to do — the WAT framework

Everything is organized around one bet, spelled out in the repo's root `CLAUDE.md`:

> *"When AI tries to handle every step directly, accuracy drops fast. If each step is 90% accurate, you're down to 59% success after just five steps. By offloading execution to deterministic scripts, you stay focused on orchestration and decision-making."*

So the architecture separates three layers — **WAT (Workflows, Agents, Tools):**
- **Workflows** — markdown SOPs that define objective, inputs, which tools to call, expected outputs, edge cases. Plain language, the way you'd brief a junior.
- **Agents** — the decision-maker (Claude). Reads the workflow, sequences the work, handles failure, asks when unsure. Coordinates; doesn't try to do everything itself.
- **Tools** — deterministic Python that does the actual execution (API calls, file ops, transforms). Consistent, testable, fast.

**A "skill" is one unit of banker capability** — build a comps set, populate a pitch deck, review a model the way a partner would. Today most skills still do their execution *in-model* (Claude generating the artifact directly). The WAT goal is to push the fragile parts into tools. **We're partway there, and that gap is exactly the reliability problem in §5.**

**Where we are today:** ~16 unique skills (built or forked), a first orchestrator that chains 12 of them end-to-end, and a planning registry of **48 skills** mapped to **5 intended orchestrators.** We're reliable at the "one skill, one task" level. We are *not* yet reliable when skills are chained, or when a skill has to generate a binary (PowerPoint / Excel).

---

## 2. What's in the repository

The library lives in one WAT monorepo. Skills grouped by function below; **maturity** is our own read of how hardened each is (see the tiers in §4).

**Provenance matters for your planning:** 11 of the financial/deck skills are a **fork of Anthropic's `financial-services` reference plugin** — solid starting points, but not yet hardened to our standard. The genuinely **Ignatious-original, proprietary** skills — the ones that encode our institutional knowledge and are our real IP — are **`ignatious-partner-review`, `narrative-arc-positioning`, and `pptx-ignatious-branding-v6`.** Those three are where the differentiation lives.

### Skills

| Skill | What it does (in → out) | Output | Maturity |
|---|---|---|---|
| **ignatious-partner-review** ★ | Deck/CIM/teaser + which SP → 12-person banker panel + 6 specialist lenses + Storm/Kevin/Chris's actual preferences → prioritized partner-level critique | md review | Battle-tested |
| **narrative-arc-positioning** ★ | Positioning ask → canonical IPO narrative arc + positioning moves distilled from 12 roadshow decks → slide arc, opening/closing, category claim | md guidance | Battle-tested |
| **pptx-ignatious-branding-v6** ★ | Existing .pptx → diagnose off-brand elements, apply brand XML (gradients, Arial, palette, logos) → on-brand deck + a diagnostic of what it could/couldn't fix | pptx + report | Battle-tested |
| **audit-xls** | Spreadsheet/model → formula + integrity audit (BS balance, cash tie-out, model-type bug catalogs for DCF/LBO/merger/3-stmt) → severity-ranked findings | md report | Solid (QA) |
| **ib-check-deck** | Deck → number-consistency across slides, data-narrative alignment, IB language polish, visual QC → severity report | md report | Solid (QA) |
| **dcf-model** | SEC/analyst data → projections, WACC, sensitivity → institutional Excel DCF + exec summary | xlsx | Solid fork (most engineered; ships `validate_dcf.py` + `TROUBLESHOOTING.md`) |
| **comps-analysis** | Peer set + market data → trading multiples & statistical benchmarking → Excel comps | xlsx | Fork — not yet hardened |
| **lbo-model** | LBO template → fill formulas, validate, format for PE/IC | xlsx | Fork — not yet hardened |
| **3-statement-model** | IS/BS/CF template → complete with linked live formulas | xlsx | Fork — not yet hardened |
| **sector-overview** | Sector → market dynamics / competitive / thematic landscape | md + Excel appendix | Fork — light |
| **pitch-deck** | PPT template + source data → populate slides (not build from scratch) | pptx | Fork — see §4 (fragile) |
| **deck-refresh** | Existing deck + new numbers → find/replace every disguised variant of a figure across slides | pptx | Fork |
| **pptx-author** / **xlsx-author** | Headless — write a .pptx/.xlsx to disk when there's no live Office app | pptx/xlsx | Thin utilities |
| **ignatious-icon-creator** | Word/phrase → 256×256 isometric SVG header icon in our style | SVG | In progress |
| **docsend-to-pdf** | Docsend URL → headless Chromium screenshots each slide (auto-clears the email gate) → local PDF | PDF | Stable utility |

★ = Ignatious-original / proprietary. There is also an **`ignatious-skill-calibrator`** — a meta-skill that tunes `ignatious-partner-review` as new SP feedback comes in, deciding what's genuinely new vs. already covered so the skill doesn't bloat.

### Agents & apps (context — mostly separate workstreams)
- **`ignatious-pitch-agent`** — the orchestrator that chains 12 skills into a first-draft pitch, end to end. **This is the most important thing in the package for your purposes** (see §5b).
- **`ignatious-crm`** — an Investor/Buyer Intelligence Platform (Airtable-based) built off Storm's objectives + Ricardo's prototype. Its own Phase-0 build; ties to the "light CRM" idea from the call. Separate from the pitch skills — included for context, not part of the core ask.
- **Ignatious Intelligence Brief (IIB)** — a working WAT app: monitors SharePoint + a team Google Doc, scores each change for materiality, and emails a weekly signal digest. It's our proof that the WAT model works *when execution is pushed into deterministic tools.*

---

## 3. What "good" looks like

Different skill types have different bars:

- **A review skill** (`ignatious-partner-review`): a prioritized critique that reads like Storm, Kevin, or Chris actually wrote it — tied to specific pages, framed the way each SP frames things (e.g., never calling a client's product a present-day failure; always locating the "why Ignatious"). Not generic slide feedback.
- **A model skill** (`dcf-model`): an institutional Excel model with *live linked formulas* (not hardcoded), a defensible WACC, a working sensitivity table, the balance sheet balancing, and cash tying out. An associate should be able to open it and trace every number.
- **A generation skill** (`pitch-deck`): a populated, on-brand deck with **real table objects** (not tab-separated text), consistent fonts across same-level boxes, the same figure identical on every slide it appears, and no leftover placeholder boxes — passing the skill's own QA checklist, then validated by a human in PowerPoint.

The general bar we hold (from the IIB quality spec, and it applies to everything): **output an analyst would put their name on — not chatbot filler.** If it reads like AI wrote it, it fails.

Exemplars ship in the package: the branded `.potx` template, the 12 reference roadshow decks behind the narrative skill, and the real SP-feedback email threads behind partner-review.

---

## 4. What works vs. what misses — the pattern

The single most useful thing we can tell you: **reliability tracks the output type.**

**Reliable — text / judgment output.** `ignatious-partner-review`, `narrative-arc-positioning`, `ib-check-deck`, `audit-xls`, `sector-overview`. Same input → materially consistent output, because the artifact *is* the reasoning. These rarely "miss."

**Non-deterministic — binary generation.** `pitch-deck`, `pptx-ignatious-branding-v6`, and the Excel models. Same input → variable output. This is the "sometimes it's great, sometimes it misses and we're not sure why" you flagged on the call. The misses show up as:
- font substitution and gradient/render drift, because **we validate with LibreOffice and it does not render PowerPoint faithfully** — so a slide can pass validation and still be wrong in actual PowerPoint;
- placeholder-format bleed (data dumped into the template's colored instruction boxes instead of replacing them);
- fake tables (tab/pipe-separated text instead of real table objects);
- in models: `#REF!`s, hardcodes over formulas, terminal value >80% of EV, case-selector bugs.

**We didn't discover these failure modes for this doc — the skills already document their own.** See `pitch-deck`'s "⚠️ Critical Rendering Limitation," `pptx-ignatious-branding-v6`'s "Known Limitations — Read Before Starting," and `dcf-model`'s `TROUBLESHOOTING.md`. Each generation skill runs a validate → fix → escalate loop (max 3 cycles, then it flags what it couldn't fix), which *mitigates* but cannot catch what LibreOffice itself can't see.

**Why it misses, in one line:** generation happens in-model against fragile Office XML, the validator is itself unreliable, and there is **no golden-output regression test anywhere in the repo.** Fixing that is most of §5a.

**Maturity tiers, explicitly:**

| Tier | Skills |
|---|---|
| Battle-tested (our IP) | `ignatious-partner-review` (+ calibrator), `narrative-arc-positioning`, `pptx-ignatious-branding-v6` |
| Solid QA reviewers | `audit-xls`, `ib-check-deck` |
| Working fork, not yet Ignatious-grade | `dcf-model` (most polished), `comps-analysis`, `lbo-model`, `3-statement-model`, `sector-overview` |
| Thin utilities | `pptx-author`, `xlsx-author`, `docsend-to-pdf` |
| In progress | `ignatious-icon-creator` |

---

## 5. The two problems we most need you to own

### 5a. Reliability / determinism
Make skill output **repeatable and verifiable.** Concretely:
- push the fragile execution out of the model and into deterministic tools (the WAT intent — most skills aren't there yet);
- replace LibreOffice-based validation with real rendering/verification that matches PowerPoint/Excel;
- define structured output contracts per skill so a result can be checked, not eyeballed;
- **stand up an eval / regression harness with golden outputs** — we have none today. Our own registry lists an "AI Learnings Log" as *not started*; there's no consolidated what-works-what-fails record yet. This is greenfield and high-leverage.

### 5b. Orchestration / chaining
This is the "we can't string skills together" pain point — and the key thing to know is **we already have a first attempt you can build on, not a blank page.** `ignatious-pitch-agent` chains **12 skills across a 10-step workflow** — scope → `sector-overview` → `narrative-arc-positioning` → market-data pull → `comps-analysis` → `lbo-model` → `dcf-model` + `3-statement-model` (audited per `audit-xls`) → football field → `pitch-deck` → `pptx-ignatious-branding-v6` → `ib-check-deck` → `ignatious-partner-review` — with **stop-for-review gates** after the model and after the deck.

But it's a **markdown SOP run by a subagent, v0.1.0.** No state management, no typed hand-offs between skills, no retry/recovery, brittle. What we need from you:
- a real orchestration layer — state, typed hand-offs, retry, cost/step budgets;
- **reviewer-agent gating** — every skill ships with a checker that gates its output before the next step (we've started this pattern with the three QA skills; it lines up with how the Intelibank platform team wants to work);
- support for the **5-orchestrator model** in our registry (Pitch Deck Builder, Sell-Side Process Runner, Valuation & Market Intelligence, Market Coverage Builder, Management Presentation Builder), not just the one pitch chain.

### 5c. Sharing (smaller, but real)
The skills live in one repo but **aren't shared across the team** — today you ping whoever built a skill for the `.md` file. Distribution needs solving (this is the Gemini Enterprise setup from the call). Worth doing alongside, because a skill nobody can find gets rebuilt badly.

---

## 6. Known gaps / what you'll need from us

Setting expectations honestly so nothing surprises you:
- **Missing helper dependencies.** Several forked skills call files that aren't in the bundle — `recalc.py` (dcf, 3-statement), `examples/*.xlsx` (comps, lbo), `scripts/office/` (branding). These are inherited assumptions about an Anthropic host runtime. Only two helper scripts actually ship: `validate_dcf.py` and `extract_numbers.py`. You'll need these supplied or stubbed to run standalone — tell us what you need and we'll get it.
- **No eval/test harness or learnings log yet** (see §5a).
- **The forked financial skills** (comps/lbo/3-statement/sector) need hardening to our standard; treat them as starting points.
- **From us, on request:** sample inputs/outputs for any skill, the branded template and style guides, the 48-skill registry, and named points of contact per skill.

---

## 7. What's in this package

A shared folder (the OneDrive link in the email) plus one live web link.

**In the folder:**
- **This walkthrough** — read it first; you can also feed it straight into Claude to get oriented fast.
- **`ignatious-pitch-agent.zip`** (8.2 MB) — the full pitch-agent: all 14 bundled skills + our branded template and logos + the orchestrator SOP. The single best thing to open — it shows both the skills *and* how we chain them.
- **`ignatious-pitch-agent-slim-test.zip`** (162 KB) — the same tree without the binaries, if you just want to skim the structure in five minutes.
- **Our three proprietary skills** — `ignatious-partner-review.skill` (+ `ignatious-skill-calibrator.skill`), `narrative-arc-positioning.skill`, and `pptx-ignatious-branding-v6.zip`. These are our own IP and the ones worth studying closely; the rest of the pitch-agent is forked from Anthropic's financial-services plugin.

**Live link — the skills roadmap:** our 48-skill planning registry, mapped to five orchestrators, with status and priority — **https://ignatious-skills-registry.vercel.app/**. It's how we've thought about what to build (not yet aligned firm-wide, but it gives you the full picture).

*(The three proprietary skills are byte-identical to their copies inside the pitch-agent zip — nothing to reconcile; the pitch-agent just expects them inside its `skills/` folder. `ignatious-crm` and the Intelligence Brief app are separate workstreams, left out here — happy to walk you through either.)*

---

## Appendix — glossary for engineers
- **Skill** — one unit of capability, defined by a `SKILL.md` (frontmatter description + instructions), sometimes with reference files and helper scripts.
- **Agent** — Claude acting as coordinator: reads a workflow/SOP, sequences skills and tools, handles failure.
- **Workflow** — a markdown SOP describing what to do and how, in plain language.
- **Tool** — deterministic Python that does the actual execution.
- **Orchestrator** — an agent that chains multiple skills into an end-to-end deliverable (e.g., `ignatious-pitch-agent`).
- **WAT** — Workflows + Agents + Tools; our core architecture (§1).
- **SP** — Senior Partner (Storm Duncan, Kevin Finn, Chris Hayes).
- **QA / reviewer skill** — a skill whose job is to check another skill's output (`audit-xls`, `ib-check-deck`, `ignatious-partner-review`).
