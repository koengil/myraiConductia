# Conductia Front-End — Design of Record (Editorial Institutional)

Companion to the master ledger (`docs/superpowers/plans/2026-05-19-intellibank-frontend-overhaul/master.md`).
The ledger owns the PRESERVE-LIST CONTRACT (what must not break). This spec owns
the DESIGN (what we are building). Every parallel batch agent reads BOTH so the
rebuilt surfaces converge into one coherent product, not four different looks.

Foundation docs are the source of truth for content/intent: `docs/00-vision`,
`docs/00-vision/strategy-and-moat.md`, `docs/01-business/*`,
`docs/02-product/*`, `docs/04-brand/{brand-foundations,visual-language,motion-language}.md`,
`docs/05-growth/{narrative-and-positioning,demo-script}.md`, `docs/07-decisions/*`,
`docs/99-source/*` (verbatim founder/team framing where it is the truest source).

---

## 1. Aesthetic north star — Editorial Institutional

Reads like a **top-tier finance institution that is natively AI** — Bloomberg/
Stripe-press gravitas, not a generic SaaS dashboard. Principles:

1. **Editorial, not decorative.** Composition, typography, and whitespace carry it. Every screen is art-directed (asymmetry, a clear focal hierarchy), never a centered card in a void.
2. **Cinematic dark ↔ warm light rhythm.** The journey breathes between deep-forest cinematic moments (entry, section breaks, close, presenter mode) and warm-neutral working surfaces (the product stages). Dark = gravitas/arrival; light = focus/work.
3. **Compliance is the architecture, felt.** The compliance instrument is a designed system element present and alive on every screen — the moat, visible (`product-principles.md §3`, `strategy-and-moat.md §1`).
4. **Decisions, not data dumps.** Surface the verdict; supporting data is dense-but-elegant and secondary (`product-principles.md §2`).
5. **Senior register.** Precise, confident, calm. Nothing playful, nothing junior. Built for the MD who makes the call (`personas-and-jobs.md`).
6. **Motion is meaning.** The three signature motions (Compliance Pulse, Skill-Transform Stream, Score Reveal) are how compliance/intelligence/scoring are *felt*. Timings are frozen (ledger §3.3); visuals are elevated.

## 2. Type system

Self-hosted via `next/font`, zero license cost. **Token names stay byte-stable**
(`--font-display` / `--font-sans` / `--font-mono`) — only the loaded faces + the
fallback chain change in `layout.tsx` + `globals.css`.

| Token | Recommended face | Role | Alternatives (Lance sign-off gate) |
|---|---|---|---|
| `--font-display` | **Fraunces** variable (opsz/SOFT/WONK) | Hero + stage headings + score numerals. Editorial gravitas. opsz high, wght 380–460, tight tracking on large sizes. | Newsreader (more newspaper), Spectral (calmer/safest) |
| `--font-sans` | **Inter** variable, tuned `cv05 cv08 ss03`, `tnum` on data | Body, UI, labels, captions, eyebrows | Geist Sans (already loaded; least distinctive) |
| `--font-mono` | **Geist Mono** (already in tree) | Compliance output, rule IDs, tabular financials, legal | IBM Plex Mono, JetBrains Mono |

Fallback chain (real, not Times): display → `Iowan Old Style, Georgia, serif`;
sans → `system-ui, -apple-system, sans-serif`; mono → `ui-monospace, monospace`.
`display:swap`, latin subset, size-adjust fallback metrics (zero-CLS, the existing `next/font` precedent).

**Semantic type ramp** (utilities in `globals.css` on top of the kept `--text-*`):
`display-hero` `clamp(40px,6vw,84px)` Fraunces tight · `display-1` (stage h1, Fraunces) ·
`editorial-lead` (lead paragraph) · `eyebrow` (Inter, uppercase, tracked, 11px, ink-tertiary) ·
`data-xl` (Fraunces or tabular Inter, the score/figure) · `body` · `caption` · `mono-legal`.
Headlines are statements, not questions (`brand-foundations.md §Voice`).

## 3. Color & surface system

Existing 16 tokens in `globals.css` are FROZEN values — never mutate; only extend.
Usage discipline (the current failure is flat application):

