# Rail multiplayer and dependencies: decisions for Storm

Date: 2026-10-22. Audience: Storm Duncan (decisions), Marco (views), engineers (what it takes).
Source: the product walkthrough of 2026-10-22, the agreed rail design for the branch `feat/walkthrough-refinements`, and the notes matrix (RAIL-21 to RAIL-39, RAIL-53 to RAIL-62).
Prototype: [`docs/prototypes/rail-multiplayer/index.html`](../prototypes/rail-multiplayer/index.html). Open it in a browser. It uses Project Summit example data, and every rule in it is labelled "Example, not decided".

This sheet asks Storm nine questions. Each has two or three options and a recommendation. Nothing in the app enforces any of these rules today, and the branch does not change who can do what.

---

## 1. The problem, in the meeting's words

The rail today is a tidy single-player list. The walkthrough asked for three things it does not have.

**People work on it at the same time, out of order.**
> "This is very static and very non-static single player."
> "It's okay if I'm someone, player 1, is over in step 5 working on something. And player 2 is in step 1 still working on something, that's totally fine. Everyone can see that those tasks are being picked up and stuff."

**Some steps really do wait on others, and some have dates that end the deal.**
> "It's missing a very, very, very key piece. To me, which is dependency."
> "I would love to see like a branch that goes, I can't even look at step 35 until step 11 is done."
> "This is dependent on that, or this has a drop dead. Timeline, like here's a date maybe across some of these things. Like if this doesn't happen by X date, deal's over."

**Someone has to own changes that affect everyone.**
> "Who gets to modify the rail for everyone on the team? And does that apply to everyone or does it only apply to an individual?"
> "Someone's trying to do something that's going to affect everyone. We need one player at least to accept that. There might be some small permissioning steps where like the person who opens the deal has to say yes to major dependency changes or shifts."
> "I can't have a disgruntled employee come in and [mess] something up. ... I think that's something you just let people set within their own organization. But yeah, I'd probably be pretty paranoid personally about anything that felt carte blanche."

**And the rules are a banking question, not a UI question.**
> "The UI can be refined to show a dependency view, which step is being taken by who, what steps need to be completed prior to step being available, but the actual rules behind that also require an understanding of the deal and how that actually is actioned by bankers."
> "I would have a huge question for Storm, which would be, does this change deal to deal? Or is it a process that we can sort of help set people set in stone for themselves?"

On layout, the meeting kept the sequence as home base:
> "Probably the default view is sort of this sequential thought." ... "If we want to allow for asynchronous workflows, it would look a little more like Gantt. That might get a little more confusing."

---

## 2. What the app does after this build

These ship on the branch from data the app already has. No database or permission changes.

| What you see | Where it comes from |
|---|---|
| **An owner on every step card**, or "Unassigned". The deal MD gets an "Assign..." menu with a confirm, because assigning sends a real notification. | Existing step assignments, loaded once for the whole rail. |
| **A factual activity line** on each card: "Draft saved by Alex Chen · 2h", "Assigned by Storm Duncan", "Done by ...". | The deal's audit trail, read when the rail loads. |
| **"Current step"** marks where the deal is. It never says "In progress", because that would claim someone is working on it. | The existing current-step marker. |
| **Out-of-order work shows as it is.** A later step done early reads Done; the current step does not move. | The app already allows this. |
| **Phase headers with "N of M done".** | Existing step statuses. |
| **Filters: All, Mine, Unassigned, Has activity**, marked "Only you see this view". | Stored in your browser only. |
| **Two browsers feel live.** The rail refreshes when you come back to the tab and every 30 seconds while it is open. | Re-reads the same data. No live presence. |
| **An honest edit prompt.** After an add, remove or move: "This changes the rail for everyone on this deal", with "Apply to this deal", "Apply and save as a company rail..." and "Don't ask again". | Existing save-rail dialog. |
| **A line saying who can change the rail.** Today that is anyone with the company's rail-editing right, on any deal they are on. The line says so rather than hiding it. | Existing company permission. |

These are **Previews** on the branch. They work in your browser only, carry the chip "Not saved yet. Engineers are wiring this.", and reset on reload:

- **Dependency links** that the deal lead draws by hand, marked hard or soft. "Waiting on" appears only for links someone drew. The app never guesses links from the "Seq NN" references in step briefs: those are source references, some point forward, and steps skipped on entry would wait forever.
- **Step target and drop-dead dates**, shown beside the real target close.
- **"Propose a change"** for people without edit rights, plus a "View as deal lead" switch that shows the review tray with Accept and Discard. Accepting saves nothing.

What the prototype adds on top, for discussion only: a Dependency view with drawn lines, a per-buyer gate, a Timeline view with a deal drop-dead date, simulated presence ("Alex is on Teaser"), and a read-only outside counsel.

---

## 3. Decisions for Storm

Each decision lists the options, a recommendation and why. Question numbers match the walkthrough handoff (Part 2) and the notes matrix (Q-01 to Q-08).

