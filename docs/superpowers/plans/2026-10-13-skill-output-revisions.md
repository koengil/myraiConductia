# Skill Output Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A banker comments on or hand-edits passages of a recorded skill run's output, applies them together, and gets a new immutable revision in which only those passages changed.

**Architecture:** Conductia owns the passages (whole Markdown blocks addressed by offsets into the stored text), the splice, the revision rows (in the existing `deal_step_skill_runs` table) and every browser route. One new Ignatious bench endpoint runs a read-only turn that returns replacement text keyed by edit id. A batch with comments is applied in `after()` and the browser polls the run list until the revision lands.

**Tech Stack:** Conductia: Next.js 16 App Router, TypeScript, Tailwind 4, Supabase Postgres, Vitest, React Testing Library, Playwright. Ignatious skill bench: Hono, Mastra, zod, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-13-skill-output-revisions-design.md`, with its behavioural mockup `docs/superpowers/specs/2026-10-13-skill-output-revisions-mockup.html`. Read both before any task. Slices 2 and 3 are out of scope and recorded in issue #463.

## Where this plan departs from the spec

Each of these was forced by something found in the code. They need Charles's agreement when he reviews this plan.

1. **End to end.** The hermetic Playwright tier runs with no skill bench (`playwright.config.ts` blanks `IGNATIOUS_API_KEY`). The hermetic journey therefore covers a hand edit, a restore and the refusal of a comment batch. The comment path is covered by route tests against a scripted bench (Task 12) and by the real-browser walk against a local bench (Task 19).
2. **OpenAPI.** No skill-run route is in `openapi/phase1.json` today. The new routes follow their siblings and are documented in `docs/03-engineering/api-v1.md` only.
3. **Engine not configured.** The apply route answers 503 before anything is recorded, as the run route does. A failed revision row is written only once an engine call has been attempted.
4. **Nothing could be applied.** The failed row keeps each edit's `unresolved` status and reason. The status `failed` is used only when the engine call itself failed.
5. **Property test.** Written with a seeded generator, with no new dependency.
6. **The revision turn is never durable.** A recovered turn is rebuilt with the bench tool policy (`recovery.ts`), which carries the write tool, so the route switches durable turns off.
7. **The run list** always leaves revision rows out of the list of runs and always returns the head, with the flag on or off.

### Found during implementation, 2026-10-13

Each of these was decided by the session that implemented the plan, from a review finding, or was already in the plan's code without being listed above. All are for Charles to confirm.

8. **The 201 body is `{ revisionId }`,** not the revision. The browser reloads the run list to read it.
9. **`provider_run_id` is null on every revision row.** It follows from departure 6: the bench names a run only on a durable turn.
10. **The revision turn keeps the bench's scratch workspace,** so a downloaded document can be opened. That is Mastra's workspace file tools (contained to the turn's own folder), its skill-reading tools, and the bench's sandbox shell, which is not isolated from the host: the same reach a skill run has. It still has no tool and no token scope that writes to the deal.
11. **The `replacements` frame is sent only when the model submitted,** and a replacement is also stripped of leading newlines and trailing whitespace before it is spliced.
12. **A model reply becomes a revision only when the turn ended cleanly.** A turn that reported an error, or whose stream ended without `done`, is a failed attempt even when it returned replacements.
13. **A failed row keeps more than departure 4 says.** When the turn ended cleanly, an unresolved comment keeps its status and reason on the failed row. `failed` is used for an engine failure, a moved head and a result that could not be stored, and for every edit of a turn that did not end cleanly.
14. **A failed read of a run's revisions answers 500.** The plan's code would have answered with the run's first output as its head.
15. **Block offsets count past a leading byte-order mark,** and a parent list item is marked on a wrapper around its own line, so its highlight stops before its nested items.
16. **`snapToBlocks` was not built.** The browser derives a passage from the stamped block elements and has no offsets to snap; the agreement with the server's alignment check is tested in the review view.
17. **Revision audit rows are named in the audit trail** (`src/lib/audit/serverAudit.ts`, a file the plan did not list). They would otherwise have read "Created the mandate".
18. **The step shows the head in every view,** including a removed step and with the flag off.
19. **Leaving a run while its edits are applying.** Selecting another run or drafting again stops the browser's wait. With the flag on, selecting a run, a refused draft and a cancelled draft each reload the run list, so coming back shows the versions the run has by then. Pending edits that were not sent are dropped when another run is selected.
20. **Pending edits follow the head.** Whenever the browser is shown a different head for the run, it re-attaches each pending edit to its passage in the new text, or lists it as detached, before it shows or sends anything. An apply never sends an offset against a head it was not placed on.
21. **The spend ledger records a revision turn only when the turn finished.** A turn that timed out or was cut off has no ledger row, because its cost never reached Conductia.
22. **An edit that would change the blocks around it is refused.** A hand edit answers 422, and an engine replacement becomes unresolved with a fixed reason. The check compares each block outside the edit by its kind, its place, how deep it is nested, the item it sits under, its own number in a numbered list, the spacing of its list, and which other items share its list. So it refuses, for example, emptying a middle row of a table, an unclosed code fence, a header row returned without its pipes, a parent item returned without its marker or split in two, a nested item given a second line that starts a top-level item, one item removed from the middle of a tight list, and any edit that renumbers, splits or joins the lists around it, including a numbered item returned as two; the banker selects the whole list or table and edits it as one passage. A bulleted item returned as two is still applied. Still not seen: a passage whose bullet character changes, or that gains a nested item, can regroup the bulleted items beside it, which changes only the spacing between them. A removed passage does not take its line break with it, because that would change a character outside the passage.
23. **An edit on a repeated block is detached when the head changes.** A pending edit follows its passage to a new head only when that passage's text is the only such block in both heads.
24. **Revision audit rows carry the step's title,** as a run's own audit row does, so the audit trail can name a custom step. They still carry no comment and no output text.
25. **Pending edits that were not sent are dropped when a draft starts,** even one that is refused or cancelled, and a failed attempt is not shown in the view after a reload.

Two sentences of the spec turned out not to describe the code they rest on:

- "the edit gets the per-conversation spend ceiling a run has": the bench enforces its spend ceilings only on `/chat`. A skill run has none, and neither has a revision. A revision turn is bounded by the bench's step cap and the model clamp. Conductia's 240 second abort ends Conductia's wait, not the turn.
- "confirm four versions are listed" after a run, an apply and a restore: that is three versions. A failed attempt is not a version.

## How this plan was checked

On 2026-10-13 the code blocks of Tasks 1 to 4, 6, 7 and 9 to 16 were extracted from this file by script and applied to scratch copies of the two repositories, so the code and the tests below were run, not only read.

- **Ignatious** (at `ef25a08`): `tsc` clean, and the whole bench suite passes with the changes in: 97 files, 1,275 tests.
- **Conductia** (at `274d68087`): `tsc` and ESLint clean on every file the plan creates or changes, and 213 tests pass across the 14 test files it adds or touches.
- **Not run:** Task 8's migration and integration test (they need a database), Task 17 (documents), Task 18 (Playwright) and Task 19 (the browser walk).

If `develop` or Ignatious `main` has moved by the time a task runs, an "existing code" snippet in that task may no longer match word for word. Find the same construct and apply the same change.

## Global Constraints

- **No command may point at a hosted Supabase project.** Every database command targets the local stack (`127.0.0.1` or `localhost`). Every subagent prompt restates this sentence.
- Ignatious ships first. Tasks 1 to 5 land before Task 12, which calls the endpoint.
- `blocks` and the splice (Tasks 6 and 7) come before every route and every surface.
- The two columns, the new `source` value and the constraints are one migration (Task 8).
- ADR-0017 decision 7: no new control-plane table, and no new column that holds bank content. The two new columns hold ids only.
- Audit rows carry ids, counts and SHA-256 digests. Never a comment and never output text.
- Limits, verbatim from the spec: at most 20 edits, 2,000 characters per comment, 200,000 characters for a result. The engine call is aborted at 240 seconds. The route sets `maxDuration = 300`.
- Feature flag `skill_output_revisions`. With it off the new routes answer 404 and the step is unchanged.
- No code comments in new code. When existing code is moved, its existing comments move with it unchanged.
- Visible copy: sentence case, no em dashes. Compose from the Workbench register (`docs/design/workbench/`) with existing tokens. Violet (`--ai`) is used only for what the AI did.
- Conductia tests live under `tests/` and use `fireEvent` (the repo has no `user-event` dependency). Ignatious tests sit beside their source.
- Git: never commit on `main` or `master`. Stage explicit paths. Never use bare `git stash`. Never fetch with `--depth`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Decision-log and API-notes entries go in their own row or paragraph at the end of their section.
- Parallel subagents stay file disjoint and never run a mutating git command. The conductor integrates and commits. Implementer subagents run on Sonnet, reviewer subagents on Opus 5.5.
- Nothing is pushed and no pull request is opened without Charles saying so (Tasks 5 and 19 stop at that point).

## Review Focus

Conditions the spec implies that are easy to miss. Each one has a test in the task named.

1. **Two bankers apply to the same head at once.** The second insert hits the unique index. It must be recorded as a failed revision with the head-moved reason, not surface as a 500 or vanish. Test in Task 12.
2. **The engine stream ends early** (bench killed, or the 240 second abort): no `done`, or no `replacements`. A failed row is still written, the head does not move, and the browser keeps the pending edits. Tests in Task 9 (reader) and Task 12 (worker).
3. **A revision id offered as the seed run of an enhancement draft.** Its `inputs` hold the edits record, which the authoring turn cannot read. The draft route must not accept a revision row. Test in Task 10.
4. **Characters outside the basic plane before a passage** (an emoji, a combining accent). Offsets are UTF-16 indices in the browser, the server and the bench, so a replacement after an emoji must land on the right characters. Tests in Task 6 and Task 7.
5. **A parent item of a nested list, and the header row of a table.** The parent's passage must stop before its children, and a replaced header row must leave the delimiter row in place. Tests in Task 6 and Task 7.

## File Structure

### Ignatious (`platform/apps/skill-bench/src`)

| File | Responsibility |
|---|---|
| `authoring/execution/resolve-package.ts` (new) | The skill reference schema, and resolving a reference to runnable package bytes. Moved out of the run route so two routes share it. |
| `authoring/execution/conductia-target.ts` (new) | Resolving the Conductia base URL a turn may call, or the refusal response. Moved out of the run route. |
| `authoring/execution/execution-route.ts` (modify) | Uses the two modules above. Exports `reportingModel`, `overRunRoot`, `describeIssues`, `packageMiss`. Behaviour unchanged. |
| `mastra-tools.ts` (modify) | `readOnly` option on `createConductiaTools`; `CONDUCTIA_WRITE_TOOL`; `CONDUCTIA_READ_ONLY_TOOL_NAMES`. |
| `turn-agent-revision.ts` (new) | `revisionInstructions()`. |
| `turn-agent.ts` (modify) | Third `TurnToolPolicy` arm, `revision`. |
| `session.ts` (modify) | `ChatSessionOptions.toolPolicy`; the `replacements` event; `skillMounted` on `done`. |
| `authoring/revision/replacements-tool.ts` (new) | `submit_replacements` and the capture of what the model submitted. |
| `authoring/revision/revision-message.ts` (new) | The message a revision turn is sent: the document with marked passages, then the comments. |
| `authoring/revision/revision-route.ts` (new) | `POST /skill-run-revisions`. |
| `server.ts`, `routes-match-table.test.ts` (modify) | Mount the route; list it as unpublished. |

### Conductia

| File | Responsibility |
|---|---|
| `src/lib/skillRun/blocks.ts` (new) | Block ranges of a Markdown text, alignment and snapping. Used by browser and server. |
| `src/lib/skillRun/revisions.ts` (new) | Request parsing, edit validation, the splice, the stored `inputs` record, digests. Pure. |
| `supabase/migrations/20261013100000_skill_output_revisions.sql` (new) | Columns, `source` value, constraints, indexes, ledger source. |
| `src/lib/constants/dealSteps.ts`, `src/lib/ai/usage.ts`, `src/lib/flags/keys.ts`, `src/lib/ignatious/config.ts`, `src/lib/ignatious/jwt.ts` (modify) | The typed mirrors: run source, ledger source, flag, agent name, scopes. |
| `src/lib/ignatious/bench.ts` (modify) | `startSkillRunRevision`. |
| `src/lib/skillRun/revisionStream.ts` (new) | Reads the bench stream into an engine outcome. |
| `src/lib/skillRun/revisionStore.ts` (new) | Loads a run's chain of versions, computes the head, builds revision summaries. |
| `src/lib/skillRun/revisionAccess.ts` (new) | The gate both new routes share. |
| `src/lib/skillRun/applyRevision.ts` (new) | Writes revision rows: hand-only, restore, and the comment batch worker. |
| `src/lib/skillRun/types.ts` (modify) | `RevisionSummary`, `RevisionEditSummary`, head fields on `SkillRunSummary`. |
| `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts` (modify) | Run list leaves revisions out and returns head and revisions. |
| `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route.ts` (new) | `POST`: apply edits or restore. |
| `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/[revisionId]/route.ts` (new) | `GET`: one version's text. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts` (modify) | A revision row is not a seed run. |
| `src/components/atoms/Markdown.tsx` (modify) | Opt-in `anchors` prop. |
| `src/app/globals.css` (modify) | Passage marks for the review document. |
| `src/lib/skillRun/revisionView.ts` (new) | Pure view helpers: versions of a run, labels, confirmation sentences, re-attaching pending edits. |
| `src/lib/skillRun/revisionClient.ts` (new) | Browser calls to the two routes. |
| `src/components/rail/review/useRunRevisions.ts` (new) | Pending edits, apply, polling, restore. |
| `src/components/rail/review/reviewCopy.ts` (new) | Every visible string of the review surface. |
| `src/components/rail/review/ReviewDocument.tsx`, `EditComposer.tsx`, `EditsPane.tsx`, `VersionBar.tsx`, `ReviewOutputDialog.tsx`, `RunOutput.tsx` (new) | The review view and the step's output box. |
| `src/components/rail/SkillStepRunner.tsx` (modify) | Renders `RunOutput` for a recorded, succeeded run. |

---

# Part A: Ignatious

Work in a new worktree of `rtslabs/ignatious`, on branch `feat/skill-run-revisions` cut from `origin/main`. All paths in Part A are relative to that worktree.

### Task 1: Share package and target resolution between routes

A pure refactor. The run route keeps its behaviour and its tests, and the next route gets two functions to call.

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/execution/resolve-package.ts`
- Create: `platform/apps/skill-bench/src/authoring/execution/resolve-package.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/execution/conductia-target.ts`
- Modify: `platform/apps/skill-bench/src/authoring/execution/execution-route.ts`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces:
  - `SkillReferenceSchema` (zod) and `type SkillReferenceInput`
  - `interface PackageSource { readonly config: ChatConfig; readPublishedPackage(skillId: string, versionId: string, projectId: string): Promise<PublishedPackage | null> }`
  - `type PackageResolution = { ok: true; pkg: RunnablePackage } | { ok: false; code: 'not_found' | 'version_pruned' | 'version_not_recoverable'; message: string }`
  - `resolveRunnablePackage(source: PackageSource, skill: SkillReferenceInput, leadId: string): Promise<PackageResolution>`
  - `resolveTarget(c: Context, config: ChatConfig, logger: Logger, request: { conductiaBaseUrl?: string | null; tenantId: string; leadId: string }): { ok: true; baseUrl: string } | { ok: false; response: Response }`
  - From `execution-route.ts`, now exported: `reportingModel`, `overRunRoot`, `describeIssues`, `packageMiss(c, miss)`

- [ ] **Step 1: Create the worktree and confirm the baseline is green**

```bash
git -C /Users/cwillian/Documents/personal/learning/ignatious fetch origin
git -C /Users/cwillian/Documents/personal/learning/ignatious worktree add \
  /Users/cwillian/Documents/personal/learning/ignatious-skill-run-revisions \
  -b feat/skill-run-revisions origin/main
cd /Users/cwillian/Documents/personal/learning/ignatious-skill-run-revisions/platform
pnpm install --frozen-lockfile
pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/execution
```

Expected: every test in `src/authoring/execution` passes.

- [ ] **Step 2: Write the failing test**

Create `platform/apps/skill-bench/src/authoring/execution/resolve-package.test.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatConfig } from '../../config.js';
import { zipSkillFolder } from '../../skill-zip.js';
import { libraryConfig, libraryRoot, removeLibraryRoot } from '../publication/bench-app-fixture.js';
import type { PublishedPackage } from '../publication/store.js';
import { resolveRunnablePackage } from './resolve-package.js';

let root = '';
let config: ChatConfig;

beforeEach(() => {
  root = libraryRoot();
  config = libraryConfig(root);
});

afterEach(() => {
  removeLibraryRoot(root);
});

function publishedReader(): PublishedPackage {
  const folder = join(root, 'source', 'reader');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'SKILL.md'),
    '---\nname: reader\ndescription: A fixture skill.\n---\n\nRead.\n',
  );
  const packageBytes = Buffer.from(zipSkillFolder(folder, 'reader'));
  return {
    skillId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    digest: createHash('sha256').update(packageBytes).digest('hex'),
    packageBytes,
  };
}

function sourceFor(record: PublishedPackage | null) {
  return { config, readPublishedPackage: () => Promise.resolve(record) };
}

