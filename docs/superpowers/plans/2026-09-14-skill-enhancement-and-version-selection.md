# Skill enhancement and version selection: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a managing director improve the skill behind a rail step through the shipped builder chat, and let any step run a chosen skill version rather than only the one it was created with.

**Architecture:** One re-pointable binding per step, resolved by one function through three layers (a binding row, then a custom step's `definition.skillBinding`, then a catalog step's tag-matched mount skill). A binding names either an immutable project publication or a firm-catalog mount version, both carrying a digest. Enhancement reuses the existing authoring draft, turn and publication pipeline, adding a *basis* (the ancestor version, the target step, an optional seed run) and swapping the pipeline's terminal action from inserting a step to rebinding one.

**Tech Stack:** Conductia is Next.js 16 App Router, TypeScript, Supabase Postgres migrations, Vitest with React Testing Library, Playwright. Ignatious skill-bench is TypeScript on Hono with Zod, Vitest, and Postgres migrations under `platform/apps/skill-bench/src/authoring/postgres/migrations/`.

**Spec:** `docs/superpowers/specs/2026-09-14-skill-enhancement-and-version-selection-design.md`

## Global Constraints

- **Branching.** Both repositories stack on the Part D branches. Create `skill-enhancement-and-version-selection` from `skill-run-execution` in `~/orca/workspaces/conductia/skill-run-execution` and in `~/orca/workspaces/ignatious/skill-run-execution`. Never commit to `main`, `master` or `develop`.
- **Never point anything at a hosted Supabase project.** Migrations, seeds, dev servers and sign-ins run against the local stack only. Read the configured URL before running anything that talks to a database and confirm it is localhost. This constraint must be restated verbatim in every subagent prompt.
- **No code comments in the Conductia repository.** This covers explanatory "why" comments and JSDoc block prose. SQL migration header comments follow the existing migration files. Ignatious keeps its existing heavily-documented house style.
- **No em dash characters** in documents, code or visible copy.
- **Stage explicit file paths.** Never `git add -A` or `git add .`.
- **Ignatious ships first.** Every Ignatious change in this plan is additive and backward compatible, so tasks I1 to I7 may deploy before any Conductia consumer exists.
- **Feature flag.** Every new Conductia surface sits behind the existing `skill_authoring` flag, checked with `requireFlag("skill_authoring")`.
- **Permission gate.** Enhancing, selecting a version and rebinding all use the gate the Part D stream route already enforces: `requireFlag`, then `requireApiUser`, then `classifyInternalUser(...) === 'internal'`, then `resolveDealStepCapabilities(...).canEditWork`.
- **Test commands.** Conductia: `npm test -- <path>` (Vitest), `npm run test:integration`, `npm run test:e2e`. Ignatious skill-bench: `npm test -- <path>` from `platform/apps/skill-bench`, and `npm run typecheck`.
- **The skill reference union** is the same shape in both repositories and in the database:
  `{ kind: "publication", skillId: string, versionId: string, digest: string }`
  or `{ kind: "mount", name: string, version: number, digest: string }`.
  `digest` is always 64 lowercase hex characters.

---

# Part 1: Ignatious

Working directory for every task in this part: `~/orca/workspaces/ignatious/skill-run-execution/platform/apps/skill-bench`.

### Task I1: Many published versions per skill identity

**Files:**
- Create: `src/authoring/postgres/migrations/003_skill_version_lineage.sql`
- Modify: `src/authoring/publication/store.ts`, `src/authoring/publication/postgres-publication-store.ts`
- Test: `src/authoring/publication/postgres-store.integration.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PublicationStore.readPublicationLineage(skillId: string, projectId: string): Promise<readonly LineageEntry[]>` where `LineageEntry = { versionId: string; digest: string; publishedAt: string }`, newest first. Task C4 consumes it through a new bench client method.

- [ ] **Step 1: Write the failing test**

Append to `src/authoring/publication/postgres-store.integration.test.ts`:

```ts
it('admits a second version on one skill identity and lists the lineage newest first', async () => {
  const store = await freshStore();
  const skillId = randomUUID();
  const projectId = randomUUID();
  const first = await seedPublication(store, { skillId, projectId, digest: 'a'.repeat(64) });
  const second = await seedPublication(store, { skillId, projectId, digest: 'b'.repeat(64) });

  const lineage = await store.readPublicationLineage(skillId, projectId);

  expect(lineage.map(entry => entry.versionId)).toEqual([second.versionId, first.versionId]);
  expect(lineage[0]?.digest).toBe('b'.repeat(64));
});

it('keeps version ids unique across the lineage', async () => {
  const store = await freshStore();
  const skillId = randomUUID();
  const versionId = randomUUID();
  await seedPublication(store, { skillId, versionId, digest: 'a'.repeat(64) });
  await expect(seedPublication(store, { skillId, versionId, digest: 'b'.repeat(64) })).rejects.toThrow();
});
```

Use the file's existing `freshStore` helper. Add a local `seedPublication` helper beside the file's existing seeding helpers that fills the required preparation row first, mirroring how the existing publication tests seed one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/authoring/publication/postgres-store.integration.test.ts`
Expected: FAIL. The first test fails on the `skill_publications_skill_id_key` unique violation; the second fails on `store.readPublicationLineage is not a function`.

- [ ] **Step 3: Write the migration**

Create `src/authoring/postgres/migrations/003_skill_version_lineage.sql`:

```sql
-- A skill identity gains a lineage: many published versions, one per row.
-- version_id stays globally unique because it is the thing a run pins.
alter table skill_publications drop constraint skill_publications_skill_id_key;

create index skill_publications_skill_idx
  on skill_publications (skill_id, published_at desc);
```

- [ ] **Step 4: Add the lineage read**

In `src/authoring/publication/store.ts`, add to the `PublicationStore` interface:

```ts
export interface LineageEntry {
  readonly versionId: string;
  readonly digest: string;
  readonly publishedAt: string;
}
```

and the method `readPublicationLineage(skillId: string, projectId: string): Promise<readonly LineageEntry[]>;`

In `src/authoring/publication/postgres-publication-store.ts`, implement it beside `readPublishedPackage`:

```ts
async readPublicationLineage(skillId: string, projectId: string): Promise<readonly LineageEntry[]> {
  const { rows } = await this.pool.query<{
    version_id: string;
    digest: string;
    published_at: Date;
  }>(
    `select version_id, digest, published_at
       from skill_publications
      where skill_id = $1 and project_id = $2
      order by published_at desc, version_id desc`,
    [skillId, projectId],
  );
  return rows.map(row => ({
    versionId: row.version_id,
    digest: row.digest,
    publishedAt: row.published_at.toISOString(),
  }));
}
```

Match the file's existing query style: if it uses a shared `query` helper rather than `this.pool.query`, use that helper instead.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/authoring/publication/postgres-store.integration.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/authoring/postgres/migrations/003_skill_version_lineage.sql src/authoring/publication/store.ts src/authoring/publication/postgres-publication-store.ts src/authoring/publication/postgres-store.integration.test.ts
git commit -m "feat(publication): admit many versions on one skill identity"
```

---

### Task I2: Run any package, not only a published one

**Files:**
- Modify: `src/authoring/execution/run-root.ts`, `src/authoring/execution/execution-route.ts`
- Test: `src/authoring/execution/run-root.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RunnablePackage = { readonly label: string; readonly digest: string; readonly packageBytes: Buffer }` exported from `run-root.ts`, and `openRunRoot(root: string, runId: string, pkg: RunnablePackage): Promise<OpenedRunRoot>`. `PublishedPackage` structurally satisfies it except for `label`, so the execution route maps it. Task I3 passes a mount package through the same function.

- [ ] **Step 1: Write the failing test**

Append to `src/authoring/execution/run-root.test.ts`:

```ts
it('opens a package that is not a publication, and names it in a mismatch', async () => {
  const root = libraryRoot();
  const bytes = zipOf({ 'demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n# Demo\n' });
  const pkg = { label: 'mount demo v3', digest: 'f'.repeat(64), packageBytes: bytes };

  await expect(openRunRoot(root, randomUUID(), pkg)).rejects.toThrow(/mount demo v3/);
  rmSync(root, { recursive: true, force: true });
});
```

Reuse the file's existing zip helper for `zipOf`; if it builds fixture zips inline, follow that exact pattern instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/authoring/execution/run-root.test.ts`
Expected: FAIL. The thrown message names the version id, not the label, so the regex does not match.

- [ ] **Step 3: Generalise the type**

In `src/authoring/execution/run-root.ts`, replace the `PublishedPackage` import and parameter:

```ts
export interface RunnablePackage {
  /** What a failure calls this package, for example a version id or "mount demo v3". */
  readonly label: string;
  readonly digest: string;
  readonly packageBytes: Buffer;
}

export async function openRunRoot(
  root: string,
  runId: string,
  pkg: RunnablePackage,
): Promise<OpenedRunRoot> {
  const actual = createHash('sha256').update(pkg.packageBytes).digest('hex');
  if (actual !== pkg.digest) {
    throw new DigestMismatch(
      `the stored package for ${pkg.label} hashes to ${actual}, not the recorded ${pkg.digest}`,
    );
  }
  ...
}
```

Everything below the digest check keeps using `pkg.packageBytes` in place of `published.packageBytes`. Delete the now-unused `PublishedPackage` import.

- [ ] **Step 4: Adapt the caller**

In `src/authoring/execution/execution-route.ts`, where `openRunRoot` is called, map the publication to a runnable package:

```ts
opened = await openRunRoot(deps.executionRoot, request.runId, {
  label: `version ${request.skill.versionId}`,
  digest: published.digest,
  packageBytes: published.packageBytes,
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/authoring/execution/` then `npm run typecheck`
Expected: PASS, including the existing digest-mismatch test, whose expected message now reads `for version <uuid>`. Update that assertion if it matched the old wording.

- [ ] **Step 6: Commit**

