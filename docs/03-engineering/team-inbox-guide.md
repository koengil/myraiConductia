# Team inbox: admin guide, live check and demo runbook

Audience: the firm admin who connects a shared inbox, the bank's Google Workspace super admin who grants the Directory read it needs, and the Conductia team running the Oct 30 demo. Decision: [ADR-0026](../07-decisions/ADR-0026-team-inbox.md) (number to confirm at merge). API: [api-v1.md](./api-v1.md), section "Deal discovery". Issue #581.

A team inbox is a shared Gmail account such as `deals@<firm domain>` that no one signs in as. The firm admin registers it, Conductia checks the address in the Google Directory, the worker reads it through the same mailbox guard as any mailbox, and the admin decides which colleagues see what it finds. Gmail only for now: a Microsoft address is refused.

Read [google-workspace-reader-admin-guide.md](./google-workspace-reader-admin-guide.md) first. A team inbox needs that registration, the delegation grant and the ingest group in place.

## What the bank's Workspace admin sets up

Two additions, on top of the reader admin guide:

1. Admin console > Account > Admin roles, open the custom role assigned to the Conductia **directory** service account.
2. Add **Users: Read** beside Groups: Read and Reports: Read. Nothing else.
3. Allow up to 24 hours for the role change to apply.
4. **Add the team inbox directly to the ingest group, by its primary address.** Admin console > Directory > Groups, open the ingest group (`conductia-ingest@<domain>`), Add members, and enter the team inbox's primary address (`deals@<domain>`, not an alias). Membership through another group does not count. A person is added to the group when they opt in; nobody signs in as a team inbox, so nobody else adds it. Until it is a direct member, every pass is refused and the card shows **Not in the ingest group**.

Why: the Directory check calls `users.get` to confirm the address is a real, active user mailbox. Without Users: Read every call answers 403, every team inbox shows "Refused: can't check this address yet", and the card retries every tick until the grant lands. Conductia has no fallback, on purpose. The directory identity keeps no delegation and no mail access.

Two facts to know:

- **Group detection.** When `users.get` finds nothing, Conductia asks the Directory for the group's members to tell "a Google Group" from "no such account". If the role can read only the ingest group, that second call is denied and the card says "can't check this address yet" for a group address instead of "This is a Google Group". The live check below shows which case applies.
- **The reader is unchanged.** The delegation grant stays exactly `gmail.readonly` and `gmail.metadata`. The address must be a user mailbox the reader can impersonate. A Google Group or Collaborative Inbox has no mailbox Google lets any app read.

Do this before the Oct 28 freeze, and by about Oct 27 at the latest. Never change a role or delegation on demo day.

## For the firm admin: connect a team inbox

Open `/discovery` as a firm admin. The "Team inboxes" card sits under ingestion health. It shows for firm admins only (not for the CCO or a banker) and only while the `deal_discovery` flag is on.

1. Enter the address, for example `deals@yourfirm.com`.
2. Optional: set **First read from**, a date between today and 730 days back. Set it now. The first read starts on the first pass after the address check, and the window decides how far back it goes. Left empty it is the last 90 days.
3. Tick the attestation: "This is a mailbox the firm owns and may read, not a person's. Conductia will read it to find deals." The version of that text is stored and audited.
4. Select **Connect team inbox**.

What follows, with no further action:

| What you see | What is happening |
|---|---|
| **Checking the address** | Connected. Nothing is read. The worker checks the address in the Directory on its next tick |
| **Ready** | The Directory confirmed an active user mailbox. The worker reads it on its passes |
| **Not in the ingest group** | The Directory confirmed it, but the worker's last read was refused because the address is not a direct member of the ingest group. The Workspace admin adds it (step 4 above); reading starts on the next pass |
| **Can't read the ingest group** | The worker could not read the ingest group on its last pass, so it read nothing. It tries again on the next pass; if it persists, check the directory identity's permissions |
| **Refused** and a line of text | A definitive answer from the Directory. The card keeps retrying every tick, so granting the missing access turns it Ready on its own |
| **Paused** | A firm admin paused reading (below). The inbox is still verified |

A Ready inbox shows "Last check failed, retrying" when the last check did not reach Google. That is a blip, not a refusal: reads continue until the last successful check is 65 minutes old, and the status never flips on one failed call.

### Why an address is refused

The wording below is the card's draft copy (design to confirm).

| Reason | What the card says | What it means and what to do |
|---|---|---|
| `group` | "This is a Google Group. Conductia reads a user mailbox; connect the account the group delivers to." | The address is a group or Collaborative Inbox. Remove the empty registration (below), then connect a licensed user mailbox the group routes into |
| `alias` | "This is an alias. Connect the primary address." | The address is an alias of a user. Connect the user's primary address |
| `suspended` | "This account is suspended in your Workspace." | Restore the account, or connect another. The card turns Ready on its own after the next check |
| `no_mailbox` | "This account has no mailbox yet." | The account exists but has no Gmail mailbox set up |
| `not_found` | "Not found in your Workspace." | No such account. Check the spelling and the domain |
| `identity_changed` | "This address now belongs to a different account. Connect it again." | The address was handed to another account since the first check. Conductia pins the Directory id on the first success and refuses a change. Remove the registration if it holds no mail, then connect again; one that holds mail waits for disconnect with purge (h1) |
| `directory_denied` | "Conductia can't check this address yet. Your Workspace admin needs to grant directory read." | The directory role lacks Users: Read (above), or cannot read that group |

Refusals at connect (the form shows the message in place):

