> **Sandbox platform, as of mid-2026.** The routes below (`/`, `/acquirers`, `/team`, `/skills`) describe the sandbox build. Today `/` redirects to `/projects` (the Conductor Center), the destinations live under `/projects/[projectId]/` beside the rail, Book, mail, deal folder, data room, audit and chat, the `ComplianceRibbon` is rendered by the top navigation, and `CommandBar` was retired (2026-10-25). The current journey is in the root `README.md`.

# Platform Experience — Conductia

How the managing director uses Conductia end-to-end. The product is a navigable platform with four destinations and a persistent chrome layer. Compliance is omnipresent; the MD returns across mandates and over time.

> **Historical note.** A prior version of this document described a 7-step linear demo spine (ColdOpen → Intent → Landscape → DeepDive → ComplianceTheatre → PitchCta). That spine was retired in Phase F of the front-end overhaul (commit `fbf10a0`, 2026-05-20). The platform replaced the spine; explicit navigation replaced auto-advance. The retired model survives in the front-end-overhaul ledger at `docs/superpowers/plans/2026-05-19-intellibank-frontend-overhaul/master.md` (Phase F closure entry) and in the predecessor ledger archive at `docs/superpowers/archive/2026-05-19-intellibank-sandbox-plan/`.

For the persona this platform serves, see [`personas-and-jobs.md`](./personas-and-jobs.md). For the factors and formula behind the composite score, see [`matrices.md`](./matrices.md). For the skill catalogue, see [`skills-catalog.md`](./skills-catalog.md). For the platform's documented IA, see the design spec §10 at [`../superpowers/specs/2026-05-19-intellibank-frontend-design.md`](../superpowers/specs/2026-05-19-intellibank-frontend-design.md).

---

## The chrome (always mounted)

Two elements stay mounted across every destination:

- **`AppHeader` + `AppNav`** — brand mark, four-destination navigation (inline on desktop, bottom-bar on mobile), profile menu.
- **`ComplianceRibbon`** — the single mounted `[data-compliance-status]` instrument. Reads `complianceStatus` from the session store; reflects `idle | scanning | clear | hold | blocked`. Every destination dispatches status updates via the store; no destination self-displays a second ribbon.

`CommandBar`, once the persistent intent surface, was retired on 2026-10-25: it was never mounted after v0.3.0 and staged a compliance scan it did not run. No command palette exists yet (`TopNav.tsx` notes it); what a future intent surface may answer from is #83.

## The four destinations

### `/` — Mandate

The MD's home tile. A compact dashboard of the live mandate: pipeline state, top-fit candidates, team availability, compliance posture. Reads through the seam and renders as a series of editorial tiles. The pre-loaded mandate is the Atlassian sell-side scenario; mandate switching is a future capability.

### `/acquirers` — Landscape

The ranked landscape. Five acquirers, each with a deterministic composite score (Anthropic 87, Salesforce 67, plus three others) computed from fixtures by `computeCompositeScore`. The MD scans, then selects an acquirer.

### `/acquirers/[id]` — Deep-dive workspace

The most-used surface. Carries the `Canvas` + skill shelf + analytical panels. Dragging a skill onto the canvas:

1. Streams a transform animation (~700ms).
2. Routes visibly through the compliance ribbon — it inspects, ticks.
3. Renders a panel: financial matrix, culture radar, score breakdown.

The premium skill (`synergy-engine`) shows the paywall on drop — the single explicit monetization signal.

### `/team` — Compliance theatre

A drawer of team profiles (MD, CFO, M&A Advisor) and a `MessageComposer`. Every message routes through the compliance layer before sending. Clean messages thread; risky messages are blocked with the rule reason. The compliance moat made interpersonal.

### `/skills` — Catalogue

Five skills total: four free, one Pro-locked. The catalogue surfaces the value metric: skill access = the tier signal. Upgrading is the explicit revenue line.

---

## Out of scope

Pitch preparation is documented as a future capability; it is not a destination in the current build. The retired "Begin Pitch Preparation" CTA was removed in Phase F alongside the spine. See [`../03-engineering/sandbox-vs-production.md`](../03-engineering/sandbox-vs-production.md) "Deferred" for the full list of out-of-scope work.

---

Source: design spec §10 (Platform IA); the front-end overhaul ledger Phase F closure (`fbf10a0`, 2026-05-20); decision-log D17 / D24.