```bash
git add src/authoring/execution/run-root.ts src/authoring/execution/execution-route.ts src/authoring/execution/run-root.test.ts
git commit -m "refactor(skill-runs): open any runnable package, not only a publication"
```

---

### Task I3: Run a firm-catalog version

**Files:**
- Create: `src/authoring/execution/mount-package.ts`, `src/authoring/execution/mount-package.test.ts`
- Modify: `src/authoring/execution/execution-route.ts`
- Test: `src/authoring/execution/execution-route.test.ts`

**Interfaces:**
- Consumes: `RunnablePackage` and `openRunRoot` from Task I2.
- Produces: `readMountPackage(skillsRoot: string, name: string, version: number): MountPackageResult` where `MountPackageResult` is `{ ok: true; pkg: RunnablePackage; sha256: string }` or `{ ok: false; code: 'not_found' | 'pruned' }`. The execution route's `SkillReferenceSchema` gains the arm `{ kind: 'mount', name, version, digest }`. Task C6 sends that arm.

- [ ] **Step 1: Write the failing test**

Create `src/authoring/execution/mount-package.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { libraryRoot, removeLibraryRoot } from '../publication/bench-app-fixture.js';
import { readMountPackage } from './mount-package.js';

let root = '';
afterEach(() => {
  if (root !== '') removeLibraryRoot(root);
  root = '';
});

function seedVersion(skillsRoot: string, name: string, version: number, bytes: Buffer | null): void {
  const dir = join(skillsRoot, 'versions', name);
  mkdirSync(dir, { recursive: true });
  if (bytes !== null) writeFileSync(join(dir, `${String(version)}.skill`), bytes);
  writeFileSync(
    join(dir, `${String(version)}.json`),
    JSON.stringify({ version, origin: 'upload', updatedAt: new Date().toISOString() }),
  );
}

describe('readMountPackage', () => {
  it('returns the retained zip for a version', () => {
    root = libraryRoot();
    const bytes = Buffer.from('zip-bytes');
    seedVersion(root, 'demo', 3, bytes);

    const result = readMountPackage(root, 'demo', 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.packageBytes.equals(bytes)).toBe(true);
      expect(result.pkg.label).toBe('mount demo v3');
    }
  });

  it('reports a version that has no record', () => {
    root = libraryRoot();
    expect(readMountPackage(root, 'demo', 9)).toEqual({ ok: false, code: 'not_found' });
  });

  it('reports a version whose bytes were pruned', () => {
    root = libraryRoot();
    seedVersion(root, 'demo', 2, null);
    expect(readMountPackage(root, 'demo', 2)).toEqual({ ok: false, code: 'pruned' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/authoring/execution/mount-package.test.ts`
Expected: FAIL with "Cannot find module './mount-package.js'".

- [ ] **Step 3: Implement the reader**

Create `src/authoring/execution/mount-package.ts`:

