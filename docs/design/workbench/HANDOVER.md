# CONDUCTIA — WORKBENCH UI/UX HANDOVER (CRITICAL)
Date: 2026-08-27 · From: design (Claude Design) · To: Claude Code
Mission: replace the current Conductia UI register end to end with the Workbench system — every token, component, font, icon, screen — WITHOUT touching logic, data flow, architecture, or feature set. OWNER'S STANDING AUTHORITY (2026-08-27): all UI/UX decisions are delegated to the implementer — no design questions need to come back — PROVIDED every product feature and function remains exactly as it is. UI/UX is free; features and functions are frozen. This document + the two HTML artifacts + components-map.md are the complete spec.

## 0. Artifacts in this package
- Workbench Kit.dc.html — the design system: 12 sections, 37 components, all scored 10/10. Open in a browser; every component carries its screen/journey strip. THE visual source of truth.
- Conductia Workbench.html — the interactive prototype: all 9 screens assembled from the kit (sign-in→MFA→home/today/rail/ask/buyers/mail/room/team/audit). THE behavioral+layout source of truth.
- components-map.md — component → kit anchor → repo route → journey mapping.
- tokens.css — the Tier-1 payload as delivered, written against the repo's EXISTING semantic token names. Shipped and since extended in src/app/globals.css, which is the source of truth; this file is the historical handover artifact.
- ICON-GUIDE.md — which lucide-react glyph maps to which product concept, and at what size. The repo depends on lucide-react for code; the 27 mapped glyphs are also vendored as SVGs in icons/lucide/ for the kit, redistributed under the ISC license in LICENSE-Lucide.txt.
- src/components/brand/assets/ — the selected L1 "Conduit" mark (canonical, all-ink) + L6 "Signal" variant, as transparent SVGs with a README placement map (Wordmark.tsx, favicon, nav brand block, auth, stamps).
- brand-spirit.md — vision, mission, audience, metaphor system, design principles, voice, and logo rules.
- Logo Directions.dc.html — the full v13 exploration for the record.

## 1. THE SAFE-CHANGE CONTRACT (unchanged, governs everything)
- Tier 1 (free): token VALUES in src/app/globals.css → apply tokens.css as a new [data-palette='workbench'] block; set it live in src/app/layout.tsx data-palette. One-line revert.
- Tier 2 (cheap): type-ramp class rules, INSIDE @layer components only.
- Tier 3 (careful): Tailwind utility classes on existing elements (className only).
- Tier 4 (pre-approved): new markup / restructured DOM. The design owner has ALREADY approved every Tier-4 item in this package (the Workbench prototype is the approved spec) — see §4b Decision record. Tier-4 discipline still applies to HOW they ship: one PR each, ship after Tiers 1–3, each independently revertible, no logic changes. Only NEW Tier-4 ideas beyond this package require asking.
- Tier 5 (forbidden): props, state, handlers, hooks, data flow, imports, logic. NEVER.
- Never touch: src/lib/ · src/app/api/ · middleware.ts · supabase/ · *.test.*.

## 2. HARD INVARIANTS (verify after every stage)
1. UI talks only to ConductiaAPI (src/lib/api/). No new fetches.
2. Exactly ONE [data-compliance-status] instrument (ComplianceRibbon in AppShell). Restyle to the workbench pill (kit §08); never duplicate/relocate. Verbatim labels kept: "Compliant", "Hold for review", "Blocked — not compliant", "Checking compliance…" (test-asserted).
3. Contrast contract: light surfaces take dark ink. Workbench is light-first; --canvas-bg stays ink #191919 for the few on-dark moments so --ink-on-dark* tokens keep meaning.
4. Type ramp stays in @layer components (Tailwind v4 layering — unlayered classes silently beat utilities).
5. Project identity is URL state. 6. Brand voice: statements, no em-dashes in user copy (regulatory separators excepted: the compliance status label "Blocked — not compliant" is a frozen regulatory status descriptor per ADR-0003 consequences and D15, and keeps its separator). 7. WCAG AA floor, 44px touch targets, 2px visible focus, prefers-reduced-motion honored. 157 test files assert rendered text/roles — do not change visible strings without checking tests.

