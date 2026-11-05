# Skill run execution and results: design

**Status:** Implemented on 2026-09-14. Every section below is built and verified except where the deferrals say otherwise. Two legs of the verification could not be exercised here and are named in the pull request: a real streamed turn needs a running skill bench and billed model calls, and the hermetic browser tier pins the skill service absent by construction.

**Repositories:** Conductia and Ignatious

**Depends on:** the Part A project rail model, the Part B authoring slimdown, and Part C skill publication and rail insertion, all of which must be merged first

**Source decisions:** [project rail skill authoring map](../../../.scratch/project-rail-skill-authoring/map.md), [one-input execution ticket](../../../.scratch/project-rail-skill-authoring/issues/08-one-input-execution.md), [Part C design](./2026-09-09-skill-publication-and-rail-insertion-design.md), and [the Part B MVP slimdown](./2026-09-11-durable-skill-authoring-slimdown.md), which lands with the Part B implementation branch and is not yet on this one

## Objective

Make the pending, skill-backed step Part C inserts into a project rail runnable: one text input, an execution of exactly the pinned skill version, a result that is kept and shown without replacing the input, retained run history, generated files filed onto the deal, and completion that stays a human action.

Conductia owns the input, the run record, the result history, the document provenance and every browser-facing route. Ignatious owns execution of the exact published package, the fresh per-run context, and the streamed response.

This design is deliberately the smallest thing that satisfies the product decisions. It adds no admission table, no lease, no fencing, no queue, no sweeper and no reconciliation loop, because the run is held by the browser tab that started it, which is how the shipped catalog-step runner already works.

## Evidence from the implemented systems

The 2026-09-09 Part B design was superseded by the 2026-09-11 slimdown before implementation. This design is written against the code as merged on the integrated Part C branch, not against the superseded design.

What exists and is reused:

- Part C's step definition is implemented as `parseSkillStepDefinitionV1` (`src/lib/skillPublication/parse.ts`): `schemaVersion 1`, `type skill`, exactly one input entry keyed `primary` of kind `text`, and `skillBinding` of `skillId`, `versionId` and `digest`. `skillBindingForStep` (`src/lib/rail/projectRail.ts`) already reads it on the client.
- A published skill version is immutable bytes in the Ignatious skill-bench Postgres: `skill_publications` holds `operation_id`, `project_id`, `skill_id`, `version_id`, `digest` and `package_bytes`, with triggers that raise on update and on delete (`platform/apps/skill-bench/src/authoring/postgres/migrations/002_skill_publication.sql`). The bytes are a zip of the skill folder produced by `zipSkillFolder` at candidate time.
- The step record already carries free-form work: `deal_steps.work jsonb` exists, and `PATCH /api/v1/deals/{dealId}/steps/{stepId}` merges into it. `manualStepDef` returns nothing for a custom step, so that route applies no catalog validation to one.
- The browser already reads a bench stream: `readBenchEvents` (`src/lib/ignatious/client.ts`) parses the Server-Sent Events framing that `POST /chat` emits, and `BenchStepRunner` renders text, elapsed time and failures from it.
- Ignatious already writes that framing in a tested module of its own with a ten-second comment heartbeat (`platform/apps/skill-bench/src/sse.ts`), which exists because the load balancer idle timeout is 300 seconds and a thinking step or a long tool call emits no frame while it runs.
- Ignatious already files a document onto a deal through Conductia: the `conductia_file_document` tool posts to `POST /v1/leads/{leadId}/documents`, whose scope comes from the `x-conductia-tenant-id`, `x-conductia-lead-id`, `x-conductia-agent-name` and `x-conductia-run-id` headers that `requireConductiaScope` reads, and `createRestConductia` sends `x-conductia-run-id` from its construction-time scope.
- Part B's merged shape for a cross-service generation is Conductia calling Ignatious directly with no worker and no internal API, gated by a config value, answering in a stream (`src/lib/skillAuthoring/runTurn.ts` and `platform/apps/skill-bench/src/authoring/turn-route.ts`).

What exists and is deliberately not reused:

- The catalog-step bench path addresses a skill by name, by prepending `/{skill-name}` to the message text, resolved by the model against the shared mount. The mount's version numbers are rewindable: a revert deletes the versions above the target and reuses the number (`platform/apps/skill-bench/src/versions.ts`), so a name cannot express "exactly this version", which is the one guarantee Part C exists to provide.
- `stepSkillIo.ts` maps a reply onto a catalog step's work fields, and `applySkillReply` overwrites them. Part D must not overwrite the input or a previous result.
- `deal_steps.bench_conversation_id`, `bench_run_id`, `bench_run_status` and `bench_run_started_at` hold one latest run identity with no input snapshot, no result and no history. Part D needs all three.
- `POST /api/v1/deals/{dealId}/steps/{stepId}/ignatious` triggers by agent name and supports an interactive `POST .../input` answer loop. A follow-up answer flow is explicitly excluded by the execution ticket.
- `applySkillReply` and the catalog step's work-field write-back, for the reason above.

