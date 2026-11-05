# Durable Skill Authoring Slimdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Part B of durable skill authoring down to what an MVP needs. Conductia's server calls one Ignatious turn endpoint directly, and the worker, fencing protocol, validators and split files go.

**Architecture:** The send and retry routes admit a `running` attempt, then use `after()` to call `POST /v1/bench/authoring/turns` on Ignatious, stream its NDJSON reply into `skill_authoring_attempts.response_text`, and finish the attempt. The browser polls the draft. Ignatious keeps generating and storing private candidate packages in its existing skill-bench Postgres.

**Tech Stack:**
- Conductia: Next.js 16 (`after` from `next/server`), Supabase Postgres (plpgsql, security definer), Vitest with React Testing Library.
- Ignatious skill-bench: Hono, Mastra agent streaming, zod, Postgres, Vitest, pnpm.

**Spec:**
- `docs/superpowers/specs/2026-09-11-durable-skill-authoring-slimdown.md`, the authority.
- `docs/superpowers/specs/2026-09-09-durable-skill-authoring-design.md`, amended by the slimdown spec.

## Global Constraints

- The browser calls only Conductia `/api/v1` routes. No browser code imports an Ignatious URL, key or client.
- Never point a command, test, seed, sign-in or dev server at hosted Supabase or any remote environment. Database tests run only against loopback disposable targets.
  - Conductia: `RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform`.
  - Ignatious: `SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform`, with a unique schema per test.
- Do not run Supabase CLI migration commands (`migration up`, `db reset`, `repair`, `--include-all`) against the shared local stack at 127.0.0.1:54322. Migrating that stack is the user's step.
- No live model calls. Ignatious tests use the existing fake model fixtures.
- Never write code comments or JSDoc prose. No em dash characters in visible product copy.
- Stage explicit file paths only. Never `git add -A` or `git add .`, never bare `git stash`, never push, never commit to `main`, `master` or `develop`.
- Never edit `/Users/cwillian/Documents/personal/learning/ignatious`, `/Users/cwillian/orca/workspaces/conductia/project-rail-model-impl`, or any `skill-publication-and-rail-insertion` worktree.
- There is no 300-line or 30-lines-per-function gate.
- Passing checks:
  - Conductia: `npx tsc --noEmit`, `npm run lint` with 0 errors, `npx prettier --check <touched files>`, `npm test`.
  - Ignatious: `pnpm --filter @ignatious/skill-bench typecheck`, `pnpm --filter @ignatious/skill-bench test`, `pnpm lint` from `platform/`.
- Implementers run focused tests only; the controller runs full suites one at a time.
- Never make a test pass by weakening assertions for behaviour that stays. Deleting tests for behaviour the spec removes is expected.
- Add no guardrail the spec does not list.
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XYDHqnkFuoUNotnHrGU4Qa`

## Repositories

- **C (Conductia):** `/Users/cwillian/orca/workspaces/conductia/durable-skill-authoring-implementation`, branch `durable-skill-authoring-implementation`.
- **I (Ignatious):** `/Users/cwillian/orca/workspaces/ignatious/feat-conductia-durable-authoring/platform`, branch `feat-conductia-durable-authoring`. The skill-bench source is under `apps/skill-bench/src`.

## Order

- **Wave 1:** Tasks I1 → I2 → I3 in Ignatious, and C1 in Conductia, in parallel.
- **Wave 2:** C2.
- **Wave 3:** C3 → C4.
- **Wave 4:** C5.

The controller tells the Part C session the exact file list before every commit, pushes, and updates both PR descriptions.

## Shared wire contract (both repos use this fixture verbatim in tests)

```text
{"type":"text","text":"Here is a draft "}
{"type":"text","text":"for the buyer tracker."}
{"type":"candidate","providerCandidateId":"6a1f2c9e-3b7d-5e10-8c4a-2f9b1d7e6a53","contentDigest":"66d2f3cda3148430b408c141dd7c6d644b11b543f280db363611ea88e03f22da","schemaVersion":1,"preview":{"name":"buyer-outreach-tracker","purpose":"Track buyer outreach","expectedInput":"Buyer list","expectedOutput":"Outreach table"}}
{"type":"done"}
```

---

### Task I1: Ignatious candidate store and turn line mapping

**Files (repo I, under `apps/skill-bench/src/authoring/`):**
- Create: `postgres/migrations/001_authoring_candidates.sql`
- Delete: `postgres/migrations/001_authoring.sql`, `postgres/migrations/002_candidate_content_fingerprint.sql`, `postgres/migrations/003_provider_admission_sequence.sql`
- Modify: `postgres/migrations.ts` so it lists only `001_authoring_candidates.sql`
- Create: `postgres/candidate-store.ts`
- Delete: `postgres/checkpoint-candidate-store.ts`
- Modify: `store-types.ts`. Keep `PrivateCandidateRecord`, `PrivateCandidateReader` and `PrivateCandidateSnapshot` unchanged, and delete the operation, outbox, checkpoint and fence types.
- Modify: `generator.ts`, `candidate-tool.ts`, `candidate-package.ts`. Remove `generation` and `checkpoint`, and remove event `sequence` numbering.
- Create: `turn-lines.ts`
- Test: `postgres/candidate-store.test.ts`, `turn-lines.test.ts`, and update `generator.test.ts` (plus any `generator-*.test.ts`)

**Interfaces:**
- Produces:
  - `class PostgresCandidateStore implements PrivateCandidateReader`, with `saveCandidate(attemptId: string, record: PrivateCandidateRecord): Promise<void>` and `readCandidate(providerCandidateId: string): Promise<PrivateCandidateSnapshot | null>`.
  - `type TurnLine`.
  - `lineFor(event: AuthoringGeneratedEvent): TurnLine`.
  - `AuthoringGenerateInput = { attemptId; history; message; currentCandidate: CandidatePreview | null }`.
  - `AuthoringGenerator.generate(input, sink, signal)`, unchanged in name.

- [ ] **Step 1: Write the failing store test.** Mirror the database setup in the existing `postgres/checkpoint-candidate-store.test.ts`: `uniqueAuthoringSchema`, `dropAuthoringTestSchema` from `testing.ts`, and the same SQL client.

```ts
it('saves a candidate once and reads it back by provider candidate id', async () => {
  const store = new PostgresCandidateStore(sql, schema);
  const record = candidateRecord({ providerCandidateId: PROVIDER_ID });
  await store.saveCandidate(ATTEMPT_ID, record);
  await store.saveCandidate(ATTEMPT_ID, { ...record, packageBytes: Buffer.from('changed') });
  const snapshot = await store.readCandidate(PROVIDER_ID);
  expect(snapshot?.contentDigest).toBe(record.contentDigest);
  expect(snapshot?.packageBytes.equals(record.packageBytes)).toBe(true);
});

