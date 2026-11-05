# ADR-0026: Admin-managed team inbox

Status: Proposed, 2026-10-18. Decision-log entry: D103. Issue #581. Built in twelve stacked PRs, `[581 1/12]` to `[581 12/12]`. Residual 4 is amended by D118 (issue #173, G-01), which builds the readable path behind an owner-gated switch and leaves the exclusion enforced.
Read [ADR-0020](./ADR-0020-mailbox-connection-deployment-and-shared-seam.md) (the guard) and [ADR-0022](./ADR-0022-google-workspace-mailbox-connection.md) (Google Workspace) first. This ADR covers only what a team inbox adds to them.

## Bottom line

- **A firm admin can connect a shared Gmail inbox such as `deals@<firm domain>`, with no person behind it.** Conductia checks the address in the Google Directory, reads it through the same #262 guard as any mailbox, and shows what it finds only to the colleagues the admin names.
- **The firm's attestation replaces the personal opt-in.** The admin confirms the address is a firm mailbox and not a person's. Conductia refuses any address that belongs to a known person, at connect and at every read.
- **Team mail is invite only.** Everyone outside the member list sees nothing from the inbox, including a banker who sees the same deal through their own mail and a colleague seated on a deal a member promoted from it. The CCO keeps metadata, as the control room does for every mailbox. A per-firm setting to share a team inbox's mail with the whole deal team, default off, is a follow-up.
- **Connect is Gmail-only for the Oct 30 demo.** Microsoft, disconnect with purge, model proposals on team mail and CCO approval before a second bank follow.

## In plain terms

- **Why.** The Oct 30 demo is "connect an Ignatious team inbox, find the deals, place a phase on each". Until now a mailbox could be read only when one named person had accepted an invite to that exact address and opted in from their own session. A shared inbox has no such person, so it could never be connected.
- **What changes.** The admin registers the address. The worker proves it is a real user mailbox, not an alias or a Google Group. The admin adds and removes colleagues. A colleague on the list sees the inbox's candidates and excerpts as if it were their own mailbox.
- **What does not change.** The guard runs before every page. Personal mailboxes, their opt-in and their visibility rules are untouched.

## Decision

Each item cites its source. "Proposed" marks our own choice. R-numbers are the design's (`03-design-discussion-team-inbox.md`).

