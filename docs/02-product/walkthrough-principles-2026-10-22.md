# Walkthrough principles and lessons

Date: 2026-10-22 · Source: the walkthrough of `develop` and conductia.com

The walkthrough found rich features behind engineering-flavored, noisy, website-like surfaces. It keeps the durable lessons for the people and coding agents who build next. Quotes are unattributed because speaker labels were unreliable (the heads-nod rule is credited to Storm), cleaned of transcription noise, and marked "paraphrase" where reworded. The principles sharpen the existing thesis: decisions not data, compliance as the moat, banking in the front and AI in the back.

## How to use this

- **PMs:** test scope and copy calls against Product, Journeys and Messaging.
- **Designers:** treat Design and UI/UX as defaults; depart on purpose, in writing.
- **Engineers and coding agents:** read the Anti-patterns first; use only glossary terms.

## Product

**1. Surface decisions, not data.**
> "Surfaced to you is everything that needs you now and the things currently running."

How to apply: a home view answers "what needs me" and "what is running" first.
Example: the teaser v2 awaiting sign-off leads the Conductor Center; deal metadata sits in the deal switcher.

**2. Build concise tools: an intuitive base view first, customization later, big ideas parked.**
> "Are we building a massive collection of features, or clear, concise tools?" · "Let's not get distracted by the big idea." (paraphrase)

How to apply: ship one default that works without choices; park good-but-not-core ideas with a note.
Example: the rail defaults to a sequential board; Superhuman-style @mentions on mail threads wait.

**3. Every firm's workflow differs, and the rails they build are the moat.**
> "Absolutely zero chance another customer says we have the exact same workflow." (paraphrase)

How to apply: make building and reusing a rail cheap; never hard-code one firm's process.
Example: a banker adds two regulatory steps, saves a custom rail, and picks it on the next deal.

**4. Compliance belongs at the source, not in a cleanup step.**
> "This should have already been taken into account when it drafted the teaser."

How to apply: MNPI and promissory-language rules live in the skill prompt, not in after-the-fact fixes.
Example: "clean voice" and "remove compliance language" come out of teaser v2; the teaser skill carries those rules.

**5. Log overrides, not abandoned drafts.**
> "If you override the AI, you might get yourself in trouble, but maybe that's just the way it is." (paraphrase)

How to apply: record who overrode a flag and when; a cancelled draft leaves no trace (D80, email decision Q1 = A).
Example: the audit trail names the person who sent past a flag; a cancelled draft never appears.

**6. Be proactive, never Big Brother, and read the minimum.**
> "As long as people don't feel like we're Big Brothering them."

How to apply: offer findings, not surveillance; read on demand and store the least possible.
Example: discovery asks "New deal in your mail. Add it?"; attachments are read only when attached to a message.

**7. Onboarding is self-serve.**
> "Does it require somebody from Conductia to walk someone through it, or is it that easy?" "The second." (paraphrase)

How to apply: every first-run path works without a call; if it needs explaining, redesign it.
Example: connect your mailbox, review proposed deals, select the ones to create.

## Design

**8. If it adds noise without adding value, remove it.**
> "If anything on the page increases noise but does not increase value, remove it."

How to apply: for each element, ask what it is for; cut anything without an answer.
Example: the rail header showed the deal code twice; show the code name once, and the code lives in the deal switcher.

**9. Never make users look something up. Name the thing, not its position.**
> "Never make somebody use a reference for something they have to go look up."

How to apply: names over numbers; a phase always carries its name; position is secondary or absent.
Example: "Phase 2 · Station 32 · 31 of 61 complete" becomes "Preparation · Draft the teaser".

**10. If we are confused, bankers are confused.**
> "We know enough about investment banking that if we're confused, even the bankers are confused."

How to apply: treat team confusion as a defect, not "a banker would know".
Example: "Live agent step orchestration" lost three people in the room; it becomes "Draft the teaser".

