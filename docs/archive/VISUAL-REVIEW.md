# Visual Review — intellibank (merge/sandbox-2026-05-21)

> **HISTORICAL. Point-in-time record (2026-05-20).** The visual critique that drove the navy register pivot (ADR-0006). The product has since evolved (the 2026-05-24 AI-native shell redesign). Current source of truth: `/README.md`. Kept for decision traceability.

**Status:** Critical visual review. Untracked working-tree draft.
**Reviewer:** subagent VR.1
**Date:** 2026-05-20
**Reference:** `/Users/martincasado/FutureProofing/intelibank-sandbox` (navy + teal IB-terminal sibling).

---

## TL;DR — the verdict in three sentences

The product currently reads like a magazine longread, not an institutional intelligence terminal: warm cream + Fraunces serif headers + ~48px section gaps + 15px body type cohere into a register that is closer to Substack than Bloomberg. The four user-reported criticisms (padding inconsistente, typography blog-ish, density baja, brand register completo) are all real and all reinforce each other — and the root cause is not "execution polish missing" but a deliberate brand decision (Editorial Institutional, `docs/04-brand/visual-language.md`) whose color, type, and spacing tokens are STRUCTURALLY a warm editorial system, not a terminal system. To get to IB-grade we either need (A) ruthless density polish inside the current spec (will half-fix), or (B/C) a deliberate token-and-type pivot toward the sandbox's navy/teal/13px register. **Recommendation below: B — partial pivot — is the right answer.**

---

## The four criticisms — investigated

### 1. Padding / spacing inconsistente

**Evidence — the token ladder itself is broken.**

`src/app/globals.css:50-57` defines a 4px-grid ladder with conspicuous gaps:

```css
--space-1: 4px;  --space-2: 8px;   --space-3: 12px;
--space-4: 16px; --space-6: 24px;  --space-8: 32px;
--space-12: 48px;
```

There is **no `--space-5`, `--space-7`, `--space-9`, `--space-10`, `--space-11`** declared. Yet `--space-5` (20px) and `--space-10` (40px) are referenced in **20+ component call sites**:

- `src/app/page.tsx:128` — `gap-[var(--space-10)]`
- `src/app/page.tsx:163` — `px-[var(--space-6)] py-[var(--space-5)]`
- `src/app/skills/page.tsx:91` — `gap-[var(--space-10)]`
- `src/app/acquirers/[id]/page.tsx:219` — `px-[var(--space-8)] py-[var(--space-6)]`
- `src/components/acquirers/AcquirerCard.tsx:156-157` — `gap-[var(--space-5)] py-[var(--space-4)] pr-[var(--space-4)] pl-[var(--space-5)]`
- `src/components/acquirers/FootballFieldPanel.tsx:176` — `gap-[var(--space-5)]`
- `src/components/team/MessageComposer.tsx:212` — `px-[var(--space-5)] py-[var(--space-4)]`
- `src/components/acquirers/PeerStrip.tsx:84` — `px-[var(--space-5)]`

**These references resolve to `unset`** at runtime — Tailwind v4 will emit literal `padding-inline: var(--space-5)` and the browser computes that to `0`. Every component using `--space-5`/`--space-10` is silently rendering with zero on that axis (or whatever cascading default). This is not "inconsistent spacing rhythm." It is **broken spacing**. The eye reads it as random because half the time the padding the developer asked for didn't apply.

**Secondary evidence — even where tokens DO resolve, the choices are ad-hoc per component.** The `Card` primitive (`src/components/primitives/Card.tsx:38`) ALWAYS uses `p-[var(--space-6)]` (24px). But page headers use `py-[var(--space-12)]` (48px) and section gaps use `gap-[var(--space-12)]` (48px). Yet `AcquirerCard` hero overrides Card with `p-[var(--space-8)]` (32px) at `AcquirerCard.tsx:112` and row variant uses `py-[var(--space-4)] pl-[var(--space-5)]` instead. There is no rhythmic system — each component decided locally.

**Sandbox comparison.** `intelibank-sandbox/app/globals.css:262` uses `.panel-pad { padding: 18px 20px; }` — a *single* canonical panel padding for all panels. `intelibank-sandbox/app/globals.css:77` uses `.page-inner { padding: 0 28px 56px; }` — a single page outer padding. The sandbox's discipline is "one panel padding, one page padding, every panel obeys."

**Proposed fix (concrete):**

