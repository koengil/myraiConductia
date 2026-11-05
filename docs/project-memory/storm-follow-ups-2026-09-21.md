# Storm email follow-ups — recorded September 21, 2026

> **Later (D80, 2026-10-05):** a discarded or abandoned draft is no longer reported at all, not even as an anonymous count (`docs/07-decisions/decision-log.md`, D80; `src/app/api/v1/mail-warning-outcomes/route.ts`). The withdrawal-count rule below is superseded.

Source: Marcelo's pasted Slack transcription in this task, attributed to Storm
at 1:08 PM, answering Marcelo's six follow-ups at 12:15 PM. The original message
date and reply permalink were not independently verified. No Slack messages or
GitHub issue comments were sent. This is accepted product direction supplied by
Marcelo, not evidence of implementation or a production configuration change.

## Source response (verbatim)

1. Great question, and I hadn't appreciated the nuance that it creates (not a simple answer, apologies).  From a hierarchy standpoint there are internal employees of the bank on the deal team, then there is the client, then their advisors, then the counterparty, then the counterparties advisors.  The risk increases as you walk down that list (so making a mistake by including an internal employee of the bank on the deal team is costless, sending an email with a copy to people outside the bank has risk, and to the counterparty is HIGHLY risky.  So even though the client is on the deal team, as well as the counterparty broadly speaking, we need to highlight those risks.  So ANY external send that includes someone outside of the banking deal team should note that there is an external party.   But the MESSAGE it generates should change and the formatting. So if there is someone copied that is not on any list associated with the deal it would be something like  all caps, red font saying "EXTERNAL NON-DEAL ASSOCIATED PARTY COPIED ON THIS EMAIL. PLEASE APPROVE."  For a buyer or counterparty it should also be in all red font, maybe not caps, saying: "Counterparty and/or Countparty Advisor copied on this email, please approve." And for any others (client, client advisor) it would merely highlight that party as a different color in the email addressee line but not require approval (similar to how apple mail does this currently - internal recipients are highlighted in green, external in red). This can be done for all external parties, not just the ones listed here, but the ones listed here don't require a second approval to send.
2. Should prompt banker on whether to add them to the working group list (which should have every single party associated with the deal on it). The working group list is currently a part of the workflow, but it needs to be perpetually kept up to date, as this entire inquiry evidences.  Anyone added to the working group list should be automatically added to the platform as well, since this is our "lead generation engine" for new clients as well.  That will require teh banker also assigning them a level of access/permissioning.  The default permission level should be the lowest, as that has the least risky in case the banker accidentally just hits accept.
3. B
4. A (although we should refine the list together of what is a top risk level)
5. B (GREAT IDEA)
6. Dan and Storm

## Follow-up question mapping

- F1 asked whether the group was platform invitees only or also off-platform
  advisors. Storm replaced that binary with the relationship hierarchy below.
- F2 asked whether someone could be logical solely through a shared deal-party
  domain. Storm answered about adding people, not that domain shortcut. Do not
  interpret F2 as approving every employee of a party company.
- F3 B means adding the person also invites them to Conductia with selected access.
- F4 A sets the initial extra-confirmation scope to the highest risk level, not
  every warning. Storm explicitly wants the exact top-risk list refined together.
- F5 B permits only a number, no text or names, for withdrawals after warnings.
- F6 identifies Dan and Storm as escalation recipients. It does not assign either
  person's precise production account, grant CCO/admin permissions or set a bar.

## Governing recipient matrix for the next implementation

Apply to To, CC and BCC, preserving the field when removing recipients.
Recipient confirmation is separate from the high-risk content confirmation.

| Verified deal relationship | Presentation | Recipient confirmation |
| --- | --- | --- |
| Bank employee on this deal's banking team | Internal recipient styling | No |
| Client | External styling in address line | No |
| Client advisor | External styling in address line | No |
| Counterparty / buyer | Red counterparty warning | Yes, even when on the group |
| Counterparty advisor | Red counterparty warning | Yes, even when on the group |
| External person not associated with this deal | Prominent uppercase red warning | Yes; then offer group addition |

