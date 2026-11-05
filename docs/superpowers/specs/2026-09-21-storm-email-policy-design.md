# Storm email policy implementation design

Date: September 21, 2026. Status: engineering design approved by Marcelo in conversation on September 21, 2026.
Product direction: accepted from Storm’s response supplied by Marcelo; the
technical proposals below are not additional decisions attributed to Storm.

## Intent and sources

Implement the seven answers in the existing Conductia mail channel. Ordinary
Ignatious sends remain one click; recipients outside the broader working group
and highly risky messages require deliberate confirmation. Preserve only sent
communications and overridden warnings; withdrawn emails leave no email record.

Source: [exact answers and provenance](../../project-memory/email-decisions-2026-09-19.md).
Governing constraints: D35 governance, D46 Team, D48 Workbench, current delivery
model, append-only audit and legal holds. This does not approve all of MVP 2.

## Verified baseline

GitHub develop was refreshed September 21: `e1d97376e9ef8a10343ca6f64c4fe0204813ba55`.
The local main-to-develop comparison contains documentation/version changes,
not application source changes. Issues #170, #171, #172, #94, #95 and #157 were
read with current bodies; the open PR list contains no implementation of these
email slices. This is a dated finding, not a promise against future team changes.

- `src/app/api/v1/screen/route.ts`: full screens persist verdict, reasons and
  a text hash before the banker decides to send.
- `src/app/api/v1/outbox/route.ts`: SCREEN is written before returning risk
  findings. The outbound row retains `rewrite`. Send-as-is always becomes
  Queued, independent of a CCO-configured bar. Pending rows precede transport.
- `src/lib/compliance/screenToken.ts`: signed tokens bind content, actor and
  deal, but not recipients or policy revision. Numeric heat is excluded.
- `src/lib/compliance/riskBand.ts`: current provisional thresholds are 40/70;
  these are existing behavior, not new Storm-approved defaults.
- `src/components/mail/MailClient.tsx` and `src/lib/mail/drafts.ts`: drafts
  autosave in localStorage; send/discard removes them. Simply leaving a draft
  is not currently equivalent to withdrawing it after a risk warning.
- `src/lib/constants/deals.ts`: lifecycle categories include live, pitch,
  prospect, mandate_hold, terminated, closed and lost.
- #157: verified-domain storage exists, but domain-management UI/API remains
  open. Never infer verified domains from the sender’s email.

## Approach and alternatives

Recommended: extend the current server send path with a small deterministic
policy evaluator and a preflight contract used by the composer. Deliver in
reviewable slices with tests and canonical documentation in each slice.

A UI-only implementation would be smaller but direct API calls could bypass
confirmations. A replacement mail pipeline would duplicate screening, transport
and audit behavior. Neither is recommended.

## 1. Confidential marking and external warning — Q2/Q3

Use authoritative deal lifecycle for automatic Confidential marking on live
and pitch mail. Proposed representation: an idempotent `[Confidential]` subject
prefix, previewed before send and applied by the server before screening,
token binding, retention and transport. Closed/lost deals do not acquire an
automatic prefix. Do not strip labels deliberately typed by the sender.

Classify every To/CC/BCC address using the sender organization’s verified domains.
Show the external warning immediately as recipients change, and persist the
external marker only on the sent communication. Domain uncertainty must be
visible, never silently classified as internal. An external address by itself
adds no confirmation. #157 management remains a separate dependency; read the
existing verified-domain source without inventing trusted domains.

## 2. Recipient confirmation — Q4

Preflight and send-time checks use the same authoritative, permission-scoped
recipient classification. Check all To/CC/BCC addresses; show flagged addresses
with remove actions. Never treat every employee of a deal-party company as an
authorized deal recipient solely because their employer is a party.

Proposed first implementation maps the broader working group to explicit active
project membership and explicitly recorded working-group contacts. Confirm
this mapping before implementation: current issue #172 says memberships and
parties, while Storm refers to a broader working group. An LLM must not decide
that an outsider is authorized.

Confirmation must bind the final message, normalized recipient sets, actor,
deal, policy revision and required confirmation reasons. Edits invalidate it;
server-side membership and policy changes are rechecked. No risk number is
stored in a token. A bare client boolean cannot satisfy confirmation.

After recipient confirmation, offer to add the person to the broader working
group. Declining does not prevent the already-authorized send. Accepting uses
the existing authorized Team/invitation flow with explicit access choices;
it never grants data access automatically. Proposed timing: offer after the
send succeeds, so an invitation cannot accidentally precede an abandoned send.
This timing is an engineering proposal; Storm only specified “If confirmed”.

## 3. Compliance settings and extra risk confirmation — Q5/Q6

Add tenant-scoped settings for the CCO routing bar and high-risk send-confirmation
policy, with versioning, server authorization and atomic configuration audit.
Separate notification/routing thresholds from send-confirmation thresholds.
Ordinary banker access cannot read another tenant’s settings or change policy.
Follow existing CCO/admin authority; identify the actual officer separately.

