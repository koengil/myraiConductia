# Teach the skill from comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A banker ticks "Teach the skill" on review comments; once those comments are applied, a "Teach the skill · N comments" button opens "Improve this skill" with a prompt Conductia wrote from them, and the banker publishes through the existing flow.

**Architecture:** The tick rides on slice 1's comment edit as `teach: true` inside the existing `deal_step_skill_runs.inputs` record. A new append-only, ids-only table `skill_comment_teachings` records which comments wait on a draft and which were sent. Opening the builder with `teach: true` makes the skill-drafts route build the prompt server-side and write it into the draft's composer through a new SQL function; the existing `skill_authoring_submit_message` is redefined to mark waiting comments as sent in the same transaction. No Ignatious change.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Supabase Postgres (plpgsql, service-role RPCs), React 19, Vitest + RTL, Playwright (hermetic tier).

**Spec:** `docs/superpowers/specs/2026-10-20-teach-the-skill-from-comments-design.md` (approved 2026-10-20). Mockup beside it. Builds on D92 (`docs/superpowers/specs/2026-10-13-skill-output-revisions-design.md`).

## Global Constraints

- Conductia only. No change under `/Users/cwillian/Documents/personal/learning/ignatious`.
- No new flag. Teaching needs both `skill_output_revisions` and `skill_authoring`.
- ADR-0017 decision 7: the new table holds ids only. The prompt lives only in `skill_authoring_drafts.composer_text` and `skill_authoring_messages.text`.
- No new audit action; `audit_log_action_check` is not touched. No comment text in any audit row.
- `deal_step_skill_runs` rows are never updated; "waiting" and "sent" are appended to `skill_comment_teachings`, which is itself immutable.
- 20,000-character limit on `composer_text` and message `text`. Comments are never cut; passages and results are.
- Only comment edits with status `applied` in a succeeded revision teach. Hand edits never teach.
- Visible copy (exact, no em dashes):
  - Composer checkbox: `Teach the skill`
  - Composer helper: `For rules everyone on this project should get, not fixes to this document.`
  - Tag: `Teaches skill`
  - Note beside Apply: `{N comment|comments} {is|are} marked to teach the skill. After applying, use Teach the skill to update this step's skill for everyone on this project. Leave a comment unticked when it only fixes this document.`
  - Button: `Teach the skill · {N comment|comments}`
- No code comments (CLAUDE.md). Tests live in `tests/` and follow the surrounding test files' style.
- Before every push: `git fetch origin && git rebase origin/develop`, re-run touched tests, `git push --force-with-lease`. Stage explicit paths only.

## Review Focus

1. **The builder opens twice for one click** (StrictMode in `next dev`, or a double click): the prompt must be written once. Pinned in Task 2 (`offers nothing when any edit already waits on the draft`) and Task 5 (`opens the same draft twice and adds the prompt once`).
2. **The composer is nearly full**: no comment fits, the builder opens unchanged and the button still counts them. Pinned in Task 3 (`includes nothing when the first comment does not fit`) and Task 5 (`opens the draft unchanged when no comment fits`).
3. **The draft is discarded after Teach**: its comments return to the count and the next Teach offers them on the new draft. Pinned in Task 2 (`offers a comment again on a new draft after the old one is discarded`).
4. **A version is restored after a taught comment was applied**: the comment still counts. Pinned in Task 4 (`still counts an applied comment after an earlier version is restored`).
5. **A crafted request marks a hand edit, or a comment that was not applied, as teaching**: the first is refused at parse, the second is refused by the offer function. Pinned in Task 1 (`refuses teach on a hand edit`) and Task 2 (`refuses an edit that is not an applied, taught comment of the draft's step`).

---

### Task 1: The tick travels with a comment edit and is kept on the revision

**Files:**
- Modify: `src/lib/skillRun/types.ts` (`EditRequest`, `EditRecord`, `RevisionEditSummary`)
- Modify: `src/lib/skillRun/revisions.ts` (`parseEdit`)
- Modify: `src/lib/skillRun/applyRevision.ts` (`failRemaining`, the `records` map in `applyCommentBatch`)
- Modify: `src/lib/skillRun/revisionStore.ts` (`summarize`)
- Test: `tests/skill-run-revisions.test.ts`, `tests/skill-run-apply-revision.test.ts`

