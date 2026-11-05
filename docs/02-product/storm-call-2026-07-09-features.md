# Storm Call (2026-07-09) — Extracted Features & Decisions

Source: Ignatious senior team ↔ Jess/Lance call + Storm's written notes. This is the canonical extraction that the refinement plan and the Ignatius extraction prompt build on. Grouped by theme; each item tagged **[MVP]**, **[MVP-aware]** (build so we don't box ourselves out later), or **[Later]**, and where it lands in the platform.

## 1. The North Star (overrides prior UI decisions)

**"Banking in the front, AI in the back."** The banker must NEVER choose a model, an effort level, or a skill route. Apple principle: every release, ask what to *remove*, not add. Autonomous vehicle, not a cockpit. "I don't know what AI is doing" — and doesn't care which skill/model produced a draft.

- **[MVP] Remove model/effort selection from the composer.** Our reference-faithful composer exposes model tiers (Instant/Fast/Pro/Deep) + a source tray. Storm explicitly rejects this — it's the exact Rogo mistake ("have some 60-year-old banker choose the model level"). The composer should just *work*; no model picker.
- **[MVP] Skills are NOT exposed / not reverse-engineerable.** "Ideally we don't even show them on the platform — they're just built in." Our Skills library currently exposes 65 step-skills with full contracts (inputs/outputs/instructions). Refine: do not surface skill instructions; at most a few bullets on *why* a skill is better, never the how. Reconsider the whole Skills-library-as-catalog surface.
- **[MVP] Auto-approval rules for routine tasks.** e.g. an NDA that meets a defined ruleset auto-signs with zero human touch — "it's done or it's not done," never a task a human touches. Steps can auto-complete against a ruleset.

## 2. Deal Folder vs Data Room (currently CONFLATED — highest-priority fix)

Storm: our "Data Room" is mislabeled. Two DISTINCT things:
- **Data Room = the CLIENT's own documents about itself** (external source material). It's what the client provides; it also lets the buyer evaluate the client. Dan can provide an outline of what a real data room looks like.
- **Deal Folder = OUR internal work product** (everything we produce *from* the data room). **Internal-only — the client CANNOT access it.** It may contain sensitive strategy (e.g. "the company's worth $50M but we'll tell them we can get $100M").

**What we ingested as "Data Room" (Project Destiny) is actually the DEAL FOLDER (our work).**
- **[MVP] Rename the current explorer to "Deal Folder"** (internal work product; internal-only access).
- **[MVP] Add a separate "Data Room"** (client documents; external). Use placeholder folders/files until Dan provides the real outline. Different access model (client-visible slice; buyer staged access later).
- **[MVP-aware] Meta-tagging + storage philosophy from day one.** Every document created must carry meta-tags + organization so Enterprise Search works later (see §5). We're not building search yet, but we must not box ourselves out.

## 3. Workflow: parallel + persistent tasks (not purely linear)