## 3. TOKENS (Tier 1 — tokens.css)
Register: warm neutrals, ink-black primary, violet reserved for the AI actor (Casey), solid pastel status fills, hairlines over shadows. Full values in tokens.css, mapped onto the repo's existing names (--ink, --surface*, --stroke, --accent*, --positive*, --hold*, --negative*) plus new ones (--ai, --*-fill, --*-tint, --sync). Decisions locked:
- Accent: ink #191919 replaces electric blue as --accent. Violet #5E5CE6 is NOT a general accent — only Casey (send button, AI chips, active-run states).
- Fraunces: DROP the font load (layout.tsx). --font-display → Georgia serif stack, used ONLY for project identity + source excerpts (kit §01).
- Interface face: Inter stays (already loaded). Geist Mono stays for ids/timestamps/figures only.
- Radius: input/button 8 · card/modal 12 · composer 16–18 · chips pill. Map --radius-* accordingly.
- Elevation: hairline borders; ONE ambient shadow token for floating composers/popovers (0 14px 40px rgb(25 25 25/.09)).
- Motion: 100–160ms ease for hovers/fades; Casey run stages 900ms cadence; keep useReducedMotion gates.

## 4. COMPONENT MIGRATION MAP (kit § → repo file → tier)
- Buttons §02 → atoms/Button.tsx: primary=ink fill; secondary=white outline #E0DED8; ghost=quiet text. h 28/34/36. T3.
- Verdict chips §03 → atoms/Badge.tsx: SOLID pastel fills (ok/warn/bad), radius 6, sentence case. T3.
- Category dot pills §03 → atoms/Pill.tsx: white pill + 6px colored dot. T3.
- Signal dot+label §03 → new tiny atom or Badge variant (Strong/Situational). T3/T4.
- Segmented pill tabs §02 → atoms/SegmentedControl.tsx: pill container-less, active=field-gray fill. T3.
- Compliance instrument §08 → compliance/ComplianceRibbon.tsx: idle white pill + dot; verdict states use fills. T3 (style only).
- Composer (Harvey pattern) §04 → workspace/Composer.tsx: gray 16r card, scope chip, quiet toolbar, ink send. T3/T4.
- Deal-home composer §04 → NEW screen content at /projects/[projectId] (workspace/): serif identity + floating card + history list. T4 — approved (§4b).
- Files/review tables §05 → dataroom/DataRoom.tsx + review surfaces: gray 12px headers (no caps), 48–58px rows, numbered spine. T3.
- Matrix grid §05 → acquirers/: typed cells (signal+thesis clamp-4 / evidence / draft). T4 — approved (§4b).
- Modal + wizard §06/§12 → wizard/, panels/: FILLED #F1F0EC borderless inputs, LEFT-aligned footer, numbered spine. T3/T4.
- Dropzone §06 → dataroom upload. T3.
- Top nav + deal switcher + ⌘K §09 → shell/AppShell.tsx, AppNav.tsx, organisms/navigation/: replaces navy sidebar with 56px light top chrome. T4 — approved (§4b); ship LAST, behind a flag if possible.
- Score dial / phase meter §10 → atoms/ScoreDial.tsx, shell/DealContextBar.tsx: track=field gray, signal arcs. T3.
- Audit register §11 → audit/AuditTrail.tsx: light table, mono timestamps, dot-pill kinds. T3.
- Team columns §12 → team/TeamRoster.tsx: party columns + boundary pills. T4 layout.
- Auth §12 → sign-in/two-factor/accept-invite pages: warm card, filled inputs, one ink action. T3.
- Toasts §08: white card + status dot, body names the register write. T3.