**Interfaces:**
- Produces:
  - `EditRequest` comment arm: `{ kind: "comment"; start: number; end: number; comment: string; teach?: true }`
  - `EditRecord.teach?: true`
  - `RevisionEditSummary.teach: boolean` and `RevisionEditSummary.sent: boolean`
  - `summarize(chain: OutputChain, nameFor: (actorId: string | null) => string, sent: ReadonlySet<string> = new Set()): RevisionSummary[]`, where `sent` holds edit ids

- [ ] **Step 1: Write the failing parse tests** in `tests/skill-run-revisions.test.ts`, inside `describe('parseRevisionRequest')`:

```ts
it('keeps teach on a comment edit', () => {
  expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'End bullets with a period.', teach: true }] }))
    .toEqual({ kind: 'edits', parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'End bullets with a period.', teach: true }] });
});
it('drops teach: false from a comment edit', () => {
  expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'Fix.', teach: false }] }))
    .toEqual({ kind: 'edits', parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'Fix.' }] });
});
it('refuses teach on a hand edit', () => {
  expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'hand', start: 27, end: 32, text: '- uno', teach: true }] }))
    .toEqual({ error: 'Only a comment can teach the skill' });
});
it('refuses a teach value that is not true or false', () => {
  expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'Fix.', teach: 'yes' }] }))
    .toEqual({ error: 'teach must be true or false' });
});
```

- [ ] **Step 2: Write the failing record test** in `tests/skill-run-apply-revision.test.ts`, following that file's existing `applyCommentBatch` fixtures: a batch with one comment sent with `teach: true` and one without records `inputs.edits[0].teach === true` and no `teach` key on `inputs.edits[1]`, both when the engine applies them and when the batch fails (`failRemaining` path, e.g. the engine timeout case already in the file).

- [ ] **Step 3: Write the failing summary test** in `tests/skill-run-revisions.test.ts` (new `describe('summarize')`, importing `summarize` and `chainOf` from `@/lib/skillRun/revisionStore`): a chain with one succeeded revision whose `inputs.edits` holds `{ id: 'e1', kind: 'comment', teach: true, status: 'applied', ... }` and `{ id: 'e2', kind: 'comment', status: 'applied', ... }`, summarized with `new Set(['e1'])`, gives `edits[0]` `{ teach: true, sent: true }` and `edits[1]` `{ teach: false, sent: false }`; summarized without the third argument gives `sent: false` for both.

- [ ] **Step 4: Run them and see them fail**

Run: `npx vitest run tests/skill-run-revisions.test.ts tests/skill-run-apply-revision.test.ts`
Expected: the new tests FAIL (teach dropped, `sent`/`teach` missing on summaries).

- [ ] **Step 5: Implement**
  - `parseEdit`: when `rec.teach` is neither `undefined` nor a boolean, return `'teach must be true or false'`; a hand edit with `rec.teach === true` returns `'Only a comment can teach the skill'`; a comment with `rec.teach === true` gets `teach: true`; `false` is dropped.
  - `applyCommentBatch` records and `failRemaining`: carry `teach: true` when the edit has it, with the same conditional-spread idiom used for `comment`.
  - `summarize`: add `teach: edit.teach === true` and `sent: sent.has(edit.id)`.
  - Fix every other `RevisionEditSummary` literal that `npx tsc --noEmit` reports (test factories such as `editSummary` in `tests/review-output.test.tsx` get `teach: false, sent: false`).

- [ ] **Step 6: Run them and see them pass**

Run: `npx vitest run tests/skill-run-revisions.test.ts tests/skill-run-apply-revision.test.ts tests/review-output.test.tsx && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/skillRun/types.ts src/lib/skillRun/revisions.ts src/lib/skillRun/applyRevision.ts src/lib/skillRun/revisionStore.ts tests/skill-run-revisions.test.ts tests/skill-run-apply-revision.test.ts tests/review-output.test.tsx
git commit -m "feat(skill-revisions): a comment edit can carry teach and keeps it on its revision"
```

---

### Task 2: The teaching ledger, the offer function, and "sent" on message admission

**Files:**
- Create: `supabase/migrations/20261022143700_skill_comment_teachings.sql`
- Modify: `supabase/schema-snapshot.txt` (regenerated)
- Modify: `src/lib/constants/tables.ts` (`SKILL_COMMENT_TEACHINGS: 'skill_comment_teachings'`)
- Test: `tests/integration/skill-comment-teachings.test.ts` (new)