Ignatious’s ordinary send remains one click. The server returns a distinct
confirmation requirement for high compliance, legal or reputational risk.
Keep existing Risk Patcher choices; high risk requires an explicit extra
confirmation beyond the initial Send. Propose one confirmation listing all
applicable recipient/risk reasons to avoid redundant dialogs.

Compute against transient screening values; retain policy revision, applicable
warnings, confirmation and the derived band on sent records, never numeric
message risk. Signed replay must carry policy-derived decisions, not fall back
to absent heat or an unconditional Queued override. A changed policy requires
fresh evaluation. Missing risk evidence cannot silently mean low risk.

The current screen exposes MNPI/promissory/reputational findings, not three
independent calibrated category scores. Do not invent category scores or
threshold values. Define the category mapping and configuration initialization
before enabling this slice. Officer identity is needed for actual notification
routing, not for constructing or testing settings with synthetic fixtures.

## 4. Prospective retention and withdrawal — Q1/Q7

Keep full screening results and rewrite suggestions ephemeral while the banker
is deciding. Do not append a message-linked SCREEN event for a returned warning
or advisory full screen. When sending is committed, retain the actual outbound
message, overridden warnings and necessary delivery/audit metadata, without an
extra original draft or suggested rewrite. Preserve historical records as-is.

An explicit withdrawal after a warning clears the local draft, pending autosave,
UI rewrite/token state and attachments; do not write a withdrawal history. Guard
against a debounced save restoring a discarded draft. Keep “continue editing”
distinct from “do not send”. Browser-close/navigation semantics need explicit
agreement if they too are intended to count as withdrawal.

Two policy boundaries must be resolved before implementing this slice:

1. Existing docs require every full screen to be audited. Storm’s Q7 says no
   unsent-email record. Proposed supersession is prospective: defer email-linked
   audit until committed sending; preserve all existing immutable evidence and
   legal holds. Do not remove audit protections to make deletion possible.
2. Current AI cost capture creates an actor/deal-linked row per screen, even
   when no email sends. Decide whether content-free usage accounting is allowed
   or requires aggregation without email correlation. Do not silently describe
   a retained per-email cost trail as “no record”.

A committed send that fails or has an ambiguous provider receipt is not the same
as a banker withdrawing before send. Preserve the existing record-first delivery
safety until its failure/recovery contract is reviewed; Q7 must not introduce
sent-but-unrecorded messages or unsafe retries.

## Delivery sequence

1. Confidential marking (#170): lifecycle, composer preview, server enforcement,
   actual sent/outbox representation. This is the most isolated first slice.
2. Shared recipient/external preflight (#172/#171), confirmation binding and the
   explicit Team follow-up. Settle broader-group mapping before this slice.
3. Tenant compliance settings and risk confirmation (#94/#95), category mapping,
   policy revision and CCO routing. Do not initialize production accounts.
4. Prospective retention/withdrawal (Q1/Q7), after the audit/cost-accounting
   boundaries above are resolved. Exercise it across the earlier slices.

Update the canonical decision log/ADR and affected API/compliance living docs
alongside each implementation. Existing issue text mentioning held messages
or unconditional override queuing needs explicit reconciliation. No external
issue comments or messages have been posted as part of this preparation.

## Required validation

- Confidential: live/pitch versus closed/lost, repeated prefix application,
  forged client lifecycle, subject screening and sent transport representation.
- Recipients: To/CC/BCC, normalization, same-firm outsider, external group member,
  missing domains, membership removal, cross-tenant queries and lookup errors.
- Confirmations: direct API bypass, altered content/recipients, expired/forged
  tokens, changed policy, simultaneous reasons and numeric-score non-retention.
- Settings: CCO/admin authorization, tenant isolation, version conflict,
  atomic audit and no unapproved production initialization.
- Retention: no draft/body/hash/reasons/rewrites stored for withdrawn mail;
  cost policy as explicitly agreed; autosave cancellation; sent evidence;
  provider error/ambiguous receipt; historical audit/hold preservation.
- UI: Workbench states, focus management, keyboard access and warning accessibility.
- Run focused failing-test → implementation → passing-test checks per slice,
  then appropriate lint/typecheck/full tests/build, isolated database integration
  and hermetic E2E. Independent review before PR handoff; Rob merges/applies
  migrations. No application tests were run for this design-only preparation.

## Review boundary

Marcelo approved this written design on September 21, 2026. This approval
permits implementation planning; the explicitly unresolved retention and risk
configuration questions below remain open for their dependent slices.

The product choices are already authorized. This proposed design makes the
engineering interpretation reviewable; it does not claim code implementation,
approved numeric thresholds, a resolved broader group or resolved retention
exceptions. The next workflow gate is review of the written implementation plan and selection
of execution method.
