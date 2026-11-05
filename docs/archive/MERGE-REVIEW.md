# Merge Review — `intellibank` (A) vs `intelibank-sandbox` (B)

> **MERGED TO `main` — 2026-05-27.** Sandbox merge (`merge/sandbox-2026-05-21`) landed on `main`. See `MERGE-FINAL-VERIFICATION.md` §2 for the final gate run.
>
> **HISTORICAL. Point-in-time record (2026-05-20).** The A-vs-B repo review that scoped the sandbox merge. The product has since evolved (the merge landed, then the 2026-05-24 AI-native shell redesign). Current source of truth: `/README.md`. Kept for decision traceability.

**Authored:** 2026-05-20
**Source:** Parallel 4-agent read-only review across engineering, product/UX, brand/visual/copy, and docs/research.

---

## TL;DR

**`intellibank` (Lance's) is the foundation. `intelibank-sandbox` (Martin's) contributes one product-defining engine, one mechanic, four analytical panels, two editorial layout ideas, and several non-negotiable research artifacts.**

The two repos express the same thesis through two different architectures. A is a *platform of destinations* — typed seam, four routes, chrome, deterministic scoring, motion contracts, written brand and decision logs. B is a *single operable surface* — one workspace where compliance is the right rail and the harness composes itself live. A wins on every infrastructure axis. B wins on substantive analytical content and on making the compliance moat *visceral*.

The merge keeps A's bones and ports B's organs. Without B's compliance rule pack, A's "compliance is the moat" thesis is undersold by a five-word profanity list. Without B's panels (Football Field, Synergy Stress-Test, Founder Read, Culture toggle), A's destinations are a chassis with thin analytical content. Without A's seam, brand system, ledger, and tests, B cannot ship.

---

## At-a-glance comparison

