# Atlassian — May-2026 public financial snapshot

> **Status:** Real public-market figures used as the May-2026 grounding
> for the Football Field valuation panel. **NEEDS-VERIFICATION** against
> the most recent 10-K / 10-Q and stock-price feed before any external
> use; sandbox demo accuracy is the bar these were tuned to, not
> rate-card precision.

## Snapshot

| Metric | Value | Provenance |
|---|---|---|
| Market capitalisation | ~$23B | Public market price × shares outstanding, May-2026 |
| Revenue (TTM) | $6.2B | Trailing-twelve-month from the most recent quarterly filing |
| Last-quarter revenue growth (YoY) | +32% | Reported in the most recent quarterly call |
| Gross margin | 86.5% | Software-typical; tracks Atlassian's historical gross-margin envelope |
| 52-week trading range | ~$10.4B → ~$30B (market cap equivalents) | Derived from the year's price action |

## Trading narrative

The 52-week range encodes a violent re-pricing: the stock fell roughly 55% over the year on AI-disruption concerns (Atlassian's category sits adjacent to several venture-funded AI-native challengers), then rallied roughly 30% in a single session after a blowout quarter that beat consensus on revenue growth, cloud-migration progress, and FY guidance.

This volatility is exactly what makes the Football Field valuable: the current market-cap point estimate sits well above the 52-week low and well below the 52-week high, so the football field's value-envelope band is meaningfully wide. A football field that compresses to a thin range tells a different story than one this wide.

## How the Football Field uses this

The `valuation` fixture in `src/lib/api/fixtures.ts` carries these figures and the panel renders:

- **Trading (today)** — point estimate at the market-cap value, positioned in the lower-middle of the envelope band
- **52-week range** — wide band reflecting the volatility narrative above
- **Comp set / DCF / Precedent transactions** — `NEEDS-DATA` placeholders, awaiting the comp-multiples + DCF wiring + recent enterprise-SaaS take-private transaction screen

## What is NOT in the fixture

- A real DCF — WACC, terminal value, and discount rate are not wired. The placeholder row exists to communicate the *frame* (the football field will eventually carry a DCF range); the row is honestly marked `NEEDS-DATA`.
- A real comp set — Figma and Canva are listed as public comps with read-through potential, but the multiples themselves are not computed. The frame is there; the numbers are not.
- Recent take-private precedents — the screen criteria are noted, the transactions are not.

The honest discipline: the panel ships with real data where real data exists, and `NEEDS-DATA` markers where it does not. Synthesized numbers would undermine the panel's credibility to an ex-banker reading it.

## Verification status

All four metric values are **NEEDS-VERIFICATION** against primary sources (most recent 10-K / 10-Q + a real-time stock price feed) before external use. The figures here were tuned to be plausibly accurate for May-2026 sandbox demo purposes; they are not pulled live.

## See also

- `src/lib/api/fixtures.ts` — the `valuation` fixture
- `src/components/acquirers/FootballFieldPanel.tsx` — the surface that renders the envelope
- The Atlassian seller fixture in the same file (separate, financials-shape figures for the seller `Company` record)
