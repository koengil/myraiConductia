# Conductia Interactive Sandbox — Design Spec

| | |
|---|---|
| **Status** | Approved (design locked 2026-05-19; pending written-spec review) |
| **Author** | Lance Marks + Claude (brainstorming) |
| **Date** | 2026-05-19 |
| **Approach** | C — guided spine + one real workspace centerpiece (ADR-0001) |
| **Provenance** | `docs/99-source/` (founder call, team build notes, full transcript) |
| **Supersedes** | — (foundational) |
| **Next step** | `writing-plans` → durable multi-phase ledger in `docs/superpowers/plans/` |

---

## 1. Summary

Conductia is a compliance-first M&A intelligence platform for **managing
directors**. This spec defines an interactive, clickable **sandbox demo** that
runs a single pre-loaded scenario — Atlassian, sell-side, exploring acquirers —
and the foundation documentation library the whole team builds on. The demo is
consumed as a **guided live walkthrough**, then handed over as a **deployed
URL**. It is mocked end-to-end behind a typed interface that *is* the future
backend contract, so this demo becomes the real product rather than throwaway
scaffolding.

## 2. Context & problem

**The thesis — not Rogo.** Rogo answers "I want to buy Apple" with a data
dump (junior-analyst work). Conductia answers "I'm exploring a sale of
Atlassian" by surfacing **only the key decisions an MD must make**, with
**compliance omnipresent above everything**. That contrast drives every screen.

**Audience of the demo itself:** Storm — the founder, an ex-investment-banker.
He wants credible critical numbers and will react most strongly to: (a) the
skill → transform → compliance → score loop, (b) the premium-skill paywall,
(c) a non-compliant message getting blocked. The demo is a sales artifact aimed
at one viewer with specific wow beats; the architecture serves those beats.

**Persona in the demo:** Mike Cannon-Brookes (Atlassian co-founder),
pre-onboarded. **No onboarding flow** — it is explicitly out of scope as "heavy".

## 3. Goals, non-goals, scope

### In scope (Sunday)
- The 7-step golden path (§5), guided and flawless.
- Hero canvas with 3–4 working skills + 1 premium-locked skill.
- Compliance ribbon, instrumented so every skill run + message visibly passes through it.
- Multi-user team drawer + the compliant/blocked message beat.
- Deterministic composite scoring (Anthropic 87 / Salesforce 67 computed, not hardcoded).
- Deployed URL (Vercel, `lance-fp`).
- The full `/docs` foundation library (distilled team docs + provenance).
- Repo + `CLAUDE.md` + durable plan ledger.

### Deferred (next week's demo)
- The pitch-preparation workflow (pre-call research, transcription analysis,
  psychology-profiled pitch deck). The golden path ends at an inert
  **"Begin Pitch Preparation"** CTA.

### Out of scope (documented as vision only, in `00-vision/`)
- Real backend, middleware, data integrations.
- Reinforcement-learning compliance training, false-positive correction loops.
- Marketplace billing/economics, revenue share, third-party skills.
- Onboarding. Email/WhatsApp ingestion. Bank partnerships.

### Success criteria
1. A presenter can run the full golden path with zero dead clicks or jank.
2. Each of the three wow beats lands as a designed moment with motion.
3. The numbers read as credible to an ex-banker (deterministic, internally consistent).
4. The deployed URL survives reasonable solo clicking (graceful stubs, no crashes).
5. A new contributor (human or agent) can orient from `docs/` in ~60 seconds.
6. Swapping mock → real backend later requires no UI rewrite (the seam holds).

## 4. Demo delivery mode (decided — D5)

Guided live walkthrough is the **optimization target**; the same build is
deployed to a revisitable URL. Implication: pour effort into the scripted path
and the wow beats; defensive breadth is *graceful stubs*, not full coverage.
The golden path doubles as `docs/05-growth/demo-script.md`.

## 5. Product experience — the golden path

Each step is a build unit and a demo-script beat.

1. **Cold open.** Land as Mike Cannon-Brookes / Atlassian, pre-onboarded. The
   compliance ribbon is present, idle-but-alive. No onboarding.
2. **Intent.** Command bar: *"I'm exploring a sale of Atlassian."* Submit →
   **compliance boot animation** (FINRA + checks cascade; state moves to
   "monitored & compliant"). Establishes the omnipresent-compliance tone in
   the first interaction.
