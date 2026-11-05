# Skill Run Execution and Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a published, version-pinned custom rail step runnable from its single text input, keep every run and its result, and file generated documents onto the deal with run provenance.

**Architecture:** The browser holds the run, as the shipped catalog-step runner already does. Conductia proxies a Server-Sent Events stream from Ignatious and writes one row only when the run ends. Ignatious executes the exact published package bytes in a per-run skill root, reusing the existing turn machinery by cloning the bench config rather than by adding a second execution engine.

**Tech Stack:** Conductia is Next.js 16 App Router, TypeScript, Supabase Postgres, Vitest with React Testing Library, Playwright. Ignatious is Node with Hono, Mastra, Postgres, Vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-14-skill-run-execution-and-results-design.md`

## Global Constraints

- Parts A, B and C must be merged before this work starts. The integrated branches are `project-rail-model-impl`, `durable-skill-authoring-implementation` and `skill-publication-and-rail-insertion` in both repositories.
- No code comments in Conductia. The repository rule is absolute and covers explanatory prose and JSDoc blocks. In Ignatious, follow the convention of the file being edited.
- No em dash characters anywhere: documents, code, or visible copy.
- Never point a dev server, a migration, a seed or a test at a hosted Supabase project. Everything here runs against a local stack.
- Stage explicit file paths in every commit. Never `git add -A` or `git add .`.
- The feature flag is `skill_authoring`, already registered in `src/lib/flags/keys.ts`. Part D adds no new flag.
- Conductia unit and route tests: `npm test`. Integration tests: `npm run test:integration`. SQL probes: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <file>` against the local stack.
- Ignatious tests: `pnpm --filter @ignatious/skill-bench test` from `platform/`.
- The run id is a v4 UUID minted by the browser. It is the primary key of the run row, the workspace key on the Ignatious side, and the `x-conductia-run-id` scope header value.
- The binding triple (`skillId`, `versionId`, `digest`) is always read server-side from `deal_steps.definition`. A client-supplied version is ignored, never trusted.

---

## File Structure

**Ignatious (`platform/apps/skill-bench/src/`)**

| File | Responsibility |
|---|---|
| `authoring/publication/store.ts` | Add `PublishedPackage` and the read-by-version method to the store interface |
| `authoring/publication/postgres-publication-store.ts` | Implement that read, returning `package_bytes` |
| `authoring/execution/run-root.ts` | Verify the digest, unpack the package into a per-run skill root, and remove it |
| `authoring/execution/execution-route.ts` | `POST /skill-runs`: validate, resolve, unpack, run the turn, stream, clean up |
| `authoring/execution/execution-config.ts` | Whether execution is serviceable, derived from the publication config |
| `authoring/publication/mount.ts` | Mount the execution route beside the publication routes |

**Conductia (`src/`)**

| File | Responsibility |
|---|---|
| `supabase/migrations/20260916130000_deal_step_skill_runs.sql` | The run table, its policies and triggers, and the document provenance column |
| `lib/skillRun/types.ts` | Run record and history types shared by routes and client |
| `lib/skillRun/parse.ts` | Parse and validate the record request body |
| `lib/skillRun/step.ts` | Resolve a deal step row into a runnable binding and saved input |
| `lib/ignatious/bench.ts` | Add `startSkillRun` to the bench client |
| `app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts` | Start a run and proxy the stream |
| `app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts` | Record a terminal run, and read history |
| `lib/dataroom/steps.ts` | A title parameter on `provisionDataroomFolder` for a step the census does not know |
| `app/v1/leads/[leadId]/documents/route.ts` | File a run's document against the run's own step, with run provenance |
| `components/rail/SkillStepRunner.tsx` | The input, the streamed result, the history and the failure states |
| `components/rail/StationCard.tsx` | Compose the runner into `CustomStepPanel` |

---

## Task 1: Read a published package by skill and version

**Files:**
- Modify: `platform/apps/skill-bench/src/authoring/publication/store.ts`
- Modify: `platform/apps/skill-bench/src/authoring/publication/postgres-publication-store.ts`
- Test: `platform/apps/skill-bench/src/authoring/publication/postgres-store.integration.test.ts`

**Interfaces:**
- Consumes: the existing `skill_publications` table from migration `002_skill_publication.sql`.
- Produces: `PublishedPackage = { readonly skillId: string; readonly versionId: string; readonly digest: string; readonly projectId: string; readonly packageBytes: Buffer }` and `PostgresPublicationRecordStore.readPublishedPackage(skillId: string, versionId: string): Promise<PublishedPackage | null>`.

- [ ] **Step 1: Write the failing test**

Append to `postgres-store.integration.test.ts`, inside the existing describe that has a live pool:

```ts
it('reads a published package by skill and version', async () => {
  const saved = await seedPublication(store, { packageBytes: Buffer.from('zip-bytes') });

  const found = await store.readPublishedPackage(saved.skillId, saved.versionId);

  expect(found).not.toBeNull();
  expect(found?.digest).toBe(saved.digest);
  expect(found?.projectId).toBe(saved.projectId);
  expect(found?.packageBytes.equals(Buffer.from('zip-bytes'))).toBe(true);
});

it('reads nothing for a version that belongs to another skill', async () => {
  const first = await seedPublication(store, { packageBytes: Buffer.from('a') });
  const second = await seedPublication(store, { packageBytes: Buffer.from('b') });

  expect(await store.readPublishedPackage(first.skillId, second.versionId)).toBeNull();
});
```

If `seedPublication` does not already exist in that file, add it beside the other helpers, building on the fixtures the file already imports:

```ts
async function seedPublication(
  store: PostgresPublicationRecordStore,
  overrides: { packageBytes: Buffer },
): Promise<StoredPublication & { packageBytes: Buffer }> {
  const input = publicationInput({ packageBytes: overrides.packageBytes });
  const stored = await store.savePublication(input);
  return { ...stored, packageBytes: overrides.packageBytes };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench test postgres-store.integration`
Expected: FAIL with `store.readPublishedPackage is not a function`.

- [ ] **Step 3: Add the type to the store interface**

In `store.ts`, beside `StoredPublication`:

```ts
export interface PublishedPackage {
  readonly skillId: string;
  readonly versionId: string;
  readonly digest: string;
  readonly projectId: string;
  readonly packageBytes: Buffer;
}
```

- [ ] **Step 4: Implement the read**

In `postgres-publication-store.ts`, add to `PostgresPublicationRecordStore`:

```ts
async readPublishedPackage(
  skillId: string,
  versionId: string,
): Promise<PublishedPackage | null> {
  const result = await this.#pool.query<PublishedPackageRow>(
    `SELECT skill_id, version_id, digest, project_id, package_bytes
       FROM ${this.#schema}.skill_publications
      WHERE skill_id = $1 AND version_id = $2`,
    [skillId, versionId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    skillId: row.skill_id,
    versionId: row.version_id,
    digest: row.digest,
    projectId: row.project_id,
    packageBytes: Buffer.from(row.package_bytes),
  };
}
```

with the row type beside `PublicationRow`:

```ts
interface PublishedPackageRow {
  readonly skill_id: string;
  readonly version_id: string;
  readonly digest: string;
  readonly project_id: string;
  readonly package_bytes: Buffer;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @ignatious/skill-bench test postgres-store.integration`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/publication/store.ts \
        platform/apps/skill-bench/src/authoring/publication/postgres-publication-store.ts \
        platform/apps/skill-bench/src/authoring/publication/postgres-store.integration.test.ts
git commit -m "feat(skill-bench): read a published package by skill and version"
```

---

## Task 2: Unpack a published package into a per-run skill root

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/execution/run-root.ts`
- Test: `platform/apps/skill-bench/src/authoring/execution/run-root.test.ts`

**Interfaces:**
- Consumes: `PublishedPackage` from Task 1, `ensureStore` and `skillPath` from `../../skill-store.js`, `zipSkillFolder` from `../../skill-zip.js` for the test fixture.
- Produces:
  - `DigestMismatch` (an `Error` subclass),
  - `openRunRoot(root: string, runId: string, published: PublishedPackage): Promise<{ readonly directory: string; readonly skillName: string }>`,
  - `closeRunRoot(directory: string): Promise<void>`.

The unpacked layout is `<root>/<runId>/skills/<skillName>/SKILL.md`, which is the layout `listSkills` and `skillPath` already expect, so a cloned config pointed at `<root>/<runId>` mounts exactly this one skill.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { zipSkillFolder } from '../../skill-zip.js';
import { listSkills } from '../../skill-store.js';
import { closeRunRoot, DigestMismatch, openRunRoot } from './run-root.js';

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const scratches: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'run-root-'));
  scratches.push(directory);
  return directory;
}

function packageFor(name: string, body: string): { bytes: Buffer; digest: string } {
  const folder = join(process.env.TMPDIR ?? '/tmp', `pkg-${name}-${String(Date.now())}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), body);
  const bytes = Buffer.from(zipSkillFolder(folder, name));
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

const SKILL_MD = ['---', 'name: weekly-update', 'description: "Writes an update"', '---', '', 'Do the thing.'].join('\n');

afterEach(async () => {
  for (const directory of scratches.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('openRunRoot', () => {
  it('unpacks the package so the store lists exactly that skill', async () => {
    const root = await scratch();
    const built = packageFor('weekly-update', SKILL_MD);

    const opened = await openRunRoot(root, RUN_ID, {
      skillId: 'skill-1',
      versionId: 'version-1',
      digest: built.digest,
      projectId: 'project-1',
      packageBytes: built.bytes,
    });

    expect(opened.skillName).toBe('weekly-update');
    expect(listSkills(opened.directory).map(skill => skill.name)).toEqual(['weekly-update']);
    expect(await readFile(join(opened.directory, 'skills', 'weekly-update', 'SKILL.md'), 'utf8')).toContain('Do the thing.');
  });

  it('refuses a package whose bytes do not hash to the recorded digest', async () => {
    const root = await scratch();
    const built = packageFor('weekly-update', SKILL_MD);

    await expect(
      openRunRoot(root, RUN_ID, {
        skillId: 'skill-1',
        versionId: 'version-1',
        digest: 'f'.repeat(64),
        projectId: 'project-1',
        packageBytes: built.bytes,
      }),
    ).rejects.toBeInstanceOf(DigestMismatch);

    expect(existsSync(join(root, RUN_ID))).toBe(false);
  });

  it('removes the run root', async () => {
    const root = await scratch();
    const built = packageFor('weekly-update', SKILL_MD);
    const opened = await openRunRoot(root, RUN_ID, {
      skillId: 'skill-1',
      versionId: 'version-1',
      digest: built.digest,
      projectId: 'project-1',
      packageBytes: built.bytes,
    });

    await closeRunRoot(opened.directory);

    await expect(stat(opened.directory)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench test run-root`
Expected: FAIL, cannot resolve `./run-root.js`.

- [ ] **Step 3: Implement the module**

```ts
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

import { unzipSync } from 'fflate';

import { ensureStore, skillPath } from '../../skill-store.js';
import type { PublishedPackage } from '../publication/store.js';

export class DigestMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestMismatch';
  }
}

export interface OpenedRunRoot {
  readonly directory: string;
  readonly skillName: string;
}

export async function openRunRoot(
  root: string,
  runId: string,
  published: PublishedPackage,
): Promise<OpenedRunRoot> {
  const actual = createHash('sha256').update(published.packageBytes).digest('hex');
  if (actual !== published.digest) {
    throw new DigestMismatch(
      `published package ${published.versionId} hashes to ${actual}, not ${published.digest}`,
    );
  }

  const entries = unzipSync(new Uint8Array(published.packageBytes));
  const names = Object.keys(entries).filter(name => !name.endsWith('/'));
  const skillName = rootFolderOf(names);
  if (skillName === null) throw new DigestMismatch('published package has no single skill folder');

  const directory = join(root, runId);
  ensureStore(directory);
  const target = skillPath(directory, skillName);

  try {
    for (const name of names) {
      const relative = name.slice(skillName.length + 1);
      const destination = join(target, relative);
      if (!normalize(destination).startsWith(normalize(target))) {
        throw new DigestMismatch(`published package entry escapes its folder: ${name}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(entries[name] as Uint8Array));
    }
  } catch (error) {
    await closeRunRoot(directory);
    throw error;
  }

  return { directory, skillName };
}

