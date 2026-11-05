# 06 — Research substrate

The research underpinning the analytical panels. Populated in Phase D of the sandbox merge (2026-05-20) per ADR-0005's "implicit-in-B research substrate" carry.

| Document | Used by |
|---|---|
| [`synergy-base-rates.md`](./synergy-base-rates.md) | `SynergyStressTestPanel` — McKinsey cost / revenue base rates; Bain capture rate |
| [`culture-fault-lines.md`](./culture-fault-lines.md) | `CultureMatrixPanel` — the four Bain fault lines (purpose, decision-making, engagement, founder compatibility) |
| [`atlassian-may-2026-financials.md`](./atlassian-may-2026-financials.md) | `FootballFieldPanel` — the Atlassian valuation envelope grounding |

All three documents carry a **NEEDS-VERIFICATION** caveat against primary sources before any external use. They are accurate to the published positions of the cited consultancies and public-market figures, but the sandbox demo accuracy is the bar they were tuned to — not rate-card precision.

## Discipline

The research substrate exists because the panels are credible only if their numbers trace to something real. Two practices keep it honest:

1. **Cite or mark `NEEDS-DATA`.** Every figure in a panel fixture either traces to a published source (cited here) or is explicitly marked `NEEDS-DATA` in the rendered UI. Synthesized numbers without provenance are not shipped.
2. **Surface drift, do not assert intent.** Cultural and founder readings describe observable signals (10-K language, public statements, governance posture) rather than psychologizing the people involved.

## See also

- `docs/07-decisions/ADR-0005-sandbox-merge-disposition.md` — the meta-record that scheduled this research substrate to be written down
- `docs/archive/MERGE-REVIEW.md` §"What each repo learned separately" — the original surfacing of B's research that was not yet captured in A's docs
