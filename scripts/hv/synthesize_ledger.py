#!/usr/bin/env python3
"""Merge candidate extractions into the canonical hv-ledger.json.

Precedence (spec §3.2): master-process v2 = base truth for steps/apps;
execution-guide v2 enriches by seq; call-notes win on semantics;
png-trio supplies gate0 + whiteboard phase panels; compliance-plan
lands as a separate complianceRoadmap (not merged into apps, to keep
counts traceable to the Master Process doc).
"""
import json, os, sys

CAND = "docs/06-research/hv-extraction/ledger/candidates"
OUT = "docs/06-research/hv-extraction/ledger/hv-ledger.json"

def load(name):
    with open(os.path.join(CAND, name)) as f:
        return json.load(f)

mp = load("master-process.json")
eg = load("execution-guide.json")
cn = load("call-notes.json")
png = load("png-trio.json")
cp = load("compliance-plan.json")
rd = load("repo-docs.json")

# --- phases: master-process names + whiteboard roles/tools panels ---
panels = {p["phase"]: p for p in png.get("whiteboard_phase_panels", [])}
phases = []
for p in mp["phases"]:
    panel = panels.get(p["num"], {})
    phases.append({
        "num": p["num"], "name": p["name"],
        "roles": panel.get("roles", []), "tools": panel.get("tools", []),
        "whiteboardSteps": panel.get("steps", []),
        "sourceRefs": [p["sourceRef"]] + ([panel.get("sourceRef")] if panel else []),
    })

# --- steps: base from master-process, enrich by seq from execution-guide ---
eg_by_seq = {s["seq"]: s for s in eg.get("steps", [])}
EXEC_TO_EXECUTOR = {"A": "agent", "A+H": "human+agent", "H+A": "human+agent", "H": "human"}
steps = []
for s in mp["steps"]:
    e = eg_by_seq.get(s["seq"], {})
    ec = e.get("executionClass", "unknown")
    merged = dict(s)
    merged.update({
        "id": f"P{s['phase']}-S{s['seq']:02d}",
        "description": e.get("description") or s["description"],
        "executionClass": ec,
        "executor": EXEC_TO_EXECUTOR.get(ec),
        "io": e.get("io") or s["io"],
        "tools": e.get("tools") or [],
        "approval": e.get("approval"),
        "compliance": e.get("compliance") or [],
        # call-notes global semantics (authoritative)
        "skippable": {"allowed": True, "requiresApproval": True,
                      "note": "skip reason routes to the appropriate next step"},
        "editableAfterComplete": True,
        # layer: OS-built sequenced steps are hybrid (vertical position, horizontal builder)
        "layer": "hybrid" if s["buildOwner"] == "futureproofing-os" else "vertical",
        "sourceRefs": s["sourceRefs"] + (e.get("sourceRefs") or []),
        "confidence": "high" if e else "medium",
    })
    steps.append(merged)

covered = sum(1 for s in steps if s["seq"] in eg_by_seq)

ledger = {
    "meta": {
        "version": "1.0", "date": "2026-07-08",
        "canonNote": "5 phases per Master Process v2 + whiteboard; 7-phase deck slide is the older investor framing (see conflicts)",
        "counts": {"phases": len(phases), "steps": len(steps),
                    "horizontalApps": len(mp["horizontalApps"]),
                    "gate0": len(cn["gate0"]),
                    "priorityBuilds": sum(1 for s in steps if s["priorityBuild"]) +
                                      sum(1 for a in mp["horizontalApps"] if a["priorityBuild"]),
                    "egCoverage": f"{covered}/{len(steps)} steps enriched by execution guide"},
    },
    "executionClassDefs": eg.get("executionClassDefs", {}),
    "semantics": cn["semantics"],
    "gate0": cn["gate0"],
    "phases": phases,
    "steps": steps,
    "horizontalApps": mp["horizontalApps"],
    "complianceRoadmap": {"apps": cp["horizontalApps"], "notes": cp["complianceNotes"]},
    "painPoints": png["painPoints"],
    "regulatoryBand": png["regulatoryBand"],
    "alwaysOnLayer": png["alwaysOnLayer"],
    "phases7_legacy": png["phases7"],
    "openQuestions": [],
    "conflicts": [],
}

# --- conflicts + open questions from every candidate ---
for src in (mp, eg, cn, png, cp, rd):
    for c in src.get("conflicts", []):
        ledger["conflicts"].append({"conflict": c, "from": src["source"]})
ledger["openQuestions"] = [c["conflict"] for c in ledger["conflicts"]]

json.dump(ledger, open(OUT, "w"), indent=1)

# --- validation (plan Task 1.3 step 2) ---
d = json.load(open(OUT))
assert len(d["phases"]) == 5 and len(d["steps"]) == 65 and len(d["gate0"]) == 4
seqs = [s["seq"] for s in d["steps"]]
assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
for s in d["steps"]:
    for k in ("id", "phase", "name", "layer", "buildOwner", "sourceRefs"):
        assert s.get(k), f"{s.get('id','?')} missing {k}"
print(f"OK: {len(d['phases'])} phases, {len(d['steps'])} steps, "
      f"{len(d['horizontalApps'])} horizontal apps, gate0=4, "
      f"{d['meta']['counts']['priorityBuilds']} priority builds, "
      f"EG coverage {d['meta']['counts']['egCoverage']}, "
      f"{len(d['conflicts'])} conflicts")