export function closeRunRoot(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true });
}

function rootFolderOf(names: readonly string[]): string | null {
  const folders = new Set(names.map(name => name.split('/')[0] ?? ''));
  if (folders.size !== 1) return null;
  const only = [...folders][0] ?? '';
  return only === '' ? null : only;
}
```

On the digest failure path the run root is removed before the throw, which is what the second test asserts.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ignatious/skill-bench test run-root`
Expected: PASS, three tests.

- [ ] **Step 5: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/execution/run-root.ts \
        platform/apps/skill-bench/src/authoring/execution/run-root.test.ts
git commit -m "feat(skill-bench): unpack a published package into a per-run skill root"
```

---

## Task 3: The execution route

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/execution/execution-route.ts`
- Test: `platform/apps/skill-bench/src/authoring/execution/execution-route.test.ts`

**Interfaces:**
- Consumes: `openRunRoot`, `closeRunRoot`, `DigestMismatch` from Task 2; `PostgresPublicationRecordStore.readPublishedPackage` from Task 1; `sseStream` from `../../sse.js`; `runTurn` from `../../session.js`; `fail` from `../publication/routes-http.js`.
- Produces: `mountSkillRuns(app: Hono, deps: SkillRunDeps | null, logger?: Logger): void` and

```ts
export interface SkillRunDeps {
  readonly config: ChatConfig;
  readonly executionRoot: string;
  readPublishedPackage(skillId: string, versionId: string): Promise<PublishedPackage | null>;
  runTurn?: typeof runTurn;
}
```

`runTurn` is injectable so a test can assert what the turn was built with without a model. `deps === null` means execution is not serviceable and every call answers `503`.

The route mounts at `/skill-runs` on the app the bench already base-paths at `/v1/bench`, giving `POST /v1/bench/skill-runs`.

**Why the turn is `runTurn` and not a second engine:** `mountedSkills(config, leadId)` reads `listSkills(config.skillsRoot)` and makes each path relative to `config.skillsBase`. Cloning the config with both pointed at the run root therefore mounts exactly the unpacked skill, with no change to `session.ts` or `turn-agent.ts`. `workspaceRoot` is deliberately not cloned: the daily spend ledger lives there, and a per-run workspace root would give every run its own daily ceiling. The per-run ceiling comes for free from the same reuse: `spend.ts` keys a conversation's ledger on the conversation id, which here is the run id, so one run is bounded exactly as one chat thread is, with nothing new written.

- [ ] **Step 1: Write the failing test**

```ts
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { zipSkillFolder } from '../../skill-zip.js';
import { mountSkillRuns } from './execution-route.js';

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const SKILL_MD = ['---', 'name: weekly-update', 'description: "Writes an update"', '---', '', 'Do the thing.'].join('\n');
const scratches: string[] = [];

afterEach(async () => {
  for (const directory of scratches.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'skill-run-'));
  scratches.push(directory);
  return directory;
}

function built(): { bytes: Buffer; digest: string } {
  const folder = join(tmpdir(), `pkg-${String(Date.now())}-${String(Math.random()).slice(2)}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), SKILL_MD);
  const bytes = Buffer.from(zipSkillFolder(folder, 'weekly-update'));
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: RUN_ID,
    skill: { kind: 'publication', skillId: 'skill-1', versionId: 'version-1', digest: 'a'.repeat(64) },
    input: 'Summarise the week',
    tenantId: 'tenant-1',
    leadId: 'lead-1',
    token: 'jwt',
    ...overrides,
  });
}

