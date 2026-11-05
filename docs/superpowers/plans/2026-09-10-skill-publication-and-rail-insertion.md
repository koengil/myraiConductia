# Skill Publication and Rail Insertion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the exact private skill candidate reviewed by an authorized Conductia author, then atomically add one pending rail step pinned to that immutable skill version.

**Architecture:** Conductia owns Save admission, project authorization, duplicate policy, one durable publication-operation row, recovery, placement, audit, and the final rail transaction. Ignatious owns private candidate bytes, package validation, deterministic capability comparison, and a project-scoped immutable first version. Both services use idempotent operations keyed by the Conductia publication ID. The request path advances work immediately, while a small authenticated five-minute sweep retries due operations after browser close or process restart. No lease, fence, queue, distributed lock, or cross-service transaction is added.

**Tech Stack:** Conductia uses Next.js 16, React 19, TypeScript, Supabase/Postgres, Tailwind 4, Vitest, RTL, and GitHub Actions. Ignatious uses Node 22 ESM, TypeScript, Hono, Zod 4, `pg` through `@ignatious/postgres`, Vitest, Docker Compose, and Terraform/ECS.

**Spec:** `docs/superpowers/specs/2026-09-09-skill-publication-and-rail-insertion-design.md`

## Preconditions and constraints

- Start Conductia from the final clean integration of Part A branch `project-rail-model-impl` and Part B branch `durable-skill-authoring-implementation`. Start Ignatious from the final clean `feat-conductia-durable-authoring` branch. Record the three base commit SHAs in the pull request. Do not copy uncommitted files from their worktrees.
- Before Task 1, verify Part A still exposes `rail_insert_step(uuid, uuid, int, text, uuid, jsonb, text, text)` and returns `stepId`, `railRevision`, and `created`. If its reviewed signature differs, update this plan's call site and contract test before implementation.
- Keep one product feature flag: `skill_authoring`. The processor credential and publication service credential are operational configuration, not flags.
- Browser code calls only Conductia. Candidate artifact references, package bytes, provider paths, and service credentials never enter browser responses.
- Part C creates one skill identity and one immutable version. It never resolves by display name and never follows `latest`.
- Every skill-backed rail definition persists and validates `skillId`, `versionId`, and `digest` together.
- Schema version 1 accepts exactly one required text input with key `primary`, while retaining an `inputs` array so a later schema version can add fields.
- Publication processing uses one operation row, unique constraints, state predicates, bounded retry metadata, and idempotent remote calls. Do not add leases, fencing generations, inboxes, outboxes, queue libraries, leader election, or distributed locks.
- Do not add an embedding service or model judge. Ignatious comparison is deterministic over normalized structured capability fields, and stores the result as a receipt.
- Never point a migration, probe, test, or script at hosted databases. Database tests must reject non-loopback hosts.
- No code comments or JSDoc prose. Preserve existing comments unless they become false. Do not use em dash characters in code, docs, or visible copy.
- Work only on feature branches. Conductia merges to `develop`; never commit directly to `main` or `master`. Deployment and flag enablement are outside this implementation plan.

## Execution order

Tasks 1 through 5 freeze the shared contract and Conductia persistence. Tasks 6 through 9 implement Ignatious against the pinned contract. Tasks 10 through 15 implement Conductia orchestration and UI. Task 16 verifies recovery and compatibility. Once Task 5 is committed, Tasks 6 through 9 may proceed independently from Conductia Tasks 10 through 12. Keep task order within each repository.

## Pinned binding map

These are every Part C location that must persist or validate `skillId + versionId + digest`:

| Repository | Location | Obligation |
|---|---|---|
| Conductia | `src/lib/skillPublication/types.ts` | Define `SkillBinding` as three required fields. |
| Conductia | `src/lib/skillPublication/parse.ts` | Strictly parse all three fields and SHA-256 digest shape. |
| Conductia | `openapi/skill-publication.json` | Require all three in publication receipt, result, and skill step definition. |
| Conductia | `supabase/migrations/20260916120000_skill_publication.sql` | Store reserved skill ID and immutable published skill ID, version ID, and digest. |
| Conductia | `supabase/migrations/20260916120000_skill_publication.sql` | Verify receipt equality and write all three into `deal_steps.definition`. |
| Conductia | `src/lib/rail/projectRail.ts` | Parse a skill definition only when all three binding fields are valid. |
| Conductia | `src/lib/skillPublication/browserResponse.ts` and `clientResponse.ts` | Return and parse the safe three-field result. |
| Ignatious | `platform/apps/skill-bench/src/authoring/publication/contract.ts` | Validate all receipt and request identities. |
| Ignatious | `platform/apps/skill-bench/src/authoring/postgres/migrations/004_skill_publication.sql` | Persist immutable skill ID, version ID, digest, and bytes. |
| Ignatious | `platform/apps/skill-bench/src/authoring/publication/store.ts` | Return a version only by exact ID tuple and project scope. |
| Ignatious | `platform/apps/skill-bench/src/authoring/publication/service.ts` | Copy the exact candidate bytes and return the stored tuple on replay. |
| Both | Contract, database, route, and recovery tests named below | Reject missing or changed fields and prove retries preserve the tuple. |

## File structure

### Conductia new files

