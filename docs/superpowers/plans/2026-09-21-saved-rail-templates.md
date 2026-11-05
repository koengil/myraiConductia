# Saved Rail Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authorized company users save or replace a named rail template and create independent deals from its structure and selected skill versions.

**Architecture:** Conductia stores named templates, immutable revisions and resumable creation commands; Ignatious retains exact skill packages and copies them into new project-owned publication identities. Replacement atomically changes the template's current revision, while each destination owns its own steps, skill bindings and future enhancement lineage. Preserve existing Gate 0 and skill execution surfaces.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase/Postgres, Vitest, Playwright; Ignatious Hono, Postgres, existing skill package readers.

**Spec:** [2026-09-21-saved-rail-templates-design.md](../specs/2026-09-21-saved-rail-templates-design.md). Read the spec and this plan before implementation.

## Global Constraints

- Keep the 61-step standard rail selected by default in Gate 0.
- Templates belong to one bank company and tenant; template use does not grant access to the source deal.
- Save and replace require internal source-deal access and `company:deals:steps:structure` on that deal's bank company.
- List and use require internal company membership and the existing authority to create deals in that company; source-deal membership is unnecessary.
- Save active steps in their current order, including completed and skipped steps; exclude removed steps.
- Copy structure and each step's selected default skill version, never its most recent one-off run version.
- Clear named owners and recipients, work, skips, completions, outputs, documents, run history, authoring conversations, and source-deal access grants.
- New deals receive fresh step identities and independent project skill identities; subsequent enhancement affects only the destination deal.
- Replacing a template affects future creations only; a creation already admitted keeps its captured revision.
- Preserve Gate 0 validation, conflicts attestation, team creation, notification receipts, and protected rail steps.
- Keep skill package bytes in Ignatious; browsers communicate only with Conductia APIs.
- Use existing dependencies and test frameworks: Conductia Node >=22.12.0, backend Node >=22.13.0 and pnpm 11.17.0.
- Do not enable hosted flags, deploy, merge, or call live models as part of implementation verification.

---

## Execution base and ownership

This is one cross-repository feature with sequential dependencies, not two independently shippable products. Commit each task separately. Backend changes can deploy dark before the Conductia UI; enablement waits for the full acceptance journey.

| Label | Repository | Inspected base | Integration target |
|---|---|---|---|
| C | `Conductia/Conductia` | `947487e8832b94b6140416129ae8c8a6a8e1792e`, PR #184 | `develop` after Parts A–E |
| I | `Conductia/conductia-agents-backend` | `caadecd3d81a5d260c696e344d1009458838ee1b`, PR #139 | `main` after Parts B–E |

Local inspection used `/Users/cwillian/Documents/personal/learning/conductia` and sibling `ignatious`. The latter's origin may still use the legacy `rtslabs/ignatious` name; verify the intended repository before pushing. Existing untracked files are unrelated and must remain untouched.

- [ ] Verify the stacks have landed, or explicitly base isolated implementation branches on the inspected tips if execution is requested before merge. Use the worktree skill at execution time. Never commit to `main`/`master`.
- [ ] Compare the integrated code with the inspected tips. Reconcile any changed signatures before task 1. The current local `develop` checkout does not contain the stack implementation.

```bash
git status --short
git log -5 --oneline
git diff 947487e8832b94b6140416129ae8c8a6a8e1792e -- src/lib/skillRun src/lib/skillPublication src/components/wizard/Gate0Wizard.tsx
```

Run the equivalent backend diff against `caadecd3d81a5d260c696e344d1009458838ee1b` for `platform/apps/skill-bench/src/authoring`. Migration numbers below are proposed; if occupied at execution, choose the next number and update this plan plus probe references together.

Both top PRs were still open on 2026-09-21. These are inspected bases, not a claim that the stacks have merged. The latest Conductia tip adds `currentStep` to deal-list responses and `useProjectRail(projectId, {withStepRecords:true})` for consumers needing work records. Preserve these behaviors; do not reinstate the older sequence-only navigation or default work-record fetch.

## File structure and responsibility

Paths in tasks are relative to C or I as marked. New C domain modules live together in `src/lib/railTemplates/`; do not spread snapshot rules into React components.

| Unit | New files | Existing integration points |
|---|---|---|
| Snapshot contract/projection | C `src/lib/railTemplates/{types,snapshot,materialize}.ts` | `src/lib/skillRun/{types,step}.ts`, `src/lib/rail/protectedSteps.ts` |
| Provider archive and import | I `platform/apps/skill-bench/src/authoring/rail-templates/{contract,store,service,routes}.ts` and adjacent tests | publication mount/store, package readers, migration 004 |
| Template persistence | C migration `20260921100000_rail_templates.sql` | company permissions, feature flags, audit constants |
| Save/list/resume | C `src/lib/railTemplates/{access,repository,service,providerClient,readSource}.ts`, routes below | publication config, Supabase service client |
| Template-based creation | C `src/lib/railTemplates/{createDeal,creationRepository}.ts`, migration `20260921110000_create_deal_from_template.sql` | deal route, Gate 0 RPC |
| Imported skill metadata | C `src/lib/skillRun/publicationMetadata.ts` | versions, duplicate comparison |
| Save UI | C `src/components/rail/SaveRailDialog.tsx`, `src/lib/railTemplates/useSaveRail.ts` | `DealRail.tsx` |
| Gate 0 picker | C `src/components/wizard/RailTemplatePicker.tsx`, `src/lib/railTemplates/{client,useRailTemplates}.ts` | `Gate0Wizard.tsx` |
| Browser acceptance | C `e2e/journeys/rail-templates.spec.ts`, `e2e/support/railTemplateFixture.ts` | hermetic publication stub and fixtures |

Do not add a general template engine, generic job runner, shared cross-repo package, automatic skill upgrading, or template administration page.

## Shared contracts

Task 1 owns the C TypeScript definitions below. Task 2 owns matching wire definitions in I's `rail-templates/contract.ts`; keep parity with JSON fixture tests in task 3. `SkillReference`, `SkillBinding`, `SkillStepDefinitionV1` and `CapabilityContract` are existing types.

```ts
import type { SkillReference } from '@/lib/skillRun/types';
import type { SkillBinding, SkillStepDefinitionV1, CapabilityContract } from '@/lib/skillPublication/types';

export type TemplateDefinition =
  | { title: string; description: string }
  | Omit<SkillStepDefinitionV1, 'skillBinding'>;

export type TemplateSkill = {
  key: string; // s0, s1: stable within one revision
  source: SkillReference;
  name: string;
  contract: CapabilityContract;
};
export type TemplateStep = {
  key: string; // t0, t1: stable within one revision
  catalogStepId: string | null;
  seq: number | null;
  phaseIndex: number;
  displayOrder: number;
  definition: TemplateDefinition | null;
  skillKey: string | null;
};
export type RailManifest = {
  schemaVersion: 1;
  censusVersion: string;
  steps: TemplateStep[];
  skills: TemplateSkill[];
};
export type SaveRailCommand = {
  requestId: string;
  sourceDealId: string;
  description: string;
  target:
    | { kind: 'new'; name: string }
    | { kind: 'replace'; templateId: string; expectedRevisionId: string };
};
export type TemplateSummary = {
  id: string; revisionId: string; name: string; description: string;
  stepCount: number; skillCount: number; updatedAt: string;
};
export type TemplatePreview = TemplateSummary & {
  steps: Array<{ title: string; phaseIndex: number; displayOrder: number }>;
};
export type RetainRequest = {
  companyId: string; sourceProjectId: string;
  skills: Array<{ key: string; source: SkillReference }>;
};
export type RetainReceipt = {
  revisionId: string;
  assets: Array<{ key: string; packageDigest: string }>;
};
export type ImportTarget = {
  key: string; operationId: string; skillId: string; versionId: string;
};
export type ImportRequest = {
  companyId: string; revisionId: string; projectId: string;
  targets: ImportTarget[];
};
export type ImportReceipt = {
  requestId: string; projectId: string;
  skills: Array<{ key: string; binding: SkillBinding }>;
};
export type TemplateSelection = { templateId: string; revisionId: string };
export type TemplateErrorCode =
  | 'name_taken' | 'stale_template' | 'source_changed'
  | 'idempotency_conflict' | 'skill_unavailable' | 'provider_unavailable'
  | 'not_found' | 'forbidden' | 'invalid_command';
```

