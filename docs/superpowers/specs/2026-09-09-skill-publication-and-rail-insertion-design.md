# Skill publication and rail insertion: design

**Status:** Approved design for sub-project C on 2026-09-10

**Repositories:** Conductia and Ignatious

**Depends on:** the Part A project rail model, the Part B durable skill-authoring boundary, Ignatious owner agreement, and verification that Ignatious publication state uses durable operational storage

**Source decisions:** [project rail skill authoring map](../../../.scratch/project-rail-skill-authoring/map.md), [save-and-attach ticket](../../../.scratch/project-rail-skill-authoring/issues/06-save-and-attach.md), [Part A design](./2026-09-09-project-rail-model-design.md), and [Part B design](./2026-09-09-durable-skill-authoring-design.md)

## Objective

Publish the exact private skill candidate an authorized author reviewed, then insert one runnable, skill-backed step into that project’s rail. The operation survives browser close, process restart, lost responses, and either service failing without creating another live version or rail step.

Conductia owns the command, authorization, project policy, durable operation state, placement, rail insertion, and audit history. Ignatious owns private candidate bytes, package validation and comparison, immutable live publication, and authoritative publication lookup.

This design deliberately uses one durable Conductia row, database uniqueness, and idempotent service operations. It does not introduce a publication queue framework, distributed lock, lease, fencing generation, or worker-ownership protocol. The expected user count and write concurrency do not justify those mechanisms.

## Evidence and integration point

Part A defines `deal_steps` as the project rail and exposes an idempotent insertion boundary:

- a custom step has stable `deal_steps.id` and `step_id = custom:<uuid>` identities;
- `rail_insert_step` accepts a caller-supplied `step_id`, `request_id`, phase, placement, and JSON definition;
- `(deal_id, request_id)` prevents duplicate inserts;
- insertion starts the step as `pending`, changes no completion history, and does not move the current step;
- `anchor_step_id` and the deal-row lock implement placement and save-order rebasing;
- `rail_revision` reports staleness but is intentionally not a blanket write precondition;
- the current Part A implementation evidence still has uncommitted migration and test changes in its separate workspace, so Part C must integrate only after Part A is committed and reviewed.

Part B defines the private authoring record:

- Conductia owns the draft, edit revision, messages, generation attempts, visible events, and candidate metadata;
- Ignatious owns immutable private candidate bytes addressed by opaque candidate ID and SHA-256 digest;
- a candidate becomes current only after a valid terminal generation result;
- drafts reserve terminal status `published`, but Part B never enters it;
- browser traffic and authority remain Conductia-only;
- current Part B implementation evidence defines `CandidatePreview` with candidate ID, opaque artifact reference, digest, schema version, name, purpose, expected input, and expected output. Its implementation is also still uncommitted in a separate workspace.

Existing Ignatious live-library creation and version paths are not suitable for Part C. They are name-based, publish immediately, and do not provide the required exact-candidate idempotency, project-local identity, or lost-response lookup. Part C therefore adds an explicit publication API rather than wrapping those paths as though they already met this contract.

## Scope

Part C includes:

- the Conductia browser publish command and publication status in draft reads;
- one simple Conductia publication-operation record;
- save-time revision, candidate, placement, authorization, name, and capability checks;
- deterministic and semantic duplicate detection against the project;
- idempotent Ignatious preparation, publication, and lookup operations;
- a stable skill identity and its first immutable version;
- a project-local atomic transaction that inserts the exact pinned binding and marks the draft published;
- user-visible saving, confirmation, reconciliation, replacement-placement, failure, and success states;
- security, audit, compatibility, recovery tests, feature-flag behavior, and rollout gates.

## Out of scope

- editing an already-published skill;
- publishing another version onto an existing skill identity;
- changing a step binding to a newer version;
- tenant-wide or company-wide skill libraries and reuse across projects;
- configurable multi-field execution forms in this release;
- skill execution, run history, result storage, or generated-file delivery, which belong to sub-project D;
- cleanup of retained candidates or published packages;
- a generic distributed saga or exactly-once delivery framework.

Part C creates one new skill identity with one immutable version. A later design may create another version and explicitly change a step binding. Nothing in Part C follows `latest` automatically.

