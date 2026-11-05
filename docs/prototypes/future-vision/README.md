# Future-Vision Prototypes

Standalone-HTML pitch prototypes that showcase where the Conductia platform could
go. Built per Lance's 31 May brief (standalone HTML, "as creative and futuristic as
possible, whilst keeping... the core audience and value props"), aligned with `/docs`,
using the `ui-ux-pro-max` design skill. These are throwaway pitch artifacts, decoupled
from the real Next.js app on purpose.

> Note: the brief asked for 2 prototypes; this set is 4 (a 2×2) so Storm can compare
> both the *paradigm* (platform vs journey) and the *aesthetic* (refined vs bold).
> The platform-vs-journey choice is intentionally left open for Storm to decide
> (ADR-0004 favours "platform of destinations"; the linear journey landed well too).

## The recommended convergence (post-call)

After the 7 June 2026 Storm call, these four exploratory directions converge into one:
[**Integrated**](integrated/index.html) — the A1 platform shell carrying the three beats
Storm validated in Martín's journey v2, rebuilt as live platform mechanics (persona
switch, entity-first team, departure cascade). It is navy+gold and wired to canonical
data. Start there; see [`integrated/design-notes.md`](integrated/design-notes.md) for
the rationale. The 2×2 below remains as the exploration it came from.

## The 2×2

| | **Platform of destinations** | **Linear deal journey** |
|---|---|---|
| **Refined** | [**A1 — Command Deck**](a1-command-deck/index.html): next-gen navy+gold AI-native terminal. Rail + full-screen content + floating compliance console. | [**B1 — Guided Journey**](b1-guided-journey/index.html): the deal lifecycle as a guided step spine, compliance the through-line. |
| **Bold** | [**A2 — Ambient Intelligence**](a2-ambient-intelligence/index.html): AI-copilot-forward, spatial glass canvas. Ask, compliance screens, decision cards materialize. | [**B2 — Cinematic Timeline**](b2-cinematic-timeline/index.html): the deal as a scroll-driven film, compliance heartbeat down a vertical timeline. |

## How to view

Open `index.html` (this folder) for a launcher, or open any prototype's
`index.html` directly. They run from `file://` (no build step) — fonts and Tailwind
load from CDN, so an internet connection is needed for full styling.

```
open docs/prototypes/future-vision/index.html        # launcher
open docs/prototypes/future-vision/a1-command-deck/index.html
```

## What each shows

Every prototype carries the **full capability union**: the analytical intelligence
already built **plus** the lifecycle/governance powers the new `/api/v1` layer unlocks
on the `engineering/migrate-permissions-schema` branch (not yet on `main`).

| Capability | A1 | A2 | B1 | B2 |
|---|:--:|:--:|:--:|:--:|
| Acquirer ranking + composite scores (Anthropic 87 / Salesforce 67) | ✓ | ✓ | ✓ | ✓ |
| 4 analytical panels (Valuation / Culture / Synergy / Founder) | ✓ | ✓ | ✓ | ✓ |
| Skills catalogue, free vs Pro | ✓ | ✓ | ✓ | ✓ |
| Compliance cascade KYC→FINRA→MNPI | ✓ | ✓ | ✓ | ✓ |
| Message screening (clear / hold / blocked + rewrite) | ✓ | ✓ | ✓ | ✓ |
| **Real identity in chrome** (`GET /me`) | ✓ | ✓ | ✓ | ✓ |
| **Deal creation** (`POST /deals`, minted code) | ✓ | — | ✓ | ✓ |
| **Multi-deal / mandate switcher** (`GET /deals`) | ✓ | ✓ | ✓ | — |
| **Role-based invites + permission matrix** (`POST /deals/{id}/members`, `roles`) | ✓ | ✓ | ✓ | ✓ |
| **Data room: classification + buyer phase-gating** (`documents`) | ✓ | ✓ | ✓ | ✓ |
| **Document-view audit trail** (`POST .../view`, `audit_log`) | ✓ | ✓ | ✓ | ✓ |

## Foundation (shared, build once)

- `shared/fixtures.js` — `window.IB`, the single source of truth for the Atlassian
  story. Numbers mirror `src/lib/api/fixtures.ts`; scores are the deterministic
  55% financial / 45% culture composites from `src/lib/scoring/composite.ts`.
- `shared/brand-tokens.css` — the non-negotiable brand layer (ADR-0006 navy+gold,
  Fraunces / Inter / Geist Mono). Each prototype's `design-system.md` (from
  `ui-ux-pro-max`) sits on top as the aesthetic treatment.
- `shared/copy.md` — approved copy, the three headline claims, and brand-voice rules.

## Honest framing

Each prototype tags features **Live now** vs **Vision / next** (per `copy.md`), so the
pitch survives Storm's scrutiny. Live: scoring, analytical panels, compliance screening
(mock verdicts), deal creation, role-based invites, data-room classification, audit
trail. Vision: real AI answers in the command bar, automated NDAs, engagement letters,
conflict checks, DB-level RLS enforcement of phase-gating.
