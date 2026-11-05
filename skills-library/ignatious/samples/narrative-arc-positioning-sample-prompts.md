# narrative-arc-positioning — Sample Prompts & Expected Outputs

Prepared for external review of the Ignatious AI build. This document is a
worked eval set for the **`narrative-arc-positioning`** skill.

---

## What this skill does

`narrative-arc-positioning` is a **generation** skill (not a review skill — that
is its sibling, `ignatious-partner-review`). Given a positioning brief — a
company, its sector/stage, and an ask — it returns narrative guidance built from
twelve recent best-in-class IPO roadshow decks (Figma, Chime, CoreWeave, Rubrik,
ServiceTitan, Klaviyo, Navan, Netskope, SailPoint, OneStream, Hinge Health,
Omada).

Its scope is deliberately narrow: **narrative and positioning only.** Financials,
unit economics, valuation comps, and visual design are explicitly out of scope.

A correct response reliably does six things:

1. **Points at 1–2 reference decks** that match the situation (per the skill's
   deck-selection heuristic table).
2. **Uses the canonical 8-stage arc** as scaffolding — Cover → Mission → Why Now
   → Solution → Proof → Moat → Model/Levers → Close.
3. **Selects 3–5 positioning moves** from the repertoire — *not* all of them —
   and names them.
4. **Designs the opening hook and closing move first**, since they do the most
   load-bearing work.
5. **Writes every slide title as an action title with positive charge** (a claim,
   6–14 words, carrying a number/verb/inevitability — never a topic label).
6. **Runs a per-section sequencing pass** so a section's titles, read alone,
   escalate and land — and **flags the failure modes** it sees.

The four examples below are the standard to grade real output against. Each pairs
a **brief-only prompt** (company, sector, ask — no attached deck) with the **full
expected output.**

---

## Example 1 — Full deck arc (whole-narrative task)

### Prompt

> **Company:** Aperture — a unified vector-data platform that lets enterprises
> run retrieval and AI workloads on their own data without stitching together a
> dozen point tools.
> **Sector / stage:** AI data infrastructure; ~$140M ARR, growing 90% YoY;
> preparing an IPO roadshow narrative.
> **Ask:** Craft the full narrative arc and deck flow. We keep getting framed as
> "just another vector database" and it's capping how investors size us.

### Expected output

**Reference decks to pull:** **CoreWeave** (primary — pure category creation in
AI infrastructure, specialist-vs-generalist framing) and **Rubrik** (secondary —
escaping a commoditized category, urgency via an AI catalyst). The "just another
vector database" problem is a *category* problem, so the load-bearing decision is
category creation, exactly CoreWeave's move.

**Positioning moves selected (5 of the repertoire — used deliberately, not all):**

- **Category creation** — stop competing inside "vector database." Name and claim
  a new category (the AI data layer / "AI-native data platform").
- **Platform consolidation** — the unified-replacement-for-N-tools move; carry the
  count of point tools you retire.
- **Data / network moat** — frame accumulated, governed enterprise data as
  compounding in a way new entrants can't catch.
- **AI-native (with proof)** — named systems and outcomes, not a vague
  "AI-powered" claim.
- **Layered TAM** — expand via credible adjacencies (retrieval → agents →
  governance), not a bigger single market number.

**Opening hook (designed first — first 3 slides must let an investor repeat the
one-liner, the category claim, and one scale metric):**

- Cover tagline: **"The data layer every AI application runs on."**
- Mission one-liner: **"We turn an enterprise's own data into its biggest AI
  advantage."**
- "At a glance" scale proof: **"$140M ARR, 90% growth, 400 enterprises — the AI
  data layer at scale."**

**Closing move (designed first, alongside the hook):** *Vision bookend* + *growth-
lever enumeration.* Reopen on the cover claim, then enumerate the post-IPO levers
(the levers *are* the ask). Close title: **"Every enterprise AI workload
converges on one data layer — ours."**

**The 8-stage arc, with action titles:**

| Stage | Action title |
|---|---|
| 1 — Cover | "The data layer every AI application runs on" |
| 2 — Mission | "We turn an enterprise's own data into its biggest AI advantage" |
| 3 — Why now | "AI adoption stalls without a governed data layer — and every enterprise hit that wall in the last 18 months" |
| 4 — Solution | "One platform retires the eight-tool retrieval stack" |
| 5 — Proof | "400 enterprises, including 6 of the top 10 banks, run production AI on Aperture" |
| 6 — Moat | "Every governed dataset we ingest compounds into a moat new entrants can't catch" |
| 7 — Model / levers | "132% net retention proves we grow inside every account we land" |
| 8 — Close | "Every enterprise AI workload converges on one data layer — ours" |

**Sequencing pass — the "Why now" sub-section (stack-and-land shape):**