IDs are UUIDs except manifest-local `key`. All digests are 64 lowercase hexadecimal characters. Error responses use `{error: string, code: TemplateErrorCode, requestId?: string, retryable: boolean}`. Provider responses contain no package bytes. Source provenance and manifests are server-only; picker projections contain no source deal identifiers.

## Task 1: Capture and materialize a clean rail snapshot (C)

**Files:** Create `src/lib/railTemplates/{types,snapshot,materialize}.ts`, `tests/rail-templates-snapshot.test.ts`, `tests/rail-templates-materialize.test.ts`, `tests/support/railTemplateFixtures.ts`.

**Interfaces:**
- Consumes existing `ProjectRailStep`, `SkillReference`, `SkillBinding`, `PROTECTED_STEP_IDS`.
- Produces `snapshotRail(steps: SnapshotStep[], censusVersion: string, protectedIds?: ReadonlySet<string>): RailManifest`, `materializeRail(manifest: RailManifest, ids: Record<string,string>, bindings: Record<string,SkillBinding>): SeededTemplateStep[]`.
- Define `SnapshotStep = ProjectRailStep & { effectiveSkill: Omit<TemplateSkill,'key'> | null }`.
- Define `SeededTemplateStep = { id:string; stepId:string; seq:number|null; origin:'catalog'|'custom'; phaseIndex:number; displayOrder:number; definition: ManualStepDefinition|SkillStepDefinitionV1|null; binding:SkillBinding|null }`, importing existing `ManualStepDefinition`.
- `snapshotRail` rejects unstructured rows, unsupported definitions, empty rails, duplicate catalog keys, invalid phase/order, or missing protected steps. Use the full baseline in production tests; unit tests may inject a `protectedIds: ReadonlySet<string> = PROTECTED_STEP_IDS` third argument.

- [ ] **Write the projection test and fixture.** `tests/support/railTemplateFixtures.ts` exports `customStep(overrides: Partial<SnapshotStep> = {}): SnapshotStep` using the row below and spreading overrides last; export `manifestFixture(): RailManifest` by snapshotting it with an empty protected set.

```ts
const step: SnapshotStep = {
  id: '11111111-1111-4111-8111-111111111111', stepId: 'custom:source',
  origin: 'custom', phaseIndex: 2, displayOrder: 10, seq: null,
  status: 'complete', anchorStepId: null, removedAt: null, removedBy: null,
  skip: null, definition: { title: 'Weekly memo', description: 'Draft a memo' },
  effectiveSkill: null,
};
it('copies completed active structure without people or work', () => {
  const saved = snapshotRail([step], 'test', new Set());
  expect(saved.steps).toEqual([{
    key: 't0', catalogStepId: null, seq: null, phaseIndex: 2,
    displayOrder: 1, definition: step.definition, skillKey: null,
  }]);
  expect(saved.steps[0]).not.toHaveProperty('status');
  expect(saved.steps[0]).not.toHaveProperty('id');
});
```

- [ ] **Run the red test.** `npx vitest run tests/rail-templates-snapshot.test.ts`; expect missing-module/export failure before implementation.
- [ ] **Implement explicit projection and deduplication.** Sort only active rows; assign dense order and local keys; allowlist manual and skill contract fields. Resolve selected skills before this function, then deduplicate by canonical reference (`kind` plus identity, version and digest). Do not spread runtime rows or preserve `skillBinding` in the manifest definition. `seq` is identity compatibility, never ordering.

```ts
const active = steps.filter(step => step.removedAt === null)
  .sort((a, b) => a.displayOrder - b.displayOrder);
const projected = active.map((step, index) => ({
  key: `t${index}`,
  catalogStepId: step.origin === 'catalog' ? step.stepId : null,
  seq: step.origin === 'catalog' ? step.seq : null,
  phaseIndex: step.phaseIndex,
  displayOrder: index + 1,
}));
```

Implement definition validation using `parseSkillStepDefinitionV1` and explicit manual title/description validation. Enumerate supported fields, so future recipient/owner fields cannot leak through.

- [ ] **Write materialization tests.** Supply two different UUID maps and assert no shared row/custom keys, same catalog keys/order, and exact imported bindings. Include a custom definition with original v1 overridden by effective v2, plus an unrelated one-off v3 run fixture; output must bind v2 only. Test removed omission and skipped active inclusion.

```ts
it('allocates independent custom identities', () => {
  const manifest = manifestFixture();
  const a = materializeRail(manifest, {t0: '22222222-2222-4222-8222-222222222222'}, {});
  const b = materializeRail(manifest, {t0: '33333333-3333-4333-8333-333333333333'}, {});
  expect(a[0].stepId).toBe(`custom:${a[0].id}`);
  expect(a[0].id).not.toBe(b[0].id);
  expect(a[0].definition).toEqual(b[0].definition);
});
```

- [ ] **Implement materialization.** Missing UUID or imported binding is a hard error. Catalog definitions remain null. Custom skill definitions receive the imported `skillBinding`; manual definitions remain manual. Always write an explicit binding for a copied skill, including catalog steps. A custom manual step rebound to a skill remains a manual definition plus explicit binding; do not silently manufacture an execution input contract.

```ts
export function materializeRail(
  manifest: RailManifest,
  ids: Record<string, string>,
  bindings: Record<string, SkillBinding>,
): SeededTemplateStep[] {
  const used = new Set<string>();
  return manifest.steps.map(step => {
    const id = ids[step.key];
    if (!id || used.has(id)) throw new Error('invalid_step_identity');
    used.add(id);
    const binding = step.skillKey === null ? null : bindings[step.skillKey];
    if (step.skillKey !== null && !binding) throw new Error('missing_skill_import');
    const catalog = step.catalogStepId !== null;
    let definition: SeededTemplateStep['definition'] = null;
    if (!catalog && step.definition !== null) {
      if ('type' in step.definition) {
        if (!binding) throw new Error('missing_skill_import');
        definition = {...step.definition, skillBinding: binding};
      } else {
        definition = {title: step.definition.title, description: step.definition.description};
      }
    }
    return {
      id, stepId: step.catalogStepId ?? `custom:${id}`,
      origin: catalog ? 'catalog' : 'custom', seq: step.seq,
      phaseIndex: step.phaseIndex, displayOrder: step.displayOrder,
      definition, binding: binding ?? null,
    };
  });
}
```

The manifest parser and admission validate UUID syntax, unique local keys, supported census/catalog identities, and catalog phase/seq consistency before this function runs. Materialization never invents a fallback UUID or version.
- [ ] **Run both files and commit.** `npx vitest run tests/rail-templates-snapshot.test.ts tests/rail-templates-materialize.test.ts`; expect all cases green. Stage only this task's source, test and fixture files; commit `feat(rail): define reusable rail snapshots`.

## Task 2: Retain immutable skill packages for a revision (I)

**Files:** Create `platform/apps/skill-bench/src/authoring/rail-templates/{contract,store,service}.ts`, `service.test.ts`, `store.integration.test.ts`, migration `platform/apps/skill-bench/src/authoring/postgres/migrations/004_rail_template_assets.sql`.

**Interfaces:**
- Consume `RetainRequest`, `RetainReceipt` above, `readMountPackage`, `readPackage`, `skillPrefix`, `PostgresPublicationStore.readPublishedPackage`.
- Produce `PostgresRailTemplateStore(pool: AuthoringPool, schema: string)` and `createRailTemplateService(deps: RailTemplateDeps): RailTemplateService`.
- Define `RailTemplateService.retain(revisionId: string, request: RetainRequest): Promise<RetainReceipt>`.
- Define `RailTemplateDeps = {store: PostgresRailTemplateStore; readSource: (companyId:string, projectId:string, reference:SkillReference)=>Promise<{packageBytes:Buffer; sourceDigest:string}>}`. Export `createReadSourcePackage(publications:PostgresPublicationStore, archives:PostgresRailTemplateStore, config:{skillsRoot:string;seedRoot:string}):RailTemplateDeps['readSource']` from `service.ts` as the production adapter factory. Add `PostgresRailTemplateStore.publicationBelongsToCompany(skillId:string,versionId:string,companyId:string):Promise<boolean>` in this task, initially through preparation ownership and extended for imports in task 3. The adapter uses `publications` to read bytes and `archives` to verify ownership; do not add an ownership method to an unspecified store.
- Store methods: `readRevision(revisionId:string,companyId:string): Promise<{requestDigest:string; receipt:RetainReceipt}|null>`, `retainRevision(revisionId:string,companyId:string,requestDigest:string,assets:RetainedAsset[]):Promise<RetainReceipt>`; define `RetainedAsset={key:string;source:SkillReference;packageDigest:string;packageBytes:Buffer}`.

