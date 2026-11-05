# Integrated — design notes

The convergence prototype proposed after the 7 June 2026 Storm call. It is **not** a
fifth exploratory option. It is the single recommended direction: the A1 platform
shell carrying the three beats Storm validated in Martín's journey v2, rebuilt as
**live platform mechanics** rather than a linear walk-through.

## Why this shape

The call produced three hard decisions and one steer:

1. **One unified interface for everyone**, with *permissions* — not separate UIs —
   deciding who sees what.
2. **Entity → user hierarchy**: every user belongs to a company; people inherit the
   entity's permissions.
3. **Leaving the firm auto-revokes deal access** across every deal at once.
4. Steer: platform-oriented, strip back complexity, the AI-first variant is "too much
   for the moment."

A1 (navy+gold platform-of-destinations) is the container because it best serves "one
unified interface." Martín's journey v2 supplied the narrative Storm reacted to. This
prototype fuses them: A1's destinations, with Martín's three beats embedded where they
belong in a platform rather than as stepper pages.

## The three beats, as mechanics

| Beat (Martín v2) | Here it becomes |
|---|---|
| **7 — The other side** (perspective switch) | A **three-way persona toggle** pinned in the top bar — bank (Storm, MD) / client (Mike Cannon-Brookes, Atlassian) / buyer (Dana Cole, Anthropic). Flip and the whole shell recomputes: the rail **drops the destinations that actor can't reach**, the data room locks to the buyer's phase, and the deal view becomes that actor's real overview (their phase, documents, thread). The permission model is *shown* — by the trimmed menu and the phase-gated room — not narrated. The client gets an **"I disagree"** control on the ranked buyers — Storm's exact ask ("they can be like, 'I disagree, that's not a good buyer'"). |
| **4 — Entities first, then people** | The **Deal Team** destination leads with entity cards (your bank, Atlassian the client, a dashed buy-side that "joins later"). People sit inside entities; a bench can be added; "Lock the deal team" walls the deal off. |
| **11 — Someone leaves** | A **Process a departure** panel on Audit & Lifecycle. One click cascades access-revoked across three deals (Atlas, Nimbus, Helios), deals intact. |

## Permission model (computed, not faked)

Three actors, one interface (Storm: *"they should see the exact same system as
everybody else, but they only have their permissions"*):

```
ALLOWED = {
  storm: [mandate, acquirers, team, dataroom, skills, audit],  // bank / MD
  mike:  [mandate, acquirers, dataroom],                       // client / seller
  dana:  [mandate, dataroom],                                  // buyer
}
```

There is no separate "explainer" destination and no pitch copy in the actor views —
the live top-bar persona switch is the demonstration. Each actor lands on their real
deal overview; the sealing is proven by what their menu and data room actually show.

Sealed destinations are **removed from the menu entirely** — not shown disabled — so
each actor sees only what their permissions grant. `setActor()` recomputes the rail,
the deal switcher (hidden for the single-deal external actors), the data-room phase
(locked to phase 1 for the buyer), and falls back to the deal overview if the current
destination isn't in the new actor's menu. This mirrors the intent of
`src/lib/api/v1/access.ts` (deal-scoped membership + role) applied to the UI.

The floating AI command console was removed — compliance presence stays felt via the
top-bar instrument, the rail's live dot, the mandate event feed, and the audit trail.

## Brand & data fidelity

- **Navy + gold** via `../shared/brand-tokens.css` (ADR-0006). The whole thing is
  re-themeable by flipping those tokens — no palette is hard-coded here.
- **Canonical numbers** via `../shared/fixtures.js`: computed composite scores
  (Anthropic 87 / Salesforce 67 = round(financial × 0.55 + culture × 0.45)), and the
  founder is **Mike Cannon-Brookes** (Martín's v2 had named him "Mike Brennan" — fixed
  to repo canon here). The buyer-side contact stays **Dana Cole, Corp Dev, Anthropic**.
- Buyer perspective is tinted a warm bronze so the flip is *felt*, while staying inside
  the navy+gold family.

## Honest framing (Live vs Vision)

**Live now:** scoring + analytical panels, compliance cascade (mock verdicts),
entity-first team + lock, role/permission matrix, data-room classification + phase
gating, audit trail, and the departure cascade — all map to shipped `/api/v1` + schema.

**Vision / next:** automated NDAs and engagement letters, conflict checks, and
DB-level RLS enforcement of the gating shown here.

## How to view

```
open docs/prototypes/future-vision/integrated/index.html
```

Flip the persona toggle in the top bar (bank / client / buyer) to switch perspective.
Runs from `file://`; fonts and Tailwind load from CDN.
