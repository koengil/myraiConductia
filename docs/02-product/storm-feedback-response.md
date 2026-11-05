# Reply to Storm — timeline feedback

*Short version you can send. Decisions + rationale below it.*

---

**Storm — quick answers on the timeline:**

**1. Why 65 and not 82.** Nothing was cut. The earlier ~82 was a flat list that folded the always-on platform services into the step count. v2 pulls those out cleanly: **65 sequenced deal steps + 21 always-on apps = 86 build items** — same universe, better partition. (Just confirm you're good with that split.)

**2. "Always-on ≠ Horizontal" — you're right, fixing it.** We'd labeled them together; that was wrong. New model is three layers: **Platform (always-on substrate)** → **Horizontal workflow rails** → **Vertical step-skills**.
Two things I need to confirm with you here: our source of truth from the working calls has **Futureproofing = Horizontal, RTS = Vertical** — your note reads that *inverted*, and names **"Conductia,"** which isn't in any of our docs. So: (a) which direction is right, and (b) what is "Conductia" — a name for the horizontal/orchestration layer, the platform itself, or a new party? I didn't want to flip the mapping without checking.

**3. What I need from you.** (a) The **Blinky** sample deal folder (+ a strong pitch/advocacy deck) for RTS to build against; (b) your **ranked order within the 16** priorities; (c) sign-off on the **v1 subset**; (d) the two confirms in #2.

**4. Prioritizing within the 16.** Proposed sequence: the **4 always-on substrate apps first** (External-Send QC, Pipeline CRM, Work-Check, Sector Intelligence) as the foundation, then the **Phase-1 RTS spine** (Source Intelligence, Relationship Pathing, MD Briefing, Client NDA, Diligence List, Outreach, Buyer Universe, Pitch QC) + Deal Pulse + FAQ. Your ranking overrides this.

**5. Missing horizontal apps.** Most are already in the 21 — FINRA, human-approval-for-everything, full tracking/audit, the **watching/learning agent** (exactly your getwiq idea), the **people relationship-graph**, cost tracking, access/permissions. What we're genuinely **adding**: **agentic containment** (token / document-change / external-email guardrails + kill switch), **time tracking** (we had cost, not hours), an **information knowledge-graph** (separate from the people graph), and the **next-step recommender** (after each step, suggest + let you pick the next — building it into the rail). Security, data-sovereignty, and "persistence-without-learning" already live in the compliance plan; we'll surface them on the timeline.

**6. Compliance.** All covered in the Compliance Build Plan: **SOC 2 Type II, 17a-4 WORM, FINRA 2210/4511, DORA + EU residency, ISO 42001**, append-only audit log, agentic guardrails. **GDPR** is currently handled by proxy (residency + DORA + DPAs) — we'll name it explicitly. Adding a visible **Compliance & Trust** band to the timeline.

Net: one real correction (the three-layer split), a few additive apps, and two confirms I need from you (ownership direction + "Conductia"). Everything else holds.

---

## Decisions (conductor, with source grounding)

| # | Storm note | Decision | Basis |
|---|---|---|---|
| 1 | 65 vs 82 | **Keep 65 + 21.** Add an 82→65+21 crosswalk to the doc. | Master Process v2 Part 1 (21 always-on, "not part of the sequence") vs Part 2 (Seq 1-65). 65+21=86≈82. Nothing dropped. |
| 2a | Always-on ≠ Horizontal | **Adopt the three-layer model.** Relabel + regroup the 21. | Call notes verbatim ("always-on and OS are different concepts"); Master Process "three layers" line; whiteboard always-on band. |
| 2b | Ownership / "Conductia" | **Do NOT invert. Flag + ask.** | Canon (call-notes §Roles + ledger) = FP horizontal / RTS vertical. Storm's note inverts it and "Conductia" is in zero sources — clarify, don't adopt. |
| 3 | What you need | **Add "What we need from you"** (decisions + inputs). | Call notes name Blinky folder, per-step specs, prioritization. |
| 4 | Prioritize within 16 | **Add sequencing logic + v1 cut.** | Substrate-first then Phase-1 RTS spine; closes conflict C3. |
| 5 | Missing apps | **Reassure (most exist) + add 3** (agentic containment, cost+time, info knowledge-graph) + surface compliance items. | Triage against the 21 + Compliance Build Plan + Blueprint governance layer. |
| 6 | Compliance | **Surface the Compliance & Trust spine** on the timeline; add GDPR explicitly. | Compliance Build Plan (SOC2/WORM/FINRA/DORA/ISO42001); GDPR only by proxy today. |

**Platform refinements to feed into the build** (tracked in `docs/06-research/hv-extraction/review-loop.md`):
- Three-layer labeling in the rail's always-on band (substrate vs rails) and copy.
- **Next-step recommender** on the rail (after each step: ranked suggestion + full-step dropdown, most-likely surfaced) — a real feature, Deal Workflow Coordinator.
- Surface a **Compliance & Trust** view (SOC2 / WORM / FINRA / DORA / ISO42001 / audit log / kill switch).
- Agentic-containment + cost/time as visible always-on capabilities.
