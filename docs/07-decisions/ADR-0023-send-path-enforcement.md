# ADR-0023: Send-path enforcement, with the native mail client kept usable

Status: Draft for discussion, 2026-10-06, after an audit round and a final review (against `develop` @ 63a4464b; status lines rechecked against `develop` @ 3c95bf19 on 2026-10-07). **Long-term product design. Not part of MVP 2 (Oct 30).**
Related: ADR-0003 (three-state verdict), ADR-0014 (deal recipient relationships), ADR-0017 (hybrid data residency), ADR-0020 (mailbox connection; this ADR answers the bypass question in its send-path section). Decision-log entries D56, D59, D60, D62, D67, D69 (work identity). Send-path work by Marcelo: PRs #191, #227, #302, #304, #305, #311, #313, #326; false-positive test set #294. The send-as-is rule (#192). Model gate (PR #346). Gmail send (#268, #339).

## Bottom line

- **Bankers keep Gmail and Outlook.** We do not force a new mail client and we do not bounce mail. We screen the same way wherever mail is sent, and we find what went around Conductia.
- **The core is one screen, run in two places.** The rules and recipient checks that run before a send through Conductia also run **after** a send from Gmail or Outlook, on the copy in the banker's Sent mail. The AI layer runs only where the model gate allows it, and each verdict records whether it ran. A reviewer sees only the messages that the screen would have warned about.
- **First stage: that after-the-fact check, measured.** It ships for a bank once the reader's go-live gates pass, with its coverage and false-alarm rate measured on a trial domain. It is not on the MVP 2 (Oct 30) path. In-client screening (an Outlook add-in, a Gmail extension or add-on) and an optional hold at the bank's mail server follow in later decisions.
- **Nothing is rejected, and nothing is held by default.** This keeps the send-as-is rule (`compliance-rules.md`, Risk Patcher): content risk goes back to the sender, who may always send. A hold that can expire unsent is a de facto block, so it needs the same sign-off as a block.

## In plain terms

- **The problem.** Conductia screens mail sent through Conductia. A banker can open Gmail or Outlook and send around it.
- **What we do first.** We look at what was actually sent and run the same checks on it. If a message would have been flagged, the bank's compliance reviewer sees it.
- **What we add later.** The same warnings inside Gmail and Outlook before send, and, for banks that want it, a hold at their mail server.
- **Why this compounds.** One screening engine serves the Conductia composer, the after-the-fact check, and later the add-ins. The mailbox reader we already run becomes the supervision feed. The email product works where bankers already are.

## Terms

- **Screen:** Conductia's checks on a message: the rules on subject, body and attachment names, AI that can only escalate (when permitted), and recipient review against the deal's relationships.
- **Send-as-is:** the current rule that a banker may always send after seeing the screen's warnings; the choice is recorded.
- **Post-send check:** the screen run on a copy from the banker's Sent mail.
- **Message-ID:** the unique id an email usually carries in its header. Messages without one are counted in the coverage report.
- **Digest:** a fingerprint of a message's content, so two copies can be compared without storing the text.
- **Approved-send log:** Conductia's record of messages it screened before send, by Message-ID and digest, with no content.
- **Supervisory read:** reading a deal-team member's Sent mail because the bank requires supervision, as distinct from the banker's opt-in for deal discovery.
- **Hold:** the bank's mail server keeps a message for a reviewer before delivery.

## Decision