**Interfaces:**
- Produces:
  - Table `skill_comment_teachings(id uuid pk default gen_random_uuid(), deal_id uuid not null references deals(id), revision_run_id uuid not null references deal_step_skill_runs(id), edit_id uuid not null, draft_id uuid not null references skill_authoring_drafts(id), kind text not null check (kind in ('waiting','sent')), message_id uuid references skill_authoring_messages(id), actor_id uuid not null references users(id), created_at timestamptz not null default now(), check ((kind = 'sent') = (message_id is not null)))`
    - unique `(edit_id) where kind = 'sent'`; unique `(draft_id, edit_id) where kind = 'waiting'`; index on `revision_run_id`
    - RLS on, `grant select, insert ... to service_role`, nothing to `authenticated`, update and delete refused by a trigger, as `deal_step_skill_runs` does (`20260916130000_deal_step_skill_runs.sql`)
  - `skill_teaching_offer(p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_edits jsonb, p_prompt text, p_correlation_id uuid) returns jsonb`; `p_edits` is `[{"runId": uuid, "editId": uuid}]`; returns `skill_authoring_receipt(v_draft) || jsonb_build_object('offered', <boolean>)`
  - `skill_authoring_submit_message` (same signature) additionally writes one `sent` row per comment waiting on the draft and adds `'taughtComments', <count>` to the `skill_authoring.message_admitted` audit detail

**`skill_teaching_offer` behaviour, in order:**
1. `perform skill_authoring_lock_author(p_actor_id, p_deal_id)`; lock the draft `for update` by id, deal and author; not found raises `skill_authoring_draft_not_found` (P0002); not `active` calls `skill_authoring_raise_conflict`.
2. Every element of `p_edits` must name a `deal_step_skill_runs` row with `source = 'revision'`, `outcome = 'succeeded'`, `deal_id = p_deal_id`, `deal_step_id = v_draft.basis_deal_step_id`, whose `inputs -> 'edits'` holds an element with that `id`, `kind = 'comment'`, `status = 'applied'` and `teach = true`. Otherwise raise `skill_teaching_invalid_edit` (P0001). An empty array raises the same.
3. If any named edit already has a `sent` row, or a `waiting` row on this draft, return the receipt with `offered: false` and change nothing.
4. New composer text: `p_prompt` when `composer_text = ''`, else `composer_text || E'\n\n' || p_prompt`. If longer than 20,000 characters, return `offered: false` and change nothing.
5. Update the draft's `composer_text`, `edit_revision = edit_revision + 1`, `updated_at = now()`; insert one `waiting` row per edit with `actor_id = p_actor_id`; return the receipt with `offered: true`.

Grant both functions as the authoring migration does: revoke from `public`, `anon`, `authenticated`; grant execute to `service_role`. The redefined `skill_authoring_submit_message` is the current body from `20260916110000_skill_authoring.sql` copied verbatim, plus, after the message insert:

```sql
insert into skill_comment_teachings (deal_id, revision_run_id, edit_id, draft_id, kind, message_id, actor_id)
select w.deal_id, w.revision_run_id, w.edit_id, w.draft_id, 'sent', v_message.id, p_actor_id
from skill_comment_teachings w
where w.draft_id = v_draft.id and w.kind = 'waiting'
  and not exists (select 1 from skill_comment_teachings s where s.edit_id = w.edit_id and s.kind = 'sent');
get diagnostics v_taught = row_count;
```

- [ ] **Step 1: Write the failing integration tests** in `tests/integration/skill-comment-teachings.test.ts`. Seed as `seedFailedRunDraft` in `tests/integration/skill-authoring-seed-run.test.ts` does (company, director user, deal, custom deal step, succeeded execution run), then insert a succeeded revision row of that run through `record_skill_run_revision` whose `inputs` is `{ kind: 'edits', edits: [{ id: E1, kind: 'comment', start, end, comment: 'End every bullet with a period.', status: 'applied', teach: true, resultStart, resultEnd }, { id: E2, kind: 'comment', ..., status: 'applied' }] }`, and open a draft with `skill_authoring_get_or_create_draft` (basis = the step, seed = the run). Tests:
  - `writes the prompt into an empty composer and records the comment as waiting`: offer `[{runId: REV, editId: E1}]` with prompt `'P1'` → `offered: true`; the draft's `composer_text = 'P1'` and `edit_revision` went up by 1; one `waiting` row for E1.
  - `adds the prompt after text already in the composer`: composer `'My note'` → `'My note\n\nP1'`.
  - `offers nothing when any edit already waits on the draft`: a second identical offer → `offered: false`, composer unchanged, still one row.
  - `refuses an edit that is not an applied, taught comment of the draft's step`: E2 (not taught) and a random uuid each raise `skill_teaching_invalid_edit`.
  - `offers nothing when the result would exceed 20,000 characters`: composer of 19,999 characters → `offered: false`.
  - `marks waiting comments as sent when the next message is admitted, and counts them in the audit row`: after an offer, `skill_authoring_submit_message` with any text → one `sent` row for E1 with that message id; the `skill_authoring.message_admitted` row's `detail.taughtComments = 1`; a second message adds no row and audits `taughtComments: 0`.
  - `offers a comment again on a new draft after the old one is discarded`: offer, `skill_authoring_discard_draft`, open a new draft, offer again → `offered: true`.
  - `never offers a comment that was already sent`: after sent, a new draft's offer → `offered: false`.
  - `refuses to change or delete a teaching row`: update and delete each raise.