## Where a generated file physically lands

The Deal Folder taxonomy is a logical placement recorded on the document row as `folder` and `folder_subpath`, and the executing skill already chooses one of the eight through the filing tool. The physical parent is separate: a Box folder reached through a `datarooms` row, whose `step_id` is free text under `unique (deal_id, step_id)`, so a custom step fits the table.

What does not fit is `provisionDataroomFolder`, which names the Box folder `{dealCode} - {census step title}` and throws `Unknown rail step` when `railStepById` misses, which it does for every custom step. Part D therefore adds one optional parameter to it: a caller-supplied title, used only when the census does not know the step, taken from `deal_steps.definition.title`. Catalog callers pass nothing and behave exactly as they do today.

The logical destination is still whatever deal folder the skill named, so the decision that generated output is found in the deal folder taxonomy is unchanged. What changes is one helper signature, not the filing model.

## Scope

- The Conductia browser routes to start a run, record its outcome and read its history.
- One Conductia table for run records, and one provenance column on `documents`.
- The Ignatious route that executes a pinned published version in a fresh, single-skill workspace and streams the response.
- The step surface: input, streamed result, retained history, failure states, and unchanged Mark complete.
- Authorization, audit, the feature flag, verification and rollout gates.

## Out of scope

- Editing a published skill or publishing a second version onto an existing skill identity.
- Selecting a version at run time. This design is shaped so that change is a widening, and the section below says exactly what blocks it today.
- Migrating catalog steps onto the version-addressed path.
- A follow-up reply, an execution chat composer, or resuming a previous execution context.
- Server-side run admission, cross-tab concurrency rules, durable recovery of an abandoned run, and independent retry of file delivery. Each is a recorded deferral below.

## Decisions this design implements

| Id | Decision |
|---|---|
| D1 | The run lives in the browser tab that started it, as the catalog-step runner already does. No `after()` driver, no Vercel duration ceiling, no server-held connection. |
| D2 | Conductia writes the run down only when it ends. There is no admission row, so there is no stuck row, no staleness window and no unstick control. |
| D3 | Ignatious receives execution on a new one-shot route beside the authoring turn route, addressed by published version rather than by name. |
| D4 | Generated files keep the deal-folder placement the skill names, filed through the path that already exists, repointed at the run's own step and carrying run provenance. |
| D5 | A run that needs more information has no distinct outcome. A one-shot run cannot ask, so it says what is missing in its reply and the user edits and runs again. |
| D6 | Run history is a table of terminal runs, and the panel lets the user select between them. |
| D7 | The run record is keyed on `deal_steps.id` and stores the binding that actually ran, so catalog steps and future version selection fit the same record. |

## Architecture: the run path

```text
Browser (SkillStepRunner inside CustomStepPanel)
 1. PATCH /api/v1/deals/:dealId/steps/:stepId          { work: { primary } }   existing route
 2. runId = crypto.randomUUID()
 3. POST  /api/v1/deals/:dealId/steps/:stepId/skill-runs/stream   { runId }
      server: access, internal, flag, capability
              load the deal_steps row: origin custom, removed_at null, parseable definition
              take skillBinding from the definition, read work.primary
              mint the trigger token with this runId and dealId
              POST Ignatious /v1/bench/skill-runs
              proxy the stream through unchanged; write nothing
 4. Browser accumulates frames with readBenchEvents, unchanged
 5. POST  /api/v1/deals/:dealId/steps/:stepId/skill-runs
      { runId, input, outcome, resultText, errorMessage, providerRunId, costUsd, startedAt }
      server: insert one deal_step_skill_runs row and one audit row
 6. GET   /api/v1/deals/:dealId/steps/:stepId/skill-runs    history and filed documents
```

Three properties follow from that order.

**The version is never client-supplied.** Step 3 reads `skillBinding` from `deal_steps.definition` on the server. The browser sends only a run id, so no request can redirect a run onto another version, and because Part C makes the binding immutable after insertion, the triple recorded at step 5 is provably the triple that ran at step 3.

**The run id exists before the run does.** It is minted in the browser and carried as the `x-conductia-run-id` scope header the provider routes already read, so a document filed mid-run by `conductia_file_document` carries the id the run record will later use. That is what buys provenance without an admission row.

