# Deal-discovery demo runbook

The operator checklist and presenter script for the deal-discovery demo on October 30,
2026. Storm Duncan, the MD, watches synthetic mail become proposed deals with a suggested
rail station, a templated reason and cited evidence. He corrects them, promotes Project
Kestrel into a real deal under Gate 0's controls, and sees the rail's evidence marker
follow late mail.

Decisions: [ADR-0018](../07-decisions/ADR-0018-deal-discovery.md) (deal discovery) and
[ADR-0019](../07-decisions/ADR-0019-milestones-stage-engine-promotion.md) (milestones, the
stage engine, promotion). Journey: `e2e/journeys/discovery-demo.spec.ts`.

## What is real and what is seeded

- **Seeded:** the mail, on the replay paths and the seeded dry runs. Every message, name
  and domain in `tests/fixtures/discovery/demo/corpus.json` is invented. On those paths no
  bank, person or Ignatious data is read, and no mailbox of a real firm is connected.
- **The Oct 30 demo** reads real Ignatious mail, read-only (owner decision, 2026-10-08; see
  "The demo on Ignatious's Workspace (read-only)"). Nothing is seeded into Ignatious's
  Workspace.
- **Live:** everything after the mail. Classification, routing, clustering, extraction
  (replaying recorded model replies), the stage engine, the corrections, Gate 0 and the
  rail marker all run for real on the local stack. No deal or candidate row is written by
  a seed script.
- **Not claimed:** the audit chain is not described as tamper-evident. On the seeded paths
  the mail is synthetic, so nothing there speaks to a real bank's data residency.

## One mail path per stack

A stack seeds exactly one mail path, always into the personas' tenant (`DEV_TENANT_ID`).
Seeding two paths on one stack, or seeding mail into another tenant, leaves Storm on an
empty Discovery page.

| Path | Use | Command |
|---|---|---|
| Graph fixture | Default in CI, and the fallback on the day. On every stack today. | `node --import tsx scripts/seed-discovery.ts --corpus demo` |
| Gmail replay | Built. The real Gmail reader over the committed demo twin (`tests/fixtures/discovery/demo/gmail-twin`), behind the mailbox guard. Run in CI by `E2E discovery demo (Gmail replay)`: opt-in on a pull request with the `e2e-gmail` label, on every push to `develop`, and nightly. Advisory, not a required check. | `node --import tsx scripts/seed-discovery.ts --google-replay --corpus demo --phase seeded`, into `DEV_TENANT_ID` |
| Live Gmail, test Workspace | Owner's machine only, for the seeded dry runs. Imports, never sends. See "Seeded dry runs on the test Workspace". | `node --import tsx scripts/google/seed-gmail.ts --live --confirm-domain <test domain> --seed <file> --phase seeded` |
| Ignatious's Workspace | The Oct 30 demo. Real mail, read-only: nothing is imported. See "The demo on Ignatious's Workspace (read-only)". | #344's discovery worker ([discovery-worker-aws-runbook.md](../04-operations/discovery-worker-aws-runbook.md)) |

October 30 runs on Ignatious's real mail (owner decision, 2026-10-08). Both offline paths
are built, for the dry runs and the fallback on the day. The UI is identical on all three. Only ingestion health, which Storm does not
see, names the provider.

## Fresh-stack checklist

Run this on a local Supabase stack only. The hosted credentials that a developer session
inherits (Supabase, Box, Resend, Anthropic, the AI gateway) stay out of every command. No
step below calls a hosted service.

1. **Scrub the environment.** Unset `DATABASE_URL`, `SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_*`,
   `BOX_*`, `RESEND_*`, `ANTHROPIC_*` and `AI_GATEWAY_*` for each command, then pass the
   local stack's values explicitly. `supabase status -o env` supplies them.
2. **Loopback check.** `NEXT_PUBLIC_SUPABASE_URL` must read `http://127.0.0.1:<port>` or
   `http://localhost:<port>`, and the database URL must be on the same host. If either is
   not local, stop. `enable-flags.ts` and the journey's `importLateMail` step refuse a
   non-local URL, and the seed scripts refuse `prod`. The check is yours for the rest.
3. **Reset and start.** `supabase db reset --local` on a stack that has every current
   migration. A second journey run needs a reset: the journey merges Harbor and promotes
   Kestrel, so a dirty stack fails it at beat 1.
4. **Flags, before any beat.**
   - `node --import tsx scripts/seed-flags.ts`, then `node --import tsx scripts/enable-flags.ts`.
   - `deal_discovery` must be on, or `/discovery` is a 404.
   - `company_access_management` must be on. While it is off, `app_can_create_deals`
     returns true for everyone, so Alex's "Needs deal-create authority" never shows and
     a member could promote.
   - Known issue: `supabase/tests/create_deal_gate0.sql` fails on a fresh stack while `company_access_management` is off. It is pre-existing, not caused by discovery, and not in CI.
5. **Users.** `node --import tsx scripts/seed-users.ts`, with `SEED_PASSWORD` set. Storm
   signs in as `md.intelibank@dev.com`.
6. **One mail path.** `node --import tsx scripts/seed-discovery.ts --corpus demo`. It
   needs `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SEED_PASSWORD`, because each mailbox
   owner opts in under their own session. Expect `Classified 81 items, stored 37,
   5 candidates (5 new)`.
7. **Extract.** `node --import tsx worker/extract.ts --once --strict --replies <file>`.
   Expect `"failed":0`. `--strict` exits 1 on any recording miss.
   - `<file>` is `tests/fixtures/discovery/demo/model-replies/extract.v1.json`, the owner's
     recording, when it exists.
   - Until then it is `extract.v1.stub.json`, the stub (see "If the recording is missing").
   - Without `--replies` the worker picks the same way: the recording, else the stub. It
     prints which one to stderr (`extract: replaying stub replies from <path>`), the path
     only, never content. A file named with `--replies` is used as given and never swapped.
   - The recorded transport is the default. A live call needs the owner's explicit choice
     on the synthetic tenant (see "Live model calls").
8. **Start the app** and sign in as Storm.
9. **Leave the worker running for the demo.** In a second terminal, with the same
   scrubbed environment as step 7:
   ```text
   node --import tsx worker/extract.ts --watch --replies <file>
   ```
   It repeats the extract pass every three seconds, and each pass also answers the
   recompute requests that Storm's corrections queue. See "Run the worker with --watch".

The hermetic CI job runs steps 4 to 7 in this order, then the journey.

### Gmail replay variant

The same checklist, with the mail seeded as Gmail mailboxes.

- Steps 1 to 5 are the same.
- Step 6 is `node --import tsx scripts/seed-discovery.ts --google-replay --corpus demo --phase seeded`.
  It prints one `Gmail mailbox <address> -> <email> (source created)` line per persona,
  then `Exclusion policy v1 (written).`, then `Classified 81 items, stored 37, 5 candidates (5 new).`
  The counts match the Graph path's, because the twin carries the same mail (a test pins
  the hashes and clusters).
- Step 7 is the same. The extract summary is the Graph path's as well:
  `{"path":"recorded","selected":37,"sent":37,"skippedNotSynthetic":0,"ok":37,"invalid":0,"failed":0,"assessed":5}`.
- **The phase rule.** Every Gmail replay command names its phase. A standalone worker run
  (`DISCOVERY_READER_MODE=fixture node --import tsx worker/classify.ts --tenant <DEV_TENANT_ID>`)
  reads `seeded` unless `DISCOVERY_GMAIL_REPLAY_PHASE` says otherwise. That is correct until
  the late mail. After `--phase after-imports`, set `DISCOVERY_GMAIL_REPLAY_PHASE=after-imports`
  and `DISCOVERY_GMAIL_REPLAY_DIR=tests/fixtures/discovery/demo/gmail-twin` on every
  standalone run. A run at an earlier phase than the source's checkpoint fails with
  `Gmail replay has no response for GET …/history`. The seed itself refuses an env value
  that disagrees with its flags (`DISCOVERY_GMAIL_REPLAY_PHASE=after-unspam … disagrees with
  --google-replay --corpus demo (seeded); unset it`) before any database write.