| Path | Responsibility |
|---|---|
| `src/lib/skillPublication/types.ts` | Provider-neutral commands, states, capability matches, receipt, result, and skill definition. |
| `src/lib/skillPublication/parse.ts` | Strict browser-command and service-response parsers. |
| `src/lib/skillPublication/browserResponse.ts` | Validate authoritative SQL projections before browser serialization. |
| `src/lib/skillPublication/clientResponse.ts` | Strict browser-side publication parser. |
| `src/lib/skillPublication/config.ts` | Fail-closed Ignatious URL, publication token, processor token, and retry settings. |
| `src/lib/skillPublication/ignatiousClient.ts` | Authenticated prepare, publish, and lookup client. |
| `src/lib/skillPublication/comparisonSet.ts` | Build deterministic project-local targets and comparison-set digest. |
| `src/lib/skillPublication/processor.ts` | Advance one operation or sweep a bounded due batch. |
| `src/lib/skillPublication/serviceAuth.ts` | Authenticate the internal recovery sweep. |
| `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/publish/route.ts` | Admit Save and attempt immediate progress. |
| `src/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/duplicate-decision/route.ts` | Confirm or decline the recorded weak matches. |
| `src/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/placement/route.ts` | Replace an invalid placement after live publication. |
| `src/app/api/v1/internal/skill-publications/process/route.ts` | Bounded authenticated recovery sweep. |
| `openapi/skill-publication.json` | Canonical browser and Ignatious publication contract. |
| `scripts/verify-skill-publication-contract.ts` | Compare canonical and pinned OpenAPI, ignoring only source revision. |
| `supabase/migrations/20260916120000_skill_publication.sql` | Operation table, indexes, immutability, and retry metadata; admission, decisions, state transitions, safe reads, and due selection; the browser projection; exact version-pinned rail insertion and draft publication transaction. |
| `supabase/tests/skill_publication.sql` | Local SQL behavior and concurrency probe. |
| `tests/db/skill-publication.test.ts` | Loopback-only Vitest wrapper for the SQL probe. |
| `tests/skill-publication-contract.test.ts` | Parser, OpenAPI, and pinned binding contract tests. |
| `tests/skill-publication-routes.test.ts` | Admission, decision, placement, access, flag, and safe response tests. |
| `tests/skill-publication-processor.test.ts` | State machine, retry, lookup, and attachment tests. |
| `tests/skill-publication-sweep-route.test.ts` | Processor authentication and bounded sweep tests. |
| `tests/skill-backed-step-definition.test.ts` | Rail parsing and pinned execution-facing binding regression. |
| `tests/skill-builder-publication.test.tsx` | Builder state, confirmation, replacement placement, close, and success tests. |
| `tests/skill-publication-rail-focus.test.tsx` | Refresh and focus of the inserted pending step. |
| `.github/workflows/process-skill-publications.yml` | Five-minute and manual recovery invocation. |

### Conductia modified files

| Path | Change |
|---|---|
| `src/lib/skillAuthoring/types.ts` | Replace unavailable publication placeholder with safe publication union. |
| `src/lib/skillAuthoring/client.ts` | Add publish, duplicate decision, and replacement placement methods. |
| `src/lib/skillAuthoring/clientResponse.ts` | Parse safe publication state exactly. |
| `src/lib/skillAuthoring/browserResponse.ts` | Accept the authoritative publication projection. |
| `src/lib/skillAuthoring/browserRoute.ts` | Normalize safe publication state and map publication conflicts. |
| `src/lib/skillAuthoring/useSkillAuthoringDraft.ts` and split controller files | Poll and command durable publication states. |
| `src/components/rail/SkillBuilderDialog.tsx` | Render publication workflow and call success callback. |
| `src/components/rail/SkillBuilderDialogParts.tsx` | Enable Save and add status/decision/placement controls. |
| `src/components/rail/SkillBuilderDialogChrome.tsx` | Add honest background and failure copy. |
| `src/components/rail/skillBuilderDialogState.ts` | Derive editable and publication-frozen UI states. |
| `src/components/rail/DealRail.tsx` | Refresh then focus the resulting step. |
| `src/lib/rail/projectRail.ts` | Add strict schema-versioned skill definition parsing. |
| `.env.example` | Document publication and processor credentials. |
| `package.json` | Add publication contract verification script. |
| `README.md` | Document local processor and compatibility commands. |

### Ignatious new files

| Path | Responsibility |
|---|---|
| `platform/apps/skill-bench/src/authoring/publication/contract.ts` | Zod schemas generated by hand from the pinned provider-neutral contract. |
| `platform/apps/skill-bench/src/authoring/publication/contract/openapi.json` | Pinned Conductia contract with source revision. |
| `platform/apps/skill-bench/src/authoring/publication/auth.ts` | Publication-only bearer-token guard. |
| `platform/apps/skill-bench/src/authoring/publication/capability-comparison.ts` | Stable normalization and exact/equivalent/similar classification. |
| `platform/apps/skill-bench/src/authoring/publication/store.ts` | Preparation and immutable publication store interfaces. |
| `platform/apps/skill-bench/src/authoring/publication/postgres-store.ts` | Transactional Postgres implementation. |
| `platform/apps/skill-bench/src/authoring/publication/service.ts` | Candidate proof, preparation, publish, and lookup orchestration. |
| `platform/apps/skill-bench/src/authoring/publication/routes.ts` | Private `/v1/conductia/skill-publications` Hono routes. |
| `platform/apps/skill-bench/src/authoring/postgres/migrations/004_skill_publication.sql` | Preparation receipts and immutable project-scoped versions. |
| `platform/apps/skill-bench/src/authoring/publication/*.test.ts` | Unit, route, auth, replay, isolation, and Postgres tests. |
| `platform/apps/skill-bench/src/authoring/publication/e2e-publication.test.ts` | Real HTTP and Postgres recovery fixture without model calls. |

### Ignatious modified files

| Path | Change |
|---|---|
| `platform/apps/skill-bench/src/authoring/postgres/checkpoint-candidate-store.ts` | Load immutable candidate bytes by provider candidate ID and digest. |
| `platform/apps/skill-bench/src/authoring/store-types.ts` | Add read-only candidate lookup interface. |
| `platform/apps/skill-bench/src/config.ts` | Parse a distinct publication service token. |
| `platform/apps/skill-bench/src/server.ts` | Mount publication routes beside the existing bench routes. |
| `platform/apps/skill-bench/src/main.ts` | Open and close the publication store with the service. |
| `platform/apps/skill-bench/src/index.ts` | Export publication seams required by tests. |
| `platform/.env.example` | Document the dedicated publication token. |
| `platform/docker-compose.yml` | Supply a local-only publication token. |
| `platform/README.md` | Document contract, storage, startup, and recovery commands. |
| `platform/infrastructure/modules/demo/main.tf` and `variables.tf` | Inject the scoped secret into skill-bench. |
| `platform/infrastructure/environments/demo/terraform.tfvars` | Declare the demo secret reference. |
| `platform/infrastructure/environments/prod/terraform.tfvars` | Declare the production secret reference without a plaintext value. |
| `platform/infrastructure/README.md` | Add rotation and rollout notes. |

---

### Task 1: Reconcile and freeze the cross-service contract

**Repository:** Conductia

**Files:**
- Create: `src/lib/skillPublication/types.ts`
- Create: `src/lib/skillPublication/parse.ts`
- Create: `tests/skill-publication-contract.test.ts`
- Create: `openapi/skill-publication.json`
- Modify: `package.json`

**Interfaces:**