1. Fill the ladder: add `--space-5: 20px; --space-7: 28px; --space-10: 40px; --space-11: 44px;` to `globals.css:50-57`. Non-negotiable — this is broken code, not stylistic.
2. Reduce the page rhythm: replace `gap-[var(--space-12)]` on the four route pages with `gap-[var(--space-8)]` (48px → 32px). Replace `py-[var(--space-12)]` with `py-[var(--space-8)]` (48px → 32px). These give back 32px per section transition.
3. Reduce `Card` default padding from `p-[var(--space-6)]` (24px) to `p-[var(--space-5)]` (20px), and add a `density="compact"` variant at `p-[var(--space-4)]` (16px) for the dense surfaces (acquirer rows, league table). 24px belongs to hero cards, not list rows.
4. Forbid local padding overrides on `Card` consumers. Audit and remove the per-callsite `p-[var(--space-8)]` overrides in `AcquirerCard.tsx:112` and the league-row override in `AcquirerCard.tsx:156-157` — they should use Card variants, not raw classes.

### 2. Typography flat / blog-ish

**Evidence — type ramp is editorial, not instrumental.**

`src/app/globals.css:41-47`:

```css
--text-xs: 11px;  --text-sm: 13px;  --text-base: 15px;
--text-md: 17px;  --text-lg: 21px;  --text-xl: 28px;  --text-2xl: 40px;
```

Combined with `body { font-size: var(--text-base); }` (15px) and the semantic ramp at lines 279–324:

- `.display-1` = `clamp(28px, 3.6vw, 44px)`, `font-weight: 440`, Fraunces serif italic display.
- `.display-hero` = `clamp(40px, 6vw, 84px)`, Fraunces serif.
- `.editorial-lead` = `clamp(17px, 1.5vw, 21px)`, sans, ink-secondary.

**Body 15px Inter + 28–44px Fraunces display + 17–21px editorial-lead is exactly the rhythm of The Atlantic / a Medium longform.** It is not the rhythm of Bloomberg Terminal (11–13px body, 14–16px section heads, 18–20px hero values) or Linear (13–14px body, 14–18px heads).

Cross-evidence from the four pages:

- `src/app/page.tsx:138-143` — the seller name uses `text-[var(--text-xl)]` ITALIC Fraunces (28px serif italic) as a page subtitle. That's a magazine pull-quote.
- `src/app/page.tsx:147` — `display-1` for "The mandate, at a glance." — a 44px Fraunces serif heading on a one-line decorative phrase.
- `src/app/acquirers/page.tsx:147` — `display-1` for "Five acquirers, ranked." — same serif treatment.
- `src/app/team/page.tsx:127` — `display-1` for "Every message checks before it sends." — serif statement, blog headline rhythm.

The **hierarchy is also weak**. There's `display-1`, then a 32px gap, then `editorial-lead` at 21px, then body at 15px. That's three sizes (44/21/15) where IB terminals use six tightly-spaced sizes (28/18/15/13/12/11) so the eye reads structure, not statement→paragraph→body.

**Sandbox comparison (`intelibank-sandbox/app/globals.css`):**

- `body { font-size: 13px; line-height: 1.5; }` — 2px denser than ours.
- `.deal-context-name` (mandate name) = `font-size: 28px; font-weight: 600` — same size as our `--text-xl` but **600 weight**, not 440 italic serif. Senior, not editorial.
- `.h-serif` (panel titles) = `font-size: 15px; font-weight: 600` — Inter, NOT Cormorant Garamond. The sandbox explicitly forbids the serif from panel heads ("the two Cormorant Garamond moments live on `.deal-context-name` and `.deal-context-q-txt` only" — sandbox CSS comment, line 280).
- `.kicker` (eyebrow) = `font-size: 9.5px` — *2px smaller than ours.* Bloomberg-style ALL-CAPS micro-label.
- Five tier sizes work hard: 9.5 / 11 / 12 / 13 / 15 px.

Our intellibank surface uses **two big serif moments per page** (the italic seller name + the display-1 heading) where the sandbox uses **two per APPLICATION** (mandate name + open question). This is the most visible "blog" tell.

**Proposed fix (concrete):**

