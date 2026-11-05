# Rogo Skills vs Our Agents — Gap Map

Status: draft for team discussion (2026-06-29). Author: Marcelo.

Companion to [`../01-business/competitive-landscape.md`](../01-business/competitive-landscape.md)
(who Rogo is + structural weaknesses) and [`../00-vision/strategy-and-moat.md`](../00-vision/strategy-and-moat.md)
(why the compliance-first moat is durable; owns the full Rogo contrast table). This doc is
narrower: it maps Rogo's *concrete capability surface* against our *actual agent/skill set*,
and sorts every gap into build / skip / already-ahead.

## Why this doc exists

On 2026-06-29 Storm shared two Rogo artifacts (confidential, built by Rogo for Ignatious):
a management-presentation skill walkthrough, and the "Enhanced Projects" one-pager. Lance
asked the team for key takeaways. This is the build-side reading: not "can we beat Rogo
feature-for-feature" (we can't and shouldn't), but "given what they ship, which gaps do we
deliberately close, which do we deliberately skip, and where are we already ahead."

The new signal vs the existing landscape doc: Rogo has moved past "ChatGPT for finance / deck
generation" into **persistent deal workspaces** ("Enhanced Projects", up to 10k files per
mandate) plus a library of **house-style skills** that encode a firm's format and approach.
That is a real step up in surface area, and worth naming honestly.

## What Rogo now offers (from the 2026-06-29 materials)

- **Persistent Projects / deal workspace** — drop a full data room (up to 10k files) into one
  workspace per mandate; data room, model and outputs live together, no re-uploading deal to deal.
- **House-style skill ("the Ignatious way")** — encodes formatting, sector lens, deal approach;
  drafts the CIM, management presentation or buyer deck in the client's own format.
- **Buyer lists / screening** — build acquirer lists and screen by sector, stage, geography.
- **3-statement models & valuation** — build/refresh from historicals and management accounts.
- **Recurring scheduled tasks / digests** — e.g. "every Monday, summarize new tech M&A across
  our sectors and email the team." Live today.
- **On-brand outputs** — pitch decks, transcript-to-minutes, against stored templates.
- **Document playbook** — NDA / engagement letter / LOI precedents; new-document checks and turns.

## The map (our side reflects `develop`, not `main`)

| Rogo capability | Our equivalent today | Bucket |
|---|---|---|
| Persistent Project / data room (10k files) | none — spine envelope is synthetic ("no data room") | **Want to close** |
| Draft CIM / mgmt presentation / buyer deck | `DraftAgent` — teaser only | **Want to close** |
| House-style / firm-template skill | none | **Want to close** |
| Recurring scheduled digests | planned async **sweep agent** (named in `types.ts`, not built) | **Want to close** |
| Buyer lists / screening | `acquirer-fit` + `deal-readiness` skills + composite scoring | **Already ahead** |
| 3-statement model build/refresh | Football Field + `financial-performance` (visualization only) | **Deliberately skip** |
| Transcript-to-minutes / generic productivity | none | **Deliberately skip** |
| NDA / engagement letter / LOI turns | none (compliance is comms-only) | **Skip for now** |
| Compliance applied to output | `COMPLIANCE_SCREEN` + `ComplianceSupervisor` (pre-send gate + monitor) | **Already ahead** |
| Tamper-proof audit | immutable `audit_log` (SEC 17a-4, #58) | **Already ahead** |

## The three buckets

### Want to close (in our thesis / roadmap)

- **Persistent data room / workspace per mandate.** This is the foundation the orchestration
  spine already assumes "for later" — today every `ContextEnvelope` is hand-fed synthetic
  documents. Without a real data room, the agents have nothing authentic to read. Highest-
  leverage gap.
- **Scheduled sweep agent (digests).** `types.ts` already names the "(later) asynchronous
  sweep agent" as the second producer of Jobs alongside the synchronous copilot. Rogo has this
  live; we have the slot designed and empty.
- **Draft beyond the teaser.** `DraftAgent` produces only a one-page teaser. Extending it to
  CIM / buyer deck is a natural widening once a data room exists.
- **House-style template skill.** Encoding the firm's format/voice is cheap relative to its
  value, and it is exactly what Ignatious visibly prizes in the Rogo build.

### Deliberately skip (off-thesis — "decisions, not data / not Rogo")

- **3-statement model building.** We are a decision surface, not a modeling tool. We visualize
  valuation (Football Field); we do not rebuild the model.
- **Transcript-to-minutes and generic productivity skills.** Commodity output, not the moat.
- **Generic contract turns (NDA/LOI).** Possibly adjacent to compliance much later; not now.

### Already ahead (our wedge — the inverse of a gap)

- **Opinionated buyer screening.** Rogo generates an acquirer list; we score the decision —
  Culture Matrix, Founder Read, Synergy Stress Test, composite score. Judgment, not retrieval.
- **Pre-send compliance + immutable audit.** Rogo has no compliance layer (per the landscape
  doc). We gate agent output before it leaves the firm (`COMPLIANCE_SCREEN`) and the audit
  trail is physically append-only (#58). "They tell you after, we stop it before."
- **Governed autonomy.** The "user input vs agent automation" axis Lance flagged is our
  stakes/autonomy split: low-stakes steps run solo; anything external pauses at
  `AWAIT_PLAN_CONFIRM` / `AWAIT_SIGNOFF`.

## Honest caveats

- Everything in the "our equivalent" column lives on **`develop`** (the orchestration spine,
  the skills, the panels), not on `main` yet.
- We are behind Rogo on **surface area** (working product, many skills, scheduled tasks live),
  not on the **model** — the spine maps cleanly onto their Projects + skills shape. The bet is
  to stay pointed at the governance + decision layer rather than out-skilling them.
- The buckets are a starting proposal, not a decided roadmap. Direction is expected from the
  Storm session (Thursday).