**Light working surfaces (product stages — Intent, Landscape, DeepDive work area, ComplianceTheatre):**
- Page base `--surface-warm` (#f5f2eb) NOT pure white — warm institutional paper.
- Cards/panels `--surface` (#fff) on the warm base, separated by `--stroke` + elevation (not heavy borders).
- Text `--ink` / secondary `--ink-secondary` / tertiary `--ink-tertiary` (eyebrows, captions).
- Accent `--accent` used **sparingly and intentionally** — focal CTAs, active state, the compliance through-line. Never a full-bleed raw button with no surrounding system (the current "default blue" failure). Prefer `--positive-deep`/`--ink` for primary action weight on light; `--accent` for interactive/links/focus.

**Dark cinematic surfaces (ColdOpen entry, section breaks, PitchCta close, presenter mode):**
- `--canvas-bg` (#0f2822 deep forest) base with `--bg-cinematic` (radial highlight + vignette) + a fine subgrid texture.
- Text = `--surface-warm` on dark; secondary = a muted warm.
- One luminous accent: `--positive` for the compliance through-line, `--accent` for the single CTA.
- This is where the "Rogo homepage gravitas" lives — composed, deep, confident.

**The DeepDive canvas** is a dark-tinted workspace stage (forest-derived, slightly lifted from #0f2822) so dropped skill panels read as luminous intelligence surfaces.

**Extended tokens to add (additive `:root`/`@theme` block, never mutate existing):**
- Elevation: `--elev-0` (stroke only), `--elev-1` resting card (0 1px 2px ink/4 + stroke), `--elev-2` raised (0 8px 24px ink/8), `--elev-3` modal (0 24px 64px ink/16); a dark-surface set (luminous inner-stroke + soft outer glow).
- `--bg-cinematic` gradient, `--texture-grid` (fine 1px line), inverse text tokens.
- Layout: `--page-max: 1200px`, `--page-pad` responsive 16/24/48, `--shell-header-h`, `--shell-spine-w/h`, 12-col grid vars.

## 4. Component design language (must be consistent across all batches)

- **Cards/Panels:** `--surface` on warm base, `--radius-card` (8px kept), `--elev-1` resting / `--elev-2` on focus or hero; generous internal padding on the 4px grid; a hairline `--stroke` not a heavy border. Dark-surface variant for cinematic/canvas.
- **Buttons (preserve all props/variants/sizes):** primary = solid `--ink` (or `--positive-deep`) on light / `--accent` only as the single focal CTA in cinematic moments; ghost/secondary = quiet. Real focus ring (`--accent`, offset). Editorial label spacing. The current full-width raw-`--accent` fill is the failure to replace.
- **Inputs (Intent command bar):** instrument-grade — generous, mono-or-sans, a precise focus state, feels like a terminal command for a principal, not a form field.
- **Eyebrow + heading pattern:** small tracked uppercase Inter eyebrow (ink-tertiary) above a Fraunces `display-1` — the editorial signature used on every stage header.
- **The Compliance Instrument (ComplianceRibbon redesign):** integrated into the header chrome as a precise live status instrument — a state "crystal" (color + micro-motion per state) + FINRA/MNPI/KYC micro-indicators + the scanning cascade. NOT a gray browser bar. The Skill-Transform Stream visibly terminates into it. Preserve every contract item (ledger §3.2 ComplianceRibbon) + Compliance-Pulse timings (§3.3).
- **ScoreDial:** a "computed" instrument — band-colored ring (score → hue band), tick marks, Fraunces numeral, the Score-Reveal sweep. Numeric text node in DOM immediately (ledger §3.2 ScoreDial).
- **Wordmark (`src/components/brand/Wordmark.tsx`, NEW):** typographic SVG "Conductia" in Fraunces with tuned letterfit + a minimal compliance shield/check glyph in `--positive-deep`. Works on light + dark (currentColor-aware). Single source of the brand mark; `public/` favicon + og derived from it. Name is always "Conductia" (D4).
- **Icons (`src/components/brand/icons/*`, NEW):** one consistent 1.5–1.75 stroke, currentColor, no icon-library dependency (matches the existing inline-SVG convention).
- **Progress spine (`ProgressSpine`, NEW):** editorial 6-stage indicator from `STAGE_ORDER`+`state.stage` (read-only) with a compliance through-line motif; vertical desktop / horizontal mobile; minimal/hidden in presenter mode.

## 5. Responsive

Mobile-first, perfected at ≤375 / 768 / 1280 / 1920. Stages compose on the 12-col
grid; mobile = single column with deliberate hierarchy (never a shrunk desktop).
DeepDive: skill shelf → top scroll-row/drawer on mobile; **add an accessible tap
"add to canvas" path invoking the same drop code path** (HTML5 DnD is unreliable
on touch) while preserving the desktop drag path + the jsdom DataTransfer test stub.
PeerStrip → horizontal scroll-snap on mobile.

## 6. Per-surface design direction (driving docs in brackets)

- **ColdOpen** [experience-spine S1, demo-script S1, narrative-and-positioning, brand-foundations]: full-bleed cinematic forest entry. Oversized Fraunces hero line, the Wordmark, the positioning line *"The compliance-first M&A intelligence layer for managing directors"* with gravitas, the pre-onboarded persona as an institutional credential card. A faint ambient compliance breathe + a backdrop data-stream that previews the wow beat. Desktop asymmetric editorial split; mobile single column. Preserve: heading name `Atlassian`, tagline, `Mike Cannon-Brookes`, button `Enter Conductia`, load/error strings + console contract.
- **Intent** [experience-spine S2, motion-language §1, brand-foundations §Voice]: instrument-grade command surface on warm light. The command bar is the focal object. Rewrite the header sub-line to on-voice prose (kill the em-dash; statements not questions). The FINRA/MNPI/KYC boot is a designed compliance-boot sequence rising toward the instrument. Preserve every asserted string + boot timing/order (ledger §3.2/§3.3 Intent).
- **Landscape** [experience-spine S3, matrices, fixtures, strategy-and-moat §2]: editorial ranked decision board — rank #1 (Anthropic 87) gets hero treatment, the rest a refined dense league table; an AI-native vs SaaS cue (the anti-Rogo thesis made visual); ScoreDial richer. PeerStrip = low-emphasis "who you sit next to" rail. Preserve AcquirerCard `role=button`/aria-name/keyboard/onSelect, DESC ranking, scores, load/error/console.
- **DeepDive (hero canvas)** [experience-spine S4–5, motion-language §2-3, skills-catalog]: the centerpiece, highest polish. Dark-tinted workspace; curated draggable skill deck; acquirer header band with composite dial as hero stat; ex-banker-credible editorial data panels (Fraunces figures, the compliance "verified" stamp elevated); the premium paywall a restrained elegant monetization moment (skill access = the value metric, `monetization-and-skills-economy.md`). Preserve all drag mimes/`data-*`/`data-testid`/dispatch order/empty-state/paywall contract/motion (ledger §3).
- **ComplianceTheatre** [experience-spine S6, demo-script S5]: a real communications surface — elegant team profile rows; the composer an instrument; clean→delivered (joins thread) and blocked (stopped-at-the-gate, live FINRA reason) as designed dramatic beats tied visually to the instrument. The blocked card is the headline compliance proof — give it weight. Preserve all composer/team contract + scanning order (ledger §3).
- **PitchCta** [experience-spine S7, demo-script S6]: confident editorial close, back to the cinematic dark register to bookend ColdOpen. Recap as an institutional summary; CTA a forward statement. Preserve recap regex lines, button, inert behavior, the curly-apostrophe caption (ledger §3.2 PitchCta).
- **Shell** [visual-language, motion-language, brand-foundations]: AppHeader (Wordmark + persona/session context, transparent over cinematic / solid on product), the Compliance Instrument, ProgressSpine, cinematic presenter mode (`?present=1`: dimmable auto-fading controls + ←/→ + ≤200ms stage cross-fade — must not reorder the Intent-boot dispatch or break golden-path `waitFor`), one designed `StageStatus` for loading/error (strings/roles preserved).

## 7. Copy & messaging fidelity (the §7 workstream)

Build a **copy-fidelity matrix** (appended to this spec in Phase E): every visible
string → its source doc/section. Rules:

1. **Traced to a doc.** Allowed sources listed at the top of this spec. No invented value props or off-doc claims.
2. **Brand voice** (`brand-foundations.md §Voice`): precise (no filler), senior (peer-to-peer with an MD), decisive (statements not questions, verdicts not options), anti-data-dump. No hedging ("perhaps/might/could"), no front-loaded context, no scare-quotes/meta-narration, **no em-dashes in prose sentences** (periods, short sentences). "Conductia" always.
3. **Persona, always.** The MD — Mike Cannon-Brookes archetype (`personas-and-jobs.md`): senior, time-constrained, not an analyst, not a compliance expert, high-EQ, sell-side only. Demo audience = Storm, ex-banker (`stakeholders-and-gtm.md`) — copy must survive his scrutiny. Every screen passes `product-principles.md §1` ("MD-need vs analyst-prep").
4. **Offering accurate.** Three headline claims in order (`narrative-and-positioning.md`): (1) Decisions, not data dumps. (2) Compliance omnipresent (former FINRA examiners; checked before it executes). (3) MD-native. Positioning line verbatim where used. Anti-Rogo contrast (`strategy-and-moat.md §2`). Skill access = value metric. Sell-side M&A only; pitch-prep is "next session" (D10).
5. **Em-dash/contract policy:** see master ledger §4 — prose em-dashes rewritten (lockstep test update + log if asserted and not in golden-path); structural separators in ARIA/domain/recap strings kept byte-identical (rationale in ledger §4); golden-path never weakened.

Enforcement: each Phase-C batch agent gets §7 + the ledger preserve-list as a hard brief; a dedicated copy-fidelity verifier pass in Phase E maps 100% of rendered strings to the matrix and flags any unsourced/off-voice/off-persona/off-offering copy.

## 8. Definition of done

All objective gates (vitest double-run green, tsc 0, eslint 0, `next build`
static-clean, seam +0/−0, golden-path green, zero console.error on the happy
path) + a visual/responsive QA pass at the four breakpoints (no Times New Roman;
Fraunces rendering; the 3 wow beats land; editorial rhythm; focus states) + the
copy-fidelity matrix at 100% + the Lance-only gates (type-trio confirmation,
visual sign-off, deploy) explicitly surfaced, not auto-passed.

---

## 9. Copy-fidelity matrix (Phase E — appended 2026-05-20)

Every visible string a real MD sees, traced to a source. The matrix is intentionally compact — its job is to answer "where does this come from and is it safe to change" for any string you find on screen, not to enumerate every label. Classifications:

- **FROZEN** — contract-asserted in ledger §3.1 (golden-path) or §3.2 (per-component). Byte-identical or lockstep-only.
- **FROZEN-em-dash** — em-dash is a sanctioned structural separator per §4 (ARIA / regulatory / ranked-data recap). Not a brand-voice violation. Keep byte-identical.
- **PROSE** — visible prose; brand-voice rules apply (no em-dashes in sentences, statements not questions, no hedging).
- **DEMO-TELL** — language that advertises sandbox/demo-ness. Removed in E unless contract-asserted (then deferred to F's lockstep golden-path rewrite).

### ColdOpen
| String | Source | Class |
|---|---|---|
| `Atlassian` (h1 name) | `99-source/` persona; D5 sell-side mandate | FROZEN |
| `The teamwork platform behind the world's best software teams.` | seller fixture / 99-source | FROZEN (straight `'`) |
| `Mike Cannon-Brookes` | persona D5 | FROZEN |
| `Enter Conductia` (button) | experience-spine S1; entry CTA | FROZEN |
| `We start where other platforms end.` | strategy-and-moat §2 anti-Rogo | PROSE (on-voice) |
| `The intelligence is already loaded. No setup.` | D5 pre-onboarded | PROSE (on-voice) |
| `Session ready` (eyebrow) | brand-voice consistency | PROSE (on-voice) |
| `Loading session…` / `The session could not be loaded in the sandbox.` | contract §3.2 + console pair | FROZEN |

### Intent
| String | Source | Class |
|---|---|---|
| `I'm exploring a sale of Atlassian.` (input value, straight `'`) | demo-script S2 | FROZEN |
| `Intent command` (input aria) | §3.2 | FROZEN |
| `State the mandate.` (h1) | brand voice — imperative statement | PROSE (on-voice) |
| `One line is enough. Conductia surfaces the decisions, not a data dump. Every session is monitored from the first word.` | product-principles §2; replaces earlier em-dashed prose | PROSE (on-voice, em-dash already removed) |
| `Compliance boots on submit. KYC, FINRA, MNPI.` | motion-language §1 + product-principles §3 | PROSE (on-voice) |
| `KYC verified` / `FINRA Rule 2210 — communications` / `MNPI guard active` | §3.2 Intent reveal texts | FROZEN-em-dash (regulatory label) |

### Landscape
| String | Source | Class |
|---|---|---|
| `Acquirer landscape` (section aria) | §3.2 | FROZEN |
| `Step 3 — Acquirer landscape` (eyebrow) | spine step | FROZEN-em-dash (structural separator) |
| `Five acquirers, ranked.` | strategy-and-moat §2 + recap regex | PROSE (on-voice; also FROZEN as part of PitchCta recap regex) |
| `Anthropic — composite score 87` (button aria) / `Salesforce — composite score 67` | §3.2 acquirer-card aria | FROZEN-em-dash (ARIA separator) |
| `Scoring acquirers…` / `The acquirer landscape could not be loaded in the sandbox.` | §3.2 + console pair | FROZEN |

### DeepDive (+ Canvas / Skills / Panels / Paywall)
| String | Source | Class |
|---|---|---|
| `Acquirer deep-dive` (section aria) | §3.2 | FROZEN |
| `Compose the analysis. Each skill routes through compliance before [it executes].` | product-principles §3 | PROSE (on-voice) |
| `Continue ▸` (advance button) | spine UI | PROSE (functional; Phase F replaces with platform nav) |
| `Drag a skill here` / `It transforms the data, routes through compliance, and surfaces…` | Canvas empty state + flow narration | §3.2 (`Drag a skill here` FROZEN) + PROSE for the narration |
| `That skill could not be processed — try another.` (Canvas error) | §3.2 | FROZEN-em-dash (status-line separator) |
| `Composite fit` / `Computed, verified` | panel framing | PROSE (on-voice) |
| `Composite score breakdown` (panel aria) | §3.2 ScoreBreakdown | FROZEN |
| `Pro skill` / `Upgrade to Pro` / `Synergy & Deal-Structuring Engine is a Pro skill` (dialog aria) | §3.2 PaywallLock | FROZEN |
| `Plan management is not part of this demo.` (paywall click confirm) | §3.1 golden-path | FROZEN (DEMO-TELL deferred to F lockstep rewrite) |
| `No feature is hidden. It is one skill away. Skill access is [the value metric].` | monetization-and-skills-economy.md | PROSE (on-voice) |
| `Verified through the compliance layer` (ScoreBreakdown) | §3.2 | FROZEN |
| `Seven-factor strategic alignment` / `Culture and psych-fit` | panels framing | PROSE (on-voice) |
| `Skills failed to load.` / `Loading skills…` / `Drag a skill onto the canvas. Each one routes through compliance.` | SkillShelf states | PROSE (on-voice) |

### ComplianceTheatre (+ TeamDrawer + MessageComposer)
| String | Source | Class |
|---|---|---|
| `Compliance theatre` (section aria + h1) | spine S6 | FROZEN |
| `Every message checks before it sends.` | product-principles §3 | PROSE (on-voice) |
| `Clean communication goes through. Non-compliant language is stopped [at the gate].` | product-principles §3 + brand voice | PROSE (on-voice) |
| `Mike Cannon-Brookes` / `Sarah Reid` (team) | fixtures | FROZEN |
| `Pre-onboarded. Every message routes through compliance before it [sends].` | D5 + product-principles | PROSE (on-voice) |
| `Deal team` / `Monitored` (eyebrows/pills) | brand vocabulary | PROSE (on-voice) |
| `Message thread` / `Message blocked` (ARIA list/alert) | §3.2 | FROZEN |
| `Clean message` / `Risky message` / `Send` / `Checking compliance…` | §3.2 composer buttons | FROZEN |
| `Financials attached for your review.` | §3.2 clean-message body | FROZEN |
| `here are the financials, and honestly, fuck you` | §3.2 risky-message body | FROZEN |
| `Stopped at the gate — not sent` | §3.2 static blocked label | FROZEN-em-dash (badge separator; though this one reads more as prose; tracked but per §3.2 it is locked) |
| `Delivered` (badge) | §3.2 | FROZEN |
| `That message could not be sent — try again.` | §3.2 send-error | FROZEN-em-dash |
| `Compose` (eyebrow) / `Message body` (label) / `Write a message…` (placeholder) | UX scaffolding | PROSE (on-voice) |

### PitchCta
| String | Source | Class |
|---|---|---|
| `Pitch preparation` (section aria) | spine S7 | FROZEN |
| `Session complete` (eyebrow) | brand voice | PROSE (on-voice) |
| `The picture is built.` (h1) | brand voice — decisive statement | PROSE (on-voice) |
| Recap body (`Atlassian, sell-side.` / `Five acquirers, ranked. Anthropic 87, Salesforce 67` / `routed through compliance before it surfaced` / `Team messaging gated at the wire`) | §3.2 PitchCta recap regex | FROZEN-em-dash (ranked-data recap) |
| `Begin Pitch Preparation` (button) | §3.2 | FROZEN |
| `Pitch preparation is the focus of next week's session.` (caption, curly `'`) | §3.1 golden-path | FROZEN (DEMO-TELL deferred to F lockstep rewrite) |
| ~~`Next session`~~ (eyebrow next to CTA) | removed in E (demo tell, not asserted) | **REMOVED 2026-05-20** |

### Shell (AppHeader / ProgressSpine / GuidedControls / ComplianceRibbon)
| String | Source | Class |
|---|---|---|
| `Conductia` (Wordmark title) | D18 brand spelling | FROZEN |
| `Session progress` (ProgressSpine aria) | E rename from `Demo progress` (demo tell, not asserted) | **CHANGED 2026-05-20** |
| `Guided walkthrough controls` (GuidedControls container aria) | §3.2 | FROZEN (Phase F replaces controls with platform nav; aria goes with them) |
| `Next ▸` / `◂ Back` / `aria-label="Next stage"` / `aria-label="Previous stage"` | §3.2 | FROZEN until F (platform nav supersedes) |
| `Compliance monitoring active` / `Checking compliance…` / `Compliant` / `Blocked — not compliant` | §3.2 ribbon labels | FROZEN-em-dash (status descriptor on `Blocked — not compliant`) |

### Phase E summary
**Demo tells removed in E (non-asserted):** `aria-label="Demo progress"` → `Session progress`; `Next session` eyebrow removed from PitchCta.
**Demo tells deferred to F (asserted, removed when golden-path is rewritten to the platform model):** `Plan management is not part of this demo.` (paywall confirm); `Pitch preparation is the focus of next week's session.` (PitchCta caption); the `Begin Pitch Preparation` button label may also evolve.
**Em-dash policy verified:** all visible em-dashes that remain are sanctioned structural separators per §4 (ARIA labels, regulatory rule names, status descriptors, ranked-data recap, badge separators). No em-dashes survive in prose sentences. Off-voice prose that pre-existed has been rewritten in C/E (e.g., the Intent header).
**Persona / offering coverage:** every surface still reflects the MD-grade voice, the three headline claims (decisions-not-data-dumps, compliance omnipresent, MD-native), the sell-side pre-onboarded premise, and skill-access as the value metric. Anti-Rogo positioning surfaces in ColdOpen + Landscape.

---

## 10. Platform IA + User-profile model (Phase F-plan — appended 2026-05-20)

The structural reframe per D17. Conductia ceases to be a linear 6-stage slideshow and becomes a navigable desktop+mobile platform a managing director returns to repeatedly. Core functionality (the seam, scoring, compliance gate, skill execution, message routing) stays intact. What changes is the **shape**: real navigation replaces auto-advance, user profile becomes explicit, and the compliance instrument is repositioned from a blanket header to a polished chrome instrument.

### 10.1 Source-of-truth alignment (every IA decision below traces to /docs)

| Doc | Decision it drives |
|---|---|
| `personas-and-jobs.md §1` | The user IS the MD. The user-profile = MD identity + their company + their team + their pipeline (acquirers). |
| `personas-and-jobs.md §2` | The 5 sequential jobs become the 4 platform destinations (+1 deferred). |
| `product-principles.md §1` | Every destination must answer "what does the MD need to act," not "what would an analyst prep." |
| `product-principles.md §2` | Every destination's primary content is a decision surface (ranked, scored), not a data table. |
| `product-principles.md §3` | The compliance instrument is present on EVERY destination. It can be repositioned but never absent. |
| `product-principles.md §5` | No onboarding. The MD lands inside the platform with their mandate already loaded. |
| `strategy-and-moat.md §1` | The compliance instrument's repositioning must still read as "the moat, felt." Smaller in space, more refined in interaction. |
| `monetization-and-skills-economy.md` | Skills are the value metric. A "Skills" destination is first-class, not buried inside Acquirers. |

### 10.2 Top-level navigation (the new shell)

Four primary destinations + one deferred + a global command surface:

| # | Destination | Job-to-be-done it serves | Today's spine stage it absorbs |
|---|---|---|---|
| 1 | **Mandate** (home) | The MD's situational dashboard — current mandate, recent activity, compliance vitals, where to pick back up | NEW — absorbs ColdOpen's persona context (no longer a one-shot cinematic) + replaces Intent as a persistent surface |
| 2 | **Acquirers** | Jobs 1 + 2 + 3 — landscape, peers, drill-down | Landscape + DeepDive collapsed into list→detail navigation |
| 3 | **Team** | Job 4 — compliant communications | ComplianceTheatre (the entire team + composer system) |
| 4 | **Skills** | Surface the value-metric directly (skill access) | NEW — the skills catalogue as a first-class surface (currently only visible as a shelf inside DeepDive) |
| ~~5~~ | ~~Pitch Prep as a primary destination~~ | **DROPPED 2026-05-20 (Lance-authorised strategic call).** An empty destination violates `product-principles §1` (MD-need not analyst prep) and advertises absence — itself a demo tell. Pitch Prep instead surfaces as a single honest one-line editorial roadmap note on Mandate ("Pitch composition. Next on the roadmap."). When Job 5 ships, it earns a destination. Until then, the platform reflects what works. |

**Global command surface** (persistent, top of every screen): the Intent command bar, evolved. A one-line "State your intent." input → triggers the compliance boot interaction (same FINRA/MNPI/KYC cascade, same dispatch order, same reduced-motion contract) → result is contextual: searches, opens a new analysis, or jumps to the right destination. It is no longer a stage; it is an ever-present affordance.

**Cinematic entry — strategic decision 2026-05-20 (Lance-authorised):** the ColdOpen aesthetic is RETIRED from daily entry. The MD lands directly at Mandate; no splash, no one-tap entry ritual. Rationale: `product-principles §5` (pre-onboarded, no heavy entry rituals) + `personas-and-jobs §1` (time-constrained MD; daily ceremonies must be light). The Editorial Institutional gravitas lives in the chrome + Mandate's editorial composition itself (Fraunces wordmark, deep-warm Mandate hero band as accents) — not a separate cinematic act. The deep-cinematic register is preserved as a bookend at the OUTCOME end of the experience (Pitch Prep close stays in full cinematic register), so the spec's "dark = gravitas/arrival ↔ warm = focus/work" rhythm survives, anchored at the decision point rather than the daily entry. If real auth ever ships, a sign-in screen can carry the register; for the sandbox there is none.

### 10.3 User-profile model

Explicit identity + context that persists across visits:

```
User (MD)
├── Identity: { name: "Mike Cannon-Brookes", role: "Founder & MD", avatar }
├── Company: { name: "Atlassian", ticker, headcount, … }   ← from getSeller()
├── Mandate: { type: "sell-side", opened: <date>, … }       ← the active deal
├── Team: [ MD, CFO, M&A Advisor ]                          ← from getTeam()
├── Pipeline: { acquirers: [...], shortlisted: [...] }       ← from getAcquirers()
└── Recent activity: [ panels saved, messages sent, last surface visited ]
```

For the sandbox this comes from the existing seam (`getApi().getSeller/getTeam/getAcquirers`). No new API surface. The "profile" is a derived view over the fixtures the seam already returns. A profile menu in the chrome (avatar + name) reveals the identity panel + sign-out (inert in sandbox).

### 10.4 The compliance instrument, repositioned

Today: a full-width header ribbon stretching the viewport, with the cascade as a visible band.

Tomorrow: a compact **status crystal** in the top-right of the chrome — a small live indicator that conveys the four states (idle / scanning / clear / blocked) at a glance, expandable on hover/tap to reveal the FINRA/MNPI/KYC indicators and the active monitor narrative. Dimensions: ~40px collapsed, a focused popover when expanded.

**Critically — the contract is preserved exactly:**
- One `[data-compliance-status]` (now on the crystal element), still `role="status"`, still `aria-live="polite"`, still `aria-label="Compliance status: ${label}"`, still the four state values, still the verbatim labels.
- The Compliance-Pulse / SCAN_SWEEP / RESOLVE_S motion constants stay frozen (`ledger §3.3`).
- The mounting rule stays: exactly one instance, in the shell.

**In-use / data-flow interaction** (the "refined" part): when a skill runs or a message sends, a fine luminous stream visually travels from the originating action (the canvas, the composer) toward the crystal — terminating at the indicator that ticks green or red. This is the design-spec §1 motion principle "compliance is the architecture, felt" made literal, and replaces today's full-bleed scanning bar.

### 10.5 Auto-advance removal (resolves §R at source)

The Intent component's reduced-motion `setTimeout(0)` clear+NEXT dispatch — the cause of the §R golden-path race — is **eliminated**. After the compliance boot completes the user explicitly navigates (or the global command bar resolves the intent to a destination). The store's `NEXT`/`BACK` actions become obsolete on the user-facing path and are either removed or kept for back-compat with no UI binding. GuidedControls is removed (the `?present=1` presenter mode is also retired in the platform model). Real platform navigation (clicking a destination in the nav, clicking an acquirer card, etc.) replaces them.

This single change eliminates the auto-unmount race that has been failing golden-path ~80% — the source of the dispositioned §R flake.

### 10.6 Test-suite rewrite (lockstep with F-exec, logged)

`tests/golden-path.test.tsx` is rewritten in lockstep to the platform model:
- Login/landing on Mandate (assert dashboard surfaces with mandate context).
- Type intent in the persistent command bar → compliance boot completes → result resolves (assert FINRA/MNPI/KYC reveal + compliance clear; no auto-advance to assert).
- Click "Acquirers" nav → landscape view → assert Anthropic 87 / Salesforce 67 cards → click Anthropic.
- Drill into DeepDive workspace (now a route, not a stage transition) → drop Acquirer Fit skill → assert composite breakdown panel + 87.
- Drop Synergy & Deal-Structuring Engine → paywall dialog (contract preserved) → close.
- Click "Team" nav → composer → clean message (assert delivered) → risky message (assert blocked alert with FINRA reason).
- Click "Pitch Prep" nav → deferred destination state.

Every per-component test (`compliance-ribbon`, `intent`, `canvas`, `score-dial`, `skill-shelf`, `paywall-lock`, `message-composer`, `pitch-cta`, `panels`, `acquirer-card`, `landscape`, `cold-open`) stays intact except where the component's surrounding surface changes (e.g., GuidedControls test removed; Intent no longer asserts auto-NEXT; ColdOpen becomes a sign-in component or is retired). All deltas logged to the change log + decision-log + this section, byte-by-byte. **No assertion weakening.** Where a behavior changes, the test changes to assert the new behavior, with the rationale recorded.

### 10.7 Mobile architecture (≤375 / 768 perfected first)

- **Top chrome**: compact wordmark + the compliance crystal (collapsed) + a profile button.
- **Persistent command bar**: full-width at the top of every destination on mobile.
- **Bottom nav**: 4 icons + labels — Mandate / Acquirers / Team / Skills. Pitch Prep accessible from Mandate (deferred destination doesn't earn a primary slot).
- **Destination details** (e.g. Acquirer drill-down): full-screen with a back affordance.
- **Canvas on mobile**: skill shelf → top horizontal scroll-row; drop-target = the canvas card with the existing "add to canvas" tap path (already partially implemented in DeepDive; keep).
- **Compliance crystal expansion**: bottom-sheet on mobile, popover on desktop.

### 10.8 Visual language (inherits §1–6 of this spec, sharpened by destination)

- **Mandate**: warm working surface; editorial dashboard layout — eyebrow + Fraunces display + dense-but-elegant tiles (active mandate, recent activity, compliance vitals, command bar).
- **Acquirers**: warm working surface; ranked decision board (hero card #1 + dense league table) → DeepDive opens as a dark-canvas workspace overlay or full-screen route.
- **Team**: warm working surface; team roster as elegant rows + composer as instrument.
- **Skills**: warm working surface; the catalogue as editorial cards, the premium one a designed monetization moment (not just a lock glyph).
- **Pitch Prep**: dark cinematic register (echoing the close); honest "next session" state.
- **Cinematic entry** (sign-in): the existing ColdOpen aesthetic preserved.

### 10.9 File-disjoint parallel execution units for F-exec

The execution is structured as 4 parallel batches + 1 sequential integration (each batch is file-disjoint from the others; the conductor integrates + commits per D21):

**F1 — Shell + navigation + user profile** (sequential, blocking C1's surface migrations)
- `src/components/shell/AppNav.tsx` (NEW — top + bottom nav with 4 destinations)
- `src/components/shell/AppHeader.tsx` (modify — wordmark + compliance crystal + profile)
- `src/components/shell/ComplianceCrystal.tsx` (NEW — replaces ComplianceRibbon visually; preserves contract)
- `src/components/shell/CommandBar.tsx` (NEW — persistent intent command bar)
- `src/components/profile/ProfileMenu.tsx` (NEW)
- `src/lib/session/store.ts` — *DO NOT TOUCH the seam*; if a `route` field is needed, use a separate `useRoute()` hook outside the seam
- App router: `src/app/(platform)/layout.tsx`, `src/app/(platform)/page.tsx` (Mandate home), and 4 destination routes (`/acquirers`, `/acquirers/[id]`, `/team`, `/skills`, `/pitch-prep`) using Next 16 App Router.
- ComplianceRibbon retained as a deprecated alias until F2 lands, then removed.

**F2 — Acquirers + DeepDive route migration** (parallel-safe vs F3/F4)
- `src/app/(platform)/acquirers/page.tsx` (the Landscape view, now a route)
- `src/app/(platform)/acquirers/[id]/page.tsx` (DeepDive as a route)
- Migrate `Landscape.tsx` → page-level component (renames stage→view; logic preserved)
- Migrate `DeepDive.tsx` → page-level component
- Canvas + skills shelf + panels + paywall: stay byte-identical, consumed by the new route

**F3 — Team route migration** (parallel-safe vs F2/F4)
- `src/app/(platform)/team/page.tsx` (ComplianceTheatre as a route)
- Migrate `ComplianceTheatre.tsx` → page-level component
- TeamDrawer / MessageComposer: byte-identical, consumed by the new route

**F4 — Skills + Mandate destinations** (parallel-safe vs F2/F3)
- `src/app/(platform)/skills/page.tsx` (NEW Skills catalogue surface)
- `src/app/(platform)/page.tsx` (Mandate home, including the one-line "Pitch composition. Next on the roadmap." editorial note)
- Reuse SkillCard / SkillShelf primitives
- *(Pitch Prep route DROPPED per the 2026-05-20 strategic decision above. The PitchCta component is retired in F5 alongside the golden-path rewrite; its asserted demo-tell strings stop being asserted.)*

**F5 — Integration + golden-path lockstep rewrite** (sequential, after F1–F4)
- Rewire `app/layout.tsx` / `app/page.tsx` to the new platform layout
- Retire GuidedControls + `?present=1` mode
- Remove Intent's reduced-motion auto-NEXT; CommandBar resolves intent explicitly
- Rewrite `tests/golden-path.test.tsx` to the platform navigation flow (logged byte-by-byte)
- Update affected per-component tests in lockstep
- Verify objective gates

### 10.10 What stays absolutely intact

- The seam (`src/lib/**`, `_shared/motion.ts`, `_shared/resolveAcquirerId.ts`) — verified `+0/−0` at every F gate.
- Every motion timing constant (ledger §3.3).
- Every per-component asserted contract (ledger §3.2) — the ribbon contract migrates byte-identically to the crystal; the composer/canvas/paywall/dial/etc. internal contracts are unchanged.
- The compliance dispatch ORDER and reduced-motion contract (ledger §3.5) — same code paths, just no auto-NEXT at the end of Intent's boot.
- Brand voice + copy fidelity (E §9 matrix) — strings carry forward; demo-tell strings asserted in golden-path get rewritten only in the lockstep test+component edit, logged.

### 10.11 Definition of done for F

All objective gates green (vitest double-run, **golden-path passing under the platform model** — the rewrite is the fix, not a mask; tsc 0, eslint 0, `next build` static-clean, seam +0/−0); visual/responsive QA at ≤375/768/1280/1920; copy-fidelity matrix updated for any string deltas; every test delta logged; the platform reads as a real, navigable, repeatedly-usable application a managing director would use — no demo tells, no auto-advance, no slideshow feel.

**Lance checkpoint**: this IA is the major flow rewrite. Before F-exec dispatches parallel implementers, surface this spec for sign-off (no Critical/structural changes to the IA without it). Phase G follows for final brand/colour/legibility validation + the favicon mark decision.
