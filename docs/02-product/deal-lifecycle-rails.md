> **Status 2026-10-24.** This is the June 2026 product map, kept for its reasoning; its Phase 0–6 list below is not the rail as built. The canonical rail is **5 phases and 65 steps**, generated from `docs/06-research/hv-extraction/ledger/hv-ledger.json` into `src/lib/rail/railData.generated.ts` (`python3 scripts/hv/ledger_to_rail.py`). The rendered MVP rail (`MVP_DEAL_RAIL` in `src/lib/rail/dealRail.ts`) has **61 stations**: the 65 steps less the five New Business Development steps (seq 1 to 5), plus the synthetic Gate 0 notify step. Seq numbers (1 to 65) and station numbers (01 to 61) are different: MD Briefing is seq 9 and Station 05, Teaser is seq 36. See "The rail as built" at the end. Rows below marked "storage not built", "comms send not wired", "connectors: none" and "assign responsibilities 🔴" are superseded by D41, D43 and the shipped step ownership. Project-owned rails with add, remove, restore and saved templates shipped (#147, #231, #371, #372, #390, #404); see "Saved company rails" below.

# Sell-side Deal Rails — human input vs AI agent, step by step

Status: draft for team discussion (2026-06-30; aligned to the Vision 2-pager for the 2026-07-06 sync). Author: Marcelo (info architecture). Design-system companion: deferred until front-end work resumes.

This doc is the **Skills** map in the Vision 2-pager's "Rails + Skills" model (v1.1): each step below is one of the ~82 sell-side skills/apps, run by a human, an agent, or both, on top of the shared Rails (orchestration, permissions, approval gates, audit log, cost attribution). It names what each step is and who acts; the Rails decide when it runs, what it may see, and whether its output may leave.

## Why this doc exists

At the 2026-06-29 weekly sync, two asks converged into one deliverable.

Lance, in #internal-intelibank:

"we need a clear map of the 'rails/train tracks' we are building for a deal workflow — with what the human inputs vs what the AI agents do (and the skills they use)" — and "focus on this more than the design."

Storm, in the same sync (the McDonald's analogy, Granola notes): the platform is an orchestration layer that routes an "order" (the deal) through discrete tasks to closing, where each task is a human, an agent, or a skill. The MVP is not autonomy. It is a sequential checklist that walks a human from deal-open to close.

This doc answers that ask at the level of the whole deal. It is information architecture, not UI. No screens are proposed. It enumerates the sell-side lifecycle as a sequence of steps and, for each, names the human input, the agent automation, the skill, and what already exists in the repo today.

Relationship to the existing map: `copilot-surface-action-map.md` is the same idea zoomed into one step (the teaser workflow's ten internal states). This doc is the whole train line; that doc is one station's internals. Same vocabulary, two scales.

UI realization: this doc is the decision record and rationale; PR #62 (`src/lib/rail/dealRail.ts` + `DealRail.tsx`) rendered the rail as a typed, deterministic fixture with these Phase 0–6 steps. The code has since moved to the 5-phase ledger rail (status note above); this doc keeps the "why" and the open questions, and the code holds the step list.

## The mental model (Storm's analogy)

```
ORDER (deal in)                                              BAG (closing)
   │                                                            ▲
   ▼     ORCHESTRATION LAYER routes the order task by task      │
   ┌──────────────────────────────────────────────────────────┐
   │ step 1 ──► step 2 ──► step 3 ──► … ──► step N              │
   │   │          │          │                                 │
   │ [human]   [agent]    [human]   each step: a human OR an    │
   │           +skill                agent (with a skill)       │
   └──────────────────────────────────────────────────────────┘
```

Quoting Storm: "if there are 100 steps to get an M&A deal done, there's like, I think we currently have 92. I view each of those steps as an app." (Example he gave: an "NDA app" that sends, negotiates and closes the NDA.) The Vision 2-pager settles on ~82 steps as the working figure; either way the shape is the same — an ~80–90-step sequence, each step an app assigned to a human, an agent, or both.

## Three layers — do not build them all at once

The single most important framing from the sync: the MVP is the rail itself, not the intelligence on each step.

```
LAYER 0 — MVP (now)        LAYER 1 — allocation         LAYER 2 — autonomy (years out)
guided checklist that      the system assigns each      agents run steps end to end;
walks the HUMAN open→close  step to a human OR an agent   "deal in, done in ~2 weeks"
+ stand up the deal team    and optimizes it
+ connect email/cal/        (Martin's loop)
  files/CRM
+ assign responsibilities
```

Storm: "the MVP is just that. It's not doing everything autonomously. It's a workflow platform that lets a human walk from the beginning of a process to the end, making sure every task is a checklist: did you do this? I did. OK, next phase."

Important nuance for our team: for the Preparation phase we already have MORE than Layer 0 (a real, end-to-end teaser workflow with research + draft + compliance — `workflows/teaser.ts`). So our MVP work is mostly stitching the steps into one sequential rail and building the connectors, not building each step's brain from scratch.

## The rail — sell-side lifecycle, step by step

Status legend: ✅ real on `develop` · 🟡 schema/logic only (no storage/UI/wiring) · 🔴 not built.

The repo today models deal status as `intake → active → paused → closed` (`src/lib/constants/deals.ts`) and document access as numeric phases 0+ (`documents.min_phase`). Semantic phase labels (naming phase 0, 1, 2…) are not yet defined in code — that is a downstream product decision flagged below. The phase names here are the proposed product layer over those numeric gates.

### Phase 0 — Mandate & origination (deal status: intake)

| Step (the "app") | Human input | AI-agent automation | Skill / mechanism | Today |
|---|---|---|---|---|
| Win the mandate (pitch) | MD pitches, wins | — | — | 🔴 off-platform |
| KYC / conflicts / FINRA / MNPI screen | MD confirms parties | screen the engagement before any work | KYC→FINRA→MNPI cascade; `compliance/screen.ts` | 🟡 screening rules real; the intake "compliance boot" not wired |
| Create the deal, mint the code | MD names target + codename | auto-mint `PREFIX-YEAR-NNN`, set MD | `POST /api/v1/deals` | ✅ |
| Stand up the deal team | MD invites by email + role | — | `POST /deals/{id}/members`; roles md/deal_team/legal/cco/admin/seller/buyer/read_only | ✅ |
| Connect email / calendar / files / CRM | MD authorizes connectors | ingest + index for downstream agents | (connectors) | 🔴 the deferred open question from the sync |
| Assign responsibilities + limits | MD assigns owners per step | — | (responsibility map) | 🔴 |

### Phase 1 — Preparation (active, phases 0–1)

| Step | Human input | AI-agent automation | Skill / mechanism | Today |
|---|---|---|---|---|
| Stand up the data room | team uploads | classify (1–4), phase-gate (min_phase) | `documents.classification` + `min_phase` | 🟡 schema real; secure storage not built (see `data-room-analysis.md`) |
| Assess seller readiness | — | score readiness from fixtures | skill `deal-readiness` → ScoreBreakdown | ✅ (fixture-driven) |
| Build + screen the buyer universe | MD sets thesis | rank acquirers by fit | skills `acquirer-fit`, `culture-signal`; `scoring/composite.ts` (Anthropic 87 / Salesforce 67) | ✅ (fixture-driven) |
| Deep-dive a candidate | MD picks one | generate panels | Valuation Football Field, Culture Matrix, Synergy Stress Test, Founder Read | ✅ (fixture-driven) |
| Draft the teaser | MD signs off at the gate | research + draft + compliance screen | orchestration `workflows/teaser.ts` (externalFacing) | ✅ end-to-end (mock agents) |
| Draft the CIM / mgmt presentation | MD reviews | research + draft against a house-style skill | (future workflow; Rogo's highest-leverage skill) | 🔴 "want to close" bucket |

### Phase 2 — Marketing & outreach (active, phases 1–2)

| Step | Human input | AI-agent automation | Skill / mechanism | Today |
|---|---|---|---|---|
| Send teaser to buyers | MD signs off (external) | pre-send compliance gate clear/hold/block + rewrite | `compliance/supervisor.ts` gate; AWAIT_SIGNOFF | 🟡 gate real; comms send not wired |
| NDA handling | legal reviews turns | send, negotiate, close the NDA | (future "NDA app") | 🔴 |
| Distribute CIM to NDA'd buyers | MD releases | phase-gate access per buyer | `min_phase` + membership phase | 🟡 logic real; storage not built |

### Phase 3 — First-round bids (active, phases 2–3)

| Step | Human input | AI-agent automation | Skill / mechanism | Today |
|---|---|---|---|---|
| Collect IOIs / hold mgmt presentations | MD schedules | — | — | 🔴 |
| Re-rank buyers on signal | MD weights | refresh fit scores with new info | scoring re-run | 🟡 scoring real; live inputs not wired |

### Phase 4 — Diligence & second round (active, phases 3–4)

| Step | Human input | AI-agent automation | Skill / mechanism | Today |
|---|---|---|---|---|
| Open data room to shortlist | MD grants | record every view to the audit trail | `POST /documents/{id}/view` → `audit_log` | 🟡 audit real; storage not built |
| Diligence Q&A | team answers | surface answers + flag missing info / risks | (future; this is Maywood's wedge) | 🔴 |
| Collect LOIs / binding bids | MD evaluates | — | — | 🔴 |

### Phase 5 — Negotiation & signing (active → closed)

| Step | Human input | AI-agent automation | Skill / mechanism | Today |
|---|---|---|---|---|
| Negotiate the SPA | legal + MD | draft turns, redline diffs | (future) | 🔴 |
| Final terms + sign | MD signs | — | — | 🔴 |

### Phase 6 — Closing & post-close (closed)

| Step | Human input | AI-agent automation | Skill / mechanism | Today |
|---|---|---|---|---|
| Complete / regulatory | MD + legal | — | — | 🔴 |
| Freeze the closed record | CCO/admin places hold | block any purge of the deal + documents | legal hold S0.4 (`place_legal_hold`) | ✅ (PR #60) |
| Retain the immutable audit | — | append-only, cannot be erased | audit_log S0.3 (#49) | ✅ |

### Cross-cutting on every step (the moat)

| Concern | Mechanism | Today |
|---|---|---|
| Compliance at the OS level (not per-skill) | KYC→FINRA→MNPI + promissory/MNPI screening + rogue-agent monitor | 🟡 rules + monitor real; full cascade wiring deferred |
| Immutable audit of every action | `audit_log` append-only (#49) | ✅ |
| Autonomy decided by stakes, not vibes | the stakes dial (below) | ✅ |

Lance's framing of why this cross-cut is defensible (Granola): "all the compliance sits on the operating system level. If FINRA tightens a rule, every app on top is compliant automatically. Rogo would have to redevelop every skill at every bank. That's the benefit, just like Apple."

## Human vs agent — the allocation rule (already in the spine)

The "who does this step, human or agent" question is not decided ad hoc. It is a property of the job's stakes, already implemented in the orchestrator:

```
LOW stakes, internal     →  agent runs the step to completion, zero gates
HIGH stakes / external   →  agent drafts, but the human CONFIRMS the plan and SIGNS OFF
                            the output before anything leaves the firm
```

So the rail above is not "human xor agent" per row forever. Most steps start human (Layer 0), and each becomes a candidate for agent execution as we move it to Layer 1, governed by this stakes rule. The teaser is the proof: external-facing, so it always pauses for sign-off.

Concretely, each step carries one of three actor values (matching `RailActor` in PR #62): **human** (only a person acts), **agent** (the agent runs it solo, low-stakes), or **both** (the agent drafts and a human signs off — the high-stakes/external default). "Both" is not a halfway state; it is the sign-off gate made explicit on the step.

## Always-on capabilities (the non-sequential layer)

The rail is the sequential spine, but not everything is sequential. A second layer of agent capabilities runs *across* the rail, always on, independent of which step the deal is on. These are Storm's "v1 journeys" that are not a checklist, and PR #62 surfaces them alongside the rail:

- Deal-scoped (live on the rail): ask-the-deal (answer any permissioned question with citations), pre-send QC (screen every outgoing external item), comms capture (emails/calls/meetings summarised under the deal code), weekly update.
- Portfolio-scoped (cross-deal / personal): the morning digest, the staffing / deal-intensity view.

They split by scope, not by phase. The sequential rail answers "what is the next step on this deal"; the always-on layer answers "what should I know right now, across everything." Both read the same live record and audit trail.

## Where the MVP line sits

For the first build, Layer 0 needs only:

```
[ create deal ✅ ] → [ stand up team ✅ ] → [ connectors 🔴 ] → [ assign owners 🔴 ]
   → walk the team through Phases 1–6 as a sequential checklist
   → each step shows: what to do, who owns it, done? yes/no, next.
```

The intelligence already built (teaser workflow, scoring, panels, compliance) plugs into the Preparation step of that checklist. The gap for MVP is the rail + the connectors, not the per-step brains.

## Saved company rails

A bank can save the rail of a deal it is running and open later mandates from it.
The capability is behind `rail_templates` and is off everywhere until an operator
turns it on; `docs/03-engineering/feature-flags.md` carries the order of
enablement and the one pre-flight check that has to be made against real data.

### What a saved rail is

A saved rail is a company rail template: a named, company-owned rail kept in the
company's catalog on Rail templates, with numbered published versions. Saving a
deal's rail creates a template or brings an existing one in line with the deal,
and publishes a version. A version holds the deal's active steps in their
current order, including the ones already done or skipped, and excludes the ones
that were removed. Each step keeps its description. A step the team added with a
skill keeps that skill, in the version the step has selected as its default,
never the version of its most recent one-off run. A house step carries a skill
only when the deal chose one for it; every other house step uses the firm skill
when it runs.

A saved rail belongs to one bank company and one tenant. Using it grants nobody
any access to the deal it came from, and the picker projection carries no source
deal identifiers at all.

### Naming and replacement

A name is 1 to 80 characters, is not "Default", and is unique within the
company. A name already in use is refused and the MD keeps what they typed.

Replacing a saved rail applies the deal's differences to the template as logged
changes: steps added and removed, a changed step description, a changed skill,
the template's description. Each appears in the template's History and can be
undone there. The next version is then published. A replacement is refused when
the template has changes that are not published, when it moved to another
version since the dialog opened, when the two rails order their shared steps
differently, and when nothing differs.

Published versions are never changed or deleted. A deal created from an older
version can still be traced to the exact skill packages it was given.

### The deal follows the rail it saved

After a save, new or replace, the deal follows that template at the version it
just published. Other deals built from the template are told about the new
version and choose, step by step, what to take. The deal that saved is offered
nothing, and its team is not notified about its own save. A deal that saves to a
template other than the one it was built from stops following the first. What
its team decided about the first template's changes stays with that template and
decides nothing the new one offers.

Rail templates saved before the catalog existed are retired. They are no longer
offered when a mandate is opened, and their names are free. Deals created from
them are unchanged. To bring one back, save the rail again from its deal.

### What a new deal starts with, and what it does not

A deal created from a saved rail starts with fresh step identities, renumbered
from one, and independent project-scoped skill identities. It carries no named
owners or recipients, no work, no skips or completions, no outputs, no
documents, no run history, no authoring conversations, and no access grant to
the source deal. Enhancing a skill on the new deal afterwards changes only that
deal.

Everything Gate 0 already does still happens: validation, the conflicts
attestation, team selection, notification receipts, and the protected steps that
cannot be removed from any rail.

### What is shared, and what the MD is told

Saving a rail shares step descriptions and the selected skill instructions with
the whole company. People, deal work and results are not copied. The dialog says
exactly that, every time, alongside the count of active steps and a floor on how
many of them carry a skill. It is a floor because the browser does not see every skill choice the server
reads, so the disclosure must never read as a ceiling.

### When something is interrupted

A save is one request carrying a request id. If the answer is lost, saving again
resends the same id and receives the first result; nothing is saved twice. The
id is matched together with the deal, so it is never answered with another
deal's save.

A template-backed create is admitted on the server under a request id before any
package work happens, and the browser keeps that id. If the response is lost,
reopening the wizard finds the pending command, shows its original values read
back from the server, and offers a retry. Retrying replays the same id: it
finishes the one command that was admitted rather than starting a second, so no
interrupted mandate becomes two deals.

A create that cannot be finished is abandoned explicitly. It is never silently
discarded, and no failure that might have been admitted mints a new id.

### If skills are not available

A save or a create that carries any skill fails in as many words when skill
capability is off or the skill service cannot be reached. It never downgrades
quietly to copying the structure alone: an MD who is told a rail was saved has
been told the skills went with it.

### Where it lives

| Concern | Where |
|---|---|
| Migrations | `supabase/migrations/20260921100000_rail_templates.sql`, `20260921110000_create_deal_from_template.sql`, the catalog (`20261002110000_rail_catalog_templates.sql` to `20261002170000_rail_catalog_soft_delete.sql`), `20261005100000_rail_catalog_publish.sql`, `20261005200000_template_change_review.sql`, `20261006100000_catalog_step_skills.sql`, `20261007100000_save_rail_on_catalog.sql`, `20261008100000_retire_old_saved_rails.sql` |
| Save, list, preview | `POST|GET /api/v1/rail-templates`, `GET /api/v1/rail-templates/{templateId}` |
| Create and resume | `POST /api/v1/deals` with `railTemplate` + `requestId`, `GET|POST /api/v1/deals/template-creations/{requestId}` |
| Package retention | Ignatious `POST /v1/conductia/rail-templates/revisions/{revisionId}/retain` and `/imports/{requestId}` |
| Permission to save or replace | `company:rails:templates:manage` on the source deal's bank, plus access to that deal |
| Permission to list or use | internal membership of the company plus `company:deals:create`; no seat on the source deal is needed |
| Feature flags | `rail_templates` with `project_rail_model` and `gate0_api_create`; other deals are told about a new version and offered its changes only with `template_change_review` |

With the flag off, Gate 0 offers no rail choice, the routes answer 404, and
creating a mandate works exactly as it did before.

## Info architecture vs design system

This artifact is the info-architecture half:

- Info architecture (this doc, Marcelo): the rail itself — steps, sequence, human/agent/skill mapping, real-vs-stub status.
- Design system (deferred until front-end work resumes): how a step, its state (to-do / doing / done), and a human↔agent handoff are represented visually and consistently across the surface. The "Agents and Human Design System" Lance named. Unowned for now; picked up when the front-end build restarts.

The boundary: this doc fixes WHAT the steps are and WHO acts; the design system fixes how that reads on screen. They meet at the vocabulary (step, owner, state, gate, stakes).

## Connectors — recommended first step (when the group is ready)

A connector lets the platform read the MD's real work data (email, calendar, files, CRM). There are none today: agents run on fixtures or hand-uploaded data. This matters because an agent can only automate a step if it can see that step's data, so most of the "AI agent automation" column above stays blocked until a connector exists. The group deferred this in the 2026-06-29 sync as "too early"; this section records the recommendation so it is ready when they pick it up, not to force the decision now.

Which connector first, weighed by value, compliance risk, and how much of its safety wrapper we already have:

| Connector | Value for the deal | Compliance risk | Envelope today |
|---|---|---|---|
| Files / data room | High — unblocks the document agents we already have (teaser, later CIM, diligence Q&A) | Medium — scoped to the deal's data room, not a personal inbox | ✅ ~80% built: `classification` (1–4), `min_phase` gate, MNPI screen, immutable audit, access predicates |
| Email | High — the proactive-agent thesis (Maywood) | High — MNPI, attorney-client privilege, personal data | 🔴 heavy, to build |
| Calendar | Low/Medium — meeting briefs | Low | 🟡 simple |
| CRM | Medium | Medium | 🟡 partial |

Recommendation: start with files / data room. Highest immediate leverage (it feeds the document agents that already exist), most contained risk (it lives inside the deal's data room, not the MD's personal mailbox), and its compliance envelope is largely already built — a files connector plugs into `documents.classification` + `min_phase` + `audit_log` (#49) + legal hold (#60) + `access.ts` rather than needing a new one. Email is the bigger prize but demands a much heavier envelope (privilege, personal data, MNPI at inbox scale); it is the natural second connector, once the pattern is proven on files.

The compliance envelope in one line: scope (what may enter — deal data room only), screen on ingest (MNPI), gate (classification + phase), audit every access, retain (legal hold). Files reuse all five; email would need each one rebuilt at inbox scale.

## Open questions for the team

1. Phase labels. The repo gates documents by numeric phase (0+) but names no phases. Do we adopt the Phase 0–6 names proposed here, or a different cut? This is the product decision the rail is waiting on.
2. Connectors. The precondition for most agent steps, deferred by the group as "too early." Recommendation captured above (files / data room first); open decision is when to start and whether the group agrees files-first.
3. Layer-1 ordering. Which steps move from human to agent first? The teaser is done; the Rogo "want to close" set (persistent data room, scheduled sweep, CIM draft, house-style skill) is the natural next batch.

## Source grounding

- UI realization of this rail: PR #62 (`src/lib/rail/dealRail.ts`, `src/components/rail/DealRail.tsx`, `TeaserRunner.tsx`) — rendered these Phase 0–6 steps at the time; the code now follows the 5-phase ledger rail ("The rail as built"); the always-on capabilities above live in the same file.
- Lance's directive: #internal-intelibank, 2026-06-29 (the "rails/train tracks" message).
- Storm's analogy + MVP framing + "92 of 100 steps" + the compliance/OS moat: Granola notes, Conductia Weekly Build Sync, 2026-06-29.
- Deal status / phases: `src/lib/constants/deals.ts`, `supabase/migrations/20260604100000_permissions_schema.sql`.
- Orchestration spine + teaser workflow + stakes gates: `src/lib/orchestration/` (`orchestrator.ts`, `types.ts`, `workflows/teaser.ts`); engineering walkthrough in `docs/03-engineering/orchestration-spine.md`; experience side in `docs/02-product/copilot-surface-action-map.md`.
- Skills + scoring + panels: `docs/02-product/skills-catalog.md`, `src/lib/scoring/composite.ts`, `src/components/panels/`.
- Compliance: `src/lib/compliance/screen.ts`, `src/lib/orchestration/compliance/supervisor.ts`.
- API surface + roles: `docs/03-engineering/api-v1.md`, `src/lib/api/v1/access.ts`, `src/lib/constants/roles.ts`.
- Data room + legal hold + audit: `docs/03-engineering/data-room-analysis.md`, `docs/03-engineering/legal-hold-design.md` (#60), audit immutability (#49).
- Competitive context (Rogo self-service skills; Maywood proactive agent): Rogo "Enhanced Projects" one-pager + `docs/02-product/rogo-skills-gap-map.md`.
- Rails + Skills framing, ~82-step figure, "connectors not replacements", the per-project vault ("index files in place... never copied off"): Conductia — The Vision on Two Pages (v1.1, post-Storm review, 3 Jul 2026).
- Storage / isolation model behind the connectors recommendation (BYOC + per-deal crypto + Object Lock): `docs/03-engineering/isolation-and-storage-architecture.md` (PR #63).

## The rail as built (2026-10-24)

Generated from `docs/06-research/hv-extraction/ledger/hv-ledger.json` into `src/lib/rail/railData.generated.ts`; `src/lib/rail/dealRail.ts` builds `DEAL_RAIL` (all 65 steps) and `MVP_DEAL_RAIL` (the 61 rendered stations) from it. The Phase 0–6 list above is the June map.

| Phase | Name | Steps (seq) |
|---|---|---|
| 1 | Origination, Qualification & Mandate | 25 (1–25); seq 1–5 are New Business Development, a separate pre-mandate timeline cut from the MVP rail |
| 2 | Preparation & Market Readiness | 13 (26–38) |
| 3 | Marketing & First-Round Bids | 7 (39–45) |
| 4 | Diligence, LOI & Definitive Docs | 5 (46–50) |
| 5 | Signing, Closing & Post-Close | 15 (51–65) |

On the MVP rail the first stations are Gate 0 (code name, conflicts, and a synthetic notify step with no seq), then Relationship Pathing (seq 8). A station number (`stationLabel`, "Station 05 of 61") counts rendered stations; a seq number is the ledger position. A project's own rail can differ from these defaults once steps are added, removed or restored (`project_rail_model`).