**An abandoned run is invisible rather than stuck.** Nothing is written until step 5. A closed tab, a navigation and a Cancel are the same event: no record. The cost is stated in the deferrals: an abandoned run may have spent money and filed a document, and that document keeps a run id that resolves to no run.

## Forward compatibility with version selection

Selecting a version at run time is wanted for custom and catalog steps alike. It is blocked today by two constraints, both upstream of this design:

- Conductia: `unique (reserved_skill_id)` on `skill_publication_operations` admits one publication per skill identity.
- Ignatious: `skill_id` is unique on `skill_publications`, so a second version row for one skill cannot be inserted.

Part C records both as out of scope. Two choices here keep Part D from adding a third obstacle:

- The run record is keyed on `deal_steps.id` and stores `skill_id`, `version_id` and `digest` per run rather than deriving them from the step at read time. Once one step can run two versions, history stays truthful, and catalog steps, which also have `deal_steps` rows, fit the same table and the same routes.
- The Ignatious route's skill reference is a discriminated union. `{ kind: "publication", skillId, versionId, digest }` is the only variant Part D implements, leaving `{ kind: "mount", name, version }` addable without a breaking change to a route Conductia already calls.

Adding selection then changes one server function, the one that turns a step into a binding: today it returns the step's binding, later it accepts a caller-supplied version and validates it against that skill's published set. Catalog steps additionally need an immutable version identity, which the rewindable mount does not have; that is a separate decision this design neither settles nor blocks.

## Conductia persistence

### `deal_step_skill_runs`

```sql
create table deal_step_skill_runs (
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

create index deal_step_skill_runs_step_idx
  on deal_step_skill_runs (deal_step_id, created_at desc);
```

`id` is the run id minted by the browser, which makes the record route idempotent through the primary key.

`skill_id`, `version_id` and `digest` are written from the server's own read of the step definition, never from the request body. `input` comes from the request: a client can misdescribe its own input, which misrepresents only its own history and cannot redirect a run.

Row level security is enabled. Select mirrors `deal_steps_select`: a deal member or an overseer. Writes are service-role only, through the route layer. Update and delete triggers raise, the way `skill_publications` does on the Ignatious side, because a run record is a statement about work that happened and money that was spent.

### `documents.step_skill_run_id`

One nullable `uuid` column, deliberately with no foreign key. A filing happens mid-run, which is before the run record exists and sometimes instead of it ever existing, so a foreign key would either fail or force an admission row. The provider filing route writes it from the `x-conductia-run-id` scope header. The history read joins on it.

## Conductia browser API

All three routes live in the existing step namespace, beside `work`, `ignatious` and `dataroom`, so the panel uses one namespace and a catalog step fits the same shape later. `:stepId` is the text `step_id`, which for a custom step is `custom:<uuid>`, exactly as the rail payload reports it.

### Start a run

`POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/stream`

Body: `{ "runId": "uuid" }`.

The handler resolves the `deal_steps` row for that deal and step id, and requires `origin = 'custom'`, `removed_at is null`, and a definition that `parseSkillStepDefinitionV1` accepts. It reads `work.primary`, mints the trigger token with the run id and the deal, calls the Ignatious route, and proxies the response body through unchanged with the same content type.

| Status | Meaning |
|---|---|
| 200 | The stream, framed exactly as the bench frames `POST /chat` |
| 403 | Not a member, not internal, or without the work capability |
| 404 | No such step on this deal |
| 409 | The step is removed, or is not skill-backed |
| 422 | The saved input is empty |
| 503 | Ignatious is not configured, or unreachable |

Nothing is persisted by this route.

### Record a run

`POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs`

Body: `{ runId, input, outcome, resultText, errorMessage, providerRunId, costUsd, startedAt }`.

It inserts one run row and one audit row. Replaying the same run id with the same payload returns the stored row. The same run id with a different payload returns `409`. `outcome` is `succeeded` or `failed`; a succeeded run must carry result text, which the database check also enforces.

### Read history

`GET /api/v1/deals/{dealId}/steps/{stepId}/skill-runs`

Returns the twenty newest runs for that step, newest first, each with actor display name, outcome, timestamps, result text or error message, the binding triple, and the documents joined by `step_skill_run_id`. No pagination.

## Ignatious execution API

`POST /v1/bench/skill-runs`, mounted in the skill-bench app beside `/v1/bench/authoring/turns`, behind the same shared inbound key, gated by its own config value the way authoring is gated by `SKILL_BENCH_AUTHORING`, answering `503` when the publication store is not configured.