## Superseded planning details

This design is authoritative where it differs from the earlier save-and-attach ticket:

1. Ignatious publishes the immutable project-scoped version before Conductia inserts the visible rail step. The earlier ticket described private preparation as the final provider action and the Conductia transaction as the publication boundary.
2. A different active or removed skill-backed step with the same normalized project-local name blocks creation. The earlier placement ticket treated duplicate display names as warnings only.
3. Part C uses simple polling and idempotent retries for its operation. It does not reuse Part B’s lease and fencing machinery merely because that machinery exists for long-running model generation.

These changes were approved during the Part C design session.

## Domain model

### Publication operation

One durable, idempotent command that publishes an exact skill candidate and attaches the resulting skill version to one project step. It is the recovery and audit identity across both repositories.

### Skill identity

The stable opaque identity of a published skill. Conductia reserves it before publication. It is independent of the project-local display name and provider storage path.

### Skill version

An immutable published package identified by version ID and content digest. Part C creates the first version only.

### Skill binding

The exact skill ID, version ID, and digest stored on the project step. Execution must later resolve this binding, not a display name, process tag, or current/latest version.

### Capability contract

The candidate’s structured purpose, expected input, and expected output. It supports duplicate detection without making a display name the definition of behavior.

## Product and authority boundary

All browser requests terminate at Conductia repository APIs. The browser never calls Ignatious, receives its credentials, sees provider artifact references, chooses project scope, or supplies a trusted author or tenant identity.

Conductia derives project, company, author, candidate, comparison targets, placement, and reserved identities from authenticated server state. New publish commands require:

- an internal project member;
- current deal access;
- `company:deals:steps:structure`;
- an active author-owned draft;
- the `skill_authoring` feature flag.

No second authoring or publication permission is added.

Ignatious exposes its Part C operations only to a publication-scoped Conductia service credential. The Part B authoring worker credential and model tool policy cannot call publication. A model tool call alone can therefore never make a candidate live.

## Architecture and ordering

The order is:

1. Conductia validates and durably admits the publication operation.
2. Ignatious prepares the exact candidate and returns a frozen comparison and validation receipt.
3. Conductia obtains any required duplicate confirmation and revalidates current local facts.
4. Ignatious publishes the exact bytes as one project-scoped immutable version.
5. Conductia records the live receipt.
6. Conductia atomically inserts the bound rail step and marks the draft and operation published.
7. The client refreshes and focuses the inserted step.

No step appears before a live version exists. If publication succeeds and attachment fails, the live version can be temporarily unattached, but it remains project-scoped and unavailable through generic discovery. Conductia retains the receipt and must attach that exact version; it never compensates by deleting it and never publishes another version on retry.

No transaction or lock crosses the network boundary.

## Conductia persistence

### `skill_publication_operations`

Add one table with these logical fields:

| Field | Meaning |
|---|---|
| `id` | Stable UUID and cross-service publication operation ID. |
| `deal_id` | Owning project. |
| `draft_id` | Source authoring draft. |
| `actor_id` | Author who admitted Save. |
| `client_request_id` | Browser idempotency key. |
| `state` | Current state described below. |
| `revision` | Small optimistic revision for confirmation and replacement-placement commands. |
| `candidate_id`, `candidate_digest` | Exact private candidate selected from the preview. |
| `draft_edit_revision` | Frozen authoring revision accepted by Save. |
| `name`, `phase_index`, `placement_kind`, `anchor_deal_step_id` | Frozen step metadata and placement snapshot. |
| `reserved_skill_id` | Conductia-generated stable skill identity. |
| `reserved_step_key` | Conductia-generated `custom:<uuid>` value passed to Part A. |
| `capability_contract` | Frozen purpose, expected input, and expected output. |
| `comparison_set_digest` | Digest of active/removed bindings and admitted publications assessed by preparation. |
| `preparation_id`, `assessment_digest`, `duplicate_matches` | Frozen Ignatious preparation outcome. Provider paths and bytes are excluded. |
| `duplicate_confirmed_at`, `duplicate_confirmed_by` | Explicit override of the recorded weak active-step match set. |
| `published_skill_id`, `published_version_id`, `published_digest` | Immutable Ignatious publication receipt. |
| `resulting_deal_step_id` | Inserted `deal_steps.id` after local commit. |
| `status_code`, `status_message` | Safe reason for a pause, required action, or terminal pre-publication failure. |
| `next_retry_at`, `attempt_count`, timestamps | Simple retry and operational inspection metadata. |

