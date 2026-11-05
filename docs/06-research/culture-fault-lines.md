# Cultural integration — the four fault lines

> **Status:** Research substrate for the Culture Matrix panel. The
> four-axis framework below is Bain & Company's structuring of the cultural
> dimensions that most predict integration outcome. Per-acquirer readings
> in `src/lib/api/fixtures.ts` apply this framework to the Atlassian deal
> universe.

## The framework

Bain & Company's culture-in-M&A research argues that integrations fail or succeed along four discrete dimensions, and that the *relative weight* between them varies by deal type. Structuring the read this way prevents the catch-all "culture clash" framing that buries the specific drivers.

### 1. Differences in purpose

How aligned are the two organizations on what they exist to do? This shows up in 10-K language, founder letters, and public talks — not in HR-survey numerics. The signal is whether the missions sit on the same axis (rare; close fit) or sit orthogonally (common; integration friction during priority decisions).

### 2. Differences in decision-making

Bain identifies this as the most disruptive fault line in practice. The dimensions: founder-led vs consensus-led, bottoms-up vs top-down, engineering-driven vs sales-driven, fast vs deliberative. When two organizations sit far apart here, decision velocity in the combined entity drops materially in the first 12–18 months — and the engineering organization in particular reads it as a regression signal that drives attrition.

### 3. Differences in engagement

The day-to-day rhythm: remote-first vs office-centric, async vs synchronous, high-autonomy vs structured. Engagement-norm mismatch doesn't usually kill a deal outright but shows up in retention within 12 months of close.

### 4. Founder compatibility

When the seller is founder-led (Atlassian is), the founder's post-deal posture is a deal-shaping variable on its own. Public conviction, prior deal behavior, governance posture, and willingness to share decision airtime with the acquirer's leadership all matter. Two strong founder personas in one org can crowd out product direction; aligned founders accelerate integration.

## Signal sources per fault line

| Fault line | Where the signal lives |
|---|---|
| Purpose | 10-K narrative sections, S-1 / proxy filings, founder letters, public-talk archives |
| Decision-making | Org charts, exec interview transcripts, Glassdoor decision-velocity themes, attrition data filtered by exit reason |
| Engagement | Remote-policy disclosures, ESG / employee engagement disclosures, employer-brand corpus (Blind, Indeed) |
| Founder compatibility | Direct public statements, prior M&A behavior (acquisitions made or accepted), governance posture (dual-class structures, board composition) |

The discipline: **surface drift, do not assert intent.** The framework reads observable signals and reports the verdict; it does not psychologize the founders or back-solve motivations.

## Verdict scale

Each fault line gets one of three verdicts in the panel:

- **Strong** — signals indicate low-friction integration along this axis. Common when missions, decision norms, or engagement rhythms substantially overlap.
- **Watch** — signals indicate visible drift, but not a deal-breaking divergence. Manageable with explicit integration governance.
- **Risk** — signals indicate divergence severe enough to predict measurable post-deal friction or attrition along this axis.

## How the Culture Matrix panel uses this

The panel renders four cards (one per fault line) per acquirer. The card shows the fault-line name, a verdict pill (Strong / Watch / Risk), a narrative description of why that verdict applies for this acquirer-target pair, and a signal-source footer.

`cultureReadingsByAcquirer` in `src/lib/api/fixtures.ts` carries an authored 4-line reading per acquirer for the Atlassian universe. Salesforce and Anthropic are fully authored; Microsoft, Adobe, and ServiceNow fall back to the Anthropic reading until per-acquirer authoring lands.

## Verification status

The four-fault-lines framework attribution to Bain is accurate to their public M&A culture work. Specific Bain publications include "Cultural integration" and "Why post-merger integrations fail" lines. **NEEDS-VERIFICATION** before any external use to pin the citation to a specific report and year.

## See also

- `src/lib/api/fixtures.ts` — `cultureReadingsByAcquirer` and `cultureMatrixFor()`
- `src/components/acquirers/CultureMatrixPanel.tsx` — the surface that renders the framework
- ADR-0005 — sandbox merge disposition; documents the research-substrate carry