describe('resolveRunnablePackage', () => {
  it('resolves a publication whose digest matches', async () => {
    const record = publishedReader();

    const resolved = await resolveRunnablePackage(
      sourceFor(record),
      {
        kind: 'publication',
        projectId: record.projectId,
        skillId: record.skillId,
        versionId: record.versionId,
        digest: record.digest,
      },
      'lead-1',
    );

    expect(resolved).toEqual({
      ok: true,
      pkg: {
        label: `version ${record.versionId}`,
        digest: record.digest,
        packageBytes: record.packageBytes,
      },
    });
  });

  it('answers not_found for a publication whose digest differs', async () => {
    const record = publishedReader();

    const resolved = await resolveRunnablePackage(
      sourceFor(record),
      {
        kind: 'publication',
        projectId: record.projectId,
        skillId: record.skillId,
        versionId: record.versionId,
        digest: 'f'.repeat(64),
      },
      'lead-1',
    );

    expect(resolved).toEqual({
      ok: false,
      code: 'not_found',
      message: 'no published version matches that project, skill, version and digest',
    });
  });

  it('answers not_found for a catalog skill that is not mounted', async () => {
    const resolved = await resolveRunnablePackage(
      sourceFor(null),
      { kind: 'mount', name: 'absent', version: 1, digest: 'a'.repeat(64) },
      'lead-1',
    );

    expect(resolved).toEqual({
      ok: false,
      code: 'not_found',
      message: 'no catalog version matches that name, number and digest',
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/execution/resolve-package.test.ts`
Expected: FAIL, cannot find module `./resolve-package.js`.

- [ ] **Step 4: Create `resolve-package.ts`**

Move `PublicationReferenceSchema`, `MountReferenceSchema` and `SkillReferenceSchema` out of `execution-route.ts` into this file, unchanged, and add the resolver. The two block comments in the route that explain "One 404 for three different misses" and "Its own 409 rather than the pruning one" move here with the branches they describe, word for word.

```ts
import { z } from 'zod';

import type { ChatConfig } from '../../config.js';
import { isSkillName } from '../../skill-store.js';
import { mountedSkills } from '../../skills.js';
import { UuidSchema } from '../contract.js';
import type { PublishedPackage } from '../publication/store.js';
import { readMountPackage } from './mount-package.js';
import type { RunnablePackage } from './run-root.js';

const PublicationReferenceSchema = z
  .object({
    kind: z.literal('publication'),
    projectId: UuidSchema,
    skillId: UuidSchema,
    versionId: UuidSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const MountReferenceSchema = z
  .object({
    kind: z.literal('mount'),
    name: z.string().refine(isSkillName, 'not a usable skill name'),
    version: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const SkillReferenceSchema = z.discriminatedUnion('kind', [
  PublicationReferenceSchema,
  MountReferenceSchema,
]);

export type SkillReferenceInput = z.infer<typeof SkillReferenceSchema>;

export interface PackageSource {
  readonly config: ChatConfig;
  readPublishedPackage(
    skillId: string,
    versionId: string,
    projectId: string,
  ): Promise<PublishedPackage | null>;
}

export type PackageMissCode = 'not_found' | 'version_pruned' | 'version_not_recoverable';

export type PackageMiss = {
  readonly ok: false;
  readonly code: PackageMissCode;
  readonly message: string;
};

export type PackageResolution =
  | { readonly ok: true; readonly pkg: RunnablePackage }
  | PackageMiss;

const PUBLICATION_MISS = 'no published version matches that project, skill, version and digest';
const MOUNT_MISS = 'no catalog version matches that name, number and digest';

function miss(code: PackageMissCode, message: string): PackageMiss {
  return { ok: false, code, message };
}

export async function resolveRunnablePackage(
  source: PackageSource,
  skill: SkillReferenceInput,
  leadId: string,
): Promise<PackageResolution> {
  if (skill.kind === 'publication') {
    const published = await source.readPublishedPackage(
      skill.skillId,
      skill.versionId,
      skill.projectId,
    );
    if (published === null || published.digest !== skill.digest) {
      return miss('not_found', PUBLICATION_MISS);
    }
    return {
      ok: true,
      pkg: {
        label: `version ${skill.versionId}`,
        digest: published.digest,
        packageBytes: published.packageBytes,
      },
    };
  }

  const catalog = mountedSkills(source.config, leadId).skills;
  if (!catalog.some(entry => entry.name === skill.name)) return miss('not_found', MOUNT_MISS);

  const read = readMountPackage(
    source.config.skillsRoot,
    source.config.seedRoot,
    skill.name,
    skill.version,
  );
  if (!read.ok && read.code === 'pruned') {
    return miss('version_pruned', 'that catalog version no longer keeps its bytes');
  }
  if (!read.ok && read.code === 'not_recoverable') {
    return miss(
      'version_not_recoverable',
      'that catalog version came from a deployment this image no longer carries',
    );
  }
  if (!read.ok || read.digest !== skill.digest) return miss('not_found', MOUNT_MISS);
  return { ok: true, pkg: read.pkg };
}
```

- [ ] **Step 5: Create `conductia-target.ts`**

```ts
import { ConductiaTargetError, resolveConductiaBaseUrl } from '@ignatious/conductia-contract';
import type { Logger } from '@ignatious/agent-runtime';
import type { Context } from 'hono';

import type { ChatConfig } from '../../config.js';
import { fail } from '../publication/routes-http.js';

export type TargetResolution =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly response: Response };

export interface TargetRequest {
  readonly conductiaBaseUrl?: string | null | undefined;
  readonly tenantId: string;
  readonly leadId: string;
}

export function resolveTarget(
  c: Context,
  config: ChatConfig,
  logger: Logger,
  request: TargetRequest,
): TargetResolution {
  try {
    return {
      ok: true,
      baseUrl: resolveConductiaBaseUrl(request.conductiaBaseUrl ?? null, config.conductiaTargets),
    };
  } catch (error) {
    if (!(error instanceof ConductiaTargetError)) throw error;
    logger.warn('conductia target refused', {
      reason: error.reason,
      tenant: request.tenantId,
      lead: request.leadId,
      ...(error.requested === null ? {} : { requested: error.requested }),
      allowed: error.allowed.join(', '),
      problem: error.message,
    });
    return {
      ok: false,
      response: fail(
        c,
        error.reason === 'not_allowed' ? 'scope_denied' : 'validation',
        error.message,
      ),
    };
  }
}
```

- [ ] **Step 6: Rewire `execution-route.ts`**

1. Delete the three reference schemas and import `SkillReferenceSchema` from `./resolve-package.js`.
2. Replace the `let conductiaBaseUrl ... try { ... } catch { ... }` block with:

```ts
    const target = resolveTarget(c, deps.config, logger, request);
    if (!target.ok) return target.response;
    const conductiaBaseUrl = target.baseUrl;
```

3. Replace everything from `let pkg: RunnablePackage;` to the end of its `else` branch with:

```ts
    const resolved = await resolveRunnablePackage(deps, request.skill, request.leadId);
    if (!resolved.ok) return packageMiss(c, resolved);
    const pkg = resolved.pkg;
```

4. Add, above `reportingModel`:

```ts
export function packageMiss(c: Context, missed: PackageMiss): Response {
  if (missed.code === 'not_found') return fail(c, 'not_found', missed.message);
  return c.json(apiError(missed.code, missed.message, { retryable: false }), 409);
}
```

5. Add `export` to `reportingModel`, `overRunRoot` and `describeIssues`.
6. Fix the imports. Add `type Context` to the `hono` import, and import `resolveTarget` from `./conductia-target.js` and `resolveRunnablePackage`, `SkillReferenceSchema`, `type PackageMiss` from `./resolve-package.js`. Remove the four imports the moved code took with it: `ConductiaTargetError` and `resolveConductiaBaseUrl`, `isSkillName`, `readMountPackage`, and `type RunnablePackage`. `mountedSkills`, `UuidSchema` and `type PublishedPackage` are still used by this file and stay.

- [ ] **Step 7: Run the tests and the type check**

```bash
pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/execution
pnpm --filter @ignatious/skill-bench typecheck
```

Expected: PASS, including every test already in `execution-route.test.ts`, with no edits to that file.

- [ ] **Step 8: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/execution/resolve-package.ts \
        platform/apps/skill-bench/src/authoring/execution/resolve-package.test.ts \
        platform/apps/skill-bench/src/authoring/execution/conductia-target.ts \
        platform/apps/skill-bench/src/authoring/execution/execution-route.ts
git commit -m "refactor(skill-bench): share package and target resolution between routes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 2: A `revision` tool policy that can read and cannot write

**Files:**
- Modify: `platform/apps/skill-bench/src/mastra-tools.ts`
- Create: `platform/apps/skill-bench/src/turn-agent-revision.ts`
- Create: `platform/apps/skill-bench/src/turn-agent-revision.test.ts`
- Modify: `platform/apps/skill-bench/src/turn-agent.ts`
- Modify: `platform/apps/skill-bench/src/session.ts`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces:
  - `TurnToolPolicy` gains `{ readonly kind: 'revision'; readonly replacementTools: Record<string, unknown> }`
  - `ChatSessionOptions.toolPolicy?: TurnToolPolicy` (default `{ kind: 'bench' }`)
  - `revisionInstructions(): string`
  - `CONDUCTIA_WRITE_TOOL = 'conductia_file_document'`, `CONDUCTIA_READ_ONLY_TOOL_NAMES: readonly string[]`
  - `createConductiaTools({ ..., readOnly?: boolean })`

- [ ] **Step 1: Write the failing test**

Create `platform/apps/skill-bench/src/turn-agent-revision.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MastraModelConfig } from '@mastra/core/llm';
import { nullLogger } from '@ignatious/agent-runtime';
import { describe, expect, it } from 'vitest';

import { COMMIT_SKILL_VERSION_TOOL } from './commit-skill-version-tool.js';
import { loadChatConfig } from './config.js';
import { CREATE_SKILL_TOOL } from './create-skill-tool.js';
import { LIST_SKILLS_TOOL } from './list-skills-tool.js';
import {
  CONDUCTIA_READ_ONLY_TOOL_NAMES,
  CONDUCTIA_WRITE_TOOL,
  PROFILE_TOOL,
} from './mastra-tools.js';
import { UNPROBED } from './sandbox.js';
import { FIND_RECENT_SKILL_RUN_TOOL } from './seed-bundle-tool.js';
import { mountedSkills } from './skills.js';
import { buildTurnAgent } from './turn-agent.js';
import { revisionInstructions } from './turn-agent-revision.js';

const SUBMIT = 'submit_replacements';

function fixtureConfig() {
  const root = mkdtempSync(join(tmpdir(), 'skill-bench-revision-policy-'));
  const store = join(root, 'store');
  mkdirSync(join(store, 'skills', 'reader'), { recursive: true });
  writeFileSync(
    join(store, 'skills', 'reader', 'SKILL.md'),
    '---\nname: reader\ndescription: A skill for a test.\n---\n\nDo the thing.\n',
  );
  return loadChatConfig({
    SKILL_BENCH_SKILLS: store,
    SKILL_BENCH_SEED: join(root, 'no-seed'),
    SKILL_BENCH_WORKSPACES: join(root, 'workspaces'),
    MODEL_CALLS: 'replay',
  });
}

function idleModel(): MastraModelConfig {
  return {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: 'scripted/test',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('streaming only');
    },
    doStream: () => {
      throw new Error('no call expected');
    },
  } as unknown as MastraModelConfig;
}

async function revisionAgent() {
  const config = fixtureConfig();
  return buildTurnAgent(
    {
      tenantId: 'tenant',
      leadId: 'lead',
      conversationId: '11111111-1111-4111-8111-111111111111',
      conductiaBaseUrl: config.conductiaBaseUrl,
      conductiaRequestToken: null,
      selection: null,
      modelId: config.model,
      modelFrom: 'test',
      effort: null,
      userEmail: null,
      startedAt: 0,
    },
    {
      config,
      mounted: mountedSkills(config, 'lead'),
      history: [],
      logger: nullLogger,
      abortSignal: new AbortController().signal,
      capabilities: UNPROBED,
      model: idleModel(),
      toolPolicy: { kind: 'revision', replacementTools: { [SUBMIT]: {} } },
    },
  );
}

describe('the revision tool policy', () => {
  it('offers every Conductia read and the submit tool', async () => {
    const turn = await revisionAgent();

    for (const name of CONDUCTIA_READ_ONLY_TOOL_NAMES) expect(turn.toolNames).toContain(name);
    expect(turn.toolNames).toContain(SUBMIT);
  });

  it('offers no Conductia write', async () => {
    const turn = await revisionAgent();

    expect(turn.toolNames).not.toContain(CONDUCTIA_WRITE_TOOL);
    expect(Object.keys(turn.parts.tools)).not.toContain(CONDUCTIA_WRITE_TOOL);
  });

  it('offers no profile, authoring or commit tool', async () => {
    const turn = await revisionAgent();

    for (const name of [
      PROFILE_TOOL,
      COMMIT_SKILL_VERSION_TOOL,
      CREATE_SKILL_TOOL,
      LIST_SKILLS_TOOL,
      FIND_RECENT_SKILL_RUN_TOOL,
    ]) {
      expect(turn.toolNames).not.toContain(name);
    }
  });

  it('reports exactly the tools it was built with', async () => {
    const turn = await revisionAgent();

    expect([...turn.toolNames].sort()).toEqual(Object.keys(turn.parts.tools).sort());
  });

  it('runs on the revision instructions', async () => {
    const turn = await revisionAgent();

    expect(turn.parts.instructions).toBe(revisionInstructions());
  });

  it('tells the model to submit once and to never invent a figure', () => {
    const text = revisionInstructions();

    expect(text).toContain('call submit_replacements exactly once');
    expect(text).toContain('A figure you cannot source is unresolved, never invented.');
    expect(text).not.toContain('\u2014');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/turn-agent-revision.test.ts`
Expected: FAIL, cannot find module `./turn-agent-revision.js`.

- [ ] **Step 3: Add the read-only option to `mastra-tools.ts`**

Add to `ConductiaToolOptions`:

```ts
  readonly readOnly?: boolean;
```

Add above `createConductiaTools`:

```ts
export const CONDUCTIA_WRITE_TOOL = 'conductia_file_document';
```

Change the signature and the last line of `createConductiaTools`:

```ts
export function createConductiaTools({
  client,
  workspace,
  clientForSkill,
  loadedSkills = [],
  readOnly = false,
}: ConductiaToolOptions): Record<string, unknown> {
```

```ts
  if (readOnly) delete tools[CONDUCTIA_WRITE_TOOL];
  return tools;
}
```

Add below `CONDUCTIA_TOOL_NAMES`:

```ts
export const CONDUCTIA_READ_ONLY_TOOL_NAMES: readonly string[] = CONDUCTIA_TOOL_NAMES.filter(
  name => name !== CONDUCTIA_WRITE_TOOL,
);
```

- [ ] **Step 4: Create `turn-agent-revision.ts`**

```ts
export function revisionInstructions(): string {
  return [
    'You are revising passages of a document that a skill produced for a banker.',
    'The message holds the whole document. Each passage to rewrite is wrapped in a passage tag that carries its id, and each has one comment from the banker.',
    'Rewrite only the marked passages. Never restate, move or correct text outside them.',
    'Return the full replacement for each passage as Markdown, in the block form the passage already has: a list item stays a list item with its marker, a table row stays a table row with the same number of cells, a heading stays a heading.',
    'Use a lookup tool only when a comment calls for a fact you do not have. Read the mounted skill when a comment turns on the rules or the format the document follows.',
    'If you cannot do what a comment asks, mark it unresolved with one sentence that says why. A figure you cannot source is unresolved, never invented.',
    'To remove a passage, return an empty text for it.',
    'When every passage has a replacement or a reason, call submit_replacements exactly once, then stop.',
    'You cannot file, upload or change anything on the deal.',
    'Write without em dashes; use commas, periods, colons or parentheses instead.',
  ].join('\n');
}
```

- [ ] **Step 5: Add the arm to `turn-agent.ts`**

Import `revisionInstructions` from `./turn-agent-revision.js`.

Replace the type:

```ts
export type TurnToolPolicy =
  | { readonly kind: 'bench' }
  | { readonly kind: 'authoring'; readonly candidateTools: Record<string, unknown> }
  | { readonly kind: 'revision'; readonly replacementTools: Record<string, unknown> };
```

The revision turn keeps the bench workspace (filesystem and sandbox), so a downloaded document can be opened. Five places change:

1. The sandbox home, so a revision turn has one:

```ts
  if (options.toolPolicy.kind !== 'authoring') await mkdir(home, { recursive: true });
```

2. The instructions:

```ts
  const turnInstructions =
    options.toolPolicy.kind === 'authoring'
      ? authoringInstructions()
      : options.toolPolicy.kind === 'revision'
        ? revisionInstructions()
        : instructions(
            workspaceDirectory,
            selection.enabled.filter(declaresRouting).map(skill => skill.name),
          );
```

Keep the existing comment inside the `instructions(...)` call where it is.

3. Model call logging, so a revision turn is logged as a bench turn is:

```ts
  const turnModel =
    options.toolPolicy.kind === 'authoring' ? rawModel : withModelCallLogging(rawModel, logger);
```

4. The tools. Insert a middle arm and leave the bench object literal as the last arm, untouched apart from the indentation the formatter gives it:

```ts
  const tools =
    options.toolPolicy.kind === 'authoring'
      ? options.toolPolicy.candidateTools
      : options.toolPolicy.kind === 'revision'
        ? {
            ...createConductiaTools({ client, workspace: workspaceDirectory, readOnly: true }),
            ...web.tools,
            ...options.toolPolicy.replacementTools,
          }
        : {
            ...createProfileTool({
```

5. The reported names:

```ts
    toolNames:
      options.toolPolicy.kind === 'authoring'
        ? Object.keys(options.toolPolicy.candidateTools)
        : options.toolPolicy.kind === 'revision'
          ? Object.keys(tools)
          : [
              PROFILE_TOOL,
              ...CONDUCTIA_TOOL_NAMES,
              ...web.names,
              FIND_RECENT_SKILL_RUN_TOOL,
              COMMIT_SKILL_VERSION_TOOL,
              CREATE_SKILL_TOOL,
              LIST_SKILLS_TOOL,
            ],
```

Then run `pnpm exec prettier --write apps/skill-bench/src/turn-agent.ts` from `platform/`. A whitespace-only re-indent of the bench tools literal is expected.

- [ ] **Step 6: Let `runTurn` take a policy, in `session.ts`**

Add `type TurnToolPolicy` to the existing import from `./turn-agent.js`.

Add to `ChatSessionOptions`:

```ts
  readonly toolPolicy?: TurnToolPolicy;
```

In `runTurn`, add `toolPolicy = { kind: 'bench' },` to the destructured options (after `sandbox: sandboxSeam,`), and in the `buildTurnAgent` call replace `toolPolicy: { kind: 'bench' },` with `toolPolicy,`.

- [ ] **Step 7: Run the tests and the type check**

```bash
pnpm --filter @ignatious/skill-bench exec vitest run src/turn-agent-revision.test.ts src/authoring/generator.test.ts src/session.test.ts
pnpm --filter @ignatious/skill-bench typecheck
```

Expected: PASS. `generator.test.ts` still proves the bench and authoring arms are unchanged.

- [ ] **Step 8: Commit**

```bash
git add platform/apps/skill-bench/src/mastra-tools.ts \
        platform/apps/skill-bench/src/turn-agent-revision.ts \
        platform/apps/skill-bench/src/turn-agent-revision.test.ts \
        platform/apps/skill-bench/src/turn-agent.ts \
        platform/apps/skill-bench/src/session.ts
git commit -m "feat(skill-bench): a revision tool policy that reads and cannot write

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: Capture what the model submits, and build its message

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/revision/replacements-tool.ts`
- Create: `platform/apps/skill-bench/src/authoring/revision/replacements-tool.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/revision/revision-message.ts`
- Create: `platform/apps/skill-bench/src/authoring/revision/revision-message.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/revision/revision-turn.test.ts`

**Interfaces:**
- Consumes: `ChatSessionOptions.toolPolicy` and the `revision` arm (Task 2).
- Produces:
  - `SUBMIT_REPLACEMENTS_TOOL = 'submit_replacements'`, `NO_REPLACEMENT_REASON`
  - `type Replacement = { readonly id: string; readonly text: string } | { readonly id: string; readonly unresolved: string }`
  - `interface ReplacementCapture { readonly tools: Record<string, unknown>; submitted(): boolean; read(): readonly Replacement[] }`
  - `createReplacementCapture(passageIds: readonly string[]): ReplacementCapture`
  - `interface RevisionPassage { readonly id: string; readonly start: number; readonly end: number; readonly comment: string }`
  - `buildRevisionMessage(document: string, passages: readonly RevisionPassage[]): string`

- [ ] **Step 1: Write the failing tests**

Create `platform/apps/skill-bench/src/authoring/revision/replacements-tool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  createReplacementCapture,
  NO_REPLACEMENT_REASON,
  SUBMIT_REPLACEMENTS_TOOL,
} from './replacements-tool.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '99999999-9999-4999-8999-999999999999';

function submit(capture: ReturnType<typeof createReplacementCapture>, replacements: unknown) {
  const tool = capture.tools[SUBMIT_REPLACEMENTS_TOOL] as {
    execute(raw: unknown): Promise<unknown>;
  };
  return tool.execute({ replacements });
}

describe('submit_replacements', () => {
  it('reports nothing submitted before the model calls it', () => {
    const capture = createReplacementCapture([FIRST]);

    expect(capture.submitted()).toBe(false);
  });

  it('keeps a text and an unresolved reason, in passage order', async () => {
    const capture = createReplacementCapture([FIRST, SECOND]);

    await submit(capture, [
      { id: SECOND, unresolved: 'No document states this figure.' },
      { id: FIRST, text: 'Revenue grew 12%.' },
    ]);

    expect(capture.submitted()).toBe(true);
    expect(capture.read()).toEqual([
      { id: FIRST, text: 'Revenue grew 12%.' },
      { id: SECOND, unresolved: 'No document states this figure.' },
    ]);
  });

  it('ignores an id that was not sent and tells the model so', async () => {
    const capture = createReplacementCapture([FIRST]);

    const result = await submit(capture, [
      { id: FIRST, text: 'Kept.' },
      { id: STRANGER, text: 'Not asked for.' },
    ]);

    expect(result).toEqual({ accepted: [FIRST], ignored: [STRANGER], missing: [] });
    expect(capture.read()).toEqual([{ id: FIRST, text: 'Kept.' }]);
  });

  it('marks a passage the model skipped as unresolved', async () => {
    const capture = createReplacementCapture([FIRST, SECOND]);

    const result = await submit(capture, [{ id: FIRST, text: 'Only this one.' }]);

    expect(result).toEqual({ accepted: [FIRST], ignored: [], missing: [SECOND] });
    expect(capture.read()).toEqual([
      { id: FIRST, text: 'Only this one.' },
      { id: SECOND, unresolved: NO_REPLACEMENT_REASON },
    ]);
  });

  it('treats an item with both a text and a reason as unresolved', async () => {
    const capture = createReplacementCapture([FIRST]);

    await submit(capture, [{ id: FIRST, text: 'A guess.', unresolved: 'Not sure.' }]);

    expect(capture.read()).toEqual([{ id: FIRST, unresolved: 'Not sure.' }]);
  });

  it('accepts an empty text, which removes the passage', async () => {
    const capture = createReplacementCapture([FIRST]);

    await submit(capture, [{ id: FIRST, text: '' }]);

    expect(capture.read()).toEqual([{ id: FIRST, text: '' }]);
  });

  it('merges a second call into the first', async () => {
    const capture = createReplacementCapture([FIRST, SECOND]);

    await submit(capture, [{ id: FIRST, text: 'First.' }]);
    await submit(capture, [{ id: SECOND, text: 'Second.' }]);

    expect(capture.read()).toEqual([
      { id: FIRST, text: 'First.' },
      { id: SECOND, text: 'Second.' },
    ]);
  });
});
```

Create `platform/apps/skill-bench/src/authoring/revision/revision-message.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildRevisionMessage } from './revision-message.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '# Memo\n\nRevenue fell.\n\n- one\n- two';

describe('buildRevisionMessage', () => {
  it('wraps each passage in place and leaves the rest of the document as written', () => {
    const message = buildRevisionMessage(DOCUMENT, [
      { id: FIRST, start: 8, end: 21, comment: 'It rose.' },
    ]);

    expect(message).toBe(
      [
        '<document>',
        `# Memo\n\n<passage id="${FIRST}">\nRevenue fell.\n</passage>\n\n- one\n- two`,
        '</document>',
        '',
        '<comments>',
        `<comment passage="${FIRST}">\nIt rose.\n</comment>`,
        '</comments>',
      ].join('\n'),
    );
  });

  it('orders passages by position whatever order they arrive in', () => {
    const message = buildRevisionMessage(DOCUMENT, [
      { id: SECOND, start: 23, end: 28, comment: 'Second.' },
      { id: FIRST, start: 8, end: 21, comment: 'First.' },
    ]);

    expect(message.indexOf(FIRST)).toBeLessThan(message.indexOf(SECOND));
    expect(message).toContain(`<passage id="${SECOND}">\n- one\n</passage>`);
    expect(message).toContain(`<comment passage="${SECOND}">\nSecond.\n</comment>`);
  });
});
```

Create `platform/apps/skill-bench/src/authoring/revision/revision-turn.test.ts`. It runs the real agent loop on a scripted model, so it proves the tool reaches the model and its call is captured:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MastraModelConfig } from '@mastra/core/llm';
import { describe, expect, it } from 'vitest';

import { loadChatConfig } from '../../config.js';
import { CONDUCTIA_WRITE_TOOL } from '../../mastra-tools.js';
import { runTurn } from '../../session.js';
import { createReplacementCapture, SUBMIT_REPLACEMENTS_TOOL } from './replacements-tool.js';

const PASSAGE = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

const FINISH = {
  type: 'finish',
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function fixtureConfig() {
  const root = mkdtempSync(join(tmpdir(), 'skill-bench-revision-turn-'));
  const store = join(root, 'store');
  mkdirSync(join(store, 'skills', 'reader'), { recursive: true });
  writeFileSync(
    join(store, 'skills', 'reader', 'SKILL.md'),
    '---\nname: reader\ndescription: A skill for a test.\n---\n\nDo the thing.\n',
  );
  return loadChatConfig({
    SKILL_BENCH_SKILLS: store,
    SKILL_BENCH_SEED: join(root, 'no-seed'),
    SKILL_BENCH_WORKSPACES: join(root, 'workspaces'),
    MODEL_CALLS: 'replay',
  });
}

function scriptedModel(steps: readonly (readonly Record<string, unknown>[])[]): MastraModelConfig {
  let index = 0;
  return {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: 'scripted/test',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('streaming only');
    },
    doStream: () => {
      const parts = steps[Math.min(index, steps.length - 1)] ?? [FINISH];
      index += 1;
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      });
    },
  } as unknown as MastraModelConfig;
}

describe('a revision turn', () => {
  it('captures what the model submits and never offers the write tool', async () => {
    const capture = createReplacementCapture([PASSAGE]);
    const offered: Record<string, unknown>[] = [];
    const model = scriptedModel([
      [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: SUBMIT_REPLACEMENTS_TOOL,
          input: JSON.stringify({ replacements: [{ id: PASSAGE, text: 'Revenue grew 12%.' }] }),
        },
        FINISH,
      ],
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Done.' },
        { type: 'text-end', id: 't' },
        FINISH,
      ],
    ]);

    const types: string[] = [];
    for await (const { event } of runTurn(
      { tenantId: 'tn_test', leadId: 'lead_test', message: 'revise', conversationId: CONVERSATION },
      {
        config: { ...fixtureConfig(), durableTurns: false },
        model,
        onOptions: seen => {
          offered.push(seen);
        },
        toolPolicy: { kind: 'revision', replacementTools: capture.tools },
      },
    )) {
      types.push(event.type);
    }

    expect(types).toContain('done');
    expect(capture.read()).toEqual([{ id: PASSAGE, text: 'Revenue grew 12%.' }]);
    expect(offered[0]?.['tools']).toContain(SUBMIT_REPLACEMENTS_TOOL);
    expect(offered[0]?.['tools']).not.toContain(CONDUCTIA_WRITE_TOOL);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/revision`
Expected: FAIL, cannot find `./replacements-tool.js` and `./revision-message.js`.

- [ ] **Step 3: Create `replacements-tool.ts`**

```ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const SUBMIT_REPLACEMENTS_TOOL = 'submit_replacements';
export const MAX_REPLACEMENT_CHARS = 200_000;
export const MAX_REASON_CHARS = 500;
export const NO_REPLACEMENT_REASON = 'The assistant returned nothing for this passage.';

export type Replacement =
  | { readonly id: string; readonly text: string }
  | { readonly id: string; readonly unresolved: string };

export interface ReplacementCapture {
  readonly tools: Record<string, unknown>;
  submitted(): boolean;
  read(): readonly Replacement[];
}

const ItemSchema = z
  .object({
    id: z.string().min(1).describe('The id on the passage tag.'),
    text: z
      .string()
      .max(MAX_REPLACEMENT_CHARS)
      .optional()
      .describe('The full Markdown that replaces the passage. Empty removes the passage.'),
    unresolved: z
      .string()
      .min(1)
      .max(MAX_REASON_CHARS)
      .optional()
      .describe('One sentence saying why the comment could not be applied.'),
  })
  .strict();

const InputSchema = z.object({ replacements: z.array(ItemSchema).max(40) }).strict();

export function createReplacementCapture(passageIds: readonly string[]): ReplacementCapture {
  const known = new Set(passageIds);
  const captured = new Map<string, Replacement>();
  let called = false;

  return {
    tools: {
      [SUBMIT_REPLACEMENTS_TOOL]: createTool({
        id: SUBMIT_REPLACEMENTS_TOOL,
        description:
          'Submit the result for every marked passage in one call: the replacement text, or ' +
          'the reason it is unresolved. Text outside the passages cannot be changed.',
        inputSchema: InputSchema,
        execute: async (raw: unknown) => {
          const { replacements } = InputSchema.parse(raw);
          called = true;
          const ignored: string[] = [];
          for (const item of replacements) {
            if (!known.has(item.id)) {
              ignored.push(item.id);
            } else if (item.unresolved !== undefined) {
              captured.set(item.id, { id: item.id, unresolved: item.unresolved });
            } else if (item.text !== undefined) {
              captured.set(item.id, { id: item.id, text: item.text });
            }
          }
          return {
            accepted: passageIds.filter(id => captured.has(id)),
            ignored,
            missing: passageIds.filter(id => !captured.has(id)),
          };
        },
      }),
    },
    submitted: () => called,
    read: () =>
      passageIds.map(id => captured.get(id) ?? { id, unresolved: NO_REPLACEMENT_REASON }),
  };
}
```

- [ ] **Step 4: Create `revision-message.ts`**

```ts
export interface RevisionPassage {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly comment: string;
}

export function buildRevisionMessage(
  document: string,
  passages: readonly RevisionPassage[],
): string {
  const ordered = [...passages].sort((left, right) => left.start - right.start);
  let marked = '';
  let cursor = 0;
  for (const passage of ordered) {
    marked +=
      document.slice(cursor, passage.start) +
      `<passage id="${passage.id}">\n` +
      document.slice(passage.start, passage.end) +
      '\n</passage>';
    cursor = passage.end;
  }
  marked += document.slice(cursor);

  const comments = ordered
    .map(passage => `<comment passage="${passage.id}">\n${passage.comment}\n</comment>`)
    .join('\n');

  return ['<document>', marked, '</document>', '', '<comments>', comments, '</comments>'].join(
    '\n',
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/revision`
Expected: PASS, three files.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/revision/replacements-tool.ts \
        platform/apps/skill-bench/src/authoring/revision/replacements-tool.test.ts \
        platform/apps/skill-bench/src/authoring/revision/revision-message.ts \
        platform/apps/skill-bench/src/authoring/revision/revision-message.test.ts \
        platform/apps/skill-bench/src/authoring/revision/revision-turn.test.ts
git commit -m "feat(skill-bench): capture a revision turn's replacements by passage id

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: `POST /skill-run-revisions`

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/revision/revision-route.ts`
- Create: `platform/apps/skill-bench/src/authoring/revision/revision-route.test.ts`
- Modify: `platform/apps/skill-bench/src/session.ts` (the `ChatEvent` union)
- Modify: `platform/apps/skill-bench/src/server.ts`
- Modify: `platform/apps/skill-bench/src/routes-match-table.test.ts`

**Interfaces:**
- Consumes: `resolveRunnablePackage`, `SkillReferenceSchema`, `resolveTarget`, `reportingModel`, `overRunRoot`, `describeIssues`, `SkillRunDeps` (Task 1); the `revision` policy and `ChatSessionOptions.toolPolicy` (Task 2); `createReplacementCapture`, `buildRevisionMessage` (Task 3).
- Produces, for Conductia (Tasks 9 and 12):
  - Route `POST /v1/bench/skill-run-revisions`, behind the bench's shared key, body:
    `{ revisionId: uuid, skill: SkillReference | null, document: string (1 to 200,000), passages: [{ id: uuid, start, end, comment (1 to 2,000) }] (1 to 20), tenantId, leadId, token?, conductiaBaseUrl?, model? }`
  - A server-sent event stream with the frames a run has, plus `{ type: 'replacements', items: ({ id, text } | { id, unresolved })[] }` sent immediately before `done`, only when the model submitted. `done` gains `skillMounted: boolean` beside `costUsd`, `model`, `modelId`, `clampedFrom`.
  - `mountSkillRunRevisions(app: Hono, deps: SkillRunDeps | null, logger?: Logger): void`

- [ ] **Step 1: Write the failing test**

Create `platform/apps/skill-bench/src/authoring/revision/revision-route.test.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PositionedEvent } from '../../chunk-events.js';
import type { ChatConfig } from '../../config.js';
import type { ChatSessionOptions, TurnRequest } from '../../session.js';
import { mountedSkills } from '../../skills.js';
import { zipSkillFolder } from '../../skill-zip.js';
import type { SkillRunDeps } from '../execution/execution-route.js';
import { libraryConfig, libraryRoot, removeLibraryRoot } from '../publication/bench-app-fixture.js';
import type { PublishedPackage } from '../publication/store.js';
import { NO_REPLACEMENT_REASON, SUBMIT_REPLACEMENTS_TOOL } from './replacements-tool.js';
import { mountSkillRunRevisions } from './revision-route.js';

const DOCUMENT = '# Memo\n\nRevenue fell.\n\n- one\n- two';
const FIRST = { id: '11111111-1111-4111-8111-111111111111', start: 8, end: 21, comment: 'It rose.' };
const SECOND = {
  id: '22222222-2222-4222-8222-222222222222',
  start: 23,
  end: 28,
  comment: 'Name the buyer.',
};

interface SeenTurn {
  readonly request: TurnRequest;
  readonly options: ChatSessionOptions;
  readonly mountedAtTurn: readonly string[];
}

type ScriptedTurn = (
  request: TurnRequest,
  options: ChatSessionOptions,
) => AsyncGenerator<PositionedEvent>;

let root = '';
let config: ChatConfig;
let executionRoot = '';
let published: PublishedPackage | null = null;
const seen: SeenTurn[] = [];

beforeEach(() => {
  root = libraryRoot();
  config = libraryConfig(root);
  executionRoot = join(root, 'skill-runs');
  published = null;
  seen.length = 0;
});

afterEach(() => {
  if (root !== '') removeLibraryRoot(root);
  root = '';
});

function publish(maxModel?: string): PublishedPackage {
  const folder = join(root, 'source', 'reader');
  mkdirSync(folder, { recursive: true });
  const ceiling = maxModel === undefined ? '' : `max-model: ${maxModel}\n`;
  writeFileSync(
    join(folder, 'SKILL.md'),
    `---\nname: reader\ndescription: A read-only fixture skill.\n${ceiling}---\n\nRead instructions.\n`,
  );
  const packageBytes = Buffer.from(zipSkillFolder(folder, 'reader'));
  published = {
    skillId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    digest: createHash('sha256').update(packageBytes).digest('hex'),
    packageBytes,
  };
  return published;
}

function submittingTurn(items: readonly Record<string, unknown>[] | null): ScriptedTurn {
  return async function* (request, options) {
    seen.push({
      request,
      options,
      mountedAtTurn: mountedSkills(options.config, request.leadId).skills.map(skill => skill.name),
    });
    const policy = options.toolPolicy;
    if (items !== null && policy?.kind === 'revision') {
      const tool = policy.replacementTools[SUBMIT_REPLACEMENTS_TOOL] as {
        execute(raw: unknown): Promise<unknown>;
      };
      await tool.execute({ replacements: items });
    }
    yield { event: { type: 'text', text: 'Done.' }, at: 1 };
    yield { event: { type: 'done', costUsd: 0.04, durationMs: 1200 }, at: 2 };
  };
}

function deps(runTurn: ScriptedTurn): SkillRunDeps {
  return {
    config,
    executionRoot,
    readPublishedPackage: (skillId, versionId, projectId) =>
      Promise.resolve(
        published !== null &&
          published.skillId === skillId &&
          published.versionId === versionId &&
          published.projectId === projectId
          ? published
          : null,
      ),
    runTurn,
  };
}

function appWith(deps: SkillRunDeps | null): Hono {
  const app = new Hono();
  mountSkillRunRevisions(app, deps);
  return app;
}

function reference(record: PublishedPackage, digest: string = record.digest) {
  return {
    kind: 'publication',
    projectId: record.projectId,
    skillId: record.skillId,
    versionId: record.versionId,
    digest,
  };
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    revisionId: randomUUID(),
    skill: null,
    document: DOCUMENT,
    passages: [FIRST, SECOND],
    tenantId: 'tenant-1',
    leadId: 'lead-1',
    ...overrides,
  });
}

function post(app: Hono, payload: string, headers: Record<string, string> = {}) {
  return app.request('/skill-run-revisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
}

function frames(text: string): Record<string, unknown>[] {
  return text
    .split('\n\n')
    .map(chunk => chunk.split('\n').find(line => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined && line !== 'data: {}')
    .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

async function errorCode(response: Response): Promise<unknown> {
  const parsed = (await response.json()) as { error?: { code?: unknown } };
  return parsed.error?.code;
}

describe('POST /skill-run-revisions', () => {
  it('answers 503 when skill execution is not configured', async () => {
    const response = await post(appWith(null), body());

    expect(response.status).toBe(503);
  });

  it('refuses passages that overlap', async () => {
    const response = await post(
      appWith(deps(submittingTurn([]))),
      body({ passages: [FIRST, { ...SECOND, start: 20 }] }),
    );

    expect(await errorCode(response)).toBe('validation');
    expect(seen).toHaveLength(0);
  });

  it('refuses a passage that runs past the end of the document', async () => {
    const response = await post(
      appWith(deps(submittingTurn([]))),
      body({ passages: [{ ...SECOND, end: DOCUMENT.length + 1 }] }),
    );

    expect(await errorCode(response)).toBe('validation');
  });

  it('refuses two passages with one id', async () => {
    const response = await post(
      appWith(deps(submittingTurn([]))),
      body({ passages: [FIRST, { ...SECOND, id: FIRST.id }] }),
    );

    expect(await errorCode(response)).toBe('validation');
  });

  it('sends the replacements for every passage, then done', async () => {
    const record = publish();
    const turn = submittingTurn([
      { id: FIRST.id, text: 'Revenue rose 12%.' },
      { id: SECOND.id, unresolved: 'No document names the buyer.' },
    ]);

    const response = await post(appWith(deps(turn)), body({ skill: reference(record) }));
    const sent = frames(await response.text());

    expect(response.status).toBe(200);
    expect(sent.map(frame => frame['type'])).toEqual(['text', 'replacements', 'done']);
    expect(sent[1]).toEqual({
      type: 'replacements',
      items: [
        { id: FIRST.id, text: 'Revenue rose 12%.' },
        { id: SECOND.id, unresolved: 'No document names the buyer.' },
      ],
    });
    expect(sent[2]).toMatchObject({ type: 'done', costUsd: 0.04, skillMounted: true });
  });

  it('runs the turn on the pinned skill alone, read-only and not durable', async () => {
    const record = publish();
    const revisionId = randomUUID();

    const response = await post(
      appWith(deps(submittingTurn([]))),
      body({ revisionId, skill: reference(record) }),
      { authorization: 'Bearer caller-token' },
    );
    await response.text();

    expect(seen[0]?.mountedAtTurn).toEqual(['reader']);
    expect(seen[0]?.request).toMatchObject({
      conversationId: revisionId,
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      token: 'caller-token',
      selection: null,
    });
    expect(seen[0]?.request.message).toContain(`<passage id="${FIRST.id}">\nRevenue fell.\n</passage>`);
    expect(seen[0]?.request.message).toContain(`<comment passage="${SECOND.id}">\nName the buyer.\n</comment>`);
    expect(seen[0]?.options.toolPolicy?.kind).toBe('revision');
    expect(seen[0]?.options.config.durableTurns).toBe(false);
    expect(seen[0]?.options.config.skillsRoot).toBe(join(executionRoot, revisionId));
  });

  it('proceeds with nothing mounted when there is no skill reference', async () => {
    const response = await post(
      appWith(deps(submittingTurn([{ id: FIRST.id, text: 'Rose.' }]))),
      body({ passages: [FIRST] }),
    );
    const sent = frames(await response.text());

    expect(seen[0]?.mountedAtTurn).toEqual([]);
    expect(seen[0]?.options.config.skillsRoot).not.toBe(config.skillsRoot);
    expect(sent.at(-1)).toMatchObject({ type: 'done', skillMounted: false });
  });

  it('proceeds with nothing mounted when the skill version no longer resolves', async () => {
    const record = publish();

    const response = await post(
      appWith(deps(submittingTurn([{ id: FIRST.id, text: 'Rose.' }]))),
      body({ passages: [FIRST], skill: reference(record, 'f'.repeat(64)) }),
    );
    const sent = frames(await response.text());

    expect(response.status).toBe(200);
    expect(seen[0]?.mountedAtTurn).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: 'done', skillMounted: false });
  });

  it('marks a passage the model skipped as unresolved', async () => {
    const response = await post(
      appWith(deps(submittingTurn([{ id: FIRST.id, text: 'Rose.' }]))),
      body(),
    );
    const sent = frames(await response.text());

    expect(sent.find(frame => frame['type'] === 'replacements')).toEqual({
      type: 'replacements',
      items: [
        { id: FIRST.id, text: 'Rose.' },
        { id: SECOND.id, unresolved: NO_REPLACEMENT_REASON },
      ],
    });
  });

  it('sends no replacements frame when the model never submitted', async () => {
    const response = await post(appWith(deps(submittingTurn(null))), body());
    const sent = frames(await response.text());

    expect(sent.map(frame => frame['type'])).toEqual(['text', 'done']);
  });

  it('removes the run root when the stream ends', async () => {
    const record = publish();
    const revisionId = randomUUID();

    const response = await post(
      appWith(deps(submittingTurn([]))),
      body({ revisionId, skill: reference(record) }),
    );
    await response.text();

    expect(existsSync(join(executionRoot, revisionId))).toBe(false);
  });

  it('clamps the model to the mounted skill ceiling and says so on done', async () => {
    const record = publish('haiku');

    const response = await post(
      appWith(deps(submittingTurn([]))),
      body({ skill: reference(record), model: 'opus' }),
    );
    const sent = frames(await response.text());

    expect(seen[0]?.request.model).toBe('haiku');
    expect(sent.at(-1)).toMatchObject({ type: 'done', clampedFrom: 'opus' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/revision/revision-route.test.ts`
Expected: FAIL, cannot find module `./revision-route.js`.

- [ ] **Step 3: Add the frame to the `ChatEvent` union, in `session.ts`**

Add a member to the union, beside `text`:

```ts
  | {
      readonly type: 'replacements';
      readonly items: readonly (
        | { readonly id: string; readonly text: string }
        | { readonly id: string; readonly unresolved: string }
      )[];
    }
```

Add one field to the `done` member, after `clampedFrom`:

```ts
      readonly skillMounted?: boolean;
```

- [ ] **Step 4: Create `revision-route.ts`**

```ts
import { join } from 'node:path';

import { apiError } from '@ignatious/http-envelope';
import type { Logger } from '@ignatious/agent-runtime';
import { nullLogger } from '@ignatious/agent-runtime';
import type { Hono } from 'hono';
import { z } from 'zod';

import type { PositionedEvent } from '../../chunk-events.js';
import { aliasOfModelId, clampModel, MODEL_ALIASES, type ModelAlias } from '../../model-choice.js';
import { runTurn as defaultRunTurn } from '../../session.js';
import { ensureStore } from '../../skill-store.js';
import { mountedSkills } from '../../skills.js';
import { sseStream } from '../../sse.js';
import { bearerToken } from '../../token.js';
import { UuidSchema } from '../contract.js';
import { resolveTarget } from '../execution/conductia-target.js';
import {
  describeIssues,
  overRunRoot,
  reportingModel,
  type SkillRunDeps,
} from '../execution/execution-route.js';
import {
  resolveRunnablePackage,
  SkillReferenceSchema,
  type SkillReferenceInput,
} from '../execution/resolve-package.js';
import { closeRunRoot, DigestMismatch, openRunRoot } from '../execution/run-root.js';
import { fail, readJsonBody } from '../publication/routes-http.js';
import { createReplacementCapture, type ReplacementCapture } from './replacements-tool.js';
import { buildRevisionMessage } from './revision-message.js';

export const MAX_DOCUMENT_CHARS = 200_000;
export const MAX_PASSAGES = 20;
export const MAX_COMMENT_CHARS = 2_000;

const PassageSchema = z
  .object({
    id: UuidSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    comment: z.string().min(1).max(MAX_COMMENT_CHARS),
  })
  .strict();

const RevisionRequestSchema = z
  .object({
    revisionId: UuidSchema,
    skill: SkillReferenceSchema.nullable(),
    document: z.string().min(1).max(MAX_DOCUMENT_CHARS),
    passages: z.array(PassageSchema).min(1).max(MAX_PASSAGES),
    tenantId: z.string().min(1),
    leadId: z.string().min(1),
    token: z.string().nullable().optional(),
    conductiaBaseUrl: z.string().nullable().optional(),
    model: z.enum(MODEL_ALIASES).nullable().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const problem = passageProblem(request.document, request.passages);
    if (problem !== null) context.addIssue({ code: 'custom', path: ['passages'], message: problem });
  });

function passageProblem(
  document: string,
  passages: readonly z.infer<typeof PassageSchema>[],
): string | null {
  if (new Set(passages.map(passage => passage.id)).size !== passages.length) {
    return 'passage ids must be unique';
  }
  let cursor = 0;
  for (const passage of [...passages].sort((left, right) => left.start - right.start)) {
    if (passage.end <= passage.start || passage.end > document.length) {
      return 'a passage lies outside the document';
    }
    if (passage.start < cursor) return 'passages must not overlap';
    cursor = passage.end;
  }
  return null;
}

interface RevisionMount {
  readonly directory: string;
  readonly skillMounted: boolean;
  readonly maxModel: ModelAlias | null;
}

async function openRevisionMount(
  deps: SkillRunDeps,
  revisionId: string,
  skill: SkillReferenceInput | null,
  leadId: string,
  logger: Logger,
): Promise<RevisionMount> {
  const directory = join(deps.executionRoot, revisionId);
  const unmounted = (reason: string): RevisionMount => {
    ensureStore(directory);
    logger.info('revision runs without its skill', { revisionId, reason });
    return { directory, skillMounted: false, maxModel: null };
  };

  if (skill === null) return unmounted('no skill reference');
  const resolved = await resolveRunnablePackage(deps, skill, leadId);
  if (!resolved.ok) return unmounted(resolved.code);

  let opened;
  try {
    opened = await openRunRoot(deps.executionRoot, revisionId, resolved.pkg);
  } catch (error) {
    if (!(error instanceof DigestMismatch)) throw error;
    return unmounted('digest mismatch');
  }

  const declared = mountedSkills(
    { ...deps.config, skillsRoot: opened.directory, skillsBase: opened.directory },
    'execution',
  ).skills.find(entry => entry.name === opened.skillName);
  if (declared === undefined) {
    await closeRunRoot(opened.directory).catch(() => undefined);
    return unmounted('skill does not load');
  }
  return { directory: opened.directory, skillMounted: true, maxModel: declared.maxModel };
}

async function* withReplacements(
  events: AsyncGenerator<PositionedEvent>,
  capture: ReplacementCapture,
  skillMounted: boolean,
): AsyncGenerator<PositionedEvent> {
  for await (const positioned of events) {
    if (positioned.event.type !== 'done') {
      yield positioned;
      continue;
    }
    if (capture.submitted()) {
      yield { event: { type: 'replacements', items: capture.read() }, at: positioned.at };
    }
    yield { ...positioned, event: { ...positioned.event, skillMounted } };
  }
}

export function mountSkillRunRevisions(
  app: Hono,
  deps: SkillRunDeps | null,
  logger: Logger = nullLogger,
): void {
  app.post('/skill-run-revisions', async c => {
    if (deps === null) {
      return c.json(
        apiError('capability_unavailable', 'skill execution is not configured', {
          retryable: true,
        }),
        503,
      );
    }

    const parsed = RevisionRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return fail(c, 'validation', describeIssues(parsed.error));
    const request = parsed.data;

    const target = resolveTarget(c, deps.config, logger, request);
    if (!target.ok) return target.response;

    const mount = await openRevisionMount(
      deps,
      request.revisionId,
      request.skill,
      request.leadId,
      logger,
    );
    const asked = request.model ?? aliasOfModelId(deps.config.model);
    const clamped = clampModel(asked, mount.maxModel);
    const capture = createReplacementCapture(request.passages.map(passage => passage.id));

    const turn = (deps.runTurn ?? defaultRunTurn)(
      {
        tenantId: request.tenantId,
        leadId: request.leadId,
        message: buildRevisionMessage(request.document, request.passages),
        conversationId: request.revisionId,
        selection: null,
        model: clamped.allowed,
        token: bearerToken(c.req.header('authorization')) ?? request.token ?? null,
        conductiaBaseUrl: target.baseUrl,
      },
      {
        config: {
          ...deps.config,
          skillsRoot: mount.directory,
          skillsBase: mount.directory,
          durableTurns: false,
        },
        logger,
        toolPolicy: { kind: 'revision', replacementTools: capture.tools },
      },
    );

    const stream = sseStream(
      withReplacements(
        reportingModel(
          overRunRoot(turn, mount.directory, logger),
          clamped.allowed,
          clamped.allowed === clamped.asked ? null : clamped.asked,
        ),
        capture,
        mount.skillMounted,
      ),
    );

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });
}
```

- [ ] **Step 5: Mount it and list it as unpublished**

In `server.ts`, import `mountSkillRunRevisions` from `./authoring/revision/revision-route.js` and add one line directly under `mountSkillRuns(app, skillRuns, logger);`:

```ts
  mountSkillRunRevisions(app, skillRuns, logger);
```

In `routes-match-table.test.ts`, add the route to the set and bring the sentence above it up to date (it says "Two routes are dropped"; it becomes three, with `skill-run-revisions` serving Conductia's output revisions):

```ts
const UNPUBLISHED_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/bench/authoring/turns',
  'POST /v1/bench/skill-runs',
  'POST /v1/bench/skill-run-revisions',
]);
```

No load balancer change is needed: the public API already routes everything under `/v1/bench` to the bench.

- [ ] **Step 6: Run the tests and the type check**

```bash
pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/revision src/routes-match-table.test.ts src/authoring/execution
pnpm --filter @ignatious/skill-bench typecheck
```

Expected: PASS. If the type check reports a non-exhaustive `switch (event.type)` in `src/cli.ts`, add `case 'replacements': break;` there and nothing else.

- [ ] **Step 7: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/revision/revision-route.ts \
        platform/apps/skill-bench/src/authoring/revision/revision-route.test.ts \
        platform/apps/skill-bench/src/session.ts \
        platform/apps/skill-bench/src/server.ts \
        platform/apps/skill-bench/src/routes-match-table.test.ts
git commit -m "feat(skill-bench): POST /skill-run-revisions rewrites marked passages read-only

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 5: Verify Ignatious as a whole and stop for review

**Files:** none.

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces: a branch that is ready to push, and a local bench that Task 19 runs against.

- [ ] **Step 1: Run the bench suite, the type check and the linters**

```bash
cd /Users/cwillian/Documents/personal/learning/ignatious-skill-run-revisions/platform
pnpm --filter @ignatious/skill-bench test
pnpm typecheck
pnpm lint
```

Expected: all three pass. Fix formatting with `pnpm format` and commit only the files this branch touched.

- [ ] **Step 2: Confirm the diff is only what this plan names**

Run: `git diff --stat origin/main...HEAD`
Expected: the files listed under "Ignatious" in File Structure, and nothing else.

- [ ] **Step 3: Stop and report**

Report to Charles that the Ignatious branch `feat/skill-run-revisions` is ready, with the test counts. Do not push and do not open a pull request until he says so. The endpoint is additive, so it can deploy before Conductia's caller exists.

---

# Part B: Conductia foundation

All paths from here are relative to the Conductia worktree at `/Users/cwillian/orca/workspaces/conductia/inline-fixes-for-ai-output`, on branch `inline-fixes-for-ai-output`. Run `npm ci` once before Task 6: the worktree has no `node_modules`.

### Task 6: Block ranges of a Markdown text

**Files:**
- Create: `src/lib/skillRun/blocks.ts`
- Test: `tests/skill-run-blocks.test.ts`
- Modify: `package.json`, `package-lock.json` (two direct dependencies that are already installed transitively)

**Interfaces:**
- Consumes: nothing from this plan.
- Produces:
  - `type BlockKind = 'heading' | 'paragraph' | 'listItem' | 'tableRow' | 'blockquote' | 'code'`
  - `type Range = { start: number; end: number }`, `type Block = Range & { kind: BlockKind }`
  - `blockRanges(text: string): Block[]` in document order, never overlapping
  - `isAligned(blocks: Block[], range: Range): boolean`
  - `snapToBlocks(blocks: Block[], from: number, to: number): Range | null`
  - `blocksWithin(blocks: Block[], range: Range): Block[]`

- [ ] **Step 1: Declare the parser packages**

`react-markdown` already brings `unified` and `remark-parse` in. Declare them so the import does not depend on hoisting:

```bash
npm install unified@^11.0.0 remark-parse@^11.0.0
```

Expected: `package.json` gains two entries under `dependencies`, and `git diff --stat package-lock.json` shows a change of a few lines.

- [ ] **Step 2: Write the failing test**

Create `tests/skill-run-blocks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { blockRanges, blocksWithin, isAligned, snapToBlocks } from '@/lib/skillRun/blocks';

function texts(doc: string): [string, string][] {
  return blockRanges(doc).map((block) => [block.kind, doc.slice(block.start, block.end)]);
}

const FLAT = [
  '# Title',
  '',
  'First paragraph.',
  '',
  '- one',
  '- two',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '> quoted',
  '',
  '```',
  'code',
  '```',
].join('\n');

describe('blockRanges', () => {
  it('returns one block per heading, paragraph, list item, table row, quote and code block', () => {
    expect(texts(FLAT)).toEqual([
      ['heading', '# Title'],
      ['paragraph', 'First paragraph.'],
      ['listItem', '- one'],
      ['listItem', '- two'],
      ['tableRow', '| a | b |'],
      ['tableRow', '| 1 | 2 |'],
      ['blockquote', '> quoted'],
      ['code', '```\ncode\n```'],
    ]);
  });

  it('stops a parent list item before its nested items', () => {
    const doc = ['- parent', '  - child one', '  - child two', '- sibling'].join('\n');

    expect(texts(doc)).toEqual([
      ['listItem', '- parent'],
      ['listItem', '- child one'],
      ['listItem', '- child two'],
      ['listItem', '- sibling'],
    ]);
  });

  it('keeps the items of a loose list apart from the paragraph after it', () => {
    expect(texts(['- one', '', '- two', '', 'After.'].join('\n'))).toEqual([
      ['listItem', '- one'],
      ['listItem', '- two'],
      ['paragraph', 'After.'],
    ]);
  });

  it('keeps a wrapped paragraph and a wrapped list item whole', () => {
    expect(texts(['A paragraph', 'on two lines.', '', '- item', '  continued'].join('\n'))).toEqual([
      ['paragraph', 'A paragraph\non two lines.'],
      ['listItem', '- item\n  continued'],
    ]);
  });

  it('counts offsets in UTF-16 units, so text after an emoji is addressed correctly', () => {
    const doc = ['Growth 🚀 was strong.', '', 'Second é paragraph.'].join('\n');

    expect(blockRanges(doc)).toEqual([
      { kind: 'paragraph', start: 0, end: 21 },
      { kind: 'paragraph', start: 23, end: 42 },
    ]);
    expect(doc.slice(23, 42)).toBe('Second é paragraph.');
  });

  it('returns nothing for an empty text', () => {
    expect(blockRanges('')).toEqual([]);
  });
});

describe('isAligned', () => {
  const blocks = blockRanges(FLAT);

  it('accepts one whole block', () => {
    expect(isAligned(blocks, { start: 9, end: 25 })).toBe(true);
  });

  it('accepts a run of whole blocks', () => {
    expect(isAligned(blocks, { start: 9, end: 38 })).toBe(true);
  });

  it('refuses a range that starts inside a block', () => {
    expect(isAligned(blocks, { start: 10, end: 25 })).toBe(false);
  });

  it('refuses a range that ends inside a block', () => {
    expect(isAligned(blocks, { start: 9, end: 30 })).toBe(false);
  });
});

describe('snapToBlocks', () => {
  const blocks = blockRanges(FLAT);

  it('snaps a caret to the block it sits in', () => {
    expect(snapToBlocks(blocks, 12, 12)).toEqual({ start: 9, end: 25 });
  });

  it('snaps a selection across blocks to one passage, in either direction', () => {
    expect(snapToBlocks(blocks, 35, 12)).toEqual({ start: 9, end: 38 });
  });

  it('returns null between blocks', () => {
    expect(snapToBlocks(blocks, 26, 26)).toBeNull();
  });

  it('always agrees with the alignment check', () => {
    for (let from = 0; from <= FLAT.length; from += 1) {
      for (let to = from; to <= FLAT.length; to += 1) {
        const snapped = snapToBlocks(blocks, from, to);
        if (snapped !== null) expect(isAligned(blocks, snapped)).toBe(true);
      }
    }
  });
});

describe('blocksWithin', () => {
  it('lists the blocks a passage covers', () => {
    const blocks = blockRanges(FLAT);

    expect(blocksWithin(blocks, { start: 27, end: 38 })).toEqual([
      { kind: 'listItem', start: 27, end: 32 },
      { kind: 'listItem', start: 33, end: 38 },
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/skill-run-blocks.test.ts`
Expected: FAIL, cannot resolve `@/lib/skillRun/blocks`.

- [ ] **Step 4: Create `src/lib/skillRun/blocks.ts`**

This exact logic was run against the installed parser while the plan was written, and produced the values the test expects.

```ts
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export type BlockKind = 'heading' | 'paragraph' | 'listItem' | 'tableRow' | 'blockquote' | 'code';

export type Range = { start: number; end: number };

export type Block = Range & { kind: BlockKind };

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

const LEAF_KINDS: Record<string, BlockKind> = {
  heading: 'heading',
  paragraph: 'paragraph',
  blockquote: 'blockquote',
  code: 'code',
};

const parser = unified().use(remarkParse).use(remarkGfm);

function rangeOf(node: MarkdownNode): Range | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

function push(into: Block[], kind: BlockKind, range: Range | null): void {
  if (range && range.end > range.start) into.push({ kind, ...range });
}

function collectItem(item: MarkdownNode, into: Block[]): void {
  const children = item.children ?? [];
  const firstList = children.findIndex((child) => child.type === 'list');
  const whole = rangeOf(item);
  if (firstList === -1) {
    push(into, 'listItem', whole);
    return;
  }
  const lastHead = firstList > 0 ? rangeOf(children[firstList - 1]) : null;
  if (whole && lastHead) push(into, 'listItem', { start: whole.start, end: lastHead.end });
  collect(children.slice(firstList), into);
}

function collect(nodes: MarkdownNode[], into: Block[]): void {
  for (const node of nodes) {
    if (node.type === 'list') {
      for (const item of node.children ?? []) collectItem(item, into);
    } else if (node.type === 'table') {
      for (const row of node.children ?? []) push(into, 'tableRow', rangeOf(row));
    } else if (LEAF_KINDS[node.type]) {
      push(into, LEAF_KINDS[node.type], rangeOf(node));
    }
  }
}

export function blockRanges(text: string): Block[] {
  const blocks: Block[] = [];
  collect((parser.parse(text) as MarkdownNode).children ?? [], blocks);
  return blocks;
}

export function isAligned(blocks: Block[], range: Range): boolean {
  const first = blocks.findIndex((block) => block.start === range.start);
  return first !== -1 && blocks.slice(first).some((block) => block.end === range.end);
}

export function snapToBlocks(blocks: Block[], from: number, to: number): Range | null {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const touched = blocks.filter((block) =>
    low === high ? block.start <= low && low <= block.end : block.start < high && block.end > low,
  );
  if (touched.length === 0) return null;
  return { start: touched[0].start, end: touched[touched.length - 1].end };
}

export function blocksWithin(blocks: Block[], range: Range): Block[] {
  return blocks.filter((block) => block.start >= range.start && block.end <= range.end);
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/skill-run-blocks.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skillRun/blocks.ts tests/skill-run-blocks.test.ts package.json package-lock.json
git commit -m "feat(skill-run): block ranges of a Markdown output, shared by browser and server

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 7: Parse, validate and splice edits

**Files:**
- Create: `src/lib/skillRun/revisions.ts`
- Modify: `src/lib/skillRun/types.ts`
- Test: `tests/skill-run-revisions.test.ts`

**Interfaces:**
- Consumes: `blockRanges`, `isAligned`, `type Range` (Task 6).
- Produces, in `types.ts`:
  - `REVISION_LIMITS = { edits: 20, comment: 2_000, text: 200_000 } as const`
  - `type EditKind = 'comment' | 'hand'`, `type EditStatus = 'applied' | 'unresolved' | 'failed'`
  - `type EditRequest = { kind: 'comment'; start: number; end: number; comment: string } | { kind: 'hand'; start: number; end: number; text: string }`
  - `type EditRecord = { id: string; kind: EditKind; start: number; end: number; comment?: string; status: EditStatus; reason?: string; resultStart?: number; resultEnd?: number }`
  - `type RevisionInputs = { kind: 'edits'; edits: EditRecord[]; skillMounted?: boolean } | { kind: 'restore'; restoredFrom: string }`
- Produces, in `revisions.ts`:
  - `type RevisionRequest = { kind: 'edits'; parentId: string; edits: EditRequest[] } | { kind: 'restore'; parentId: string; restoreOf: string }`
  - `type Replacement = Range & { text: string }`
  - `parseRevisionRequest(body: unknown): RevisionRequest | { error: string }`
  - `validateEdits(text: string, edits: readonly Range[]): string | null`
  - `cleanReplacement(raw: string): string`
  - `shiftRange(range: Range, replacements: readonly Replacement[]): Range`
  - `splice(text: string, replacements: readonly Replacement[]): { text: string; ranges: Range[] }` with `ranges` in the order of `replacements`
  - `storageProblem(text: string): string | null`
  - `digestOf(value: string): string`, `editsDigest(edits: readonly EditRequest[]): string`
  - `countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>>`
  - `parseRevisionInputs(value: unknown): RevisionInputs | null`

- [ ] **Step 1: Write the failing test**

Create `tests/skill-run-revisions.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { blockRanges } from '@/lib/skillRun/blocks';
import {
  cleanReplacement,
  countBy,
  editsDigest,
  parseRevisionInputs,
  parseRevisionRequest,
  shiftRange,
  splice,
  storageProblem,
  validateEdits,
} from '@/lib/skillRun/revisions';

const PARENT = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const OTHER = '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const DOC = ['# Title', '', 'First paragraph.', '', '- one', '- two'].join('\n');

function removeRanges(text: string, ranges: { start: number; end: number }[]): string {
  let out = '';
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseRevisionRequest', () => {
  it('reads a comment edit and a hand edit', () => {
    expect(
      parseRevisionRequest({
        parentId: PARENT,
        edits: [
          { kind: 'comment', start: 9, end: 25, comment: '  Name the buyer.  ' },
          { kind: 'hand', start: 27, end: 32, text: '- uno' },
        ],
      }),
    ).toEqual({
      kind: 'edits',
      parentId: PARENT,
      edits: [
        { kind: 'comment', start: 9, end: 25, comment: 'Name the buyer.' },
        { kind: 'hand', start: 27, end: 32, text: '- uno' },
      ],
    });
  });

  it('reads a restore', () => {
    expect(parseRevisionRequest({ parentId: PARENT, restoreOf: OTHER })).toEqual({
      kind: 'restore',
      parentId: PARENT,
      restoreOf: OTHER,
    });
  });

  it('refuses edits and a restore together', () => {
    expect(
      parseRevisionRequest({
        parentId: PARENT,
        restoreOf: OTHER,
        edits: [{ kind: 'hand', start: 0, end: 7, text: '# T' }],
      }),
    ).toEqual({ error: 'Send edits or restoreOf, not both' });
  });

  it('refuses more than 20 edits', () => {
    const edits = Array.from({ length: 21 }, (_, index) => ({
      kind: 'hand',
      start: index * 2,
      end: index * 2 + 1,
      text: 'x',
    }));

    expect(parseRevisionRequest({ parentId: PARENT, edits })).toEqual({
      error: 'At most 20 edits can be applied at once',
    });
  });

  it('refuses an empty comment and one over 2,000 characters', () => {
    expect(
      parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 0, end: 7, comment: '   ' }] }),
    ).toEqual({ error: 'A comment cannot be empty' });
    expect(
      parseRevisionRequest({
        parentId: PARENT,
        edits: [{ kind: 'comment', start: 0, end: 7, comment: 'a'.repeat(2001) }],
      }),
    ).toEqual({ error: 'A comment is too long' });
  });

  it('refuses a range that does not run forward and a parent that is not a UUID', () => {
    expect(
      parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'hand', start: 7, end: 7, text: 'x' }] }),
    ).toEqual({ error: 'Each edit needs a start and a later end' });
    expect(parseRevisionRequest({ parentId: 'nope', edits: [] })).toEqual({
      error: 'parentId must be a UUID',
    });
  });
});

describe('validateEdits', () => {
  it('accepts edits on whole blocks that do not overlap', () => {
    expect(validateEdits(DOC, [{ start: 27, end: 38 }, { start: 9, end: 25 }])).toBeNull();
  });

  it('refuses an edit past the end of the text', () => {
    expect(validateEdits(DOC, [{ start: 33, end: 99 }])).toBe('An edit lies outside the output');
  });

  it('refuses two edits on the same passage', () => {
    expect(validateEdits(DOC, [{ start: 27, end: 38 }, { start: 33, end: 38 }])).toBe(
      'Two edits cover the same passage',
    );
  });

  it('refuses an edit that cuts into a block', () => {
    expect(validateEdits(DOC, [{ start: 10, end: 25 }])).toBe('An edit does not cover whole passages');
  });
});

describe('splice', () => {
  it('replaces several passages of different lengths and reports where each landed', () => {
    const replacements = [
      { start: 27, end: 32, text: '- the first item, now longer' },
      { start: 9, end: 25, text: 'Short.' },
    ];

    const result = splice(DOC, replacements);

    expect(result.text).toBe(
      ['# Title', '', 'Short.', '', '- the first item, now longer', '- two'].join('\n'),
    );
    expect(result.ranges).toEqual([
      { start: 17, end: 45 },
      { start: 9, end: 15 },
    ]);
  });

  it('removes a passage when its replacement is empty', () => {
    const result = splice(DOC, [{ start: 9, end: 25, text: '' }]);

    expect(result.text).toBe(['# Title', '', '', '', '- one', '- two'].join('\n'));
    expect(result.ranges).toEqual([{ start: 9, end: 9 }]);
  });

  it('leaves the delimiter row in place when a table header row is replaced', () => {
    const table = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    const header = blockRanges(table)[0];

    const result = splice(table, [{ ...header, text: '| Buyer | Bid |' }]);

    expect(result.text).toBe(['| Buyer | Bid |', '| - | - |', '| 1 | 2 |'].join('\n'));
  });

  it('lands on the right characters after an emoji', () => {
    const doc = ['Growth 🚀 was strong.', '', 'Second é paragraph.'].join('\n');
    const second = blockRanges(doc)[1];

    const result = splice(doc, [{ ...second, text: 'Margin held.' }]);

    expect(result.text).toBe(['Growth 🚀 was strong.', '', 'Margin held.'].join('\n'));
  });

  it('leaves every character outside the passages identical, for any valid set of edits', () => {
    const random = seeded(20261013);
    const words = ['Revenue', 'grew', '12%', 'in', 'FY25', '🚀', 'café', 'EBITDA', 'margin', 'held'];
    const sentence = () =>
      `${Array.from({ length: 2 + Math.floor(random() * 5) }, () => words[Math.floor(random() * words.length)]).join(' ')}.`;

    for (let round = 0; round < 200; round += 1) {
      const text = Array.from({ length: 2 + Math.floor(random() * 8) }, () =>
        random() < 0.3 ? `- ${sentence()}` : sentence(),
      ).join('\n\n');
      const replacements = blockRanges(text)
        .filter(() => random() < 0.4)
        .map((block) => ({ start: block.start, end: block.end, text: random() < 0.2 ? '' : sentence() }));

      const result = splice(text, replacements);

      expect(removeRanges(result.text, result.ranges)).toBe(removeRanges(text, replacements));
      result.ranges.forEach((range, index) => {
        expect(result.text.slice(range.start, range.end)).toBe(replacements[index].text);
      });
    }
  });
});

describe('shiftRange', () => {
  it('moves a later range by the length change of the replacements before it', () => {
    expect(shiftRange({ start: 27, end: 32 }, [{ start: 9, end: 25, text: 'Short.' }])).toEqual({
      start: 17,
      end: 22,
    });
  });

  it('leaves an earlier range where it is', () => {
    expect(shiftRange({ start: 0, end: 7 }, [{ start: 9, end: 25, text: 'Short.' }])).toEqual({
      start: 0,
      end: 7,
    });
  });
});

describe('cleanReplacement', () => {
  it('drops leading blank lines, trailing whitespace and carriage returns', () => {
    expect(cleanReplacement('\n\n- one\r\n  more  \n\n')).toBe('- one\n  more');
  });
});

describe('storageProblem', () => {
  it('accepts ordinary text', () => {
    expect(storageProblem('# Title\n\nBody.')).toBeNull();
  });

  it('refuses a blank result and one over 200,000 characters', () => {
    expect(storageProblem(' \n ')).toBe('The revised output would be empty.');
    expect(storageProblem('a'.repeat(200_001))).toBe('The revised output is too long.');
  });

  it('refuses text that would be changed by storing it', () => {
    expect(storageProblem('e\u0301')).toBe('The revised output could not be stored as written.');
  });
});

describe('editsDigest and countBy', () => {
  it('gives one digest per set of edits, with no text in it', () => {
    const digest = editsDigest([{ kind: 'comment', start: 0, end: 7, comment: 'secret words' }]);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('secret');
  });

  it('counts values', () => {
    expect(countBy(['comment', 'hand', 'comment'])).toEqual({ comment: 2, hand: 1 });
  });
});

describe('parseRevisionInputs', () => {
  it('reads an edits record and drops anything that is not an edit', () => {
    expect(
      parseRevisionInputs({
        kind: 'edits',
        skillMounted: true,
        edits: [
          { id: 'e1', kind: 'comment', start: 0, end: 7, comment: 'Fix.', status: 'applied', resultStart: 0, resultEnd: 9 },
          { nonsense: true },
        ],
      }),
    ).toEqual({
      kind: 'edits',
      skillMounted: true,
      edits: [
        { id: 'e1', kind: 'comment', start: 0, end: 7, comment: 'Fix.', status: 'applied', resultStart: 0, resultEnd: 9 },
      ],
    });
  });

  it('reads a restore record and refuses a run input record', () => {
    expect(parseRevisionInputs({ kind: 'restore', restoredFrom: OTHER })).toEqual({
      kind: 'restore',
      restoredFrom: OTHER,
    });
    expect(parseRevisionInputs({ asOf: '2026-09-30' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/skill-run-revisions.test.ts`
Expected: FAIL, cannot resolve `@/lib/skillRun/revisions`.

- [ ] **Step 3: Add the shared types to `src/lib/skillRun/types.ts`**

Append at the end of the file:

```ts
export const REVISION_LIMITS = { edits: 20, comment: 2_000, text: 200_000 } as const;

export type EditKind = "comment" | "hand";

export type EditStatus = "applied" | "unresolved" | "failed";

export type EditRequest =
  | { kind: "comment"; start: number; end: number; comment: string }
  | { kind: "hand"; start: number; end: number; text: string };

export type EditRecord = {
  id: string;
  kind: EditKind;
  start: number;
  end: number;
  comment?: string;
  status: EditStatus;
  reason?: string;
  resultStart?: number;
  resultEnd?: number;
};

export type RevisionInputs =
  | { kind: "edits"; edits: EditRecord[]; skillMounted?: boolean }
  | { kind: "restore"; restoredFrom: string };
```

- [ ] **Step 4: Create `src/lib/skillRun/revisions.ts`**

```ts
import { createHash } from 'node:crypto';

import { canonicalizeText } from '@/lib/conductia/documents';
import { isUuid } from '@/lib/skillPublication/parse';

import { blockRanges, isAligned, type Range } from './blocks';
import {
  REVISION_LIMITS,
  type EditRecord,
  type EditRequest,
  type RevisionInputs,
} from './types';

export type RevisionRequest =
  | { kind: 'edits'; parentId: string; edits: EditRequest[] }
  | { kind: 'restore'; parentId: string; restoreOf: string };

export type Replacement = Range & { text: string };

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseEdit(value: unknown): EditRequest | string {
  if (!value || typeof value !== 'object') return 'Each edit must be an object';
  const rec = value as Record<string, unknown>;
  if (!isOffset(rec.start) || !isOffset(rec.end) || rec.end <= rec.start) {
    return 'Each edit needs a start and a later end';
  }
  if (rec.kind === 'comment') {
    const comment = typeof rec.comment === 'string' ? canonicalizeText(rec.comment).trim() : '';
    if (comment === '') return 'A comment cannot be empty';
    if (comment.length > REVISION_LIMITS.comment) return 'A comment is too long';
    return { kind: 'comment', start: rec.start, end: rec.end, comment };
  }
  if (rec.kind === 'hand') {
    if (typeof rec.text !== 'string') return 'A hand edit needs its text';
    if (rec.text.length > REVISION_LIMITS.text) return 'A hand edit is too long';
    return { kind: 'hand', start: rec.start, end: rec.end, text: rec.text };
  }
  return 'Each edit is a comment or a hand edit';
}

export function parseRevisionRequest(body: unknown): RevisionRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const rec = body as Record<string, unknown>;
  const parentId = typeof rec.parentId === 'string' ? rec.parentId.trim() : '';
  if (!isUuid(parentId)) return { error: 'parentId must be a UUID' };

  if (rec.restoreOf !== undefined) {
    if (rec.edits !== undefined) return { error: 'Send edits or restoreOf, not both' };
    const restoreOf = typeof rec.restoreOf === 'string' ? rec.restoreOf.trim() : '';
    if (!isUuid(restoreOf)) return { error: 'restoreOf must be a UUID' };
    return { kind: 'restore', parentId, restoreOf };
  }

  if (!Array.isArray(rec.edits) || rec.edits.length === 0) {
    return { error: 'edits must list at least one edit' };
  }
  if (rec.edits.length > REVISION_LIMITS.edits) {
    return { error: `At most ${String(REVISION_LIMITS.edits)} edits can be applied at once` };
  }
  const edits: EditRequest[] = [];
  for (const raw of rec.edits) {
    const edit = parseEdit(raw);
    if (typeof edit === 'string') return { error: edit };
    edits.push(edit);
  }
  return { kind: 'edits', parentId, edits };
}

export function validateEdits(text: string, edits: readonly Range[]): string | null {
  const blocks = blockRanges(text);
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.end > text.length) return 'An edit lies outside the output';
    if (edit.start < cursor) return 'Two edits cover the same passage';
    if (!isAligned(blocks, edit)) return 'An edit does not cover whole passages';
    cursor = edit.end;
  }
  return null;
}

export function cleanReplacement(raw: string): string {
  return canonicalizeText(raw).replace(/^\n+/, '').replace(/[ \t\n]+$/, '');
}

export function shiftRange(range: Range, replacements: readonly Replacement[]): Range {
  const delta = replacements
    .filter((replacement) => replacement.end <= range.start)
    .reduce(
      (sum, replacement) => sum + replacement.text.length - (replacement.end - replacement.start),
      0,
    );
  return { start: range.start + delta, end: range.end + delta };
}

export function splice(
  text: string,
  replacements: readonly Replacement[],
): { text: string; ranges: Range[] } {
  let out = '';
  let cursor = 0;
  for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  out += text.slice(cursor);

  const ranges = replacements.map((replacement) => {
    const start = shiftRange(replacement, replacements).start;
    return { start, end: start + replacement.text.length };
  });
  return { text: out, ranges };
}

export function storageProblem(text: string): string | null {
  if (text.trim() === '') return 'The revised output would be empty.';
  if (text.length > REVISION_LIMITS.text) return 'The revised output is too long.';
  if (canonicalizeText(text) !== text) return 'The revised output could not be stored as written.';
  return null;
}

export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function editsDigest(edits: readonly EditRequest[]): string {
  return digestOf(JSON.stringify(edits));
}

export function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isEditRecord(value: unknown): value is EditRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    (rec.kind === 'comment' || rec.kind === 'hand') &&
    isOffset(rec.start) &&
    isOffset(rec.end) &&
    (rec.status === 'applied' || rec.status === 'unresolved' || rec.status === 'failed')
  );
}

export function parseRevisionInputs(value: unknown): RevisionInputs | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec.kind === 'restore' && typeof rec.restoredFrom === 'string') {
    return { kind: 'restore', restoredFrom: rec.restoredFrom };
  }
  if (rec.kind !== 'edits' || !Array.isArray(rec.edits)) return null;
  return {
    kind: 'edits',
    edits: rec.edits.filter(isEditRecord),
    ...(typeof rec.skillMounted === 'boolean' ? { skillMounted: rec.skillMounted } : {}),
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/skill-run-revisions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skillRun/revisions.ts src/lib/skillRun/types.ts tests/skill-run-revisions.test.ts
git commit -m "feat(skill-run): parse, validate and splice edits to an output

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 8: The migration and its typed mirrors

**Files:**
- Create: `supabase/migrations/20261013100000_skill_output_revisions.sql`
- Modify: `src/lib/constants/dealSteps.ts`, `src/lib/ai/usage.ts`, `src/lib/flags/keys.ts`
- Modify: `tests/constants-schema-sync.test.ts`
- Modify: `supabase/schema-snapshot.txt` (regenerated, never hand-edited)
- Test: `tests/integration/skill-output-revisions.test.ts`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces:
  - Columns `deal_step_skill_runs.parent_run_id`, `deal_step_skill_runs.root_run_id` (uuid, nullable, ids only)
  - `source` value `'revision'`; `SKILL_RUN_SOURCE.REVISION = 'revision'`
  - Unique index: one row per `parent_run_id` where `outcome = 'succeeded'`
  - Ledger source `'skill_revision'` in `AI_USAGE_SOURCES` and `ai_usage_source_check`
  - Flag key `skill_output_revisions`

If `origin/develop` has gained a migration with a later timestamp by the time this task runs, rename this file to sort after it and use the new name everywhere below. `npm run check:migrations` confirms the order.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/skill-output-revisions.test.ts`. Rows in this table cannot be deleted, so the test cleans nothing up; the local stack is reset between runs, as the other run-table tests assume.

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { recordAiUsage } from '@/lib/ai/usage';
import { createProvisionedUser } from '@/lib/auth/provisioning';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY ' +
      '(local `supabase start` stack).',
  );
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = randomUUID();
let bankId = '';
let deals = 0;

type Seed = {
  dealId: string;
  stepId: string;
  actorId: string;
  rootId: string;
  skillId: string;
  versionId: string;
};

async function seedRun(): Promise<Seed> {
  if (!bankId) {
    const { data: bank, error } = await admin
      .from('companies')
      .insert({ tenant_id: TENANT, name: `Revision Bank ${RUN}`, type: 'bank' })
      .select('id')
      .single();
    if (error || !bank) throw new Error(`bank seed failed: ${error?.message}`);
    bankId = bank.id;
  }

  const { id: actorId } = await createProvisionedUser(admin, {
    email: `${randomUUID()}-${RUN}@integration.conductia.dev`,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  const { error: userError } = await admin
    .from('users')
    .update({ tenant_id: TENANT, status: 'active' })
    .eq('id', actorId);
  if (userError) throw new Error(`user claim failed: ${userError.message}`);

  deals += 1;
  const { data: deal, error: dealError } = await admin
    .from('deals')
    .insert({
      tenant_id: TENANT,
      code: `REV-${RUN}-${deals}`,
      codename: `Revision Deal ${RUN} ${deals}`,
      bank_id: bankId,
    })
    .select('id')
    .single();
  if (dealError || !deal) throw new Error(`deal seed failed: ${dealError?.message}`);

  const { data: step, error: stepError } = await admin
    .from('deal_steps')
    .insert({
      deal_id: deal.id,
      step_id: `custom:${randomUUID()}`,
      status: 'pending',
      origin: 'custom',
      definition: {},
    })
    .select('id')
    .single();
  if (stepError || !step) throw new Error(`step seed failed: ${stepError?.message}`);

  const seed = {
    dealId: deal.id as string,
    stepId: step.id as string,
    actorId,
    rootId: randomUUID(),
    skillId: randomUUID(),
    versionId: randomUUID(),
  };
  const { error: runError } = await admin.from('deal_step_skill_runs').insert({
    id: seed.rootId,
    deal_id: seed.dealId,
    deal_step_id: seed.stepId,
    actor_id: seed.actorId,
    skill_id: seed.skillId,
    version_id: seed.versionId,
    digest: 'a'.repeat(64),
    input: 'Summarise the week',
    outcome: 'succeeded',
    result_text: 'First output.',
    source: 'execution',
  });
  if (runError) throw new Error(`run seed failed: ${runError.message}`);
  return seed;
}

function revision(seed: Seed, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    deal_id: seed.dealId,
    deal_step_id: seed.stepId,
    actor_id: seed.actorId,
    source: 'revision',
    parent_run_id: seed.rootId,
    root_run_id: seed.rootId,
    skill_id: seed.skillId,
    version_id: seed.versionId,
    digest: 'a'.repeat(64),
    inputs: { kind: 'edits', edits: [] },
    outcome: 'succeeded',
    result_text: 'Revised output.',
    ...overrides,
  };
}

describe('skill output revision rows', () => {
  it('stores a revision that names its parent, its root and the run reference', async () => {
    const seed = await seedRun();

    const { error } = await admin.from('deal_step_skill_runs').insert(revision(seed));

    expect(error).toBeNull();
  });

  it('stores a revision of an imported run, which has no reference at all', async () => {
    const seed = await seedRun();

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { skill_id: null, version_id: null, digest: null }));

    expect(error).toBeNull();
  });

  it('refuses a revision with half a reference', async () => {
    const seed = await seedRun();

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { version_id: null }));

    expect(error).not.toBeNull();
  });

  it('refuses a revision with no parent or no actor', async () => {
    const seed = await seedRun();

    const orphan = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { parent_run_id: null }));
    const anonymous = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { actor_id: null }));

    expect(orphan.error).not.toBeNull();
    expect(anonymous.error).not.toBeNull();
  });

  it('refuses an executed run that claims a parent', async () => {
    const seed = await seedRun();

    const { error } = await admin.from('deal_step_skill_runs').insert({
      id: randomUUID(),
      deal_id: seed.dealId,
      deal_step_id: seed.stepId,
      actor_id: seed.actorId,
      skill_id: seed.skillId,
      version_id: seed.versionId,
      digest: 'a'.repeat(64),
      input: 'Again',
      outcome: 'succeeded',
      result_text: 'Second run.',
      source: 'execution',
      parent_run_id: seed.rootId,
      root_run_id: seed.rootId,
    });

    expect(error).not.toBeNull();
  });

  it('lets only one successful revision stand on a parent', async () => {
    const seed = await seedRun();
    const first = await admin.from('deal_step_skill_runs').insert(revision(seed));

    const second = await admin.from('deal_step_skill_runs').insert(revision(seed));

    expect(first.error).toBeNull();
    expect(second.error?.code).toBe('23505');
  });

  it('keeps a failed attempt beside the successful revision of the same parent', async () => {
    const seed = await seedRun();
    await admin.from('deal_step_skill_runs').insert(revision(seed));

    const { error } = await admin.from('deal_step_skill_runs').insert(
      revision(seed, {
        outcome: 'failed',
        result_text: null,
        error_message: 'The edit could not be applied.',
      }),
    );

    expect(error).toBeNull();
  });

  it('refuses to change a revision row once written', async () => {
    const seed = await seedRun();
    const row = revision(seed);
    await admin.from('deal_step_skill_runs').insert(row);

    const { error } = await admin
      .from('deal_step_skill_runs')
      .update({ result_text: 'tampered' })
      .eq('id', row.id);

    expect(error).not.toBeNull();
  });

  it('accepts a ledger row for a revision', async () => {
    const seed = await seedRun();

    const result = await recordAiUsage(admin, {
      tenantId: TENANT,
      dealId: seed.dealId,
      actorId: seed.actorId,
      source: 'skill_revision',
      task: 'custom:revision-test',
      externalId: randomUUID(),
      model: 'sonnet',
      costUsd: null,
    });

    expect(result.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run it against the local stack to verify it fails**

```bash
supabase start --exclude studio,postgres-meta,edge-runtime,realtime,logflare,vector
supabase db reset --local
eval "$(supabase status -o env)"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
  npx vitest run --config vitest.integration.config.ts tests/integration/skill-output-revisions.test.ts
```

Expected: FAIL. The inserts are refused because `parent_run_id` does not exist, and the ledger write is refused because `skill_revision` is not an allowed source. If another session holds the one local database, start a second stack with its own project id and ports instead of stopping theirs.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261013100000_skill_output_revisions.sql`:

```sql
alter table deal_step_skill_runs
  add column if not exists parent_run_id uuid references deal_step_skill_runs (id),
  add column if not exists root_run_id   uuid references deal_step_skill_runs (id);

alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_source_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_source_check
  check (source in ('execution', 'imported', 'revision'));

alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_reference_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_reference_check
  check (
    (source = 'execution'
      and parent_run_id is null and root_run_id is null
      and digest is not null and actor_id is not null
      and ((skill_id is not null and version_id is not null
            and mount_name is null and mount_version is null)
        or (mount_name is not null and mount_version is not null
            and skill_id is null and version_id is null)))
    or
    (source = 'imported'
      and parent_run_id is null and root_run_id is null
      and digest is null and actor_id is null and skill_id is null and version_id is null
      and mount_name is null and mount_version is null)
    or
    (source = 'revision'
      and parent_run_id is not null and root_run_id is not null and actor_id is not null
      and ((digest is not null and skill_id is not null and version_id is not null
            and mount_name is null and mount_version is null)
        or (digest is not null and mount_name is not null and mount_version is not null
            and skill_id is null and version_id is null)
        or (digest is null and skill_id is null and version_id is null
            and mount_name is null and mount_version is null)))
  );

create unique index if not exists deal_step_skill_runs_one_revision_per_parent_idx
  on deal_step_skill_runs (parent_run_id)
  where outcome = 'succeeded';

create index if not exists deal_step_skill_runs_root_idx
  on deal_step_skill_runs (root_run_id, created_at)
  where root_run_id is not null;

alter table ai_usage drop constraint if exists ai_usage_source_check;
alter table ai_usage add constraint ai_usage_source_check
  check (source in ('screen','agent_run','bench_chat','twin_chat','discovery_extract','skill_run','skill_authoring','skill_revision'))
  not valid;
alter table ai_usage validate constraint ai_usage_source_check;
```

- [ ] **Step 4: Update the typed mirrors**

`src/lib/constants/dealSteps.ts`, in `SKILL_RUN_SOURCE`:

```ts
export const SKILL_RUN_SOURCE = {
  EXECUTION: 'execution',
  IMPORTED: 'imported',
  REVISION: 'revision',
} as const;
```

`src/lib/ai/usage.ts`: add the source, and move the migration number in the line above it to `20261013100000` so that pointer stays true:

```ts
export const AI_USAGE_SOURCES = ['screen', 'agent_run', 'bench_chat', 'twin_chat', 'discovery_extract', 'skill_run', 'skill_authoring', 'skill_revision'] as const;
```

`src/lib/flags/keys.ts`, a new entry at the end of `FLAG_REGISTRY`:

```ts
  skill_output_revisions: {
    description:
      "Review and revise a skill run's output: comments and hand edits on passages, applied as immutable revisions that are all kept. Off = the revision routes 404 and a run's output is read-only.",
  },
```

- [ ] **Step 5: Point the schema sync test at the new migration**

In `tests/constants-schema-sync.test.ts`, add beside `SKILL_VERSION_SELECTION_MIGRATION`:

```ts
const SKILL_OUTPUT_REVISIONS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20261013100000_skill_output_revisions.sql',
);
```

In the test `covers every skill binding kind, binding source and run source CHECK`, the third assertion reads the run sources from the older migration. Replace that one assertion with:

```ts
    const revisionsSql = readFileSync(SKILL_OUTPUT_REVISIONS_MIGRATION, 'utf8');
    expect(revisionsSql).toContain(
      `check (source in (${SKILL_RUN_SOURCES.map((source) => `'${source}'`).join(', ')}))`,
    );
```

- [ ] **Step 6: Apply the migration locally and regenerate the schema snapshot**

```bash
supabase db reset --local
eval "$(supabase status -o env)"
printf "DATABASE_URL='%s'\n" "$DB_URL" > "$TMPDIR/local-db.env"
npm run schema:snapshot -- "$TMPDIR/local-db.env"
rm -f "$TMPDIR/local-db.env"
git diff --stat supabase/schema-snapshot.txt
```

Expected: the snapshot gains `column deal_step_skill_runs.parent_run_id`, `column deal_step_skill_runs.root_run_id` and the two indexes, and loses nothing.

- [ ] **Step 7: Run the tests**

```bash
npm run check:migrations
npx vitest run tests/constants-schema-sync.test.ts
eval "$(supabase status -o env)"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
  npx vitest run --config vitest.integration.config.ts \
  tests/integration/skill-output-revisions.test.ts tests/integration/skill-version-lineage.test.ts
npx tsc --noEmit
```

Expected: PASS. `skill-version-lineage.test.ts` proves the execution and imported arms of the reference check still hold.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261013100000_skill_output_revisions.sql supabase/schema-snapshot.txt \
        src/lib/constants/dealSteps.ts src/lib/ai/usage.ts src/lib/flags/keys.ts \
        tests/constants-schema-sync.test.ts tests/integration/skill-output-revisions.test.ts
git commit -m "feat(db): revision rows in the skill run table, behind skill_output_revisions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 9: The read-only token, the bench call and its stream

**Files:**
- Modify: `src/lib/ignatious/config.ts`, `src/lib/ignatious/jwt.ts`, `src/lib/ignatious/bench.ts`
- Create: `src/lib/skillRun/revisionStream.ts`
- Modify: `tests/conductia-seam-auth.test.ts`
- Test: `tests/skill-run-revision-engine.test.ts`

**Interfaces:**
- Consumes: the Ignatious route's body and frames (Task 4).
- Produces:
  - `SKILL_RUN_REVISION_AGENT = 'skill-run-revision'`
  - `skillRunRevisionScopes(): readonly string[]`, five read scopes and no write
  - `type BenchRevisionPassage = { id: string; start: number; end: number; comment: string }`
  - `type BenchSkillRunRevisionBody = { revisionId: string; skill: SkillReference | null; projectId: string; document: string; passages: BenchRevisionPassage[]; tenantId: string; leadId: string; model?: string | null; token: string }`
  - `createSkillBench(config, fetchImpl).startSkillRunRevision(body, signal?): Promise<Response>`
  - `type EngineReplacement = { text: string } | { unresolved: string }`
  - `type EngineOutcome = { replacements: Map<string, EngineReplacement> | null; finished: boolean; costUsd: number | null; model: string | null; alias: string | null; skillMounted: boolean | null; providerRunId: string | null; error: string | null }`
  - `readRevisionStream(body: ReadableStream<Uint8Array>): Promise<EngineOutcome>`; rejects when the stream itself breaks

- [ ] **Step 1: Write the failing tests**

In `tests/conductia-seam-auth.test.ts`, add `skillRunRevisionScopes` to the import from `@/lib/ignatious/jwt`, add one entry to the `agents` array of `round-trips the claims of every agent that mints a token`:

```ts
      { agentName: 'skill-run-revision', scopes: skillRunRevisionScopes() },
```

and add a test inside `describe('agent seam: scopes are enforced', ...)`:

```ts
  it('refuses a document write made with a skill-run-revision token and allows its reads', () => {
    seamEnv();
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'skill-run-revision',
      dealId: LEAD,
      scopes: skillRunRevisionScopes(),
    });
    const asBench = { 'x-conductia-agent-name': 'skill-bench' };

    expect(skillRunRevisionScopes()).toEqual([
      'lead.read',
      'documents.read',
      'maps.read',
      'library.read',
      'personas.read',
    ]);
    expect(requireConductiaScope(seamRequest(token, asBench), LEAD, SCOPE.DOCUMENTS_WRITE).ok).toBe(false);
    expect(requireConductiaScope(seamRequest(token, asBench), LEAD, SCOPE.DOCUMENTS_READ).ok).toBe(true);
  });
```

Create `tests/skill-run-revision-engine.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSkillBench } from '@/lib/ignatious/bench';
import { readRevisionStream } from '@/lib/skillRun/revisionStream';

const CONFIG = {
  baseUrl: 'https://plane.test',
  apiKey: 'bench-key',
  tenantId: 'tn_demo',
  leadIdOverride: null,
  benchUrl: 'https://bench.test',
  conductiaBaseUrl: 'https://conductia.test',
};

const PUBLICATION = {
  kind: 'publication' as const,
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

function stream(frames: unknown[], options: { breakAfter?: boolean } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
      }
      if (options.breakAfter) controller.error(new Error('socket closed'));
      else controller.close();
    },
  });
}

describe('startSkillRunRevision', () => {
  it('posts the document and passages to the bench with the caller token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('ok');
    }) as typeof fetch;

    await createSkillBench(CONFIG, fetchImpl).startSkillRunRevision({
      revisionId: 'rev-1',
      skill: PUBLICATION,
      projectId: 'deal-1',
      document: '# Memo',
      passages: [{ id: 'p1', start: 0, end: 6, comment: 'Retitle.' }],
      tenantId: 'tn_demo',
      leadId: 'ATLAS-2026-001',
      model: 'sonnet',
      token: 'trigger-token',
    });

    expect(calls[0]?.url).toBe('https://bench.test/v1/bench/skill-run-revisions');
    expect(calls[0]?.init.headers).toMatchObject({
      'x-api-key': 'bench-key',
      authorization: 'Bearer trigger-token',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      revisionId: 'rev-1',
      skill: { ...PUBLICATION, projectId: 'deal-1' },
      document: '# Memo',
      passages: [{ id: 'p1', start: 0, end: 6, comment: 'Retitle.' }],
      tenantId: 'tn_demo',
      leadId: 'ATLAS-2026-001',
      model: 'sonnet',
      conductiaBaseUrl: 'https://conductia.test',
    });
  });

  it('sends a null skill for a run that recorded no reference', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('ok');
    }) as typeof fetch;

    await createSkillBench(CONFIG, fetchImpl).startSkillRunRevision({
      revisionId: 'rev-1',
      skill: null,
      projectId: 'deal-1',
      document: '# Memo',
      passages: [{ id: 'p1', start: 0, end: 6, comment: 'Retitle.' }],
      tenantId: 'tn_demo',
      leadId: 'ATLAS-2026-001',
      token: 'trigger-token',
    });

    expect(sent.skill).toBeNull();
    expect(sent.model).toBeNull();
  });
});

describe('readRevisionStream', () => {
  it('reads the replacements, the cost, the model and whether the skill was mounted', async () => {
    const outcome = await readRevisionStream(
      stream([
        { type: 'ready', model: 'anthropic/claude-sonnet-5' },
        { type: 'text', text: 'Working.' },
        {
          type: 'replacements',
          items: [
            { id: 'p1', text: 'Revenue rose 12%.' },
            { id: 'p2', unresolved: 'No document names the buyer.' },
          ],
        },
        { type: 'done', costUsd: 0.04, model: 'sonnet', modelId: 'anthropic/claude-sonnet-5', skillMounted: true },
      ]),
    );

    expect(outcome.finished).toBe(true);
    expect(outcome.costUsd).toBe(0.04);
    expect(outcome.model).toBe('sonnet');
    expect(outcome.alias).toBe('sonnet');
    expect(outcome.skillMounted).toBe(true);
    expect([...(outcome.replacements ?? [])]).toEqual([
      ['p1', { text: 'Revenue rose 12%.' }],
      ['p2', { unresolved: 'No document names the buyer.' }],
    ]);
  });

  it('reports no replacements when the model never submitted', async () => {
    const outcome = await readRevisionStream(
      stream([{ type: 'error', message: 'The provider refused.' }, { type: 'done', costUsd: null }]),
    );

    expect(outcome.replacements).toBeNull();
    expect(outcome.error).toBe('The provider refused.');
    expect(outcome.finished).toBe(true);
  });

  it('reports an unfinished turn when the stream ends before done', async () => {
    const outcome = await readRevisionStream(stream([{ type: 'text', text: 'Working.' }]));

    expect(outcome.finished).toBe(false);
    expect(outcome.replacements).toBeNull();
  });

  it('drops an item that is neither a text nor a reason', async () => {
    const outcome = await readRevisionStream(
      stream([
        { type: 'replacements', items: [{ id: 'p1' }, { text: 'no id' }, { id: 'p2', text: '' }] },
        { type: 'done', costUsd: 0 },
      ]),
    );

    expect([...(outcome.replacements ?? [])]).toEqual([['p2', { text: '' }]]);
  });

  it('rejects when the connection breaks mid-stream', async () => {
    await expect(
      readRevisionStream(stream([{ type: 'text', text: 'Working.' }], { breakAfter: true })),
    ).rejects.toThrow('socket closed');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/skill-run-revision-engine.test.ts tests/conductia-seam-auth.test.ts`
Expected: FAIL, `skillRunRevisionScopes` and `startSkillRunRevision` do not exist and `@/lib/skillRun/revisionStream` cannot be resolved.

- [ ] **Step 3: Add the agent name and the scopes**

`src/lib/ignatious/config.ts`, under `SKILL_STEP_RUN_AGENT`:

```ts
export const SKILL_RUN_REVISION_AGENT = 'skill-run-revision';
```

`src/lib/ignatious/jwt.ts`, under `skillStepRunScopes`:

```ts
const SKILL_RUN_REVISION_SCOPES = [
  'lead.read',
  'documents.read',
  'maps.read',
  'library.read',
  'personas.read',
] as const;

export function skillRunRevisionScopes(): readonly string[] {
  return SKILL_RUN_REVISION_SCOPES;
}
```

- [ ] **Step 4: Add the bench call, in `src/lib/ignatious/bench.ts`**

Under `BenchSkillRunBody`:

```ts
export type BenchRevisionPassage = { id: string; start: number; end: number; comment: string };

export type BenchSkillRunRevisionBody = {
  revisionId: string;
  skill: SkillReference | null;
  projectId: string;
  document: string;
  passages: BenchRevisionPassage[];
  tenantId: string;
  leadId: string;
  model?: string | null;
  token: string;
};
```

In the object `createSkillBench` returns, after `startSkillRun`:

```ts
    async startSkillRunRevision(
      body: BenchSkillRunRevisionBody,
      signal?: AbortSignal,
    ): Promise<Response> {
      return benchFetch('/v1/bench/skill-run-revisions', {
        method: 'POST',
        headers: headers({
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${body.token}`,
        }),
        body: JSON.stringify({
          revisionId: body.revisionId,
          skill: body.skill ? benchReference(body.skill, body.projectId) : null,
          document: body.document,
          passages: body.passages,
          tenantId: body.tenantId,
          leadId: body.leadId,
          model: body.model ?? null,
          ...(config.conductiaBaseUrl ? { conductiaBaseUrl: config.conductiaBaseUrl } : {}),
        }),
        signal,
      });
    },
```

- [ ] **Step 5: Create `src/lib/skillRun/revisionStream.ts`**

```ts
import { bareModelId } from '@/lib/ignatious/benchMeter';
import { readBenchEvents } from '@/lib/ignatious/client';

export type EngineReplacement = { text: string } | { unresolved: string };

export type EngineOutcome = {
  replacements: Map<string, EngineReplacement> | null;
  finished: boolean;
  costUsd: number | null;
  model: string | null;
  alias: string | null;
  skillMounted: boolean | null;
  providerRunId: string | null;
  error: string | null;
};

function readItems(value: unknown): Map<string, EngineReplacement> {
  const items = new Map<string, EngineReplacement>();
  if (!Array.isArray(value)) return items;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string') continue;
    if (typeof item.unresolved === 'string') items.set(item.id, { unresolved: item.unresolved });
    else if (typeof item.text === 'string') items.set(item.id, { text: item.text });
  }
  return items;
}

export async function readRevisionStream(body: ReadableStream<Uint8Array>): Promise<EngineOutcome> {
  const outcome: EngineOutcome = {
    replacements: null,
    finished: false,
    costUsd: null,
    model: null,
    alias: null,
    skillMounted: null,
    providerRunId: null,
    error: null,
  };

  for await (const event of readBenchEvents(body)) {
    if (event.type === 'ready' && typeof event.model === 'string' && event.model) {
      outcome.model = bareModelId(event.model);
    } else if (event.type === 'run' && typeof event.runId === 'string') {
      outcome.providerRunId = event.runId;
    } else if (event.type === 'replacements') {
      outcome.replacements = readItems(event.items);
    } else if (event.type === 'error' && typeof event.message === 'string') {
      outcome.error = event.message;
    } else if (event.type === 'done') {
      outcome.finished = true;
      outcome.costUsd = typeof event.costUsd === 'number' ? event.costUsd : null;
      if (typeof event.model === 'string' && event.model) {
        outcome.alias = event.model;
        outcome.model = bareModelId(event.model);
      }
      if (typeof event.skillMounted === 'boolean') outcome.skillMounted = event.skillMounted;
    }
  }
  return outcome;
}
```

The model on `done` wins over the one on `ready`, which is the rule `meterBenchStream` follows for a skill run, so a revision and a run of the same model share one spelling on the spend report.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/skill-run-revision-engine.test.ts tests/conductia-seam-auth.test.ts tests/skill-run-filing.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ignatious/config.ts src/lib/ignatious/jwt.ts src/lib/ignatious/bench.ts \
        src/lib/skillRun/revisionStream.ts tests/conductia-seam-auth.test.ts \
        tests/skill-run-revision-engine.test.ts
git commit -m "feat(ignatious): a read-only token and client for the revision endpoint

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

# Part C: Conductia server

### Task 10: Read a run's versions

**Files:**
- Create: `src/lib/skillRun/revisionStore.ts`
- Create: `src/lib/skillRun/revisionAccess.ts`
- Create: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/[revisionId]/route.ts`
- Create: `tests/helpers/skillRunAdmin.ts`
- Modify: `src/lib/skillRun/types.ts`
- Modify: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts`
- Modify: `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts`
- Modify: `tests/api/skill-run-records.test.ts`, `tests/api/skill-drafts-basis.test.ts`
- Test: `tests/skill-run-revision-store.test.ts`, `tests/api/skill-run-version-route.test.ts`

**Interfaces:**
- Consumes: `parseRevisionInputs` (Task 7); `SKILL_RUN_SOURCE.REVISION` and the flag (Task 8).
- Produces, in `types.ts`:
  - `type RevisionEditSummary = { id: string; kind: EditKind; start: number; end: number; comment: string | null; status: EditStatus; reason: string | null; resultStart: number | null; resultEnd: number | null; before: string | null }`
  - `type RevisionSummary = { id: string; parentId: string; kind: 'edits' | 'restore'; outcome: RunOutcome; errorMessage: string | null; actorName: string; createdAt: string; version: number | null; edits: RevisionEditSummary[]; restoredFrom: string | null; skillMounted: boolean | null }`
  - `SkillRunSummary` gains `headId: string`, `headText: string | null`, `revisions: RevisionSummary[]`
- Produces, in `revisionStore.ts`:
  - `type RevisionRow = { id: string; outcome: RunOutcome; inputs: unknown; resultText: string | null; errorMessage: string | null; actorId: string | null; parentId: string; rootId: string; createdAt: string }`
  - `type OutputChain = { headId: string; headText: string | null; versions: { id: string; text: string }[]; rows: RevisionRow[] }`
  - `type RootRun = { id: string; dealStepId: string; skillId: string | null; versionId: string | null; mountName: string | null; mountVersion: number | null; digest: string | null; model: string | null }`
  - `readRevisionRows(admin: SupabaseClient, rootIds: string[]): Promise<RevisionRow[]>`
  - `chainOf(root: { id: string; text: string | null }, rows: RevisionRow[]): OutputChain`
  - `summarize(chain: OutputChain, nameFor: (actorId: string | null) => string): RevisionSummary[]`
  - `loadChain(admin: SupabaseClient, dealStepId: string, runId: string): Promise<{ root: RootRun; chain: OutputChain } | null>`
- Produces, in `revisionAccess.ts`:
  - `type RevisionAccess = { admin: SupabaseClient; user: ApiUser; deal: { id: string; code: string }; step: { dealStepId: string; stepKey: string; title: string | null } }`
  - `requireRevisionAccess(dealId: string, stepId: string, mode: 'read' | 'write'): Promise<{ ok: true; ctx: RevisionAccess } | { ok: false; response: NextResponse }>`
- Produces, for tests: `fakeAdmin(tables)` in `tests/helpers/skillRunAdmin.ts`
- Routes: the run list returns the three new fields per run; `GET .../skill-runs/{runId}/revisions/{revisionId}` returns `{ id, text }`.

- [ ] **Step 1: Write the in-memory admin the route tests share**

Create `tests/helpers/skillRunAdmin.ts`. It answers the query shapes the run and revision code uses, and enforces the two uniqueness rules of the real table:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null };

export type FakeAdmin = {
  admin: SupabaseClient;
  tables: Record<string, Row[]>;
  failInsertsInto: Set<string>;
};

const CLOCK_START = Date.parse('2026-10-13T10:00:00.000Z');

export function fakeAdmin(seed: Record<string, Row[]> = {}): FakeAdmin {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const failInsertsInto = new Set<string>();
  let ticks = 0;

  function insertInto(table: string, row: Row): Result {
    if (failInsertsInto.has(table)) return { data: null, error: { message: 'insert refused' } };
    const rows = (tables[table] ??= []);
    if (row.id !== undefined && rows.some((existing) => existing.id === row.id)) {
      return { data: null, error: { code: '23505', message: 'duplicate key' } };
    }
    if (
      table === 'deal_step_skill_runs' &&
      row.outcome === 'succeeded' &&
      row.parent_run_id &&
      rows.some(
        (existing) =>
          existing.parent_run_id === row.parent_run_id && existing.outcome === 'succeeded',
      )
    ) {
      return { data: null, error: { code: '23505', message: 'one revision per parent' } };
    }
    ticks += 1;
    const stored = { created_at: new Date(CLOCK_START + ticks * 1000).toISOString(), ...row };
    rows.push(stored);
    return { data: stored, error: null };
  }

  function from(table: string) {
    let rows = [...(tables[table] ?? [])];
    let inserted: Result | null = null;
    const settle = (): Result => inserted ?? { data: rows, error: null };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] !== value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return builder;
      },
      order: (column: string, options: { ascending: boolean }) => {
        rows = [...rows].sort((a, b) => {
          const left = String(a[column]);
          const right = String(b[column]);
          return options.ascending ? left.localeCompare(right) : right.localeCompare(left);
        });
        return builder;
      },
      limit: (count: number) => {
        rows = rows.slice(0, count);
        return builder;
      },
      insert: (row: Row) => {
        inserted = insertInto(table, row);
        return builder;
      },
      maybeSingle: async (): Promise<Result> =>
        inserted ?? { data: rows[0] ?? null, error: null },
      single: async (): Promise<Result> =>
        inserted ?? { data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } },
      then: (resolve: (value: Result) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  }

  return { admin: { from } as unknown as SupabaseClient, tables, failInsertsInto };
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/skill-run-revision-store.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { chainOf, summarize, type RevisionRow } from '@/lib/skillRun/revisionStore';

const ROOT = { id: 'root', text: '# Title\n\nFirst paragraph.' };

function row(overrides: Partial<RevisionRow>): RevisionRow {
  return {
    id: 'rev',
    outcome: 'succeeded',
    inputs: { kind: 'edits', edits: [] },
    resultText: '# Title\n\nSecond paragraph.',
    errorMessage: null,
    actorId: 'user-1',
    parentId: 'root',
    rootId: 'root',
    createdAt: '2026-10-13T10:00:01.000Z',
    ...overrides,
  };
}

const names = (actorId: string | null) => (actorId === 'user-1' ? 'Storm Duncan' : 'Unknown');

describe('chainOf', () => {
  it('is the run itself when nothing has been revised', () => {
    expect(chainOf(ROOT, [])).toEqual({
      headId: 'root',
      headText: ROOT.text,
      versions: [{ id: 'root', text: ROOT.text }],
      rows: [],
    });
  });

  it('follows successful revisions from the run to the head', () => {
    const second = row({ id: 'v2' });
    const third = row({ id: 'v3', parentId: 'v2', resultText: '# Title\n\nThird.' });

    const chain = chainOf(ROOT, [second, third]);

    expect(chain.headId).toBe('v3');
    expect(chain.headText).toBe('# Title\n\nThird.');
    expect(chain.versions.map((version) => version.id)).toEqual(['root', 'v2', 'v3']);
  });

  it('does not move the head for a failed attempt', () => {
    const failed = row({ id: 'f1', outcome: 'failed', resultText: null });

    expect(chainOf(ROOT, [failed]).headId).toBe('root');
  });

  it('ignores the revisions of another run', () => {
    expect(chainOf(ROOT, [row({ id: 'other', rootId: 'elsewhere', parentId: 'elsewhere' })]).rows).toEqual([]);
  });

  it('has no head text for a run that failed', () => {
    expect(chainOf({ id: 'root', text: null }, [])).toEqual({
      headId: 'root',
      headText: null,
      versions: [],
      rows: [],
    });
  });
});

describe('summarize', () => {
  it('numbers versions from the run and reads each passage as it was before the edit', () => {
    const second = row({
      id: 'v2',
      inputs: {
        kind: 'edits',
        skillMounted: true,
        edits: [
          {
            id: 'e1',
            kind: 'comment',
            start: 9,
            end: 25,
            comment: 'Say second.',
            status: 'applied',
            resultStart: 9,
            resultEnd: 26,
          },
        ],
      },
    });

    expect(summarize(chainOf(ROOT, [second]), names)).toEqual([
      {
        id: 'v2',
        parentId: 'root',
        kind: 'edits',
        outcome: 'succeeded',
        errorMessage: null,
        actorName: 'Storm Duncan',
        createdAt: '2026-10-13T10:00:01.000Z',
        version: 2,
        edits: [
          {
            id: 'e1',
            kind: 'comment',
            start: 9,
            end: 25,
            comment: 'Say second.',
            status: 'applied',
            reason: null,
            resultStart: 9,
            resultEnd: 26,
            before: 'First paragraph.',
          },
        ],
        restoredFrom: null,
        skillMounted: true,
      },
    ]);
  });

  it('gives a failed attempt no version number and keeps its reason', () => {
    const failed = row({
      id: 'f1',
      outcome: 'failed',
      resultText: null,
      errorMessage: 'The edit could not be applied.',
      inputs: {
        kind: 'edits',
        edits: [{ id: 'e1', kind: 'comment', start: 9, end: 25, comment: 'Fix.', status: 'failed', reason: 'The edit could not be applied.' }],
      },
    });

    const [summary] = summarize(chainOf(ROOT, [failed]), names);

    expect(summary).toMatchObject({ version: null, outcome: 'failed', errorMessage: 'The edit could not be applied.' });
    expect(summary?.edits[0]).toMatchObject({ status: 'failed', reason: 'The edit could not be applied.', before: 'First paragraph.' });
  });

  it('names the version a restore came from', () => {
    const second = row({ id: 'v2' });
    const restore = row({
      id: 'v3',
      parentId: 'v2',
      resultText: ROOT.text,
      inputs: { kind: 'restore', restoredFrom: 'root' },
    });

    const summaries = summarize(chainOf(ROOT, [second, restore]), names);

    expect(summaries[1]).toMatchObject({ kind: 'restore', restoredFrom: 'root', version: 3, edits: [] });
  });
});
```

Create `tests/api/skill-run-version-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAdmin, type FakeAdmin } from '../helpers/skillRunAdmin';

const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const STEP_KEY = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const ROOT_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const SECOND_ID = '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a';
const FAILED_ID = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b';

const state = {
  flags: { skill_authoring: true, skill_output_revisions: true } as Record<string, boolean>,
  wall: 'internal' as 'internal' | 'external',
  store: null as FakeAdmin | null,
};

vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: async (key: string) =>
    state.flags[key] ? null : new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
}));
vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => true,
  classifyInternalUser: async () => state.wall,
  resolveDealStepCapabilities: async () => ({ canAssign: false, canComplete: true, canEditWork: true }),
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test', companyId: null },
    admin: state.store?.admin,
  }),
}));

function seed(): FakeAdmin {
  return fakeAdmin({
    deal_steps: [
      { id: DEAL_STEP_ID, deal_id: 'deal-1', step_id: STEP_KEY, removed_at: null, definition: { title: 'Weekly update' }, assigned_to: null, status: 'pending' },
    ],
    deal_step_skill_runs: [
      { id: ROOT_ID, deal_step_id: DEAL_STEP_ID, source: 'execution', outcome: 'succeeded', result_text: 'First output.', created_at: '2026-10-13T09:00:00.000Z' },
      { id: SECOND_ID, deal_step_id: DEAL_STEP_ID, source: 'revision', outcome: 'succeeded', result_text: 'Second output.', parent_run_id: ROOT_ID, root_run_id: ROOT_ID, inputs: { kind: 'edits', edits: [] }, actor_id: 'user-1', created_at: '2026-10-13T09:01:00.000Z' },
      { id: FAILED_ID, deal_step_id: DEAL_STEP_ID, source: 'revision', outcome: 'failed', result_text: null, parent_run_id: SECOND_ID, root_run_id: ROOT_ID, inputs: { kind: 'edits', edits: [] }, actor_id: 'user-1', created_at: '2026-10-13T09:02:00.000Z' },
    ],
  });
}

async function read(revisionId: string, runId: string = ROOT_ID) {
  const { GET } = await import(
    '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/[revisionId]/route'
  );
  return GET(new Request('http://localhost'), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: STEP_KEY, runId, revisionId }),
  });
}