**11. Make it a pleasure: an app, not a site.**
> "Get people to go, this doesn't seem arduous or monotonous." · "Animation meets user experience."

How to apply: prefer direct manipulation and continuous motion to mode buttons and page loads.
Example: "Full array" and "Focus" give way to zoom: a step with its neighbors beside it, zoom out to the phase.

**12. Show progress visually, at portfolio scale.**
> "With 10, 20 or 30 engagements, how do I see the progress?" (paraphrase)

How to apply: every deal shows phase progress you can scan at 50 rows.
Example: a Conductor Center row shows phase name, percent through it and the current step.

## UI/UX patterns

**13. One modal system.**
> "Nothing standardized: the modals, the components, the way things move in and out of the screen."

How to apply: one overlay component with defined variants; never hand-roll another.
Example: Rails configuration used a center modal and Organization a right panel; both use the same overlay.

**14. Open detail inline and close it where the user is.**
> "Don't make me go over to another part of the screen to close something."

How to apply: detail opens beside its row, closes there, and swaps in place for the next row.
Example: on Team, clicking Alex Chin replaces Storm Duncan's open detail where it sits.

**15. Feel native: follow standard conventions, and clone only a familiar tool's primary functions.**
> "Apple has made this standard: a dot with a number." · "Anything that's settings, go to your mail client." (paraphrase)

How to apply: use the convention before inventing one; keep core actions plus the differentiator; settings stay native.
Example: a Mail badge opens its item; SSO leads sign-in; Mail looks like Outlook without filters; the avatar edits the photo.

**16. Free text with examples, not presets.**
> "Free text, with some lines: try one of the following." (paraphrase)

How to apply: one input with visible example prompts the user types themselves.
Example: revising teaser v2 is one "What should change?" box with sample lines beneath.

**17. Confirm shared-impact edits once, and let users stop being asked.**
> "Do I want to save this as a new rail? Ignore it? Also, stop asking me this." (paraphrase)

How to apply: three or four named choices including "don't ask again", then a brief confirmation.
Example: after reordering steps: "Save as new rail · Update this rail · Ignore · Stop asking".

**18. Lists that will grow are grouped, searchable, filterable and multi-select.**
> "That list is going to balloon."

How to apply: design every roster for 1,000 rows.
Example: Organization members are searchable and multi-selectable, so one permission change covers many people.

## User journeys and multiplayer

**19. Work runs in parallel: show who is on what, and keep dependencies a view.**
> "Different people working on steps 1, 5, 9 and 12, all in parallel."

How to apply: a sequential, Trello-style board with owners on cards; blocking shows in a dependency view.
Example: Summit shows three people on different steps, and step 33 reads "Waiting on the teaser".

**20. No carte blanche over the shared workflow.**
> "I can't have a disgruntled employee come in and mess something up." (paraphrase)

How to apply: changes affecting everyone on a deal need a named approver; prototype honestly until ruled.
Example: a junior banker removing a step needs the deal opener's approval, provisional until Storm rules.

**21. Team is who is on this deal; Organization is firm seats, in Settings.**
> "Team feels like who's part of this deal. My organization feels like who has a seat in my company." (paraphrase)

How to apply: deal-level and firm-level people surfaces never share a nav level.
Example: "My organization" moves from the top nav to Settings › Organization.

**22. "Invite to deal" is for colleagues; outsiders get data room access.**
> "Invite to platform feels like I'm selling a platform. It's very vague."

How to apply: name what the invitee gets, and start outside invites from the room they open.
Example: Team offers "Invite to deal" for your firm; outside counsel is invited from the Data Room.

**23. Design and test against realistic data.**
> "Assume I have 10 engagements at various stages. Do I have a grasp on what's going on?" (paraphrase)

How to apply: never judge a multi-deal or multiplayer view on a one-deal demo.
Example: this build's demo book seeds 12 deals, with several people working Summit at once.