- [ ] **Step 2: Run them and see them fail**

Run (local stack per the integration recipe: `npx supabase db reset`, then `eval "$(npx supabase status -o env)"`):
`NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" npx vitest run --config vitest.integration.config.ts tests/integration/skill-comment-teachings.test.ts`
Expected: FAIL (`skill_teaching_offer` does not exist).

- [ ] **Step 3: Write the migration** as specified above, and add `SKILL_COMMENT_TEACHINGS` to `TABLE`.

- [ ] **Step 4: Apply and run them again**

Run: `npx supabase db reset`, re-export the env, re-run the command in Step 2.
Expected: PASS. Also run `tests/integration/skill-authoring-seed-run.test.ts` and `tests/integration/skill-output-revisions.test.ts`: PASS.

- [ ] **Step 5: Regenerate the schema snapshot**

Run: `printf "DATABASE_URL='%s'\n" "$DB_URL" > "$TMPDIR/local-db.env" && npm run schema:snapshot -- "$TMPDIR/local-db.env"`
Expected: `supabase/schema-snapshot.txt` changes only by the new table, indexes, trigger, and the two functions.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261022143700_skill_comment_teachings.sql supabase/schema-snapshot.txt src/lib/constants/tables.ts tests/integration/skill-comment-teachings.test.ts
git commit -m "feat(skill-teaching): record which taught comments wait on a draft and which were sent"
```

---

### Task 3: Which comments teach, and the prompt built from them

**Files:**
- Create: `src/lib/skillRun/teaching.ts`
- Test: `tests/skill-teaching.test.ts` (new, `// @vitest-environment node`)

**Interfaces:**
- Consumes: `OutputChain` (type) from `src/lib/skillRun/revisionStore.ts`; `parseRevisionInputs` from `src/lib/skillRun/revisions.ts`.
- Produces:
  - `type TeachableComment = { revisionId: string; editId: string; comment: string; passage: string; became: string }`
  - `teachableComments(chain: OutputChain, sent: ReadonlySet<string>): TeachableComment[]`: comment edits with `teach === true` and `status === 'applied'` from rows with `outcome === 'succeeded'`, oldest row first and in record order within a row, skipping ids in `sent`. `passage` is the parent version's text at `[start, end)`; `became` is the row's own version text at `[resultStart, resultEnd)`. A row missing from `chain.versions` is skipped.
  - `COMPOSER_LIMIT = 20_000`, `TEACHING_EXCERPT_LENGTH = 600`
  - `promptRoom(composerText: string): number` = `COMPOSER_LIMIT - composerText.length - (composerText === '' ? 0 : 2)`
  - `teachingPrompt(comments: readonly TeachableComment[], room: number): { text: string; included: TeachableComment[] }`

**Prompt format** (exact header; numbering restarts at 1 per prompt):

```
Update this skill with lessons from reviews of its output.

Keep the lessons in a section titled "Learned from reviews". Merge these with any lessons already in that section: drop duplicates, and where two conflict, keep the newer one. Write each lesson as a short standing rule. Leave every other part of the skill unchanged.

1. Comment: "<comment, verbatim>"
   Written on: "<passage excerpt>"
   Became: "<became excerpt>"
```

Entries are separated by a blank line. An excerpt collapses runs of whitespace to one space, trims, and cuts to `TEACHING_EXCERPT_LENGTH` characters followed by `...` when longer. Entries are added in order while the whole text stays within `room`; the first entry that does not fit stops the loop. With no entry included, `text` is `''`.

