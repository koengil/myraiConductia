# Durable skill authoring and generation handoff: design

**Status:** Approved design for sub-project B, amended by the [2026-09-11 MVP slimdown](2026-09-11-durable-skill-authoring-slimdown.md), which wins on conflict

**Date:** 2026-09-09

**Repositories:** Conductia and Ignatious

**Depends on:** Ignatious owner approval and durable operational database verification

**Source decisions:** [project rail skill authoring map](../../../.scratch/project-rail-skill-authoring/map.md), tickets [02](../../../.scratch/project-rail-skill-authoring/issues/02-draft-ownership-and-publishing.md), [04](../../../.scratch/project-rail-skill-authoring/issues/04-durable-authoring-boundary.md), [07](../../../.scratch/project-rail-skill-authoring/issues/07-builder-dialog.md), and [10](../../../.scratch/project-rail-skill-authoring/issues/10-generation-handoff.md)

## Objective

Give an authorized internal project member a private, durable skill-authoring dialog that survives close, refresh, disconnection, simultaneous tabs, and service restarts. Conductia owns the complete authoring record. An Ignatious-hosted worker performs generation behind a replaceable provider contract and durably delivers response events back to Conductia.

This sub-project ends when the author can reach a validated skill candidate in the preview. It defines the publication-facing interface and its UI states, but it does not publish a skill or create a rail step. Sub-project C owns that operation.

Part B is therefore demoable but not independently shippable.

## Evidence from the current systems

The design does not extend the current bench flow by assumption.

- Conductia's current `POST /api/v1/deals/:dealId/bench/chat` route forwards an Ignatious stream for the lifetime of one browser request.
- `BenchChat` keeps its transcript and conversation identifier in React state and exposes model and skill-library controls that do not belong in banker-facing authoring.
- `BenchStepRunner` persists only a conversation ID, run ID, status, and start time on `deal_steps`. Those fields cannot represent a private draft, immutable messages, retries, ordered events, candidates, or simultaneous-tab conflicts.
- Ignatious at source commit `8f3ef35efd7242f18d48bd4e2e46516d2e457653` can continue a stream after browser disconnection and replay a bounded run, but it has no inspected duplicate-safe request admission, fenced worker ownership, durable delivery outbox, or unpublished structured candidate contract.
- Ignatious remains the backend that creates, validates, and stores skill packages. Its current `create_skill` and `commit_skill_version` tools cannot be reused unchanged because they write immediately into the live skill library. Part B adds a draft-only Ignatious authoring API/adapter that creates private candidates without publishing them; Part C later uses an idempotent Ignatious preparation operation for the exact candidate Conductia authorizes.

The complete upstream findings are in [Ignatious project skill authoring: source contract findings](../../06-research/2026-09-08-ignatius-project-skill-authoring.md).

## Scope

Part B delivers:

- one private active skill-authoring draft per author and project;
- durable editable metadata and unsent composer text;
- immutable submitted messages and retry history;
- one nonterminal generation attempt per draft;
- a Conductia-owned work inbox with leases and fencing generations;
- an Ignatious authoring worker with durable idempotent admission, context checkpoints, private candidates, and a delivery outbox;
- authenticated internal Conductia operations for claim, lease, context, and event ingestion;
- a recoverable builder dialog with the approved chat and preview layout;
- archived draft behavior;
- a provider-neutral publication interface that remains unavailable until Part C;
- feature gating, audit metadata, contract tests, local database probes, and cross-service recovery verification.

## Out of scope

- Publishing a candidate, activating a runnable skill, or inserting a rail step.
- Editing a published skill.
- Running a published skill or storing its results.
- Browsing discarded drafts.
- Cancelling an accepted generation because the dialog closed or the draft was discarded.
- Background completion notifications outside the dialog.
- Model selection, provider selection, raw tool traces, cost display, or provider conversation controls in the banker interface.
- Moving either service to a new hosting platform.
- Claiming exactly-once model or tool side effects across every crash boundary.

## Product and network boundary

Every product request goes through APIs implemented in the Conductia repository.

- The browser calls Conductia only.
- The browser never receives an Ignatious URL, API key, provider conversation ID as authority, or model credential.
- The Ignatious worker claims work, renews leases, reads scoped context, and delivers events through authenticated Conductia internal APIs.
- Ignatious calls its model provider as runtime egress. That call is not browser or product API traffic.