- **Late mail on this path:** `node --import tsx scripts/seed-discovery.ts --google-replay --corpus demo --phase after-imports`,
  then extract. It prints `Exclusion policy v1 (unchanged).`, then
  `Classified 2 items, stored 2, 5 candidates (0 new).` and the extract summary
  `"selected":2,…,"failed":0,"assessed":1`, as the Graph path does.
- **The stored exclusion policy.** The Gmail demo seed writes the tenant's exclusion policy
  before it classifies, so the replay loads a stored policy the way live Gmail must. The
  rules come from `tests/fixtures/discovery/demo/exclusion-policy.json`, a bare JSON list
  that holds `[]` today, so the replay skips nothing. The write goes through
  `discovery_exclusion_policy_set`, the only writer: one `discovery_exclusion_policies` row
  (`version` 1, `requested_by` `demo-seed`) and one `discovery.exclusion_policy_changed`
  audit row. A re-seed whose rules equal the current version writes and audits nothing.
  The Graph path and the base `--google-replay` seed write no policy.
  - **It writes only into a local stack.** Policy rows are append-only, so the seed refuses
    a Supabase URL that is not loopback, naming the variable (`the demo exclusion policy is
    written only into a local stack: SUPABASE_URL is not loopback`), before it creates a
    database client. A hosted `SUPABASE_URL` exported by a shell profile trips this on an
    otherwise local stack: unset it. The seed also reads and validates the rules file before
    it writes anything.
  - **It never supersedes a policy it did not write.** A stack whose latest policy has
    another `requested_by` is refused: `the tenant's exclusion policy vN was not written by
    the demo seed; reset the stack (supabase db reset --local) and seed the demo again`.
    It exits 1 before any `Gmail mailbox` line, and writes nothing.
  - **What it proves.** The seed wrote an audited row before it classified. With `[]` no
    message is skipped, so nothing records that a pass applied the policy. That the read
    path applies a stored policy (policy check, then the mailbox guard, then the reader) is
    covered by the exclusion-policy tests, not by this journey.
- **Ingestion health.** Signed in as the seeded admin (`admin.intelibank@dev.com`) or CCO
  (`cco.intelibank@dev.com`), `/discovery` shows the ingestion health panel (the admin sees
  only that panel; the CCO sees it above the proposed deals). It lists the three mailboxes,
  each labelled `Gmail mailbox` under its address, and an `Exclusion policy v1` badge. The
  `v1` is the table's highest version, not a record of the pass. Storm sees no panel and
  no provider text. This is read from the component and the page, not checked in a browser.
- **Switching paths:** a stack seeds one mail path (see above). Reset before switching.

## Run the worker with --watch

A correction does not recompute the station itself. It writes the change and queues a
recompute request for the candidate; the extract worker answers the request on its next
pass and saves a new assessment. With only `--once` run before the demo, nothing answers
the request, and a page that depends on the new assessment reads stale. With `--watch`
running, the page is right on the next reload, within about three seconds.

| Beat | Correction | What waits for the worker |
|---|---|---|
| 4 | Merge Harbor into Kestrel | Kestrel's station and reason, which now rest on Harbor's emails too |
| 4 | Set station on Kestrel | The "overridden" flag on the evidence's own suggestion beneath Storm's station |
| 4, if shown | Split emails off a deal | The new deal's station (it has none until assessed) and the original's |
| 4, if shown | Move an email to another deal | Both deals' stations |

Rename queues a recompute too, but nothing it shows depends on the answer. Reject queues
none: a rejected deal is not assessed. A request is cleared only after its assessment is saved, so a
worker that stops mid-pass picks the request up again when it restarts.

If the worker is not running, start it once (`--once`) after the correction and reload.
The journey does this itself (`e2e/steps/rerunDiscovery.ts`).

## The beats

Beat 5 is not built: phase 7 (triage) is cut because Task A's `thread_reference` route is
not on the base. The other six are in the journey.

1. **Discovery.** `/discovery` lists Project Kestrel, Project Harbor, Project Osprey and
   Project Falcon. Project Cobra is absent: only a colleague's mail found it.
2. **Kestrel.** Open it. The station card reads "Station 44 of 61 · LOI Review" with the
   reason "LOI Review because LOI signed on Sep 18, 2026 (N emails)". The milestone table
   lists the dated events, and Storm's own evidence shows the cited sentence with the
   cited span marked. The email count comes from the model's output, so never state it
   from memory.
3. **Osprey.** "Station 53 of 61 · Closing Checklist" with a Closed badge. History arrives
   closed.
4. **Correct.** On Harbor, choose Merge into, pick Project Kestrel and give a reason. The
   page reads "Merged into Project Kestrel". On Kestrel, choose Set station, pick
   "44 · LOI Review" and give a reason. The card now reads "Station set by a person", the
   evidence's own suggestion stays beneath it, and the decision history names who, what,
   when, why and the value before. Each change writes a `discovery.correction` audit row.
5. **Triage.** Not built (see above).
6. **Promote.** On Kestrel choose Promote to mandate. Type the code name
   `Project Kestrel`, the target `Northwind Robotics`, choose the entry station
   "44 · LOI Review", and type the conflicts approver. The dialog runs Gate 0's own
   controls. The rail opens with the receipt "Mandate opened from discovery" and the MNPI
   screen verdict. The deal is at Station 44, and the audit trail shows
   `discovery.candidate_promoted`.
7. **Late mail.** The deal's evidence moves, and the rail marker follows.
   ```text
   node --import tsx scripts/seed-discovery.ts --corpus demo --phase after-imports
   node --import tsx worker/extract.ts --once --strict --replies <file>
   ```
   Reload the rail. The marker reads "Evidence suggests Station 47 · Signing /
   Announcement Prep" with its reason. Nothing moved on its own. Choose "Move rail to
   station 47", which goes through the rail's own progress route and writes an `advance`
   audit row. Dismiss with a reason is the other action.

What the demo does not show: no dataroom is provisioned on promotion, and colleagues'
evidence text stays with the colleague (ADR-0019, deferred Q7 second half).

## If the recording is missing

T2's recording, `tests/fixtures/discovery/demo/model-replies/extract.v1.json`, is made once
by the owner with `scripts/discovery/record-extract-replies.ts` and committed as delivered.
It is never hand-written and never edited.

While it is absent:

- **The stub stands in.** `extract.v1.stub.json` is built from the offline test double
  (`tests/helpers/demoReplyTable.ts`) by `node --import tsx tests/helpers/stubReplies.ts`.
  It says what it is in its `provenance` field and in `provider: "stub"`. It is never
  written to the recording's path, and CI fails if it drifts from the corpus
  (`stubReplies.ts --check`).
- **The journey runs on it.** `e2e/support/recording.ts` picks the recording when it
  exists and the stub otherwise. Beats 2, 3 and 7 assert an extracted station, so they
  carry a `pending-t2-recording` annotation in the Playwright report. They are pending,
  not passed, as checks on the recording.
- **`tests/discovery-demo-recordings.test.ts`** reports its recording checks as todo, and
  checks the stub instead.
- **The on-the-day rule is unchanged.** If the recording is not in by October 16, the
  journey's cut rule drops the beats that assert an extracted station (2, 3 and 7), keeps
  merge and promotion with a typed entry station, and this runbook says so. A demo given
  on the stub must not be described as a recording of model output.

When the recording lands, the same tests turn real with no code change. A corpus edit
without a re-recording fails `discovery-demo-recordings.test.ts`, not the journey.

