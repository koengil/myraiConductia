# Google Workspace reader: super admin guide

Audience: a bank's Google Workspace super admin. Scope: what Conductia needs from your tenant so it can read the mailboxes of people who have consented, and nothing else. Design: #259. Nothing here asks you to create or send us a key file. Conductia signs through Google's IAM Credentials API as a service account we name; there is no key to rotate or leak on either side.

Read `.secrets/README.md` first for the values you send back.

## What you set up, in order

1. **Authorise the DWD client ID for exactly one scope.**
   - Admin console > Security > Access and data control > API controls > Manage Domain Wide Delegation > Add new.
   - Client ID: the numeric client ID of the Conductia DWD service account (we send it).
   - OAuth scopes, exactly this one and nothing else:
     - `https://www.googleapis.com/auth/gmail.readonly`
   - Do not add `gmail.metadata`. With `gmail.metadata` on the same entry, Gmail refused the reader's full message reads (`format=full`) and `q` searches in Conductia's test tenant, even alongside `gmail.readonly`.
   - Do not add `gmail.modify`, `gmail.send`, `mail.google.com` or any Drive scope. The probe (P07) fails if a wider token can be issued.
2. **Create the ingest group.**
   - Create `conductia-ingest@<your domain>` as a Google Group and set "Who can join the group" to "Only invited users", with external members off. Under this setting members cannot join themselves; the member-facing copy that still tells them to join the group is corrected in #675.
   - You add and remove members yourself, so the bank decides whose mail Conductia may read and Google's audit log records each change. Only members of this group are ever read, and only if they also hold an accepted Conductia seat and have consented. Conductia re-reads membership at the start of every sync job, so removing someone stops reads by the next job. Withdrawing the invitation or consent in Conductia stops reads before the next page.
   - Option, the bank's choice: "Anyone in the organization can join" lets users join themselves after they consent in Conductia. The group then mirrors consent and no longer adds a bank-held check, and the out-of-list alert's allowlist still needs updating for each new member.
   - Membership must be direct and under the person's primary address. A user has to be a direct member of the ingest group, added under their primary email. A member who arrives through a nested group, or who was added under an alias, is not matched: the guard refuses that mailbox as `not_in_provider_group` and reads nothing. That failure is safe (mail is skipped, never over-read), so it shows as a mailbox that waits, not as a leak. Fix it by adding the person directly under their primary address.