it('returns null for an unknown candidate', async () => {
  const store = new PostgresCandidateStore(sql, schema);
  expect(await store.readCandidate(OTHER_ID)).toBeNull();
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/postgres/candidate-store.test.ts`. Expected: FAIL, the module is not found.

- [ ] **Step 3: Write the migration and the store.**

```sql
create table authoring_candidates (
  provider_candidate_id uuid primary key,
  attempt_id uuid not null,
  artifact_reference text not null unique,
  package_bytes bytea not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  content_fingerprint text not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index authoring_candidates_attempt_idx on authoring_candidates (attempt_id);
```

In `postgres/candidate-store.ts`, port `saveCandidate` and `readCandidate` from `checkpoint-candidate-store.ts` with the same client, schema quoting and row mapping. Remove the fence and any `authoring_operations` join, and make the insert `on conflict (provider_candidate_id) do nothing`. Wherever `preparePrivateCandidate` or its options referenced the checkpoint store, point them at `PostgresCandidateStore`.

- [ ] **Step 4: Write the failing line-mapping test.**

```ts
it('maps generator events to wire lines', () => {
  expect(lineFor({ type: 'text_delta', payload: { text: 'Hi' } })).toEqual({ type: 'text', text: 'Hi' });
  expect(lineFor({ type: 'terminal_success', payload: {} })).toEqual({ type: 'done' });
  expect(lineFor({ type: 'terminal_error', payload: { code: 'generation_failed', message: 'Generation could not complete. Try again.' } }))
    .toEqual({ type: 'error', code: 'generation_failed', message: 'Generation could not complete. Try again.' });
  expect(lineFor({ type: 'candidate', payload: CANDIDATE_PAYLOAD })).toEqual({ type: 'candidate', ...CANDIDATE_PAYLOAD });
});
```

`CANDIDATE_PAYLOAD` is the candidate line of the shared wire contract, without `type`.

- [ ] **Step 5: Implement `turn-lines.ts`, and simplify the generator.**

```ts
import type { AuthoringGeneratedEvent } from './generator.js';

export type CandidatePreview = {
  readonly name: string;
  readonly purpose: string;
  readonly expectedInput: string;
  readonly expectedOutput: string;
};

export type TurnLine =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'candidate';
      readonly providerCandidateId: string;
      readonly contentDigest: string;
      readonly schemaVersion: 1;
      readonly preview: CandidatePreview;
    }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

export function lineFor(event: AuthoringGeneratedEvent): TurnLine {
  const payload = event.payload;
  switch (event.type) {
    case 'text_delta':
      return { type: 'text', text: String(payload['text']) };
    case 'candidate':
      return {
        type: 'candidate',
        providerCandidateId: String(payload['providerCandidateId']),
        contentDigest: String(payload['contentDigest']),
        schemaVersion: 1,
        preview: payload['preview'] as CandidatePreview,
      };
    case 'terminal_success':
      return { type: 'done' };
    case 'terminal_error':
      return { type: 'error', code: String(payload['code']), message: String(payload['message']) };
  }
}
```

Edits to `generator.ts`:
- `AuthoringGenerateInput` becomes `{ attemptId, history, message, currentCandidate: CandidatePreview | null }`.
- `AuthoringGeneratedEvent` becomes `{ type, payload }`, with no `sequence`.
- `EventEmitter` drops sequence tracking and `successPayload`, so `terminal_success` has payload `{}` and `terminal_error` has `{ code: 'generation_failed', message: 'Generation could not complete. Try again.' }`.
- `messagesFor` prepends `{ role: 'assistant', content: 'Current candidate: ' + JSON.stringify(currentCandidate) }` when a candidate exists, in place of the checkpoint summary.
- `candidatePayload` drops `artifactReference`.
- `createCandidateTool` drops `generation`, and `PrivateCandidateInput` drops `generation`.
- Update the existing generator tests to match: remove sequence and generation assertions, and keep every behavioural assertion (text chunking, candidate capture, failure on tool error, abort).

- [ ] **Step 6: Run the focused tests.** Run `SKILL_BENCH_DATABASE_URL=... pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/postgres/candidate-store.test.ts src/authoring/turn-lines.test.ts src/authoring/generator`, then `pnpm --filter @ignatious/skill-bench typecheck`. Expected: the tests pass. Type errors are allowed only in files Task I2 deletes (worker, coordinator, delivery, service); list them in the report.

- [ ] **Step 7: Commit.** Stage the created, modified and deleted paths explicitly, then run `git commit -m "refactor(skill-bench): plain candidate store and turn line mapping"`.

### Task I2: Ignatious turn route, wiring, and worker removal

**Files (repo I):**
- Create: `apps/skill-bench/src/authoring/turn-route.ts`
- Create: `apps/skill-bench/src/authoring/authoring-config.ts`
- Delete these files from `apps/skill-bench/src/authoring/` together with their tests:
  - `worker.ts`, `worker-lease.ts`, `worker-config.ts`, `worker-test-fixtures.ts`
  - `coordinator.ts`, `coordinator-context.ts`, `coordinator-sink.ts`, `coordinator-test-fixtures.ts`, `coordinator-test-store.ts`
  - `context-builder.ts`, `delivery.ts`
  - `conductia-client.ts`, `conductia-client-errors.ts`, `conductia-client.fixtures.ts`
  - `contract/openapi.json`
  - `service.ts`, `store.ts`
  - `postgres/outbox-store.ts`, `postgres/operation-store.ts`, `postgres/fence.ts`
  - `e2e-conductia-events.ts`, `e2e-conductia-journal.ts`, `e2e-conductia-server.ts`, `e2e-conductia-state.ts`, `e2e-contract.ts`, `e2e-fixtures.ts`, `e2e-provider.ts`
- Modify:
  - `apps/skill-bench/src/authoring/contract.ts`: keep only `UuidSchema`.
  - `store-test-fixtures.ts`: keep only candidate fixtures.
  - `apps/skill-bench/src/server.ts`: mount the route.
  - `apps/skill-bench/src/main.ts`: build the generator.
  - `apps/skill-bench/src/index.ts`: remove worker, lease, worker-config and service exports; export `PostgresCandidateStore`, `AuthoringConfig`, `loadAuthoringConfig` and `TurnLine`.
  - `platform/docker-compose.yml`, plus the Terraform lines #126 added for `CONDUCTIA_AUTHORING_BASE_URL`, `CONDUCTIA_AUTHORING_SERVICE_TOKEN` and `SKILL_BENCH_AUTHORING*`. Find them with `git diff origin/main...HEAD -- docker-compose.yml infrastructure`. Do not touch `infrastructure/modules/api-alb/`.
- Test: `apps/skill-bench/src/authoring/turn-route.test.ts`

**Interfaces:**
- Consumes: `AuthoringGenerator`, `lineFor` and `TurnLine` from I1, and `UuidSchema`.
- Produces:
  - `mountAuthoringTurns(app: Hono, generator: AuthoringGenerator | null): void`
  - `type AuthoringConfig = { readonly databaseUrl: string | null; readonly schema: string }`
  - `loadAuthoringConfig(env: NodeJS.ProcessEnv): AuthoringConfig`
  - `createChatServer` options gain `authoringGenerator?: AuthoringGenerator | null`.

- [ ] **Step 1: Write the failing route test.** Build the app with `createChatServer`, reusing the options fixture in `src/server-test-fixture.ts` (or the existing server test setup), and pass a fake generator that emits the shared contract events.

```ts
it('streams NDJSON lines for an authorised turn', async () => {
  const app = serverWith({ authoringGenerator: fakeGenerator(CONTRACT_EVENTS) });
  const response = await app.request('/v1/bench/authoring/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': INBOUND_KEY },
    body: JSON.stringify(TURN_REQUEST),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  expect(await response.text()).toBe(SHARED_WIRE_CONTRACT);
});

it('rejects a missing api key', async () => {
  const app = serverWith({ authoringGenerator: fakeGenerator(CONTRACT_EVENTS) });
  const response = await app.request('/v1/bench/authoring/turns', { method: 'POST', body: JSON.stringify(TURN_REQUEST) });
  expect(response.status).toBe(401);
});

it('rejects an invalid body', async () => {
  const response = await authorisedPost(serverWith({ authoringGenerator: fakeGenerator([]) }), { message: '' });
  expect(response.status).toBe(400);
});

it('returns 503 when authoring is not configured', async () => {
  const response = await authorisedPost(serverWith({ authoringGenerator: null }), TURN_REQUEST);
  expect(response.status).toBe(503);
});
```

`SHARED_WIRE_CONTRACT` is the contract block above, with a trailing newline after each line. Match the actual API key header constant (`API_KEY_HEADER`) and the key the fixture configures.

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/turn-route.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the route and config.**

```ts
import type { Hono } from 'hono';
import { z } from 'zod';

import { UuidSchema } from './contract.js';
import type { AuthoringGenerator } from './generator.js';
import { lineFor, type TurnLine } from './turn-lines.js';

const PreviewSchema = z
  .object({ name: z.string(), purpose: z.string(), expectedInput: z.string(), expectedOutput: z.string() })
  .strict();

const TurnRequestSchema = z
  .object({
    attemptId: UuidSchema,
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).strict()),
    message: z.string().min(1).max(20_000),
    currentCandidate: PreviewSchema.nullable(),
  })
  .strict();