- [ ] **Write the byte-retention test.** Construct a valid minimal package with existing `zipSkillFolder` test helpers, then compare bytes read from the new store, not just invocation counts. Extend `store.integration.test.ts` from the existing loopback-only `authoring/publication/postgres-store.integration.test.ts` setup (`localPostgresUrl`, unique schema, migration, rollback/drop).

```ts
it('retains a revision atomically and rejects a changed retry', async () => {
  const id = randomUUID();
  const companyId = randomUUID();
  const bytes = Buffer.from('immutable bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const reference = {kind:'publication' as const,skillId:randomUUID(),versionId:randomUUID(),digest};
  const assets = [{key:'s0',source:reference,packageDigest:digest,packageBytes:bytes}];
  const first = await store.retainRevision(id, companyId, 'a'.repeat(64), assets);
  expect(await store.retainRevision(id, companyId, 'a'.repeat(64), assets)).toEqual(first);
  await expect(store.retainRevision(id, companyId, 'b'.repeat(64), assets)).rejects.toThrow('idempotency_conflict');
});
```

- [ ] **Run red.** From I `platform/`: `pnpm exec vitest run apps/skill-bench/src/authoring/rail-templates/store.integration.test.ts`. Set `SKILL_BENCH_DATABASE_URL` to the verified loopback test DB. A skipped integration file is not a passing gate.
- [ ] **Add immutable archive schema and store.** Reuse the existing immutable trigger for new archive tables; retention is one transaction, including the receipt and request digest. Validate nonempty unique keys and exact UUID/hash shapes in the service; empty skills produce a valid empty receipt in Conductia without invoking I.

```sql
create table rail_template_archives (
  revision_id uuid primary key,
  company_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null,
  created_at timestamptz not null default now()
);
create table rail_template_assets (
  revision_id uuid not null references rail_template_archives(revision_id),
  asset_key text not null,
  source_reference jsonb not null,
  package_digest text not null check (package_digest ~ '^[0-9a-f]{64}$'),
  package_bytes bytea not null,
  primary key (revision_id, asset_key)
);
```

- [ ] **Implement source resolution.** Publication lookup verifies `project_id` against the source deal and resolves company via its preparation (or import archive after task 3). Mount lookup calls `readMountPackage(config.skillsRoot, config.seedRoot, reference.name, reference.version)`, requires `ok`, and verifies the result's `digest === reference.digest`. Both run `readPackage` and `skillPrefix` validation and calculate `sha256(packageBytes)` for storage. A mount content hash must never be substituted for the ZIP digest.

```ts
const packageDigest = createHash('sha256').update(packageBytes).digest('hex');
const files = readPackage(packageBytes);
skillPrefix(files);
```

Hash the canonical request using existing `canonical-json.ts` conventions. Check replay before reading a source so retained packages remain usable after source bytes are pruned. Race losers reread and compare the request digest; a different digest fails rather than returning the winner's receipt.
- [ ] **Add service tests and run green.** Cover publication wrong project/company, absent version, wrong source digest, corrupt ZIP, seed content-hash versus ZIP-hash distinction, duplicate keys, all-or-nothing multi-asset save, replay after pruning, and a company mismatch on replay. `pnpm exec vitest run apps/skill-bench/src/authoring/rail-templates`.
- [ ] **Commit.** Stage only task files and migration: `feat(skill-bench): retain rail template skill packages`.

## Task 3: Import retained packages as independent publications and expose the seam (I)

**Files:** Modify task 2 `contract.ts`, `store.ts`, `service.ts`, migration 004 (before it ships), `authoring/publication/{mount,store,postgres-publication-store}.ts`, `src/main.ts`; create `rail-templates/routes.ts`, `routes.test.ts`, `contract.test.ts`, `import.integration.test.ts`, `contract/fixtures.json`. Update `authoring/publication/contract/openapi.json` with the new paths and `platform/README.md` with the service capability.

**Interfaces:**
- Consume task 2 retained assets.
- Produce `RailTemplateService.import(requestId:string, request:ImportRequest):Promise<ImportReceipt>` and store `importRevision(requestId:string,request:ImportRequest,requestDigest:string):Promise<ImportReceipt>`.
- `createRailTemplateRoutes(service:RailTemplateService, options:PublicationRoutesOptions):Hono` mounts authenticated routes at `/v1/conductia/rail-templates`.
- `POST /revisions/:revisionId/retain` accepts `RetainRequest`; `POST /imports/:requestId` accepts `ImportRequest`.

- [ ] **Write independence and retry tests.** Two destination requests importing the same asset must return different IDs with identical bytes; a replay must return the same receipt, including after a deliberately lost response. Verify source lineage is untouched and destination lineage returns its imported v1.

```ts
const target = {key:'s0', operationId:randomUUID(), skillId:randomUUID(), versionId:randomUUID()};
const input: ImportRequest = {companyId, revisionId, projectId:randomUUID(), targets:[target]};
const requestId = randomUUID();
const receipt = await service.import(requestId, input);
expect(await service.import(requestId, input)).toEqual(receipt);
const pkg = await publications.readPublishedPackage(target.skillId, target.versionId);
expect(pkg?.projectId).toBe(input.projectId);
expect(pkg?.packageBytes).toEqual(retainedBytes);
expect(await publications.readPublicationLineage(target.skillId, input.projectId))
  .toHaveLength(1);
```

Here `companyId`, `revisionId` and `retainedBytes` are seeded through task 2's real store inside `beforeEach`; `service` and `publications` share that suite's isolated schema.
- [ ] **Run red.** `pnpm exec vitest run apps/skill-bench/src/authoring/rail-templates/import.integration.test.ts`.
- [ ] **Extend publication provenance without fabricating drafts.** Add `rail_template_imports(request_id uuid primary key, company_id uuid not null, revision_id uuid not null references rail_template_archives, project_id uuid not null, request_digest text not null, receipt jsonb not null, created_at timestamptz not null default now())`. Imported publication rows carry `import_request_id`, `import_revision_id` and `import_asset_key`; their `preparation_id` is null. Existing rows keep preparations. Add composite foreign keys to bind the import and asset to the same archive and destination project; both origin arms are exclusive.

```sql
alter table skill_publications alter column preparation_id drop not null;
alter table rail_template_imports
  add constraint rail_template_imports_identity_unique
  unique (request_id, revision_id, project_id);
alter table skill_publications add column import_request_id uuid;
alter table skill_publications add column import_revision_id uuid;
alter table skill_publications add column import_asset_key text;
alter table skill_publications add constraint skill_publication_origin_check check (
  (preparation_id is not null and import_request_id is null
    and import_revision_id is null and import_asset_key is null)
  or (preparation_id is null and import_request_id is not null
    and import_revision_id is not null and import_asset_key is not null)
);
alter table skill_publications add constraint skill_publication_import_fk
  foreign key (import_request_id, import_revision_id, project_id)
  references rail_template_imports(request_id, revision_id, project_id);
alter table skill_publications add constraint skill_publication_import_asset_fk
  foreign key (import_revision_id, import_asset_key)
  references rail_template_assets(revision_id, asset_key);
```

Keep `PublicationInput` for authored writes unchanged. Widen only the read-side `StoredPublication.preparationId` / SQL row to `string|null`, add import origin fields where needed, and update consumers to narrow before preparation access. Normal publication replay keeps its original contract. The origin CHECK makes the import FK columns nonnull together; the two FKs enforce project and archive membership. Verify the importing company matches the archive before writing its receipt.
- [ ] **Implement atomic batch import.** Lock the archive/read verified bytes, require one target per archived asset, validate distinct destination operation/skill/version IDs, insert all publications and the stored receipt in one transaction. Use the archive package digest unchanged. Existing operation-ID conflicts outside this request reject the whole import. Do not clone older versions. Add immutable update/delete protection to import receipts. Query company ownership through preparation for authored packages and the import archive for imported packages, so a copied deal can itself be saved later.
- [ ] **Mount service routes.** Reuse `publicationAuthGuard`, existing publication token/config/pool, and `createPublicationRoutes` logging/error conventions. Extend `openPublicationRoutes` to receive mount roots from `main.ts` and compose both route apps at `/`; preserve `composeSkillBenchApp`. When unconfigured, both new prefixes return 503. Update all call sites, including `authoring/publication/e2e-server-entry.ts`, and mount tests. Use 401 for missing service auth, 404 for scoped misses, 409 for conflicting replay/unavailable source, 422 for invalid body, 503 when storage is unconfigured.
- [ ] **Write wire fixtures and parity tests.** `contract/fixtures.json` contains one publication retain, one seed-mount retain, one import, corresponding receipts, and invalid extra-field/bad-digest cases. Commit the identical fixture under C `tests/fixtures/rail-template-provider.json` in task 5. Both suites parse the fixtures and assert rejection outcomes; only service credentials can access these routes.
- [ ] **Run focused tests, typecheck and commit.** From `platform/`: `pnpm exec vitest run apps/skill-bench/src/authoring/rail-templates apps/skill-bench/src/authoring/publication`; `pnpm --filter @ignatious/skill-bench typecheck`. Commit: `feat(skill-bench): import retained rail skills into new projects`.