1. "Enterprises moved AI from pilots to production in the last 18 months."
2. "But ungoverned data is where 80% of those projects stall."
3. "The winners are standardizing on a data layer now — and that window is
   closing."

Read alone, the three titles escalate (shift → obstacle → urgency) and the third
one lands. They are not shuffleable — that's the test the skill applies.

**Failure modes flagged:**

- **Category trap.** Any slide titled "Vector Database Comparison" concedes the
  commodity frame — cut it or reframe to the new category.
- **Generic "AI-powered."** Stage 4/6 must name systems and cite outcomes, or the
  AI claim reads as table stakes.
- **TAM inflation.** Use the layered TAM (retrieval → agents → governance); don't
  claim the entire "$X-trillion data market."

---

## Example 2 — Opening only (single-section task)

### Prompt

> **Company:** Kestrel — field-operations software for commercial construction
> firms (scheduling, compliance, subcontractor payments). Built by two people who
> ran a mechanical contracting business for 15 years.
> **Sector / stage:** Vertical SaaS; growth-stage, pre-IPO.
> **Ask:** Write our opening — the cover tagline and the first three slides. The
> current opener is a company-overview slide and it's flat.

### Expected output

**Reference deck to pull:** **ServiceTitan** — vertical SaaS, authenticity-as-moat,
"Born in the Trades." Kestrel's founder DNA is a structural asset (the product
*requires* industry fluency), so authenticity should be load-bearing in the very
first slides.

**Opening hook pattern selected:** *Mission statement* + *named problem with a
number*, with **founder/origin DNA** threaded through the tagline. The test the
skill enforces: after three slides, an investor can repeat the one-liner, the
category claim, and one scale metric.

**Cover tagline (3 options, all verb-led, all carrying the origin claim):**

- **"The operating system for commercial construction."** (category claim —
  "operating system for X" move)
- **"Built by contractors, for contractors."** (authenticity move — the
  ServiceTitan echo)
- **"We run the job site so contractors can run the job."** (outcome claim)

Recommended: pair the category claim on the cover with the authenticity claim on
slide 2 — you get ubiquity *and* credibility.

**Slide 1 (cover):** "The operating system for commercial construction"

**Slide 2 (mission / origin):** **"Fifteen years on the tools taught us what
construction software always got wrong."** — founder photo, origin story. This is
the authenticity move; it earns the right to the category claim.

**Slide 3 (named problem with a number):** **"Commercial contractors lose 30% of
project hours to paperwork and rework."** Lead with the number and the verb — a
quantified problem converts skepticism into curiosity.

**Repeat-back check (the skill's pass/fail test for an opener):** After these
three slides an investor can say back: *"Operating system for construction (one-
liner + category), built by people who ran a contracting business (moat), solving
a 30%-of-hours problem (scale of pain)."* The hook passes.

**Failure modes flagged:**

- The current "company overview" title is a topic label — the #1 failure mode.
  Every one of the first three slides must carry a claim.