Request body, mirroring the chat body that already carries deal scope and a forwarded token:

```json
{
  "runId": "uuid",
  "skill": {
    "kind": "publication",
    "skillId": "uuid",
    "versionId": "uuid",
    "digest": "64 hex characters"
  },
  "input": "the text the user typed",
  "tenantId": "...",
  "leadId": "...",
  "token": "the Conductia-minted JWT"
}
```

### Resolving the pinned version

A new read on the publication store fetches the `skill_publications` row by skill id and version id. The route then proves that the SHA-256 of `package_bytes` equals both the row's digest and the requested digest. A mismatch is a non-retryable refusal, never a fallback to another version, another name or the mount.

### Mounting exactly that package

The bytes are unpacked with `unzipSync`, reusing the entry validation the staging path already performs (it reads the zip central directory specifically to catch symlink entries, which `unzipSync` does not report, and rejects traversal), into `<runsRoot>/<runId>/<skillName>/`.

The turn agent is built with that one skill and a `LocalSkillSource` whose base path is `<runsRoot>/<runId>`, so the run sees exactly one skill and none of the skills on the shared mount.

Two consequences are structural rather than promised. The fresh context the execution ticket requires is guaranteed because the workspace key is the run id: there is no conversation record, no conversation metadata, no step lookup that could resurrect an earlier run, and nothing to resume. And the sandbox and the run directory are destroyed in a `finally`, as the chat session and the recovery path already do, so a run leaves nothing on the volume.

### Deal access during the run

The Conductia client is constructed scope-bound with `runId` set to Conductia's run id, which is what puts `x-conductia-run-id` on every call the skill makes, filings included. The token is forwarded, not minted and not widened, so the skill reaches Conductia as the running user.

### The stream

The route writes through the existing Server-Sent Events module and emits the vocabulary `POST /chat` emits: `run`, `text`, `tool`, `tool_result`, `done` with `costUsd`, and `error`. Conductia then proxies bytes it does not have to understand, and the browser reader and result rendering are unchanged.

The heartbeat is load bearing rather than a nicety: the load balancer idle timeout is 300 seconds and is a genuine idle timer, and a single thinking step or one long tool call emits no frame while it runs, so without the comment frame a long run dies at five minutes with the tab still open.

### Cost control

The service-wide daily ceiling applies unchanged, since a run records its spend like any turn. The per-conversation ceiling does not apply, because a run has no conversation; the same per-key mechanism is keyed on the run id instead, so a run carries a ceiling rather than none.

## The step surface

`CustomStepPanel` remains the shell and gains a `SkillStepRunner` whenever `skillBindingForStep` returns a binding. A custom step whose definition has no parseable binding renders as it does today and says it has no skill attached, rather than showing a control that cannot work.

The order is input, then result, then history. The input is never overwritten by output.

| State | What the panel shows |
|---|---|
| Idle | The input textarea labelled `Input` with the definition's helper text, and Draft this step |
| Saving | The Saving and Saved labels the builder dialog already uses, on a debounced save into `work.primary`, plus one forced save immediately before a run starts |
| Running | Elapsed time, the streamed text in the result area, a disabled Draft this step, and Cancel |
| Cancelled | Nothing was recorded, said plainly. Identical to what a closed tab leaves |
| Succeeded | The result rendered as markdown, the documents the run filed, and Draft again |
| Failed | The failure message from the shared helper, the input untouched, and Draft again as an ordinary fresh run |
| History | The step's runs, newest first, with actor, time and outcome. Selecting one shows its result below the input and changes nothing else |
| Removed step | History, read only. A new run is refused by the route with `409` |

Mark complete is the existing control, unchanged, still gated by the completion capability. No run outcome completes a step.

Two consequences to hold on to. Two people can run the same step at the same time: both records land, each labelled with its actor, and neither overwrites the other, which is the upside of having no shared result field. And the existing step PATCH merges `work` by key with no expected revision, so two people editing the same `primary` value is last write wins; this design does not add a revision check to a route four other callers share.

## Authorization

Every route runs the existing chain: authenticate, resolve the deal, confirm deal access, classify the user as internal because a rail step's work product is bank material, then resolve step capabilities. The work capability gates starting and recording a run. The history read requires deal access and internal classification. The `skill_authoring` flag gates all three routes.

The browser learns nothing new: the skill identity, version and digest are already in the rail payload it parses, the Ignatious base URL and inbound key stay on the server, and the token is minted per run for this deal and this run.

