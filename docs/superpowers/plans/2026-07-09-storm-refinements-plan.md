# Surgical Refinement Plan — Storm Call (2026-07-09)

Implements `docs/02-product/storm-call-2026-07-09-features.md` into the live `develop-design` platform. Ordered by demo-impact × smallest-correct-change. Every item is a **presentation/derivation** change — nothing crosses the `ConductiaAPI` seam or `/api/v1`. All rail semantics layer in `src/lib/rail/dealRail.ts` overlays (`STEP_OVERRIDES`/`STEP_FEATURES` pattern), never the generated `railData.generated.ts`. Test invariants to preserve: **5 phases / 65 steps**, `GATE0_ACTIONS` = 4, `ALWAYS_ON_APPS` = 21; keep `/acquirers`, `/team`, and the golden-path `"Compliance theatre"` + `Clean/Risky message` affordances intact.

**Two cross-cutting decisions up front:**
- **`src/lib/constants/adminSurfaces.ts` → `ADMIN_SURFACES = false`** — one shared module-level gate for "built internally, hidden from the banker" (used by the composer pickers and the full step-io). Avoids scattering flags / a Supabase `FLAG_REGISTRY` round-trip for demo toggles.
- **Naming is OPEN — do not rename the codebase.** "Conductia" is preferred over "Conductia," but antitrust flagged *both* for the "Intel" root (and "…Deal" names are risky). Tracked as a decision for Storm; no code action.

---

## WS1 — Deal Folder vs Data Room split  `[MVP]` (highest priority, foundational)

Our explorer shows Project Destiny = our **internal work product = Deal Folder** (internal-only; client cannot access). The **Data Room** = the client's own documents (external; placeholder already built at `public/data-room-external/` + `src/lib/dataroom/data-room-manifest.json`). Parameterize the ONE explorer by `(manifest, kind)`.

- `src/lib/dataroom/tree.ts`: add `type ManifestKind = 'deal-folder' | 'data-room'`; export `dealFolderManifest` (current) + `dataRoomExternalManifest` (new JSON); add `tags?: readonly string[]` to `FileNode` (meta-tagging seed for future Enterprise Search — typed now, no search built).
- `src/components/dataroom/DataRoom.tsx`: change to `DataRoom({ manifest, kind })`; drop the hardcoded `DEAL_NAME`/`dataRoomManifest`; header driven by `kind` (eyebrow "Deal folder" vs "Data room" + an access note — deal-folder: "Internal work product. The client cannot access this."; data-room: "Client documents. Staged buyer access."); render `file.tags` chips in the preview pane; audit uses `detail: manifest.root`.
- Routes: rename `.../dataroom/` → `.../deal-folder/` (renders `dealFolderManifest`, `kind="deal-folder"`); add `.../data-room/page.tsx` (renders `dataRoomExternalManifest`, `kind="data-room"`).
- `src/lib/perspective/access.ts`: replace `'dataroom'` with `'dealFolder' | 'dataRoom'`; **storm** gets both, **mike/dana (client/buyer) get `dataRoom` ONLY** (nav-level internal-only guarantee); `destinationFromPathname` matches `/data-room` before `/deal-folder`.
- Both navs (`Sidebar.tsx` `PER_DEAL_ITEMS` + `AppNav.tsx` `DESTINATION_SPECS`): two rows — Deal Folder (FolderLock, first) + Data Room (FolderOpen).
- Tests: add `dataroom.test.tsx` (each kind renders its manifest + access note) + an `access.test.ts` case (mike/dana blocked from dealFolder). No existing tests break.

## WS2 — Composer: remove model/effort/source pickers  `[MVP]` (near-zero risk, high impact)

"Banking in the front, AI in the back" — the banker never picks a model/effort/route.
- `src/components/workspace/Composer.tsx`: delete `MODEL_TIERS`, `SOURCE_GROUPS`, the tier + source buttons and both popover blocks + their state/handlers; **keep attach + submit**. Gate the removed markup behind `ADMIN_SURFACES` (default off) for internal reversibility. Update the file's header comment.
- Hosts (`DealHome.tsx`, `Chat.tsx`) untouched (they pass only `codename/placeholder/onSubmit`). Fix the stale "with model + source pickers" comment in `golden-path.test.tsx`. No test asserts picker text.

## WS3 — Buyers → Working Group List + reframe the WGL rail step  `[MVP]`

