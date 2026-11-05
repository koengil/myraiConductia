# Personas & Jobs-to-Be-Done — Conductia

This document defines the primary persona and their specific jobs when exploring a
sell-side M&A transaction. For the product principles that govern how Conductia
serves this persona, see [`product-principles.md`](./product-principles.md).

---

## 1. Primary persona: the managing director (sell-side)

**Archetype:** Mike Cannon-Brookes, co-founder of Atlassian.

The MD is a founder or senior executive of a significant technology company who is
actively exploring a sale. They are not a finance professional by training — they
think in strategy, product, and culture. They rely on advisors (CFO, M&A counsel)
for technical analysis, but the final decision and the narrative belong to them.

**Key characteristics:**

- Senior enough to make the call; not doing the analysis themselves.
- Time-constrained. Every interaction with the platform must yield a decision, not a
  research task.
- Commercially sophisticated but not a compliance expert. They need compliance
  omnipresent and invisible — it must run without requiring their attention.
- High EQ. They evaluate acquirers not just on financial capacity but on cultural and
  strategic alignment. Numbers tell one story; the business and people tell another.
- Sell-side only. They are not shopping for acquisitions. They are evaluating who
  should buy them, at what terms, and whether the fit is right.

Source: `99-source/03-full-transcript-2026-05-19.md` (Lance, "the target user is the
managing director … purely focused at managing directors … senior people … knowledge
work, not administrative tasks");
`99-source/02-team-build-notes.md` § Investment Banking AI Platform Vision
("Target user: Managing directors making executive decisions")

---

## 2. Jobs-to-be-done in a sell-side exploration

The MD exploring a sale needs to answer five sequential questions. These map directly
to the skills and screens in the product:

**Job 1: Understand who could acquire me and why**
Identify a ranked set of realistic acquirer candidates — not an exhaustive list, but
the five most credible — each with a one-line strategic rationale and a composite fit
score. Understand who is AI-native, who is SaaS-traditional, and what that means for
valuation and integration.

**Job 2: Benchmark myself against my peer set**
Know where I stand relative to comparable companies (revenue, headcount, growth rate).
This is the "who sits next to me" question — the MD needs to understand how acquirers
see their company in context, before any conversation with a buyer.

**Job 3: Understand acquirer fit in depth**
For a shortlisted acquirer, understand the financial capacity to make the deal and the
cultural/strategic alignment. Not a financial model — a scored, visualised verdict on
whether the fit is real. Financial analysis covers valuation coverage, cash capacity,
growth, and margin. Cultural/strategic analysis covers vision, mission, founder
alignment, headcount, industry, product, and culture fit. See
[`matrices.md`](./matrices.md) for the full factor definitions.

**Job 4: Communicate with advisors without compliance risk**
Coordinate with the CFO and M&A advisor through the platform, with every message
compliance-checked before it sends. The MD does not want to think about what they
can and cannot say — the platform tells them, in real time, before it becomes a
problem.

**Job 5: Understand what pitch to make to a target acquirer**
Once a preferred acquirer is identified, begin assembling the pitch: what value does
the company bring to this buyer, and why is this the right deal? This job is the
next session — the current build ends with an inert "Begin Pitch Preparation" CTA.

Source: `99-source/03-full-transcript-2026-05-19.md` (Lance's description of the full
sell-side workflow: acquirer landscape → benchmarking → deep-dive analysis → compliance
theatre → pitch prep); `99-source/02-team-build-notes.md` § Platform Architecture &
Features
