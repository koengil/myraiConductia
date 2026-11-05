# Durable Skill Authoring Implementation Plan

**Status:** Superseded by docs/superpowers/plans/2026-09-11-durable-skill-authoring-slimdown.md. The worker, fencing and internal API below were not built.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver durable, author-private skill drafts in Conductia and an Ignatious-hosted background authoring worker that produces recoverable response events and private validated skill candidates.

**Architecture:** Conductia owns the browser API, canonical draft journal, work inbox, leases, fencing generations, and event ingestion. Ignatious polls the Conductia internal contract, admits each attempt once in its operational Postgres database, generates with an authoring-only tool policy, stores private candidate bytes, and retries its delivery outbox until Conductia acknowledges a contiguous event sequence. Part B stops at a valid candidate preview; Part C owns publication and rail insertion.

**Tech Stack:** Conductia: Next.js 16 App Router, React 19, TypeScript, Supabase/Postgres, Tailwind 4, Vitest and RTL. Ignatious: Node 22 ESM, TypeScript, Hono, Mastra, Zod 4, `pg` through `@ignatious/postgres`, Vitest, Docker Compose, Terraform/ECS.

**Spec:** `docs/superpowers/specs/2026-09-09-durable-skill-authoring-design.md`

## Global Constraints

- The Conductia browser calls only Conductia `/api/v1` routes. No browser code may import an Ignatious URL, key, conversation ID as authority, or provider client.
- Ignatious remains responsible for creating, validating, and storing skill packages through the new draft-only authoring adapter. Existing live-library `create_skill`, `commit_skill_version`, upload, and name-replacement paths are forbidden in authoring mode.
- Every skill candidate is still created through an Ignatious-owned package API. Part B adds the private `DraftSkillPackageApi`; it does not reimplement skill-package creation in Conductia.
- Part B must not publish a skill, create a project step, or claim publication success. The Save action remains visible but unavailable until Part C.
- Conductia is authoritative for drafts, composer text, messages, attempts, visible events, candidate metadata, and recovery state. Ignatious is authoritative only for operational admission, checkpoints, private candidate bytes, and delivery outbox state.
- Use `company:deals:steps:structure`; do not add another authoring permission. The Conductia implementation starts after Part A's permission migration is present. If it has not merged, extract that migration as a shared prerequisite instead of duplicating it.
- Never write code comments or JSDoc prose. Preserve existing comments when editing surrounding files unless they become false.
- No em dash characters in visible product copy.
- Never point a command, migration, seed, test, sign-in, or dev server at hosted Supabase. Database tests run only after validating a disposable local URL.
- Conductia database probes use `RUN_DB_TESTS=1` and `DATABASE_URL`; they skip by default and reject non-local hosts.
- Ignatious authoring mode must refuse startup unless its operational Postgres URL and service credential are present. It has no in-memory durable fallback.
- Every multi-row Conductia author mutation is a `security definer` function that begins by locking its `deals` row with `select ... for update`.
- Conductia event ingestion and Ignatious operation/outbox writes enforce the fencing generation in their own databases.
- Work in feature branches. Suggested branches are `feat/durable-skill-authoring` in Conductia and `feat/conductia-durable-authoring` in Ignatious. Never commit to `main` or `master`.
- Conductia work is done when merged to `develop`. Do not deploy either repository as part of this plan.

## Execution Order

Tasks 1 through 7 establish the Conductia contract and persistence boundary. Tasks 8 through 14 implement the Ignatious consumer and worker against that fixed contract. Tasks 15 through 17 complete the Conductia browser experience. Task 18 verifies the two repositories together.

Once Task 7 is committed, Tasks 8 through 14 and Tasks 15 through 17 can proceed in parallel. Within each repository, preserve task order.

## File Structure

### Conductia new files

| Path | Responsibility |
|---|---|
| `src/lib/skillAuthoring/types.ts` | Provider-neutral browser and internal-contract types and status constants. |
| `src/lib/skillAuthoring/parse.ts` | Strict parsers for browser mutations and worker event batches. |
| `src/lib/skillAuthoring/access.ts` | One fail-closed authoring authorization helper. |
| `src/lib/skillAuthoring/serviceAuth.ts` | Fixed provider/deployment service credential verification. |
| `src/lib/skillAuthoring/audit.ts` | Content-free application-level denial audit helper. |
| `src/lib/skillAuthoring/client.ts` | Browser-only Conductia API client. |
| `src/lib/skillAuthoring/reducer.ts` | Pure polling/event reconciliation and dialog state reducer. |
| `src/lib/skillAuthoring/useSkillAuthoringDraft.ts` | Restore, autosave, submit, retry, discard, and polling orchestration. |
| `src/components/rail/SkillBuilderDialog.tsx` | Recoverable Workbench builder dialog. |
| `src/components/rail/SkillCandidatePreview.tsx` | Validated candidate preview and unavailable Part B Save boundary. |
| `src/components/rail/SkillAuthoringConversation.tsx` | Ordered messages, attempt history, partial response, and retry controls. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts` | Get or create the current author's draft. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/route.ts` | Restore and autosave one draft. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/route.ts` | Durable message admission. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/[messageId]/retry/route.ts` | Explicit retry. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/events/route.ts` | Contiguous event polling. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/discard/route.ts` | Archive an active draft. |
| `src/app/api/v1/internal/skill-authoring/work/claim/route.ts` | Authenticated worker claim. |
| `src/app/api/v1/internal/skill-authoring/attempts/[attemptId]/lease/route.ts` | Lease renewal and reconciliation status. |
| `src/app/api/v1/internal/skill-authoring/attempts/[attemptId]/context/route.ts` | Lease-scoped immutable history pages. |
| `src/app/api/v1/internal/skill-authoring/attempts/[attemptId]/events/route.ts` | Fenced event ingestion and contiguous acknowledgement. |
| `openapi/skill-authoring-internal.json` | Canonical worker contract owned by Conductia. |
| `supabase/migrations/20260909200000_skill_authoring_schema.sql` | Draft, message, attempt, work, event, and candidate tables. |
| `supabase/migrations/20260909201000_skill_authoring_author_functions.sql` | Get/create, autosave, submit, retry, and discard functions. |
| `supabase/migrations/20260909202000_skill_authoring_worker_functions.sql` | Claim, renew, context, and event-ingestion functions. |
| `supabase/migrations/20260909203000_skill_authoring_audit.sql` | Content-free audit writes attached to author and worker transitions. |
| `supabase/tests/skill_authoring.sql` | Local psql behavioral probe. |
| `tests/db/skill-authoring.test.ts` | Guarded Vitest wrapper for the probe. |
| `tests/skill-authoring-contract.test.ts` | Type/parser/OpenAPI agreement. |
| `tests/skill-authoring-routes.test.ts` | Browser route authorization and RPC mapping. |
| `tests/skill-authoring-internal-routes.test.ts` | Service auth and worker route mapping. |
| `tests/skill-authoring-reducer.test.ts` | Pure event and conflict reconciliation. |
| `tests/skill-builder-dialog.test.tsx` | Approved dialog states and recovery behavior. |
| `tests/skill-authoring-rail-entry.test.tsx` | Add step visibility and open/restore behavior. |

### Conductia modified files

| Path | Change |
|---|---|
| `src/lib/flags/keys.ts` | Add `skill_authoring`. |
| `.env.example` | Document the inbound authoring service credential and fixed deployment. |
| `openapi/phase1.json` | Link the internal authoring contract in the development API index metadata. |
| `src/components/rail/RailTimeline.tsx` | Add the top-right Add step entry point. |
| `src/components/rail/DealRail.tsx` | Own dialog open state and pass the project rail phases/steps. |
| `src/components/rail/index.ts` | Export the builder components. |

### Ignatious new files

| Path | Responsibility |
|---|---|
| `platform/apps/skill-bench/src/authoring/contract.ts` | Zod schemas and types for the pinned Conductia contract. |
| `platform/apps/skill-bench/src/authoring/contract/openapi.json` | Pinned copy of Conductia's canonical internal OpenAPI document. |
| `platform/apps/skill-bench/src/authoring/conductia-client.ts` | Claim, renew, context, and deliver HTTP client. |
| `platform/apps/skill-bench/src/authoring/postgres/migrations/001_authoring.sql` | Operations, checkpoints, candidates, and event outbox. |
| `platform/apps/skill-bench/src/authoring/store.ts` | Transactional operation, fencing, checkpoint, candidate, and outbox store. |
| `platform/apps/skill-bench/src/authoring/candidate-package.ts` | Validate, zip, digest, and persist a private package without staging it live. |
| `platform/apps/skill-bench/src/authoring/candidate-tool.ts` | Authoring-only `propose_skill_candidate` Mastra tool. |
| `platform/apps/skill-bench/src/authoring/generator.ts` | Authoring-only turn adapter and product event stream. |
| `platform/apps/skill-bench/src/authoring/coordinator.ts` | Idempotent admission, fencing, context checkpoints, and one operation runner. |
| `platform/apps/skill-bench/src/authoring/delivery.ts` | Durable outbox delivery and contiguous acknowledgement cleanup. |
| `platform/apps/skill-bench/src/authoring/worker.ts` | Claim loop, lease renewal, reconciliation, and graceful stop. |
| `platform/apps/skill-bench/src/authoring/testing.ts` | Disposable Postgres schema and fake Conductia server helpers. |
| `platform/apps/skill-bench/src/authoring/*.test.ts` | Unit and Postgres-backed tests beside each module. |

