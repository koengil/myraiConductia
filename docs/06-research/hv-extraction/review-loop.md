# Platform Review → Score → Fix Loop (autonomous drive to 9+/10)

Conductor-run loop: review the platform from four angles, score against the matrix, dispatch file-disjoint fix agents, re-score. Continue until every dimension ≥ 9 and no blockers. Source corpus scored against: `intelibank-101`, `intelibank-horizontal-vertical`, `rogo-research` (1:1 reference fidelity is an explicit dimension).

## Scoring matrix (0–10 per dimension; target ≥ 9 all)

| Dimension | What it measures |
|---|---|
| UI/UX 1:1 fidelity | Faithfulness to the reference (Rogo) screens/webarchive: layout, sidebar, chat-as-document, composer + model/source pickers, skills hairline grid, fonts, sizes, light-mode colors, density |
| Feature completeness | Every key vision feature present: Command Center, rail, chat, skills, data room, pre-send QC, buyer log, weekly update, audit, search |
| Functionality | Real end-to-end flows work: home→step, chat compose→response, visible compliance, nav parity, no dead ends/demo scaffolding |
| Product effectiveness | Intuitive/best-practice for an MD; morning command view; rails usable; compliance felt not theatre; no build-metadata leakage |

## Rounds

### Round 1 — baseline (2026-07-09)
Scores: **UI/UX 7 · Features 5 · Functionality 5 · Product 5 · avg 5.5**

