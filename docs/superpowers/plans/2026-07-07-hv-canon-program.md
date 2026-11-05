# Horizontal/Vertical Canon Program — Implementation Plan (Phases 0–4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This program is conductor-driven: fan-out tasks run via the Workflow tool; gates pause for Lance/Storm.

**Goal:** Build the canonical extraction ledger from the three source folders, render it as the D1 team doc + HTML timeline (due to Storm 07-07/08), complete Rogo + codebase research, and produce the approved D2 design spec — leaving the D2 build governed by its own follow-on plan.

**Architecture:** Disk-based shared knowledge (`docs/06-research/hv-extraction/`) is the "same agent" memory: every agent writes findings to disk and every downstream agent reads the digests first. Fan-outs are Workflow scripts; synthesis and artifact authoring are conductor-inline; hard gates sit between phases.

**Tech Stack:** pandoc, textutil, python3 (stdlib only), Workflow tool (multi-agent), Read (multimodal for PNGs/PDFs), self-contained HTML for the timeline artifact.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-07-horizontal-vertical-canon-design.md` (source precedence §3.2; ledger schema §3.1 including `tools`; risk table §6).
- Branch: `develop-design` only. Nothing pushed to origin until Lance says push.
- No credentials in any committed file. Live Rogo login only if the local archive leaves material gaps.
- Conflicts between sources are logged, never silently resolved (conflict-log.md → "questions for Storm").
- Step count is reported as found, never padded to 82.
- Existing team docs in `docs/02-product/` are cross-referenced, not modified. D1 lands as NEW files.
- Every extraction claim carries `sourceRefs`. Verifiers reject untraceable steps.
- Commit at the end of every task with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Phase 0 — Source conversion

### Task 0.1: Knowledge-base scaffold + convert all sources

**Files:**
- Create: `docs/06-research/hv-extraction/{sources,digests,ledger}/` directories
- Create: `docs/06-research/hv-extraction/sources/MANIFEST.md`
- Create: converted text files under `sources/` (one per source doc)
- Create: `scripts/hv/pptx_to_text.py`

**Interfaces:**
- Produces: readable text for every docx/pptx/rtf/webarchive source; MANIFEST.md mapping converted file → origin path; PNGs/PDFs referenced in place (multimodal agents read them from `~/Downloads`).

- [ ] **Step 1: Scaffold + pptx extractor**

```bash
cd /Users/lancemarks/Documents/Projects/Claude/Futureproofing/intelibank
mkdir -p docs/06-research/hv-extraction/sources docs/06-research/hv-extraction/digests docs/06-research/hv-extraction/ledger/candidates scripts/hv
```

`scripts/hv/pptx_to_text.py`:
```python
#!/usr/bin/env python3
"""Extract slide text from a .pptx (zip of XML) using stdlib only."""
import re, sys, zipfile

def slide_key(name):
    m = re.search(r"slide(\d+)\.xml$", name)
    return int(m.group(1)) if m else 0