| Dimension | A — `intellibank` | B — `intelibank-sandbox` | Foundation |
|---|---|---|---|
| Architecture | Typed `ConductiaAPI` seam at the product boundary (`src/lib/api/`) | `LLMProvider` interface + real `app/api/llm/*` route handlers | **A** (B's lesson informs §4) |
| Scoring | Fixed weights 0.55/0.45 (`composite.ts`, 21 lines) | User-editable weighted normalization (`score.ts`, 52 lines) | **B's primitive, A's shape** |
| Compliance engine | 5-word profanity check (`rules.ts`) | MNPI + promissory regex + dollar-figure context + per-pattern rewrite suggestions (`screen.ts`, 112 lines) | **B** (port wholesale) |
| Compliance UX | One `[data-compliance-status]`, ribbon in chrome, store-dispatched | Inline Gateway right rail + rotating-phase screening overlay | **A's instrument + B's overlay** |
| IA / navigation | 4 routed destinations + persistent CommandBar | Single page, harness-composed panels | **A** |
| Analytical panels | Score breakdown, culture radar | Football Field, Synergy Stress-Test, Founder Read, Culture toggle | **B** (port four panels) |
| Skills concept | Catalogue route + drag shelf + Canvas drop | Drag between Marketplace ↔ Active Harness, surface reshapes | **A** for return-visits, B's harness mental model worth a memo |
| Motion language | Framer Motion + named contracts (Compliance Pulse, Skill-Transform Stream) | Hand-rolled CSS keyframes (pulse, panelIn, etc.) | **A** (B's app-bar pulse dot is the one piece worth lifting) |
| Type system | Self-hosted Fraunces / Inter / Geist Mono via `next/font`, OpenType features applied | Google Fonts `<link>`, Cormorant Garamond + Inter + JetBrains Mono | **A** (B's two italic display moments pattern survives, mapped to Fraunces) |
| Color tokens | 16 frozen tokens, warm cream + deep forest + compliance green | Navy + teal + coral + gold, "Bloomberg-sober" | **A** (B's navy survives only as `data-surface="cinematic"`) |
| Voice | Editorial, no em-dashes in prose, "statements not questions" | Vivid IB-trader prose, em-dashes in ~80% of fixtures | **A's discipline + B's best single lines, em-dashes stripped** |
| Tooling | Tailwind 4 PostCSS, Vitest 4, ESLint 9 flat config | Tailwind 3 + config, `node:test`, deprecated `next lint` | **A** (B is one Tailwind major behind) |
| Tests | 13 vitest + RTL files | 2 `node:test` files | **A** (port B's deeper unit tests into vitest) |
| Docs | 36 files: vision, business, product, engineering, brand, growth, decisions (D1–D21), source transcripts, superpowers ledger | 1 README | **A** (port B's implicit knowledge as ADRs and research) |
| Brand name | "Conductia" (double L) | "Conductia" (single L) — pervasive across code and copy | **A** (global rename required on every B import) |

---

## Merge plan — what to port from B into A

Ordered by leverage and effort. Each item references specific paths.

### Priority 1 — Ship blockers (port before any demo)

**1. Compliance rule pack.** Replace `src/lib/compliance/rules.ts` with the substance of `intelibank-sandbox/lib/compliance/screen.ts`:

- Three-state verdict: `compliant | hold | blocked` (currently A is binary).
- `PROMISSORY_PATTERNS` regex set.
- `MNPI_KEYWORDS` with dollar-figure context detection.
- Per-pattern `rewrite` suggestions.
- Widen `ComplianceCheckResult` in `src/lib/api/types.ts` to include `verdict` and `rewrite?: string`.
- Port `lib/compliance/screen.test.ts` to vitest under `tests/compliance.test.ts`.

*Why ship-blocker:* A's current profanity-only check undersells the moat that defines the product. Every reviewer of A asks the same question: "is that really all compliance does?" The honest answer today is yes. After this port, the answer is "no — MNPI, promissory framing, dollar-figure context, with rewrite suggestions."

**2. Generalized weighted scoring + editable weights mechanic.** Replace the fixed-weight implementation in `src/lib/scoring/composite.ts` with B's `lib/scoring/score.ts` primitive (normalized arbitrary weights, all-zero edge case). Layer A's two-bucket `CompositeScore` shape on top. Then port the slider weights UI from `intelibank-sandbox/components/scenes/AcquirersClient.tsx:233-385` into A's acquirer deep-dive (`src/app/acquirers/[id]/`).

*Why ship-blocker:* "Same formula across every acquirer" is the determinism claim in A's copy. Today the user cannot *see* the formula. Sliders make the determinism visible and turn the dashboard into an operator surface.

### Priority 2 — Substantive content gaps

**3. Four analytical panels.** Port from `intelibank-sandbox/components/scenes/` into A's `src/app/acquirers/[id]/`, wired through the `ConductiaAPI` seam (extend with `getValuation`, `getSynergyStressTest`, `getFounderRead`, `getCultureMatrix(acquirerId)`):

| Source | Destination | Notes |
|---|---|---|
| `FootballField.tsx` | New section in deep-dive | Valuation envelope with horizontal range bars + explicit `NEEDS-DATA` rows. MDs read football fields, not radar charts. |
| `SynergyStressTest.tsx` | New section in deep-dive | Mgmt claim vs published base rates (McKinsey ~80% cost / ~50% revenue; Bain 30–50%). The single most MD-grade artifact in either repo. |
| `FounderRead.tsx` | New section in deep-dive or `/team` | Three post-deal scenarios with `Most likely / Plausible / Tail risk` verdict pills + retention-risk ladder. |
| `CultureClient.tsx` (Salesforce ↔ Anthropic toggle, Bain 4 fault lines) | Replace A's `CultureRadarPanel` content | Same surface reads differently per acquirer — concretely demonstrates "the 20% nobody prices." Currently fetches `/api/llm/culture-matrix`; rewire to the seam. |

For each, port the content and structure; render through A's `Card` and brand tokens (drop B's heavier `panel-pad surface-panel` chrome).

**4. Compliance overlay during scanning.** Lift the rotating-phase screening overlay pattern from `GatewayStream.tsx` (`Parsing message` → `Scanning for MNPI markers` → `Checking promissory language` → `Finalizing verdict`). Wire it into A's `CommandBar` and `MessageComposer` flows during the existing `scanning` state on the ribbon. **Trim the 6-second artificial floor to ~1.5s** — keep the weight, drop the hostility.

**5. Mandate banner pattern.** Fold B's `MandateBanner` tile + italicized open-question pattern into A's `/` Mandate header. A's tiles read like dashboard KPIs; B's tiles + the italic Cormorant question land as a *brief*. Render the question in Fraunces against `--ink` on `--surface-warm` with a `--positive-deep` hairline.

### Priority 3 — Engineering hardening

**6. Async race-cancellation pattern.** Replace A's `active` boolean guard in `src/app/page.tsx:49-95` with B's `reqToken` pattern from `AcquirersClient.tsx:242,266`. B's handles stale-request collisions; A's only handles unmount.

**7. Network-boundary seam (architectural lesson, not a copy-paste).** Before the first real backend conversation, wrap `MockConductiaAPI` behind thin `/api/intellibank/*` route handlers modeled on B's `app/api/llm/*/route.ts` (3-line route → provider singleton). Forces honesty about latency, retries, and failure surfaces. Almost free now; expensive later.

**8. Split `Skill.panel` out of the API contract.** A's `MockConductiaAPI.runSkill` returns a `PanelData` discriminated union (`src/lib/api/mock.ts:46-76`) that bakes panel rendering into the wire shape. A real backend will not return UI panel kinds. Resolve the panel-kind pivot client-side; keep `Skill.panel` as a presentation concern. B's `LLMProvider` shape stays cleaner on this point — study it as a counter-example, then refactor.

### Priority 4 — Visual / copy

**9. Persistent right-rail layout.** Port the sticky-at-66px deal room rail from B's `globals.css:217-244` + `DealRoom.tsx:51-62`. Fit it into A's existing `page-shell` grid. Makes the workspace feel like an IB terminal without abandoning A's IA.

**10. Two italic display-serif editorial moments.** Mandate name + open question, rendered in Fraunces italic, `--ink` on `--surface-warm`, with a `--positive-deep` hairline. Cheap, brand-defining, on-spec.

**11. App-bar pulse dot.** Lift `app-pill-dot` from B's `globals.css:128-137` (3px halo box-shadow + keyframes pulse). Cheap, gorgeous.

### Priority 5 — Cleanup before any port from B lands

These are corrections to B's content as it crosses into A. Apply at port time:

- **Rename "Conductia" → "Conductia" globally** in every ported file (B has the single-L spelling pervasively; D4 in A's decision log mandates double-L).
- **Strip em-dashes** from every ported copy string (~80% of B's fixtures use them; A's brand spec forbids them in prose).
- **Drop the "Sandbox · v0" chrome and meta-narration.** `AppBar.tsx:11`, the footer `<strong>Sandbox · fixture data, real screening.</strong>` in `DealRoom.tsx:75`, the `eyebrow: "Live scenario · sell-side mandate"` in fixtures — all are demo-tells. Strip on port.
- **Replace JetBrains Mono with Geist Mono** wherever B's CSS references it.
- **Drop B's font-loading via Google CDN** — A's `next/font` self-hosting is strictly better.
- **Drop `lib/llm/prompts/.gitkeep`** — aspirational dead space.

---

## What each repo learned separately

Beyond the merge, both repos encode insights worth preserving as written artifacts even if no code crosses over.

### From `intelibank-sandbox` — implicit knowledge to capture as written research

1. **Editable scoring weights as a product principle.** B's M4 commit and `score.ts` express a thesis: *the MD must be able to move the weights and see the ranking flip*. A's `matrices.md §4` fixes weights without comment. Capture as **ADR-22: Composite scoring — editable weights or fixed?** plus an update to `matrices.md §4`.

2. **Three-state compliance verdict (compliant / hold / blocked) with rewrite suggestions.** B's `screen.ts` model. A models only binary `clear|blocked`. More nuanced and more credible to an ex-banker. Capture as **ADR-23: Compliance verdict shape — three-state with rewrites** plus extension to `data-contracts.md`.

3. **NEEDS-DATA discipline.** B inlines `NEEDS-DATA` markers in code and copy to honestly label what is computed vs. hand-authored. A claims deterministic scoring but doesn't catalog synthesized parts. Capture in `03-engineering/conventions.md`.

4. **Real M&A research substrate.** Bain "4 fault lines" culture matrix, McKinsey synergy base rates (~80% cost / ~50% revenue / 30–50% capture within 2 years), Football Field with May-2026 financials and 52-wk range derivation. None of this exists in A's `02-product/matrices.md`. **Fill A's empty `docs/06-research/` directory with this research, with citations.**

5. **Single-surface UX hypothesis.** B's commit `M1 v2: single operable surface — no tabs, no scenes, no navigation` is a real counter-argument to A's four-destination platform. Capture as **ADR-24: Platform vs. single surface — why four destinations win** so the rejected branch is on record.

6. **Six-second artificial think delay as deliberate demo presence.** B chose latency as a design element, not a bug. Worth a sentence in `04-brand/motion-language.md` even though A will trim the magnitude.

7. **Harness mental model** (Marketplace ↔ Active Harness drag). Even if A keeps the catalogue + canvas drop, B's "two-zone harness" framing is a memo worth writing into `02-product/skills-catalog.md`.

### From `intellibank` — discipline to preserve

- The seam pattern itself (typed `ConductiaAPI` + `MockConductiaAPI`) is the single most important engineering call in either repo. Don't dilute it.
- The decision log (D1–D21) is honest and self-correcting (D4↔D18, D7↔D12). Continue the discipline.
- The ledger pattern in `docs/superpowers/plans/.../master.md` is what makes cold-start resume possible. Follow it for the merge itself.
- Source-trace discipline in `docs/99-source/` (verbatim transcripts with `DO NOT EDIT` headers) is irreplaceable raw material.
- Brand spec rules in `04-brand/brand-foundations.md` are operational, not aspirational — observably enforced in shipped copy.

---

## Stale documentation in A — fix as part of the merge

Found by the docs review agent. These will mislead anyone joining cold:

| File | Issue |
|---|---|
| `docs/02-product/experience-spine.md` | Describes the retired 7-step linear spine (ColdOpen → Intent → Landscape → ...) that Phase F deleted. Either rewrite to the four-destination platform or move to `superpowers/archive/`. |
| `docs/03-engineering/architecture.md` | References `STAGE_ORDER`, the session stage machine, and `src/components/stages/` — all deleted in F5. |
| `docs/03-engineering/data-contracts.md` | Line 42 still defines `type Stage = 'coldOpen' \| 'intent' \| ...` — a dead type. |
| `docs/03-engineering/sandbox-vs-production.md` | Route table shows 3 routes; actual build has 8. "Sunday deliverable" framing reads stale. |
| `docs/README.md` | `06-research/` listed as "Awaiting input" (still empty). Active spine referenced in reading order. |

---

## ADRs the merge itself needs

The merge is a contested design call, not a cleanup. It deserves entries in `docs/07-decisions/decision-log.md`:

- **D22** — Composite scoring: editable weights (port from sandbox).
- **D23** — Compliance verdict shape: three-state with rewrites (port from sandbox).
- **D24** — Platform of destinations vs. single operable surface — why four destinations win (record the rejected branch).
- **D25** — Sandbox merge disposition — what was kept from each repo and why (this document is the source).

And a new ledger entry under `docs/superpowers/plans/2026-05-21-sandbox-merge/master.md` following the existing pattern, so subagents can resume the merge cold.

---

## Risks and open questions

1. **`Skill.panel` in the API contract.** Already noted in §3 priority 3 item 8. Refactor before the API contract hardens further.

2. **Three-state compliance may invalidate existing tests.** A's `tests/compliance.test.ts` and `compliance-ribbon.test.tsx` assume binary verdict. Plan for test rewrite, not just augmentation.

3. **Editable weights may invalidate fixed-snapshot tests** (`tests/composite.test.ts`, `score-dial.test.tsx`). The 87/67 fixed scores in CLAUDE.md become "default-weight scores." Update the invariant language.

4. **Brand collision: navy.** B's deep navy is *good* and *wrong* — wrong for A's warm-cream + deep-forest system, but genuinely strong as a cinematic data surface. Options: drop entirely, or introduce a `data-surface="cinematic"` variant for specific panels. Decide before porting B's chrome.

5. **B's `app/api/llm/*` routes use real network calls in dev.** A's `MockConductiaAPI` is in-process. The architectural lesson (port the route shape, not the wiring) is correct, but the merge must not silently introduce flaky network calls into A's golden-path tests.

6. **Spelling normalization is bigger than it looks.** "Conductia" → "Conductia" appears in B's `package.json`, `metadata.title`, brand mark, footer, every fixture string, README, several CSS class names. Treat it as a discrete pre-merge sweep, not a search-and-replace at port time.

---

## Recommended next steps

1. **Read this doc.** Mark anything you disagree with — every item above is a call, not a fact.
2. **Decide foundation.** Confirm A as the trunk (or push back with a counter-argument). Everything downstream assumes A.
3. **Authorize the merge ledger.** I can create `docs/superpowers/plans/2026-05-21-sandbox-merge/master.md` and the four ADR stubs (D22–D25) — locally, untracked, awaiting your review — so the merge has a phased plan with verify gates before any code crosses over.
4. **Sequence the Priority 1 ports** (compliance rule pack, weighted scoring + sliders). These two ports alone change the product more than anything else available.
5. **Decide on the navy.** Drop, or introduce `data-surface="cinematic"`.
6. **Address the four stale A docs.** They will mislead anyone reading A cold today.

---

*End of merge review. No code or git state has been modified by this document's creation.*