function post(app: Hono, payload: string): Promise<Response> {
  return app.request('/skill-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
}

describe('POST /skill-runs', () => {
  it('answers 503 when execution is not serviceable', async () => {
    const app = new Hono();
    mountSkillRuns(app, null);

    expect((await post(app, body())).status).toBe(503);
  });

  it('refuses a body that is not a publication-addressed run', async () => {
    const app = new Hono();
    mountSkillRuns(app, {
      config: { skillsRoot: '/unused', skillsBase: '/unused' } as never,
      executionRoot: await scratch(),
      readPublishedPackage: async () => null,
    });

    const response = await post(app, body({ skill: { kind: 'mount', name: 'weekly-update' } }));
    expect(response.status).toBe(422);
  });

  it('answers 404 when the version is not published', async () => {
    const app = new Hono();
    mountSkillRuns(app, {
      config: { skillsRoot: '/unused', skillsBase: '/unused' } as never,
      executionRoot: await scratch(),
      readPublishedPackage: async () => null,
    });

    expect((await post(app, body())).status).toBe(404);
  });

  it('refuses bytes that do not match the recorded digest', async () => {
    const made = built();
    const app = new Hono();
    mountSkillRuns(app, {
      config: { skillsRoot: '/unused', skillsBase: '/unused' } as never,
      executionRoot: await scratch(),
      readPublishedPackage: async () => ({
        skillId: 'skill-1',
        versionId: 'version-1',
        digest: 'b'.repeat(64),
        projectId: 'project-1',
        packageBytes: made.bytes,
      }),
    });

    expect((await post(app, body({ skill: { kind: 'publication', skillId: 'skill-1', versionId: 'version-1', digest: 'b'.repeat(64) } }))).status).toBe(500);
  });

  it('runs the turn against a config mounted on the run root, and cleans up', async () => {
    const made = built();
    const executionRoot = await scratch();
    const seen: { request?: Record<string, unknown>; skillsRoot?: string } = {};
    const app = new Hono();

    mountSkillRuns(app, {
      config: { skillsRoot: '/shared/store', skillsBase: '/shared', workspaceRoot: '/workspace' } as never,
      executionRoot,
      readPublishedPackage: async () => ({
        skillId: 'skill-1',
        versionId: 'version-1',
        digest: made.digest,
        projectId: 'project-1',
        packageBytes: made.bytes,
      }),
      runTurn: (async function* (request, options) {
        seen.request = request as unknown as Record<string, unknown>;
        seen.skillsRoot = (options.config as unknown as { skillsRoot: string }).skillsRoot;
        yield { event: { type: 'text', text: 'done' }, at: 0 } as never;
      }) as never,
    });

    const response = await post(app, body({ skill: { kind: 'publication', skillId: 'skill-1', versionId: 'version-1', digest: made.digest } }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('"text":"done"');
    expect(seen.request?.conversationId).toBe(RUN_ID);
    expect(seen.request?.message).toBe('Summarise the week');
    expect(seen.request?.selection).toBeNull();
    expect(seen.skillsRoot).toBe(join(executionRoot, RUN_ID));
    expect(await import('node:fs').then(fs => fs.existsSync(join(executionRoot, RUN_ID)))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench test execution-route`
Expected: FAIL, cannot resolve `./execution-route.js`.

- [ ] **Step 3: Implement the route**

```ts
import { nullLogger, type Logger } from '@ignatious/agent-runtime';
import type { Hono } from 'hono';
import { z } from 'zod';

import { sseStream } from '../../sse.js';
import { runTurn as defaultRunTurn } from '../../session.js';
import type { ChatConfig } from '../../config.js';
import type { PositionedEvent } from '../../session.js';
import { fail } from '../publication/routes-http.js';
import type { PublishedPackage } from '../publication/store.js';
import { closeRunRoot, DigestMismatch, openRunRoot } from './run-root.js';

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const RequestSchema = z
  .object({
    runId: z.string().uuid(),
    skill: z
      .object({
        kind: z.literal('publication'),
        skillId: z.string().uuid(),
        versionId: z.string().uuid(),
        digest: DigestSchema,
      })
      .strict(),
    input: z.string().trim().min(1).max(20_000),
    tenantId: z.string().trim().min(1),
    leadId: z.string().trim().min(1),
    token: z.string().trim().min(1).nullable().optional(),
    conductiaBaseUrl: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export interface SkillRunDeps {
  readonly config: ChatConfig;
  readonly executionRoot: string;
  readPublishedPackage(skillId: string, versionId: string): Promise<PublishedPackage | null>;
  readonly runTurn?: typeof defaultRunTurn;
}

export function mountSkillRuns(
  app: Hono,
  deps: SkillRunDeps | null,
  logger: Logger = nullLogger,
): void {
  app.post('/skill-runs', async c => {
    if (deps === null) return fail(c, 'capability_unavailable', 'skill execution is not configured');

    const parsed = RequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'validation', 'skill run request was not valid');

    const { runId, skill, input, tenantId, leadId } = parsed.data;
    const published = await deps.readPublishedPackage(skill.skillId, skill.versionId);
    if (published === null || published.digest !== skill.digest) {
      return fail(c, 'not_found', `no published version ${skill.versionId}`);
    }

    let opened;
    try {
      opened = await openRunRoot(deps.executionRoot, runId, published);
    } catch (error) {
      if (error instanceof DigestMismatch) {
        logger.error('skill run refused', { runId, versionId: skill.versionId });
        return fail(c, 'server_error', 'the published package could not be verified');
      }
      throw error;
    }

    const turn = deps.runTurn ?? defaultRunTurn;
    const events = withCleanup(
      turn(
        {
          tenantId,
          leadId,
          message: input,
          conversationId: runId,
          selection: null,
          model: null,
          token: parsed.data.token ?? null,
          userEmail: null,
          conductiaBaseUrl: parsed.data.conductiaBaseUrl ?? null,
        },
        {
          config: { ...deps.config, skillsRoot: opened.directory, skillsBase: opened.directory },
          logger,
        },
      ),
      () => closeRunRoot(opened.directory),
    );

    return new Response(sseStream(events), {
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

async function* withCleanup(
  events: AsyncIterable<PositionedEvent>,
  cleanup: () => Promise<void>,
): AsyncGenerator<PositionedEvent> {
  try {
    for await (const event of events) yield event;
  } finally {
    await cleanup();
  }
}
```

If `PositionedEvent` is not exported from `session.ts`, export the existing type rather than redeclaring it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ignatious/skill-bench test execution-route`
Expected: PASS, five tests.

- [ ] **Step 5: Run the whole bench suite**

Run: `pnpm --filter @ignatious/skill-bench test`
Expected: PASS. The route is additive, so nothing else should move.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/execution/execution-route.ts \
        platform/apps/skill-bench/src/authoring/execution/execution-route.test.ts
git commit -m "feat(skill-bench): execute a pinned published skill version"
```

---

## Task 4: Mount the execution route and configure it

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/execution/execution-config.ts`
- Modify: `platform/apps/skill-bench/src/authoring/publication/mount.ts`
- Modify: `platform/.env.example`, `platform/README.md`
- Test: `platform/apps/skill-bench/src/authoring/execution/execution-config.test.ts`, `platform/apps/skill-bench/src/authoring/publication/mount.test.ts`

**Interfaces:**
- Consumes: `PublicationConfig` from `../publication/config.js`, `mountSkillRuns` from Task 3.
- Produces: `executionRootFor(config: ChatConfig, env: NodeJS.ProcessEnv): string` and the wiring inside `openPublicationRoutes`, which already owns the pool and the store.

Execution is serviceable exactly when publication is: both read the same table in the same database. There is no second switch to get out of step with.

- [ ] **Step 1: Write the failing config test**

```ts
import { describe, expect, it } from 'vitest';

import { executionRootFor } from './execution-config.js';

describe('executionRootFor', () => {
  it('defaults to a skill-runs directory beside the workspace', () => {
    const root = executionRootFor({ workspaceRoot: '/data/workspaces' } as never, {});
    expect(root).toBe('/data/workspaces/skill-runs');
  });

  it('honours an explicit root', () => {
    const root = executionRootFor({ workspaceRoot: '/data/workspaces' } as never, {
      SKILL_BENCH_EXECUTION_ROOT: '/mnt/runs',
    });
    expect(root).toBe('/mnt/runs');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench test execution-config`
Expected: FAIL, cannot resolve `./execution-config.js`.

- [ ] **Step 3: Implement it**

```ts
import { join } from 'node:path';

import type { ChatConfig } from '../../config.js';

export function executionRootFor(config: ChatConfig, env: NodeJS.ProcessEnv): string {
  const explicit = env['SKILL_BENCH_EXECUTION_ROOT']?.trim();
  return explicit !== undefined && explicit !== '' ? explicit : join(config.workspaceRoot, 'skill-runs');
}
```

- [ ] **Step 4: Write the failing mount test**

Add to `mount.test.ts`:

```ts
it('answers 503 on a skill run when publication is not serviceable', async () => {
  const mounted = openPublicationRoutes({ serviceable: false, reason: 'authoring disabled' });

  const response = await mounted.routes.request('/v1/bench/skill-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  expect(response.status).toBe(503);
  await mounted.close();
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter @ignatious/skill-bench test mount`
Expected: FAIL with 404, because no such route is mounted.

- [ ] **Step 6: Wire the route into the mount**

In `mount.ts`, extend `openPublicationRoutes` to take the bench config and the environment, and mount the run route on the same Hono instance the publication routes use, both in the serviceable and the unavailable branch:

```ts
export function openPublicationRoutes(
  settings: PublicationConfig,
  logger: Logger = nullLogger,
  bench?: { readonly config: ChatConfig; readonly env: NodeJS.ProcessEnv },
): MountedPublicationRoutes {
  if (!settings.serviceable) {
    const routes = unavailablePublicationRoutes(logger);
    mountSkillRuns(routes, null, logger);
    return { routes, close: () => Promise.resolve() };
  }
  const pool = createPool(settings.databaseUrl, { options: `-c search_path=${settings.schema}` });
  const store = new PostgresPublicationStore(pool, settings.schema);
  const candidates = new PostgresCandidateStore(pool, settings.schema);
  const service = createPublicationService({ store, candidates });
  const routes = createPublicationRoutes(service, { expectedToken: () => settings.token, logger });
  if (bench !== undefined) {
    mountSkillRuns(
      routes,
      {
        config: bench.config,
        executionRoot: executionRootFor(bench.config, bench.env),
        readPublishedPackage: (skillId, versionId) => store.readPublishedPackage(skillId, versionId),
      },
      logger,
    );
  }
  return { routes, close: () => pool.end() };
}
```

`unavailablePublicationRoutes` currently claims every path under its base with `app.all('*')`. Mount the run route before that catch-all, or move the catch-all registration after it, so the run route's own `503` shape is the one returned.

Pass the bench config and `process.env` from the composition site in `main.ts` where `openPublicationRoutes` is already called.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @ignatious/skill-bench test mount execution-config`
Expected: PASS.

- [ ] **Step 8: Document the variable**

Add to `platform/.env.example`:

```
SKILL_BENCH_EXECUTION_ROOT=
```

and one line to the skill-bench section of `platform/README.md` saying that `POST /v1/bench/skill-runs` executes a published version, that it is serviceable exactly when publication is, and that `SKILL_BENCH_EXECUTION_ROOT` defaults to `skill-runs` under the workspace root.

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm --filter @ignatious/skill-bench test`

```bash
git add platform/apps/skill-bench/src/authoring/execution/execution-config.ts \
        platform/apps/skill-bench/src/authoring/execution/execution-config.test.ts \
        platform/apps/skill-bench/src/authoring/publication/mount.ts \
        platform/apps/skill-bench/src/authoring/publication/mount.test.ts \
        platform/apps/skill-bench/src/main.ts \
        platform/.env.example platform/README.md
git commit -m "feat(skill-bench): mount and configure the skill run route"
```

---

## Task 5: The run table and the document provenance column

**Files:**
- Create: `supabase/migrations/20260916130000_deal_step_skill_runs.sql`
- Create: `supabase/tests/deal_step_skill_runs.sql`
- Modify: `src/lib/constants/tables.ts`

**Interfaces:**
- Produces: the `deal_step_skill_runs` table, `documents.step_skill_run_id`, and `TABLE.DEAL_STEP_SKILL_RUNS = 'deal_step_skill_runs'`.

- [ ] **Step 1: Write the failing probe**

`supabase/tests/deal_step_skill_runs.sql`:

```sql
-- supabase/tests/deal_step_skill_runs.sql
-- Verifies the run record: shape, policy, immutability. Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/deal_step_skill_runs.sql
-- Wrapped in a transaction that always ROLLBACKs.

begin;

do $$
begin
  perform 1 from information_schema.tables where table_name = 'deal_step_skill_runs';
  if not found then raise exception 'FAIL: deal_step_skill_runs missing'; end if;

  perform 1 from information_schema.columns
    where table_name = 'documents' and column_name = 'step_skill_run_id';
  if not found then raise exception 'FAIL: documents.step_skill_run_id missing'; end if;

  raise notice 'OK: skill run schema';
end $$;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_deal   uuid := gen_random_uuid();
  v_step   uuid := gen_random_uuid();
  v_run    uuid := gen_random_uuid();
  v_failed boolean;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'md@example.test', '{}'::jsonb);
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'Bank', 'bank');
  insert into users (id, company_id, email, full_name)
    values (v_md, v_bank, 'md@example.test', 'MD');
  insert into deals (id, tenant_id, bank_id, code, codename, target_name)
    values (v_deal, v_tenant, v_bank, 'RUN-2026-001', 'Run', 'Target');
  insert into deal_steps (id, deal_id, step_id, seq, status, origin)
    values (v_step, v_deal, 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6', null, 'pending', 'custom');

  insert into deal_step_skill_runs
    (id, deal_id, deal_step_id, actor_id, skill_id, version_id, digest, input, outcome, result_text)
  values
    (v_run, v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
     repeat('a', 64), 'the input', 'succeeded', 'the result');

  begin
    update deal_step_skill_runs set result_text = 'tampered' where id = v_run;
    raise exception 'FAIL: a run record accepted an update';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    delete from deal_step_skill_runs where id = v_run;
    raise exception 'FAIL: a run record accepted a delete';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  v_failed := false;
  begin
    insert into deal_step_skill_runs
      (id, deal_id, deal_step_id, actor_id, skill_id, version_id, digest, input, outcome)
    values
      (gen_random_uuid(), v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
       repeat('a', 64), 'the input', 'succeeded');
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: a succeeded run was stored with no result text'; end if;

  v_failed := false;
  begin
    insert into deal_step_skill_runs
      (id, deal_id, deal_step_id, actor_id, skill_id, version_id, digest, input, outcome, result_text)
    values
      (gen_random_uuid(), v_deal, v_step, v_md, gen_random_uuid(), gen_random_uuid(),
       'not-a-digest', 'the input', 'succeeded', 'r');
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: a malformed digest was stored'; end if;

  raise notice 'OK: skill run records';
end $$;

rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/deal_step_skill_runs.sql`
Expected: FAIL with `FAIL: deal_step_skill_runs missing`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260916130000_deal_step_skill_runs.sql`:

```sql
-- One terminal record per skill run on a project rail step, plus the document
-- provenance that links a filed document back to the run that produced it.
-- Written only when a run ends: a run held by a closed browser tab leaves no row.

create table if not exists deal_step_skill_runs (
  id              uuid primary key,
  deal_id         uuid not null references deals (id) on delete cascade,
  deal_step_id    uuid not null references deal_steps (id),
  actor_id        uuid not null references users (id),
  skill_id        uuid not null,
  version_id      uuid not null,
  digest          text not null check (digest ~ '^[0-9a-f]{64}$'),
  input           text not null,
  outcome         text not null check (outcome in ('succeeded','failed')),
  result_text     text,
  error_message   text,
  provider_run_id text,
  cost_usd        numeric,
  started_at      timestamptz,
  created_at      timestamptz not null default now(),
  check ((outcome = 'succeeded') = (result_text is not null))
);

create index if not exists deal_step_skill_runs_step_idx
  on deal_step_skill_runs (deal_step_id, created_at desc);

alter table deal_step_skill_runs enable row level security;

grant select, insert on deal_step_skill_runs to service_role;
grant select on deal_step_skill_runs to authenticated;

drop policy if exists deal_step_skill_runs_select on deal_step_skill_runs;
create policy deal_step_skill_runs_select on deal_step_skill_runs for select to authenticated
  using (app_is_deal_member(deal_id, auth.uid()) or app_is_overseer(auth.uid()));

create or replace function deal_step_skill_runs_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'deal_step_skill_runs rows are immutable';
end $$;

drop trigger if exists deal_step_skill_runs_no_update on deal_step_skill_runs;
create trigger deal_step_skill_runs_no_update
  before update on deal_step_skill_runs
  for each row execute function deal_step_skill_runs_immutable();

drop trigger if exists deal_step_skill_runs_no_delete on deal_step_skill_runs;
create trigger deal_step_skill_runs_no_delete
  before delete on deal_step_skill_runs
  for each row execute function deal_step_skill_runs_immutable();

alter table documents
  add column if not exists step_skill_run_id uuid;

create index if not exists documents_step_skill_run_idx
  on documents (step_skill_run_id) where step_skill_run_id is not null;
```

There is deliberately no foreign key on `documents.step_skill_run_id`: a document is filed during the run, which is before the run record exists and sometimes instead of it ever existing.

- [ ] **Step 4: Apply and run the probe**

Run: `npm run db:migrate` then `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/deal_step_skill_runs.sql`
Expected: `OK: skill run schema` and `OK: skill run records`.

- [ ] **Step 5: Add the table constant**

In `src/lib/constants/tables.ts`, add `DEAL_STEP_SKILL_RUNS: 'deal_step_skill_runs',` to `TABLE` and, if the file keeps a companion array of table names, add it there too so `tests/constants-schema-sync.test.ts` stays green.

- [ ] **Step 6: Run the unit suite**

Run: `npm test -- constants-schema-sync`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260916130000_deal_step_skill_runs.sql \
        supabase/tests/deal_step_skill_runs.sql \
        src/lib/constants/tables.ts
git commit -m "feat(skill-runs): record runs on a project step"
```

---

## Task 6: Resolve a step into a runnable binding, and parse a run record

**Files:**
- Create: `src/lib/skillRun/types.ts`
- Create: `src/lib/skillRun/parse.ts`
- Create: `src/lib/skillRun/step.ts`
- Test: `tests/skill-run-step.test.ts`

**Interfaces:**
- Consumes: `parseSkillStepDefinitionV1` and `SkillBinding` from `@/lib/skillPublication/parse` and `@/lib/skillPublication/types`.
- Produces:

```ts
export type RunnableStep = {
  dealStepId: string;
  stepId: string;
  title: string;
  binding: SkillBinding;
  input: string;
};

export type StepResolution =
  | { ok: true; step: RunnableStep }
  | { ok: false; code: 'not_found' | 'removed' | 'not_skill_backed' | 'empty_input' };

export function resolveRunnableStep(row: unknown): StepResolution;

export type RunRecordBody = {
  runId: string;
  input: string;
  outcome: 'succeeded' | 'failed';
  resultText: string | null;
  errorMessage: string | null;
  providerRunId: string | null;
  costUsd: number | null;
  startedAt: string | null;
};

export function parseRunRecord(body: unknown): RunRecordBody | { error: string };
```

- [ ] **Step 1: Write the failing test**

`tests/skill-run-step.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveRunnableStep } from '@/lib/skillRun/step';
import { parseRunRecord } from '@/lib/skillRun/parse';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deal-step-1',
    step_id: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
    origin: 'custom',
    removed_at: null,
    work: { primary: 'Summarise the week' },
    definition: {
      schemaVersion: 1,
      type: 'skill',
      title: 'Weekly project update',
      description: 'Prepare a concise update.',
      inputs: [{ key: 'primary', kind: 'text', label: 'Input', helperText: 'What to emphasise.', required: true }],
      skillBinding: BINDING,
    },
    ...overrides,
  };
}

describe('resolveRunnableStep', () => {
  it('returns the binding, the title and the saved input', () => {
    const resolved = resolveRunnableStep(row());
    expect(resolved).toEqual({
      ok: true,
      step: {
        dealStepId: 'deal-step-1',
        stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        title: 'Weekly project update',
        binding: BINDING,
        input: 'Summarise the week',
      },
    });
  });

  it('refuses a row that is not there', () => {
    expect(resolveRunnableStep(null)).toEqual({ ok: false, code: 'not_found' });
  });

  it('refuses a removed step', () => {
    expect(resolveRunnableStep(row({ removed_at: '2026-09-14T10:00:00Z' }))).toEqual({
      ok: false,
      code: 'removed',
    });
  });

  it('refuses a catalog step and a custom step with no binding', () => {
    expect(resolveRunnableStep(row({ origin: 'catalog' }))).toEqual({
      ok: false,
      code: 'not_skill_backed',
    });
    expect(resolveRunnableStep(row({ definition: { title: 'Manual', description: 'x' } }))).toEqual({
      ok: false,
      code: 'not_skill_backed',
    });
  });

  it('refuses an input that is missing or blank', () => {
    expect(resolveRunnableStep(row({ work: {} }))).toEqual({ ok: false, code: 'empty_input' });
    expect(resolveRunnableStep(row({ work: { primary: '   ' } }))).toEqual({
      ok: false,
      code: 'empty_input',
    });
  });
});

describe('parseRunRecord', () => {
  const runId = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';

  it('accepts a succeeded run', () => {
    expect(
      parseRunRecord({
        runId,
        input: 'in',
        outcome: 'succeeded',
        resultText: 'out',
        providerRunId: 'run_1',
        costUsd: 0.42,
        startedAt: '2026-09-14T10:00:00.000Z',
      }),
    ).toEqual({
      runId,
      input: 'in',
      outcome: 'succeeded',
      resultText: 'out',
      errorMessage: null,
      providerRunId: 'run_1',
      costUsd: 0.42,
      startedAt: '2026-09-14T10:00:00.000Z',
    });
  });

  it('accepts a failed run with a message and no result', () => {
    const parsed = parseRunRecord({ runId, input: 'in', outcome: 'failed', errorMessage: 'boom' });
    expect(parsed).toMatchObject({ outcome: 'failed', resultText: null, errorMessage: 'boom' });
  });

  it('refuses a succeeded run with no result text', () => {
    expect(parseRunRecord({ runId, input: 'in', outcome: 'succeeded' })).toEqual({
      error: 'resultText is required for a succeeded run',
    });
  });

  it('refuses a run id that is not a uuid and an unknown outcome', () => {
    expect(parseRunRecord({ runId: 'nope', input: 'in', outcome: 'succeeded', resultText: 'r' })).toEqual({
      error: 'runId must be a UUID',
    });
    expect(parseRunRecord({ runId, input: 'in', outcome: 'cancelled' })).toEqual({
      error: 'outcome must be succeeded or failed',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- skill-run-step`
Expected: FAIL, cannot resolve `@/lib/skillRun/step`.

- [ ] **Step 3: Write the types**

`src/lib/skillRun/types.ts`:

```ts
import type { SkillBinding } from '@/lib/skillPublication/types';

export type RunOutcome = 'succeeded' | 'failed';

export type RunnableStep = {
  dealStepId: string;
  stepId: string;
  title: string;
  binding: SkillBinding;
  input: string;
};

export type StepResolution =
  | { ok: true; step: RunnableStep }
  | { ok: false; code: 'not_found' | 'removed' | 'not_skill_backed' | 'empty_input' };

export type RunRecordBody = {
  runId: string;
  input: string;
  outcome: RunOutcome;
  resultText: string | null;
  errorMessage: string | null;
  providerRunId: string | null;
  costUsd: number | null;
  startedAt: string | null;
};

export type SkillRunDocument = {
  id: string;
  name: string;
  folder: string | null;
  createdAt: string;
};

export type SkillRunSummary = {
  id: string;
  outcome: RunOutcome;
  actorName: string;
  input: string;
  resultText: string | null;
  errorMessage: string | null;
  costUsd: number | null;
  startedAt: string | null;
  createdAt: string;
  binding: SkillBinding;
  documents: SkillRunDocument[];
};
```

- [ ] **Step 4: Write the resolver**

`src/lib/skillRun/step.ts`:

```ts
import { parseSkillStepDefinitionV1 } from '@/lib/skillPublication/parse';
import type { StepResolution } from './types';

export function resolveRunnableStep(row: unknown): StepResolution {
  if (!row || typeof row !== 'object') return { ok: false, code: 'not_found' };
  const step = row as {
    id?: unknown;
    step_id?: unknown;
    origin?: unknown;
    removed_at?: unknown;
    work?: unknown;
    definition?: unknown;
  };
  if (typeof step.id !== 'string' || typeof step.step_id !== 'string') {
    return { ok: false, code: 'not_found' };
  }
  if (step.removed_at !== null && step.removed_at !== undefined) {
    return { ok: false, code: 'removed' };
  }
  if (step.origin !== 'custom') return { ok: false, code: 'not_skill_backed' };

  const parsed = parseSkillStepDefinitionV1(step.definition);
  if ('error' in parsed) return { ok: false, code: 'not_skill_backed' };

  const work = step.work && typeof step.work === 'object' ? (step.work as Record<string, unknown>) : {};
  const input = typeof work.primary === 'string' ? work.primary.trim() : '';
  if (input === '') return { ok: false, code: 'empty_input' };

  return {
    ok: true,
    step: {
      dealStepId: step.id,
      stepId: step.step_id,
      title: parsed.title,
      binding: parsed.skillBinding,
      input,
    },
  };
}
```

- [ ] **Step 5: Write the record parser**

`src/lib/skillRun/parse.ts`:

```ts
import type { RunRecordBody } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 200_000;

export function parseRunRecord(body: unknown): RunRecordBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const rec = body as Record<string, unknown>;

  const runId = typeof rec.runId === 'string' ? rec.runId.trim() : '';
  if (!UUID.test(runId)) return { error: 'runId must be a UUID' };

  const input = typeof rec.input === 'string' ? rec.input : '';
  if (input.trim() === '') return { error: 'input is required' };
  if (input.length > MAX_TEXT) return { error: 'input is too long' };

  if (rec.outcome !== 'succeeded' && rec.outcome !== 'failed') {
    return { error: 'outcome must be succeeded or failed' };
  }

  const resultText = typeof rec.resultText === 'string' && rec.resultText.trim() ? rec.resultText : null;
  if (rec.outcome === 'succeeded' && resultText === null) {
    return { error: 'resultText is required for a succeeded run' };
  }
  if (resultText !== null && resultText.length > MAX_TEXT) return { error: 'resultText is too long' };

  return {
    runId,
    input,
    outcome: rec.outcome,
    resultText: rec.outcome === 'succeeded' ? resultText : null,
    errorMessage: typeof rec.errorMessage === 'string' && rec.errorMessage.trim() ? rec.errorMessage.slice(0, 2000) : null,
    providerRunId: typeof rec.providerRunId === 'string' && rec.providerRunId.trim() ? rec.providerRunId.trim() : null,
    costUsd: typeof rec.costUsd === 'number' && Number.isFinite(rec.costUsd) ? rec.costUsd : null,
    startedAt: typeof rec.startedAt === 'string' && rec.startedAt.trim() ? rec.startedAt : null,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- skill-run-step`
Expected: PASS, nine tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/skillRun/types.ts src/lib/skillRun/parse.ts src/lib/skillRun/step.ts \
        tests/skill-run-step.test.ts
git commit -m "feat(skill-runs): resolve a runnable step and parse a run record"
```

---

## Task 7: The bench client call

**Files:**
- Modify: `src/lib/ignatious/bench.ts`
- Test: `tests/skill-run-bench-client.test.ts`

**Interfaces:**
- Consumes: `IgnatiousConfig` and the existing `createSkillBench` factory.
- Produces: `startSkillRun(body: BenchSkillRunBody, signal?: AbortSignal): Promise<Response>` on the object `createSkillBench` returns, where

```ts
export type BenchSkillRunBody = {
  runId: string;
  skill: { kind: 'publication'; skillId: string; versionId: string; digest: string };
  input: string;
  tenantId: string;
  leadId: string;
  token: string;
};
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSkillBench } from '@/lib/ignatious/bench';

const CONFIG = {
  baseUrl: 'https://plane.test',
  apiKey: 'key',
  tenantId: 'tenant-1',
  leadIdOverride: null,
  benchUrl: 'https://bench.test',
  conductiaBaseUrl: 'https://conductia.test',
};

describe('startSkillRun', () => {
  it('posts the pinned binding and forwards the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);

    await bench.startSkillRun({
      runId: '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11',
      skill: { kind: 'publication', skillId: 'skill-1', versionId: 'version-1', digest: 'a'.repeat(64) },
      input: 'Summarise the week',
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      token: 'jwt',
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bench.test/v1/bench/skill-runs');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('key');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt');
    expect(JSON.parse(init.body as string)).toEqual({
      runId: '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11',
      skill: { kind: 'publication', skillId: 'skill-1', versionId: 'version-1', digest: 'a'.repeat(64) },
      input: 'Summarise the week',
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      conductiaBaseUrl: 'https://conductia.test',
    });
  });

  it('reports an unreachable bench as a 503-shaped failure', async () => {
    const bench = createSkillBench(CONFIG, (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch);

    await expect(
      bench.startSkillRun({
        runId: '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11',
        skill: { kind: 'publication', skillId: 's', versionId: 'v', digest: 'a'.repeat(64) },
        input: 'x',
        tenantId: 't',
        leadId: 'l',
        token: 'jwt',
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
```

The token travels in the `authorization` header and not in the body, exactly as `chat` already sends it.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- skill-run-bench-client`
Expected: FAIL, `bench.startSkillRun is not a function`.

- [ ] **Step 3: Implement it**

Add the type beside `BenchChatBody` and the method beside `chat` in `createSkillBench`:

```ts
export type BenchSkillRunBody = {
  runId: string;
  skill: { kind: 'publication'; skillId: string; versionId: string; digest: string };
  input: string;
  tenantId: string;
  leadId: string;
  token: string;
};
```

```ts
async startSkillRun(body: BenchSkillRunBody, signal?: AbortSignal): Promise<Response> {
  return benchFetch('/v1/bench/skill-runs', {
    method: 'POST',
    headers: headers({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${body.token}`,
    }),
    body: JSON.stringify({
      runId: body.runId,
      skill: body.skill,
      input: body.input,
      tenantId: body.tenantId,
      leadId: body.leadId,
      ...(config.conductiaBaseUrl ? { conductiaBaseUrl: config.conductiaBaseUrl } : {}),
    }),
    signal,
  });
},
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- skill-run-bench-client`
Expected: PASS, two tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ignatious/bench.ts tests/skill-run-bench-client.test.ts
git commit -m "feat(skill-runs): call the bench skill run route"
```

---

## Task 8: The start-and-stream route

**Files:**
- Create: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts`
- Modify: `src/lib/ignatious/config.ts`, `src/lib/ignatious/jwt.ts`
- Test: `tests/api/skill-run-stream.test.ts`

**Interfaces:**
- Consumes: `resolveRunnableStep` (Task 6), `startSkillRun` (Task 7), `requireApiUser`, `loadDealByIdOrCode`, `userCanAccessDeal`, `resolveDealStepCapabilities`, `requireFlag`, `leadIdForDeal`, `mintTriggerToken`, `streamBenchResponse`.
- Produces: `POST` handler, and two constants: `SKILL_STEP_RUN_AGENT = 'skill-step-run'` in `config.ts` and `skillStepRunScopes()` in `jwt.ts` returning the same scope list as `mdBriefingScopes()`.

- [ ] **Step 1: Write the failing test**

`tests/api/skill-run-stream.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const state = {
  flagOff: false,
  canAccess: true,
  capabilities: { canAssign: false, canComplete: true, canEditWork: true } as
    | { canAssign: boolean; canComplete: boolean; canEditWork: boolean }
    | 'unreadable',
  step: {
    id: 'deal-step-1',
    step_id: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
    origin: 'custom',
    removed_at: null as string | null,
    work: { primary: 'Summarise the week' } as Record<string, unknown>,
    definition: {
      schemaVersion: 1,
      type: 'skill',
      title: 'Weekly project update',
      description: 'Prepare a concise update.',
      inputs: [{ key: 'primary', kind: 'text', label: 'Input', helperText: 'What to emphasise.', required: true }],
      skillBinding: BINDING,
    } as unknown,
  } as Record<string, unknown> | null,
  started: [] as Record<string, unknown>[],
};

vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: async () =>
    state.flagOff ? new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }) : null,
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));

vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => state.canAccess,
  resolveDealStepCapabilities: async () => state.capabilities,
}));

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test' },
    admin: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.step, error: null }) }),
          }),
        }),
      }),
    },
  }),
}));