def main(pptx_path):
    with zipfile.ZipFile(pptx_path) as z:
        slides = sorted((n for n in z.namelist()
                         if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=slide_key)
        for n in slides:
            xml = z.read(n).decode("utf-8", errors="replace")
            texts = re.findall(r"<a:t>(.*?)</a:t>", xml, flags=re.S)
            print(f"\n===== Slide {slide_key(n)} =====")
            for t in texts:
                t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")
                if t.strip():
                    print(t.strip())

if __name__ == "__main__":
    main(sys.argv[1])
```

- [ ] **Step 2: Convert every source**

```bash
SRC=docs/06-research/hv-extraction/sources
D=/Users/lancemarks/Downloads
# intelibank-101
pandoc -f docx -t gfm --wrap=none "$D/intelibank-101/Conductia_Product_Blueprint_v11.docx" -o "$SRC/101-product-blueprint-v11.md"
pandoc -f docx -t gfm --wrap=none "$D/intelibank-101/Conductia_Founders_Planning_Seession_Document.docx" -o "$SRC/101-founders-planning-session.md"
python3 scripts/hv/pptx_to_text.py "$D/intelibank-101/Conductia_Seed_Deck_10.pptx" > "$SRC/101-seed-deck-10.txt"
cp "$D/intelibank-101/Rob Conductia Internal __ Demo - 2026_07_01 16_31 EDT - Notes by Gemini.md" "$SRC/101-rob-demo-notes.md"
cp "$D/intelibank-101/RTS-meeting-notes.md" "$SRC/101-rts-meeting-notes.md"
cp "$D/intelibank-101/intelibank-handbook.html" "$SRC/101-handbook.html"
# horizontal-vertical
pandoc -f docx -t gfm --wrap=none "$D/intelibank-horizontal-vertical/Sellside_M_A_Master_Process___Build_Sequence_2026_07_08_v2.docx" -o "$SRC/hv-master-process-v2.md"
pandoc -f docx -t gfm --wrap=none "$D/intelibank-horizontal-vertical/Sellside_M_A_Execution_Guide_2026_07_08_v2.docx" -o "$SRC/hv-execution-guide-v2.md"
pandoc -f docx -t gfm --wrap=none "$D/intelibank-horizontal-vertical/Conductia Compliance Build Plan.docx" -o "$SRC/hv-compliance-build-plan.md"
# rogo-research
textutil -convert txt "$D/rogo-research/screenshots/slack-conversation-notes.rtf" -output "$SRC/rogo-slack-notes.txt"
textutil -convert txt "$D/rogo-research/screenshots/question-answer.rtf" -output "$SRC/rogo-question-answer.txt"
textutil -convert html "$D/rogo-research/rogo .webarchive" -output "$SRC/rogo-webarchive.html"
cp "$D/rogo-research/rogo-teardown.html" "$SRC/rogo-teardown.html"
cp "$D/rogo-research/rogo-skills-library.html" "$SRC/rogo-skills-library.html"
cp "$D/rogo-research/Whats New in Rogo.html" "$SRC/rogo-whats-new.html"
```

Call-notes source: write Lance's "Ignatious workflows and pain points" notes (verbatim from the session brief, WITHOUT the Login/Pass lines) to `$SRC/call-notes-2026-07-07.md`.

- [ ] **Step 3: Sanity-check conversions**

```bash
for f in docs/06-research/hv-extraction/sources/*; do echo "$(wc -w < "$f") words  $f"; done
```
Expected: every file > 100 words (HTML files will be thousands). Any file under 100 words → conversion failed → investigate that file (fallback: `textutil -convert txt` for docx, or flag to Lance).

- [ ] **Step 4: Write MANIFEST.md** mapping each `sources/` file → origin path in `~/Downloads`, noting PNGs and PDFs are read in place: the 3 H/V PNGs (`deal-lifecycle.png`, `deal-lifecycle-notes.png`, `Ignatious_Sell_Side_Process___Whiteboard_2026_07_07.png`), 10 Rogo screenshots, 2 PDFs.

- [ ] **Step 5: Commit**

```bash
git add docs/06-research/hv-extraction scripts/hv && git commit -m "chore(hv): phase 0 — source conversion + knowledge-base scaffold"
```

---

## Phase 1 — Extraction fleet → ledger

### Task 1.1: 101 canon digest (Workflow WF1a)

**Files:**
- Create: `docs/06-research/hv-extraction/digests/101-canon.md`

**Interfaces:**
- Produces: the canon digest EVERY later agent must read first. Sections: `## Product vision & strategy`, `## Process & workflow facts`, `## Teams, roles & build responsibilities`, `## Terminology`, `## Open questions`.

- [ ] **Step 1: Run WF1a** — 3 parallel lens agents + 1 synthesis agent.

Workflow shape (script authored at execution with these exact prompts):
- Agent A (vision lens): "Read ALL files in `docs/06-research/hv-extraction/sources/` with the `101-` prefix, plus `~/Downloads/intelibank-101/Conductia — The Vision on Two Pages.pdf` and `rogo-enhanced-projects-one-pager.pdf` (Read tool handles PDFs). Extract every key insight about WHAT Conductia is, for whom (Ignatious; Storm founder), positioning vs Rogo, product principles. Return structured findings, each with sourceRef (file + section/slide)."
- Agent B (process lens): same inputs; extract every fact about the deal lifecycle, phases, steps, workflow mechanics, compliance, audit.
- Agent C (org lens): same inputs; extract teams (Futureproofing = horizontal, RTS = vertical, Ignatious = process expertise), responsibilities, MVP definitions, decisions and open debates.
- Synthesis agent: reads the three structured results, writes `digests/101-canon.md` with the five sections above; every claim keeps its sourceRef.

Structured-output schema for lens agents: `{ "findings": [{ "topic": str, "insight": str, "sourceRef": str, "confidence": "high|medium|low" }] }`.

- [ ] **Step 2: Verify digest**

```bash
wc -w docs/06-research/hv-extraction/digests/101-canon.md
grep -c "sourceRef\|§\|Slide\|—" docs/06-research/hv-extraction/digests/101-canon.md
```
Expected: > 800 words; source references present throughout. Read it; spot-check 3 claims against sources.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "docs(hv): 101 canon digest"`

### Task 1.2: H/V candidate extraction (Workflow WF1b)

**Files:**
- Create: `docs/06-research/hv-extraction/ledger/candidates/<source>.json` (one per extractor)

**Interfaces:**
- Consumes: `digests/101-canon.md` (mandatory first read for every agent).
- Produces: candidate files, each `{ "source": str, "phases": [...], "gate0": [...], "steps": [<ledger-schema step>], "conflicts": [str], "notes": [str] }` using the spec §3.1 step schema (missing fields allowed at candidate stage, `sourceRefs` NOT optional).

- [ ] **Step 1: Run WF1b** — 6 parallel extractors, each writing its own candidates file to disk and returning only a summary count:
  1. `hv-master-process-v2.md` extractor (primary: full step list, phases, ordering, H/V flags, build sequence)
  2. `hv-execution-guide-v2.md` extractor (per-component template facts: inputs/transformation/outputs/constraints — Markus's framework; tools)
  3. `hv-compliance-build-plan.md` extractor (compliance touchpoints per phase/step)
  4. PNG trio extractor (multimodal): reads the 3 PNGs from `~/Downloads/intelibank-horizontal-vertical/` — 7-phase lifecycle, the notes PNG (4 pre-deal actions), whiteboard structure
  5. `call-notes-2026-07-07.md` extractor (authoritative semantics: gate 0, skip/edit rules, versioned outputs, MVP, roles)
  6. Repo cross-checker: reads `docs/02-product/deal-lifecycle-rails.md`, `skills-catalog.md`, `rogo-skills-gap-map.md`, `experience-spine.md`; emits agreements/conflicts vs the sources (as candidates with `source: "repo-docs"`)

Each prompt states: read `digests/101-canon.md` first; write your JSON to your assigned candidates path with the Write tool; every step needs `sourceRefs`; record any disagreement with other documents you notice as a `conflicts` entry rather than resolving it.

- [ ] **Step 2: Validate candidates**

```bash
python3 - <<'EOF'
import json, glob
for p in sorted(glob.glob("docs/06-research/hv-extraction/ledger/candidates/*.json")):
    d = json.load(open(p))
    steps = d.get("steps", [])
    missing = [s.get("name","?") for s in steps if not s.get("sourceRefs")]
    print(f"{p}: {len(steps)} steps, {len(d.get('conflicts',[]))} conflicts, missing-refs={len(missing)}")
    assert not missing, f"untraceable steps in {p}: {missing[:5]}"
EOF
```
Expected: 6 files, master-process file carries the bulk of steps, zero missing-refs.

- [ ] **Step 3: Commit** — `git commit -am "docs(hv): H/V candidate extraction (6 sources)"`

### Task 1.3: Ledger synthesis

**Files:**
- Create: `docs/06-research/hv-extraction/ledger/hv-ledger.json`
- Create: `docs/06-research/hv-extraction/ledger/conflict-log.md`

**Interfaces:**
- Consumes: all candidates + 101-canon.
- Produces: `hv-ledger.json` top level `{ "phases": [...], "gate0": [...], "steps": [...], "openQuestions": [...] }` per spec §3.1; `conflict-log.md` with one `### C<n>` section per conflict (both readings + recommendation).

- [ ] **Step 1: Run synthesis agent** (single agent, high effort): merge candidates applying spec §3.2 precedence (docx v2 > PNGs > repo docs > older decks; call notes win on semantics). Union each step's fields from all sources that mention it; keep every step's `sourceRefs` cumulative; assign `id` = `P<phase#>-S<seq-in-phase>`, global `seq`; classify `layer` and `buildOwner` with justification in `description` when non-obvious; unresolved disagreements → conflict-log entries referenced from the step's `conflicts` array.

- [ ] **Step 2: Validate ledger**

```bash
python3 - <<'EOF'
import json
d = json.load(open("docs/06-research/hv-extraction/ledger/hv-ledger.json"))
assert d["phases"] and d["steps"] and len(d["gate0"]) == 4, "phases/steps/gate0 shape"
seqs = [s["seq"] for s in d["steps"]]
assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), "seq must be strictly ordered"
for s in d["steps"]:
    for k in ("id","phase","name","layer","buildOwner","executor","sourceRefs"):
        assert s.get(k), f"{s.get('id','?')} missing {k}"
print(f"OK: {len(d['phases'])} phases, {len(d['steps'])} steps, gate0=4, {len(d.get('openQuestions',[]))} open questions")
EOF
```
Expected: OK line; step count printed (report as found — likely near 82).

- [ ] **Step 3: Commit** — `git commit -am "docs(hv): canonical ledger v1 + conflict log"`

### Task 1.4: Adversarial verification ⛔ GATE

**Files:**
- Create: `docs/06-research/hv-extraction/ledger/verification.md`

- [ ] **Step 1: Run verification workflow** — one verifier agent PER canonical phase (parallel). Each verifier: reads 101-canon, its phase's steps from the ledger, and the relevant sources; attempts to REFUTE: (a) any step untraceable to its sourceRefs, (b) any source step missing from the ledger, (c) wrong ordering vs sources, (d) unjustified layer/buildOwner classification, (e) empty io/tools on high-confidence steps. Returns `{ "phase": str, "verdict": "pass|fail", "issues": [{ "stepId": str, "problem": str, "evidence": str }] }`. Plus one global verifier for gate0 + phase list + cross-phase ordering.

- [ ] **Step 2: Fix and re-verify.** Apply every confirmed issue to the ledger; re-run failed verifiers only. Loop until all pass. Write `verification.md` (per-phase verdicts, issues found→fixed, final counts).

- [ ] **Step 3: Commit** — `git commit -am "docs(hv): ledger verified — phase-by-phase adversarial pass"`

**Gate:** proceed to Phase 2 only when every verifier passes.

---

## Phase 2 — D1 artifacts ⛔ GATE (Lance → Storm)

### Task 2.1: Google-Doc text (`horizontal-vertical-map.md`)

**Files:**
- Create: `docs/02-product/horizontal-vertical-map.md`

**Interfaces:**
- Consumes: `hv-ledger.json`, `conflict-log.md` ONLY (no going back to raw sources — that's what makes render-verification meaningful).
- Produces: paste-ready Google Doc content.

- [ ] **Step 1: Author the doc** (conductor-inline) with exactly these sections:
  1. `# Conductia: The Horizontal/Vertical Map` + one-paragraph exec summary
  2. `## The model in one minute` — horizontal = rails/timeline spanning the deal (Futureproofing builds), vertical = skills at specific steps (RTS builds), hybrid noted (vertical built by horizontal team)
  3. `## Before the deal starts: Gate 0` — the 4 actions
  4. `## The deal lifecycle` — one subsection per phase: intro sentence + table `| # | Step | Layer | Builds | Runs | Inputs → Outputs | Tools |` (Runs = human/agent/both)
  5. `## Build responsibilities` — FP / RTS / Ignatious split, step-lock note
  6. `## Open questions for Storm` — from conflict-log + openQuestions
  7. `## Sources` — the document set this was extracted from
- [ ] **Step 2: Self-check** — every ledger step appears exactly once; counts stated match `python3` count from Task 1.3.
- [ ] **Step 3: Commit** — `git commit -am "docs(product): horizontal/vertical map — team alignment doc (D1 text)"`

### Task 2.2: HTML timeline one-pager

**Files:**
- Create: `docs/02-product/horizontal-vertical-timeline.html` (self-contained; ledger JSON embedded)

- [ ] **Step 1: Build** (conductor-inline; load `artifact-design`/`frontend-design` guidance for craft): horizontal rail of phases left→right; Gate 0 block before phase 1; steps as cards on the rail (grouped by sub-phase where present); vertical skill stacks under vertical/hybrid steps; badges: build-owner (FP/RTS), executor (human/agent/both), layer; filter chips (team / phase / executor / layer); count strip (phases, steps, gate0); print stylesheet (landscape). No external requests — inline CSS/JS only. Data source: `const LEDGER = {...}` pasted from `hv-ledger.json`.
- [ ] **Step 2: Deploy as private Artifact** (favicon 🏦, stable title "Conductia H/V Timeline") for a shareable review link; file also committed.
- [ ] **Step 3: Commit** — `git commit -am "docs(product): H/V interactive timeline one-pager (D1 diagram)"`

### Task 2.3: Render verification

- [ ] **Step 1: Run one verifier agent**: reads ledger + both D1 artifacts; refutes: missing steps, invented steps, wrong badges/owners, count mismatches, Gate 0 absent/wrong. Returns issues list; fix all; re-run until clean. Append result to `verification.md`; commit.

### Task 2.4: Lance gate ⛔

- [ ] Present to Lance: artifact link + `horizontal-vertical-map.md` (paste-ready) + open-questions list + actual step count with per-source breakdown. Lance reviews → 1-on-1 with Storm. **Storm's corrections are applied to `hv-ledger.json` first**, then Tasks 2.1–2.3 re-run (cheap re-render). Phase 3 starts without waiting for this gate to clear.

---

## Phase 3 — Rogo + codebase research (runs during the Phase-2 review window)

### Task 3.1: Rogo fleet (Workflow WF3a)

**Files:**
- Create: `digests/rogo-ui-findings.md`, `digests/rogo-skills-inventory.md`

**Interfaces:**
- Consumes: `sources/rogo-*.{html,txt}`, the 10 screenshots in `~/Downloads/rogo-research/screenshots/`, `~/Downloads/rogo-research/rogo-enhanced-projects-one-pager.pdf`, 101-canon.
- Produces: `rogo-ui-findings.md` sections: `## Layout system`, `## Navigation & IA`, `## Design language` (color/type/density/components), `## Interaction patterns` (chat/skill invocation, model picker, internal vs external sources, Felix flows, tables/artifacts), `## What to steal vs skip for Conductia`. `rogo-skills-inventory.md`: skills taxonomy table + invocation/configuration model.

- [ ] **Step 1: Run WF3a** — parallel: teardown reader; skills-library reader; whats-new + one-pager reader; webarchive reader; 2 multimodal screenshot analysts (5 PNGs each, prompts name the exact files); Slack+Q&A notes reader. Two synthesis agents write the two digests (UI findings; skills inventory), each claim tagged with its source file/screenshot name.
- [ ] **Step 2: Gap check** — conductor reads both digests; if material gaps (e.g. a flow no artifact captured), ask Lance before using the live Rogo login via Chrome tools (read-only browsing).
- [ ] **Step 3: Commit** — `git commit -am "docs(hv): Rogo UI/UX findings + skills inventory digests"`

### Task 3.2: Codebase fleet (Workflow WF3b)

**Files:**
- Create: `digests/codebase-map.md`

- [ ] **Step 1: Run WF3b** — parallel over the repo at `develop-design` (== develop): IA/route mapper (`src/app` incl. `(authed)`, nav, page inventory, user journey walk-through in prose); design-system auditor (Tailwind/tokens, `components/ui|atoms|molecules|shell|brand`, current visual language); seam+orchestration analyst (`src/lib`, `src/types`, `openapi/`, `supabase/migrations`, `tests/orchestration` — what Roberto's workflow demo does today, Focus vs Full Array); infra surveyor (build/test/scripts, CI expectations). Synthesis agent writes `codebase-map.md` with sections `## Routes & journeys`, `## Design system today`, `## Data & orchestration seam`, `## What the rails vision can reuse / must replace`, `## Build & test infra`.
- [ ] **Step 2: Commit** — `git commit -am "docs(hv): codebase map digest (develop reality)"`

---

## Phase 4 — D2 design synthesis ⛔ GATE

### Task 4.1: Draft the D2 design spec

**Files:**
- Create: `docs/superpowers/specs/2026-07-XX-develop-design-vision-spec.md` (date = authoring day)

**Interfaces:**
- Consumes: `hv-ledger.json` (post-Storm if available), all four digests, program spec.
- Produces: full app design spec: IA + screen inventory; rails timeline surface (Focus + Full Array); step detail w/ vertical skill runners; Gate-0 creation wizard; skip-with-approval; versioned outputs; edit-after-complete; compliance ribbon + audit; ledger-driven fixture layer; visual language (Rogo-informed, Conductia brand); reuse-vs-replace decisions from codebase-map.

- [ ] **Step 1: Author draft** (conductor-inline).
- [ ] **Step 2: Judge panel workflow** — 4 parallel judges score the draft 1–10 with required improvements: ledger fidelity; Rogo design parity; team mergeability (respects seam/tests); simplicity (YAGNI). Fold in improvements scoring < 8.
- [ ] **Step 3: Commit; present to Lance.** ⛔ **Gate:** Lance approves the D2 spec.

### Task 4.2: Author the D2 build plan

- [ ] After the gate: invoke superpowers:writing-plans against the approved D2 spec → `docs/superpowers/plans/2026-07-XX-develop-design-vision-build.md` with the workstream structure from program spec §4 Phase 5 (fixtures → shell/nav → rails timeline → step detail/skills → wizard/flows → compliance surfaces → integration), TDD per component, exit criteria: tsc 0 / eslint 0 / build clean / tests green / golden-path browser walkthrough. Execution of that plan = Phase 5 (its own session-scale effort).

---

## Phase 6 — Closeout (after Phase 5 completes under its own plan)

- [ ] Session report in workspace `reports/session/`; memory update (`project_intellibank.md`: ledger location, D1 shared, D2 state); archive scratch; summary for Lance with push/PR decision left to him.

## Conductor's Sequence Card

```
NOW ──► P0 (convert) ──► P1.1 (101) ──► P1.2 (candidates) ──► P1.3 (synth) ──► P1.4 verify ⛔
     ──► P2.1–2.3 (D1) ──► P2.4 Lance ⛔ ──────────────┐ (review window)
     ──► P3.1 + P3.2 run DURING the review window ◄────┘
     ──► Storm corrections → ledger → re-render D1
     ──► P4.1 spec ⛔ Lance ──► P4.2 build plan ──► Phase 5 (own plan) ──► P6
```
