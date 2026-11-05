#!/usr/bin/env python3
"""Render docs/02-product/horizontal-vertical-map.md from hv-ledger.json.
Prose sections live in this script (single source); all tables are generated."""
import json

d = json.load(open("docs/06-research/hv-extraction/ledger/hv-ledger.json"))
steps = d["steps"]
apps = d["horizontalApps"]
phases = d["phases"]

def io_compact(s):
    io = s.get("io") or {}
    ins = io.get("inputs") or []
    outs = io.get("outputs") or []
    i = ins[0]["what"] if ins and isinstance(ins[0], dict) and ins[0].get("what") else (ins[0] if ins and isinstance(ins[0], str) else "—")
    o = outs[0]["what"] if outs and isinstance(outs[0], dict) and outs[0].get("what") else (outs[0] if outs and isinstance(outs[0], str) else "—")
    more_i = f" (+{len(ins)-1})" if len(ins) > 1 else ""
    more_o = f" (+{len(outs)-1})" if len(outs) > 1 else ""
    return f"{i}{more_i} → {o}{more_o}"

def tools_compact(s):
    t = s.get("tools") or []
    if not t:
        return "—"
    if len(t) > 3:
        return ", ".join(t[:3]) + f" (+{len(t)-3})"
    return ", ".join(t)

RUNS = {"A": "Agent", "A+H": "Agent → human approves", "H+A": "Human leads, agent checks", "H": "Human"}
LAYER = {"vertical": "Vertical", "hybrid": "Hybrid*", "horizontal": "Horizontal"}
OWNER = {"rts": "RTS", "futureproofing-os": "Futureproofing (OS)"}

out = []
w = out.append
w("# Conductia: The Horizontal/Vertical Map")
w("")
w("**One canonical picture of the sell-side platform: the horizontal rails every deal runs on, and the vertical skills that do the work at each step.** Extracted 2026-07-08 from the Master Process & Build Sequence v2, the Execution Guide v2, the process whiteboard, the Compliance Build Plan, and the 2026-07-07 working-call notes. Status: for Storm's 1-on-1 review before the wider group.")
w("")
w("## The model in one minute")
w("")
w("- **Horizontal = the rails.** Everything that spans the whole deal lifecycle: the workflow engine that advances a deal through 5 phases and 65 steps, plus 21 always-on platform applications (search, QC, compliance, orchestration). **Futureproofing builds the horizontal layer** at the Operating System level.")
w("- **Vertical = the skills.** The work that happens at a specific step: valuation, pitch deck, buyer outreach, diligence answers. Each step is one \"application\" — an agentic workflow with defined human control. **RTS builds the vertical skills** that run on the rails.")
w("- **Hybrid\\*** = a step that sits at a specific point on the timeline but is built by the horizontal team (e.g. Lead Registration, Codename/Deal Shell, Mandate Activation) — infrastructure that happens to live at one step.")
w("- **Ignatious** supplies the process truth: step descriptions, ordering, prioritization (each vertical step gets a 5-page spec assigned to a banker + an RTS team member; integration is step-locked between the teams).")
w("- **How a step runs:** every step carries an execution class — **A** (fully agentic) · **A+H** (agent does the work, banker approves) · **H+A** (human leads, agent checks) · **H** (fully human, agents observe to learn). Any step can be **skipped with logged human approval** (the reason routes to the right next step), any completed step can be **edited later** (outputs are versioned: Pitch Valuation V1/V2…), and every step is assigned to a human or an agent **with a deadline or priority tag**.")
w("")
w("## Before the rails: Gate 0 (deal creation)")
w("")
w("Four things happen before Step 1, every time:")
w("")
for i, g in enumerate(d["gate0"], 1):
    w(f"{i}. **{g['action'].rstrip('.')}**")
w("")
w("Gate 0 also confirms **where in the lifecycle the deal enters** — a mandate can arrive mid-process, and the rails start at the right step, not step 1.")
w("")
w("## The deal lifecycle — 5 phases, 65 steps")
w("")
w("★ = one of Storm's 16 priority builds. *Runs* shows the execution class. *Builds* = who builds that step's application.")

PHASE_INTROS = {
    1: "Nothing signed yet: find and vet the opportunity, research company and buyers, win the mandate, sign the Engagement Letter.",
    2: "The bank is hired. The team mobilizes, stages the company for market, writes the selling documents (Teaser, CIM/MP).",
    3: "The process goes live. Buyers approached under a code name; interest converts into first-round offers (IOIs).",
    4: "Offers on the table. Narrow to one buyer under LOI; the buyer verifies everything while lawyers negotiate the definitive agreement.",
    5: "Sign, announce, close — money moves under maximum human control; records, fees, and lessons are harvested (incl. the no-close/tail branch).",
}

for p in phases:
    ps = [s for s in steps if s["phase"] == p["num"]]
    w("")
    w(f"### Phase {p['num']}: {p['name']}  ({len(ps)} steps)")
    w("")
    w(PHASE_INTROS[p["num"]])
    if p.get("roles"):
        w("")
        w(f"**Who runs it today:** {'; '.join(p['roles'])}. **Tools today:** {', '.join(p['tools'])}.")
    w("")
    w("| # | Step | Layer | Builds | Runs | Input → Output | Tools |")
    w("|---|---|---|---|---|---|---|")
    for s in ps:
        star = " ★" if s.get("priorityBuild") else ""
        w(f"| {s['seq']} | **{s['name']}**{star} | {LAYER[s['layer']]} | {OWNER[s['buildOwner']]} | {RUNS.get(s['executionClass'], s['executionClass'])} | {io_compact(s)} | {tools_compact(s)} |")