| Code | What the form says | Meaning |
|---|---|---|
| `person_address` | "This is a person's address. They connect it themselves from their profile." | A user, a pending or accepted invitation, or a personal source already holds the address. A colleague's own mailbox cannot be registered as a team inbox |
| `provider_unsupported` | "Team inboxes on Microsoft 365 are not available yet." | Microsoft is a later slice |
| `provider_unresolved` | "Conductia cannot tell which mail provider serves this address. Check that its domain is registered to your firm." | The address's domain is in no reader registration for your firm |
| `out_of_range` | "Choose a start date within the last 730 days, no later than today." | The window is outside its bounds |
| `invalid_address` | "Enter a full email address, such as deals@yourfirm.com." | Not an address |
| `not_eligible` | "Only the firm admin can connect a team inbox." | The caller is not an active firm admin |

Connecting an address that is already connected returns the existing row and writes nothing.

### Add and remove people

Each inbox lists "People with access" and an **Add** control. Only colleagues who are active, internal, seated in the firm and not firm admins can be added. A firm admin cannot add themselves: an admin's `/discovery` shows ingestion and administration, not candidates. Add the MDs and bankers who should see the deals found in the inbox.

- **Add** takes effect on the next read of the candidate list. No job runs.
- **Remove** asks to confirm, then closes the membership. The person stops seeing the inbox's candidates, excerpts and deal email on their next read. Their own mailbox, their deals and their deal memberships are not touched, and a deal they promoted stays.
- **A person who loses their seat** in the firm is removed automatically, recorded as `seat_lost`.
- The membership is closed, never deleted, so the history stays.

### What a member sees, and what nobody else does

A member sees the inbox's candidates, their evidence and excerpts, the milestones and links on them, and the inbox's rows in the deal email view, as they would for their own mailbox. They can promote a candidate whose evidence is team mail and place it at a phase.

Everyone else sees nothing from the inbox: no item, link, milestone or deal-email row, even on a candidate they reach through their own mail. Team mail is invite only on a deal too: colleagues a member seats on a deal promoted from the inbox see the deal, and none of the inbox's mail on it unless the admin adds them to the inbox. A per-firm setting to share team mail with the whole deal team (default off) is a follow-up. Two limits are accepted (ADR-0026, residuals):

- **The CCO** sees an allowlisted team item's metadata (date, sender domain), never its text, as for every mailbox.
- **Candidate-level fields** (parties, first and last seen) can come partly from team evidence and are visible to anyone who sees the candidate through their own mail.