3. **Give the directory identity a custom role.**
   - Admin console > Account > Admin roles > Create new role, with only "Groups: Read". It checks the ingest group's membership. Do not add "Reports: Read" to this role (see the last item of this step). Reports: Read (under Reporting) is for the out-of-list token alert only, which Dan Dima-ala (Ignatious) chose to grant on 2026-10-20 (written access approval, Slack). We believe Google Cloud's audit logs show which principal minted a token, not which mailbox it was for (unverified: no source in this repo states it, and P11 is the check that settles it); the Workspace token audit names the mailbox.
   - Assign it to the Conductia **directory** service account (we send its email). This identity has no domain-wide delegation. It reads group membership.
   - Which identity holds Reports: Read is **Proposed, not agreed** (Guillermo, owner, 2026-10-21; pending the test in #674). The proposal is that Reports: Read sits in a separate Reports-only role on a separate alert identity that the worker cannot mint tokens for, read by the out-of-list token alert poller (#674), and not on the directory identity. The reason: the worker can mint tokens for the directory identity, and Reports opens every audit log in the domain. Until the #674 test passes, the identity that holds Reports is still open: do not assign Reports: Read to any Conductia identity yet. We will confirm the identity with your admin before you assign it.
4. **Allow up to 24 hours** for delegation and role changes to take effect before you run the probe. Never grant or change delegation on the day of a demo or a go-live.
5. **Send back the values** listed in `.secrets/README.md` (`google/registration.json`): domain, ingest group address, and the tenant's bank company. The bank's admin never sends a credential.

## Team inboxes: one more role permission

Only if your firm admin will connect a shared inbox such as `deals@<your domain>` (#581): add **Users: Read** to the directory identity's custom role from step 3, beside Groups: Read and Reports: Read. Conductia calls the Directory's `users.get` to confirm the address is an active user mailbox and not an alias or a Google Group. Without the permission every team inbox is refused ("Conductia can't check this address yet") and retried until it is granted. The directory identity still has no delegation and no mail access. Then **add the team inbox directly to the ingest group, by its primary address**, as you would a person (step 2's rule): nobody signs in as a team inbox, so nobody else adds it, and until it is a direct member every pass is refused and the card shows "Not in the ingest group". Allow up to 24 hours, and finish before the freeze. Details, refusal reasons and the live check: [team-inbox-guide.md](./team-inbox-guide.md).

## What Conductia can and cannot do with this

- Read-only Gmail access, per mailbox, per page, and only after Conductia's own guard confirms the invite, consent and group membership.
- No sending, no deleting, no label changes, no Drive access for the reader.
- The guard refuses any address that is not both seated in Conductia and a member of your group, even where Google would allow it.

## The exclusion policy: write version 1 before the first live pass

Before any message body is fetched, the tenant's exclusion policy runs on the message's metadata (sender and recipient addresses, the `Sensitivity` and `msip_labels` marker headers, Gmail labels and Workspace classification labels). A message it excludes is never fetched in full. It appears in the ingestion health ledger as skipped, with the rule and the policy version, and nothing of its content is stored. Gmail's `snippet` (about 200 characters of the body) is never requested either: every listing and metadata call carries a `fields` mask.

A live pass refuses a tenant that has no policy version. The source shows "No exclusion policy" as its Last error, or "Exclusion policy invalid" when the current version fails validation. One audited write, even an empty list, connects the bank. Conductia staff make it at the bank's written request (`--requested-by` names who asked):

```
npm run discovery:set-exclusion-policy -- --tenant <tenant uuid> --requested-by "<who at the bank asked>" \
  --expected-version 0 --rules <rules.json>            # prints the diff, writes nothing
npm run discovery:set-exclusion-policy -- ... --confirm   # writes the version
npm run discovery:set-exclusion-policy -- --print-template   # the recommended starting rules; writes nothing
```

This npm script loads `.env.local`, and a value the shell already exports wins over the file (`node --env-file` never overrides one), so a shell profile's hosted Supabase URL would receive the write. For any live or trial stack, use the guarded `node --import tsx scripts/discovery/set-exclusion-policy.ts …` form in `deal-discovery-demo-runbook.md` ("Seeded dry runs on the test Workspace") instead.

`rules.json` is a list of rules (`[]` is a valid, deliberate policy). Each rule has a stable `id`, a `category`, a `scope` (`thread` or `message`, below) and one of five kinds: `participant_domain` (`domains`), `participant_address` (`addresses`), `header_marker` (`header`: `sensitivity` or `msip_labels`, and `contains`), `label` (`names`: label names matched case-insensitively, or Gmail's built-in ids such as `CATEGORY_PERSONAL`) and `classification` (`labelId`, optionally narrowed by `fieldId` and `selectionId`). A rule id names one condition forever: a changed condition needs a new id. Every version is append-only and writes a `discovery.exclusion_policy_changed` audit row that names the rule ids and the requester, never the domains. The fixture and replay modes read under version 0 (no rules) when no policy was written, so the Graph fixture and the base Gmail replay read as before. The demo Gmail replay (`--google-replay --corpus demo`) writes version 1 itself, with the empty rules in `tests/fixtures/discovery/demo/exclusion-policy.json`, requested by `demo-seed`.

A label rule that names a user label costs one extra Gmail request per pass (the mailbox's label list). A label added to a message between the metadata read and the raw read cannot be stopped, because the body has already been fetched by then: the message is discarded unparsed, never stored, and ledgered as `policy_excluded_after_fetch`, so it is never counted as excluded before the fetch. A classification rule fails closed: until a live read has shown that Google returns classification labels for this tenant, a message without them is excluded as `policy_unevaluable`, so configure one only after that check. The script prints a warning when a version carries a classification rule while that check is still open.

The policy change's audit row is a service row: its actor is the operator script, not a person, so `--requested-by` is the only record of who asked. Give a real requester, a name and role or a ticket (for example `"Jordan Ames, CCO, ticket SEC-142"`), never the operator's own name alone. The script, the writer function and the table all refuse an empty value.

A thread-scoped rule that cannot be evaluated on a message (an unreadable address, an unverified classification field) excludes that message and the rest of its conversation as it is read, but is never stored as a thread taint: only a real match taints a conversation for later passes. Taints belong to a source: a source that is removed and connected again starts with none, and its conversations are judged afresh on the next backfill.

**Scope.** A `thread` rule excludes the whole conversation: when any message of it matches, every other message is excluded too (ledgered as `policy_thread_excluded`), including a reply that arrives in a later pass, so a reply that quotes privileged advice is never fetched. A `message` rule excludes only the message that matches. A rule that states no scope is a `thread` rule, and the stored version always states it. Conductia remembers which conversations a thread rule has excluded (per mailbox, append-only), so the exclusion holds after the matching message loses its label or the ledger is refreshed; narrowing a rule to `message`, or removing it, stops that rule's old exclusions from applying to later mail. Messages read before a conversation was tainted stay stored: a policy change applies forward only. The recommended starting rules (`--print-template`) make the sensitivity markers and the Privileged, Confidential and HR labels thread rules, and the outside-counsel domain a message rule, because outside counsel is copied on most M&A threads and a thread rule on counsel's domain would blind discovery on exactly those deals. Replace its placeholder domain with your counsel's before writing the version.

**What the admin sees.** The ingestion health panel on `/discovery` shows "N excluded by policy" for each source and in the totals, and "Exclusion policy vN" on its own line. The count covers every policy version the bank has had, including messages whose label arrived after the metadata read (`policy_excluded_after_fetch`), and is part of the skipped count, not on top of it. The version is the current one only. The panel never shows which rule matched, the thread id, or any subject or address of an excluded message; the ledger row holds the rule, the version and a metadata hash for the audit.

## How far back the first read goes (#353)

A mailbox's first read does not take the whole mailbox. It takes mail from the source's window start and nothing older:

- **The default** is 90 days before the mailbox was connected (UTC). A mailbox that was connected before windows existed and had never been read gets 90 days before it was connected. One that had already been read keeps its whole mailbox, and the panel says so.
- **The limit.** Before the first read starts, the bank's firm admin in Conductia may move the start on `/discovery` (Change window) to any date from today back to 730 days before today (UTC). This is the owner's decision of 2026-10-16. Each change is audited with the old and the new date. The CCO sees the window and cannot change it. Once the first read starts, the window is fixed for that read: a restart of a halted mailbox opens it again, and moving it earlier after a read is not built yet.
- **The cost of a long window.** A window far back makes the first read longer on a busy mailbox. Gmail keeps a mailbox's change history typically for at least a week, sometimes less, and a first read that takes more than 5 days and outlives that history halts and needs a restart. Conductia's operators project the read before setting a long window (#344's runbook).
- **What the panel shows.** Each Gmail mailbox has a Window line: "Reads mail from Jul 17, 2026", or "Whole mailbox".

How it reads:

- The reader lists threads with a Gmail search filter on the date, then keeps only messages on or after the window start. The exclusion policy still judges the whole conversation, so an older message that matches a thread rule still excludes the newer ones, even though the older message itself is never fetched in full or stored; only its metadata is read, to judge the thread.
- The search filter needs `gmail.readonly`. Google refuses a search query under `gmail.metadata`, and the reader only ever asks for `gmail.readonly`. Do not remove that scope from the delegation.
- After the first read, new mail keeps arriving through Gmail's change history exactly as before. That incremental read has no date floor: an old message restored from Trash or Spam, or imported with an old date, is read and judged by the exclusion policy like any new one. The window limits how much the first read takes. The exclusion policy, not the window, keeps mail out.
- Microsoft 365 mailboxes are still read whole for now; the window applies to Gmail only.

## Credential checklist we send the bank

Run on your tenant as the acceptance step, from Conductia's side, with your confirmation of the domain:

```
npm run google:probe -- --live --confirm-domain <your domain> \
  --registration .secrets/google/registration.json --mailbox <an allowlisted address>
```

The output is one line per check with ids, statuses and reason codes only. It never prints mail content. Required checks gate acceptance; the others are recorded.

| Id | Check | Expected | Required |
|---|---|---|---|
| P01 | Caller token from the keyless worker credential | PASS | yes |
| P02 | IAM Credentials `signJwt` on the DWD service account | PASS | yes |
| P03 | `gmail.readonly` token for an allowlisted address, then the profile | 200 | yes |
| P04 | `gmail.metadata` token for the same address | Refused on a one-scope entry: the probe prints FAIL here, which is the expected result (recorded, not a gate) | recorded |
| P05 | With the metadata token, reading the designated seeded test message raw (no other message; SKIPPED without one) | SKIPPED on a one-scope entry (no metadata token); 403 only where `gmail.metadata` is authorised | recorded |
| P06 | With the metadata token, searching the inbox | SKIPPED on a one-scope entry (no metadata token); 403 or 400 only where `gmail.metadata` is authorised | recorded |
| P07 | A `gmail.modify` token is refused (over-grant check) | `unauthorized_client` | yes |
| P08 | Directory identity reads the ingest group's members | 200, member count | yes |
| P09 | The directory identity cannot be delegated | refused | yes |
| P10 | Reports shows token activity for the DWD client | 200, read through the alert identity (#674): the out-of-list token alert reads this audit | yes, before real mail (runbook G5); the probe records it and does not gate on it until #674 |
| P11 | IAM Credentials Data Access log records the `signJwt` subject | MANUAL: your admin checks Cloud Logging and answers yes or no | recorded |
| P12 | The Drive probe identity sees the seeded shared drive as a Viewer only (trial only) | 200, viewer | yes, trial only |
| P13 | Conductia's guard refuses an address Google would allow but Conductia has not seated | PENDING until the guard integration (Phase 2) | at go-live |

If P07 or P09 fails, delegation is wider than agreed. Fix it in the Admin console and rerun before any mail is read.

## Demo runbook (Conductia team)

This section is for the Conductia team running the Oct 30 demo, not for a bank's admin. Two paths show Gmail candidates in `/discovery`. The offline path is the primary one.

### Offline path: a Gmail replay, no trial, no credential

`DISCOVERY_READER_MODE=fixture` runs the real Gmail reader over a replay instead of Google. The committed synthetic twin (`tests/fixtures/discovery/gmail-twin`) is generated from the Graph fixture corpus, so it needs nothing from the trial. It is refused in production.

`seed:users`, `seed:discovery` and `worker:classify` load `.env.local`, and a value the shell already exports wins over the file. Run them only where the shell exports no hosted Supabase values. For any live or trial stack, use the runbook's guarded `node --import tsx` form.

1. Start a local Supabase stack and seed it: `npm run seed:users`, then `npm run seed:flags:enable`.
2. `npm run seed:discovery -- --google-replay`. This makes the three fixture personas Gmail sources of the dev tenant (registration, invites, consent under each owner's own session), then classifies them once through the Gmail reader. The replay is read in its last phase, `after-unspam`, when a mailbox holds the whole corpus. To read an earlier phase, set `DISCOVERY_GMAIL_REPLAY_PHASE` (`seeded`, `after-imports`). For the deal-discovery demo mail (Kestrel, Harbor, Osprey), use `npm run seed:discovery -- --google-replay --corpus demo --phase seeded` instead; see `deal-discovery-demo-runbook.md`.
3. Sign in as Storm (`md.intelibank@dev.com`) and open `/discovery`. Falcon and Cobra appear with the same evidence as the Graph fixture. `npm run seed:discovery` without the flag switches the sources back to Microsoft.

The same worker path runs without the seed: `DISCOVERY_READER_MODE=fixture DISCOVERY_GMAIL_REPLAY_PHASE=after-unspam npm run worker:classify -- --tenant <uuid>`. Name the phase: the worker's default is `seeded`, and a source the seed read at `after-unspam` has a checkpoint the `seeded` phase cannot answer (`Gmail replay has no response for GET …/history`). `DISCOVERY_GMAIL_REPLAY_DIR` points the reader at another replay directory.

To replay the recorded trial (Oct 7) instead of the twin, join the recorder's per-phase files, review the result, and copy it into the repo:

```
npm run google:merge-replay -- --dir <recorder --out dir> --out tests/fixtures/discovery/gmail
```

The Tidewell recording stays outside the repo. Read it with `DISCOVERY_GMAIL_REPLAY_DIR=$TIDEWELL_GMAIL_REPLAY_DIR npm run seed:discovery -- --google-replay --owner <persona address>=<seed owner slug>` (one `--owner` per persona that is not a fixture persona), then score it as the plan's Tidewell parity step describes.

### Demo users and the ingest group

Demo users must be direct members of the ingest group under their primary address. Nested groups and aliases are refused as `not_in_provider_group` (the mirror lists direct `USER` members only, `src/lib/google/reader/groupMirror.ts`), which fails safe: the mailbox waits and nothing is read. If a demo mailbox shows `not_in_provider_group` in its health status after the user consented, check this first.

### Optional live path

On the test Workspace, with Phase 2's manual steps done (registration written, personas invited and consented, worker credential in place), follow "Seeded dry runs on the test Workspace" in `deal-discovery-demo-runbook.md`. It runs every step as `node --import tsx …` in a guarded terminal on its own local stack, and writes the exclusion policy before the first live pass (a live pass refuses a tenant with none). Do not use the npm scripts that load `.env.local` for this: `node --env-file` does not override a variable the shell already exports, so a hosted value would win.

Announce every live run to the owner before it starts.

### Freeze

From Wed Oct 28, make no domain-wide delegation, group or registration change, and never change delegation on demo day: it can take up to 24 hours to apply. Dry run the offline path that day.
