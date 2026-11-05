# Strategy & Moat — Conductia

This document covers why we win: the compliance-first moat, the explicit competitive
contrast, and the market intelligence that shapes positioning. For the long-term vision,
see [`north-star.md`](./north-star.md).

---

## 1. Why compliance-first is the moat

Compliance is not a feature — it is the architectural choice that defines Conductia's
competitive position. Every skill run, every message, every output passes through the
compliance layer before it reaches the user or any external party. This is not optional
and cannot be switched off. It is the platform's core promise.

The business case is straightforward: investment banks face multi-billion-dollar regulatory
fines for non-compliant communications. Reputational damage from leaked messages or
compliance failures at the MD level destroys careers and firms. No current AI player
for financial services has built compliance infrastructure into the core. Conductia's
advisors include former FINRA examiners — the people who ran the examinations other firms
failed.

Compliance-first means: all emails route through the platform; text and WhatsApp
communications are monitored via business accounts; every message is checked in real time
before it sends. This is infrastructure, not UX.

Source: `99-source/01-founder-call-storm.md` § Compliance Layer as Core Product

---

## 2. The anti-Rogo thesis

**Rogo is the explicit competitive contrast.**

Rogo (approximately $2B valuation) is PowerPoint-focused and charges per analyst.
The per-analyst pricing model is structurally misaligned: customers pay based on headcount,
not on outcomes or intelligence delivered. The product's core interaction is a ChatGPT-style
prompt — "I want to buy Apple" — that returns a data dump of public information. This is
junior-analyst work, not managing-director intelligence.

Critically: **Rogo has no compliance infrastructure.** There is no compliance layer.
An MD using Rogo for sensitive deal communications has no guardrail between their intent
and a regulatory violation.

Claude now offers similar PowerPoint generation capability, which further erodes Rogo's
core differentiation.

Conductia's contrast on every axis:

| Dimension | Rogo | Conductia |
|---|---|---|
| Compliance | None | Omnipresent; every action routed through it |
| Pricing model | Per analyst (misaligned) | Platform / outcome-aligned |
| Output type | Data dump | Surfaced key decisions, scored |
| Target user | Analysts | Managing directors |
| Focus | General finance | M&A, sell-side |

Source: `99-source/01-founder-call-storm.md` § Compliance Layer as Core Product;
`99-source/03-full-transcript-2026-05-19.md` (Lance's articulation of the Rogo contrast
and the "decisions, not data dump" framing)

---

## 3. The SLM incumbent: a different answer to the same pressure

A second competitive signal: a larger incumbent already positions itself as an "advanced
AI player" in financial services. Its architectural choice is an SLM (small language model)
rather than an LLM — the stated rationale is data control. This is a meaningful tell: a
small model constrains what the system can do with sensitive client data by reducing the
surface area exposed to inference.

This player's SLM choice reflects the same underlying pressure Conductia answers with
compliance infrastructure: financial data is regulated, and uncontrolled LLM exposure
is a liability. Conductia's answer is different — a full compliance layer that monitors
and controls outputs, rather than limiting model capability.

Source: `99-source/01-founder-call-storm.md` § Business Development & Partnerships
(competitive intelligence)

---

## 4. Market entry and partnerships

Business development is underway: outreach to CIOs at Bank of America and Citibank
(Van Zill contact), FINRA compliance consultants engaged for the advisory board,
and a meeting with Action Partners scheduled for June. Partnership contracts at major
banks represent $10M+ opportunities.

Source: `99-source/01-founder-call-storm.md` § Business Development & Partnerships
