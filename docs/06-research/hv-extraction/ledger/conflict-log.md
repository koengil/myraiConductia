# Conflict Log — H/V Extraction (curated)

21 raw conflicts from 6 candidate extractions, deduplicated into 10 entries. Each carries both readings and a recommendation. **C1–C6 are the questions for Storm** (also rendered in D1); C7–C10 are team-internal reconciliations.

## C1 — Step count: "~82 steps" vs Seq 1–65 + 21 horizontal apps
- **Reading A:** Storm's framing (call notes, Vision 2-pager, repo docs — one quote says "92 of ~100"): the sell-side process is ~82 steps.
- **Reading B:** Master Process v2 (freshest, 2026-07-08): 65 chronological steps + 21 always-on horizontal applications = 86 build items.
- **Recommendation:** adopt 65+21 as canon (docx v2 precedence; the doc self-describes as the build backlog). Confirm with Storm that the 82→65+21 re-decomposition is intentional, not a loss.

## C2 — Phase model: 5 vs 7 (vs repo 0–6)
- **Readings:** whiteboard + Master Process v2 = **5 phases**; product-deck slide = 7 (Mandate/Prep/Marketing/Diligence/Negotiation/Signing/Close); repo `deal-lifecycle-rails.md` = phases 0–6.
- **Mapping:** Mandate→P1, Preparation→P2, Marketing→P3, Diligence+Negotiation→P4, Signing+Close→P5.
- **Recommendation:** 5 phases canonical. The 7-phase slide is investor framing; repo docs need updating. Confirmed by precedence rules; low-risk to present as settled.

## C3 — V1 scope of the always-on layer
- **Reading A:** Master Process assigns 27 numbered OS builds (21 apps + 6 OS-built sequenced steps) to the OS team.
- **Reading B:** the Handbook's V1 contraction: 4 surfaces + ONE agent, seams only for the rest.
- **Recommendation:** treat the 21 apps as the full horizontal catalog, and ask Storm to bless a V1 subset (the 4 priority-shaded apps are the obvious start: External-Send QC, Pipeline CRM, Work-Check, Sector Intelligence).

## C4 — Deferred-app tension: CIM drafting + Negotiation Copilot
- **Reading A:** protected v1 exclusions (Blueprint/Founders/Handbook agree): no CIM authoring, no negotiation copilot in v1.
- **Reading B:** Execution Guide/Master Process include CIM/MP drafting (Seq 37, RTS #34, A+H) and Negotiation Copilot (OS #16) in the build sequence.
- **Recommendation:** both live in the *full* backlog with build numbers ≥ 30 — i.e., sequenced later, not v1. Present as "in catalog, not in v1" and confirm.

## C5 — Models direction: multi-model vs Anthropic-only v1
- **Reading A:** Multi-Model Verification (OS #7) + Model Optimization (OS #24) + ≤40%-of-all-Claude-cost KPI presume multi-model routing.
- **Reading B:** Jul-2 direction: one enterprise API (Anthropic, zero retention) behind an internal router; routing deferred ("audit complexity isn't worth it yet").
- **Recommendation:** v1 = single provider behind the router seam; the two OS apps are the v2 activation of that seam. Needs Storm's nod.

## C6 — Pre-Send QC verdict shape
- **Readings:** Handbook worked example = binary BLOCK, no override; Vision 2-pager = green/yellow/red with logged yellow acknowledgment; Execution Guide adds a banker-invocable **rush-send override** (addressee-only check, rest deferred + logged for supervisory review).
- **Recommendation:** one canonical answer required before the QC surface is built. Suggest: tri-state score for drafting UX, hard block on red, rush mode as a logged supervisory exception. Storm + compliance call.

## C7 — Layer of OS-built sequenced steps (settled in ledger)
Sequenced steps built by the OS team (Seq 4, 6, 7, 26, 32, 43) sit at a specific step (vertical position) but are horizontal-team builds → classified **hybrid** per the call-notes reframe ("some verticals are built by the horizontal team"). Applied throughout the ledger.

## C8 — Execution-class vocabulary (repo reconciliation)
Repo `RailActor` (PR #62) has 3 values (human/agent/both); canon has 4 classes (A / A+H / H+A / H) — "both" can't express who leads. D2 build must migrate the type.

## C9 — Gate-0 composition (settled)
Canonical gate 0 = exactly 4 pre-deal actions (code name, team/permissions, notify compliance/mgmt, lifecycle entry point) per Lance's Slack note + call notes. Repo's Phase-0 six-step version (adds pitch, connectors) is superseded — pitch lives inside Phase 1 (Seq 21–25).

## C10 — Stale repo docs (team-internal)
`deal-lifecycle-rails.md`, `skills-catalog.md` (5 draggable sandbox panels ≠ step-apps), `experience-spine.md` (4-destination IA, per-skill Pro paywall) predate the v2 canon. Preserve their unique value (per-step build-status map, connector sequencing, sandbox code contracts) but mark them superseded on phases/steps/classes/monetization. D2 spec is the vehicle.