Key findings:
- BLOCKER: Command Center / morning queue absent → **built** (`CommandCenter.tsx`, mounted at `/projects`).
- Functionality: chat is one hardcoded answer + dead follow-up composer; ComplianceRibbon mounted nowhere (6 surfaces dispatch into the void); desktop/mobile nav mismatch.
- Product: rail leaks build-team metadata (RTS/FP·OS, A/A+H, LIVE/schema/planned, OS build #, ★) meaningless to an MD; login lacked the cross-deal task view (now fixed by Command Center).
- UI/UX: sidebar defaults collapsed (should be always-expanded ~264px labeled); History stream absent; chat double-header; type a notch large.

Fix wave 1 (dispatched, file-disjoint):
- `fix:shell-nav` — sidebar expanded + History section, re-mount ComplianceRibbon inline, nav parity.
- `fix:rail-md` — strip build metadata from the MD-facing rail.
- `fix:chat` — stateful functional conversation (compose→response), code-name-safe.

Next: integrate wave 1 → full verify (tsc/lint/test/build) → commit → re-score (Round 2). Then wave 2 (UI/UX density + 1:1 polish) and wave 3 (Search/Ask, weekly update, audit viewer). Loop until ≥9 all.

### Round 1 fixes landed (2026-07-09)
Fix wave 1 committed (43aab8d): Command Center (login landing), sidebar expanded + History, ComplianceRibbon re-mounted inline, nav parity, rail stripped of build-metadata (MD-legible), chat is a real stateful conversation. Gates: tsc 0 / 256 tests / build clean.

Storm-feedback refinements to fold into the platform build:
- Three-layer labeling (platform substrate / horizontal rails / vertical skills) in the rail's always-on band + copy.
- Next-step recommender on the rail (after each step: ranked suggestion + full-step dropdown).
- Surface a Compliance & Trust view (SOC2 / WORM / FINRA / DORA / ISO42001 / audit log / kill switch).
- Agentic-containment + cost/time as visible always-on capabilities.

Round 2 review dispatched next.

### Round 2 — Lance IA feedback + fixes (2026-07-09)
Lance walked the platform and flagged the navigation model, not just styling. The corrected IA:
- **Command Center = the multi-deal HOME** (login landing). Services all deals: morning tasks across every deal, overnight agent work, approvals, live-deals strip. This IS the "weekly update / morning" surface — no separate weekly-update page.
- **Each deal has its OWN Deal Rail.** Sidebar lists deals by CODE NAME (Atlassian → Project Summit; + a 2nd example deal e.g. Project Harbor at a different stage). Clicking a deal → that deal's rail, not a per-deal home/chat.
- **History = dedicated chat-history section** (each item → its chat), not dead links / weekly-update.
- Removed dead nav (Weekly update did nothing).
- Compliance ribbon inline in the TopBar header row (save real estate), not a standalone strip.

Quick fixes landed inline: dropped serif ("Kirby") headers → clean Inter sans; removed the Share button from chat.
IA-restructure agent dispatched (sidebar/nav/command-center/deals/routing/compliance-inline).

Round 2 review (dispatched after the IA fix) ADDS a **user-journey audit** dimension: walk the actual MD/banker journeys against the nav panel — which screens/links work, which don't, what's intuitive vs not, sidebar functionality — and score.

### Round 2 continued — Lance walkthrough fixes (2026-07-09)
Landed inline (committed): compliance ribbon inline in header (navy chip) + white strip removed; chat full-screen (composer pinned); serif headers → Inter; Share removed; **chat HOME restored** (empty /chat state = composer home via DealHome; New Chat + "Ask" nav land here); **History items now distinct** (each seeds a different question/template; chat remounts per ?q so they don't all show the same conversation); "Chat" nav renamed to **"Ask"**; deal index → rail; Command Center = multi-deal home with code-name deals (Project Summit / Project Harbor).

Sample deal ingested: "Project Destiny" (27 files / 29 folders) → public/data-room + previews + manifest.

Dispatched (file-disjoint), building now:
- **Data Room UI** (a07b7c77): replace the classified mock with a navigable Project-Destiny file explorer (tree + folders + preview iframe / download), audit-hooked.
- **Audit Trail** (a65a116f): live audit-log screen + route + step/skill instrumentation (chat already instrumented; store at src/lib/audit/store.ts; nav item + destination already added).

Next: integrate both → full verify → commit → **Round 2 re-score with journey audit** → dispatch remaining fixes → loop to 9+.

### Round 2 scores (2026-07-09)
**UI/UX 7.8 · Features 6 · Functionality 7 · Product 7 · Journey 7 · avg 6.96** (was 5.5).

Concrete, demo-impactful fixes (fix wave 2 dispatched):
- **Rail honors ?step**: Command Center task CTAs (and chat quick-actions) deep-link with ?step, but DealRail ignores it — every task lands on the current cursor, not the named step. Make the rail Focus/scroll to the ?step.
- **Double-header chrome**: the global TopBar stacks above each surface's own header (chat/data-room/audit) → double hairline bars. Reconcile to one header per surface (keep compliance chip visible).
- **Audit the OPENING chat question** (only follow-ups are logged now) — compliance completeness.
- **Audit Trail missing from mobile bottom nav** — parity.
- **Orphaned acquirers/team routes** (no nav entry) — remove or surface.
- Minor: density ~1px over reference 12px base; navy compliance chip reads as a dark island; active pill tint.

Note on Features/Product ceiling: scored against the FULL real operating layer (real LLM retrieval, 10-category Pre-Send QC, server-side audit, all 65 steps live). This is intentionally a fixture-driven DEMO skin — those axes cap ~7-8 without building the real engine (out of scope for a UI demo). UI/UX, Functionality, Journey are the axes a polish pass can take to 9.

### Round 3 scores + fix wave 3 (2026-07-09)
**UI/UX 8 · Features 6.5 · Functionality 8 · Product 7 · Journey 7 · avg 7.3** (was 6.96). Fix wave 2 moved UI/UX + Functionality up.
Fix wave 3 (done inline — the dispatched agent returned a prompt-injection + zero work, redone by conductor):
- Rail honors ?step (tasks land on the named step's drawer); opening chat question audited; double-header removed (borderless TopBar); Audit Trail in mobile nav.
- **Surfaced Buyers (acquirers league table) + Team (outreach threads)** — both fully built but had NO nav entry (a demo never reached them; the single biggest Product/Journey deduction).
- **DealHome derives real deal state** from the cursor (Summit=Preparation, Harbor=Origination) — fixes the hardcoded "Phase 3, Marketing / 18 of 65" shown on every deal.
Remaining to 9 on Product: step-detail altitude (contract/io reads as an engineering spec). Features/Product capped by the simulated engine (real LLM/backend out of scope for a UI demo).

### Fix wave 3+ complete; Round 4 review blocked (session limit → resets 2:20pm ET)
All concrete Round-3 findings addressed:
- Orphaned Buyers + Team surfaced in nav ✓
- Deal-state consistency: DealHome + Command Center both derive real phase/progress from the cursor (Summit=Preparation/35, Harbor=Origination/6) ✓
- Step detail reframed to banker language ("What it works with / Needs / What it does / Produces"); dropped build-metadata + stub deadline ✓
- (wave 2) rail ?step deep-link, opening-question audit, double-header removed, mobile audit nav ✓
Gates: tsc 0 · 262 tests · build clean · lint 0.
Score trend: 5.5 → 6.96 → 7.3 (R3); R4 re-score pending session-limit reset. Demo axes (UI/UX 8, Functionality 8) near 9; Product/Journey expected ~8.5 post-wave-3; Features ~6.5 capped by simulated engine (real LLM/backend out of scope for a UI demo).