1. Drop `--text-base` from 15px → 13px. Body, page, captions follow.
2. Add `--text-xxs: 10px` for kickers/eyebrows; reduce eyebrow letter-spacing from `0.14em` to `0.10em` and font-size from `var(--text-xs)` (11px) to 10px.
3. Demote `.display-1` from `clamp(28px, 3.6vw, 44px)` to `clamp(20px, 2.2vw, 28px)`, change `font-weight: 440` to `font-weight: 600`, change `letter-spacing: -0.016em` to `-0.01em`. This kills the magazine register.
4. Reserve Fraunces / `font-display` to TWO sites application-wide: (a) the mandate name in the page header, (b) the open question banner. Everywhere else use `font-sans` (Inter) with `font-weight: 600` for headings — sandbox discipline. Update `display-1` to use `var(--font-sans)` instead of `var(--font-display)`.
5. Add `.h-section { font: 600 14px/1.2 var(--font-sans); letter-spacing: -0.005em; }` and `.h-panel { font: 600 13px/1.25 var(--font-sans); }` to fill the missing 14/13px tier — these become the panel and section heads. Routes use `.h-section`, panel cards use `.h-panel`.
6. `editorial-lead` shrinks: `clamp(17px, 1.5vw, 21px)` → `clamp(13px, 1vw, 15px)`. The "lead" should be sub-heading information density, not a magazine standfirst.

### 3. Density baja (airy)

**Evidence — the page rhythm bleeds vertical air.**

Per route:

- `src/app/page.tsx:128` — `gap-[var(--space-10)] py-[var(--space-12)]` = 40px gap + 96px vertical padding (48 top + 48 bottom). Six sections × 40px = 240px of pure air between content blocks.
- `src/app/acquirers/page.tsx:142` — `gap-[var(--space-12)] py-[var(--space-12)]` = **48px gap + 96px page padding**.
- `src/app/team/page.tsx:123` — same — `gap-[var(--space-12)] py-[var(--space-12)]`.
- `src/app/acquirers/[id]/page.tsx:279` — analytical-panels stack = `gap-[var(--space-12)]` (48px between four already-tall panels).

That is **3× the sandbox's density.** `intelibank-sandbox/app/globals.css`:

- `.page-inner { padding: 0 28px 56px; }` — no top padding (the navy app-bar sits flush), 56px bottom only.
- `.deal-context { padding: 16px 20px; margin-bottom: 18px; }` — 18px between sections.
- `.surface-grid { gap: 18px; }` — 18px gap.
- `.surface-col { gap: 18px; }` — 18px between vertical panels.

The sandbox lives in an **18-20px section rhythm**. Ours lives in a **40-48px section rhythm**. That is the entire perceptual difference between "data terminal" and "blog page."

Inside cards it's the same story:

- `Card` primitive default = `p-[var(--space-6)]` = 24px on all sides.
- Sandbox `.panel-pad` = 18px 20px.
- Sandbox `.acq-card` = `padding: 16px 18px`.

Plus the body line-height: `.body { line-height: 1.55 }` (`globals.css:331`). Sandbox body = 1.5. Two percent line-height across 15px = noticeable extra vertical bleed.

**Proposed fix (concrete):**

1. **Page rhythm**: every route changes `gap-[var(--space-12)] py-[var(--space-12)]` → `gap-[var(--space-6)] py-[var(--space-6)]` (48→24, 48→24). On `acquirers/[id]/page.tsx:279`, the analytical-panels stack changes `gap-[var(--space-12)]` → `gap-[var(--space-6)]`.
2. **Card padding**: default Card = `p-[var(--space-5)]` (20px). Hero variant = `p-[var(--space-6)]` (24px). Compact variant (rows) = `p-[var(--space-4)]` (16px).
3. **Body line-height**: `.body { line-height: 1.45 }` (was 1.55). `.editorial-lead { line-height: 1.45 }` (was 1.5).
4. **Mandate vitals tiles**: replace the four-column tile grid (`src/app/page.tsx:178-229`) currently using `Card` (24px padding × 4) with a single horizontal strip mirroring the sandbox `.deal-context` pattern — name + four micro-metrics in a single row, total height ~80px instead of the current ~220px. Each metric: 9px label / 15px mono value, total ~50px per cell.

### 4. Brand register completo

**This is the real issue, and the answer is: the brand spec itself.**

Read together, `docs/04-brand/brand-foundations.md` and `docs/04-brand/visual-language.md` commit to a brand that is structurally non-IB-terminal:

- **Voice spec (`brand-foundations.md` §Voice):** "Precise, senior, decisive. Anti-data-dump." This part is correct and we should keep it.
- **Visual spec (`visual-language.md` §Spacing and density, line 102):** "Layout: airy — generous whitespace between sections, not compact." **This is explicit.** The current shell is executing the spec correctly. The spec is the problem.
- **Visual spec (`visual-language.md` §Type):** primary type stack is Fraunces serif for display + Inter for body. The serif is editorial DNA. Bloomberg, Linear, Rogo do not use serif display.
- **Visual spec (`visual-language.md` §Colour tokens):** the dominant background is `--surface-warm: #f5f2eb` (warm cream). That is the single biggest visual difference. Cream + serif = editorial register. Cool-gray + sans = terminal register. There is no halfway.