## 4b. TIER-4 DECISION RECORD (approved by the design owner, 2026-08-27)
Authority: the owner approved the Workbench Kit (all components scored 10/10) and the Workbench prototype end to end, and directed a full UI/UX replacement. These five restructures are therefore DECIDED — build them to match Conductia Workbench.html exactly:
1. Top-nav shell replaces the navy sidebar — 56px light chrome, deal switcher, nav pills, ⌘K, one compliance instrument, avatar. Buys: light-first register end to end, +236px content width. Risk: largest DOM change → ship last, behind a flag; sidebar code path kept until flag removal.
2. Deal-home composer at /projects/[projectId] — serif identity, floating composer (violet Casey send), suggestion chips, history list, phase meter. Buys: the deal reads as a workspace, ask-first entry. Risk: replaces dashboard content; navigation and data hooks unchanged.
3. Buyers matrix at /acquirers — typed grid cells (signal+thesis / capacity / evidence / draft), select column, per-row approve. Buys: the screening run becomes a durable, reviewable artifact. Risk: table markup only; data shape unchanged.
4. Mail release-gate layout — pipeline pills, held card with flagged term in situ, why-held block, register preview, left-aligned actions. Buys: the supervisory queue IS the screen. Risk: layout of existing MailClient panes; send/release handlers untouched.
5. Team party columns — one column per side with boundary pills. Buys: the perimeter becomes visible. Risk: presentational regrouping of the existing roster data.
If implementation forces a deviation from the prototype (a11y, tests, data constraints), deviate minimally and note it in the PR. Per the owner's standing authority, UI/UX deviations need no approval; the ONLY hard stop requiring escalation is anything that would remove, hide, or alter a product feature or function — every capability reachable today must remain reachable after the restyle.

## 5. SCREEN ORDER (each stage ships + reverts independently)
Stage 1 (T1): tokens.css live under [data-palette='workbench']. Whole app re-skins.
Stage 2 (T2): type ramp values (sizes/weights per kit §01) in @layer components.
Stage 3 (T3): atoms (Button, Badge, Pill, Segmented, ScoreDial, inputs, tables, toasts, ribbon restyle, auth).
Stage 4 (T4, one PR each, pre-approved per §4b): deal-home composer · buyers matrix · mail release-gate layout · team columns · top-nav shell (last, flagged).
Verify per stage: run tests; check every palette × style-mode combination still renders; confirm single ribbon instance; axe-scan for AA.

## 6. ICONS (icons/lucide, ISC license preserved)
lucide-react names: search, command, panel-left, database, file-text, table-2, chart-no-axes-combined, shield-check, circle-check-big, lock-keyhole, folder-lock, clock-3, git-compare-arrows, quote, circle-alert, external-link, workflow, landmark, briefcase-business, building-2, badge-dollar-sign, scale, scan-text, book-open-check, list-checks, search-check, file-check. Sizes: 16 dense · 18 controls · 20 prominent; 14 allowed in dense contexts. strokeWidth 1.75. Label beside any unfamiliar icon.

## 7. ACCESSIBILITY FLOOR (non-negotiable)
Text AA minimum (ink #191919 on #F5F4F1 = 15.99:1; secondary #55534E = 6.98:1 on #F5F4F1, 7.68:1 on white; tertiary #6B6B68 = 5.35:1 on white, 4.69:1 on the #F1F0EC field fill). #9C9A94 clears no AA threshold at any size (2.81:1 on white, 2.56:1 on #F5F4F1) — placeholders and decoration only, never text a reader must read. Focus: 2px visible ring #B9B4A8 minimum — keep the repo's 2px contract. 44px touch targets on interactive rows (rows are 48px+). Status = color + label, never color alone. prefers-reduced-motion strips travel, keeps state changes.

## 8. WHAT SUCCESS LOOKS LIKE
Open any screen next to Conductia Workbench.html at 1440px: same tokens, same geometry, same density, same states. All 157 tests green. Every palette×mode combination renders. Zero logic diffs outside className/CSS. The kit becomes the foundation: new features compose from kit components only.
