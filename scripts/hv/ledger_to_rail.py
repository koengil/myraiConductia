#!/usr/bin/env python3
"""Generate src/lib/rail/railData.generated.ts from the verified H/V ledger.
Deterministic: rerun after ledger corrections (Storm review) to re-skin the app."""
import json
import re

d = json.load(open("docs/06-research/hv-extraction/ledger/hv-ledger.json"))

# Product-copy pass over the verbatim ledger: the census renders in-app for any
# bank, so the source bank's name and the ledger's own seq numbering (the UI
# counts display stations, not ledger seqs) must not reach visible copy. The
# ledger itself stays untouched — it is the verified extraction record.
COPY_FIXES = [
    ("Tier 1: Ignatious deals", "Tier 1: the firm's own deals"),
    ("any Ignatious deal", "any of the firm's deals"),
    ("Ignatious mandate fit", "the firm's mandate fit"),
    ("Ignatious must prove", "the firm must prove"),
    ("(Ignatious handles conflicts manually", "(the firm handles conflicts manually"),
    ("the Ignatious consulting-partner build list", "the consulting-partner build list"),
    ("at Seq 25 (Engagement Negotiation)", "at the Engagement Negotiation step"),
    ("fed by Seq 55", "fed by League Table Submission"),
    # Em dash between clauses that a colon or parentheses would misread.
    ("(1) MD brief \u2014 call objectives", "(1) MD brief: call objectives"),
    ("(2) source-cited company profile \u2014 product", "(2) source-cited company profile: product"),
    ("the deal team executes \u2014 not outreach itself", "the deal team executes, not outreach itself"),
    ("invoice drafts \u2014 but never sends", "invoice drafts, but never sends"),
    # The ledger's own version notes ("v9 ...", "RAG readiness") are
    # engineering notes, not step copy.
    ("v9 scope: normalize", "Scope: normalize"),
    ("assembles the four v9 elements:", "assembles four elements:"),
    ("across the v9 dimensions:", "across these dimensions:"),
    ("scoring \u2014 v9 classifies this agent as part of", "scoring, part of"),
    ("checklist to completion (from v9):", "checklist to completion:"),
    ("; v9 deprioritized automation here)", ")"),
    ("Per v9, the Negotiation Copilot", "The Negotiation Copilot"),
    ("are mandatory v9 elements", "are mandatory elements"),
    ("Timing depends on process type per v9:", "Timing depends on process type:"),
    (" (v9: SECRET SAUCE)", ""),
    ("v9 frames this explicitly as future RAG readiness \u2014 disciplined", "Disciplined"),
    ("Per v9, automated routing", "Automated routing"),
    ("v9 section set:", "Sections:"),
    ("v9 adds two mandatory elements:", "Two elements are mandatory:"),
    (" \u2014 a v9 'secret sauce' asset", ""),
    ("v9 classifies this agent SECRET SAUCE \u2014 core competitive moat", "A core competitive moat"),
    # Roadmap and build-number notes are engineering notes, not step copy.
    ("the agent assembles the checklist and evidence, banker and compliance make the determination; the OS later productizes a full conflicts engine.",
     "Conductia assembles the checklist and evidence, and the banker and compliance make the determination."),
    ("(with the Negotiation Copilot, OS Build #16, surfacing market precedent)",
     "(with the Negotiation Copilot surfacing market precedent)"),
    ("the Fee Structure Pool (OS Build #21)", "the Fee Structure Pool"),
    # The glossary names the actor Conductia, never "the agent" (D49), in
    # every field the step view shows (description, approval, compliance).
    ("gates the step, not the agent", "gates the step, not Conductia"),
    ("The agent scores mandate fit", "Conductia scores mandate fit"),
    ("the agent recommends, the senior banker decides", "Conductia recommends, the senior banker decides"),
    ("the agent prepares and captures", "Conductia prepares and captures"),
    ("the agent ensures no one walks", "Conductia ensures no one walks"),
    ("the agent manages the paper", "Conductia manages the paper"),
    ("the agent assembles, tracks, and chases", "Conductia assembles, tracks, and chases"),
    ("Agent structures and files;", "Conductia structures and files;"),
    ("The agent generates outputs from that meeting", "Conductia generates outputs from that meeting"),
    ("the agent reviews it as a buyer", "Conductia reviews it as a buyer"),
    ("the agent performs mechanical normalization and checking", "Conductia performs mechanical normalization and checking"),
    ("agent never initiates contact", "Conductia never initiates contact"),
    ("Legal controlled; agent tracks only;", "Legal controlled; Conductia tracks only;"),
    ("funds movement never agent-initiated", "funds movement never initiated by Conductia"),
    ("the agent never sends the invoice itself", "Conductia never sends the invoice itself"),
    ("the agent preps the materials", "Conductia preps the materials"),
    ("(human leads, agent assists)", "(human leads, Conductia assists)"),
    ("The agent drafts and pitches;", "Conductia drafts and pitches;"),
    # Ledger seq numbers in shown descriptions name the step instead (the UI
    # counts display steps, not ledger seqs). Inputs keep theirs for "Draws on".
    ("(handed to Seq 30)", "(handed to the Working Group List step)"),
    # "WGL" is the ledger's shorthand; shown text spells it out (the step's
    # name is set in STEP_COPY_FIXES).
    ("Initial WGL, milestone targets", "Initial Working Group List, milestone targets"),
    ("visibility-segregated WGL", "visibility-segregated Working Group List"),
    ("(handed to Seq 29)", "(handed to the Timeline step)"),
    ("Buyer Q&A (Seq 45) updates from live questions", "Buyer Q&A updates from live questions"),
    ("league-table credit from Seq 55.", "league-table credit from League Table Submission."),
]

