# Known Compliance Vulnerabilities — Bridge Register

Status: living register, opened 2026-07-21. Author: Marcelo.

Companion to `data-room-analysis.md`, `sandbox-vs-production.md`, and
`permissions-enforcement-gaps.md`. Decision origin: ADR-0009 (document gating
deferred) + the Storm weekly (2026-07-20) and RTS sync (2026-07-21).

## Why this doc exists

Storm's explicit decision on the Storm call: while Conductia is not yet the single
entry point for every file action, we will **not pretend the audit trail is
complete**. Instead we keep an honest, tracked list of exactly where compliance
coverage has a hole, what the exposure is, and what closes it. "We need to know
where we are not good as well as where we are good."

The moat is "compliance is the floor." That is only true if the gaps are named,
owned, and closing — not hidden. This register is that list.

## The bridge we are living with

Ideal end state: every open / save / share flows through Conductia, so every file
action is observable and auditable. Today bankers work in SharePoint. The MVP bridge
(Storm-approved, temporary):

- **Data room → Box** (compliance-certified; regulatory burden shifts to Box).
- **Existing SharePoint content** stays reachable via Box's SharePoint connectors, so
  bankers do not have to migrate on day one.
- Where a client insists on staying in SharePoint outside our observation, the audit
  guarantee is **explicitly disclaimed**, not silently assumed.

Every item below is a consequence of that bridge existing at all. Each closes when the
"through Conductia" end state lands for that action.

## Register

Severity: 🔴 disclosure/audit hole · 🟠 partial coverage · 🟡 cosmetic/known-limit.
Status: OPEN · MITIGATED · CLOSED.

| # | Vulnerability | Exposure | Severity | Mitigation today | Closes when | Status |
|---|---|---|---|---|---|---|
| V1 | Banker copies a SharePoint share link and sends it outside Conductia | File is accessed with no Conductia audit event; we cannot prove who saw it or when | 🔴 | Disclaimer to client that SharePoint-native sharing is outside our audit; encourage data-room (Box) path | File actions route through Conductia / Box-only data room | OPEN |
| V2 | Direct edit/delete in SharePoint bypasses Conductia versioning + permissions | Canonical file changes with no version record or permission check on our side | 🔴 | Box as system for the data room; SharePoint kept as read-through bridge only | Deal-folder content migrates behind Conductia | OPEN |
| V3 | Dual store (SharePoint + Box) during the bridge means two governance regimes | "Which copy is canonical / audited" is ambiguous while both exist | 🟠 | Roberto targeting a single Box implementation for MVP to avoid the dual build | Single-store MVP ships | OPEN |
| V4 | Lead-stage files (pre-project) have no data room yet | A sensitive file attached to a lead before a project exists may lack an access wall | 🟠 | Rule: any confidential file must promote the lead to a project (or a temp data room linked to one); public-visibility only at lead stage | Lead-stage guard implemented | OPEN |
| V5 | Buyer / external phase-gating not enforced | External parties can currently see all deal documents (see `permissions-enforcement-gaps.md` #10/#15) | 🔴 | Coarse deal-membership scoping only | Phase-gating + classification filter land | OPEN |
| V6 | AI agent ingests untrusted content (transcripts, emails) | Prompt-injection could drive tool calls / data exfiltration | 🟠 | Agents run in an isolated container; data pulled via permission-scoped MCP (JSON, not raw files); scoped token; audit per write | Isolation + MCP scoping verified E2E | MITIGATED (by design) |

## Working rules

1. When we ship a bridge affordance that leaves a hole, it gets a row here **before**
   it ships — not after someone finds it.
2. Every row names the exposure in plain terms a compliance officer would accept, and
   the concrete thing that closes it.
3. This register is the honest answer to the compliance-officer question "what can't
   you see?" Keep it current; an out-of-date register is worse than none.

Owner: Marcelo (info architecture). Review cadence: at each Storm weekly.