### Ignatious modified files

| Path | Change |
|---|---|
| `platform/apps/skill-bench/package.json` | Add `@ignatious/postgres`. |
| `platform/apps/skill-bench/src/config.ts` | Parse the opt-in authoring worker configuration and require Postgres. |
| `platform/apps/skill-bench/src/turn-agent.ts` | Select an explicit tool policy so authoring cannot receive live publication tools. |
| `platform/apps/skill-bench/src/main.ts` | Migrate/start/stop the authoring worker with the service. |
| `platform/apps/skill-bench/src/index.ts` | Export authoring seams needed by tests. |
| `platform/docker-compose.yml` | Supply local authoring URL, deployment, token, and enabled switch. |
| `platform/infrastructure/modules/demo/main.tf` | Inject fixed Conductia URL/deployment and the shared authoring secret. |

---

### Task 1: Freeze the Conductia contract and flag

**Repository:** Conductia

**Files:**
- Create: `src/lib/skillAuthoring/types.ts`
- Create: `src/lib/skillAuthoring/parse.ts`
- Create: `tests/skill-authoring-contract.test.ts`
- Create: `openapi/skill-authoring-internal.json`
- Modify: `src/lib/flags/keys.ts`

**Interfaces:**
- Produces: `DraftStatus`, `AttemptStatus`, `DraftPatch`, `MessageCommand`, `RetryCommand`, `DiscardCommand`, `AuthoringEvent`, `DraftRead`, `ClaimResponse`, `LeaseResponse`, `ContextPage`, `EventBatch`, `EventAck`, `EventPage`, and the five strict parsers.
- Consumed by: every later Conductia task and Ignatious Task 8.

- [ ] **Step 1: Write failing contract tests**

Create `tests/skill-authoring-contract.test.ts` with focused cases:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseDraftPatch,
  parseEventBatch,
  parseMessageCommand,
} from '@/lib/skillAuthoring/parse';

describe('skill authoring contract', () => {
  it('accepts an exact message command', () => {
    expect(parseMessageCommand({
      clientMessageId: '11111111-1111-4111-8111-111111111111',
      expectedEditRevision: 3,
      text: 'Draft a weekly update.',
    })).toEqual({
      clientMessageId: '11111111-1111-4111-8111-111111111111',
      expectedEditRevision: 3,
      text: 'Draft a weekly update.',
    });
  });

  it('rejects empty messages and negative revisions', () => {
    expect(parseMessageCommand({ text: '', expectedEditRevision: -1 })).toEqual({
      error: 'Message text, clientMessageId, and a nonnegative expectedEditRevision are required.',
    });
  });

  it('rejects an event batch with two payloads for one sequence', () => {
    expect(parseEventBatch({
      generation: 2,
      events: [
        { sequence: 1, type: 'text_delta', payload: { text: 'a' }, payloadDigest: 'aa' },
        { sequence: 1, type: 'text_delta', payload: { text: 'b' }, payloadDigest: 'bb' },
      ],
    })).toEqual({ error: 'An event batch cannot repeat a sequence.' });
  });

  it('keeps OpenAPI event and status enums aligned', () => {
    const api = JSON.parse(readFileSync('openapi/skill-authoring-internal.json', 'utf8'));
    expect(api.components.schemas.AuthoringEvent.properties.type.enum).toEqual([
      'text_delta', 'candidate', 'terminal_success', 'terminal_error',
    ]);
    expect(api.components.schemas.AttemptStatus.enum).toEqual([
      'queued', 'running', 'reconciling', 'succeeded', 'failed',
    ]);
  });
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `npx vitest run tests/skill-authoring-contract.test.ts`

Expected: FAIL because `@/lib/skillAuthoring/parse` and the OpenAPI file do not exist.

- [ ] **Step 3: Define the exact shared types**

Create `src/lib/skillAuthoring/types.ts` with these public unions and records:

```ts
export const DRAFT_STATUS = ['active', 'archived', 'published'] as const;
export type DraftStatus = (typeof DRAFT_STATUS)[number];

export const ATTEMPT_STATUS = ['queued', 'running', 'reconciling', 'succeeded', 'failed'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUS)[number];

export const AUTHORING_EVENT_TYPE = [
  'text_delta', 'candidate', 'terminal_success', 'terminal_error',
] as const;
export type AuthoringEventType = (typeof AUTHORING_EVENT_TYPE)[number];

export type Placement =
  | { kind: 'phase_start'; phaseIndex: number }
  | { kind: 'phase_end'; phaseIndex: number }
  | { kind: 'after'; phaseIndex: number; afterStepId: string };

export type DraftPatch = {
  expectedEditRevision: number;
  name: string;
  placement: Placement | null;
  composerText: string;
};

export type MessageCommand = {
  clientMessageId: string;
  expectedEditRevision: number;
  text: string;
};

export type RetryCommand = { retryRequestId: string };
export type DiscardCommand = { expectedEditRevision: number };

export type CandidatePreview = {
  id: string;
  artifactReference: string;
  digest: string;
  schemaVersion: 1;
  name: string;
  purpose: string;
  expectedInput: string;
  expectedOutput: string;
};

export type AuthoringEvent = {
  cursor: number;
  attemptId: string;
  sequence: number;
  type: AuthoringEventType;
  payload: Record<string, unknown>;
  payloadDigest: string;
};

export type AttemptRead = {
  id: string;
  messageId: string;
  number: number;
  status: AttemptStatus;
  responseText: string;
  error: { code: string; message: string } | null;
};

export type DraftRead = {
  id: string;
  dealId: string;
  status: DraftStatus;
  name: string;
  placement: Placement | null;
  composerText: string;
  editRevision: number;
  messages: Array<{ id: string; ordinal: number; text: string; attempts: AttemptRead[] }>;
  activeAttempt: AttemptRead | null;
  candidate: CandidatePreview | null;
  eventCursor: number;
  publication: { available: false };
};

export type ClaimResponse = {
  attemptId: string;
  generation: number;
  leaseExpiresAt: string;
  contractVersion: 1;
  context: {
    throughMessageOrdinal: number;
    candidate: CandidatePreview | null;
    checkpointVersion: number;
    recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
};

export type LeaseResponse = { leaseExpiresAt: string; generation: number };

export type ContextPage = {
  messages: Array<{ ordinal: number; role: 'user' | 'assistant'; content: string }>;
  nextBeforeOrdinal: number | null;
  throughMessageOrdinal: number;
};

export type EventBatch = {
  generation: number;
  contractVersion: 1;
  events: Omit<AuthoringEvent, 'attemptId' | 'cursor'>[];
};

export type EventAck = { capturedThrough: number; terminal: boolean };

export type EventPage = {
  events: AuthoringEvent[];
  nextCursor: number;
  activeAttempt: AttemptRead | null;
};
```

- [ ] **Step 4: Implement strict pure parsers**

Create `src/lib/skillAuthoring/parse.ts`. Export the five parsers named above. Use record/type guards, UUID validation, integer validation, trimmed nonempty message text, placement validation, and duplicate sequence detection. Return `{ error: string }` on invalid input rather than throwing. Keep these exact limits: message and composer text 20,000 characters; name 100; one event batch 100 events; each text delta 32,000 characters.

The `parseEventBatch` success return must preserve the received payload and require `contractVersion === 1`, `generation >= 1`, `sequence >= 1`, one of the four event types, and a lowercase 64-character SHA-256 hex digest.

- [ ] **Step 5: Write the canonical OpenAPI document**

Create `openapi/skill-authoring-internal.json` with OpenAPI 3.1 operations for claim, lease, context, and events. Define all request/response schemas from `types.ts`, bearer authentication, the fixed event/status enums, conflict responses, and `x-conductia-contract-version: 1`.

No browser route belongs in this document. `openapi/phase1.json` remains the browser/platform contract.

- [ ] **Step 6: Register the feature flag**

Add to `FLAG_REGISTRY` in `src/lib/flags/keys.ts`:

```ts
skill_authoring: {
  description:
    'Private durable skill authoring and candidate preview. Off = Add step is hidden and no new authoring message is admitted.',
},
```

- [ ] **Step 7: Run the contract tests**

Run: `npx vitest run tests/skill-authoring-contract.test.ts tests/flags.test.ts tests/flags-resolve.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/skillAuthoring/types.ts src/lib/skillAuthoring/parse.ts \
  tests/skill-authoring-contract.test.ts openapi/skill-authoring-internal.json \
  src/lib/flags/keys.ts
git commit -m "feat(authoring): define the durable authoring contract"
```

---

### Task 2: Create the Conductia authoring schema

**Repository:** Conductia

**Files:**
- Create: `supabase/migrations/20260909200000_skill_authoring_schema.sql`
- Create: `tests/skill-authoring-schema.test.ts`

**Interfaces:**
- Consumes: status/event values from Task 1.
- Produces: six authoring tables and their uniqueness, RLS, foreign-key, and lifecycle constraints.
- Consumed by: Tasks 3 through 7.

- [ ] **Step 1: Write a failing migration-shape test**

Create `tests/skill-authoring-schema.test.ts` that reads the migration and asserts all table names, partial unique indexes, RLS statements, service-role grants, and exact CHECK values:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20260909200000_skill_authoring_schema.sql',
  'utf8',
).toLowerCase();

describe('skill authoring schema migration', () => {
  it.each([
    'skill_authoring_drafts',
    'skill_authoring_messages',
    'skill_authoring_attempts',
    'skill_authoring_work',
    'skill_authoring_events',
    'skill_authoring_candidates',
  ])('creates and protects %s', (table) => {
    expect(sql).toContain(`create table ${table}`);
    expect(sql).toContain(`alter table ${table} enable row level security`);
  });

  it('enforces one active draft and one nonterminal attempt', () => {
    expect(sql).toMatch(/unique[\s\S]*deal_id[\s\S]*author_id[\s\S]*where[\s\S]*status = 'active'/);
    expect(sql).toMatch(/unique[\s\S]*draft_id[\s\S]*where[\s\S]*status in \('queued', 'running', 'reconciling'\)/);
  });
});
```

- [ ] **Step 2: Run the shape test and verify failure**

Run: `npx vitest run tests/skill-authoring-schema.test.ts`

Expected: FAIL because the migration does not exist.

- [ ] **Step 3: Write the schema migration**

Create `supabase/migrations/20260909200000_skill_authoring_schema.sql` with:

```sql
create table skill_authoring_drafts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id),
  author_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active','archived','published')),
  name text not null default '' check (char_length(name) <= 100),
  phase_index integer,
  placement_kind text check (placement_kind is null or placement_kind in ('phase_start','phase_end','after')),
  anchor_deal_step_id uuid references deal_steps(id),
  composer_text text not null default '' check (char_length(composer_text) <= 20000),
  edit_revision bigint not null default 0 check (edit_revision >= 0),
  current_candidate_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  published_at timestamptz,
  check ((placement_kind = 'after') = (anchor_deal_step_id is not null)),
  check ((status = 'archived') = (archived_at is not null)),
  check ((status = 'published') = (published_at is not null))
);