## Task 4: Persist templates, immutable revisions and save commands (C)

**Files:** Create `supabase/migrations/20260921100000_rail_templates.sql`, `supabase/tests/rail_templates.sql`, `tests/db/rail-templates.test.ts`, `src/lib/railTemplates/repository.ts`. Modify `src/lib/constants/{tables,audit}.ts`, `src/lib/flags/keys.ts`. This migration also owns `deal_skill_imports`, whose first writer arrives in task 6.

**Interfaces:**
- `rail_template_admit_save(p_actor_id uuid,p_company_id uuid,p_command jsonb,p_manifest jsonb,p_source_fingerprint text) returns jsonb` freezes a save and reserves its revision UUID.
- `rail_template_finalize_save(p_actor_id uuid,p_request_id uuid,p_receipt jsonb) returns jsonb` atomically publishes a revision and returns `TemplateSummary`.
- `rail_template_read_source(p_actor_id uuid,p_deal_id uuid) returns jsonb` returns coherent structural rows, binding rows and `sourceFingerprint`; fingerprints exclude runtime work/status and include removal, order, definitions and selected bindings.
- `readSave(admin:SupabaseClient,actorId:string,requestId:string):Promise<SaveAdmission|null>`, `admitSave(admin:SupabaseClient,actorId:string,companyId:string,command:SaveRailCommand,manifest:RailManifest,sourceFingerprint:string):Promise<SaveAdmission>`, and `finalizeSave(admin:SupabaseClient,actorId:string,requestId:string,receipt:RetainReceipt):Promise<TemplateSummary>` in `repository.ts` wrap those RPCs. Define/export `SaveAdmission={requestId:string; revisionId:string; companyId:string; command:SaveRailCommand; manifest:RailManifest; state:'preparing'|'ready'|'conflict'; receipt:TemplateSummary|null}` in `types.ts` for server/client type-only consumers.

- [ ] **Write SQL probes before migration.** Reuse `supabase/tests/project_rail.sql` transaction fixtures, establishing a bank/director/deal and full seeded protected rail. The probe saves A, prepares B, verifies A still current, finalizes B, verifies a stale replacement is refused. Create a second user with create permission but no source membership and a second bank for negative cases. Add a Vitest wrapper matching `tests/db/project-rail.test.ts` pointing at `supabase/tests/rail_templates.sql`.

```sql
-- After fixture admission of revision B, before finalization:
do $$ begin
  if (select current_revision_id from rail_templates where id = current_setting('test.template_id')::uuid)
     <> current_setting('test.revision_a')::uuid then
    raise exception 'preparing replacement changed the visible template';
  end if;
end $$;
```

The fixture sets those GUCs with `set_config` immediately after its RPC results. Probe with SQL assertions and exception blocks, not snapshots of SQL text.
- [ ] **Run red.** `RUN_DB_TESTS=1 npx vitest run tests/db/rail-templates.test.ts` with loopback `DATABASE_URL`; expect missing table/function before applying migration.
- [ ] **Add schema.** `rail_templates`: id, tenant_id, company_id, name, normalized_name, current_revision_id nullable, created_by/at, updated_at; unique index `(company_id,normalized_name) where current_revision_id is not null`, with SQL normalization `lower(btrim(regexp_replace(name,'\s+',' ','g')))`. Hidden preparations do not reserve names forever. `rail_template_revisions`: id, template_id, actor_id, request_id unique, request_digest, command jsonb, source_deal_id, source_fingerprint, expected_revision_id nullable, description, manifest, state (`preparing`,`ready`,`conflict`), provider_receipt nullable, created_at. Composite FK ensures a current revision belongs to its template. A trigger forbids changing an admitted command/manifest and forbids changes to ready revisions; only state/receipt transition on a preparing row is allowed. `rail_templates` may only point to a ready revision.

Also create `deal_skill_imports`: skill_id UUID PK, deal_id UUID FK, version_id UUID unique, digest text, name text, capability_contract jsonb, imported_by UUID, template_revision_id UUID FK, source_asset_key text, created_at timestamptz. Require nonnull columns, valid digest, valid capability shape and same-bank revision/deal ownership. Apply RLS/service-only access and immutability. This lets task 5 implement metadata reads before task 6 writes imports.
- [ ] **Implement transaction rules.** Source read and admission take the same `deals FOR UPDATE` lock used by rail edits; admission rechecks fingerprint. Check new-name conflicts at admission and enforce them again through the visible-name unique index at finalization. An abandoned hidden preparation does not block a later save of that name. Replacement locks the template, validates company and expected revision, and leaves its pointer unchanged until finalize. Finalize validates exact receipt revision/key count/digests, rechecks source access and structure authority, and uses compare-and-swap on expected revision. Replay returns stored success before stale-pointer checking. Competing replacements can prepare concurrently, but only one can finalize from a given expected revision. Record `rail.template_created`/`rail.template_replaced` only on success.

```sql
update rail_templates
set current_revision_id = v_revision.id, updated_at = now()
where id = v_revision.template_id
  and current_revision_id is not distinct from v_revision.expected_revision_id;
if not found then
  raise exception 'stale_template' using errcode = 'P0001';
end if;
```

Validate source bank against actor/company and target template; bank is derived, never trusted from browser JSON. Both DB and HTTP use the existing company permission model, including its director/admin and flag behavior. All tables enable RLS with no browser table grants; all RPCs revoke PUBLIC/anon/authenticated and grant service_role only. Company-scoped HTTP projections provide the read path. Audit detail contains IDs/counts, not manifests or package contents.
- [ ] **Register `rail_templates` flag and constants.** Flag description: “Save and replace named company rails and select them during Gate 0.” Default remains off. Add audit actions to the database action check by preserving the full latest list; do not replace it with just the new actions.
- [ ] **Run probes and commit.** Include name normalization, unsupported manifests, missing protected steps, immutable ready revision, actor mismatch on replay, repeated save, cross-bank replacement and execute-grant probes. Commit: `feat(rail): persist named company rail templates`.

## Task 5: Authorize, save, replace, list and resume through Conductia (C)

**Files:** Create `src/lib/railTemplates/{access,readSource,providerClient,service}.ts`, `src/lib/skillRun/publicationMetadata.ts`, `tests/skill-run-imported-metadata.test.ts`, `src/app/api/v1/rail-templates/route.ts`, `src/app/api/v1/rail-templates/[templateId]/route.ts`, `src/app/api/v1/rail-templates/saves/[requestId]/route.ts`, `tests/rail-template-provider.test.ts`, `tests/rail-template-save.test.ts`, `tests/api/rail-templates.test.ts`, `tests/fixtures/rail-template-provider.json`.

