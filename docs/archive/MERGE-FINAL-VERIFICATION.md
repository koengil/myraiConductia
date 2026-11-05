# Sandbox Merge — FINAL VERIFICATION

> **MERGED TO `main` — 2026-05-27.** Branch `merge/sandbox-2026-05-21` landed on `main`. Lance gates in §10 closed at merge time.
>
> **HISTORICAL. Point-in-time record (2026-05-20).** Sandbox-merge close-out. The product has since evolved (the 2026-05-24 AI-native shell redesign). Current source of truth: `/README.md`. Kept for decision traceability.

> Phase H close-out. Objective gates, port inventory, seam-diff, brand-register pivot record, open Lance gates. Authored 2026-05-20.

**Branch:** `merge/sandbox-2026-05-21` → **merged to `main` 2026-05-27**
**Baseline:** `main` at `cef65ed` (Lance's `FINAL-VERIFICATION.md` end-state + the `MERGE-REVIEW.md` he committed before the merge began).
**Donor repo (never modified):** `/Users/martincasado/FutureProofing/intelibank-sandbox`
**Commit hash range:** `9ae79c6` (Phase 0 scaffolding) → Phase H close-out commit.

---

## 1. What this branch ships

A functional and visual merge of `intelibank-sandbox` into `intellibank`. **The trunk stayed `intellibank` (Lance's foundation)**; the sandbox donated the substance — a real compliance engine, editable scoring, four analytical panels, the inline screening overlay, the editorial open-question moment, the network-boundary route layer, and the brand register that matches the actual logo. Voice rules, four-destination IA, all Phase A–G primitives from Lance's overhaul — all preserved.

**The shape change**, in one sentence: the build went from a navigable platform with thin analytical content + a five-word profanity check called "compliance" to the same platform with substantive panels, a real three-state compliance engine with rewrite suggestions, editable score-weight sliders, and a navy + gold brand register matching the user-supplied logo.

**The MD now sees:**

- `/` — Mandate: italic Fraunces "Atlassian" display + plain eyebrow + h1 + lead + open-question editorial moment in italic Fraunces + vitals tiles + recent activity. Two editorial Fraunces moments per the brand pattern.
- `/acquirers` — landscape with RAG-coloured score dials (green ≥75, amber 50–74, red <50), hero rank-1 card with gold accents.
- `/acquirers/[id]` — workspace + score card with **editable bucket-weight sliders** (auto-balancing, RAG dial), then **four always-visible analytical panels** (Football Field, Culture Matrix with Bain four fault lines, Synergy Stress-Test against McKinsey/Bain base rates, Founder Read with retention-risk ladder). Sticky right-rail context on `lg+`.
- `/team` — compliance theatre with the **rotating-phase screening overlay** during scanning + the **three-state verdict** (compliant / hold / blocked) with **inline rewrite suggestion** as guidance.
- `/skills` — catalogue (Free / Pro tiers).
- Chrome: navy AppHeader with gold Wordmark (clickable → home), inline AppNav with gold active-hairline, ProfileMenu, ComplianceRibbon with the new `hold` state + the brighter-on-navy retoning, and the persistent CommandBar (hidden on `/acquirers/[id]` to avoid chrome competition).

**The compliance moat is now visible.** "Every interaction visibly routes through compliance" was a claim before this merge; it is a demonstration now — three-state verdict + rewrite suggestion + rotating-phase overlay during scan + RAG signal on every score.

---

## 2. Objective gates — all green (verified 2026-05-20)

Commands (run from the repo root, under Node 22 per `.nvmrc`):

```sh
nvm use                                  # picks Node 22 from .nvmrc
npx tsc --noEmit                         # tsc 0 — type-clean
npx eslint .                             # eslint 0 — lint-clean
npx vitest run                           # 114 passed / 1 documented skip
npx next build                           # static-clean, 9 routes resolve
```

**Results at HEAD:**

| Gate | Status | Detail |
|---|---|---|
| TypeScript | ✅ 0 errors | `tsc --noEmit` clean |
| ESLint | ✅ 0 errors, 0 warnings | full repo |
| Vitest | ✅ 114 passed / 1 documented skip / 0 failures / 0 flakes | 19 test files |
| `next build` | ✅ static-clean | Next 16.2.6 Turbopack; 9 routes |
| Node engine | ✅ pinned at `22` via `.nvmrc` | resolves vitest 4 + rolldown engine floor |

**Test delta vs Lance's Phase G end-state:** `39 passed / 1 skipped` → `114 passed / 1 skipped`. **+75 new tests net**, zero failures, zero flakes through 16 commits.

**Routes resolving in production build:**

```
┌ ○ /
├ ○ /_not-found
├ ○ /acquirers
├ ƒ /acquirers/[id]                  (dynamic; server-rendered on demand)
├ ƒ /api/intellibank/acquirers       (NEW — Phase F representative route handler)
├ ○ /dev-primitives
├ ○ /icon.svg
├ ○ /skills
└ ○ /team
```

**The one documented skip:** `tests/golden-path.test.tsx > Acquirer detail` — carried forward from Lance's Phase G. The `React.use(params)` Suspense pattern doesn't reliably suspend + resolve in jsdom + react-testing-library. Coverage is provided by per-component suites (paywall, score-dial, skill-shelf, panels, compliance-ribbon, plus the new four analytical-panel tests) and the click → router.push contract asserted in the Acquirers section. Honestly recorded, not masked.

---

## 3. Seam-diff vs Lance's Phase G end-state

The merge IS a deliberate widening of the typed seam in `src/lib/api/types.ts`. Token names are byte-stable; method signatures are widened (not broken); the changes are recorded per ADR.

**Type widenings (governed by ADR-0003 + ADR-0005):**

| Type | Before (Lance's Phase G) | After (this merge) | Source |
|---|---|---|---|
| `ComplianceCheckResult` | `{ status: 'clear'\|'blocked'; reasons: string[]; ruleIds: string[] }` | `{ verdict: 'compliant'\|'hold'\|'blocked'; reasons: string[]; rewrite?: string }` | ADR-0003 |
| `ComplianceStatus` | `'idle'\|'scanning'\|'clear'\|'blocked'` | `'idle'\|'scanning'\|'clear'\|'hold'\|'blocked'` | ADR-0003 |
| `Skill` | `{ ..., panel: 'financialMatrix'\|'cultureRadar'\|'scoreBreakdown' }` | `{ ..., dataShape: 'company'\|'cultureFactors'\|'compositeScore' }` | ADR-0005 engineering-review carry |
| `PanelData` | discriminated union with `kind: 'financialMatrix'\|'cultureRadar'\|'scoreBreakdown'` | **Retired.** Replaced with `SkillRunData` whose `dataKind` discriminator carries DOMAIN names (`'company' \| 'cultureFactors' \| 'compositeScore'`) instead of UI-panel names. | ADR-0005 |
| `Company` | unchanged shape | optional `openQuestion?: string` field added | Phase E |

**New seam methods on `ConductiaAPI`** (governed by Phase D extension):

- `getValuation(): Promise<Valuation>` — Football Field rows + trace data for the seller.
- `getSynergyStressTest(acquirerId: string): Promise<SynergyStressTest>` — McKinsey/Bain rate rows + risk-driver note.
- `getFounderRead(acquirerId: string): Promise<FounderRead>` — three post-deal scenarios for the founder.
- `getCultureMatrix(acquirerId: string): Promise<CultureMatrix>` — Bain four fault lines, per-acquirer authored reading.

Plus `runSkill` return shape changed from `{ locked: false; panel: PanelData }` to `{ locked: false; data: SkillRunData }` (Phase F refactor; panel rendering belongs on the client).

**One representative HTTP route handler** added at `src/app/api/intellibank/acquirers/route.ts` (Phase F) — the network-boundary architectural lesson from the merge review. Existing UI keeps consuming through `getApi()` directly for in-process speed. Remaining 12 endpoints follow the same 3-line pattern; deferred to a polish phase.

---

## 4. Kept-from-A (Lance's foundation, preserved intact)

| Artifact | Why preserved |
|---|---|
| Four-destination IA (`/`, `/acquirers`, `/acquirers/[id]`, `/team`, `/skills`) | D17 / ADR-0004; A wins on platform-of-destinations vs sandbox's single-surface DealRoom |
| `ConductiaAPI` typed seam at `src/lib/api/` | The product boundary; widened, never replaced |
| `MockConductiaAPI` + fixtures | Foundation for the merge's port targets |
| Pure-function deterministic scoring (`computeCompositeScore`) | Refactored on top of weighted-mean primitive; **default-weight scores `Anthropic 87 / Salesforce 67` byte-identical**, the assertion floor |
| Single-mount `ComplianceRibbon` contract | `[data-compliance-status]` mounted exactly once in chrome — widened to 5 states but invariant preserved |
| 16-token core palette + 4px spacing grid + Fraunces / Inter / Geist Mono type trio (D14) | Token NAMES stayed byte-stable; only values pivoted (G2/G3) |
| 13 vitest tests + golden-path lockstep policy (§4 of front-end overhaul ledger) | All asserted contracts preserved; lockstep edits logged in change log + ADRs where the contract shifted |
| All `docs/` skeleton: vision, business, product, engineering, brand, growth, decisions (D1–D21), source transcripts, superpowers ledgers + spec | Preserved; the new D22–D26 + ADR-0002–ADR-0006 augment, never replace |
| Voice rules in `04-brand/brand-foundations.md` | "Precise, senior, decisive" — survives the brand register pivot intact |
| §4 em-dash policy (banned in prose; sanctioned in ARIA + regulatory labels + recap lines) | Applied to every B-sourced string at port time |
| ScreeningOverlay's structural place: ribbon contract |  `'Checking compliance…'` label byte-identical; overlay added inline in MessageComposer + CommandBar without touching the ribbon contract |

---

## 5. Ported-from-B (substantive donations from the sandbox)

**Engineering / domain logic:**

- **Three-state compliance engine** (`src/lib/compliance/screen.ts`, Phase B). Ported `PROMISSORY_PATTERNS` + `MNPI_KEYWORDS` + dollar-figure context detection verbatim. Three verdicts (`compliant` / `hold` / `blocked`) + rewrite suggestion. Retires the prior five-word profanity check. Governed by ADR-0003.
- **Weighted-mean scoring primitive** + **editable bucket-weight sliders** (`src/lib/scoring/composite.ts`, `src/components/acquirers/ScoreWeightsControl.tsx`, Phase C). Default weights produce locked 87/67; user can slide between financial and culture buckets and the rank tally updates live. Governed by ADR-0002.
- **`reqToken` race-cancel pattern** (`src/app/acquirers/[id]/page.tsx`, Phase F). Replaces the `active` boolean guard where deps allow re-runs (acquirer navigation). Mandate page keeps `active` (empty deps, no race).
- **`Skill.panel` refactor** (Phase F). `PanelData` (UI-name discriminator) retired; `SkillRunData` (domain-name discriminator) replaces. Wire contract narrowed; presentation lives on the client. ADR-0005 engineering-review carry.
- **Network-boundary route handler** (`src/app/api/intellibank/acquirers/route.ts`, Phase F). One representative GET; pattern documented; remaining 12 endpoints deferred.

**Analytical content (Phase D):**

- **`FootballFieldPanel`** — valuation envelope with explicit `NEEDS-DATA` rows where comp set / DCF / precedents aren't wired. Atlassian May-2026 figures from public market.
- **`CultureMatrixPanel`** — Bain four fault lines (purpose, decision-making, engagement, founder compatibility); per-acquirer authored readings (Anthropic + Salesforce fully written; others fall back).
- **`SynergyStressTestPanel`** — three rows (cost / revenue / total-captured) against McKinsey + Bain published base rates. Mgmt-claim cells `NEEDS-DATA` until an acquirer files synergy projections.
- **`FounderReadPanel`** — three post-deal scenarios for Mike Cannon-Brookes with retention-risk ladder + likelihood pills (`Most likely / Plausible / Tail risk`).
- Plus four new seam methods (`getValuation`, `getSynergyStressTest`, `getFounderRead`, `getCultureMatrix(acquirerId)`) and per-component tests.

**UX patterns:**

- **`ScreeningOverlay`** (`src/components/compliance/ScreeningOverlay.tsx`, Phase E). Cycles `Parsing message` → `Scanning for MNPI markers` → `Checking promissory language` → `Finalizing verdict` at 375ms each during composer scanning. `SCAN_BEAT_MS` raised 320 → 1500 (one full cycle); the sandbox's 6s artificial floor was trimmed to ~1.5s per ledger disposition.
- **Italic Fraunces "open question" editorial moment** on the Mandate page (Phase E + G2). Paired with the italic Fraunces seller-name display (Phase G + G2). Two editorial display-serif moments per APPLICATION per the brand pattern; everywhere else uses sans Inter.
- **Sticky right-rail context** (`/acquirers/[id]` warm analytical section, Phase G). Compact ScoreDial + acquirer name; reference-only (operator score-card with sliders stays in the dark workspace header).
- **Pulse-halo dot** on the ComplianceRibbon idle state (`.compliance-idle-dot` keyframes + `--pulse-halo-color` token, Phase G). The "compliance is alive" heartbeat ported from sandbox `app-pill-dot`; reduced-motion suppressed via CSS media query.
- **Arrow glyphs** on primary CTAs (Run →, Send →, Phase G3) — the sandbox's `Send →` pattern that Phase B stripped, restored.

**Research substrate (Phase D, ADR-0005 carry):**

- `docs/06-research/synergy-base-rates.md` — McKinsey ~80% cost / ~50% revenue + Bain 30–50% capture within 2yr.
- `docs/06-research/culture-fault-lines.md` — Bain four fault lines + signal sources.
- `docs/06-research/atlassian-may-2026-financials.md` — market cap / revenue / 52-week range with the violent re-pricing narrative.
- `docs/06-research/README.md` — index. All figures marked `NEEDS-VERIFICATION` before external use; sandbox-demo accuracy is the bar.

`docs/README.md` updated: the `06-research/` directory status flipped from "Awaiting input" to "Populated 2026-05-20 (Phase D sandbox merge)".

---

## 6. Retired from `intellibank` (the merge swept stale state in Phase A)

Four `intellibank` docs over-claimed F5's removal scope. Corrected in Phase A + Phase A correction:

| Doc | Before | After |
|---|---|---|
| `docs/02-product/experience-spine.md` | Described the retired 7-step spine (ColdOpen → ... → PitchCta) as the live narrative | Rewritten as "Platform Experience" — four destinations + chrome; retired-spine content moved to a historical-note pointer |
| `docs/03-engineering/architecture.md` | Claimed `STAGE_ORDER` + `Stage` union + `src/components/stages/` "removed in F5" — half-true; F5 deleted only the UI surfaces. Reducer machinery survived as residue. | Rewritten honestly: UI removed in F5, reducer machinery survives in `session/store.ts` as awaiting-cleanup residue (exercised by `tests/session.test.ts`) |
| `docs/03-engineering/data-contracts.md` | Implied `Stage` type was deleted | Restored type with honest comment about post-F5 residue |
| `docs/03-engineering/sandbox-vs-production.md` | "Sunday deliverable" framing; 3-route build table | Modernised: 8-route build table; "Sunday deliverable" framing dropped |

The retired-but-active `Stage` / `STAGE_ORDER` / `NEXT` / `BACK` reducer machinery is now documented honestly. A future polish phase can remove the dead code; the merge deferred that per owner direction to preserve momentum.

---

## 7. Phase summary

| Phase | Commit | Substance |
|---|---|---|
| 0 — Scaffolding | `9ae79c6` + `ccc5fe2` | Ledger + 4 ADRs (D22–D25) + decision-log entries. No code. |
| A — Doc refresh | `c6fc591` | 4 stale `intellibank` docs corrected post-F5. |
| A correction | `454b8ca` | Honest reframing of F5 stage-machine residue (reducer survives; only UI was deleted). |
| B — Compliance engine port | `a4f1fac` | Three-state verdict + rewrite + hold UI state. `ComplianceCheckResult` widened. ADR-0003 Accepted. +43 tests. |
| C — Editable scoring | `081582f` | Weighted-mean primitive + slider UI; 87/67 default-weight floor preserved. ADR-0002 Accepted. +15 tests. |
| `.nvmrc` pin | `f8aa01f` | Node 22 pinned so `nvm use` from the repo root picks the right runtime (resolves vitest 4 + rolldown engine floor). |
| D — Analytical panels | `1370a3a` | 4 panels + 4 seam methods + research substrate + 4 per-component tests + 4 docs in `06-research/`. Parallel-subagent dispatch (D21) held cleanly. +9 tests. |
| E — Screening overlay + open question | `579ff70` | Inline rotating-phase overlay; italic-Fraunces open-question moment on Mandate. +5 tests. |
| F — Engineering hardening | `da2bb32` | `reqToken` pattern adopted; `Skill.panel` refactored off the wire; one representative `/api/intellibank/*` route handler. +3 tests. |
| G — Visual ports | `baec691` | Pulse-dot halo on the ribbon's idle state; italic-Fraunces seller name moment #2; sticky right-rail on the deep-dive. Golden-path lockstep edit. |
| G2 — Brand pivot | `09dd055` | **ADR-0006 Accepted.** Editorial Institutional retired (D13 reversed); IB-terminal palette + 13px body + density reset. Spacing-ladder bug fixed (`--space-5/7/10/11` were used 24× but undefined). |
| G3 — Brand-aligned correction | `0503fc5` | User-supplied brand logo (navy + gold serif) clarified the brand; teal → gold accent; navy chrome; AppHeader Wordmark → gold + clickable to home; Send/Run arrows; CommandBar hidden on deep-dive + wider + centred; RAG semaforo on ScoreDial; AcquirerCard hero decorative greens → gold; Team fieldset bug fix; ribbon retone for navy chrome; rewrite-button UX bug fix. |
| H — Final verification | (this commit) | `MERGE-FINAL-VERIFICATION.md` written; ADR-0005 status flipped Proposed → Accepted; ledger closed; D25 row updated. |

---

## 8. ADRs accepted in this merge

| ADR | Status | Effect |
|---|---|---|
| ADR-0002 (editable scoring weights) | Accepted (Phase C) | Extends D9 — function stays pure + deterministic; default-weight floor preserved; weights become user-editable via sliders. |
| ADR-0003 (three-state compliance verdict) | Accepted (Phase B) | Widens `ComplianceCheckResult` + `ComplianceStatus`. The ribbon's verbatim label set gains `'Hold for review'`. Profanity wordlist retired. |
| ADR-0004 (platform vs single-surface) | Accepted (formalises D17, 2026-05-19) | Records why the sandbox's single-surface `DealRoom` thesis was the rejected branch — for the future maintainer who finds B's commit history. |
| ADR-0005 (sandbox merge disposition) | **Accepted at Phase H close (this commit)** | Meta-record of the merge: trunk = `intellibank`, donor = `intelibank-sandbox`, kept / ported / retired inventories enumerated. Pending Lance acknowledgement before any push to `main` per D3. |
| ADR-0006 (brand register pivot) | Accepted (G2 + G3 correction) | **Reverses D13** (Editorial Institutional aesthetic). Partially supersedes D11 (rogo-derived nominal). Preserves D14 (Fraunces / Inter / Geist Mono trio). Triggered by user feedback + supplied brand logo. Pending Lance acknowledgement. |

Decision log: D22 → D26 appended on the same dates. D13 marked reversed by D26.

---

## 9. Brand register pivot record (Phase G2 + G3)

Mid-merge the user did a visual walk-through and reported "se ve todo muy blanco, look and feel blogger de los 2000". A critical visual review (`docs/archive/VISUAL-REVIEW.md`, subagent-authored) confirmed the criticism was structural, not execution polish: Editorial Institutional commits to warm cream + Fraunces serif display + airy section gaps; faithful execution produces a magazine-blog feel. Plus a hidden critical bug — `--space-5/7/10/11` referenced 24× but undefined, resolving to 0 at runtime.

The user authorised Option B (partial pivot), then supplied the actual brand logo (deep navy + Trajan-style serif **CONDUCTIA** in gold + classical column "I" mark + tagline *"THE AI OPERATING SYSTEM FOR INVESTMENT BANKING"*). G2 pivoted to navy + teal + cool gray + dense; G3 corrected the accent to gold per the logo and added the navy AppHeader chrome, CTA arrows, RAG semaforo, ribbon retoning, and a handful of bug fixes the user surfaced page-by-page.

Token names stayed byte-stable; only values pivoted. Voice rules + two editorial Fraunces moments + 13px body + spacing-ladder fix + four-destination IA + all B–G functional work survived intact.

**Compliance-green is reserved for actual compliance signals only** (ribbon clear state, `ScoreBreakdownPanel` "Verified through the compliance layer" note, `TransformStream` skill drop) — and for the RAG dial high band. Everywhere else, decorative emphasis is `--accent` (gold). The discipline keeps the brand voice ("senior, decisive") readable without the magazine costume.

---

## 10. Lance gates — closed 2026-05-27

**All gates acknowledged; branch merged to `main` on 2026-05-27.** Original gate text preserved below for traceability.

These are the gates Lance owns; the conductor cannot close them. Listed in dependency order:

1. **ADR-0006 acknowledgement.** The brand register pivot (D13 → reversed by D26) is local to the feature branch. Before any push to `main`, Lance reviews ADR-0006 + the Phase G2 / G3 ledger entries + a visual diff of the four destinations. If Lance disagrees with the pivot, the resolution is either (a) revert G2 + G3 cleanly (the two commits are self-contained), or (b) refine the spec by negotiation. The feature branch is the conversation surface; `main` stays untouched until acknowledgement lands.
2. **Visual / responsive sign-off** at the four QA breakpoints (≤375 mobile / 768 tablet / 1280 desktop / 1920 wide). Suggested check per destination (Mandate / Acquirers / Acquirer detail [with a panel scrolled into view] / Team [send a clean message + a held message + a risky message — the three composer affordances] / Skills [Free + Pro cards]). Plus the profile menu open/close + the rail sticky behaviour on `/acquirers/[id]` at `lg+`.
3. **Favicon (`src/app/icon.svg`)** — still depicts the deep-forest shield/check that pre-dated even Lance's wordmark text-only change in D-2. Now visually inconsistent with the navy + gold logo. Needs a brand decision (text monogram, geometric mark, plain navy tile). The conductor did not autonomously change it — brand call, not defensive edit.
4. **Deploy / GitHub remote / repo+dir rename** — per D3 + D18 (and the new D26 spelling check), these are Lance's checkpoints. Branch is `merge/sandbox-2026-05-21`; identity for the dir is `lance-fp / lance@futureproofing.dev` via the `github.com-fp` SSH alias when a remote is created. Nothing has been pushed.

Also flagged for Lance's awareness (not blockers):

5. **Stage-machine residue cleanup** (Phase A correction entry in the ledger). `Stage` type, `STAGE_ORDER`, `NEXT`/`BACK` reducer actions, `SessionState.stage` survive in the session store after F5 retired the UI surfaces that used them. No production impact; just dead code exercised by `tests/session.test.ts`. A cleanup phase can land any time.
6. **Spelling normalisation** — the logo says `CONDUCTIA` (single L). The repo dir is `intellibank` (double L per D18). Code identifiers mix both. The merge did not unify these — that's a follow-on decision (rename the repo to match the logo, OR keep the dir double-L while shipping with the single-L brand mark). Worth a conversation, not blocking.

---

## 11. How to reproduce the verification

```sh
cd /Users/martincasado/FutureProofing/intellibank
git checkout merge/sandbox-2026-05-21
nvm use                     # picks Node 22 from .nvmrc

# Objective gates
npx tsc --noEmit            # expect: exit 0
npx eslint .                # expect: exit 0
npx vitest run              # expect: 19 files / 114 passed / 1 skipped
rm -rf .next && npx next build  # expect: static-clean, 9 routes

# Range of commits this merge contributes
git log --oneline cef65ed..HEAD

# Diff stat against main (the merge surface)
git diff --stat main..HEAD

# Local visual smoke (browse each destination at the 4 breakpoints)
npx next dev               # then http://localhost:3000
```

Expected output of `git log --oneline cef65ed..HEAD`:

```
<Phase H close>
0503fc5 feat(brand): Phase G3 — navy+gold brand pivot + iterative visual polish ...
09dd055 feat(brand): Phase G2 — brand register pivot to IB-terminal (ADR-0006)
baec691 feat(visual): Phase G — pulse-dot heartbeat, italic moment, sticky rail
da2bb32 refactor(seam): Phase F — engineering hardening
579ff70 feat(compliance,mandate): Phase E — screening overlay + open-question brief
1370a3a feat(panels): Phase D — four analytical panels in /acquirers/[id]
081582f feat(scoring): Phase C — weighted scoring + editable bucket-weight sliders
f8aa01f chore: pin Node version to 22 via .nvmrc
a4f1fac feat(compliance): Phase B — three-state verdict + rewrite suggestions
454b8ca docs(correction): Phase A — honest framing of F5 stage residue
c6fc591 docs(merge-phase-a): refresh 4 stale docs post-F5 + close Phase A in ledger
ccc5fe2 docs(ledger): Phase 0 ☑ closed at 9ae79c6 → Phase A
9ae79c6 docs(merge-phase-0): ledger + ADRs D22-D25 for sandbox merge
```

---

## 12. Where to read next

- **The merge review that started this:** `docs/archive/MERGE-REVIEW.md` (parallel 4-agent comparative review of A vs B, 2026-05-20).
- **Durable ledger:** `docs/superpowers/plans/2026-05-21-sandbox-merge/master.md` — phase-by-phase audit, change log, RESUME HERE pointer; this is the durable record, this file is the close-out summary.
- **Visual review behind the brand pivot:** `docs/archive/VISUAL-REVIEW.md` (subagent-authored 2026-05-20).
- **ADRs added by this merge:** `docs/07-decisions/ADR-0002` through `ADR-0006`. Decision log entries D22 → D26 in `docs/07-decisions/decision-log.md`.
- **Research substrate:** `docs/06-research/` (synergy base rates / culture fault lines / Atlassian May-2026 financials / README).
- **Lance's predecessor close-out:** `FINAL-VERIFICATION.md` (pre-merge end state — companion document, not superseded).
- **Predecessor implementation ledger:** `docs/superpowers/plans/2026-05-19-intellibank-frontend-overhaul/master.md` (Phases A–G of the front-end overhaul Lance ran before this merge began).
- **Sandbox donor (never modified):** `/Users/martincasado/FutureProofing/intelibank-sandbox/` — historical reference for what was ported.

---

*End of merge close-out. The branch is local, the gates are green, the ADRs are recorded. Lance has the floor.*
