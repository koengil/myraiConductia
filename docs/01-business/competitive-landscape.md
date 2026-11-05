# Competitive Landscape — Conductia

This document covers the competitive structure in depth: who the named competitors are,
what their structural weaknesses are, and how Conductia differentiates. For the
strategic moat argument — why Conductia's compliance-first architecture is durable —
see [`../00-vision/strategy-and-moat.md`](../00-vision/strategy-and-moat.md), which owns
that argument and carries the full Rogo contrast table.

---

## 1. Competitor A — Rogo (~$2B valuation)

Rogo is the primary named competitor and the explicit contrast for Conductia's
positioning.

**What Rogo does:** Rogo operates as a ChatGPT-style financial research tool. The core
interaction is a natural-language prompt — "I want to buy Apple" — that returns an
aggregation of public financial information. The output is a data dump oriented toward
PowerPoint generation. This is junior-analyst work: information retrieval and formatting,
not senior decision-support.

**Structural weaknesses:**

- **No compliance infrastructure.** Rogo has no compliance layer. A managing director
  using Rogo for sensitive deal communications has no guardrail between their intent
  and a regulatory violation.
- **Per-analyst pricing.** The pricing model charges per analyst seat. This is misaligned
  with outcomes — customers pay based on headcount, not on deal quality or intelligence
  delivered. It also makes Rogo's economics dependent on users having large analyst teams,
  rather than on platform value.
- **PowerPoint-focused.** Core value proposition is deck generation, not decision support.
  As Claude and competing LLMs now offer comparable PowerPoint generation capability,
  Rogo's core differentiation erodes.
- **Data-dump output.** The interaction model surfaces volume, not decisions. Managing
  directors need surfaced judgments, not more documents to read.

Source: `99-source/01-founder-call-storm.md` § Compliance Layer as Core Product;
`99-source/03-full-transcript-2026-05-19.md` (Martín's description of the Rogo demo,
Lance's articulation of the "decisions not data dump" contrast)

---

## 2. Competitor B — the SLM incumbent

A second competitor is a larger, unnamed firm that positions itself as an "advanced AI
player" in financial services (its own characterization). Its architectural choice is to
use an SLM (small language model) rather than a full LLM. The stated rationale is data control:
a smaller model reduces the surface area of sensitive client data exposed to inference.

**What this signals:** The SLM choice reflects the same underlying pressure Conductia
addresses with its compliance layer — financial data is regulated, and uncontrolled LLM
exposure is a liability. The incumbent's answer is to constrain the model's capability.
Conductia's answer is to build a full compliance layer that monitors and controls
outputs without capping what the model can do. This is a materially different
architectural bet.

Source: `99-source/01-founder-call-storm.md` § Business Development & Partnerships
(competitive intelligence)

For the strategic interpretation of both competitors, see
[`../00-vision/strategy-and-moat.md`](../00-vision/strategy-and-moat.md) § 2 and § 3.

---

## 3. Conductia's differentiated position

Against both competitors, Conductia's differentiation rests on three structural choices:

1. **Compliance is infrastructure, not a feature.** Every skill run, every message, every
   output routes through the compliance layer. It cannot be switched off. Advisors include
   former FINRA examiners — the people who ran the examinations other firms failed.

2. **Managing directors, not analysts.** Target user is the senior decision-maker. The
   output is surfaced, scored decisions — not raw data for analysts to interpret.

3. **M&A specific, not general finance.** The focus on M&A sell-side workflow creates
   depth of coverage where generalist tools are shallow.

The full moat argument — including the compliance-as-competitive-advantage case and the
Rogo comparison table — is in [`../00-vision/strategy-and-moat.md`](../00-vision/strategy-and-moat.md).

Source: `99-source/01-founder-call-storm.md` § Compliance Layer as Core Product,
§ Target User & Workflow; `99-source/02-team-build-notes.md` § Investment Banking AI
Platform Vision

---

## 4. Movement as of 2026-09 (unverified)

Storm's monitoring agent reported the following moves in the two months before
2026-09-11. It is AI-generated competitive intelligence and has not been checked
against primary sources. Verify it before using it externally.

| Competitor | Reported move | What it means for us |
|---|---|---|
| **Rogo** | Now covers transaction workspaces, meeting intelligence, Datasite content, institutional memory, and bank-backed distribution | Rogo is moving past the research and deck tool described in § 1. It now reaches the deal workspace itself |
| **Model ML** (new) | Expanding financial work-product, data connectivity, model routing, and firmwide deployment | A second work-product competitor, selling to the whole firm |
| **Intapp** (new) | Moved its compliance platform to agent-first workflows using firm data and rules | The first named competitor on the compliance side. This directly tests the claim that nobody else has compliance infrastructure |

The memo's conclusion is that the surrounding layers are now crowded. It lists as
*not* differentiating on their own: generic deal rooms or workflow orchestration,
meeting recording and notes, basic VDR (virtual data room)/CRM/data connectors,
generic source-cited research, AI-generated decks, models, memos or dashboards,
generic institutional memory, broad "governed AI" positioning, autonomous KYC or
compliance clearance, and a proprietary foundation model. It says we should
integrate with those tools and put our differentiation in the **supervisory and
evidence layer above them**: who may act, which policy and evidence apply, who
approves and releases the work, and what record is kept.

It also flags a positioning risk. A recent SEC enforcement case against an AI
startup targeted unsupported claims about customers, partnerships, projections,
valuation, and product maturity. Every competitive or maturity claim in our sales
and fundraising material needs evidence behind it.

Source: `99-source/04-product-direction-memo-2026-09-11.md` § 2 (items 1, 5), § 4