### D1. Do dependencies change deal to deal, or are they set once?
*Handoff question 1. Notes Q-01.*

- **(a) Fixed per firm.** Set once by a firm admin; every deal inherits them.
- **(b) Per rail template, editable per deal.** Links live in each saved rail and copy into a new deal; the deal lead can adjust them on that deal.
- **(c) Drawn per deal.** Each deal starts with no links; the lead draws them.

**Recommendation: (b).** Banks run the same process shape most of the time, so the template carries the standard gates, and the deal lead still adjusts for the deal in front of them. It also fits what already exists: saved company rails. (a) breaks on the first unusual deal. (c) makes every lead redraw the same NDA gate on every deal.

### D2. Do links block, or only warn?
*Handoff question 2. Notes Q-01.*

- **(a) Hard.** A step cannot be marked done until the steps it waits on are done.
- **(b) Soft.** Marking it done shows "usually comes first" and asks to confirm.
- **(c) Both, chosen per link.** Each link is marked hard or soft; a firm setting decides who may create hard links.

**Recommendation: (c), with soft as the default.** Most real gates are habits, and a wrong hard block stops a live deal. Hard links are for the few gates that are legal or contractual (NDA before data room access, regulatory approval before closing). Asana and Monday make the same split. The prototype shows both: Teaser before Outreach Sequencing is hard; Financial Normalization before the CIM is soft.

### D3. Do gates apply per buyer or per deal?
*Handoff question 3.*

- **(a) Per deal only.** "Buyer NDA" is one step; when it is done, everyone moves on.
- **(b) Per buyer, for chosen steps.** Steps such as Buyer NDA and Buyer VDR Access track each buyer separately, and a gate between them applies buyer by buyer.
- **(c) Per buyer for every buyer-facing step.**

**Recommendation: (b).** "Buyer NDA before Buyer data room access" is true for each buyer, not for the deal: one signed NDA lets that buyer in and nobody else. A per-deal step either blocks everyone until the last NDA or lets everyone in after the first. (c) turns the whole marketing phase into a grid, which is too much for an MVP. The prototype shows four buyers by code name, two with signed NDAs and one with access.

### D4. Who is the host for a deal's rail?
*Handoff question 4. Notes Q-04, Q-06.*

- **(a) The mandate owner,** the person who opened the deal.
- **(b) The deal MD,** whoever holds the MD seat on the deal team.
- **(c) A firm setting,** where each firm picks (a) or (b).

**Recommendation: (b), with the firm-wide right kept as an outer limit.** The deal MD already is the host for assignment: only the MD can assign steps today. Using the same person for rail changes keeps one mental model. The mandate owner is usually the same person, and when they differ the MD is the one running the work. Today anyone with the company's rail-editing right can change any deal they are on; the host rule closes that "carte blanche" gap. Make (c) a later setting only if a firm asks.

### D5. What can a junior propose, and what can they change directly?
*Handoff question 4. Notes Q-04, Q-06.*

- **(a) Propose everything.** Juniors change nothing on the rail directly; every add, remove, move, link or date goes to the host.
- **(b) Small changes direct, structure proposed.** Juniors directly edit their own steps (draft, mark done, own dates); adding, removing, moving steps and drawing links go to the host.
- **(c) Change everything, with an undo log.**

**Recommendation: (b).** It matches the meeting: people work their own steps freely, and anything that "affects everyone" needs one person to accept. (a) floods the host with trivial requests. (c) is the disgruntled-employee case.

### D6. Who approves, and is the approval logged for compliance?
*Handoff question 4. Notes Q-04.*

- **(a) The host approves; the approval is an audit row** visible to the CCO, like other rail changes.
- **(b) The host approves; nothing is logged** beyond the change itself.
- **(c) Major changes need two approvers** (host plus CCO or a second MD).

**Recommendation: (a).** Removing a step or a gate changes how a regulated process ran, and the audit trail is the product's proof of what happened. Every proposal, accept and decline becomes a row naming who and what. (c) adds friction with no example from the meeting that needs it; keep it as a later firm setting.

### D7. Where do drop-dead dates come from?
*Notes Q-02.*

- **(a) Typed by the host per deal.**
- **(b) Pulled from documents.** For example, the outside date in the LOI or the expiry in an exclusivity letter, suggested by Conductia and confirmed by a person.
- **(c) Template defaults** ("LOI review within 14 days of LOI received"), adjustable per deal.

**Recommendation: (a) now, (b) next.** Drop-dead dates are external and contractual ("if this doesn't happen by X date, deal's over"), so they belong to the deal, not the template. Typing them is enough for an MVP. Suggesting them from the LOI fits the product, with the usual rule that a person confirms. (c) invents deadlines that are not in any contract.

### D8. Can steps be copied from another rail?
*Handoff question 8. Notes Q-07, Q-08.*

- **(a) Copy a range of steps** (for example, a whole phase) from another saved rail.
- **(b) Pick single steps** from any saved rail.
- **(c) Not now.** Add steps one at a time, as today.