3. **Acquirer landscape.** The *surfaced decision*, not a data dump: ~5 ranked
   acquirers with composite scores — **Anthropic 87** (AI-native fit),
   **Salesforce 67** (SaaS, not AI-native), + 3 others — each with a one-line
   "why". A **peer strip** (Figma/Canva-style) shows revenue, headcount,
   growth: "who you sit next to."
4. **Acquirer deep-dive — THE HERO CANVAS** (Approach C centerpiece). Pick
   Anthropic → a real workspace: a **skills shelf** at the side, a **canvas**
   in the middle. Drag a skill onto the canvas → **data-transform animation**
   → the stream **routes up through the compliance ribbon** (it inspects,
   ticks) → a **panel renders**: financial matrix, the culture/psych-fit
   radar, or the composite-score breakdown. Compose multiple skills → multiple
   panels. This is the "fuck, alright" moment.
5. **Paywall beat.** One shelf skill is premium (e.g. *Synergy &
   Deal-Structuring Engine*). Drag it → elegant lock → *Upgrade to Pro*. The
   deliberate monetization signal for Storm.
6. **Compliance-block beat.** Team drawer: you (MD), a CFO, an M&A advisor.
   Message the advisor with financials → real-time check ✓ → **sends**.
   Compose *"…here are the financials, and honestly, fuck you"* → check ✗ →
   **blocked, not sent, flagged**. The headline compliance proof.
7. **Dead-end CTA.** *Begin Pitch Preparation* — visible, inert, captioned
   "next session". Sets up next week.

## 6. The three layers (conceptual model)

Detailed in `docs/02-product/matrices.md` (built in implementation).

- **Compliance layer** — a global ribbon above everything. States: `idle`,
  `scanning`, `clear`, `blocked`. Instrumented so every skill run and every
  message visibly transits it. The moat; faked but must *feel* omnipresent.
- **Financial matrix** — valuation, revenue, EBITDA, growth, cash-vs-equity
  purchase capacity. Sharp, ex-banker-credible visualization.
- **Culture / psych-fit matrix** — vision, mission, founder, headcount,
  industry, product, culture fit. The "AI sees nuance bankers miss" story.
- **Composite score** = a **pure deterministic function** of (financial ×
  culture), gated by compliance. Documented as a real methodology; values are
  computed from fixtures so they are credible and demo-stable.

## 7. Skills model

- A skill = a named, draggable unit that performs a (mocked) data
  transformation, visibly routes through compliance, and renders a panel.
- 3–4 working skills + 1 premium-locked. Candidate set is refined by Martín's
  research (`docs/06-research/`); the spec does not hard-bind the final list.
- Per-user "skill harness" is represented (the shelf is configurable in
  concept); marketplace economics are vision-only.

## 8. Multi-user compliance demo

- Single account, multiple **profiles**: MD (you), CFO, M&A advisor.
- A team drawer + a message composer with a real-time compliance check that
  **gates send**. Two scripted outcomes: clean → sends; profane/leaky →
  blocked + flagged. Animation is the point, not real NLP.

## 9. Technical architecture

`docs/03-engineering/` holds the detailed versions.

- **Stack:** Next.js 16 (App Router) + TypeScript + Tailwind + Framer Motion +
  shadcn-style primitives.
- **The seam (the most important decision — D8):** `src/lib/api/` exposes a
  typed `ConductiaAPI` interface. `MockConductiaAPI` returns fixtures
  (Atlassian, acquirers, peers, team, skills, scores). **UI components only
  ever depend on the interface**, never on fixtures directly. This interface
  is documented as `docs/03-engineering/data-contracts.md` — the literal
  contract a future backend implements. Mock → real = one new implementation,
  zero UI rewrite.
- **Deterministic scoring:** a pure module computes composite scores from
  fixture inputs (real algorithm, fake data). No `Math.random`, no hardcoded
  87/67 in the view layer.
- **Component layers:** primitives → domain components (`ComplianceRibbon`,
  `SkillCard`, `SkillShelf`, `Canvas`, `ScoreRadar`, `AcquirerCard`,
  `MatrixPanel`, `PeerStrip`, `TeamDrawer`, `MessageComposer`,
  `PaywallLock`) → screens (the 7 golden-path steps).
- **State:** local/client state only; a single demo "session" store driving
  the scripted path. No persistence beyond the session.
- **Deploy:** Vercel under `lance-fp`. Local dev for the guided run.

## 10. Repo & docs foundation architecture

