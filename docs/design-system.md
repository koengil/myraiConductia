# Conductia Design System — Rogo-faithful (navy accent)

> **Superseded on colour, elevation and label case by D48 (the Workbench register).** The navy accent, elevation ramp and uppercase micro-caps below are history; `docs/design/workbench/HANDOVER.md` and the `[data-palette='workbench']` block in `src/app/globals.css` are current. The structural rules here — 44px touch targets, 2px focus rings, contrast contract — still hold. Typography is superseded too: Fraunces was dropped (D48); the display serif is Georgia via `--font-display`, for deal identity and source excerpts only.

**Directive (Lance, 2026-07-09):** the entire UI/UX must be a faithful reproduction of Rogo's actual interface (from `docs/06-research/hv-extraction/digests/rogo-ui-findings.md` + `rogo-skills-inventory.md` + the webarchive), with Conductia deal-phase content. One deviation from Rogo: the single accent is **our navy `#163561`**, not Rogo's forest green. Everything else — layout, fonts, component grammar, spacing, density — mirrors Rogo.

## Color (light — the default and primary experience)

| Token | Value | Role (from Rogo CSS) |
|---|---|---|
| `--rogo-canvas` | `#FCFDFB` | app canvas (warm off-white) |
| `--rogo-panel` | `#F9F9F7` | raised panel |
| `--rogo-panel-2` | `#F2F2F1` | deeper panel / hover |
| `--rogo-panel-3` | `#EAE9E7` | tertiary fill |
| `--rogo-hair` | `#EAE9E7` | hairline dividers/borders |
| `--rogo-ink` | `#151312` | primary text |
| `--rogo-ink-2` | `#34312E` | secondary text |
| `--rogo-muted` | `#655E59` | muted/labels |
| `--rogo-placeholder` | `#97918D` | input placeholder |
| `--rogo-tooltip` | `#1F1C1B` | dark tooltip bg |
| `--rogo-accent` | `#163561` | **navy** — replaces Rogo forest green `#134a34`. Primary buttons, toggles ON, selection borders (2px), links, focus rings, citation/range chips. The ONLY accent. |
| `--rogo-accent-hover` | `#0F2647` | accent hover/pressed |
| `--rogo-accent-soft` | `#E9EEF6` | selection wash (active nav row, chips) |
| `--rogo-accent-contrast` | `#FFFFFF` | text on accent fill |
| `--rogo-danger` | `#B8432B` | destructive menu rows only |
| `--rogo-positive` | `#2D7E54` | compliance-clear / done |

Dark mode (Rogo "warm near-black, low-light"): canvas `#171514`, panel `#1F1C1B`, hair `#2E2A28`, ink `#ECE9E6`, muted `#A39D97`, accent marks `#8FB2DE`, accent fill `#1B3A66`. Light is default.

## Typography (Rogo split)

- **UI / body:** Inter (loaded via next/font). Sizes: base **12px/18**, secondary **10.5px/15**, micro-label **9px/12** (uppercase, tracked). This small-but-airy density IS the Rogo feel.
- **Serif display:** Fraunces (already loaded; stands in for Rogo's "Martina Plantijn"). Greetings, page titles, feature/section headings only. Sizes: hero **22.5px**, title **18px**, section H2 **15px**, H3 **13.5px**. Never in controls.
- **Mono:** Geist Mono for figures/receipts/tabular data.

## Radii & elevation

- Cards/popovers/composer: **12–16px**. Buttons/inputs: **8px**. Filter chips / quick actions: **full pill**. Toggles: iOS-style switch.
- Elevation is minimal: **hairlines everywhere**, a single soft shadow only on popovers/modals/the composer. No glows, no gradients, no neon. (This is the hard break from the current app.)
- Faint graph-paper grid texture behind home/composer surfaces (barely-visible hairlines, ~22px grid), light and dark.

## Layout / component grammar (mirror Rogo exactly)

- **Left rail ~270px, fixed**, warm panel bg, hairline right border. Order: brand + collapse (⌘B) → **New** primary button → nav list (Home, Search, Deals, Skills, Library, Scheduled) → **Pinned** → **Deals** (was Projects) → **History** (typed-icon artifact stream) → What's new / Help → avatar + name block. Collapsible.
- **Home = empty-state hero:** centered serif greeting + one large rounded composer card; controls INSIDE the card footer (attach + source-scope left; model-tier picker + submit-arrow right); quick-action pills below. Faint grid behind.
- **Model picker** (the "models"): plain-language tiers with one-line descriptors + checkmark on active + "More models ›" escape. Task-shaped naming (Instant / Fast / Pro / Deep Research) preferred for the MD; hide raw vendor models.
- **Source tray** (the "sources"): category tray — External Sources (master toggle) / Internal Sources (Add) / Broker Research — cascading to a searchable per-source toggle list with logos. Internal vs external structurally segregated. For Conductia: internal = deal room / VDR / firm docs; external = filings / market data — internal gated behind compliance.
- **Skills library:** All/Organization filter pills + search + grid/list toggle; cards = icon tile + bold name + 2-line muted description + attribution + state chip; hairline-separated 2-col grid. Detail = title + master state, metadata row, Instructions/References tabs, Run/Share actions.
- **Chat = document, not widget:** assistant answer is a single ~900px serif/prose column, real headings, bold-led bullets, NO bubble chrome; only the user message gets a light-gray right-aligned bubble. "Worked for Ns ›" / "N steps completed ›" receipts. Right-hand "N Sources" panel appears only when cited.
- **Tables:** quiet hairline grid, tall rows, cell selection = 2px accent border; skeleton cells with a pulsing accent dot.

## Conductia content mapping

- Sidebar "Deals" = the deal portfolio; a deal opens to its **Home** (deal greeting + composer scoped to the deal) with the **Rail** (5 phases / 65 steps) as the primary deal surface.
- Composer model/source pickers are real controls on deal surfaces.
- Skills library = the 65 step-skills grouped by phase, Rogo card grammar, approval states (Proposed/Approved/Active).
- Receipts grammar carries compliance: "Screened · KYC ✓ FINRA ✓ MNPI ✓ · 12s ›".

## Accessibility

Navy `#163561` on white = 12.2:1 (AA+). White on navy passes. Ink on canvas passes. 44px touch targets, visible focus rings (2px navy), `prefers-reduced-motion` honored, semantic HTML, keyboard-reachable.