**Interfaces:**
- `requireTemplateUse(admin:SupabaseClient,actorId:string):Promise<{companyId:string;tenantId:string}>`; `requireTemplateSave(admin:SupabaseClient,actorId:string,sourceDealId:string):Promise<{companyId:string;tenantId:string;dealId:string}>`; throw a typed `TemplateError` with `code`, `status`, `retryable` fields (define/export in `types.ts`). Use `hasCompanyPermissionChecked`, `classifyInternalUser`, `userCanAccessDeal`; reuse `requireSkillAuthoringAccess`'s deal-bank scoping pattern.
- `readSourceSnapshot(admin:SupabaseClient,actorId:string,dealId:string):Promise<{manifest:RailManifest;sourceFingerprint:string}>` consumes the task 4 RPC and task 1 projection.
- `retainTemplateSkills(revisionId:string,request:RetainRequest):Promise<RetainReceipt>`, `importTemplateSkills(requestId:string,request:ImportRequest):Promise<ImportReceipt>` in `providerClient.ts`, using existing publication config/token/timeout.
- `saveRailTemplate(admin:SupabaseClient,actorId:string,command:SaveRailCommand):Promise<TemplateSummary>`, `resumeRailSave(admin:SupabaseClient,actorId:string,requestId:string):Promise<TemplateSummary>`.
- Define/export `PublicationMetadata={name:string;contract:CapabilityContract;actorId:string;createdAt:string}` from `publicationMetadata.ts`. `readPublicationMetadata(admin:SupabaseClient,dealId:string,reference:Extract<SkillReference,{kind:'publication'}>):Promise<PublicationMetadata|null>` and `readPublicationMetadataBatch(admin:SupabaseClient,dealId:string,references:Array<Extract<SkillReference,{kind:'publication'}>>):Promise<Map<string,PublicationMetadata>>` resolve ordinary publication operations first, then imports, matching deal, skill, version and digest in both paths. Batch results key by version ID. The single reader delegates to the batch reader.
- `GET /api/v1/rail-templates` returns `{templates:TemplateSummary[]}`; `?purpose=save` requires structure authority and allows the save chooser even if the actor lacks deal-create authority. Default purpose requires template-use authority.
- `GET /api/v1/rail-templates/:templateId` returns `TemplatePreview`, current revision only. `POST /api/v1/rail-templates` takes `SaveRailCommand`. `GET /saves/:requestId` returns actor-scoped `{command,state,receipt}`; `POST /saves/:requestId` resumes the frozen command.

- [ ] **Write authorization tests.** Follow `tests/api/rail-writes.test.ts` Supabase mock conventions. A same-bank deal creator with no source membership can list/preview; a creator without structure permission cannot save; an internal structure editor with source access can replace a template created by another editor. A different bank, external user or unreadable permission lookup cannot access it. The list/preview must omit source IDs and unready revisions.

Start with this actual HTTP-boundary test in `tests/api/rail-templates.test.ts`. Add the authenticated company/permission cases using the existing Supabase fixtures; assert the route's returned JSON omits source IDs, rather than constructing the expected projection as the test input.

```ts
import {expect, it, vi} from 'vitest';
vi.mock('@/lib/flags/requireFlag', () => ({requireFlag: async () => null}));
vi.mock('@/lib/api/v1/http', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: false,
    response: Response.json({error: 'Unauthorized'}, {status: 401}),
  }),
}));

it('requires an authenticated user before listing company rails', async () => {
  const {GET} = await import('@/app/api/v1/rail-templates/route');
  const response = await GET(new Request('http://localhost/api/v1/rail-templates'));
  expect(response.status).toBe(401);
});
```
- [ ] **Run red.** `npx vitest run tests/api/rail-templates.test.ts tests/rail-template-save.test.ts`.
- [ ] **Implement the metadata reader and test both origins.** Use task 4's import table and existing publication operations. Reject wrong-deal or wrong-digest rows; return null for an unknown version; never fall back to another version's contract. Test an imported v1 and an authored v2 with distinct contracts/actors. Missing required publication metadata makes save fail with `skill_unavailable`.
- [ ] **Implement coherent capture.** Read source rows and bindings in the task 4 RPC. Resolve explicit Part E binding first, custom definition second, catalog mount third through `resolveStepBinding`/`resolveMountTripleForStep`. Load the current version's capability contract through the metadata reader. For catalog mounts use the catalog description and `io.inputs`/`io.outputs`, joining each `what` with a newline; missing IO produces the existing step description for purpose and the literal labels “Banker-provided text input” / “Skill-generated result” for the other two fields. Resolve a given catalog tag once per save. A failed catalog service read is an error, not evidence that the step has no skill.
- [ ] **Implement bounded save/resume.** Read an existing admission by actor/request before reading the source; compare normalized command digest for POST replay. If absent, authenticate source, capture, admit with the fingerprint, and retain the frozen skills. Finalize only with a complete validated provider receipt. For zero skills use `{revisionId,assets:[]}` locally. `resumeRailSave` performs the same retention/finalization on the stored admission with fresh authorization; it does not accept replacement content.

```ts
const request: RetainRequest = {
  companyId: admission.companyId,
  sourceProjectId: admission.command.sourceDealId,
  skills: admission.manifest.skills.map(({key, source}) => ({key, source})),
};
const receipt = request.skills.length === 0
  ? {revisionId: admission.revisionId, assets: []}
  : await retainTemplateSkills(admission.revisionId, request);
return finalizeSave(admin, actorId, admission.requestId, receipt);
```

Canonicalize `sourceDealId` to its UUID before persistence. Limit names/descriptions per spec and normalize whitespace identically to SQL. Never take a manifest, company ID, provider reference or digest from the browser save command. Returned errors: 409 name/stale/source changed/replay conflict, 422 invalid command, 403 forbidden, 404 scoped miss, 503 provider timeout/unconfigured with `retryable:true`. Invalid provider receipt fails closed with 502 and `retryable:true`; add status 502 to the `provider_unavailable` mapping. Keep the previous template current on every unsuccessful replacement.
- [ ] **Implement list and preview.** Query current ready revisions in the authenticated company ordered by normalized name. Compute titles from stored custom definitions and catalog keys; enforce manifest schema. Require the three rollout flags server-side for new template routes and `skill_authoring` for skill-bearing save. Preview is read-only and does not expose opaque skill IDs. A template containing unavailable code/schema is rejected explicitly.
- [ ] **Test replay and wire parity.** Copy task 3's fixture verbatim. Tests exercise malformed/extra receipt assets, network loss after provider commit, concurrent source edits before admission, changed source after admission, access revoked before finalize, save of a copied deal, and no provider dependency for manual-only rail. Verify a successful replay produces one audit row.
- [ ] **Run focused tests and commit.** `npx vitest run tests/api/rail-templates.test.ts tests/rail-template-save.test.ts tests/rail-template-provider.test.ts`; commit `feat(rail): expose template save replace and browse APIs`.

## Task 6: Create deals transactionally from a captured template revision (C)

**Files:** Create `supabase/migrations/20260921110000_create_deal_from_template.sql`, `src/lib/railTemplates/{createDeal,creationRepository}.ts`, `src/lib/deals/createDealInput.ts`, `src/app/api/v1/deals/template-creations/[requestId]/route.ts`, `tests/rail-template-create.test.ts`, `tests/api/rail-template-create.test.ts`, `supabase/tests/rail_template_creation.sql`, `tests/db/rail-template-creation.test.ts`. Modify `src/app/api/v1/deals/route.ts`, `src/lib/constants/{tables,audit}.ts`, `src/lib/rail/dealRail.ts` only if shared seed typing is required.

**Interfaces:**
- Extract/export existing `Gate0Member`, `ConflictsAttestation`, `DealCreateBody` into `createDealInput.ts` without weakening validation; extend `DealCreateBody` with optional `requestId:string` and `railTemplate:TemplateSelection`.
- Export `ValidatedGate0Input={tenantId:string;actorId:string;bankId:string;codename:string;targetName:string|null;targetCompanyId:string|null;codenameTheme:string|null;members:Array<{userId:string;dealRole:string}>;screening:{verdict:string;reasons:string[]};conflicts:{approvedBy:string;approvedOn:string}}`. Existing validation fills this type before either creation path.
- `createDealFromTemplate(admin:SupabaseClient,input:ValidatedGate0Input,selection:TemplateSelection,requestId:string):Promise<Gate0CreateReceipt>`; define `Gate0CreateReceipt` to match existing success response: `{deal:{id:string;code:string};memberships:unknown;notified:Array<{userId:string;at:string}>;screening:ValidatedGate0Input['screening']}`.
- `CreationAdmission={requestId:string;actorId:string;companyId:string;dealId:string;revisionId:string;manifest:RailManifest;input:ValidatedGate0Input;stepIds:Record<string,string>;targets:ImportTarget[];state:'preparing'|'ready';receipt:Gate0CreateReceipt|null}`.
- Repository functions: `admitCreation(admin:SupabaseClient,input:ValidatedGate0Input,selection:TemplateSelection,requestId:string):Promise<CreationAdmission>`, `readCreation(admin:SupabaseClient,actorId:string,requestId:string):Promise<CreationAdmission|null>`, `finalizeCreation(admin:SupabaseClient,actorId:string,requestId:string,imports:ImportReceipt):Promise<Gate0CreateReceipt>`.
- Export `CreationAdmission` and `Gate0CreateReceipt` from `types.ts`, using a type-only import of `ValidatedGate0Input` from `src/lib/deals/createDealInput.ts`. Browser modules must not import server repository modules for runtime values.
- `GET /api/v1/deals/template-creations/:requestId` returns the actor's frozen input/selection and state; `POST` resumes with no body. Do not expose admissions through the ordinary deal list.

