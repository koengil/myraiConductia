# Deal-relative recipient safety design

Date: September 21, 2026. Status: approved by Marcelo before implementation.
Storm's product directions are accepted. Execution method is inline with an
independent final review. This document supersedes the recipient section of the
earlier umbrella design for the supported slice below.

## Outcome and source

Implement Conductia #172 using [Storm's supplied follow-up](../../project-memory/storm-follow-ups-2026-09-21.md).
Before sending, a banker can see whom each To/CC/BCC recipient represents,
remove an unintended recipient, and explicitly approve counterparty or unknown
recipients. After a successful send, adding a new person to the working group
also initiates authorized platform onboarding with minimal selected access.
Adding a counterparty never makes subsequent counterparty emails confirmation-free.

This is an architectural change to Team, invitation and mail contracts. Reusing
membership alone cannot express advisor affiliation; using email domain or AI
would incorrectly trust company colleagues. Recommended: a small explicit,
deal-scoped relationship register joined to existing invitation/membership state.
A separate contact-only directory is rejected because Storm requires onboarding.
Replacing the existing invitation/access system is unnecessary and unsafe.

## Verified baseline and governing constraints

Fresh develop: e1d97376; main comparison: ahead 2, behind 0. #172 remains OPEN,
W4 milestone, no assignee/comments; its roster-member-silent criterion is
superseded by Storm. #191 is OPEN at 5247f025 and #192 at f85d7822, both green.
Build from freshly verified develop when these dependencies land; otherwise use
an explicitly documented stacked branch and composition check. Never merge them
on the user's behalf or assume the older c30f93d3 composition applies today.

Follow AGENTS, D35 governance, D46 Team, D48 Workbench, delivery model and current
access/invite RPCs. All reads/writes are tenant/deal scoped with server checks.
AI never decides affiliation, permission or confirmation. Node >=22.12.0;
TypeScript strict. Prefix node/npm/npx with NODE_OPTIONS=. No concurrent Vitest.
Rob merges and applies named migrations. Never modify production credentials or
Storm/Dan accounts. Synthetic records use ZZ TEST. No numeric risk persistence.

## Recipient decisions

| Authoritative state | Presentation | Recipient confirmation |
| --- | --- | --- |
| Active bank member on this deal | Internal styling and accessible label | No |
| Explicit client | External chip, Client label | No |
| Explicit client advisor | External chip, Client advisor label | No |
| Explicit counterparty | Red counterparty warning | Yes |
| Explicit counterparty advisor | Red counterparty warning | Yes |
| External address with no deal association | Uppercase red non-deal warning | Yes |
| Off-deal bank employee | Accurate off-deal warning, not an external claim | Yes |
| Known member without reliable affiliation | Relationship-unverified warning | Yes |

Unknown firm boundary is explicitly unverified, never silently internal.
A known external member with unknown affiliation must not be called an unknown
person. All To/CC/BCC participate; one internal address cannot suppress another's
warning. Colors supplement readable labels. Use Workbench tokens and focusable
removal controls. Correct the source copy's typo to "Counterparty".

## Relationship register and lifecycle

Proposed `deal_recipient_affiliations` stores tenant_id, deal_id, normalized_email,
company_id, affiliation (client/client_advisor/counterparty/counterparty_advisor),
represented_company_id (required for advisors), user_id or invite_id reference,
revision, created_by, updated_by and timestamps. Unique deal/email. The bank-team
case comes from authoritative current membership AND the deal's owning bank;
it is not selectable to bypass warnings. No generic allowlist or numeric risk.

Relationship records are administrative facts, not an unsent-email log. Write
only after an explicit authorized Team/invitation action, never on compose,
preflight, cancel or merely confirming a send. SQL and TypeScript enums agree.
RLS grants no unrestricted client mutation; use authenticated server guards and
transactional RPCs with explicit actor checks, not a trusted client actor ID.

Effective affiliation requires either a current eligible membership or a valid, successfully delivered
pending platform invitation created for this deal and email. The banker's explicit
relationship assignment establishes the communications relationship while an
invitation is pending; it does not grant platform access before acceptance.
Expired/revoked invitations and removed memberships cannot keep a stale exemption.
Delivery failure remains visible and retryable and does not activate a new
communications exemption. Do not label failed onboarding
as completed. Existing external members without classification remain known but
unverified until an authorized manager assigns one; no mass inferred backfill.

Advisor relationship must point to the represented deal party. Access role and
client/counterparty affiliation are separate: seller/buyer must not universally
mean client/counterparty (buy-side mandates exist), and legal/read_only do not
say whom an advisor represents. Ambiguous/contradictory associations require
review, never a guessed client exemption. Company/email changes invalidate an
old effective relationship until checked again.

## Team and onboarding

Team is the sole management destination. Existing authorized member managers
can assign/correct affiliations, with atomic audit and optimistic revision checks.
External directors may not relabel counterparties to suppress warnings; the mail
relationship policy is maintained by authorized internal deal managers/admins.
Ordinary senders can approve a send but do not thereby gain roster-management rights.