- New `src/lib/wgl/workingGroup.ts`: `WglSide = 'client'|'sell-advisor'|'buyer'|'buy-advisor'`; `WorkingGroupPerson = {id,name,firm,side,role,email,phone?,platformStatus?}` (email + `platformStatus` = network-effects seed). `SEED_WGL` seeds sell-advisor from `getTeam()` names (Storm/James/Sarah) + buyers from acquirer names, so surfaces agree.
- New `src/components/wgl/WorkingGroupList.tsx`: roster grouped by side; each row a contact card with **click-to-call** (`tel:`) + **email** (`mailto:`); a `[Later]` "Invite to platform" affordance when `platformStatus==='off-platform'`.
- New route `.../working-group/page.tsx`; `access.ts` add `'workingGroup'` (storm + mike + limited dana); `Sidebar`/`AppNav`: **replace** the "Buyers" (acquirers) nav row with "Working Group List" (icon `Contact`). Keep `/acquirers` + `/acquirers/[id]` reachable via a "Buyer scoring →" link from the WGL buyer section (preserves the golden-path league-table assertions).
- Rail: reframe existing step **seq 30 `p2-s30` "WGL"** `STEP_FEATURES` from RACI/owners into "Draft the Working Group List" (contacts preview mirrors `SEED_WGL`); note it as the perpetually-updated roster. **Do NOT add a step** (65-step invariant). Moving it earlier than phase 2 = ledger regen = `[Later]`.
- Tests: add `working-group.test.tsx` (roster + tel/mailto per person); golden-path acquirers case stays green.

## WS4 — Token odometer  `[MVP, small]`

- `src/components/rail/DealRail.tsx` header pill (data already in `deals.ts`: `getDealTokens`/`DEAL_TOKENS_EVENT`): reframe as **"Odometer" · {tokens} · spend on this deal** (live-subscribed already). Optional `src/components/rail/Odometer.tsx` reused on `CommandCenter.tsx` live-deals strip for the "by deal / by person" framing. Honest-by-design vs Rogo's hidden cost. No test asserts the pill copy.

## WS5 — Code-name themes at Gate 0  `[MVP, small]`

- `src/lib/rail/deals.ts`: `CODENAME_THEMES: Record<'birds'|'football'|'movies', string[]>` (neutral words that never contain the target — mask invariant holds); `proposeCodenamesByTheme(theme,...)` reusing the coprime-stride logic; `proposeCodenames` becomes a thin wrapper; store `codenameTheme?` on `FixtureDeal` (on-theme counterparty names later, `[MVP-aware]`).
- `src/components/wizard/Gate0Wizard.tsx`: a 3-chip theme selector above the suggestions; feed themed suggestions; pass `codenameTheme` to `createDeal`. Add one test (theme changes the suggestion set); existing gate0 tests hold (suggestions still `/^Project /` + masked). The Tesla-style Easter egg Storm wants.

## WS6 — Skills not exposed / not reverse-engineerable  `[MVP]` (medium — touches tests)