- [ ] **Write DB tests for atomicity, initialization and replacement.** Extend real Gate 0 fixtures to include a custom step with null seq before the first catalog execution step. Verify exactly one current step and a matching `current_deal_step_id`; all other execution steps are pending regardless of source progress. Create D1 from revision A; replace template with B; create D2 from B; assert D1 rows/bindings unchanged. Admit D3 from A before replacement, then finalize after replacement and assert A is used.

```sql
-- Fixture stores test.created_deal after finalize RPC.
do $$ declare n int; begin
  select count(*) into n from deal_steps
  where deal_id=current_setting('test.created_deal')::uuid and status='current';
  if n <> 1 then raise exception 'template creation must have one current step'; end if;
  if exists (select 1 from deal_steps where deal_id=current_setting('test.created_deal')::uuid
             and (assigned_to is not null or coalesce(work,'{}'::jsonb) <> '{}'::jsonb)) then
    raise exception 'source people or work copied';
  end if;
end $$;
```

- [ ] **Run red.** `RUN_DB_TESTS=1 npx vitest run tests/db/rail-template-creation.test.ts` with loopback DB.
- [ ] **Add creation table and provenance columns.** `rail_template_creations`: request_id PK, actor_id, tenant_id, company_id, revision_id FK, reserved_deal_id unique, request_digest, input jsonb, step_ids jsonb, targets jsonb, state preparing/ready, receipt nullable, created_at. Add nullable `deals.rail_template_revision_id` and `rail_template_name` snapshot. Use `deal_skill_imports` from task 4. RLS/service-only rules match task 4. Revisions used by creations or imports must remain retained.
- [ ] **Add admission RPC.** `rail_template_admit_creation(p_actor_id uuid,p_request_id uuid,p_selection jsonb,p_input jsonb) returns jsonb`: recheck create authority, selected company and current revision; lock the template while admitting. Freeze input and manifest revision, allocate deal UUID, row UUIDs and import targets once. A stale picker is rejected only for a new request; an existing matching request resumes its captured revision. Request digest includes normalized Gate 0 content and template selection. Named people supplied through the new Gate 0 team are allowed; source assignments never enter this input.
- [ ] **Adapt the Gate 0 RPC in one new migration.** Preserve the existing public signature as a wrapper for standard creation. Extract its current body to service-only `create_deal_gate0_core` with the same arguments plus `p_reserved_deal_id uuid`, `p_template_seed jsonb`, `p_template_revision_id uuid`, `p_template_name text` (no overload ambiguity). The wrapper passes nulls for these four arguments; only the template finalizer passes them. Keep all existing checks, notifications, membership and audit writes in the core. Allocate the passed deal ID only on the template path; standard calls retain the original allocation behavior.

```sql
-- Template branch of step initialization, before inserting steps:
select value->>'stepId' into v_entry_step_id
from jsonb_array_elements(p_template_seed)
where not (value->>'stepId' = any(v_gate0_step_ids))
order by (value->>'displayOrder')::int
limit 1;
if v_entry_step_id is null then
  raise exception 'template_has_no_execution_step' using errcode='P0001';
end if;
```

Declare `v_entry_step_id text` and `v_gate0_step_ids text[] := array['p1-s7','p1-s6','g0-notify']` using the exact IDs from `src/lib/rail/gate0.ts`, and test parity. Derive the initial deal phase from that selected seed row, not from the baseline wizard hint. Status is `current` for this key, `skipped_entry` for the fresh Gate 0 receipt steps (existing convention), otherwise `pending`. Insert provided row IDs, definitions, nullable seq, origins, phases and order; anchors null, work `{}`, assignments null. Use current row UUID as authority. Legacy `entry_step_seq/current_step_seq` may use the first post-Gate-0 catalog seq as a compatibility hint for a custom current step; no template consumer may use that hint as ordering. Assert rail rendering/navigation uses the UUID through `useProjectRail` and that `GET /api/v1/deals` returns the new custom step's title and nullable seq in its `currentStep` projection.
- [ ] **Implement finalization and orchestration.** `rail_template_finalize_creation(p_actor_id uuid,p_request_id uuid,p_imports jsonb,p_seed jsonb) returns jsonb` locks the admission, returns stored receipt if ready, rechecks create authority, validates exact receipt project/keys/IDs/digests against reserved targets and retained asset receipts, invokes core, inserts bindings/import metadata/provenance and saves receipt in the same transaction. Bound rows use `source='template'`; extend Part E's source CHECK rather than labelling copies as selections. Add `rail.template_applied` audit. A missing receipt asset aborts the whole transaction.

```ts
const imports: ImportReceipt = admission.targets.length === 0
  ? {requestId, projectId:admission.dealId, skills:[]}
  : await importTemplateSkills(requestId, {
      companyId:admission.companyId, revisionId:admission.revisionId,
      projectId:admission.dealId, targets:admission.targets,
    });
return finalizeCreation(admin, input.actorId, requestId, imports);
```

`finalizeCreation` reads the admission and calls task 1's `materializeRail` with the reserved map and receipt bindings, then supplies the trusted rows as `p_seed`. Validate seed IDs/keys/order/definitions against the admitted manifest and imports inside the finalizer. Seeds are never accepted from HTTP.
- [ ] **Integrate the HTTP path and resume.** Standard POST without `railTemplate` retains its existing entryStepSeq behavior. Template POST requires UUID requestId, resolves current template and ignores the wizard's legacy baseline entry hint in favor of template order. Keep mask checking, selected target identity precedence and screening. After successful finalize, run existing best-effort data-room provisioning; it must be safe to repeat. Resume revalidates stored codename/target/members/attestation before import/finalization; a revoked membership or changed target causing mask failure must fail, leaving no visible partial deal. `GET` requires exact actor and company, never merely possession of a request ID.
- [ ] **Test recovery and regression.** Inject provider success followed by lost response; retry yields one deal, one set of bindings and one notification fan-out. Inject finalizer failure after step insertion; no deal/steps/imports survive. A ready replay returns the saved success receipt even if the template has since changed. Test stale selection, changed payload with same requestId, blank/custom seq, flag disabled, skill flag disabled, source inaccessible to creator, and baseline unchanged. Extend grant tests to ensure core/finalizer cannot be called as authenticated/anon.
- [ ] **Run focused API/DB tests and commit.** `npx vitest run tests/rail-template-create.test.ts tests/api/rail-template-create.test.ts tests/gate0-wizard-api.test.ts`; run both database probe files with `RUN_DB_TESTS=1`. Commit `feat(deals): create independent deals from rail templates`.

## Task 7: Integrate copied skills with version history and enhancement (C)

**Files:** Modify `src/lib/skillRun/{publicationMetadata,versions}.ts`, `tests/skill-run-imported-metadata.test.ts`, `src/lib/skillPublication/{comparisonSet,comparisonTargets}.ts`, `src/lib/railTemplates/readSource.ts`, `tests/skill-run-versions.test.ts`, `tests/skill-publication-comparison-set.test.ts`, `tests/skill-publication-comparison-set-integrity.test.ts`, `tests/integration/skill-version-lineage.test.ts`.

**Interfaces:**
- Consume task 5's `PublicationMetadata`, `readPublicationMetadata(admin,dealId,reference)` and `readPublicationMetadataBatch(admin,dealId,references)` with their defined signatures. No source deal access is required for imported metadata.
- Produce integrations into `readStepVersions` and `buildComparisonSet` without changing their public signatures. `readSourceSnapshot` already uses the reader; extend its tests to cover destination enhancement and resaving.

- [ ] **Write metadata and duplicate-detection failures.** Seed one imported v1 and one later authored v2 under the same destination skill identity. Current v1 gets its import contract and importing actor; v2 gets its authored contract and author. Both appear in destination lineage; source versions do not. Add a copied custom step as a duplicate target before any destination authoring operation exists.

```ts
it('treats an imported skill as a duplicate target without an authoring draft', () => {
  const contract = {purpose:'Weekly memo', expectedInput:'Deal update', expectedOutput:'Memo'};
  const metadata: PublicationMetadata = {
    name:'Weekly memo', contract, actorId:'importer', createdAt:'2026-09-21T00:00:00Z',
  };
  const target = importedComparisonTarget('step-row', false, metadata, {
    skillId:'skill', versionId:'version', digest:'a'.repeat(64),
  });
  expect(target.state).toBe('active');
  expect(target.capabilityContract).toEqual(contract);
  expect(target.candidate).toBeNull();
});
```

