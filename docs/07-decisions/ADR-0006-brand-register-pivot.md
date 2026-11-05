# ADR-0006 — Brand register pivot from Editorial Institutional to IB-terminal

- **Status:** Accepted; **superseded by D48** (the Workbench register, 2026-08-27), which replaced this navy pivot on colour, elevation and label case.
- **Date:** 2026-05-20
- **Deciders:** Martin Casado (proposer + implementer; Lance acknowledgement pending — this ADR is documented in advance of any merge to `main`).
- **Source:** `docs/archive/VISUAL-REVIEW.md` (subagent critical review, 2026-05-20); user feedback on 2026-05-20 ("siguen los mismos errores de padding, look and feel blogger de los 2000"); persistent memory entry `feedback-visual-register`.

## Context

The product's prior visual register was **Editorial Institutional** (D13, 2026-05-19), executed across Lance's front-end overhaul Phase A–G. Headline tokens:

- Warm cream page background (`--surface-warm: #f5f2eb`).
- Fraunces serif display headings as the dominant register; the `display-1` and `display-hero` utility classes used Fraunces by default.
- 15px body type, line-height 1.55.
- Section rhythm at 48px gaps (`gap-[var(--space-12)] py-[var(--space-12)]`).
- 24px Card padding (`p-[var(--space-6)]`).
- Spec language (`docs/04-brand/visual-language.md` line 102): "Layout: airy — generous whitespace between sections, not compact."

On 2026-05-20, after the sandbox merge landed seven phases of functional work (B–G), Martin ran the app visually and reported that the register reads as a mid-2000s blog, not as an institutional intelligence terminal. A structured critical visual review (`docs/archive/VISUAL-REVIEW.md`) confirmed the diagnosis:

1. **The spacing ladder was literally broken** — `--space-5`, `--space-7`, `--space-10`, `--space-11` were referenced 24+ times across the codebase but never defined; they resolved to `unset`/0 at runtime, producing random padding collapses the user perceived as "inconsistency."
2. **The type rhythm is editorial, not instrumental.** Fraunces serif display + 15px body + 48px section gaps = magazine longread. Bloomberg, Linear, Rogo use sans display + 11–13px body + 16–20px gaps.
3. **Density is ~3× the sandbox.** Page rhythm 48px vs sandbox 18–20px; Card padding 24px vs sandbox 18px. The "airy" spec call-out is being executed faithfully and produces the visible blog feel.
4. **The brand spec itself names the conflict.** Editorial Institutional commits to warm cream + serif display + airy spacing. Those tokens cannot reach the IB-terminal register the persona expects, regardless of execution polish.

The verdict in the review: "The brand should be IB-terminal first, editorial second."

## Decision

Pivot the brand register from **Editorial Institutional** to **IB-terminal with two editorial moments**. Keep the brand voice rules ("Precise, senior, decisive. Anti-data-dump." — `brand-foundations.md §Voice`). Keep the four-destination platform IA (D17 / ADR-0004). Keep every line of functional work from sandbox-merge Phases B–G.

Replace the surface palette, type scale, and density rhythm:

- **Palette.** Page background pivots from `#f5f2eb` (warm cream) to `#F4F5F8` (cool gray). `--ink` from `#151515` to `#0E1B3A` (navy). `--accent` from `#0099ff` (azure) to `#1A8F8F` (teal). `--canvas-bg` from `#0f2822` (deep forest) to `#0E1B3A` (navy). Positive / negative / stroke values shift to match the cool-gray surround.
- **Type.** Body 15px → 13px. `--text-base`, `--text-xs`, the entire ramp tightens. `--text-xxs: 10px` added for eyebrow / kicker micro-labels.
- **Display register.** `.display-1` and `.display-hero` switch from Fraunces serif to Inter sans-serif weight 600 — Fraunces is no longer the default display face. Two new utility classes introduced: `.editorial-name` (mandate seller name + acquirer rail name) and `.editorial-question` (open-question aside). Fraunces is **reserved to these two named utilities application-wide.**
- **Density.** Page rhythm `gap/py 48px` → `gap/py 24px` (`--space-12` → `--space-6`) across all four routes. Card primitive default padding `24px` → `20px` (`--space-6` → `--space-5`), with a new `density="compact"` variant at `16px` for dense list rows.
- **Spacing ladder.** The missing rungs `--space-5: 20px`, `--space-7: 28px`, `--space-10: 40px`, `--space-11: 44px` are added (fix for the silent-zero bug above).

The token *names* are byte-stable — every existing `var(--ink)`, `var(--surface-warm)`, `bg-[color-mix(in_srgb,var(--positive)_X%,transparent)]` call site keeps working. Only the values change.

## Alternatives considered

- **Option A — execution polish within the current spec.** Fix the spacing-ladder bug and tighten gaps + Card padding without touching the warm-cream palette or the Fraunces display register. Half-measure. Solves part of #1 and #3, leaves #2 and #4 untouched. The user would be 30% happier and still call it blog-ish. **Rejected.**
- **Option C — full pivot to the sandbox's exact register.** Adopt `intelibank-sandbox/app/globals.css` 1:1; retire the existing Card / Pill / Badge primitives in favor of the sandbox's utility-class chrome. Maximum density, maximum IB-grade — but breaks the entire seam between "structure" and "skin" that A's primitives provide, retires the editorial moment entirely, and over-rotates onto the sandbox (we already have the sandbox if we wanted the sandbox literally). **Rejected — over-rotation; loses the option to keep any editorial register.**
- **Option B — partial pivot (this ADR).** Keep the primitives and the voice. Drop warm-cream + serif default + airy rhythm. Reserve Fraunces to two named moments. Adopt sandbox-grade density. **Selected.**

