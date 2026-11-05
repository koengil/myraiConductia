# Ignatious Workflows and Pain Points — Call Notes (2026-07-07, provided by Lance)

> Authoritative for semantics per spec §3.2: gate 0, skip/edit rules, versioned outputs, MVP framing, team responsibilities.

## OS vs. App Layer Distinction

- Core tension: what counts as "operating system" vs. "application layer" is still unclear
  - "Always on" and "operating system" are different concepts (e.g. PowerPoint is always-on but not OS)
  - Workflow process is effectively #1 priority but was listed #9 in the current doc
- Proposed reframe: horizontal vs. vertical
  - Horizontal: things that span the entire deal lifecycle (workflow engine, compliance checker, spell check)
  - Vertical: things that happen at a specific step (valuation, pitch deck, advocacy deck)
  - Some verticals are still built by the horizontal team (e.g. deal onboarding routing)

## MVP Definition and Scope

- Storm's truest MVP: all 82 steps present, human marks each done/not done, moves to next
  - No skills, no agents, just a checklist that advances linearly
- Lance's MVP: 16 core steps across all five phases, covering origination through close
- Agreed direction: full 82-step timeline in place, with limited automation added progressively
- Four things that must happen at deal creation (pre-step-one):
  1. Assign a team
  2. Create a code name
  3. Notify compliance and management
  4. Confirm where in the lifecycle the deal is entering
- Steps can be skipped with human approval; reason for skip routes to the appropriate next step
- Editing completed steps: always allowed (not reverting the flow, just updating that step's output)
  - Valuation is the clearest example: updated many times, stored as versioned outputs (e.g. Pitch Valuation V1, V2; Advocacy Valuation V1, V2)

## Workflow Demo (Roberto's Prototype)

- Showed the "Dil console": deal list, research feature, per-deal skill runner
- Two views: Focus (current step) and Full Array (all steps)
- Each step can: run a skill/agent, track token usage, require approval, be marked complete
- Step-level compliance tracking and audit trail already in place

## Document and Prioritization Alignment

- Dan shared "Sell Side M&A Master Process and Build Sequence 2.0" this morning
  - Attempts to map 82 steps to five phases and flag horizontal vs. vertical
  - Storm: first draft, not yet agreed, needs everyone's input on ordering and classification
- Execution guide also shared: template for describing each build component
- Markus's input/output framework for each component:
  - What is the input, format, and source (API, file, etc.)
  - What is the transformation/process
  - What is the expected output format
  - Constraints, edge cases, and guardrails for AI
- Svetozar: watching Dan perform a deal manually would surface what documents don't capture
- Request for a sample completed deal folder (e.g. "Blinky" deal + best pitch/advocacy decks from other deals, mixed and matched to show a full process)
  - Markus suggested using Claude to de-identify or generate sample input files at scale

## Roles and Build Responsibilities

- Futureproofing: horizontal layer, workflow engine, orchestration, audit/tracking
- RTS (Markus, Svetozar): vertical agents and skills at each step
- Ignatious/Conductia: process expertise, step descriptions, prioritization input
- Each vertical step will get a dedicated 5-page spec doc assigned to a banker + RTS team member
- Integration and testing require step-lock between Futureproofing and RTS

## Next Steps (from the call)

- Simplify docs into a clear horizontal/vertical timeline (Lance): consolidate Dan's two docs into a one-to-two page visual showing each step, owner, inputs/outputs, and human vs. agent split. Share by end of day 7th July or 8th July at latest.
- Review simplified doc 1-on-1 with Storm before the wider group (Lance).
- Compile sample deal folder for RTS (Dan, Storm): duplicate a closed deal (e.g. Blinky), populate gaps with artifacts from other deals.
- Move shared docs to Google Drive and share links with the group (Dan, Storm).
- Schedule additional working sessions this week, 45-60 min each (Kyle).
