# Durable skill authoring: MVP slimdown

**Status:** Approved by the user on 2026-09-11 (decisions D1 to D4 below)

**Amends:** [Durable skill authoring and generation handoff: design](2026-09-09-durable-skill-authoring-design.md). Where they conflict, this document wins.

**Repositories:** Conductia (PR #151) and Ignatious (PR #126). Part C (skill publication) rebases onto the result.

## Why

Conductia is an MVP with few users. The 2026-09-09 design paid for exactly-once delivery across worker crashes, lease takeovers, concurrent tabs and adversarial callers. That payment is about three quarters of the Part B code: a separate Ignatious worker, a claim/lease/context/events internal API, fencing generations, payload digests, an outbox, an OpenAPI byte contract, audit detail validators, client response validators, and a client event reducer. The product need is smaller: an author opens a private draft from the rail, chats with Ignatious, sees the reply stream in, sees the candidate preview, and finds the draft again after a reload.

## Decisions

- **D1.** Conductia's server calls Ignatious directly. The worker, its internal API and its fencing protocol are removed. **The browser never calls Ignatious; it calls only Conductia `/api/v1` routes.**
- **D2.** The 300-line and 30-lines-per-function gate from the implementation process is dropped. The repository's normal lint, Prettier and TypeScript checks apply.
- **D3.** Removed behaviour: the multi-tab conflict prompt, the unload guard, exactly-once event delivery, the flag-off drain cutoff, and the audit detail validators. Plain audit rows stay.
- **D4.** Part B slims first. Part C pauses, then rebases once and drops the guardrails it copied.

## Architecture

```text
Browser ──/api/v1──▶ Conductia route ──RPC──▶ Supabase (drafts, messages, attempts, candidates)
                          │
                          └─ after() ─▶ runAuthoringTurn ──HTTPS NDJSON──▶ Ignatious skill-bench
                                              │                              POST /v1/bench/authoring/turns
                                              └─ record_progress / complete / fail RPCs
```

1. `POST .../messages` (or `.../retry`) admits the message and a `running` attempt in one transaction, returns the receipt, and, only when the attempt was newly created, schedules `runAuthoringTurn(attemptId)` with Next's `after()`.
2. `runAuthoringTurn` loads the turn context, calls Ignatious, streams the NDJSON response, writes the accumulated reply text to the attempt about every 500 ms, and finishes the attempt as succeeded (with the last candidate) or failed.
3. The browser polls `GET .../skill-drafts/:draftId` every second while an attempt is active and every 10 seconds otherwise.

`after()` is not durable: a deploy, crash or timeout ends the turn. The stale-attempt rule below turns such an attempt into a retryable failure without a sweep job.

## Ignatious authoring turn API

`POST /v1/bench/authoring/turns`, mounted inside the skill-bench app so the ALB forwards it and the existing `x-api-key` guard authenticates it. Conductia sends the same `IGNATIOUS_API_KEY` it already uses for the bench. No separate authoring service token exists.

Request body:

```json
{
  "attemptId": "uuid",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "message": "the admitted user message",
  "currentCandidate": { "name": "...", "purpose": "...", "expectedInput": "...", "expectedOutput": "..." }
}
```

`currentCandidate` is `null` when the draft has none.

Response: `200`, `content-type: application/x-ndjson`, one JSON object per line, in this order:

- zero or more `{"type":"text","text":"..."}`;
- zero or more `{"type":"candidate","providerCandidateId":"uuid","contentDigest":"64 hex","schemaVersion":1,"preview":{"name":"...","purpose":"...","expectedInput":"...","expectedOutput":"..."}}`, where the last one wins;
- exactly one terminal line: `{"type":"done"}` or `{"type":"error","code":"generation_failed","message":"Generation could not complete. Try again."}`.

Before the stream starts: `400` for an invalid body, `401` from the key guard, `503` when the candidate store is not configured. The model call is tied to the request's abort signal.

Candidate bytes stay in Ignatious. The candidate tool validates and packages the skill, then inserts it into `skill_authoring.authoring_candidates` in the skill-bench Postgres, idempotent on `provider_candidate_id`, keeping `package_bytes`, `content_digest` and `content_fingerprint`. The provider candidate id stays `candidateIdFor(attemptId, ordinal)`. Part C's prepare and publish read this table unchanged through `PrivateCandidateReader`.

Conductia never sends the same `attemptId` twice. A retry is always a new attempt.

## Conductia schema

One migration, `supabase/migrations/20260916110000_skill_authoring.sql`, replaces every `20260909200000` to `20260909203900` file. CI applies migrations only to a local hermetic stack, and Part B was never merged. Replacing the files assumes no hosted project had them applied by hand, which the user confirms.

- `skill_authoring_drafts` and `skill_authoring_messages`: unchanged from the 2026-09-09 schema.
- `skill_authoring_attempts`: `id, draft_id, message_id, attempt_number, retry_request_id, status, response_text, last_progress_at, error_code, error_message, created_at, started_at, completed_at`. Status is `running | succeeded | failed`. One `running` attempt per draft (partial unique index).
- `skill_authoring_candidates`: `id, draft_id, attempt_id, provider_candidate_id, content_digest, schema_version, preview, created_at`, unique `(draft_id, provider_candidate_id)` and `(draft_id, id)`. The key `skill_authoring_candidates_draft_provider_digest_key (draft_id, id, provider_candidate_id, content_digest)` stays for Part C.
- Removed: `skill_authoring_work`, `skill_authoring_events`, the event cursor, admission snapshot columns, sequence gating, `reconciling`, `queued`.
- Functions, all `security definer`, execute revoked from `public`, `anon` and `authenticated`, granted to `service_role`:
  - author commands: `lock_author`, `raise_conflict`, `get_or_create_draft`, `patch_draft`, `submit_message`, `retry_message`, `discard_draft`, `read_draft`;
  - projection: `browser_draft`, `browser_messages`, `browser_attempt`, `browser_active_attempt`, `browser_candidate`;
  - turn: `attempt_live`, `run_context`, `record_progress`, `complete_attempt`, `fail_attempt`;
  - audit: `write_audit`.
- Every author read and write still locks and authorizes through `lock_author` (membership, not external, structure permission) and filters by `author_id`. Reads no longer take `for update`.

## Stale attempts

An attempt is live when `status = 'running' and last_progress_at > now() - interval '60 seconds'`. The projection reports a non-live running attempt as `failed` with `error_code = 'generation_interrupted'`. `submit_message` and `retry_message` mark a stale running attempt `failed` in the same transaction before admitting a new one. `record_progress`, `complete_attempt` and `fail_attempt` act only `where status = 'running'`, so late or repeated writes do nothing.

## Browser API

Kept routes: `POST skill-drafts`, `GET` and `PATCH skill-drafts/:draftId`, `POST .../messages`, `POST .../messages/:messageId/retry`, `POST .../discard`. Removed: `GET .../events` and every `/api/v1/internal/skill-authoring/*` route.

The draft read carries `messages[].attempts[].responseText` and `activeAttempt.responseText`. There is no `eventCursor`. The browser shows `activeAttempt.responseText` as the streaming reply.

## Audit

Plain rows through `write_audit`, ids and codes only, never message or reply text: `skill_authoring.draft_created`, `draft_archived`, `message_admitted`, `attempt_transitioned`, `candidate_selected`, `access_denied`. Turn outcomes are written with a null actor and `service_identity = 'conductia'`. The audit detail validators, the detail CHECK and `lease_taken_over`/`event_conflict` go.

## Visible behaviour changes

- A stale `PATCH` returns `409` with the server draft. The client adopts the server revision, re-applies unsent local field edits and saves once more. No conflict prompt.
- No `beforeunload` guard.
- Send is disabled while its request is in flight. A failed send leaves the text in the composer; the next click sends with a new `clientMessageId`.
- An interrupted generation shows as failed with Retry.

Unchanged: private drafts, one active draft per author and project, autosave with Saving and Saved labels, save before send, close and discard, discard confirmation, the not-permitted view, the placement fields, the candidate preview with Save unavailable until Part C, and the dialog staying mounted while the rail reloads.

## Accepted risks

- A turn ends when the Vercel function ends. Conductia is on Vercel Pro, so the send and retry routes set `maxDuration = 300` and the turn deadline is 280 seconds; an interrupted turn becomes a retryable failure.
- Access is checked at admission, not again during a turn of a few seconds.
- An interrupted turn can leave an Ignatious candidate row Conductia never records. It is not cleaned up.
- If Ignatious is unavailable, a send fails instead of queueing.