describe('GET one version of a run output', () => {
  beforeEach(() => {
    state.flags = { skill_authoring: true, skill_output_revisions: true };
    state.wall = 'internal';
    state.store = seed();
    vi.resetModules();
  });

  it('returns the text of the run itself and of a later version', async () => {
    expect(await (await read(ROOT_ID)).json()).toEqual({ id: ROOT_ID, text: 'First output.' });
    expect(await (await read(SECOND_ID)).json()).toEqual({ id: SECOND_ID, text: 'Second output.' });
  });

  it('answers 404 for a failed attempt, which is not a version', async () => {
    expect((await read(FAILED_ID)).status).toBe(404);
  });

  it('answers 404 while the flag is off', async () => {
    state.flags.skill_output_revisions = false;

    expect((await read(ROOT_ID)).status).toBe(404);
  });

  it('refuses a reader outside the firm', async () => {
    state.wall = 'external';

    expect((await read(ROOT_ID)).status).toBe(403);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/skill-run-revision-store.test.ts tests/api/skill-run-version-route.test.ts`
Expected: FAIL, `@/lib/skillRun/revisionStore` and the route module cannot be resolved.

- [ ] **Step 4: Add the summary types to `src/lib/skillRun/types.ts`**

Append:

```ts
export type RevisionEditSummary = {
  id: string;
  kind: EditKind;
  start: number;
  end: number;
  comment: string | null;
  status: EditStatus;
  reason: string | null;
  resultStart: number | null;
  resultEnd: number | null;
  before: string | null;
};

export type RevisionSummary = {
  id: string;
  parentId: string;
  kind: "edits" | "restore";
  outcome: RunOutcome;
  errorMessage: string | null;
  actorName: string;
  createdAt: string;
  version: number | null;
  edits: RevisionEditSummary[];
  restoredFrom: string | null;
  skillMounted: boolean | null;
};
```

And add three fields at the end of `SkillRunSummary`:

```ts
  headId: string;
  headText: string | null;
  revisions: RevisionSummary[];
```

- [ ] **Step 5: Create `src/lib/skillRun/revisionStore.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

import { SKILL_RUN_SOURCE } from '@/lib/constants/dealSteps';
import { TABLE } from '@/lib/constants/tables';

import { parseRevisionInputs } from './revisions';
import type { RevisionSummary, RunOutcome } from './types';

const REVISION_COLUMNS =
  'id, outcome, inputs, result_text, error_message, actor_id, parent_run_id, root_run_id, created_at';
const ROOT_COLUMNS =
  'id, deal_step_id, outcome, result_text, skill_id, version_id, mount_name, mount_version, digest, model';

export type RevisionRow = {
  id: string;
  outcome: RunOutcome;
  inputs: unknown;
  resultText: string | null;
  errorMessage: string | null;
  actorId: string | null;
  parentId: string;
  rootId: string;
  createdAt: string;
};

export type OutputChain = {
  headId: string;
  headText: string | null;
  versions: { id: string; text: string }[];
  rows: RevisionRow[];
};

export type RootRun = {
  id: string;
  dealStepId: string;
  skillId: string | null;
  versionId: string | null;
  mountName: string | null;
  mountVersion: number | null;
  digest: string | null;
  model: string | null;
};

function toRow(raw: Record<string, unknown>): RevisionRow {
  return {
    id: raw.id as string,
    outcome: raw.outcome as RunOutcome,
    inputs: raw.inputs,
    resultText: (raw.result_text as string | null) ?? null,
    errorMessage: (raw.error_message as string | null) ?? null,
    actorId: (raw.actor_id as string | null) ?? null,
    parentId: raw.parent_run_id as string,
    rootId: raw.root_run_id as string,
    createdAt: raw.created_at as string,
  };
}

export async function readRevisionRows(
  admin: SupabaseClient,
  rootIds: string[],
): Promise<RevisionRow[]> {
  if (rootIds.length === 0) return [];
  const { data } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select(REVISION_COLUMNS)
    .in('root_run_id', rootIds)
    .order('created_at', { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(toRow);
}

export function chainOf(root: { id: string; text: string | null }, rows: RevisionRow[]): OutputChain {
  const mine = rows.filter((row) => row.rootId === root.id);
  const versions = root.text === null ? [] : [{ id: root.id, text: root.text }];
  let current = root.id;
  for (let step = 0; step < mine.length && versions.length > 0; step += 1) {
    const next = mine.find(
      (row) => row.parentId === current && row.outcome === 'succeeded' && row.resultText !== null,
    );
    if (!next || next.resultText === null) break;
    versions.push({ id: next.id, text: next.resultText });
    current = next.id;
  }
  return {
    headId: current,
    headText: versions.length > 0 ? versions[versions.length - 1].text : null,
    versions,
    rows: mine,
  };
}

export function summarize(
  chain: OutputChain,
  nameFor: (actorId: string | null) => string,
): RevisionSummary[] {
  return chain.rows.map((row) => {
    const inputs = parseRevisionInputs(row.inputs);
    const parentText = chain.versions.find((version) => version.id === row.parentId)?.text ?? null;
    const position = chain.versions.findIndex((version) => version.id === row.id);
    return {
      id: row.id,
      parentId: row.parentId,
      kind: inputs?.kind ?? 'edits',
      outcome: row.outcome,
      errorMessage: row.errorMessage,
      actorName: nameFor(row.actorId),
      createdAt: row.createdAt,
      version: position === -1 ? null : position + 1,
      edits:
        inputs?.kind === 'edits'
          ? inputs.edits.map((edit) => ({
              id: edit.id,
              kind: edit.kind,
              start: edit.start,
              end: edit.end,
              comment: edit.comment ?? null,
              status: edit.status,
              reason: edit.reason ?? null,
              resultStart: edit.resultStart ?? null,
              resultEnd: edit.resultEnd ?? null,
              before: parentText === null ? null : parentText.slice(edit.start, edit.end),
            }))
          : [],
      restoredFrom: inputs?.kind === 'restore' ? inputs.restoredFrom : null,
      skillMounted: inputs?.kind === 'edits' ? (inputs.skillMounted ?? null) : null,
    };
  });
}

export async function loadChain(
  admin: SupabaseClient,
  dealStepId: string,
  runId: string,
): Promise<{ root: RootRun; chain: OutputChain } | null> {
  const { data } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select(ROOT_COLUMNS)
    .eq('id', runId)
    .eq('deal_step_id', dealStepId)
    .neq('source', SKILL_RUN_SOURCE.REVISION)
    .maybeSingle();
  if (!data) return null;
  const raw = data as Record<string, unknown>;
  const rows = await readRevisionRows(admin, [runId]);
  return {
    root: {
      id: raw.id as string,
      dealStepId: raw.deal_step_id as string,
      skillId: (raw.skill_id as string | null) ?? null,
      versionId: (raw.version_id as string | null) ?? null,
      mountName: (raw.mount_name as string | null) ?? null,
      mountVersion: (raw.mount_version as number | null) ?? null,
      digest: (raw.digest as string | null) ?? null,
      model: (raw.model as string | null) ?? null,
    },
    chain: chainOf({ id: raw.id as string, text: (raw.result_text as string | null) ?? null }, rows),
  };
}
```

- [ ] **Step 6: Create `src/lib/skillRun/revisionAccess.ts`**

```ts
import type { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  classifyInternalUser,
  resolveDealStepCapabilities,
  userCanAccessDeal,
} from '@/lib/api/v1/access';
import { jsonError, requireApiUser, type ApiUser } from '@/lib/api/v1/http';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { requireFlag } from '@/lib/flags/requireFlag';

export type RevisionAccess = {
  admin: SupabaseClient;
  user: ApiUser;
  deal: { id: string; code: string };
  step: { dealStepId: string; stepKey: string; title: string | null };
};

type Gate = { ok: true; ctx: RevisionAccess } | { ok: false; response: NextResponse };

const STEP_COLUMNS = 'id, step_id, removed_at, definition, assigned_to, status';

function refuse(message: string, status: number): Gate {
  return { ok: false, response: jsonError(message, status) };
}

export async function requireRevisionAccess(
  dealId: string,
  stepId: string,
  mode: 'read' | 'write',
): Promise<Gate> {
  for (const flag of ['skill_authoring', 'skill_output_revisions'] as const) {
    const gate = await requireFlag(flag);
    if (gate) return { ok: false, response: gate };
  }

  const auth = await requireApiUser();
  if (!auth.ok) return { ok: false, response: auth.response };

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return refuse('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) return refuse('Forbidden', 403);

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return refuse('Profile lookup failed', 500);
  if (wall !== 'internal') return refuse('Forbidden', 403);

  const { data } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select(STEP_COLUMNS)
    .eq('deal_id', deal.id)
    .eq('step_id', stepId)
    .maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.id !== 'string') return refuse('Unknown step', 404);

  if (mode === 'write') {
    if (row.removed_at) return refuse('This step was removed', 409);
    const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
      assigned_to: (row.assigned_to as string | null) ?? null,
      status: (row.status as string) ?? 'pending',
    });
    if (capabilities === 'unreadable') return refuse('Profile lookup failed', 500);
    if (!capabilities.canEditWork) return refuse('Not permitted to revise this output', 403);
  }

  const definition = row.definition as { title?: unknown } | null;
  return {
    ok: true,
    ctx: {
      admin: auth.admin,
      user: auth.user,
      deal: { id: deal.id, code: deal.code },
      step: {
        dealStepId: row.id,
        stepKey: stepId,
        title: typeof definition?.title === 'string' ? definition.title : null,
      },
    },
  };
}
```

- [ ] **Step 7: Create the version route**

`src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/[revisionId]/route.ts`:

```ts
import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireRevisionAccess } from '@/lib/skillRun/revisionAccess';
import { loadChain } from '@/lib/skillRun/revisionStore';

type RouteContext = {
  params: Promise<{ dealId: string; stepId: string; runId: string; revisionId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { dealId, stepId, runId, revisionId } = await context.params;
  const access = await requireRevisionAccess(dealId, stepId, 'read');
  if (!access.ok) return access.response;
  if (!isUuid(runId) || !isUuid(revisionId)) return jsonError('Version not found', 404);

  const loaded = await loadChain(access.ctx.admin, access.ctx.step.dealStepId, runId);
  const version = loaded?.chain.versions.find((entry) => entry.id === revisionId);
  if (!version) return jsonError('Version not found', 404);
  return NextResponse.json({ id: version.id, text: version.text });
}
```

- [ ] **Step 8: Make the run list leave revisions out and return the head**

In `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts`:

1. Import `chainOf`, `readRevisionRows`, `summarize` from `@/lib/skillRun/revisionStore`.
2. In `readRuns`, add `.neq('source', SKILL_RUN_SOURCE.REVISION)` between `.eq('deal_step_id', dealStepId)` and `.order(...)`.
3. In `decorate`, read the revision rows before the user lookup and include their actors:

```ts
  const runIds = rows.map((row) => row.id as string);
  const revisionRows = await readRevisionRows(admin, runIds);
  const actorIds = [
    ...new Set(
      [...rows.map((row) => row.actor_id), ...revisionRows.map((row) => row.actorId)].filter(
        (id): id is string => typeof id === 'string',
      ),
    ),
  ];
```

   (This replaces the existing `actorIds` and `runIds` declarations.)

4. Replace the final `return rows.map(...)` of `decorate` with this. The first fourteen properties are the ones already there; the last three are new:

```ts
  return rows.map((row) => {
    const chain = chainOf(
      { id: row.id as string, text: (row.result_text as string | null) ?? null },
      revisionRows,
    );
    return {
      id: row.id as string,
      outcome: row.outcome as SkillRunSummary['outcome'],
      actorName:
        row.source === SKILL_RUN_SOURCE.IMPORTED
          ? IMPORTED_ACTOR_LABEL
          : (nameFor.get(row.actor_id as string) ?? 'Unknown'),
      input: (row.input as string | null) ?? null,
      inputs: parseInputValues(row.inputs) ?? {},
      resultText: (row.result_text as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      costUsd: (row.cost_usd as number | null) ?? null,
      startedAt: (row.started_at as string | null) ?? null,
      createdAt: row.created_at as string,
      binding: referenceFromRunRow(row),
      model: (row.model as string | null) ?? null,
      clampedFrom: (row.clamped_from as string | null) ?? null,
      documents: ((documents ?? []) as Record<string, unknown>[])
        .filter((doc) => doc.step_skill_run_id === row.id)
        .map((doc) => ({
          id: doc.id as string,
          name: doc.name as string,
          folder: (doc.folder as string | null) ?? null,
          createdAt: doc.created_at as string,
        })),
      headId: chain.headId,
      headText: chain.headText,
      revisions: summarize(chain, (actorId) => nameFor.get(actorId ?? '') ?? 'Unknown'),
    };
  });
```

- [ ] **Step 9: Refuse a revision row as a seed run**

In `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts`, import `SKILL_RUN_SOURCE` from `@/lib/constants/dealSteps` and add one filter in `readSeedRun`:

```ts
  let query = admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select("input, inputs, result_text, error_message")
    .eq("id", seedRunId)
    .eq("deal_id", dealId)
    .neq("source", SKILL_RUN_SOURCE.REVISION);
```

- [ ] **Step 10: Update the two existing route tests**

`tests/api/skill-run-records.test.ts`:

1. Add `revisions: [] as Record<string, unknown>[],` to `state`, and `state.revisions = [];` in `beforeEach`.
2. Replace the `select` of the `deal_step_skill_runs` builder so it answers the new query shapes:

```ts
      select: () => ({
        eq: (_column: string, value: unknown) => {
          state.queriedStepIds.push(value);
          return {
            neq: () => ({
              order: () => ({ limit: async () => ({ data: state.runs, error: null }) }),
            }),
          };
        },
        in: () => ({ order: async () => ({ data: state.revisions, error: null }) }),
      }),
```

3. Add two tests at the end of the `describe`:

```ts
  it('returns the run as its own head when nothing has been revised', async () => {
    state.runs = [storedRun()];

    const body = (await (await history()).json()) as {
      runs: { headId: string; headText: string | null; revisions: unknown[] }[];
    };

    expect(body.runs[0]).toMatchObject({ headId: RUN_ID, headText: 'Here is the update.', revisions: [] });
  });

  it('returns the latest version as the head, with what changed and who changed it', async () => {
    state.runs = [storedRun()];
    state.revisions = [
      {
        id: 'rev-2',
        outcome: 'succeeded',
        inputs: {
          kind: 'edits',
          edits: [{ id: 'e1', kind: 'hand', start: 0, end: 19, status: 'applied', resultStart: 0, resultEnd: 17 }],
        },
        result_text: 'Here is the plan.',
        error_message: null,
        actor_id: 'user-1',
        parent_run_id: RUN_ID,
        root_run_id: RUN_ID,
        created_at: '2026-09-14T11:00:00.000Z',
      },
    ];

    const body = (await (await history()).json()) as {
      runs: {
        resultText: string;
        headId: string;
        headText: string;
        revisions: { id: string; version: number; actorName: string; edits: { before: string }[] }[];
      }[];
    };

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      resultText: 'Here is the update.',
      headId: 'rev-2',
      headText: 'Here is the plan.',
    });
    expect(body.runs[0]?.revisions[0]).toMatchObject({
      id: 'rev-2',
      version: 2,
      actorName: 'Storm Duncan',
      edits: [{ before: 'Here is the update.' }],
    });
  });
```

`tests/api/skill-drafts-basis.test.ts`:

1. Give the `deal_step_skill_runs` builder a `neq`, beside its `eq`:

```ts
          neq: (column: string, value: unknown) => {
            rows = rows.filter((row) => row[column] !== value);
            return builder;
          },
```

2. Add a test beside `does not read a seed run belonging to another deal into the receipt`:

```ts
  it("does not take a revision of an output as the seed run", async () => {
    const revisionId = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    state.runs = [
      {
        id: revisionId,
        deal_id: DEAL_ID,
        deal_step_id: DEAL_STEP_UUID,
        source: "revision",
        input: null,
        inputs: { kind: "edits", edits: [{ id: "e1", kind: "comment", comment: "Fix." }] },
        result_text: "Revised.",
      },
    ];

    const { response, rpc } = await postDraft({ basisStepId: STEP_ID, seedRunId: revisionId });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.seedRun).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "skill_authoring_get_or_create_draft",
      expect.objectContaining({ p_seed_run_id: null }),
    );
  });
```

- [ ] **Step 11: Run the tests and the type check**

```bash
npx vitest run tests/skill-run-revision-store.test.ts tests/api/skill-run-version-route.test.ts \
  tests/api/skill-run-records.test.ts tests/api/skill-drafts-basis.test.ts tests/api/skill-run-stream.test.ts
npx tsc --noEmit
```

Expected: PASS. If `tsc` reports a `SkillRunSummary` built somewhere without the three new fields, add them there with `headId: <its id>`, `headText: <its resultText>` and `revisions: []`.

- [ ] **Step 12: Commit**

```bash
git add src/lib/skillRun/revisionStore.ts src/lib/skillRun/revisionAccess.ts src/lib/skillRun/types.ts \
        "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts" \
        "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/[revisionId]/route.ts" \
        "src/app/api/v1/deals/[dealId]/skill-drafts/route.ts" \
        tests/helpers/skillRunAdmin.ts tests/skill-run-revision-store.test.ts \
        tests/api/skill-run-version-route.test.ts tests/api/skill-run-records.test.ts \
        tests/api/skill-drafts-basis.test.ts
git commit -m "feat(skill-run): read a run's versions and its head

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 11: Apply hand edits and restore a version

Both are synchronous: no model is called.

**Files:**
- Create: `src/lib/skillRun/applyRevision.ts`
- Create: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route.ts`
- Test: `tests/skill-run-apply-revision.test.ts`, `tests/api/skill-run-revisions-route.test.ts`

**Interfaces:**
- Consumes: `splice`, `cleanReplacement`, `storageProblem`, `countBy`, `digestOf`, `editsDigest`, `parseRevisionRequest`, `validateEdits` (Task 7); `loadChain`, `RootRun`, `requireRevisionAccess`, `fakeAdmin` (Task 10).
- Produces, in `applyRevision.ts`:
  - `HEAD_MOVED_MESSAGE`, `AUDIT_AFTER_MESSAGE`
  - `type RevisionTarget = { admin: SupabaseClient; dealId: string; stepKey: string; actorId: string; root: RootRun; parent: { id: string; text: string } }`
  - `type RevisionResult = { ok: true; revisionId: string } | { ok: false; status: number; message: string }`
  - `recordHandRevision(target: RevisionTarget, edits: EditRequest[]): Promise<RevisionResult>`
  - `recordRestore(target: RevisionTarget, version: { id: string; text: string }): Promise<RevisionResult>`
  - `auditRevisionStarted(target: RevisionTarget, revisionId: string, edits: EditRequest[]): Promise<{ message: string } | null>`
  - Internal, reused by Task 12 in the same file: `writeRow`, `recordFailure`, `auditRevisionRecorded`, `failRemaining`, `type Engine`
- Route: `POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/{runId}/revisions`. For a batch of hand edits or a restore it answers 201 with `{ revisionId }`. The browser reloads the run list to read the revision, so the body carries only the id.

- [ ] **Step 1: Write the failing tests for the two writers**

Create `tests/skill-run-apply-revision.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('@/lib/ai/usage', () => ({
  recordAiUsage: async (_admin: unknown, row: Record<string, unknown>) => {
    ledger.rows.push(row);
    return { error: null };
  },
}));

import {
  AUDIT_AFTER_MESSAGE,
  HEAD_MOVED_MESSAGE,
  recordHandRevision,
  recordRestore,
  type RevisionTarget,
} from '@/lib/skillRun/applyRevision';

import { fakeAdmin, type FakeAdmin } from './helpers/skillRunAdmin';

const ROOT_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const PARENT_TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

function targetFor(store: FakeAdmin, overrides: Partial<RevisionTarget> = {}): RevisionTarget {
  return {
    admin: store.admin,
    dealId: 'deal-1',
    stepKey: 'custom:step',
    actorId: 'user-1',
    root: {
      id: ROOT_ID,
      dealStepId: DEAL_STEP_ID,
      skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
      versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      mountName: null,
      mountVersion: null,
      digest: 'a'.repeat(64),
      model: 'sonnet',
    },
    parent: { id: ROOT_ID, text: PARENT_TEXT },
    ...overrides,
  };
}

function runs(store: FakeAdmin) {
  return store.tables.deal_step_skill_runs ?? [];
}

function audits(store: FakeAdmin) {
  return (store.tables.audit_log ?? []).map((row) => row.detail as Record<string, unknown>);
}

describe('recordHandRevision', () => {
  let store: FakeAdmin;

  beforeEach(() => {
    store = fakeAdmin();
    ledger.rows.length = 0;
  });

  it('writes a revision whose only changes are the edited passages', async () => {
    const result = await recordHandRevision(targetFor(store), [
      { kind: 'hand', start: 23, end: 28, text: '- uno' },
      { kind: 'hand', start: 8, end: 21, text: 'Revenue rose sharply.\n\n' },
    ]);

    expect(result).toEqual({ ok: true, revisionId: expect.any(String) });
    expect(runs(store)).toHaveLength(1);
    expect(runs(store)[0]).toMatchObject({
      source: 'revision',
      parent_run_id: ROOT_ID,
      root_run_id: ROOT_ID,
      deal_step_id: DEAL_STEP_ID,
      actor_id: 'user-1',
      skill_id: '2d362e20-0709-4ba0-bbd7-d21831148282',
      digest: 'a'.repeat(64),
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose sharply.', '', '- uno', '- two'].join('\n'),
      model: null,
      cost_usd: null,
    });
    expect((runs(store)[0]?.inputs as { edits: unknown[] }).edits).toEqual([
      { id: expect.any(String), kind: 'hand', start: 23, end: 28, status: 'applied', resultStart: 31, resultEnd: 36 },
      { id: expect.any(String), kind: 'hand', start: 8, end: 21, status: 'applied', resultStart: 8, resultEnd: 29 },
    ]);
  });

  it('audits the revision with ids, counts and a digest, and no text', async () => {
    await recordHandRevision(targetFor(store), [{ kind: 'hand', start: 8, end: 21, text: 'Secret figure.' }]);

    expect(audits(store)).toHaveLength(1);
    expect(audits(store)[0]).toMatchObject({
      kind: 'skill_run_revision',
      phase: 'recorded',
      rootRunId: ROOT_ID,
      parentRunId: ROOT_ID,
      revisionKind: 'edits',
      outcome: 'succeeded',
      edits: { applied: 1 },
      resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(store.tables.audit_log)).not.toContain('Secret');
  });

  it('refuses a result that would be empty and writes nothing', async () => {
    const store2 = fakeAdmin();

    const result = await recordHandRevision(
      targetFor(store2, { parent: { id: ROOT_ID, text: 'Only paragraph.' } }),
      [{ kind: 'hand', start: 0, end: 15, text: '   ' }],
    );

    expect(result).toEqual({ ok: false, status: 422, message: 'The revised output would be empty.' });
    expect(runs(store2)).toHaveLength(0);
  });

  it('records a failed attempt and answers 409 when another revision won the same parent', async () => {
    store = fakeAdmin({
      deal_step_skill_runs: [{ id: 'winner', parent_run_id: ROOT_ID, root_run_id: ROOT_ID, outcome: 'succeeded' }],
    });

    const result = await recordHandRevision(targetFor(store), [
      { kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' },
    ]);

    expect(result).toEqual({ ok: false, status: 409, message: HEAD_MOVED_MESSAGE });
    const attempt = runs(store).find((row) => row.id !== 'winner');
    expect(attempt).toMatchObject({ outcome: 'failed', result_text: null, error_message: HEAD_MOVED_MESSAGE });
    expect((attempt?.inputs as { edits: { status: string; reason: string }[] }).edits[0]).toMatchObject({
      status: 'failed',
      reason: HEAD_MOVED_MESSAGE,
    });
  });

  it('reports the audit failure after the revision is saved', async () => {
    store.failInsertsInto.add('audit_log');

    const result = await recordHandRevision(targetFor(store), [
      { kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' },
    ]);

    expect(result).toEqual({ ok: false, status: 500, message: AUDIT_AFTER_MESSAGE });
    expect(runs(store)).toHaveLength(1);
  });
});

describe('recordRestore', () => {
  it('writes a revision that carries the text of the restored version', async () => {
    const store = fakeAdmin();

    const result = await recordRestore(
      targetFor(store, { parent: { id: 'v2', text: 'Second output.' } }),
      { id: ROOT_ID, text: PARENT_TEXT },
    );

    expect(result.ok).toBe(true);
    expect(runs(store)[0]).toMatchObject({
      parent_run_id: 'v2',
      root_run_id: ROOT_ID,
      outcome: 'succeeded',
      result_text: PARENT_TEXT,
      inputs: { kind: 'restore', restoredFrom: ROOT_ID },
    });
    expect(audits(store)[0]).toMatchObject({ phase: 'recorded', revisionKind: 'restore', restoredFrom: ROOT_ID });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/skill-run-apply-revision.test.ts`
Expected: FAIL, cannot resolve `@/lib/skillRun/applyRevision`.

- [ ] **Step 3: Create `src/lib/skillRun/applyRevision.ts`**

```ts
import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { AUDIT_ACTION } from '@/lib/constants/audit';
import { SKILL_RUN_SOURCE } from '@/lib/constants/dealSteps';
import { TABLE } from '@/lib/constants/tables';

import type { RootRun } from './revisionStore';
import {
  cleanReplacement,
  countBy,
  digestOf,
  editsDigest,
  splice,
  storageProblem,
} from './revisions';
import type { EditRecord, EditRequest, RevisionInputs, RunOutcome } from './types';

export const HEAD_MOVED_MESSAGE =
  'This output changed while you were editing. Your edits are kept. Check them against the new version.';
export const AUDIT_AFTER_MESSAGE =
  'The revision was saved, but its audit record could not be written. Contact compliance before retrying.';
const NOT_RECORDED_MESSAGE = 'The revision could not be recorded.';

export type RevisionTarget = {
  admin: SupabaseClient;
  dealId: string;
  stepKey: string;
  actorId: string;
  root: RootRun;
  parent: { id: string; text: string };
};

export type RevisionResult =
  | { ok: true; revisionId: string }
  | { ok: false; status: number; message: string };

export type Engine = {
  model: string | null;
  costUsd: number | null;
  providerRunId: string | null;
  startedAt: string | null;
};

const NO_ENGINE: Engine = { model: null, costUsd: null, providerRunId: null, startedAt: null };

type HandEdit = Extract<EditRequest, { kind: 'hand' }>;

export function failRemaining(edits: readonly EditRecord[], reason: string): EditRecord[] {
  return edits.map((edit) =>
    edit.status === 'unresolved'
      ? edit
      : {
          id: edit.id,
          kind: edit.kind,
          start: edit.start,
          end: edit.end,
          ...(edit.comment === undefined ? {} : { comment: edit.comment }),
          status: 'failed',
          reason,
        },
  );
}

export async function writeRow(
  target: RevisionTarget,
  revisionId: string,
  inputs: RevisionInputs,
  result: { text: string } | { error: string },
  engine: Engine = NO_ENGINE,
): Promise<'written' | 'head_moved' | 'refused'> {
  const succeeded = 'text' in result;
  const { error } = await target.admin.from(TABLE.DEAL_STEP_SKILL_RUNS).insert({
    id: revisionId,
    deal_id: target.dealId,
    deal_step_id: target.root.dealStepId,
    actor_id: target.actorId,
    source: SKILL_RUN_SOURCE.REVISION,
    parent_run_id: target.parent.id,
    root_run_id: target.root.id,
    skill_id: target.root.skillId,
    version_id: target.root.versionId,
    mount_name: target.root.mountName,
    mount_version: target.root.mountVersion,
    digest: target.root.digest,
    inputs,
    outcome: succeeded ? 'succeeded' : 'failed',
    result_text: succeeded ? result.text : null,
    error_message: succeeded ? null : result.error,
    model: engine.model,
    cost_usd: engine.costUsd,
    provider_run_id: engine.providerRunId,
    started_at: engine.startedAt,
  });
  if (!error) return 'written';
  return succeeded && (error as { code?: string }).code === '23505' ? 'head_moved' : 'refused';
}

async function audit(
  target: RevisionTarget,
  detail: Record<string, unknown>,
): Promise<{ message: string } | null> {
  const { error } = await target.admin.from(TABLE.AUDIT_LOG).insert({
    actor_id: target.actorId,
    action: AUDIT_ACTION.CREATE,
    deal_id: target.dealId,
    detail: {
      kind: 'skill_run_revision',
      stepKey: target.stepKey,
      dealStepId: target.root.dealStepId,
      rootRunId: target.root.id,
      parentRunId: target.parent.id,
      ...detail,
    },
  });
  return error ? { message: error.message } : null;
}

export function auditRevisionStarted(
  target: RevisionTarget,
  revisionId: string,
  edits: EditRequest[],
): Promise<{ message: string } | null> {
  return audit(target, {
    phase: 'started',
    revisionId,
    edits: countBy(edits.map((edit) => edit.kind)),
    editsDigest: editsDigest(edits),
  });
}

export function auditRevisionRecorded(
  target: RevisionTarget,
  revisionId: string,
  inputs: RevisionInputs,
  outcome: RunOutcome,
  resultText: string | null,
  model: string | null,
): Promise<{ message: string } | null> {
  return audit(target, {
    phase: 'recorded',
    revisionId,
    revisionKind: inputs.kind,
    outcome,
    edits: inputs.kind === 'edits' ? countBy(inputs.edits.map((edit) => edit.status)) : {},
    ...(inputs.kind === 'restore' ? { restoredFrom: inputs.restoredFrom } : {}),
    model,
    resultDigest: resultText === null ? null : digestOf(resultText),
  });
}

export async function recordFailure(
  target: RevisionTarget,
  revisionId: string,
  inputs: RevisionInputs,
  message: string,
  engine: Engine = NO_ENGINE,
): Promise<void> {
  const written = await writeRow(target, revisionId, inputs, { error: message }, engine);
  if (written !== 'written') {
    console.error('[skill-revision] a failed attempt could not be recorded', revisionId);
    return;
  }
  const auditError = await auditRevisionRecorded(target, revisionId, inputs, 'failed', null, engine.model);
  if (auditError) console.error('[skill-revision] audit write failed', revisionId);
}

async function commit(
  target: RevisionTarget,
  inputs: RevisionInputs,
  text: string,
): Promise<RevisionResult> {
  const revisionId = randomUUID();
  const written = await writeRow(target, revisionId, inputs, { text });
  if (written === 'head_moved') {
    const failed: RevisionInputs =
      inputs.kind === 'edits'
        ? { ...inputs, edits: failRemaining(inputs.edits, HEAD_MOVED_MESSAGE) }
        : inputs;
    await recordFailure(target, revisionId, failed, HEAD_MOVED_MESSAGE);
    return { ok: false, status: 409, message: HEAD_MOVED_MESSAGE };
  }
  if (written === 'refused') return { ok: false, status: 500, message: NOT_RECORDED_MESSAGE };

  const auditError = await auditRevisionRecorded(target, revisionId, inputs, 'succeeded', text, null);
  if (auditError) return { ok: false, status: 500, message: AUDIT_AFTER_MESSAGE };
  return { ok: true, revisionId };
}

export async function recordHandRevision(
  target: RevisionTarget,
  edits: EditRequest[],
): Promise<RevisionResult> {
  const hand = edits.filter((edit): edit is HandEdit => edit.kind === 'hand');
  const result = splice(
    target.parent.text,
    hand.map((edit) => ({ start: edit.start, end: edit.end, text: cleanReplacement(edit.text) })),
  );
  const problem = storageProblem(result.text);
  if (problem) return { ok: false, status: 422, message: problem };

  return commit(
    target,
    {
      kind: 'edits',
      edits: hand.map((edit, index) => ({
        id: randomUUID(),
        kind: 'hand',
        start: edit.start,
        end: edit.end,
        status: 'applied',
        resultStart: result.ranges[index].start,
        resultEnd: result.ranges[index].end,
      })),
    },
    result.text,
  );
}

export function recordRestore(
  target: RevisionTarget,
  version: { id: string; text: string },
): Promise<RevisionResult> {
  return commit(target, { kind: 'restore', restoredFrom: version.id }, version.text);
}
```

- [ ] **Step 4: Run the writer tests**

Run: `npx vitest run tests/skill-run-apply-revision.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing route tests**

Create `tests/api/skill-run-revisions-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEAD_MOVED_MESSAGE } from '@/lib/skillRun/applyRevision';

import { fakeAdmin, type FakeAdmin } from '../helpers/skillRunAdmin';

const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const STEP_KEY = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const ROOT_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const SECOND_ID = '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a';
const FAILED_RUN_ID = '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c';
const STRANGER_ID = '7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d';
const TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

type Capabilities = { canAssign: boolean; canComplete: boolean; canEditWork: boolean };

const state = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  capabilities: { canAssign: false, canComplete: true, canEditWork: true } as Capabilities,
  store: null as FakeAdmin | null,
  afterTasks: [] as (() => Promise<unknown>)[],
  configured: true,
}));

vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    state.afterTasks.push(task);
  },
}));
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: async () => ({ error: null }) }));
vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: async (key: string) =>
    state.flags[key] ? null : new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
}));
vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => true,
  classifyInternalUser: async () => 'internal',
  resolveDealStepCapabilities: async () => state.capabilities,
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test', companyId: null },
    admin: state.store?.admin,
  }),
}));
vi.mock('@/lib/ignatious/config', async (original) => ({
  ...(await original<typeof import('@/lib/ignatious/config')>()),
  readIgnatiousConfig: () =>
    state.configured
      ? {
          baseUrl: 'https://plane.test',
          apiKey: 'key',
          tenantId: 'tn_demo',
          leadIdOverride: null,
          benchUrl: 'https://bench.test',
          conductiaBaseUrl: 'https://conductia.test',
        }
      : null,
}));

function seed(overrides: { removed?: boolean } = {}): FakeAdmin {
  return fakeAdmin({
    deals: [{ id: 'deal-1', tenant_id: '00000000-0000-4000-8000-00000000000a' }],
    deal_steps: [
      {
        id: DEAL_STEP_ID,
        deal_id: 'deal-1',
        step_id: STEP_KEY,
        removed_at: overrides.removed ? '2026-10-13T08:00:00.000Z' : null,
        definition: { title: 'Weekly update' },
        assigned_to: null,
        status: 'pending',
      },
    ],
    deal_step_skill_runs: [
      {
        id: ROOT_ID,
        deal_step_id: DEAL_STEP_ID,
        source: 'execution',
        outcome: 'succeeded',
        result_text: TEXT,
        skill_id: '2d362e20-0709-4ba0-bbd7-d21831148282',
        version_id: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        mount_name: null,
        mount_version: null,
        digest: 'a'.repeat(64),
        model: 'sonnet',
        created_at: '2026-10-13T09:00:00.000Z',
      },
      {
        id: FAILED_RUN_ID,
        deal_step_id: DEAL_STEP_ID,
        source: 'execution',
        outcome: 'failed',
        result_text: null,
        created_at: '2026-10-13T08:30:00.000Z',
      },
    ],
  });
}

async function apply(body: unknown, runId: string = ROOT_ID) {
  const { POST } = await import(
    '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route'
  );
  return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: STEP_KEY, runId }),
  });
}

function revisions() {
  return (state.store?.tables.deal_step_skill_runs ?? []).filter((row) => row.source === 'revision');
}

function audits() {
  return (state.store?.tables.audit_log ?? []).map((row) => row.detail as Record<string, unknown>);
}

const HAND = { kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' };

describe('POST a revision of a run output', () => {
  beforeEach(() => {
    state.flags = { skill_authoring: true, skill_output_revisions: true };
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.store = seed();
    state.afterTasks.length = 0;
    state.configured = true;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('answers 404 while the flag is off', async () => {
    state.flags.skill_output_revisions = false;

    expect((await apply({ parentId: ROOT_ID, edits: [HAND] })).status).toBe(404);
    expect(revisions()).toHaveLength(0);
  });

  it('refuses a caller who cannot edit the step', async () => {
    state.capabilities = { canAssign: false, canComplete: false, canEditWork: false };

    expect((await apply({ parentId: ROOT_ID, edits: [HAND] })).status).toBe(403);
  });

  it('refuses to revise the output of a removed step', async () => {
    state.store = seed({ removed: true });

    expect((await apply({ parentId: ROOT_ID, edits: [HAND] })).status).toBe(409);
  });

  it('answers 404 for a run that is not on this step', async () => {
    expect((await apply({ parentId: STRANGER_ID, edits: [HAND] }, STRANGER_ID)).status).toBe(404);
  });

  it('refuses a run that failed, which has no output to revise', async () => {
    expect((await apply({ parentId: FAILED_RUN_ID, edits: [HAND] }, FAILED_RUN_ID)).status).toBe(409);
  });

  it('answers 409 when the parent is no longer the head', async () => {
    const response = await apply({ parentId: SECOND_ID, edits: [HAND] });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: HEAD_MOVED_MESSAGE });
    expect(revisions()).toHaveLength(0);
  });

  it('refuses an edit that cuts into a block', async () => {
    const response = await apply({ parentId: ROOT_ID, edits: [{ ...HAND, start: 9 }] });

    expect(response.status).toBe(422);
    expect(revisions()).toHaveLength(0);
  });

  it('applies hand edits at once and answers 201 with the revision id', async () => {
    const response = await apply({ parentId: ROOT_ID, edits: [HAND] });
    const body = (await response.json()) as { revisionId: string };

    expect(response.status).toBe(201);
    expect(revisions()).toHaveLength(1);
    expect(revisions()[0]).toMatchObject({
      id: body.revisionId,
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n'),
    });
    expect(state.afterTasks).toHaveLength(0);
  });

  it('restores an earlier version as a new revision', async () => {
    const first = (await (await apply({ parentId: ROOT_ID, edits: [HAND] })).json()) as {
      revisionId: string;
    };
    vi.resetModules();

    const response = await apply({ parentId: first.revisionId, restoreOf: ROOT_ID });

    expect(response.status).toBe(201);
    expect(revisions()).toHaveLength(2);
    expect(revisions()[1]).toMatchObject({
      parent_run_id: first.revisionId,
      result_text: TEXT,
      inputs: { kind: 'restore', restoredFrom: ROOT_ID },
    });
  });

  it('refuses to restore the current version, and a version from elsewhere', async () => {
    expect((await apply({ parentId: ROOT_ID, restoreOf: ROOT_ID })).status).toBe(422);

    vi.resetModules();
    expect((await apply({ parentId: ROOT_ID, restoreOf: STRANGER_ID })).status).toBe(404);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/api/skill-run-revisions-route.test.ts`
Expected: FAIL, the route module cannot be resolved.

- [ ] **Step 7: Create the route**

`src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route.ts`:

```ts
import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import {
  HEAD_MOVED_MESSAGE,
  recordHandRevision,
  recordRestore,
  type RevisionResult,
  type RevisionTarget,
} from '@/lib/skillRun/applyRevision';
import { requireRevisionAccess } from '@/lib/skillRun/revisionAccess';
import { loadChain } from '@/lib/skillRun/revisionStore';
import { parseRevisionRequest, validateEdits } from '@/lib/skillRun/revisions';

export const maxDuration = 300;

type RouteContext = { params: Promise<{ dealId: string; stepId: string; runId: string }> };

function respond(result: RevisionResult): NextResponse {
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ revisionId: result.revisionId }, { status: 201 });
}

export async function POST(request: Request, context: RouteContext) {
  const { dealId, stepId, runId } = await context.params;
  const access = await requireRevisionAccess(dealId, stepId, 'write');
  if (!access.ok) return access.response;
  const { ctx } = access;
  if (!isUuid(runId)) return jsonError('Run not found', 404);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const parsed = parseRevisionRequest(raw);
  if ('error' in parsed) return jsonError(parsed.error, 422);

  const loaded = await loadChain(ctx.admin, ctx.step.dealStepId, runId);
  if (!loaded) return jsonError('Run not found', 404);
  const { root, chain } = loaded;
  if (chain.headText === null) return jsonError('Only a run that succeeded can be revised', 409);
  if (parsed.parentId !== chain.headId) return jsonError(HEAD_MOVED_MESSAGE, 409);

  const target: RevisionTarget = {
    admin: ctx.admin,
    dealId: ctx.deal.id,
    stepKey: ctx.step.stepKey,
    actorId: ctx.user.id,
    root,
    parent: { id: chain.headId, text: chain.headText },
  };

  if (parsed.kind === 'restore') {
    const version = chain.versions.find((entry) => entry.id === parsed.restoreOf);
    if (!version) return jsonError('That version is not part of this run', 404);
    if (version.id === chain.headId) return jsonError('That version is already the current one', 422);
    return respond(await recordRestore(target, version));
  }

  const problem = validateEdits(chain.headText, parsed.edits);
  if (problem) return jsonError(problem, 422);

  if (parsed.edits.every((edit) => edit.kind === 'hand')) {
    return respond(await recordHandRevision(target, parsed.edits));
  }

  return jsonError('Comments cannot be applied yet', 501);
}
```

The last line is replaced in Task 12. It is there so this task ends with a route that answers every request.

- [ ] **Step 8: Run the tests**

```bash
npx vitest run tests/api/skill-run-revisions-route.test.ts tests/skill-run-apply-revision.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/skillRun/applyRevision.ts \
        "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route.ts" \
        tests/skill-run-apply-revision.test.ts tests/api/skill-run-revisions-route.test.ts
git commit -m "feat(skill-run): apply hand edits and restore a version as revisions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 12: Apply a batch with comments

**Files:**
- Modify: `src/lib/skillRun/applyRevision.ts`
- Modify: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route.ts`
- Modify: `tests/skill-run-apply-revision.test.ts`, `tests/api/skill-run-revisions-route.test.ts`

**Interfaces:**
- Consumes: `startSkillRunRevision`, `readRevisionStream`, `EngineOutcome`, `SKILL_RUN_REVISION_AGENT`, `skillRunRevisionScopes` (Task 9); `writeRow`, `recordFailure`, `auditRevisionRecorded`, `auditRevisionStarted`, `failRemaining`, `Engine`, `RevisionTarget` (Task 11); the Ignatious endpoint (Task 4).
- Produces, in `applyRevision.ts`:
  - `ENGINE_TIMEOUT_MS = 240_000`, `ENGINE_TIMEOUT_MESSAGE`, `ENGINE_FAILED_MESSAGE`, `NO_REPLACEMENTS_MESSAGE`, `NOTHING_APPLIED_MESSAGE`, `MISSING_REASON`
  - `type CommentBatchJob = RevisionTarget & { revisionId: string; edits: EditRequest[]; tenantId: string; deal: { id: string; code: string }; config: IgnatiousConfig; actorEmail: string; stepTitle: string | null }`
  - `applyCommentBatch(job: CommentBatchJob, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<void>`; never rejects
- Route: a batch with at least one comment answers 202 with `{ revisionId }` and does the work in `after()`. A row with that id, succeeded or failed, is what the browser polls for.

- [ ] **Step 1: Write the failing worker tests**

Append to `tests/skill-run-apply-revision.test.ts`. Add these imports to the existing import from `@/lib/skillRun/applyRevision`: `applyCommentBatch`, `ENGINE_FAILED_MESSAGE`, `ENGINE_TIMEOUT_MESSAGE`, `MISSING_REASON`, `NO_REPLACEMENTS_MESSAGE`, `NOTHING_APPLIED_MESSAGE`, `type CommentBatchJob`. Add `import { readTriggerClaims } from '@/lib/ignatious/jwt';`.

```ts
const REVISION_ID = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';

type Sent = {
  url: string;
  authorization: string | null;
  body: {
    revisionId: string;
    skill: unknown;
    document: string;
    passages: { id: string; start: number; end: number; comment: string }[];
    model: string | null;
  };
};

function sse(frames: unknown[], options: { breakAfter?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
        }
        if (options.breakAfter) controller.error(new Error('socket closed'));
        else controller.close();
      },
    }),
  );
}

function bench(reply: (sent: Sent) => Response) {
  const calls: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const sent = {
      url: String(url),
      authorization: headers.authorization ?? null,
      body: JSON.parse(String(init?.body)) as Sent['body'],
    };
    calls.push(sent);
    return reply(sent);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jobFor(store: FakeAdmin, edits: CommentBatchJob['edits'], overrides: Partial<CommentBatchJob> = {}): CommentBatchJob {
  return {
    ...targetFor(store),
    revisionId: REVISION_ID,
    edits,
    tenantId: '00000000-0000-4000-8000-00000000000a',
    deal: { id: 'deal-1', code: 'ATLAS-2026-001' },
    config: {
      baseUrl: 'https://plane.test',
      apiKey: 'key',
      tenantId: 'tn_demo',
      leadIdOverride: null,
      benchUrl: 'https://bench.test',
      conductiaBaseUrl: null,
    },
    actorEmail: 'md@example.test',
    stepTitle: 'Weekly update',
    ...overrides,
  };
}

function recorded(store: FakeAdmin) {
  const row = runs(store).find((entry) => entry.id === REVISION_ID);
  return {
    row,
    edits: ((row?.inputs as { edits?: Record<string, unknown>[] } | undefined)?.edits ?? []),
  };
}

const COMMENT = { kind: 'comment' as const, start: 8, end: 21, comment: 'It rose 12%. Say so.' };
const SECOND_COMMENT = { kind: 'comment' as const, start: 29, end: 34, comment: 'Name the buyer.' };

describe('applyCommentBatch', () => {
  let store: FakeAdmin;

  beforeEach(() => {
    store = fakeAdmin();
    ledger.rows.length = 0;
  });

  it('applies a comment and a hand edit and changes nothing else', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.\n' }] },
        { type: 'done', costUsd: 0.04, model: 'sonnet', skillMounted: true },
      ]),
    );

    await applyCommentBatch(
      jobFor(store, [COMMENT, { kind: 'hand', start: 23, end: 28, text: '- uno' }]),
      { fetchImpl: engine.fetchImpl },
    );

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose 12%.', '', '- uno', '- two'].join('\n'),
      model: 'sonnet',
      cost_usd: 0.04,
      parent_run_id: ROOT_ID,
      root_run_id: ROOT_ID,
    });
    expect(edits).toEqual([
      { id: expect.any(String), kind: 'comment', start: 8, end: 21, comment: 'It rose 12%. Say so.', status: 'applied', resultStart: 8, resultEnd: 25 },
      { id: expect.any(String), kind: 'hand', start: 23, end: 28, status: 'applied', resultStart: 27, resultEnd: 32 },
    ]);
    expect((row?.inputs as { skillMounted?: boolean }).skillMounted).toBe(true);
  });

  it('shows the engine the document as the banker already corrected it', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: '- the buyer' }] },
        { type: 'done', costUsd: 0.01 },
      ]),
    );

    await applyCommentBatch(
      jobFor(store, [
        { kind: 'hand', start: 8, end: 21, text: 'Revenue rose sharply.' },
        { kind: 'comment', start: 23, end: 28, comment: 'Name it.' },
      ]),
      { fetchImpl: engine.fetchImpl },
    );

    expect(engine.calls[0]?.url).toBe('https://bench.test/v1/bench/skill-run-revisions');
    expect(engine.calls[0]?.body.revisionId).toBe(REVISION_ID);
    expect(engine.calls[0]?.body.document).toBe(
      ['# Memo', '', 'Revenue rose sharply.', '', '- one', '- two'].join('\n'),
    );
    expect(engine.calls[0]?.body.passages).toEqual([
      { id: expect.any(String), start: 31, end: 36, comment: 'Name it.' },
    ]);
    expect(recorded(store).row?.result_text).toBe(
      ['# Memo', '', 'Revenue rose sharply.', '', '- the buyer', '- two'].join('\n'),
    );
  });

  it('sends the run skill and model, on a token that cannot write', async () => {
    const engine = bench(() => sse([{ type: 'done', costUsd: 0 }]));

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const claims = readTriggerClaims(engine.calls[0]?.authorization ?? null);
    expect(claims).toMatchObject({ agentName: 'skill-run-revision', dealId: 'deal-1', userId: 'user-1' });
    expect(claims?.scopes).toEqual(['lead.read', 'documents.read', 'maps.read', 'library.read', 'personas.read']);
    expect(engine.calls[0]?.body.skill).toEqual({
      kind: 'publication',
      projectId: 'deal-1',
      skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
      versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      digest: 'a'.repeat(64),
    });
    expect(engine.calls[0]?.body.model).toBe('sonnet');
  });

  it('sends no skill for a run that recorded no reference', async () => {
    const engine = bench(() => sse([{ type: 'done', costUsd: 0 }]));
    const job = jobFor(store, [COMMENT]);
    job.root = { ...job.root, skillId: null, versionId: null, digest: null, model: null };

    await applyCommentBatch(job, { fetchImpl: engine.fetchImpl });

    expect(engine.calls[0]?.body.skill).toBeNull();
    expect(engine.calls[0]?.body.model).toBeNull();
  });

  it('keeps an unresolved comment with its reason beside one that was applied', async () => {
    const engine = bench((sent) =>
      sse([
        {
          type: 'replacements',
          items: [
            { id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' },
            { id: sent.body.passages[1]?.id, unresolved: 'No document names the buyer.' },
          ],
        },
        { type: 'done', costUsd: 0.05, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT, SECOND_COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row?.outcome).toBe('succeeded');
    expect(edits[1]).toEqual({
      id: expect.any(String),
      kind: 'comment',
      start: 29,
      end: 34,
      comment: 'Name the buyer.',
      status: 'unresolved',
      reason: 'No document names the buyer.',
    });
  });

  it('records a passage the engine skipped, or answered for under another id, as unresolved', async () => {
    const engine = bench((sent) =>
      sse([
        {
          type: 'replacements',
          items: [
            { id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' },
            { id: 'not-a-passage', text: 'Ignored.' },
          ],
        },
        { type: 'done', costUsd: 0.05 },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT, SECOND_COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).edits[1]).toMatchObject({ status: 'unresolved', reason: MISSING_REASON });
    expect(recorded(store).row?.result_text).not.toContain('Ignored.');
  });

  it('records a failed attempt with each reason when nothing could be applied', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, unresolved: 'No source states this.' }] },
        { type: 'done', costUsd: 0.02 },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', result_text: null, error_message: NOTHING_APPLIED_MESSAGE });
    expect(edits[0]).toMatchObject({ status: 'unresolved', reason: 'No source states this.' });
  });

  it('records a failed attempt when the engine refuses the call', async () => {
    const engine = bench(() => new Response('{"error":{"code":"server_error"}}', { status: 500 }));

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', error_message: ENGINE_FAILED_MESSAGE });
    expect(edits[0]).toMatchObject({ status: 'failed', reason: ENGINE_FAILED_MESSAGE, comment: 'It rose 12%. Say so.' });
    expect(ledger.rows).toHaveLength(0);
  });

  it('records a failed attempt when the turn ends without replacements, and still books the cost', async () => {
    const engine = bench(() =>
      sse([{ type: 'text', text: 'I am not sure.' }, { type: 'done', costUsd: 0.03, model: 'sonnet' }]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: NO_REPLACEMENTS_MESSAGE, cost_usd: 0.03 });
    expect(ledger.rows).toEqual([
      expect.objectContaining({ source: 'skill_revision', externalId: REVISION_ID, costUsd: 0.03, task: 'custom:step', actorId: 'user-1' }),
    ]);
  });

  it('records a failed attempt when the connection breaks mid-stream', async () => {
    const engine = bench(() => sse([{ type: 'text', text: 'Working.' }], { breakAfter: true }));

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: ENGINE_FAILED_MESSAGE });
  });

  it('stops an engine call that runs past the limit and records why', async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl, timeoutMs: 5 });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: ENGINE_TIMEOUT_MESSAGE });
  });

  it('records a failed attempt when another revision took the parent during the call', async () => {
    store = fakeAdmin({
      deal_step_skill_runs: [{ id: 'winner', parent_run_id: ROOT_ID, root_run_id: ROOT_ID, outcome: 'succeeded' }],
    });
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.04 },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', result_text: null, error_message: HEAD_MOVED_MESSAGE });
    expect(edits[0]).toMatchObject({ status: 'failed', reason: HEAD_MOVED_MESSAGE });
    expect(ledger.rows).toHaveLength(1);
  });

  it('never writes a comment or any output text to the audit log', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.04, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const written = JSON.stringify(store.tables.audit_log);
    expect(audits(store)[0]).toMatchObject({ phase: 'recorded', revisionId: REVISION_ID, outcome: 'succeeded', edits: { applied: 1 }, model: 'sonnet' });
    expect(written).not.toContain('It rose');
    expect(written).not.toContain('Revenue');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/skill-run-apply-revision.test.ts`
Expected: FAIL, `applyCommentBatch` is not exported.

- [ ] **Step 3: Add the worker to `src/lib/skillRun/applyRevision.ts`**

Add these imports:

```ts
import { recordAiUsage } from '@/lib/ai/usage';
import { createSkillBench } from '@/lib/ignatious/bench';
import {
  leadIdForDeal,
  SKILL_RUN_REVISION_AGENT,
  type IgnatiousConfig,
} from '@/lib/ignatious/config';
import { mintTriggerToken, skillRunRevisionScopes } from '@/lib/ignatious/jwt';
import { isBenchModelAlias } from '@/lib/ignatious/processTag';

import {
  readRevisionStream,
  type EngineOutcome,
  type EngineReplacement,
} from './revisionStream';
```

Extend the existing imports: add `shiftRange` and `type Replacement` from `./revisions`, and `type SkillReference` from `./types`.

Add at the end of the file:

```ts
export const ENGINE_TIMEOUT_MS = 240_000;
export const ENGINE_TIMEOUT_MESSAGE = 'The edit took too long and was stopped. Nothing was changed.';
export const ENGINE_FAILED_MESSAGE = 'The edit could not be applied. Nothing was changed.';
export const NO_REPLACEMENTS_MESSAGE = 'The assistant returned no replacements. Nothing was changed.';
export const NOTHING_APPLIED_MESSAGE = 'None of the comments could be applied.';
export const MISSING_REASON = 'The assistant returned nothing for this passage.';
const MAX_REASON = 500;

export type CommentBatchJob = RevisionTarget & {
  revisionId: string;
  edits: EditRequest[];
  tenantId: string;
  deal: { id: string; code: string };
  config: IgnatiousConfig;
  actorEmail: string;
  stepTitle: string | null;
};

type IndexedReplacement = Replacement & { index: number };

type EngineCall = { outcome: EngineOutcome | null; failure: string | null };

function referenceOf(root: RootRun): SkillReference | null {
  if (root.digest === null) return null;
  if (root.mountName !== null && root.mountVersion !== null) {
    return { kind: 'mount', name: root.mountName, version: root.mountVersion, digest: root.digest };
  }
  if (root.skillId !== null && root.versionId !== null) {
    return { kind: 'publication', skillId: root.skillId, versionId: root.versionId, digest: root.digest };
  }
  return null;
}

async function callEngine(
  job: CommentBatchJob,
  records: readonly EditRecord[],
  hand: readonly IndexedReplacement[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<EngineCall> {
  const passages = job.edits.flatMap((edit, index) =>
    edit.kind === 'comment'
      ? [{ id: records[index].id, ...shiftRange(edit, hand), comment: edit.comment }]
      : [],
  );
  const token = mintTriggerToken({
    agentName: SKILL_RUN_REVISION_AGENT,
    dealId: job.deal.id,
    conductiaTenantId: job.tenantId,
    scopes: skillRunRevisionScopes(),
    userId: job.actorId,
    userEmail: job.actorEmail,
    stepId: job.stepKey,
    ...(job.stepTitle ? { stepTitle: job.stepTitle } : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ENGINE_TIMEOUT_MS);
  try {
    const upstream = await createSkillBench(job.config, options.fetchImpl).startSkillRunRevision(
      {
        revisionId: job.revisionId,
        skill: referenceOf(job.root),
        projectId: job.deal.id,
        document: splice(job.parent.text, hand).text,
        passages,
        tenantId: job.config.tenantId,
        leadId: leadIdForDeal(job.config, job.deal),
        model: isBenchModelAlias(job.root.model) ? job.root.model : null,
        token,
      },
      controller.signal,
    );
    if (!upstream.ok || !upstream.body) return { outcome: null, failure: ENGINE_FAILED_MESSAGE };
    const outcome = await readRevisionStream(upstream.body);
    if (outcome.replacements === null) {
      return { outcome, failure: outcome.error ? ENGINE_FAILED_MESSAGE : NO_REPLACEMENTS_MESSAGE };
    }
    return { outcome, failure: null };
  } catch {
    return {
      outcome: null,
      failure: controller.signal.aborted ? ENGINE_TIMEOUT_MESSAGE : ENGINE_FAILED_MESSAGE,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function settle(
  job: CommentBatchJob,
  records: readonly EditRecord[],
  hand: readonly IndexedReplacement[],
  outcome: EngineOutcome,
  engine: Engine,
): Promise<void> {
  const answers = outcome.replacements ?? new Map<string, EngineReplacement>();
  const applied: IndexedReplacement[] = [...hand];
  const edits = records.map((record, index): EditRecord => {
    const edit = job.edits[index];
    if (edit.kind === 'hand') return record;
    const answer = answers.get(record.id);
    if (answer && 'text' in answer) {
      applied.push({ index, start: edit.start, end: edit.end, text: cleanReplacement(answer.text) });
      return record;
    }
    return {
      ...record,
      status: 'unresolved',
      reason: (answer?.unresolved ?? MISSING_REASON).trim().slice(0, MAX_REASON),
    };
  });
  const mounted = outcome.skillMounted === null ? {} : { skillMounted: outcome.skillMounted };
  const fail = (reason: string, kept: EditRecord[]) =>
    recordFailure(job, job.revisionId, { kind: 'edits', edits: kept, ...mounted }, reason, engine);

  if (applied.length === 0) {
    await fail(NOTHING_APPLIED_MESSAGE, edits);
    return;
  }

  const result = splice(job.parent.text, applied);
  const problem = storageProblem(result.text);
  if (problem) {
    await fail(problem, failRemaining(edits, problem));
    return;
  }

  const finished = [...edits];
  applied.forEach((replacement, position) => {
    finished[replacement.index] = {
      ...finished[replacement.index],
      status: 'applied',
      resultStart: result.ranges[position].start,
      resultEnd: result.ranges[position].end,
    };
  });
  const inputs: RevisionInputs = { kind: 'edits', edits: finished, ...mounted };

  const written = await writeRow(job, job.revisionId, inputs, { text: result.text }, engine);
  if (written !== 'written') {
    const reason = written === 'head_moved' ? HEAD_MOVED_MESSAGE : ENGINE_FAILED_MESSAGE;
    await fail(reason, failRemaining(edits, reason));
    return;
  }
  const auditError = await auditRevisionRecorded(job, job.revisionId, inputs, 'succeeded', result.text, engine.model);
  if (auditError) console.error('[skill-revision] audit write failed', job.revisionId);
}

export async function applyCommentBatch(
  job: CommentBatchJob,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const startedAt = new Date().toISOString();
  const records: EditRecord[] = job.edits.map((edit) => ({
    id: randomUUID(),
    kind: edit.kind,
    start: edit.start,
    end: edit.end,
    ...(edit.kind === 'comment' ? { comment: edit.comment } : {}),
    status: 'failed',
  }));
  const hand: IndexedReplacement[] = job.edits.flatMap((edit, index) =>
    edit.kind === 'hand'
      ? [{ index, start: edit.start, end: edit.end, text: cleanReplacement(edit.text) }]
      : [],
  );

  const call = await callEngine(job, records, hand, options);
  const engine: Engine = {
    model: call.outcome?.alias ?? job.root.model,
    costUsd: call.outcome?.costUsd ?? null,
    providerRunId: call.outcome?.providerRunId ?? null,
    startedAt,
  };

  try {
    if (call.failure !== null || call.outcome === null) {
      const reason = call.failure ?? ENGINE_FAILED_MESSAGE;
      await recordFailure(
        job,
        job.revisionId,
        { kind: 'edits', edits: failRemaining(records, reason) },
        reason,
        engine,
      );
    } else {
      await settle(job, records, hand, call.outcome, engine);
    }
  } catch {
    console.error('[skill-revision] the batch could not be settled', job.revisionId);
  } finally {
    if (call.outcome?.finished) {
      await recordAiUsage(job.admin, {
        tenantId: job.tenantId,
        dealId: job.dealId,
        actorId: job.actorId,
        source: 'skill_revision',
        task: job.stepKey,
        externalId: job.revisionId,
        model: call.outcome.model,
        costUsd: call.outcome.costUsd,
      });
    }
  }
}
```

A turn that ended is on the ledger whether or not its replacements could be used: the bank paid for it. `recordAiUsage` never throws.

- [ ] **Step 4: Run the worker tests**

Run: `npx vitest run tests/skill-run-apply-revision.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Write the failing route tests**

Append to the `describe` in `tests/api/skill-run-revisions-route.test.ts`:

```ts
  const COMMENT = { kind: 'comment', start: 8, end: 21, comment: 'It rose 12%. Say so.' };

  function stubBench() {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { passages: { id: string }[] };
      calls.push(sent);
      const encoder = new TextEncoder();
      const frames = [
        { type: 'replacements', items: [{ id: sent.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.04, model: 'sonnet', skillMounted: true },
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames) {
              controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
            }
            controller.close();
          },
        }),
      );
    });
    return calls;
  }

  it('answers 202 for a batch with a comment, then records the revision under that id', async () => {
    const calls = stubBench();

    const response = await apply({ parentId: ROOT_ID, edits: [COMMENT] });
    const body = (await response.json()) as { revisionId: string };

    expect(response.status).toBe(202);
    expect(revisions()).toHaveLength(0);
    expect(audits()).toEqual([
      expect.objectContaining({ phase: 'started', revisionId: body.revisionId, edits: { comment: 1 } }),
    ]);

    await Promise.all(state.afterTasks.map((task) => task()));

    expect(calls).toHaveLength(1);
    expect(revisions()[0]).toMatchObject({
      id: body.revisionId,
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n'),
    });
  });

  it('sends a mixed batch through the engine path', async () => {
    stubBench();

    const response = await apply({
      parentId: ROOT_ID,
      edits: [COMMENT, { kind: 'hand', start: 23, end: 28, text: '- uno' }],
    });

    expect(response.status).toBe(202);
    await Promise.all(state.afterTasks.map((task) => task()));
    expect(revisions()[0]?.result_text).toBe(
      ['# Memo', '', 'Revenue rose 12%.', '', '- uno', '- two'].join('\n'),
    );
  });

  it('answers 503 and records nothing when the skill service is not configured', async () => {
    state.configured = false;

    const response = await apply({ parentId: ROOT_ID, edits: [COMMENT] });

    expect(response.status).toBe(503);
    expect(audits()).toHaveLength(0);
    expect(state.afterTasks).toHaveLength(0);
  });

  it('does not start the edit when its audit row cannot be written', async () => {
    const calls = stubBench();
    state.store?.failInsertsInto.add('audit_log');

    const response = await apply({ parentId: ROOT_ID, edits: [COMMENT] });

    expect(response.status).toBe(500);
    expect(state.afterTasks).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(revisions()).toHaveLength(0);
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run tests/api/skill-run-revisions-route.test.ts`
Expected: FAIL, the comment batch answers 501.

- [ ] **Step 7: Finish the route**

In `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route.ts`:

Change the imports:

```ts
import { randomUUID } from 'node:crypto';

import { after, NextResponse } from 'next/server';

import { auditFailed, isUuid, jsonError } from '@/lib/api/v1/http';
import { TABLE } from '@/lib/constants/tables';
import { readIgnatiousConfig } from '@/lib/ignatious/config';
import { SKILL_SERVICE_UNCONFIGURED_MESSAGE } from '@/lib/ignatious/failure';
import {
  applyCommentBatch,
  auditRevisionStarted,
  HEAD_MOVED_MESSAGE,
  recordHandRevision,
  recordRestore,
  type RevisionResult,
  type RevisionTarget,
} from '@/lib/skillRun/applyRevision';
```

Replace the last line of `POST`, `return jsonError('Comments cannot be applied yet', 501);`, with:

```ts
  const config = readIgnatiousConfig();
  if (!config) return jsonError(SKILL_SERVICE_UNCONFIGURED_MESSAGE, 503);

  const { data: owner, error: ownerError } = await ctx.admin
    .from(TABLE.DEALS)
    .select('tenant_id')
    .eq('id', ctx.deal.id)
    .maybeSingle();
  if (ownerError) return jsonError('Deal lookup failed', 500);
  const tenantId = (owner?.tenant_id as string | null | undefined) ?? null;
  if (!tenantId) return jsonError('Deal has no tenant', 500);

  const revisionId = randomUUID();
  const auditError = await auditRevisionStarted(target, revisionId, parsed.edits);
  if (auditError) {
    return auditFailed(auditError, 'The edit could not be recorded, so it was not started. Try again.');
  }

  after(() =>
    applyCommentBatch({
      ...target,
      revisionId,
      edits: parsed.edits,
      tenantId,
      deal: ctx.deal,
      config,
      actorEmail: ctx.user.email,
      stepTitle: ctx.step.title,
    }),
  );
  return NextResponse.json({ revisionId }, { status: 202 });
```

- [ ] **Step 8: Run the tests**

```bash
npx vitest run tests/api/skill-run-revisions-route.test.ts tests/skill-run-apply-revision.test.ts
npx tsc --noEmit
npm run lint
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/skillRun/applyRevision.ts \
        "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route.ts" \
        tests/skill-run-apply-revision.test.ts tests/api/skill-run-revisions-route.test.ts
git commit -m "feat(skill-run): apply comments through the read-only engine, in the background

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

# Part D: Conductia surface

The mockup beside the spec is the behavioural reference for Part D. Open it before starting, and again when reviewing each task.

### Task 13: Stamp block ranges on rendered Markdown

**Files:**
- Modify: `src/components/atoms/Markdown.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/markdown-anchors.test.tsx`

**Interfaces:**
- Consumes: `blockRanges`, `type Block`, `type BlockKind` (Task 6).
- Produces:
  - `type MarkdownAnchors = { marks?: ReadonlyMap<number, string>; labels?: ReadonlyMap<number, string>; selected?: { start: number; end: number } | null; tabStop?: number | null }`, every map keyed by a block's start offset
  - `MarkdownProps.anchors?: MarkdownAnchors`. When given, each block element carries `data-block-start`, `data-block-end`, `data-block-kind`, and, where they apply, `data-mark`, `data-mark-label`, `data-selected="true"` and a `tabIndex` (0 on `tabStop`, -1 on the others, none when `tabStop` is undefined).
  - CSS class `review-doc` whose descendants style those attributes.

A rendered element's own source range is not the block's range: a parent list item's element runs to the end of its nested list. So the atom stamps an element only when its start offset is the start of a block of the matching kind, and takes the end from the block. This was checked against the installed renderer while the plan was written.

- [ ] **Step 1: Write the failing test**

Create `tests/markdown-anchors.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '@/components/atoms';

const DOC = [
  '# Title',
  '',
  'First paragraph.',
  '',
  '- parent',
  '  - child',
  '- two',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '> quoted',
  '',
  '```',
  'code',
  '```',
].join('\n');

describe('Markdown anchors', () => {
  it('stamps nothing unless anchors are asked for', () => {
    render(<Markdown>{DOC}</Markdown>);

    expect(screen.getByText('First paragraph.')).not.toHaveAttribute('data-block-start');
    expect(screen.getByRole('heading', { name: 'Title' })).not.toHaveAttribute('data-block-start');
  });

  it('stamps each block with its range in the source text', () => {
    render(<Markdown anchors={{}}>{DOC}</Markdown>);

    const heading = screen.getByRole('heading', { name: 'Title' });
    expect(heading).toHaveAttribute('data-block-start', '0');
    expect(heading).toHaveAttribute('data-block-end', '7');
    expect(heading).toHaveAttribute('data-block-kind', 'heading');
    expect(screen.getByText('First paragraph.')).toHaveAttribute('data-block-end', '25');
    expect(screen.getByText('two')).toHaveAttribute('data-block-kind', 'listItem');
    expect(screen.getByText('quoted').closest('blockquote')).toHaveAttribute('data-block-kind', 'blockquote');
    expect(screen.getByText('quoted')).not.toHaveAttribute('data-block-start');
    expect(screen.getByText('code').closest('pre')).toHaveAttribute('data-block-kind', 'code');
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('data-block-kind', 'tableRow');
  });

  it('ends a parent list item before its nested items', () => {
    render(<Markdown anchors={{}}>{DOC}</Markdown>);

    const parent = screen.getByText('child').closest('ul')?.closest('li');
    expect(parent).toHaveAttribute('data-block-start', '27');
    expect(parent).toHaveAttribute('data-block-end', '35');
    expect(DOC.slice(27, 35)).toBe('- parent');
  });

  it('writes marks, labels and the selection onto the blocks they name', () => {
    render(
      <Markdown
        anchors={{
          marks: new Map([[9, 'pending']]),
          labels: new Map([[9, '1']]),
          selected: { start: 0, end: 7 },
        }}
      >
        {DOC}
      </Markdown>,
    );

    const paragraph = screen.getByText('First paragraph.');
    expect(paragraph).toHaveAttribute('data-mark', 'pending');
    expect(paragraph).toHaveAttribute('data-mark-label', '1');
    expect(paragraph).not.toHaveAttribute('data-selected');
    expect(screen.getByRole('heading', { name: 'Title' })).toHaveAttribute('data-selected', 'true');
  });

  it('gives one block the tab stop and takes the others out of the tab order', () => {
    render(<Markdown anchors={{ tabStop: 9 }}>{DOC}</Markdown>);

    expect(screen.getByText('First paragraph.')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('heading', { name: 'Title' })).toHaveAttribute('tabindex', '-1');
  });

  it('leaves blocks out of the tab order when no tab stop is given', () => {
    render(<Markdown anchors={{}}>{DOC}</Markdown>);

    expect(screen.getByText('First paragraph.')).not.toHaveAttribute('tabindex');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/markdown-anchors.test.tsx`
Expected: FAIL, `anchors` is not a prop and no element carries `data-block-start`.

- [ ] **Step 3: Add anchors to `src/components/atoms/Markdown.tsx`**

Add the import and the types near the top:

```tsx
import { blockRanges, type Block, type BlockKind } from '@/lib/skillRun/blocks';

export type MarkdownAnchors = {
  marks?: ReadonlyMap<number, string>;
  labels?: ReadonlyMap<number, string>;
  selected?: { start: number; end: number } | null;
  tabStop?: number | null;
};
```

Add `anchors?: MarkdownAnchors;` to `MarkdownProps`.

Add, above `COMPONENTS`:

```tsx
type AnchorState = MarkdownAnchors & { blocks: ReadonlyMap<number, Block> };

const AnchorContext = React.createContext<AnchorState | null>(null);

const TAG_KINDS = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  li: 'listItem',
  tr: 'tableRow',
  blockquote: 'blockquote',
  pre: 'code',
} as const satisfies Record<string, BlockKind>;

type AnchoredProps = React.HTMLAttributes<HTMLElement> & {
  as: keyof typeof TAG_KINDS;
  node?: { position?: { start: { offset?: number } } };
};

function Anchored({ as, node, ...rest }: AnchoredProps) {
  const anchors = React.useContext(AnchorContext);
  const start = node?.position?.start.offset;
  const block = anchors && typeof start === 'number' ? anchors.blocks.get(start) : undefined;
  if (!anchors || !block || block.kind !== TAG_KINDS[as]) {
    return React.createElement(as as string, rest);
  }
  const selected =
    anchors.selected != null &&
    block.start >= anchors.selected.start &&
    block.end <= anchors.selected.end;
  return React.createElement(as as string, {
    ...rest,
    'data-block-start': block.start,
    'data-block-end': block.end,
    'data-block-kind': block.kind,
    'data-mark': anchors.marks?.get(block.start),
    'data-mark-label': anchors.labels?.get(block.start),
    'data-selected': selected ? 'true' : undefined,
    tabIndex: anchors.tabStop === undefined ? undefined : anchors.tabStop === block.start ? 0 : -1,
  });
}
```

In `COMPONENTS`, replace these ten renderers and add an eleventh, `tr`, beside `td`. Each keeps the class and style it has today; only the element it renders changes. Every other renderer (`strong`, `em`, `ul`, `ol`, `table`, `th`, `td`, `a`, `code`, `img`, `hr`) is untouched.

```tsx
  h1: (props) => (
    <Anchored as="h1" node={props.node} {...domProps(props)} className="bank-heading" style={heading('var(--text-xl)')} />
  ),
  h2: (props) => (
    <Anchored as="h2" node={props.node} {...domProps(props)} className="bank-heading" style={heading('var(--text-lg)')} />
  ),
  h3: (props) => (
    <Anchored as="h3" node={props.node} {...domProps(props)} className="bank-heading" style={heading('var(--text-md)')} />
  ),
  h4: (props) => (
    <Anchored as="h4" node={props.node} {...domProps(props)} className="bank-heading" style={heading('var(--text-md)')} />
  ),
  h5: (props) => (
    <Anchored as="h5" node={props.node} {...domProps(props)} className="bank-heading" style={heading('var(--text-md)')} />
  ),
  h6: (props) => (
    <Anchored as="h6" node={props.node} {...domProps(props)} className="bank-heading" style={heading('var(--text-md)')} />
  ),

  p: (props) => (
    <Anchored
      as="p"
      node={props.node}
      {...domProps(props)}
      className="body"
      style={{ color: 'var(--md-ink)', margin: '0 0 var(--space-3)' }}
    />
  ),
```

```tsx
  li: (props) => (
    <Anchored as="li" node={props.node} {...domProps(props)} style={{ margin: '0 0 var(--space-2)' }} />
  ),
```

```tsx
  tr: (props) => <Anchored as="tr" node={props.node} {...domProps(props)} />,
```

```tsx
  pre: (props) => (
    <Anchored
      as="pre"
      node={props.node}
      {...domProps(props)}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        background: 'var(--md-fill)',
        border: '1px solid var(--md-stroke)',
        borderRadius: 'var(--radius-input)',
        padding: 'var(--space-3)',
        overflowX: 'auto',
        color: 'var(--md-ink)',
        margin: '0 0 var(--space-3)',
      }}
    />
  ),

  blockquote: (props) => (
    <Anchored
      as="blockquote"
      node={props.node}
      {...domProps(props)}
      style={{
        borderLeft: '2px solid var(--md-stroke)',
        paddingLeft: 'var(--space-3)',
        margin: '0 0 var(--space-3)',
        color: 'var(--md-ink-2)',
      }}
    />
  ),
```

Let the formatter wrap the heading lines.

Replace the `Markdown` function:

```tsx
export function Markdown({ children, variant = 'light', className, anchors }: MarkdownProps) {
  const anchored = anchors !== undefined;
  const blocks = React.useMemo(
    () =>
      anchored ? new Map(blockRanges(children ?? '').map((block) => [block.start, block])) : null,
    [anchored, children],
  );
  const state = React.useMemo(
    () => (blocks && anchors ? { ...anchors, blocks } : null),
    [anchors, blocks],
  );

  if (!children || !children.trim()) return null;
  return (
    <div className={className} style={{ ...ALIASES[variant], color: 'var(--md-ink)' }}>
      <AnchorContext.Provider value={state}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={COMPONENTS}>
          {children}
        </ReactMarkdown>
      </AnchorContext.Provider>
    </div>
  );
}
```

- [ ] **Step 4: Add the passage marks to `src/app/globals.css`**

Inside the existing `@layer components { ... }` block, before its closing brace:

```css
  .review-doc [data-block-start] {
    position: relative;
    border-radius: var(--radius-input);
    cursor: pointer;
    scroll-margin: var(--space-6);
  }
  .review-doc [data-block-start]:hover,
  .review-doc [data-selected='true'] {
    background: var(--surface-subtle);
  }
  .review-doc [data-block-start]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .review-doc [data-selected='true'] {
    outline: 1px solid var(--stroke-strong);
    outline-offset: 2px;
  }
  .review-doc [data-mark='pending'] {
    outline: 1px dashed var(--ink-tertiary);
    outline-offset: 2px;
  }
  .review-doc [data-mark='applying'] {
    outline: 1px dashed var(--ai);
    outline-offset: 2px;
    opacity: 0.7;
  }
  .review-doc [data-mark='comment'] {
    box-shadow: inset 2px 0 0 var(--ai);
    background: var(--ai-tint);
  }
  .review-doc [data-mark='hand'] {
    box-shadow: inset 2px 0 0 var(--ink);
    background: var(--surface-subtle);
  }
  .review-doc tr[data-mark='comment'] > *:first-child {
    box-shadow: inset 2px 0 0 var(--ai);
  }
  .review-doc tr[data-mark='comment'] > * {
    background: var(--ai-tint);
  }
  .review-doc tr[data-mark='hand'] > *:first-child {
    box-shadow: inset 2px 0 0 var(--ink);
  }
  .review-doc tr[data-mark='hand'] > * {
    background: var(--surface-subtle);
  }
  .review-doc :not(tr)[data-mark-label]::before {
    content: attr(data-mark-label);
    position: absolute;
    top: 0;
    right: 100%;
    margin-right: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-secondary);
  }
  .review-doc[data-readonly='true'] [data-block-start] {
    cursor: default;
  }
  .review-doc[data-readonly='true'] [data-block-start]:hover {
    background: transparent;
  }
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/markdown-anchors.test.tsx tests/markdown-atom.test.tsx \
  tests/markdown-node-coverage.test.tsx tests/markdown-table-edges.test.tsx \
  tests/bench-chat-markdown.test.tsx tests/presearch-memo-markdown.test.tsx
npm run lint
```

Expected: PASS. The five existing Markdown tests prove that a caller who passes no `anchors` gets the DOM it got before.

- [ ] **Step 6: Commit**

```bash
git add src/components/atoms/Markdown.tsx src/app/globals.css tests/markdown-anchors.test.tsx
git commit -m "feat(markdown): opt-in block anchors with source ranges and passage marks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 14: Pending edits, apply and restore in the browser

**Files:**
- Create: `src/lib/skillRun/revisionView.ts`
- Create: `src/lib/skillRun/revisionClient.ts`
- Create: `src/components/rail/review/useRunRevisions.ts`
- Test: `tests/skill-run-revision-view.test.ts`

**Interfaces:**
- Consumes: `blockRanges`, `isAligned` (Task 6); `RevisionSummary`, `SkillRunSummary` (Task 10); the routes (Tasks 10 to 12).
- Produces, in `revisionView.ts`:
  - `type OutputVersion = { id: string; number: number; actorName: string; createdAt: string; revision: RevisionSummary | null }`
  - `type PendingEdit = { key: string; kind: 'comment' | 'hand'; start: number; end: number; passage: string; value: string; problem: string | null; detached: boolean }`
  - `DETACHED_PROBLEM`, `STILL_APPLYING_MESSAGE`, `NOT_APPLIED_MESSAGE`
  - `normalizeRun(run): SkillRunSummary`, `outputVersions(run): OutputVersion[]`, `versionLabel(versions, id): string`, `plural(count, noun): string`
  - `confirmation(revision: RevisionSummary, versions: OutputVersion[]): string`
  - `reattach(edits: PendingEdit[], headText: string): PendingEdit[]`
  - `settlePending(edits: PendingEdit[], sentKeys: string[], revision: RevisionSummary, headText: string): PendingEdit[]`
- Produces, in `revisionClient.ts`:
  - `type PostRevisionResult = { kind: 'recorded' | 'started'; revisionId: string } | { kind: 'refused'; status: number; message: string }`
  - `postRevision(runsPath: string, runId: string, body: unknown): Promise<PostRevisionResult>`
  - `fetchVersionText(runsPath: string, runId: string, versionId: string): Promise<string | null>`
- Produces, in `useRunRevisions.ts`:
  - `type ReviewStatus = { kind: 'idle' } | { kind: 'applying'; keys: string[] } | { kind: 'done'; message: string } | { kind: 'error'; message: string }`
  - `useRunRevisions({ runsPath, run, reload, pollMs?, maxPolls? })` returning `{ pending: PendingEdit[]; status: ReviewStatus; save(edit): void; remove(key: string): void; discard(): void; apply(): Promise<void>; restore(versionId: string): Promise<void> }`
  - `type RunRevisions = ReturnType<typeof useRunRevisions>`

The hook is exercised through the components in Task 15, which is where its tests live. This task tests the pure helpers.

- [ ] **Step 1: Write the failing test**

Create `tests/skill-run-revision-view.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  confirmation,
  DETACHED_PROBLEM,
  normalizeRun,
  outputVersions,
  plural,
  reattach,
  settlePending,
  versionLabel,
  type PendingEdit,
} from '@/lib/skillRun/revisionView';
import type { RevisionSummary, SkillRunSummary } from '@/lib/skillRun/types';

const TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

function revision(overrides: Partial<RevisionSummary> = {}): RevisionSummary {
  return {
    id: 'rev-2',
    parentId: 'run-1',
    kind: 'edits',
    outcome: 'succeeded',
    errorMessage: null,
    actorName: 'Lance Park',
    createdAt: '2026-10-13T10:00:00.000Z',
    version: 2,
    edits: [],
    restoredFrom: null,
    skillMounted: true,
    ...overrides,
  };
}

function run(overrides: Partial<SkillRunSummary> = {}): SkillRunSummary {
  return {
    id: 'run-1',
    outcome: 'succeeded',
    actorName: 'Storm Duncan',
    input: null,
    inputs: {},
    resultText: TEXT,
    errorMessage: null,
    costUsd: null,
    startedAt: null,
    createdAt: '2026-10-13T09:00:00.000Z',
    binding: null,
    model: 'sonnet',
    clampedFrom: null,
    documents: [],
    headId: 'run-1',
    headText: TEXT,
    revisions: [],
    ...overrides,
  };
}

function edit(overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    key: 'k1',
    kind: 'comment',
    start: 8,
    end: 21,
    passage: 'Revenue fell.',
    value: 'It rose.',
    problem: null,
    detached: false,
    ...overrides,
  };
}

function applied(kind: 'comment' | 'hand', status: 'applied' | 'unresolved', reason: string | null = null) {
  return { id: 'e', kind, start: 0, end: 1, comment: null, status, reason, resultStart: null, resultEnd: null, before: null };
}

describe('normalizeRun', () => {
  it('treats a run with no revision fields as its own head', () => {
    const { headId, headText, revisions, ...older } = run();

    expect(normalizeRun(older)).toMatchObject({ headId: 'run-1', headText: TEXT, revisions: [] });
    expect([headId, headText, revisions]).toEqual(['run-1', TEXT, []]);
  });
});

describe('outputVersions and versionLabel', () => {
  it('numbers the run as version 1 and each successful revision after it', () => {
    const versions = outputVersions(
      run({
        headId: 'rev-2',
        revisions: [revision(), revision({ id: 'failed', version: null, outcome: 'failed' })],
      }),
    );

    expect(versions.map((version) => [version.id, version.number, version.actorName])).toEqual([
      ['run-1', 1, 'Storm Duncan'],
      ['rev-2', 2, 'Lance Park'],
    ]);
    expect(versionLabel(versions, 'rev-2')).toBe('Version 2 of 2');
  });

  it('has no versions for a run that failed', () => {
    expect(outputVersions(run({ resultText: null, headText: null, outcome: 'failed' }))).toEqual([]);
  });
});

describe('plural', () => {
  it('adds an s to anything but one', () => {
    expect([plural(1, 'edit'), plural(3, 'edit'), plural(0, 'edit')]).toEqual(['1 edit', '3 edits', '0 edits']);
  });
});

describe('confirmation', () => {
  const versions = outputVersions(run({ revisions: [revision()] }));

  it('states what was applied, what was not, and the version recorded', () => {
    const landed = revision({
      edits: [applied('comment', 'applied'), applied('hand', 'applied'), applied('comment', 'applied'), applied('comment', 'unresolved', 'No source.')],
    });

    expect(confirmation(landed, versions)).toBe('3 edits applied. 1 could not be applied. Version 2 is recorded.');
  });

  it('says nothing about failures when every edit was applied', () => {
    expect(confirmation(revision({ edits: [applied('hand', 'applied')] }), versions)).toBe(
      '1 edit applied. Version 2 is recorded.',
    );
  });

  it('names the version a restore brought back', () => {
    expect(confirmation(revision({ kind: 'restore', restoredFrom: 'run-1' }), versions)).toBe(
      'Version 1 restored. Version 2 is recorded.',
    );
  });

  it('gives the reason of a failed attempt', () => {
    expect(
      confirmation(revision({ outcome: 'failed', version: null, errorMessage: 'None of the comments could be applied.' }), versions),
    ).toBe('None of the comments could be applied.');
  });
});

describe('reattach', () => {
  it('keeps an edit whose passage is where it was', () => {
    expect(reattach([edit()], TEXT)).toEqual([edit()]);
  });

  it('moves an edit whose passage shifted but is unchanged', () => {
    const shifted = ['# A longer memo title', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

    expect(reattach([edit()], shifted)).toEqual([edit({ start: 23, end: 36 })]);
  });

  it('detaches an edit whose passage no longer exists', () => {
    const rewritten = ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n');

    expect(reattach([edit()], rewritten)).toEqual([edit({ detached: true, problem: DETACHED_PROBLEM })]);
  });

  it('detaches an edit whose passage now appears twice', () => {
    const doubled = ['Revenue fell.', '', 'Revenue fell.'].join('\n');

    expect(reattach([edit({ start: 100, end: 113 })], doubled)[0]).toMatchObject({ detached: true });
  });
});

describe('settlePending', () => {
  it('drops the edits that were applied and keeps an unresolved one with its reason', () => {
    const pending = [edit({ key: 'a' }), edit({ key: 'b', start: 23, end: 28, passage: '- one', value: 'Name it.' })];
    const landed = revision({
      edits: [applied('comment', 'applied'), applied('comment', 'unresolved', 'No document names the buyer.')],
    });
    const head = ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n');

    expect(settlePending(pending, ['a', 'b'], landed, head)).toEqual([
      edit({ key: 'b', start: 27, end: 32, passage: '- one', value: 'Name it.', problem: 'No document names the buyer.' }),
    ]);
  });

  it('keeps every edit when the attempt failed', () => {
    const pending = [edit({ key: 'a' })];

    expect(settlePending(pending, ['a'], revision({ outcome: 'failed', version: null }), TEXT)).toEqual(pending);
  });

  it('keeps an edit that was not part of the batch', () => {
    const pending = [edit({ key: 'a' }), edit({ key: 'late', start: 29, end: 34, passage: '- two' })];
    const landed = revision({ edits: [applied('hand', 'applied')] });

    expect(settlePending(pending, ['a'], landed, TEXT).map((entry) => entry.key)).toEqual(['late']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/skill-run-revision-view.test.ts`
Expected: FAIL, cannot resolve `@/lib/skillRun/revisionView`.

- [ ] **Step 3: Create `src/lib/skillRun/revisionView.ts`**

```ts
import { blockRanges, isAligned } from './blocks';
import type { RevisionSummary, SkillRunSummary } from './types';

export const DETACHED_PROBLEM = 'This passage changed. Place the edit again or remove it.';
export const NOT_APPLIED_MESSAGE = 'The edits could not be applied.';
export const STILL_APPLYING_MESSAGE =
  'This is taking longer than expected. Reload the step to see whether the edits landed.';

export type OutputVersion = {
  id: string;
  number: number;
  actorName: string;
  createdAt: string;
  revision: RevisionSummary | null;
};

export type PendingEdit = {
  key: string;
  kind: 'comment' | 'hand';
  start: number;
  end: number;
  passage: string;
  value: string;
  problem: string | null;
  detached: boolean;
};

type RunAsListed = Omit<SkillRunSummary, 'headId' | 'headText' | 'revisions'> &
  Partial<Pick<SkillRunSummary, 'headId' | 'headText' | 'revisions'>>;

export function normalizeRun(run: RunAsListed): SkillRunSummary {
  return {
    ...run,
    headId: run.headId ?? run.id,
    headText: run.headText === undefined ? run.resultText : run.headText,
    revisions: run.revisions ?? [],
  };
}

export function outputVersions(run: SkillRunSummary): OutputVersion[] {
  if (run.resultText === null) return [];
  const later = run.revisions
    .flatMap((revision) => (revision.version === null ? [] : [{ revision, number: revision.version }]))
    .sort((a, b) => a.number - b.number)
    .map(({ revision, number }) => ({
      id: revision.id,
      number,
      actorName: revision.actorName,
      createdAt: revision.createdAt,
      revision,
    }));
  return [
    { id: run.id, number: 1, actorName: run.actorName, createdAt: run.createdAt, revision: null },
    ...later,
  ];
}

export function versionLabel(versions: OutputVersion[], id: string): string {
  const version = versions.find((entry) => entry.id === id);
  return `Version ${String(version?.number ?? versions.length)} of ${String(versions.length)}`;
}

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function confirmation(revision: RevisionSummary, versions: OutputVersion[]): string {
  if (revision.outcome === 'failed') return revision.errorMessage ?? NOT_APPLIED_MESSAGE;
  const recorded = `Version ${String(revision.version ?? versions.length)} is recorded.`;
  if (revision.kind === 'restore') {
    const source = versions.find((entry) => entry.id === revision.restoredFrom);
    return `Version ${String(source?.number ?? 1)} restored. ${recorded}`;
  }
  const applied = revision.edits.filter((edit) => edit.status === 'applied').length;
  const missed = revision.edits.length - applied;
  const parts = [`${plural(applied, 'edit')} applied.`];
  if (missed > 0) parts.push(`${String(missed)} could not be applied.`);
  return [...parts, recorded].join(' ');
}

export function reattach(edits: PendingEdit[], headText: string): PendingEdit[] {
  const blocks = blockRanges(headText);
  return edits.map((edit) => {
    if (headText.slice(edit.start, edit.end) === edit.passage) return { ...edit, detached: false };
    const at = headText.indexOf(edit.passage);
    const moved = { start: at, end: at + edit.passage.length };
    const unique = at !== -1 && headText.indexOf(edit.passage, at + 1) === -1;
    if (unique && isAligned(blocks, moved)) return { ...edit, ...moved, detached: false };
    return { ...edit, detached: true, problem: DETACHED_PROBLEM };
  });
}

export function settlePending(
  edits: PendingEdit[],
  sentKeys: string[],
  revision: RevisionSummary,
  headText: string,
): PendingEdit[] {
  if (revision.outcome === 'failed') return edits;
  const kept = edits.flatMap((edit) => {
    const position = sentKeys.indexOf(edit.key);
    if (position === -1) return [edit];
    const outcome = revision.edits[position];
    if (!outcome || outcome.status === 'applied') return [];
    return [{ ...edit, problem: outcome.reason ?? NOT_APPLIED_MESSAGE }];
  });
  return reattach(kept, headText);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/skill-run-revision-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `src/lib/skillRun/revisionClient.ts`**

```ts
export type PostRevisionResult =
  | { kind: 'recorded' | 'started'; revisionId: string }
  | { kind: 'refused'; status: number; message: string };

const UNREACHABLE_MESSAGE = 'The edits could not be sent. Check your connection and try again.';
const REFUSED_MESSAGE = 'The edits could not be applied.';

function revisionsPath(runsPath: string, runId: string): string {
  return `${runsPath}/${encodeURIComponent(runId)}/revisions`;
}

export async function postRevision(
  runsPath: string,
  runId: string,
  body: unknown,
): Promise<PostRevisionResult> {
  let response: Response;
  try {
    response = await fetch(revisionsPath(runsPath, runId), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'refused', status: 0, message: UNREACHABLE_MESSAGE };
  }
  const parsed = (await response.json().catch(() => null)) as {
    revisionId?: unknown;
    error?: unknown;
  } | null;
  if ((response.status === 201 || response.status === 202) && typeof parsed?.revisionId === 'string') {
    return { kind: response.status === 201 ? 'recorded' : 'started', revisionId: parsed.revisionId };
  }
  return {
    kind: 'refused',
    status: response.status,
    message: typeof parsed?.error === 'string' ? parsed.error : REFUSED_MESSAGE,
  };
}

export async function fetchVersionText(
  runsPath: string,
  runId: string,
  versionId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${revisionsPath(runsPath, runId)}/${encodeURIComponent(versionId)}`,
      { credentials: 'include' },
    );
    if (!response.ok) return null;
    const parsed = (await response.json()) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Create `src/components/rail/review/useRunRevisions.ts`**

```ts
'use client';

import * as React from 'react';

import { postRevision, type PostRevisionResult } from '@/lib/skillRun/revisionClient';
import {
  confirmation,
  outputVersions,
  reattach,
  settlePending,
  STILL_APPLYING_MESSAGE,
  type PendingEdit,
} from '@/lib/skillRun/revisionView';
import type { SkillRunSummary } from '@/lib/skillRun/types';

export type ReviewStatus =
  | { kind: 'idle' }
  | { kind: 'applying'; keys: string[] }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

export type EditDraft = Pick<PendingEdit, 'kind' | 'start' | 'end' | 'passage' | 'value'> & {
  key?: string;
};

type Options = {
  runsPath: string;
  run: SkillRunSummary;
  reload: () => Promise<SkillRunSummary[]>;
  pollMs?: number;
  maxPolls?: number;
};

const HEAD_CONFLICT = 409;

function requestOf(edit: PendingEdit) {
  return edit.kind === 'comment'
    ? { kind: 'comment', start: edit.start, end: edit.end, comment: edit.value }
    : { kind: 'hand', start: edit.start, end: edit.end, text: edit.value };
}

export function useRunRevisions({ runsPath, run, reload, pollMs = 2000, maxPolls = 150 }: Options) {
  const [draft, setDraft] = React.useState<{ runId: string; edits: PendingEdit[] }>({
    runId: run.id,
    edits: [],
  });
  const [status, setStatus] = React.useState<ReviewStatus>({ kind: 'idle' });
  const busy = React.useRef(false);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pending = draft.runId === run.id ? draft.edits : [];

  function setEdits(edits: PendingEdit[]) {
    setDraft({ runId: run.id, edits: [...edits].sort((a, b) => a.start - b.start) });
  }

  function save(edit: EditDraft) {
    const key = edit.key ?? crypto.randomUUID();
    const others = pending.filter((entry) => entry.key !== key);
    setEdits([...others, { ...edit, key, problem: null, detached: false }]);
    setStatus({ kind: 'idle' });
  }

  function remove(key: string) {
    setEdits(pending.filter((entry) => entry.key !== key));
  }

  function discard() {
    setEdits([]);
    setStatus({ kind: 'idle' });
  }

  async function landed(revisionId: string) {
    for (let attempt = 0; attempt < maxPolls && alive.current; attempt += 1) {
      const fresh = (await reload()).find((entry) => entry.id === run.id);
      const revision = fresh?.revisions.find((entry) => entry.id === revisionId);
      if (fresh && revision) return { fresh, revision };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return null;
  }

  async function finish(result: PostRevisionResult, keys: string[]) {
    if (result.kind === 'refused') {
      if (result.status === HEAD_CONFLICT) {
        const fresh = (await reload()).find((entry) => entry.id === run.id);
        if (fresh?.headText) setEdits(reattach(pending, fresh.headText));
      }
      setStatus({ kind: 'error', message: result.message });
      return;
    }
    const arrived = await landed(result.revisionId);
    if (!alive.current) return;
    if (!arrived) {
      setStatus({ kind: 'error', message: STILL_APPLYING_MESSAGE });
      return;
    }
    setEdits(settlePending(pending, keys, arrived.revision, arrived.fresh.headText ?? ''));
    const message = confirmation(arrived.revision, outputVersions(arrived.fresh));
    setStatus(
      arrived.revision.outcome === 'succeeded' ? { kind: 'done', message } : { kind: 'error', message },
    );
  }

  async function send(body: unknown, keys: string[]) {
    if (busy.current) return;
    busy.current = true;
    setStatus({ kind: 'applying', keys });
    try {
      await finish(await postRevision(runsPath, run.id, body), keys);
    } finally {
      busy.current = false;
    }
  }

  async function apply() {
    const sending = pending.filter((entry) => !entry.detached);
    if (sending.length === 0) return;
    await send(
      { parentId: run.headId, edits: sending.map(requestOf) },
      sending.map((entry) => entry.key),
    );
  }

  async function restore(versionId: string) {
    await send({ parentId: run.headId, restoreOf: versionId }, []);
  }

  return { pending, status, save, remove, discard, apply, restore };
}

export type RunRevisions = ReturnType<typeof useRunRevisions>;
```

The `busy` ref, not the `applying` status, is what stops a double click from sending twice: the status only changes after a render.

- [ ] **Step 7: Type check and commit**

```bash
npx tsc --noEmit
git add src/lib/skillRun/revisionView.ts src/lib/skillRun/revisionClient.ts \
        src/components/rail/review/useRunRevisions.ts tests/skill-run-revision-view.test.ts
git commit -m "feat(skill-run): pending edits, apply and restore in the browser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 15: The review view

**Files:**
- Create: `src/components/rail/review/reviewCopy.ts`
- Create: `src/components/rail/review/ReviewDocument.tsx`
- Create: `src/components/rail/review/EditComposer.tsx`
- Create: `src/components/rail/review/EditsPane.tsx`
- Create: `src/components/rail/review/VersionBar.tsx`
- Create: `src/components/rail/review/ReviewOutputDialog.tsx`
- Create: `src/components/rail/review/RunOutput.tsx`
- Test: `tests/review-output.test.tsx`

**Interfaces:**
- Consumes: `Markdown` with `anchors` (Task 13); `useRunRevisions`, `RunRevisions`, `ReviewStatus`, `outputVersions`, `versionLabel`, `plural`, `PendingEdit`, `OutputVersion`, `fetchVersionText` (Task 14); `useModalDialog` and the `Button` atom (existing).
- Produces: `RunOutput({ runsPath: string; run: SkillRunSummary; documents: SkillRunSummary['documents']; reload: () => Promise<SkillRunSummary[]>; pollMs?: number })`, the only component Task 16 imports.

- [ ] **Step 1: Write the failing test**

Create `tests/review-output.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunOutput } from '@/components/rail/review/RunOutput';
import type { RevisionEditSummary, RevisionSummary, SkillRunSummary } from '@/lib/skillRun/types';

const RUNS_PATH = '/api/v1/deals/ATLAS-2026-001/steps/custom%3Astep/skill-runs';
const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');
const HEAD_MOVED = 'This output changed while you were editing. Your edits are kept. Check them against the new version.';

function run(overrides: Partial<SkillRunSummary> = {}): SkillRunSummary {
  return {
    id: RUN_ID,
    outcome: 'succeeded',
    actorName: 'Storm Duncan',
    input: null,
    inputs: {},
    resultText: TEXT,
    errorMessage: null,
    costUsd: null,
    startedAt: null,
    createdAt: '2026-10-13T09:00:00.000Z',
    binding: null,
    model: 'sonnet',
    clampedFrom: null,
    documents: [],
    headId: RUN_ID,
    headText: TEXT,
    revisions: [],
    ...overrides,
  };
}

function editSummary(overrides: Partial<RevisionEditSummary> = {}): RevisionEditSummary {
  return {
    id: 'e1',
    kind: 'comment',
    start: 8,
    end: 21,
    comment: 'It rose 12%.',
    status: 'applied',
    reason: null,
    resultStart: 8,
    resultEnd: 25,
    before: 'Revenue fell.',
    ...overrides,
  };
}

function revision(overrides: Partial<RevisionSummary> = {}): RevisionSummary {
  return {
    id: 'rev-2',
    parentId: RUN_ID,
    kind: 'edits',
    outcome: 'succeeded',
    errorMessage: null,
    actorName: 'Lance Park',
    createdAt: '2026-10-13T10:00:00.000Z',
    version: 2,
    edits: [],
    restoredFrom: null,
    skillMounted: true,
    ...overrides,
  };
}

const server = {
  posts: [] as { url: string; body: unknown }[],
  reply: (): Response | Promise<Response> => new Response('{}', { status: 500 }),
  lists: [] as SkillRunSummary[][],
};

function Harness({ initial }: { initial: SkillRunSummary }) {
  const [runs, setRuns] = React.useState([initial]);
  const reload = React.useCallback(async () => {
    const next = server.lists.length > 1 ? (server.lists.shift() ?? [initial]) : (server.lists[0] ?? [initial]);
    setRuns(next);
    return next;
  }, [initial]);
  return <RunOutput runsPath={RUNS_PATH} run={runs[0]} documents={[]} reload={reload} pollMs={1} />;
}

function openReview(initial: SkillRunSummary = run()) {
  render(<Harness initial={initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
  return screen.getByRole('dialog', { name: 'Review output' });
}

function output(dialog: HTMLElement) {
  return within(within(dialog).getByRole('group', { name: 'Output' }));
}

function addComment(dialog: HTMLElement, passage: string, comment: string) {
  fireEvent.click(output(dialog).getByText(passage));
  fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
    target: { value: comment },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
}

describe('reviewing a run output', () => {
  beforeEach(() => {
    server.posts = [];
    server.reply = () => new Response('{}', { status: 500 });
    server.lists = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          server.posts.push({ url, body: JSON.parse(String(init.body)) });
          return server.reply();
        }
        return new Response(JSON.stringify({ id: 'x', text: 'Fetched version text.' }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('labels the output with its version and who made it', () => {
    render(<Harness initial={run()} />);

    expect(screen.getByText(/Version 1 of 1 · Storm Duncan/)).toBeInTheDocument();
  });

  it('adds a comment on a selected passage and names the commit for what it does', () => {
    const dialog = openReview();

    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    expect(within(dialog).getByRole('list', { name: 'Pending' })).toHaveTextContent('It rose 12%.');
    expect(within(dialog).getByRole('button', { name: 'Apply 1 edit' })).toBeEnabled();
    expect(output(dialog).getByText('Revenue fell.')).toHaveAttribute('data-mark', 'pending');
  });

  it('reopens a pending edit when its passage is selected again', () => {
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(output(dialog).getByText('Revenue fell.'));

    expect(within(dialog).getByLabelText('What should change in this passage')).toHaveValue('It rose 12%.');
    expect(within(dialog).getByRole('button', { name: 'Update comment' })).toBeInTheDocument();
  });

  it('applies a hand edit and states what was recorded', async () => {
    const next = ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n');
    server.reply = () => new Response(JSON.stringify({ revisionId: 'rev-2' }), { status: 201 });
    server.lists = [
      [
        run({
          headId: 'rev-2',
          headText: next,
          revisions: [revision({ edits: [editSummary({ kind: 'hand', comment: null, resultEnd: 21 })] })],
        }),
      ],
    ];
    const dialog = openReview();

    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit text' }));
    const field = within(dialog).getByLabelText('Passage text, in Markdown');
    expect(field).toHaveValue('Revenue fell.');
    fireEvent.change(field, { target: { value: 'Revenue rose.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save edit' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));

    expect(await within(dialog).findByText('1 edit applied. Version 2 is recorded.')).toBeInTheDocument();
    expect(server.posts).toEqual([
      {
        url: `${RUNS_PATH}/${RUN_ID}/revisions`,
        body: { parentId: RUN_ID, edits: [{ kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' }] },
      },
    ]);
    expect(within(dialog).getByText('Version 2 of 2')).toBeInTheDocument();
    expect(output(dialog).getByText('Revenue rose.')).toHaveAttribute('data-mark', 'hand');
    expect(within(dialog).getByRole('list', { name: 'Changed in this version' })).toHaveTextContent('Edited by hand');
    expect(within(dialog).getByRole('button', { name: 'Apply edits' })).toBeDisabled();
  });

  it('waits for a comment batch and keeps an unresolved comment with its reason', async () => {
    const next = ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n');
    server.reply = () => new Response(JSON.stringify({ revisionId: 'rev-2' }), { status: 202 });
    server.lists = [
      [run()],
      [
        run({
          headId: 'rev-2',
          headText: next,
          revisions: [
            revision({
              edits: [
                editSummary(),
                editSummary({
                  id: 'e2',
                  start: 23,
                  end: 28,
                  comment: 'Name the buyer.',
                  status: 'unresolved',
                  reason: 'No document names the buyer.',
                  resultStart: null,
                  resultEnd: null,
                  before: '- one',
                }),
              ],
            }),
          ],
        }),
      ],
    ];
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');
    addComment(dialog, 'one', 'Name the buyer.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 2 edits' }));

    expect(
      await within(dialog).findByText('1 edit applied. 1 could not be applied. Version 2 is recorded.'),
    ).toBeInTheDocument();
    expect(server.posts[0]?.body).toEqual({
      parentId: RUN_ID,
      edits: [
        { kind: 'comment', start: 8, end: 21, comment: 'It rose 12%.' },
        { kind: 'comment', start: 23, end: 28, comment: 'Name the buyer.' },
      ],
    });
    const pending = within(dialog).getByRole('list', { name: 'Pending' });
    expect(pending).toHaveTextContent('Not applied');
    expect(pending).toHaveTextContent('No document names the buyer.');
    expect(output(dialog).getByText('Revenue rose 12%.')).toHaveAttribute('data-mark', 'comment');
  });

  it('says it is applying and locks the document while a batch is in flight', () => {
    server.reply = () => new Promise<Response>(() => undefined);
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));
    fireEvent.click(output(dialog).getByText('one'));

    expect(within(dialog).getByText('Applying. This can take a minute.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();
    expect(output(dialog).getByText('Revenue fell.')).toHaveAttribute('data-mark', 'applying');
  });

  it('keeps the pending edits when the output changed underneath', async () => {
    server.reply = () => new Response(JSON.stringify({ error: HEAD_MOVED }), { status: 409 });
    server.lists = [[run()]];
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(HEAD_MOVED);
    expect(within(dialog).getByRole('list', { name: 'Pending' })).toHaveTextContent('It rose 12%.');
  });

  it('shows an earlier version read-only and restores it', async () => {
    server.reply = () => new Response(JSON.stringify({ revisionId: 'rev-3' }), { status: 201 });
    server.lists = [
      [
        run({
          headId: 'rev-3',
          headText: TEXT,
          revisions: [
            revision(),
            revision({ id: 'rev-3', parentId: 'rev-2', kind: 'restore', version: 3, restoredFrom: RUN_ID }),
          ],
        }),
      ],
    ];
    const dialog = openReview(run({ headId: 'rev-2', headText: 'Second output.', revisions: [revision()] }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Earlier version' }));

    expect(within(dialog).getByText('Version 1 of 2')).toBeInTheDocument();
    expect(within(dialog).getByText('This is an earlier version. It is read-only.')).toBeInTheDocument();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    expect(within(dialog).queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore this version' }));

    expect(await within(dialog).findByText('Version 1 restored. Version 3 is recorded.')).toBeInTheDocument();
    expect(server.posts[0]?.body).toEqual({ parentId: 'rev-2', restoreOf: RUN_ID });
    expect(within(dialog).getByText('Version 3 of 3')).toBeInTheDocument();
  });

  it('shows the passage as it was before an edit', () => {
    const dialog = openReview(
      run({
        headId: 'rev-2',
        headText: ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n'),
        revisions: [revision({ edits: [editSummary()] })],
      }),
    );
    const changed = within(dialog).getByRole('list', { name: 'Changed in this version' });

    fireEvent.click(within(changed).getByRole('button', { name: 'Show before' }));

    expect(within(changed).getByText('Revenue fell.')).toBeInTheDocument();
    expect(changed).toHaveTextContent('It rose 12%.');
    expect(changed).toHaveTextContent('Lance Park');
  });

  it('reaches a passage from the keyboard', () => {
    const dialog = openReview();
    const heading = within(dialog).getByRole('heading', { name: 'Memo' });
    expect(heading).toHaveAttribute('tabindex', '0');
    heading.focus();

    fireEvent.keyDown(heading, { key: 'ArrowDown' });
    const paragraph = output(dialog).getByText('Revenue fell.');
    expect(paragraph).toHaveFocus();
    fireEvent.keyDown(paragraph, { key: 'Enter' });

    expect(within(dialog).getByLabelText('What should change in this passage')).toHaveFocus();
  });

  it('closes the composer on Escape before it closes the view, and returns focus', () => {
    render(<Harness initial={run()} />);
    const opener = screen.getByRole('button', { name: 'Review output' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Review output' });
    fireEvent.click(output(dialog).getByText('Revenue fell.'));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(within(dialog).queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Review output' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Review output' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('keeps pending edits when the view is closed and says so on the step', () => {
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByText(/1 pending edit/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(screen.getByRole('list', { name: 'Pending' })).toHaveTextContent('It rose 12%.');
  });

  it('discards every pending edit in one action', () => {
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard pending edits' }));

    expect(within(dialog).queryByRole('list', { name: 'Pending' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Apply edits' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/review-output.test.tsx`
Expected: FAIL, cannot resolve `@/components/rail/review/RunOutput`.

- [ ] **Step 3: Create `reviewCopy.ts`**

```ts
import type { ReviewStatus } from './useRunRevisions';

export const REVIEW_COPY = {
  open: 'Review output',
  title: 'Review output',
  document: 'Output',
  applying: 'Applying. This can take a minute.',
  readOnly: 'This is an earlier version. It is read-only.',
  restore: 'Restore this version',
  earlier: 'Earlier version',
  later: 'Later version',
  composer: 'Edit this passage',
  comment: 'Comment',
  editText: 'Edit text',
  commentLabel: 'What should change in this passage',
  textLabel: 'Passage text, in Markdown',
  addComment: 'Add comment',
  updateComment: 'Update comment',
  saveEdit: 'Save edit',
  updateEdit: 'Update edit',
  cancel: 'Cancel',
  remove: 'Remove',
  edit: 'Edit',
  pending: 'Pending',
  changed: 'Changed in this version',
  editedByHand: 'Edited by hand',
  rewritten: 'Rewritten from a comment',
  notApplied: 'Not applied',
  showBefore: 'Show before',
  hideBefore: 'Hide before',
  discard: 'Discard pending edits',
  close: 'Close',
  applyNone: 'Apply edits',
  emptyPending: 'Select a passage to comment on it or edit it.',
  firstOutput: "This is the run's first output.",
  loadingVersion: 'Loading this version.',
  versionUnavailable: 'This version could not be loaded.',
  skillNotMounted:
    'The skill version this run used was not available, so these edits were made without it.',
  keyboardHint:
    'Use the arrow keys to move between passages. Press Enter to comment on a passage or edit it.',
} as const;

export function statusLine(status: ReviewStatus): string | null {
  if (status.kind === 'idle') return null;
  return status.kind === 'applying' ? REVIEW_COPY.applying : status.message;
}
```

- [ ] **Step 4: Create `ReviewDocument.tsx`**

```tsx
'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import { blockRanges, type Block, type Range } from '@/lib/skillRun/blocks';

import { REVIEW_COPY } from './reviewCopy';

type Props = {
  text: string;
  readOnly: boolean;
  marks: ReadonlyMap<number, string>;
  labels: ReadonlyMap<number, string>;
  selection: Range | null;
  onSelect: (range: Range) => void;
  children?: React.ReactNode;
};

const COMPOSER_GAP = 8;
const COMPOSER_ROOM = 320;

function elementOf(node: EventTarget | Node | null): Element | null {
  if (node instanceof Element) return node;
  return node instanceof Node ? node.parentElement : null;
}

export function ReviewDocument({
  text,
  readOnly,
  marks,
  labels,
  selection,
  onSelect,
  children,
}: Props) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const hintId = React.useId();
  const blocks = React.useMemo(() => blockRanges(text), [text]);
  const composerRef = React.useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = React.useState<number | null>(null);

  const tabStop = blocks.some((block) => block.start === cursor)
    ? cursor
    : (blocks[0]?.start ?? null);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const composer = composerRef.current;
    if (!root || !composer || !selection) return;
    const last = root.querySelector(`[data-block-end="${String(selection.end)}"]`);
    if (!last) return;
    const top = last.getBoundingClientRect().bottom - root.getBoundingClientRect().top + COMPOSER_GAP;
    composer.style.top = `${String(top)}px`;
  }, [selection, text, readOnly]);

  function blockAt(target: EventTarget | Node | null): Block | null {
    const element = elementOf(target)?.closest('[data-block-start]');
    if (!element || !rootRef.current?.contains(element)) return null;
    const start = Number(element.getAttribute('data-block-start'));
    return blocks.find((block) => block.start === start) ?? null;
  }

  function select(block: Block, extend: boolean) {
    setCursor(block.start);
    onSelect(
      extend && selection
        ? {
            start: Math.min(selection.start, block.start),
            end: Math.max(selection.end, block.end),
          }
        : { start: block.start, end: block.end },
    );
  }

  function handleClick(event: React.MouseEvent) {
    if (readOnly || elementOf(event.target)?.closest('a')) return;
    const dragged = window.getSelection();
    const from = dragged && !dragged.isCollapsed ? blockAt(dragged.anchorNode) : null;
    const to = dragged && !dragged.isCollapsed ? blockAt(dragged.focusNode) : null;
    if (from && to) {
      setCursor(to.start);
      onSelect({ start: Math.min(from.start, to.start), end: Math.max(from.end, to.end) });
      return;
    }
    const clicked = blockAt(event.target);
    if (clicked) select(clicked, event.shiftKey);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (readOnly) return;
    const focused =
      event.target instanceof Element && event.target.hasAttribute('data-block-start')
        ? blockAt(event.target)
        : null;
    if (!focused) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = blocks[blocks.indexOf(focused) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setCursor(next.start);
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-block-start="${String(next.start)}"]`)
        ?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(focused, event.shiftKey);
    }
  }

  const composing = selection !== null && !readOnly;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={REVIEW_COPY.document}
      aria-describedby={readOnly ? undefined : hintId}
      data-readonly={readOnly ? 'true' : undefined}
      className="review-doc relative mx-auto max-w-[72ch] pl-[var(--space-6)]"
      style={composing ? { paddingBottom: COMPOSER_ROOM } : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <p id={hintId} className="sr-only">
        {REVIEW_COPY.keyboardHint}
      </p>
      <Markdown
        anchors={{ marks, labels, selected: selection, tabStop: readOnly ? undefined : tabStop }}
      >
        {text}
      </Markdown>
      {composing ? (
        <div
          ref={composerRef}
          className="absolute inset-x-0 top-0 z-10 pl-[var(--space-6)]"
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Create `EditComposer.tsx`**

```tsx
'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { REVISION_LIMITS } from '@/lib/skillRun/types';

import { REVIEW_COPY } from './reviewCopy';

type Mode = 'comment' | 'hand';

type Props = {
  passage: string;
  existing: { kind: Mode; value: string; problem: string | null } | null;
  onSave: (kind: Mode, value: string) => void;
  onCancel: () => void;
  onRemove: (() => void) | null;
};

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'comment', label: REVIEW_COPY.comment },
  { mode: 'hand', label: REVIEW_COPY.editText },
];

const FIELD =
  'mt-1 w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

export function EditComposer({ passage, existing, onSave, onCancel, onRemove }: Props) {
  const [mode, setMode] = React.useState<Mode>(existing?.kind ?? 'comment');
  const [comment, setComment] = React.useState(existing?.kind === 'comment' ? existing.value : '');
  const [text, setText] = React.useState(existing?.kind === 'hand' ? existing.value : passage);
  const fieldRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fieldId = React.useId();

  React.useEffect(() => {
    fieldRef.current?.focus();
  }, [mode]);

  const commenting = mode === 'comment';
  const ready = commenting ? comment.trim() !== '' : text !== passage;
  const updating = existing?.kind === mode;
  const saveLabel = commenting
    ? updating
      ? REVIEW_COPY.updateComment
      : REVIEW_COPY.addComment
    : updating
      ? REVIEW_COPY.updateEdit
      : REVIEW_COPY.saveEdit;

  return (
    <div
      role="group"
      aria-label={REVIEW_COPY.composer}
      className="rounded-[var(--radius-card)] border border-[var(--stroke-strong)] bg-[var(--surface)] p-[var(--space-3)] shadow-[var(--shadow-ambient)]"
    >
      <div className="flex gap-[var(--space-2)]">
        {MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={mode === option.mode}
            onClick={() => setMode(option.mode)}
            className="rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] aria-pressed:bg-[var(--surface-subtle)] aria-pressed:text-[var(--ink)]"
          >
            {option.label}
          </button>
        ))}
      </div>

      <label
        htmlFor={fieldId}
        className="mt-[var(--space-3)] block text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
      >
        {commenting ? REVIEW_COPY.commentLabel : REVIEW_COPY.textLabel}
      </label>
      <textarea
        id={fieldId}
        ref={fieldRef}
        rows={commenting ? 3 : 6}
        value={commenting ? comment : text}
        maxLength={commenting ? REVISION_LIMITS.comment : REVISION_LIMITS.text}
        onChange={(event) =>
          commenting ? setComment(event.target.value) : setText(event.target.value)
        }
        className={commenting ? FIELD : `${FIELD} font-mono`}
      />

      {existing?.problem ? (
        <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--negative-deep)]">
          {REVIEW_COPY.notApplied}. {existing.problem}
        </p>
      ) : null}

      <div className="mt-[var(--space-3)] flex items-center justify-between gap-[var(--space-3)]">
        <div>
          {onRemove ? (
            <Button variant="ghost" size="sm" onClick={onRemove}>
              {REVIEW_COPY.remove}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {REVIEW_COPY.cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!ready}
            onClick={() => onSave(mode, commenting ? comment.trim() : text)}
          >
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create `EditsPane.tsx`**

```tsx
'use client';

import * as React from 'react';

import { Badge, Markdown } from '@/components/atoms';
import type { OutputVersion, PendingEdit } from '@/lib/skillRun/revisionView';
import type { RevisionEditSummary } from '@/lib/skillRun/types';

import { REVIEW_COPY } from './reviewCopy';

type Props = {
  atHead: boolean;
  locked: boolean;
  pending: PendingEdit[];
  onOpen: (edit: PendingEdit) => void;
  onRemove: (key: string) => void;
  viewing: OutputVersion;
  versions: OutputVersion[];
};

const HEADING = 'text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]';
const ITEM = 'border-t border-[var(--stroke)] py-[var(--space-3)] first:border-t-0';
const LINK = 'text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline disabled:opacity-50';
const EXCERPT_LENGTH = 80;

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH)}...` : line;
}

function PendingItem({
  edit,
  number,
  locked,
  onOpen,
  onRemove,
}: {
  edit: PendingEdit;
  number: number | null;
  locked: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <li className={ITEM}>
      <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {number === null ? '' : `${String(number)} · `}
        {edit.kind === 'comment' ? REVIEW_COPY.comment : REVIEW_COPY.editedByHand}
      </p>
      <p className="mt-1 font-[family-name:var(--font-display)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {excerpt(edit.passage)}
      </p>
      <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink)]">{excerpt(edit.value)}</p>
      {edit.problem ? (
        <p className="mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          <Badge tone="hold">{REVIEW_COPY.notApplied}</Badge>
          {edit.problem}
        </p>
      ) : null}
      <div className="mt-[var(--space-2)] flex gap-[var(--space-3)]">
        <button type="button" className={LINK} disabled={locked || edit.detached} onClick={onOpen}>
          {REVIEW_COPY.edit}
        </button>
        <button type="button" className={LINK} disabled={locked} onClick={onRemove}>
          {REVIEW_COPY.remove}
        </button>
      </div>
    </li>
  );
}

function ChangedItem({ edit, actorName }: { edit: RevisionEditSummary; actorName: string }) {
  const [open, setOpen] = React.useState(false);
  const byAi = edit.kind === 'comment';
  return (
    <li className={ITEM}>
      <p className="flex items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${byAi ? 'bg-[var(--ai)]' : 'bg-[var(--ink)]'}`}
        />
        {byAi ? REVIEW_COPY.rewritten : REVIEW_COPY.editedByHand} · {actorName}
      </p>
      {edit.comment ? (
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink)]">{edit.comment}</p>
      ) : null}
      {edit.status === 'applied' ? null : (
        <p className="mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          <Badge tone="hold">{REVIEW_COPY.notApplied}</Badge>
          {edit.reason}
        </p>
      )}
      {edit.before !== null && edit.status === 'applied' ? (
        <>
          <button
            type="button"
            className={`mt-[var(--space-2)] ${LINK}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? REVIEW_COPY.hideBefore : REVIEW_COPY.showBefore}
          </button>
          {open ? (
            <Markdown className="mt-[var(--space-2)] rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface-warm)] p-[var(--space-3)]">
              {edit.before}
            </Markdown>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export function EditsPane({ atHead, locked, pending, onOpen, onRemove, viewing, versions }: Props) {
  const revision = viewing.revision;
  const restoredFrom = versions.find((version) => version.id === revision?.restoredFrom);
  const numbers = new Map(
    pending.filter((edit) => !edit.detached).map((edit, index) => [edit.key, index + 1]),
  );

  return (
    <div className="space-y-[var(--space-5)]">
      {atHead ? (
        <section>
          <h3 className={HEADING}>
            {REVIEW_COPY.pending}
            {pending.length > 0 ? ` · ${String(pending.length)}` : ''}
          </h3>
          {pending.length === 0 ? (
            <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              {REVIEW_COPY.emptyPending}
            </p>
          ) : (
            <ul aria-label={REVIEW_COPY.pending} className="mt-[var(--space-2)]">
              {pending.map((edit) => (
                <PendingItem
                  key={edit.key}
                  edit={edit}
                  number={numbers.get(edit.key) ?? null}
                  locked={locked}
                  onOpen={() => onOpen(edit)}
                  onRemove={() => onRemove(edit.key)}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section>
        <h3 className={HEADING}>{REVIEW_COPY.changed}</h3>
        {revision === null ? (
          <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {REVIEW_COPY.firstOutput}
          </p>
        ) : revision.kind === 'restore' ? (
          <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
            Restored from version {String(restoredFrom?.number ?? 1)} by {revision.actorName}.
          </p>
        ) : (
          <>
            {revision.skillMounted === false ? (
              <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                {REVIEW_COPY.skillNotMounted}
              </p>
            ) : null}
            <ul aria-label={REVIEW_COPY.changed} className="mt-[var(--space-2)]">
              {revision.edits.map((edit) => (
                <ChangedItem key={edit.id} edit={edit} actorName={revision.actorName} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
```

The numbers match the labels on the passages: both count the placed edits in document order.

- [ ] **Step 7: Create `VersionBar.tsx`**

```tsx
'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { versionLabel, type OutputVersion } from '@/lib/skillRun/revisionView';

import { REVIEW_COPY } from './reviewCopy';

type Props = {
  versions: OutputVersion[];
  viewing: OutputVersion;
  busy: boolean;
  onView: (id: string) => void;
  onRestore: () => void;
};

const STEP =
  'rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-40 disabled:hover:bg-transparent';

export function VersionBar({ versions, viewing, busy, onView, onRestore }: Props) {
  const index = versions.findIndex((version) => version.id === viewing.id);
  const atHead = index === versions.length - 1;

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--space-3)] border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)]">
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <button
          type="button"
          className={STEP}
          aria-label={REVIEW_COPY.earlier}
          disabled={index <= 0}
          onClick={() => onView(versions[index - 1].id)}
        >
          Earlier
        </button>
        <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
          {versionLabel(versions, viewing.id)}
        </p>
        <button
          type="button"
          className={STEP}
          aria-label={REVIEW_COPY.later}
          disabled={atHead}
          onClick={() => onView(versions[index + 1].id)}
        >
          Later
        </button>
        <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {viewing.actorName} · {new Date(viewing.createdAt).toLocaleString()}
        </p>
      </div>
      {atHead ? null : (
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {REVIEW_COPY.readOnly}
          </p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore}>
            {REVIEW_COPY.restore}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Create `ReviewOutputDialog.tsx`**

```tsx
'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { blockRanges, blocksWithin, type Range } from '@/lib/skillRun/blocks';
import { fetchVersionText } from '@/lib/skillRun/revisionClient';
import { plural, type OutputVersion, type PendingEdit } from '@/lib/skillRun/revisionView';
import type { SkillRunSummary } from '@/lib/skillRun/types';
import { useModalDialog } from '@/lib/ui/useModalDialog';

import { EditComposer } from './EditComposer';
import { EditsPane } from './EditsPane';
import { REVIEW_COPY, statusLine } from './reviewCopy';
import { ReviewDocument } from './ReviewDocument';
import type { RunRevisions } from './useRunRevisions';
import { VersionBar } from './VersionBar';

type Props = {
  runsPath: string;
  run: SkillRunSummary;
  versions: OutputVersion[];
  review: RunRevisions;
  onClose: () => void;
};

function passageMarks(
  text: string | null,
  viewing: OutputVersion,
  pending: PendingEdit[],
  applyingKeys: string[] | null,
) {
  const marks = new Map<number, string>();
  const labels = new Map<number, string>();
  if (text === null) return { marks, labels };
  const blocks = blockRanges(text);

  for (const edit of viewing.revision?.edits ?? []) {
    if (edit.status !== 'applied' || edit.resultStart === null || edit.resultEnd === null) continue;
    for (const block of blocksWithin(blocks, { start: edit.resultStart, end: edit.resultEnd })) {
      marks.set(block.start, edit.kind);
    }
  }

  pending
    .filter((edit) => !edit.detached)
    .forEach((edit, index) => {
      const covered = blocksWithin(blocks, edit);
      for (const block of covered) {
        marks.set(block.start, applyingKeys?.includes(edit.key) ? 'applying' : 'pending');
      }
      if (covered[0]) labels.set(covered[0].start, String(index + 1));
    });
  return { marks, labels };
}

export function ReviewOutputDialog({ runsPath, run, versions, review, onClose }: Props) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [pinnedId, setPinnedId] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<Range | null>(null);
  const [fetched, setFetched] = React.useState<Record<string, string | null>>({});

  const head = versions[versions.length - 1];
  const viewing = versions.find((version) => version.id === pinnedId) ?? head;
  const atHead = viewing.id === head.id;
  const applying = review.status.kind === 'applying' ? review.status.keys : null;
  const locked = applying !== null;
  const needsFetch = !atHead && viewing.id !== run.id;
  const text = atHead
    ? run.headText
    : viewing.id === run.id
      ? run.resultText
      : (fetched[viewing.id] ?? null);

  useModalDialog(panelRef, () => (selection ? setSelection(null) : onClose()), {
    initialFocus: panelRef,
  });

  React.useEffect(() => {
    if (!needsFetch || viewing.id in fetched) return;
    let live = true;
    void fetchVersionText(runsPath, run.id, viewing.id).then((value) => {
      if (live) setFetched((prior) => ({ ...prior, [viewing.id]: value }));
    });
    return () => {
      live = false;
    };
  }, [needsFetch, viewing.id, fetched, runsPath, run.id]);

  const { marks, labels } = passageMarks(text, viewing, atHead ? review.pending : [], applying);

  const editing =
    selection === null
      ? null
      : (review.pending.find(
          (edit) => !edit.detached && edit.start === selection.start && edit.end === selection.end,
        ) ?? null);
  const sendable = review.pending.filter((edit) => !edit.detached).length;
  const status = statusLine(review.status);

  function handleSelect(range: Range) {
    const hit = review.pending.find(
      (edit) => !edit.detached && edit.start < range.end && edit.end > range.start,
    );
    setSelection(hit ? { start: hit.start, end: hit.end } : range);
  }

  function handleView(id: string) {
    setSelection(null);
    setPinnedId(id === head.id ? null : id);
  }

  function handleRestore() {
    const id = viewing.id;
    setPinnedId(null);
    void review.restore(id);
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[color-mix(in_srgb,var(--ink)_55%,transparent)] p-[var(--space-4)]"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={REVIEW_COPY.title}
        onClick={(event) => event.stopPropagation()}
        className="flex h-[min(860px,92vh)] w-full max-w-[1180px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] shadow-[var(--shadow-ambient)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
          <h2 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
            {REVIEW_COPY.title}
          </h2>
          {status ? (
            <p
              role={review.status.kind === 'error' ? 'alert' : 'status'}
              className={`max-w-[60ch] text-[length:var(--text-sm)] ${
                review.status.kind === 'error'
                  ? 'text-[var(--negative-deep)]'
                  : 'text-[var(--ink-secondary)]'
              }`}
            >
              {status}
            </p>
          ) : null}
        </div>

        <VersionBar
          versions={versions}
          viewing={viewing}
          busy={locked}
          onView={handleView}
          onRestore={handleRestore}
        />

        <div className="flex min-h-0 flex-1 flex-col min-[860px]:grid min-[860px]:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-5)] py-[var(--space-4)]">
            {text === null ? (
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                {viewing.id in fetched
                  ? REVIEW_COPY.versionUnavailable
                  : REVIEW_COPY.loadingVersion}
              </p>
            ) : (
              <ReviewDocument
                text={text}
                readOnly={!atHead || locked}
                marks={marks}
                labels={labels}
                selection={selection}
                onSelect={handleSelect}
              >
                {selection ? (
                  <EditComposer
                    key={`${String(selection.start)}-${String(selection.end)}`}
                    passage={text.slice(selection.start, selection.end)}
                    existing={
                      editing
                        ? { kind: editing.kind, value: editing.value, problem: editing.problem }
                        : null
                    }
                    onSave={(kind, value) => {
                      review.save({
                        key: editing?.key,
                        kind,
                        start: selection.start,
                        end: selection.end,
                        passage: text.slice(selection.start, selection.end),
                        value,
                      });
                      setSelection(null);
                    }}
                    onCancel={() => setSelection(null)}
                    onRemove={
                      editing
                        ? () => {
                            review.remove(editing.key);
                            setSelection(null);
                          }
                        : null
                    }
                  />
                ) : null}
              </ReviewDocument>
            )}
          </div>

          <aside className="min-h-0 overflow-y-auto border-t border-[var(--stroke)] bg-[var(--surface-warm)] px-[var(--space-4)] py-[var(--space-4)] min-[860px]:border-l min-[860px]:border-t-0">
            <EditsPane
              atHead={atHead}
              locked={locked}
              pending={review.pending}
              onOpen={(edit) => setSelection({ start: edit.start, end: edit.end })}
              onRemove={review.remove}
              viewing={viewing}
              versions={versions}
            />
          </aside>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
          <Button
            variant="ghost"
            disabled={review.pending.length === 0 || locked}
            onClick={() => {
              setSelection(null);
              review.discard();
            }}
          >
            {REVIEW_COPY.discard}
          </Button>
          <div className="flex items-center gap-[var(--space-3)]">
            <Button variant="secondary" onClick={onClose}>
              {REVIEW_COPY.close}
            </Button>
            <Button
              variant="primary"
              disabled={!atHead || locked || sendable === 0}
              onClick={() => {
                setSelection(null);
                void review.apply();
              }}
            >
              {sendable === 0 ? REVIEW_COPY.applyNone : `Apply ${plural(sendable, 'edit')}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Create `RunOutput.tsx`**

```tsx
'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import { outputVersions, plural, versionLabel } from '@/lib/skillRun/revisionView';
import type { SkillRunSummary } from '@/lib/skillRun/types';

import { REVIEW_COPY, statusLine } from './reviewCopy';
import { ReviewOutputDialog } from './ReviewOutputDialog';
import { useRunRevisions } from './useRunRevisions';

type Props = {
  runsPath: string;
  run: SkillRunSummary;
  documents: SkillRunSummary['documents'];
  reload: () => Promise<SkillRunSummary[]>;
  pollMs?: number;
};

export function RunOutput({ runsPath, run, documents, reload, pollMs }: Props) {
  const review = useRunRevisions({ runsPath, run, reload, pollMs });
  const [open, setOpen] = React.useState(false);

  const versions = outputVersions(run);
  const head = versions[versions.length - 1];
  if (!head || run.headText === null) return null;

  const status = open ? null : statusLine(review.status);
  const waiting = review.pending.length;

  return (
    <div className="space-y-[var(--space-2)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
        <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {versionLabel(versions, head.id)} · {head.actorName} ·{' '}
          {new Date(head.createdAt).toLocaleString()}
          {waiting > 0 ? ` · ${plural(waiting, 'pending edit')}` : ''}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
        >
          {REVIEW_COPY.open}
        </button>
      </div>

      {status ? (
        <p
          role={review.status.kind === 'error' ? 'alert' : 'status'}
          className={`text-[length:var(--text-sm)] ${
            review.status.kind === 'error'
              ? 'text-[var(--negative-deep)]'
              : 'text-[var(--ink-secondary)]'
          }`}
        >
          {status}
        </p>
      ) : null}

      <Markdown className="max-h-72 overflow-auto rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
        {run.headText}
      </Markdown>

      {documents.length > 0 ? (
        <ul
          aria-label="Documents this run filed"
          className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
        >
          {documents.map((document) => (
            <li key={document.id}>{document.name}</li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <ReviewOutputDialog
          runsPath={runsPath}
          run={run}
          versions={versions}
          review={review}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 10: Run the tests**

```bash
npx vitest run tests/review-output.test.tsx
npx tsc --noEmit
npm run lint
```

Expected: PASS, 13 tests. Read the failure before changing a test: each test states behaviour the spec asks for, so a failure is a component to fix.

- [ ] **Step 11: Check the view against the register**

Read `docs/design/workbench/HANDOVER.md` and `components-map.md`, then compare each component with the mockup. Confirm: no colour outside the tokens; violet only on the mark and the dot of an AI rewrite; one primary button in the footer; sentence case; no em dash in `reviewCopy.ts`. Fix what differs.

- [ ] **Step 12: Commit**

```bash
git add src/components/rail/review tests/review-output.test.tsx
git commit -m "feat(rail): a full-size view to review, comment on and edit a run's output

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 16: Offer the review from the step

**Files:**
- Modify: `src/components/rail/SkillStepRunner.tsx`
- Modify: `tests/skill-step-runner.test.tsx`

**Interfaces:**
- Consumes: `RunOutput` (Task 15); `normalizeRun` (Task 14); `useFlag` and the flag key (Task 8).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

In `tests/skill-step-runner.test.tsx`, add imports:

```tsx
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
```

Add a helper beside `runRow`:

```tsx
function flagsWith(...enabled: FlagKey[]): FlagMap {
  return Object.fromEntries(
    Object.keys(FLAG_REGISTRY).map((key) => [key, enabled.includes(key as FlagKey)]),
  ) as FlagMap;
}
```

Add four tests inside the existing `describe`, which already stubs `fetch` before each test. Render the runner the way the neighbouring tests do; only the wrapper differs:

```tsx
  it('keeps the output read-only while skill_output_revisions is off', async () => {
    state.runs = [runRow()];

    render(<SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />);

    expect(await screen.findByText('newer result')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review output' })).not.toBeInTheDocument();
  });

  it('offers Review output on a recorded, succeeded run when the flag is on', async () => {
    state.runs = [runRow()];

    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Review output' })).toBeInTheDocument();
    expect(screen.getByText(/Version 1 of 1 · Storm Duncan/)).toBeInTheDocument();
  });

  it('shows the latest version of a revised output, not the first', async () => {
    state.runs = [
      runRow({
        headId: 'rev-2',
        headText: 'the revised result',
        revisions: [
          {
            id: 'rev-2',
            parentId: 'run-2',
            kind: 'edits',
            outcome: 'succeeded',
            errorMessage: null,
            actorName: 'Lance Park',
            createdAt: '2026-09-14T12:00:00.000Z',
            version: 2,
            edits: [],
            restoredFrom: null,
            skillMounted: true,
          },
        ],
      }),
    ];

    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );

    expect(await screen.findByText('the revised result')).toBeInTheDocument();
    expect(screen.queryByText('newer result')).not.toBeInTheDocument();
    expect(screen.getByText(/Version 2 of 2 · Lance Park/)).toBeInTheDocument();
  });

  it('does not offer it on a failed run or a removed step', async () => {
    state.runs = [runRow({ outcome: 'failed', resultText: null, errorMessage: 'It failed.' })];
    const first = render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );
    await screen.findByRole('list', { name: 'Run history' });
    expect(screen.queryByRole('button', { name: 'Review output' })).not.toBeInTheDocument();
    first.unmount();

    state.runs = [runRow()];
    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner
          projectId="ATLAS-2026-001"
          step={{ ...STEP, removedAt: '2026-09-14T09:00:00.000Z', removedBy: 'user-1' }}
        />
      </FlagsProvider>,
    );
    expect(await screen.findByText('newer result')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review output' })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/skill-step-runner.test.tsx`
Expected: the three flag-on tests FAIL (no `Review output` button, and the first output is shown). The flag-off test passes already.

- [ ] **Step 3: Wire `RunOutput` into `SkillStepRunner.tsx`**

Add imports:

```tsx
import { useFlag } from '@/lib/flags/FlagsContext';
import { normalizeRun } from '@/lib/skillRun/revisionView';
import { RunOutput } from './review/RunOutput';
```

In the component, beside the other state:

```tsx
  const revisionsOn = useFlag('skill_output_revisions');
```

Make `loadRuns` normalise what it reads, so a list from an older server still works:

```tsx
  const loadRuns = React.useCallback(async (): Promise<SkillRunSummary[]> => {
    const response = await fetch(path, { credentials: 'include' });
    if (!response.ok) return [];
    const body = (await response.json()) as { runs?: SkillRunSummary[] };
    return (body.runs ?? []).map(normalizeRun);
  }, [path]);
```

Add a reload that keeps the selected run, under `handleVersionsLoaded`:

```tsx
  const reloadRuns = React.useCallback(async (): Promise<SkillRunSummary[]> => {
    const loaded = await loadRuns().catch(() => []);
    setRuns(loaded);
    return loaded;
  }, [loadRuns]);
```

Show the head, and work out whether the selected run can be reviewed. Replace the `shownText` line and add the one after it:

```tsx
  const shownText = streamed !== null ? streamed : (selected?.headText ?? null);
  const reviewed =
    revisionsOn && streamed === null && selected?.outcome === 'succeeded' && selected.headText !== null
      ? selected
      : null;
```

In the last `return` only (the one that renders the inputs and `Draft this step`), replace `{shownText ? <RunResult text={shownText} documents={shownDocuments} /> : null}` with:

```tsx
      {reviewed ? (
        <RunOutput
          key={reviewed.id}
          runsPath={path}
          run={reviewed}
          documents={shownDocuments}
          reload={reloadRuns}
        />
      ) : shownText ? (
        <RunResult text={shownText} documents={shownDocuments} />
      ) : null}
```

The earlier `return`, for a removed step or a step with no skill, keeps `RunResult`: its output stays read-only.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/skill-step-runner.test.tsx tests/skill-step-runner-versions.test.tsx tests/rail
npx tsc --noEmit
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/SkillStepRunner.tsx tests/skill-step-runner.test.tsx
git commit -m "feat(rail): open the output review from a skill step

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

# Part E: Close-out

### Task 17: Record the language, the decision and the API

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/07-decisions/decision-log.md`
- Modify: `docs/03-engineering/api-v1.md`
- Modify: `docs/04-operations/agent-seam-edge-and-rollout.md`
- Modify: `docs/superpowers/specs/2026-10-13-skill-output-revisions-design.md` (status line only)

**Interfaces:**
- Consumes: everything built.
- Produces: nothing for later tasks.

- [ ] **Step 1: Add the terms to `CONTEXT.md`**

Append after **Catalog fork**, in the file's existing form:

```markdown

**Revision**:
A version of a skill run's output that came from applying edits to an earlier version, or from restoring one. The run's first output is not a revision.

**Head**:
The latest successful revision of a skill run, or the run's first output when it has none. The head is what the step shows.

**Passage**:
The whole Markdown blocks an edit covers, as one contiguous range of the output's source text.

**Edit**:
One change a banker asks for on one passage. A comment edit carries the banker's sentence and the AI writes the replacement. A hand edit carries the banker's own replacement text.

**Unresolved**:
A comment edit the AI declined to apply, with its reason.
```

- [ ] **Step 2: Add one row to the decision log**

Find the next free number: `git fetch origin && git show origin/develop:docs/07-decisions/decision-log.md | tail -3`. Add a row at the end of the table with that number, in the table's existing column order (number, date, decision, source):

```markdown
| D<next> | 2026-10-13 | **A banker revises a skill run's output by passage, and every revision is kept** (Accepted; slice 1 of three, flag `skill_output_revisions`). A banker comments on a passage or edits it by hand, the edits are applied together, and the result is a new immutable revision. Only the commented passages can change: the engine returns replacement text by edit id and Conductia splices it at offsets it validated itself. The engine may look things up and may never write: the bench offers no write tool and the token carries no write scope. A revision is a row in `deal_step_skill_runs` (`source = 'revision'`), chosen because it adds no bank-content store under ADR-0017 decision 7; the two new columns hold ids only. A failed attempt and an unresolved comment are recorded with their reason. Not in this slice: a comment that holds on later runs, and folding lessons into the skill (#463). | Oct 12 team call; design discussion with Charles on 2026-10-13; [the spec](../superpowers/specs/2026-10-13-skill-output-revisions-design.md); migration `20261013100000_skill_output_revisions.sql`. |
```

- [ ] **Step 3: Add a section at the end of `docs/03-engineering/api-v1.md`**

```markdown
## Skill output revisions (flag `skill_output_revisions`, OFF)

A recorded, succeeded skill run's output can be revised by passage. Every route below also needs `skill_authoring`, an internal user with access to the deal, and, to write, `canEditWork` on a step that is not removed. With the flag off they answer 404.

A passage is one or more whole Markdown blocks (a heading, a paragraph, a list item, a table row, a block quote, a code block), addressed by `start` and `end` offsets into the text of the version being edited. Offsets are UTF-16 code units, which is what a JavaScript string index is.

### `POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/{runId}/revisions`

`runId` is the run whose output is revised. `parentId` is the version the caller was looking at, and must be the head.

- Edits: `{ parentId, edits: [{ kind: 'comment', start, end, comment } | { kind: 'hand', start, end, text }] }`. At most 20 edits, 2,000 characters per comment, and a result of at most 200,000 characters. An empty `text` removes the passage.
- Restore: `{ parentId, restoreOf }`, where `restoreOf` is an earlier version of the same run.

| Status | Meaning |
|---|---|
| 201 `{ revisionId }` | Hand edits only, or a restore. The revision is written. |
| 202 `{ revisionId }` | At least one comment. The work continues after the response. A row with this id, succeeded or failed, appears in the run list when it ends. |
| 409 | `parentId` is no longer the head, the run failed, or the step was removed. |
| 422 | An edit is out of bounds, cuts into a block or overlaps another; the result would be empty or too long; or `restoreOf` is already the head. |
| 503 | The skill service is not configured. Nothing was recorded. |

### `GET /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/{runId}/revisions/{revisionId}`

Returns `{ id, text }` for one version: the run itself, or a successful revision of it. A failed attempt is not a version and answers 404.

### The run list

`GET /api/v1/deals/{dealId}/steps/{stepId}/skill-runs` never lists a revision as a run. Each run carries `headId`, `headText` and `revisions`: every revision and failed attempt, oldest first, with its `version` number (null for a failed attempt), who made it, and its edits. Each edit carries its status, its reason when it was not applied, and `before`, the passage as it was. `resultText` is still the run's first output.

### What is recorded

A revision is a row in `deal_step_skill_runs` with `source = 'revision'`, `parent_run_id` and `root_run_id`. Rows are never updated or deleted. At most one successful revision can stand on a parent, so two people applying to the same head cannot both win; the loser's attempt is recorded as failed. A comment's engine call is on the AI spend ledger as `source: skill_revision`, with `external_id` the revision id. The audit log gets one `create` row with `detail.kind: 'skill_run_revision'` when a comment batch starts (`phase: 'started'`) and one when any revision or failed attempt is written (`phase: 'recorded'`). Both carry ids, counts and SHA-256 digests, and never a comment or output text.
```

- [ ] **Step 4: Add the agent to the seam runbook**

In `docs/04-operations/agent-seam-edge-and-rollout.md`, add one row to the table that lists `skill-step-run`, directly under that row:

```markdown
| Skill output revision | a recorded skill run on a deal rail station, then **Review output**, add a comment, **Apply** (flag `skill_output_revisions`) | `skill-run-revision` |
```

- [ ] **Step 5: Mark the spec as implemented by this plan**

In the spec, change the status line to:

```markdown
**Status:** Approved 2026-10-13. Implemented by `docs/superpowers/plans/2026-10-13-skill-output-revisions.md`, which lists where it departs from this document.
```

- [ ] **Step 6: Confirm ADR-0017's processor table needs no row**

Read decision 6 of `docs/07-decisions/ADR-0017-hybrid-data-residency.md`. The agents-backend row names `src/lib/ignatious/` as the path that sends bank content to that processor. The revision call leaves through `src/lib/ignatious/bench.ts`, so the row already covers it. If a test that fences those paths fails in Task 18, stop and report it to Charles instead of widening the fence.

- [ ] **Step 7: Commit**

```bash
git add CONTEXT.md docs/07-decisions/decision-log.md docs/03-engineering/api-v1.md \
        docs/04-operations/agent-seam-edge-and-rollout.md \
        docs/superpowers/specs/2026-10-13-skill-output-revisions-design.md
git commit -m "docs: record skill output revisions in the language, the decision log and the API notes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 18: The hermetic journey and the full local checks

**Files:**
- Modify: `e2e/support/railDealFixture.ts`
- Create: `e2e/journeys/skill-output-revisions.spec.ts`

**Interfaces:**
- Consumes: the whole feature.
- Produces: `insertSucceededRun(dealId: string, opts: { stepId: string; actorId: string; binding: { skillId: string; versionId: string; digest: string }; resultText: string }): Promise<string>` and `readRevisionRows(dealId: string)` in the fixture.

The hermetic tier has no skill bench, so this journey proves what Conductia owns without the engine: a hand edit changes only its passage, a restore brings the first output back as a new version, every version is kept, and a comment batch is refused without recording anything. The e2e stack turns every flag on (`scripts/enable-flags.ts`), so the new flag needs no setup.

- [ ] **Step 1: Add the fixture helpers**

Add `import { randomUUID } from 'node:crypto';` at the top of `e2e/support/railDealFixture.ts`, then append:

```ts
export async function insertSucceededRun(
  dealId: string,
  opts: {
    stepId: string;
    actorId: string;
    binding: { skillId: string; versionId: string; digest: string };
    resultText: string;
  },
): Promise<string> {
  const admin = localAdmin('write a succeeded skill run');
  const step = await admin
    .from(TABLE.DEAL_STEPS)
    .select('id')
    .eq('deal_id', dealId)
    .eq('step_id', opts.stepId)
    .single();
  if (step.error || !step.data) throw new Error(`could not find the step: ${step.error?.message}`);

  const runId = randomUUID();
  const { error } = await admin.from(TABLE.DEAL_STEP_SKILL_RUNS).insert({
    id: runId,
    deal_id: dealId,
    deal_step_id: step.data.id,
    actor_id: opts.actorId,
    skill_id: opts.binding.skillId,
    version_id: opts.binding.versionId,
    digest: opts.binding.digest,
    input: 'Summarise the week',
    outcome: 'succeeded',
    result_text: opts.resultText,
    source: 'execution',
  });
  if (error) throw new Error(`could not insert the run: ${error.message}`);
  return runId;
}

export async function readRevisionRows(
  dealId: string,
): Promise<{ id: string; outcome: string; result_text: string | null; parent_run_id: string; inputs: Record<string, unknown> }[]> {
  const admin = localAdmin('read the revision rows');
  const { data, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select('id, outcome, result_text, parent_run_id, inputs, created_at')
    .eq('deal_id', dealId)
    .eq('source', 'revision')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`could not read revisions: ${error.message}`);
  return (data ?? []) as {
    id: string;
    outcome: string;
    result_text: string | null;
    parent_run_id: string;
    inputs: Record<string, unknown>;
  }[];
}
```

- [ ] **Step 2: Write the journey**

Create `e2e/journeys/skill-output-revisions.spec.ts`:

```ts
import { test, expect } from '../support/fixtures';
import {
  createRailDeal,
  insertSkillStep,
  insertSucceededRun,
  readRevisionRows,
} from '../support/railDealFixture';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const FIRST_OUTPUT = [
  '# Weekly update',
  '',
  'Revenue fell in the quarter.',
  '',
  '- Two buyers asked for the data room.',
  '- The board meets on Friday.',
].join('\n');

const EDITED_OUTPUT = FIRST_OUTPUT.replace(
  'Revenue fell in the quarter.',
  'Revenue rose 12% in the quarter.',
);

function railUrl(dealCode: string): string {
  return `/projects/${encodeURIComponent(dealCode)}/rail?view=focus`;
}

async function openTheSkillStep(page: import('@playwright/test').Page, title: string) {
  const focus = page.getByRole('region', { name: 'Deal rail · focus' });
  await expect(focus).toBeVisible();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await focus.getByRole('heading', { name: title }).count()) break;
    const previous = focus.getByRole('button', { name: /Previous station/ });
    if ((await previous.count()) === 0) break;
    await previous.click();
  }
  await expect(focus.getByRole('heading', { name: title })).toBeVisible();
  return focus;
}

test.describe('skill output revisions', () => {
  test('an MD edits a passage by hand, restores the first output, and keeps every version', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Weekly update ${runId}`;
    const stepId = `custom:${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId,
      title,
      description: 'Prepare a concise update for the board.',
      helperText: 'What to emphasise.',
      binding: BINDING,
      phaseIndex: 1,
      displayOrder: 0,
    });
    const me = await evidence.request.get('/api/v1/me');
    const actorId = ((await me.json()) as { user: { id: string } }).user.id;
    const rootId = await insertSucceededRun(deal.id, {
      stepId,
      actorId,
      binding: BINDING,
      resultText: FIRST_OUTPUT,
    });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    const runner = focus.getByRole('region', { name: 'Skill run' });
    await expect(runner.getByText(/Version 1 of 1/)).toBeVisible();

    await runner.getByRole('button', { name: 'Review output' }).click();
    const review = page.getByRole('dialog', { name: 'Review output' });
    await review.getByText('Revenue fell in the quarter.').click();
    await review.getByRole('button', { name: 'Edit text' }).click();
    await review.getByLabel('Passage text, in Markdown').fill('Revenue rose 12% in the quarter.');
    await review.getByRole('button', { name: 'Save edit' }).click();
    await review.getByRole('button', { name: 'Apply 1 edit' }).click();

    await expect(review.getByText('1 edit applied. Version 2 is recorded.')).toBeVisible();
    await expect(review.getByText('Version 2 of 2')).toBeVisible();
    await expect(review.getByText('Revenue rose 12% in the quarter.')).toBeVisible();
    await expect(review.getByText('Two buyers asked for the data room.')).toBeVisible();

    await review.getByRole('button', { name: 'Earlier version' }).click();
    await expect(review.getByText('This is an earlier version. It is read-only.')).toBeVisible();
    await review.getByRole('button', { name: 'Restore this version' }).click();
    await expect(review.getByText('Version 1 restored. Version 3 is recorded.')).toBeVisible();
    await expect(review.getByText('Version 3 of 3')).toBeVisible();

    await review.getByRole('button', { name: 'Close' }).click();
    await expect(runner.getByText(/Version 3 of 3/)).toBeVisible();
    await expect(runner.getByText('Revenue fell in the quarter.')).toBeVisible();

    const rows = await readRevisionRows(deal.id);
    expect(rows.map((row) => [row.outcome, row.result_text])).toEqual([
      ['succeeded', EDITED_OUTPUT],
      ['succeeded', FIRST_OUTPUT],
    ]);
    expect(rows[0]?.parent_run_id).toBe(rootId);
    expect(rows[1]?.parent_run_id).toBe(rows[0]?.id);
    expect(rows[1]?.inputs).toEqual({ kind: 'restore', restoredFrom: rootId });

    const history = runner.getByRole('list', { name: 'Run history' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
  });

  test('a comment is refused, and nothing is recorded, while no skill service is configured', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Board readout ${runId}`;
    const stepId = `custom:${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId,
      title,
      description: 'Draft the readout.',
      helperText: 'What to emphasise.',
      binding: BINDING,
      phaseIndex: 1,
      displayOrder: 0,
    });
    const me = await evidence.request.get('/api/v1/me');
    const actorId = ((await me.json()) as { user: { id: string } }).user.id;
    await insertSucceededRun(deal.id, { stepId, actorId, binding: BINDING, resultText: FIRST_OUTPUT });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    await focus.getByRole('button', { name: 'Review output' }).click();
    const review = page.getByRole('dialog', { name: 'Review output' });
    await review.getByText('The board meets on Friday.').click();
    await review.getByLabel('What should change in this passage').fill('Say which Friday.');
    await review.getByRole('button', { name: 'Add comment' }).click();
    await review.getByRole('button', { name: 'Apply 1 edit' }).click();

    await expect(review.getByRole('alert')).toBeVisible();
    await expect(review.getByRole('list', { name: 'Pending' })).toContainText('Say which Friday.');
    expect(await readRevisionRows(deal.id)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the journey and the journeys the change can reach**

Bring up the hermetic tier as `docs/03-engineering/e2e-testing.md` describes (local Supabase stack, `supabase db reset --local`, the seeds and `npm run seed:flags:enable`, all against `127.0.0.1`), then:

```bash
grep -rln "Skill run\|Run history\|Draft this step" e2e/journeys
npx playwright test --project=hermetic e2e/journeys/skill-output-revisions.spec.ts \
  e2e/journeys/skill-run.spec.ts e2e/journeys/skill-enhancement.spec.ts
```

Expected: PASS. Run every journey the `grep` names, because the step's output box now carries a version label and a new button wherever a succeeded run is shown.

- [ ] **Step 4: Reproduce the CI jobs locally**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run check:migrations
supabase db reset --local
eval "$(supabase status -o env)"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" npm run test:integration
npm run build
```

Expected: all green. Then confirm the schema snapshot is still current by repeating Step 6 of Task 8 and checking `git status --porcelain supabase/schema-snapshot.txt` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add e2e/support/railDealFixture.ts e2e/journeys/skill-output-revisions.spec.ts
git commit -m "test(e2e): a hand edit, a restore and a refused comment on a run's output

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 19: Walk the comment path in a real browser, then stop

**Files:** none, unless the walk finds a defect.

**Interfaces:**
- Consumes: the Ignatious branch from Task 5 and the whole Conductia branch.
- Produces: evidence for the pull request, and a branch that is ready to push.

This is the only place the comment path runs end to end with a real model. It uses a local Supabase stack, the local bench, and seeded credentials. Never a hosted project.

- [ ] **Step 1: Start the local bench from the Ignatious worktree**

```bash
cd /Users/cwillian/Documents/personal/learning/ignatious-skill-run-revisions/platform
pnpm --filter @ignatious/skill-bench dev
```

It reads `platform/.env`. It needs a model key and `MODEL_CALLS=live`, and its `CONDUCTIA_ALLOWED_BASE_URLS` must include the local Conductia origin. Model spend here is real: keep the walk to the steps below.

- [ ] **Step 2: Start Conductia against the local stack and the local bench**

Use a local Supabase stack with `npm run seed` and `npm run seed:flags:enable` run against it, as `docs/03-engineering/e2e-testing.md` describes. In `.env.local` point `IGNATIOUS_SKILL_BENCH_URL` at the local bench, set `IGNATIOUS_API_KEY` to the bench's inbound key, and set `CONDUCTIA_PUBLIC_URL` to the local origin. Confirm `NEXT_PUBLIC_SUPABASE_URL` is `127.0.0.1` or `localhost` before starting `npm run dev`.

- [ ] **Step 3: Walk it**

Sign in through the API with a seeded MD (the repository's e2e auth convention, skipping two-factor). On a deal with a skill-backed step:

1. Run the step with `Draft this step` and wait for the output.
2. `Review output`. Comment on two passages: one that needs no lookup ("make this one sentence"), one that does ("use the figure from the latest uploaded financials"). Edit a third passage by hand.
3. `Apply 3 edits`. Confirm the view says it is applying, and that closing and reopening it keeps that state.
4. When it lands, confirm the confirmation sentence, the three marks (two violet, one ink), and `Show before` on each.
5. Compare version 1 and version 2 outside the three passages: copy both from the database and diff them. The diff must touch only the three passages.
6. Ask for something the model cannot source ("state the exact EBITDA for FY27"). Confirm it comes back `Not applied` with a reason and stays in `Pending`.
7. Restore version 1 and confirm four versions are listed.
8. Mark a table row and a nested list item, and check their marks render.
9. Narrow the window below 860 pixels and confirm the edits pane stacks under the document.
10. In the database, confirm: the revision rows; `ai_usage` rows with `source = 'skill_revision'`; `audit_log` rows with `detail.kind = 'skill_run_revision'` that hold no comment text; and no document filed by any revision turn.

Record the walk the way the repository records a browser check, with captions.

- [ ] **Step 4: Fix what the walk finds**

A defect found here gets a failing test in the task that owns the code, then the fix, then a commit. Re-run Step 4 of Task 18 afterwards.

- [ ] **Step 5: Stop and report**

Report to Charles: what was built, the test counts, the walk recording, each departure from the spec listed at the top of this plan, and anything the walk changed. Do not push and do not open a pull request until he says so. When he does:

- Ignatious first: push `feat/skill-run-revisions`, open its pull request, and let it deploy.
- Conductia: `git fetch origin && git rebase origin/develop`, re-run the tests the change touches, `git push --force-with-lease`, then open the pull request against `develop`. Its description says what the feature does and how it was verified; it carries no rollout sequence.
- Add the link to the spec in issue #463, where it says the spec will be linked once written.

---

## Self-review

Run against the spec after writing.

**Spec coverage.**

| Spec section | Task |
|---|---|
| Passages, `blocks` | 6, 13 |
| Persistence: columns, `source`, constraints, index | 8 |
| `inputs` record on a revision row | 7 (types), 11, 12 |
| Browser API: `POST` edits, `POST` restore, list, one version | 10, 11, 12 |
| Applying a batch with comment edits | 12 |
| Ignatious API, tool policy, `submit_replacements`, frames | 1 to 4 |
| The step surface and the review view | 13 to 16 |
| Authorization | 10 (`requireRevisionAccess`), tests in 10 and 11 |
| Audit, two moments | 11, 12 |
| Failure handling, each case | 11 (head moved), 12 (engine, nothing applied, missing id, audit, skill unmounted) |
| Token with no write scope, refused at the seam | 9 |
| Ledger source `skill_revision` | 8, 12 |
| Flag `skill_output_revisions` | 8, 10, 16 |
| `CONTEXT.md`, decision log, API notes | 17 |
| Verification | each task's tests, 18, 19 |

**Not covered, on purpose.** The OpenAPI document (departure 2). The spec's "pending edits re-attached after a head move" is implemented by `reattach` (Task 14) and by the 409 path of the hook.

**Type consistency.** `RevisionTarget`, `RootRun`, `EditRequest`, `EditRecord`, `RevisionInputs`, `RevisionSummary`, `PendingEdit` and `OutputVersion` are each defined once and used under that name in every later task. The bench body Conductia sends in Task 9 has the fields the Ignatious schema in Task 4 accepts, and no others.
