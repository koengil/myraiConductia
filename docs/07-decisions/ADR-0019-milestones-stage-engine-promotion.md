# ADR-0019: Milestone extraction, the stage engine and promotion

Status: Accepted, September 30, 2026, with the owner-held items in decision 8 still open
(epic #261; the deal-discovery demo path, design phases 6, 8 and 9). Decisions: D71 and
D72. Builds on [ADR-0018](./ADR-0018-deal-discovery.md) and ADR-0017 (hybrid data
residency, decisions 1, 2, 6 and 7). Runbook:
[`deal-discovery-demo-runbook.md`](../03-engineering/deal-discovery-demo-runbook.md).

## Context

A proposed deal is useful to a managing director when it says where the deal stands on the
rail and why. That needs two things from mail: which milestones happened (an NDA executed,
an LOI signed) and a rule that turns them into a station. The first is language
understanding, so it needs a model. The second must be deterministic, because an MD will
be asked why the rail says Station 44 and the answer cannot be a model's prose.

Phase 6 is also the first path that sends stored mail text to a model, so it falls under
ADR-0017 decision 6: mailbox-derived content goes only to a processor whose row in the
processor table reads Verified: Yes. No row does today.

## Decision

1. **Prompt v1 with span verification.** The model reads one message and returns JSON
   only: a list of milestones, each with a type from a closed list, the date it occurred,
   a confidence and a verbatim quote. The parser rejects a reply that is not valid against
   the schema. It also rejects any quote it cannot find in the message body, so a model
   cannot cite text that is not there. The prompt text is pinned by a hash that every
   recording carries, and a change to the text means a new recording, never an edit.
   `milestone_events` belongs to the source item, keyed by item and extractor version, and
   holds offsets, not quotes. The page cuts the excerpt from the owner-only stored text.

2. **A pure, versioned engine.** `assessStage` (`stage-engine/v1`) takes the milestone
   events on a candidate's firm or confirmed links and the rail, and returns a station, a
   lifecycle and a templated reason. No model is involved. Each milestone type maps to one
   rail step in a v1 table (`MILESTONE_STATION`): the engagement letter to `p2-s26`, a
   buyer NDA to `p3-s42`, an LOI to `p4-s48` (Station 44), a signed purchase agreement
   to `p5-s51` (Station 47), closing to `p5-s57` (Station 53). The latest mapped event
   leads, a regression event (exclusivity lapsed, round reopened) can lower it, closed wins
   for the lifecycle, and a pause or termination that nothing follows decides otherwise.
   The reason is a template, "{station title} because {milestone} on {d MMM yyyy}
   ({n} emails)", formatted from a fixed month table, never model prose. Assessments are
   inserted only when the step, lifecycle or evidence set changes, and the latest is the
   current suggestion. Correction RPCs queue a recompute through an outbox, which the
   extract worker drains. Every station number is for display: anything that moves a
   cursor or compares one uses the step id or `seq`.

3. **Recorded replies by default, and the processor gate.** The default transport is
   `recorded`, everywhere: replies are keyed by prompt version, model and content hash, and
   a miss is a failed call, never a silent empty result. A live call is possible only after
   `assertProcessorAllowed` passes, before any text is read.
   - **Verified path, any tenant.** It needs the processor in `VERIFIED_MODEL_PROCESSORS`
     and `DISCOVERY_OUTPUT_PLACEMENT_APPROVED` set `true`. Both ship closed (an empty list
     and `false`). Terms settle where content may go, and placement settles where the
     model's output may rest, so neither alone opens a real bank's extraction.
   - **Synthetic path, until then.** It needs a local Supabase URL, an app environment
     other than `prod`, a tenant in `SYNTHETIC_MODEL_TENANT_IDS`, and, item by item, a
     Message-ID in the committed synthetic corpora. An item outside them is skipped and
     never sent. A tenant id alone does not prove the mail in it is synthetic.
   - The model pin is `anthropic/claude-sonnet-5`. `DISCOVERY_EXTRACT_MODEL` overrides it
     and refuses any Covered Model, because ADR-0017 bars them for bank content.
   - The recordings are made once by the owner with the recorder, from a real model run on
     the synthetic corpus, and committed as delivered. They are never hand-written, because
     presenting invented output as model output would misrepresent the product. While the
     recording is absent, a stub built from the offline test double stands in at its own
     path and says so in the file. It is never written to the recording's path.

4. **T13, decided: the cost source for the Messages endpoint (D72).** The Messages
   endpoint returns no cost, and the generation lookup names no Messages id. So a live
   synthetic gateway call is priced from tokens with `src/lib/ai/pricing.ts` and writes
   one `ai_usage` row (source `discovery_extract`, `external_id` the response `id`). A
   recorded replay is not an external call and writes none. `ai_usage.actor_id` becomes
   nullable for `discovery_extract` only, because the worker has no user actor. This
   supersedes the architecture's Q10 sentence that cost comes from the gateway's reported
   cost, for the Messages endpoint. Revisit it if the gateway starts exposing cost for
   Messages.

5. **No unaudited row.** The worker writes through two service-role definers,
   `discovery_record_extraction` and `discovery_record_assessment`. Each writes its rows
   and its audit row in one transaction, as `deal_move_cursor` does. `model_calls` is
   service-role only with no user policy, and stores references and the parsed output,
   never the request text. Audit details carry ids and counts only.

6. **Promotion runs full Gate 0 controls.** `POST /api/v1/deals/from-discovery` uses Gate
   0's validator, the code name mask, the conflicts attestation and the MNPI screen, then a
   service-role RPC that calls `create_deal_gate0_core` unchanged. The candidate row is
   locked, so a second click returns 409 and never a second deal. The deal lands at the
   entry station the MD chooses, with earlier steps skipped, and the lifecycle and status
   come from the latest assessment and the entry phase. The MD types the code name and the
   target: deal identity entered by the banker is control metadata, and mail-derived
   identity is bank content (ADR-0017 decision 7). No dataroom is provisioned, and the
   CCO notice payload is unchanged. Storm's sign-off on tiered controls is pending (T8), so
   every promotion runs the full set.

7. **The rail marker suggests, and the MD decides.** "Evidence suggests Station 47 ·
   Signing / Announcement Prep" appears when the latest assessment's step differs from the
   deal's cursor step, compared by step id. Accept calls the rail's own `PATCH /progress`
   with the step's `seq`, which writes the existing `advance` audit row. Dismiss is the MD
   only, needs a reason, and hides the marker until a newer assessment arrives. Nothing
   moves the rail by itself.

8. **Owner-held items and their defaults.** Each default sits in one place, so a flip is
   one reviewed line.

   | Item | Default | Where it lives |
   |---|---|---|
   | T11 (a): may the new tables hold bank content in the control plane until #264? | No: they hold synthetic data only | `DISCOVERY_OUTPUT_PLACEMENT_APPROVED = false` and `VERIFIED_MODEL_PROCESSORS = []` in `src/lib/modelGateway/processorGate.ts`; each migration header says so |
   | T11 (b): does an MD's explicit pick of a mail-derived name count as banker-entered? | Yes (owner, 2026-10-22): the fields start pre-filled from the candidate, stay editable, and the MD's submit is the pick | `PREFILL_PROMOTION_FROM_CANDIDATE = false` in `src/components/discovery/PromoteDialog.tsx` |
   | T11 (c): the gateway's processor-table row | Reads No | this ADR, below |
   | T12: the candidate name in triage | No name before confirmation | `discovery_triage_list()` returns no name column (phase 7, cut) |
   | T8: tiered Gate 0 on promotion | Full controls on every promotion | decision 6 |

   **Processor-table row for ADR-0017** (added to ADR-0017 decision 6 by #462, D90; this copy is kept aligned with it):

   | Processor | Covered by | Verified: Yes | Note |
   |---|---|---|---|
   | Vercel AI Gateway, with Anthropic behind it (`vercel-ai-gateway:anthropic`) | Discovery milestone extraction; also screening and code names (ADR-0017) | **No** | Zero data retention is sent on every call from one client (`postGatewayMessages`), and the route is pinned to `anthropic`. A refusal is `zdr_unavailable`: AI is off, with no fallback, and the extract worker stops. The row reads Yes only when `npm run ai:zdr-probe` exits 0 with the production key (runbook gate G11) and #270 T1 closes with the terms confirmed in writing. |

   The row reads No until then, so a real bank's extraction stays closed under both paths.

9. **Deferred: the second half of architecture Q7 (T9).** Deal members reading colleagues'
   evidence text after promotion, audited, is not built. It needs the evidence re-pointed
   to the deal, new deal-scoped policies and changes to #262-owned helpers. Until then a
   deal member who holds no evidence sees the marker's reason and count, not the items,
   and Storm, who holds the evidence, sees all of it.

## Consequences

- The station on a proposed deal is explainable from dated milestones and a table, and
  re-running the same mail and the same recording gives the same station.
- A recording miss or a stale recording fails a test, not the journey. A corpus edit needs
  a re-recording.
- The demo runs offline. No live model call happens from CI or from an agent host.
- The new tables hold model outputs about mail and mail-derived names (`milestone_events`,
  `stage_assessments.reason_text`, `model_calls.parsed`, `corrections.before`, `after`
  and `reason`). They are bank content under ADR-0017 decision 1 and join the E1 set that
  moves to the data plane in #264. Their content is minimized (offsets, templated reasons,
  ids and counts in audit), and they hold synthetic data only until T11 (a) is answered.
- Tiered promotion, evidence re-pointing and a generation-cost lookup are follow-ups, not
  demo changes.

## Not chosen

- A deterministic cue extractor. The corpus could be written to match it, which would game
  the demo.
- Hand-written model replies, and storing redacted requests.
- Computing the station at read time. Each viewer sees different events, so the result
  would differ by viewer.
- Chaining `POST /api/v1/deals` and a second RPC, which is two transactions.

## Amendment 1 (D120): audiences, rule events and the lifecycle

Status: Proposed, 2026-10-22. Issue #173, gap G-07; decision-log entry D120, number to
confirm at merge. It amends decisions 2, 6 and 7 and revisits one "Not chosen" line. The
decisions below are built in slices 1a to 3a (branches
`feat/173-g07-1a-scoped-assessments` to `feat/173-g07-3a-rule-detector`, migrations
`20261023130100` to `20261023130500`), not yet merged. Slices 3b, 4 and 5 are planned and
held (item 6). The why is in [ADR-0026](./ADR-0026-team-inbox.md), "Station suggestions on
team mail (D120)": a deal seen only through a team inbox gets no suggestion, and team
evidence may reach only the inbox's readers.

1. **One assessment stream per audience (amends decision 2).** `stage_assessments` and
   `corrections` gain `team_mailbox_id`, a composite reference to the inbox in the row's own
   tenant, `on delete restrict`. A null row is the shared row: built from the evidence the
   candidate's readers may see today, under today's policy, unchanged. A row with an inbox id
   is built from the shared evidence plus the events only that inbox contributes, and it is
   read by no one until slice 4 opens it to that inbox's readers. Insert-on-change and
   "latest" are per candidate and audience, and the writer takes the tenant lock. A team row
   exists only while the inbox adds evidence the shared audience lacks; a tombstone (no step,
   no evidence) ends it. A purge that deletes a stream's latest row writes an audited
   tombstone and queues a recompute (trigger `purge`), so a reader never falls back to an
   older, pre-purge row. This is still not "computing the station at read time": every row
   is an audited engine output, and a reader only chooses among rows RLS already shows them.
2. **Which row a reader is shown (amends decision 7).** `preferredAssessment` drives display
   only (the candidate list, the detail and so the Promote default, the rail marker): among
   the reader's visible team rows that name a step, the one furthest along the rail, then the
   latest; with none, the latest shared row.
3. **Lifecycle from model events only (amends decisions 2 and 6).** The engine is
   `stage-engine/v2`. Each event carries a basis, `model` or `rules`. Rule events place a
   station and never set a lifecycle, so `closed`, a pause or a termination comes from model
   events only. Promotion reads the shared row only, for the lifecycle and for the audit's
   `suggestedStepId`, and opens the deal `closed` only when that row says `closed` and cites a
   model-basis `closed` event; otherwise the deal is `live`. `discovery_set_station` records
   `before.suggestedStepId` from the shared row. A dismissal of a team row is itself scoped,
   and is refused until slice 4 (orchestrator call, 2026-10-22). The entry station stays the
   MD's explicit choice, and the MD can still set the lifecycle after promotion.
4. **One rule picks an item's current events.** `discovery_current_event_ids` replaces the
   readers' "newest extractor version" pick, for the engine's inputs and, through the
   caller-bound `discovery_item_current_events`, for the timeline and evidence list. An `ok`
   model call on the item's current content wins, even with zero events, so a zero-event
   answer really means zero. Otherwise rule events count, and only through a firm approved for
   `milestone_rules`. Behaviour change: an item whose current content has no `ok` call (edited
   upstream, not yet re-extracted) now contributes nothing.
5. **A deterministic detector, measured rather than trusted (revisits "Not chosen").** This
   ADR rejected a deterministic cue extractor because the corpus could be written to match it.
   D120 adds one, `rules/v1`, for mail no model may read (ADR-0026 residual 3), and answers
   the objection with measurement, not the demo. The demo seed is the recall check only: 13
   of 13 expected events, on 13 of its 38 messages, and nothing on the other 25. Precision is
   measured on a hand-written negative corpus (105 sentences, no false match, measured
   2026-10-22) and on a held-out set the orchestrator commissioned from an author who never
   saw the rule text: 343 sentences, `tp=18 fp=1 fn=157 tn=168`, so precision 18/19 (0.95)
   and recall 18/55 (0.33) on the seven types it covers (measured 2026-10-22). The detector covers seven types; `closed`, `announced` and
   the NDA types are out of v1. It imports no model client, logs nothing, and a fence test
   pins both. It counts for a firm only once the owner approves (D120 Q2: the owner approved Ignatious on 2026-10-23, once the rehearsal shows the expected phases; the flip is an owner step), and wherever
   a settled model call exists for an item, the model wins.
6. **Slices 3b, 4 and 5 (#753, #754, #766), built once G-01 was on `develop`.** Slice 3b (`20261023130600`) adds the `milestone_detections`
   ledger, rule events with `model_call_id` null and a `detection_id`, the detect batch and
   writer, the per-firm approval check over G-01's table, and the worker's `--rules` mode and
   `detect` entrypoint. Slice 4 (`20261023130700`) lets the inbox's readers read and dismiss
   team rows through G-01's `app_reads_team_mailbox`. Slice 5 (`20261023130800`) lists each
   detection pass in the team-inbox audit trail. Each was cut only once the G-01 slice it needs
   was on `develop` (orchestrator call, 2026-10-22); none is merged yet. Until 3b merges, no rule
   event can exist, and until 4 merges, no one reads a team row.