There is no access recheck during a run, which matches the authoring slimdown's accepted risk. Every read the skill performs, however, goes through Conductia's own provider routes with the forwarded token, and those authorize per call, so mid-run data access is checked per request even though the run was authorized once.

## Audit

One row per recorded run, using an existing action value with `detail.kind = 'skill_run'` carrying the step id, the deal step id, the run id, the binding triple, the outcome and the cost. No input text and no result text, matching the slimdown's ids-and-codes posture. No new `audit_log` check value, so no enum migration.

Filings continue to write their own upload rows, now carrying the run id. The server-side audit reader gains a label for the new kind, as the rail actions gained theirs, so the audit view reads a sentence rather than a code.

## Deliberate deferrals and accepted risks

1. **No admission and no concurrency rule.** The execution ticket asked for at most one nonterminal run per user and project, enforced atomically. With the run held by the tab there is nothing to enforce it against, so it is dropped. Two runs by one person in two tabs both land.
2. **No distinct `needs_information` outcome.** A one-shot run cannot ask a question. A run that lacks information says so in its reply and ends succeeded; the user edits the input or the deal documents and runs again.
3. **No durable recovery.** A run whose tab closes is unrecorded. It may have spent money and filed a document, and that document keeps a run id that resolves to no run. The document remains findable in its deal folder.
4. **No expected-revision input save.** Same-field editing is last write wins on the shared step route.
5. **No independent file-delivery retry.** A filing that fails fails inside the run, and the reply text still records when the run ends.
6. **No version selection.** Blocked upstream by the two uniqueness constraints named above, and shaped so it lands as a widening.
7. **Catalog steps are untouched.** They continue on the name-addressed path with its rewindable mount versions.

## Verification

### Conductia contract tests

- The stream route takes the binding from the step definition and ignores a client-supplied version.
- It refuses a removed step and a non-skill step with `409`, an empty saved input with `422`, and a non-member, an external user and a user without the work capability with `403`.
- The record route is idempotent on run id, and conflicts on the same id with a different payload.
- A succeeded record without result text is refused.
- The history read returns only that step's runs and joins documents by run id.

### Database probes

`supabase/tests/deal_step_skill_runs.sql`:

- Select succeeds for a deal member and returns nothing for a non-member.
- The update and delete triggers raise.
- The outcome and result-text check holds in both directions.
- The digest shape check rejects a non-hex or wrong-length value.

### Ignatious tests

- A digest that does not match the stored bytes refuses, and nothing is mounted.
- A run mounts exactly one skill, and a skill on the shared mount is not reachable from it.
- The emitted frames match the chat vocabulary, which is what keeps the Conductia reader and the browser unchanged.
- The run directory and the sandbox are gone after success and after failure.
- The per-run spend key bounds one run, and the daily ceiling still refuses past its limit.

### Cross-repository local check

One real run against a local stack, ending with a document filed into a deal folder carrying the run id, and a run row whose binding matches the step's definition. Local Supabase only: nothing in this verification points at a hosted project.

### Browser validation before the pull request

Real browser, seeded credentials, programmatic sign-in without driving the sign-in form: add a step through the Part C builder, type an input, run it, see the result below the unchanged input, run it again, see two history rows with the right actors and outcomes, select the older one, then mark the step complete.

## Rollout gates

- Parts A, B and C merged first. Part D needs a bound step to exist.
- The Ignatious route deployed before the Conductia flag flips, or the stream route answers `503`.
- `skill_authoring` off by default.
- The publication store configured on the Ignatious side, since execution reads the same Postgres that publication writes.

## Repository responsibilities

### Conductia

- One migration for the run table and the document provenance column.
- Three routes in the existing step namespace.
- `SkillStepRunner`, composed into `CustomStepPanel`.
- The audit label for the new kind.
- Repointing the provider filing route at the run's own step instead of the hardcoded brief step, a title parameter on `provisionDataroomFolder` for a step the census does not know, and run provenance on the document.

### Ignatious

- `POST /v1/bench/skill-runs`, its config gate, and its mount.
- A read by skill id and version id on the publication store.
- Per-run unpacking, single-skill mounting, and teardown.
- The run-keyed spend ceiling.

## Implementation-plan requirements

The plan must:

- reconcile against the merged Part C definition parser and binding type rather than the Part C design text;
- prove in a test that `versionId` and `digest` are used together, and that a client-supplied version is ignored;
- treat the provider filing route change as a change to a shared path and cover the brief step's existing behaviour as a regression;
- keep the new Ignatious route's skill reference a union from the first commit, with one variant;
- order the work so the Ignatious route and its tests land before the Conductia stream route depends on them.