Constraints enforce:

- unique `(draft_id, client_request_id)`;
- one non-failed operation per draft, including the successful operation;
- unique reserved skill identity;
- unique resulting deal-step identity when present;
- SHA-256 digest shape;
- immutable frozen fields after admission;
- immutable published receipt fields once populated.

A known pre-publication failure leaves the draft active and permits a new operation only after the author corrects the draft or candidate. Historical failed operations remain retained. A nonterminal operation freezes authoring edits, new messages, retry-generation, and Discard. The draft itself remains `active` until the local attachment transaction changes it to `published`.

### Operation states

The stored states are:

```text
preparing
confirmation_required
publishing
attaching
reconciling
needs_placement
published
failed
```

- `preparing` verifies the frozen candidate and compares project capabilities.
- `confirmation_required` contains only weak active-step matches that the author may explicitly override.
- `publishing` means the idempotent Ignatious publication call may be in progress.
- `attaching` means a live immutable receipt is stored and the local rail transaction remains.
- `reconciling` means a publication or attachment outcome was ambiguous and must be looked up before retrying.
- `needs_placement` means a live version exists but the chosen anchor is no longer active.
- `published` is terminal success and names the resulting step.
- `failed` is terminal only when Ignatious proves no live version exists.

Timeout after a publication request is never sufficient evidence for `failed`. After a live receipt exists, the only terminal state is `published`.

### Deliberately simple processing

The request path may attempt immediate progress, and a small periodic processor retries eligible nonterminal rows by `next_retry_at`. It may select rows without claiming exclusive ownership. Duplicate processors are harmless because:

- Ignatious prepare and publish are idempotent by operation identity and exact payload;
- Part A insertion is idempotent by `deal_steps.request_id`;
- local state updates use short transactions and state predicates;
- unique database constraints decide rare Save races.

Do not add a publication-specific inbox, outbox, queue, lease, heartbeat, fencing generation, distributed lock, or leader election. A future scale problem must be demonstrated before adding coordination.

## Skill-backed rail definition

Part C extends the custom-step definition with a versioned input array and exact binding:

