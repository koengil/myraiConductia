> **Delivered.** The Ignatious beta shipped as `v0.5.6` on 2026-09-07 (production at app.conductia.com, `v0.6.0` on 2026-09-15). This document is the point-in-time scope lock (ADR-0013 / D45); the next target is MVP 2 (Oct 30, 2026), whose proposed scope (PR #146) closed unmerged and is to be recorded as a decision.

# Labor Day MVP — Scope Lock (2026-08-03)

> **Source:** Conductia Labor Day MVP Alignment deck (Aug 3, 2026).  
> **Beta date:** Monday, September 7, 2026 — Ignatious begins using the agreed core product.  
> **Scope changes:** Storm approves; the delivery team coordinates day to day (Lance accountable, Rob product lead).

## Thesis (one line)

Ignatious can open a **real deal** and manage it through the defined sell-side workflow. Every step has an owner, a status, and proof of what happened. AI assists selected steps; the banker controls each decision and can continue without it.

## Day-one workflow (six capabilities)

| # | Capability | Ship target |
|---|------------|-------------|
| 01 | Secure sign-in — company and user permissions | `develop` |
| 02 | Deal setup — name, code name, team, compliance notice, starting point | `develop` (Gate 0) |
| 03 | Complete process — sell-side workflow from setup through close | `develop` (deal rail) |
| 04 | Step ownership — owner, status, deadline, required result | `develop` |
| 05 | Step completion — complete or skip with reason and proof | `develop` (G16 + rail) |
| 06 | Documents and access — permissioned deal folder, Box-backed data room | `develop` (#123 + #124 room-split) |

**Result:** deal status, next step, and action history are visible.

## Launch blockers (required by Sep 7)

| Priority | Scope | Owner | Status on `develop` |
|----------|-------|-------|---------------------|
| Workflows in action | Human workflow, clear next step, owners, evidence, audit | Rob | **Shipped** (Gate 0 + rail + audit) |
| Onboarding + rooms | Ignatious users, permissions, deal folder, data room, Box | Martin | **Shipped** (#124; `platform_onboarding` flag) |
| Compliant communication | Messages sent inside Conductia are pre-screened | Marcelo | **Shipped** (#126, D41) |
| Digital twin (narrow) | Person brief — background, priorities, comms style, decision drivers | RTS / Charles | **W2** (Aug 10–14 gate) |

## Explicitly not launch blockers

These are **post-beta** (`post-beta` label on GitHub). Do not pull into Labor Day scope without Storm sign-off.

- Automation at every step (agents/skills deepen after human workflow is stable)
- Buyer and seller onboarding (Labor Day is Ignatious-only)
- Outlook and text integration (Conductia messages first)
- Digital-twin automation (automated research, deeper profiles)
- Presentation generation
- Bank-level setup after the invite arc (#125)

## Weekly delivery gates

| Week | Dates | Gate | Outcome |
|------|-------|------|---------|
| W1 | Aug 3–7 | Integrated beta path | Combine workflow, onboarding, Box, and controls; Ignatious path end to end |
| W2 | Aug 10–14 | Person brief and walkthrough | End-to-end demo with person research, comms guidance, meeting prep |
| W3 | Aug 17–21 | Proof and controls | Permissions, documents, completion evidence, audit, compliance in one flow |
| W4 | Aug 24–28 | Ignatious acceptance | Realistic deal run, gap fixes, user prep |
| W5 | Aug 31–Sep 4 | Launch readiness | Final fixes, access check, support plan, go/no-go |

Date moves only for **launch blockers** after scope lock.

## Current build baseline (Aug 3)

| Area | State |
|------|-------|
| Deal workflow | Integrated on `develop` |
| Controls (compliance, audit) | Integrated on `develop` |
| Ignatious onboarding | Built in `duo/onboarding` → merged #124 |
| Person brief / MD Briefing | Partial; W2 deliverable |

## GitHub tracking

- **Project board:** [Conductia delivery](https://github.com/orgs/Conductia/projects/1) (the FutureProofingDev board this doc used is archived)
- **Epics:** workflow, onboarding+Box, compliant comms, digital twin, integrated beta path
- **Completion bar:** work lands on **`develop`** (see [`delivery-model.md`](../03-engineering/delivery-model.md))
- **Decision record:** ADR-0013, decision-log D45

## Cadence

- **Weekly delivery review:** live demo, written scorecard (done / next / at risk / owner), one bottleneck with owner and next action. Blockers escalated within 24h.
- **Monthly strategy:** separate from weekly delivery.