The new browser routes belong to the versioned platform REST layer beside `ConductiaAPI`. Draft persistence, authorization, and durable operations are platform state, not M&A content fixtures.

## Domain model

### Authoring draft

The aggregate for one author's private authoring conversation in one project. It owns mutable metadata, acknowledged composer text, immutable messages, attempts, visible response history, and its current skill candidate.

At most one draft may be active for an author and project. Active and archived drafts have no automatic expiry. Closing or refreshing does not change lifecycle. Losing project access preserves the draft but makes it unavailable until access and permission return.

### Composer text

Mutable, unsent text stored on the draft. Autosaving it never submits it to the model. It becomes an authoring message only through the explicit Send operation.

### Authoring message

One immutable submitted instruction. A stable client message ID makes submission retryable. A failed generation retry remains attached to the same message.

### Generation attempt

One provider execution for one authoring message. An attempt is also the durable provider operation identity. A draft may have only one queued, running, or reconciling attempt at a time.

### Skill candidate

An unpublished, validated skill package proposal. Conductia stores its provider-neutral identity, immutable digest, schema version, preview, and originating draft revision. Ignatious stores its private immutable package bytes. A candidate is not discoverable in the live skill library and is not runnable.

### Archived draft

An explicitly discarded draft retained as private history and for recovery bookkeeping. It cannot accept edits, messages, retries, or publication. Part B provides no author-facing archived-draft browser. An already accepted attempt may finish into its history but cannot make the draft active or select a publishable current candidate.

## Ownership and authorization

Starting, reading, editing, observing, retrying, and discarding a draft require all of:

1. an authenticated Conductia user;
2. current access to the project;
3. internal project-member classification;
4. `company:deals:steps:structure` for the project's bank company;
5. authorship of the draft.

Part B reuses the structural permission established by sub-project A. It does not add a second skill-authoring permission. External project members gain no authoring access. Other internal users with the structural permission cannot inspect or take over another author's draft.

This is a schema-ordering dependency, not a dependency on Part A's rail behavior. The Conductia portion of Part B starts after the migration defining `company:deals:steps:structure` is available. If both implementations overlap, that permission must land once in a shared prerequisite commit rather than in two competing migrations. Ignatious implementation does not wait on that schema change.

Access loss blocks browser reads and mutations without deleting or transferring data. If access and permission return, the original author can resume the active draft. Delivery of events already produced for an admitted attempt remains allowed because capture does not authorize a new project read or product action.

## Conductia persistence

All authoring tables have RLS enabled and no direct authenticated-browser write path. Route handlers authenticate and authorize, then call narrow database functions with the service client. Multi-row author mutations use `security definer` plpgsql functions that begin by locking the `deals` row with `select ... for update`, following the existing `create_deal_gate0` discipline.

### `skill_authoring_drafts`

One row per retained draft.

| Field | Meaning |
|---|---|
| `id` | Stable UUID. |
| `deal_id` | Owning project. |
| `author_id` | Sole user allowed to read the conversation. |
| `status` | `active`, `archived`, or the Part C terminal value `published`. Part B performs only `active -> archived`. |
| `name` | Editable proposed step name. |
| `phase_index` | Selected rail phase, nullable until chosen. |
| `placement_kind` | `phase_start`, `phase_end`, or `after`, nullable until chosen. |
| `anchor_deal_step_id` | Stable project-step anchor when placement is `after`. |
| `composer_text` | Last acknowledged unsent text. |
| `edit_revision` | Monotonic optimistic-concurrency revision for author edits and message admission. |
| `current_candidate_id` | Latest valid candidate selected for the active draft, if any. |
| timestamps | Created, updated, archived, and future published times. |

A partial unique index on `(deal_id, author_id)` where `status = 'active'` makes concurrent first opens return one draft.

`edit_revision` changes only for user-authored metadata/composer mutations and message admission. Worker events have a separate cursor and do not manufacture composer conflicts.

### `skill_authoring_messages`

Immutable logical user messages.

- Each message has a stable UUID, draft ID, author ID, monotonically assigned draft ordinal, exact submitted text, client message ID, admitted edit revision, and timestamp.
- `(draft_id, client_message_id)` and `(draft_id, ordinal)` are unique.
- Reusing a client message ID with identical content returns the existing receipt. Reusing it with different content returns conflict.

### `skill_authoring_attempts`

Generation and retry history.