create unique index skill_authoring_one_active_draft
  on skill_authoring_drafts(deal_id, author_id) where status = 'active';
```

Add the five dependent tables with the exact columns from the spec. Include no expiry column or expiry job: active and archived drafts persist until an explicit future retention policy exists. Required keys are:

```sql
unique (draft_id, client_message_id)
unique (draft_id, ordinal)
unique (message_id, attempt_number)
unique (message_id, retry_request_id)
unique (attempt_id)
unique (attempt_id, sequence)
unique (draft_id, provider_candidate_id)
```

Store event and preview bodies as `jsonb`; store `payload_digest` and candidate `content_digest` as 64-character lowercase hex with CHECK constraints. Give every event a monotonically increasing `event_cursor bigint generated always as identity`; `(attempt_id, sequence)` remains its provider idempotency key, while `event_cursor` is the draft polling cursor. Store the candidate's opaque `artifact_reference` separately from its provider candidate ID. Put `draft_id` directly on attempts so the partial unique index can enforce one nonterminal attempt. Add the deferred foreign key from `drafts.current_candidate_id` after candidates exists.

Enable RLS on all six tables. Grant all operations to `service_role`; grant nothing directly to `authenticated` or `anon`. Add indexes for active draft lookup, eligible work ordered by `available_at`, attempt context order, and event sequence.

- [ ] **Step 4: Run schema checks**

Run: `npx vitest run tests/skill-authoring-schema.test.ts tests/constants-schema-sync.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260909200000_skill_authoring_schema.sql \
  tests/skill-authoring-schema.test.ts
git commit -m "feat(authoring): add the durable draft schema"
```

---

### Task 3: Add Conductia author operations

**Repository:** Conductia

**Files:**
- Create: `supabase/migrations/20260909201000_skill_authoring_author_functions.sql`
- Create: `src/lib/skillAuthoring/access.ts`
- Create: `tests/skill-authoring-access.test.ts`

**Interfaces:**
- Consumes: `company:deals:steps:structure` and Task 2 tables.
- Produces: `requireSkillAuthoringAccess`, `skill_authoring_get_or_create_draft`, `skill_authoring_patch_draft`, `skill_authoring_submit_message`, `skill_authoring_retry_message`, `skill_authoring_discard_draft`.
- Consumed by: Task 5 browser routes.

- [ ] **Step 1: Write failing authorization tests**

Create `tests/skill-authoring-access.test.ts` with a mocked Supabase client. Cover deal missing, no membership, external member, unreadable profile, absent permission, and the one success case. Assert unreadable checks return `{ ok: false, status: 500 }`, while known denials return 403.

Use this result contract:

```ts
export type SkillAuthoringAccess =
  | { ok: true; deal: { id: string; bankId: string }; userId: string }
  | { ok: false; status: 403 | 404 | 500; message: string };
```

- [ ] **Step 2: Run the access test and verify failure**

Run: `npx vitest run tests/skill-authoring-access.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement fail-closed authorization**

Create `src/lib/skillAuthoring/access.ts`. `requireSkillAuthoringAccess(admin, userId, dealId)` must:

1. load `deals.id, bank_id` by UUID or code using the repository's deal resolver;
2. call `userCanAccessDeal`;
3. require `classifyInternalUser(...) === 'internal'`;
4. call `hasCompanyPermissionChecked(..., COMPANY_PERMISSION.DEAL_STEPS_STRUCTURE)` against `bank_id`;
5. distinguish unreadable checks from known denials.

Do not accept author ID or bank ID from request data.

- [ ] **Step 4: Write the author database functions**

Create `supabase/migrations/20260909201000_skill_authoring_author_functions.sql`. Each function takes `p_actor_id` and `p_deal_id`, locks the deal first, rechecks active internal membership and `app_has_company_permission`, and returns a row or raises a stable SQLSTATE/message consumed by routes.

Use these exact signatures:

```sql
skill_authoring_get_or_create_draft(p_actor_id uuid, p_deal_id uuid, p_correlation_id uuid)
skill_authoring_patch_draft(p_actor_id uuid, p_deal_id uuid, p_draft_id uuid,
  p_expected_revision bigint, p_name text, p_phase_index integer,
  p_placement_kind text, p_anchor_step_id uuid, p_composer_text text, p_correlation_id uuid)
skill_authoring_submit_message(p_actor_id uuid, p_deal_id uuid, p_draft_id uuid,
  p_expected_revision bigint, p_client_message_id uuid, p_text text, p_correlation_id uuid)
skill_authoring_retry_message(p_actor_id uuid, p_deal_id uuid, p_draft_id uuid,
  p_message_id uuid, p_retry_request_id uuid, p_correlation_id uuid)
skill_authoring_discard_draft(p_actor_id uuid, p_deal_id uuid, p_draft_id uuid,
  p_expected_revision bigint, p_correlation_id uuid)
```

`submit_message` must insert the message, attempt, and work row in the same transaction and clear composer text only when its exact current value equals `p_text`; otherwise it leaves composer text intact. Replayed identical client IDs return the existing message/attempt. Conflicting reuse, stale revision, archived lifecycle, and another nonterminal attempt are conflicts.

`retry_message` requires the latest attempt for that message to be `failed`, preserves all old attempts, and creates exactly one attempt/work pair per retry request ID.

`discard_draft` archives without touching an admitted work row or attempt.

Revoke public execution and grant execution only to `service_role` for every function.

- [ ] **Step 5: Run authorization tests**

Run: `npx vitest run tests/skill-authoring-access.test.ts tests/skill-authoring-schema.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260909201000_skill_authoring_author_functions.sql \
  src/lib/skillAuthoring/access.ts tests/skill-authoring-access.test.ts
git commit -m "feat(authoring): add durable author commands"
```

---

### Task 4: Add Conductia worker functions

**Repository:** Conductia

**Files:**
- Create: `supabase/migrations/20260909202000_skill_authoring_worker_functions.sql`
- Create: `tests/skill-authoring-worker-sql.test.ts`

**Interfaces:**
- Consumes: Task 2 schema and Task 3 admitted work.
- Produces: `skill_authoring_claim_work`, `skill_authoring_renew_lease`, `skill_authoring_read_context`, `skill_authoring_ingest_events`.
- Consumed by: Task 6 internal routes.

- [ ] **Step 1: Write failing SQL-shape tests**

Create `tests/skill-authoring-worker-sql.test.ts`. Read the migration and assert:

```ts
expect(sql).toContain('for update skip locked');
expect(sql).toContain('fencing_generation = fencing_generation + 1');
expect(sql).toContain('skill_authoring_claim_work');
expect(sql).toContain('skill_authoring_renew_lease');
expect(sql).toContain('skill_authoring_read_context');
expect(sql).toContain('skill_authoring_ingest_events');
expect(sql).toContain('highest_contiguous_sequence');
```

- [ ] **Step 2: Run the SQL-shape test and verify failure**

Run: `npx vitest run tests/skill-authoring-worker-sql.test.ts`

Expected: FAIL because the migration does not exist.

- [ ] **Step 3: Implement claim and renewal**

Create the migration and these signatures:

```sql
skill_authoring_claim_work(p_provider text, p_deployment text, p_worker_id text,
  p_lease_seconds integer, p_allow_admitted_before timestamptz, p_correlation_id uuid)
skill_authoring_renew_lease(p_attempt_id uuid, p_provider text, p_deployment text,
  p_worker_id text, p_generation bigint, p_lease_seconds integer, p_correlation_id uuid)
```