```ts
/**
 * A firm-catalog version, read as something a run can mount.
 *
 * The mount keeps a zip per version for the last `KEEP_VERSION_BYTES` of them, and a record for
 * every version ever. Those are three different answers and a caller needs all three: the version
 * is here and runnable, the version was pruned and is recoverable only by re-uploading it, or the
 * version was never here. `pruned` is separated from `not_found` because an MD can act on it.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { readVersion, versionZipPath } from '../../versions.js';
import type { RunnablePackage } from './run-root.js';

export type MountPackageResult =
  | { readonly ok: true; readonly pkg: RunnablePackage; readonly sha256: string }
  | { readonly ok: false; readonly code: 'not_found' | 'pruned' };

export function readMountPackage(
  skillsRoot: string,
  name: string,
  version: number,
): MountPackageResult {
  const record = readVersion(skillsRoot, name, version);
  if (record === null) return { ok: false, code: 'not_found' };

  const path = versionZipPath(skillsRoot, name, version);
  if (!record.bytesRetained || !existsSync(path)) return { ok: false, code: 'pruned' };

  const packageBytes = readFileSync(path);
  const sha256 = createHash('sha256').update(packageBytes).digest('hex');
  return {
    ok: true,
    sha256,
    pkg: { label: `mount ${name} v${String(version)}`, digest: sha256, packageBytes },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/authoring/execution/mount-package.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Append to `src/authoring/execution/execution-route.test.ts`:

```ts
it('runs a mount version whose digest matches', async () => {
  const { app, skillsRoot } = await benchWithRuns();
  const bytes = skillZip('demo');
  seedMountVersion(skillsRoot, 'demo', 3, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');

  const response = await postRun(app, {
    skill: { kind: 'mount', name: 'demo', version: 3, digest },
  });

  expect(response.status).toBe(200);
});

it('answers 404 when a mount version digest does not match', async () => {
  const { app, skillsRoot } = await benchWithRuns();
  seedMountVersion(skillsRoot, 'demo', 3, skillZip('demo'));

  const response = await postRun(app, {
    skill: { kind: 'mount', name: 'demo', version: 3, digest: 'c'.repeat(64) },
  });

  expect(response.status).toBe(404);
});

it('answers 409 when a mount version was pruned', async () => {
  const { app, skillsRoot } = await benchWithRuns();
  seedMountVersion(skillsRoot, 'demo', 2, null);

  const response = await postRun(app, {
    skill: { kind: 'mount', name: 'demo', version: 2, digest: 'c'.repeat(64) },
  });

  expect(response.status).toBe(409);
});
```

Reuse the file's existing app fixture and run-posting helpers rather than inventing new ones; name the local helpers to match what the file already calls them.

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- src/authoring/execution/execution-route.test.ts`
Expected: FAIL with 400 validation errors, because `kind: 'mount'` is not in the union.

- [ ] **Step 7: Add the arm to the route**

In `src/authoring/execution/execution-route.ts`:

```ts
const MountReferenceSchema = z
  .object({
    kind: z.literal('mount'),
    name: z.string().min(1).max(100),
    version: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const SkillReferenceSchema = z.discriminatedUnion('kind', [
  PublicationReferenceSchema,
  MountReferenceSchema,
]);
```

Replace the publication-only lookup with a branch that produces a `RunnablePackage` or a failure response:

```ts
let pkg: RunnablePackage;
if (request.skill.kind === 'publication') {
  const published = await deps.readPublishedPackage(request.skill.skillId, request.skill.versionId);
  if (published === null || published.digest !== request.skill.digest) {
    return fail(c, 'not_found', 'no published version matches that skill, version and digest');
  }
  pkg = {
    label: `version ${request.skill.versionId}`,
    digest: published.digest,
    packageBytes: published.packageBytes,
  };
} else {
  const read = readMountPackage(deps.config.skillsRoot, request.skill.name, request.skill.version);
  if (!read.ok && read.code === 'pruned') {
    return c.json(
      apiError('version_pruned', 'that catalog version no longer keeps its bytes', {
        retryable: false,
      }),
      409,
    );
  }
  if (!read.ok || read.sha256 !== request.skill.digest) {
    return fail(c, 'not_found', 'no catalog version matches that name, number and digest');
  }
  pkg = read.pkg;
}
```

Then pass `pkg` to `openRunRoot`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- src/authoring/execution/` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/authoring/execution/mount-package.ts src/authoring/execution/mount-package.test.ts src/authoring/execution/execution-route.ts src/authoring/execution/execution-route.test.ts
git commit -m "feat(skill-runs): execute a pinned firm-catalog version"
```

---

### Task I4: Choose a model for a run

**Files:**
- Modify: `src/authoring/execution/execution-route.ts`
- Test: `src/authoring/execution/execution-route.test.ts`

**Interfaces:**
- Consumes: the route from Task I3.
- Produces: `SkillRunRequestSchema` gains `model?: ModelAlias | null`. The clamped alias is passed as `runTurn`'s `model`. Task C6 sends it.

- [ ] **Step 1: Write the failing test**

Append to `src/authoring/execution/execution-route.test.ts`:

```ts
it('passes a requested model through to the turn', async () => {
  const seen: (string | null)[] = [];
  const { app, skillsRoot } = await benchWithRuns({
    runTurn: ((request: { model?: string | null }) => {
      seen.push(request.model ?? null);
      return (async function* () {})();
    }) as never,
  });
  const bytes = skillZip('demo');
  seedMountVersion(skillsRoot, 'demo', 1, bytes);

  await postRun(app, {
    skill: {
      kind: 'mount',
      name: 'demo',
      version: 1,
      digest: createHash('sha256').update(bytes).digest('hex'),
    },
    model: 'sonnet',
  });

  expect(seen).toEqual(['sonnet']);
});

it('clamps a requested model to the skill declared ceiling', async () => {
  const seen: (string | null)[] = [];
  const { app, skillsRoot } = await benchWithRuns({
    runTurn: ((request: { model?: string | null }) => {
      seen.push(request.model ?? null);
      return (async function* () {})();
    }) as never,
  });
  const bytes = skillZip('demo', { maxModel: 'haiku' });
  seedMountVersion(skillsRoot, 'demo', 1, bytes);

  await postRun(app, {
    skill: {
      kind: 'mount',
      name: 'demo',
      version: 1,
      digest: createHash('sha256').update(bytes).digest('hex'),
    },
    model: 'opus',
  });

  expect(seen).toEqual(['haiku']);
});
```

Extend the file's `skillZip` helper to accept optional frontmatter fields so the second test can declare `max-model: haiku`, matching the frontmatter key `readFrontmatter` already parses for `maxModel`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/authoring/execution/execution-route.test.ts`
Expected: FAIL. The first test fails with a 400, because `model` is not in the strict schema.

- [ ] **Step 3: Accept and clamp the model**

In `src/authoring/execution/execution-route.ts`, add `model: z.string().nullable().optional()` to `SkillRunRequestSchema`, then after `openRunRoot` succeeds:

```ts
/*
  The ceiling is read from the skill that was just unpacked, not from the caller. A published
  skill's frontmatter is not visible to Conductia, so the clamp cannot live in the dropdown the
  way it does for the catalog runner.
*/
const asked = readModelAlias(request.model ?? null);
const declared = mountedSkills(
  { ...deps.config, skillsRoot: opened.directory, skillsBase: opened.directory },
  'execution',
).skills.find(skill => skill.name === opened.skillName);
const model = clampModel(asked, declared?.maxModel ?? null).allowed;
```

Import `readModelAlias` and `clampModel` from `../../model-choice.js` and `mountedSkills` from `../../skills.js`. Pass `model` in place of the hard-coded `model: null` in the `runTurn` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/authoring/execution/` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/authoring/execution/execution-route.ts src/authoring/execution/execution-route.test.ts
git commit -m "feat(skill-runs): choose a model for a run, clamped by the skill ceiling"
```

---

### Task I5: Seed an authoring turn from an existing version

**Files:**
- Modify: `src/authoring/turn-route.ts`, `src/authoring/generator.ts`
- Test: `src/authoring/turn-route.test.ts`, `src/authoring/generator.test.ts`

**Interfaces:**
- Consumes: `readMountPackage` from Task I3, `readPublishedPackage` from the existing store.
- Produces: `TurnRequestSchema` gains `basis` (the skill reference union, nullable) and `seedRun` (`{ input: string; output: string }`, nullable). `AuthoringGenerateInput` gains the same two fields. `AuthoringGeneratorOptions` gains `readAncestor(basis): Promise<{ skillMdText: string; referenceFiles: Record<string, string> } | null>`. Task C8 sends `basis` and `seedRun`.

- [ ] **Step 1: Write the failing test**

Append to `src/authoring/generator.test.ts`:

```ts
it('puts the ancestor instructions and the failing run into the turn', async () => {
  const messages: string[] = [];
  const generator = new AuthoringGenerator({
    ...baseOptions(),
    readAncestor: async () => ({
      skillMdText: '---\nname: demo\ndescription: d\n---\n# Demo\nOld instructions.\n',
      referenceFiles: {},
    }),
    model: recordingModel(messages),
  });

  await generator.generate(
    {
      attemptId: randomUUID(),
      history: [],
      message: 'The confidence read was wrong.',
      currentCandidate: null,
      basis: { kind: 'mount', name: 'demo', version: 3, digest: 'a'.repeat(64) },
      seedRun: { input: 'Check Acme', output: 'High confidence, no evidence.' },
    },
    async () => undefined,
  );

  const joined = messages.join('\n');
  expect(joined).toContain('Old instructions.');
  expect(joined).toContain('Check Acme');
  expect(joined).toContain('High confidence, no evidence.');
});
```

Use the file's existing `baseOptions` and scripted-model helpers; if it names them differently, follow that naming.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/authoring/generator.test.ts`
Expected: FAIL with a type error on the unknown `basis` and `seedRun` properties, and no ancestor text in the messages.

- [ ] **Step 3: Thread the basis through the generator**

In `src/authoring/generator.ts`, extend the input type and the message builder:

```ts
export type SkillReference =
  | { readonly kind: 'publication'; readonly skillId: string; readonly versionId: string; readonly digest: string }
  | { readonly kind: 'mount'; readonly name: string; readonly version: number; readonly digest: string };

export type AuthoringGenerateInput = {
  readonly attemptId: string;
  readonly history: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly message: string;
  readonly currentCandidate: CandidatePreview | null;
  readonly basis?: SkillReference | null;
  readonly seedRun?: { readonly input: string; readonly output: string } | null;
};
```

Add `readAncestor?: (basis: SkillReference) => Promise<{ skillMdText: string; referenceFiles: Record<string, string> } | null>` to `AuthoringGeneratorOptions`, resolve it once in `run` before building the turn, and prepend to `messagesFor`:

```ts
function basisMessages(
  ancestor: { skillMdText: string } | null,
  seedRun: { input: string; output: string } | null | undefined,
): readonly { readonly role: string; readonly content: string }[] {
  if (ancestor === null) return [];
  const parts = [
    'You are improving an existing skill, not writing a new one. Follow the skillbuilder ' +
      'methodology: interview before drafting, establish whether this is a one-off or a pattern, ' +
      'preserve everything unrelated to the complaint, and show the full revised text before ' +
      'proposing a candidate.',
    `The skill as it stands:\n\n${ancestor.skillMdText}`,
  ];
  if (seedRun) {
    parts.push(
      `The run the banker is complaining about.\n\nInput:\n${seedRun.input}\n\nOutput:\n${seedRun.output}`,
    );
  }
  return [{ role: 'user', content: parts.join('\n\n') }];
}
```

Call it at the head of `messagesFor`'s returned array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/authoring/generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Append to `src/authoring/turn-route.test.ts`:

```ts
it('accepts a basis and a seed run and hands both to the generator', async () => {
  const seen: unknown[] = [];
  const app = appWithGenerator({ generate: async input => void seen.push(input) });

  const response = await app.request('/authoring/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId: randomUUID(),
      history: [],
      message: 'Tighten the confidence read.',
      currentCandidate: null,
      basis: { kind: 'publication', skillId: randomUUID(), versionId: randomUUID(), digest: 'a'.repeat(64) },
      seedRun: { input: 'Check Acme', output: 'High confidence.' },
    }),
  });

  expect(response.status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ seedRun: { input: 'Check Acme' } });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- src/authoring/turn-route.test.ts`
Expected: FAIL with 400, because the schema is `.strict()` and rejects the new keys.

- [ ] **Step 7: Widen the turn schema**

In `src/authoring/turn-route.ts`, add the reference and seed schemas and put both on `TurnRequestSchema` as `.nullable().optional()`:

```ts
const ReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('publication'),
      skillId: UuidSchema,
      versionId: UuidSchema,
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mount'),
      name: z.string().min(1).max(100),
      version: z.number().int().positive(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
]);

const SeedRunSchema = z
  .object({ input: z.string().min(1).max(20_000), output: z.string().min(1).max(100_000) })
  .strict();
```

- [ ] **Step 8: Wire `readAncestor` in main**

In `src/main.ts`, where `AuthoringGenerator` is constructed, pass a `readAncestor` that branches on the reference kind: `publication` reads `publication.readPublishedPackage(skillId, versionId)` and unpacks it in memory with the same `readPackage` logic `run-root.ts` uses; `mount` reads the current folder under `config.skillsRoot` with `findSkill` and `skillPath`. Return `null` when either misses, so the conversation degrades to creation rather than failing.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test -- src/authoring/` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/authoring/turn-route.ts src/authoring/generator.ts src/authoring/turn-route.test.ts src/authoring/generator.test.ts src/main.ts
git commit -m "feat(authoring): seed a turn from an existing version and its failing run"
```

---

### Task I6: Build an enhanced candidate by overlay

**Files:**
- Modify: `src/authoring/candidate-package.ts`, `src/authoring/generator.ts`
- Test: `src/authoring/candidate-package.test.ts`

**Interfaces:**
- Consumes: `readAncestor` from Task I5.
- Produces: `PrivateCandidatePackageOptions` gains `basePackage?: { readonly referenceFiles: Readonly<Record<string, string>> }`. Files in the base that the candidate does not name are carried into the zip unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/authoring/candidate-package.test.ts`:

```ts
it('carries forward a base reference file the candidate did not name', async () => {
  const store = memoryStore();
  const packages = preparePrivateCandidate(store, {
    basePackage: {
      referenceFiles: {
        'references/style.md': 'House style.',
        'references/tables.md': 'Old tables.',
      },
    },
  });

  const candidate = await packages.prepareCandidate({
    attemptId: randomUUID(),
    providerCandidateId: randomUUID(),
    name: 'demo',
    purpose: 'p',
    expectedInput: 'i',
    expectedOutput: 'o',
    skillMdText: '---\nname: demo\ndescription: d\n---\n# Demo\n',
    referenceFiles: { 'references/tables.md': 'New tables.' },
  });

  const files = unzipSync(new Uint8Array(await store.read(candidate.id)));
  expect(new TextDecoder().decode(files['demo/references/style.md'])).toBe('House style.');
  expect(new TextDecoder().decode(files['demo/references/tables.md'])).toBe('New tables.');
});
```

Use the file's existing in-memory store helper and its way of reading stored bytes back; if it exposes the bytes differently, follow that.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/authoring/candidate-package.test.ts`
Expected: FAIL. `references/style.md` is absent from the zip, because nothing carried it forward.

- [ ] **Step 3: Overlay the base**

In `src/authoring/candidate-package.ts`, extend the options and merge before validating:

```ts
export interface PrivateCandidatePackageOptions {
  readonly temporaryRoot?: string;
  /**
   * The ancestor's reference files, for an enhancement. Everything here that the candidate does
   * not name survives into the new package, which is the guarantee skillbuilder states as
   * "preserve everything that has nothing to do with the complaint".
   */
  readonly basePackage?: { readonly referenceFiles: Readonly<Record<string, string>> };
}
```

In `prepareCandidate`, merge base first and candidate second so a named file wins:

```ts
const merged = { ...(base?.referenceFiles ?? {}), ...(input.referenceFiles ?? {}) };
const references = validateReferences(merged);
...
await writePackage(scratch, input.skillMdText, merged, references);
```

Leave `contentFingerprint` reading `input` alone: the digest must still be a function of the merged bytes, so pass `merged` into it in place of `input.referenceFiles`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/authoring/candidate-package.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it from the generator**

In `src/authoring/generator.ts`, when `readAncestor` returned files, construct the candidate tool's packages with `preparePrivateCandidate(store, { basePackage: { referenceFiles: ancestor.referenceFiles } })` rather than the shared instance. Thread it through `capturePackages` unchanged.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/authoring/` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/authoring/candidate-package.ts src/authoring/candidate-package.test.ts src/authoring/generator.ts
git commit -m "feat(authoring): build an enhanced candidate by overlay onto its ancestor"
```

---

### Task I7: Stop an ancestor from blocking its own enhancement

**Files:**
- Modify: `src/authoring/publication/service-prepare.ts`, `src/authoring/publication/routes-validation.ts`
- Test: `src/authoring/publication/service-prepare-binding.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the prepare request accepts `ancestorSkillId: string | null`. A duplicate match whose skill identity equals `ancestorSkillId` is dropped from `matches` before the block is decided. Task C7 sends it.

- [ ] **Step 1: Write the failing test**

Append to `src/authoring/publication/service-prepare-binding.test.ts`:

```ts
it('does not report the ancestor as a duplicate', async () => {
  const { service, skillId } = await serviceWithBoundSkill();

  const prepared = await service.prepare(prepareRequest({ ancestorSkillId: skillId }));

  expect(prepared.matches).toEqual([]);
});

it('still reports a different bound skill as a duplicate', async () => {
  const { service, skillId } = await serviceWithBoundSkill();

  const prepared = await service.prepare(prepareRequest({ ancestorSkillId: randomUUID() }));

  expect(prepared.matches.map(match => match.skillId)).toContain(skillId);
});
```

Use the file's existing service fixture and request builder; extend the builder to pass `ancestorSkillId` through.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/authoring/publication/service-prepare-binding.test.ts`
Expected: FAIL. The first test finds the ancestor in `matches`.

- [ ] **Step 3: Accept and apply the exemption**

Add `ancestorSkillId: z.string().uuid().nullable().optional()` to the prepare request schema in `src/authoring/publication/routes-validation.ts`, carry it into the service request type, and in `src/authoring/publication/service-prepare.ts` filter the comparison result before the block decision:

```ts
const matches = rawMatches.filter(match => match.skillId !== request.ancestorSkillId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/authoring/publication/` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/authoring/publication/service-prepare.ts src/authoring/publication/routes-validation.ts src/authoring/publication/service-prepare-binding.test.ts
git commit -m "feat(publication): exempt a draft ancestor from duplicate detection"
```

---

# Part 2: Conductia

Working directory for every task in this part: `~/orca/workspaces/conductia/skill-run-execution`.

### Task C1: The step binding table and the rebind function

**Files:**
- Create: `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql`
- Test: `tests/api/skill-binding-rebind.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: table `deal_step_skill_bindings` and function `rail_rebind_step(p_deal_id uuid, p_actor_id uuid, p_deal_step_id uuid, p_reference jsonb, p_source text) returns jsonb`. Tasks C3 and C5 consume both.

- [ ] **Step 1: Write the failing test**

Create `tests/api/skill-binding-rebind.integration.test.ts` following the pattern of the repository's existing migration integration tests (the ones under `tests/api/` that open a service-role client against the local stack):

```ts
it('writes a binding and replaces it on a second rebind', async () => {
  const { dealId, stepId, actorId } = await seedCustomStep();
  const first = { kind: 'publication', skillId: randomUUID(), versionId: randomUUID(), digest: 'a'.repeat(64) };
  const second = { kind: 'mount', name: 'demo', version: 3, digest: 'b'.repeat(64) };

  await admin.rpc('rail_rebind_step', {
    p_deal_id: dealId, p_actor_id: actorId, p_deal_step_id: stepId,
    p_reference: first, p_source: 'publication',
  });
  await admin.rpc('rail_rebind_step', {
    p_deal_id: dealId, p_actor_id: actorId, p_deal_step_id: stepId,
    p_reference: second, p_source: 'selection',
  });

  const { data } = await admin
    .from('deal_step_skill_bindings').select('*').eq('deal_step_id', stepId).single();

  expect(data).toMatchObject({ kind: 'mount', mount_name: 'demo', mount_version: 3, source: 'selection' });
  expect(data.skill_id).toBeNull();
});

it('refuses a removed step', async () => {
  const { dealId, stepId, actorId } = await seedCustomStep({ removed: true });
  const { error } = await admin.rpc('rail_rebind_step', {
    p_deal_id: dealId, p_actor_id: actorId, p_deal_step_id: stepId,
    p_reference: { kind: 'mount', name: 'demo', version: 1, digest: 'c'.repeat(64) },
    p_source: 'selection',
  });
  expect(error?.message).toContain('step_removed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- tests/api/skill-binding-rebind.integration.test.ts`
Expected: FAIL with `relation "deal_step_skill_bindings" does not exist`.

Before running, confirm the configured Supabase URL is localhost. Never run this against a hosted project.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql`:

```sql
-- Which skill version a step runs, for catalog and custom steps alike.
--
-- Part C wrote the binding into deal_steps.definition, which only custom steps
-- carry. A catalog step has origin 'catalog' and a null definition, so version
-- selection needs a home that both kinds share. Absence is meaningful: no row
-- means the step resolves the way it does today.

create table if not exists deal_step_skill_bindings (
  deal_step_id  uuid primary key references deal_steps (id) on delete cascade,
  deal_id       uuid not null references deals (id) on delete cascade,
  kind          text not null check (kind in ('publication', 'mount')),
  skill_id      uuid,
  version_id    uuid,
  mount_name    text,
  mount_version integer check (mount_version is null or mount_version > 0),
  digest        text not null check (digest ~ '^[0-9a-f]{64}$'),
  bound_by      uuid not null references users (id),
  bound_at      timestamptz not null default now(),
  source        text not null check (source in ('publication', 'selection')),
  check ((kind = 'publication') = (skill_id is not null and version_id is not null)),
  check ((kind = 'mount') = (mount_name is not null and mount_version is not null))
);

alter table deal_step_skill_bindings enable row level security;

grant select, insert, update, delete on deal_step_skill_bindings to service_role;

-- No authenticated grant and no select policy: every read of this table goes
-- through an API route on the service role. A direct grant would expose it
-- over the Supabase REST API, where app_is_overseer alone does not compare
-- tenants and would let any firm's admin read another firm's bindings.
revoke select on deal_step_skill_bindings from authenticated;
drop policy if exists deal_step_skill_bindings_select on deal_step_skill_bindings;

create or replace function rail_rebind_step(
  p_deal_id uuid, p_actor_id uuid, p_deal_step_id uuid, p_reference jsonb, p_source text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_step     deal_steps%rowtype;
  v_previous jsonb;
  v_kind     text := p_reference ->> 'kind';
begin
  perform 1 from deals where id = p_deal_id for update;

  select * into v_step from deal_steps
   where id = p_deal_step_id and deal_id = p_deal_id for update;
  if not found then
    raise exception 'step_not_found' using errcode = 'P0002';
  end if;
  if v_step.removed_at is not null then
    raise exception 'step_removed' using errcode = 'P0002';
  end if;
  if v_kind not in ('publication', 'mount') then
    raise exception 'unknown_reference_kind' using errcode = 'P0001';
  end if;

  select to_jsonb(binding) into v_previous
    from deal_step_skill_bindings binding where binding.deal_step_id = p_deal_step_id;

  insert into deal_step_skill_bindings as target (
    deal_step_id, deal_id, kind, skill_id, version_id, mount_name, mount_version,
    digest, bound_by, bound_at, source
  ) values (
    p_deal_step_id, p_deal_id, v_kind,
    nullif(p_reference ->> 'skillId', '')::uuid,
    nullif(p_reference ->> 'versionId', '')::uuid,
    nullif(p_reference ->> 'name', ''),
    nullif(p_reference ->> 'version', '')::integer,
    p_reference ->> 'digest', p_actor_id, now(), p_source
  )
  on conflict (deal_step_id) do update set
    kind = excluded.kind, skill_id = excluded.skill_id, version_id = excluded.version_id,
    mount_name = excluded.mount_name, mount_version = excluded.mount_version,
    digest = excluded.digest, bound_by = excluded.bound_by, bound_at = excluded.bound_at,
    source = excluded.source
  returning to_jsonb(target) into v_previous;

  perform skill_authoring_write_audit(null, 'rail.step_rebound', p_deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'service', 'conductia', 'dealStepId', p_deal_step_id, 'actorId', p_actor_id,
      'source', p_source, 'reference', p_reference
    )));

  return v_previous;
