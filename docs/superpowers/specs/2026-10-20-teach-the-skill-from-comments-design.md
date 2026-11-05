# Teach the skill from comments: design

**Status:** Approved 2026-10-20. Implemented by docs/superpowers/plans/2026-10-20-teach-the-skill-from-comments.md.

**Repositories:** Conductia only. Ignatious is not changed.

**Depends on:** skill output revisions (slice 1, D92, PR #499, on `develop`) and skill enhancement and version selection (Part E, `2026-09-14-skill-enhancement-and-version-selection-design.md`).

**Replaces:** slices 2 and 3 of [#463](https://github.com/Conductia/Conductia/issues/463). Slice 2 (a remembered comment applied as a lesson at run time) is dropped. Slice 3 (a manual "Fold into skill") is replaced by this design.

**Mockup:** `2026-10-20-teach-the-skill-from-comments-mockup.html`, beside this file.

## Objective

When a banker's comment on a skill's output states a rule that everyone on the project should get, let the banker turn it into a new version of the step's skill, without copying anything by hand.

The banker ticks "Teach the skill" on the comments that are standing rules. Applying the comments fixes the document exactly as slice 1 does. Later, when the banker asks for it, "Improve this skill" opens with a prompt Conductia has written from those comments. The banker sends it, answers anything the model asks, reviews the proposed skill and publishes it through the existing flow. The step then runs the new version.

## Why

- A skill can now be versioned per project (Part E), so a lesson can live in the skill itself. A separate memory applied at run time (the old slice 2) is no longer needed, and it carried the bloat and digest problems #463 described.
- Bankers already say what good looks like in their comments. Making them retype it into "Improve this skill" means most lessons are never taught.
- Most comments are one-off fixes ("that figure is wrong"). A one-off fix taught to the skill degrades every later run (#355). So the banker chooses per comment, and the copy tells them how to choose.

## Decisions (Charles, 2026-10-19 and 2026-10-20)

1. **Per-comment choice.** Each comment has its own "Teach the skill" tick, in the comment composer. The banker can leave any comment out. Pending comments that are ticked show a "Teaches skill" tag.
2. **The copy explains the choice; there is no pop-up.** While any pending comment is ticked, a note beside Apply says what teaching does and that one-off fixes stay unticked.
3. **Apply only fixes the document.** Ticking a comment changes nothing about the skill on its own.
4. **The banker asks for it.** A "Teach the skill · N comments" button beside "Review output" on the step opens the skill builder. It shows only while the output has ticked comments that have not been sent yet.
5. **The normal skill update flow does the rest.** The skill builder opens with Conductia's prompt already written in. The banker sends it, works with the model as today and publishes. Publishing is the human approval that lets model-written skill text reach a prompt (#357). No Ignatious change and no background job.
6. **The new version is for this project.** Publishing already switches the step to the new version. Other projects never see it. A step that runs a firm catalog skill forks a project copy on publish, as Part E does today; the firm catalog is never written to.
7. **No notification.** The new version appears in the step's version list like any other, under the publishing banker's name.
8. **Lessons go in one section.** The prompt asks the model to keep the lessons in a section of the skill titled "Learned from reviews", merging new ones with any already there, and to leave the rest of the skill unchanged. This is an instruction, not a guarantee: the skill builder rewrites the whole skill file, and the banker's review before publishing is the safeguard.
9. **Only applied comments teach.** A comment the model could not apply never teaches, even if ticked. In slice 1 an unapplied comment stays in Pending and is usually reworded and applied again, so counting unapplied copies would teach the same rule twice and would ignore an untick on the retry. The cost: a rule the document lacked the facts to apply is taught by typing it into "Improve this skill". (Decided after the builder check, reversing an earlier proposal.)

## Goals

- A banker can turn a comment into a skill lesson in two clicks after writing it: the tick, then "Teach the skill".
- The banker's own words reach the model verbatim.
- Every lesson reaches a prompt only through a version a person published.
- One-off fixes are easy to keep out, and the screen says why they should be.

## Non-goals

- Lessons applied at run time without a new skill version (old slice 2).
- Publishing without a person, or any background process that writes a skill.
- Changing the firm catalog, or sharing a learned version with other projects.
- Teaching from hand edits. A hand edit says what changed but not why.
- A structural guarantee that only the "Learned from reviews" section changes.
- Notifying anyone that a skill changed.
- Whole-document comments, measuring edits, and output that is not text (unchanged from #463's "Not in any slice yet").

## Anti-goals

These would make the feature a failure even if it works:

- A skill changes without a person publishing the change.
- A comment the banker did not tick reaches the skill.
- The banker's sentence is paraphrased or cut before the model sees it.
- The banker has to copy or retype a comment to teach it.

## Constraints

- **ADR-0017 decision 7.** No new control-plane table or column may hold bank content. The tick is a boolean inside the existing `deal_step_skill_runs.inputs` record. The prompt lives where composer text and messages already live (`skill_authoring_drafts.composer_text`, `skill_authoring_messages.text`). Anything new that records which comments were sent holds ids only.
- **ADR-0017 decision 6.** No new path to a model. The prompt travels the existing authoring turn path.
- **Run records are immutable.** A revision row's `inputs` is never updated, so "sent" is recorded somewhere else, by appending.
- **The 20,000-character limit** on `composer_text` and on a message's `text`.
- **Seed runs.** A revision cannot seed "Improve this skill" (D92, `readSeedRun` in `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts`). The seed run is the output's original run.
- **One active draft per author per basis step** (`skill_authoring_drafts`, Part E). Opening the builder may return a draft the banker already has open on that step.
- **No new audit action.** Widening `audit_log_action_check` means restating the whole check; this design should not need it.

## The flow

### 1. Writing a comment

In `EditComposer`, Comment mode gets a "Teach the skill" checkbox under the text field, off by default, with helper text: "For rules everyone on this project should get, not fixes to this document." Edit text mode has no checkbox.

In the Pending list (`EditsPane`), a ticked comment shows a "Teaches skill" tag next to its "Comment" label. Editing the comment keeps or changes the tick.

### 2. Applying

While at least one pending comment is ticked, a note sits beside Apply in the `ReviewOutputDialog` footer:

> 2 comments are marked to teach the skill. After applying, use Teach the skill to update this step's skill for everyone on this project. Leave a comment unticked when it only fixes this document.

Apply sends each comment edit with `teach: true` when ticked. The revisions route accepts the field on comment edits only, and `applyRevision` keeps it on the `EditRecord` in `inputs`. Nothing else about applying changes.

The "Changed in this version" list also shows the "Teaches skill" tag on taught comments.

### 3. Teaching

**The button.** Beside "Review output" in `RunOutput`, "Teach the skill · N comments" shows when all of these hold:

- both `skill_output_revisions` and `skill_authoring` are on;
- the viewer may improve this step's skill (the same check as "Improve this skill");
- the step resolves to a skill reference;
- N > 0, where N counts ticked comments with status `applied` in this output's succeeded revisions that have not been sent.

Only applied comments teach (decision 9). A comment that was not applied stays in Pending with its tick, as slice 1 already does, and counts only once the banker gets it applied. If the banker removes it, it never teaches. Because a pending comment can be unticked until it applies, the tick that counts is the one it had when it was applied. Restoring an earlier version does not take an applied comment out of N.

The run list the step already reads (`GET .../skill-runs`) returns the count per run, so no extra request is needed.

**Opening the builder.** The button opens the skill builder the same way "Improve this skill" does from a run (`SkillStepRunner` → `DealRail.handleEnhance` → `SkillBuilderDialog`), with basis = the step and seed run = the output's original run. Nothing is sent automatically, so the banker can edit the prompt or delete a lesson first.

The server, not the dialog, fills the composer, because the draft outlives the dialog: the composer autosaves, and the same draft comes back through "Improve this skill" or a second click. When the draft is opened from the button, the server:

- takes the output's unsent ticked comments that are not already waiting on this draft;
- builds the prompt below from them and adds it after any text already in the draft's composer;
- records those comments as waiting on the draft, by id only.

A second click with no new ticked comments reopens the draft and adds nothing. Comments ticked since the first click are added as a new block. If the draft is discarded without a message being sent, its waiting comments go back to the count.

**The prompt.** Built by Conductia from the unsent ticked comments, oldest first. The wording is the builder's to tune; it must carry:

- the instruction: keep the lessons in a section titled "Learned from reviews"; merge them with any lessons already there; remove duplicates; when two conflict, the newer one wins; write each as a short standing rule, in general terms, naming no company, party, codename or person and repeating no figure from the comments or excerpts; leave the rest of the skill unchanged;
- for each comment: the banker's sentence verbatim, the passage it was written on, and what the passage became when it was applied.

Example shape:

```
Update this skill with lessons from reviews of its output.

Keep the lessons in a section titled "Learned from reviews". Merge these with any
lessons already in that section: drop duplicates, and where two conflict, keep the
newer one. Write each lesson as a short standing rule. State each lesson in
general terms: do not name the company, any party, codename or person, and do not
repeat a figure from the comments or excerpts below. Leave every other part of
the skill unchanged.

1. Comment: "End every bullet with a period."
   Written on: "Key risks: cloud migration pace, seat compression in SMB"
   Became: "Key risks: cloud migration pace, seat compression in SMB."

2. Comment: "Always lead risks with the biggest one by revenue impact."
   Written on: ...
   Became: ...
```

**Fitting the limit.** Comments are never cut. Passages and results are shortened to an excerpt when needed. If the prompt still does not fit in 20,000 characters, it carries as many comments as fit, oldest first, and the rest stay unsent so the button still counts them.

### 4. Sending and publishing

The next message sent on that draft, however the builder was opened, marks every comment waiting on the draft as sent, and they leave N. They count as sent even if the banker edited or deleted the prompt, or later leaves without publishing; if they want those lessons back, they write them into "Improve this skill" themselves. Comments waiting on a draft stay in N until then, so the button stays available to reopen it.

The rest is the shipped Part E flow, unchanged: the model may ask a question first, proposes a candidate, and the banker publishes. Publishing rebinds the step, so the next run uses the new version.

**Recording "waiting" and "sent".** Append-only, ids only: the revision run id, the edit id, the draft id, and, once sent, the authoring message id, with the actor and time of each. "Waiting" is written when the draft is opened from the button. "Sent" is written in the same transaction that admits the next message on the draft (`skill_authoring_submit_message` or its caller). The builder chooses the shape within ADR-0017 decision 7.

Audit: the existing `skill_authoring.message_admitted` row gets, in its detail, the count of comments the message marked as sent. No comment text is audited.

## Permissions

- Anyone who can comment on the output can tick a comment.
- Only someone who may improve the step's skill sees the button. The count is per output, not per person: comments ticked by any banker are offered, and once anyone sends them they leave the count.
- The skill version is published by, and attributed to, whoever publishes it, as today.

## Copy

Statements, no em dashes, per the brand voice.

| Where | Text |
|---|---|
| Composer checkbox | Teach the skill |
| Composer helper | For rules everyone on this project should get, not fixes to this document. |
| Pending and Changed tag | Teaches skill |
| Note beside Apply | N comments are marked to teach the skill. After applying, use Teach the skill to update this step's skill for everyone on this project. Leave a comment unticked when it only fixes this document. |
| Note beside Apply, for someone who may not improve the skill | N comments are marked to teach the skill. After applying, someone who may improve this step's skill can use Teach the skill to update it for everyone on this project. Leave a comment unticked when it only fixes this document. |
| Button | Teach the skill · N comments |

## Calls made in the design session

Proposed by Claude and accepted by Charles on 2026-10-20 without discussion; worth a check while reading:

- The prompt is filled in, not sent automatically.
- A comment counts as sent once the message carrying it is sent, whether or not a version is published.
- Only comments teach; hand edits do not.
- Long passages are shortened; the banker's sentence is not.
- No new flag: the feature needs both `skill_output_revisions` and `skill_authoring`.
- The learned version builds on the step's current skill, which may be newer than the version the commented run used.

Settled by Claude after the builder check, not discussed:

- The server fills the composer and records which comments wait on the draft, so a closed dialog, a reopen through "Improve this skill" or a second click neither loses nor duplicates them.
- The next message on the draft marks its waiting comments as sent, whatever its text.

## Left to the builder

- The final prompt wording and excerpt length.
- The shape of the "sent" record, within the constraints above.
- How the run list reports the count.
- Where the decision-log entry goes (a new row at the end of the table, number confirmed at merge) and the `CONTEXT.md` term for a taught comment.
- Tests, including extending `e2e/journeys/skill-output-revisions.spec.ts` to tick, apply, and open the builder with the prompt filled in.

## Open, outside this design

- Updating #463 to say slices 2 and 3 are replaced by this design.
- Whether Storm approves the change in scope (CLAUDE.md: Storm approves scope changes).