- Each attempt has a UUID that is also its provider operation key, draft ID, message ID, attempt number, optional retry request ID, status, immutable context watermark, captured-through sequence, optional terminal last sequence, safe error code/message, and timestamps.
- Status is `queued`, `running`, `reconciling`, `succeeded`, or `failed`.
- A partial unique index on `draft_id` for `queued`, `running`, and `reconciling` enforces one nonterminal attempt across tabs and requests.
- Retry request IDs are unique within the logical message. An identical replay returns the existing attempt; conflicting reuse fails.

### `skill_authoring_work`

The Conductia-owned durable inbox.

- One row belongs to one attempt.
- It stores availability, next eligible time, provider, deployment, lease owner, lease expiry, and a monotonically increasing fencing generation.
- Claiming locks an eligible row, increments the generation, records the owner and expiry, and moves the attempt to `running` or `reconciling`.
- Expired ownership is never silently treated as permission to start a second provider operation. The successor must reconcile by attempt ID.

### `skill_authoring_events`

The immutable Conductia event journal.

- Identity is `(attempt_id, sequence)`.
- Event types exposed to the product are `text_delta`, `candidate`, `terminal_success`, and `terminal_error`.
- Each event stores a canonical payload digest. An identical duplicate is acknowledged; a different payload at the same identity is rejected and audited.
- Events may arrive out of order and remain stored. Only the highest contiguous sequence is exposed as ordered progress.
- A terminal event declares `last_sequence`. An attempt becomes succeeded or failed only when every event through that sequence is present.
- Raw chain-of-thought, provider credentials, and unrestricted tool traces are not accepted as product events.

User-visible assistant responses are reconstructed from immutable contiguous events. Conductia therefore retains the complete visible conversation independently of provider replay limits.

### `skill_authoring_candidates`

Private structured candidates produced by successful attempts.

- The row records candidate ID, draft ID, attempt ID, provider-neutral artifact reference, content digest, schema version, originating draft edit revision, and preview fields for name, purpose, expected input, and expected output.
- The artifact reference is opaque to the browser and has no authority by itself.
- Candidate insertion is idempotent by candidate ID and digest.
- A candidate becomes `current_candidate_id` only after its containing attempt has reached terminal success and the draft is still active.
- A candidate delivered after discard remains retained for history but cannot become current.

## State transitions

### Draft

```text
active -> archived
active -> published     Part C only
```

Archived and published are terminal for authoring. Closing the dialog is not a state transition.

### Attempt

```text
queued -> running -> succeeded
queued -> running -> failed
queued -> failed
queued -> running -> reconciling -> running
queued -> reconciling -> running
running -> reconciling -> failed
running -> reconciling -> succeeded
```

An expired lease or ambiguous provider admission enters `reconciling`, not `failed`. Explicit Retry is available only after the attempt is known failed.

## Browser API

All routes require the `skill_authoring` flag and the ownership checks above. When the flag is off, they return 404.

### Get or create current draft

`POST /api/v1/deals/:dealId/skill-drafts`

Atomically returns the author's existing active draft or creates one. Concurrent requests converge on the partial unique constraint. Archived drafts are ignored, so Add step after discard creates fresh state.

### Restore a draft

`GET /api/v1/deals/:dealId/skill-drafts/:draftId`

Returns:

- draft identity, lifecycle, editable metadata, acknowledged composer, and `editRevision`;
- ordered user messages and assistant response states;
- current nonterminal attempt, if any;
- current candidate preview, if any;
- publication capability with `available: false` in Part B;
- the current incremental event cursor.

Provider operation internals and artifact references are not returned.

### Autosave editable state

`PATCH /api/v1/deals/:dealId/skill-drafts/:draftId`

The body contains `expectedEditRevision` and any changed name, placement, or composer fields. An exact revision updates the row and increments the revision. A stale revision returns conflict with the latest safe draft state; it never overwrites acknowledged text.

A client that loses the PATCH response reads the draft before deciding whether to retry. If the desired value is already authoritative, no second mutation is needed.

### Submit a message

`POST /api/v1/deals/:dealId/skill-drafts/:draftId/messages`

The body contains exact text, stable `clientMessageId`, and `expectedEditRevision`. One database transaction:

1. rechecks authorization and active lifecycle;
2. rejects a different nonterminal attempt;
3. records or recovers the immutable logical message;
4. records the pending attempt and work item;
5. clears only the composer revision whose exact text was submitted;
6. returns the message and attempt receipt.