end;
$$;

revoke all on function rail_rebind_step(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function rail_rebind_step(uuid, uuid, uuid, jsonb, text) to service_role;
```

- [ ] **Step 4: Apply the migration and run the test**

Run: `npm run db:migrate` then `npm run test:integration -- tests/api/skill-binding-rebind.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql tests/api/skill-binding-rebind.integration.test.ts
git commit -m "feat(skills): give a step a re-pointable skill binding"
```

---

### Task C2: Relax the constraints that admit only one version

**Files:**
- Create: `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql`
- Test: `tests/api/skill-version-lineage.integration.test.ts`

**Interfaces:**
- Consumes: Task C1's table.
- Produces: `skill_authoring_drafts.basis jsonb`, `.basis_deal_step_id uuid`, `.seed_run_id uuid`; `deal_step_skill_runs` widened with `mount_name`, `mount_version`, `model`, `source`; the three relaxed uniqueness rules. Tasks C3, C6 and C7 consume them.

- [ ] **Step 1: Write the failing test**

Create `tests/api/skill-version-lineage.integration.test.ts`:

```ts
it('admits two published operations on one skill identity', async () => {
  const skillId = randomUUID();
  await expect(seedPublicationOperation({ skillId, state: 'published' })).resolves.toBeTruthy();
  await expect(seedPublicationOperation({ skillId, state: 'published' })).resolves.toBeTruthy();
});

it('still admits only one live operation per skill identity', async () => {
  const skillId = randomUUID();
  await seedPublicationOperation({ skillId, state: 'preparing' });
  await expect(seedPublicationOperation({ skillId, state: 'preparing' })).rejects.toThrow();
});

it('admits a creation draft and an enhancement draft for one author on one deal', async () => {
  const { dealId, actorId, stepId } = await seedCustomStep();
  await expect(seedDraft({ dealId, actorId, basisStepId: null })).resolves.toBeTruthy();
  await expect(seedDraft({ dealId, actorId, basisStepId: stepId })).resolves.toBeTruthy();
  await expect(seedDraft({ dealId, actorId, basisStepId: stepId })).rejects.toThrow();
});

it('records a mount run with no publication ids', async () => {
  const { dealId, stepId, actorId } = await seedCustomStep();
  const { error } = await admin.from('deal_step_skill_runs').insert({
    id: randomUUID(), deal_id: dealId, deal_step_id: stepId, actor_id: actorId,
    mount_name: 'demo', mount_version: 3, digest: 'a'.repeat(64),
    input: 'Check Acme', outcome: 'succeeded', result_text: 'Done.', model: 'sonnet',
    source: 'execution',
  });
  expect(error).toBeNull();
});

it('records an imported run with no reference at all', async () => {
  const { dealId, stepId } = await seedCustomStep();
  const { error } = await admin.from('deal_step_skill_runs').insert({
    id: randomUUID(), deal_id: dealId, deal_step_id: stepId,
    input: 'Check Acme', outcome: 'succeeded', result_text: 'Done.', source: 'imported',
  });
  expect(error).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- tests/api/skill-version-lineage.integration.test.ts`
Expected: FAIL on the `skill_publication_operations_reserved_skill_id_key` unique violation and on unknown columns `mount_name`, `model`, `source`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql`:

```sql
-- A skill identity gains a lineage, a draft gains a basis, and a run gains a
-- firm-catalog shape.
--
-- The three uniqueness rules relaxed here all encoded the same assumption: one
-- version per skill, written once. Each keeps its real guarantee as a partial
-- index over the states that are still in flight.

alter table skill_publication_operations drop constraint skill_publication_operations_reserved_skill_id_key;
create unique index skill_publication_one_live_per_skill_idx
  on skill_publication_operations (reserved_skill_id)
  where state not in ('published', 'failed');

alter table skill_publication_operations drop constraint skill_publication_operations_resulting_deal_step_id_key;
create unique index skill_publication_one_live_per_step_idx
  on skill_publication_operations (resulting_deal_step_id)
  where resulting_deal_step_id is not null and state not in ('published', 'failed');

alter table skill_authoring_drafts
  add column if not exists basis              jsonb,
  add column if not exists basis_deal_step_id uuid references deal_steps (id),
  add column if not exists seed_run_id        uuid references deal_step_skill_runs (id);

alter table skill_authoring_drafts drop constraint if exists skill_authoring_drafts_basis_check;
alter table skill_authoring_drafts add constraint skill_authoring_drafts_basis_check
  check ((basis is null) = (basis_deal_step_id is null));

alter table skill_authoring_drafts drop constraint if exists skill_authoring_drafts_basis_placement_check;
alter table skill_authoring_drafts add constraint skill_authoring_drafts_basis_placement_check
  check (basis_deal_step_id is null or (phase_index is null and placement_kind is null));

drop index if exists skill_authoring_drafts_one_active_idx;
create unique index skill_authoring_drafts_one_active_idx
  on skill_authoring_drafts (
    deal_id, author_id, coalesce(basis_deal_step_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'active';

alter table deal_step_skill_runs
  add column if not exists mount_name    text,
  add column if not exists mount_version integer,
  add column if not exists model         text,
  add column if not exists source        text not null default 'execution';

alter table deal_step_skill_runs alter column skill_id   drop not null;
alter table deal_step_skill_runs alter column version_id drop not null;
alter table deal_step_skill_runs alter column digest     drop not null;
alter table deal_step_skill_runs alter column actor_id   drop not null;

alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_source_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_source_check
  check (source in ('execution', 'imported'));

-- The nullability dropped above is given back as a rule keyed on source: an
-- executed run always names exactly one reference, a digest and an actor; an
-- imported bench reply names none of them, because the bench path recorded
-- neither a version nor who ran it.
alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_reference_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_reference_check
  check (
    (source = 'execution'
      and digest is not null and actor_id is not null
      and ((skill_id is not null and version_id is not null
            and mount_name is null and mount_version is null)
        or (mount_name is not null and mount_version is not null
            and skill_id is null and version_id is null)))
    or
    (source = 'imported'
      and digest is null and skill_id is null and version_id is null
      and mount_name is null and mount_version is null)
  );
```

Before writing it, confirm the real constraint names with
`\d skill_publication_operations` and `\d skill_authoring_drafts` against the local stack, and use whatever Postgres actually generated.

- [ ] **Step 4: Apply the migration and run the test**

Run: `npm run db:migrate` then `npm run test:integration -- tests/api/skill-version-lineage.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full integration suite for regressions**

Run: `npm run test:integration`
Expected: PASS. The Part C and Part D suites exercise both relaxed constraints.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql tests/api/skill-version-lineage.integration.test.ts
git commit -m "feat(skills): admit a skill lineage, a draft basis and a catalog run"
```

---

### Task C3: Resolve a step through three layers

**Files:**
- Modify: `src/lib/skillRun/types.ts`, `src/lib/skillRun/step.ts`
- Test: `tests/skill-run-step.test.ts`

**Interfaces:**
- Consumes: Task C1's table.
- Produces:

```ts
export type SkillReference =
  | { kind: "publication"; skillId: string; versionId: string; digest: string }
  | { kind: "mount"; name: string; version: number; digest: string };

export function resolveStepBinding(
  row: unknown,
  binding: unknown,
  mountName: string | null,
  mountVersion: number | null,
  mountDigest: string | null,
): BindingResolution;
```

`BoundStep.binding` becomes `SkillReference`. Tasks C4, C5, C6 and C10 consume it.

- [ ] **Step 1: Write the failing test**

Append to `tests/skill-run-step.test.ts`:

```ts
const MOUNT_ARGS = ["demo", 3, "d".repeat(64)] as const;

describe("resolveStepBinding layers", () => {
  it("prefers a binding row over the step definition", () => {
    const resolved = resolveStepBinding(
      row(),
      { kind: "mount", mount_name: "demo", mount_version: 3, digest: "d".repeat(64) },
      ...MOUNT_ARGS,
    );
    expect(resolved).toMatchObject({
      ok: true,
      step: { binding: { kind: "mount", name: "demo", version: 3, digest: "d".repeat(64) } },
    });
  });

  it("falls back to the definition binding for a custom step", () => {
    const resolved = resolveStepBinding(row(), null, ...MOUNT_ARGS);
    expect(resolved).toMatchObject({
      ok: true,
      step: { binding: { kind: "publication", ...BINDING } },
    });
  });

  it("falls back to the tag-matched mount skill for a catalog step", () => {
    const resolved = resolveStepBinding(
      row({ origin: "catalog", definition: null, step_id: "p1-s17" }),
      null,
      ...MOUNT_ARGS,
    );
    expect(resolved).toMatchObject({
      ok: true,
      step: { binding: { kind: "mount", name: "demo", version: 3, digest: "d".repeat(64) } },
    });
  });

  it("refuses a catalog step with no mount skill behind it", () => {
    expect(
      resolveStepBinding(row({ origin: "catalog", definition: null }), null, null, null, null),
    ).toEqual({ ok: false, code: "not_skill_backed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/skill-run-step.test.ts`
Expected: FAIL. `resolveStepBinding` takes one argument and returns a bare `SkillBinding` with no `kind`.

- [ ] **Step 3: Widen the types**

In `src/lib/skillRun/types.ts`, add `SkillReference` exactly as given in the Interfaces block above, and change `BoundStep.binding` to `SkillReference`. Keep `SkillBinding` imported only where the publication shape is meant.

- [ ] **Step 4: Implement the three layers**

Rewrite `resolveStepBinding` in `src/lib/skillRun/step.ts`:

```ts
export function resolveStepBinding(
  row: unknown,
  binding: unknown,
  mountName: string | null,
  mountVersion: number | null,
  mountDigest: string | null,
): BindingResolution {
  if (!row || typeof row !== "object") return { ok: false, code: "not_found" };
  const step = row as StepRow;
  if (typeof step.id !== "string" || typeof step.step_id !== "string") {
    return { ok: false, code: "not_found" };
  }
  if (step.removed_at !== null && step.removed_at !== undefined) {
    return { ok: false, code: "removed" };
  }

  const parsed = parseSkillStepDefinitionV1(step.definition);
  const title = "error" in parsed ? String(step.step_id) : parsed.title;

  const fromRow = referenceFromRow(binding);
  if (fromRow) {
    return { ok: true, step: { dealStepId: step.id, stepId: step.step_id, title, binding: fromRow } };
  }

  if (step.origin === "custom") {
    if ("error" in parsed) return { ok: false, code: "not_skill_backed" };
    return {
      ok: true,
      step: {
        dealStepId: step.id,
        stepId: step.step_id,
        title: parsed.title,
        binding: { kind: "publication", ...parsed.skillBinding },
      },
    };
  }

  if (mountName === null || mountVersion === null || mountDigest === null) {
    return { ok: false, code: "not_skill_backed" };
  }
  return {
    ok: true,
    step: {
      dealStepId: step.id,
      stepId: step.step_id,
      title,
      binding: { kind: "mount", name: mountName, version: mountVersion, digest: mountDigest },
    },
  };
}

function referenceFromRow(binding: unknown): SkillReference | null {
  if (!binding || typeof binding !== "object") return null;
  const row = binding as Record<string, unknown>;
  const digest = typeof row.digest === "string" ? row.digest : null;
  if (digest === null) return null;
  if (row.kind === "publication" && typeof row.skill_id === "string" && typeof row.version_id === "string") {
    return { kind: "publication", skillId: row.skill_id, versionId: row.version_id, digest };
  }
  if (row.kind === "mount" && typeof row.mount_name === "string" && typeof row.mount_version === "number") {
    return { kind: "mount", name: row.mount_name, version: row.mount_version, digest };
  }
  return null;
}
```

Update `resolveRunnableStep` to take and forward the same five arguments.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/skill-run-step.test.ts` then `npm run lint`
Expected: PASS, no lint errors. Fix the two Part D call sites the signature change breaks (`skill-runs/route.ts` and `skill-runs/stream/route.ts`) by passing the step's binding row and the resolved mount triple, which Task C6 finishes wiring.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skillRun/types.ts src/lib/skillRun/step.ts tests/skill-run-step.test.ts
git commit -m "feat(skill-runs): resolve a step binding through row, definition and mount"
```

---

### Task C4: The version picker payload

**Files:**
- Create: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-versions/route.ts`, `src/lib/skillRun/versions.ts`
- Modify: `src/lib/ignatious/bench.ts`
- Test: `tests/api/skill-versions-route.test.ts`, `tests/skill-run-versions.test.ts`

**Interfaces:**
- Consumes: `resolveStepBinding` from Task C3, Ignatious's lineage lookup from Task I1.
- Produces:

```ts
export type VersionOption = {
  reference: SkillReference;
  label: string;
  authorName: string | null;
  createdAt: string | null;
  available: boolean;
  unavailableReason: string | null;
};

export type StepVersions = {
  current: SkillReference | null;
  project: VersionOption[];
  catalog: VersionOption[];
};
```

Returned as JSON by `GET /api/v1/deals/{dealId}/steps/{stepId}/skill-versions`. Tasks C5 and C10 consume it.

- [ ] **Step 1: Write the failing pure test**

Create `tests/skill-run-versions.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { catalogOptions, projectOptions } from "@/lib/skillRun/versions";

describe("catalogOptions", () => {
  it("lists newest first with the author and marks a pruned version unavailable", () => {
    const options = catalogOptions("demo", [
      { version: 3, sha256: "a".repeat(64), bytesRetained: true, updatedBy: "sd@x.com", updatedAt: "2026-09-10T00:00:00Z" },
      { version: 2, sha256: "b".repeat(64), bytesRetained: false, updatedBy: null, updatedAt: "2026-09-01T00:00:00Z" },
    ]);

    expect(options.map(option => option.label)).toEqual(["v3", "v2"]);
    expect(options[0]).toMatchObject({ available: true, authorName: "sd@x.com" });
    expect(options[1]).toMatchObject({
      available: false,
      unavailableReason: "This catalog version no longer keeps its bytes.",
    });
  });

  it("drops a version with no recorded hash, which cannot be pinned", () => {
    expect(
      catalogOptions("demo", [
        { version: 1, sha256: null, bytesRetained: true, updatedBy: null, updatedAt: null },
      ]),
    ).toEqual([]);
  });
});

describe("projectOptions", () => {
  it("lists a lineage newest first with its author", () => {
    const options = projectOptions("11111111-1111-4111-8111-111111111111", [
      { versionId: "22222222-2222-4222-8222-222222222222", digest: "c".repeat(64), publishedAt: "2026-09-12T00:00:00Z", authorName: "Storm Duncan" },
    ]);

    expect(options[0]).toMatchObject({
      label: "Published 12 Sep 2026",
      authorName: "Storm Duncan",
      available: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/skill-run-versions.test.ts`
Expected: FAIL with "Cannot find module '@/lib/skillRun/versions'".

- [ ] **Step 3: Implement the mappers**

Create `src/lib/skillRun/versions.ts` exporting `VersionOption`, `StepVersions`, `catalogOptions(name, records)` and `projectOptions(skillId, entries)` that produce exactly the shapes asserted above. A catalog record with a null `sha256` is dropped, because a version with no recorded hash cannot be pinned. Format `label` for a project version as `Published <d MMM yyyy>` using `toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/skill-run-versions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Create `tests/api/skill-versions-route.test.ts` following the structure of `tests/api/skill-run-records.test.ts`, asserting that the route returns 403 for a non-internal user, 404 for an unknown step, and a body with `current`, `project` and `catalog` for an internal user on a bound step.

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/api/skill-versions-route.test.ts`
Expected: FAIL, the route module does not exist.

- [ ] **Step 7: Implement the route and the bench client method**

Add `listPublicationLineage(skillId: string, projectId: string)` to the bench client in `src/lib/ignatious/bench.ts`, calling the Ignatious lineage endpoint from Task I1. Create the route with the standard gate chain (`requireFlag("skill_authoring")`, `requireApiUser`, `loadDealByIdOrCode`, `userCanAccessDeal`, `classifyInternalUser`, `resolveDealStepCapabilities(...).canEditWork`), then resolve the step, fetch both sources, and return `StepVersions`. Resolve author names for project versions by joining `skill_publication_operations.actor_id` to `users`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- tests/api/skill-versions-route.test.ts tests/skill-run-versions.test.ts` then `npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/skillRun/versions.ts "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-versions/route.ts" src/lib/ignatious/bench.ts tests/skill-run-versions.test.ts tests/api/skill-versions-route.test.ts
git commit -m "feat(skill-runs): serve the grouped version list for a step"
```

---

### Task C5: Promote a version to the step

**Files:**
- Create: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-binding/route.ts`
- Test: `tests/api/skill-binding-route.test.ts`

**Interfaces:**
- Consumes: `rail_rebind_step` from Task C1, `StepVersions` from Task C4.
- Produces: `PUT /api/v1/deals/{dealId}/steps/{stepId}/skill-binding` taking `{ reference: SkillReference }` and returning `{ binding: SkillReference }`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/skill-binding-route.test.ts`, following the mocking harness `tests/api/skill-run-records.test.ts` already uses for `requireApiUser` and the Supabase admin client:

```ts
const AVAILABLE = { kind: "mount", name: "demo", version: 3, digest: "d".repeat(64) } as const;

it("refuses a user who cannot edit the step's work", async () => {
  const response = await put({ capabilities: { canEditWork: false }, reference: AVAILABLE });
  expect(response.status).toBe(403);
});

it("refuses a version that is not available for this step", async () => {
  const response = await put({
    reference: { kind: "mount", name: "other", version: 9, digest: "e".repeat(64) },
  });
  expect(response.status).toBe(422);
});

it("refuses a body that is not a skill reference", async () => {
  const response = await put({ reference: { kind: "nonsense" } });
  expect(response.status).toBe(422);
});

it("rebinds the step and answers with the new binding", async () => {
  const { response, rpc } = await putCapturingRpc({ reference: AVAILABLE });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ binding: AVAILABLE });
  expect(rpc).toHaveBeenCalledWith(
    "rail_rebind_step",
    expect.objectContaining({ p_reference: AVAILABLE, p_source: "selection" }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/api/skill-binding-route.test.ts`
Expected: FAIL, the route module does not exist.

- [ ] **Step 3: Implement the route**

```ts
export async function PUT(request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;
  const body = (await request.json().catch(() => null)) as { reference?: unknown } | null;
  const reference = parseSkillReference(body?.reference);
  if (!reference) return jsonError('A skill reference is required', 422);

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) return jsonError('Forbidden', 403);

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  const step = await loadStepRow(auth.admin, deal.id, stepId);
  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
    assigned_to: (step?.assigned_to as string | null) ?? null,
    status: (step?.status as string) ?? 'pending',
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);
  if (!capabilities.canEditWork) return jsonError('Not permitted to change this step', 403);

  const available = await readStepVersions(auth.admin, deal, stepId);
  if (!isAvailable(available, reference)) {
    return jsonError('That version is not available for this step', 422);
  }

  const { error } = await auth.admin.rpc('rail_rebind_step', {
    p_deal_id: deal.id,
    p_actor_id: auth.user.id,
    p_deal_step_id: step.id,
    p_reference: reference,
    p_source: 'selection',
  });
  if (error) return jsonError('Unable to change this step version', 500);

  return NextResponse.json({ binding: reference });
}
```

Export `parseSkillReference`, `readStepVersions` and `isAvailable` from `src/lib/skillRun/versions.ts` so Task C6 reuses the same validation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/api/skill-binding-route.test.ts` then `npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-binding/route.ts" src/lib/skillRun/versions.ts tests/api/skill-binding-route.test.ts
git commit -m "feat(skill-runs): promote a chosen version to the step"
```

---

### Task C6: Run a one-off version on a chosen model

**Files:**
- Modify: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts`, `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts`, `src/lib/ignatious/bench.ts`, `src/lib/skillRun/parse.ts`
- Test: `tests/api/skill-run-stream.test.ts`, `tests/api/skill-run-records.test.ts`

**Interfaces:**
- Consumes: `parseSkillReference`, `readStepVersions`, `isAvailable` from Task C5; Ignatious's mount arm and model from Tasks I3 and I4.
- Produces: the stream route accepts `{ runId, version?, model? }`; the record route accepts `model` and the reference actually used. `startSkillRun` forwards `skill` as a `SkillReference` and `model`.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/skill-run-stream.test.ts`:

```ts
it("runs the step binding when no version is supplied", async () => {
  const { sent } = await postStream({ runId: RUN_ID });
  expect(sent.skill).toEqual({ kind: "publication", ...BINDING });
});

it("runs a supplied version without changing the binding", async () => {
  const { sent, rebinds } = await postStream({
    runId: RUN_ID,
    version: { kind: "mount", name: "demo", version: 3, digest: "d".repeat(64) },
  });
  expect(sent.skill).toEqual({ kind: "mount", name: "demo", version: 3, digest: "d".repeat(64) });
  expect(rebinds).toHaveLength(0);
});

it("refuses a version that is not available for this step", async () => {
  const response = await postStreamRaw({
    runId: RUN_ID,
    version: { kind: "mount", name: "other", version: 9, digest: "e".repeat(64) },
  });
  expect(response.status).toBe(422);
});

it("forwards the chosen model", async () => {
  const { sent } = await postStream({ runId: RUN_ID, model: "sonnet" });
  expect(sent.model).toBe("sonnet");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/api/skill-run-stream.test.ts`
Expected: FAIL. `version` and `model` are ignored and `sent.skill` has no `kind`.

- [ ] **Step 3: Accept the version and the model**

In the stream route, after resolving the runnable step:

```ts
const requested = body.version === undefined ? null : parseSkillReference(body.version);
if (body.version !== undefined && requested === null) {
  return jsonError('That version reference is not valid', 422);
}
if (requested) {
  const available = await readStepVersions(auth.admin, deal, stepId);
  if (!isAvailable(available, requested)) {
    return jsonError('That version is not available for this step', 422);
  }
}
const reference = requested ?? resolved.step.binding;
const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;
```

Pass `skill: reference` and `model` to `startSkillRun`, and drop the `{ kind: 'publication', ...binding }` spread, because `reference` already carries its kind.

- [ ] **Step 4: Record what actually ran**

In the record route and `src/lib/skillRun/parse.ts`, accept `reference` and `model` on the body and write `skill_id`/`version_id` or `mount_name`/`mount_version` accordingly, with `source: 'execution'`. Extend `SkillRunSummary.binding` to `SkillReference` and add `model: string | null`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/api/skill-run-stream.test.ts tests/api/skill-run-records.test.ts` then `npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts" "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts" src/lib/ignatious/bench.ts src/lib/skillRun/parse.ts src/lib/skillRun/types.ts tests/api/skill-run-stream.test.ts tests/api/skill-run-records.test.ts
git commit -m "feat(skill-runs): run a one-off version on a chosen model"
```

---

### Task C7: Open an enhancement draft

**Files:**
- Create: `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql`
- Modify: `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts`, `src/lib/skillAuthoring/browserResponse.ts`
- Test: `tests/api/skill-drafts-basis.test.ts`

**Interfaces:**
- Consumes: Task C2's columns, Task C3's resolver.
- Produces: `skill_authoring_get_or_create_draft(p_actor_id, p_deal_id, p_correlation_id, p_basis_deal_step_id, p_basis, p_seed_run_id)`. `POST /api/v1/deals/{dealId}/skill-drafts` accepts `{ basisStepId?, seedRunId? }`. The draft receipt gains `basis`, `basisStepId`, `seedRun`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/skill-drafts-basis.test.ts`:

```ts
it("creates a creation draft when no basis is given", async () => {
  const { response, rpc } = await postDraft({});
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith(
    "skill_authoring_get_or_create_draft",
    expect.objectContaining({ p_basis_deal_step_id: null, p_basis: null, p_seed_run_id: null }),
  );
});

it("carries the step binding and the seed run onto an enhancement draft", async () => {
  const { response, rpc } = await postDraft({ basisStepId: STEP_ID, seedRunId: RUN_ID });

  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith(
    "skill_authoring_get_or_create_draft",
    expect.objectContaining({
      p_basis_deal_step_id: DEAL_STEP_UUID,
      p_basis: { kind: "publication", ...BINDING },
      p_seed_run_id: RUN_ID,
    }),
  );
  await expect(response.json()).resolves.toMatchObject({
    basisStepId: DEAL_STEP_UUID,
    seedRun: { input: "Check Acme", output: "High confidence." },
  });
});

it("resumes the same draft for the same step", async () => {
  const first = await postDraft({ basisStepId: STEP_ID });
  const second = await postDraft({ basisStepId: STEP_ID });
  await expect(second.response.json()).resolves.toMatchObject({
    draftId: (await first.response.json()).draftId,
  });
});

it("refuses a step with no skill attached", async () => {
  const { response } = await postDraft({ basisStepId: STEP_ID }, { stepHasSkill: false });
  expect(response.status).toBe(409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/api/skill-drafts-basis.test.ts`
Expected: FAIL, the route ignores the body.

- [ ] **Step 3: Widen the RPC**

Create `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql` that drops and re-creates `skill_authoring_get_or_create_draft` with the three new parameters appended, matching the existing function body and adding `basis`, `basis_deal_step_id` and `seed_run_id` to the insert and to the lookup predicate. Drop the prior signature first so no overload is created, following the precedent commented in `20260716180000_deal_steps.sql`.

- [ ] **Step 4: Widen the route**

Read `{ basisStepId, seedRunId }` from the body, resolve the step with `resolveStepBinding`, answer 409 with "This step has no skill attached" when it does not resolve, read the seed run's `input` and `result_text` when `seedRunId` is present, and pass all three to the RPC. Add `basis`, `basisStepId` and `seedRun` to `normalizeReceipt` in `browserResponse.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run db:migrate` then `npm test -- tests/api/skill-drafts-basis.test.ts` then `npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql "src/app/api/v1/deals/[dealId]/skill-drafts/route.ts" src/lib/skillAuthoring/browserResponse.ts tests/api/skill-drafts-basis.test.ts
git commit -m "feat(authoring): open a draft based on an existing skill version"
```

---

### Task C8: Send the basis to the turn, and publish onto the lineage

**Files:**
- Modify: `src/lib/skillAuthoring/runTurn.ts`, `src/lib/skillAuthoring/ignatiousAuthoring.ts`, `src/lib/skillPublication/processorPrepare.ts`, `src/lib/skillPublication/processorAttach.ts`
- Test: `tests/skill-authoring-turn.test.ts`, `tests/skill-publication-attach.test.ts`

**Interfaces:**
- Consumes: Task C7's draft fields, Tasks I5 and I7.
- Produces: `TurnRequest` gains `basis: SkillReference | null` and `seedRun: { input: string; output: string } | null`. The prepare request gains `ancestorSkillId`. `skill_publication_attach` calls `rail_rebind_step` for a based operation.

- [ ] **Step 1: Write the failing test**

In `tests/skill-authoring-turn.test.ts`:

```ts
it("sends the basis and the seed run for an enhancement draft", async () => {
  const sent = await captureTurnRequest({
    draft: {
      basis: { kind: "publication", ...BINDING },
      basis_deal_step_id: DEAL_STEP_UUID,
      seed_run_id: RUN_ID,
    },
  });
  expect(sent).toMatchObject({
    basis: { kind: "publication", ...BINDING },
    seedRun: { input: "Check Acme", output: "High confidence." },
  });
});

it("sends both as null for a creation draft", async () => {
  const sent = await captureTurnRequest({ draft: { basis: null, basis_deal_step_id: null } });
  expect(sent).toMatchObject({ basis: null, seedRun: null });
});
```

In `tests/skill-publication-attach.test.ts`:

```ts
it("rebinds the basis step instead of inserting a new one", async () => {
  const { calls } = await attach({ draft: { basis_deal_step_id: DEAL_STEP_UUID } });
  expect(calls.map(call => call.name)).toEqual(["rail_rebind_step"]);
  expect(calls[0]?.args).toMatchObject({ p_source: "publication", p_deal_step_id: DEAL_STEP_UUID });
});

it("still inserts a step for a creation draft", async () => {
  const { calls } = await attach({ draft: { basis_deal_step_id: null } });
  expect(calls.map(call => call.name)).toEqual(["rail_insert_step"]);
});

it("reconciles when the basis step was rebound by someone else first", async () => {
  const result = await attach({
    draft: { basis_deal_step_id: DEAL_STEP_UUID, basis: { kind: "publication", ...BINDING } },
    currentBinding: { kind: "publication", skillId: BINDING.skillId, versionId: OTHER_VERSION, digest: "f".repeat(64) },
  });
  expect(result).toMatchObject({ state: "reconciling", statusCode: "receipt_conflict" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/skill-authoring-turn.test.ts tests/skill-publication-attach.test.ts`
Expected: FAIL. `TurnRequest` has no `basis`, and attach always inserts.

- [ ] **Step 3: Thread the basis through the turn**

Add `basis` and `seedRun` to `TurnRequest` in `ignatiousAuthoring.ts` and populate them in `runTurn.ts` from the draft row.

- [ ] **Step 4: Branch the attach**

Extend the `skill_publication_attach` function in a new migration `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql` so that when the operation's draft carries `basis_deal_step_id` it calls `rail_rebind_step(v_op.deal_id, v_op.actor_id, v_draft.basis_deal_step_id, <the published reference>, 'publication')` and sets `resulting_deal_step_id` to that step, instead of calling `rail_insert_step`. Keep every existing receipt check, and add one more before the rebind, because a based publication is the one case where the step can have moved underneath the draft:

```sql
if v_draft.basis_deal_step_id is not null then
  select to_jsonb(binding) into v_current
    from deal_step_skill_bindings binding
   where binding.deal_step_id = v_draft.basis_deal_step_id;

  -- The ancestor is what this candidate was built on. If somebody rebound the
  -- step while the draft was open, publishing would silently discard their
  -- choice, so this reconciles rather than overwrites.
  if v_current is not null and referenceOf(v_current) is distinct from v_draft.basis then
    return skill_publication_transition(p_publication_id, array['attaching'], 'reconciling',
      jsonb_build_object('statusCode', 'receipt_conflict'));
  end if;
end if;
```

Write `referenceOf(jsonb)` as a small `immutable` helper in the same migration that projects a binding row's jsonb onto the `{kind, skillId, versionId, digest}` or `{kind, name, version, digest}` reference shape, so the comparison is against the same shape the draft stored.

Send `ancestorSkillId` from `processorPrepare.ts` when the draft has a basis of kind `publication`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run db:migrate` then `npm test -- tests/skill-authoring-turn.test.ts tests/skill-publication-attach.test.ts` then `npm run test:integration`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql src/lib/skillAuthoring/runTurn.ts src/lib/skillAuthoring/ignatiousAuthoring.ts src/lib/skillPublication/processorPrepare.ts src/lib/skillPublication/processorAttach.ts tests/skill-authoring-turn.test.ts tests/skill-publication-attach.test.ts
git commit -m "feat(publication): publish a new version onto a step rather than a new step"
```

---

### Task C9: The dialog in enhancement mode

**Files:**
- Create: `src/components/rail/SkillBuilderBasisRow.tsx`
- Modify: `src/components/rail/SkillBuilderDialog.tsx`, `src/components/rail/SkillCandidatePreview.tsx`, `src/components/rail/SkillBuilderLauncher.tsx`
- Test: `tests/skill-builder-enhance.test.tsx`

**Interfaces:**
- Consumes: Task C7's receipt fields.
- Produces: `SkillBuilderDialog` accepts `basisStepId?: string` and `seedRunId?: string`. `SkillCandidatePreview` accepts `ancestor?: TurnCandidatePreview | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/skill-builder-enhance.test.tsx` asserting, with React Testing Library and the repository's existing dialog test harness: the header reads `Enhance skill`; the step name, phase and position controls are absent; the basis row names the step, the version and the seed run; the preview shows the ancestor value beside the candidate value for each of the four fields; the readiness chip reads `Ready to publish`; the footer primary reads `Publish and use on this step`; and in creation mode every one of those reverts to the shipped copy.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/skill-builder-enhance.test.tsx`
Expected: FAIL. The dialog renders `Skill builder` and the placement fields in both modes.

- [ ] **Step 3: Build the basis row**

Create `SkillBuilderBasisRow.tsx` rendering the step title, the version label with its author and date, and the attached run with a select that lists the step's other runs. Match the metadata row's existing grid and token classes so it occupies the same band.

- [ ] **Step 4: Branch the dialog**

In `SkillBuilderDialog.tsx`, derive `const enhancing = Boolean(basisStepId)` and swap the header text, the metadata row, the chip copy and the footer primary label on it. Render `SkillBuilderPlacementFields` only when not enhancing. Pass the ancestor preview to `SkillCandidatePreview`, which renders the ancestor value beneath each field label when present.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/skill-builder-enhance.test.tsx` then `npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/rail/SkillBuilderBasisRow.tsx src/components/rail/SkillBuilderDialog.tsx src/components/rail/SkillCandidatePreview.tsx src/components/rail/SkillBuilderLauncher.tsx tests/skill-builder-enhance.test.tsx
git commit -m "feat(rail): run the skill builder in enhancement mode"
```

---

### Task C10: The version control and the model select on the runner

**Files:**
- Create: `src/components/rail/StepVersionControl.tsx`
- Modify: `src/components/rail/SkillStepRunner.tsx`
- Test: `tests/skill-step-runner-versions.test.tsx`

**Interfaces:**
- Consumes: `StepVersions` from Task C4, the binding route from Task C5, the stream route from Task C6.
- Produces: `StepVersionControl` props `{ projectId, stepId, onEnhance(runId: string | null): void }`.

- [ ] **Step 1: Write the failing test**

Create `tests/skill-step-runner-versions.test.tsx` asserting: the control's value is the step's bound version with its author and date; the list is grouped `This project` and `Firm catalog`; a pruned catalog version is present and disabled with its reason; selecting a version and running sends that `version` on the stream request without calling the binding route; `Use on this step` calls `PUT .../skill-binding`; `Improve this skill` on a run calls back with that run id; and with no runs the same action calls back with null.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/skill-step-runner-versions.test.tsx`
Expected: FAIL. `SkillStepRunner` renders no version control.

- [ ] **Step 3: Build the control**

Create `StepVersionControl.tsx` fetching `GET .../skill-versions` on mount, rendering a grouped `<select>` with `<optgroup label="This project">` and `<optgroup label="Firm catalog">`, each option labelled `${label} · ${authorName ?? "unknown"} · ${date}` and disabled when `available` is false. When the selection differs from `current`, render the difference and a `Use on this step` button that PUTs the binding and refetches.

- [ ] **Step 4: Wire it into the runner**

Render the control and a model `<select>` above the input in `SkillStepRunner.tsx`. Send the selected reference as `version` and the alias as `model` on the stream request. Render `Improve this skill` on each run in the history and on the control when `runs.length === 0`, both calling `onEnhance`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/skill-step-runner-versions.test.tsx` then `npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/rail/StepVersionControl.tsx src/components/rail/SkillStepRunner.tsx tests/skill-step-runner-versions.test.tsx
git commit -m "feat(rail): select a skill version and a model on a step"
```

---

### Task C11: Import the bench replies, then converge on one runner

**Files:**
- Create: `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql`
- Modify: `src/components/rail/StationCard.tsx`, `src/components/rail/StepContract.tsx`, `src/components/rail/index.ts`
- Delete: `src/components/rail/BenchStepRunner.tsx`
- Test: `tests/api/import-bench-replies.integration.test.ts`, `tests/step-contract-runner.test.tsx`

**Interfaces:**
- Consumes: Tasks C2, C3, C6 and C10.
- Produces: catalog steps render `SkillStepRunner`. `BenchStepRunner` no longer exists.

This task keeps the migration and the convergence together deliberately: importing without converging leaves history nothing renders it, and converging without importing empties every catalog step's history.

- [ ] **Step 1: Write the failing migration test**

Create `tests/api/import-bench-replies.integration.test.ts`:

```ts
it("imports one run per catalog step that holds a bench reply", async () => {
  const { dealId, stepId } = await seedCatalogStepWithReply({
    input: "Check Acme",
    reply: "High confidence.",
    startedAt: "2026-09-01T10:00:00Z",
  });

  await runImportStatement();

  const { data } = await admin
    .from("deal_step_skill_runs").select("*").eq("deal_step_id", stepId);

  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({
    deal_id: dealId,
    source: "imported",
    input: "Check Acme",
    result_text: "High confidence.",
    outcome: "succeeded",
    skill_id: null,
    version_id: null,
    digest: null,
    actor_id: null,
  });
  expect(new Date(data[0].created_at).toISOString()).toBe("2026-09-01T10:00:00.000Z");
});

it("imports nothing for a step with no reply", async () => {
  const { stepId } = await seedCatalogStepWithReply({ input: null, reply: null, startedAt: null });
  await runImportStatement();
  const { data } = await admin
    .from("deal_step_skill_runs").select("id").eq("deal_step_id", stepId);
  expect(data).toEqual([]);
});

it("imports nothing a second time", async () => {
  const { stepId } = await seedCatalogStepWithReply({
    input: "Check Acme", reply: "High confidence.", startedAt: null,
  });
  await runImportStatement();
  await runImportStatement();
  const { data } = await admin
    .from("deal_step_skill_runs").select("id").eq("deal_step_id", stepId);
  expect(data).toHaveLength(1);
});
```

`runImportStatement` executes the same insert the migration holds, read from the migration file, so the test proves the shipped statement rather than a copy of it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- tests/api/import-bench-replies.integration.test.ts`
Expected: FAIL, no imported rows exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql` inserting one row per catalog step that holds a bench reply, guarded by `where not exists (select 1 from deal_step_skill_runs existing where existing.deal_step_id = deal_steps.id and existing.source = 'imported')` so it is safe to re-run. Read the reply and the input from the `work` jsonb keys the shipped `stepSkillIo.ts` writes; confirm those exact key names in that file before writing the SQL.

- [ ] **Step 4: Write the failing runner test**

Create `tests/step-contract-runner.test.tsx` asserting that a catalog step renders `SkillStepRunner` and that no `BenchStepRunner` output appears.

- [ ] **Step 5: Converge**

Replace every `BenchStepRunner` usage with `SkillStepRunner`, delete the component and its export from `index.ts`, and delete its test file. Stop writing `bench_conversation_id`, `bench_run_id`, `bench_run_status` and `bench_run_started_at`. Leave those columns in place; dropping them is out of scope.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run db:migrate` then `npm test` then `npm run test:integration` then `npm run lint`
Expected: PASS across the suites, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql src/components/rail/StationCard.tsx src/components/rail/StepContract.tsx src/components/rail/index.ts tests/api/import-bench-replies.integration.test.ts tests/step-contract-runner.test.tsx
git rm src/components/rail/BenchStepRunner.tsx
git commit -m "feat(rail): converge every skill-backed step on one runner"
```

---

### Task C12: The end-to-end journey

**Files:**
- Create: `e2e/journeys/skill-enhancement.spec.ts`

**Interfaces:**
- Consumes: every preceding task.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the spec**

Create `e2e/journeys/skill-enhancement.spec.ts` following `e2e/journeys/skill-run.spec.ts` exactly, including its programmatic API authentication that skips two-factor rather than driving the sign-in form. The journey: run a skill-backed step; open `Improve this skill` from that result; send one message; publish with `Publish and use on this step`; assert the step's version control now names the new version; run again and assert the result came from it; select the previous version and run once; assert the run history's newest entry names the previous version and that the step's bound version did not change; promote the previous version with `Use on this step` and assert the control's current value changed.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- e2e/journeys/skill-enhancement.spec.ts`
Expected: PASS against the local stack. Never run this against a hosted project.

- [ ] **Step 3: Commit**

```bash
git add e2e/journeys/skill-enhancement.spec.ts
git commit -m "test(skills): prove enhancement and version selection end to end"
```

---

### Task C13: Record the vocabulary

**Files:**
- Modify: `CONTEXT.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Add the four new terms**

Append to `CONTEXT.md`, in the existing definition style: **Skill lineage**, **Enhancement draft**, **Draft basis**, **Catalog fork**, with the definitions given in the spec's Vocabulary section. Amend the existing **Skill binding** entry to say it is re-pointable, lives in `deal_step_skill_bindings`, and may name a firm-catalog version as well as a publication.

- [ ] **Step 2: Update the status lines**

Add a dated entry to `README.md` and to the Conductia `CLAUDE.md` recording that a step's skill version is selectable and that skills are enhanced in place through the builder, with the flag it sits behind.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md README.md CLAUDE.md
git commit -m "docs(skills): name the lineage, the basis and the catalog fork"
```

---

## Verification before the pull requests

- [ ] Ignatious: `npm test` and `npm run typecheck` from `platform/apps/skill-bench`, both clean.
- [ ] Conductia: `npm test`, `npm run test:integration`, `npm run lint`, `npm run build`, all clean.
- [ ] Conductia: `npm run test:e2e`, clean, against the local stack.
- [ ] Real-browser validation with seeded credentials against the local stack: open a project rail, run a step, improve its skill, publish, select an older version, run it, promote it. Confirm the audit trail shows one `rail.step_rebound` per rebind and none per one-off run.
- [ ] Confirm no command in this branch ever pointed at a hosted Supabase project.