# Whole-field overrides keyed by step id, applied after COPY_FIXES and the
# dash rule, for ledger sentences no phrase swap can repair.
STEP_COPY_FIXES = {
    "p2-s30": {"name": "Working Group List"},
    "p3-s43": {
        "description": "Once a buyer's NDA is executed, provisions staged VDR access by buyer group: permissions scoped to what that group is cleared to see, watermarking, full access logs, download rules, and clean-team restrictions on restricted materials. 'Staged' means access widens as a buyer advances rather than exposing everything at once. It needs platform-level access control and a full audit trail.",
    },
}

COMMA_AFTER_ASIDE = {"anticipates", "then", "turning", "generates", "monitoring", "each"}

def no_em_dash(v):
    """No em dash in visible copy.
    Two dashes that enclose an aside inside one sentence on one line become
    parentheses. Every other dash is handled on its own: a colon, or a comma
    when the clause it ends already has a colon. A dash between two full
    sentences is reworded in COPY_FIXES instead."""
    if "\u2014" not in v:
        return v
    parts = re.split(r" *\u2014 *", v)
    out = parts[0]
    k = 1
    while k < len(parts):
        if k + 1 < len(parts) and not re.search(r"[.?!;\n]", parts[k]):
            nxt = parts[k + 1]
            first = (re.match(r"[A-Za-z]+", nxt) or [""])[0] if nxt else ""
            if re.match(r"[,.;:)]", nxt):
                glue = ""
            elif first in COMMA_AFTER_ASIDE:
                glue = ", "
            else:
                glue = " "
            out += " (" + parts[k] + ")" + glue + nxt
            k += 2
            continue
        clause = re.split(r"[.?!]\s|\n", out)[-1]
        if re.search(r"[.:?!]\s*$", out):
            out += " " + parts[k]
        else:
            out += (", " if ":" in clause else ": ") + parts[k]
        k += 1
    return out

def fix_copy(v):
    if isinstance(v, str):
        for old, new in COPY_FIXES:
            v = v.replace(old, new)
        return no_em_dash(v)
    if isinstance(v, list):
        return [fix_copy(x) for x in v]
    if isinstance(v, dict):
        return {k: fix_copy(x) for k, x in v.items()}
    return v

d = fix_copy(d)
leftovers = [s["seq"] for s in d["steps"] if "Ignatious" in json.dumps(s)]
if leftovers:
    raise SystemExit(f"unneutralized 'Ignatious' in ledger steps {leftovers}: extend COPY_FIXES")
notes = [s["seq"] for s in d["steps"] if re.search(r"\bv9\b|\bRAG\b", json.dumps(s))]
if notes:
    raise SystemExit(f"ledger version notes (v9, RAG) left in steps {notes}: extend COPY_FIXES")

def ts(v):
    return json.dumps(v, ensure_ascii=False)

def io_ts(io):
    io = io or {}
    def items(xs):
        out = []
        for x in xs or []:
            if isinstance(x, dict):
                out.append({"what": x.get("what") or "", "format": x.get("format") or "", "source": x.get("source") or ""})
            else:
                out.append({"what": str(x), "format": "", "source": ""})
        return out
    return {
        "inputs": items(io.get("inputs")),
        "transformation": io.get("transformation") or "",
        "outputs": items(io.get("outputs")),
        "constraints": [str(c) for c in (io.get("constraints") or [])],
    }