Claim selects one eligible row with `for update skip locked`, ordered by `available_at, created_at`. It includes queued rows and expired running/reconciling rows. It increments the fencing generation before returning it. An expired attempt becomes reconciling unless it was never admitted upstream.

The flag-off caller passes the disable timestamp as `p_allow_admitted_before`; claim may drain rows accepted before that timestamp and cannot claim later rows. Renewal requires exact provider, deployment, worker, generation, and unexpired current ownership.

Before initial execution, re-check the author's current project membership and `company:deals:steps:structure`. If access is gone, atomically mark the attempt failed and insert one system-origin `terminal_error` event with a complete local sequence; return no project context and do not create a worker lease. This preserves the same event-journal invariant as a provider failure.

- [ ] **Step 4: Implement scoped context**

Add:

```sql
skill_authoring_read_context(p_attempt_id uuid, p_provider text, p_deployment text,
  p_worker_id text, p_generation bigint, p_before_ordinal bigint, p_limit integer,
  p_correlation_id uuid)
```

Require the live lease. Return only messages and contiguous assistant responses at or before the attempt's immutable message watermark. Cap `p_limit` at 100. If the author lost access after execution began, deny new context pages without changing already-captured events.

- [ ] **Step 5: Implement fenced event ingestion**

Add:

```sql
skill_authoring_ingest_events(p_attempt_id uuid, p_provider text, p_deployment text,
  p_worker_id text, p_generation bigint, p_events jsonb, p_correlation_id uuid)
```

Lock the attempt and work rows. Validate exact ownership and generation. For every event, insert or compare the stored digest. A different digest for an existing sequence returns a typed conflict result and leaves event/domain rows unchanged; Task 7's replacement records the conflict audit in that transaction before returning, so the audit survives instead of being rolled back by an exception. Compute `highest_contiguous_sequence` from sequence 1. Apply text deltas only in sequence order. Insert candidate metadata idempotently, but set `current_candidate_id` only after terminal success and only if the draft is active. A terminal event changes status only after its declared `lastSequence` is contiguous.

Return `{ captured_through, terminal }`. Revoke public execution and grant only `service_role`.

- [ ] **Step 6: Run SQL-shape tests**

Run: `npx vitest run tests/skill-authoring-worker-sql.test.ts tests/skill-authoring-schema.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260909202000_skill_authoring_worker_functions.sql \
  tests/skill-authoring-worker-sql.test.ts
git commit -m "feat(authoring): add fenced worker operations"
```

---

### Task 5: Expose the Conductia browser routes

**Repository:** Conductia

**Files:**
- Create: the six browser route files listed in File Structure
- Create: `tests/skill-authoring-routes.test.ts`

**Interfaces:**
- Consumes: parsers from Task 1, authorization from Task 3, author RPCs from Task 3, and `requireFlag('skill_authoring')`.
- Produces: the complete browser API consumed by Task 15.

- [ ] **Step 1: Write failing route tests**

Mock `requireFlag`, `requireApiUser`, `requireSkillAuthoringAccess`, and `admin.rpc`. Cover:

```ts
it('404s before authentication when the flag is off');
it('does not pass request-supplied author identity to an RPC');
it('maps stale edit revision to 409 with authoritative draft state');
it('returns the same receipt for an idempotent message replay');
it('returns the active attempt when another message is nonterminal');
it('keeps discard separate from close');
it('returns only events after the requested cursor');
```

For each route, call the exported handler with a real `Request` and asserted params.

- [ ] **Step 2: Run route tests and verify failure**

Run: `npx vitest run tests/skill-authoring-routes.test.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Add one thin route pattern**

Every handler follows this order:

```ts
const flag = await requireFlag('skill_authoring');
if (flag) return flag;
const auth = await requireApiUser();
if (!auth.ok) return auth.response;
const access = await requireSkillAuthoringAccess(auth.admin, auth.user.id, dealId);
if (!access.ok) return jsonError(access.message, access.status);
```

Then parse the body, create or validate one UUID correlation ID for the request, call exactly one RPC with `p_actor_id: auth.user.id`, `p_deal_id: access.deal.id`, and `p_correlation_id`, map known SQL conflicts to 409/422, and normalize database snake case into Task 1's camel-case `DraftRead`.

- [ ] **Step 4: Implement all six routes**

Use:

- collection `POST` for get-or-create;
- draft `GET` for restore and `PATCH` for autosave;
- messages `POST` for admission;
- retry `POST` for a known failed message;
- events `GET` with a nonnegative integer `after`, default 0;
- discard `POST` with `expectedEditRevision`.

No route calls Ignatious. Provider outages cannot change message-admission status.

- [ ] **Step 5: Run browser-route tests**

Run: `npx vitest run tests/skill-authoring-routes.test.ts tests/skill-authoring-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/v1/deals/[dealId]/skill-drafts' tests/skill-authoring-routes.test.ts
git commit -m "feat(authoring): expose durable draft routes"
```

---

### Task 6: Authenticate and expose the Conductia worker routes

**Repository:** Conductia

**Files:**
- Create: `src/lib/skillAuthoring/serviceAuth.ts`
- Create: the four internal route files listed in File Structure
- Create: `tests/skill-authoring-internal-routes.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 1 internal types/parsers and Task 4 RPCs.
- Produces: `requireSkillAuthoringService(request)` and the HTTP contract consumed by Ignatious.

- [ ] **Step 1: Write failing service-auth and route tests**

Cover missing/malformed/wrong bearer token, current and previous token acceptance, removal of the previous token, fixed provider/deployment derivation, no secret in logs or response, per-source authentication throttling with a fake clock, claim, renew, context, event acknowledgement, stale generation conflict, and flag-off drain behavior.

Use the exact success result:

```ts
{ ok: true, service: { provider: 'ignatious', deployment: string } }
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run tests/skill-authoring-internal-routes.test.ts`

Expected: FAIL because service auth and routes do not exist.

- [ ] **Step 3: Implement constant-time service authentication**

`requireSkillAuthoringService` reads `IGNATIOUS_AUTHORING_SERVICE_TOKEN`, optional `IGNATIOUS_AUTHORING_SERVICE_TOKEN_PREVIOUS`, and `IGNATIOUS_AUTHORING_DEPLOYMENT` at request time. Parse `Authorization: Bearer <token>`, compare fixed-length SHA-256 digests with `timingSafeEqual`, and accept either configured digest during a rotation overlap. Return a generic 401 for every mismatch. Never accept provider or deployment from a body or query.

Add a bounded fixed-window limiter for failed authentication with both a global bucket and a source bucket keyed by the trusted platform source-address header, falling back to `unknown`. Allow 10 failures per minute per source and 100 globally, cap retained buckets, return 429 after either limit, and clear a source bucket after successful authentication. Inject clock and limiter state in tests.

Document in `.env.example`:

```dotenv
# IGNATIOUS_AUTHORING_SERVICE_TOKEN=
# IGNATIOUS_AUTHORING_SERVICE_TOKEN_PREVIOUS=
# IGNATIOUS_AUTHORING_DEPLOYMENT=local
```

- [ ] **Step 4: Implement the four internal routes**

Claim accepts `{ workerId, leaseSeconds, contractVersion: 1 }`. Lease accepts `{ workerId, generation, leaseSeconds }`. Context accepts `workerId`, `generation`, `beforeOrdinal`, and `limit` query parameters. Every handler creates or validates one UUID correlation ID and passes `p_correlation_id`. Events use `parseEventBatch` and add the authenticated fixed provider/deployment plus path attempt ID before calling the RPC.

Browser session authentication is never used on these routes. Browser cookies alone cannot pass service authentication.

When the feature flag is off, claim calculates the flag row's `updated_at` and passes it as the admitted-before cutoff. Existing admitted rows drain; no browser route can add another. Lease/context/events remain callable for current work.

- [ ] **Step 5: Run internal-route tests**

Run: `npx vitest run tests/skill-authoring-internal-routes.test.ts tests/skill-authoring-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skillAuthoring/serviceAuth.ts src/app/api/v1/internal/skill-authoring \
  tests/skill-authoring-internal-routes.test.ts .env.example
git commit -m "feat(authoring): expose the worker bridge"
```

---

### Task 7: Complete Conductia contract documentation and audit records

**Repository:** Conductia

**Files:**
- Create: `supabase/migrations/20260909203000_skill_authoring_audit.sql`
- Create: `src/lib/skillAuthoring/audit.ts`
- Modify: `src/lib/skillAuthoring/access.ts`
- Modify: `src/lib/skillAuthoring/serviceAuth.ts`
- Modify: `openapi/phase1.json`
- Modify: `tests/skill-authoring-contract.test.ts`
- Create: `tests/skill-authoring-audit.test.ts`

**Interfaces:**
- Consumes: all Conductia operations from Tasks 1 through 6.
- Produces: fixed contract snapshot revision and content-free audit vocabulary for Tasks 8 and 18.

- [ ] **Step 1: Add failing audit and documentation tests**