After confirmed successful send, offer “Add to working group”. Declining leaves
sending complete. Acceptance opens a prefilled governed Team invitation form,
including company, affiliation, represented party where applicable and access.
Use the existing invitation domain confirmation, verification, acceptance and
existing-account grant controls. A recipient approval token is never an invitation
confirmation or permission grant. A sender without management rights sees the
permission explanation and Team destination, not an enabled unauthorized mutation.

Default access: company member, disclosure phase 0, and read_only for an eligible
internal bank seat. External seats retain the current party-derived seller/buyer
contract at phase 0; read_only is not currently a valid external invite role.
Never downgrade or elevate an existing account silently. Show the actual perimeter
preview before submission; phase 0 is not described as zero access.

### Existing policy boundary that remains visible

`src/app/api/v1/invites/route.ts` currently requires an external company to be a
deal party (approximately lines 171–191) and returns `company_requires_director`
for a member invite into a company without an active director (approximately
lines 198–211). Storm's lowest-default direction does not authorize bypassing
those checks or selecting Director automatically. Keep the member default and
show an explicit setup blocker; no relationship exemption is committed as a
substitute for a failed invitation.

New advisor firms not representable by the existing deal-party model require a
separate, explicitly designed party/onboarding extension. Do not label an advisor
firm as the client/counterparty solely to make the old endpoint accept it.
This delivery can classify already onboarded advisors and safely guide eligible
new invitees. #172 must stay open for end-to-end new-advisor-company onboarding
until that extension is implemented. This is a concrete scope dependency, not
another unanswered question about what Storm wants.

## Mail API and confirmation

Proposed POST `/api/v1/deals/{dealId}/recipient-check` accepts only current
To/CC/BCC lists. Return recipient-specific relationship, organization boundary,
confirmation reason and policy fingerprint. Require mail flag, authentication
and the existing bank-side deal mail permission; do not expose a tenant directory.
An inaccessible deal is denied; failed authoritative lookup is 503, not an empty
trusted roster. Limit and validate lists consistently with outbox limits.

Outbox remains authoritative: resolve deal, apply Confidential subject handling,
load current policy, classify current recipients. If required approval is absent
or stale, return `recipientReviewRequired` with results and an opaque signed token,
without provider call, outbound row or recipient-override audit. No extra record
is created for an abandoned recipient review. A projectless send retains #171's
external warning and existing risk controls; no invented deal group.

Token binds actor, tenant, deal, normalized field-specific recipients, effective
subject, body/HTML, attachment content digests, decision reasons, policy schema
version and current relationship/membership fingerprint. HMAC with a dedicated
purpose-derived key, 10-minute expiry and rejection of future issue times. Never
persist the token, content hashes or recipient preflight in analytics/logs.
At submit reauthenticate/recheck access and reclassify; changed policy requires
fresh confirmation. A plain client boolean or a token for a different message
is insufficient. Send confirmation is not a reusable membership exemption.

Keep Risk Patcher intact. Recipient confirmation never sets sendAsIs or satisfies
its token. Content risk confirmation may follow the recipient review; unchanged
recipient approval can travel with the risk resubmit, but edits invalidate it.
Reuse the valid existing screen result where supported to avoid repeated paid
screening. Only the normal committed send retains recipient override reasons,
relationship snapshot and policy version in its existing append-only evidence.
No new CCO notification for every outsider; Q5 routing is a separate slice.

The implementation will add no generalized transport idempotency guarantee:
existing pending-row/delivery recovery remains authoritative. UI double-submit
is disabled; token validation must not bypass sender/provider configuration.

## Explicitly separate work

Q6 top-risk rule calibration and Q5 routing/settings to Dan and Storm are a
separate plan. Q1/Q7 sent-only retention and anonymous withdrawal counts require
the audit/AI-cost accounting reconciliation; they are not mixed into #172.
Existing historical evidence/legal holds remain untouched.

## Delivery and validation

1. Relationship storage, guarded management and live Team representation.
2. Deterministic recipient classification and server-enforced signed approval.
3. Composer indicators, removal/confirmation and governed post-send invitation.
4. Separate new-advisor-company onboarding extension before claiming #172 closed.

Tests cover every matrix row in To/CC/BCC, mixed roles, same-domain strangers,
pending/revoked/expired invites, membership removal, affiliation changes, ambiguous
advisors, cross-tenant requests, ordinary sender versus manager, query errors,
client spoofing, token tampering/expiry/field movement/content/attachment changes,
Risk Patcher composition, cancelled drafts producing no new preflight record,
lowest-access defaults, director/setup blockers and invitation failures.

Use failing-test → minimal code → passing-test per task; required application
checks, isolated SQL/integration and hermetic E2E, actual Workbench browser/a11y
checks, and independent courteous material-only review. Name migrations in PRs.
Record partial implementation versus merge/release; no automatic issue closure.
