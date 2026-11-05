# The Three Matrices — Conductia

Conductia's scoring model consists of three layers. Together they produce the
composite scores the MD sees on every acquirer card. The definitions here and the
implementation in `src/lib/scoring/composite.ts` must stay in sync — this document
is the authoritative specification; the code is the authoritative execution. Any
change to weights, factors, or formula requires updating both.

For how these matrices surface in the product, see
[`experience-spine.md`](./experience-spine.md) (the step spine it once described was retired).
For the panels that visualise them, see [`skills-catalog.md`](./skills-catalog.md).

---

## 1. Compliance layer

The compliance layer is not a matrix — it is a gate. It precedes all scoring and
governs all communications. Five UI states (`ComplianceStatus` in `src/lib/api/types.ts`; `hold` added by ADR-0003):

| State | Meaning |
|---|---|
| `idle` | Session active; no action in progress. Ribbon present, calm. |
| `scanning` | An action (skill run or message send) is being checked. Ribbon animates. |
| `clear` | The action passed all compliance checks. Ribbon pulses green. |
| `hold` | The action needs review: the rule screen flagged it (MNPI and other non-promissory hits in `src/lib/compliance/screen.ts`). Distinct from both `clear` and `blocked`. |
| `blocked` | The action violated a compliance rule (promissory language in the rule screen). Ribbon pulses red. On mail, since #192 neither `hold` nor `blocked` stops a send: the sender chooses the rewrite, an edit or send as-is, all audited. |

The compliance layer gates everything: a skill run transitions the ribbon from `idle`
to `scanning` to `clear` before the panel renders. A message transitions from `idle`
to `scanning`, then either `clear` (delivers) or `blocked` (does not send, flagged).
Compliance is never skipped.

The demo implements FINRA Rule 2210 (communications standards) as the primary rule
set. Rule ids are prefixed `FINRA-`. Additional rule sets are deferred to post-sandbox.

Source: design spec § 6; plan Task 1.5 (compliance rules implementation contract)

---

## 2. Financial matrix

Four factors, each scored 0–100, that assess an acquirer's financial capacity and
compatibility for the deal.

| Factor | id | What it measures |
|---|---|---|
| Valuation coverage | `valuationCoverage` | Can the acquirer's valuation justify the deal price? |
| Cash capacity | `cashCapacity` | Does the acquirer have sufficient cash for a cash transaction? |
| Revenue growth | `growth` | Is the acquirer on a growth trajectory consistent with a strategic deal? |
| EBITDA margin | `margin` | Is the acquirer profitable enough to absorb the acquisition? |

**Financial sub-score:**

```
financialSub = round(mean(valuationCoverage, cashCapacity, growth, margin))
             = round((valuationCoverage + cashCapacity + growth + margin) / 4)
```

Source: design spec § 6; plan Task 1.4 (composite scoring implementation)

---

## 3. Culture / psych-fit matrix

Seven factors, each scored 0–100, that assess the strategic and cultural alignment
between seller and acquirer. This is the "AI sees nuance bankers miss" layer.

| Factor | id | What it measures |
|---|---|---|
| Vision alignment | `vision` | Do the companies share a long-term directional thesis? |
| Mission alignment | `mission` | Are the organisations' stated purposes compatible? |
| Founder fit | `founder` | Is there interpersonal and values alignment at the founding/leadership level? |
| Headcount fit | `headcount` | Is the acquirer's scale compatible with a smooth integration? |
| Industry alignment | `industry` | Does the acquirer operate in, or adjacently to, the seller's market? |
| Product fit | `product` | Do the product lines complement rather than cannibalise? |
| Culture fit | `culture` | Are organisational culture and operating norms compatible? |

**Culture sub-score:**

```
cultureSub = round(mean(vision, mission, founder, headcount, industry, product, culture))
           = round((vision + mission + founder + headcount + industry + product + culture) / 7)
```

Source: `99-source/03-full-transcript-2026-05-19.md` (Lance, "vision fit, mission fit,
founder fit, headcount fit, industry fit, product fit, culture fit");
design spec § 6; plan Task 1.4

---

## 4. Composite score formula

The composite score is a weighted combination of the two sub-scores, gated by
compliance. Financial fit is weighted at 55%; culture fit at 45% — reflecting the
primacy of deal economics while acknowledging that cultural misalignment kills
integrations.

```
total = round(0.55 × financialSub + 0.45 × cultureSub)
```

These are the **default** weights. ADR-0002 made the weights user-editable (sliders on the deep-dive): `computeWeightedScore(fit, weights)` scores any weights, and `computeCompositeScore` applies `DEFAULT_WEIGHTS`, so the 87 / 67 figures below hold at the defaults.

**Compliance gate:** if the compliance layer has not cleared (`compliancePassed:
false`), the score is not presented to the user.

**Worked examples (Anthropic and Salesforce):**

| | `financialSub` | `cultureSub` | `total` |
|---|---|---|---|
| Anthropic | 84 | 91 | **87** |
| Salesforce | 71 | 62 | **67** |

_Verification: Anthropic → `round(0.55 × 84 + 0.45 × 91)` = `round(46.2 + 40.95)` =
`round(87.15)` = 87. Salesforce → `round(0.55 × 71 + 0.45 × 62)` = `round(39.05 +
27.9)` = `round(66.95)` = 67._

These totals are computed by the pure function `computeCompositeScore(fitInputs)` in
`src/lib/scoring/composite.ts`. They are never hardcoded in the view layer. The
fixture inputs that produce the Anthropic sub-scores of 84/91 are defined in
`src/lib/api/fixtures.ts` (Task 1.3).

Source: design spec § 6; plan Task 1.4 (exact formula and implementation);
`99-source/02-team-build-notes.md` § Platform Architecture & Features (Anthropic 87 /
Salesforce 67)