vi.mock('@/lib/ignatious/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/config')>()),
  readIgnatiousConfig: () => ({
    baseUrl: 'https://plane.test',
    apiKey: 'key',
    tenantId: 'tenant-1',
    leadIdOverride: null,
    benchUrl: 'https://bench.test',
    conductiaBaseUrl: 'https://conductia.test',
  }),
}));

vi.mock('@/lib/ignatious/bench', () => ({
  createSkillBench: () => ({
    startSkillRun: async (body: Record<string, unknown>) => {
      state.started.push(body);
      return new Response('event: text\ndata: {"type":"text","text":"hi"}\n\n', { status: 200 });
    },
  }),
}));

async function start(body: Record<string, unknown>) {
  const { POST } = await import(
    '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route'
  );
  return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6' }),
  });
}

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';

describe('POST skill-runs/stream', () => {
  beforeEach(() => {
    state.flagOff = false;
    state.canAccess = true;
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.step = {
      id: 'deal-step-1',
      step_id: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      origin: 'custom',
      removed_at: null,
      work: { primary: 'Summarise the week' },
      definition: {
        schemaVersion: 1,
        type: 'skill',
        title: 'Weekly project update',
        description: 'Prepare a concise update.',
        inputs: [{ key: 'primary', kind: 'text', label: 'Input', helperText: 'What to emphasise.', required: true }],
        skillBinding: BINDING,
      },
    };
    state.started = [];
    vi.resetModules();
  });

  it('sends the binding read from the step, and the saved input', async () => {
    const response = await start({ runId: RUN_ID });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(state.started).toHaveLength(1);
    expect(state.started[0]).toMatchObject({
      runId: RUN_ID,
      skill: { kind: 'publication', ...BINDING },
      input: 'Summarise the week',
      leadId: 'ATLAS-2026-001',
      tenantId: 'tenant-1',
    });
  });

  it('ignores a client-supplied version', async () => {
    await start({ runId: RUN_ID, skill: { kind: 'publication', skillId: 'x', versionId: 'y', digest: 'b'.repeat(64) } });

    expect(state.started[0]?.skill).toEqual({ kind: 'publication', ...BINDING });
  });

  it('refuses a run id that is not a uuid', async () => {
    expect((await start({ runId: 'nope' })).status).toBe(422);
    expect(state.started).toHaveLength(0);
  });

  it('refuses a removed step, a catalog step and an empty input', async () => {
    state.step = { ...(state.step as Record<string, unknown>), removed_at: '2026-09-14T00:00:00Z' };
    expect((await start({ runId: RUN_ID })).status).toBe(409);

    vi.resetModules();
    state.step = { ...(state.step as Record<string, unknown>), removed_at: null, origin: 'catalog' };
    expect((await start({ runId: RUN_ID })).status).toBe(409);

    vi.resetModules();
    state.step = { ...(state.step as Record<string, unknown>), origin: 'custom', work: {} };
    expect((await start({ runId: RUN_ID })).status).toBe(422);
  });

  it('refuses a step that is not on this deal', async () => {
    state.step = null;
    expect((await start({ runId: RUN_ID })).status).toBe(404);
  });

  it('refuses a caller who cannot edit the step, and a disabled flag', async () => {
    state.capabilities = { canAssign: false, canComplete: false, canEditWork: false };
    expect((await start({ runId: RUN_ID })).status).toBe(403);

    vi.resetModules();
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.flagOff = true;
    expect((await start({ runId: RUN_ID })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- skill-run-stream`
Expected: FAIL, the route module does not exist.

- [ ] **Step 3: Add the agent name and scopes**

In `src/lib/ignatious/config.ts`, beside the other agent constants:

```ts
export const SKILL_STEP_RUN_AGENT = 'skill-step-run';
```

In `src/lib/ignatious/jwt.ts`, beside `mdBriefingScopes`:

```ts
const SKILL_STEP_RUN_SCOPES = [
  'lead.read',
  'documents.read',
  'documents.write',
  'maps.read',
  'library.read',
  'personas.read',
] as const;

export function skillStepRunScopes(): readonly string[] {
  return SKILL_STEP_RUN_SCOPES;
}
```

- [ ] **Step 4: Write the route**

```ts
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { resolveDealStepCapabilities, userCanAccessDeal } from '@/lib/api/v1/access';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { requireFlag } from '@/lib/flags/requireFlag';
import { createSkillBench } from '@/lib/ignatious/bench';
import { leadIdForDeal, readIgnatiousConfig, SKILL_STEP_RUN_AGENT } from '@/lib/ignatious/config';
import { streamBenchResponse } from '@/lib/ignatious/benchRequest';
import { ignatiousErrorResponse } from '@/lib/ignatious/routeContext';
import { mintTriggerToken, skillStepRunScopes } from '@/lib/ignatious/jwt';
import { TABLE } from '@/lib/constants/tables';
import { resolveRunnableStep } from '@/lib/skillRun/step';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  let body: { runId?: unknown };
  try {
    body = (await request.json()) as { runId?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!UUID.test(runId)) return jsonError('runId must be a UUID', 422);

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) {
    return jsonError('Forbidden', 403);
  }

  const { data: row } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select('id, step_id, origin, removed_at, work, definition, assigned_to, status')
    .eq('deal_id', deal.id)
    .eq('step_id', stepId)
    .maybeSingle();

  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
    assigned_to: (row?.assigned_to as string | null) ?? null,
    status: (row?.status as string) ?? 'pending',
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);
  if (!capabilities.canEditWork) return jsonError('Not permitted to run this step', 403);

  const resolved = resolveRunnableStep(row);
  if (!resolved.ok) {
    if (resolved.code === 'not_found') return jsonError('Unknown step', 404);
    if (resolved.code === 'empty_input') return jsonError('Save an input before running', 422);
    return jsonError(
      resolved.code === 'removed' ? 'This step was removed' : 'This step has no skill attached',
      409,
    );
  }

  const config = readIgnatiousConfig();
  if (!config) return jsonError('Ignatious is not configured', 503);

  const token = mintTriggerToken({
    agentName: SKILL_STEP_RUN_AGENT,
    dealId: deal.id,
    scopes: skillStepRunScopes(),
    userId: auth.user.id,
    userEmail: auth.user.email,
  });

  try {
    const upstream = await createSkillBench(config).startSkillRun({
      runId,
      skill: { kind: 'publication', ...resolved.step.binding },
      input: resolved.step.input,
      tenantId: config.tenantId,
      leadId: leadIdForDeal(config, deal),
      token,
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return new Response(text || `Skill bench answered ${String(upstream.status)}`, {
        status: upstream.status >= 400 ? upstream.status : 502,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
      });
    }
    return streamBenchResponse(upstream);
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
```

The capability check runs before the resolution so a caller with no rights learns nothing about the step's shape.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- skill-run-stream`
Expected: PASS, six tests.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts" \
        src/lib/ignatious/config.ts src/lib/ignatious/jwt.ts tests/api/skill-run-stream.test.ts
git commit -m "feat(skill-runs): start a version-pinned run and stream it"
```

---

## Task 9: Record a terminal run, and read history

**Files:**
- Create: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts`
- Modify: `src/lib/audit/serverAudit.ts`
- Test: `tests/api/skill-run-records.test.ts`

**Interfaces:**
- Consumes: `parseRunRecord` and `resolveRunnableStep` (Task 6), `TABLE.DEAL_STEP_SKILL_RUNS` (Task 5), `AUDIT_ACTION.CREATE`.
- Produces: `POST` (record) and `GET` (history) handlers returning `SkillRunSummary` shapes from `src/lib/skillRun/types.ts`.

- [ ] **Step 1: Write the failing test**

`tests/api/skill-run-records.test.ts`. Reuse the mock shape from Task 8's test, extended with an insert and a select that can return existing rows:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};
const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';

const state = {
  runs: [] as Record<string, unknown>[],
  documents: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  insertError: null as { code: string; message: string } | null,
};

function step() {
  return {
    id: 'deal-step-1',
    step_id: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
    origin: 'custom',
    removed_at: null,
    work: { primary: 'Summarise the week' },
    definition: {
      schemaVersion: 1,
      type: 'skill',
      title: 'Weekly project update',
      description: 'Prepare a concise update.',
      inputs: [{ key: 'primary', kind: 'text', label: 'Input', helperText: 'Hint.', required: true }],
      skillBinding: BINDING,
    },
    assigned_to: null,
    status: 'pending',
  };
}

vi.mock('@/lib/flags/requireFlag', () => ({ requireFlag: async () => null }));
vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => true,
  classifyInternalUser: async () => 'internal',
  resolveDealStepCapabilities: async () => ({ canAssign: false, canComplete: true, canEditWork: true }),
}));

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test' },
    admin: {
      from: (table: string) => builderFor(table),
    },
  }),
}));