Assert the internal OpenAPI document includes all four routes, version 1, bearer auth, and no composer/transcript fields. Assert audit payload builders include IDs, actor/service, state transition, and correlation ID while excluding `text`, `composerText`, `skillMdText`, `referenceFiles`, and credentials.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run tests/skill-authoring-contract.test.ts tests/skill-authoring-audit.test.ts`

Expected: FAIL on missing audit events and API index metadata.

- [ ] **Step 3: Add the audit events**

Create a forward-only audit migration. It replaces the Task 3 and Task 4 functions with versions that persist these event names through the existing `audit_log` shape at the same transaction boundary as each state change. Do not edit the earlier migration files:

```text
skill_authoring.draft_created
skill_authoring.draft_archived
skill_authoring.message_admitted
skill_authoring.attempt_transitioned
skill_authoring.lease_taken_over
skill_authoring.event_conflict
skill_authoring.candidate_selected
skill_authoring.access_denied
```

Payloads contain only draft/message/attempt/candidate IDs, from/to state, provider/deployment, fencing generation, and request correlation ID.

Known authorization denials have no domain mutation to share a transaction with. Add `writeSkillAuthoringDenialAudit` using the existing service-role client and record them immediately before returning 403 from browser access checks or 401/429 from service authentication. Audit failure must be observable and fail closed for the requested operation.

- [ ] **Step 4: Add contract metadata**

Add an `x-internal-contracts` entry to `openapi/phase1.json` pointing at `openapi/skill-authoring-internal.json`. Record the Task 6 Conductia commit, the fixed parent revision against which the final contract metadata is authored, in `info.x-source-revision` before committing Task 7 and handing the snapshot to Ignatious. Do not attempt to embed Task 7's self-referential commit hash.

- [ ] **Step 5: Run the full Conductia boundary tests**

Run: `npx vitest run tests/skill-authoring-contract.test.ts tests/skill-authoring-access.test.ts tests/skill-authoring-schema.test.ts tests/skill-authoring-worker-sql.test.ts tests/skill-authoring-routes.test.ts tests/skill-authoring-internal-routes.test.ts tests/skill-authoring-audit.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add openapi/phase1.json openapi/skill-authoring-internal.json \
  supabase/migrations/20260909203000_skill_authoring_audit.sql \
  src/lib/skillAuthoring/audit.ts src/lib/skillAuthoring/access.ts \
  src/lib/skillAuthoring/serviceAuth.ts \
  tests/skill-authoring-contract.test.ts tests/skill-authoring-audit.test.ts
git commit -m "docs(authoring): freeze the worker contract"
```

---

### Task 8: Pin the contract and build the Ignatious Conductia client

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/contract/openapi.json`
- Create: `platform/apps/skill-bench/src/authoring/contract.ts`
- Create: `platform/apps/skill-bench/src/authoring/conductia-client.ts`
- Create: `platform/apps/skill-bench/src/authoring/conductia-client.test.ts`

**Interfaces:**
- Consumes: Conductia Task 7 canonical OpenAPI revision.
- Produces: `AuthoringConductiaClient` with `claim`, `renew`, `readContext`, `deliver` methods and Zod-parsed results.
- Consumed by: Tasks 13 and 14.

- [ ] **Step 1: Copy the canonical contract and write failing client tests**

Copy `openapi/skill-authoring-internal.json` byte-for-byte into the pinned location. In the test, use a fake `fetch` and assert exact Conductia paths, bearer header, contract version, fixed timeout, and Zod refusal of malformed responses.

Define the interface in the test:

```ts
export interface AuthoringConductiaClient {
  claim(input: { workerId: string; leaseSeconds: number }): Promise<ClaimResponse | null>;
  renew(input: { attemptId: string; workerId: string; generation: number; leaseSeconds: number }): Promise<LeaseResponse>;
  readContext(input: { attemptId: string; workerId: string; generation: number; beforeOrdinal?: number; limit: number }): Promise<ContextPage>;
  deliver(input: { attemptId: string; workerId: string; batch: EventBatch }): Promise<EventAck>;
}
```

- [ ] **Step 2: Run the client test and verify failure**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/conductia-client.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement Zod schemas and the client**

Create `contract.ts` with exact version-1 schemas matching the pinned OpenAPI enums. Create `conductia-client.ts` with one private JSON request helper. Its constructor accepts `{ baseUrl, token, fetchImpl?, timeoutMs? }`; strip a trailing slash, send `Authorization: Bearer`, set `accept` and `content-type`, apply `AbortSignal.timeout`, parse every success with the matching schema, and map 401/409/422/503 to typed errors.

`claim` returns `null` on 204. It never accepts tenant, deal, author, provider, or deployment parameters.

- [ ] **Step 4: Run the client and type checks**

Run from `platform`:

```bash
pnpm --filter @ignatious/skill-bench test -- authoring/conductia-client.test.ts
pnpm --filter @ignatious/skill-bench typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/contract \
  platform/apps/skill-bench/src/authoring/contract.ts \
  platform/apps/skill-bench/src/authoring/conductia-client.ts \
  platform/apps/skill-bench/src/authoring/conductia-client.test.ts
git commit -m "feat(skill-bench): add the Conductia authoring client"
```

---

### Task 9: Add the Ignatious operational authoring store

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/postgres/migrations/001_authoring.sql`
- Create: `platform/apps/skill-bench/src/authoring/store.ts`
- Create: `platform/apps/skill-bench/src/authoring/store.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/testing.ts`
- Modify: `platform/apps/skill-bench/package.json`

**Interfaces:**
- Consumes: `@ignatious/postgres` pool/migration runner and Task 8 types.
- Produces: `AuthoringStore` and `openAuthoringStore`.
- Consumed by: Tasks 10 through 14.

- [ ] **Step 1: Add the workspace dependency and failing Postgres tests**

Add `"@ignatious/postgres": "workspace:*"` to skill-bench dependencies. Use `postgresReachable` to skip only when the local disposable database is absent. Allocate a unique schema per test process, migrate it, and drop that schema in teardown.

Test these store methods:

```ts
admit(claim): Promise<{ operation: AuthoringOperation; created: boolean }>
acceptGeneration(attemptId, generation): Promise<boolean>
saveCheckpoint(attemptId, generation, checkpoint): Promise<boolean>
saveCandidate(attemptId, generation, candidate): Promise<boolean>
appendEvent(attemptId, generation, event): Promise<boolean>
pendingEvents(limit): Promise<OutboxEvent[]>
acknowledge(attemptId, capturedThrough): Promise<void>
```

Cover duplicate admission, monotonic fence, stale checkpoint/candidate/event refusal, conflicting event digest, and acknowledgement that leaves higher sequences intact.

- [ ] **Step 2: Run the store test and verify failure**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/store.test.ts`

Expected: FAIL because the store does not exist, or SKIP only when the checked local Postgres is unreachable.

- [ ] **Step 3: Write the operational migration**

Create four tables in the dedicated test/runtime schema:

```sql
create table authoring_operations (
  attempt_id uuid primary key,
  status text not null check (status in ('admitted','running','reconciling','succeeded','failed')),
  fencing_generation bigint not null,
  context_watermark bigint not null,
  checkpoint_version bigint not null default 0,
  claim jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table authoring_checkpoints (...);
create table authoring_candidates (..., artifact_reference text not null unique, package_bytes bytea not null, content_digest text not null, unique(attempt_id, provider_candidate_id));
create table authoring_event_outbox (..., primary key(attempt_id, sequence), unique(attempt_id, payload_digest));
```

The store must execute every fenced mutation as `update ... where fencing_generation = $expected` or inside a transaction that first performs that exact comparison. A stale generation returns false and writes nothing.

- [ ] **Step 4: Implement store lifecycle**

`openAuthoringStore({ databaseUrl, schema, logger })` creates one pool, runs migrations with a dedicated advisory lock, and returns `{ store, close }`. It must not accept a null URL. Use schema `skill_authoring` in runtime and unique test schemas in tests.

- [ ] **Step 5: Run store tests and typecheck**

Run from `platform`:

```bash
pnpm --filter @ignatious/skill-bench test -- authoring/store.test.ts
pnpm --filter @ignatious/skill-bench typecheck
```

Expected: PASS or explicit local-Postgres SKIP, with typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/package.json platform/pnpm-lock.yaml \
  platform/apps/skill-bench/src/authoring/postgres \
  platform/apps/skill-bench/src/authoring/store.ts \
  platform/apps/skill-bench/src/authoring/store.test.ts \
  platform/apps/skill-bench/src/authoring/testing.ts
git commit -m "feat(skill-bench): persist authoring operations"
```

---

### Task 10: Create private skill candidates without live publication

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/candidate-package.ts`
- Create: `platform/apps/skill-bench/src/authoring/candidate-package.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/candidate-tool.ts`
- Create: `platform/apps/skill-bench/src/authoring/candidate-tool.test.ts`

**Interfaces:**
- Consumes: Task 9 `AuthoringStore` and Ignatious package APIs `readFrontmatter`, `statusOf`, `safeReferenceSegments`, and `zipSkillFolder`.
- Produces: the draft-only `DraftSkillPackageApi.prepareCandidate`, its `preparePrivateCandidate` adapter, and `createCandidateTool`.
- Consumed by: Task 11 generator and Part C later.

- [ ] **Step 1: Write failing candidate tests**

Test valid SKILL.md plus references, invalid frontmatter, unsafe reference path, stable digest for identical bytes, changed digest for changed bytes, retry with the same provider candidate ID/content, conflict for same ID/different content, and proof that `findSkill(skillsRoot, name)` remains null after candidate creation.