**Recommendation: (b).** "Can I take part of something I did in that other rail and add it here?" Picking steps covers the case without a range picker, and it uses the add-step placement already being simplified on the branch. Links between copied steps come along only if both ends are copied. Separately, for hiding versus removing a step: keep remove only until someone shows a case where a hidden step must stay on the record.

### D9. Does a change apply to everyone, or to one person?
*Handoff question 4. Notes Q-05.*

- **(a) Always to everyone on the deal.** There is one rail per deal.
- **(b) Structure for everyone, views per person.** Steps, order, links and dates are shared; filters, collapsed phases and the chosen view are personal.
- **(c) Personal copies of the rail.**

**Recommendation: (b).** It is how the app works today and how the branch words it: every structural change says "This changes the rail for everyone on this deal", and filters say "Only you see this view". (c) breaks the single source of truth that compliance depends on. Saved views that the host shares with the whole deal are a later step (handoff E15).

---

## 4. Benchmarks

For calibrating the interaction only. None of these is a compliance product.

- **Trello:** faces on cards and no built-in dependencies. Simplicity wins; this is the "Trello board" the meeting described.
- **Linear:** "Blocked by" and "Blocks" are links people create by hand, and personal views are clearly separate from team views.
- **Asana and Monday:** people set dependencies, and the board owner picks strict or flexible mode. Supports hard versus soft as a setting (D2).
- **GitHub Projects:** one dataset, many saved views (board, table, roadmap). Supports Sequential, Dependency and Timeline as views of the same rail.
- **Vanta:** percent complete plus an owner on every item. Supports "N of M done" per phase and owners on cards.
- **Smartsheet and Gantt tools:** full dependency types and a critical path. Too heavy as the default, which matches the meeting's worry that a Gantt "might get a little more confusing". Fine as a secondary view.

## 5. Real sell-side gates (calibration only)

These are common patterns, not rules for Conductia. They explain why the options above lean the way they do.

- **NDA before CIM and data room access, per buyer.** Each buyer signs before seeing confidential material. This is the per-buyer case (D3).
- **First-round bids before management meetings.** Management time goes to the buyers who bid. Often a soft gate with a date.
- **LOI and exclusivity before confirmatory diligence.** Full diligence opens to the winning bidder under exclusivity, usually with an expiry date (D7).
- **Regulatory approvals before closing.** A legal hard gate, set by the regulator's timetable.

Most of these are per counterparty and driven by outside deadlines. That is why the rules belong to Storm, not to the UI.

## 6. What engineers would need

Each item is an entry in the walkthrough handoff (`docs/03-engineering/walkthrough-handoff-2026-10-22.md`). None is built on this branch.

- [E4. Step dependencies, per-step dates and "started" facts](../03-engineering/walkthrough-handoff-2026-10-22.md#e4-step-dependencies-per-step-dates-and-started-facts): a dependencies table carried in templates, enforcement per D1 to D3, step due and drop-dead dates with notifications per D7.
- [E3. Per-deal rail edit rights and "Propose a change"](../03-engineering/walkthrough-handoff-2026-10-22.md#e3-per-deal-rail-edit-rights-and-propose-a-change): the per-deal host per D4, proposals with audit rows per D5 and D6, one new notification type. This is an authorization change and needs a security review.
- [E1. Save a step reorder (deal rail and rail templates)](../03-engineering/walkthrough-handoff-2026-10-22.md#e1-save-a-step-reorder-deal-rail-and-rail-templates): needed before "move" proposals can be accepted for real.
- [E2. Copy steps from another rail](../03-engineering/walkthrough-handoff-2026-10-22.md#e2-copy-steps-from-another-rail): per D8.
- [E5. Live presence and pushed updates on the rail](../03-engineering/walkthrough-handoff-2026-10-22.md#e5-live-presence-and-pushed-updates-on-the-rail): private per-deal channels only; public channels would leak deal activity.
- [E15. Saved views: per user or shared with the deal](../03-engineering/walkthrough-handoff-2026-10-22.md#e15-saved-views-per-user-or-shared-with-the-deal): per D9.
- [E14. Cross-deal progress for the Book](../03-engineering/walkthrough-handoff-2026-10-22.md#e14-cross-deal-progress-for-the-book): per-phase progress across an MD's deals.

## 7. Summary of recommendations

| # | Decision | Recommendation |
|---|---|---|
| D1 | Dependencies per deal or set once | Per rail template, editable per deal |
| D2 | Hard or soft | Chosen per link, soft by default |
| D3 | Per buyer or per deal | Per buyer for chosen steps |
| D4 | Who is the host | The deal MD, inside the firm-wide right |
| D5 | What a junior can do | Own steps directly, structure by proposal |
| D6 | Approval and logging | Host approves, every proposal and decision is an audit row |
| D7 | Source of drop-dead dates | Typed by the host now, suggested from the LOI next |
| D8 | Copy steps from another rail | Pick single steps; keep remove only, no hide |
| D9 | Everyone or one person | Structure for everyone, views per person |