The request succeeds only after all three durable records exist. Provider availability is not part of acceptance.

### Retry a failed message

`POST /api/v1/deals/:dealId/skill-drafts/:draftId/messages/:messageId/retry`

The body contains a stable `retryRequestId`. The function verifies that the latest attempt is known failed, then creates a new attempt and work row for the existing message. Prior partial responses remain visible as attempt history.

### Read incremental activity

`GET /api/v1/deals/:dealId/skill-drafts/:draftId/events?after=:cursor`

Returns newly contiguous Conductia-persisted events plus the next cursor and current attempt summary. Polling is sufficient for v1. The client backs off when no work is active and stops when the dialog closes. Reopening first restores the authoritative draft, so correctness never depends on a browser poll remaining alive.

### Discard

`POST /api/v1/deals/:dealId/skill-drafts/:draftId/discard`

The body contains `expectedEditRevision`. The transaction archives the active draft after one confirmed user action. It rejects a future Part C saving or reconciling publication, but it does not cancel an already admitted generation attempt. New author actions are rejected after archival.

## Internal worker API

The internal namespace is implemented in Conductia:

- `POST /api/v1/internal/skill-authoring/work/claim`
- `POST /api/v1/internal/skill-authoring/attempts/:attemptId/lease`
- `GET /api/v1/internal/skill-authoring/attempts/:attemptId/context`
- `POST /api/v1/internal/skill-authoring/attempts/:attemptId/events`

### Service authentication

Ignatious uses a dedicated opaque bearer credential stored in each service's secret configuration. Conductia maps that credential to the fixed `ignatious` provider and an allowed deployment. The caller cannot select a tenant, project, author, or provider in request data.

The credential supports rotation with an overlap window. Authentication comparisons are constant-time, failures are rate-limited and audited, and no value is logged. A future multi-provider registry may replace configuration, but it is not required for v1.

### Claim

The worker supplies its deployment-scoped worker ID and supported contract version. Conductia:

1. selects one eligible row for that credential's provider/deployment;
2. locks and fences it in one transaction;
3. rechecks the author's current access before a queued attempt starts;
4. returns attempt ID, fencing generation, lease expiry, immutable context watermark, current candidate preview, checkpoint version, and recent history.

If access was lost before initial execution, Conductia records a system-origin terminal failure without releasing project context. That local transition writes the same visible terminal event shape as a provider failure and sets a complete local sequence, so the event-journal invariant still holds. If the operation had already started, event delivery remains permitted, but the worker cannot obtain new restricted context after access loss.

When `skill_authoring` is disabled, browser admission stops immediately. Claim remains available only to drain work already durably admitted before disablement. Renewal and delivery remain available for those attempts, so disabling the feature cannot strand an accepted response.

### Lease and fencing

Lease renewal requires attempt ID, worker ID, and current fencing generation. A stale owner receives conflict.

The fencing generation is enforced twice:

- Conductia rejects stale renewals and deliveries.
- Ignatious stores the highest generation for the operation and requires it for provider admission, checkpoint advancement, and outbox append.

A stale process may finish an external model call, but it cannot commit new operation state or product events after ownership moves.

### Scoped context

Each attempt captures a message watermark and candidate identity at admission. The claim response includes recent history. If the worker needs older history, it pages through the context endpoint using its live lease. That endpoint exposes only the immutable authoring history for the claimed attempt and never grants general project access.

Context retrieval uses the stored watermark, not the draft's newest mutable state. A later browser edit or response cannot change an already admitted attempt's input.

### Event delivery

Ignatious sends one or more ordered events with attempt ID, fencing generation, sequence, payload digest, and contract version. Conductia locks the attempt, validates the batch, inserts new events, detects conflicting duplicates, advances the contiguous acknowledgement, and applies a terminal transition only after all required sequences exist.

The response returns the highest contiguous persisted sequence. That acknowledgement is the only authority for Ignatious outbox cleanup.

## Ignatious worker and storage

Part B adds an authoring mode to the existing long-lived skill-bench service. It does not create another hosting platform.

### Durable operation admission

An `authoring_operations` record is unique by Conductia attempt ID. It stores provider/deployment identity, status, highest fencing generation, immutable context watermark, context checkpoint version, and timestamps.

Receiving the same attempt again returns or reconciles this operation. It does not invoke a new logical turn. The existing request-bound `/v1/bench/chat` admission path is not reused for this guarantee.

