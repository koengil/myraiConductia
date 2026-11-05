> **Historical: the sandbox walkthrough (mid-2026).** The command bar it uses was retired on 2026-10-25, and the routes are the sandbox's. Kept for its narration; it is not today's demo.

# Demo Script — Conductia Sunday Walkthrough

This is the presenter's narration layer for the Sunday guided walkthrough with
Storm. It is **not** a re-definition of the experience spine — its stage
definitions came from the retired step spine of
[`../02-product/experience-spine.md`](../02-product/experience-spine.md).

This document is what the presenter **says and does** at each beat, in order.

The demo runs a single pre-loaded scenario: Atlassian, sell-side, exploring
acquirers. Persona: Mike Cannon-Brookes, pre-onboarded.

There are **six stages** and three designed wow beats:
1. Skill → transform → compliance → panel (hero canvas)
2. The premium-skill paywall
3. The non-compliant message getting blocked

Source: design spec §5, §4 (delivery mode D5); `02-product/experience-spine.md`

---

## Stage 1 — Cold Open

**Presenter action:** Open the browser. The product is already loaded.

**Narration:**

> "This is Mike Cannon-Brookes. Atlassian is already onboarded — company data
> is in, team is in, no setup. We start where other platforms end."

**What Storm sees:** Mike Cannon-Brookes logged in, Atlassian branding visible,
compliance ribbon present and quietly alive at the top. A single primary CTA.

**Transition:** Click the CTA to begin the session.

---

## Stage 2 — Intent

**Presenter action:** Type or confirm the pre-filled command bar entry. Submit.

**Command bar text (verbatim):**
> *"I'm exploring a sale of Atlassian."*

**Narration (as compliance boot runs):**

> "Before anything, compliance boots. FINRA check — clear. MNPI guard — clear.
> KYC verification — clear. Every session is monitored from intent. This
> happens automatically. Storm doesn't configure it; it's just on."

**What Storm sees:** The compliance ribbon transitions idle → scanning → clear.
Each check cascades visibly. The ribbon settles green.

**What this establishes:** Compliance is not announced as a feature. It simply
happens on the first interaction. This is the tone for everything that follows.

---

## Stage 3 — Acquirer Landscape

**Presenter action:** Gesture at the ranked acquirer list as it appears.

**Narration:**

> "Five acquirers. Ranked. Not a spreadsheet — a decision. Anthropic: 87.
> AI-native fit, strategic alignment, high-growth. Salesforce: 67 — solid SaaS
> incumbent, but not where AI is going. Each score is computed from the same
> formula — financials cross-referenced with culture fit. You're not looking
> at data. You're looking at a verdict."

**Narration (peer strip):**

> "And below — Figma, Canva. Who Atlassian sits next to by revenue and
> headcount. Context, without asking for it."

**What Storm sees:** Acquirer cards, each with an animated score dial. Peer strip
below.

**Transition:** Click on Anthropic to open the deep-dive.

---

## Stage 4 — Acquirer Deep-Dive (Hero Canvas)

This stage contains two of the three wow beats: the hero canvas interaction and
the premium-skill paywall.

### 4a — Hero Canvas (Wow Beat 1)

**Presenter action:** The canvas opens with the skills shelf visible. Pick up
a skill card (e.g., Financial Matrix) and drag it onto the canvas.

**Narration (as transform stream plays):**

> "Drag a skill. Watch it move."

*[pause — let the animation run]*

> "It's transforming the data, routing it through compliance — the ribbon
> checks — and surfacing the verdict. Not a dashboard. An analysis the MD
> composes, on demand."

**What Storm sees:** The transform stream animates across the canvas, curves up
through the compliance ribbon (ribbon pulses to scanning → clear), and the
Financial Matrix panel renders on the canvas.

**Presenter action:** Drag a second skill (e.g., Culture & Psych-Fit Radar).

**Narration:**

> "Add another. The radar — culture fit, vision alignment, founder psychology.
> Stack what matters. Ignore the rest."

**What Storm sees:** Second skill streams through, second panel renders alongside
the first. Scores appear.

### 4b — Paywall Beat (Wow Beat 2)

**Presenter action:** Point to the locked skill on the shelf (Synergy &
Deal-Structuring Engine, with a lock glyph). Pick it up and drag it onto
the canvas.

**Narration:**

> "One skill is Pro. Watch."

*[drag — lock modal appears]*

> "It stops. Elegantly. 'Upgrade to Pro.' No feature is hidden — it's right
> there, one skill away. That's the business model: access to intelligence
> is the value metric."

**What Storm sees:** An elegant lock modal appears on the canvas. The upgrade
CTA is present. No panel is added. The modal communicates premium without
feeling like a wall.

**Transition:** Close the deep-dive and open the team drawer.

---

## Stage 5 — Compliance Theatre (Wow Beat 3)

**Presenter action:** Open the team drawer. Show the three profiles: MD (Mike
Cannon-Brookes), CFO, M&A Advisor. Open a message to the M&A Advisor.

**First message — clean:**

**Presenter action:** Type (or select pre-filled): *"Financials attached for
your review."* Send.

**Narration:**

> "Clean message. Compliance checks it — green — it sends. Appears in the
> thread."

**What Storm sees:** Real-time check runs, green tick, message delivers.

**Second message — blocked:**

**Presenter action:** Type (or select pre-filled): *"Here are the financials,
and honestly, fuck you."* Attempt to send.

**Narration:**

> "Now watch."

*[compliance check runs, red cross appears]*

> "Blocked. Not flagged after the fact. Stopped at the gate. The message is
> never sent. It is never in the thread. FINRA Rule 2210 — that's the reason
> logged. This is what compliance-first means in practice."

**What Storm sees:** The compliance ribbon snaps to blocked (red). The message
is not delivered. A blocked reason is surfaced. The team thread is clean.

---

## Stage 6 — Pitch-Prep CTA

**Presenter action:** Navigate to the final screen. Point at the CTA.

**Narration:**

> "The platform now knows everything about Atlassian and Anthropic — financials,
> culture fit, psych profile, composite score. Next session, it generates the
> pitch. Today we stop here. On purpose."

**What Storm sees:** A prominent "Begin Pitch Preparation" button, captioned
"Next session." Clicking it shows a brief "Coming next week" toast. Nothing
more loads.

**Closing line:**

> "This is the skeleton. What you just saw — the compliance, the canvas, the
> paywall — that is how the product feels. The backend is next."

---

## Presenter notes

- **Pacing:** let the animations breathe. The three wow beats earn their pauses.
  Do not narrate over the skill-transform stream; let Storm watch it.
- **If Storm clicks off-script:** graceful stubs are in place. If a click hits
  one, acknowledge and redirect: "That's wired for next week."
- **Numbers:** Anthropic 87, Salesforce 67 are computed, not invented. If Storm
  asks, the formula is in [`../02-product/matrices.md`](../02-product/matrices.md).
- **Compliance thread:** every stage has compliance in it. Do not let it go
  unmentioned — the ribbon is always visible; reference it, even briefly, at
  each stage.

Source: design spec §5, §2, §4 (D5); `02-product/experience-spine.md`
