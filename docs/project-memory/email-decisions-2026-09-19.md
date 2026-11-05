# Email compliance decisions — 2026-09-19

> **Later:** Storm's follow-ups of 2026-09-21 briefly allowed an anonymous withdrawal count (`storm-follow-ups-2026-09-21.md`); D80 (2026-10-05) returned to Q7 A below: no record of an email that was not sent, not even a count.

Source: user-supplied wording, reconciled with the [published Slack message](https://futureproofingtalk.slack.com/archives/C0B7L94CDPS/p1789830302556419),
Sep 19 at 12:05 BRT. Publication is confirmed, including the revised question 7.
Storm’s response was supplied by Marcelo on September 21 and is recorded below.
The connector previously returned no replies; this does not invalidate the supplied
response. Codex has not posted messages or changed GitHub issues for this update.

## Supplied message

Storm, Dan: seven decisions on email compliance for the October release. Each one is a choice; a one-letter answer works.

Email safety

1. What we keep on file for every screened email.
   (A) Only the email as sent, plus any warning the banker chose to override.
   (B) Also the banker's original draft and the AI's suggested rewrite.
   A drives less retention risk; B gives compliance the full trail.
2. Confidential marking.
   (A) Every email on a live deal or pitch is marked Confidential automatically.
   (B) The banker marks it when needed.
3. Email to someone outside the firm.
   (A) The banker sees a warning and can send.
   (B) The banker must confirm before it goes out.
4. Someone on the email who is not on the deal team.
   (A) Warn the banker before sending.
   (B) Warn, and also notify compliance after the send.

Compliance controls

5. Who is the compliance officer of record at Ignatious, and what should land on their desk?
   (A) Only the riskiest messages.
   (B) The riskiest plus a sample of routine ones.
   (C) Everything above a bar they set themselves.
6. Sending at Ignatious. Other banks will get their own setting.
   (A) One click, as today.
   (B) A confirmation step on every email leaving the firm.
7. Emails the banker decides not to send after seeing a risk warning.
   (A) Keep no record of the unsent email.
   (B) Keep a record visible only to the deal team.
   (C) Keep a record also visible to the firm’s compliance officer.
   If B or C: should the record include the draft text, or only the warning and the decision not to send?

Answers to 1, 2, 3, 5 and 6 unblock the build; 4 and 7 can wait a week.

## Storm’s response — recorded September 21, 2026

Source: Marcelo’s pasted transcription, attributed to Storm at 12:30 PM.
The original reply date and direct reply permalink have not been independently
verified. The question-thread link above is not a verified link to the reply.
This response supersedes this ledger’s earlier pending-answer status.

> 1. A
> 2. A
> 3. A
> 4. If the recipient is logical for that email is should merely see a warning and can send; if the recipient is illogical it should require confirmation (e.g. if the recipient is not on the broader working group for that deal, they need to manually confirm sending.  If confirmed, banker is then asked if that person should be added to the broader working group for that deal)
> 5. C
> 6. A (subject to #4 above).  One exception, if something is highly risky, there should be a second confirmation (compliance risk, legal risk, reputational risk).  This should be tunable by compliance.
> 7. A

## Implementation mapping and response ledger

Mapping is an engineering interpretation, not a new assignment. Issue references
identify related scope, not refreshed delivery status.

| Question | Related work | Confirmed product direction |
| --- | --- | --- |
| 1 | Screen/outbox/audit retention | A: retain the sent email and overridden warnings, without retaining the original draft and AI rewrite as additional records. |
| 2 | #170 Confidential marking | A: automatically mark email on a live deal or pitch Confidential. |
| 3 | #171 external banner, #95 send friction | A: external recipients alone trigger a warning, with sending allowed. Exceptions in Q4/Q6 still apply. |
| 4 | #172 recipient check | Logical recipient: warning with sending allowed. Illogical recipient, including someone outside the broader working group: manual confirmation, followed by a prompt asking whether to add that person to the broader working group. |
| 5 | #94 thresholds and CCO routing | C: route everything above a compliance-defined bar. Officer identity remains unanswered. |
| 6 | #95 per-bank friction | A for Ignatious, subject to Q4 and an extra confirmation for high compliance, legal or reputational risk; tunable by compliance. |
| 7 | Withdrawn-email retention; #99 is related but not identical | A: keep no record of the unsent email when the banker withdraws after a risk warning. |

## Remaining implementation contracts

The seven policy directions are answered. Email safety and compliance controls
can proceed to specification and implementation planning; this is not evidence
that the controls are implemented or delivered.

- Obtain the identity of Ignatious’s compliance officer. Q5 C answers routing,
  but does not supply the person’s name.
- Define the authoritative broader working group and the deterministic recipient
  check. An AI suggestion must not authorize sending or access. Offering to add
  a person is not automatic membership or a grant of deal/data access. Specify
  when the prompt occurs relative to actual sending; Storm said “If confirmed”.
- Specify compliance-owned risk settings and how recipient and high-risk
  confirmations compose. Do not invent thresholds or persist numeric scores.
  Q4 does not approve automatic compliance notification for every outsider.
- Reconcile Q1/Q7 with existing SCREEN audit metadata/hashes, outbox rewrite
  fields, telemetry, append-only audit requirements and legal holds before
  changing persistence. Q7 means no record of the unsent email, not merely no
  draft body. Escalate any remaining policy conflict explicitly; do not silently
  narrow Storm’s answer or delete historical audit records. These answers do
  not authorize a historical purge or reintroducing the old hold/block path.
- Carry this source into the canonical decision log/ADR process, living specs
  and affected issues before implementation. This local record does not claim
  that GitHub, production behavior or canonical contracts have been updated.
