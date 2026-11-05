> **SUPERSEDED 2026-08-27 by the Workbench register.** The IB-terminal
> navy language below is retired. The design system of record is
> `docs/design/workbench/` (HANDOVER.md, Workbench Kit, brand-spirit.md,
> tokens.css): warm neutrals, ink #191919 accent, Casey violet #5E5CE6
> only for the AI actor, solid pastel status fills, Georgia serif for
> deal identity + source excerpts only. This file is kept as history.

# Visual Language — Conductia

> **Updated 2026-05-20 by ADR-0006 — IB-terminal pivot.** This file documents the *current* visual language. The prior "Editorial Institutional" register (warm cream + Fraunces serif display + airy 48px section rhythm) is retired; the current register is **IB-terminal with two editorial moments** — cool gray + navy + teal + Inter sans display + 13px body + 18-24px section rhythm, with Fraunces serif reserved to two named utility classes (`.editorial-name` and `.editorial-question`) only.
>
> The shift was driven by user feedback that the prior register read as a mid-2000s editorial blog rather than as an institutional intelligence terminal. The pivot keeps every existing component, every test, every line of voice copy, and the four-destination IA — only the surface tokens and the display register change. Token *names* are byte-stable; only their *values* pivot. See `docs/archive/VISUAL-REVIEW.md` for the structured review that drove the call and `docs/07-decisions/ADR-0006-brand-register-pivot.md` for the formal record.

Conductia's visual language is **IB-terminal first, editorial second**. Bloomberg / Linear / Rogo are the reference register: cool surfaces, dense rhythm, sans-serif display, mono-numeric data values, restrained use of any italic-serif accent. The two editorial moments (mandate seller name; the open-question aside on Mandate) carry the brand's senior-decisive voice without imposing a magazine register on the rest of the product.

Source: decision-log D11 (rogo-derived in spirit, though the IB-terminal pivot in D26 is closer to what Rogo actually IS today); D14 (Fraunces / Inter / Geist Mono trio — preserved); D26 (the IB-terminal pivot itself); design spec §11; ADR-0006.

---

## Colour tokens (IB-terminal, post-ADR-0006)

The token *names* match the pre-pivot block byte-for-byte so every existing `var(--surface-warm)` / `var(--ink)` / `var(--accent)` call site keeps working. Only the *values* changed. The page background is now the cool gray `--surface-warm: #F4F5F8` (was `#f5f2eb` warm cream); ink, accent, and canvas-bg all moved to the navy-teal cool-gray register.

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#0E1B3A` | Navy as ink — primary text, heavy UI elements |
| `--ink-secondary` | `#4F5B70` | Secondary text, captions, muted labels |
| `--ink-tertiary` | `#8B95AC` | Placeholder, disabled text, soft eyebrow |
| `--surface` | `#FFFFFF` | Primary white surface — Card default, editorial-aside background |
| `--surface-subtle` | `#ECEEF2` | Cool gray subtle surface — sub-panels, inputs |
| `--surface-warm` | `#F4F5F8` | Page background (the cool register; "warm" is now a legacy name) |
| `--surface-dark` | `#0E1B3A` | Navy inverse panels |
| `--stroke` | `#DDE0E7` | Cool gray hairline rule |
| `--accent` | `#1A8F8F` | Teal — interactive accent, focus rings, editorial-aside hairline |
| `--accent-dark` | `#0E5757` | Teal pressed / darker variant |
| `--positive` | `#2D7E54` | Compliance clear, success states |
| `--positive-deep` | `#1B4D33` | Deep green, compliance brand anchor — used by the pulse-dot heartbeat |
| `--negative` | `#D14B30` | Compliance blocked, error states |
| `--canvas-bg` | `#0E1B3A` | Navy canvas / hero backdrop (was deep forest pre-D26) |

**Observation note:** `#0099ff` (accent blue) appeared 26 times in the
extracted source as `rgb(0, 153, 255)`. `#19a26c` appeared as the primary green
action color. `#d94636` appeared as the sole red token. The warm cream
`#f5f2eb` and near-black `#151515` are the dominant background and text
anchors. The dark surface token `#1c1c1c` (`--token-907a89d9`) confirms a
dark-panel treatment used alongside the white primary surface.

---

## Typography

Extracted from rogo.ai `@font-face` declarations (framerusercontent.com CDN,
2026-05-19).

**Primary typeface family:** BR Sonoma (Regular 400, Medium 500, SemiBold 600)

- Body text, UI labels, navigation, CTA copy.
- Weights available: 400 / 500 / 600, plus italic variants for 500 and 600.

**Display / editorial typeface:** ABC Arizona Mix / ABC Arizona Flare (Regular 400, Light 300)

- Used for hero headings and editorial moments.
- Sets the premium, editorial register.

**Mono typeface options:** Fragment Mono, Rooftop Mono (Regular 400, Medium 500)

- Data tables, compliance output, code-adjacent surfaces.
- Fragment Mono is the primary mono; Rooftop Mono is the secondary.

**Fallback stack (Conductia implementation):**

```css
--font-sans: "BR Sonoma", "Inter", system-ui, sans-serif;
--font-display: "ABC Arizona Mix", "ABC Arizona Flare", serif;
--font-mono: "Fragment Mono", "Rooftop Mono", ui-monospace, monospace;
```

**Licensing note [assumption]:** BR Sonoma, ABC Arizona, and the Rooftop family
are commercial typefaces. Conductia must license them independently from
Klim / ABC Dinamo / respective foundries, or substitute with open-source
equivalents (e.g., Geist Sans for body, Fraunces for display, Geist Mono for
mono) before public launch. The token names above are stable regardless of
which fonts fill them.

---

## Type scale

Inferred from rogo.ai's layout density and standard financial-product conventions.
No explicit `font-size` token names were extractable from the raw HTML without the
full Framer CSS bundle; these are reasonable starting values.

| Token | Size | Usage |
|---|---|---|
| `--text-xs` | 11px | Fine print, legal labels |
| `--text-sm` | 13px | Table data, secondary captions |
| `--text-base` | 15px | Body, UI labels |
| `--text-md` | 17px | Section intros |
| `--text-lg` | 21px | Sub-headings |
| `--text-xl` | 28px | Screen headings |
| `--text-2xl` | 40px | Hero / display text |

---

## Spacing and density

- **Layout:** airy — generous whitespace between sections, not compact.
- **Component density:** medium-dense within panels (financial tables, score
  cards), wide between top-level surfaces.
- **Base unit:** 4px grid (standard; inferred from Framer/Tailwind convention).

---

## Component feel

- **Border radius:** subtle rounded — cards and panels use ~6–8px, buttons ~6px,
  input fields ~4–6px. No sharp square, no pill-shaped buttons in primary UI.
  **[Inferred: not directly extractable from source without full CSS bundle.]**
- **Buttons:** solid-filled primary (dark ink on white or white on accent);
  ghost text-style for secondary navigation. No outlined style as primary CTA.
- **Cards:** light shadow or stroke (`--stroke`) separation, not heavy elevation.
- **Panels:** dark-surface (`--canvas-bg` / `--surface-dark`) for the hero canvas;
  white surface for surrounding chrome.

---

## Evolution note

These tokens are a versioned starting point, not a permanent dependency on
rogo.ai's choices. When Conductia develops its own design identity — brand
photo style, illustration, iconography — this file is the place to capture the
delta. The token names (`--ink`, `--surface`, `--accent`, `--positive`,
`--negative`) are stable; the hex values behind them are evolvable.

Source: decision-log D11; design spec §11; rogo.ai (extracted 2026-05-19)