The highest applicable requirement wins for mixed recipients. Removing one
recipient must not clear another recipient's confirmation requirement. Color
must be accompanied by text/accessible labels. Correct the example's typo
"Countparty" in product copy without changing the preserved source above.

Storm's costless example is explicitly a bank employee ON the banking deal team.
It does not exempt every same-domain employee. Preserve the earlier confirmation
requirement for an off-deal internal employee, with accurate internal wording.
Unresolved identity/affiliation must never be silently promoted to client/team.
The suggested handling of incomplete affiliation needs specification; do not
invent a client/counterparty relationship from access role, email domain or AI.

## Supersessions and engineering implications

- Supersedes #172's old "a draft to a roster member passes silently" criterion:
  counterparties and their advisors require approval even as recognized members.
- Supersedes the proposed communication-only addition path. Accepting an addition
  must include platform onboarding/invitation and an explicit permission choice,
  initially the lowest supported access. Reuse authorized invitation/acceptance
  controls; do not silently grant elevated access or bypass information barriers.
- Domain classification from PR #192 remains useful as a base signal. It cannot
  determine client versus counterparty. Add per-recipient relationship styling
  and confirmation in the next slice. Q3 alone does not require confirmation,
  but the clarified Q4 exceptions do. Do not label #192 the complete new UI.
- Membership/access roles (`md`, `deal_team`, `legal`, `seller`, `buyer`,
  `read_only`) are not a complete affiliation taxonomy: legal/read-only cannot
  distinguish whom an advisor represents; buyer/seller is not universally the
  same as counterparty/client. Use explicit deal-relative affiliation.
- Team remains the canonical place to maintain the working group. Invitations,
  accepted memberships and affiliation are distinct states. Specify pending,
  revoked and changed affiliations, authorized maintenance and retry behavior.
- Keep confirmation bound server-side to actor, deal, final content, recipient
  fields, attachments and current policy/group state. Adding someone must not
  remove a counterparty confirmation requirement on subsequent messages.
- Initial high-risk confirmation is top-tier only. Numeric thresholds and the
  exact rule list were not supplied; current numeric defaults are not thereby
  approved. Compliance routing and send-confirmation thresholds remain separate.
- Anonymous aggregate withdrawal count is now allowed. Do not retain a per-email
  withdrawal event, names, body, rewrite, hash or actor/deal-linked event disguised
  as a count. Define aggregation and duplicate prevention without reconstructing
  an individual withdrawal. This does not authorize a historical purge or resolve
  the separate AI usage accounting/immutable-audit/legal-hold contracts.
- Configure Dan and Storm as the intended escalation recipients through the
  authorized settings process; no production account modifications in this task.

## Refreshed delivery evidence

GitHub refreshed after this transcription on September 21:
`develop` e1d97376 is two commits ahead of main, zero behind.
#172 is OPEN, has no comments, and retains its older acceptance text.
#191 is OPEN at 5247f025 (changed from the earlier reviewed c30f93d3), all checks
pass in run 35621207878. The old combined test at c30f93d3 is not proof of the
new head's composition. #192 is OPEN at f85d7822, all checks pass in run
35621483609. Neither is merged. No product code was changed in this update.

## Recommended next work

1. Revise the #172 implementation design around explicit affiliation, a maintained
   Team roster, per-recipient indicators and server-enforced confirmation. Include
   the governed invitation/access step and lowest-access default; do not implement
   a contact-only list as the final addition behavior.
2. Implement top-risk confirmation and configurable routing to Dan and Storm
   (#94/#95), after defining the top-tier rule mapping with Storm/compliance.
3. Implement prospective sent-only retention plus anonymous withdrawal counts,
   reconciling audit and cost accounting without deleting historical evidence.

This local decision reconciliation is not a newly approved implementation plan.
Promote the sourced decisions into the current-branch decision log/ADRs and living
contracts with the affected implementation. Avoid editing stale main's decision
log over D56/D59 in the open PRs.
