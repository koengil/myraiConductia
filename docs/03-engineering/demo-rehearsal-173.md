# #173 demo rehearsal: run write-up (Oct 30 demo)

Issue #173 (MVP 2 acceptance: a realistic end-to-end deal run). The demo story: "connect a team inbox, find the deals, place a phase on each". This page records two offline rehearsals of that story on the shared production code path, on a local stack and fixtures only, and the go/no-go call that follows from them. Run 2 covers both mail paths: the Gmail replay (the primary demo source, a new synthetic Google test Workspace) and the Microsoft Graph fixtures (the M365 backup). The ranked gap lists (v1 and v2, with every command and its output) are kept in the #173 task directory. Their summary is below.

## How it was run

- **Stack.** The exclusive local stack `w9-m365cap` (API `127.0.0.1:57321`, DB `127.0.0.1:57322`). No hosted database, Workspace, M365 tenant, Vercel or AWS step was run, and no live model call was made.
- **Harness.** `scripts/rehearsal/rehearse.sh` is the only door. It refuses any `.env*` file, pins the two local endpoints, runs every child under `env -i` with an allow-list that never carries a gateway key, and prints counts and codes only.
- **Gmail track (primary).** `hermetic-team-inbox-demo` (`e2e/journeys/team-inbox-demo.spec.ts`). The firm admin connects the team inbox, the worker checks and reads it, and the MD is added and sees its candidates while a colleague sees none of its team-only mail. The MD promotes Kestrel at phase 4 (seq 48) and Osprey at phase 5 (seq 57). Assessments stay invite-only. The CCO sees the connect and both deals in the bell and on each Audit Trail, on a chained audit log.
- **M365 track (backup).** `rehearse.sh seed --graph` seeds the demo corpus on the fixture Graph reader for every persona (CI's hermetic seed). `extract` replays the recorded extraction replies, and `e2e --graph` runs the Graph discovery journey (`e2e/journeys/discovery-demo.spec.ts`, project `hermetic-discovery-demo`). The detector, a recorded propose pass and the accept were then run on a fresh Graph seed.
- **Run 1.** 2026-10-21, develop `953e0692`.
- **Run 2.** 2026-10-25, develop `3ecb764f`. It added the rule detector, the accept flow, prefix-only routing and the M365 track. The commands added for run 2 (`capability milestone_rules on|off`, `detect`, `extract`, `integration`, `seed --graph`, `propose --graph`, `e2e --graph`) and `tests/rehearsal/prefix-only-recall.test.ts` are on the branch `test/173-rehearsal-2` and are not on `develop` yet.

## What changed between the runs

| Gap | Run 1 (`953e0692`) | Run 2 (`3ecb764f`) |
|---|---|---|
| G-01 team inbox sent to a model | `not_deal=2` rows written for the team source, unreadable | `not_deal=0`: the team source is skipped. The lift is built and stays OFF for Oct 30 |
| G-02 proposals have no actions | missing | Dismiss (G-02a) and accept with a person-confirmed station (G-02b): SQL, integration (11/11) and unit (187) tests pass on the stack. No browser journey (G-21) |
| G-03 / G-04 CCO oversight | missing | The firm-level team inbox audit trail and the refusal notice to the firm's admin and CCO: SQL tests pass. The journey's G-04 witness is retired |
| G-07 station suggestions on team mail | missing | The rule detector behind `milestone_rules`. Kestrel's team view reads LOI Review from the team-only LOI. Precision table below |
| G-09 recall without "Project <Name>" | T1 open | T1 answered: prefixes. With prefixes only, the team inbox still finds both deals with every item (2/2) |
| `discovery_corrections.sql` | n/a | Passes on a freshly reset stack, unseeded and seeded (11/11 each). Its one failure needed split or reassign rows left in another tenant on a long-lived stack, so the item is dropped |

Unchanged: G-05 (no disconnect for an inbox that holds mail), G-06 (the Gmail scope docs disagree), G-10 (the window is enforced only on a live read), and the release and hosted items below.

## The two mail paths side by side

Both tracks ran on `w9-m365cap` with recorded replies only.

| Demo step | Gmail replay (primary) | Graph fixtures (M365 backup) |
|---|---|---|
| Connect a team inbox | works-fixture-only: the journey connects the team inbox through the admin card; the worker checks and reads it | **missing:** the connect RPC refuses a Microsoft inbox, `provider_unsupported` (22023, route 422), with nothing written. A team inbox is Gmail only (`20261019100000_team_mailboxes.sql:34`, `TeamInboxes.tsx:111`); the Graph check is `[581 h2]` |
| Find deals | works-fixture-only: the journey, `passed=5`; the team inbox finds 2/2 with prefixes only | works-fixture-only: the Graph journey `passed=5` (setup 4, journey 1, retries 0) on personal mailboxes: Kestrel, Harbor, Osprey and Falcon shown, Cobra absent; merge, re-run, promote at station 44, and late mail advances it to 51 with the MD's accept |
| Phase suggestions (rules) | `detect -> events=11, teamPasses=1, assessedTeam=1` | `detect -> selected=37, events=12, assessed=5, teamPasses=0` (no team inbox to assess) |
| AI proposals (recorded) | `called=5, deal=0`: the stub's deal answer is in a mailbox the team seed does not hold | `called=21, deal=1, not_deal=20, cost $0.0000`: one `m:` proposal on an owned mailbox |
| Accept an `m:` proposal (G-02b) | not reachable on the DEV seed | integration `passed=11` runs on the Graph fixture reader. On the DEV seed the owner's accept is refused `no_authority` (42501): the persona that holds the proposal has no deal-create right (G-26) |
| The CCO's oversight | the bell, both Audit Trails, the team inbox trail | not in this journey: it asserts the correction and station-advance audit rows, and has no CCO view. There is no team inbox trail because there is no team inbox |

So the M365 backup can show "find the deals and place a phase" on personal mailboxes. It cannot show "connect a team inbox". A shared mailbox in the scope group can be read only as a source with one owner. The backup is pending the owner's decision on a new test tenant and the certificate path (G-27). Its live steps are in the checklist's [Backup: M365](../04-operations/demo-day-switch-checklist.md#backup-m365) section.

## The rule detector (G-07) against the fixtures

The ground truth comes from an annotator who read only the demo corpus, never the rules or their golden set. `milestone_rules` is decided ON (owner, 2026-10-25) for the Ignatious tenant and for each test tenant once it exists. This table is the sanity check.

| Deal | Track and audience | Implied | Rules suggest | Match |
|---|---|---|---|---|
| Kestrel | Gmail, team inbox | p4-s48 LOI Review | p4-s48 | yes |
| Kestrel | Gmail, personal | p4-s48 | p4-s48 | yes |
| Osprey | Gmail, team inbox | p5-s57 | p4-s48 (no team row: none of its team mail is team-only) | n/a |
| Osprey | Gmail, personal | p5-s57 | p5-s51 (`closed` is not a rules/v1 type) | no |
| Kestrel | Graph, personal | p4-s48 | p4-s48 | yes |
| Harbor | Graph, personal | p4-s48 | p4-s48 | yes |
| Osprey | Graph, personal | p5-s57 | p5-s51 | no |

| Set | TP | FP | FN | Precision | Recall |
|---|---|---|---|---|---|
| Gmail, team inbox messages (6) | 4 | 0 | 2 | 1.00 | 0.67 |
| Gmail, all stored messages (28) | 11 | 0 | 9 | 1.00 | 0.55 |
| Graph, all stored messages (37; the 8 Cobra and Falcon messages are unlabelled and drew no event) | 12 | 0 | 10 | 1.00 | 0.55 |
| Held-out sentences (343) | 18 | 1 | 157 | 0.95 | 0.10 |

The demo set is the rules' own golden set, so its precision is in-sample; the held-out row is the out-of-sample figure. The rules are precise and narrow: seven milestone types, and they miss most milestones. The detector has no provider branch, so the two tracks score the same. The MD confirms every station either way.

The switch's on and off behaved as documented:

- **Gate closed.** With the capability off, the detector reads nothing (`capability_not_approved`), on both tracks.
- **On.** Gmail: 28 messages read, 11 events, 1 team pass, all audited. Graph: 37 messages read, 12 events.
- **Off.** Revoked: 0 active rows, 2 recompute requests queued, and the next run reads nothing. Rule events stay stored and directly readable (#784).

Locally the detector ran as `worker/extract.ts --rules`. On the hosted worker it needs a `detect` task, and `infra/discovery-worker/ecs.tf` defines none yet: a reviewed infra change and its deploy come first (blocker 3 below).

## AI surfaces and their gates

Every model call in this repository goes through the model gateway module (`src/lib/modelGateway/gatewayClient.ts`, `postGatewayMessages`). It sends zero data retention with Anthropic only on every call (`:153`), and a ZDR refusal turns AI off with no other route. `tests/model-egress-fence.test.ts` and `tests/model-call-fence.test.ts` hold that line. On `develop` today, off loopback, no tenant may use the gateway (`VERIFIED_MODEL_TENANT_IDS` ships empty), and the recorded replay is for `DEV_TENANT_ID` alone (`SYNTHETIC_MODEL_TENANT_IDS`). #684 (head `b10b6551`, draft) replaces that with **one tenant list on the prod host** that gates extraction, proposals, the pre-send screen, `/api/v1/screen` and codename suggestion. Jev is not on it, and its ids are still `_TBD` placeholders.

| Surface | Model call | Gate | Ran locally, recorded or stubbed | Hosted synthetic test tenant on `develop` | With #684 (`b10b6551`) and real ids |
|---|---|---|---|---|---|
| Deal proposals | `callModel` (`propose/run.ts:289`) to the gateway transport | `--propose`, flag `discovery_model_proposals_demo`, `assertProcessorAllowed`, `MODEL_PROPOSAL_TENANT_IDS`, the key | Graph `propose --graph -> called=21, cost $0`; Gmail `called=5` | **No:** `tenant_not_verified` or `host_not_verified`; a recorded replay is refused for a non-DEV tenant (`recorded_not_synthetic`) | Yes on the prod host: `MODEL_PROPOSAL_TENANT_IDS` derives from the one list |
| Extraction (model milestones) | `callModel` (`extract/run.ts:313`) | `assertProcessorAllowed` with `--transport gateway`, a budget from the estimate, the key | `extract -> sent=37, ok=37, assessed=5` (stub replies) | **No:** the list is empty | Yes on the prod host, switched on in the P2 = B order (checklist step 8) |
| Phase suggestions (rules) | none | `milestone_rules` row, and the `detect` task | `detect` (above) | Not yet: no `detect` task definition. No model is involved | n/a |
| Email drafting | **none: not built.** `src/lib/mail/drafts.ts` is composer storage in the browser; `DraftAgent` is a deterministic mock; `reply_draft` is only a planned purpose (`src/lib/ai/modelPolicy.ts:51`) | n/a | n/a | n/a (it does not exist) | n/a |
| Compliance screen (pre-send, and `/api/v1/screen`) | `postGatewayMessages` (`src/lib/compliance/llm.ts:513`) | `modelCallsAllowed(tenant, 'mail_send_screen' or 'mail_screen')`, the key, no flag. A refusal keeps the deterministic verdict | `tests/compliance-llm.test.ts` (fetch stubbed); hermetic e2e runs rules only | **No:** `not_local` | Yes on the prod host (`verified_tenant`) |
| Jev second opinion | its own `fetch` to `/v1/evaluate` with ZDR (`src/lib/ai/jev.ts:96`) | `mail_send_second_opinion`, flag `mail_jev_second_opinion`, non-prod only | none | No | No: Jev is not on the list |
| Codename suggestion | `postGatewayMessages` (`src/lib/gate0/codenameLlm.ts:94`) | `modelCallsAllowed(tenant, 'codename_suggest')`, the key. It falls back to the fixed sets | `tests/api-v1-codenames-suggest.test.ts` (fetch stubbed) | **No:** `not_local` (the fixed sets show) | Yes on the prod host (`verified_tenant`) |
| Bench, twin chat, skill runs | the separate Ignatious backend (`src/lib/ignatious/`), not this gateway | `IGNATIOUS_*` config, some flags | hermetic runs blank it | outside this gateway's ZDR rule | **Stay off** on the test and Ignatious tenants, pending the owner's #345 choice |

The 23 gate, fence and surface test files pass on `develop` (486 tests).

**What this means for "AI end to end, drafting included".** Two owner decisions are **pending**, not decided:

- **Drafting is not built.** The owner chooses between a post-freeze build (a purpose, a gate, a route and a UI) and showing the pre-send screen's rewrite instead. Either is a scope change, and the code freeze is the end of Oct 28.
- **Bench, twin chat and skill runs** stay off on the test and Ignatious tenants until the owner's #345 choice.

No separate live ZDR probe runs (#787 closed, fence kept): the first live AI calls are the real worker on the synthetic test tenants, through the gateway module that enforces ZDR on every call.

## Go/no-go (Proposed)

**Recommendation, Proposed: GO for the Oct 30 demo on the synthetic Google test Workspace, rules-only phase suggestions on the team inbox, with the MD placing each phase. M365 is the backup for "find the deals and place a phase" on personal mailboxes only, pending the owner's decision. NO-GO for reading a real customer mailbox by Oct 30.**

**Blockers before GO, all owner or hosted:**

1. **Release (G-24).** Promote develop (at least `3ecb764f`, plus whatever lands by the end-of-Oct-28 code freeze) to the demo environment. The Promote Actions apply each commit's migrations before the fast-forward. The promotion date is being set by the owner, the release co-owner and the team. Staging was last promoted before G-07 and G-02b.
2. **The demo tenant (G-17).** The Google test Workspace, for synthetic test mail only, is approved and being configured by the release co-owner. It must be connected and pass the #666 checklist's seeded dry runs: the Directory grants, the ingest group, the T1 probe, the exclusion policy and the index key. No live read has been made on any tenant yet.
3. **`milestone_rules` on the demo tenant (G-07 hosted).** Decided ON (owner, 2026-10-25). Still to do, in order, all owner and hosted:
   - a reviewed infra change and deploy that adds the `detect` task, which `infra/discovery-worker/ecs.tf` does not define. It must land before the freeze if detection is to be live on Oct 30;
   - the reviewed migration for the test tenant's firm, once the tenant exists;
   - one `detect` run.
4. **AI on the test tenant (G-13).** AI on synthetic test tenants is ON by the owner's decision, and on `develop` no AI surface runs on a hosted tenant other than DEV. #684 (`b10b6551`) opens extraction, proposals, the screen and codenames with one list on the prod host. It still needs the test tenants' real ids, #685 and owner approval, then the P2 = B switch order. The first live call is the real worker on a synthetic test tenant, after the owner's go-ahead on the key handling.

**Owner decisions pending (they shape the demo script, not GO itself):**

- Drafting (G-29): a post-freeze build, or show the pre-send screen's rewrite.
- Bench, twin chat and skill runs: off on the test and Ignatious tenants until #345 is decided.

**Blockers for the M365 backup (only if it is used; pending the owner's decision):** a new M365 test tenant (the earlier one expired on 2026-10-24); the reader's certificate path on the hosted worker (G-27); and the live steps in the checklist's [Backup: M365](../04-operations/demo-day-switch-checklist.md#backup-m365) section. Its story has no team inbox (G-28).

**Why no real customer mail:** "no connection yet" (owner, 2026-10-25), and an inbox that holds mail cannot be disconnected with purge yet (G-05). The Gmail scope set is also unsettled (G-06).

**Fallback:** the offline rehearsal path in the [team-inbox guide](./team-inbox-guide.md#offline-rehearsal-primary-path), on a local stack.

### Draft decision-log entry (Proposed; D125 reserved)

Develop's highest decision number is D121, and open branches claim D122 to D124, so this entry reserves D125. It moves into `docs/07-decisions/decision-log.md` as its own row once accepted.

> | D125 | 2026-10-25 | **The Oct 30 demo runs on the synthetic Google test Workspace, with rules-only phase suggestions on the team inbox and the MD placing each phase; M365 is the backup on personal mailboxes; no real customer mailbox is read by Oct 30** (Proposed). Two offline rehearsals (#173, develop `953e0692` and `3ecb764f`) passed the team inbox story on the production code path on the Gmail replay: connect, check, read, find both deals, keep team-only mail with its members, promote and phase both deals, and show the CCO the bell, both Audit Trails, the firm's team inbox trail and a chained log. On the Graph fixtures the discovery journey passed, but a Microsoft team inbox is refused at connect (`provider_unsupported`). GO depends on owner or hosted steps: the promotion after the end-of-Oct-28 freeze, on a date the owner sets with the release co-owner and the team; the test Workspace connected with its seeded dry runs passed; for `milestone_rules` (decided ON), the `detect` task added to the worker's infrastructure, the migration for the test tenant's firm and one `detect` run; and, for AI on the test tenant, #684 with real ids, switched on in the AWS runbook's P2 = B order. Two owner decisions are pending: email drafting (not built: a post-freeze build, or the pre-send screen's rewrite) and the Ignatious control plane (bench, twin chat and skill runs stay off until #345). The team-proposal lift (D118) stays off. The rule detector is precise and narrow (held-out precision 0.95, recall 0.10), and a person confirms every station. The first live model calls are the real worker on the synthetic test tenants, through the gateway module that enforces ZDR on every call; no separate probe runs (#787). Real customer mail waits for a connection, disconnect with purge (`[581 h1]`) and one Gmail scope set. Sources: owner decisions of 2026-10-25 (freeze, test Workspace primary and M365 backup, AI on synthetic test tenants, `milestone_rules` ON, #787), [demo rehearsal write-up](../03-engineering/demo-rehearsal-173.md), [demo-day switch checklist](../04-operations/demo-day-switch-checklist.md). | Proposed |

## Owner decisions needed

All pending:

- The go/no-go above, and the decision number when it merges.
- The promotion date (with the release co-owner and the team). The checklist assumes none.
- Drafting (G-29): a post-freeze build, or show the pre-send screen's rewrite. It is a scope change either way.
- Bench, twin chat and skill runs on the test and Ignatious tenants: the #345 choice. They stay off until then.
- #684: the test tenants' real ids and approval; then the go-ahead and the key handling before the first live call.
- The `detect` task's infra change and deploy, and whether it lands before the freeze.
- G-06: one Gmail scope set for the delegation, then the three docs made to agree.
- The M365 backup: whether to stand up a new test tenant, and the reader's certificate path on the hosted worker (G-27).
- G-26: which persona the demo seed gives the `m:` proposal and deal-create rights, if the accept is shown.

## Follow-ups, not blocking the demo

- **G-21:** a browser journey for accepting a proposal.
- **G-22:** the detector's type coverage (`closed`, `announced`, NDAs).
- **G-23:** stale text in the team-inbox guide's D120 status and in the G-03 witness annotation.
- **G-28 / `[581 h2]`:** a Microsoft team inbox.
- **#790:** content-free output for `m365:write-registration`.
- **#784:** rule events stay readable after a revoke.
- **G-18 / G-19:** build warnings.