- [ ] **Step 2: Run candidate tests and verify failure**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/candidate`

Expected: FAIL because candidate modules do not exist.

- [ ] **Step 3: Implement private package preparation**

Use this input/output:

```ts
export type PrivateCandidateInput = {
  attemptId: string;
  generation: number;
  providerCandidateId: string;
  name: string;
  purpose: string;
  expectedInput: string;
  expectedOutput: string;
  skillMdText: string;
  referenceFiles?: Readonly<Record<string, string>>;
};

export type PrivateCandidate = {
  id: string;
  artifactReference: string;
  digest: string;
  schemaVersion: 1;
  name: string;
  purpose: string;
  expectedInput: string;
  expectedOutput: string;
};
```

Define `DraftSkillPackageApi` as the only skill-package creation seam used by authoring. Its `prepareCandidate` operation builds the package in a temporary directory, validates frontmatter and safe reference paths through the existing Ignatious package APIs before writing, zips it with `zipSkillFolder`, hashes the exact ZIP bytes with SHA-256, allocates an opaque provider-neutral artifact reference, and saves the bytes through `AuthoringStore.saveCandidate`. `preparePrivateCandidate` is the concrete adapter behind that API. Never call `stageSkillUpload`, `writeVisibility`, `createSkill`, or `commitSkillVersion` because those existing APIs publish into the live library.

The worker and model tool must call `DraftSkillPackageApi.prepareCandidate`; no second code path may assemble or persist candidate bytes. This is the new draft-only Ignatious API/adapter promised by the spec. It creates and validates the skill package inside Ignatious while keeping every browser request on Conductia.

- [ ] **Step 4: Implement the authoring-only tool**

Create Mastra tool `propose_skill_candidate` with a Zod input matching `PrivateCandidateInput` minus attempt/generation. Close those values over tool construction. Its result is the provider-neutral preview and digest only. It cannot receive deal, tenant, author, visibility, provider, or live skill name to replace.

- [ ] **Step 5: Run candidate tests**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/candidate`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/candidate-package.ts \
  platform/apps/skill-bench/src/authoring/candidate-package.test.ts \
  platform/apps/skill-bench/src/authoring/candidate-tool.ts \
  platform/apps/skill-bench/src/authoring/candidate-tool.test.ts
git commit -m "feat(skill-bench): create private skill candidates"
```

---

### Task 11: Add an explicit authoring tool policy and generator

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/generator.ts`
- Create: `platform/apps/skill-bench/src/authoring/generator.test.ts`
- Modify: `platform/apps/skill-bench/src/turn-agent.ts`

**Interfaces:**
- Consumes: Task 10 candidate tool and existing Mastra model/workspace construction.
- Produces: `AuthoringGenerator.generate(input, sink, signal)` and `TurnToolPolicy`.
- Consumed by: Task 12 coordinator.

- [ ] **Step 1: Write failing tool-policy tests**

Construct both modes with a scripted model. Assert normal bench mode retains its existing tool list. Assert authoring mode includes `propose_skill_candidate` and excludes `create_skill`, `commit_skill_version`, generic list/upload mutation, and Conductia write tools.

Test one scripted turn that emits text deltas then calls the candidate tool. The sink must receive monotonically sequenced `text_delta`, `candidate`, and `terminal_success` product events.

- [ ] **Step 2: Run generator tests and verify failure**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/generator.test.ts`

Expected: FAIL because authoring mode does not exist.

- [ ] **Step 3: Introduce a closed tool-policy type**

Add to `turn-agent.ts`:

```ts
export type TurnToolPolicy =
  | { kind: 'bench' }
  | {
      kind: 'authoring';
      candidateTools: Record<string, unknown>;
    };
```

Make the existing caller pass `{ kind: 'bench' }`. Build the current tool object only for bench. For authoring, build only read-only workspace skill loading plus `candidateTools`. Return `toolNames` from the selected object, not from a hard-coded union.

- [ ] **Step 4: Implement the generator adapter**

`AuthoringGenerator.generate` accepts:

```ts
type AuthoringGenerateInput = {
  attemptId: string;
  generation: number;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
  checkpoint: { version: number; summary: string; throughOrdinal: number } | null;
};

type AuthoringEventSink = (event: {
  type: 'text_delta' | 'candidate' | 'terminal_success' | 'terminal_error';
  payload: Record<string, unknown>;
}) => Promise<void>;
```

Build the agent with the authoring tool policy and instructions that interview, refine, and emit a structured candidate only through `propose_skill_candidate`. Translate only user-visible text and candidate results into the sink. On success emit terminal success with the final sequence; on safe model/tool failure emit terminal error. Do not emit raw reasoning or unrestricted tool traces.

- [ ] **Step 5: Run regression tests**

Run from `platform`:

```bash
pnpm --filter @ignatious/skill-bench test -- authoring/generator.test.ts turn-agent.test.ts session.test.ts create-skill-tool.test.ts
pnpm --filter @ignatious/skill-bench typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/generator.ts \
  platform/apps/skill-bench/src/authoring/generator.test.ts \
  platform/apps/skill-bench/src/turn-agent.ts
git commit -m "feat(skill-bench): isolate authoring generation"
```

---

### Task 12: Coordinate idempotent attempts, checkpoints, and fencing

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/coordinator.ts`
- Create: `platform/apps/skill-bench/src/authoring/coordinator.test.ts`

**Interfaces:**
- Consumes: Task 8 claim/context types, Task 9 store, Task 11 generator.
- Produces: `AuthoringCoordinator.runClaim(claim, leaseSignal)`.
- Consumed by: Task 14 worker.

- [ ] **Step 1: Write failing coordinator tests**

Use fake store/generator instances. Cover first admission, repeated claim returning the existing operation, higher-generation takeover, stale-generation refusal before generation, context pagination pinned to the claim watermark, checkpoint reuse, process-style resume, and a stale sink that cannot append after ownership moves.

- [ ] **Step 2: Run coordinator tests and verify failure**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/coordinator.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement admission and reconciliation**

`runClaim` calls `store.admit` by attempt ID. If created, mark running only after `acceptGeneration` succeeds. If existing with the same or lower generation, reconcile its status and pending outbox instead of invoking a new operation. If the claim generation is higher, atomically advance the fence before any checkpoint or generator call.

An operation already succeeded or failed never invokes the generator again; it only redelivers pending events.

- [ ] **Step 4: Implement context preparation**

Start from the checkpoint pinned to the operation. Merge recent claim messages, then page older Conductia context only until the configured context builder reports sufficient coverage. Never read beyond `throughMessageOrdinal`. Always append the current immutable message and current candidate identity after checkpoint material.

Write a new checkpoint only through `saveCheckpoint(attemptId, generation, ...)`. A false result means ownership moved; abort the local generator sink immediately.

- [ ] **Step 5: Run coordinator tests**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/coordinator.test.ts authoring/store.test.ts`

Expected: PASS or the Postgres test's explicit local-only SKIP.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/coordinator.ts \
  platform/apps/skill-bench/src/authoring/coordinator.test.ts
git commit -m "feat(skill-bench): fence authoring attempts"
```

---

### Task 13: Deliver the durable outbox

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/delivery.ts`
- Create: `platform/apps/skill-bench/src/authoring/delivery.test.ts`

**Interfaces:**
- Consumes: Task 8 Conductia client and Task 9 store.
- Produces: `AuthoringDelivery.flushOnce()` and `run(signal)`.
- Consumed by: Task 14 worker.

- [ ] **Step 1: Write failing delivery tests**

Cover ordered batching, exact payload digest, callback timeout, duplicate redelivery, partial contiguous acknowledgement, acknowledgement cleanup, higher sequences retained, conflicting-event 409 held for reconciliation, exponential backoff, restart with preexisting outbox rows, and redelivery after an artificial replay-cache expiry.

- [ ] **Step 2: Run delivery tests and verify failure**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/delivery.test.ts`

Expected: FAIL because delivery does not exist.

- [ ] **Step 3: Implement one flush**

`flushOnce` reads at most 100 pending events grouped by attempt and generation. It sends the lowest contiguous batch first. After `EventAck`, call `acknowledge(attemptId, capturedThrough)`. Never delete on timeout, 5xx, parse failure, or a lower acknowledgement.

Hash canonical JSON payload bytes with SHA-256 before store insertion. The digest sent to Conductia must be the stored digest, never recomputed from a differently ordered object.

- [ ] **Step 4: Implement the delivery loop**

`run(signal)` repeats while not aborted. Use 250 ms after progress, exponential backoff from 1 second to 30 seconds after transport/5xx failure, and reset after a successful acknowledgement. A 409 event conflict marks the operation reconciling and stops automatic deletion or generation for that attempt.

- [ ] **Step 5: Run delivery tests**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/delivery.test.ts authoring/store.test.ts`

Expected: PASS or explicit local Postgres SKIP.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/delivery.ts \
  platform/apps/skill-bench/src/authoring/delivery.test.ts
git commit -m "feat(skill-bench): redeliver authoring events"
```

---