### Durable delivery outbox

Every product event is written to an `authoring_event_outbox` table before callback delivery. Identity is operation plus sequence and payload digest. Delivery retries with backoff until Conductia acknowledges that sequence. Replay-cache cleanup, browser disconnection, process restart, or callback failure cannot remove unacknowledged rows.

The operational Postgres database is a required dependency for authoring mode. In-memory fallback may support unrelated development flows, but it must refuse to advertise or start durable Conductia authoring.

### Private candidate storage

Authoring uses a provider adapter that can validate and store immutable candidate packages in a private namespace. It cannot call the current live-library `create_skill`, `commit_skill_version`, generic upload, or name-based replacement paths.

The worker reaches that package service through the new Ignatious draft-only authoring API/adapter. Ignatious therefore remains responsible for creating the skill package; Conductia remains the only browser-facing API and the authority for whether that package may later be published.

Candidate storage returns a provider-neutral artifact reference and content digest. Only the later Conductia-authorized Part C flow may invoke the idempotent Ignatious preparation operation and bind that exact artifact to a project step. A model tool call alone cannot publish it.

### Context checkpoints

Ignatious stores a versioned checkpoint containing a compressed context representation, its Conductia message watermark, and the candidate identity it summarizes. The adapter combines that checkpoint with recent messages and the current admitted instruction. It may fetch older history from Conductia when needed.

Checkpoint advancement cannot delete or modify Conductia history, omit the current instruction, or silently replace the selected candidate. Recovery uses the checkpoint version pinned to the operation.

## End-to-end data flow

1. Add step calls Conductia to get or create the author's active draft.
2. The dialog renders only Conductia state and autosaves metadata and composer edits with optimistic revision checks.
3. Send transactionally records the message, attempt, and work row before returning accepted.
4. The Ignatious worker claims the attempt through Conductia, obtains a fencing generation and immutable context, and durably admits the attempt ID once.
5. The worker generates under authoring-only tools. It persists response deltas and any validated candidate into its delivery outbox.
6. The delivery loop posts event batches to Conductia until acknowledged.
7. Conductia appends events, advances contiguous progress, and marks the attempt terminal only when complete.
8. The open dialog polls Conductia. A closed dialog does nothing; reopening restores the same authoritative state.
9. A successful active attempt may select a new current candidate. An archived draft retains the response but selects nothing.
10. Part B stops at a valid preview. Part C later submits the exact candidate ID and digest through a separate publication operation.

## Builder dialog

The approved low-fidelity source is [skill builder dialog outline](../../../.scratch/project-rail-skill-authoring/assets/skill-builder-dialog-outline.md).

### Entry and layout

- Add step appears at the top-right of the rail Full Array view when `skill_authoring` is enabled and the user is eligible.
- Opening it restores the active draft or creates one.
- Editable step name, phase, and position appear above the body.
- Desktop uses conversation on the left and skill preview on the right.
- Narrow layouts place preview below conversation while keeping footer actions reachable.
- The footer contains Save skill and add step, Close, and a visually separate Discard draft action.

### Deliberate replacement of `BenchChat`

`SkillBuilderDialog` and its state hook are new authoring components. `BenchChat` is not reused because it owns a browser-local transcript, addresses the provider stream directly through a request, exposes model/library controls, and treats restart as deletion of local conversation identity.

Shared presentation primitives such as Markdown rendering and Workbench modal styles may be reused without importing bench state semantics.

### Visible states

| State | Required behavior |
|---|---|
| First open | Empty conversation, editable metadata, preview placeholder, Save unavailable. |
| Restored | Acknowledged composer, transcript, candidate, and active attempt come from Conductia. |
| Autosaving | Show Saving until Conductia acknowledges; never label local-only text Saved. |
| Conflict | Preserve local text and offer Keep mine or Reload saved. |
| Queued | Show that the message is safely queued, even if Ignatious is unavailable. |
| Generating | Show contiguous partial response; disable another Send; Close remains available. |
| Reconnecting | Continue reading Conductia state; do not start a provider turn. |
| Failed | Preserve submitted message and partial response; show Retry for that message only. |
| Valid candidate | Show candidate name, purpose, input, output, and Ready to save. |
| Discarded | Close the dialog after confirmation; the next Add step starts fresh. |
| Published history | Defined as future read-only behavior for Part C; no Send or Save. |

### Close and navigation