## Consequences

- **D13 is reversed.** "Editorial Institutional aesthetic" is no longer the brand register. Voice rules survive; visual register pivots.
- **D11 is partially superseded.** D11 said the design language was "rogo-derived". The visual review found that the rogo-derivation was nominal (it borrowed Rogo's color names but invented an editorial register on top of them). The new register is more faithful to what Rogo actually IS now (cool slate + sans-serif terminal) and to Bloomberg / Linear / Rogo's actual aesthetic.
- **D14 stays.** The Fraunces / Inter / Geist Mono trio remains the type stack. Fraunces is no longer the *default* display face but it is the canonical face for the two editorial moments. The font is not retired.
- `docs/04-brand/visual-language.md` is rewritten in Phase G2.5 to describe the IB-terminal register. The prior file becomes historical record; the rewrite is in lockstep with this ADR.
- `docs/04-brand/brand-foundations.md` is unchanged — voice rules survive intact.
- All sandbox-merge phases B through G survive intact. The pulse-dot, italic Fraunces moment, sticky right-rail, screening overlay, compliance engine, scoring sliders, analytical panels, route handler, Skill.panel refactor — all keep working under the new tokens.
- Test suite is unaffected (verified — 19 files / 114 passed / 1 skipped before and after the pivot). Tests assert behavior + structure, not pixels.
- AppHeader's translucent warm-cream-92% backdrop is now a translucent cool-gray-92% backdrop. Same visual purpose; cooler register.
- The Open-question aside's left hairline rebinds from `--positive-deep` to `--accent` (teal); background changes from `--surface-warm` (was warm cream) to `--surface` (white) so it stands out against the cool-gray page background.
- D24 / ADR-0004 (platform vs. single-surface) is unaffected.
- ADR-0005 (sandbox merge disposition) gets a new line: "Phase G2 — brand register pivot per ADR-0006" added to the kept-from-A inventory.

## Open question (flagged for Lance acknowledgement)

This ADR is authored by Martin on the feature branch `merge/sandbox-2026-05-21`. The Editorial Institutional decision (D13) was authored by Lance. Nothing is on `main` yet; the pivot is local to the feature branch. **Before any merge to `main`, Lance reviews this ADR + the sandbox-merge ledger entry for Phase G2 + a visual diff of the four destinations.** If Lance disagrees with the pivot, the resolution is to either revert Phase G2 (the pivot is one cohesive layer that can be cleanly reverted) or refine the spec further by negotiation. The feature branch is the conversation surface; `main` stays untouched.

## Correction (Phase G3, 2026-05-20)

After Phase G2 landed, Martin reviewed the merge branch visually and supplied a brand logo that arrived as a letterhead: deep navy background with a Trajan-style serif **"CONDUCTIA"** in **gold/champagne**, plus a classical-column "I" mark and the tagline *"The AI operating system for investment banking"* in gold tracked caps. The logo encodes the actual brand: **navy + gold + classical serif**, closer to private-bank gravitas than Bloomberg-terminal density.

Phase G2's selection of `--accent: #1A8F8F` (teal) was an over-rotation toward Bloomberg/Linear. The brand-accurate accent is **gold** — `--accent: #C29445` (sampled approximately from the logo). Phase G3 corrects the accent and pushes the navy deeper (`--canvas-bg: #0A1228`) so the chrome reads as the deep-navy of the logo rather than the lighter navy I picked in G2.

Concretely, Phase G3 lands:

- `--accent` `#1A8F8F` (teal) → `#C29445` (gold).
- `--accent-dark` `#0E5757` → `#9A7530` (hover/pressed gold).
- `--canvas-bg` `#0E1B3A` → `#0A1228` (deeper navy, matches the logo bg).
- `AppHeader` chrome flipped to navy translucent (`bg-[color-mix(in_srgb,var(--canvas-bg)_94%,transparent)]`). Tone attribute `data-shell-tone="dark"`; text colors switch to `--ink-on-dark`. The Wordmark fill rebinds from `--ink` (navy on navy = invisible) to `--accent` (gold) — matches the logo treatment.
- `AppNav` inline variant gains a `tone` prop with `on-dark` toggling text to `--ink-on-dark` / `--ink-on-dark-secondary` so the desktop nav remains readable on the navy chrome.
- `ProfileMenu` switches to `tone="on-dark"`.
- `CommandBar` Run button gains an arrow glyph (`Run →`) and switches its background from `--ink` to `--accent` so the primary CTA reads as the brand gold against the cool-gray page surface. `MessageComposer` Send button gains the matching `Send →` arrow.
- `CommandBar` placeholder copy clarified: `"State your intent."` → `"Ask anything. Compliance screens first."` Plus a small honest meta line below the input — *"Compliance screens every intent. AI answers wire up next."* — to remove the previous confusion ("what does this surface actually do?"). The compliance boot animation is real; the AI response leg is not wired yet.

The token names stay byte-stable from Phase G2; only the values change in the palette block. Voice rules, two editorial Fraunces moments, the 13px body, the spacing-ladder fix, the four-destination IA — all preserved.

Net effect: the brand now reads navy-and-gold (matches the logo), the chrome has visible navy presence (was "too white"), the primary CTAs read as gold accent calls (not monochromatic navy buttons), and the CommandBar copy is honest about its current state.
