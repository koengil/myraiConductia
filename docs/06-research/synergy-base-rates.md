# Synergy realization — base rates for M&A integration

> **Status:** Research substrate for the Synergy Stress-Test panel. Figures
> are widely-cited public research, used here as base-rate benchmarks
> against which a real acquirer's pro-forma synergy claim is compared
> when one becomes available (currently `// NEEDS-DATA` in the fixture).
> Specific figures need verification with primary sources before use in any
> client-facing artifact outside the sandbox.

## Cost synergies

**Industry average: ~80% of announced cost synergies realized within 2–3 years.**

- **Source:** McKinsey & Company, "M&A integration: A look at the elephant in the room" and the related "Where mergers go wrong" line of research. McKinsey's integration practice has published this figure across multiple deal-research pieces over the last decade.
- **Why it holds:** cost synergies are largely under the acquirer's control — headcount reductions, contract consolidation, real-estate footprint, vendor renegotiation. They depend less on customer behavior, which is the volatile variable.

## Revenue synergies

**Industry average: ~50% of announced revenue synergies realized.**

- **Source:** McKinsey & Company, same body of work. Revenue synergies systematically miss more than cost synergies because they depend on customers behaving as the deal model assumes (cross-sell uptake, retention, upsell from the combined offer).
- **Why it underperforms:** customer attrition during integration, sales-force distraction during re-org, and product roadmap re-alignment all eat into the assumed cross-sell tailwind.

## Total announced → captured

**Industry average: 30–50% of total announced synergies are actually captured within 2 years of close.**

- **Source:** Bain & Company integration research, published periodically as part of their "M&A practitioners' guide". The figure is the blended capture rate across cost + revenue, accounting for one-time integration costs that eat into the synergy line in the first two years.
- **Why the spread is wide:** deal type matters. Tuck-ins of small targets routinely hit the top of this range; transformational platform deals routinely sit at the bottom or below.

## How the Synergy Stress-Test panel uses these

The panel renders three rows — one per category above — each showing:

- The base-rate figure (these doc citations)
- A `Mgmt claim` cell that stays `// NEEDS-DATA` until an acquirer files an 8-K or other public synergy projection for the target deal
- A `verdict` chip that classifies how the management case compares to the base rate (currently `framework`; flips to `ok` / `stress` once a real claim is filed)

The point of the panel is to give the MD a frame: when a buyer says "we expect $X in synergies", how does $X compare to what comparable deals have actually delivered?

## Verification status

All three figures are **NEEDS-VERIFICATION** before any external use. They are accurate to the consultancies' general published positions but the specific bounds and time horizons vary slightly across reports. For client-facing artifacts, pull the most recent primary publication and cite it directly.

## See also

- `src/lib/api/fixtures.ts` — the `synergyStressTest` fixture references these
- `src/components/acquirers/SynergyStressTestPanel.tsx` — the surface that renders them
- ADR-0005 — sandbox merge disposition; documents the research-substrate carry
