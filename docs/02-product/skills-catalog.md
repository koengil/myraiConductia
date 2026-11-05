# Skills Catalog — Conductia

> **Provisional — final catalogue pending `06-research/` (Martín). Skill ids are a
> hard contract with `src/lib/api/fixtures.ts`.**

A skill is a named, draggable unit that performs a mocked data transformation,
visibly routes through the compliance layer, and renders a panel on the canvas. The
sandbox ships with exactly five skills: four on the free plan, one premium-locked.

This catalogue is the sandbox fixture behind the `ConductiaAPI` seam. The Skills destination (`/projects/[projectId]/skills`) now shows the governed library of the rail's step skills, with no paywall.

For how skills fit into the experience, see
[`experience-spine.md`](./experience-spine.md) (the step spine it once described was retired).
For the panels each skill renders, see [`matrices.md`](./matrices.md).
For the monetisation model skills enable, see
[`../01-business/monetization-and-skills-economy.md`](../01-business/monetization-and-skills-economy.md).

---

## Skill table

| id | Display name | One-line purpose | Panel rendered | Plan |
|---|---|---|---|---|
| `financial-performance` | Financial Performance | Analyse the seller's revenue, growth, EBITDA, and cash capacity over time. | `financialMatrix` | Free |
| `acquirer-fit` | Acquirer Fit | Score an acquirer's composite fit: financial capacity × cultural/strategic alignment. | `scoreBreakdown` | Free |
| `culture-signal` | Culture Signal | Visualise the 7-axis culture and strategic fit between seller and acquirer. | `cultureRadar` | Free |
| `deal-readiness` | Deal Readiness | Assess the acquirer's readiness to close: cash vs. equity capacity, headcount alignment, FINRA compliance posture. | `scoreBreakdown` | Free |
| `synergy-engine` | Synergy & Deal-Structuring Engine | Model deal structures and quantify synergies across product, revenue, and headcount. | `scoreBreakdown` | **Pro** |

---

## Panel types

- **`financialMatrix`** — Rendered by `FinancialMatrixPanel`. Displays valuation,
  revenue, growth, EBITDA, and cash figures as scored tiles. Source: the seller's
  `Financials` fixture data.
- **`cultureRadar`** — Rendered by `CultureRadarPanel`. A 7-axis SVG radar
  (animated draw on mount) using the acquirer's `CultureFactors`. Axes: vision,
  mission, founder, headcount, industry, product, culture.
- **`scoreBreakdown`** — Rendered by `ScoreBreakdownPanel`. Shows the composite
  score dial, the financial and culture sub-scores, and the breakdown bars. Source:
  `computeCompositeScore(acquirer.fitInputs)`.

---

## Notes

The skill mechanism is fixed and code-contractual: ids, `premium` flags, and `panel`
values above match the fixtures, with one rename: the `Skill` type in `src/lib/api/types.ts` now carries `dataShape` (`company`, `cultureFactors`, `compositeScore`) instead of `panel`, and `Canvas.tsx` maps each data shape to the panels listed above and the fixture
definitions in `src/lib/api/fixtures.ts`. Do not rename ids without updating both
the fixtures and any consuming component.

The catalogue itself is provisional: once Martín's M&A process research lands in
`docs/06-research/`, skill descriptions and display names may be refined. The ids
and premium/panel assignments are locked for the sandbox build.

Source: design spec § 7; plan Task 1.3 (fixtures contract and exact skill ids)