- [ ] **Step 1: Write the failing tests**
  - `lists applied, taught comments oldest first with their passage and what it became` (two succeeded revisions, the later one second)
  - `leaves out an untaught comment, an unresolved one, a hand edit, and any comment in a failed revision`
  - `leaves out a comment that was already sent`
  - `writes the header and one numbered entry per comment, keeping the comment verbatim` (assert the full string for one comment whose passage spans two lines: the excerpt is on one line, the comment keeps its newline)
  - `cuts a long passage to an excerpt but never the comment` (700-character passage → 600 characters plus `...`)
  - `stops at the first comment that does not fit and reports what it included` (room fits header + 1 entry → `included` has 1)
  - `includes nothing when the first comment does not fit` (→ `{ text: '', included: [] }`)
  - `leaves room for the separator when the composer has text` (`promptRoom('')` is 20000, `promptRoom('abc')` is 19995)

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/skill-teaching.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/skillRun/teaching.ts`** to the interfaces above.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/skill-teaching.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillRun/teaching.ts tests/skill-teaching.test.ts
git commit -m "feat(skill-teaching): pick the applied, taught comments and write the prompt from them"
```

---

### Task 4: The run list says which taught comments were sent, and the step counts the rest

**Files:**
- Create: `src/lib/skillRun/teachingStore.ts`
- Modify: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts` (`decorate`)
- Modify: `src/lib/skillRun/revisionView.ts`
- Test: `tests/api/skill-run-records.test.ts`, `tests/skill-run-revision-view.test.ts`

**Interfaces:**
- Consumes: `TABLE.SKILL_COMMENT_TEACHINGS` (Task 2); `summarize(..., sent)` (Task 1).
- Produces:
  - `type TeachingRow = { revisionId: string; editId: string; draftId: string; kind: 'waiting' | 'sent' }`
  - `readTeachings(admin: SupabaseClient, revisionIds: string[]): Promise<TeachingRow[] | 'unreadable'>` (empty input returns `[]` with no query; logs and returns `'unreadable'` on error, as `readRevisionRows` does)
  - `sentEditIds(rows: readonly TeachingRow[]): Set<string>`
  - `unsentTaughtCount(run: SkillRunSummary): number` in `revisionView.ts`: comment edits with `teach && !sent && status === 'applied'` in revisions with `outcome === 'succeeded'`

- [ ] **Step 1: Write the failing tests**
  - `tests/api/skill-run-records.test.ts`: extend the file's fake admin with a `skill_comment_teachings` table, then `marks a taught comment as sent in history once a message carried it`: a run with a succeeded revision holding taught comment `e1` and a `sent` teaching row for `e1` → `GET` returns `revisions[0].edits[0]` with `teach: true, sent: true`. And `answers 500 when the teaching rows cannot be read`.
  - `tests/skill-run-revision-view.test.ts`, new `describe('unsentTaughtCount')`:
    - `counts applied, taught comments not yet sent` (3 taught applied, 1 sent → 2)
    - `ignores untaught, unresolved and hand edits, and failed revisions` (→ 0)
    - `still counts an applied comment after an earlier version is restored` (a later `restore` revision → still 1)

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/api/skill-run-records.test.ts tests/skill-run-revision-view.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `teachingStore.ts`, `unsentTaughtCount`, and in `decorate`: after `readRevisionRows`, read teachings for the revision row ids, return `'unreadable'` when unreadable, and pass `sentEditIds(rows)` to `summarize`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/api/skill-run-records.test.ts tests/skill-run-revision-view.test.ts tests/api-v1-deal-not-visible.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillRun/teachingStore.ts "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts" src/lib/skillRun/revisionView.ts tests/api/skill-run-records.test.ts tests/skill-run-revision-view.test.ts
git commit -m "feat(skill-teaching): run history says which taught comments were sent"
```

---

### Task 5: Opening the builder with `teach` fills the draft's composer

**Files:**
- Modify: `src/lib/skillRun/teachingStore.ts` (add `prepareTeachingOffer`)
- Modify: `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts`
- Modify: `src/lib/skillAuthoring/client.ts` (`DraftBasisRequest`, `openBody`)
- Test: `tests/api/skill-drafts-teach.test.ts` (new, modelled on `tests/api/skill-drafts-basis.test.ts`), `tests/skill-authoring-client.test.ts`

**Interfaces:**
- Consumes: `loadChain` (revisionStore), `teachableComments`, `teachingPrompt`, `promptRoom` (Task 3), `readTeachings`, `sentEditIds` (Task 4), RPC `skill_teaching_offer` (Task 2).
- Produces:
  - `type TeachingOffer = { edits: { runId: string; editId: string }[]; prompt: string }`
  - `prepareTeachingOffer(admin: SupabaseClient, input: { dealStepId: string; seedRunId: string; draftId: string }): Promise<TeachingOffer | null | 'unreadable'>`: loads the chain, the teaching rows and the draft's `composer_text`; drops comments that are sent or already waiting on `draftId`; builds the prompt with `promptRoom(composerText)`; returns `null` when nothing is included.
  - `DraftBasisRequest.teach?: boolean`; `openBody` sends `teach: true` only when set (its return type widens to `Record<string, string | boolean>`).
  - Route body field `teach: true`.