- **[MVP] Some steps run in PARALLEL, not linearly.** e.g. draft buyer materials / buyer log / advocacy piece WHILE still negotiating the engagement letter. The rail must not force "can't start step N+1 until N is signed" for parallel-safe steps.
- **[MVP] Persistent / always-required tasks.** The Engagement Letter always happens no matter how many steps are skipped (it's the example, not the only one). The 4 pre-deal gate actions always happen. Not everything is skippable.
- **[MVP] Skip semantics are richer.** A deal can enter with a term sheet already on the table → skip pitch + marketing + ~15 steps; a repeat client may already have a valid NDA → skip that. But persistent tasks (EL, gate 0) still fire.
- **[MVP] "In process — remind me daily" flag** for non-blocking parallel tasks. A button on a step to mark it in-progress-parallel with a daily nudge, so parallel work isn't lost.

## 4. New Business Development = separate timeline, CUT from MVP

The first origination/pitch steps (Target Universe, Exit Readiness, pitching, winning the mandate) are **new-business-development**, which precedes and is PARALLEL to deal execution and feeds many deal types (M&A sell-side, buy-side, IPO, SPAC, debt).
- **[MVP] Make New Business Development a SEPARATE timeline** from M&A deal execution, and **cut it from the MVP deal rail.** The deal rail MVP starts around the mandate/engagement, not the pitch. (Revisit which of the current 65 steps are new-biz-dev vs execution.)

## 5. Working Group List (redesign "Buyers" → WGL) + network-effects seed

- **[MVP] The "Buyers" surface should become the WORKING GROUP LIST (WGL)** — everyone on the project, BOTH sides: the client, our team, the buyers, their bankers/advisors, by name. Click a person → contact card, click-to-call, email. Today it's just a Word doc ("Lance Marks, Futureproofing, cell, email").
- **[MVP] Add a WGL-creation STEP early in the timeline** (it happens very early; perpetually updated). If it's not in the 65 steps, add it.
- **[MVP-aware] The WGL is the seed of the network-effects model.** Later, counterparties (buyers, their bankers) log into the platform themselves — a tech-sales not human-sales motion. Build the WGL so that per-person permissions + email are first-class, enabling "you can log in too" invites later.
- **Team surface** (internal deal-team chat) is distinct from the WGL (all parties). Redesign Team to be the internal team collaboration; WGL is the cross-party roster. (Lance: Team = chat between team members, needs redesign.)

## 6. Meeting-notes → automated follow-through (biggest banker pain point)

The #1 pain a banker raised post-demo: **no automated follow-through after meeting notes.** Real story: an org call didn't get set up, the client asked for the agenda, the banker pulled an all-nighter.
- **[MVP] From call/meeting notes, the platform should auto:** detect follow-ups ("we need an org meeting next week"), **draft the agenda** from the notes, **coordinate calendars** (Calendly-style), and **send it automatically** — surfaced as "Don't forget to set up this call — I've drafted the email + agenda and coordinated calendars." An interface between all data repositories: "set up the agenda as per last week's call" → it finds the calls, drafts the agenda.
- **[MVP] Automated step reminders** (esp. compliance): "notify compliance" is easy to forget — automated reminders ensure steps aren't skipped. This is a core benefit ("that mistake will never happen again").

## 6b. Pre-compliance (high-value, [Later])

Ignatious's compliance contact: **pre-compliance is huge** — but comes LATER, once the firm is enmeshed in the platform (no more email). Screen/clear before the fact. Build the compliance spine now so pre-compliance is reachable.

## 7. Token/cost visibility — the "Odometer" [MVP]

Storm: "100% — I talked about an odometer for bankers." Unlike Rogo (which hides token cost because it's VC-subsidized to grab share), we SHOW spend. Frame our existing rail token tally as an **odometer** (running spend by deal/person/task), visible and honest.

## 8. Deal code names — themed Easter egg [MVP, small]

- Code-name generation should offer **themed options** (birds, football teams, movies), not one suggestion. Names within a deal follow a **consistent theme** (project "bird" → all counterparties named birds). Pick a theme → generate on-theme names starting with the right letter.
- Framed as a Tesla-style Easter egg — fun, memorable, low-effort. Refine the Gate-0 code-name step accordingly.

## 9. Knowledge graph ≠ Relationship graph [MVP-aware]

- **Relationship graph** = who knows whom ("my cousin is best friends with Lance's sister").
- **Knowledge graph** = all knowledge around the project / the firm.
- They are different concepts; our earlier doc conflated them. Keep them distinct in the model.

## 10. Skills marketplace / "App Store rules" template [Later]

Eventually third parties add skills/agents (Storm's "$1M competition" — customers build thousands of skills, viral marketing). Needs a **compliant skill/agent submission template** ("App Store rules") — how a skill must interface with the platform. RTS + Futureproofing build it together. Not MVP.

## 11. Connectors & comms on-platform (vs Rogo email) [MVP-aware / V-next]

- Rogo's core weakness: runs through **email only**, no Slack/Teams connectors. We want comms to live **on our platform** (Slack/Teams connectors), so within ~a year a user "never needs email again." Not V1-complete, but design toward it.
- Data sources (CapIQ, PitchBook): connect to the bank's EXISTING subscriptions rather than bundling; downstream, non-blocking. SEC data is easy to organize ourselves now.

## 12. Naming (open, not for action yet)

The product name is unsettled: **Conductia** is preferred over Conductia, but antitrust flagged BOTH "Conductia" and "Conductia" for the "Intel" root; anything with "D...deal" also risky (may not always be a deal). **Do NOT rename the codebase yet** — flag as an open decision. (Meeting title used "Conductia.")

## 13. Team/process notes (context, not features)

- Route Ignatious feedback through **Dan** (coordinator), not individual bankers.
- **Junior bankers** are the best source for execution-oriented workflow extraction.
- Horizontal apps: some horizontals RTS has prior codebases for (they may build them even though horizontal). Storm + Lance to prioritize the horizontal-app list together (~1-2 weeks out).
- Ownership handoff goal: Rob leads Futureproofing engineers; Markus/Svet lead skills; Storm + Lance on strategy (MVP scope + horizontal prioritization).

---

## Net platform-refinement implications (feeds the plan)

1. **Deal Folder vs Data Room split** (rename current → Deal Folder; add external Data Room w/ placeholders). — highest priority.
2. **Composer: remove model/source pickers** ("banking in front, AI in back").
3. **Skills: stop exposing skill contracts/instructions** (built-in, not a catalog of how-tos).
4. **Buyers → Working Group List** (both sides, contact cards, click-to-call; add a WGL step).
5. **Redesign Team** (internal team collab) distinct from WGL.
6. **New Business Development → separate timeline, cut from MVP rail.**
7. **Parallel + persistent tasks** on the rail: parallel steps, "remind me daily" flag, always-required tasks (EL, gate 0), richer skip/enter-mid-process.
8. **Meeting-notes → follow-through agent** (agenda draft + calendar + auto-send) + automated step/compliance reminders. — new hero feature.
9. **Token odometer** (reframe the rail token tally).
10. **Code-name themes** at Gate 0.
11. **Meta-tagging on documents** (deal folder + data room) — MVP-aware for future Enterprise Search.
12. **Keep knowledge-graph vs relationship-graph distinct.**
13. **[Later, note only]:** pre-compliance, skills marketplace template, Slack/Teams connectors, data-vendor connections, naming.