1. **Admin-managed membership is the access model (R1).** The firm admin adds and removes the people who see the inbox's findings, the way a deal's admin decides whether it is archived or removed. Conductia's member list is the only access list; Gmail delegation is not consulted. Source: owner decision, 2026-10-17: "Admin managed. So an admin adds and removes people. Same as the deal management, the admin decides whether a deal is archived or removed if it's cancelled."
2. **A separate firm-owned registry, not rows in `allowed_mailboxes` (R2).** Proposed: `team_mailboxes` (one open row per tenant and address, close-once), `team_mailbox_members` (append-only, close-once), the views `allowed_team_mailboxes` and `team_mailbox_readers`, and `content_sources.team_mailbox_id` (the source has no owner; a trigger keeps it ownerless and keeps its address fixed). `allowed_mailboxes` keeps its meaning of one person per row (D68). Because every RLS helper joins on the owner, a team source is invisible until a helper has an explicit team branch, which fails closed.
3. **The firm's attestation replaces the opt-in; only a firm admin connects (R3).** Proposed: connect requires `app_is_firm_admin`, the `deal_discovery` flag, a Google provider resolved for the firm, and an attestation checkbox whose version is stored and audited. The registration survives the admin who made it; any firm admin manages it. Connect accepts an optional first-read window (today minus 730 days up to today), so the window is set before the first read.
4. **Members are owner-equivalent; nobody else sees team provenance (R4).** A member reads the inbox's texts, excerpts and deal email as an owner would. Eligibility: active, internal, seated in the firm, not a firm admin, not the caller. Source: the orchestrator's steer on design review B1, 2026-10-18 (team provenance requires current membership even where the viewer has personal evidence on the same candidate). Proposed: build it as a team branch in `app_owns_item`, leaving `app_item_has_allowed_source` and the colleague branch unchanged, so links, milestones and deal email follow the item rule with no change of their own.

   **Invite only on a deal too; sharing with the deal team is a later per-firm setting, default off.** Source: owner decision, 2026-10-19: items from a team inbox are invite only. A deal member who is not a reader of the inbox (an open member who is active, internal, seated in the firm and not a firm admin) sees none of its mail on the deal, even after a member promoted the candidate and the item attached to it. As built, a seat on a deal grants nothing here:
   - `discovery_item_owner_seated` (`20261019170000`) decides only which items a promoted deal's candidate gains: a team item attaches while some reader of its inbox holds a seat on the deal. It decides nothing about who reads them.
   - Every read of a team item is `app_can_see_candidate`, `app_can_see_item` or `app_owns_item`, and none consults a deal seat. That covers the candidate, links, items, texts, milestones, `discovery_item_metadata` (the deal email's subject, sender and date) and the deal email route, which reads under RLS. The guard's tool, search, retrieval and export reads admit only a reader (`team_mailbox_readers`).
   - The deal-scoped branches a seat does open (the deal's `stage_assessments`, and its `promote` and `dismiss_suggestion` corrections) carry no team content today, because milestone extraction and assessment inputs are team-blind (residual 3).
   - Asserted by `supabase/tests/discovery_promotion.sql` (a seated non-reader after a later attach) and `tests/integration/team-mailbox-visibility.test.ts` (the deal email for seated non-members).

   The sharing setting is a follow-up issue. Proposed hook: one predicate, a team analogue of `app_item_has_allowed_source`, that admits a team item to the colleague branch of `app_can_see_item` when the firm's setting is on and the viewer is seated on a deal the item's candidate is promoted to. The candidate rule would need the same deal-seat disjunct. Making extraction team-aware later would also put team milestones into the deal's stage assessment, which every deal member reads, so that change must take this rule into account.

   **Note (D120).** D120 takes this rule into account. Assessment inputs are now audience-aware, but team-derived evidence goes only into an assessment row scoped to its inbox (`stage_assessments.team_mailbox_id`), which has no deal branch. The deal's shared row, the deal's state, the promotion audit and `set_station` corrections are built from shared evidence only, and a dismissal of a scoped row is itself scoped. So the deal-scoped branches a seat opens still carry no team content; the reason is now the audience split, not team-blind inputs. See "Station suggestions on team mail (D120)" below.

5. **Removing a person closes the row; deals are untouched; the tenant lock comes first (R5).** Proposed: removal sets `removed_at`, `removed_by` and `removed_reason` (`removed`, `seat_lost`, `disconnected`) and refreshes the candidate visibility in the same transaction, so it takes effect on the next read with no job. Deal memberships and promoted deals stay. The member RPCs and the seat-loss trigger take `discovery_lock_tenant` before anything that writes audit or visibility, which is the order the worker's candidate upsert already keeps; a two-session DB test runs both orderings.
6. **Pause, Remove, Disconnect (R6).** Proposed:
   - **Pause** (existing control in ingestion health) is the reversible way to stop reads. It keeps everything.
   - **Remove** closes a registration whose source holds no mail, verified or not, and archives its empty source. It is the cheap way out when `deals@` turns out to be a group, a typo, or an address whose identity changed.
   - **Disconnect with purge** of a registration that holds mail is `[581 h1]`, after Oct 30. It runs the #461 purge on the team source under the tenant's retention policy.
   - Removing a member never purges.
7. **One verification gate on the shared read path; freshness only in the guard (R7).** Source: the orchestrator's answers to research Q1 and Q2 and the steer on design review B2, M3 and M4, 2026-10-18; the shape below is proposed.
   - Both worker entry points (`runOnce` and the sync job), before they read the ingest group, ask SQL whether the check is due (on the database clock) and, when due, ask the Directory. Live, a team inbox is read only as a direct member of the ingest group, which the Workspace admin adds it to; the card says when it is not.
   - A verified row is re-checked at the start of a pass once its last success is 15 minutes old. Pending and refused rows retry every tick.
   - The guard reads a team inbox only while `verified_at` is under 65 minutes old, and renews once mid-pass when it goes stale, so a long backfill or a re-read survives. A second refusal stops the pass.
   - RLS, visibility and the allowlist mirror use a timer-free view, so a Pause, a worker outage or a Directory blip stops reads and never what members already see.
   - A transient Directory error is recorded apart (`last_check_error`) and never flips Ready to Refused. Only a definitive answer does.
   - Every pass, backfill or delta, refuses when the Gmail profile is not the registered address.
8. **Person collisions fail closed at connect and at read; the address lock is deferred (R8).** Proposed: connect refuses an address that is a user's email, a pending or accepted invite's email, or a personal source (`person_address`), before it takes the source row lock. At read, the view drops an address that has since become a person's (`team_mailbox_person`). The advisory lock between connect and the personal grant is deferred, because the three checks and the fixed-source trigger already cover Oct 30.
9. **Audit carries ids and fixed codes only; the CCO is notified on connect; the guard is never bypassed (R9).** Proposed:
   - Five actions, named in the audit log as `discovery.team_mailbox_connected`, `discovery.team_mailbox_checked`, `discovery.team_mailbox_member_added`, `discovery.team_mailbox_member_removed` and `discovery.team_mailbox_disconnected`. Details hold ids, codes and `reason`, never an address.
   - The inherited writers (pause and resume, restart, the guard's refusal row, allowlist drift, and connect's own archive branch) write `teamMailboxId` instead of the address for a team source. Drift names a team address as `team:<id>`.
   - On connect, the firm's admins and the CCO receive a `mailbox_connected` notification. The notification names the address because it is addressed to them; it is not an audit row.
   - **Note, #173 (D116; Proposed).** A Directory refusal now notifies too, beside the connect notice, and both reach only the inbox's own firm company. When an inbox enters `refused`, or a refused reason changes, its firm's active, internal admins and CCOs get one `team_mailbox_refused` notification ("Team inbox failed the address check", `{teamMailboxId, address, reason, href: '/discovery'}`), written in the same transaction as the `discovery.team_mailbox_checked` row, which stays the audit record. A same-reason recheck, a recovery and a `directory_error` send nothing. Recipients are `users.company_id = team_mailboxes.firm_company_id`, never every company `firm_company_ids()` names; `[173 G-04 2/2]` moves the connect notice to the same predicate, so "the firm's admins and the CCO" above means that firm company only, not a second bank company in the same tenant. The audit rows stay ids and fixed codes; the firm's admin and CCO read them in the Team inbox audit trail on `/discovery`, through a definer read scoped to their firm company (D116), not through `audit_log_select`.
10. **Gmail-only connect for Oct 30 (R10).** Source: the task brief of 2026-10-17 (Ignatious is on Gmail, so Gmail comes first). `team_mailboxes.provider` is checked to `'google'`, and a Microsoft address is refused `provider_unsupported`. `[581 h2]` follows #275 and widens the check with Graph verification.
11. **Stack base, migrations and the audit CHECK (R11).** Proposed: phase 1 branches from `feat/461-1-purge-core`; migrations are `20261019100000` to `20261019170000`; `20261018120000` belongs to #275. The audit CHECK restatement carries #461's and #490's actions, whichever has merged, and `tests/audit-action-check-history.test.ts` catches a miss on rebase.
12. **What `deals@` is at Ignatious is an owner topic; the code is the same in every case (R12).** Source: owner, 2026-10-17/18. A real Workspace user mailbox is verified and read. A Google Group or Collaborative Inbox is refused with a plain reason and the empty registration can be removed.
13. **The Directory Users read is a prerequisite, with no fallback in code (R13).** Source: owner, 2026-10-17/18. See "What the bank's Workspace admin must grant".
14. **A colleague's personal mailbox cannot be connected as a team inbox (R14).** Source: owner, 2026-10-17/18. Refuse known people at connect and at read, require the attestation, notify the CCO, audit by ids. **Planned before a second bank:** CCO approval before the first read, as a `pending_cco` state the verdict refuses until a firm CCO approves.
15. **Twelve code PRs of about 400 lines, plus this docs PR (R15).** Source: the orchestrator, 2026-10-18. Deferred: the address lock and the "Team inbox" health label.

## What the bank's Workspace admin must grant

The Directory check calls `users.get` as the directory identity, with a token that carries both `admin.directory.group.member.readonly` and `admin.directory.user.readonly`. Both token paths (the keyless mint and the `generateAccessToken` fallback) request both scopes, so the group mirror is unchanged in behaviour.

The directory identity's custom role needs **Users: Read** beside the existing Groups: Read and Reports: Read. Without it every `users.get` answers 403, every team inbox shows `directory_denied`, and the card retries every tick until the grant lands. There is no fallback in code (R13). Role changes take up to 24 hours, so the grant belongs before the Oct 28 freeze, and by about Oct 27 at the latest. If it slips, the demo runs on the test Workspace.

A 404 on `users.get` is followed by `members.list` on the same address to tell a Google Group from a missing account. If the role can read only the allowlist group, that second call answers 403 and the card says "can't check this address yet" instead of "This is a Google Group". The live check below measures it.

## The live check (T1) has not run

**Owner decision, 2026-10-20: T1 gates the first live connect, not the merge.** The emailmask.uk trial has expired, no other test Workspace is available, and Ignatious's is not yet reachable. So T1 runs on the firm's own Workspace once its registration and the Users: Read grant exist, and a human reads the rows against the expected table before the firm admin presses Connect. A deviation stops the connect and goes back to decision 7. The stack may merge first: merged code reads nothing until a firm has a registration and an admin connects an address, and the verifier refuses any answer it does not expect.

`npm run google:probe-team` is the owner's hand-run probe. It prints status codes, Google reason codes, counts and yes/no only, never an address, id, token or mail, and it touches the trial Workspace only. For each of four addresses (an alias, a Google Group that is not the allowlist group, a suspended user, a real shared user mailbox) it reports `users.get` with the two-scope token, `members.list(maxResults=1)`, the DWD token mint and the Gmail profile. Once per run it lists the allowlist group's members with the same token, which confirms the added scope does not break the group mirror.

**Status on 2026-10-18: not run.** Every Directory answer in the verifier is built from Google's documented behaviour and tested against a scripted Directory, not observed. A deviation from the expected pattern goes back to decision 7 before the stack merges to `develop`. The exact steps and the expected rows are in [the team inbox guide](../03-engineering/team-inbox-guide.md#the-live-check-t1).

## Residuals, accepted

These two were accepted in design review round 2 (thread T8, 2026-10-18).

1. **The CCO keeps team metadata.** Date and sender domain of an allowlisted team item, never text. This matches the control-room carve-out for every other mailbox (D68). It uses a new helper, `app_item_cco_allowed_source`, so the CCO's branches reach team items without making `app_item_has_allowed_source` team-aware.
2. **Candidate-level aggregates.** `parties`, `first_seen_at` and `last_seen_at` can come partly from team evidence. Anyone who sees the candidate through their own mail sees those fields. The stage assessment cannot today, because its inputs are team-blind (residual 3). No team item, link, milestone, date, sender or deal-email row is exposed to a non-member, including a non-member seated on a deal promoted from the inbox (decision 4).

Two more follow from the build and are recorded here so they are not a surprise:

3. **Milestone extraction stays team-blind.** The extractor's selection (`discovery_extract_batch`, and its estimate `discovery_extract_pending`) admits an item only while `app_item_has_allowed_source` holds. That helper is unchanged on purpose, so no model extraction runs on a team inbox's mail and a team-only item gains no extracted milestone. Proposed: leave it for Oct 30, since the demo places phases by promotion, and decide it with model proposals on team sources.

   **Amended by D120.** "No model extraction runs on a team inbox's mail" holds: the helper, the extractor's batch and its estimate are unchanged, and `tests/constants-schema-sync.test.ts` pins that no D120 migration redefines them. The clause "a team-only item gains no extracted milestone" is amended: once the owner approves `milestone_rules` for a firm (D120 Q2: approved for Ignatious by the owner on 2026-10-23, once the rehearsal shows the expected phases), a deterministic rule detector that sends nothing out of the process may put milestones on that firm's mail, team mail included, and team-only evidence reaches only the inbox's readers. Whether a model ever reads team mail stays the owner's call: for now it does not (D120 Q1 decided as A, the rule detector, by the owner on 2026-10-23). Residual 2's "the stage assessment cannot" still holds for the shared assessment. Details in "Station suggestions on team mail (D120)" below.
4. **Model proposals stay owner-scoped.** A team source has no owner, so the proposal step does not run on it until `[581 h3]`. The demo places each phase by promotion.

   **Amended by D118: built, behind an owner-gated switch, and still enforced.** The exclusion is an owner decision, so lifting it stays the owner's call (Q1 below). What changed is that lifting it is now one reviewed change, not a redesign. As shipped nothing changes for any firm: the proposal step reads a person's own mailbox only, exactly as #683 left it.
   - **Two halves, both absent.** A team source reaches the step only when its firm company is in `TEAM_PROPOSAL_FIRMS` (`src/lib/discovery/propose/gate.ts`, frozen, empty) and holds a live `team_proposals` row in `discovery_tenant_approvals`, which only a reviewed migration can write. Neither is enough alone.
   - **Four checks.** The worker's hand-off, `discovery_begin_proposal_source`, `discovery_renew_proposal_source` (once per page, and before any model call or retry once the lease is nearly spent) and the writer (a live approval, and an open pass of the row's run whose lease has not lapsed) each check the switch. Any failure stops that source for the run. The step asks `begin` about every source before its first model call, so whether a source is a team inbox comes from its row in SQL, never from the caller, and the step keeps only the firms the reviewed list names, whatever it is handed. Until slice 4 merges, the writer refuses every team source outright, so no slice lets a team row in on its own.
   - **Audited.** A team source holds a leased pass: `discovery.team_mailbox_proposal_started` is written before the first model call and `discovery.team_mailbox_proposal_finished` on every exit. A pass a dead worker left open is closed as `unclosed` by the next propose run's sweep (`discovery_close_lapsed_proposal_passes`, once per run, whatever the switch now says), or by a later `begin`. Every approval change is `discovery.tenant_approval_changed`; an approval names a bank company of its own tenant and starts when it is written. Rows carry ids, a path, an outcome and integer counts, never mail text, a subject, an address or a deal name.
   - **Who reads the proposals.** The inbox's readers (the open members of decision 4) and the CCO of the inbox's own firm company, through `app_reads_team_mailbox`, and only for rows written under a pass. A firm admin, a removed member, a CCO of another firm company and anyone in another tenant read nothing. A refused or removed inbox has no reader. Reading does not need a live approval: revoking stops new passes and new rows, and rows already written stay readable to the same audience.
   - **The barrier tightens now, regardless of Q1.** A source's prompt, and the candidate a proposal row may name, are judged per source (`discovery_proposal_may_name`), so a team inbox's deal names no longer reach a banker's personal prompt, and no CCO or cross-mailbox path remains.
   - **Held.** The slice that shows pass rows and approval changes to the firm admin and CCO in the team-inbox audit trail (`feat/173-g01-trail-team-proposal-audit`, migration `20261023110400`) is held until #711 to #716 are on `develop`. The owner's flip PR is gated on it.
   - **Residual 3 is unchanged.** Milestone extraction stays team-blind, and nothing here lets a proposal become a deal (that is G-02).

## Owner question Q1: lift residual 4 for Ignatious's team inbox before Oct 30, and confirm who reads

**Answered (owner, 2026-10-23): B for Oct 30.** T1 is treated as "prefixes" (owner: "IDK but go with prefixes"), and the owner's rule is to lift residual 4 only if T1 = company names. So the G-01 lift stays off for Oct 30, and the switch ships empty as built: no `TEAM_PROPOSAL_FIRMS` entry and no `team_proposals` row. The options below stay on record for a later flip, which would be a new owner decision. The code is identical under A and B; C needs one more reviewed migration before its flip (below).

**The question.** Residual 4 says a team inbox gets no AI proposals. The build lets the owner lift it for one firm company through two reviewed changes (a `TEAM_PROPOSAL_FIRMS` entry and a `team_proposals` row). Should that be done for Ignatious before Oct 30, and is the reader set right: the inbox's members plus the CCO of the inbox's firm company?

**Why it is a business and risk call.** Proposed reading of the sources:
- **No rule decides it.** No regulation requires or forbids AI on a firm mailbox. [ADR-0024](./ADR-0024-sources-cost-and-regulation.md) calls such controls "risk-based choices to defend in the vendor-oversight conversation". The live duties are the bank's vendor oversight (FINRA Regulatory Notice 21-29, Reg S-P 2024; [ADR-0020](./ADR-0020-mailbox-connection-deployment-and-shared-seam.md)) and its MNPI information barriers. Residual 4 is an accepted product residual, not a rule.
- **The internal conditions do not change.** Model calls go ZDR-only through the enforcing gateway (owner, 2026-10-16). Model calls on real Ignatious content wait for #346 (D75, [ADR-0017](./ADR-0017-hybrid-data-residency.md) Amendment 1, condition 4).
- **Tier: Pilot.** The content is real Ignatious mail under D75's single-tenant pilot exception, whatever the event is called. The `sb_secret_` worker key is accepted for Demo and Trial only, so the narrower worker credential is a Pilot gate.

**What a reader sees.** A proposal row holds no body or subject, but it is not mere metadata:
- **The deal name** can be a target's or a bidder's name, which can be MNPI. It carries `codename_guess` sensitivity.
- **The phase** is the model's judgment of how far the deal has progressed.
- **Party domains** can identify a counterparty.
- **`c:` names** are candidates the readers and the CCO can already see; **`m:` names** are new, deals the rules missed.

| Option | What it does | Gains | Risk |
|---|---|---|---|
| **A. Lift for Ignatious; members plus the inbox firm's CCO read** | Flip PR adds the TS entry and the migration row | The AI finds `deals@` deals with phases, and the CCO sees both the proposals and every audited pass | Firm-wide shared mail, including outside parties' messages that may carry MNPI, goes to the ZDR processor. Model guesses, `m:` names included, reach every member and the CCO. They cannot become deals (G-02) and are labelled "Proposed · demo" |
| **B. Keep residual 4 through Oct 30; ship dark** | Nothing is flipped | No new exposure | If Ignatious's `deals@` threads carry no codenames (T1 = no), there are no AI-found team-inbox deals on Oct 30 |
| **C. A without CCO reads of proposals** | Flip as A, after its own migration and SQL test: `app_reads_proposal_source` stops calling `app_reads_team_mailbox` for a team source and uses a proposal-specific reader rule, the same allowlisted inbox and open, non-admin member test with no CCO branch. Dropping a CCO branch from `app_reads_proposal_source` alone would change nothing, because it admits the CCO through `app_reads_team_mailbox`. The shared helper keeps its CCO branch, so G-07 is unaffected | The same finds | The CCO still sees every pass but not the proposals, which loses gap-list step 7 (the CCO reads them). One more reviewed migration and test before the flip |

**Cost** (price from D91; volume unsourced):
- **Price.** D91 records Haiku 5.5 at $0.10 input and $0.50 output per MTok, from the gateway catalog snapshot of 2026-10-09 and not yet checked against Anthropic's list price. Bake-off A measured about $0.29 per 1,000 emails on synthetic mail without the known-deals list. Proposed estimate with the list: roughly $0.3 to $0.5 per 1,000 unrouted messages. Up to three attempts are billed per message, and a message in N mailboxes is billed N times.
- **Volume.** No figure exists for `deals@`. The first-read window defaults to 90 days and is at most 730 days ([team inbox guide](../03-engineering/team-inbox-guide.md)). The Oct 27 read-only rehearsal gives the real unrouted count before any flip. Even 10,000 unrouted messages cost single-digit dollars.

**Risk that cannot be undone.** Egress is permanent. Revoking the approval row stops a running worker at the next save or renewal, so at most one message per inbox, with its retries, is sent after the revoke commits; removing the TS entry stops only runs started from an image built after it (the [runbook](../04-operations/discovery-worker-aws-runbook.md#team-inbox-proposals-the-flip-owner-gated-not-built) gives the order). Mail already sent has been disclosed to the processor. ZDR means it is not retained, and the started and finished audit rows record which passes ran.

**Recommendation (Proposed).** If T1 = no (the threads carry no codenames), take A, flipped together with allow-list slice 3. If T1 = yes, take B, because the rules already find the deals. Under either, the reader set is A's. Keep residual 3 (milestone extraction on team mail) closed through Oct 30: G-07's `milestone_rules` reads rules only and sends nothing out of the process, so it is a separate switch.

**Gates for any flip**, whatever the answer (under C, also its reader migration and test): #684; allow-list slice 3 with the D91 go; the ZDR probe with the production key (runbook G11); the `discovery_model_proposals_demo` flag; #346; slices 1 to 5 merged; and the audit-trail slice merged (held today, see residual 4). The flip is described in the [runbook](../04-operations/discovery-worker-aws-runbook.md#team-inbox-proposals-the-flip-owner-gated-not-built).

## As built, and where it differs from the design

- **Audit action names.** The five actions are `discovery.team_mailbox_*`, matching the other discovery actions, not the bare `team_mailbox_*` the outline used.
- **Retry interval.** Pending and refused rows are due again after 4 minutes, not 5, so "every tick" holds when a check lands seconds into a 5-minute tick (`discovery_team_mailbox_check_due`).
- **The e2e journey has its own workflow.** `.github/workflows/e2e-team-inbox.yml` runs it, advisory and opt-in (a push to `develop`, the `e2e-team-inbox` label on a non-draft PR, or by hand), on its own reset stack seeded with Morgan's mailbox alone. It never runs inside `ci.yml` and is not a required check, because it mutates discovery state and needs Storm to have no personal copy of the mail. It keeps its video on every run.
- **Fixture checks.** In fixture mode a team inbox verifies when the replay folder holds its mailbox and is refused `not_found` otherwise. The fixture verifier throws in production.
- **Mixed candidate.** The demo's `deals@bank.example` twin shares one Kestrel message with Morgan's mailbox, which is the case the visibility tests and the journey use.

## Station suggestions on team mail (D120)

Proposed, 2026-10-22; D120; issue #173, gap G-07. It amends residual 3 and adds a note to decision 4. Engine and promotion changes are [ADR-0019](./ADR-0019-milestones-stage-engine-promotion.md), Amendment 1.

**The gap.** A deal seen only through a team inbox gets no station suggestion, because every input to the stage engine requires `app_item_has_allowed_source`, which is team-blind. The MD places such a deal blind at promotion. On real mail no deal gets a suggestion today, personal or team, because the model gate ships closed (#684). No deterministic phase signal existed to fall back on: codenames, prefixes, aliases and clustering decide which deal an email belongs to, not where it stands.

**The goal and its limit.** Source: the task brief of 2026-10-22 (the owner asked to start G-07 that day) and the owner decision of 2026-10-19 (decision 4, invite only). A team-only deal gets the same suggestion a personal-mail deal gets, and nobody outside the inbox's readers learns anything new from it.

**What is built** (slices 1a to 3a, migrations `20261023130100` to `20261023130500`, stacked branches, not yet merged). Proposed unless marked:
- **Two audiences.** An assessment row with `team_mailbox_id` null is the shared row, today's row, unchanged. A row with an inbox id is built from the shared evidence plus what only that inbox contributes. It is read by no one until slice 4 (fail closed).
- **Shared-only writes.** Deal state, the promotion audit and `set_station` corrections use the shared row only. A deal opens `closed` only when the shared row says so and cites a model-basis `closed` event. Dismissing a scoped row is refused (`42501`) until slice 4 (orchestrator call, 2026-10-22).
- **A purge tombstone.** A purge that deletes a stream's latest row writes an audited tombstone and queues a recompute, so no reader falls back to an older, pre-purge row.
- **One rule for an item's current events.** The model wins over rules for an item, even with zero events, and rule events count only through an approved firm (`discovery_rule_firm_ok`, which returns false until slice 3b).
- **Team provenance.** A member sees team mail labelled "Team inbox" in the milestone timeline and the evidence list; the timeline read "Your mailbox" before (wording and look: design to confirm).
- **Engine v2.** Rule events place a station and never set a lifecycle (orchestrator call on design review round 2).
- **The detector, `rules/v1`.** Pure TypeScript, seven milestone types, no model client, no logging, both pinned by a fence test. Measured on 2026-10-22: no false match on 105 hand-written negatives; 13 of 13 expected events on the demo seed; on the held-out set (343 sentences from an author who never saw the rule text), `tp=18 fp=1 fn=157 tn=168`, precision 18/19 (0.95) and recall 18/55 (0.33) on the seven types it covers.

**Built once G-01 reached `develop`** (each cut only once the G-01 slice it needs was there; orchestrator call, 2026-10-22), stacked and not yet merged:
- **Slice 3b** (#753, `20261023130600`, on G-01 slice 2, `20261023110100`): the detection ledger, rule events, the detect batch and writer, the worker's `--rules` mode and the `detect` entrypoint, all behind the approval below.
- **Slice 4** (#754, `20261023130700`, on G-01 slice 4, `20261023110300`): scoped rows and scoped dismissals readable by the inbox's readers through `app_reads_team_mailbox`.
- **Slice 5** (#766, `20261023130800`, on G-01's trail slice, #752, `20261023110400`, on `develop`): each detection pass in the team-inbox audit trail.

**Who will read a scoped suggestion** (slice 4; the reader rule is G-01's, by orchestrator call):

| Person | Sees |
|---|---|
| An open member of the inbox (decision 4) | The scoped row and any scoped dismissal; every cited event resolves |
| The CCO of the inbox's firm company | The scoped row |
| A colleague who sees the candidate through their own mail | The shared row only |
| A seated deal member who is not a reader, and the firm admin | The shared row only; no team-derived step in readable corrections, audit or deal state |
| A CCO of another firm company in the tenant | No scoped row. That CCO can already read team-only milestone metadata through the tenant-wide CCO branch (thread T-9, a gap that predates D120) |
| Anyone in another tenant, a removed member, or anyone once the inbox is refused | Nothing scoped |

**The switch.** Settlement (orchestrator, 2026-10-22): G-07 consumes G-01's `discovery_tenant_approvals`; a `(tenant, firm company, 'milestone_rules')` row is the whole switch, because nothing leaves the process. The row is checked in the worker before any mail is read (a read error counts as off), in the batch, in the writer, and in `discovery_current_event_ids`. A rule event joins the shared row only through a personal or site source of an approved firm, and a team row only when that inbox's firm is approved, so one firm's approval never reaches another firm's shared row. No row ships. The flip and the revoke are reviewed migrations with G-01's existence guard, and the hosted `detect` task is an owner step; both are in the [runbook](../04-operations/discovery-worker-aws-runbook.md#milestone-rules-the-detect-task-and-the-per-firm-switch-owner-steps-not-applied). A revoke needs no purge: rule events leave every timeline at once and every assessment at the next `detect` run, which drains the recompute outbox even with no approval. Rule events stay stored and stop counting.

### D120 owner question Q1: what puts milestones on team-only mail

**Decided: A, the rule detector** (the owner, 2026-10-23). Residual 3 stays closed: no model reads team-only mail. The option table and the reasoning below are kept as the record the owner decided on.

Tier: Demo (Oct 30) on real Ignatious mail, carrying into the pilot. Slices 1a to 2b are the same under every answer.

| Option | What it does | Cost | Risk and driver | Reversal |
|---|---|---|---|---|
| **A. The rule detector only; residual 3 stays closed** | `rules/v1` on the approved firm's personal, site and team mail | Slice 3b, about 400 lines plus the corpus; regex in the worker; no processor, no `ai_usage` rows; one ECS task the owner applies | Precision. A wrong match can place a station, never a lifecycle, and the MD still decides at promotion. Stays inside the internal ZDR mandate (ADR-0017 decision 6), since nothing leaves the process | A revoke migration, effective at the next `detect` run, no purge |
| **B. Model extraction lifted for the firm** | Team mail goes to the ZDR processor | A new capability value and a reviewed TS list, which widens the settled CHECK (an orchestrator call). About $0.011 per email, about $55 per 5,000 emails once, from Sonnet 5 at $2 and $10 per million input and output tokens (`src/lib/ai/pricing.ts`) and the estimator's 3.0 bytes per token and 600 output tokens (`src/lib/discovery/extract/estimate.ts`), at an assumed 4 KB body. Body size and inbox volume are unsourced; `entrypoint.sh estimate` prints the real figure | Better precision, but nothing lights before #684, allow-list slice 3, the ZDR probe with the production key and output placement all land. Firm-wide shared mail, including outside parties' messages that may carry MNPI, goes to a processor. Same family as D118 Q1 | A revoke stops new calls; mail already sent has been disclosed to the processor under ZDR |
| **C. Both** | Rules now, the model once the gate opens; the model wins per item | Both | Both | Both |

No external rule (FINRA or SEC) mandates either option `[reasoning; not legal advice]`. Recommendation (Proposed): A now, and decide B together with D118 Q1 after Oct 30. A is the only option that places a team-only deal on Oct 30 whatever happens to #684, and its failure mode is visible and reversible.

### D120 owner question Q2: approve `milestone_rules` for the Ignatious firm before Oct 30

**Decided: approve `milestone_rules` for Ignatious once the rehearsal shows the expected phases** (the owner, 2026-10-23). The flip migration and the ECS `detect` step stay owner steps: no PR inserts the approval row or applies the task. The gates below are what the flip needs in order to run, and they still stand; with Q1 decided as A, the first of them is met.

Tier: Demo on real Ignatious mail, and the start of the pilot unless revoked.

- **What "on" means.** One guarded migration row for the Ignatious tenant and firm company. It covers only the allowed mail of that firm's sources: its seated bankers' personal mailboxes, its registered sites and its verified team inboxes. Ignatious MDs would then see rule-based station suggestions on real deals, personal-mail deals included, which have none today.
- **Cost.** Owner time to review the flip (and, if needed, the revoke) and to apply one ECS task change. Runtime is regex in an existing worker container; the Fargate minutes are small but unmeasured `[unsourced]`. No model spend.
- **Driver.** Risk-based only: the accuracy of an advisory suggestion and the MD's trust in it. No mail leaves the process, so the internal ZDR mandate is not engaged.
- **Options.** A: approve before Oct 30, once every gate below is met. B: no approval until after Oct 30; phases are placed by promotion, as this ADR planned, and approval follows a week of MD feedback on the dev tenant. "Team inboxes only" is dropped: the same LOI email would produce a milestone from `deals@` and none from the MD's own copy.
- **Gates for the flip, whatever the answer:** Q1 answered A or C; the Ignatious tenant id and firm company id (#684); G-01 slices 2 and 4 and D120 slices 1a to 4 merged (Proposed: slice 5 too, so the firm admin and CCO see each pass in the audit trail, as D118 gates its flip on its trail slice); the hosted `detect` task; precision measured on the negatives and on the held-out set; and the rehearsal showing the expected stations on the synthetic corpus, with a local approval row inserted with `psql` on the loopback stack only.

Recommendation (Proposed): A, gated on the held-out precision and the rehearsal. The switch is per firm, audited and reversible without a purge, and a rule match can only suggest a station.

**Residuals, recorded** (threads in the G-07 task folder): after promotion a deal member or the firm admin still reads shared assessments whose evidence they cannot resolve, as ADR-0019 intends (T-3); a scoped dismissal's audit row shows deal overseers that a dismissal happened, with no step or reason (T-3); a `chosenStepSeq` the MD left at a default from a scoped suggestion is recorded in the shared promotion audit as the MD's explicit submission (T-3); the CCO gap above (T-9); and ingestion's quote stripping misses a wrapped "On ... wrote:" opener, which the detector cuts for itself (T-10).

## Not built, by impact

| Gap | Why it matters | Blocks Oct 30? |
|---|---|---|
| The T1 live check (owner) | The verifier's Google answers are not yet observed | Yes, before the first live connect (owner decision 2026-10-20), not before merge |
| Users read granted to the directory identity (owner, Ignatious IT) | Without it every team inbox is refused `directory_denied` | Yes. There is no test Workspace to fall back on yet (emailmask.uk expired; a paid dev Workspace was approved on 2026-10-20, see [its setup checklist](../04-operations/dev-google-workspace-setup.md)) |
| What `deals@` is at Ignatious (owner, T2) | A group or Collaborative Inbox cannot be read | Yes, if it is a group |
| Disconnect with purge (`[581 h1]`) | A verified inbox can be paused and its people removed, but not disconnected | No |
| Microsoft team inboxes (`[581 h2]`) | A Microsoft address is refused | No |
| Notifications to a member, model proposals on team mail (`[581 h3]`) | A member is not told, and the proposal step skips team mail | No |
| CCO approval before the first read | A firm admin's attestation is the only gate | Before a second bank |
| Per-firm setting to share team mail with the deal team (default off) | Team mail is invite only; a non-reader on the deal sees none of it (decision 4) | No |
| Window audit under #576 | If #576's window writer lands after this, it must write `teamMailboxId`, not the address, for a team source | No |
| The "Team inbox" label in ingestion health, the address lock | Deferred (R15, R8) | No |
| The flip PR for AI proposals on a team inbox (D118) | Built dark: the switch ships empty, so a team inbox gets no proposals until the owner lifts residual 4 | No. Owner, 2026-10-23 (Q1): off for Oct 30; lift only if T1 = company names |
| Team-inbox audit trail for passes and approvals (`feat/173-g01-trail-team-proposal-audit`, D118) | Held until #711 to #716 are on `develop`. Pass and approval rows are written, but the firm admin and CCO do not see them in the trail yet | Gates the flip PR |

## Alternatives considered

| Option | Why not |
|---|---|
| Null-user rows in `allowed_mailboxes` | Breaks its "one person per row" meaning and every helper that joins on the user |
| A synthetic invite and consent for the inbox | Invents a person who never consented |
| A team source owned by one named user | The inbox then disappears with that person, and they alone read it |
| Mirroring Gmail delegation as the member list | The bank's delegate list is not the admin's decision (R1). Suggesting delegates stays a parked follow-up (T4) |
| Reading a Google Group or Collaborative Inbox | Google exposes no API for it, so the verifier refuses a group address outright |
| Freshness in the views | A Pause or a Directory blip would hide members' candidates and flip allowlist drift |
| Verifying in the Next.js app | The app cannot mint a Google token in production, so the worker verifies |

## References

Migrations `20261019100000_team_mailboxes.sql` to `20261019170000_team_mailbox_attach.sql`. `src/lib/google/reader/directoryUser.ts`, `worker/teamMailbox.ts`, `src/lib/mailboxAccess/` (mirror, readers), `src/components/discovery/TeamInboxes.tsx`, `src/app/api/v1/discovery/team-mailboxes/`, `scripts/google/probe-team-mailbox.ts`, `e2e/journeys/team-inbox-demo.spec.ts`. SQL suites: `supabase/tests/team_mailboxes.sql`, `discovery_rls.sql`, `discovery_promotion.sql`; `tests/db/team-mailbox-lock-order.test.ts`; `tests/integration/team-mailbox-visibility.test.ts`. Guide and runbook: [team-inbox-guide.md](../03-engineering/team-inbox-guide.md). API: [api-v1.md](../03-engineering/api-v1.md). Related: ADR-0018 (deal discovery), ADR-0020, ADR-0022, D68, D93. Issue #581; stacks #461 and #490; threads T1 to T8 in the task folder.