**Route behaviour when `body.teach === true`:**
1. `requireFlag('skill_output_revisions')` gate (404 when off).
2. `basisStepId` and a resolved seed run are required; otherwise 422 `Teaching the skill needs the step and the run it reviewed.`
3. After `skill_authoring_get_or_create_draft`, call `prepareTeachingOffer`; `'unreadable'` → 500 `The comments could not be read.`; `null` → respond with the draft as today.
4. Otherwise `callRpc(admin, 'skill_teaching_offer', { p_actor_id, p_deal_id, p_draft_id, p_edits: offer.edits, p_prompt: offer.prompt, p_correlation_id })`, and build the receipt from its result instead of the get-or-create result. An RPC failure returns its mapped response.

- [ ] **Step 1: Write the failing tests**
  - `tests/api/skill-drafts-teach.test.ts` (mock the RPC client and Supabase reads as `skill-drafts-basis.test.ts` does):
    - `fills the draft with a prompt from the run's taught comments` (asserts the `skill_teaching_offer` call carries the two edit ids and a prompt containing both comments, and the response's draft has that composer text)
    - `opens the same draft twice and adds the prompt once` (second open sees both edits waiting on the draft → no offer RPC)
    - `opens the draft unchanged when no comment fits` (composer of 19,990 characters → no offer RPC, 200)
    - `answers 404 when skill output revisions are off`
    - `answers 422 when teach comes without a step or a run`
    - `does not offer anything without teach` (existing open path unchanged: no teaching reads)
  - `tests/skill-authoring-client.test.ts`: `posts teach when opening a teaching draft` (`open('deal-1', { basisStepId: 'p2-s36', seedRunId: 'run-1', teach: true })` → body `{ basisStepId: 'p2-s36', seedRunId: 'run-1', teach: true }`).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/api/skill-drafts-teach.test.ts tests/skill-authoring-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `prepareTeachingOffer`, the route branch, and the client field.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/api/skill-drafts-teach.test.ts tests/api/skill-drafts-basis.test.ts tests/skill-authoring-client.test.ts tests/skill-authoring-browser-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillRun/teachingStore.ts "src/app/api/v1/deals/[dealId]/skill-drafts/route.ts" src/lib/skillAuthoring/client.ts tests/api/skill-drafts-teach.test.ts tests/skill-authoring-client.test.ts
git commit -m "feat(skill-teaching): opening the builder to teach fills its composer with the prompt"
```

---

### Task 6: The tick, the tag and the note in the review dialog

**Files:**
- Modify: `src/components/rail/review/reviewCopy.ts`
- Modify: `src/lib/skillRun/revisionView.ts` (`PendingEdit.teach`)
- Modify: `src/components/rail/review/useRunRevisions.ts` (`EditDraft`, `requestOf`)
- Modify: `src/components/rail/review/EditComposer.tsx`
- Modify: `src/components/rail/review/EditsPane.tsx`
- Modify: `src/components/rail/review/ReviewOutputDialog.tsx`
- Test: `tests/review-output.test.tsx`

**Interfaces:**
- Produces:
  - `PendingEdit.teach: boolean`; `EditDraft` picks `teach` too
  - `requestOf` sends `teach: true` on a comment whose `teach` is true, and no `teach` key otherwise
  - `EditComposer` props: `existing: { kind: Mode; value: string; problem: string | null; teach: boolean } | null`; `onSave: (kind: Mode, value: string, teach: boolean) => void`
  - `REVIEW_COPY.teach = 'Teach the skill'`, `REVIEW_COPY.teachHelp = 'For rules everyone on this project should get, not fixes to this document.'`, `REVIEW_COPY.teachesSkill = 'Teaches skill'`
  - `teachNote(count: number): string` and `teachButton(count: number): string` in `reviewCopy.ts`, producing the exact copy in Global Constraints (`teachButton(2)` is `Teach the skill · 2 comments`)

**UI rules:**
- The checkbox renders in Comment mode only, under the text field, labelled `Teach the skill` with the helper as its description; it is off for a new comment and keeps its state when an existing comment is reopened. Edit text mode has no checkbox and saves `teach: false`.
- A pending comment with `teach` shows the `Teaches skill` tag after its `Comment` label; an applied edit in "Changed in this version" shows it when `edit.teach`.
- The footer shows `teachNote(n)` beside Apply while `n` (pending, non-detached comments with `teach`) is above 0.

- [ ] **Step 1: Write the failing tests** in `tests/review-output.test.tsx`, inside `describe('reviewing a run output')`:
  - `ticks Teach the skill on a comment and shows it as teaching in Pending`
  - `offers no Teach the skill box when editing the text by hand`
  - `keeps the tick when a pending comment is reopened`
  - `says what teaching does beside Apply only while a pending comment is ticked` (exact `teachNote(1)` text, then gone after unticking)
  - `sends teach with a ticked comment and not with an unticked one` (assert the POST body's edits)
  - `tags an applied comment that teaches in Changed in this version`

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/review-output.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the copy, types and components to the rules above, using the existing `Badge` atom for the tag and the composer's existing field styles.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/review-output.test.tsx tests/skill-run-revision-view.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/review/reviewCopy.ts src/lib/skillRun/revisionView.ts src/components/rail/review/useRunRevisions.ts src/components/rail/review/EditComposer.tsx src/components/rail/review/EditsPane.tsx src/components/rail/review/ReviewOutputDialog.tsx tests/review-output.test.tsx
git commit -m "feat(skill-teaching): tick a comment to teach the skill, with the note beside Apply"
```

---

### Task 7: The Teach the skill button opens the builder to teach

**Files:**
- Modify: `src/components/rail/review/RunOutput.tsx`
- Modify: `src/components/rail/SkillStepRunner.tsx`, `src/components/rail/StationCard.tsx`, `src/components/rail/StepRunner.tsx`, `src/components/rail/StepContract.tsx`, `src/components/rail/StepFocus.tsx`, `src/components/rail/DealRail.tsx`
- Modify: `src/components/rail/SkillBuilderLauncher.tsx`, `src/components/rail/SkillBuilderDialog.tsx`, `src/lib/skillAuthoring/useSkillAuthoringDraft.ts`
- Test: `tests/review-output.test.tsx`, `tests/skill-authoring-rail-entry.test.tsx`

**Interfaces:**
- Consumes: `unsentTaughtCount` (Task 4), `teachButton` (Task 6), `DraftBasisRequest.teach` (Task 5).
- Produces:
  - `RunOutput` prop `onTeach?: () => void`; the button renders beside "Review output" only when `onTeach` is set and `unsentTaughtCount(run) > 0`, labelled `teachButton(count)`.
  - Every `onEnhance` prop typed `(runId: string | null) => void` becomes `(runId: string | null, teach?: boolean) => void` (SkillStepRunner, StationCard, StepRunner twice, StepContract); `StepFocus`'s becomes `(basisStepId: string, seedRunId: string | null, teach?: boolean) => void` and its two lambdas forward `teach`.
  - `DealRail.handleEnhance(basisStepId: string, seedRunId: string | null, teach?: boolean)` launches with `{ basisStepId, seedRunId?, teach? }`.
  - `SkillBuilderEnhancementBasis.teach?: boolean`; `SkillBuilderDialog` and its body take `teach?: boolean` and put `teach: true` into `requestedBasis`; `useSkillAuthoringDraft` passes `teach` to `client.open` and lists it in the open effect's dependencies.
  - `SkillStepRunner` passes `onTeach={() => handleEnhance(reviewed.id, true)}` to `RunOutput` when `onEnhance` is provided.
  - Visibility follows "Improve this skill": the button shows wherever that control does, and someone without structure authority gets the builder's existing not-permitted view.

- [ ] **Step 1: Write the failing tests**
  - `tests/review-output.test.tsx`:
    - `offers Teach the skill with the count of applied comments not yet sent` (run with 2 such comments → button `Teach the skill · 2 comments`; clicking calls `onTeach`)
    - `hides Teach the skill when every taught comment was sent, or when there is no onTeach`
  - `tests/skill-authoring-rail-entry.test.tsx`, in `describe("skill authoring rail entry - improve this skill")`: `opens the builder to teach from the step's Teach the skill button` (rail with a skill-backed step whose run history includes one applied taught comment; click the button; the dialog opens and the `skill-drafts` POST body is `{ basisStepId: <step key>, seedRunId: <run id>, teach: true }`).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/review-output.test.tsx tests/skill-authoring-rail-entry.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the button and the `teach` threading listed above.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/review-output.test.tsx tests/skill-authoring-rail-entry.test.tsx tests/skill-builder-enhance.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/review/RunOutput.tsx src/components/rail/SkillStepRunner.tsx src/components/rail/StationCard.tsx src/components/rail/StepRunner.tsx src/components/rail/StepContract.tsx src/components/rail/StepFocus.tsx src/components/rail/DealRail.tsx src/components/rail/SkillBuilderLauncher.tsx src/components/rail/SkillBuilderDialog.tsx src/lib/skillAuthoring/useSkillAuthoringDraft.ts tests/review-output.test.tsx tests/skill-authoring-rail-entry.test.tsx
git commit -m "feat(skill-teaching): a Teach the skill button opens Improve this skill with the prompt"
```

---

### Task 8: The browser journey, the docs, and the full local CI run

**Files:**
- Modify: `e2e/support/railDealFixture.ts` (add `insertTaughtRevision`)
- Modify: `e2e/journeys/skill-output-revisions.spec.ts`
- Modify: `docs/07-decisions/decision-log.md`, `docs/03-engineering/api-v1.md`, `CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-10-20-teach-the-skill-from-comments-design.md` (status line only)

**Interfaces:**
- Produces: `insertTaughtRevision(dealId: string, opts: { rootRunId: string; actorId: string; binding: { skillId: string; versionId: string; digest: string }; parentText: string; comment: string; passage: string; replacement: string }): Promise<{ revisionId: string; editId: string }>`, writing a succeeded revision through `record_skill_run_revision` whose single edit is an applied comment with `teach: true`.

- [ ] **Step 1: Write the journey test** in `e2e/journeys/skill-output-revisions.spec.ts`: `an MD sends a taught comment to Improve this skill, and it is offered once`. Seed a step and run as the existing hand-edit test does, then `insertTaughtRevision`. Open the step; expect the `Teach the skill · 1 comment` button; click it; expect the `Enhance skill` dialog with `Message` holding `End every bullet with a period.` and `Learned from reviews`; send it; close the dialog; reload; expect no `Teach the skill` button. The hermetic tier has no authoring service, so the turn itself fails after the message is admitted; the journey asserts only admission.

- [ ] **Step 2: Run the journey**

Run (hermetic setup from the local CI recipe, `.env.local` without `IGNATIOUS_*` lines): `npx playwright test --project=hermetic e2e/journeys/skill-output-revisions.spec.ts --reporter=line`
Expected: PASS, all three tests in the file.

- [ ] **Step 3: Write the docs**
  - `decision-log.md`: a new row at the end of the table, `D<next> | 2026-10-20 | **A banker teaches a step's skill from applied review comments** (Accepted; replaces slices 2 and 3 of #463; flags skill_output_revisions and skill_authoring)`, summarising the spec's decisions 1 to 9 and citing the spec and the migration; "number to confirm at merge".
  - `api-v1.md`: a paragraph at the end of the skill-runs/revisions section for `teach` on a comment edit and `teach`/`sent` on revision edit summaries, and one at the end of the skill-drafts section for `teach: true` on open, with its 404 and 422.
  - `CONTEXT.md`: **Taught comment**, an applied comment edit the banker ticked to teach the step's skill.
  - Spec status: `Approved 2026-10-20. Implemented by docs/superpowers/plans/2026-10-20-teach-the-skill-from-comments.md.`

- [ ] **Step 4: Reproduce CI locally** (local CI recipe): lint and build, `npx tsc --noEmit`, `npm test`, the schema snapshot check, the DB probes, the SQL probes, the integration suite, and the full hermetic e2e run.
Expected: green apart from the known macOS-only failures (`discovery-export`, `perf-local-stack-guard`, `worker/entrypoint` ×2), each confirmed against `develop`.

- [ ] **Step 5: Walk it in a browser** against a local bench and a live model (local browser check setup): tick one comment and leave one unticked, apply, use Teach the skill, check the prompt names only the ticked comment, send, publish, and confirm the new version appears in the step's version list and the button is gone. Record the walk for the PR.

- [ ] **Step 6: Commit**

```bash
git add e2e/support/railDealFixture.ts e2e/journeys/skill-output-revisions.spec.ts docs/07-decisions/decision-log.md docs/03-engineering/api-v1.md CONTEXT.md docs/superpowers/specs/2026-10-20-teach-the-skill-from-comments-design.md
git commit -m "docs(skill-teaching): decision, API notes and journey for teaching a skill from comments"
```
