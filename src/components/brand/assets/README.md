# Conductia logo — L1 "The Conduit" (canonical) + L6 "Signal" variant
Decision (owner, 2026-08-27): L1 all-ink is the CANONICAL mark. L6 (violet dot) is a sanctioned VARIANT only — violet = Casey, so use L6 solely in Casey/AI-forward contexts (marketing accents, AI feature surfaces) and NEVER adjacent to live Casey controls (send button, AI chips) where the dot would read as interactive.

All files are transparent-background SVG, stroke-based, scale to any size.

| File | Use |
|---|---|
| conductia-mark-ink.svg | Canonical mark on light surfaces. Replaces the mark in src/components/brand/Wordmark.tsx |
| conductia-mark-white.svg | Reversed, on ink/dark surfaces (auth panel, dark chrome) |
| conductia-mark-signal.svg | L6 variant, light surfaces, Casey/marketing contexts only |
| conductia-mark-signal-on-dark.svg | L6 reversed (dot lightened to #8B89F0 for contrast on ink) |
| conductia-favicon.svg | Favicon / ≤20px sizes (heavier stroke + larger dot for legibility) |
| conductia-favicon-signal.svg | L6 favicon, only if the product ships AI-forward branding |
| conductia-app-icon.svg | App icon / avatar contexts: ink rounded square, white mark |
| conductia-app-icon-signal.svg | L6 app icon |
| conductia-lockup-ink.svg | Mark + wordmark. Text uses Inter via font-family (loaded in product); for contexts without Inter, compose lockup in HTML per Wordmark.tsx |
| conductia-lockup-signal.svg | L6 lockup |
| conductia-lockup-white.svg | Reversed lockup |

Rules (from brand-spirit.md §7): single-color ink discipline; no gradients/bevels/motion; clearspace = the dot's diameter on all sides; minimum size 16px; never recolor beyond ink/white/Casey-violet. Wordmark: Inter 650, -0.02em; serif (Georgia) letterhead contexts compose type separately.
Placement map: Wordmark.tsx (brand mark) · favicon link tag · top-nav brand block (v12 .brandc → replace letter C with mark) · auth card header · document stamps/exports.