function builderFor(table: string) {
  if (table === 'deal_steps') {
    return {
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: step(), error: null }) }) }) }),
    };
  }
  if (table === 'deal_step_skill_runs') {
    return {
      insert: (row: Record<string, unknown>) => {
        state.inserted.push(row);
        return {
          select: () => ({
            single: async () =>
              state.insertError
                ? { data: null, error: state.insertError }
                : { data: { ...row, created_at: '2026-09-14T10:00:00.000Z' }, error: null },
          }),
        };
      },
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: state.runs, error: null }),
          }),
        }),
      }),
    };
  }
  if (table === 'documents') {
    return { select: () => ({ in: async () => ({ data: state.documents, error: null }) }) };
  }
  if (table === 'users') {
    return {
      select: () => ({ in: async () => ({ data: [{ id: 'user-1', full_name: 'Storm Duncan', display_name: null, email: 'md@example.test' }], error: null }) }),
    };
  }
  return { insert: async (row: Record<string, unknown>) => { state.audits.push(row); return { error: null }; } };
}

async function record(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route');
  return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6' }),
  });
}

async function history() {
  const { GET } = await import('@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route');
  return GET(new Request('http://localhost'), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6' }),
  });
}

describe('skill run records', () => {
  beforeEach(() => {
    state.runs = [];
    state.documents = [];
    state.inserted = [];
    state.audits = [];
    state.insertError = null;
    vi.resetModules();
  });

  it('stores the binding from the step, not from the request', async () => {
    const response = await record({
      runId: RUN_ID,
      input: 'Summarise the week',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      providerRunId: 'run_9',
      costUsd: 0.12,
      skill: { skillId: 'spoofed', versionId: 'spoofed', digest: 'b'.repeat(64) },
    });

    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({
      id: RUN_ID,
      deal_id: 'deal-1',
      deal_step_id: 'deal-step-1',
      actor_id: 'user-1',
      skill_id: BINDING.skillId,
      version_id: BINDING.versionId,
      digest: BINDING.digest,
      outcome: 'succeeded',
      result_text: 'Here is the update.',
    });
    expect(state.audits[0]).toMatchObject({
      action: 'create',
      deal_id: 'deal-1',
      detail: expect.objectContaining({ kind: 'skill_run', runId: RUN_ID, outcome: 'succeeded' }),
    });
  });

  it('never audits the input or the result text', async () => {
    await record({ runId: RUN_ID, input: 'secret input', outcome: 'succeeded', resultText: 'secret result' });
    expect(JSON.stringify(state.audits[0])).not.toContain('secret');
  });

  it('refuses a succeeded run with no result text', async () => {
    expect((await record({ runId: RUN_ID, input: 'in', outcome: 'succeeded' })).status).toBe(422);
  });

  it('returns the stored row when the same run id is replayed', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.runs = [
      {
        id: RUN_ID,
        outcome: 'succeeded',
        input: 'Summarise the week',
        result_text: 'Here is the update.',
        error_message: null,
        actor_id: 'user-1',
        skill_id: BINDING.skillId,
        version_id: BINDING.versionId,
        digest: BINDING.digest,
        cost_usd: 0.12,
        started_at: null,
        created_at: '2026-09-14T10:00:00.000Z',
      },
    ];

    const response = await record({
      runId: RUN_ID,
      input: 'Summarise the week',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { id: RUN_ID } });
  });

  it('conflicts when the same run id carries different content', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.runs = [
      {
        id: RUN_ID,
        outcome: 'succeeded',
        input: 'a different input',
        result_text: 'a different result',
        error_message: null,
        actor_id: 'user-1',
        skill_id: BINDING.skillId,
        version_id: BINDING.versionId,
        digest: BINDING.digest,
        cost_usd: null,
        started_at: null,
        created_at: '2026-09-14T10:00:00.000Z',
      },
    ];

    expect(
      (await record({ runId: RUN_ID, input: 'in', outcome: 'succeeded', resultText: 'out' })).status,
    ).toBe(409);
  });

  it('reads history newest first with the actor and the filed documents', async () => {
    state.runs = [
      {
        id: RUN_ID,
        outcome: 'succeeded',
        input: 'in',
        result_text: 'out',
        error_message: null,
        actor_id: 'user-1',
        skill_id: BINDING.skillId,
        version_id: BINDING.versionId,
        digest: BINDING.digest,
        cost_usd: null,
        started_at: null,
        created_at: '2026-09-14T10:00:00.000Z',
      },
    ];
    state.documents = [
      { id: 'doc-1', name: 'update.docx', folder: 'admin', created_at: '2026-09-14T10:01:00.000Z', step_skill_run_id: RUN_ID },
    ];

    const body = (await (await history()).json()) as { runs: { id: string; actorName: string; documents: { id: string }[] }[] };

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.actorName).toBe('Storm Duncan');
    expect(body.runs[0]?.documents.map((doc) => doc.id)).toEqual(['doc-1']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- skill-run-records`
Expected: FAIL, the route module does not exist.

- [ ] **Step 3: Write the route**

```ts
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyInternalUser, resolveDealStepCapabilities, userCanAccessDeal } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { requireFlag } from '@/lib/flags/requireFlag';
import { parseRunRecord } from '@/lib/skillRun/parse';
import { resolveRunnableStep } from '@/lib/skillRun/step';
import type { SkillRunSummary } from '@/lib/skillRun/types';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

const HISTORY_LIMIT = 20;
const RUN_COLUMNS =
  'id, outcome, input, result_text, error_message, actor_id, skill_id, version_id, digest, cost_usd, started_at, created_at';

export async function POST(request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const parsed = parseRunRecord(raw);
  if ('error' in parsed) return jsonError(parsed.error, 422);

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) return jsonError('Forbidden', 403);

  const { data: row } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select('id, step_id, origin, removed_at, work, definition, assigned_to, status')
    .eq('deal_id', deal.id)
    .eq('step_id', stepId)
    .maybeSingle();

  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
    assigned_to: (row?.assigned_to as string | null) ?? null,
    status: (row?.status as string) ?? 'pending',
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);
  if (!capabilities.canEditWork) return jsonError('Not permitted to run this step', 403);

  const resolved = resolveRunnableStep({ ...(row ?? {}), work: { primary: 'recorded' } });
  if (!resolved.ok) {
    return resolved.code === 'not_found'
      ? jsonError('Unknown step', 404)
      : jsonError('This step has no skill attached', 409);
  }

  const insert = {
    id: parsed.runId,
    deal_id: deal.id,
    deal_step_id: resolved.step.dealStepId,
    actor_id: auth.user.id,
    skill_id: resolved.step.binding.skillId,
    version_id: resolved.step.binding.versionId,
    digest: resolved.step.binding.digest,
    input: parsed.input,
    outcome: parsed.outcome,
    result_text: parsed.resultText,
    error_message: parsed.errorMessage,
    provider_run_id: parsed.providerRunId,
    cost_usd: parsed.costUsd,
    started_at: parsed.startedAt,
  };

  const { data: stored, error } = await auth.admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .insert(insert)
    .select(RUN_COLUMNS)
    .single();

  if (error && (error as { code?: string }).code === '23505') {
    const existing = await readRuns(auth.admin, resolved.step.dealStepId);
    const match = existing.find((run) => run.id === parsed.runId);
    if (!match) return jsonError('Run already recorded', 409);
    const same =
      match.input === parsed.input &&
      match.outcome === parsed.outcome &&
      (match.resultText ?? null) === parsed.resultText;
    if (!same) return jsonError('That run id was already recorded with different content', 409);
    return NextResponse.json({ run: match });
  }
  if (error || !stored) return jsonError(error?.message ?? 'Failed to record the run', 500);

  await auth.admin.from(TABLE.AUDIT_LOG).insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.CREATE,
    deal_id: deal.id,
    detail: {
      kind: 'skill_run',
      stepId,
      dealStepId: resolved.step.dealStepId,
      runId: parsed.runId,
      skillId: resolved.step.binding.skillId,
      versionId: resolved.step.binding.versionId,
      digest: resolved.step.binding.digest,
      outcome: parsed.outcome,
      costUsd: parsed.costUsd,
    },
  });

  const [summary] = await decorate(auth.admin, [stored as Record<string, unknown>]);
  return NextResponse.json({ run: summary }, { status: 201 });
}

