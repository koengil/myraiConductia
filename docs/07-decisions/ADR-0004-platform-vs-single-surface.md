# ADR-0004 — Platform of destinations, not single operable surface

- **Status:** Accepted (originally accepted as D17 on 2026-05-19; formalized as ADR on 2026-05-20)
- **Date:** 2026-05-20
- **Deciders:** Lance Marks (original decision via D17); Martin Casado (formalization as ADR)
- **Source:** `docs/archive/MERGE-REVIEW.md` §Two product bets; `intelibank-sandbox/app/page.tsx`; F-plan §10 of the design spec; D17.

## Context

The four-agent review found that `intellibank` and `intelibank-sandbox` execute the same product thesis through two genuinely different architectures:

- **`intellibank` (A)** — a *platform of destinations*. Four navigable routes (`/`, `/acquirers`, `/team`, `/skills`), a persistent global `CommandBar`, a single `ComplianceRibbon` mounted once in the chrome, the typed `ConductiaAPI` seam, deterministic scoring, motion contracts, a written brand and decision log. The thesis: this is a *place the MD comes back to* — durable, navigable, post-onboarding.

- **`intelibank-sandbox` (B)** — a *single operable surface*. One `DealRoom` page where the MD composes a *harness* of skills via drag between Marketplace and Active Harness zones, and each active skill toggles a panel into a two-column workspace. Compliance Gateway is literally the right rail; without it in the harness, there is no deal room. The thesis: this *is* the workstation, every analysis is on one screen, the right rail is alive with traffic.

B's commit history records the bet explicitly: `M1 v2: single operable surface — no tabs, no scenes, no navigation`. It is not a mistake; it is a deliberate counter-design.

D17 already accepted the platform thesis for `intellibank` (Phase F retired the spine, promoted four destinations to root). This ADR records the *rejected* counter-thesis so the decision is traceable, the reasoning is preserved, and a future maintainer who finds B's commit history does not need to reconstruct it.

## Decision

`intellibank` ships as a platform of destinations (D17, confirmed). The single-operable-surface thesis is **acknowledged, documented, and rejected** for the intended persona (the managing director using the product across weeks and deals).

The rejection is principled, not casual. B's single-surface design has real strengths — first-impact density, immediate "you are inside a live deal" framing, no navigation friction — that the platform model loses. Where those strengths are recoverable inside the platform, they are recovered (the persistent `CommandBar`, the always-mounted `ComplianceRibbon`, the deep-dive deep-link, the mandate banner pattern from ADR-0005).

## Alternatives considered

- **Adopt B's single operable surface as the product.** First-impact wins; the MD lands inside a live deal on every visit. Rejected: bad fit for *return* visits. A platform the MD comes back to weekly needs durable mental landmarks (destinations) and navigation that scales to many mandates simultaneously. A single workspace can hold one deal; it cannot hold a portfolio. The MD persona handles many deals.
- **Hybrid: a `/deal-room` destination that runs B's single-surface composition inside the platform.** Worth flagging as a possible Phase F or later expansion. Not rejected, but out of scope for this merge. The four-destination IA absorbs B's content without the harness composer; if a future deal-room view earns its keep, it can be added as a fifth destination.
- **Keep the spine + add destinations.** Rejected by D17 already (the spine is retired). This ADR does not relitigate D17.

## Consequences

- A's four-destination IA is the canonical product surface. B's content (analytical panels, compliance engine, weighted scoring) is *ported into* A's destinations, not the other way around.
- B's `DealRoom`, `AppBar`, and single-page composition (`app/page.tsx`) are **not** ported. The chrome and IA stay A's.
- B's right-rail layout *pattern* may be ported into A's deep-dive (`/acquirers/[id]`) as a content arrangement, not as the dominant surface (per Phase G in the merge ledger).
- The "harness mental model" (Marketplace ↔ Active Harness drag composer) is captured as a *memo* in `docs/02-product/skills-catalog.md` — preserved as a design idea even though A's existing catalogue + canvas drop pattern is shipped instead. Worth revisiting if the MD persona's skill-composition behavior diverges from what A predicts.
- `docs/07-decisions/decision-log.md` carries D24 as the explicit record of the rejected branch, with this ADR as the source.

## Why this ADR exists even though D17 already locked the decision

Because the alternative is not theoretical. It is a working application in a sibling repo with its own commit history and design rationale. A maintainer who finds `intelibank-sandbox` six months from now will reasonably ask "why did we not do this?" — and deserves a real answer, not silence. This ADR is that answer.
