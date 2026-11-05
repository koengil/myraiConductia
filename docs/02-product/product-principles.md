# Product Principles — Conductia

Five non-negotiable principles that govern every product decision. Any feature,
screen, or interaction that conflicts with these is out of scope.

For the vision these principles serve, see [`../00-vision/north-star.md`](../00-vision/north-star.md).
For the competitive logic behind them, see [`../00-vision/strategy-and-moat.md`](../00-vision/strategy-and-moat.md).

---

## 1. Managing directors, not junior analysts

The platform is built for senior decision-makers — the MD who owns the deal, not
the analyst who compiles data. Every screen is tested against the question: "Is this
what an MD needs to act, or is this analyst prep work?" If it is the latter, it does
not belong in the product.

This principle has a direct competitive implication: Rogo's core interaction (a
ChatGPT-style prompt returning a data dump) is exactly the analyst workflow Conductia
does not replicate. See [`../00-vision/strategy-and-moat.md § 2`](../00-vision/strategy-and-moat.md).

Source: `99-source/02-team-build-notes.md` § Investment Banking AI Platform Vision;
`99-source/03-full-transcript-2026-05-19.md` (Lance, "the junior analyst would go and
get all of the information … we need to focus on what is the key information that the
managing directors need")

---

## 2. Surface decisions, not data dumps

The output of every skill run is a decision surface — scored, ranked, and actionable —
not a document or a raw data export. The MD arrives at a conclusion, not a spreadsheet.

A well-formed skill output answers: "Here is what you need to know to make this
specific decision, and here is our recommended direction." The presentation is sharp
and bounded. Information that does not serve the immediate decision is omitted.

Source: `99-source/03-full-transcript-2026-05-19.md` (Lance, "it's like key
information … not overwhelming with too much information and too much data");
`99-source/02-team-build-notes.md` § Investment Banking AI Platform Vision ("Surface
key decision-making information, not overwhelming data dumps")

---

## 3. Compliance is omnipresent, above everything

Compliance is not a phase, a mode, or a filter applied selectively. It is the
architectural layer that every action — skill run, message, output — must pass through
before anything reaches the user or an external party. The compliance ribbon is
always visible. There is no interaction where compliance is absent.

This is the moat and the core differentiator. The full rationale is in
[`../00-vision/strategy-and-moat.md § 1`](../00-vision/strategy-and-moat.md).
The four compliance states and gate logic are defined in
[`matrices.md § 1`](./matrices.md).

Source: `99-source/03-full-transcript-2026-05-19.md` (Lance, "compliance layer sits
above everything … everything goes through the compliance layer");
`99-source/02-team-build-notes.md` § Investment Banking AI Platform Vision
("Compliance-first infrastructure layer")

---

## 4. Sell-side M&A only

The platform's scope is sell-side M&A. The persona is a company founder or MD
exploring a sale. Acquirers are evaluated as potential buyers, not targets. "I'm
exploring a sale of Atlassian" is the canonical intent; "I want to buy Apple" is
not a supported workflow.

This is not a temporary constraint. Sell-side focus is what makes the decision
surface tractable — who can acquire me, at what valuation, and why does it fit?
The scope may expand later; for the current build it is an absolute boundary.

Source: `99-source/03-full-transcript-2026-05-19.md` (Lance, "imagine that we're
the managing director … always using this from the sell side");
`99-source/02-team-build-notes.md` § Investment Banking AI Platform Vision
("Focus on sell-side M&A process")

---

## 5. Pre-onboarded; no onboarding flow

The demo persona arrives with company data already loaded. There is no onboarding
flow. This is both a product design principle — the platform's intelligence is
pre-contextualised — and a practical demo requirement.

Heavy onboarding is what makes enterprise software feel like work. Conductia's
promise is that the MD walks in and the platform already knows who they are and what
they own. Onboarding as a product investment is explicitly deferred; it is not in
scope for the current build and is documented as a future concern only.

Source: `99-source/03-full-transcript-2026-05-19.md` (Martín, "we're assuming that
he already onboarded all the company … we don't want to focus on the onboarding
process right now because I think it can be heavy")