### Regenerating the demo fixtures

`npm run discovery:build-demo-corpus && npm run discovery:build-demo-twin`. Never hand-edit
a replay. `tests/google/demo-twin.test.ts` fails if the second command is forgotten.

## Reader passes

Every discovery reader attempt, on Microsoft 365 or Google Workspace, leaves two chained
`audit_log` events joined by `detail.passId` (#370): `discovery.reader_pass_started` before
any flag, registration or provider call, and `discovery.reader_pass_finished` with the
outcome, a fixed reason code and the counts. Ids, codes, counts and UTC times only: never a
subject, an address, a filename, a body, a token or a checkpoint. If the start cannot be
written, nothing is read.

On `/discovery`, the ingestion-health card shows, for the firm admin and the CCO:

- **Last reader pass**, per source: Completed, Continued (a page limit or a reset that
  queued the next job), Stopped (paused, disabled, halted or skipped), Refused (the access
  guard), Failed, In progress (no end yet, started under an hour ago, the `discovery.sync`
  expiry) or No end recorded (no end an hour on). Then its start and end times (UTC, by the
  worker's clock) and its three counts.
- **Last 24 h**, under the totals: passes started in the last 24 hours by server time, by
  outcome, with their counts summed.

What the counts mean:

- **fetched**: every provider object whose body crossed the wire, whatever the reader then
  did with it. A Gmail message excluded after its raw fetch, one that gained a built-in
  label, one with no raw and one over 25 MiB all count, as does every Graph delta message
  that is not a removal and every SharePoint download that returned bytes. A 404, a thrown
  request and a download stopped in flight count nothing. The one lower bound: a page that
  throws before it is yielded is not counted.
- **excluded by policy**: messages the exclusion policy excluded on metadata, before any
  content request. Never also fetched.
- **stored**: items written to the store, counted before the page's checkpoint, so a
  failed checkpoint write still reports them.

Things to know:

- `classify-once`, `scripts/seed-discovery.ts` and `scripts/m365/replay-discovery.ts` run
  `runOnce`, which starts every active source's pass at the run start, so their `startedAt`
  is the run start time. A source another source's failure left unread ends `skipped` /
  `run_aborted`. A tenant with no active sources records nothing. These scripts need the
  `20261006120000_discovery_reader_pass` migration: against a database without it, the
  start fails and nothing is read.
- The worker's clock is checked against the database's: a start more than 10 minutes off
  is refused. The symptom is failed `discovery.sync` jobs reading `reader pass start failed
  (reader_pass_clock_skew)` and no pass rows. A `reader_pass_mismatch` means two writers
  disagreed about one pass: worth an incident note.
- `DISCOVERY_WORKER_DEPLOYMENT` names the deployment in each pass (`unknown` unless set,
  `local` in fixture mode); a `REVISION` file next to the bundle names the build.
- Trust limit: the service role can still insert into `audit_log` directly. The hash chain
  proves no pass row was altered or removed afterwards, not who wrote it. The card ignores
  pass rows that fail the writer's shape checks or its time bounds, and an end that does
  not match its start on every immutable field.
- Passes of a deleted source drop out of the 24-hour totals.

The full history, for an operator, with the service role:

```sql
select ts, action, detail->>'passId' as pass, detail->>'runId' as run, detail->>'status' as status,
       detail->>'reason' as reason, detail->'fetched' as fetched, detail->'excluded' as excluded, detail->'stored' as stored
from audit_log
where tenant_id = $1 and action like 'discovery.reader_pass_%' and ts >= $2
order by ts, action desc;
```

## Send census (#425)

The service-role-only `send_census_weekly` table counts sends per tenant, mailbox source and complete UTC ISO week. It contains ids, dates and counts, not addresses or content.

| Column | Meaning |
|---|---|
| `native` | Gmail `SENT` ledger rows; null means the week is not knowable, including Microsoft sources, never zero |
| `platform` | Resend relay sends attributed to the owner's mailbox active when the message left |
| `deal_contact` | Native sends with a deal contact on the thread; null until recipient classification is available |
| `deal_sensitive` | Null until sensitivity tagging (#436) |
| `non_deal` | Native sends without a deal contact on the thread; null until recipient classification is available |
| `computed_at` | Time the row was refreshed |

Derived readings: unclassified is `native - deal_contact - non_deal`; normal is `deal_contact - coalesce(deal_sensitive, 0)`. Off-platform share is `native / nullif(native + platform, 0)`, only over rows where `native is not null`. A baseline consists of weeks before an owner's first `platform > 0`.

Native send facts are frozen at first read, so later reads do not change classification. Relay sends use the release time when present, otherwise creation time, and are assigned to the owner's mailbox active at that time, preferring Google. A send from before the owner's mailbox was connected goes to the owner's earliest Google mailbox whose census covers that week. A sender with neither contributes to the job's `unattributed` count instead of a mailbox row. Attribution follows current ownership: when an ownerless mailbox is adopted by a seated banker, that banker's earlier unattributed relay sends move onto it at the next refresh of those weeks. `send_census_from` marks the first covered week for an existing source; earlier weeks are absent unless a full backfill or baseline rescan establishes coverage. A platform send can still appear in an uncovered week, with `native` null.

The worker refreshes the trailing eight complete weeks Mondays at 02:00 UTC. An operator can refresh a longer window with the service role:

```sql
select send_census_refresh('<tenant uuid>', 104);

select week, source_id, native, platform, deal_contact, non_deal,
       round(native::numeric / nullif(native + platform, 0), 3) as off_platform_share
  from send_census_weekly
 where tenant_id = '<tenant uuid>' and native is not null
 order by week desc, source_id;
```

## Live model calls

Off by default. A live call goes down one of two paths, and the processor gate picks the
path before any mail text is read.

- **Synthetic (local stack).** It needs all of these: `DISCOVERY_EXTRACT_TRANSPORT=gateway`,
  `AI_GATEWAY_API_KEY`, a local Supabase URL, `NEXT_PUBLIC_APP_ENV` set to `dev` or `local`
  (#339: unset or `staging` is refused too), the synthetic tenant, and, item by item, a
  Message-ID from the committed corpora.
- **Verified (Ignatious's real mail).** It stays closed until the three constants of the
  processor gate are flipped by one reviewed PR: `VERIFIED_MODEL_PROCESSORS` and
  `DISCOVERY_OUTPUT_PLACEMENT_APPROVED` (ADR-0019), and `VERIFIED_MODEL_TENANT_IDS`
  (ADR-0017 Amendment 1; in `processorGate.ts` since #432, shipped empty), which lists the Ignatious tenant alone. It then runs the pinned
  `anthropic/claude-sonnet-5` and no other model. See "Live extraction on Ignatious mail".

The gate refuses anything else. A live call is priced from tokens and writes one `ai_usage`
row (source `discovery_extract`). A replay writes none. A gateway pass runs under a budget on
either path: see "Spend is bounded by its estimate".

## Live extraction on Ignatious mail

From the deploy of the owner's flip PR (the ADR-0017 gateway row reads Yes), the AWS extract
service runs `extract --serve --tenant <Ignatious> --transport gateway` (the fixed command arrives with #433), and its summary reads
`"path":"verified"`. The beats that show model output are 2, 3 and 7: the station, the reason
and the cited span. Whether they run on Ignatious's mail is the owner's separate decision in
"The demo on Ignatious's Workspace (read-only)"; the Kestrel and Osprey figures in "The beats"
come from the seeded corpus. Where they do run on real mail, the stations, reasons and spans
are what the model extracted from it. Mail is read with `gmail.readonly` only. The model
sees routed items only, through the Gateway with zero data retention (team-wide), Anthropic
only, on Sonnet 5.

**Spend is bounded by its estimate.** Before the first live pass, the owner runs the estimate
task (AWS runbook, "Switching later", P2 = A to B, step 4) and reads the counts, sizes,
expected tokens and cost. The first live pass opens a budget from a fresh estimate over the
same mail. Compare the two lines. The run extracts only that mail, and it sends nothing more
once the next call could cross the stop line (`"capped":"over_estimate"`). It also stops if
a call's cost is not on the ledger as a number or a reserved call never settled
(`"capped":"unpriced"`), or if the open budget was opened for another model or prompt version
(`"capped":"budget_model_mismatch"`); the AWS runbook says how to find the rows. A stopped run still answers corrections, so Merge, Set station, Split
and Move keep working. Mail that arrives after the budget opens waits for the owner to renew
it.

**Owner dates** (owner to confirm; the Schedule below stands). The estimate needs mail already
read and routed, and Ignatious's reader grant is in place by Oct 27, so the estimate cannot
precede the Oct 27 read.
- Oct 23: the flip PR merged.
- Oct 26: the flip PR deployed with the extract service still at 0 (build, gateway key
  secret, stage 2 again). The tfvars switch waits for the Oct 27 read.
- Oct 27: after the read-only rehearsal has stored mail, the estimate is read and the tfvars
  switch applied (`extract_gateway_enabled = true`, `extract_desired_count = 1`). This is
  done before the Oct 28 freeze, and it is neither a delegation, group nor registration
  change.

**Oct 27 rehearsal.** The read-only rehearsal on Ignatious ("Read-only rehearsal on Ignatious
(Oct 27)") is the first real pass on Ignatious's mail, so it starts the ADR-0017 Amendment 1
decision-6 clock. Once the tfvars switch is applied, check the extract summaries:
`"path":"verified"`, `"failed":0`, and `capped` null until the cohort is done.

**If live extraction is not running on Ignatious by the end of Oct 27.** The freeze on Oct 28
leaves no time to fix it. Recorded replies cannot stand in on Ignatious mail: they are keyed
by the synthetic corpus's content hashes, and recording replies from real mail is barred.
Beats 2, 3 and 7 then run on the seeded mail with the recorded replies, and are described as
"a recording of model output on seeded mail". The Ignatious beats show reading and
classification only.

**Stop.** The AWS runbook's extract stop (section 14): scale `conductia-discovery-extract` to
0 and stop its tasks. It needs no deploy, and it takes effect within the 40 s `stopTimeout`
after `stop-task`: on `SIGTERM` the extract task finishes the call in hand, puts it on record,
sends nothing more and exits. Only a call still in flight if ECS sends `SIGKILL` leaves its
reservation set, so the next pass sends nothing (`"capped":"unpriced"`) until the owner reads
it and renews the budget.

The demo-only model proposal step (#460, Proposed in D91) has its own switch,
`DISCOVERY_PROPOSE_TRANSPORT=gateway`, so turning live extraction on never turns live
proposals on. It is also refused unless `classify-once` gets `--propose`, the
`discovery_model_proposals_demo` flag is on and, on the verified path, the tenant is in
`MODEL_PROPOSAL_TENANT_IDS` (empty as shipped). A live proposal writes one `ai_usage` row
(source `discovery_extract`, task `deal_proposal`). See "Coverage counts and the model
proposal step, locally (#460)".

## Seeded dry runs on the test Workspace (owner's machine only)

The live path has two parts (owner decision, 2026-10-08): these seeded dry runs, on a test
Workspace that Conductia controls, and "The demo on Ignatious's Workspace (read-only)"
below. Seeded mail never touches Ignatious's Workspace.

`<test domain>` is the domain of the paid dev Workspace approved on 2026-10-20. It replaces
emailmask.uk, whose trial has expired (owner, 2026-10-20), and it is a placeholder until the
owner creates it. What to create, grant and write before these runs, and what to paste back:
[dev-google-workspace-setup.md](../04-operations/dev-google-workspace-setup.md). It goes into
`seeding.json`'s `testDomains`; every seeded command below keeps
`--confirm-domain <test domain>`.

Never run by an agent. Announce every run to the owner first: `seed-gmail.ts` refuses
without `--live` and a `--confirm-domain` equal to the test domain, and prints a
`LIVE Google run` line before its first call. The Oct 28 freeze applies: no domain-wide
delegation (DWD), group or registration change after it. The mail is synthetic: the demo
seed `tests/fixtures/discovery/demo/gmail-seed.jsonl`, imported into the test mailboxes.

### Prerequisites

- **Reader delegation.** The DWD client is authorised for exactly one scope,
  `https://www.googleapis.com/auth/gmail.readonly`, and never `gmail.metadata` (with it,
  the test tenant refused full reads; see `google-workspace-reader-admin-guide.md`).
  Delegation changes take up to 24 hours to apply.
- **Import delegation.** `seed-gmail.ts` mints a `gmail.insert` token for the seeding
  service account that `seeding.json` names (`seedingServiceAccountEmail`). The keyless
  caller signs that token's JWT as the seeding account (IAM Credentials `signJwt`), so it
  needs Service Account Token Creator on that account, and the account needs a
  `gmail.insert` domain-wide delegation grant on `<test domain>`. The reader scopes above do
  not cover it. The grant is a DWD change: it is in place by Oct 21 (it takes up to 24 hours
  to apply). The emailmask.uk trial has expired and took its grant with it. Revoking the
  test Workspace's grant after the demo is an owner task (O28); it applies to the test
  Workspace only, because Ignatious never has a seeding grant. Step 4b gates its use between
  runs.
- **Credential.** A keyless caller credential at `.secrets/google/worker-credentials.json`
  (`external_account`, `impersonated_service_account` or `authorized_user`). A service
  account key anywhere under `.secrets/` makes `seed-gmail.ts` refuse.
- **Files.** `.secrets/google/registration.json` (the reader registration: `tenantId`,
  `workspaceDomain`, `serviceAccountEmail`, `directoryServiceAccountEmail`, `clientId`,
  `allowlistGroup`, `firmCompanyId`, `status`, `consentedAt`, and `sources` as a list of
  `{ address, ownerEmail }`) and `.secrets/google/seeding.json` (`testDomains`,
  `seedingServiceAccountEmail`, and `personas`, which maps each demo persona address to
  the trial mailbox that holds its copy).
- **Group.** Each test mailbox is a direct member of `conductia-ingest@<test domain>`,
  added under its primary address. A nested or alias member is refused as
  `not_in_provider_group`.

### The terminal guard

Every command below is a `node --import tsx ...` form, run in a terminal prepared by the
guard. Do not use the npm scripts that load `.env.local` (`seed:discovery`,
`google:seed-gmail`, `worker:classify`): `node --env-file` does not override a variable
that is already set, so a hosted value that the shell profile exports would win over the
file.

**Which local stack.** Run from a `develop` checkout, a bare `supabase status` resolves the
repo's `supabase/config.toml`: `project_id "conductia"` on port 54321, the shared dev
stack. Step 1's reset would wipe it. So the live run uses its own stack:

- Make a scratch project directory, for example `~/conductia-live-stack`. Copy `develop`'s
  `supabase/` folder into it (migrations and config), and refresh the copy after every
  `develop` pull.
- Edit `supabase/config.toml` there: a `project_id` that starts with `conductia-live` (for
  example `conductia-live`; the guard accepts no other name) and shifted ports (for
  example 556xx). Never 543xx, the shared dev stack, and never 548xx, the kit's
  `gmaillive`.
- `export SB_WORKDIR=~/conductia-live-stack`, and `export SEED_PASSWORD=<a local-only
  password>`. Every `supabase` command passes `--workdir "$SB_WORKDIR"`.

Save the guard as a file and `source` it in every terminal, including the second one for
`--watch`. It is a bash function (it refuses any other shell: in zsh `compgen` does nothing,
so hosted `BOX_`, `ANTHROPIC_` and `AI_GATEWAY_` values would stay exported) that returns on
a refusal, so a refusal never closes an interactive terminal. It accepts only a
`project_id` that starts with `conductia-live`: any other running stack, including another
session's, is refused, so step 1's reset cannot wipe it. It clears every variable that
`supabase status` sets before it reads the status, so a value left by an earlier terminal
cannot pass for this stack's. It also clears every `DISCOVERY_` and `IGNATIOUS_` variable, so a
reader mode, extract transport or Ignatious endpoint left in the shell cannot leak into a
step. A step that needs one sets it on its own command line, after the guard has run, as
step 5 does with `DISCOVERY_READER_MODE=live`.

```bash
# ~/conductia-live-guard.sh : run `source ~/conductia-live-guard.sh` from the develop checkout's root.
conductia_live_guard() {
  [ -n "${BASH_VERSION:-}" ] || { echo 'refused: bash only'; return 1; }
  if [ -z "${SB_WORKDIR:-}" ] || [ ! -f "$SB_WORKDIR/supabase/config.toml" ]; then
    echo 'refused: export SB_WORKDIR=<scratch dir holding supabase/config.toml with project_id conductia-live*>'; return 1
  fi
  if [ -z "${SEED_PASSWORD:-}" ]; then
    echo 'refused: export SEED_PASSWORD (a local-only password) first'; return 1
  fi
  local pid status_env v
  pid=$(sed -n 's/^project_id *= *"\([^"]*\)".*/\1/p' "$SB_WORKDIR/supabase/config.toml")
  case "$pid" in
    conductia-live|conductia-live-*) ;;
    *) echo "refused: project_id '$pid' is not a conductia-live stack"; return 1 ;;
  esac
  for v in DATABASE_URL SUPABASE_DB_URL API_URL ANON_KEY SERVICE_ROLE_KEY DB_URL NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY SUPABASE_URL SUPABASE_SECRET_KEY \
    SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY SUPABASE_ACCESS_TOKEN NEXT_PUBLIC_APP_ENV \
    PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE \
    $(compgen -e | grep -E '^(BOX|RESEND|ANTHROPIC|MFA|EMAIL|STORAGE|AI_GATEWAY|DISCOVERY|IGNATIOUS)_'); do
    unset "$v"
  done
  status_env=$(supabase status -o env --workdir "$SB_WORKDIR") || { echo "refused: stack $pid is not running"; return 1; }
  eval "$status_env"
  [ -n "${DB_URL:-}" ] && [ -n "${ANON_KEY:-}" ] && [ -n "${SERVICE_ROLE_KEY:-}" ] ||
    { echo "refused: supabase status reported no DB_URL, ANON_KEY or SERVICE_ROLE_KEY for $pid"; return 1; }
  case "$API_URL" in
    http://127.0.0.1:54321|http://127.0.0.1:54321/*|http://localhost:54321|http://localhost:54321/*)
      echo 'refused: port 54321 is the shared dev stack'; return 1 ;;
    http://127.0.0.1:*|http://localhost:*) ;;
    *) echo 'refused: the Supabase URL is not loopback'; return 1 ;;
  esac
  export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"
  export DB_URL NEXT_PUBLIC_APP_ENV=dev
  export GOOGLE_APPLICATION_CREDENTIALS=.secrets/google/worker-credentials.json   # keyless
  export TENANT=00000000-0000-4000-8000-000000000001                              # DEV_TENANT_ID
  echo "guarded: project_id $pid at $API_URL"
}
conductia_live_guard
```

Read the `guarded: project_id ...` line before every step. If the guard printed `refused`,
nothing below runs in that terminal. One mail path per stack applies here too: this stack
only ever sees the live Gmail path. Do not run the Graph or replay seeds on it. Since #275 a
live pass no longer stops on a Microsoft registration: it lists the Exchange scope group the
registration records, reads no Microsoft mailbox when none is recorded (health shows `Group
unreadable`), and reads that registration's SharePoint sites live under the site guard.

### Steps

1. **A fresh stack from `develop`'s migrations.** `supabase start --workdir "$SB_WORKDIR"`,
   `source` the guard, then `supabase db reset --local --workdir "$SB_WORKDIR"`. Then do the
   fresh-stack checklist's steps 4 and 5 (flags, users), all in the guarded terminal. Never
   run a bare `supabase db reset --local` from the repo root. When the session is over,
   `supabase stop --workdir "$SB_WORKDIR"`.
2. **Write the exclusion policy.** Without it, every live read is refused (`discovery: the
   tenant has no exclusion policy`, and the source's Last error in ingestion health reads
   `No exclusion policy`). The content is the owner's. **The live default is the
   recommended template.**
   ```text
   node --import tsx scripts/discovery/set-exclusion-policy.ts --print-template > ~/trial-policy.json
   # edit ~/trial-policy.json: replace outside-counsel.example with the counsel domain the trial uses
   node --import tsx scripts/discovery/set-exclusion-policy.ts --tenant "$TENANT" \
     --requested-by "<owner name>, <test domain> dry run" --expected-version 0 --rules ~/trial-policy.json
   # that is the dry run: read the diff. The same command with --confirm writes version 1:
   node --import tsx scripts/discovery/set-exclusion-policy.ts --tenant "$TENANT" \
     --requested-by "<owner name>, <test domain> dry run" --expected-version 0 --rules ~/trial-policy.json --confirm
   ```
   `--requested-by` is the only record of who asked: give a name and a purpose, never an
   empty value. `[]` (the committed `tests/fixtures/discovery/demo/exclusion-policy.json`)
   **reads everything in the trial mailboxes**: every routed trial message's body is
   stored. It is the offline replay's policy, and using it here is an explicit owner choice.
   Keep the rules file outside the repo.
3. **Preflight the registration and the seeding map before applying anything.** This
   prints only the fields that decide where reads go and whose mailbox each one is. It never
   prints the rest of either file. It exits 1 if `seeding.json`'s trial mailboxes differ
   from the registration's sources, because `seed-gmail.ts` imports by `seeding.json`'s
   persona map (`planImports`), while `seed-discovery.ts --google` reads `registration.json`.
   ```text
   node -e '
     const r = require("./.secrets/google/registration.json"), s = require("./.secrets/google/seeding.json");
     const sources = (r.sources ?? []).map((x) => ({ address: x.address.toLowerCase(), ownerEmail: x.ownerEmail }));
     console.log(JSON.stringify({ tenantId: r.tenantId, workspaceDomain: r.workspaceDomain, allowlistGroup: r.allowlistGroup,
       firmCompanyId: r.firmCompanyId, status: r.status, sources, seedingPersonas: s.personas, testDomains: s.testDomains }, null, 2));
     const trial = Object.values(s.personas).map((a) => a.toLowerCase()).sort(), registered = sources.map((x) => x.address).sort();
     if (JSON.stringify(trial) !== JSON.stringify(registered)) { console.error("MISMATCH seeding.json", trial, "registration", registered); process.exit(1); }'
   psql "$DB_URL" -c "select u.email, u.tenant_id, u.company_id from users u where u.email = any (array['<ownerEmail 1>', '<ownerEmail 2>', '<ownerEmail 3>'])"
   ```
   Check each of these, and stop if any differs:
   - `tenantId` equals `$TENANT`.
   - `workspaceDomain` is `<test domain>`, and `testDomains` includes it.
   - `allowlistGroup` is `conductia-ingest@<test domain>`.
   - `sources` are exactly the trial mailboxes you intend to read.
   - `seedingPersonas` maps each of `storm.duncan@bank.example`, `morgan.vale@bank.example`
     and `alex.chen@bank.example` to one of those mailboxes.
   - In the `psql` rows, every `ownerEmail` has `tenant_id` equal to `$TENANT` and
     `company_id` equal to the file's `firmCompanyId`.

   **After every reset, the owner updates `firmCompanyId`.** `seed-users` creates the firm
   company with a fresh uuid each time, so the value in `registration.json` goes stale. The
   symptom is `seed-discovery.ts --google` failing with `Seed user <email> is not seated in
   the firm company <id>`. Take the new value from the `company_id` the `psql` query prints.

   Then: `node --import tsx scripts/seed-discovery.ts --google .secrets/google/registration.json`.
   It writes the registration and the sources, then invites and consents each owner under
   their own session. It does not classify: it ends with `Seeded. Nothing was classified`.
3b. **On a reused test Workspace, clear the previous run's late mail.** Delete the previous
   run's `after-imports` messages (for the demo seed, `kestrel-017` and `kestrel-018` in
   Storm's trial mailbox) by hand in Gmail, and remove their entries from
   `~/.conductia/google-seed/<test domain>.json`. Otherwise step 5 classifies them up front
   and the late-mail beat shows nothing new. The reader's scopes cannot delete mail, and no
   script here does.
4. **Import the demo mail.** It imports and never sends, and it skips a Message-ID it has
   already imported:
   ```text
   node --import tsx scripts/google/seed-gmail.ts --live --confirm-domain <test domain> \
     --seed tests/fixtures/discovery/demo/gmail-seed.jsonl --phase seeded
   ```
   It ends with `Done (seeded): <n> imported, <m> already present`. Its duplicate check
   lists Message-IDs in each trial mailbox through the operator door. That is a
   metadata-only read by an import tool, not ingestion: it does not pass the exclusion
   policy, and nothing it reads is stored by Conductia. It also keeps a log of what it
   imported at `~/.conductia/google-seed/<test domain>.json`, outside the repo. An entry in
   that log skips the import without asking Google, and it is the only record when Google
   refuses the duplicate check (`... (search refused; local seed log used)`). If the trial
   mailboxes were emptied, remove the log first.
4b. **Between runs, nobody can use the import delegation.** The owner holds Service Account
   Token Creator on the seeding service account only for a dry run or the demo, and removes
   it afterwards. IAM changes apply in minutes and are not DWD changes, so the freeze does
   not cover them.
5. **Classify.** `DISCOVERY_READER_MODE=live node --import tsx worker/classify.ts --tenant "$TENANT"`.
   Every read goes stored policy, then mailbox guard, then the reader. It prints one
   `Tenant <id>: read <n> items from 3 sources, stored <m>, <k> candidates (<j> new), <r>
   refused, ...` line. A non-zero `refused` means the mailbox guard is holding a source
   (for example a mailbox that has not joined the group): sign in as the admin and read the
   ingestion health panel.
6. **Base mail check.** Beat 1 expects Falcon, which is base mail, not demo mail. A new
   test Workspace holds none until the base seed is imported. Check: `psql "$DB_URL" -c "select count(*) from source_items where tenant_id =
   '$TENANT' and internet_message_id like '<falcon-%'"` is greater than 0, or Falcon is
   listed in `/discovery`. If it is missing, import the base seed (`seed-gmail` skips what
   is already there), then repeat step 5:
   ```text
   node --import tsx scripts/google/fixture-to-seed.ts --out evals/out/base-seed.jsonl
   node --import tsx scripts/google/seed-gmail.ts --live --confirm-domain <test domain> --seed evals/out/base-seed.jsonl --phase seeded
   ```
   `fixture-to-seed.ts` writes only under `evals/out/` and refuses a file that exists, so
   delete an earlier `base-seed.jsonl` first. The base seed marks `falcon-006` and
   `falcon-007` as `after-imports` and `dinner-005` as spam. So `--phase seeded` brings
   Falcon in with five of its seven messages, and the reader never lists `dinner-005`
   (`includeSpamTrash=false`). The replay paths hold all seven. Beat 1 lists only Falcon's
   heading. Proposed: to match the replay paths, also run the second command above with
   `--phase after-imports`, then step 5 again. Without Falcon, only beat 1's Falcon heading
   differs. No other beat uses Falcon.
7. **Start the extractor and let it drain, on recorded replies only.** In a second guarded
   terminal: `node --import tsx worker/extract.ts --watch --transport recorded --replies <file>`,
   where `<file>` is the recording if committed, else the stub. It stays running for the
   whole walkthrough, and prints one summary line every three seconds. The correction beats
   (merge, set station) queue recompute requests that only a running extractor answers (see
   "Run the worker with --watch").
   - Do not pass `--strict`: trial mail outside the demo corpus has no recorded reply and
     writes a `recording_miss` (a failed call, no model call).
   - Never set `DISCOVERY_EXTRACT_TRANSPORT=gateway` on this stack.
   - **Wait until a pass prints `"selected":0`.** One pass handles at most 50 items
     (`runExtractOnce`, `src/lib/discovery/extract/run.ts`), so a single `--once` can stop
     before every demo item was tried. A failed item is retried up to 3 times, 30 s apart
     (`discovery_extract_batch`, `20261002200000_discovery_milestones.sql`), so
     `"selected":0` arrives about a minute after the last miss.
   - Without `--watch`, repeat `--once` passes (the default) until one prints
     `"selected":0`, then start `--watch` for the walkthrough.
8. **Then check the misses and the outstanding demo items.** Run this only after
   `"selected":0`. The summaries' `failed` counts include every `recording_miss`. Misses on
   non-corpus trial mail are expected.
   ```text
   # Demo-corpus misses: model_calls joined to its item by id, within the tenant.
   psql "$DB_URL" -c "select si.internet_message_id, count(*) as misses
     from model_calls mc join source_items si on si.id = mc.source_item_id
     where mc.tenant_id = '$TENANT' and si.tenant_id = '$TENANT' and mc.error_code = 'recording_miss'
       and si.internet_message_id similar to '<(kestrel|harbor|osprey|bidq)-%' group by 1 order by 1"
   # Demo items on a candidate with no settled reply yet (no ok or invalid call).
   psql "$DB_URL" -c "select si.internet_message_id, count(mc.id) as calls
     from source_items si
     join evidence_links el on el.source_item_id = si.id and el.state <> 'rejected'
     left join model_calls mc on mc.source_item_id = si.id and mc.tenant_id = '$TENANT'
     where si.tenant_id = '$TENANT' and si.internet_message_id similar to '<(kestrel|harbor|osprey|bidq)-%'
     group by 1 having count(mc.id) filter (where mc.outcome in ('ok', 'invalid')) = 0 order by 1"
   ```
   - **Any row in the first query means the newly imported demo mail does not key onto the
     committed replies.** The keying is inferred from the recorded base replays, not
     verified for new imports. In that case Kestrel and Osprey show no extracted station.
     The options are the owner's: re-record replies against the live items (an ADR-0019
     owner decision), or show the station beats on the replay path and the live path for
     discovery only.
   - **A row in the second query with `calls` 0** means the extractor has not reached that
     item yet. Wait for another `"selected":0` pass, then re-check. A row with `calls` above
     0 has only failed attempts, and the first query lists them.
   - The second query approximates the extractor's eligible set (routed items) by evidence
     links. If it lists an item the extractor never selects, compare it with
     `discovery_extract_batch`'s selection in that migration.
9. Do not walk the beats until both queries are empty, or until the owner has chosen how to
   handle the misses.
10. Sign in as Storm and walk the beats.
11. **Late mail.** Step 4 with `--phase after-imports`, then step 5. The running `--watch`
    extractor picks it up. Wait for `"selected":0` again before showing the evidence marker.

A demo given on the stub is not described as a recording.

## The demo on Ignatious's Workspace (read-only)

The Oct 30 demo runs on real Ignatious mail (owner decision, 2026-10-08). Nothing is
seeded: no `seed-gmail.ts`, no import, no `gmail.insert`. The reader runs as #344's
discovery worker on AWS, against the hosted project, under that runbook's go-live gates
([discovery-worker-aws-runbook.md](../04-operations/discovery-worker-aws-runbook.md)). The
seeded dry runs' local stack, guard and seed commands do not apply here.

- **Never a seeding domain.** Ignatious's domain is never added to `seeding.json`'s
  `testDomains`, so the seeders' domain guard (`requireLiveRun`,
  `scripts/google/lib/live.ts`) keeps refusing it with `Refusing: <domain> is not a test
  domain in .secrets/google/seeding.json`.
- **`gmail.readonly` only.** Ignatious's delegation grants exactly
  `https://www.googleapis.com/auth/gmail.readonly` and never `gmail.insert`, as #344's
  gate G9 inspects it: one entry, `sa-dwd`'s client id, in Ignatious's project (P9).
- **The late-mail beat** is a real email that an Ignatious participant sends during the
  demo, to a consented mailbox. Nothing is imported; the worker's next pass reads it.
- **Which beats run on real mail** is a separate owner decision. Until it is made, the
  seeded beats in "The beats" (Kestrel, Harbor, Osprey, the stations, the recorded replies)
  are dry-run beats.

### Owner and Ignatious prerequisites (owner queue)

- [ ] Ignatious's written confirmation of which mailboxes are read, the consent record for
  each, and their exclusion policy for real mail. The #392 demo policy
  (`tests/fixtures/discovery/demo/exclusion-policy.json`, `[]`) was built for the seeded
  corpus and is never used here.
- [ ] Ignatious's reader grant in place by Oct 27. Domain-wide delegation takes up to 24
  hours to apply.
- [ ] The retention and deletion of discovery data after the demo: what is kept, for how
  long, and who deletes it. Proposed answer (#461, D93): a banker's stored mail is deleted
  when their consent ends, and the operator purges the tenant at pilot end or on the bank's
  written request, then the project is deleted, as
  [Deleting stored mail](../04-operations/discovery-worker-aws-runbook.md#deleting-stored-mail)
  describes. A message index that holds no content (its digest keyed per tenant) is kept only per the tenant's retention policy
  (owner, 2026-10-14); under the pilot values it is deleted at disconnect, and at pilot end
  it is exported to the bank, then deleted. The deletion window and the backup number are the owner's to confirm.

### Read-only rehearsal on Ignatious (Oct 27)

Run the reader once against Ignatious's real mailboxes, as #344's runbook runs a pass, and
check:

- **Access:** every mailbox the confirmation names is read, and the mailbox guard refuses
  none of them (ingestion health shows no `not_in_provider_group`, `no_consent` or owner
  mismatch).
- **Volume:** the pass's summary line (`Tenant <tenant id>: read … stored …, fetched …,
  excluded …`) is in the range the confirmed mailboxes should produce. A pass that reads
  far more than expected stops the rehearsal.
  - The expected volume is each mailbox's window, not the whole mailbox (#353). A Gmail
    source's first read takes mail from the date on its Window line on `/discovery`: 90
    days before the source was registered, unless the firm admin changed it before the
    read (at most 730 days back). New mail arrives after that through the incremental
    sync. A source whose line reads "Whole mailbox" read before the window existed.
  - Older messages of a thread that is active inside the window are judged by the
    exclusion policy with their thread, but never fetched in full or stored; their
    metadata is read to judge the thread. So they count in neither `fetched` nor
    `excluded`.
  - Before the rehearsal, record each source's Window line next to the confirmed
    mailboxes, and size the expected range from it. A window set earlier than the
    default makes a longer first read: see the AWS runbook, step 13.1, "Long windows".
- **The exclusion policy:** Ignatious's policy row exists
  (`discovery_exclusion_policies` for their tenant), and the `excluded` count and the
  ledger's skipped rows match what their policy should exclude.

It writes nothing to their mailboxes: the reader's scopes cannot insert, change or delete
mail. What it reads is stored in the hosted project, under the retention item above.

**Coverage counts (Proposed, #460, D91).** The first pass over the newly connected inbox
also answers whether Ignatious's mail names its deals with codenames. Its summary line
carries `Routing (full read): of N read, routed N, unrouted N, skipped N, collisions N; codenames N`:
counts only, recorded privately. The owner compares the routed codenames
with the deals the team expects and decides, before the dry run, whether the demo runs
on the rules alone or adds the demo-only model proposal step. The AWS runbook's "Demo
only: the coverage count and the model proposal run (#460)" says how to run both.

## Moving the emailmask.uk kit to develop (owner's list)

The kit at `~/conductia-gmail-demo/` runs the live path from a worktree frozen before
`develop` took the Gmail reader. Its emailmask.uk Workspace ends on Oct 14, so the moved kit
targets the new test Workspace (`<test domain>`), never Ignatious's. It is not edited, and not migrated in place, by this
work. Moving it means a fresh database from `supabase db reset` on `develop`'s migrations,
not an upgrade of `gmaillive`:

- `develop` renumbered eleven #259/#262 migrations.
- Two versions exist on both sides under different names: `20260930100000` and
  `20261001100000`.
- `scripts/migrate.sh` says in its header that it is not safe over a lived-in database.

1. **A new worktree on `develop`,** after the exclusion policy work and this one, with its
   own `npm ci`. Drop the `node_modules` symlink into the old #259 workspace. The
   `.secrets/google` symlink can stay, because it holds keyless files only.
2. **Database.** `supabase db reset` from `develop`'s migrations, into a new project. The
   `gmaillive` data (41 items, 6 deals, any corrections made there) is not carried over.
   Items and deals are re-derived by re-reading Gmail, and corrections are lost. Keep
   `gmaillive` stopped, not deleted, until the new stack passes a dry run.
3. **`supabase/config.toml`.** Start from `develop`'s. It has the `custom_access_token`
   hook (#316), `enable_manual_linking = true` and the keycloak block, which the kit's lacks.
   The design said to keep the kit's `project_id` and ports. Proposed: give the new stack a
   new `project_id` and ports instead, as the live section does. The terminal guard above
   accepts only a `conductia-live*` `project_id`, so it refuses `gmaillive`, and keeping
   `gmaillive` stopped until the dry run passes needs a second stack beside it.
4. **`local.env`.** The same ten names: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL`, `NEXT_PUBLIC_APP_ENV`, `SEED_PASSWORD`
   and `MFA_ENFORCEMENT`, with values from the new stack. `SEED_PASSWORD` must match the
   `seed-users` run.
5. **Seeding order.**
   1. `seed-flags`, then `enable-flags`.
   2. `seed-users`. Consent now needs an MD or deal-team membership on a deal (D68).
   3. The exclusion policy (required for live).
   4. `seed-discovery --google registration.json`, which does invite plus consent.
6. **The `/profile` "Connect my mailbox" flow** now calls `mailbox_consent_grant` through
   `/api/v1/discovery/mailbox-consent`. `discovery_connect_google_mailbox()` was removed,
   and the status RPC (`discovery_google_mailbox_status()`) changed shape.
7. **`demo.sh`.** `probe` and `sync` keep their flags. The `read` verb does not move (it
   runs `read-one.ts`, item 8). Add an `extract` verb
   (`worker/extract.ts --once --transport recorded --replies <file>`) and a `watch` verb
   (`--watch`, for the walkthrough). Add an `import` verb that wraps step 4 above. Every
   verb runs `node --import tsx` under the kit's existing env strip (`run.sh`), not the npm
   scripts.
8. **`read-one.ts`.** The default is to not move it to `develop`, in any mode, and not
   the `demo.sh` `read` verb either.
   - **Why:** it mints a token and reads directly after the guard check, outside the Gmail
     reader, so it bypasses the exclusion policy's two-step read. `--list` and
     `--metadata` are direct reads outside the policy path too: metadata only, not
     policy-evaluated.
   - Keeping any mode is an explicit owner opt-in, recorded with its reason.
   - If a mode is kept, its imports changed: `CLOUD_PLATFORM` is now
     `GOOGLE_TOOL_SCOPE.IAM`, and the Google primitives come from `googleOperatorKit()`.
9. **The Oct 28 freeze** still applies: no DWD, group or registration change. The seeding
   account's `gmail.insert` grant is in place before it (use gated by Token Creator, step
   4b).

## Before the freeze

- [ ] T2 recorded and the journey green on the real recording before Oct 23 (leaves room
  before the Oct 28 freeze).
- [ ] The new test Workspace exists and its seeding grant is in place by Oct 21. Revoking it
  after the demo is an owner task (O28), for the test Workspace only. Oct 21 has passed with
  no Workspace: the paid dev Workspace was approved on 2026-10-20, and its checklist is
  [dev-google-workspace-setup.md](../04-operations/dev-google-workspace-setup.md).
- [ ] Ignatious's reader grant (exactly `gmail.readonly`, per #344's G9) is in place by
  Oct 27, and the owner queue in "The demo on Ignatious's Workspace (read-only)" is
  answered.

## Schedule

| Date | Step |
|---|---|
| Oct 14 | The emailmask.uk trial Workspace ends. Its mailboxes and grants go with it. |
| Oct 16 | Recording due. Phase 7 is cut if Task A is not on the base. |
| By Oct 21 | The new test Workspace exists and its seeding grant is in place. |
| Oct 23 | T2 recorded and the journey green on the real recording. |
| Oct 26 | Seeded dry run on the test Workspace, on a fresh stack. |
| Oct 27 | Seeded dry run on the test Workspace, and the read-only rehearsal on Ignatious's Workspace. Ignatious's reader grant is in place. |
| Oct 28 | Freeze. Nothing merges after it. |
| Oct 29 | Spare. |
| Oct 30 | The demo, on Ignatious's Workspace (real mail, read-only). |

Fallback on the day: reset, run the checklist with the Graph fixture, and continue.

## Running the journey locally

```text
npx playwright test --project=hermetic --project=hermetic-discovery-demo
```

The demo journey is its own Playwright project, which depends on `hermetic`, so it runs
after every other journey. After the corrections it re-runs discovery from a full re-read
of every mailbox (`e2e/steps/rerunDiscovery.ts`, which rewinds the mailbox checkpoints with
the service key) and asserts that the merge, Storm's station and the history all still
stand before it promotes. Naming it alone still runs `hermetic` first. The app server
listens on port 3000 and the two stubs on 4310 and 4311. Stop another server on those
ports first. The spec is skipped under `E2E_BASE_URL`, and needs the stack's secret key
for its service-role reads.

On the Gmail replay: reset the stack, run the Gmail replay variant of the checklist (steps 1
to 7), then `npm run test:e2e:discovery-gmail`. It runs the same spec and steps; its
mid-journey seeds add `--google-replay`. The journey's first step fails if a mailbox source
is on the other path, before anything is mutated. The rerun and late-mail beats check again
after their re-seeds. Running both projects needs two resets: one stack, one mail path. A
bare `npx playwright test` runs both on one stack, so one of them fails at its first step by
design. For the HTML report, add `--reporter=html` (the local config uses the list reporter).

## Coverage counts and the model proposal step, locally (#460)

Proposed (D91, not yet approved). A rehearsal of both on a local stack, on the Graph
fixture path, with the recorded stub: no model is called. Run the fresh-stack checklist's
steps 1 to 6 first, and keep its scrubbed environment for every command below, with
`AI_GATEWAY_API_KEY` and `DISCOVERY_PROPOSE_TRANSPORT` unset. `<fixture dir>` is
`tests/fixtures/discovery/demo/graph`, or `tests/fixtures/discovery/demo/graph-after-imports`
after the late-mail beat.

The local serve worker (`worker/classify.ts --serve`) now exits 1 with one line,
`{"evt":"fatal","reason":"gateway_key_present"}`, when `AI_GATEWAY_API_KEY` is set. The
screening-eval script tells developers to keep that key in `.env.local`: remove it from there,
or unset it in the serve worker's shell, before starting the serve worker.

1. **The coverage count.** The seed has already read every mailbox, so a plain pass reads
   only new mail:

   ```text
   DISCOVERY_READER_MODE=fixture DISCOVERY_FIXTURE_DIR=<fixture dir> node --import tsx worker/classify.ts --tenant <DEV_TENANT_ID>
   ```

   Its line ends `Routing (new mail only since the last pass): …`. Add `--recount` to the
   same command: the line then reads
   `Routing (full read): of N read, routed N, unrouted N, skipped N, collisions N; codenames N`,
   and `select delta_checkpoint, backfill_completed_at from content_sources` returns what
   it did before.
2. **The flag.** `discovery_model_proposals_demo` is already on if step 4 ran
   `enable-flags.ts`, which turns every flag on. Otherwise insert it, since no migration
   creates its row and a plain `update` changes nothing:
   `insert into feature_flags (key, description, enabled) values ('discovery_model_proposals_demo', 'Demo-only model proposal step (#460, D91)', true) on conflict (key) do update set enabled = true;`
3. **The propose run**, on the recorded replies:

   ```text
   DISCOVERY_READER_MODE=fixture DISCOVERY_FIXTURE_DIR=<fixture dir> node --import tsx worker/classify.ts --tenant <DEV_TENANT_ID> --propose
   ```

   It replays `tests/fixtures/discovery/demo/model-replies/propose.v2.json` once the
   owner has recorded one, else `propose.v2.stub.json`, a labelled test double that is
   never a model output. The line reads `Routing (full read): …` and ends
   `Proposed: called N, deal N, new names N, not deal N, failed 0, invalid 0, cost $0.0000.`
   No deal name is printed. A second run asks nothing again (`called 0`), and neither run
   moves a source's sync cursor or resume state; only the `reader_progress_at` liveness mark
   moves, as on any read. A closed lock prints
   `Tenant <DEV_TENANT_ID>: propose refused (<code>).` and reads nothing: `flag_off` with
   the flag off, or a processor gate code off a loopback stack.
4. **The section.** Start the app and sign in as the owner of a mailbox the stub's deal
   answers came from. `/discovery` shows "Proposed from mail by a model · demo" below the
   proposed deals: the deal name, a neutral "Proposed" badge, the highest proposed phase,
   the email count, the date range and the parties. A colleague who does not own that
   mailbox sees no section, and neither does the CCO. The model is offered only the
   rules-found candidates the mailbox's owner can see and the deals it named in that owner's
   own mailboxes, so a proposed deal that names one of those candidates links to it; a
   proposal naming a candidate the viewer cannot see is not shown. A message in two
   mailboxes is one row in each.
5. **Off again.** `update feature_flags set enabled = false where key = 'discovery_model_proposals_demo';`
   hides the section (its route answers 404) and makes `--propose` refuse with `flag_off`.

The parties leave out the firm's own domains (those of its configured mailboxes), as the
rules-found list does, so a proposal from internal mail only reads "No outside party
identified". A recorded run inside the AWS image cannot load the stub,
which the image does not ship, so on AWS the step runs only on the gateway.

## The team inbox variant (#581)

The Oct 30 story, "connect an Ignatious team inbox, find the deals, place a phase on each", has its own admin guide, live check and runbook: [team-inbox-guide.md](./team-inbox-guide.md). The presenter is a non-admin MD (Storm), the firm admin connects the inbox and adds him, phases are placed by promotion, and the offline rehearsal and the `team-inbox-demo` journey run on their own reset stack. Decision: [ADR-0026](../07-decisions/ADR-0026-team-inbox.md).
