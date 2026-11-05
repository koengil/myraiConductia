# Skill output revisions: design

**Status:** Approved 2026-10-13. Implemented by `docs/superpowers/plans/2026-10-13-skill-output-revisions.md`, which lists where it departs from this document.

**Repositories:** Conductia and Ignatious

**Depends on:** Skill run execution and results (Part D) and skill enhancement and version selection (Part E), both on `develop`.

**Source decisions:** the Oct 12 team call, the design discussion of 2026-10-13 recorded under "Decisions this design implements", and the research on the learning engine map ([#354](https://github.com/Conductia/Conductia/issues/354)). The slices that follow this one are in [#463](https://github.com/Conductia/Conductia/issues/463).

**Mockup:** `2026-10-13-skill-output-revisions-mockup.html`, beside this file.

## Objective

Let a banker correct a skill run's output where it is wrong, and keep every correction.

The banker comments on a passage, or types the fix by hand. The comments are applied together. The AI rewrites the commented passages and nothing else, and the result is kept as a new revision of that run's output. Every revision, every comment and every failed attempt is recorded, attributed and immutable, so the team can later review what bankers were trying to achieve.

This is slice 1 of three. It does not make a comment affect later runs (slice 2) and does not change the skill (slice 3).

## Language

These terms are added to `CONTEXT.md`. "Correction" and "promotion" are already taken by deal discovery and are not used here.

- **Revision**: a version of a run's output that came from applying edits to an earlier version, or from restoring one. The run's first output is not a revision.
- **Head**: the latest successful revision of a run, or the run's first output when it has none. The head is what the step shows.
- **Passage**: the whole Markdown blocks an edit covers, as one contiguous range of the output's source text.
- **Edit**: one change a banker asks for on one passage. A **comment edit** carries the banker's sentence and the AI writes the replacement. A **hand edit** carries the banker's own replacement text.
- **Unresolved**: a comment edit the AI declined to apply, with its reason.

## Evidence from the implemented systems

Read from Conductia `develop` at `274d68087` and the Ignatious checkout at `ef25a08`.

What exists and is reused:

- A run's output is Markdown in `deal_step_skill_runs.result_text`, capped at 200,000 characters (`src/lib/skillRun/parse.ts`), rendered by the `Markdown` atom on `react-markdown` and `remark-gfm`. Each renderer already receives the parsed node, which carries its source offsets.
- `deal_step_skill_runs` is append-only: triggers block UPDATE and DELETE (`supabase/migrations/20260916130000_deal_step_skill_runs.sql`). It already carries `source`, `actor_id`, `model`, `cost_usd`, `provider_run_id`, `outcome`, `error_message` and `inputs` (`jsonb`, constrained only to be an object).
- The run route authenticates, checks the internal wall and `canEditWork`, writes an audit row before the run starts, mints a scoped trigger token and meters the call on the AI spend ledger (`src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts`).
- A skill run's token carries `lead.read`, `documents.read`, `documents.write`, `maps.read`, `library.read` and `personas.read` (`src/lib/ignatious/jwt.ts`). The scopes are chosen by Conductia, and the Conductia agent seam enforces them.
- Work that must finish after the browser has gone runs in `after()` under `maxDuration = 300`, as the authoring turn does (`src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/route.ts`).
- The bench builds a turn's agent in `buildTurnAgent` under a `TurnToolPolicy` with two arms, `bench` and `authoring` (`platform/apps/skill-bench/src/turn-agent.ts`). The authoring arm shows how a turn returns structured output: one tool the model calls once, whose arguments the route captures (`authoring/candidate-tool.ts`).
- The bench's Conductia tools are split into reads (`CONDUCTIA_READ_TOOLS` in `platform/packages/skill-tools/src/conductia-tools.ts`, plus `conductia_get_library_item` and `conductia_download_document`) and one write, `conductia_file_document`.
- `openRunRoot` mounts exactly one pinned skill version for a run and removes it when the stream ends (`authoring/execution/run-root.ts`).

What constrains this design:

- **Storage.** ADR-0017 decision 7 bars any migration that adds a control-plane table or column holding bank content. Revised text and comments are bank content. `deal_step_skill_runs.input`, `inputs` and `result_text` are already an inventoried content store (row E8) with a planned move to the bank data plane.
- **Model path.** ADR-0017 decision 6 lists every path that sends bank content to a model. The agents-backend row already covers run inputs and bench text sent from `src/lib/ignatious/`. A direct model call from Conductia would be a new path.
- **The run record is posted by the browser** after the stream ends, so a tab closed mid-run records nothing. This design does not change that. A revision needs a recorded run to attach to.
- **Authoring's seed run accepts only scalar inputs** (`SeedRunSchema` in `authoring/turn-route.ts`), so a revision row cannot seed "Improve this skill" yet.

## Decisions this design implements

1. **The AI changes only the commented passages, by construction.** The engine returns replacement text keyed by edit, and Conductia splices it into the stored text at offsets it validated itself. No text outside a passage is ever written by the model.
2. **A comment edit may look things up, and may never write.** The edit runs with the run's read tools and no write tool. Charles decided this on 2026-10-13, reversing the first proposal of a call with no tools.
3. **A revision is a row in the existing run table,** not a new table. Chosen for now because it needs no ADR-0017 amendment.
4. **The engine call lives in Ignatious and is reached only through the Conductia backend.** The browser never calls Ignatious.
5. **Everything is kept.** Each edit has its own id. A failed attempt and an unresolved comment are recorded with their reason. A hand edit is in scope, so a banker has no reason to fix output off the platform.
6. **Comments are applied together,** like a code review: they collect as pending and one action applies them.

## Scope

- Commenting on a passage and editing a passage by hand, on the head of a recorded, succeeded run.
- Applying pending edits in one request, producing one revision.
- Restoring an earlier version.
- The revision record, its listing, and a before and after view per edit.
- One Ignatious endpoint and one tool policy.
- Authorization, audit, spend metering, a feature flag and verification.

## Out of scope

- **Remembering a comment on later runs, and folding lessons into the skill.** Slices 2 and 3, in #463.
- **Whole-document comments.** "Additional instructions" and a re-run cover that today.
- **"Improve this skill" from a revision.** The action stays on the run and seeds from the run's first output, as today.
- **Pending edits that survive a reload.** They live in the browser until applied.
- **Cancelling an edit in flight,** and showing one in flight after a reload.
- **Passages smaller than a block.**
- **Output that is not text.**
- **Recording the run itself on the server.** The browser-posted run record is a known gap and a separate change.

## Architecture

```
browser                    Conductia backend                     Ignatious bench
-------                    -----------------                     ---------------
select passage, comment
Apply  ------------------> validate edits against the head
                           audit row
                           202 { revisionId }
poll run list              after():
                             apply hand edits
                             POST /skill-run-revisions --------> mount pinned skill, read tools only
                                                                 model returns replacements by edit id
                             splice replacements  <------------- replacements, done { model, costUsd }
                             insert revision row
                             ledger row
revision appears  <-------
```

Conductia owns the passages, the splice, the record and every browser route. Ignatious owns the model call. The scope guarantee sits entirely in Conductia: it never asks the engine where a replacement goes.

## Passages

A passage is addressed by `start` and `end` offsets into the head's stored text.

`src/lib/skillRun/blocks.ts` parses Markdown with the same `remark-parse` and `remark-gfm` the atom renders with and returns the block ranges: headings, paragraphs, list items, table rows, block quotes and code blocks. For a nested list the innermost item is the block. The browser and the server both call it, so they agree on where blocks are.

The `Markdown` atom gains an opt-in prop that stamps each block element with its source range. Other uses of the atom are unchanged.

A selection snaps outward to the blocks it touches. A selection across several blocks is one passage from the first block's start to the last block's end. Each block also has its own keyboard-reachable control, so commenting does not depend on selecting text with a pointer.

## Persistence

No new table. `deal_step_skill_runs` gains two columns that hold ids only, and one value of `source`.

```
parent_run_id  uuid references deal_step_skill_runs (id)
root_run_id    uuid references deal_step_skill_runs (id)
source         'execution' | 'imported' | 'revision'
```

A revision row has `source = 'revision'`. `parent_run_id` is the version it was made from and `root_run_id` is the run whose output it is a version of. Both are null on every other row, by constraint.

The remaining columns mean what they already mean:

| Column | On a revision row |
|---|---|
| `actor_id` | The banker who applied or restored. Required. |
| `result_text` | The full revised output. Null when the attempt failed. |
| `outcome`, `error_message` | `succeeded` when at least one edit was applied or a version was restored. Otherwise `failed`, with the reason. |
| `inputs` | The record of what was asked. See below. |
| `skill_id`, `version_id`, `mount_name`, `mount_version`, `digest` | Copied from the root run. All null when the root is an imported row. |
| `model`, `cost_usd`, `provider_run_id`, `started_at` | The engine call. Null when no model was called. |

`inputs` on a revision row:

```
{
  "kind": "edits" | "restore",
  "edits": [
    {
      "id": "<uuid>",
      "kind": "comment" | "hand",
      "start": 120, "end": 310,
      "comment": "the banker's sentence, verbatim (comment edits only)",
      "status": "applied" | "unresolved" | "failed",
      "reason": "one sentence, when not applied",
      "resultStart": 120, "resultEnd": 288
    }
  ],
  "restoredFrom": "<uuid>",
  "skillMounted": true
}
```

`start` and `end` address the passage in the parent's text. `resultStart` and `resultEnd` address the replacement in this row's text. On a failed attempt every edit has the status `failed` and no result offsets. Because rows are immutable, the passage before the edit and the text after it are always recoverable from the offsets, so neither is stored twice. A hand edit's text is the range it produced.

Constraints:

- The reference check gains an arm for `revision`: an actor, both run ids, and a skill reference that is either complete or entirely absent.
- A partial unique index on `parent_run_id where outcome = 'succeeded'` allows one successful revision per parent. Revisions of a run therefore form a single line, and two bankers applying to the same head cannot both win.
- A trigger refuses a revision whose root is itself a revision, or whose root or parent is on another step or another run's line.
- The immutability triggers and the service-role-only posture are unchanged.

Nothing is backfilled. A run with no revision rows behaves as it does today.

## Conductia browser API

All under `/api/v1/deals/{dealId}/steps/{stepId}/skill-runs`.

- `POST /{runId}/revisions`, body `{ parentId, edits }`. `runId` is the root run. Each edit is `{ start, end, kind: 'comment', comment }` or `{ start, end, kind: 'hand', text }`. The route refuses unless `parentId` is the head, and the ranges are in bounds, aligned to blocks and do not overlap. At most 20 edits, 2,000 characters per comment, and a result within the existing 200,000 character cap.
  - With no comment edit, the route splices and inserts the row itself and answers 201 with the revision.
  - With at least one comment edit, it writes the audit row, answers 202 with `{ revisionId }`, and does the rest in `after()`.
- `POST /{runId}/revisions`, body `{ parentId, restoreOf }`. Inserts a revision whose text is that of the named version. Answers 201.
- `GET` on the run list gains, per run, `headId`, the head's text, and `revisions`: every revision's id, kind, outcome, actor name, time, edits and parent, oldest first. For each edit it includes the passage's text before the edit, read from the parent at request time. Text of versions other than the head is not included.
- `GET /{runId}/revisions/{revisionId}` returns one version's text, for viewing an earlier one.

The run list keeps its limit of 20 runs. Revisions are fetched by `root_run_id` for the runs listed.

## Applying a batch with comment edits

Inside `after()`, bounded by `maxDuration = 300`:

1. Apply the hand edits to the parent's text. The engine sees the document as the banker has already corrected it.
2. Mint a trigger token for a new agent name, `skill-run-revision`, with `lead.read`, `documents.read`, `maps.read`, `library.read` and `personas.read`. It has no write scope.
3. Call the bench with the document, the comment passages and the root run's skill reference. The call is not tied to the browser's connection, and is aborted at 240 seconds.
4. Read the stream to its end. Take the replacement for each edit id that was sent. Ignore any other id and everything else in the reply.
5. Canonicalize each replacement with `canonicalizeText`, splice it in at the stored offsets, and insert the row. The same holds for hand text. Offsets recorded on the row are therefore offsets into the text as stored, and an attempt whose spliced text is not already canonical fails rather than being silently re-normalized.
6. Record the cost on the AI spend ledger under a new source, `skill_revision`.

The browser polls the run list until the revision id appears, succeeded or failed. It stops at 330 seconds, longer than the function may run, says the edit did not finish and keeps the edits.

## Ignatious API

`POST /skill-run-revisions` on the skill bench, reached as `/v1/bench/skill-run-revisions`.

```
{
  revisionId, skill | null, document,
  passages: [{ id, start, end, comment }],
  tenantId, leadId, token, conductiaBaseUrl, model
}
```

- `revisionId` is the conversation id, so the edit gets the per-conversation spend ceiling a run has.
- The pinned skill version is mounted through `openRunRoot`, as a run mounts it, so the model can read the skill's own rules. When `skill` is null or no longer resolves, the edit proceeds with no skill mounted and says so on the terminal frame. This is not a substitution: the skill is context for the edit, not the thing being run.
- `TurnToolPolicy` gains a third arm, `revision`. It carries the Conductia read tools, `conductia_get_library_item`, `conductia_download_document`, the web tools under the deployment's existing grants, and one tool of its own, `submit_replacements`. It carries no `conductia_file_document`, no profile tool and no skill authoring or commit tool.
- The model is told to rewrite only the marked passages, to use a lookup only when a comment calls for one, to return each passage's full replacement as Markdown, and to mark a comment unresolved with one sentence rather than guess. A figure it cannot source is unresolved, not invented.
- The stream carries the frames a run carries, plus one `replacements` frame: for each passage id, either `text` or `unresolved` with a reason. The terminal `done` frame carries `model`, `modelId`, `costUsd`, `clampedFrom` and `skillMounted`.
- The model alias is the one the root run recorded, or the bench's default when it recorded none, clamped against the mounted skill's ceiling as a run's is.

Read-only is enforced twice, in two repositories: the bench does not offer a write tool, and the token cannot authorize a write.

## The step surface

**Behavioural reference:** `2026-10-13-skill-output-revisions-mockup.html`, beside this file. Its content is illustrative and its replacements are scripted. Dashed tags in it are notes on the mockup, not product UI.

### In the step

The step changes in two places, for a recorded, succeeded run when the flag is on and the step is not removed.

- The output box stays the compact scroll area it is today. It shows the head and is labelled with its version, who made it and when, with a count of pending edits when there are any.
- It gains one action, `Review output`.

Inputs, `Draft this step`, the run history and `Improve this skill` are unchanged. Streaming text and removed steps keep the read-only result.

### The review view

`Review output` opens a full-size overlay on the same shell as the skill builder dialog (`SkillBuilderDialog.tsx`). Review does not happen inside the step, because its output box is about 288 pixels tall, which is too small to review a document in.

`SkillStepRunner` is already 653 lines and gains only the label and the action. The view lives under `src/components/rail/review/`, with its state in a `useRunRevisions` hook.

- **Version bar.** `Version 3 of 3`, who made it and when, stepping to earlier and later versions, and `Restore this version` on any version but the head. An earlier version is read-only and says so.
- **Document.** The version being viewed, at reading width, rendered with block anchors. A click on a block selects it, a drag across several selects them as one passage, and each block has its own keyboard-reachable control.
- **Composer.** Opens under the selected passage with `Comment` and `Edit text`. `Edit text` shows the passage's Markdown source in a text area. Selecting a passage that already has a pending edit reopens that edit.
- **Edits pane.** `Pending`: what has been added, each removable and reopenable, numbered to match its passage. `Changed in this version`: each edit the version came from, with its comment or `Edited by hand`, who made it, and `Show before`.
- **Footer.** `Discard pending edits`, `Close`, and the commit, named for what it does: `Apply 3 edits`.

Marks on a passage: a dashed rule for a pending edit, violet for a passage the AI rewrote from a comment, and ink for one edited by hand. The register reserves violet for the AI actor. Every mark has its label in the edits pane, so status is never colour alone.

While a batch is applying, the document is read-only, the passages being rewritten are marked, and the view says `Applying. This can take a minute.` No stage of the work is shown, because the browser only learns that the revision has landed. The view can be closed in the meantime, and the step shows the new version when it arrives.

After applying, a confirmation states what was recorded: `3 edits applied. 1 could not be applied. Version 2 is recorded.` Each unresolved comment stays in `Pending` with its reason, marked `Not applied`, to reword or remove.

Pending edits survive closing the view. They do not survive a reload.

Keyboard: Escape closes the composer, then the view. Focus is held inside the view and returns to `Review output` when it closes. Below 860 pixels the edits pane stacks under the document.

Composed from the Workbench register (`docs/design/workbench/`) with existing tokens. Visible copy has no em dashes.

## Authorization

The gate that guards running the step: the deal access check, the internal wall (`classifyInternalUser`), and `resolveDealStepCapabilities(...).canEditWork`. A removed step's output cannot be revised. Everyone who can read the step's runs can read its revisions. No new permission key.

## Audit

Two moments are audited, as they are for a run. Both use the existing `create` action with `detail.kind = 'skill_run_revision'`, so `audit_log_action_check` is not widened. Neither row ever carries a comment or any output text.

- **Before the engine is called,** for a batch with comment edits: the deal, step, root, parent and revision ids, the count of edits by kind, and a SHA-256 of the edits as submitted. A failure to write this row stops the edit, as it does for a run.
- **When the revision row is written,** for every kind of revision: the same ids, the outcome, the count of edits by status, the model, and a SHA-256 of the resulting text. It is written in the same transaction as the row (`record_skill_run_revision`), so neither exists without the other.

## Failure handling

- **The head moved.** `parentId` is no longer the head: 409 before any model call. If two applies race, the unique index refuses the second insert and its row is recorded as failed. The browser reloads the head and re-attaches each pending edit whose passage text is unchanged there. The rest are listed as detached, to place again or discard.
- **The engine fails or times out.** A failed revision row is written with every edit and the reason. The head does not move and the pending edits stay in the browser.
- **Nothing could be applied.** Every comment came back unresolved and there was no hand edit: a failed row, with each reason. The head does not move.
- **A replacement is missing or names an unknown id.** The edit is recorded as unresolved, and the unknown id is ignored.
- **The audit row cannot be written.** The edit is not started.
- **The skill version no longer resolves.** The edit proceeds without it and the revision records `skillMounted: false`.

## Deliberate deferrals and accepted risks

- **An edit in flight is invisible after a reload, and cannot be cancelled.** It lands when it finishes, and `Restore` undoes it.
- **A second apply started while the first is in flight** is refused only when it tries to insert, after its model call has been paid for.
- **An edit cut off by the 300 second function limit leaves no row,** only its `started` audit row. The browser says the edit did not finish and keeps the edits. The 240 second abort exists so that the usual timeout still records a failed row.
- **Lookups make an edit slower and less repeatable** than a plain rewrite. Accepted by decision 2.
- **A comment whose fix belongs elsewhere in the document** cannot be honoured. Only its passage changes, or it comes back unresolved.
- **The model can rewrite a passage badly.** The guards are the before and after view, and `Restore`.
- **Comments are fields inside a `jsonb` column,** not rows of their own. Nothing is lost and they can be queried, and their ids are stable for slice 2 to reference. Moving them to their own store belongs with the table's move to the bank data plane.

## Verification

Unit and integration, in the existing shape:

- `blocks`: ranges for each block kind, nested lists and tables, and agreement between the browser's snapping and the server's alignment check.
- The splice, as a property test: for any text and any valid set of edits, every character outside the passages is identical before and after.
- The apply route: a stale parent, overlapping, unaligned and out-of-bounds ranges, an oversized result, a batch of hand edits only, a restore, and each failure above against a scripted bench.
- The constraints: one successful revision per parent, the `revision` arm of the reference check, and immutability of revision rows.
- The token: `skill-run-revision` carries no write scope, and the agent seam refuses a write made with it.
- Ignatious: the `revision` policy offers no write tool, `submit_replacements` is captured, an unknown or missing id is handled, and an unresolvable skill proceeds unmounted.

End to end, authenticating through the API and skipping two-factor, per the repository convention: run a step, comment on two passages and edit one by hand, apply, confirm only those three passages changed, restore the first output, and confirm four versions are listed.

Real-browser validation with seeded credentials against a local Supabase stack before the branch becomes a pull request. Never against a hosted project.

## Rollout gates

- Behind a new flag, `skill_output_revisions`. With it off, a run's output is read-only as today.
- The Ignatious endpoint is additive and deploys first.
- The migration is additive and backfills nothing.

## Repository responsibilities

**Conductia:** `blocks`, the splice, the two columns and their constraints, the routes, the token and its agent name wherever agent surfaces are enumerated, the audit row, the ledger source and its CHECK, the review surface, the flag, the `CONTEXT.md` terms, a decision-log entry, the API notes and the OpenAPI document.

**Ignatious:** the `/skill-run-revisions` route, the `revision` tool policy and its instructions, `submit_replacements`, and the `replacements` and `done` frames.

## Implementation-plan requirements

The plan must sequence the Ignatious endpoint before Conductia's caller, build `blocks` and the splice first because the routes and the surface both depend on them, and keep the column additions, the `source` value and the constraints in one migration. The decision-log and API-notes entries go in their own paragraph at the end of their section. Parallel work must stay file disjoint. Every subagent prompt must restate that no command may point at a hosted Supabase project.