```ts
export const PUBLICATION_STATES = [
  "preparing",
  "confirmation_required",
  "publishing",
  "attaching",
  "reconciling",
  "needs_placement",
  "published",
  "failed",
] as const;

export type SkillBinding = {
  skillId: string;
  versionId: string;
  digest: string;
};

export type SkillStepDefinitionV1 = {
  schemaVersion: 1;
  type: "skill";
  title: string;
  description: string;
  inputs: [{
    key: "primary";
    kind: "text";
    label: "Input";
    helperText: string;
    required: true;
  }];
  skillBinding: SkillBinding;
};

export type PublishCommand = {
  requestId: string;
  expectedEditRevision: number;
  candidateId: string;
  candidateDigest: string;
};

export type DuplicateDecisionCommand = {
  expectedRevision: number;
  assessmentDigest: string;
  decision: "confirm" | "decline";
};
```

- [ ] **Step 1: Write failing parser and OpenAPI tests**

Cover exact keys, all states, UUIDs, nonnegative revisions, SHA-256 lowercase hex, the three required binding fields, and exactly one `primary` text input. Reject an extra input in schema version 1.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run tests/skill-publication-contract.test.ts`

Expected: FAIL because the new modules and OpenAPI document do not exist.

- [ ] **Step 3: Implement strict types and parsers**

Export `parsePublishCommand`, `parseDuplicateDecisionCommand`, `parsePlacementCommand`, `parsePreparationResponse`, `parsePublicationLookup`, and `parseSkillStepDefinitionV1`. Use exact object-key checks. Define `DIGEST_PATTERN = /^[0-9a-f]{64}$/` once in `parse.ts`.

- [ ] **Step 4: Write the canonical OpenAPI document**

Include the three Conductia browser commands and the three Ignatious operations. Define reusable schemas for `CapabilityContract`, `ComparisonTarget`, `DuplicateMatch`, `PreparationReceipt`, `PublicationReceipt`, `PublicationRead`, `SkillBinding`, and `SkillStepDefinitionV1`. Mark all objects `additionalProperties: false`. Require `skillId`, `versionId`, and `digest` wherever a binding or receipt occurs.

- [ ] **Step 5: Add the verification command**

Add `"verify:skill-publication-contract": "node --import tsx scripts/verify-skill-publication-contract.ts"` to `package.json`. The script is created in Task 16.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/skill-publication-contract.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/skillPublication/types.ts src/lib/skillPublication/parse.ts tests/skill-publication-contract.test.ts openapi/skill-publication.json package.json
git commit -m "feat(skills): define publication contract"
```

### Task 2: Add the durable Conductia operation schema

**Repository:** Conductia

**Files:**
- Create: `supabase/migrations/20260916120000_skill_publication.sql`
- Create: `supabase/tests/skill_publication.sql`
- Create: `tests/db/skill-publication.test.ts`

- [ ] **Step 1: Write failing SQL probes**

Probe defaults and checks, idempotency on `(draft_id, client_request_id)`, one non-failed operation per draft, unique `reserved_skill_id`, immutable frozen fields, immutable live receipt, SHA-256 checks, and a corrected operation after a failed one. Include one two-session simultaneous admission test only.

- [ ] **Step 2: Run against disposable local Postgres and verify failure**

Run:

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres npx vitest run --config vitest.integration.config.ts tests/db/skill-publication.test.ts
```

Expected: FAIL because `skill_publication_operations` does not exist.

- [ ] **Step 3: Create the operation table**

Use typed scalar columns for identities and frozen metadata, including `phase_index`, `placement_kind`, and nullable `anchor_deal_step_id`. Use `jsonb` only for capability contract, duplicate matches, safe result, and status detail. Add `revision bigint not null default 0`, `attempt_count int not null default 0`, `next_retry_at timestamptz`, and timestamps. Use a partial unique index:

```sql
create unique index skill_publication_one_live_per_draft_idx
  on skill_publication_operations (draft_id)
  where state <> 'failed';
```

Add a trigger that rejects changes to the admitted candidate, draft revision, name, reserved IDs, and capability contract. Once `published_version_id` is non-null, reject any change to published skill ID, version ID, or digest.

- [ ] **Step 4: Protect direct access**

Enable RLS, add no browser table policies, revoke public/authenticated mutations, and grant only service-role access through the planned functions.

- [ ] **Step 5: Run the SQL probe**

Expected: PASS, including exactly one winner for the simultaneous Save case.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260916120000_skill_publication.sql supabase/tests/skill_publication.sql tests/db/skill-publication.test.ts
git commit -m "feat(skills): persist publication operations"
```

### Task 3: Implement admission, duplicate facts, commands, and safe reads

**Repository:** Conductia

**Files:**
- Create: `supabase/migrations/20260916120000_skill_publication.sql`
- Modify: `supabase/tests/skill_publication.sql`

**Database functions:**

```text
skill_publication_admit(actor, deal, draft, request, expected_revision, candidate, digest, correlation)
skill_publication_decide_duplicate(actor, deal, publication, expected_revision, assessment_digest, decision, correlation)
skill_publication_replace_placement(actor, deal, publication, expected_revision, placement, correlation)
skill_publication_read(actor, deal, publication, correlation)
skill_publication_due(limit)
skill_publication_transition(publication, expected_states, next_state, patch)
skill_publication_browser_view(publication)
```

- [ ] **Step 1: Extend failing SQL probes**

Cover active author ownership, expected edit revision, terminal candidate ID and digest, no active generation, nonblank name, selected placement, active anchor, `skill_authoring` flag, current access and structure permission. Cover identical request replay and changed payload conflict. Cover deterministic duplicate facts from active steps, removed steps, and non-failed admitted operations.

- [ ] **Step 2: Implement admission as one short transaction**

Begin by locking the deal row and draft row. Derive name, placement, capability fields, actor, deal/company scope, candidate, reserved skill UUID, and `custom:<uuid>` step key on the server. Never accept name, scope, actor, placement, or comparison targets from the browser command.

- [ ] **Step 3: Implement duplicate decision and placement commands**

Confirmation must match both `revision` and `assessment_digest`. If the comparison set changed, return the operation to `preparing`. Decline sets `failed` with `duplicate_declined`. Replacement placement is allowed only in `needs_placement`, changes only placement fields, and returns to `attaching`.

- [ ] **Step 4: Implement due selection without ownership claims**

`skill_publication_due(25)` returns IDs in retry-time order for `preparing`, `publishing`, `attaching`, and `reconciling`. It must not mutate ownership or add a lease. State transitions use `where state = any(expected_states)` and are safe to lose to another processor.

- [ ] **Step 5: Implement safe browser projection and audit**

Return only `available`, `id`, `state`, `revision`, safe matches, safe error, and result. The result contains rail step ID and exact binding. Audit identifiers, digests, state, reason code, and actor/service completion only. Never audit transcript, package bytes, input text, credentials, or provider path.