- Don't state the origin story without the structural payoff — tie it explicitly
  to *why the product is better* (fluency competitors can't fake), or it's just a
  nice anecdote.

---

## Example 3 — Category reframe (positioning task)

### Prompt

> **Company:** Sentira — cloud security. Today investors and analysts slot us as
> an "email security" vendor, which anchors us to a small, crowded, low-multiple
> category. Our platform actually covers identity, data, and collaboration
> surfaces too.
> **Sector / stage:** Cybersecurity; late growth-stage.
> **Ask:** Reframe our category. We're stuck being seen as a point tool.

### Expected output

**Reference decks to pull:** **Rubrik** (primary — the canonical category
reframe, "backup → cyber resilience") and **Netskope** (secondary — convergence
and platform consolidation in security).

**Positioning moves selected (4):**

- **Category redefinition** — take the existing "email security" frame and reframe
  what the company *is.* (Rubrik's exact play.)
- **Platform consolidation** — the convergence move: name the point categories you
  subsume (email + identity + data + collaboration), and carry the count.
- **Legacy end-of-life framing** — the point-tool-per-surface model is what's
  ending; you ride that wave in "Why now."
- **Implicit incumbent contrast** — since you're reframing upward, contrast the
  fragmented point-tool world against your unified surface; don't name and
  legitimize small rivals.

**The reframe (before → after):**

- From: **"Email security"** (one surface, crowded, commodity multiple)
- To: **"The human-layer security platform"** — every surface an employee touches
  (email, identity, data, collaboration) defended as one control plane.

**Load-bearing one-liner (what the investor repeats back):** **"Attackers don't
target inboxes — they target people. We defend the human layer everywhere it's
exposed."**

**Where the reframe shows up in the arc:**

- **Why now:** "Point tools guard one surface each — but a single compromised
  employee crosses all of them in minutes."
- **Solution:** "One platform replaces four single-surface point tools." (name the
  count — consolidation strength scales with it)
- **Moat:** "Signals from every human surface compound into detection no single-
  surface tool can match." (the data-moat consequence of the reframe)

**Sequencing pass — the reframe sub-section (frame → prove → moat shape):**

1. "Attackers target people, not inboxes." *(frame)*
2. "So we defend every surface a person touches — as one platform." *(prove)*
3. "And every surface we watch makes the next detection sharper." *(moat)*

**Failure modes flagged:**

- **Conceding the old category.** A single slide comparing "email security
  vendors" re-anchors you to the small category — the whole point is to leave it.
- **Feature list instead of positioning.** Don't list the 12 things the platform
  does; collapse them into the consolidation move (four surfaces, one plane).
- **TAM inflation.** Size the human-layer category through defensible adjacencies
  (email → identity → data → collaboration), not a blanket "$Xbn cybersecurity
  market."

---

## Example 4 — Closing move + title rewrites (targeted task)

### Prompt

> **Company:** Payline — payments infrastructure. We're going public a second
> time, four years after being taken private by a PE firm. Under PE we rebuilt the
> platform and moved upmarket, but the market still remembers the old, slower
> Payline.
> **Sector / stage:** Fintech infrastructure; re-IPO.
> **Ask:** Design our closing slides, and fix these five flat titles from the
> current draft:
> (1) "Company Overview" (2) "Our Products" (3) "Financial Highlights"
> (4) "Why Now" (5) "Conclusion"

### Expected output

**Reference deck to pull:** **SailPoint** — the re-IPO / post-take-private
template: the "(Re)introducing" permission-granting reintroduction with a
same/different matrix, closing on Rule-of-40 durability.

**Opening frame this close must bookend (noted because closes and openers are
designed together):** a *permission-granting reintroduction* — a two-column
"what's the same / what's different" matrix. It handles the "we remember the old
Payline" objection without defensiveness. Cover title: **"(Re)introducing
Payline: same rails, rebuilt engine."**

**Closing move selected:** *Vision bookend* + *key-takeaways enumeration.* The
bookend reopens the reintroduction claim (transformation complete); the numbered
takeaways give a complex re-IPO story a high floor. Each takeaway is itself an
action title.

**Closing slides:**

- **Bookend slide:** "The rails you trusted, rebuilt for the next decade of
  payments."
- **Takeaways (numbered, each a claim — not the word "Takeaways"):**
  1. "We rebuilt the platform under PE — and came back faster, not just bigger."
  2. "We moved upmarket: enterprise is now the majority of new volume."
  3. "We compound at Rule of 40 with expanding margins."
  4. "Every new merchant deepens the network our competitors can't rebuild."
  5. "The re-IPO capital funds the three levers that extend this runway."

**Flat → charged title rewrites (applying the action-title + positive-charge
rule — a claim, 6–14 words, carrying a number/verb/inevitability):**

| # | Flat (draft) | Charged rewrite |
|---|---|---|
| 1 | "Company Overview" | "(Re)introducing Payline: same rails, rebuilt engine" |
| 2 | "Our Products" | "One platform now moves money across every rail a merchant needs" |
| 3 | "Financial Highlights" | "We compound at Rule of 40 with expanding margins" |
| 4 | "Why Now" | "Real-time rails are going mainstream — and merchants are re-platforming now" |
| 5 | "Conclusion" | "The rails you trusted, rebuilt for the next decade of payments" |

**Failure modes flagged:**

- **Defensive reintroduction.** Don't apologize for the old Payline; the
  same/different matrix reframes the past as a completed rebuild, not a
  liability.
- **Hedged close.** Don't end on non-GAAP reconciliations — lead the close with
  the thesis, then put reconciliations in the appendix (the only place neutral
  labels are allowed).
- **Topic-label titles.** All five original titles are placeholders; none would
  fail on a competitor's deck, which means none of them claim anything.

---

## How to grade real output against these

A response is on-standard when it:

- [ ] Names 1–2 reference decks that fit the situation (not a generic answer).
- [ ] Selects **3–5** positioning moves and names them — penalize "all nine."
- [ ] Designs the **opening hook and closing move** explicitly, before/apart from
      the middle.
- [ ] Produces slide titles that are **claims with charge** (number/verb/
      inevitability, 6–14 words) — zero topic labels ("Overview," "Why Now,"
      "Conclusion").
- [ ] Runs a **per-section sequencing pass** and can show the titles escalate and
      land (the shuffle test).
- [ ] **Flags failure modes** it sees (topic labels, flat titles, generic AI,
      TAM inflation, feature dumps, unquantified problems, hedged closes).
- [ ] Stays **in scope** — narrative and positioning only; does not wander into
      valuation, unit economics, or visual design.