Close, X, and Escape use the same path. They immediately flush dirty composer state. If the save fails or conflicts, the dialog remains open and explains that the latest text is not durable. Browser navigation or refresh uses the standard unsaved-changes warning while a mutation is unacknowledged.

Once edits are acknowledged, closing is immediate even while generation runs. Closing never cancels, discards, or publishes.

### Preview and Save boundary

Text deltas may be visible while generation runs, but the preview changes only from a validated candidate event belonging to a terminally successful attempt. A malformed or partial package never becomes Ready to save.

Part B renders Save skill and add step as unavailable with clear internal-demo copy. The component contract already accepts future publication state and result data, but no Part B route pretends publication succeeded and no rail step is created.

## Failure and recovery rules

| Situation | Required outcome |
|---|---|
| Conductia database write fails before admission | Send fails; no accepted message is claimed. Composer text remains visible. |
| Ignatious unavailable after admission | Attempt remains visibly queued and is claimed after recovery. |
| Two tabs submit different messages | One wins the database constraint; the other receives the active attempt and preserves its local text. |
| Same message request is replayed | Identical ID/content returns the original receipt; conflicting reuse fails. |
| Worker loses claim response | It claims again and reconciles by the same attempt ID. |
| Lease expires before provider admission | New owner increments the fence and admits the same operation key once. |
| Lease expires during execution | Old owner cannot checkpoint or append events; new owner reconciles the existing operation. |
| Conductia loses an event response | Ignatious redelivers; identical events acknowledge without duplication. |
| Events arrive out of order | Store them, expose only contiguous progress, and keep the attempt reconciling until gaps arrive. |
| Same sequence has different payload | Reject, audit, and hold reconciliation. Do not choose one silently. |
| Terminal event arrives before a gap | Do not mark terminal until every sequence through `last_sequence` exists. |
| Provider replay cache expires | Ignatious outbox and operation database remain the recovery source. |
| Generation fails after partial text | Preserve the message, partial attempt, and safe error; explicit Retry creates another attempt. |
| Autosave response is lost | Read authoritative draft, then reconcile rather than blindly overwrite. |
| Access is lost while queued | Do not release project context or start generation. Preserve the draft. |
| Access is lost while running | Allow already-produced event delivery; deny additional project-context reads and new actions. |
| Draft is discarded while active | Accepted attempt may finish into archived history but cannot reactivate or select a current candidate. |
| Feature flag is disabled | Stop new browser admission; drain, renew, and capture work already admitted before disablement. |

## Feature flag and fallback

Add `skill_authoring` to `src/lib/flags/keys.ts`.

- Flag off: Add step is absent and browser authoring routes return 404.
- Flag on: eligible authors may use the durable flow.
- Existing bench chat and rail behavior are unchanged in either state.
- Internal claim drains work admitted before the flag was disabled, but no new browser admission occurs. Lease renewal and event delivery remain enabled for those attempts.

There is no old authoring implementation whose data shape should be faked as a fallback. The reusable seam is the typed browser client consumed by `SkillBuilderDialog`; tests may supply an in-memory implementation, while production supplies the Conductia HTTP implementation.

## Security and audit

- Browser authorization is derived from the session and database relationships, never request-supplied author, company, provider, or conversation identity.
- Draft responses are author-private even from other project members with structural permission.
- Internal context is scoped to one leased attempt and immutable watermark.
- Worker callbacks authorize capture of an already-authorized operation only. They cannot publish, create a step, read arbitrary project data, or change permissions.
- Candidate artifact references and provider identifiers are never authority and are not exposed to the browser.
- Audit records capture draft creation, discard, message admission, attempt transitions, lease takeover, conflicting event identity, access denial, and candidate selection.
- Audit metadata contains IDs, actor/service identity, state changes, and correlation data. It excludes composer text, transcript content, candidate package bytes, secrets, and raw model traces.
- Logs use safe error codes and correlation IDs. Banker-facing responses do not reveal worker identities, internal endpoints, provider storage, or stack errors.

## Contract ownership

Conductia owns a provider-neutral OpenAPI contract for the internal worker operations and event schemas. Ignatious checks in a pinned snapshot with its source Conductia revision and validates its client and event producer against it.

Each repository's normal CI remains independent. Before rollout, a cross-repository compatibility command compares the Ignatious snapshot with Conductia's canonical contract and runs the end-to-end fixtures. Contract drift blocks enablement.