Compare what we extracted FROM Rogo per `visual-language.md` lines 19-34 (warm cream, Fraunces) vs what Rogo actually IS now (cool slate, sans-serif terminal). **The visual spec is not accurately Rogo-derived; it borrowed Rogo's colour names but invented an editorial register on top of them.** The user is right: this register cannot reach IB-grade because it was never trying to.

The sandbox (`intelibank-sandbox/app/globals.css:18-46`) is exactly the alternative:

- `--navy: #0E1B3A` — dark institutional anchor (app bar, modals).
- `--bg: #F4F5F8` — cool light surface (page background).
- `--ink: #0E1B3A` — navy as ink, not black.
- `--teal: #1A8F8F` + `--teal-dark: #0E5757` — the single accent.
- `--gold: #C6962E` for warnings; `--coral: #D14B30` for blocked; `--green: #2D7E54` for positive.
- 13px body, 1.5 line-height.
- Cormorant Garamond is reserved for **two** moments application-wide.

That register IS Bloomberg-adjacent. It can absolutely deliver IB-grade.

**Position:** Editorial Institutional, as currently specified, cannot deliver IB-grade — not as a polish issue, as a spec issue. The warm-cream + Fraunces choice **structurally produces** the look the user is criticising. We must change the spec, not the execution.

---

## The bigger question — brand identity

**Editorial Institutional** is a coherent brand. It is also the wrong brand for this product.

The thesis (CLAUDE.md) says:

> Compliance is omnipresent. Decisions, not data. Sell-side, pre-onboarded, for managing directors.

An MD does not want a magazine. An MD wants a **terminal**. Terminals are dense, cool, sans-serif, mono-numeric, and visually quiet so the data screams. Magazines are airy, warm, serif-led, and visually loud so the writing breathes.

The Editorial Institutional spec keeps trying to do both: senior serif voice + dense data tables + warm cream + 48px gaps. The execution failure the user is calling out is actually the **inherent tension in the spec.** Every component shipped has had to choose which side it serves; the result is a mid-2000s blog with a finance plug-in.

**The brand should be IB-terminal first, editorial second.** That means: cool-gray + navy + teal + sans-serif headings; mono numerics; 13px body; 18-20px section rhythm. Reserve the Fraunces serif for the two named moments (mandate name + open question) — the sandbox already proved this is enough to keep the "editorial" identity moment without losing the terminal register.

---

## Concrete fix plan

