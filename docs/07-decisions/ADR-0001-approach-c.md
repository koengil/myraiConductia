# ADR-0001 — Sandbox structure: guided spine + one real workspace centerpiece

- **Status:** Accepted
- **Date:** 2026-05-19
- **Deciders:** Lance Marks (Futureproofing)
- **Source:** `docs/99-source/03-full-transcript-2026-05-19.md`

## Context

The Sunday deliverable is a clickable sandbox demo for the founder (Storm),
consumed as a **guided live walkthrough with a deployed link handed over
afterward**. The transcript's most-emphasized "wow" moment is the
*drag-a-skill → data transforms → routes through compliance → renders a
score/graph* loop ("I think storm will be like fuck all right"). The timeline
is days, and a freeform composable canvas is the riskiest thing to make feel
good under that constraint.

## Decision

Adopt **Approach C**: a guided narrative spine of polished, full-bleed
set-pieces, with **one hero screen that is a genuine drag-skills-onto-canvas
workspace** (the acquirer deep-dive). The canvas magic lives exactly where the
money beat is; everything else is a designed, deadline-safe set-piece.

## Alternatives considered

- **Approach A — single living canvas (everything is a panel).** Most
  product-true and novel, but freeform drag/drop/layout everywhere is the
  highest-risk build on a days-long clock. Rejected: risk to the deadline and
  to demo polish outweighs the upside.
- **Approach B — pure guided narrative, skills are "invoked" not composed.**
  Lowest risk, highest polish-per-hour, but softens the skills metaphor — the
  single thing the founder is expected to react most strongly to. Rejected:
  gives up the core wow.

## Consequences

- Engineering concentrates the riskiest work into one well-bounded surface.
- The hero canvas doubles as the truest preview of the real product.
- The spine screens can be built and polished in parallel by subagents.
- The composable-workspace vision (Approach A) is documented as the product's
  direction in `00-vision/`, not lost.