export function mountAuthoringTurns(app: Hono, generator: AuthoringGenerator | null): void {
  app.post('/authoring/turns', async c => {
    if (generator === null) return c.json({ error: 'authoring_unavailable' }, 503);
    const parsed = TurnRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const signal = c.req.raw.signal;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = async (line: TurnLine): Promise<void> => {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        };
        await generator.generate(parsed.data, event => write(lineFor(event)), signal).catch(() => undefined);
        controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
  });
}
```

```ts
export type AuthoringConfig = { readonly databaseUrl: string | null; readonly schema: string };

export function loadAuthoringConfig(env: NodeJS.ProcessEnv): AuthoringConfig {
  const databaseUrl = env['SKILL_BENCH_DATABASE_URL']?.trim();
  return {
    databaseUrl: databaseUrl ? databaseUrl : null,
    schema: env['SKILL_BENCH_AUTHORING_SCHEMA']?.trim() || 'skill_authoring',
  };
}
```

Match the names `worker-config.ts` used today for the database URL and schema. If they differ, keep the existing variable names so deployments need no change.

Wiring:
- In `server.ts`, add `authoringGenerator?: AuthoringGenerator | null` to the `createChatServer` options. Call `mountAuthoringTurns(app, options.authoringGenerator ?? null)` right after `app.use('*', apiKeyGuard(...))` (line 319 today), so the key guard protects the route.
- In `main.ts`, replace `loadAuthoringWorkerConfig` and `openAuthoringService` with the following, porting the client and migration calls from `service.ts` before deleting it: when `databaseUrl` is set, open the SQL client, run `postgres/migrations.ts`, construct `PostgresCandidateStore`, build the `DraftSkillPackageApi` the way `service.ts` did, and construct `AuthoringGenerator`. Pass it as `authoringGenerator`, close the SQL client on shutdown, and keep a one-line banner (`authoring  enabled` or `authoring  disabled`).

- [ ] **Step 4: Delete the worker stack.** Delete the listed files and their `*.test.ts` files, trim `contract.ts`, `store-test-fixtures.ts` and `index.ts`, and remove the environment and Terraform lines. Run `terraform fmt -check -recursive` in `infrastructure` if Terraform is installed (`mise exec terraform@1.9.8 -- terraform fmt -check -recursive`), and never run `init`, `plan` or `apply`.

- [ ] **Step 5: Run the checks.** Run `pnpm --filter @ignatious/skill-bench typecheck`, `SKILL_BENCH_DATABASE_URL=... pnpm --filter @ignatious/skill-bench exec vitest run src/authoring src/strip-types-boot.test.ts src/server-auth.test.ts`, and `pnpm lint`. Expected: PASS. The strip-types boot test must still pass, because it guards the production launch.

- [ ] **Step 6: Commit.** Stage explicit paths, then run `git commit -m "refactor(skill-bench): serve authoring turns directly and remove the worker"`.

### Task I3: Undo the file-size splits in Ignatious #126

**Files (repo I, `apps/skill-bench/src/`):**
- The `session.ts` split into `session-context.ts`, `session-run.ts` and `session-types.ts`, plus `session-start-log.test.ts`.
- The `turn-agent.ts` split into `turn-agent-bench-tools.ts`, `turn-agent-preparation.ts`, `turn-agent-profile.ts` and `turn-agent-workspace.ts`.
- The `server.test.ts` split into `server-*.test.ts` and `server-test-fixture.ts`.
- Any `recovery*.ts` split. Find it with `git diff --stat origin/main...HEAD -- apps/skill-bench/src ':!apps/skill-bench/src/authoring'`.
- Keep: `turn-agent-authoring.ts`, `turn-agent-authoring.test.ts`, `strip-types-boot.test.ts`.

**Interfaces:**
- Produces: no API change. `buildTurnAgent`'s authoring `toolPolicy` stays, because I1 uses it.

- [ ] **Step 1: Record the baseline.** Run `pnpm --filter @ignatious/skill-bench exec vitest run src --reporter=json --outputFile=/tmp/i3-before.json` with the loopback database env, and note the test count per behaviour area.
- [ ] **Step 2: Restore each cluster in turn.** Run `git checkout origin/main -- apps/skill-bench/src/session.ts`, then diff the restored file against the concatenated split files (`git show HEAD:<split file>` for each). Delete the split files only if the differences are moves and import rewiring. If a split carries a behaviour change, re-apply that change to the restored file in place and list it in the report.
  - For `turn-agent.ts`, the authoring tool policy is such a change and must be re-applied.
  - For `server.test.ts`, port every test case that exists in the split files but not in `origin/main`'s `server.test.ts` (for example the new cases in `server-auth.test.ts`) into the restored `server.test.ts`, then delete the split test files and `server-test-fixture.ts`.
- [ ] **Step 3: Verify.** Run typecheck, the full skill-bench tests with the loopback env, and `pnpm lint`. Expected: PASS, with no behaviour test lost. The report lists any test count difference and why.
- [ ] **Step 4: Commit.** Stage explicit paths, then run `git commit -m "refactor(skill-bench): undo file-size splits"`.

### Task C1: Conductia squashed schema and database probe

**Files (repo C):**
- Create: `supabase/migrations/20260916110000_skill_authoring.sql`
- Delete: every `supabase/migrations/20260909200000_skill_authoring_schema.sql` through `20260909203900_skill_authoring_claim_recent_messages_contract.sql` (20 files; list them with `ls supabase/migrations/202609092*`)
- Rewrite: `supabase/tests/skill_authoring.sql`
- Delete:
  - `supabase/tests/skill_authoring/` (10 files)
  - `supabase/tests/skill_authoring_admission_context.sql`, `skill_authoring_audit.sql`, `skill_authoring_audit/` (6 files), `skill_authoring_audit_helper_grants.sql`, `skill_authoring_claim_recent_messages_contract.sql`, `skill_authoring_patch_draft_optional_name.sql`, `skill_authoring_send_receipt_deal_code_identity.sql`
  - `tests/db/skill-authoring-admission-context.test.ts`, `-audit.test.ts`, `-audit-helper-grants.test.ts`, `-claim-recent-messages-contract.test.ts`, `-patch-draft-optional-name.test.ts`, `-send-receipt-deal-code-identity.test.ts`
- Modify: `tests/db/skill-authoring.test.ts`, `tests/skill-authoring-db-guard.test.ts` (trim to the loopback-accept, hosted-reject, non-postgres-reject and missing-URL-reject cases), and `tests/constants-schema-sync.test.ts` plus `src/lib/constants/*`, if they enumerate skill authoring attempt statuses.
- Keep: `tests/db/localDatabase.ts`

**Interfaces:**
- Produces:
  - SQL functions with the exact names in the spec's schema section.
  - The receipt from `skill_authoring_submit_message` and `skill_authoring_retry_message` gains `created boolean` and keeps its existing keys.
  - `skill_authoring_run_context(uuid) returns jsonb` with `{attemptId, history:[{role,content}], message, currentCandidate}` (camelCase keys, matching `TurnRequest` in C2).
  - `skill_authoring_record_progress(uuid, text) returns boolean`
  - `skill_authoring_complete_attempt(uuid, text, jsonb) returns boolean`
  - `skill_authoring_fail_attempt(uuid, text, text) returns boolean`
  - `skill_authoring_attempt_live(text, timestamptz) returns boolean`
  - `skill_authoring_lock_author(p_actor_id uuid, p_deal_id uuid, p_lock boolean default true)`
  - The draft projection keys used today, minus `event_cursor`, plus `response_text` on each attempt.

- [ ] **Step 1: Keep the old definitions for reference.** Run `git show a623beee:supabase/migrations/<file>` as needed. Before deleting, find the latest body of each kept function with `grep -l "function <name>(" supabase/migrations/20260909*.sql | tail -1`.

- [ ] **Step 2: Write the failing probe.** Rewrite `supabase/tests/skill_authoring.sql` in the same harness style `tests/db/skill-authoring.test.ts` runs today: an isolated schema and a rolled-back transaction, loading Part A's `20260916100000_project_rail_model.sql` and the new migration by path, with seed rows created inline. Each case raises an exception with a clear message on failure. Cases:
  1. `get_or_create_draft` returns the same active draft on a second call for the same author and deal.
  2. A second member cannot read or patch the first author's draft: `skill_authoring_forbidden` or `skill_authoring_draft_not_found`.
  3. A member without `company:deals:steps:structure` is refused by `lock_author`.
  4. `patch_draft` with a stale revision raises the conflict. An empty name is accepted.
  5. `submit_message` creates a `running` attempt with `created = true`. The same `clientMessageId` returns the same ids with `created = false`. A different message while that attempt is live raises the conflict.
  6. Setting `last_progress_at = now() - interval '2 minutes'` makes `read_draft` report the attempt as `failed` with `generation_interrupted`. A new `submit_message` then marks it `failed` in the table and admits a new `running` attempt.
  7. `run_context` returns earlier user messages paired with their latest succeeded `response_text`, the admitted message, and `currentCandidate` as the current preview.
  8. `record_progress` stores text. `complete_attempt` with a candidate inserts it, sets `current_candidate_id` and marks the attempt `succeeded`. A second `complete_attempt` and a later `fail_attempt` both return `false` and change nothing.
  9. After `discard_draft`, `complete_attempt` still succeeds but does not change `current_candidate_id`.
  10. `has_function_privilege('anon', 'skill_authoring_read_draft(uuid,uuid,uuid,uuid)', 'execute')` and the same for `authenticated` are false, and for `service_role` it is true.
  11. `audit_log` rows for `draft_created`, `message_admitted`, `attempt_transitioned` and `candidate_selected` exist, and no `detail` value contains the message or reply text.

- [ ] **Step 3: Run it and confirm it fails.** Run `RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform npx vitest run tests/db/skill-authoring.test.ts`. Expected: FAIL, because the migration file does not exist yet.

- [ ] **Step 4: Write the migration.**
  - Tables `skill_authoring_drafts` and `skill_authoring_messages` are copied verbatim from `20260909200000_skill_authoring_schema.sql` lines 1 to 42. Attempts and candidates are defined as follows:

```sql
create table skill_authoring_attempts (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references skill_authoring_drafts(id),
  message_id uuid not null,
  attempt_number integer not null check (attempt_number >= 1),
  retry_request_id uuid,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  response_text text not null default '',
  last_progress_at timestamptz not null default now(),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (message_id, attempt_number),
  unique (message_id, retry_request_id),
  unique (draft_id, id),
  foreign key (draft_id, message_id) references skill_authoring_messages(draft_id, id)
);

create unique index skill_authoring_one_running_attempt
  on skill_authoring_attempts(draft_id) where status = 'running';

create table skill_authoring_candidates (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references skill_authoring_drafts(id),
  attempt_id uuid not null,
  provider_candidate_id uuid not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  schema_version integer not null check (schema_version = 1),
  preview jsonb not null,
  created_at timestamptz not null default now(),
  unique (draft_id, provider_candidate_id),
  unique (draft_id, id),
  constraint skill_authoring_candidates_draft_provider_digest_key unique (draft_id, id, provider_candidate_id, content_digest),
  foreign key (draft_id, attempt_id) references skill_authoring_attempts(draft_id, id)
);
```

  - Then the deferrable `current_candidate_id` foreign key, RLS enabled on all four tables, and `grant select, insert, update, delete ... to service_role` for the four tables, all copied from the old schema file without the work and events lines.
  - **Audit.** Recreate `audit_log_action_check` with the existing base actions (copy the list from `20260909203000_skill_authoring_audit.sql` lines 11 to 19). Replace the skill authoring entries with `'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted', 'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied'`.
  - Keep the `service_identity` column exactly as `20260909203000` added it. Define the actor-or-service constraint as `constraint audit_log_actor_or_service_check check (actor_id is not null or service_identity is not null)`, using the column names from that migration.
  - `skill_authoring_write_audit(p_actor_id uuid, p_action text, p_deal_id uuid, p_detail jsonb)` is a plain insert that sets `service_identity` to `'conductia'` when `p_actor_id` is null. Copy the insert's column list from `20260909202900`, without any validator call.
  - **Functions.** Copy the latest body of `lock_author`, `raise_conflict`, `get_or_create_draft`, `patch_draft` (from `203700`), `discard_draft`, `read_draft`, `browser_draft`, `browser_messages`, `browser_attempt`, `browser_active_attempt` and `browser_candidate`, with these edits:
    - `lock_author` gains `p_lock boolean default true`; when false it selects the deal without `for update`. `read_draft` passes `false`.
    - `browser_draft` drops `event_cursor` and the visibility cursor.
    - `browser_attempt` returns `id, attempt_number, status, response_text, error_code, error_message`. When `status = 'running' and not skill_authoring_attempt_live(status, last_progress_at)` it reports `status 'failed'` and `error_code 'generation_interrupted'`, with `error_message 'Generation was interrupted. Try again.'`.
    - `browser_active_attempt` returns the live running attempt or null.
    - `submit_message` and `retry_message` keep their signatures, replay and conflict logic. Before the conflict check, they run `update skill_authoring_attempts set status = 'failed', error_code = 'generation_interrupted', error_message = 'Generation was interrupted. Try again.', completed_at = now() where draft_id = v_draft.id and status = 'running' and not skill_authoring_attempt_live(status, last_progress_at)`. They insert the attempt with default status `running` and no admission snapshot, work row or event insert, and add `'created', true` to a new receipt and `'created', false` to a replayed receipt.
  - Add the turn functions:

```sql
create or replace function skill_authoring_attempt_live(p_status text, p_last_progress_at timestamptz)
returns boolean language sql stable set search_path = public as $$
  select p_status = 'running' and p_last_progress_at > now() - interval '60 seconds';
$$;

create or replace function skill_authoring_run_context(p_attempt_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare v_attempt skill_authoring_attempts%rowtype; v_draft skill_authoring_drafts%rowtype; v_message skill_authoring_messages%rowtype;
begin
  select * into v_attempt from skill_authoring_attempts where id = p_attempt_id and status = 'running';
  if not found then return null; end if;
  select * into v_draft from skill_authoring_drafts where id = v_attempt.draft_id;
  select * into v_message from skill_authoring_messages where id = v_attempt.message_id;
  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'message', v_message.text,
    'history', coalesce((
      select jsonb_agg(turn order by ordinal, position)
      from (
        select m.ordinal, 1 as position, jsonb_build_object('role', 'user', 'content', m.text) as turn
        from skill_authoring_messages m
        where m.draft_id = v_draft.id and m.ordinal < v_message.ordinal
        union all
        select m.ordinal, 2, jsonb_build_object('role', 'assistant', 'content', a.response_text)
        from skill_authoring_messages m
        join lateral (
          select response_text from skill_authoring_attempts
          where message_id = m.id and status = 'succeeded' and response_text <> ''
          order by attempt_number desc limit 1
        ) a on true
        where m.draft_id = v_draft.id and m.ordinal < v_message.ordinal
      ) turns
    ), '[]'::jsonb),
    'currentCandidate', (select c.preview from skill_authoring_candidates c where c.id = v_draft.current_candidate_id)
  );
end;
$$;

create or replace function skill_authoring_record_progress(p_attempt_id uuid, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update skill_authoring_attempts set response_text = p_text, last_progress_at = now()
  where id = p_attempt_id and status = 'running';
  return found;
end;
$$;

create or replace function skill_authoring_complete_attempt(p_attempt_id uuid, p_text text, p_candidate jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype; v_attempt skill_authoring_attempts%rowtype; v_candidate_id uuid;
begin
  select d.* into v_draft from skill_authoring_drafts d
    join skill_authoring_attempts a on a.draft_id = d.id where a.id = p_attempt_id for update of d;
  if not found then return false; end if;
  select * into v_attempt from skill_authoring_attempts where id = p_attempt_id and status = 'running' for update;
  if not found then return false; end if;
  if p_candidate is not null then
    insert into skill_authoring_candidates (draft_id, attempt_id, provider_candidate_id, content_digest, schema_version, preview)
    values (v_draft.id, v_attempt.id, (p_candidate ->> 'providerCandidateId')::uuid, p_candidate ->> 'contentDigest', 1, p_candidate -> 'preview')
    on conflict (draft_id, provider_candidate_id) do nothing;
    select id into v_candidate_id from skill_authoring_candidates
      where draft_id = v_draft.id and provider_candidate_id = (p_candidate ->> 'providerCandidateId')::uuid;
    if v_draft.status = 'active' then
      update skill_authoring_drafts set current_candidate_id = v_candidate_id, updated_at = now() where id = v_draft.id;
      perform skill_authoring_write_audit(null, 'skill_authoring.candidate_selected', v_draft.deal_id,
        jsonb_build_object('draft_id', v_draft.id, 'attempt_id', v_attempt.id, 'candidate_id', v_candidate_id));
    end if;
  end if;
  update skill_authoring_attempts set status = 'succeeded', response_text = p_text, completed_at = now(), last_progress_at = now()
    where id = v_attempt.id;
  perform skill_authoring_write_audit(null, 'skill_authoring.attempt_transitioned', v_draft.deal_id,
    jsonb_build_object('draft_id', v_draft.id, 'attempt_id', v_attempt.id, 'status', 'succeeded'));
  return true;
end;
$$;

create or replace function skill_authoring_fail_attempt(p_attempt_id uuid, p_code text, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_deal_id uuid; v_draft_id uuid;
begin
  update skill_authoring_attempts a set status = 'failed', error_code = p_code, error_message = p_message, completed_at = now()
    from skill_authoring_drafts d
    where a.id = p_attempt_id and a.status = 'running' and d.id = a.draft_id
    returning d.deal_id, d.id into v_deal_id, v_draft_id;
  if not found then return false; end if;
  perform skill_authoring_write_audit(null, 'skill_authoring.attempt_transitioned', v_deal_id,
    jsonb_build_object('draft_id', v_draft_id, 'attempt_id', p_attempt_id, 'status', 'failed', 'error_code', p_code));
  return true;
end;
$$;

do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'skill_authoring\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;
end $$;
```

  - The grant loop runs only if the roles exist. Guard `anon` and `authenticated` with `if exists (select 1 from pg_roles where rolname = ...)`, the way the old migrations guarded role grants.

- [ ] **Step 5: Run the probe.** Run the same command as Step 3. Expected: PASS for all 11 cases.
- [ ] **Step 6: Delete the old migrations, probes and database tests.** Update `tests/db/skill-authoring.test.ts` to load only the new probe, and trim the db-guard test. Run `npx tsc --noEmit`, `npx vitest run tests/db tests/skill-authoring-db-guard.test.ts tests/constants-schema-sync.test.ts` (the database tests skip without env), and the Step 3 command again. Expected: PASS.
- [ ] **Step 7: Commit.** Stage explicit paths, then run `git commit -m "refactor(authoring): squash the skill authoring schema for direct turns"`.

### Task C2: Conductia turn runner, routes and server cleanup

**Files (repo C):**
- Create: `src/lib/skillAuthoring/ignatiousAuthoring.ts`, `src/lib/skillAuthoring/runTurn.ts`
- Modify:
  - `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/route.ts` and `.../messages/[messageId]/retry/route.ts`
  - `src/lib/skillAuthoring/browserRoute.ts`: drop the receipt identity-echo checks, map `created`, and keep the exports `callRpc`, `correlationId`, `readJson`, `RpcClient`, `isParsedError`, `normalizeDraft`, `normalizeSendReceipt`.
  - `src/lib/skillAuthoring/browserResponse.ts`: absorb `browserAttempt.ts`, add `responseText`, drop `eventCursor` and the camelCase fallback reader.
  - `src/lib/skillAuthoring/access.ts`: remove the tri-state `unreadable` and the fail-closed audit, and write the denial through `skill_authoring_write_audit`.
  - `src/lib/skillAuthoring/parse.ts`: delete event batch parsing. Keep `hasExactKeys`, `hasOnlyKeys`, `isNonnegativeInteger`, `isRecord`, `parsePlacement`, `UUID`, `parseMessageCommand`, `parseRetryCommand`.
  - `src/lib/skillAuthoring/types.ts`: attempt status `'running' | 'succeeded' | 'failed'`, add `responseText`, remove event and worker types.
  - `src/lib/api/v1/access.ts`: revert `userCanAccessDealChecked` if `access.ts` no longer needs it; check with `git diff 40da473d a623beee -- src/lib/api/v1/access.ts`.
  - `package.json`: remove `verify:skill-authoring-contract`.
  - `.env.example`: remove the `IGNATIOUS_AUTHORING_*` lines.
  - `openapi/phase1.json` and `docs/03-engineering/api-v1.md`: remove internal skill authoring entries and the events route.
- Delete:
  - `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/events/route.ts`
  - `src/app/api/v1/internal/skill-authoring/` (4 routes)
  - `src/lib/skillAuthoring/browserAttempt.ts`, `browserEventResponse.ts`, `internalRoute.ts`, `serviceAuth.ts`, `workerResponse.ts`, `workerResponseContext.ts`, `audit.ts`
  - `openapi/skill-authoring-internal.json`, `scripts/verify-skill-authoring-contract.ts`
  - These tests: `tests/skill-authoring-routes.test.ts`, `-route-behaviors.test.ts`, `-route-behaviors-details.test.ts`, `-route-event-behaviors.test.ts`, `-routes-conflicts.test.ts`, `-task15a-route.test.ts`, `-internal-routes.test.ts`, `-internal-attempt-routes.test.ts`, `-internal-error-matrix.test.ts`, `-openapi-boundaries.test.ts`, `-service-auth.test.ts`, `-service-auth-comparisons.test.ts`, `-service-auth-limiter.test.ts`, `-worker-response-boundaries.test.ts`, `-worker-validation.test.ts`, `-browser-response.test.ts`, `-audit.test.ts`
- Test:
  - Create `tests/skill-authoring-run-turn.test.ts`, `tests/skill-authoring-ignatious-authoring.test.ts`, `tests/skill-authoring-browser-routes.test.ts` and `tests/db/skill-authoring-draft-contract.test.ts`.
  - Trim `tests/skill-authoring-access.test.ts`.
  - Rename `tests/skill-authoring-contract.test.ts` to `tests/skill-authoring-parse.test.ts`, keeping only the command-parse cases.

**Interfaces:**
- Consumes: the C1 SQL names and the `created` receipt field. From the spec: the wire contract and the `IgnatiousConfig` type (`src/lib/ignatious/config.ts`: `benchUrl`, `apiKey`).
- Produces:
  - `streamAuthoringTurn(config: IgnatiousConfig, request: TurnRequest, signal: AbortSignal, fetchImpl?: typeof fetch): AsyncGenerator<TurnLine>`
  - `runAuthoringTurn(attemptId: string, deps: RunTurnDeps): Promise<void>`
  - `defaultTurnDeps(admin: RpcClient): RunTurnDeps`
  - `TurnRequest`, `TurnLine` and `TurnCandidate` types
  - The draft read shape `DraftRead` with `messages[].attempts[].responseText` and `activeAttempt`, and no `eventCursor`.

- [ ] **Step 1: Write the failing Ignatious client test.**

```ts
it('posts the turn with the bench key and yields parsed lines across chunk boundaries', async () => {
  const chunks = [SHARED_WIRE_CONTRACT.slice(0, 25), SHARED_WIRE_CONTRACT.slice(25)];
  const fetchImpl = vi.fn(async () => new Response(streamOf(chunks), { status: 200 }));
  const lines = [];
  for await (const line of streamAuthoringTurn(CONFIG, TURN_REQUEST, new AbortController().signal, fetchImpl)) lines.push(line);
  expect(lines.map((line) => line.type)).toEqual(['text', 'text', 'candidate', 'done']);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('http://bench.test/v1/bench/authoring/turns');
  expect(new Headers(init.headers).get('x-api-key')).toBe('bench-key');
  expect(JSON.parse(String(init.body))).toEqual(TURN_REQUEST);
});

it('throws on a non-2xx response', async () => {
  const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
  const iterate = async () => { for await (const _ of streamAuthoringTurn(CONFIG, TURN_REQUEST, new AbortController().signal, fetchImpl)) {} };
  await expect(iterate()).rejects.toThrow('401');
});
```

Set `CONFIG.benchUrl` to match how `createSkillBench` in `src/lib/ignatious/bench.ts` joins `benchUrl` and its `/chat` path. If `bench.ts` appends `/v1/bench/chat` to `benchUrl`, the turn path is `/v1/bench/authoring/turns`. If `benchUrl` already ends in `/v1/bench`, the path is `/authoring/turns`, and the expected URL changes accordingly.

- [ ] **Step 2: Implement `ignatiousAuthoring.ts`.**

```ts
import type { IgnatiousConfig } from "@/lib/ignatious/config";
import type { CandidatePreview } from "./types";

export type TurnRequest = {
  attemptId: string;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  currentCandidate: CandidatePreview | null;
};

export type TurnCandidate = {
  providerCandidateId: string;
  contentDigest: string;
  schemaVersion: 1;
  preview: CandidatePreview;
};

export type TurnLine =
  | { type: "text"; text: string }
  | ({ type: "candidate" } & TurnCandidate)
  | { type: "done" }
  | { type: "error"; code: string; message: string };

const TURN_PATH = "/v1/bench/authoring/turns";

export async function* streamAuthoringTurn(
  config: IgnatiousConfig,
  request: TurnRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<TurnLine> {
  const response = await fetchImpl(`${config.benchUrl}${TURN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.apiKey },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Authoring turn request failed with ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as TurnLine;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as TurnLine;
}
```

Adjust `TURN_PATH` per the Step 1 note.

- [ ] **Step 3: Write the failing turn runner test.** Use an injected clock and fake RPC recording `[fn, args]`.

```ts
it('streams progress, then completes with the full text and the last candidate', async () => {
  const clock = fakeClock();
  const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
  await runAuthoringTurn(ATTEMPT_ID, { rpc, stream: linesAdvancing(clock, CONTRACT_LINES, 600), deadlineMs: 50_000, now: clock.now });
  expect(rpc.calls).toContainEqual(["skill_authoring_record_progress", { p_attempt_id: ATTEMPT_ID, p_text: "Here is a draft " }]);
  expect(rpc.calls.at(-1)).toEqual(["skill_authoring_complete_attempt", {
    p_attempt_id: ATTEMPT_ID, p_text: "Here is a draft for the buyer tracker.", p_candidate: CONTRACT_CANDIDATE,
  }]);
});

it('fails the attempt with the error line code and message', async () => { });
it('fails the attempt when the stream ends without a terminal line', async () => { });
it('fails the attempt when the stream throws', async () => { });
it('fails the attempt when the deadline aborts the stream', async () => { });
it('does nothing when the attempt is no longer running', async () => { });
```

Write out each of the five remaining bodies in the same style:
- **Error line:** the calls end with `["skill_authoring_fail_attempt", { p_attempt_id, p_code: "generation_failed", p_message: "Generation could not complete. Try again." }]`, and there is no complete call.
- **Missing terminal line:** the stream yields two text lines only, and the last call is `fail_attempt` with `generation_failed`.
- **Stream throws:** the stream throws after one text line, and the last call is `fail_attempt`.
- **Deadline:** the stream awaits `signal` abort with `deadlineMs: 5`, and the last call is `fail_attempt`.
- **No longer running:** `run_context` returns `null`, the stream is never called, and `rpc.calls` has length 1.

- [ ] **Step 4: Implement `runTurn.ts`.**

```ts
import { readIgnatiousConfig } from "@/lib/ignatious/config";
import type { RpcClient } from "./browserRoute";
import { streamAuthoringTurn, type TurnCandidate, type TurnLine, type TurnRequest } from "./ignatiousAuthoring";

export const PROGRESS_FLUSH_MS = 500;
export const KEEPALIVE_MS = 10_000;
export const TURN_DEADLINE_MS = 280_000;
export const GENERATION_FAILED = "generation_failed";
export const GENERATION_FAILED_MESSAGE = "Generation could not complete. Try again.";

export type RunTurnDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
  stream: (request: TurnRequest, signal: AbortSignal) => AsyncIterable<TurnLine>;
  deadlineMs: number;
  now?: () => number;
};

export async function runAuthoringTurn(attemptId: string, deps: RunTurnDeps): Promise<void> {
  const context = (await deps.rpc("skill_authoring_run_context", { p_attempt_id: attemptId })) as TurnRequest | null;
  if (!context) return;
  const now = deps.now ?? Date.now;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deps.deadlineMs);
  let text = "";
  let lastFlush = now();
  let candidate: TurnCandidate | null = null;
  const flush = async () => {
    lastFlush = now();
    await deps.rpc("skill_authoring_record_progress", { p_attempt_id: attemptId, p_text: text });
  };
  const fail = (code: string, message: string) =>
    deps.rpc("skill_authoring_fail_attempt", { p_attempt_id: attemptId, p_code: code, p_message: message });
  const keepalive = setInterval(() => void flush().catch(() => undefined), KEEPALIVE_MS);
  try {
    for await (const line of deps.stream(context, controller.signal)) {
      if (line.type === "text") {
        text += line.text;
        if (now() - lastFlush >= PROGRESS_FLUSH_MS) await flush();
      } else if (line.type === "candidate") {
        const { type: _type, ...rest } = line;
        candidate = rest;
      } else if (line.type === "done") {
        await deps.rpc("skill_authoring_complete_attempt", { p_attempt_id: attemptId, p_text: text, p_candidate: candidate });
        return;
      } else {
        await fail(line.code, line.message);
        return;
      }
    }
    await fail(GENERATION_FAILED, GENERATION_FAILED_MESSAGE);
  } catch {
    await fail(GENERATION_FAILED, GENERATION_FAILED_MESSAGE).catch(() => undefined);
  } finally {
    clearTimeout(deadline);
    clearInterval(keepalive);
  }
}

export function defaultTurnDeps(admin: RpcClient): RunTurnDeps {
  const config = readIgnatiousConfig();
  return {
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
    stream: (request, signal) => {
      if (!config) throw new Error("Ignatious is not configured");
      return streamAuthoringTurn(config, request, signal);
    },
    deadlineMs: TURN_DEADLINE_MS,
  };
}
```

Match `admin.rpc`'s return shape to `RpcClient` in `browserRoute.ts`. The runner test checks that a candidate line's `type` is stripped before `complete_attempt`.

- [ ] **Step 5: Wire the routes.** In both the messages and retry routes:

```ts
import { after, NextResponse } from "next/server";
import { defaultTurnDeps, runAuthoringTurn } from "@/lib/skillAuthoring/runTurn";

export const maxDuration = 300;
```

After the RPC succeeds:

```ts
const receipt = normalizeSendReceipt(result.data);
if (!receipt) return jsonError("Unable to process skill authoring request.", 500);
if (receipt.created) {
  const deps = defaultTurnDeps(auth.admin as unknown as RpcClient);
  after(() => runAuthoringTurn(receipt.attemptId, deps));
}
return NextResponse.json(receipt);
```

`normalizeSendReceipt` and the retry receipt normalizer read `created` and the attempt id from the receipt JSON C1 returns, and no longer compare it with the URL.

- [ ] **Step 6: Write the browser route test.** Port the mock setup from `tests/skill-authoring-routes.test.ts` (flag, `requireApiUser`, access, admin RPC) and add `vi.mock("next/server", async (orig) => ({ ...(await orig()), after: vi.fn() }))`. Cases:
  1. Flag off returns the flag response for each route.
  2. Access denied returns 403.
  3. An invalid body returns 400.
  4. A new send returns the receipt and calls `after` once.
  5. A replayed send (`created: false`) does not call `after`.
  6. Retry behaves the same way.
  7. `GET` draft returns the normalized draft with `responseText`.
  8. A stale `PATCH` returns 409 with the draft.
  9. Discard returns 200.

- [ ] **Step 7: Write the SQL-to-TypeScript draft contract probe.** In `tests/db/skill-authoring-draft-contract.test.ts`, reuse `tests/db/localDatabase.ts`, the new migration and the rolled-back isolated schema. Seed a draft with one succeeded attempt, one running attempt and a candidate, run `skill_authoring_read_draft`, and pass the JSON through `normalizeDraft`. Assert non-null, `activeAttempt.responseText`, and the candidate preview name.

- [ ] **Step 8: Delete the listed files and trim the rest.** Run `npx tsc --noEmit`, then `npx vitest run tests/skill-authoring-run-turn.test.ts tests/skill-authoring-ignatious-authoring.test.ts tests/skill-authoring-browser-routes.test.ts tests/skill-authoring-access.test.ts tests/skill-authoring-parse.test.ts`, then `RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform npx vitest run tests/db/skill-authoring-draft-contract.test.ts tests/db/skill-authoring.test.ts`. Expected: PASS. Component and hook type errors are allowed only in files C3 rewrites; list them in the report.

- [ ] **Step 9: Commit.** Stage explicit paths, then run `git commit -m "refactor(authoring): run turns from Conductia and remove the worker API"`.

### Task C3: Conductia client data layer

**Files (repo C):**
- Rewrite: `src/lib/skillAuthoring/useSkillAuthoringDraft.ts`
- Modify: `src/lib/skillAuthoring/client.ts`, and the call sites in `src/components/rail/SkillBuilderDialog.tsx` and `skillBuilderDialogState.ts`. Change these only as far as needed to use the new hook and drop the conflict branch; C4 merges the files.
- Delete:
  - `src/lib/skillAuthoring/useSkillAuthoringCommands.ts`, `useSkillAuthoringDraftActions.ts`, `useSkillAuthoringDraftController.ts`, `useSkillAuthoringDraftShared.ts`, `useSkillAuthoringDraftState.ts`, `useSkillAuthoringPersistence.ts`, `useSkillAuthoringPolling.ts`, `reducer.ts`, `clientReceipt.ts`, `clientResponse.ts`
  - These tests: `tests/skill-authoring-hook-authoritative.test.ts`, `-hook-fix-round-u2.test.ts`, `-hook-fix-round-u4.test.ts`, `-hook-flush-coverage.test.ts`, `-hook-mutations.test.ts`, `-hook-recovery.test.ts`, `-hook-round4.test.ts`, `-hook-stale-polls.test.ts`, `-client-receipt.test.ts`, `-client-response.test.ts`, `-reducer.test.ts`, `-task15a.test.ts`, `-unnamed-first-message.test.ts`
- Test: create `tests/skill-authoring-hook.test.ts`; modify `tests/skill-authoring-client.test.ts`.

**Interfaces:**
- Consumes: `DraftRead` and the routes from C2.
- Produces:

```ts
export type LocalDraft = DraftRead;
export type DraftFields = Partial<Pick<DraftRead, "name" | "placement" | "composerText">>;
export type SkillAuthoringDraft = {
  status: "loading" | "ready" | "forbidden" | "error";
  draft: LocalDraft | null;
  saveState: "saved" | "saving" | "error";
  sending: boolean;
  updateFields: (fields: DraftFields) => void;
  send: () => Promise<boolean>;
  retry: (messageId: string) => Promise<void>;
  discard: () => Promise<boolean>;
  flush: () => Promise<boolean>;
};
export function nonterminal(attempt: { status: string } | null | undefined): boolean;
export function freshId(): string;
export function useSkillAuthoringDraft(projectId: string, client?: SkillAuthoringClient): SkillAuthoringDraft;

export type SkillAuthoringClient = {
  open(projectId: string): Promise<DraftRead>;
  read(projectId: string, draftId: string): Promise<DraftRead>;
  patch(projectId: string, draftId: string, body: { expectedEditRevision: number } & DraftFields): Promise<DraftRead>;
  send(projectId: string, draftId: string, body: { clientMessageId: string; expectedEditRevision: number; text: string }): Promise<unknown>;
  retry(projectId: string, draftId: string, messageId: string, body: { retryRequestId: string }): Promise<unknown>;
  discard(projectId: string, draftId: string): Promise<void>;
};
export class SkillAuthoringHttpError extends Error { status: number; draft: DraftRead | null }
```

Field and body names must match the C2 route parsers. Read `parse.ts` for `parseMessageCommand`, `parseRetryCommand` and the patch parser, and use those names if they differ.

- [ ] **Step 1: Write the failing hook tests.** Use fake timers with a pinned now constant, a fake `SkillAuthoringClient`, and `renderHook`. Cases:
  1. It opens the draft and reports `ready`; a 403 on open reports `forbidden`.
  2. Rapid `updateFields` calls produce one `patch` after 500 ms, with the latest fields and current revision.
  3. A `patch` rejected with 409 and a server draft adopts the server revision and patches again once with the local fields.
  4. `send` flushes pending edits first, posts a fresh `clientMessageId`, clears the composer, and ignores a second `send` while the first is in flight.
  5. A failed `send` keeps the composer text and sets `sending` false.
  6. With an active attempt the hook reads every 1000 ms, and without one every 10 000 ms.
  7. A 403 during polling reports `forbidden` and stops reads.
  8. `retry` posts a fresh `retryRequestId` and re-reads.
  9. A first message on an unnamed draft is sent (ported from `skill-authoring-unnamed-first-message.test.ts`).
  10. `discard` flushes, then discards, and returns true.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/skill-authoring-hook.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the hook and client.** The hook holds `draft` in state and a ref:
  - **Debounce:** a timer ref.
  - **Save loop:** one in-flight promise ref, plus an `again` flag when edits arrive mid-save. When a request returns, adopt the server draft, but keep local `name`, `placement` and `composerText` edited after the request started.
  - **409:** on a `SkillAuthoringHttpError` with status 409 and a draft, adopt the server revision and patch once more.
  - **Send:** a synchronous `sendingRef` guard, set before the first `await`.
  - **Poll:** one `useEffect` keyed on draft id and whether `activeAttempt` exists. It schedules `read` with `setTimeout` at 1000 ms or 10 000 ms and clears it in cleanup.
  - **Exports:** `nonterminal` returns `status === "running"`, and `freshId` uses `crypto.randomUUID()`.
  - **Client:** `client.ts` keeps the same-origin `/api/v1/deals/${projectId}/skill-drafts...` URLs. It throws `SkillAuthoringHttpError` with `status`, plus `draft` when the body has one, and does no response shape validation.

- [ ] **Step 4: Update the dialog call sites.** Update `SkillBuilderDialog.tsx` and `skillBuilderDialogState.ts` to the new hook: remove the Keep mine and Reload saved conflict branch and the `beforeunload` listener. Run `npx tsc --noEmit`, then `npx vitest run tests/skill-authoring-hook.test.ts tests/skill-authoring-client.test.ts tests/skill-builder-dialog.test.tsx tests/skill-authoring-rail-entry.test.tsx`. Expected: the new tests pass. Dialog test failures that test removed behaviour are expected, and C4 deletes them; list them.

- [ ] **Step 5: Commit.** Stage explicit paths, then run `git commit -m "refactor(authoring): one draft hook polling the draft read"`.

### Task C4: Dialog and rail consolidation

**Files (repo C):**
- Modify: `src/components/rail/SkillBuilderDialog.tsx` (absorb `SkillBuilderDialogChrome.tsx`, `SkillBuilderDialogParts.tsx`, `skillBuilderDialogState.ts`), `SkillAuthoringConversation.tsx`, `SkillBuilderPlacementFields.tsx` (absorb `placementLabels.ts` and the placement helpers, re-exporting the same label export names), `RailTimeline.tsx` (inline `RailTimelineHeader.tsx`), `DealRail.tsx` (inline `DealRailLoading.tsx` as the loading branch of the existing ternary, so `SkillBuilderLauncherDialog` stays mounted), and `src/components/rail/index.ts` (revert Part B's changes: `git diff 40da473d a623beee -- src/components/rail/index.ts`).
- Delete: `SkillBuilderDialogChrome.tsx`, `SkillBuilderDialogParts.tsx`, `skillBuilderDialogState.ts`, `placementLabels.ts`, `RailTimelineHeader.tsx`, `DealRailLoading.tsx`
- Test: rewrite `tests/skill-builder-dialog.test.tsx`; trim `tests/skill-authoring-rail-entry.test.tsx` (drop the duplicate restore and not-permitted cases); update `tests/helpers/skillBuilderDialogFixtures.tsx`; delete `tests/skill-builder-dialog-close-discard.test.tsx`, `-fix-round-c1.test.tsx`, `-fix-round-n2-1.test.tsx`, `-fix-round-r2.test.tsx`, `-fix-round-u1.test.tsx`, `-fix-round-u2-2.test.tsx`, `-fix-round-u3.test.tsx`, `-layout.test.tsx`, `-lifecycle.test.tsx`

**Interfaces:**
- Consumes: `useSkillAuthoringDraft` from C3.
- Produces: `SkillBuilderDialog` and `SkillBuilderLauncher` exports with the same names and props as today. The Part C session re-applies its wiring onto them.

- [ ] **Step 1: Write the dialog behaviour tests** with `userEvent`, role queries and the fixtures helper:
  1. The dialog restores the draft name, placement and messages.
  2. A spaces-only name shows the name field error copy and does not show a conflict banner.
  3. A rail without phased steps shows the phase start and end help text.
  4. While an attempt is active its `responseText` is visible.
  5. A failed newest message shows Retry, and older failed messages do not.
  6. Send is disabled while sending.
  7. A candidate shows "Ready to save" and a disabled Save.
  8. Close and Escape save then close, and a failed save keeps the dialog open with the save error message.
  9. Discard asks for confirmation, then discards.
  10. A forbidden draft shows the not-permitted view.
  11. The footer order matches today's (read it from `SkillBuilderDialogChrome.tsx` before merging).

  For each case, port the exact copy strings from the existing test files rather than inventing new copy.

- [ ] **Step 2: Run them against the pre-merge files.** Run `npx vitest run tests/skill-builder-dialog.test.tsx`. The behaviour should already pass except where C3 removed conflict or unload behaviour. Record the result.

- [ ] **Step 3: Merge the files.** Move the component code into `SkillBuilderDialog.tsx` as module-level components. Remove wrappers that only pass props through, and components defined only to meet the old line gate. Keep visible copy byte-identical. Inline the two rail components.

- [ ] **Step 4: Run the checks.** Run `npx tsc --noEmit`, `npx vitest run tests/skill-builder-dialog.test.tsx tests/skill-authoring-rail-entry.test.tsx tests/rail`, `npm run lint`, and `npx prettier --check` on the touched files. Expected: PASS.

- [ ] **Step 5: Commit.** Stage explicit paths, then run `git commit -m "refactor(authoring): merge the builder dialog and inline rail extractions"`.

### Task C5: Final verification and handoff

**Files:** none new. Controller work plus a verification report at `.superpowers/sdd/2026-09-09-durable-skill-authoring/slimdown-verification.md` (git-ignored).

- [ ] **Step 1: Conductia.** Run `npx tsc --noEmit`, `npm run lint`, `npm test`, and then the database lane with the loopback URL: `RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform npx vitest run tests/db --no-file-parallelism`. Record the counts.
- [ ] **Step 2: Ignatious.** Run `pnpm --filter @ignatious/skill-bench typecheck`, `SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform pnpm --filter @ignatious/skill-bench test`, `pnpm lint`, and the Terraform `fmt -check`. Record the counts.
- [ ] **Step 3: File count.** Run `git diff --shortstat 40da473d HEAD` and `git diff --name-only --diff-filter=A 40da473d HEAD | wc -l` in Conductia, and `git diff --shortstat origin/main...HEAD` in Ignatious. Compare with the review's targets.
- [ ] **Step 4: Search for leftovers.** Run `git grep -nE 'skill_authoring_(work|events)|event_cursor|fencing|claim_work|serviceAuth|IGNATIOUS_AUTHORING_SERVICE_TOKEN|verify:skill-authoring-contract'` in Conductia, and `git grep -nE 'worker-lease|outbox|fence|conductia-client|CONDUCTIA_AUTHORING'` in Ignatious. Expected: no matches outside docs history.
- [ ] **Step 5: Hand off.**
  - Push both branches.
  - Replace both PR descriptions with the slimmed summary, the verification counts, and the rollout notes: set `maxDuration` per the Vercel plan, and migrate the shared local stack as a user step.
  - Send Part C the migration filename, harness path, hook, dialog and state export names, Ignatious migration and type names, and the audit constraint expression.
- [ ] **Step 6: Local manual check.** Offer the user a local smoke test with one or two billed model calls. Run it only with the user's explicit approval.