- [ ] **Step 6: Run SQL probes**

Run the Task 2 database command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260916120000_skill_publication.sql supabase/tests/skill_publication.sql
git commit -m "feat(skills): admit and read publication commands"
```

### Task 4: Project publication state through the Part B draft boundary

**Repository:** Conductia

**Files:**
- Modify: `src/lib/skillAuthoring/types.ts`
- Modify: `src/lib/skillAuthoring/browserResponse.ts`
- Modify: `src/lib/skillAuthoring/browserRoute.ts`
- Modify: `src/lib/skillAuthoring/clientResponse.ts`
- Create: `src/lib/skillPublication/browserResponse.ts`
- Create: `src/lib/skillPublication/clientResponse.ts`
- Create: `tests/skill-publication-projection.test.ts`
- Create: `supabase/migrations/20260916120000_skill_publication.sql`

- [ ] **Step 1: Write failing authoritative and browser parser tests**

Test every operation state, safe match shape, null result before success, exact binding on success, and rejection of artifact references, provider paths, extra keys, missing version IDs, and malformed digests.

- [ ] **Step 2: Replace the placeholder type**

Change `publication: { available: false }` to `publication: { available: false } | PublicationRead`. Keep `available: false` for active drafts with no operation.

- [ ] **Step 3: Replace the database projection**

Create or replace `skill_authoring_browser_draft` so it calls `skill_publication_browser_view` for the draft's non-failed operation, or its latest failed operation when no non-failed operation exists. Do not expose candidate `artifact_reference`.

- [ ] **Step 4: Implement strict server and client normalization**

The server accepts only the SQL projection shape. The browser client then independently parses the serialized product shape. Do not cast unknown publication JSON to `PublicationRead`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/skill-publication-contract.test.ts tests/skill-publication-projection.test.ts tests/skill-authoring-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skillAuthoring/types.ts src/lib/skillAuthoring/browserResponse.ts src/lib/skillAuthoring/browserRoute.ts src/lib/skillAuthoring/clientResponse.ts src/lib/skillPublication/browserResponse.ts src/lib/skillPublication/clientResponse.ts tests/skill-publication-projection.test.ts supabase/migrations/20260916120000_skill_publication.sql
git commit -m "feat(skills): expose safe publication state"
```

### Task 5: Add the atomic pinned attachment transaction

**Repository:** Conductia

**Files:**
- Create: `supabase/migrations/20260916120000_skill_publication.sql`
- Modify: `supabase/tests/skill_publication.sql`
- Modify: `src/lib/rail/projectRail.ts`
- Create: `tests/skill-backed-step-definition.test.ts`

**Interface:**

```sql
skill_publication_attach(p_publication_id uuid) returns jsonb
```

- [ ] **Step 1: Write failing attachment and rail parser tests**

Prove the function locks the deal and operation, accepts only `attaching`, verifies all receipt fields, calls Part A `rail_insert_step` with `p_request_id = publication_id::text` and the reserved step key, creates one pending step, publishes the draft, and returns the same step on replay. Prove no partial step or terminal claim survives a failing transaction.

- [ ] **Step 2: Pin the exact definition**

Construct the definition directly from the locked operation row:

```sql
jsonb_build_object(
  'schemaVersion', 1,
  'type', 'skill',
  'title', v_operation.name,
  'description', v_operation.capability_contract ->> 'purpose',
  'inputs', jsonb_build_array(jsonb_build_object(
    'key', 'primary',
    'kind', 'text',
    'label', 'Input',
    'helperText', v_operation.capability_contract ->> 'expectedInput',
    'required', true
  )),
  'skillBinding', jsonb_build_object(
    'skillId', v_operation.published_skill_id,
    'versionId', v_operation.published_version_id,
    'digest', v_operation.published_digest
  )
)
```

Pass the frozen original `actor_id` to Part A's insertion function so its existing audit foreign key remains valid. Record a separate publication audit detail marking service completion. Do not recheck author permission inside this service-only reconciliation function.

- [ ] **Step 3: Handle removed anchors precisely**

Map only Part A's `P0002 anchor_removed` result to `needs_placement`. Keep the live receipt unchanged. Phase-start and phase-end continue through Part A rebasing.

- [ ] **Step 4: Extend rail parsing**

Make `ProjectRailStep.definition` a union of the existing manual definition and `SkillStepDefinitionV1`. Reject `type: "skill"` unless the input array and all three binding fields pass strict validation.

- [ ] **Step 5: Add the execution-facing pin regression**

In `tests/skill-backed-step-definition.test.ts`, create a definition bound to version `v1`, then present a library fixture where the same name has `v2`. Assert the execution-facing selector returns the `v1` ID and digest from the rail definition and never invokes the name/latest resolver. This test establishes Part D's required consumption boundary without implementing execution.

- [ ] **Step 6: Run focused and SQL tests**

```bash
npx vitest run tests/skill-backed-step-definition.test.ts tests/project-rail-contract.test.ts
RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres npx vitest run --config vitest.integration.config.ts tests/db/skill-publication.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260916120000_skill_publication.sql supabase/tests/skill_publication.sql src/lib/rail/projectRail.ts tests/skill-backed-step-definition.test.ts
git commit -m "feat(skills): attach pinned versions to the rail"
```

### Task 6: Pin the contract and isolate Ignatious publication authentication

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/publication/contract/openapi.json`
- Create: `platform/apps/skill-bench/src/authoring/publication/contract.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/auth.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/contract.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/auth.test.ts`
- Modify: `platform/apps/skill-bench/src/config.ts`
- Modify: `platform/apps/skill-bench/src/authoring/worker-config.test.ts`

- [ ] **Step 1: Copy the approved canonical contract and record its source revision**

Copy `openapi/skill-publication.json` from the Conductia Task 1 commit. Add only `info.x-source-revision` to the pinned copy.

- [ ] **Step 2: Write failing Zod and auth tests**

Validate every request and response fixture against Zod and the pinned OpenAPI. Prove the existing inbound bench key and Part B authoring worker token are both rejected by publication routes. Prove startup rejects a missing, default, or reused publication token outside local deployment.

- [ ] **Step 3: Implement the contract module**

Export `PrepareRequestSchema`, `PreparationReceiptSchema`, `PublishRequestSchema`, `PublicationReceiptSchema`, and `PublicationLookupSchema`. Use `.strict()` for objects. Require lower-case SHA-256 digests and UUID operation, project, candidate, preparation, skill, and version IDs.

- [ ] **Step 4: Implement the scoped guard**

Read `CONDUCTIA_PUBLICATION_SERVICE_TOKEN` into a distinct config field. Compare bearer credentials with the repository's constant-time key helper. Do not add publication methods to the model tool policy or Part B worker client.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/publication/contract.test.ts src/authoring/publication/auth.test.ts src/authoring/worker-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/publication platform/apps/skill-bench/src/config.ts platform/apps/skill-bench/src/authoring/worker-config.test.ts
git commit -m "feat(authoring): define publication boundary"
```