```json
{
  "schemaVersion": 1,
  "type": "skill",
  "title": "Weekly project update",
  "description": "Prepare a concise project update from current deal information.",
  "inputs": [
    {
      "key": "primary",
      "kind": "text",
      "label": "Input",
      "helperText": "Describe the reporting period and any points to emphasize.",
      "required": true
    }
  ],
  "skillBinding": {
    "skillId": "2d362e20-0709-4ba0-bbd7-d21831148282",
    "versionId": "01K4VJ2M7DB05PAVK6SGNBSFK9",
    "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Part C accepts exactly one input entry with `key = primary`, `kind = text`, and `required = true`. The fixed label is `Input`; the candidate’s expected-input description becomes helper text. The array and top-level schema version deliberately leave room for future schema versions with multiple fields or other input kinds without changing existing records or the skill-binding model.

The binding is required for `type = skill` and immutable after the step is inserted. No `latest`, range, tag, mutable package name, or provider artifact path is allowed. The implementation plan and code tests must explicitly prove that `versionId` and `digest` are persisted and used together.

`deal_steps.request_id` is the publication-operation ID. `reserved_step_key` is passed as Part A’s caller-supplied `stepId`. A retry therefore returns the same `deal_steps` row.

## Browser API

### Publish

`POST /api/v1/deals/:dealId/skill-drafts/:draftId/publish`

```json
{
  "requestId": "c522f85b-cbac-47cc-8c64-fd88ab0baa1e",
  "expectedEditRevision": 12,
  "candidateId": "f896a8d2-3e35-42af-8be0-5e51f818f809",
  "candidateDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The browser does not repeat name or placement as trusted publication inputs. Conductia reads them from the locked draft at the expected revision. Admission validates:

- authentication, project relationship, internal classification, permission, and flag;
- active author ownership;
- no nonterminal generation attempt;
- current candidate identity and digest;
- valid nonblank name;
- selected phase and valid active anchor;
- deterministic duplicate rules;
- absence of another non-failed publication for the draft.

An identical request returns the existing operation. Reusing a request ID with different content returns `409 idempotency_conflict`. A changed draft revision or candidate returns a specific `409` and never silently chooses newer bytes.

The response is an operation read with `202` while nonterminal and `200` when it already resolved.

### Decide a weak match

`POST /api/v1/deals/:dealId/skill-publications/:publicationId/duplicate-decision`

```json
{
  "expectedRevision": 2,
  "assessmentDigest": "...",
  "decision": "confirm"
}
```

`decision` is `confirm` or `decline`. The command requires the original author’s current access and structure permission. Confirmation applies only to the exact recorded weak-match set. If the project comparison set changed, Conductia returns to `preparing`; a new match may require new confirmation.

Declining moves the operation to known pre-publication `failed` with `duplicate_declined` and unfreezes the active draft. It cannot affect a live version because the decision occurs before publication.

### Replace invalid placement

`POST /api/v1/deals/:dealId/skill-publications/:publicationId/placement`

```json
{
  "expectedRevision": 4,
  "placement": {
    "kind": "after",
    "phaseIndex": 2,
    "afterStepId": "4e4bac4f-dcbf-411c-bf4b-3ddc6cdb5861"
  }
}
```

This command is available only in `needs_placement`. It changes placement, not candidate, name, skill identity, version, or digest. It requires current author access and structure permission and returns the operation to `attaching`.

### Read

Part B draft reads replace `publication: { available: false }` with a safe product view:

```json
{
  "available": true,
  "id": "...",
  "state": "attaching",
  "revision": 3,
  "matches": [],
  "error": null,
  "result": null
}
```

On success, `result` contains the Conductia rail-step ID and the safe skill binding. It never contains Ignatious credentials, artifact references, provider storage paths, or another project’s names.

## Ignatious publication API

Ignatious adds a private API owned by its skill-package module. The canonical request and response schemas are provider-neutral and versioned in the Conductia-owned OpenAPI contract.

### Prepare

`POST /v1/conductia/skill-publications/:operationId/prepare`

The request contains:

- candidate ID and digest;
- reserved skill ID;
- server-derived tenant and project scope;
- frozen capability contract and project-local display name;
- a comparison-set digest;
- exact candidate or published-version identities for active steps, relevant removed steps, and already-admitted project publications.

Ignatious must:

1. load candidate bytes from its private candidate store;
2. prove their digest equals the request and candidate record;
3. validate the package under the publication schema;
4. compare its immutable capability contract against the supplied project set;
5. persist a preparation receipt before replying.

The response contains a preparation ID, verified candidate digest, normalized capability contract, comparison-set digest, assessment digest, and matches classified as `exact`, `equivalent`, or `similar`, with safe reason codes and confidence. It contains no package bytes.

Preparation is idempotent by operation ID and comparison-set digest. A new comparison set may produce a new preparation receipt for the same still-unpublished operation; old receipts remain retained but cannot authorize publication after Conductia records a newer assessment.

### Publish

`POST /v1/conductia/skill-publications/:operationId/publish`

The request names the current preparation ID and assessment digest plus the candidate ID/digest, reserved skill ID, and project scope. Ignatious verifies that all values match its stored preparation, then publishes the exact candidate bytes into an immutable project-scoped package namespace.

The response contains:

```json
{
  "operationId": "...",
  "skillId": "...",
  "versionId": "...",
  "digest": "...",
  "projectId": "...",
  "publishedAt": "..."
}
```

The receipt is stored before reply. An identical replay returns it. Any different candidate, digest, skill identity, preparation, or project under the same operation ID returns a conflict and is audited. Publication never replaces another skill, resolves by display name, or creates a second version on retry.

### Lookup

`GET /v1/conductia/skill-publications/:operationId`

Lookup returns `not_published`, the current preparation, or the immutable live receipt. Conductia uses it after timeout, connection loss, or restart. An unknown result never authorizes retry as a new operation.

## Project-local identity and duplicate policy

Display names are project-local. Two projects may use the same name without collision or disclosure. Ignatious storage and execution address the opaque skill identity, not a global display-name namespace.

Before publication, Conductia and Ignatious compare against active skill-backed steps and already-recorded project publication operations.

Hard blocks are:

- the same skill identity already bound to an active step;
- the same normalized project-local display name on another active skill-backed step;
- an identical structured capability contract;
- an Ignatious high-confidence `equivalent` assessment.

A weaker `similar` match against an active step shows the step, safe reason, and explicit Save-anyway confirmation. The recorded assessment makes retries deterministic.

For removed steps:

- the same normalized name, exact identity, or equivalent capability blocks creation and offers Restore existing step;
- weak semantic matches are ignored.

Normalization is limited to stable text normalization such as trimming, whitespace folding, and case folding. It does not rewrite the user’s saved display name.

The system checks current steps and recorded publication operations at admission and again before the publish call. It never holds a project lock while Ignatious compares packages. Consequently, two different users can very rarely publish semantically equivalent candidates at the same moment before either becomes visible. This low-concurrency semantic race is explicitly accepted for Part C. Exact identity, request, draft, name, and identical-contract constraints remain deterministic.

## Local attachment transaction

After Conductia stores a live Ignatious receipt, one service-only database function performs the local commit:

1. lock and load the publication operation and draft;
2. verify the receipt’s skill ID, version ID, and digest against the frozen operation;
3. verify the draft is still active and bound to the frozen candidate/revision;
4. call Part A’s insertion function with the reserved step key, publication ID as request ID, current placement, and version-pinned definition;
5. store the resulting `deal_steps.id`;
6. transition the draft `active -> published` and set `published_at`;
7. transition the operation to `published`;
8. append publication-specific audit metadata.

All steps occur in one Postgres transaction. If it fails, neither draft nor operation claims success. Part A’s request ID makes repeating the call return the same rail step if insertion had already become durable.

Part C must reuse Part A’s insertion semantics rather than duplicate ordering rules in application code. The implementation plan must reconcile against Part A’s final committed function signature before editing this boundary.

The inserted step is `pending`/To do. It does not run the skill, complete itself, move the current project step, or alter existing history—even if inserted before the current position.

## Revalidation and authorization timing

Save admission atomically revalidates draft revision, current candidate ID/digest, generation state, name, capability, phase, anchor, membership, permission, and feature flag.

Before calling Ignatious publish, Conductia rechecks:

- the author still has project access and structure permission;
- the flag remains enabled;
- the candidate and frozen operation still agree;
- no new deterministic duplicate exists;
- the comparison-set digest remains current.

If access or permission is lost before publication, the operation stops without publishing and the retained private draft remains inaccessible until access returns. If the flag is disabled, a proven-unpublished operation pauses rather than fails.

After a live publication receipt exists, attachment is reconciliation of an already-authorized irreversible command. The Conductia service may finish attachment even if the author subsequently loses permission. The audit record distinguishes the original actor from service completion, and the former author cannot read or modify the result without current access.

If the selected anchor disappears before attachment, do not silently choose another placement. Move to `needs_placement`, retain the exact live version, and require the original author—while currently authorized—to select a new placement. Phase-start and phase-end placement continue to use Part A’s normal save-time rebasing.

## Failure and recovery

| Situation | Required outcome |
|---|---|
| Invalid, missing, stale, or digest-mismatched candidate | Known pre-publication `failed`; preserve and unfreeze draft. |
| Exact/equivalent active duplicate | Do not publish; show and focus the existing step. |
| Exact/equivalent removed duplicate | Do not publish; offer Restore existing step. |
| Weak active match | `confirmation_required`; publish only after current authorized confirmation. |
| Ignatious prepare fails transiently | Retain `preparing`, set retry time, retry same operation. |
| Prepare reply is lost | Repeat by operation ID and comparison-set digest. |
| Publish call times out | `reconciling`; lookup by operation ID before any retry. |
| Lookup proves not published | Retry publish under the same operation ID if flag and permission still allow it. |
| Lookup returns live receipt | Store it and enter `attaching`. |
| Live receipt conflicts with frozen identity or digest | Hold `reconciling`, audit, and require operator investigation; never choose one. |
| Conductia attachment fails transiently | Retain receipt and retry the same local transaction. |
| Attachment reply/outcome is lost | Read operation and `deal_steps.request_id`; return the existing result or retry idempotently. |
| Anchor was removed | `needs_placement`; no partial step appears. |
| Browser closes or navigates | Continue or retry server-side; reopening reads persisted state. |
| Feature flag turns off before publication | Stop new admission and pause proven-unpublished work. |
| Feature flag turns off after publication may have happened | Reconcile; attach any proven live receipt. |
| Author loses authority before publication | Do not publish. |
| Author loses authority after live receipt | Service completes exact attachment; deny author interaction. |

There is no delete-as-compensation. Published package versions, published drafts, bound active steps, and bound removed steps are immutable references for this feature.

## Builder experience

Save is available only when:

- the draft is active;
- no generation attempt is queued, running, or reconciling;
- the preview has a current valid candidate;
- name, phase, and position are complete;
- no publication operation already freezes the draft.

After Save:

- `preparing` renders **Checking project**;
- `confirmation_required` shows the possible active duplicate and requires explicit confirmation;
- `publishing` renders **Publishing skill**;
- `attaching` renders **Adding step**;
- `reconciling` renders **Finishing in background** with honest retry/recovery copy;
- `needs_placement` renders **Choose a new position** and enables only placement;
- `failed` shows a safe correction and unfreezes the authoring draft;
- `published` closes the dialog, refreshes the rail, and focuses the new To do step.

Close remains available and never cancels. Discard is unavailable while a publication is nonterminal. Once publication may have occurred, the UI offers neither Cancel nor Start over until authoritative lookup resolves the outcome. Explicit Retry appears only for a known safe pre-publication failure; transient retries otherwise happen automatically with bounded backoff.

The author retains the private conversation as read-only history after success. Other authorized project users receive the runnable step and binding but not the authoring transcript.

## Feature flag and disable behavior

Reuse the one `skill_authoring` feature flag from Part B. Do not add a separate publication flag.

- Flag off rejects new authoring and publication admission using the existing hidden/not-found boundary.
- Proven-unpublished publication operations pause.
- Ambiguous publication calls continue lookup because disablement cannot declare an unknown outcome safe.
- A proven live receipt continues to attachment so the project is not left with an orphaned irreversible result.
- Re-enabling resumes retained eligible work.

## Security and audit

- Browser authorization comes from the session and database relationships, never request-supplied identity or provider scope.
- Candidate artifact references are not authority and never reach browser responses.
- Ignatious validates service authentication, project scope, candidate identity, digest, preparation receipt, and operation payload equality.
- Published packages are not generically discoverable or invocable by project-local display name.
- Another project’s matching name or package cannot be disclosed through collision errors.
- Part B authoring/model credentials cannot invoke publication.
- Audit events cover admission, denial, deterministic duplicate, semantic assessment, confirmation, prepare receipt, publication receipt, reconciliation, placement replacement, attachment, version binding, and terminal transition.
- Audit metadata includes actor/service identity, project/draft/candidate/operation/skill/version/step IDs, digests, safe result codes, and timestamps.
- Audit and logs exclude conversation text, composer text, package bytes, step input, credentials, provider paths, and raw model traces.

## Contract ownership

Conductia owns the provider-neutral OpenAPI schemas for:

- browser publication command and safe operation read;
- Ignatious prepare, publish, and lookup requests and receipts;
- capability-contract and duplicate-match shapes;
- skill-backed step definition version 1.

Ignatious checks in a pinned snapshot with the source Conductia revision and validates its handler and client fixtures against it. Provider-specific storage and SDK types stay behind Ignatious interfaces.

Each repository retains independent CI. A cross-repository compatibility command compares the canonical contract to the pinned snapshot and runs shared happy-path and recovery fixtures before enablement.

## Verification

### Conductia contract tests

- parse only supported operation states, SHA-256 digests, and schema versions;
- reject stale draft revisions, stale candidates, changed request-ID payloads, active generation, invalid placement, and browser-supplied authority;
- expose safe publication state without provider references;
- parse a version-pinned skill-backed definition and reject missing `skillId`, `versionId`, or `digest`;
- require exactly one `primary` text input in schema version 1 while preserving the versioned array shape;
- verify flag-off behavior.

### Conductia database tests

- two identical Save requests return one operation;
- conflicting request reuse fails;
- simultaneous Save admission for one draft yields one non-failed operation;
- failed history permits a corrected new operation while published history does not;
- frozen candidate, identity, version receipt, and binding cannot mutate;
- local attachment inserts one pending step, uses the reserved key, stores the exact version and digest, and atomically marks draft and operation published;
- a repeated attachment returns the same step;
- phase and anchor behavior reuse Part A semantics;
- removed anchor enters replacement-placement handling without a partial step;
- access/permission and feature checks match the timing rules.

One simultaneous-Save test is sufficient. No load test or elaborate concurrency harness is required for Part C.

### Ignatious tests

- candidate ID and digest resolve to the exact immutable bytes;
- changed digest, scope, identity, preparation, or operation payload is rejected;
- project-local same names do not collide across projects or disclose one another;
- comparison classifies exact/equivalent/similar and repeats the stored assessment receipt for the same comparison-set digest;
- prepare replay returns the same receipt;
- publish replay returns the same first immutable version;
- timeout followed by lookup recovers the same receipt;
- the live package cannot be selected generically by display name;
- the normal authoring worker and model tools cannot call publication.

### Cross-service recovery tests

Run locally against real Conductia and Ignatious processes with test databases:

1. normal prepare, publish, attach, refresh, and focus;
2. weak-match confirmation and changed comparison set;
3. exact active duplicate and exact removed-step restore offer;
4. publish success with lost response, recovered by lookup;
5. publish success followed by transient Conductia failure, recovered without another version;
6. attachment success with lost response, recovered as the same step;
7. anchor removal followed by replacement placement and attachment of the same version;
8. permission loss before publication and after live receipt;
9. feature disablement before publication and after an ambiguous call;
10. same name in another project with no collision or disclosure.

## Rollout gates

Do not enable `skill_authoring` for Part C until:

1. Part A and Part B are committed, reviewed, green, and integrated at their shared rail/permission boundary.
2. Part C is reconciled against Part A’s final insertion function and Part B’s final candidate/read contracts.
3. The Ignatious owner approves the publication API, project-scoped package identity, and model-tool exclusion.
4. The deployed Ignatious operational database and immutable package storage are verified, not inferred from local defaults.
5. Conductia’s canonical OpenAPI contract and Ignatious’s pinned snapshot match.
6. Database migrations and probes pass against representative existing projects.
7. The cross-service recovery suite passes.
8. Internal enablement shows no unexpectedly old nonterminal publication operations.

Operational visibility can remain small: counts by state and safe error code, operation age, and correlation-ID logs are sufficient. Investigate operations that remain nonterminal beyond the expected retry window; do not build a general workflow console for this release.

## Repository responsibilities

### Conductia

- browser APIs and feature boundary;
- author/project authorization and policy;
- publication table and simple processor;
- deterministic duplicate checks and comparison-set construction;
- durable receipt capture and safe operation reads;
- atomic version-pinned rail insertion and draft publication;
- builder states, recovery, rail refresh, and focus;
- audit, migrations, probes, and canonical contracts.

### Ignatious

- private candidate-byte retrieval and digest proof;
- immutable package validation;
- exact/equivalent/similar comparison against supplied project targets;
- project-scoped stable skill identity and first immutable version;
- idempotent prepare, publish, and lookup receipts;
- publication-scoped service authentication and authoring-tool exclusion;
- pinned contracts, operational persistence, and adapter tests.

## Implementation-plan requirements

The implementation plan must:

- sequence integration after the final Part A and Part B commits rather than copy their in-progress workspace changes;
- identify every schema, parser, API, SQL, and test location that persists or validates `skillId + versionId + digest`;
- include a regression test proving execution-facing consumers cannot substitute a newer version or name lookup for the pinned binding;
- preserve the versioned `inputs` array while implementing exactly one text input in schema version 1;
- keep publication processing free of leases, fencing, distributed locks, and a new queue framework;
- split Conductia and Ignatious work at the published OpenAPI boundary;
- include the compatibility and local recovery commands required before rollout.