Define/export `importedComparisonTarget(stepId:string,removed:boolean,metadata:PublicationMetadata,binding:SkillBinding):ComparisonTarget` in `comparisonTargets.ts`; it returns targetId, active/removed state, metadata name/contract, binding and null candidate. Keep this name for the new import projection and preserve the existing authored projection unless the task's tests require shared behavior.
- [ ] **Run red.** `npx vitest run tests/skill-run-imported-metadata.test.ts`.
- [ ] **Implement destination-scoped metadata reads.** Update `readAncestorContract` to accept dealId and use the resolver. Resolve authors for lineage with a batched operation/import lookup. Preserve original actor attribution for authored versions, label imported v1 with importing actor and time. Do not fabricate a publication operation, candidate, draft or run.
- [ ] **Update duplicate comparison and resaving.** Build current step targets from effective bindings, not the original definition or arbitrary latest operation per step. Include catalog steps explicitly rebound to project publications and imported custom/manual steps. Preserve admitted-but-unattached authoring targets and removed targets. A missing required contract is an integrity error. Read effective bindings in the same deal scope and preserve the Part E ancestor identity exemption.

```ts
export function importedComparisonTarget(
  stepId: string,
  removed: boolean,
  metadata: PublicationMetadata,
  binding: SkillBinding,
): ComparisonTarget {
  return {
    targetId: stepId,
    state: removed ? 'removed' : 'active',
    displayName: metadata.name,
    capabilityContract: metadata.contract,
    skillBinding: binding,
    candidate: null,
  };
}
```

Keep the metadata query in `comparisonSet.ts` and this projection pure. Query both active and removed steps; the normal runnable-step resolver rejects removed rows, so extract their stored binding directly for duplicate comparison without making them runnable.
- [ ] **Test enhancement end to end at the service boundary.** Use the existing fake authoring generator/provider fixture: copied v1 is a real backend publication, enhancement resolves its bytes, overlays a change, publishes v2 with the same destination skill ID, and rebinds only the destination step. Assert source skill count/digest unchanged, duplicate check recognizes the ancestor, catalog comparison options remain available for catalog steps. Test save of that destination captures its currently selected v1 or v2 correctly.
- [ ] **Run focused metadata/comparison/version tests and commit.** `npx vitest run tests/skill-run-imported-metadata.test.ts tests/rail-template-save.test.ts tests/skill-run-versions.test.ts tests/skill-publication-comparison-set.test.ts tests/skill-publication-comparison-set-integrity.test.ts`; run `npm run test:integration -- tests/integration/skill-version-lineage.test.ts`. Commit `feat(skills): integrate imported rail skills with enhancement`.

## Task 8: Save or replace a rail from the existing deal UI (C)

**Files:** Create `src/components/rail/SaveRailDialog.tsx`, `src/lib/railTemplates/{client,useSaveRail}.ts`, `tests/save-rail-dialog.test.tsx`; modify `src/components/rail/DealRail.tsx`.

**Interfaces:**
- `SaveRailDialog({dealId,onClose,onSaved}:{dealId:string;onClose:()=>void;onSaved:(summary:TemplateSummary)=>void})`.
- `client.ts`: `listRailTemplates(purpose?:'use'|'save'):Promise<TemplateSummary[]>`, `readRailTemplate(id:string):Promise<TemplatePreview>`, `saveRail(command:SaveRailCommand):Promise<TemplateSummary>`, `readRailSave(requestId:string):Promise<{command:SaveRailCommand;state:SaveAdmission['state'];receipt:TemplateSummary|null}>`, `resumeRailSave(requestId:string):Promise<TemplateSummary>` (client import name aliases the server service only in server modules).
- `useSaveRail(dealId:string)` returns `{state:'editing'|'saving'|'retryable'|'saved'|'conflict';error:string|null;save:(command:SaveRailCommand)=>Promise<void>;resume:()=>Promise<void>;summary:TemplateSummary|null}`. Declare a distinct client hook type, not an untyped state object.

- [ ] **Write interaction tests.** Use Testing Library and fetch fixtures, existing modal primitives, no new dependency. Test required trimmed name; new mode; replacement list; selected current revision; disabled submit while saving; error preservation; success close; company sharing text; named people disclosure.

```tsx
it('explains replacement and preserves existing projects', async () => {
  render(<SaveRailDialog dealId="deal-1" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('radio', {name:'Replace existing'}));
  expect(await screen.findByText('Existing projects keep their own copies.')).toBeVisible();
  expect(screen.getByRole('button', {name:'Replace rail'})).toBeDisabled();
});
```

- [ ] **Run red.** `npx vitest run tests/save-rail-dialog.test.tsx`.
- [ ] **Build the dialog and client.** Create-new form has name and description; replace has saved template selector and description, retaining the chosen name. Show active step count from the current rail and number of known skill-backed steps as a preview; the server's save result is authoritative. Use labelled controls, focus trap, Escape/back dismissal, inline failure and accessible busy status. Reuse existing Button/dialog styles in the project rather than importing an unrelated design system.

```tsx
<p>Shares step descriptions and selected skill instructions with your company. People, deal work and results are not copied.</p>
<p>Existing projects keep their own copies.</p>
```

- [ ] **Implement retry identity.** Generate `crypto.randomUUID()` once per submitted command. Store its ID in session storage under `rail-template-save:<actorId>:<dealId>`; use existing current-user context for actorId. Keep the admitted command frozen while retrying. On reopen/reload read it from the server, render its original values, and offer Retry. A 409 stale template restores edit mode after explicitly clearing the pending ID, refreshes choices, and retains entered description. A successful response clears the pending ID. Do not regenerate a request ID on a transport failure.
- [ ] **Integrate into DealRail.** Show action only on real structured deals with structure permission and all rollout flags. Keep hooks above existing early returns. Template list/load failure does not affect the source rail. Unsaved authoring drafts are not part of the rail; the dialog can state “Only published steps are included.” No implicit publication is performed.
- [ ] **Test reload/resume and commit.** Include server rejection despite visible permission, name conflict, source-changed capture and source authority loss. `npx vitest run tests/save-rail-dialog.test.tsx tests/rail/dealRail.test.tsx`; commit `feat(rail): add save and replace template dialog`.

## Task 9: Select a template in Gate 0 and recover interrupted creation (C)

**Files:** Create `src/components/wizard/RailTemplatePicker.tsx`, `src/lib/railTemplates/useRailTemplates.ts`, `tests/rail-template-picker.test.tsx`; modify `src/components/wizard/Gate0Wizard.tsx`, `src/lib/railTemplates/client.ts`, `tests/gate0-wizard-api.test.tsx`, `tests/gate0-invite-queue.test.ts`.

**Interfaces:**
- `RailTemplatePicker({value,onChange}:{value:TemplateSelection|null;onChange:(selection:TemplateSelection|null)=>void})`; null means standard baseline.
- `useRailTemplates():{templates:TemplateSummary[];loading:boolean;error:string|null;reload:()=>void}`.
- Client `readTemplateCreation(requestId:string):Promise<CreationResumeView>` exposes actor-owned input/state only (omit backend targets and full manifest from HTTP). Define `CreationResumeView={requestId:string;input:ValidatedGate0Input;selection:TemplateSelection;state:'preparing'|'ready';receipt:Gate0CreateReceipt|null}`. `resumeTemplateCreation(requestId:string):Promise<Gate0CreateReceipt>` calls POST resume.

- [ ] **Write default/selection tests.** Baseline remains selected and existing requests contain no template fields. Selecting a template sends its ID and captured revision, plus one requestId. Server failure must retain the selection; list failure displays an error and Retry while still allowing the explicitly selected standard rail.

```tsx
it('keeps the standard rail as the explicit initial choice', async () => {
  render(<RailTemplatePicker value={null} onChange={vi.fn()} />);
  expect(screen.getByRole('combobox', {name:'Rail'})).toHaveValue('standard');
});
```

- [ ] **Run red.** `npx vitest run tests/rail-template-picker.test.tsx tests/gate0-wizard-api.test.tsx`.
- [ ] **Add picker and preview.** Place it in the existing initial deal-setup/codename stage, before final notification confirmation. Do not restore the hidden lifecycle-entry step. Display template name, optional description and ordered phase/step preview from the server. On replacement since preview, HTTP 409 shows “This saved rail changed. Review the updated rail and try again.” Require explicit reselection/review; never silently create from a different revision.