export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) return jsonError('Forbidden', 403);

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  const { data: row } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select('id, step_id, origin, removed_at, work, definition')
    .eq('deal_id', deal.id)
    .eq('step_id', stepId)
    .maybeSingle();
  if (!row) return jsonError('Unknown step', 404);

  const runs = await readRuns(auth.admin, (row as { id: string }).id);
  return NextResponse.json({ runs });
}
```

with the two helpers in the same file:

```ts
async function readRuns(
  admin: SupabaseClient,
  dealStepId: string,
): Promise<SkillRunSummary[]> {
  const { data } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select(RUN_COLUMNS)
    .eq('deal_step_id', dealStepId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  return decorate(admin, (data ?? []) as Record<string, unknown>[]);
}

async function decorate(
  admin: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<SkillRunSummary[]> {
  if (rows.length === 0) return [];
  const actorIds = [...new Set(rows.map((row) => row.actor_id as string))];
  const runIds = rows.map((row) => row.id as string);

  const { data: people } = await admin.from(TABLE.USERS).select('id, full_name, display_name, email').in('id', actorIds);
  const { data: documents } = await admin
    .from(TABLE.DOCUMENTS)
    .select('id, name, folder, created_at, step_skill_run_id')
    .in('step_skill_run_id', runIds);

  const nameFor = new Map(
    ((people ?? []) as Record<string, unknown>[]).map((person) => [
      person.id as string,
      (person.display_name as string | null) ?? (person.full_name as string | null) ?? (person.email as string),
    ]),
  );

  return rows.map((row) => ({
    id: row.id as string,
    outcome: row.outcome as SkillRunSummary['outcome'],
    actorName: nameFor.get(row.actor_id as string) ?? 'Unknown',
    input: row.input as string,
    resultText: (row.result_text as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    costUsd: (row.cost_usd as number | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    createdAt: row.created_at as string,
    binding: {
      skillId: row.skill_id as string,
      versionId: row.version_id as string,
      digest: row.digest as string,
    },
    documents: ((documents ?? []) as Record<string, unknown>[])
      .filter((doc) => doc.step_skill_run_id === row.id)
      .map((doc) => ({
        id: doc.id as string,
        name: doc.name as string,
        folder: (doc.folder as string | null) ?? null,
        createdAt: doc.created_at as string,
      })),
  }));
}
```

`TABLE.USERS` is `'users'` and already exists in `src/lib/constants/tables.ts`.

- [ ] **Step 4: Add the audit label**

In `src/lib/audit/serverAudit.ts`, where `detail.kind` is switched to build a sentence, add a `skill_run` branch producing the action label `Ran a skill` and naming the step through the same `railStepName` helper the rail branch uses, falling back to the step id.

- [ ] **Step 5: Run the tests**

Run: `npm test -- skill-run-records serverAudit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts" \
        src/lib/audit/serverAudit.ts tests/api/skill-run-records.test.ts
git commit -m "feat(skill-runs): record a terminal run and read its history"
```

---

## Task 10: File a run's document against the run's own step

**Files:**
- Modify: `src/lib/ignatious/jwt.ts` (carry the step on the trigger claims)
- Modify: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts` (mint those claims)
- Modify: `src/lib/dataroom/steps.ts` (`provisionDataroomFolder` title parameter)
- Modify: `src/lib/dataroom/fileToStep.ts` (title and run provenance)
- Modify: `src/app/v1/leads/[leadId]/documents/route.ts` (use the claims and the run id header)
- Test: `tests/skill-run-filing.test.ts`

**Interfaces:**
- Consumes: `readTriggerClaims`, `fileBytesToStepDataroom`, `provisionDataroomFolder`.
- Produces:
  - `TriggerClaims` gains `stepId?: string` and `stepTitle?: string`, both minted server-side and read back by `readTriggerClaims`.
  - `provisionDataroomFolder(admin, dealId, stepId, dealCode, stepTitle?)`.
  - `fileBytesToStepDataroom` gains `stepTitle?: string` and `stepSkillRunId?: string | null`.

The run id already reaches this route as `x-conductia-run-id`. The step cannot be derived from it, because no run row exists while the run is in flight, so the step travels in the token the stream route minted.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mintTriggerToken, readTriggerClaims } from '@/lib/ignatious/jwt';

const state = {
  provisioned: [] as { stepId: string; title: string | undefined }[],
  documents: [] as Record<string, unknown>[],
};

vi.mock('@/lib/box', () => ({
  getBoxClient: () => ({
    uploadFile: async () => ({ id: 'box-file-1' }),
    createFolder: async () => ({ id: 'box-folder-1', url: 'https://box.test/f/1' }),
  }),
}));

describe('trigger claims carry the step', () => {
  it('round-trips the step id and title', () => {
    const token = mintTriggerToken({
      agentName: 'skill-step-run',
      dealId: 'deal-1',
      scopes: ['documents.write'],
      stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      stepTitle: 'Weekly project update',
    });

    expect(readTriggerClaims(`Bearer ${token}`)).toMatchObject({
      stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      stepTitle: 'Weekly project update',
    });
  });
});

describe('provisionDataroomFolder', () => {
  beforeEach(() => {
    state.provisioned = [];
    vi.resetModules();
  });

  it('names a custom step folder from the supplied title', async () => {
    const { provisionDataroomFolder } = await import('@/lib/dataroom/steps');
    const admin = fakeAdmin(state);

    const dataroom = await provisionDataroomFolder(
      admin as never,
      'deal-1',
      'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      'ATLAS-2026-001',
      'Weekly project update',
    );

    expect(dataroom.box_folder_id).toBe('box-folder-1');
  });

  it('still refuses a step the census does not know and no title', async () => {
    const { provisionDataroomFolder } = await import('@/lib/dataroom/steps');
    const admin = fakeAdmin(state);

    await expect(
      provisionDataroomFolder(admin as never, 'deal-1', 'custom:unknown', 'ATLAS-2026-001'),
    ).rejects.toThrow('Unknown rail step');
  });
});
```

`fakeAdmin` is this double, written at the top of the same test file:

```ts
function fakeAdmin(store: typeof state) {
  const rows: Record<string, unknown>[] = [];
  return {
    from(table: string) {
      if (table === 'datarooms') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: rows[0] ?? null, error: null }) }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            const saved = { id: 'dataroom-1', box_folder_id: null, min_phase: 0, ...row };
            rows.push(saved);
            store.provisioned.push({
              stepId: row.step_id as string,
              title: undefined,
            });
            return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { ...(rows[0] ?? {}), ...patch }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'documents') {
        return {
          insert: (row: Record<string, unknown>) => {
            store.documents.push(row);
            return { select: () => ({ single: async () => ({ data: { id: 'doc-1' }, error: null }) }) };
          },
        };
      }
      return { insert: async () => ({ error: null }) };
    },
  };
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- skill-run-filing`
Expected: FAIL. The claims do not round-trip the step, and `provisionDataroomFolder` takes four parameters.

- [ ] **Step 3: Carry the step on the claims**

In `src/lib/ignatious/jwt.ts`, add `stepId?: string` and `stepTitle?: string` to `TriggerClaims`, spread them into the minted payload the way `userId` and `userEmail` are spread, and read them back in `readTriggerClaims` with the same `typeof` guard.

- [ ] **Step 4: Mint them from the stream route**

In the stream route from Task 8, extend the `mintTriggerToken` call:

```ts
const token = mintTriggerToken({
  agentName: SKILL_STEP_RUN_AGENT,
  dealId: deal.id,
  scopes: skillStepRunScopes(),
  userId: auth.user.id,
  userEmail: auth.user.email,
  stepId: resolved.step.stepId,
  stepTitle: resolved.step.title,
});
```

- [ ] **Step 5: Take a title in the provisioner**

In `src/lib/dataroom/steps.ts`:

```ts
export async function provisionDataroomFolder(
  admin: SupabaseClient,
  dealId: string,
  stepId: string,
  dealCode: string,
  stepTitle?: string,
): Promise<DataroomRow> {
```

and replace the census lookup so a supplied title satisfies it:

```ts
  const censusStep = railStepById(stepId);
  const title = censusStep?.title ?? stepTitle;
  if (!title) throw new Error(`Unknown rail step: ${stepId}`);
```

then use `title` where `censusStep.title` was used to build `folderName`. Every existing caller passes four arguments and is unchanged.

- [ ] **Step 6: Pass the title and the run id through the filing helper**

In `src/lib/dataroom/fileToStep.ts`, add `stepTitle?: string` and `stepSkillRunId?: string | null` to the options, forward the title into `provisionDataroomFolder`, and add `step_skill_run_id: opts.stepSkillRunId ?? null` to the `documents` insert.

- [ ] **Step 7: Use them in the provider filing route**

In `src/app/v1/leads/[leadId]/documents/route.ts`, replace the hardcoded step with the claims, and pass the run id through:

```ts
const claims = readTriggerClaims(request.headers.get('authorization'));
await fileBytesToStepDataroom({
  admin: gate.admin,
  dealId: deal.id,
  dealCode: deal.code,
  stepId: claims?.stepId ?? MD_BRIEFING_STEP_ID,
  stepTitle: claims?.stepTitle,
  stepSkillRunId: gate.scope.runId,
  fileName,
  bytes,
  uploadedBy: actorId,
  auditDetail: {
    source: 'ignatious',
    agent: gate.scope.agentName,
    runId: gate.scope.runId,
    documentType: filed.documentType,
  },
});
```

The brief keeps its behaviour: its token carries no step, so the fallback is the same constant as today. The deal folder the skill named continues to be recorded by `persistLeadDocument`, untouched.

- [ ] **Step 8: Add the regression for the brief**

Add to the same test file a case asserting that a token with no `stepId` still provisions `MD_BRIEFING_STEP_ID`, so the existing brief path is proven unchanged:

```ts
it('files a brief against the census step when the token names none', async () => {
  const { provisionDataroomFolder } = await import('@/lib/dataroom/steps');
  const admin = fakeAdmin(state);

  const dataroom = await provisionDataroomFolder(admin as never, 'deal-1', 'p1-s9', 'ATLAS-2026-001');

  expect(dataroom.step_id).toBe('p1-s9');
});
```

- [ ] **Step 9: Run the tests**

Run: `npm test -- skill-run-filing api-v1-deal-step-upload-gate dataroom`
Expected: PASS, including the existing upload-gate suite which calls the four-argument form.

- [ ] **Step 10: Commit**

```bash
git add src/lib/ignatious/jwt.ts src/lib/dataroom/steps.ts src/lib/dataroom/fileToStep.ts \
        "src/app/v1/leads/[leadId]/documents/route.ts" \
        "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts" \
        tests/skill-run-filing.test.ts
git commit -m "feat(skill-runs): file generated documents against the run's own step"
```

---

## Task 11: The step surface

**Files:**
- Create: `src/components/rail/SkillStepRunner.tsx`
- Modify: `src/components/rail/StationCard.tsx`, `src/components/rail/StepFocus.tsx`, `src/components/rail/index.ts`
- Test: `tests/skill-step-runner.test.tsx`

**Interfaces:**
- Consumes: `skillBindingForStep` and `ProjectRailStep` from `@/lib/rail/projectRail`, `readStepState` and `patchStep` from `@/lib/ignatious/benchSession`, `readBenchEvents` from `@/lib/ignatious/client`, `skillRunFailureMessage` from `@/lib/ignatious/failure`, `Markdown` from `@/components/atoms`, `SkillRunSummary` from `@/lib/skillRun/types`.
- Produces: `<SkillStepRunner projectId={string} step={ProjectRailStep} />`, composed into `CustomStepPanel`, which gains a `dealId` prop passed from `StepFocus`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SkillStepRunner } from '@/components/rail/SkillStepRunner';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const STEP = {
  id: 'deal-step-1',
  stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  origin: 'custom' as const,
  phaseIndex: 1,
  displayOrder: 3,
  seq: null,
  status: 'pending' as const,
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
  definition: {
    schemaVersion: 1 as const,
    type: 'skill' as const,
    title: 'Weekly project update',
    description: 'Prepare a concise update.',
    inputs: [
      { key: 'primary' as const, kind: 'text' as const, label: 'Input', helperText: 'What to emphasise.', required: true as const },
    ],
    skillBinding: BINDING,
  },
};

function sseBody(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: run\ndata: ${JSON.stringify({ type: 'run', runId: 'provider-run-1' })}\n\n`));
      controller.enqueue(encoder.encode(`event: text\ndata: ${JSON.stringify({ type: 'text', text })}\n\n`));
      controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ type: 'done', costUsd: 0.2 })}\n\n`));
      controller.close();
    },
  });
}

const calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/skill-runs/stream')) return new Response(sseBody('Here is the update.'), { status: 200 });
    if (url.endsWith('/skill-runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run: { id: 'run-1' } }), { status: 201 });
    }
    if (url.endsWith('/skill-runs')) {
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }
    if (url.includes('/steps/')) {
      return new Response(JSON.stringify({ step: { work: { primary: 'Summarise the week' } } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('SkillStepRunner', () => {
  it('runs the step, keeps the input, and records the run', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP as never} />);

    const input = await screen.findByLabelText('Input');
    expect(input).toHaveValue('Summarise the week');

    await userEvent.click(screen.getByRole('button', { name: 'Draft this step' }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());
    expect(input).toHaveValue('Summarise the week');

    const record = calls.find((call) => call.url.endsWith('/skill-runs') && call.init?.method === 'POST');
    expect(JSON.parse(record?.init?.body as string)).toMatchObject({
      runId: '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      providerRunId: 'provider-run-1',
      input: 'Summarise the week',
    });
  });

  it('shows a failure without recording a result, and keeps the input', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/skill-runs/stream')) return new Response('nope', { status: 503 });
      if (url.includes('/steps/') && !url.includes('skill-runs')) {
        return new Response(JSON.stringify({ step: { work: { primary: 'Summarise the week' } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }));

    render(<SkillStepRunner projectId="deal-1" step={STEP as never} />);
    await screen.findByLabelText('Input');
    await userEvent.click(screen.getByRole('button', { name: 'Draft this step' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByLabelText('Input')).toHaveValue('Summarise the week');
    const record = calls.find((call) => call.url.endsWith('/skill-runs') && call.init?.method === 'POST');
    expect(JSON.parse(record?.init?.body as string)).toMatchObject({ outcome: 'failed' });
  });

  it('lists history and shows a selected earlier run', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/steps/') && !url.includes('skill-runs')) {
        return new Response(JSON.stringify({ step: { work: { primary: 'Summarise the week' } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          runs: [
            { id: 'run-2', outcome: 'succeeded', actorName: 'Storm Duncan', input: 'newer', resultText: 'newer result', errorMessage: null, costUsd: null, startedAt: null, createdAt: '2026-09-14T11:00:00.000Z', binding: BINDING, documents: [] },
            { id: 'run-1', outcome: 'succeeded', actorName: 'Ana Reyes', input: 'older', resultText: 'older result', errorMessage: null, costUsd: null, startedAt: null, createdAt: '2026-09-14T10:00:00.000Z', binding: BINDING, documents: [] },
          ],
        }),
        { status: 200 },
      );
    }));

    render(<SkillStepRunner projectId="deal-1" step={STEP as never} />);

    expect(await screen.findByText('newer result')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Ana Reyes/ }));
    expect(screen.getByText('older result')).toBeInTheDocument();
    expect(screen.getByLabelText('Input')).toHaveValue('Summarise the week');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- skill-step-runner`