### Task 14: Run the Ignatious authoring worker and wire deployment configuration

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/worker.ts`
- Create: `platform/apps/skill-bench/src/authoring/worker.test.ts`
- Modify: `platform/apps/skill-bench/src/config.ts`
- Modify: `platform/apps/skill-bench/src/main.ts`
- Modify: `platform/apps/skill-bench/src/index.ts`
- Modify: `platform/docker-compose.yml`
- Modify: `platform/infrastructure/modules/demo/main.tf`

**Interfaces:**
- Consumes: Tasks 8 through 13.
- Produces: opt-in background worker with awaited migration/start and graceful stop.

- [ ] **Step 1: Write failing config and worker tests**

Test default off; explicit on requiring database URL, Conductia URL, token, and deployment; refusal of default/local token outside local config; one claim at a time; lease renewal before half-life; reconciling after renewal conflict; claim backoff; independent delivery loop; and abort-driven shutdown.

Use this config shape:

```ts
type AuthoringWorkerConfig = {
  enabled: true;
  conductiaBaseUrl: string;
  serviceToken: string;
  deployment: string;
  databaseUrl: string;
  databaseSchema: 'skill_authoring';
  workerId: string;
  leaseSeconds: 60;
  pollMs: 1000;
};
```

- [ ] **Step 2: Run worker tests and verify failure**

Run from `platform`: `pnpm --filter @ignatious/skill-bench test -- authoring/worker.test.ts config.test.ts`

Expected: FAIL because config and worker wiring do not exist.

- [ ] **Step 3: Parse opt-in configuration**

Add:

```text
SKILL_BENCH_AUTHORING=off|on
CONDUCTIA_AUTHORING_BASE_URL
CONDUCTIA_AUTHORING_SERVICE_TOKEN
SKILL_BENCH_AUTHORING_DEPLOYMENT
SKILL_BENCH_AUTHORING_WORKER_ID
```

When on, require `SKILL_BENCH_DATABASE_URL`. Do not reuse `CONDUCTIA_INBOUND_API_KEY`, which authenticates the opposite direction. Use a stable deployment value and a process-unique worker ID.

- [ ] **Step 4: Implement claim and lease orchestration**

`AuthoringWorker.start()` runs delivery and claim loops under one abort controller. For each claim, start a renewal timer, call `coordinator.runClaim`, cancel renewal in `finally`, and immediately flush its outbox. Process one generation per worker instance in v1; multiple ECS tasks gain concurrency through `skip locked` and fencing.

`stop()` aborts new claims, waits for the active coordinator to stop at a safe fence boundary, flushes no unpersisted event, and closes the authoring pool after the delivery loop stops.

- [ ] **Step 5: Wire service startup and shutdown**

In `main.ts`, when enabled:

1. open and migrate the authoring store before binding the authoring worker;
2. bind the existing HTTP server normally;
3. start the worker only after the server callback fires;
4. include `authoring on/off` and database schema in the startup banner, never the token;
5. await worker stop and pool close in the existing shutdown path before process exit.

Export worker seams from `index.ts` for tests.

- [ ] **Step 6: Wire local and Terraform configuration**

In Compose, set authoring on with the local Conductia base URL, `local-authoring-key`, deployment `local`, and the existing Postgres URL. In Terraform, add a distinct generated secret for `CONDUCTIA_AUTHORING_SERVICE_TOKEN`, inject it into the skill-bench task, and pass fixed Conductia base URL and deployment. Do not apply Terraform or deploy.

- [ ] **Step 7: Run Ignatious verification**

Run from `platform`:

```bash
pnpm --filter @ignatious/skill-bench test
pnpm --filter @ignatious/skill-bench typecheck
pnpm lint
terraform -chdir=infrastructure fmt -check -recursive
terraform -chdir=infrastructure validate
```

Expected: all commands PASS. `terraform validate` must not contact or modify AWS.

- [ ] **Step 8: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/worker.ts \
  platform/apps/skill-bench/src/authoring/worker.test.ts \
  platform/apps/skill-bench/src/config.ts platform/apps/skill-bench/src/main.ts \
  platform/apps/skill-bench/src/index.ts platform/docker-compose.yml \
  platform/infrastructure/modules/demo/main.tf
git commit -m "feat(skill-bench): run durable Conductia authoring"
```

---

### Task 15: Build the Conductia browser client and recovery reducer

**Repository:** Conductia

**Files:**
- Create: `src/lib/skillAuthoring/client.ts`
- Create: `src/lib/skillAuthoring/reducer.ts`
- Create: `src/lib/skillAuthoring/useSkillAuthoringDraft.ts`
- Create: `tests/skill-authoring-reducer.test.ts`
- Create: `tests/skill-authoring-client.test.ts`

**Interfaces:**
- Consumes: Task 1 `DraftRead` and Task 5 browser routes.
- Produces: `SkillAuthoringClient`, `reduceAuthoringEvents`, `useSkillAuthoringDraft`.
- Consumed by: Task 16 dialog.

- [ ] **Step 1: Write failing client and reducer tests**

Assert every fetch begins with `/api/v1/deals/`, never the configured Ignatious origin. Cover get/create, restore, patch, submit, retry, poll, discard, 409 conflict parsing, identical event dedupe, gap buffering, contiguous release, terminal-after-gap, and candidate selection only after terminal success.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run tests/skill-authoring-client.test.ts tests/skill-authoring-reducer.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement the browser client**

Define:

```ts
export interface SkillAuthoringClient {
  open(dealId: string): Promise<DraftRead>;
  read(dealId: string, draftId: string): Promise<DraftRead>;
  patch(dealId: string, draftId: string, command: DraftPatch): Promise<DraftRead>;
  send(dealId: string, draftId: string, command: MessageCommand): Promise<DraftRead>;
  retry(dealId: string, draftId: string, messageId: string, retryRequestId: string): Promise<DraftRead>;
  events(dealId: string, draftId: string, after: number): Promise<EventPage>;
  discard(dealId: string, draftId: string, expectedEditRevision: number): Promise<void>;
}
```

Use same-origin fetch only. Parse non-2xx JSON into `SkillAuthoringClientError` carrying status and authoritative conflict state.

- [ ] **Step 4: Implement pure event reduction**

Track the draft-level `eventCursor` independently from a per-attempt `{ capturedThrough, gaps: Map<number, AuthoringEvent> }`. Ignore identical repeats, enter conflict on a different payload digest for the same `(attemptId, sequence)`, release only consecutive sequences within that attempt, append text deltas to the addressed attempt, and apply terminal/candidate state only at the complete declared last sequence. Advance the browser cursor from each event's `cursor`, never from provider sequence, because sequence restarts for every retry attempt.

- [ ] **Step 5: Implement the hook**

The hook owns `idle|opening|ready|saving|conflict|error` UI state, acknowledged draft, local editable fields, dirty set, one debounce timer, and polling timer. Use 500 ms autosave debounce, immediate flush on blur/Close, 1-second poll while an attempt is nonterminal, and exponential idle backoff to 10 seconds. Closing stops polling but does not call discard or cancellation.

Expose:

```ts
{
  state, draft, local, dirty, open, change, flush, send, retry,
  keepMine, reloadSaved, discard, closeRequested
}
```

`keepMine` reads the latest draft then patches local values against its revision. `reloadSaved` replaces only conflicted local fields. Register `beforeunload` only while dirty or a save is unacknowledged.

- [ ] **Step 6: Run client and reducer tests**

Run: `npx vitest run tests/skill-authoring-client.test.ts tests/skill-authoring-reducer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/skillAuthoring/client.ts src/lib/skillAuthoring/reducer.ts \
  src/lib/skillAuthoring/useSkillAuthoringDraft.ts \
  tests/skill-authoring-client.test.ts tests/skill-authoring-reducer.test.ts
git commit -m "feat(authoring): restore durable drafts in the browser"
```

---

### Task 16: Build the recoverable skill builder dialog

**Repository:** Conductia

**Files:**
- Create: `src/components/rail/SkillBuilderDialog.tsx`
- Create: `src/components/rail/SkillCandidatePreview.tsx`
- Create: `src/components/rail/SkillAuthoringConversation.tsx`
- Create: `tests/skill-builder-dialog.test.tsx`
- Modify: `src/components/rail/index.ts`

**Interfaces:**
- Consumes: Task 15 hook and Part A `ProjectRail` phase/step identities.
- Produces: `SkillBuilderDialog({ open, dealId, rail, onClose })`.
- Consumed by: Task 17 rail entry.

- [ ] **Step 1: Write failing RTL tests for approved states**

Cover first open, restored composer/transcript, Saving and Saved labels, stale-tab Keep mine/Reload saved, queued, generating partial response, reconnecting, failed partial plus Retry, valid candidate, disabled Save, Close during generation, Close blocked on failed flush, navigation warning, discard confirmation, discard unavailable during future saving/reconciling publication, and narrow layout order. Assert Part B exposes neither an archived-draft browser nor a background-completion notification surface.

Assert the dialog contains no model picker, provider name, cost, raw trace, or direct Ignatious control.

- [ ] **Step 2: Run dialog tests and verify failure**

Run: `npx vitest run tests/skill-builder-dialog.test.tsx`

Expected: FAIL because components do not exist.

- [ ] **Step 3: Build focused presentation components**

`SkillAuthoringConversation` renders immutable user messages and each attempt's partial/final/error state. Only the newest known failed attempt renders Retry. It disables Send while any attempt is queued, running, or reconciling.