### Task 7: Add deterministic capability comparison

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/publication/capability-comparison.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/capability-comparison.test.ts`

- [ ] **Step 1: Write the classification matrix first**

Test case-folding, Unicode normalization, trim, whitespace folding, punctuation tokenization, exact structured equality, high-confidence equivalence, weaker similarity, unrelated capabilities, and stable ordering. Test each field independently so a matching purpose cannot hide incompatible input or output.

- [ ] **Step 2: Implement stable normalization and scoring**

Use `NFKC`, locale-independent lowercase, whitespace folding, and alphanumeric tokens. Classify:

- `exact` when all three normalized field strings are equal;
- `equivalent` when each field has Jaccard token overlap of at least `0.9` and the combined overlap is at least `0.95`;
- `similar` when each field has overlap of at least `0.55` and combined overlap is at least `0.7`;
- no match otherwise.

Sort matches by classification severity, then target ID. Hash canonical JSON with keys in fixed order to create `assessmentDigest`. These conservative constants live as named exports and are pinned by tests. No embeddings or model calls.

- [ ] **Step 3: Run focused tests**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/publication/capability-comparison.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/publication/capability-comparison.ts platform/apps/skill-bench/src/authoring/publication/capability-comparison.test.ts
git commit -m "feat(authoring): compare publication capabilities"
```

### Task 8: Persist preparation receipts and immutable first versions

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/postgres/migrations/004_skill_publication.sql`
- Create: `platform/apps/skill-bench/src/authoring/publication/store.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/postgres-store.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/postgres-store.integration.test.ts`
- Modify: `platform/apps/skill-bench/src/authoring/store-types.ts`
- Modify: `platform/apps/skill-bench/src/authoring/postgres/checkpoint-candidate-store.ts`
- Modify: `platform/apps/skill-bench/src/authoring/postgres/migrations.test.ts`

- [ ] **Step 1: Write failing migration and store tests**

Cover candidate lookup by opaque provider candidate ID and digest, preparation replay by operation plus comparison-set digest, retained superseded preparations, one immutable publication per operation, unique skill and version IDs, project isolation, payload conflict, and exact byte equality.

- [ ] **Step 2: Add candidate lookup without broadening candidate authority**

Extend the authoring store with:

```ts
export interface PrivateCandidateReader {
  readCandidate(candidateId: string): Promise<PrivateCandidateRecord | null>;
}
```

The query uses `provider_candidate_id`, returns the immutable stored row, and does not expose a list or name lookup.

- [ ] **Step 3: Add publication tables**

Create `skill_authoring.skill_publication_preparations` keyed by preparation ID with operation ID, comparison-set digest, request digest, normalized capability, assessment digest, matches, and timestamps. Create `skill_authoring.skill_publications` keyed by operation ID with project ID, skill ID, version ID, digest, package bytes, request digest, and published timestamp. Add unique indexes for skill ID and version ID.

- [ ] **Step 4: Implement atomic replay semantics**

On an operation replay, return the stored receipt only when its canonical request digest matches. Otherwise throw a typed conflict. Store the package bytes in the live publication row so future candidate cleanup cannot invalidate an immutable version.

- [ ] **Step 5: Run focused Postgres tests**

```bash
SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/publication/postgres-store.integration.test.ts src/authoring/postgres/migrations.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/postgres platform/apps/skill-bench/src/authoring/store-types.ts platform/apps/skill-bench/src/authoring/publication/store.ts platform/apps/skill-bench/src/authoring/publication/postgres-store.ts platform/apps/skill-bench/src/authoring/publication/postgres-store.integration.test.ts
git commit -m "feat(authoring): persist immutable publications"
```

### Task 9: Implement Ignatious prepare, publish, lookup, and routes

**Repository:** Ignatious

**Files:**
- Create: `platform/apps/skill-bench/src/authoring/publication/service.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/service.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/routes.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/routes.test.ts`
- Create: `platform/apps/skill-bench/src/authoring/publication/e2e-publication.test.ts`
- Modify: `platform/apps/skill-bench/src/server.ts`
- Modify: `platform/apps/skill-bench/src/main.ts`
- Modify: `platform/apps/skill-bench/src/index.ts`

- [ ] **Step 1: Write failing service and HTTP tests**

Cover candidate not found, digest mismatch, package schema failure, preparation replay, changed comparison set, publish replay, changed candidate/scope/identity/preparation conflict, lookup before and after publish, cross-project same name, and no discovery by name.

- [ ] **Step 2: Implement prepare**

Load candidate bytes, verify both stored and recomputed SHA-256 digest, validate the existing package schema, confirm the package capability fields equal the request's frozen contract, run deterministic comparison, persist the receipt, then respond. Do not return bytes or artifact reference.

- [ ] **Step 3: Implement first-version publication**

Verify the current preparation and request equality. Use the Conductia-reserved skill UUID and derive the first version UUID deterministically with the repository's name-based UUID helper and the domain string `conductia-skill-version:1`. Copy exact candidate bytes and digest into the immutable publication table before replying.

- [ ] **Step 4: Implement lookup**

Return one of `not_published`, current preparation, or published receipt by operation ID. Never treat an unknown operation as permission to create another identity.

- [ ] **Step 5: Mount the private routes**

Expose:

```text
POST /v1/conductia/skill-publications/:operationId/prepare
POST /v1/conductia/skill-publications/:operationId/publish
GET  /v1/conductia/skill-publications/:operationId
```

Mount them on the same Hono server before `serve`, but under the publication-only bearer guard rather than the existing `/v1/bench` API-key guard. Return typed 401, 404, 409, 422, and 500 envelopes without echoing sensitive input.

- [ ] **Step 6: Run focused and E2E tests**

```bash
pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/publication
SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/publication/e2e-publication.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add platform/apps/skill-bench/src/authoring/publication platform/apps/skill-bench/src/server.ts platform/apps/skill-bench/src/main.ts platform/apps/skill-bench/src/index.ts
git commit -m "feat(authoring): publish project scoped skill versions"
```

### Task 10: Configure the Ignatious publication boundary

**Repository:** Ignatious

**Files:**
- Modify: `platform/.env.example`
- Modify: `platform/docker-compose.yml`
- Modify: `platform/README.md`
- Modify: `platform/infrastructure/modules/demo/main.tf`
- Modify: `platform/infrastructure/modules/demo/variables.tf`
- Modify: `platform/infrastructure/environments/demo/terraform.tfvars`
- Modify: `platform/infrastructure/environments/prod/terraform.tfvars`
- Modify: `platform/infrastructure/README.md`

- [ ] **Step 1: Write configuration tests before edits**

Extend the existing config tests to prove the publication token is separate from `CONDUCTIA_INBOUND_API_KEY` and `CONDUCTIA_AUTHORING_SERVICE_TOKEN`, is never logged, and is required when publication routes are enabled.

- [ ] **Step 2: Add local and infrastructure configuration**

Use `CONDUCTIA_PUBLICATION_SERVICE_TOKEN`. Compose may use `local-publication-key`; demo and production use secret references only. Do not place a real secret in tfvars or docs.

- [ ] **Step 3: Document storage and rollout**

State that publication shares the durable `skill_authoring` Postgres schema, retains immutable bytes, is addressed by opaque IDs, and cannot be invoked by authoring/model credentials. Include token rotation and contract-pin commands.

- [ ] **Step 4: Run checks**

```bash
pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/worker-config.test.ts src/authoring/publication
pnpm --filter @ignatious/skill-bench typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add platform/.env.example platform/docker-compose.yml platform/README.md platform/infrastructure
git commit -m "chore(authoring): configure publication service"
```

### Task 11: Build Conductia's project comparison set and Ignatious client

**Repository:** Conductia

**Files:**
- Create: `src/lib/skillPublication/config.ts`
- Create: `src/lib/skillPublication/ignatiousClient.ts`
- Create: `src/lib/skillPublication/comparisonSet.ts`
- Create: `tests/skill-publication-ignatious-client.test.ts`
- Create: `tests/skill-publication-comparison-set.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing client and comparison tests**