This repo is **two deliverables**: the app and the foundation library. The
`docs/` IA (full map in `docs/README.md`):

`00-vision` · `01-business` · `02-product` · `03-engineering` · `04-brand` ·
`05-growth` · `06-research` · `07-decisions` · `99-source` ·
`superpowers/specs` · `superpowers/plans`.

**Distillation principle:** raw inputs are preserved verbatim under
`99-source/` and never edited. Team docs (`00`–`06`) are distilled — accurate,
concise, structured — and every non-obvious claim is traceable to a
`99-source/` file. Building these distilled docs is an explicit early
implementation phase, not an afterthought.

## 11. Brand foundations

`docs/04-brand/` holds the detailed versions.

- **Name:** Conductia. **Positioning:** "the compliance-first M&A
  intelligence layer for managing directors." **Voice:** precise, senior,
  decisive — anti-data-dump.
- **Visual language:** a starting skin *derived from* rogo.ai (palette, type,
  component feel) but documented as Conductia's own evolvable system — not a
  clone (D11).
- **Motion language:** documented explicitly (compliance pulse,
  skill-transform stream, score reveal) because motion *is* the product's
  felt quality and the wow beats are motion beats.

## 12. Execution model (binding)

Lance's explicit requirements, made part of the design of record so the plan
and every subagent honor them:

- **Multi-phase.** The build is decomposed into ordered phases (foundation &
  distilled docs → design system + app shell + the seam → spine screens →
  hero canvas + skills → compliance theatre + paywall → motion/polish +
  deploy → verification swarm + demo dry-run). Phase boundaries are
  integration checkpoints.
- **Subagent-driven.** Independent surfaces (e.g. distinct spine screens,
  distinct docs, the radar vs. the matrix panel) are dispatched to parallel
  subagents, each fed *the spec + the ledger* as ground truth. Shared
  contracts (the `ConductiaAPI` interface, the design tokens) are
  established before parallel work begins to avoid integration drift.
- **Durable plan ledger.** `docs/superpowers/plans/<topic>/master.md` is the
  single source of truth for execution state. It is **read FIRST on any
  resume** and **updated at every phase boundary**. No execution state lives
  only in a chat.
- **Return-to-plan verification.** After each phase: re-read this spec + the
  ledger, verify completeness and accuracy against the success criteria
  (§3), and run a surgical correction pass before the next phase. "Surgical"
  = smallest correct change, follow the seam, no scope creep beyond the
  active phase.
- **Anti-context-loss protocol.** Spec + ledger + `99-source/` + ADRs +
  decision-log are committed and authoritative. A project memory entry points
  at them. Any session can be reconstructed from the repo alone.

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Freeform canvas jank undercuts the demo | Approach C confines the canvas to one bounded hero screen; build it first within its phase, polish hardest. |
| Numbers feel fake to an ex-banker | Deterministic scoring module; internally consistent fixtures; Martín's scoring research feeds the methodology. |
| Timeline slip | Guided-mode (D5) lets us cut defensive breadth to graceful stubs; phases ordered so the golden path is demo-able even if later polish is trimmed. |
| Context loss across sessions/subagents | §12 anti-context-loss protocol; ledger-first discipline. |
| Skills list churns on Martín's research | Spec does not hard-bind the skill list; the skill *mechanism* is the contract, the catalog is data. |
| Brand reads as a Rogo clone | rogo.ai is a *starting skin* only; `04-brand/` defines an evolvable system; positioning is explicitly the anti-Rogo. |

## 14. Open items & dependencies

- **Martín's research** → lands in `docs/06-research/` (M&A MD decision
  process, FINRA + compliance requirements, financial vs. cultural scoring
  methodologies). Feeds §6/§7. Not blocking the spine build.
- **Martín's GitHub username** → via WhatsApp; needed for collaborator add.
- **GitHub remote creation + collaborator add** → Lance's checkpoint (D3);
  agent stays local until then.
- **Final skill catalog** → resolved early in implementation using Martín's
  research + a Claude domain pass; tracked in `docs/02-product/skills-catalog.md`.

## 15. Provenance

- `docs/99-source/01-founder-call-storm.md` — vision/strategy context.
- `docs/99-source/02-team-build-notes.md` — authoritative build scope.
- `docs/99-source/03-full-transcript-2026-05-19.md` — full nuance/intent.
- `docs/07-decisions/decision-log.md` — locked decisions D1–D11.
- `docs/07-decisions/ADR-0001-approach-c.md` — the structural decision.