`SkillCandidatePreview` renders name, purpose, expected input, expected output, and Ready to save only for a valid candidate. It always renders the Part B `Save skill and add step` button disabled with `aria-describedby` text: `Step attachment ships with the publication workflow.`

- [ ] **Step 4: Build the dialog shell**

Follow the existing Workbench modal pattern: fixed scrim, focusable `role="dialog"`, Escape using the same close request as X, name/phase/position above a `md:grid-cols-2` conversation/preview body, and footer actions in this order: Save, Close, Discard draft.

Phase placement values are `phase_start`, `phase_end`, or `after` an active step in that phase. If an anchor disappears after restore, preserve the conversation and require another placement before future publication.

- [ ] **Step 5: Implement close and discard behavior**

Close calls `flush`. On success, invoke `onClose`; on failure/conflict, remain open and focus the error. Discard opens one confirmation, then calls the server archive operation. It never clears local state as proof of discard before the server succeeds.

- [ ] **Step 6: Run dialog tests and accessibility assertions**

Run: `npx vitest run tests/skill-builder-dialog.test.tsx tests/bench-chat-markdown.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/rail/SkillBuilderDialog.tsx \
  src/components/rail/SkillCandidatePreview.tsx \
  src/components/rail/SkillAuthoringConversation.tsx \
  src/components/rail/index.ts tests/skill-builder-dialog.test.tsx
git commit -m "feat(authoring): add the recoverable builder dialog"
```

---

### Task 17: Add the rail entry point and feature boundary

**Repository:** Conductia

**Files:**
- Modify: `src/components/rail/RailTimeline.tsx`
- Modify: `src/components/rail/DealRail.tsx`
- Create: `tests/skill-authoring-rail-entry.test.tsx`

**Interfaces:**
- Consumes: Task 16 dialog, `useFlag('skill_authoring')`, and Part A `rail.canEditStructure`.
- Produces: the approved Add step entry in Full Array only.

- [ ] **Step 1: Write failing rail-entry tests**

Assert Add step is absent when the flag is off, absent without `canEditStructure`, absent outside Full Array, present at the top-right when both gates pass, opens the builder with the URL project ID, restores an existing draft through the hook, and closes without changing the rail.

- [ ] **Step 2: Run the rail-entry test and verify failure**

Run: `npx vitest run tests/skill-authoring-rail-entry.test.tsx`

Expected: FAIL because Add step is absent.

- [ ] **Step 3: Add the entry without changing timeline data semantics**

Add optional props to `RailTimeline`:

```ts
canAddStep?: boolean;
onAddStep?: () => void;
```

Render the button in a header row aligned opposite the minimap/progress controls. Do not add authoring state to station records.

In `DealRail`, compute `canAddStep = useFlag('skill_authoring') && rail.canEditStructure`, own only the dialog's open boolean, and pass the active `ProjectRail` for placement choices. Closing does not refresh the rail because Part B creates no step.

- [ ] **Step 4: Run rail and dialog regression tests**

Run: `npx vitest run tests/skill-authoring-rail-entry.test.tsx tests/skill-builder-dialog.test.tsx tests/rail-ui.test.tsx tests/rail-numbering.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/RailTimeline.tsx src/components/rail/DealRail.tsx \
  tests/skill-authoring-rail-entry.test.tsx
git commit -m "feat(authoring): open drafts from the project rail"
```

---

### Task 18: Add database probes, cross-service recovery tests, and final verification

**Repositories:** Conductia and Ignatious, with separate commits

**Files:**
- Create: `supabase/tests/skill_authoring.sql`
- Create: `tests/db/skill-authoring.test.ts`
- Create: `scripts/verify-skill-authoring-contract.ts`
- Modify: `package.json`
- Create: `platform/apps/skill-bench/src/authoring/e2e.test.ts`
- Modify: `docs/03-engineering/api-v1.md`
- Modify: `platform/README.md`

**Interfaces:**
- Consumes: every prior task.
- Produces: executable evidence for the database invariants and cross-repository contract, without deployment.

- [ ] **Step 1: Write the guarded Conductia DB wrapper**

Copy the guarded `execFileSync('psql', ...)` shape from `tests/db/legal-hold.test.ts`, then add a local-host refusal before execution. Allow only `localhost`, `127.0.0.1`, `::1`, or the disposable Compose service name explicitly set by `ALLOW_LOCAL_DB_HOST=postgres`.

The test is skipped unless `RUN_DB_TESTS=1`.

- [ ] **Step 2: Write the psql probe**

Wrap the probe in `begin; ... rollback;`. Seed a tenant, bank, two internal authors, one external member, one project, memberships, and the structural permission. Use `dblink` or two psql sessions where true concurrency is required.

Assert every spec case:

```text
one active draft per author/project
author privacy
external and missing-permission denial
access loss then restoration
atomic message/attempt/work admission
identical and conflicting message replay
one nonterminal attempt
retry preserves prior attempt
stale edit conflict
discard blocks author actions but retains admitted work
candidate after discard is not selected
claim increments fencing generation
stale renew and stale event rejection
identical duplicate and conflicting duplicate events
out-of-order storage and contiguous acknowledgement
terminal gap remains nonterminal
flag-off cutoff drains only previously admitted work
```

- [ ] **Step 3: Verify the probe fails without the authoring migrations**

Only against a validated disposable local database, apply migrations through the revision before Task 2, then run:

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgresql://... npx vitest run tests/db/skill-authoring.test.ts
```

Expected: FAIL because authoring tables/functions are absent. Restore the disposable database, apply all local migrations, rerun, and expect PASS.

- [ ] **Step 4: Add the contract comparison command**

`scripts/verify-skill-authoring-contract.ts` accepts `IGNATIOUS_REPO` and compares canonical JSON against `platform/apps/skill-bench/src/authoring/contract/openapi.json` after removing only `info.x-source-revision`. A mismatch prints both paths and exits 1.

Add:

```json
"verify:skill-authoring-contract": "node --import tsx scripts/verify-skill-authoring-contract.ts"
```

- [ ] **Step 5: Write the Ignatious cross-service test**

Use a fake Conductia HTTP server implementing the pinned contract and the disposable authoring Postgres schema. Exercise:

1. claim response loss followed by the same attempt claim;
2. Ignatious unavailable after Conductia admission, followed by later claim;
3. process-equivalent coordinator reconstruction after admission;
4. higher-generation takeover while the old sink tries to append;
5. callback loss and duplicate delivery;
6. out-of-order delivery acknowledgement;
7. replay-cache expiry with outbox rows intact;
8. access loss while queued producing the local system terminal event;
9. access-denied context page after a running attempt;
10. archived draft accepting delivery but never publication;
11. partial response then a separate retry attempt;
12. no row or folder in the live skill store.

- [ ] **Step 6: Document operations without deployment instructions that mutate state**

In Conductia's API guide, document browser routes, the private-author rule, queued/reconciling meanings, the disabled Part B Save boundary, and internal contract location. In Ignatious's README, document opt-in variables, mandatory Postgres, startup refusal, health/banner signal, and contract pinning command. State that owner approval and Part C are rollout gates.

- [ ] **Step 7: Run final Conductia verification**

Run in Conductia:

```bash
npx vitest run tests/skill-authoring-contract.test.ts tests/skill-authoring-access.test.ts \
  tests/skill-authoring-schema.test.ts tests/skill-authoring-worker-sql.test.ts \
  tests/skill-authoring-routes.test.ts tests/skill-authoring-internal-routes.test.ts \
  tests/skill-authoring-audit.test.ts tests/skill-authoring-client.test.ts \
  tests/skill-authoring-reducer.test.ts tests/skill-builder-dialog.test.tsx \
  tests/skill-authoring-rail-entry.test.tsx
npm test
npx tsc --noEmit
npx eslint .
IGNATIOUS_REPO=/Users/cwillian/Documents/personal/learning/ignatious npm run verify:skill-authoring-contract
```

Expected: all commands PASS. Run the DB probe only when the URL is visibly local.

- [ ] **Step 8: Run final Ignatious verification**

Run from `ignatious/platform`:

```bash
pnpm --filter @ignatious/skill-bench test
pnpm --filter @ignatious/skill-bench typecheck
pnpm lint
terraform -chdir=infrastructure fmt -check -recursive
terraform -chdir=infrastructure validate
```

Expected: all commands PASS. Do not run `terraform apply`, push images, or deploy.

- [ ] **Step 9: Commit Conductia verification and docs**

```bash
git add supabase/tests/skill_authoring.sql tests/db/skill-authoring.test.ts \
  scripts/verify-skill-authoring-contract.ts package.json docs/03-engineering/api-v1.md
git commit -m "test(authoring): verify durable recovery boundaries"
```

- [ ] **Step 10: Commit Ignatious verification and docs**

```bash
git add platform/apps/skill-bench/src/authoring/e2e.test.ts platform/README.md
git commit -m "test(skill-bench): verify Conductia authoring recovery"
```

- [ ] **Step 11: Record the non-code rollout blockers**

In both PR descriptions, record these unchecked external gates without attempting them:

```text
[ ] Ignatious owner approves worker, operational Postgres, private candidate, fencing, and outbox ownership
[ ] Service credential configured and rotation rehearsed
[ ] Deployed operational database verified healthy
[ ] Part C publication implemented and verified
[ ] skill_authoring flag approved for enablement
```

Do not mark Part B shippable while any gate remains open.