Two more limits: milestone extraction by a model does not read team mail yet, and model proposals do not run on team sources as shipped (the owner has not lifted ADR-0026 residual 4; the switch that would is described in [AI proposals on a team inbox](#ai-proposals-on-a-team-inbox-built-off)). Phases are placed by promotion.

### Pause, Remove and Disconnect

| Action | Where | Effect | When it applies |
|---|---|---|---|
| **Pause / Resume** | Ingestion health, on the inbox's source | Stops reading, keeps every stored item, link and member. Resume reads on | Any time. The reversible "archive" |
| **Remove** | The inbox row on the Team inboxes card, with an inline confirm | Closes the registration, archives its empty source, closes any members. The address can be connected again | Only while the inbox holds no mail, verified or not. For example a `deals@` that turned out to be a group, or a typo. Closed as `never_verified`, or `no_mail` once it had verified |
| **Disconnect with purge** | Not built (`[581 h1]`, after Oct 30) | Will run the #461 purge on the team source under the tenant's retention policy | A verified inbox, or one that holds mail |

Until h1 ships, an inbox that holds mail can be paused and its people removed but not disconnected. Removing a person never deletes mail.

### Audit

Every row about a team source carries ids and fixed codes only, never an address: `discovery.team_mailbox_connected`, `_checked` (written on a change of status or reason only), `_member_added`, `_member_removed` and `_disconnected`. The pause, restart, first-read window, guard-refusal and allowlist-drift rows name the registration id for a team source, and so do a refusal or a drift entry for the address of a registration that was closed (unless a person's own source holds the address now). On connect, the admins and the CCO of the inbox's own firm company receive a `mailbox_connected` notification, which does name the address. Another bank company registered in the same tenant is not told (#173, since `[173 G-04 2/2]`).

### Who is told when the address check refuses (#173)

When the Directory check refuses a team inbox, or a refused inbox's reason changes, every active, internal admin and CCO seated in the inbox's own firm company gets one notification in the bell:

- First line: "Team inbox failed the address check".
- Second line: the address and a short reason, for example `deals@yourfirm.com · Directory read not granted`.
- It links to `/discovery`.

| Reason | Short reason in the bell (design to confirm) |
|---|---|
| `group` | Google Group, not a mailbox |
| `alias` | Alias, not the primary address |
| `suspended` | Account suspended |
| `no_mailbox` | No mailbox yet |
| `not_found` | Not found in Workspace |
| `identity_changed` | Address moved to another account |
| `directory_denied` | Directory read not granted |

It is sent once per change, never on each retry: a recheck that finds the same refusal sends nothing, and neither does a recovery to Ready, a first Ready or a check that did not reach Google ("Last check failed, retrying"). An inbox that goes refused, Ready, refused is told twice. The notification carries the inbox's id, its address and the fixed reason code, never mail. The `discovery.team_mailbox_checked` audit row written with it stays the record. With no admin or CCO seated in the firm nobody is told, and the audit row is still written.

The bell reads the feed again when it is opened, and when the tab becomes visible again (at most once every 30 seconds), so a refusal that lands while the page stays open shows without a reload. A failed read keeps what the bell already shows.

### The team inbox audit trail (#173)

On `/discovery`, the **Team inbox audit trail** shows the firm's own team-inbox rows from the tamper-evident audit chain. The firm admin sees it under the Team inboxes card, and the CCO under Ingestion health. Nobody else sees it, and it shows nothing for a firm that has never held a team inbox. It reads `GET /api/v1/discovery/team-mailboxes/audit`, which answers only an active, internal admin or CCO of a firm company that holds a team inbox, open or closed, and returns only that company's inboxes and rows (D116).

| View | What it lists |
|---|---|
| **Access and checks** (default) | Connected, each address check (Verified or Refused, with the reason), access given or removed (naming the person), paused, resumed, restarted, first-read window set, removed, refused reads, and the Google ingest group's state as a firm event under "All team inboxes". Once `[173 G-03 4/4]` lands, also the deals firm rules proposed from the inbox's mail |
| **All reads** | Every reader pass of the inbox's sources, started and finished |
| **Reads with mail or problems** | Finished passes that stored or excluded mail or did not complete ("12 fetched, 3 excluded by policy, 9 stored"), and started passes with no finish recorded after an hour |

Each row has Time, Inbox, Action, Detail and By. The Inbox column shows the address, "All team inboxes" for an ingest-group event, or "Removed inbox" once a registration is closed. The By column names the real actor: "by <name>" for a person, or the service by its own label ("Discovery worker", "Team inbox access rule" when a membership closed because its person lost their seat). "Show older" pages back. Rows carry ids, fixed codes, counts and names only; the address comes from the registry and is never stored in a row. The layout and the copy are design to confirm.

Limits: until `[173 G-03 4/4]` merges (a stacked PR, built, not landed), the trail has no "Proposed a deal candidate" rows. After it, a candidate created before it carries no attribution, team mail added later to an existing candidate is not recorded, and the trail shows how many messages formed a candidate, never its name. The deal Audit Trail is unchanged: these rows belong to no deal.

## Station suggestions on team mail (D120: built in part, held, off)

**Status.** Decision: D120 (number to confirm at merge), and [ADR-0026](../07-decisions/ADR-0026-team-inbox.md), "Station suggestions on team mail (D120)". Issue #173, gap G-07. The parts that need nothing from G-01 are built on stacked branches and not yet merged. The detector's wiring (slice 3b, #753), the scoped read (slice 4, #754) and the audit-trail entry (slice 5, #766) are built on the G-01 slices they need, which are on `develop`, and are not merged yet. No firm is approved, so no suggestion changes for anyone until the owner flips the per-firm switch. The owner decided both questions on 2026-10-23: Q1, the rule detector puts milestones on team-only mail; Q2, `milestone_rules` is approved for Ignatious once the rehearsal shows the expected phases. The flip migration and the ECS `detect` step stay owner steps, so nothing changes until the owner applies them.

**What changes before any approval.** Once slice 2b merges, a member sees team mail labelled **Team inbox** in the milestone timeline's Source column and as a line under the subject in the evidence list; the timeline read "Your mailbox" before (wording and look: design to confirm). Nothing else a member, a colleague, the CCO or the admin sees changes.

**What the switch turns on.** With an approved firm, a deal found in that firm's team inbox shows a suggested station, the reason sentence (for example "LOI Review because LOI signed on 18 Sep 2026 (1 email)") and its evidence, to the inbox's readers only. The milestones come from a rule detector that reads the stored text inside the worker and sends nothing anywhere; no model reads team mail (ADR-0026 residual 3 holds). A rule match places a station and never closes or pauses a deal, and the MD still sets the station at promotion.

### Who sees a team-inbox suggestion

| Person | Sees |
|---|---|
| An open member of the inbox | The team suggestion and any dismissal of it; every cited email resolves |
| The CCO of the inbox's firm | The team suggestion (milestone metadata only, never text) |
| A colleague who sees the deal through their own mail | Only the suggestion built from evidence they could already see |
| A colleague seated on the deal who is not a member, and the firm admin | The same shared suggestion as today; the deal's state and audit carry nothing from the team inbox |
| A CCO of another firm in the tenant | No team suggestion (a pre-existing gap lets that CCO read team milestone metadata in a multi-firm tenant; Ignatious is a single-firm tenant) |
| A removed member, anyone in another tenant, or anyone once the inbox is refused | Nothing from the inbox |

When the inbox stops adding evidence the shared view lacks, its suggestion ends and readers see the shared one. A purge never brings back an older suggestion.

### Turning it on and off

- **On** is one reviewed migration that adds a `milestone_rules` row for the firm, then a run of the hosted `detect` task. Both are owner steps in the [runbook](../04-operations/discovery-worker-aws-runbook.md#milestone-rules-the-detect-task-and-the-per-firm-switch-owner-steps-not-applied).
- **Off** is one reviewed migration that revokes the row and queues a recompute. Rule milestones leave every timeline at once and every suggestion at the next `detect` run. Nothing is purged: the rule milestones stay stored and stop counting, and consent, tenant and orphan purges still remove them with their mail. A revoke stops counting; it does not hide: anyone who can see a message can still read its stored rule milestones directly, as they can read the message itself (a stricter read path is a logged follow-up).
- Nothing in the product flips the switch, and a firm admin has no control for it.

### For the demo

Until the owner approves the firm, the rule in the demo runbook stands: phases are placed by promotion, and no one promises automatic phase suggestions on team mail. To rehearse the approved state once slices 3b and 4 are merged, insert a local `milestone_rules` row for the dev tenant and firm with `psql` on the loopback stack, never on a hosted database. On the demo corpus, the member (Storm) should then see Kestrel suggested at LOI Review with the team-only `kestrel-015` among its evidence, and the colleague (Morgan) the shared suggestion only.

## How reads work, in one page

- **The check.** At the start of each pass, before the ingest group is read, the worker asks, on the database's clock, whether the Directory check is due: never checked; verified and 15 minutes old; or not verified and 4 minutes old. A due check calls `users.get` and records the result, so an inbox verified on this tick is read on this tick.
- **The ingest group.** Live, the worker reads a mailbox only when its address is a direct member of the ingest group. A team inbox outside it is refused `not_in_provider_group` on every pass, and the card says **Not in the ingest group**.
- **The read.** The guard allows a team inbox for the worker's own read only while the last successful check is under 65 minutes old. A stale check is renewed before a pass at 15 minutes and once mid-pass, so a long first backfill or a re-read finishes. A second refusal stops the pass.
- **What a stale check does not do.** It never hides what members already see and never flips allowlist drift. A Pause, a worker outage or a Directory blip stops new reads and nothing else.
- **Every pass** (backfill or delta) starts with the Gmail profile and refuses when it is not the registered address.
- **Tool, search and export reads** of a team inbox must name a current member as the acting user. Only the worker's own read may name no one.
- **A person's address.** If a user or an invitation later takes the address, the guard refuses it as `team_mailbox_person` and nothing is read.

In ingestion health, a team source that waits shows one of: "Waiting for the address check", "The team inbox was removed", "This is a person's address".

## AI proposals on a team inbox (built, off)

**Status.** Built and off for every firm. ADR-0026 residual 4 (a team inbox gets no AI proposals) is still enforced, and lifting it is the owner's call. The owner answered on 2026-10-23 (ADR-0026, "Owner question Q1"): off for Oct 30, because T1 is treated as "prefixes" and the rule is to lift only if T1 = company names. Decision: D118 (number to confirm at merge). Nothing on this page changes what a firm admin or a member sees until the owner flips the switch.

**What it does when on.** For a team inbox of an approved firm company, the worker asks the model about each message the firm's rules left unrouted, as it does for a person's own mailbox (the "Proposed from mail by a model" section on `/discovery`, D91). Each answer is a row with a deal name, a phase and party domains. It holds no body, no subject and no address. A proposal cannot become a deal: placing a phase is still a promotion by a person.

### Who sees the proposals

| Person | Sees a team inbox's proposals |
|---|---|
| An open member of the inbox (active, internal, in the firm, not a firm admin) | Yes |
| The CCO of the inbox's own firm company | Yes (the owner may drop this: Q1 option C, which needs its own reader migration first) |
| A firm admin | No |
| A removed member | No |
| A CCO of another company in the tenant | No |
| Anyone in another tenant | No |
| Anyone, once the inbox is refused or removed | No |

Only rows written inside an audited pass are readable. A revoked approval stops new passes and new rows, and rows already written stay readable to the same people. Rows written without a pass (by a build older than #683, for example) are never readable.

### The switch

A team inbox reaches the model only when two reviewed changes agree for its firm company:

- **The code half.** An entry in `TEAM_PROPOSAL_FIRMS` (`src/lib/discovery/propose/gate.ts`). It is frozen and ships empty.
- **The data half.** A `team_proposals` row in `discovery_tenant_approvals`, written by a reviewed migration. Nothing in the app can write it, and a row is revoked, never deleted.

Neither half is enough alone. The worker's hand-off, the start of a pass, every page's renewal (and a renewal before any model call or retry once the lease is nearly spent) and the writer each check them, and any failure, any error and any unreadable answer stops that inbox for the run. Whether a source is a team inbox is decided in the database from the source itself: the worker asks before the first model call of every source, a person's own mailbox included. With the switch empty, the run behaves exactly as it did before: a team inbox is read and routed, and none of its text reaches a model. The run summary says how many sources were skipped or refused, as numbers (`sources skipped N, sources refused N`).

To turn it off, revoke the data half first: a running worker stops at its next save or renewal for that firm's inboxes. Removing the code half stops only runs started from a build that has the change. The [runbook](../04-operations/discovery-worker-aws-runbook.md#team-inbox-proposals-the-flip-owner-gated-not-built) gives both steps.

### The pass, and what it audits

Each run opens one pass per team inbox before its first model call, only on a page that has unrouted mail. A pass has a 30-minute lease that is renewed on every page. Two audit rows describe it, with ids, a path, an outcome and five integer counts (asked, deal, not deal, invalid, failed), never text:

- `discovery.team_mailbox_proposal_started`, written before the first model call;
- `discovery.team_mailbox_proposal_finished`, written on every exit.

| Outcome | What happened |
|---|---|
| `complete` | The inbox was read to the end |
| `page_limit` | The run reached its page limit |
| `paused` | The run was asked to stop mid-read |
| `refused` | The mailbox guard, the inbox's allowlist or the switch refused the pass |
| `revoked` | The approval was turned off after the pass opened |
| `archived` | The source was archived mid-read |
| `error` | Anything else failed |
| `zdr_unavailable` | The AI Gateway refused zero data retention, so AI is off |
| `ledger` | A usage row was refused, so the run stopped |
| `failure_streak` | Twenty calls in a row failed |
| `unclosed` | The worker died or was cut off, or its closing call failed. The next propose run closed the pass after its lease lapsed, with the last counts it kept |

A second run that meets another run's fresh lease stops for that inbox and sends nothing from it (`pass_in_progress`). Every propose run starts by closing any pass whose lease has lapsed, whether or not the inbox may still be read, so a pass never stays open past its lease and the next run.

**Where the firm admin and the CCO see this.** The slice that adds pass rows and approval changes to the team-inbox audit trail is **held** until #711 to #716 are on `develop` (D118). Until it merges the rows are written to the audit log but do not appear in the trail, and the owner's flip PR is gated on it.

### What also changed now, switch or not

A source's proposals now name only deals that source's own mail backs. A banker who also reads a team inbox no longer gets team-derived deal names in the prompt for their personal mailbox, a CCO's personal mailbox no longer inherits control-room candidates, and one mailbox of a person no longer feeds names to another of theirs, even after it is withdrawn. This is live and only narrows.
## Recall by marker form

Model proposals do not run on a team inbox, so the deals the firm rules find in it are the deals it shows. How many they find depends on how the bankers write about a deal. Decision: D121 in the [decision log](../07-decisions/decision-log.md) (number to confirm at merge). Issue #173, gap G-09.

Status: this note describes the router through `[173 G-09 4/5]` and `[173 G-09 3b]`, measured on two synthetic corpora, one written with the rules and one held out from them, in the pages the real readers use. The firm-name rule is **not live anywhere yet**. The worker does not pass it any names, because `[173-g09 5/6]` waits for G-01's approvals table to reach `develop`. This section is updated when that slice lands.

### What routes, and what does not

The rules read mail, not meaning. A message joins a deal only when it carries one of these markers.

| How the deal is written | Routes? | What decides it |
|---|---|---|
| `Project <Name>` in the subject or body | Yes | The literal is the only thing that teaches the rules a codename |
| The bare codename, in an inbox that also holds a `Project <Name>` message | Yes | The literal must have been read in the same inbox first |
| A reply that drops the codename | Yes, in the same inbox | A reply sent under a new subject, or with no thread id, is missed |
| `<Name>:` subject prefix | Yes | The prefix must open at least two topics in that inbox, from at least two firm people, or from the mailbox's owner alone when one of the owner's subjects is a reply. The same must hold in every other mailbox that also holds the message |
| The bare codename, taught only in a banker's personal mailbox | No | A team inbox routes only on codenames written in itself; the personal mailbox's knowledge does not cross |
| The root of a thread, held only in a personal mailbox | No | Same boundary |
| A copy also read in a personal mailbox, where only one side taught the codename | No, on both sides | An item routes only if every mailbox that read it allows it |
| A client or target company named outright | Not yet | Needs the firm's approval, the company entered, and every reader of the inbox entitled to list it (below) |
| A document named for the company | No | The company-name rule reads messages only |
| Nothing in the message names the deal | No | Out of reach for rules |

### Measured recall in the `deals@` inbox

Counts of `deals@` observations (a message read in an inbox) on the synthetic `harrow.example` corpus, read as the Graph reader reads an M365 inbox: pages of 50 messages, in the corpus's order. "Develop" is the rules as they stood before the G-09 stack. Counts, not rates: the corpus is small (246 messages, 250 observations, 140 of them in `deals@`) and was written by the team that wrote the rules, so read the table as a map of what each form needs and not as a forecast.

| Marker form | Develop | With the stack | Note |
|---|---|---|---|
| `Project <Name>` | 1 of 1 | 1 of 1 | |
| Thread: the naming message and its replies, one inbox | 3 of 5 | 3 of 5 | The two misses are a reply sent under a new subject and a reply with no thread id |
| Thread whose root is only in a personal mailbox | 1 of 1 | 0 of 1 | Intended: the boundary |
| `<Name>:` prefix, two or more topics and firm senders | 3 of 3 | 3 of 3 | |
| `<Name>:` prefix, one topic or one sender | 0 of 2 | 0 of 2 | Too thin to count as a codename |
| Bare codename, same inbox as the literal | 3 of 3 | 3 of 3 | Includes the literal message |
| Bare codename, taught only in a personal mailbox | 1 of 1 | 0 of 1 | Intended: the boundary |
| Mixed copy (also read in a personal mailbox) with a literal for one deal and a bare word for another | 2 of 2, one with a wrong extra route | 2 of 2, none wrong | The bare word was taught only in the inbox, so it is refused on the shared item |
| Mixed copy, bare word taught only in the inbox | 1 of 1 | 1 of 1 | The inbox's own copy routes; the personal copy does not |
| Mixed copy, bare word taught only in the personal mailbox | 1 of 1 | 0 of 1 | The stated cost of the boundary: an item routes only if every mailbox that read it allows it |
| Client or target named outright | 0 of 7 | 2 of 7 | Not live (see status). The two found are a full name plus a process term, from a firm person. The five misses are the short form, a case variant, a body-only mention, an external sender and a subject with no process term |
| Document named for the company | 0 of 1 | 0 of 1 | |
| Nothing names the deal | 0 of 3 | 0 of 3 | |

Three more rows stay at zero by design and sit outside `deals@`: a reader without leads view (0 of 1), a company the reader may not list (0 of 2), and a source with no owner, so no firm to approve (0 of 2).

**Reading order.** Mail that routes nowhere when it is read keeps no text, and a rules-version change does not re-read provider history. A reply or bare codename read before the message that teaches it is lost. The Gmail reader lists the most recently active thread first, so on this corpus it loses the two bare-codename messages; read in the opposite order with small pages, the two same-inbox replies go as well (the `gmail10t` and `page10_rev` columns of `recall.test.ts`). Plan the first read of a deal-heavy inbox on that basis.

### The held-out corpus

`heldout1` (the `hqpartners.example` firm: 325 items, 6 sources, 7 deals, 167 noise) was written by a separate agent that saw only the corpus format, never the rules. Its `deals@` observations in the Graph reader's pages are the same on develop and with the stack, except the prefix row:

| Marker form | `deals@` |
|---|---|
| `Project <Name>` | 13 of 14 |
| A reply in the same inbox | 17 of 18 |
| `<Name>:` prefix, several topics and senders | 15 of 15 on develop, 14 of 15 with `[173 G-09 3b]` (below) |
| `<Name>:` prefix, one topic or one sender | 4 of 4, each also carrying a bare codename taught in `deals@` |
| Bare codename, same inbox as the literal | 7 of 7 |
| Mixed copies | 5 of 9 |
| Client or target named outright | 0 of 15 |
| Document named for the company | 0 of 5 |
| Nothing names the deal | 0 of 5 |

What it shows, beyond the in-repo corpus:

- **Prefix recall follows the reader's page.** A prefix becomes a codename once its evidence is in, but the evidence is counted per router call, and the worker routes one reader page per call. Prefix observations found, `deals@` and across all mailboxes (25):

  | Reader shape | Develop | Evidence carried across pages | `[173 G-09 3b]` as built (every mailbox must promote) |
  |---|---|---|---|
  | Graph, 50 messages a page (M365) | 15 of 15, 17 of 25 | 15 of 15, 21 of 25 | 14 of 15, 19 of 25 |
  | Gmail, 10 threads a page | 4 of 15, 4 of 25 | 13 of 15, 17 of 25 | 9 of 15, 9 of 25 |
  | 10 messages a page (stress case) | 2 of 15, 2 of 25 | 13 of 15, 18 of 25 | 8 of 15, 8 of 25 |

  An M365 `deals@` of this size needs no change: one Graph page already holds the evidence. `[173 G-09 3b]` carries each mailbox's evidence from page to page, as the prefix word and keyed digests of its topics and senders, held in memory and bounded, and seeds it from stored mail when a run starts. A mailbox disconnected with its records kept can still refuse a route on mail it holds, but it no longer teaches or counts toward a prefix, which matters for Gmail inboxes and for personal mailboxes. The rule that a prefix route needs every mailbox that read the message costs the difference between the last two columns: when tenant discovery re-routes stored mail, a copy held in `deals@` and in a banker's mailbox is refused if the banker's stored mail alone does not promote the prefix. **Limits.** Prefix mail read before its prefix reaches the bar keeps nothing. Across runs, only stored mail is evidence, so in day-to-day delta reads a new prefix whose topics arrive in different runs may never qualify. Keeping evidence derived from unrouted mail would close that gap, and that is the owner's call.
- **A forward loses its codename.** When `Project <Name>` sits only below "Forwarded message", quote stripping drops it, and the forward routes nowhere (0 of 4 observations). Recorded as a follow-up.
- **The bare codename matches place and shop names.** A street, hill or coffee shop that shares a codename word routes as the deal. That is all of the false positives below, and 3 of them are in `deals@` at every stage, because `deals@` taught those codenames itself. Recorded as a follow-up.
- **The firm-name pass never ran on `deals@`.** One of the inbox's three readers has no leads view, so the inbox holds no names: 0 of 15 at every stage. In the readers' own mailboxes the pass finds 7 of 30 real-name observations (0 on develop) and routes no noise. So this corpus says nothing about the pass's false positives in a team inbox. It does show why every reader needs leads view (activation, step 4).
- **One call over everything is a comparison, not a bound.** The `whole` column routes the whole corpus in one call. A message held in `deals@` and in a personal mailbox is then one item, and a rule that needs every mailbox that read it can refuse it: `whole` finds 0 of 30 real-name observations, where the reader-shaped modes find 7.

**Indicative cross-check.** A synthetic M365 capture, scored by a script outside the repo that counts any route as a hit, gives Halyard 32 of 33, Kestrel 15 of 18, Lantern 9 of 9 and 0 of 140 unrelated messages routed. It does not move at any slice of the stack. It is not a gate.

### False positives

The measure is `misdirected`: routes on non-deal mail, plus routes to the wrong deal, counted by the rule that made each route. On the in-repo corpus it is 6 in every reader shape (5 in the reversed stress case) on develop, 4 (3) after the boundary, and 6 (5) with the firm-name pass. On the held-out corpus it is 16 in the Graph shape and 14 in the Gmail shape on develop, and 13 and 10 after the boundary and with the firm-name pass, which adds none there.

The gate: no rule may misroute more than at the slice before, in any shape on any corpus, and it is never loosened to let a change through. A slice cannot hide new false positives of one kind behind old ones of another kind that an earlier slice removed. The firm-name pass fails it: it adds two routes of a new kind, coverage mail that names a client and uses a deal-process word for something else (a conference sponsorship, a lease). Mail that only mentions a client, or uses `CA` or `model`, does not route. The test names exactly those two routes as waiting on the owner, and that slice merges only on the owner's decision (D121).

The other false positives are on develop already and are recorded, not fixed here: an internal prefix that two firm people use on two topics in one mailbox (`Townhall:`) is read as a deal, and a bare word that is also a company name matches.

### Firm names: activation

Off until a firm is approved. A firm person's subject routes when it names one of the firm's client or target companies as a whole phrase and carries a deal-process term: `CIM`, `NDA`, `LOI`, `IOI`, `VDR`, `DD`, `SPA`, `APA` or `Q&A` in capitals, or teaser, bid, process letter, data room, management presentation, diligence, buyer list, mandate, engagement letter or valuation in any case. The route is keyed by the company's identity, so it never merges with a `Project <Name>` deal or with another firm's company of the same name, and a subject that names two such companies routes on neither. It never teaches a codename or a thread. One deal, one candidate: mail a codename or a prefix already routes gets no firm route, and a reply that continues a codename's thread joins that deal only.

Everything below comes **before the inbox's first read**. Mail read earlier routes nowhere and is lost for good.

1. **Onboard the firm.** Its tenant id and bank company row must exist.
2. **Approval.** A reviewed migration inserts a `firm_name_alias` row for the firm in `discovery_tenant_approvals`, guarded so it does nothing on any project without that firm. It follows review, CI, merge and the Migrate database Action; allow about a working day. The owner approves, and the firm's CCO sees the row once G-01's trail slice is merged, which gates this migration. Not built.
3. **Connect, held.** Readers can only be added to an inbox that is connected, and a connected inbox is read on the worker's next pass once it is verified. The hold is the ingest group: the worker never reads a mailbox that is not a direct member of it (the card shows **Not in the ingest group**). So the Workspace admin does **not** add the address to the ingest group yet. Connect the inbox, then pause its source in ingestion health as a second hold. If the address is already in the ingest group, there is no race-free hold, because an inbox cannot be connected paused: that is a gap, recorded for the owner.
4. **Readers.** Add the inbox's readers. **Every reader needs leads view.** The inbox gets only the names all of its readers may list, so one reader without leads view leaves it with none: on the held-out corpus, one such reader kept the rule from finding any of the inbox's 15 real-name observations. A source with no readers gets no names either, and a reader added later without leads view empties the inbox's names on the next run.
5. **Names.** The MD enters the three to eight active client and target companies. These are entered, not discovered, and the demo says so.
6. **Deploy.** The G-09 slices and G-01's approvals table are merged and the worker is deployed.
7. **Release the hold.** The Workspace admin adds the address to the ingest group, and the firm admin resumes the source. The first read follows on the next pass.

What the approval costs. The entered company names become listable by every internal user who is not walled off. The approval is per firm, so every banker's own mailbox at that firm routes on the same names, within that banker's own entitlement. Revoking is a second reviewed migration that sets `revoked_at`: new routes stop on the next run, candidates already opened stay until the MD rejects them, and listed names stay listed. Until it lands, the emergency stop is `discovery_worker_enabled` off, which is global.

### Re-measuring

`npx vitest run tests/discovery/recall` prints the table for the in-repo corpus and for every corpus under `tests/discovery/recall/corpora/`. A rule change shows up as a diff of the pinned cells. That directory's README states the corpus format for anyone writing a new corpus.

## The live check (T1)

**Status on 2026-10-20: not run, and parked as a gate on the first live connect** (owner decision, ADR-0026). The emailmask.uk trial has expired, so the owner runs it on the firm's own Workspace before its first team inbox is connected, and reads the rows before the admin presses Connect. A paid dev Workspace was approved the same day and is not created yet. Its checklist, [dev-google-workspace-setup.md](../04-operations/dev-google-workspace-setup.md), prepares the four addresses so T1 can also run there on its first day (Proposed: that run informs the design and does not replace the gate). Announce the run first. It prints status codes, Google reason codes, counts and yes/no only, never an address, id, token or mail, so the rows are safe to paste.

Prepare four addresses inside the registered domain, one per role: `--alias` (an alias of a user), `--group` (a Google Group that is **not** the ingest group), `--suspended` (a suspended user), `--shared` (a real shared user mailbox, the team inbox). Any subset runs; the demo needs `--shared` and `--group` most.

1. Use a checkout that includes `scripts/google/probe-team-mailbox.ts`, with `npm ci` done.
2. Confirm the trial's `.secrets/google/registration.json` is the file `write-registration.ts` wrote (it carries `tenantId`, `workspaceDomain`, `serviceAccountEmail`, `directoryServiceAccountEmail`, `allowlistGroup`), and that `GOOGLE_APPLICATION_CREDENTIALS` points at the keyless worker credential, as for `npm run google:probe`. `GOOGLE_DIRECTORY_CREDENTIALS`, when set, is used as the worker uses it; otherwise the probe asks IAM for a directory token.
3. Run, from the repo root, in a terminal that exports no hosted Supabase values:

   ```
   npm run google:probe-team -- --live --confirm-domain <trial domain> \
     --registration .secrets/google/registration.json \
     --alias <alias> --group <group> --suspended <suspended> --shared <shared>
   ```

4. Paste back every line that starts with `T1`.

For each address the probe reports (1) `users.get` with a directory token minted with both scopes: status, whether `primaryEmail` equals the input, `suspended`, `archived`, `isMailboxSetup`; (2) `members.list(maxResults=1)` on the address: status; (3) a DWD token mint for the address with `gmail.readonly`: status and error code; (4) the Gmail profile, only where step 3 succeeded: status and whether `emailAddress` equals the input. For `--shared` it adds (5) whether the address is a direct member of the ingest group (`directMember=yes|no`). Once per run, first, it lists the ingest group's members with the same two-scope token.

Expected rows:

| Role | Expected |
|---|---|
| alias | `users.get` 200 with `primaryEmail equals input: no` |
| group | `users.get` 404, then `members.list` 200 |
| suspended | `suspended: true` |
| shared | 200, yes, not suspended, mailbox set up; token and profile succeed; `directMember=yes` |
| group-mirror line | 200 and the same member count as before |

Reading the rows:

- A 403 on `users.get` for every address means the directory role lacks Users: Read. Grant it and re-run. There is no fallback.
- `directMember=no` for the shared mailbox means it is not a direct member of the ingest group (or only through a nested group). Add it by its primary address (step 4 above) and re-run.
- A 403 on `members.list` for the group means the role can read only the ingest group. Group addresses then show "can't check this address yet". Widen the role to read all groups, or accept that wording.
- A `matches=no` row, `groupMirror=failed`, or exit code 1 is a deviation. Do not connect the inbox. Hand the rows to the design owner: it goes back to ADR-0026 decision 7.

## Demo runbook (Conductia team)

The story for Oct 30: "connect an Ignatious team inbox, find the deals, place a phase on each". Read [deal-discovery-demo-runbook.md](./deal-discovery-demo-runbook.md) for the stack, the worker and the freeze.

### Cast and rules

- **The presenter who sees the deals is a non-admin MD (Storm Duncan).** A firm admin's `/discovery` shows no candidate list, and an admin cannot be added as a member. The admin (a different login) connects the inbox and adds Storm.
- **Phases are placed by promotion.** Storm promotes a candidate and places the deal at a phase. Model proposals do not run on a team inbox unless the owner has lifted residual 4 for the firm (they are built and off, see [AI proposals on a team inbox](#ai-proposals-on-a-team-inbox-built-off)). Do not promise automatic phase suggestions on this mail.
- **Set the window at connect**, before the first pass. Do not rely on the window editor.
- **A colleague who holds personal copies** of some of the same mail (Morgan, in the demo corpus) sees the shared deal but none of the team's messages. This is the beat that shows the member list is the gate.

### Offline rehearsal (primary path)

The real Gmail reader runs over the committed demo twin (`tests/fixtures/discovery/demo/gmail-twin/deals@bank.example.replay.json`) with the Directory check answered from the replay folder. No credential, no network. It is refused in production.

1. Fresh local stack, then `npm run seed:users` and `npm run seed:flags:enable`, as in the discovery runbook's fresh-stack checklist.
2. Seed the stack with the team inbox already connected and Storm a member:

   ```
   npm run seed:discovery -- --google-replay --corpus demo --personas morgan \
     --team-inbox deals@bank.example --team-members storm
   ```

   `--personas morgan` seeds Morgan's mailbox only, so Storm has no personal copy of the mail and sees it only as a member. The seed registers the inbox through the connect RPC under the seeded admin, records the check through the RPC, and adds each `--team-members` persona.
3. The seed ends with one classification pass in fixture mode, which reads the team inbox. To read again (late mail, or the admin walk below), run the worker with `DISCOVERY_READER_MODE=fixture` and name the replay phase, as the discovery runbook's "Run the worker with --watch" does.
4. Sign in as Storm and open `/discovery`. Kestrel and Osprey appear from the team inbox. Promote Project Kestrel and place it at a phase.

To walk the admin side live instead, seed `--personas morgan` without `--team-inbox`, sign in as the admin (`admin.intelibank@dev.com`), connect `deals@bank.example` with a window, wait for **Ready**, add Storm, run the worker once more, then sign in as Storm.

**The automated journey.** `e2e/journeys/team-inbox-demo.spec.ts` plays the story end to end, seven beats: the admin connects `deals@` with a window and sees "Checking the address"; the worker checks it and it reads Ready; the worker reads it and Storm, not yet a member, sees nothing; the admin adds Storm and he sees Kestrel and Osprey and reads the team-only Kestrel mail; Morgan sees Kestrel but none of the team's messages; Storm promotes Kestrel and places it at the LOI Review station; the admin removes Storm and he no longer sees Osprey.

```
npm run test:e2e:team-inbox
```

It needs the hermetic stack seeded with `seed:discovery --google-replay --corpus demo --phase seeded --personas morgan`, and it mutates discovery state, so it runs on its own reset stack. In CI it is the workflow `E2E team inbox (Gmail replay)` (`.github/workflows/e2e-team-inbox.yml`): advisory, never a required check, run on a push to `develop`, on a non-draft PR labelled `e2e-team-inbox`, or by hand. It uploads the video of every run. The owner watches it to confirm it tells the story.

### On Ignatious's Workspace (Oct 30)

Prerequisites, all owner tasks:

- [ ] **T2:** Ignatious says what `deals@` is: a licensed user mailbox (reads), or a Google Group or Collaborative Inbox (refused; the owner and Ignatious choose a licensed mailbox the group routes into).
- [ ] **Users: Read** granted to the directory role, with group read if the live check shows it is needed, by Oct 26 (delegation changes take up to 24 hours, and the Oct 28 freeze follows). There is no test Workspace to fall back on until the paid dev Workspace exists ([setup checklist](../04-operations/dev-google-workspace-setup.md)).
- [ ] **`deals@` added directly to the ingest group**, by its primary address, and the live check's `directMember=yes`.
- [ ] **T1** run on Ignatious's Workspace and the rows read against the expected table by a human, before Connect. This is the gate.
- [ ] The exclusion policy written for the tenant before the first pass, as for any mailbox.
- [ ] Ignatious's confirmation, in writing, that the named mailbox is a firm mailbox. The attestation in the card is the firm admin's act; the paper trail is Ignatious's.

Rehearsal (the Oct 27 read-only rehearsal in the discovery runbook): as the firm admin connect the address with the window, watch it reach **Ready**, add the demo MD, and check ingestion health shows the source reading with no refusal. If the card shows **Refused**, read the table above before changing anything. A refusal retries on its own once the cause is fixed.

On the day: the inbox is already Ready and Storm already a member. Do not connect or add anyone live unless the story needs it; a connect on the day waits one worker tick for **Ready**.

### If something goes wrong

| Symptom | Likely cause | Action |
|---|---|---|
| Stuck on **Checking the address** | The worker has not ticked, or the Directory is unreachable | Check the worker's last pass in ingestion health. "Last check failed, retrying" means a blip |
| **Refused: can't check this address yet** | Users: Read not granted, or applied less than 24 hours ago | Grant it; the card turns Ready after the next tick |
| **Refused: This is a Google Group** | `deals@` is a group | Remove the empty registration, connect a user mailbox, or switch to the test Workspace |
| **Not in the ingest group** | The address is not a direct member of the ingest group | The Workspace admin adds it by its primary address; the next pass reads |
| Ready but Storm sees nothing | Storm is not a member, or is a firm admin, or the first pass has not run | Check "People with access", then the source in ingestion health |
| Source waits with "Waiting for the address check" | The last successful check is 65 minutes old or more | Wait one tick; if it persists the Directory is failing, see the transient note |
| Ingestion shows "This is a person's address" | A user or invitation holds the address | Connect a different address |

## Planned before a second bank

**CCO approval before the first read.** Today a firm admin's attestation is the only gate before a team inbox is read, with the CCO notified on connect and every step audited. Before a second bank connects a team inbox, a registration will start in a `pending_cco` state that the guard refuses until a firm CCO approves it. This is the owner's decision (2026-10-17/18) and is not built.

Also after Oct 30: disconnect with purge (h1), Microsoft team inboxes (h2), member notifications (h3), the owner's flip for model proposals on team mail (built and off; the owner kept it off for Oct 30, Q1 in ADR-0026), suggesting members from Gmail delegates (T4), the "Team inbox" label in ingestion health, and the advisory lock between connect and a personal grant.