Cover bearer auth, timeout, invalid JSON, strict response parsing, correlation ID, lookup status, stable target ordering, stable canonical digest, active versus removed targets, admitted operations, project isolation, and project-local normalized name collisions.

- [ ] **Step 2: Implement fail-closed config**

Read `IGNATIOUS_SKILL_BENCH_URL`, `IGNATIOUS_PUBLICATION_SERVICE_TOKEN`, and `SKILL_PUBLICATION_PROCESSOR_TOKEN`. Keep the publication token separate from the general Ignatious API key and Part B worker token. Never expose these variables through `NEXT_PUBLIC_*`.

- [ ] **Step 3: Implement the service client**

Expose `prepare(operation)`, `publish(operation)`, and `lookup(operationId)`. Use a bounded request timeout, `Authorization: Bearer`, `x-correlation-id`, and strict response parsers. A timeout returns an ambiguous typed error; it never returns `not_published`.

- [ ] **Step 4: Implement comparison-set construction**

Read only the current deal's active and relevant removed skill-backed definitions plus non-failed admitted operations. Canonicalize by opaque target ID, state, normalized name, capability contract, and binding. Hash canonical JSON. Never query or reveal another project's matching names.

- [ ] **Step 5: Run focused tests**

```bash
npx vitest run tests/skill-publication-ignatious-client.test.ts tests/skill-publication-comparison-set.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skillPublication/config.ts src/lib/skillPublication/ignatiousClient.ts src/lib/skillPublication/comparisonSet.ts tests/skill-publication-ignatious-client.test.ts tests/skill-publication-comparison-set.test.ts .env.example
git commit -m "feat(skills): connect publication services"
```

### Task 12: Implement the simple Conductia publication processor

**Repository:** Conductia

**Files:**
- Create: `src/lib/skillPublication/processor.ts`
- Create: `tests/skill-publication-processor.test.ts`

**Interfaces:**

```ts
export type AdvanceResult = {
  publicationId: string;
  state: PublicationState;
  progressed: boolean;
};

export async function advancePublication(publicationId: string): Promise<AdvanceResult>;
export async function drivePublication(publicationId: string, maxSteps?: number): Promise<AdvanceResult>;
export async function processDuePublications(limit?: number): Promise<AdvanceResult[]>;
```

- [ ] **Step 1: Write the complete failing state table**

Test preparing, confirmation pause, current-set change, permission loss, flag disablement, publishing, publish timeout, reconciling lookup, proven-not-published retry, live receipt capture, attaching, transient attachment failure, removed anchor, replacement placement, and published no-op.

- [ ] **Step 2: Implement one-step advancement**

Each `advancePublication` call reads authoritative state, performs at most one network operation or one local attachment, and persists the result. `drivePublication` calls it at most four times and stops when no progress occurs, user action is required, a retry time is set, or a terminal state is reached. `processDuePublications` drives each selected row with the same four-step cap. This keeps requests bounded and makes two processors harmless. Use state-predicate updates and database uniqueness only.

- [ ] **Step 3: Enforce duplicate policy before publish**

Rebuild the comparison set before publish. Hard-block same active identity, same normalized active name, identical contract, and Ignatious `equivalent`. For removed same-name, exact-identity, or equivalent matches, set a safe Restore action. Pause on active `similar` until the exact recorded assessment is confirmed. Ignore weak removed matches.

- [ ] **Step 4: Implement retry timing**

Use bounded backoff of 5, 15, 60, 300, then 900 seconds, capped at 15 minutes. Increment `attempt_count` only after an attempted remote or attachment action. A publish timeout enters `reconciling`; only lookup may prove whether publish happened.

- [ ] **Step 5: Enforce authorization timing**

