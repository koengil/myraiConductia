# Workbench — the Conductia design system of record

Start here when building ANY component, screen, or visual change.

1. **`HANDOVER.md`** — the contract: register, tier rules, invariants, §4b decisions.
2. **`Workbench Kit.dc.html`** — visual source of truth (12 sections, 37 components). Open in a browser.
3. **`Conductia Workbench.html`** — behavioral + layout source of truth (interactive prototype).
4. **`brand-spirit.md`** — vision, metaphor system (Conductor/Rails/Stations/Casey/Receipts/Perimeter), voice, logo rules.
5. **`components-map.md`** — component → kit section → repo file map.
6. **`tokens.css`** — the Tier-1 payload (live in `src/app/globals.css` under `[data-palette='workbench']`).
7. **`ICON-GUIDE.md`** — lucide-react glyph set, sizes 16/18/20 (14 allowed in dense contexts), strokeWidth 1.75.

Logos: `src/components/brand/assets/` (L1 Conduit canonical; see its README for placement rules).
Atom showcase / living proof page: `/dev-primitives`.

Hard rules for new work: warm neutrals + ink `#191919` accent; violet `var(--ai)` ONLY on Casey/AI-actor surfaces; solid pastel status fills (`--*-fill` + `--*-deep` text); Georgia serif (`--font-display`, `.deal-identity`) ONLY for deal identity + source excerpts; hairlines over shadows (`--shadow-ambient` only on floating surfaces); sentence case, no caps headers; WCAG AA floor, 2px ink focus rings, 44px targets; write `text-[length:var(--text-…)]` never `text-[var(--text-…)]` (a ratchet test enforces this; the ellipsis stands for any step of the type scale, written out in real code).
