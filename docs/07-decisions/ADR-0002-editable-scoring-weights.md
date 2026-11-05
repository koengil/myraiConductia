# ADR-0002 — Composite scoring: editable weights, not fixed

- **Status:** Accepted (implemented in Phase C of the sandbox merge ledger, 2026-05-20)
- **Date:** 2026-05-20
- **Deciders:** Martin Casado (proposal + implementation; Lance acknowledgement pending)
- **Source:** `docs/archive/MERGE-REVIEW.md` §Merge plan Priority 1.2; `intelibank-sandbox/lib/scoring/score.ts`; `intelibank-sandbox/components/scenes/AcquirersClient.tsx`; extends D9 (does not reverse it — pure-function determinism preserved).
- **Phase C scope note:** The implementation lands as **bucket-level sliders** (financial vs culture, two sliders auto-balanced to 100%). Per-factor sliders (over the 11 sub-factors) are out of scope for Phase C because A's data shape uses nested objects with bucket-specific field names, not the flat name+value array B uses. Per-factor sliders would require renaming A's factor identifiers to a shared label vocabulary — a separate, larger change deferred to a future polish phase. For the Atlassian fixture set the bucket sliders re-shuffle ranks 2–5 (Adobe ↔ Microsoft swap is the documented beat) but do not flip Anthropic from rank 1; that property of the fixture is honest and acceptable.

## Context

`intellibank` currently computes the composite score with hardcoded weights (financial fit 0.55, culture fit 0.45) in `src/lib/scoring/composite.ts`. The function is pure and deterministic — credible to an ex-banker, demo-stable, and the basis of the locked `Anthropic 87 / Salesforce 67` fixtures asserted across the test suite.

`intelibank-sandbox` ships the same composite as a *generalized* weighted-mean primitive in `lib/scoring/score.ts` (normalized arbitrary weights, gracefully handles all-zero), and exposes the weights to the user via sliders in `components/scenes/AcquirersClient.tsx`. The MD can move a weight and see the ranking re-tally live, including a "Lead candidate" crown that re-anchors to whichever acquirer is now on top.

The merge review concluded this is the single most "MD-grade" interaction in either repo: it transforms the dashboard from a *snapshot* into an *operator surface*. The determinism claim that A's copy makes ("each score is computed from the same formula") becomes visible — the MD can prove it by moving the levers.

## Decision

Adopt B's weighted-mean primitive as the new composite implementation in `src/lib/scoring/composite.ts`. Expose the weights as user-editable sliders in `/acquirers/[id]` (acquirer deep-dive). The *default* weights remain financial 0.55 / culture 0.45, and the default-weight composite scores remain `Anthropic 87` and `Salesforce 67` byte-for-byte — preserving every existing fixture and test that references those numbers.

The slider mechanic is the operator move; the locked fixtures are the reference. Both coexist.

## Alternatives considered

- **Fixed weights (status quo).** Lowest churn; preserves every test verbatim with no widening. Rejected: leaves the determinism claim unprovable to the user; loses the single most "MD-grade" interaction available; the merge review classified this as a ship-blocker.
- **Editable weights with no defaults / no locked fixtures.** Maximum flexibility. Rejected: destroys the assertion surface that holds the demo together (golden-path encodes 87/67); turns deterministic scoring into a moving target; undermines D9.
- **Editable weights on a dev-only surface (`/dev-primitives`).** Lowest user-facing risk. Rejected: hides the feature from the persona it exists to serve; defeats the purpose. The mechanic is the demo, not a setting page.

## Consequences

- `src/lib/scoring/composite.ts` is refactored on top of a generalized `composite(factors, weights)` primitive. Pure function discipline is preserved; the function is still deterministic given identical inputs.
- A slider component is added to `/acquirers/[id]`. It writes weights to local component state (or session store if the choice persists across destinations) and re-runs `composite()` on each change. No backend, no debounce surprises.
- `tests/composite.test.ts` and `tests/score-dial.test.tsx` are widened to assert both *default-weight* invariants (the 87/67 fixtures) AND *variant-weight* re-rank behavior. The default-weight case is the new floor; the variant case is the new ceiling.
- The locked language in `CLAUDE.md` ("the 87 / 67 are computed by a pure function") gains a clause: "*under default weights*". The function purity statement stays.
- `docs/02-product/matrices.md §4` is updated to describe the default weights as the *anchor* and the slider mechanic as the *operator move*.
- D9 in the decision log is annotated with a `see also: D22 / ADR-0002` cross-reference; D9 is not reversed (determinism stays), it is *extended*.

## Open questions

1. Should the weights persist across the destination tree (session store) or reset on each `/acquirers/[id]` mount? Default proposal: reset on mount; the MD's exploration is per-acquirer, not global. Pending Phase C implementation choice.
2. Does B's "Lead candidate" crown ribbon survive the port, or does A's existing visual hierarchy already convey the same? Default proposal: port the crown; it is doing real work — it teaches the MD that the ranking is live.