Recommend **reduction, not removal** (keep the governed-library demo, drop the "how"):
- Add `whyBetter?: string` to `RailStep` via a new `STEP_WHY` override (~65 short lines or a generic fallback) — replaces `description` on exposed surfaces.
- `SkillLibraryCard.tsx`: show name + `whyBetter` + owner/★/approval-state chips; drop the execution-class badge + io.
- `SkillDetailPanel.tsx`: **remove the "Contract" tab** (io lanes) + the "Tools"/"Mechanism in this repo" blocks; collapse to title + approval state + 2–3 "why it's better" bullets + governance (approval gate, compliance).
- `StepContract.tsx` (MD view): replace the "What it works with" io lanes + "Tools today" with a single "Produces: …" line; keep full io behind `ADMIN_SURFACES`.
- Tests: `skills-library.test.tsx` assertions on the Contract tab / io / `description` move to `whyBetter` + the reduced panel; census assertions stay. Re-check `rail-ui.test.tsx` io-lane assertions.
- Alternative (call out, don't default): drop the Skills nav destination entirely — maximally hidden but forfeits the on-thesis governed-library surface.

## WS7 — Auto-approval rulesets  `[MVP]`

"NDA meets a ruleset → auto-signs, zero human touch."
- `dealRail.ts`: `autoApproval?: {ruleset; checks[]}` via `STEP_OVERRIDES` on the NDA steps `p1-s12` (Client NDA) + `p3-s42` (Buyer NDA).
- New `src/lib/rail/autoApproval.ts`: pure `evaluateAutoApproval(step) → {verdict:'clear', checks}`.
- `DealRail.tsx`: when an active/entered step has `autoApproval`, auto-write an "Auto-signed" receipt (`addReceipt`) + advance the cursor — no buttons/modal (idempotent on receipt presence).
- `StationCard.tsx`/`StepContract.tsx`: "Auto-approved" chip; `stepNeedsApproval` returns false; suppress run/complete/skip with "Signed automatically against the {ruleset} ruleset."
- Tests: `deal-rail.test.ts` (NDA steps carry autoApproval; needsApproval false).

## WS8 — Parallel + persistent + remind-daily + richer skip/mid-entry  `[MVP]`

Overlay on the cursor model (don't rewrite it).
- `dealRail.ts`: add `parallelSafe?`, `persistent?`; new `STEP_FLOW` map — persistent = `p1-s6, p1-s7, p1-s12, p1-s20, p1-s25` (Gate-0 conflicts/codename, Client NDA, EL strategy, Engagement Negotiation — "fire regardless of skips"); parallelSafe = `p2-s30 (WGL), p2-s36 (Teaser), p2-s37 (CIM), p3-s41 (Buyer Log)`.
- `railRunState.ts`: `reminders: Record<stepId,{remindDaily,since}>` + `markInProcess`/`clearReminder` (localStorage + `RAIL_RUN_EVENT`). Add `'in-process'` to `StationState` + label + marker.
- `StepContract.tsx`: on a `parallelSafe` active step, a **"In process — remind me daily"** button → `markInProcess` + advance cursor past it (parallel work not lost, doesn't block N+1). Disable **Skip** for `persistent` steps ("This step always happens").
- `DealRail.tsx`/`RailTimeline.tsx`: a top **"Reminders"** strip listing `remindDaily` steps; "Always required" chip on persistent steps; mid-entry derivation renders pre-entry persistent steps as "required," not auto-done (EL/NDA/Gate-0 still fire when a deal enters late).
- Tests: `deal-rail.test.ts` + `rail-ui.test.tsx` (persistent un-skippable + survive mid-entry; parallelSafe advances without completing; markInProcess writes a reminder).

## WS9 — New Business Development → separate timeline, cut from MVP rail  `[MVP]`

- `dealRail.ts` (derivation only): `timeline: 'new-biz-dev'|'execution'` in `toRailStep` = `phase===1 && !persistent ? 'new-biz-dev' : 'execution'` (Phase-1 pitch/origination steps become new-biz-dev; the 5 persistent mandate-formation steps stay execution). Keep `DEAL_RAIL` = full 65 (invariant). Add derived `NEW_BIZ_DEV_STEPS` + `MVP_DEAL_RAIL` (execution + the 5 persistent Phase-1 steps).
- Point `DealRail.tsx`/`RailTimeline.tsx` + the Gate-0 entry-picker at `MVP_DEAL_RAIL` (thread via `rail=` param, don't change the `DEAL_RAIL` default); Skills page labels Phase 1 "New Business Development — separate timeline (post-MVP)". Optional internal `/newbiz` behind `ADMIN_SURFACES` `[Later]`.
- Tests: `deal-rail.test.ts` full census unchanged; add a `timeline`-partition test; retarget any rail count assertion to the MVP subset.

## WS10 — Meeting-notes → automated follow-through  `[MVP]` (hero, largest net-new)

The #1 banker pain (the all-nighter agenda). Fixture-driven but real-feeling; reuses WS8 reminders + the `AgentFeatureModal` grammar.
- New `src/lib/followups/fixtures.ts`: meeting notes → detected follow-ups `{id, deal, trigger, agenda[], attendees[], proposedSlots[], draftEmail, complianceReminder?}` (seed Storm's org-call story + a "notify compliance" reminder).
- New `src/components/followups/FollowUpCard.tsx` + `FollowUpModal.tsx` (loader→agenda→Calendly-style slots→auto-send draft, compliance-screened badge, honest fixture framing).
- `CommandCenter.tsx`: a **"Follow-ups drafted for you"** section above "Needs you now"; card opens the modal; "auto-send" writes an audit line + a token allocation (moves the odometer — ties to WS4). Route compliance reminders through the WS8 rail reminders strip. Promote to a dedicated `/followups` destination `[MVP-aware]`.
- Tests: new `followups.test.tsx`; no existing test breaks.

## WS11 — Team cross-link (kept distinct from WGL)  `[MVP, light]`

- `team/page.tsx`: keep the `"Compliance theatre"` label + `Clean/Risky message` affordances **byte-identical** (golden-path). Add a one-line "Our deal team. For all parties, see the Working Group List." + a `Link` to `/working-group`. Team stays storm-only (internal); WGL is cross-party.

---

## Execution order & dependencies
WS1 → WS2 → WS3 (+ WS relies on `SEED_WGL` for the rail reframe) → WS4 → WS5 → WS6 → WS7 → WS8 → WS9 (depends on WS8 `persistent`) → WS10 (reuses WS8 + WS4) → WS11 (depends on WS3 route). WS1/WS2/WS4/WS5 are the fast, low-risk demo wins; WS6/WS8/WS9/WS10 are the medium-risk, higher-value ones.

## Later / out-of-scope (flag, don't build)
Pre-compliance; skills-marketplace "App Store rules" template; Slack/Teams connectors + comms-on-platform; data-vendor (CapIQ/PitchBook) connections; true per-person backend authorization (the WGL `platformStatus`/permissions fields are the seed); real Enterprise Search (the `tags` field is the seed); knowledge-graph vs relationship-graph modeling; the product name.
