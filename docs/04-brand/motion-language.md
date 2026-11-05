# Motion Language — Conductia

Motion is not decoration. In Conductia, the three named motions below are the
product's felt quality — they are how the MD perceives compliance, intelligence,
and scoring as real. The wow beats in the Sunday demo are motion beats. Get
these wrong and the demo is a screenshot. Get them right and the demo sells.

Source: design spec §11 (motion language), §5 (wow beats)

---

## 1. Compliance Pulse

**Purpose:** Communicates the compliance ribbon's live state. The ribbon is
idle-but-alive at all times, and visibly changes state when an action triggers
a check. This motion makes omnipresent compliance *felt* rather than read.

**States the motion covers:**

- `idle → scanning` — triggered by any skill run or message send.
- `scanning → clear` — compliance check passed; action proceeds.
- `scanning → blocked` — compliance check failed; action stopped.

**Specification:**

| Property | Value |
|---|---|
| Duration (idle pulse) | 2 000ms loop |
| Duration (scanning) | 800ms |
| Duration (clear / blocked resolve) | 300ms |
| Easing (idle) | `ease-in-out` (slow breathe) |
| Easing (scanning) | `linear` (mechanical urgency) |
| Easing (resolve) | `ease-out` (decisive snap) |

**Visual character:** The ribbon subtly brightens and pulses at `idle`. On
`scanning`, a sweep or cascade of check indicators runs left to right (FINRA →
MNPI → KYC on the compliance boot; single-pass on per-message checks). On
`clear`, the ribbon settles to green (`--positive`) with a sharp snap. On
`blocked`, it snaps to red (`--negative`) and holds — it does not fade out.

Source: design spec §11 (motion language), §5 step 2 + step 6

---

## 2. Skill-Transform Stream

**Purpose:** Makes data transformation visible and routes it through compliance.
When an MD drags a skill onto the canvas, they watch raw data become intelligence
— and see compliance intercept and approve it before it surfaces. This is the
"fuck, alright" moment. The motion is the product.

**Sequence:**

1. Skill card lifts from the shelf (scale up slightly, shadow appears).
2. On canvas drop: a stream of particles or lines flows from the skill card
   toward the panel render zone (~700ms). The visual metaphor is data in
   transit.
3. The stream curves upward and visibly passes through the compliance ribbon —
   the ribbon triggers a `scanning` pulse (see Compliance Pulse).
4. Compliance resolves to `clear`.
5. The panel renders with a fast fade-in.

**Specification:**

| Property | Value |
|---|---|
| Skill lift duration | 150ms |
| Skill lift easing | `ease-out` |
| Transform stream duration | 700ms |
| Transform stream easing | `ease-in-out` |
| Panel render duration | 250ms |
| Panel render easing | `ease-out` |
| Total sequence (lift → panel) | ~1 200ms |

**Implementation note:** The stream is the most expensive motion in the product.
It is also the most important. Build it within its phase; do not stub it. If
only one motion gets full implementation effort, this is it.

Source: design spec §11 (motion language), §5 step 4 (hero canvas wow beat)

---

## 3. Score Reveal

**Purpose:** Makes the composite score feel computed, not retrieved. The ScoreDial
and the culture/psych-fit radar animate in from zero, establishing that the
number was derived — not hardcoded. Credibility for an ex-banker is built in
this moment.

**Sequence:**

1. The panel is blank while the skill-transform stream is in progress.
2. On panel render: the radar arms extend from center outward simultaneously,
   reaching their target values.
3. Simultaneously, the ScoreDial sweeps clockwise from 0 to the computed value
   (e.g., 87 for Anthropic, 67 for Salesforce).
4. When the dial lands, it holds for 200ms, then the numerical label fades in.

**Specification:**

| Property | Value |
|---|---|
| Radar arm extension duration | 600ms |
| Radar easing | `cubic-bezier(0.34, 1.56, 0.64, 1)` (slight overshoot) |
| ScoreDial sweep duration | 700ms |
| ScoreDial easing | `ease-out` |
| Score label fade-in | 200ms after dial settles |
| Score label easing | `ease-in` |

**Visual character:** The radar arms move together, not sequentially. The dial
sweeps at a rate that feels deliberate — fast enough to be satisfying, slow
enough to read as computation. The overshoot on the radar suggests confidence,
not hesitation.

Source: design spec §11 (motion language), §5 step 3 + step 4 (landscape scores
and hero canvas score breakdown); `02-product/matrices.md` (composite score
definition)