Provider-specific folder paths, trace objects, and model SDK types may exist behind the Ignatious adapter but cannot enter the canonical contract.

## Verification

### Conductia hermetic tests

Run in the normal `npm test` lane:

- route flag, authentication, internal classification, permission, and author-privacy gates;
- get-or-create convergence and response normalization;
- autosave acknowledgement, lost-response reconciliation, and stale-tab Keep mine/Reload saved behavior;
- message and retry idempotency responses;
- queued, generating, reconnecting, failed-partial, valid-candidate, and archived dialog states;
- Close/X/Escape flush behavior and navigation warning;
- polling reducer behavior for duplicate, gap, and terminal events;
- Add step visibility and the unavailable Part B Save boundary;
- a browser-network assertion that all authoring calls target Conductia paths.

### Conductia database probe

Add `supabase/tests/skill_authoring.sql` with a `tests/db/skill-authoring.test.ts` wrapper. It follows the existing `RUN_DB_TESTS=1` and `DATABASE_URL` opt-in and refuses hosted databases.

Required checks:

- one active draft per author/project under concurrent creation;
- author privacy and structural permission enforcement;
- access loss and restoration;
- atomic message, attempt, and work admission;
- identical and conflicting client message ID reuse;
- one nonterminal attempt per draft;
- retry identity and preservation of prior attempts;
- optimistic metadata/composer conflicts;
- serialized discard and rejection of later author actions;
- candidate delivery after discard cannot become current;
- lease claim and monotonic fencing generation;
- stale renewal and stale event rejection;
- identical duplicate and conflicting duplicate events;
- out-of-order storage with contiguous acknowledgement;
- terminal gap handling;
- feature shutdown prevents new admission while already-admitted work can still be claimed and captured.

### Ignatious tests

Using its operational Postgres test path:

- durable admission is unique by Conductia attempt ID;
- a lost claim response does not start a second operation;
- process restart recovers admitted and running operations;
- the highest fencing generation gates admission, checkpoints, and outbox append;
- stale workers cannot commit after ownership moves;
- context checkpoints remain pinned to the admitted watermark;
- authoring mode cannot invoke live-library publication tools;
- private candidate bytes and digest remain stable;
- every event is durable before delivery;
- redelivery survives callback failure, restart, and replay-cache expiry;
- acknowledged outbox cleanup never removes unacknowledged rows.

### Cross-service local verification

Run both services with disposable local databases and no hosted Supabase configuration. Verify:

- duplicate browser Send;
- simultaneous tabs;
- Ignatious unavailable at admission;
- lost worker claim response;
- worker restart before and after provider admission;
- lease takeover with a stale old worker;
- duplicate and out-of-order delivery;
- lost Conductia acknowledgement;
- event delivery after replay-cache expiry;
- access loss while queued and running;
- discard during generation;
- partial response followed by explicit Retry;
- no publication or live skill-library entry at any point.

Runtime verification against hosted infrastructure remains a user-controlled rollout action and is not part of implementation completion.

## Rollout gates

The feature must remain disabled until all of these are true:

1. the Ignatious owner explicitly accepts the worker, durable database, private candidate, fencing, and outbox responsibilities;
2. deployed Ignatious configuration proves operational Postgres is mandatory and healthy for authoring mode;
3. Conductia migrations and the guarded local database probe pass;
4. both repositories pass their hermetic suites;
5. the cross-repository contract snapshot matches;
6. service credentials are configured and rotation is exercised;
7. restart, stale-worker, replay-expiry, and access-loss scenarios pass in the local cross-service test;
8. Part C implements and verifies publication before any user-facing rollout.

## Repository responsibilities

### Conductia

- migrations, RLS, database functions, and permissions enforcement;
- canonical draft/message/attempt/event/candidate history;
- work claim, fencing, scoped context, and event-ingestion APIs;
- canonical internal OpenAPI contract;
- typed browser client, polling state, and builder dialog;
- feature flag, audit metadata, and local database probe.

### Ignatious

- background authoring worker in the long-lived skill-bench service;
- durable operation admission keyed by Conductia attempt ID;
- fencing enforcement inside the execution coordinator;
- versioned context preparation and checkpoints;
- authoring-only tool policy and private immutable candidate storage;
- durable event outbox, retry, and acknowledgement cleanup;
- pinned Conductia contract snapshot and consumer verification.

Neither repository may claim Part B production-ready on its own. The implementation plan must sequence both repositories and keep Part C publication separate.