Expected: FAIL, cannot resolve `@/components/rail/SkillStepRunner`.

- [ ] **Step 3: Write the component**

```tsx
'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import { readStepState, patchStep, elapsedLabel } from '@/lib/ignatious/benchSession';
import { readBenchEvents } from '@/lib/ignatious/client';
import { skillRunFailureMessage } from '@/lib/ignatious/failure';
import { skillBindingForStep, type ProjectRailStep } from '@/lib/rail/projectRail';
import type { SkillRunSummary } from '@/lib/skillRun/types';

const CANCELLED = 'Cancelled. Nothing was recorded.';

function runsPath(projectId: string, stepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}/skill-runs`;
}

export function SkillStepRunner({
  projectId,
  step,
}: {
  projectId: string;
  step: ProjectRailStep;
}) {
  const binding = skillBindingForStep(step);
  const definition = step.definition && 'inputs' in step.definition ? step.definition : null;
  const [input, setInput] = React.useState('');
  const [saving, setSaving] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const [runs, setRuns] = React.useState<SkillRunSummary[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [streamed, setStreamed] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const abort = React.useRef<AbortController | null>(null);
  const cancelled = React.useRef(false);

  React.useEffect(() => {
    let live = true;
    void readStepState(projectId, step.stepId).then((state) => {
      if (live && typeof state.work.primary === 'string') setInput(state.work.primary);
    });
    void fetch(runsPath(projectId, step.stepId), { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : { runs: [] }))
      .then((body: { runs?: SkillRunSummary[] }) => {
        if (!live) return;
        setRuns(body.runs ?? []);
        setSelected(body.runs?.[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, step.stepId]);

  React.useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  React.useEffect(() => () => abort.current?.abort(), []);

  async function save(next: string) {
    setSaving('saving');
    await patchStep(projectId, step.stepId, { work: { primary: next } });
    setSaving('saved');
  }

  async function refresh() {
    const response = await fetch(runsPath(projectId, step.stepId), { credentials: 'include' });
    if (!response.ok) return;
    const body = (await response.json()) as { runs?: SkillRunSummary[] };
    setRuns(body.runs ?? []);
    setSelected(body.runs?.[0]?.id ?? null);
  }

  async function record(body: Record<string, unknown>) {
    await fetch(runsPath(projectId, step.stepId), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function run() {
    if (pending || input.trim() === '') return;
    setError(null);
    setStreamed('');
    setPending(true);
    setElapsed(0);
    cancelled.current = false;
    const controller = new AbortController();
    abort.current = controller;
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let text = '';
    let providerRunId: string | null = null;
    let costUsd: number | null = null;

    try {
      await save(input);
      const response = await fetch(`${runsPath(projectId, step.stepId)}/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`The skill bench answered ${String(response.status)}.`);

      for await (const event of readBenchEvents(response.body)) {
        if (event.type === 'run' && typeof event.runId === 'string') providerRunId = event.runId;
        if (event.type === 'text' && typeof event.text === 'string') {
          text += (text === '' ? '' : '\n\n') + event.text;
          setStreamed(text);
        }
        if (event.type === 'done' && typeof event.costUsd === 'number') costUsd = event.costUsd;
        if (event.type === 'error' && typeof event.message === 'string') throw new Error(event.message);
      }
      if (text.trim() === '') throw new Error('The skill returned an empty reply.');

      await record({ runId, input, outcome: 'succeeded', resultText: text, providerRunId, costUsd, startedAt });
      setStreamed(null);
      await refresh();
    } catch (caught) {
      if (cancelled.current) {
        setError(CANCELLED);
        setStreamed(null);
        return;
      }
      const message = skillRunFailureMessage(caught);
      setError(message);
      setStreamed(null);
      await record({ runId, input, outcome: 'failed', errorMessage: message, providerRunId, costUsd, startedAt }).catch(
        () => undefined,
      );
      await refresh();
    } finally {
      abort.current = null;
      setPending(false);
    }
  }

  if (!binding || !definition) {
    return (
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        This step has no skill attached.
      </p>
    );
  }

  const shown = streamed ?? runs.find((entry) => entry.id === selected) ?? null;
  const shownText = typeof shown === 'string' ? shown : (shown?.resultText ?? null);
  const shownDocuments = typeof shown === 'string' ? [] : (shown?.documents ?? []);

  return (
    <section className="space-y-[var(--space-4)]" aria-label="Skill run">
      <div className="space-y-[var(--space-2)]">
        <label htmlFor="skill-step-input" className="block text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
          Input
        </label>
        <textarea
          id="skill-step-input"
          value={input}
          rows={4}
          onChange={(event) => setInput(event.target.value)}
          onBlur={() => void save(input)}
          className="w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)]"
        />
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {definition.inputs[0].helperText}
          {saving === 'saving' ? ' · Saving' : saving === 'saved' ? ' · Saved' : ''}
        </p>
      </div>

      <div className="flex items-center gap-[var(--space-3)]">
        <button
          type="button"
          onClick={() => void run()}
          disabled={pending || input.trim() === ''}
          className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium"
        >
          Draft this step
        </button>
        {pending ? (
          <>
            <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              running {elapsedLabel(elapsed)}
            </span>
            <button
              type="button"
              onClick={() => {
                cancelled.current = true;
                abort.current?.abort();
              }}
              className="text-[length:var(--text-xs)] underline"
            >
              Cancel
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}

      {shownText ? (
        <div className="space-y-[var(--space-2)]">
          <Markdown className="max-h-72 overflow-auto rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
            {shownText}
          </Markdown>
          {shownDocuments.length > 0 ? (
            <ul className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              {shownDocuments.map((document) => (
                <li key={document.id}>{document.name}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {runs.length > 0 ? (
        <ul className="space-y-[var(--space-1)]" aria-label="Run history">
          {runs.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => {
                  setStreamed(null);
                  setSelected(entry.id);
                }}
                className="text-left text-[length:var(--text-xs)] text-[var(--ink-secondary)] underline"
              >
                {entry.actorName} · {new Date(entry.createdAt).toLocaleString()} · {entry.outcome}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default SkillStepRunner;
```

- [ ] **Step 3b: Render a removed step's history without offering a run**

A removed step keeps its history and refuses a new run. Add a prop and an early branch to the component, and a fourth test asserting both:

```tsx
if (step.removedAt !== null) {
  return (
    <section className="space-y-[var(--space-3)]" aria-label="Skill run">
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        This step was removed. Its runs are kept for reference.
      </p>
      {runs.length > 0 ? <RunHistoryList runs={runs} selected={selected} onSelect={setSelected} /> : null}
    </section>
  );
}
```

Extract the history list rendered at the bottom of the component into `RunHistoryList` in the same file so both branches render one list rather than two copies. The test:

```tsx
it('shows history and no run control on a removed step', async () => {
  render(<SkillStepRunner projectId="deal-1" step={{ ...STEP, removedAt: '2026-09-14T09:00:00Z' } as never} />);

  await waitFor(() => expect(screen.queryByRole('button', { name: 'Draft this step' })).toBeNull());
  expect(screen.getByText(/This step was removed/)).toBeInTheDocument();
});
```

- [ ] **Step 4: Compose it into the panel**

In `StationCard.tsx`, give `CustomStepPanel` a `dealId: string` prop and render the runner under the description, above Mark complete:

```tsx
<SkillStepRunner projectId={dealId} step={step} />
```

In `StepFocus.tsx`, pass `dealId` where `CustomStepPanel` is rendered. Export `SkillStepRunner` from `src/components/rail/index.ts` beside the other rail exports.

- [ ] **Step 5: Run the tests**

Run: `npm test -- skill-step-runner`
Expected: PASS, three tests.

- [ ] **Step 6: Run the whole unit suite and the linter**

Run: `npm test` then `npm run lint`
Expected: PASS. `CustomStepPanel` gained a required prop, so fix any other call site the type checker names.

- [ ] **Step 7: Commit**

```bash
git add src/components/rail/SkillStepRunner.tsx src/components/rail/StationCard.tsx \
        src/components/rail/StepFocus.tsx src/components/rail/index.ts \
        tests/skill-step-runner.test.tsx
git commit -m "feat(skill-runs): run a step and show its results on the rail"
```

---

## Task 12: End-to-end proof and browser validation

**Files:**
- Create: `e2e/skill-run.spec.ts`
- Modify: `docs/superpowers/specs/2026-09-14-skill-run-execution-and-results-design.md` (status line only, once the work is proven)

**Interfaces:**
- Consumes: the hermetic Playwright project and the repository's convention that a browser end-to-end spec authenticates through the API rather than by driving the sign-in form, and skips two-factor.

- [ ] **Step 1: Write the failing spec**

`e2e/skill-run.spec.ts`, following the existing hermetic specs' setup helpers:

```ts
import { expect, test } from '@playwright/test';

import { signInThroughApi, seedCustomSkillStep } from './support/session';

test('an MD runs a custom step and keeps both results', async ({ page, request }) => {
  const { dealId, stepId } = await seedCustomSkillStep(request);
  await signInThroughApi(page, request);

  await page.goto(`/projects/${dealId}?step=${encodeURIComponent(stepId)}`);

  await page.getByLabel('Input').fill('Summarise the week for the board');
  await page.getByRole('button', { name: 'Draft this step' }).click();

  await expect(page.getByRole('button', { name: 'Draft this step' })).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByLabel('Input')).toHaveValue('Summarise the week for the board');

  await page.getByRole('button', { name: 'Draft this step' }).click();
  await expect(page.getByRole('button', { name: 'Draft this step' })).toBeEnabled({ timeout: 120_000 });

  const history = page.getByLabel('Run history').getByRole('button');
  await expect(history).toHaveCount(2);
});
```

`seedCustomSkillStep` belongs in `e2e/support/` and does three things through the service client the other seeds already use: create a deal, insert a published package row into the local bench database (`skill_publications`, with `skill_id`, `version_id`, `digest` and the zipped bytes of a one-file skill), and insert a `deal_steps` row with `origin = 'custom'` and a definition whose `skillBinding` names that exact skill, version and digest. It returns `{ dealId, stepId }`, where `stepId` is the text `custom:<uuid>` value. Reuse `zipSkillFolder` from the Ignatious package if it is reachable from the test environment; otherwise commit a small fixture zip beside the helper and hash it at seed time so the digest and the bytes cannot drift apart.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:e2e -- skill-run`
Expected: FAIL, no such input on the step surface until the seed and the flag are in place.

- [ ] **Step 3: Make it pass**

Enable `skill_authoring` in the hermetic fixture, make the seed insert a real published package into the local bench database, and correct whatever the run reveals. Do not weaken the assertions to make them pass: if the second run does not appear in history, fix the code rather than the expectation.

- [ ] **Step 4: Run every suite**

Run, in order:

```bash
npm test
npm run lint
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/deal_step_skill_runs.sql
npm run test:e2e
pnpm --filter @ignatious/skill-bench test
```

Expected: all green. `$DATABASE_URL` must name the local stack. Never point any of this at a hosted project.

- [ ] **Step 4b: Confirm the rollout gates**

- `skill_authoring` has no row in a fresh environment, so `resolveFlags` leaves it false and every Part D route answers 404. Confirm that by hitting one route with the flag row absent.
- The Ignatious route must be deployed before the flag is turned on in Conductia, or the stream route answers 503. Note that ordering in the pull request body.

- [ ] **Step 5: Validate in a real browser before opening the pull request**

Sign in with seeded credentials and walk the path by hand:

1. Add a step through the Part C builder and publish it.
2. Open the step, type an input, and watch the text stream in.
3. Confirm the input is unchanged when the result lands.
4. Run it again and confirm two history rows with the right actors, times and outcomes.
5. Select the older run and confirm its result is shown and the input still is not touched.
6. Confirm a generated document appears in the deal folder the skill named.
7. Mark the step complete and confirm nothing about the run did that on its own.
8. Start a run and close the tab, then reopen the step and confirm it shows the last recorded run with no stuck state.

- [ ] **Step 6: Commit**

```bash
git add e2e/skill-run.spec.ts e2e/support
git commit -m "test(skill-runs): prove the run path end to end"
```