w("")
w("## Three layers (Storm 07-08: \"always-on is different than horizontal\")")
w("")
w("Storm is right that the always-on platform is not the same thing as the horizontal workflow. The model is **three** layers, not two:")
w("")
for L in d.get("layers", []):
    w(f"- **{L['name']}** — {L['desc']} *Built by {L['owner']}.*")
w("")

subs = [a for a in apps if a.get("layerClass") == "substrate"]
rails_apps = [a for a in apps if a.get("layerClass") == "rail"]

def app_rows(group):
    w("| Application | What it does | OS build # |")
    w("|---|---|---|")
    for a in sorted(group, key=lambda x: (x.get("osBuildNum") or 99)):
        star = " ★" if a.get("priorityBuild") else ""
        prop = " *(proposed)*" if a.get("proposed") else ""
        w(f"| **{a['name']}**{star}{prop} | {a['what']} | {a.get('osBuildNum') or '—'} |")
    w("")

w(f"### Layer 1 — Platform (always-on substrate) · {len(subs)} apps")
w("")
w("Runs regardless of any deal or step. ★ = priority build. *(proposed)* = added from Storm's note 5.")
w("")
app_rows(subs)
w(f"### Layer 2 — Horizontal workflow rails · {len(rails_apps)} apps")
w("")
w("The engine that carries a deal through the 65 steps — including the **next-step recommender** (after each step, a ranked suggestion + full-step dropdown, most-likely surfaced).")
w("")
app_rows(rails_apps)
w("## Build responsibilities")
w("")
rts_n = sum(1 for s in steps if s["buildOwner"] == "rts")
os_n = sum(1 for s in steps if s["buildOwner"] == "futureproofing-os")
w(f"- **Futureproofing (Operating System team):** the workflow engine + rails, all {len(apps)} always-on applications, and {os_n} hybrid steps in the sequence (lead registration, conflicts, codename/deal shell, mandate activation, document intake, buyer VDR access). Orchestration, audit, tracking.")
w(f"- **RTS (Markus, Svetozar):** {rts_n} of the 65 step-applications — the vertical skills. Build order runs by the RTS Build # in the Master Process (first twelve of Storm's 16 priorities are RTS steps in Phases 1–2).")
w("- **Ignatious:** process expertise — step descriptions, per-step 5-page specs (banker + RTS pairing), prioritization, and the sample deal folder ('Blinky') for RTS testing.")
w("- **Step-lock:** integration and testing lock step-by-step between the two teams; the 4 execution classes define the human/agent contract per step.")
w("")
w("## Why 65 and not 82")
w("")
w(d.get("crosswalk", ""))
w("")
w("## Ownership — needs your confirm")
w("")
w(d.get("ownershipFlag", ""))
w("")
w("## How the 16 priorities sequence")
w("")
w(d.get("prioritization", ""))
w("")
w("## Compliance & Trust spine")
w("")
cs = d.get("complianceSpine", {})
w("Regimes covered by the Compliance Build Plan: **" + " · ".join(cs.get("regimes", [])) + "**.")
w("")
for ph in cs.get("phases", []):
    w(f"- {ph}")
w("")
w(cs.get("gdprNote", ""))
w("")
w("## What we need from you")
w("")
w("- **Inputs:** the Blinky sample deal folder (+ a strong pitch/advocacy deck) for RTS; your ranked order within the 16; sign-off on the v1 subset.")
w("- **Confirms:** ownership direction + what \"Conductia\" is (see above); the six decisions below.")
w("")
w("## Open questions for Storm")
w("")
w("1. **Step count:** confirmed as **65 sequenced steps + 21 always-on apps** (see crosswalk above) — intentional re-partition, nothing dropped. Confirm you're happy with it.")
w("2. **Phase count is settled as 5** (whiteboard + Master Process v2); the 7-phase deck slide maps in (Diligence+Negotiation → P4, Signing+Close → P5). Confirm the deck gets updated, not the process.")
w("3. **V1 subset of the always-on layer:** 21 apps are catalogued; the 4 shaded priorities (External-Send QC, Pipeline CRM, Work-Check, Sector Intelligence) look like the v1 cut. Bless a v1 subset?")
w("4. **CIM drafting (Seq 37) and Negotiation Copilot (OS #16)** carry build numbers but the v1 exclusions defer both. Confirm: in catalog, not in v1.")
w("5. **Models v1:** single provider behind the router seam now; Multi-Model Verification (OS #7) and Model Optimization (OS #24) activate that seam later. Confirm.")
w("6. **Pre-Send QC verdict shape:** binary block (handbook) vs green/yellow/red with logged yellow (vision 2-pager) vs rush-send override (execution guide). One canonical answer needed before the QC surface is built.")
w("")
w("## Sources")
w("")
w("Master Process & Build Sequence v2 (2026-07-08) · Sell-Side M&A Execution Guide v2 (2026-07-08) · Ignatious Sell-Side Process whiteboard (2026-07-07) · Deal-lifecycle deck slide + Slack gate-0 note · Compliance Build Plan v2 · Working-call notes (2026-07-07) · Conductia 101 canon (Product Blueprint v11, Founders Planning Session, Handbook, Vision 2-pager, Seed Deck 10, RTS + demo notes). Full traceability: `docs/06-research/hv-extraction/` (ledger + conflict log).")
w("")

open("docs/02-product/horizontal-vertical-map.md", "w").write("\n".join(out))
ids = {s["seq"] for s in steps}
print(f"rendered: {len(steps)} steps across {len(phases)} phases, {len(apps)} apps; seq coverage {min(ids)}-{max(ids)}; words={len(' '.join(out).split())}")