## Messaging and copy

**24. Every headline should make heads nod (Storm's rule).**
> "The title of every slide should be something that makes everyone's heads nod."

How to apply: state something the reader already agrees with, then how Conductia delivers it.
Example: "Bankers should bank" landed instantly; build the landing page from it.

**25. Lead with what you are, and split the work clearly.**
> "I'd rather hear what you are." · "What does Conductia do versus what does the banker do?" (paraphrase)

How to apply: follow any "not" line with a positive statement of who does what.
Example: "We are not an AI product" needs a next line; of the three "we are" cards, only compliance landed.

**26. Answer "why this matters to me" for the buyer, and why us over other AI-banking tools.**
> "I have to make that leap myself." · "Who makes purchasing decisions?"

How to apply: write for the purchaser's problem; one sentence beats six bullets; state the difference up front.
Example: compliance at the source and "banking in front, AI in back" sit above the fold.

**27. One vocabulary, propagated everywhere, including the website.**
> "When we update terminology it needs to update app-wide and cross-platform." (paraphrase)

How to apply: change the glossary first; copy, tests, emails and conductia.com follow in the same change.
Example: "Invite to platform" becomes "Invite to deal" in button, toast and test steps together.

## Process

**28. Get something on the page, then hand the designer a quick prototype and a banker.**
> "It's always easier to critique something that exists." · "Remake it in Claude real fast, a simple HTML." · "He won't understand it in full." (paraphrase)

How to apply: bring a working build, a throwaway prototype and a domain expert to design sessions.
Example: the Claude design mock of the Conductor Center went to Marco.

**29. Validate detail with real users.**
> "How much of this matters to you? What would you do with this information?"

How to apply: any field whose purpose nobody can state goes to a banker before polish.
Example: "Disclosure phase" in Team detail is checked with a banker before redesign.

**30. Brief coding agents against jargon, then budget a strip-out pass.**
> "Numbers everywhere, explainers everywhere." · "The last two days is stripping out features and simplifying all the views."

How to apply: every dispatch carries the glossary and banned words; a separate pass removes what doesn't earn its place.
Example: this build bans station, spine and orchestration in visible copy, and runs an explainer sweep.

**31. Confirm banker-dependent rules with Storm before encoding them.**
> "The rules behind that require an understanding of the deal and how bankers action it." (paraphrase)

How to apply: dependencies, approvals and role hierarchy are Storm's calls; until then, prototype, don't encode.
Example: whether step 35 waits on step 11 is Storm's question, not an engineering default.

## Anti-jargon brief for coding agents

Principle 30 in a form you can paste. Put it in every prompt that writes or changes copy a user can see. `tests/copy-guard.test.ts` and `tests/hv-no-em-dash.test.ts` check the same rules.

```text
Copy rules for Conductia. They apply to everything a user can read: labels, headings,
buttons, aria-labels, toasts, empty states and API errors that reach the screen.

The reader is a managing director running a sell-side deal. Write for a banker, not an engineer.
- Say what happens and who does it: "Conductia drafts the teaser. You review and sign off."
  Name the actor, the action and the record.
- Never make the reader look something up. No issue numbers like "(#192)", no internal ids,
  no step numbers where the step name will do.
- Senior, precise, decisive. Sentence case. Statements, not questions.
- No em dashes. Use a colon, a full stop or a comma.
- Dates read "Oct 7, 2026" and come from src/lib/format/date.ts.
- Banned words: orchestration, spine, station, array, seam, perimeter, tenant, mount,
  reader registration, register (in its jargon sense), binding, publication.
- One word for each thing: step (never station), rail, phase, deal, Conductor Center,
  Invite to deal (colleagues), data room access (outside parties). Do not invent synonyms.
- If a line explains the interface instead of helping the banker act, delete it.
- If something is not saved, say so: the Preview chip reads "Not saved yet". Never show
  unsaved state as saved.
- When you change copy, update the tests that pin it in the same commit.
```

## Anti-patterns we saw

- **Engineering vocabulary in the UI:** "Live agent step orchestration", "Full array", "reader registration".
- **Duplicate identifiers:** the deal code under its code name; Morgan Vale's name twice on one page.
- **Presets instead of free text:** "Clean voice" and "Remove compliance language".
- **Modal soup:** center modals, right panels and full pages for the same kind of task.
- **Settings rebuilt inside a cloned tool:** mail settings and filters that belong in Outlook or Gmail.
- **Numbers users must look up:** "Phase 2", "Station 32", "31 of 61".
- **Explainers about the interface** and **locale dates** (use "Oct 7, 2026").

## Open questions that are not principles yet

- Do dependency rules and drop-dead dates vary by deal, or can a firm fix them? (Storm)
- Who approves major rail changes: deal opener, MD, or a role? (Storm)
- Who may invite a CCO or an admin? (Storm, with engineers)
- Should logged overrides stay in the audit trail despite the banker's liability? (Storm)
- Should revising an output also improve its skill? (Storm)
- Discovery reach and cadence: onboarding only, or ongoing? (engineers confirm, Storm decides)
- Rail orientation, card stacking and iPad gestures. (Marco)
- What Team detail shows, and for whom. (Marco, with Storm)
- Deal Folder and Data Room layout, color coding and preview. (Marco)
- Buyer-side view: one shared rail or separate ones? (Storm, future)

## Lessons from building it (Oct 23 to 25, 2026)

The walkthrough was built by parallel lanes and scored by three independent judges against a binary UX matrix. These are the lessons from that run, for the next build of its kind.

- **Fix the defect class, not the instance.** Every judging round after the first found the same kind of defect in a place the last fix had not reached: a plain line missing on one more step type, one more locked control with no reason, one more page with no heading. How to apply: when you fix one, grep for every sibling and fix or list them in the same change.
- **Run the end-to-end suite after every fix round.** Two journeys broke during the UX rounds and surfaced only at the end, because e2e last ran before them. How to apply: a fix round is not done until the hermetic e2e passes on a fresh database.
- **A test must be able to fail on the bug it guards.** One switcher test ran with feature flags off, where the bug could not happen, so it passed against the broken code. How to apply: prove each new test fails without the fix, in the mode where the bug lives.
- **Mock the framework's timing, not just its values.** Tests that read the browser address bar directly hid a one-render lag in the router, and a zoomed step re-opened after Escape. How to apply: when navigation is involved, mock the delayed value the framework really hands you.
- **A recorded human decision outranks a judge's taste call.** A judge asked to rename "API calls"; Lance had chosen that label on Oct 5. How to apply: check the decision log and past PRs before acting on a style note, and send real conflicts to the owner.
- **Never let a "not on this deal" state hide a firm-wide duty.** Hiding Mail for people not on a deal also hid the compliance officer's held-mail queue, which covers every deal. How to apply: before gating a page by membership, list everyone who must still reach any part of it.
- **Merge the mainline early.** The branch fell 26 commits behind develop, and renamed files turned a five-file trial merge into 18 conflicts. How to apply: merge develop into a long branch at least daily, and sweep the mainline's new screens for retired words.
- **Stop looping when the residuals change every round.** Three full re-scores each found one or two different small items. A scoped fix round plus one focused judge closed them faster than a fourth full round. How to apply: after two stalled rounds, adjudicate, fix what is concrete, and send taste to the owner.
- **Keep operator logs and server keys out of copy sweeps.** Renaming "station" to "step" applies to what users read, never to stored values, routes, query parameters or logs that operators search. How to apply: scope copy guards to rendered text and accessible names.
- **Unit fixtures must use real API shapes, and lanes that touch mail or discovery run the integration suite.** Several bugs hid in fixtures that the real server never returns.