Before publication, current access, structure permission, and flag must still pass. Proven-unpublished work pauses if the flag is off or permission is absent. Ambiguous publication continues lookup. A stored live receipt continues exact attachment as service reconciliation even after permission loss.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/skill-publication-processor.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/skillPublication/processor.ts tests/skill-publication-processor.test.ts
git commit -m "feat(skills): process durable publications"
```

### Task 13: Add browser commands and periodic recovery

**Repository:** Conductia

**Files:**
- Create: `src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/publish/route.ts`
- Create: `src/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/duplicate-decision/route.ts`
- Create: `src/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/placement/route.ts`
- Create: `src/app/api/v1/internal/skill-publications/process/route.ts`
- Create: `src/lib/skillPublication/serviceAuth.ts`
- Create: `tests/skill-publication-routes.test.ts`
- Create: `tests/skill-publication-sweep-route.test.ts`
- Create: `.github/workflows/process-skill-publications.yml`

- [ ] **Step 1: Write failing route tests**

Cover auth, deal scope, ownership, permission, flag, exact command parsing, idempotent status codes, stale revision/candidate codes, confirmation revision, placement restriction, safe responses, processor token, and a maximum batch of 25.

- [ ] **Step 2: Implement Save admission and immediate progress**

Call the admission RPC, then call `advancePublication` once before returning. Register `after(() => drivePublication(publicationId, 4))` from `next/server` so fast prepare, publish, and attach steps continue after the response. Return `202` for nonterminal operation state and `200` for already-published replay. `drivePublication` stops at confirmation, replacement placement, terminal state, or scheduled retry.

- [ ] **Step 3: Implement decision and placement routes**

Reuse `requireSkillAuthoringAccess`. Only the original currently authorized author can confirm or replace placement. Decline is a known pre-publication terminal action. Call one immediate advancement after a successful confirm or placement replacement.

- [ ] **Step 4: Implement the recovery endpoint**

Require an Authorization bearer value equal to `SKILL_PUBLICATION_PROCESSOR_TOKEN`, accept no request body, run `processDuePublications(25)`, and return counts by resulting state without names or content.

- [ ] **Step 5: Add the five-minute schedule**

The workflow uses `workflow_dispatch` and `schedule: [{ cron: "*/5 * * * *" }]`, reads `SKILL_PUBLICATION_PROCESSOR_URL` and `SKILL_PUBLICATION_PROCESSOR_TOKEN` from GitHub secrets, and performs one `curl --fail-with-body` POST. It does not enable `skill_authoring` or deploy code. Document that GitHub runs schedules only from the default branch.

- [ ] **Step 6: Run route tests**

```bash
npx vitest run tests/skill-publication-routes.test.ts tests/skill-publication-sweep-route.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/publish/route.ts' 'src/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/duplicate-decision/route.ts' 'src/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/placement/route.ts' src/app/api/v1/internal/skill-publications/process/route.ts src/lib/skillPublication/serviceAuth.ts tests/skill-publication-routes.test.ts tests/skill-publication-sweep-route.test.ts .github/workflows/process-skill-publications.yml
git commit -m "feat(skills): expose publication workflow"
```

### Task 14: Add publication commands and state polling to the browser client

**Repository:** Conductia

**Files:**
- Modify: `src/lib/skillAuthoring/client.ts`
- Modify: `src/lib/skillAuthoring/useSkillAuthoringDraft.ts`
- Modify: `src/lib/skillAuthoring/useSkillAuthoringDraftController.ts`
- Modify: `src/lib/skillAuthoring/useSkillAuthoringDraftActions.ts`
- Modify: `src/lib/skillAuthoring/useSkillAuthoringCommands.ts`
- Modify: `src/lib/skillAuthoring/useSkillAuthoringPolling.ts`
- Modify: `src/lib/skillAuthoring/useSkillAuthoringDraftState.ts`
- Create: `tests/skill-authoring-publication-client.test.ts`
- Create: `tests/skill-authoring-publication-controller.test.ts`

- [ ] **Step 1: Write failing client and controller tests**

Test request bodies, idempotent request ID retention across network failure, safe response parsing, polling after browser reopen, frozen authoring commands during nonterminal publication, confirmation, decline, replacement placement, known failure unfreeze, and success callback firing once.

- [ ] **Step 2: Extend the client interface**

Add:

```ts
publish(dealId: string, draftId: string, command: PublishCommand): Promise<DraftRead>;
decideDuplicate(dealId: string, publicationId: string, command: DuplicateDecisionCommand): Promise<DraftRead>;
replacePlacement(dealId: string, publicationId: string, command: PlacementCommand): Promise<DraftRead>;
```

- [ ] **Step 3: Extend controller state without a second workflow store**

Use the draft's safe `publication` projection as the source of truth. Poll the existing draft read while publication is nonterminal. Keep one Save request ID in controller state until the authoritative operation appears. Closing only unmounts UI and never sends cancellation.

- [ ] **Step 4: Freeze authoring commands correctly**

Disable patch, send, retry-generation, and Discard while publication is nonterminal. In `needs_placement`, enable only placement replacement. A known pre-publication `failed` restores normal draft editing.

- [ ] **Step 5: Run focused tests**

```bash
npx vitest run tests/skill-authoring-publication-client.test.ts tests/skill-authoring-publication-controller.test.ts tests/skill-authoring-controller.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skillAuthoring/client.ts src/lib/skillAuthoring/useSkillAuthoringDraft.ts src/lib/skillAuthoring/useSkillAuthoringDraftController.ts src/lib/skillAuthoring/useSkillAuthoringDraftActions.ts src/lib/skillAuthoring/useSkillAuthoringCommands.ts src/lib/skillAuthoring/useSkillAuthoringPolling.ts src/lib/skillAuthoring/useSkillAuthoringDraftState.ts tests/skill-authoring-publication-client.test.ts tests/skill-authoring-publication-controller.test.ts
git commit -m "feat(skills): control publication from the builder"
```

### Task 15: Complete the builder UI and rail handoff

**Repository:** Conductia

**Files:**
- Modify: `src/components/rail/SkillBuilderDialog.tsx`
- Modify: `src/components/rail/SkillBuilderDialogParts.tsx`
- Modify: `src/components/rail/SkillBuilderDialogChrome.tsx`
- Modify: `src/components/rail/skillBuilderDialogState.ts`
- Modify: `src/components/rail/DealRail.tsx`
- Create: `tests/skill-builder-publication.test.tsx`
- Create: `tests/skill-publication-rail-focus.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Pin Save admission rules and the visible labels `Checking project`, `Publishing skill`, `Adding step`, `Finishing in background`, and `Choose a new position`. Test weak-match confirm/decline, exact active duplicate focus action, removed duplicate Restore action, safe failure, read-only success history, close while running, no Cancel/Start over after publish ambiguity, and one success callback.

- [ ] **Step 2: Enable Save conservatively**

Enable only for an active draft with no queued/running/reconciling generation, a current candidate, nonblank name, complete placement, and no nonterminal publication. Save sends only request ID, expected edit revision, candidate ID, and candidate digest.

- [ ] **Step 3: Render durable operation states**

Keep Close available. Do not render Cancel. Automatic transient retry stays background-only. Show an explicit retry only after a known safe pre-publication failure and implement it by a new Save request after the author corrects or confirms the draft.