```ts
const templateFields = selectedTemplate === null ? {} : {
  requestId: templateRequestId,
  railTemplate: selectedTemplate,
};
const body = {codename:codename.trim(), codenameTheme,
  targetCompanyId:selectedCompany.id, entryStepSeq:postGate0EntrySeq,
  members, conflictsAttestation, ...templateFields};
```

- [ ] **Preserve Gate 0 side effects.** Keep email-domain preflight and queued invites before/after create in their existing order. Only trigger the existing post-create invite flow on a successful create/resume receipt; never on a retryable response. Newly selected team members are legitimate destination data, unrelated to cleared source assignments. Ensure source recipients, memberships, documents and tokens are never in template payloads.
- [ ] **Recover creation across reload.** Persist only requestId under `rail-template-create:<actorId>` on first template submission. On wizard reopen, GET the actor-scoped command and show a Resume action for the frozen input. While an admitted request is pending, edits require explicitly abandoning it and starting a new command; a timeout alone does not abandon it. On successful resume, route to the saved destination and stash the normal receipt. Clear the pending ID only after the success is handled. Queued invitation state remains under the existing wizard semantics; a reload must not invent recipients or resend completed invites. If the invitation queue is no longer present, show the created deal and direct the user to Team for any remaining invitations.
- [ ] **Run regression tests and commit.** Test stale selection before admission, replacement after admission, 503 retry with same ID, reload resume, ready receipt replay, normal baseline payload, flag-off controls and existing invite sequencing. `npx vitest run tests/rail-template-picker.test.tsx tests/gate0-wizard-api.test.tsx tests/gate0-invite-queue.test.ts`; commit `feat(gate0): select and resume saved rail creation`.

## Task 10: Prove the cross-repository journey and document rollout (C + I)

**Files:** Create C `e2e/journeys/rail-templates.spec.ts`, `e2e/support/railTemplateFixture.ts`; modify C `e2e/support/ignatiousPublicationStub.ts`, `docs/03-engineering/feature-flags.md`, `docs/02-product/deal-lifecycle-rails.md`; extend I `platform/apps/skill-bench/src/authoring/rail-templates/import.integration.test.ts` and `platform/README.md`.

**Interfaces:** `seedTemplateJourney():Promise<{source:{id:string;code:string};secondCreatorStorageState:string}>` in the new fixture creates a source deal with the baseline, one removed non-protected step, one manual step, a custom skill with selected v2 and last one-off run v3, and two company users. Source director and second creator use distinct auth contexts; second creator has no source membership. Use existing `createRailDeal` and hermetic Supabase helpers, never hosted fixture mutations.

- [ ] **Write a browser test for save/create/replace.** Extend the hermetic provider stub with retain/import receipts matching task 3 wire fixtures and a controllable “commit then disconnect once” mode. It may fake bytes but must keep stable request receipts. Browser tests prove product wiring; backend integration below proves real package semantics.

```ts
test('replacement changes only later deals', async ({page, browser}) => {
  const fixture = await seedTemplateJourney();
  await page.goto(`/projects/${fixture.source.code}/rail`);
  await page.getByRole('button', {name:'Save rail', exact:true}).click();
  await page.getByLabel('Name', {exact:true}).fill('Technology sell-side');
  await page.getByRole('button', {name:'Save rail', exact:true}).last().click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const colleague = await browser.newContext({storageState:fixture.secondCreatorStorageState});
  try {
    const otherPage = await colleague.newPage();
    await otherPage.goto('/');
    await expect(otherPage.getByRole('button', {name:/new mandate/i})).toBeVisible();
  } finally {
    await colleague.close();
  }
});
```

Expand this test using the existing Gate 0 helper's actual accessible labels: create D1 selecting the template, assert order/count, fresh assignments and empty run history; replace from the source after a structural edit; create D2; reread D1 and compare its rows/bindings with the pre-replacement snapshot. Do not use fixed sleeps. Use API/DB assertions for identities and UI assertions for the user journey.
- [ ] **Run red.** `npx playwright test e2e/journeys/rail-templates.spec.ts --project=hermetic` under the repo's local Supabase setup; expected failure until fixtures/stub routes exist. Never label a live-only skipped journey as acceptance.
- [ ] **Complete browser recovery/access cases.** Same-bank colleague can reuse without opening source; different-bank creator cannot list/use it; inaccessible source identifiers do not appear in picker responses. Provider commit/disconnect followed by Retry creates once. Replacement while creation is admitted leaves that creation on the prior revision. Add assertions for name conflict, stale replacement, selected default v2 rather than one-off v3, standard default, and preserved new team selections.
- [ ] **Run real backend byte/lineage acceptance.** In the loopback integration suite retain publication v2 and seeded catalog packages, prune/change the source mount, import into two destination IDs, then execute through `mountSkillRuns` using injected `runTurn` that reads the unpacked SKILL.md and returns deterministic output. Assert the unpacked instructions are v2, generated run context uses the destination project, source digest is unchanged, and destination enhancement appends only to destination lineage. Authoring uses the existing deterministic generator seam; no live model calls.
- [ ] **Document operation and flag behavior.** Describe new names/replacement, clearing people/work, package sharing disclosure, exact version retention, pending command retry/resume, and the fact that superseded archives are retained. Record migrations, request paths and permission keys. `rail_templates` defaults off; show local enablement only after project rail backfill plus stack migrations and backend migration 004. Existing standard creation remains available when the new flag is off. Skill-bearing save/create fails explicitly if skill capability is disabled; no silent downgrade.
- [ ] **Run the completion gates.** From C, with only local services configured:

```bash
npx tsc --noEmit
npm run lint
npm test
RUN_DB_TESTS=1 npx vitest run tests/db/rail-templates.test.ts tests/db/rail-template-creation.test.ts tests/db/project-rail.test.ts
npx playwright test e2e/journeys/rail-templates.spec.ts --project=hermetic
```

From I `platform/`, with verified loopback `SKILL_BENCH_DATABASE_URL`:

```bash
pnpm run typecheck
pnpm run lint
pnpm exec vitest run apps/skill-bench/src/authoring
```

Run the repository-required CI checks beyond these commands if its instructions changed at integration. Report skipped suites and existing failures separately. The new DB/import acceptance suites must execute, not skip. Do not broaden repeated runs after green without a new change or concern.
- [ ] **Commit and hand off.** C commit `test(rail): verify template reuse replacement and recovery`; I commit `test(skill-bench): verify retained rail skill independence`. Provide the commit IDs, test results and local gate status. Request deployment or flag enablement only if execution scope separately authorizes it.

## Dependency order and review boundaries

1. Task 1 defines the snapshot shape.
2. Tasks 2–3 deliver a backward-compatible authenticated provider capability.
3. Task 4 delivers the durable template store.
4. Tasks 5–7 deliver save/import/create and then integrate enhancement, in order. The import metadata table exists in task 4 and its reader ships in task 5, so none of these tasks consumes a future implementation. Keep the new feature flag off throughout.
5. Tasks 8–9 attach the two UI entry points.
6. Task 10 is the release gate.

Each task is independently reviewable at its own boundary, but no partial state is described as the finished user feature. Implementation commits should stage exact task paths and never include unrelated untracked files.

## Plan self-review and requirement coverage

| Requirement | Implementation | Evidence required |
|---|---|---|
| Named company templates | 4, 5, 8 | Name conflict and company-scope API/DB tests |
| Reuse without source membership | 5, 6, 9 | Two-user acceptance journey |
| Selected version, not last run | 1, 2, 5 | Override-v2/one-off-v3 fixture and real package read |
| Create new / replace existing | 4, 5, 8 | Atomic pointer switch and stale replacement conflict |
| Existing projects unchanged | 6, 10 | D1/D2 row and binding comparison |
| Clear named people and work | 1, 6, 10 | Projection, DB assertions, fresh UI history |
| Independent enhancement | 3, 7, 10 | Destination v1/v2 lineage and unchanged source |
| Retry without duplicate deals | 3, 4, 6, 9 | Lost-response replay, rollback, notification count |
| Standard rail / Gate 0 compatibility | 6, 9 | Existing Gate 0 suites and baseline payload |
| Saved skills survive mount pruning | 2, 3, 10 | Retain, prune, import and execute local integration |

Self-review at authoring: checked all four user decisions against these tasks; verified the inspected PR heads; accounted for explicit Part E bindings, imported metadata, nullable custom sequence, current-step navigation, and catalog content-hash versus package-hash identity. Checked repository paths, cross-task types, source-reader dependencies, import provenance FKs, and the replacement/creation race. Implementation code and tests in this plan have not been executed. Validate exact existing signatures when the stack merges.
