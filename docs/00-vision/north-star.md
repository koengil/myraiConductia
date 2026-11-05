# North Star — Conductia

> "Client says 'I want M&A advice' → everything handled automatically."

This document defines the 5–10 year vision. For competitive positioning and moat, see
[`strategy-and-moat.md`](./strategy-and-moat.md).

---

## 1. The destination: fully automated investment bank

The 5–10 year endpoint is a fully automated investment bank. A client issues a single
natural-language intent — "I want to sell my company" — and the platform handles every
subsequent step: research, analysis, compliance verification, counterparty identification,
and pitch preparation. No junior analysts in the loop. No compliance gaps.

The market this aims at is measured in hundreds of billions.

Source: `99-source/01-founder-call-storm.md` § Investment Banking AI Platform Vision

---

## 2. The current wedge: compliance-first infrastructure

The path to that vision begins not with automation breadth, but with compliance depth.
The mechanics are covered in [strategy-and-moat.md](./strategy-and-moat.md) § 1. This is the wedge.

Why compliance first? Because the industry's largest pain point is not lack of data or
analysis; it is the regulatory and reputational exposure that comes from non-compliant
communications. Investment banks face multi-billion-dollar fines and lose senior talent
to compliance violations. The primary risk owners are managing directors — senior people,
not junior analysts, are where most compliance failures occur.

Conductia makes compliance infrastructure the core product, not a checkbox.

Source: `99-source/01-founder-call-storm.md` § Compliance Layer as Core Product

---

## 3. Target user: managing directors

Conductia is built for managing directors — the senior decision-makers, not the analysts
who compile data. The MD's job is knowledge work and judgment, not information retrieval.
The platform surfaces the key decisions an MD must make, scored and ranked, rather than
delivering raw data dumps that require analyst hours to parse.

The initial workflow follows the highest-stakes MD moment: from first client call through
to pitch preparation. Every output — research, transcription, deck — is filtered through
the compliance layer.

Source: `99-source/01-founder-call-storm.md` § Target User & Workflow

---

## 4. The skills marketplace endgame

Long-term, the platform becomes a marketplace. Individual skills — bounded, composable
units of financial intelligence — call other skills and compose into workflows. Third-party
creators build and publish skills; the platform takes a revenue share. The model is the
Apple App Store applied to financial services.

A managing director configures their own skill harness — the specific set of skills
relevant to their deal type, client profile, and regulatory context. A different MD on
the same platform runs a completely different harness. The marketplace is the monetization
engine; the compliance layer is the trust substrate that makes third-party skills safe
to run.

Source: `99-source/01-founder-call-storm.md` § Investment Banking AI Platform Vision
(skills marketplace), § Technical Architecture & Orchestration (skill quality management
and marketplace liability)

---

## 5. Technical spine: master agent + reinforcement learning

The platform's runtime is a master agent that routes user intent to specialized skills.
Over time, compliance feedback trains the system — false positives are corrected, the
compliance signal improves, and the agent becomes more precise. Skill quality management
is an explicit concern: preventing bloat and regression in a self-teaching system requires
careful governance.

This is vision-level architecture; the current sandbox demonstrates the principle without
implementing the learning loop.

Source: `99-source/01-founder-call-storm.md` § Technical Architecture & Orchestration