### Option A — execution polish within current brand spec
**What:** Fix the broken `--space-5`/`--space-10` tokens; reduce per-route gaps from 48 to 32; reduce Card padding from 24 to 20; demote `display-1` to 28px; reduce body to 14px.
**Outcome:** Solves the padding bug (#1, hard); halves the airiness (#3, partial); typography still reads editorial (#2, unsolved); brand still warm-cream serif (#4, unsolved).
**Effort:** ~1 day. Pure surface-level token + utility changes.
**Risk:** Low. Touches `globals.css` + four pages. No new tokens, no new tests.
**Verdict:** Half-measure. User will be 30% happier and still call it blog-ish.

### Option B — partial pivot — keep Fraunces (two moments), drop warm-cream + airy spacing, adopt density and ink-on-deep tokens (RECOMMENDED)
**What:**
- Add a new token block for IB-terminal: `--ib-bg: #F4F5F8`, `--ib-ink: #0E1B3A`, `--ib-ink-muted: #4F5B70`, `--ib-rule: #DDE0E7`, `--ib-teal: #1A8F8F`, `--ib-teal-dark: #0E5757`, `--ib-navy: #0E1B3A`.
- Map `--background` to `--ib-bg` (was `--surface`). `--ink` becomes `#0E1B3A`. `--surface-warm` retires.
- Body 13px, line-height 1.45.
- Fraunces reserved to two named utility classes: `.editorial-name`, `.editorial-question`. Every other display becomes sans-serif weight-600.
- Spacing ladder filled (5/7/10/11 added) and route rhythm reset to 20-24px section gaps.
- AppHeader becomes navy (or stays light but adopts the cool surface).
- ComplianceRibbon's `--positive` stays green; `--accent` blue rebinds to `--ib-teal`.
**Outcome:** Solves all four criticisms. The product reads as a terminal with two intentional editorial accents — matches the brand voice ("precise, senior, decisive") without the magazine costume.
**Effort:** ~2-3 days. Token-set rewrite + audit of every component for the new register. Brand spec rewrite in `docs/04-brand/visual-language.md`. ADR documenting the pivot.
**Risk:** Medium. The token names stay; the hex values change; ~30 components need an eye to confirm contrast/aesthetic. Tests assert behaviour, not pixels — should pass.
**Verdict:** This is what the user is asking for, articulated. Strongly recommended.

### Option C — full pivot to IB-terminal register
**What:** Mirror the sandbox 1:1. Adopt the sandbox `globals.css` whole; rewrite all four pages to use the sandbox's `.panel` / `.deal-context` / `.surface-grid` patterns; retire `Card`, `Pill`, `editorial-lead`, `display-1`. Wordmark goes navy. Compliance instrument adopts the sandbox `app-pill` pattern (already partially merged).
**Outcome:** Maximum density, maximum IB-grade. Total visual unity with the sandbox.
**Effort:** ~5-7 days. Half the components need rewriting against new utility classes; semantic primitives (Card/Badge/Pill) lose their Tailwind-token wiring; brand spec rewritten end-to-end.
**Risk:** High. The frozen primitives are referenced by 30+ tests asserting structure; we'd be breaking the seam between "structure" and "skin." Loses the option to keep any editorial moments at all.
**Verdict:** Over-rotation. We already have the sandbox if we wanted the sandbox literally — keeping two products visually identical defeats having two products.

---

## Specific token changes proposed (Option B)

**Add to `src/app/globals.css:50-57` — spacing ladder, fill the gaps (critical bug fix):**

```css
--space-5: 20px;
--space-7: 28px;
--space-10: 40px;
--space-11: 44px;
```

**Replace the colour token block (lines 13-26):**

```css
/* IB-terminal palette (replaces warm-editorial). */
--ink:           #0E1B3A;
--ink-secondary: #4F5B70;
--ink-tertiary:  #8B95AC;
--surface:       #FFFFFF;
--surface-subtle:#ECEEF2;
--surface-warm:  #F4F5F8;        /* retired-as-warm, repurposed as cool page bg */
--surface-dark:  #0E1B3A;
--stroke:        #DDE0E7;
--accent:        #1A8F8F;        /* teal, was #0099ff blue */
--accent-dark:   #0E5757;
--positive:      #2D7E54;
--positive-deep: #1B4D33;
--negative:      #D14B30;
--canvas-bg:     #0E1B3A;        /* navy, was forest */

/* Page background is the cool gray, not the warm cream. */
--background: var(--surface-warm);  /* now #F4F5F8 */
```

**Type scale (replace lines 41-47):**

```css
--text-xxs:  10px;
--text-xs:   11px;
--text-sm:   12px;
--text-base: 13px;
--text-md:   14px;
--text-lg:   16px;
--text-xl:   20px;
--text-2xl:  28px;
```

**Semantic type ramp (replace lines 279-324):**

```css
.editorial-name {
  font-family: var(--font-display);
  font-size: clamp(22px, 2.4vw, 28px);
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.01em;
}
.editorial-question {
  font-family: var(--font-display);
  font-style: italic;
  font-size: clamp(14px, 1.2vw, 16px);
  line-height: 1.35;
  color: var(--ink);
}
.display-1 {
  font-family: var(--font-sans);     /* SANS, not Fraunces. */
  font-size: clamp(18px, 1.6vw, 22px);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
.editorial-lead {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.45;
  color: var(--ink-secondary);
}
.eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: var(--ink-tertiary);
}
.body {
  font-size: 13px;
  line-height: 1.45;
}
```

**Route rhythm (apply across `src/app/page.tsx:128`, `src/app/acquirers/page.tsx:142`, `src/app/team/page.tsx:123`, `src/app/skills/page.tsx:91`):**

`gap-[var(--space-12)] py-[var(--space-12)]` → `gap-[var(--space-6)] py-[var(--space-6)]`

**Card primitive (`src/components/primitives/Card.tsx:38`):**

`p-[var(--space-6)]` → `p-[var(--space-5)]`. Add `density="compact"` variant at `p-[var(--space-4)]`.

---

## Closing note

The user's diagnosis is correct and concise. The brand spec, faithfully executed, produces what they're seeing. Polish-only (Option A) addresses the symptom; the partial pivot (Option B) addresses the cause while keeping the moves of the brand (two editorial moments, compliance-first instrument, senior voice) that ARE working. Option B is the right call.