- [ ] **Step 4: Preserve future input extensibility**

Do not build an execution input form in Part C. The only UI responsibility is publishing the definition whose versioned array contains one primary text field. Part D will render execution inputs from that array.

- [ ] **Step 5: Refresh and focus success**

Add `onPublished(stepId: string)` to `SkillBuilderDialog`. In `DealRail`, close the dialog, call `useProjectRail().refresh()`, wait until the refreshed active steps contain `stepId`, then call the existing `openStepInFocus(stepId)`. Assert the new step remains `pending` and the current rail cursor does not move.

- [ ] **Step 6: Run focused UI tests**

```bash
npx vitest run tests/skill-builder-publication.test.tsx tests/skill-publication-rail-focus.test.tsx tests/skill-builder-dialog.test.tsx tests/skill-authoring-rail-entry.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/rail/SkillBuilderDialog.tsx src/components/rail/SkillBuilderDialogParts.tsx src/components/rail/SkillBuilderDialogChrome.tsx src/components/rail/skillBuilderDialogState.ts src/components/rail/DealRail.tsx tests/skill-builder-publication.test.tsx tests/skill-publication-rail-focus.test.tsx
git commit -m "feat(skills): finish publication in the rail UI"
```

### Task 16: Verify compatibility and cross-service recovery

**Repositories:** Conductia and Ignatious

**Files:**
- Create: `scripts/verify-skill-publication-contract.ts` in Conductia
- Create: `tests/e2e/skill-publication-recovery.test.ts` in Conductia
- Modify: `README.md` in Conductia
- Modify: `platform/README.md` in Ignatious

- [ ] **Step 1: Write the contract comparison script**

Mirror `scripts/verify-skill-authoring-contract.ts`: canonicalize JSON keys, remove only `info.x-source-revision`, compare Conductia `openapi/skill-publication.json` to Ignatious `platform/apps/skill-bench/src/authoring/publication/contract/openapi.json`, and exit nonzero on drift.

- [ ] **Step 2: Build the local recovery harness**

Use real Conductia and Ignatious HTTP handlers with disposable loopback Postgres databases and a fake package candidate. Do not call a model provider. Inject lost replies and transient failures at the HTTP boundary.

- [ ] **Step 3: Cover the ten approved recovery scenarios**

Test normal publish/attach/focus, weak confirmation with changed set, exact active duplicate, exact removed Restore, lost publish response plus lookup, transient attachment failure, lost attachment response, removed anchor plus replacement, permission loss before and after live receipt, feature disablement before and after ambiguity, and same name in another project without disclosure. Keep this small suite serial with one user flow per case.

- [ ] **Step 4: Run repository verification**

Conductia:

```bash
IGNATIOUS_REPO=/Users/cwillian/orca/workspaces/ignatious/feat-conductia-durable-authoring npm run verify:skill-authoring-contract
IGNATIOUS_REPO=/Users/cwillian/orca/workspaces/ignatious/feat-conductia-durable-authoring npm run verify:skill-publication-contract
npx vitest run tests/skill-publication-contract.test.ts tests/skill-publication-projection.test.ts tests/skill-backed-step-definition.test.ts tests/skill-publication-routes.test.ts tests/skill-publication-processor.test.ts tests/skill-publication-sweep-route.test.ts tests/skill-authoring-publication-client.test.ts tests/skill-authoring-publication-controller.test.ts tests/skill-builder-publication.test.tsx tests/skill-publication-rail-focus.test.tsx
RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres npx vitest run --config vitest.integration.config.ts tests/db/skill-publication.test.ts
npm test
npx tsc --noEmit
npx eslint .
npm run build
```

Ignatious:

```bash
pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/publication
SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/e2e- src/authoring/publication/e2e-publication.test.ts
pnpm --filter @ignatious/skill-bench typecheck
pnpm --filter @ignatious/skill-bench lint
```

Cross-service:

```bash
RUN_PUBLICATION_E2E=1 CONDUCTIA_DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres SKILL_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/ignatious_platform IGNATIOUS_REPO=/Users/cwillian/orca/workspaces/ignatious/feat-conductia-durable-authoring npx vitest run --config vitest.integration.config.ts tests/e2e/skill-publication-recovery.test.ts
```

Expected: every command passes. Any contract mismatch, unpinned binding, second version, duplicate step, nonlocal database, or leaked provider field fails the gate.

- [ ] **Step 5: Document enablement gates and operational checks**

Document counts by state and safe error code, operation age, correlation-ID lookup, the manual processor workflow, and the requirement to verify deployed operational Postgres and immutable package storage. State explicitly that execution and results remain Part D.

- [ ] **Step 6: Inspect repository diffs and forbidden complexity**

Run:

```bash
git diff --check
rg -n "lease|fencing|heartbeat|leader election|BullMQ|queue" src/lib/skillPublication src/app/api/v1/internal/skill-publications supabase/migrations/2026091020* openapi/skill-publication.json
rg -n "latest|find.*name|artifactReference|artifact_reference" src/lib/skillPublication src/lib/rail/projectRail.ts openapi/skill-publication.json
```

Expected: `git diff --check` is clean. The first search finds only explicit prohibition tests/docs, not implementation machinery. The second finds no execution or publication lookup by latest/name and no browser-exposed artifact field.

- [ ] **Step 7: Commit verification assets in each repository**

Conductia:

```bash
git add scripts/verify-skill-publication-contract.ts tests/e2e/skill-publication-recovery.test.ts README.md
git commit -m "test(skills): verify publication recovery"
```

Ignatious:

```bash
git add platform/README.md
git commit -m "docs(authoring): document publication recovery"
```

## Done criteria

- Save always names the exact candidate ID, candidate digest, and accepted draft revision.
- Ignatious returns the same preparation and first immutable version on identical replay.
- Conductia never inserts a step before it has stored a live receipt.
- The local transaction writes one pending step and pins skill ID, version ID, and digest together.
- A newer version or matching name cannot replace the pinned binding at the execution-facing boundary.
- Browser close, lost responses, and process restart converge through immediate advancement plus the five-minute recovery sweep.
- Exact/equivalent duplicates block; weak active matches require one explicit confirmation; weak removed matches are ignored.
- A removed anchor requires replacement placement while retaining the same live version.
- The builder displays all approved publication states, then refreshes and focuses the inserted step.
- Schema version 1 stores one required primary text input inside a versioned array.
- `skill_authoring` remains the only product flag.
- No publication lease, fence, queue, distributed lock, model judge, or embedding service exists.
- Execution, run history, results, and generated files remain unimplemented until Part D.