phases = [{
    "num": p["num"], "name": p["name"],
    "roles": p.get("roles") or [], "tools": p.get("tools") or [],
} for p in d["phases"]]

steps = [{
    "seq": s["seq"], "id": f"p{s['phase']}-s{s['seq']}", "phase": s["phase"],
    "name": s["name"], "description": s.get("description") or "",
    "layer": s["layer"], "buildOwner": s["buildOwner"],
    "executionClass": s.get("executionClass") or "unknown",
    "io": io_ts(s.get("io")), "tools": s.get("tools") or [],
    "priorityBuild": bool(s.get("priorityBuild")),
    "approvalBy": (s.get("approval") or {}).get("by") or "",
    "compliance": s.get("compliance") or [],
} for s in d["steps"]]

for s in steps:
    s.update(STEP_COPY_FIXES.get(s["id"], {}))

# The fields the step view shows (after the overrides above): the actor is
# Conductia, and no roadmap, build-number or ledger seq note reaches them.
# io.inputs keep their "Seq NN" references: "Draws on" (src/lib/rail/drawsOn.ts)
# reads them, and the UI never shows them.
VISIBLE_NOTE = re.compile(
    r"\bthe agent\b|\bagent\b|\bthe OS\b|productiz|\bOS Build\b|\bOperating System\b|\bSeq\s*\d+\b|\bv9\b|\bWGL\b",
    re.I,
)
def visible_text(s):
    return [s["name"], s["description"], s["approvalBy"]] + [str(c) for c in s["compliance"]] + [
        o["what"] for o in s["io"]["outputs"]
    ]
voice = [s["seq"] for s in steps if any(VISIBLE_NOTE.search(t) for t in visible_text(s))]
if voice:
    raise SystemExit(f"'the agent' or an engineering note left in visible step text {voice}: extend COPY_FIXES")

gate0 = [g["action"] for g in d["gate0"]]

apps = [{
    "name": a["name"], "what": a["what"],
    "osBuildNum": a.get("osBuildNum"), "priorityBuild": bool(a.get("priorityBuild")),
} for a in d["horizontalApps"]]

out = f"""// GENERATED FILE — do not edit by hand.
// Source: docs/06-research/hv-extraction/ledger/hv-ledger.json (verified {d['meta']['date']})
// Regenerate: python3 scripts/hv/ledger_to_rail.py

export interface GeneratedIoItem {{ what: string; format: string; source: string }}
export interface GeneratedIo {{
  inputs: GeneratedIoItem[]
  transformation: string
  outputs: GeneratedIoItem[]
  constraints: string[]
}}
export type GeneratedLayer = 'vertical' | 'hybrid'
export type GeneratedBuildOwner = 'rts' | 'futureproofing-os'
export type ExecutionClass = 'A' | 'A+H' | 'H+A' | 'H' | 'unknown'

export interface GeneratedPhase {{
  num: number
  name: string
  roles: string[]
  tools: string[]
}}

export interface GeneratedStep {{
  seq: number
  id: string
  phase: number
  name: string
  description: string
  layer: GeneratedLayer
  buildOwner: GeneratedBuildOwner
  executionClass: ExecutionClass
  io: GeneratedIo
  tools: string[]
  priorityBuild: boolean
  approvalBy: string
  compliance: string[]
}}

export interface GeneratedApp {{
  name: string
  what: string
  osBuildNum: number | null
  priorityBuild: boolean
}}

export const GENERATED_PHASES: GeneratedPhase[] = {ts(phases)}

export const GENERATED_STEPS: GeneratedStep[] = {ts(steps)}

export const GATE0_ACTIONS: string[] = {ts(gate0)}

export const ALWAYS_ON_APPS: GeneratedApp[] = {ts(apps)}

export const EXECUTION_CLASS_LABELS: Record<ExecutionClass, string> = {{
  'A': 'Agent',
  'A+H': 'Agent, human approves',
  'H+A': 'Human leads, agent checks',
  'H': 'Human',
  'unknown': 'Unclassified',
}}
"""
open("src/lib/rail/railData.generated.ts", "w").write(out)
print(f"generated: {len(phases)} phases, {len(steps)} steps, {len(gate0)} gate0, {len(apps)} apps")