1. **One screen, shared.**
   - The outbox's checks (the deal's Confidential subject prefix, the recipient boundary, recipient review, the rule screen, AI that can only escalate) move into one shared function, separate from storing and sending the message.
   - The outbox calls it and then sends. The post-send check calls it on a Sent copy. Future add-ins call it before send. The engine cannot drift between them.
   - Separate audit events: screened before send, sent, checked after send.
   - **Compounding with the screen's tuning.** Marcelo's false-positive work (#294, #305: rule-layer false positives from 23% to 7% on ordinary mail, with risky mail still caught) applies to both places at once. Every rule fix lowers false alarms before send and after send.
2. **The post-send check (first stage).**
   - **Scope.** External messages in the Sent mail of deal-team members whose mailboxes are connected. A message counts as deal mail if a recipient is a party or relationship of the member's deal, or the message is routed to a deal.
   - **Match first.** A message already screened before send (sent through Conductia) is matched by Message-ID and checked against its recorded digest and recipients. A Message-ID alone is a lookup hint, not proof.
   - **A matched message.** A clean match (same digest, same recipients) is counted, not queued. If the recipients differ from what was approved, a high-severity item is raised: mail went to people the screen never saw. If only the content differs, the Sent copy is screened again and raises an item only if that screen would warn.
   - **Screen the rest.** An unmatched message gets the same screen (rules only until the model gate allows AI, decision 8). A review item is raised only when the screen would have warned, or a recipient falls outside the deal's relationships. Clean unmatched mail is counted, not queued.
   - **The digest is computed one way everywhere:** plain text with signature and quoted history removed and whitespace normalized; attachments by name, size and hash; all recipients, including Bcc. Subject and send time alone never count as a match.
   - **Coverage is reported, never assumed.** Per bank: mailboxes connected, mailboxes paused or withdrawn, messages the reader skipped (no Message-ID, too large), and the pass delay.
3. **What the reader must add.**
   - **Microsoft:** Bcc and message headers in the fields the reader requests. Gmail's full download already includes both.
   - **Both:** the shared message shape exposes Bcc and the Conductia marker (decision 5) where present. A match on partial recipients is never treated as clean.
   - **Conductia's own sends:** store the real Message-ID. Today Graph sends get a synthetic id.
4. **Who can switch it off: a setting per bank, possibly per person. The team or the founder decides.** Today the reader reads a mailbox only after its banker opts in, and the banker can withdraw. The person most likely to bypass Conductia can therefore stop the check. The policy is a setting, not a single answer:
   - **Per bank:** the bank chooses between a **supervisory read** (the bank mandates reading deal-team Sent mail for supervision, as a new purpose in the mailbox guard, separate from the banker's discovery opt-in; needs the bank's legal basis) and **banker opt-in with withdrawal as an alert** (a pause or withdrawal raises an item for the bank's compliance reviewer).
   - **Per person, possibly:** a bank may set the policy for named people or roles (for example, deal leads under supervisory read, others under opt-in). The setting attaches to the banker's bound work identity (D69), not to an email address.
   - **Not decided here:** which options ship and the default. That is for the team or the founder.
5. **The approval marker (with the add-ins, later).**
   - An opaque random id in `X-Conductia-Approval`, looked up on Conductia's side. It carries no tenant, deal or sender, because headers reach recipients, and in M&A that alone can reveal a deal.
   - Written only at the moment of send, never earlier, so an approved draft edited later on mobile does not carry a stale approval.
   - The post-send check verifies every marker against the Sent copy's digest and recipients, and flags reused or mismatched ids as high severity. Single use is enforced there, and at a gateway if one exists. A mail rule that only checks that the header is present can be forged.
   - **Why it is signed:** only so a gateway can reject a forged id without a database lookup, including during a database outage. Until a gateway exists, the lookup is enough and the signature is optional.
   - Until an external verifier exists, the marker is signed with a per-bank key held by Conductia, which meets the ADR-0017 rule that banks do not share keys. A bank-verifiable signature (an asymmetric key, with key id, rotation, a public-key endpoint and bank-owned keys in BYOC) comes only with an external verifier.
6. **Data handling.**
   - The approved-send log and review items hold opaque ids, digests and verdicts in Conductia's database. Subjects, addresses, recipients and any reason that quotes content stay in the bank's data plane (ADR-0017).
   - The post-send check keeps nothing beyond digests and its verdict.
   - Composer sends still store the message as today. Whether that copy is a regulated record is the bank's decision (ADR-0020).
   - A reviewer's disposition of an item is supervisory evidence the bank must be able to export and keep.
7. **Identity: built on work identity (D69).** Martin's work-identity onboarding (#316, PR #320, flag off) binds each banker's Conductia account to the firm's own Google or Microsoft subject, matched by Google domain or Microsoft tenant, never by email alone, and refuses suspended users on every session. This ADR uses it three ways:
   - **Mailbox to person:** a mailbox source and its Sent mail map to a person through the bound identity.
   - **Client sign-in:** the future Outlook add-in and Gmail add-on sign the banker in through the same work identity, so preflight knows who is sending without a second login.
   - **Suspension and switch-off:** a suspended or revoked banker's mailbox stops being read for discovery, while the post-send check follows the bank's per-person policy (decision 4).
8. **AI.** Rules only, both in the send path and in the post-send check, until the model gate (#346) records a verified processor for the bank. Each verdict records which ran.

## Where each stage applies, by provider and tier

Only the composer screen is built today. Everything else in this table is planned.

| | Microsoft 365 | Google Workspace |
|---|---|---|
| **Dev** | Composer screen; post-send check on a Microsoft test tenant (after #275; the current tenant expires 2026-10-24, so a new one is needed) | Composer screen; post-send check on the paid dev Workspace ([setup checklist](../04-operations/dev-google-workspace-setup.md); the `emailmask.uk` trial expired 2026-10-20) |
| **Production, first stage** | Post-send check on connected mailboxes; under the bank's decision 4 setting | Post-send check on connected mailboxes; under the bank's decision 4 setting |
| **Production, later** | Outlook add-in on send (follow-up); hold rule on the bank's request | Chrome extension or Workspace add-on (follow-up); gateway hold on the bank's request |

**Gates before the first stage goes live for a bank:**
- the reader's own go-live gates for the bank's provider (ADR-0021 for Microsoft, ADR-0022 for Google) and ADR-0020;
- the shared screen extracted, with the outbox behaving exactly as before;
- on the trial domain, a measured false-alarm rate and an estimate of review items per banker per day, both accepted by the bank's compliance team. The false-alarm rate is measured with the existing false-positive test set (`tests/compliance-false-positives.test.ts`), extended with real Sent copies from native clients (signatures, quoted history, forwards);
- the decision 4 choice made.

## Follow-up decisions (not decided here)

| Item | What is known | What must be proven first |
|---|---|---|
| Outlook add-in on send | Works on web, new and classic Windows and Mac, not mobile. "Prompt user" mode lets the banker send anyway, which keeps send-as-is. If the add-in fails to load, the mail is sent with no marker; the post-send check catches it. Admin deployment only; Mac needs the XML manifest; each update needs admin re-consent | The marker set in the send handler reaches the transport rule; coexistence with the bank's other on-send add-ins; the Simple MAPI policy |
| Gmail extension (desktop Chrome) | InboxSDK's pre-send event can cancel a send. It may fire more than once, and other extensions can change the message after it. Needs managed Chrome, and InboxSDK becomes a vendor dependency (SOC 2 CC9.2) | The bank can force-install it (Ignatious has no IT team); the content is checked at the moment of send; upkeep as Gmail changes |
| Gmail Workspace add-on | Web and mobile, but opened by choice; cannot gate Send or set headers | Whether bankers use it |
| Usage dashboard for the email product | Sends per channel (Conductia, add-in, native), screen outcomes, send-as-is rate, post-send items and how they were resolved, coverage per bank, AI cost per message. Builds on two existing pieces: the anonymous warning-outcome counter (#311: tenant, day, warning kind, sent or abandoned, no person or content), extended with a channel dimension, and the AI Costs page (#246, #299, #109). Needs no new content | Which metrics banks and Conductia actually use; who may see per-banker figures |
| Hold at the bank's mail server | Exchange "forward for approval" expires after two days (processed weekly), unsent, and the moderator receives the whole message. Google needs a Conductia-run relay (DKIM, SPF, loops, two zones, on-call) | Reviewer coverage and response time; sign-off as an amendment to send-as-is |

## Costs and effort

| Item | Monthly cost | Effort (estimate) | Notes |
|---|---|---|---|
| Shared screen extraction | $0 | Medium | Prerequisite for everything else. Engineering (send path) |
| Post-send check | Small: rules-only compute on each Sent message in the reader's pass | Medium | AI, when allowed, is metered per message (#109) |
| Reader additions (Bcc, headers, real Message-ID) | $0 | Small | |
| Reviewer time | **The main cost:** items per day × minutes per item | n/a | Estimated on the trial domain; a gate for the first stage |
| Per-bank signing key | About $1 per bank | Small | Only with the marker |
| Outlook add-in, Gmail extension, Gmail add-on | $0 hosting; $5 one-time Chrome Web Store fee | Medium each, plus extension upkeep | Follow-ups |
| Google gateway | Unpriced: needs two zones, a load balancer and on-call | Large | Follow-up, on a bank's request |

## Regulation

| Area | What applies | How this design answers it |
|---|---|---|
| Supervision of correspondence | FINRA 3110(b)(4): written procedures to review outgoing correspondence, risk-based (Supplementary Material .06) | The post-send check gives the bank a risk-based review of external deal mail, whatever client sent it, and coverage is measured |
| Books and records | FINRA 4511, SEC 17a-4 | The bank's own archive keeps the mail. The log is content-free. Review dispositions are supervisory evidence the bank keeps |
| Off-channel communications | SEC off-channel actions (over 100 firms, over $2B since 2021) | Native mail stays in the bank's own tenant, where the bank's archive is expected to capture it; the bank verifies that coverage for each send path, including Conductia's fallback transport. The gap closed here is unscreened mail, not unrecorded mail |
| SOC 2 | CC7.2 and CC7.3 (monitoring, evaluating events) | Bypass is detected, evaluated by the same screen, and routed to a reviewer |

No rule requires a single send path. This design makes supervision measurable without one.

## Alternatives considered

| Option | Why not |
|---|---|
| Force all sending through Conductia (reject at the bank's server) | Breaks the native client and mobile, contradicts send-as-is, and a gateway outage stops all deal mail |
| Queue every unmatched external message for review | On Gmail almost every native send is unmatched; the queue would equal the bank's external mail |
| A header rule as the only control | Any SMTP or API client can forge the header |
| Native Gmail DLP alone | Uses built-in detectors and word lists; cannot apply deal relationships. A bank may still run it alongside |
| Deal and tenant ids in the marker | Headers reach recipients and can reveal a deal |

## Open points

| Item | What changes if wrong | Owner |
|---|---|---|
| Decision 4: which switch-off options ship, at bank or person level, and the default | Whether a banker can switch off the check | The team or the founder, with legal review |
| False-alarm rate and reviewer load on the trial domain | Whether the first stage is workable for the bank's reviewer | Engineering (send path), then the bank's compliance team |

## When to revisit

| Trigger | Reversal or change |
|---|---|
| False alarms or reviewer load exceed what the bank accepted | Narrow the deal-mail scope, or raise the screen's threshold for post-send items |
| A bank asks for prevention, not detection | Bring forward the Outlook add-in or Gmail extension; a hold only with a send-as-is amendment |
| Bankers widely withdraw consent | Move from the withdrawal alert to the supervisory read, with the bank's legal basis |
| A regulator or examiner expects pre-send review of correspondence | Make in-client screening a requirement for that bank |
| Email becomes a stand-alone product | The shared screen, the log and the post-send check ship without the discovery pipeline |

## References

Outbox pipeline: `src/app/api/v1/outbox/route.ts` (checks, then record and send), `src/lib/mail/recipientBoundary.ts`, `src/lib/api/v1/recipientReview.ts`, `src/lib/compliance/recipientToken.ts` (10-minute HMAC token), `src/lib/compliance/screenToken.ts` (60-minute HMAC token), `src/lib/compliance/screen.ts`, `src/lib/compliance/llm.ts`, `src/lib/email/graph.ts:171-172` (synthetic id). `/api/v1/screen` takes one text field and no recipients, and returns no token. Readers: `src/lib/graph/reader/mail.ts:35-49` (Sent read; no Bcc or headers selected), `src/lib/google/reader/mail.ts` (Sent read; skips). Send-as-is: `docs/03-engineering/compliance-rules.md:22-26`. Research, read 2026-10-06: Outlook Smart Alerts and internet headers; Exchange mail-flow conditions, actions and moderation; Gmail add-on manifest and compose actions; InboxSDK compose events; Chrome force-install; Gmail content compliance, routing and DLP; FINRA 3110 and 4511.
