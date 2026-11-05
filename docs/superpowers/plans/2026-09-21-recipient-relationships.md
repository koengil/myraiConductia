# Deal-relative Recipient Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement inline, task-by-task. Preserve independent final review. Steps use checkbox syntax.

**Goal:** Deliver relationship-aware #172 recipient review, maintained in Team,
with governed post-send onboarding for companies supported by the current invite contract.

**Architecture:** A deal-scoped affiliation register complements current membership
and invitation records. A shared server classifier supplies the preview and outbox;
signed, message-bound recipient approval composes with existing Risk Patcher.
Team remains the management surface. Do not treat this slice as completion of
new-advisor-company onboarding or close #172 automatically.

**Tech Stack:** Next.js 16, React 19, strict TypeScript, Supabase/PostgreSQL,
Vitest, Playwright, Node >=22.12.0.

**Spec:** [Deal-relative recipient safety design](../specs/2026-09-21-recipient-relationships-design.md).
Status: approved by Marcelo September 21; executing inline. Product hierarchy is
accepted; technical choices below are not attributed to Storm.

## Execution evidence

Implemented in [PR #194](https://github.com/Conductia/Conductia/pull/194), stacked
on #192 with current #191 code composed separately. Tasks 1–5 are implemented;
Task 6 CI verification and handoff are in progress. The original checklists below
remain the approved acceptance reference; this dated evidence states execution.

Local full suite: 2,004 passed /9 skipped; TypeScript, build and audit passed;
lint 0 errors /32 existing warnings. Chrome desktop/mobile composer verification
passed. Independent review findings were resolved with regressions. The expanded
hermetic journey covers send → Team invitation → subsequent counterparty approval.
Migration applied in initial CI; SQL fixture codename collision was corrected.
SQL/integration and final hermetic browser results must be checked before delivery.
No merge or production migration performed; unsupported advisor-company onboarding
and other Storm slices remain separate. Do not close #172 from this partial scope.

## Global constraints

- Follow AGENTS, D35/D46/D48 and the current delivery model; read current canonical
  docs/ADRs for mail, Team, invitations, permissions and Workbench before editing.
- Bank team, affiliation and access permission are distinct. No domain-based or
  AI-based promotion to trusted client/team. Counterparties always need approval.
- All To/CC/BCC participate; preserve their field when removing or binding them.
- Prefix node/npm/npx with NODE_OPTIONS=. Never run concurrent Vitest processes.
- No production credentials/accounts, database migrations or automatic merges.
  Rob applies named migrations. Synthetic data uses ZZ TEST.
- Keep unknown states explicit, information barriers intact, no numeric risk in
  persistent data/tokens, no recipient preflight persistence.
- Minimal access is member + phase 0, internal read_only where valid; external
  roles remain party-derived. No automatic director promotion or party invention.
- Inline implementation followed by independent English, courteous, material-only
  review. Do not invoke the code-review skill.

## Dependencies and scope boundary

Refresh develop/main and PR #191/#192 before execution. Current base e1d97376 is
not behind main. Prefer a feature branch from develop once both mail foundations
land. If they remain open, explicitly stack on #192, port only the required current
#191 mail changes in the isolated worktree, document both dependencies and keep
implementation commits separate for eventual rebasing. Do not merge either PR.
Reconcile current heads, not the earlier c30f93d3 combined-test snapshot.

Supported onboarding remains subject to existing company/party/director rules.
A new advisor firm that cannot be represented by those rules stays an explicit
setup blocker; the following plan does not bypass it or claim the whole issue is
done. A separate party/onboarding extension must be planned and tested before
#172 closure. Counterparty confirmation and client/advisor visual indicators do
not need to wait for that extension.

## Review focus

1. Advisor access role does not determine client/counterparty affiliation (Tasks 1–2).
2. Pending invite expiry/revocation or member removal removes a prior exemption (Tasks 1–3).
3. A changed BCC, attachment or affiliation invalidates approval even if subject stays unchanged (Task 3).
4. Recipient approval cannot become Risk Patcher approval, and unknown data cannot become trusted (Tasks 2–4).
5. A failed invitation or missing company director cannot produce a completed addition or elevated default (Tasks 1, 5).

## Task 1: Persistent affiliation and guarded Team management

**Files:** new `supabase/migrations/20260922100000_deal_recipient_affiliations.sql`,
`supabase/tests/deal_recipient_affiliations.sql`, `src/lib/constants/recipientAffiliations.ts`,
`src/lib/api/v1/recipientAffiliations.ts`,
`src/app/api/v1/deals/[dealId]/recipient-affiliations/route.ts`,
`tests/api-v1-recipient-affiliations.test.ts`; update relevant current invite RPC migration
through the new migration only, never rewrite an already applied migration.

**Interface:**
```ts
export type RecipientAffiliation =
  | 'client' | 'client_advisor' | 'counterparty' | 'counterparty_advisor';
export type AffiliationInput = {
  email: string; companyId: string; affiliation: RecipientAffiliation;
  representedCompanyId: string | null;
  userId: string | null; inviteId: string | null; expectedRevision: number | null;
};
// GET returns affiliations visible to the authorized bank-side deal manager.
// PUT accepts AffiliationInput for an existing eligible member/invitation only.
// Server derives actor, tenant and canonical deal ID; never accept client tenant.
```

- [ ] Refresh issue body/comments/milestone and dependency heads, create isolated
  codex/172-recipient-relationships worktree, read current documents and run baseline.
- [ ] Write failing API tests with existing mock-admin/auth patterns. Use literal
  expectations for inaccessible deal (403), cross-tenant references (403/404 without
  disclosing existence), external manager relabeling (403), malformed relationship
  (400), stale revision (409), failed authoritative lookup (503), valid update (200).
- [ ] Run `NODE_OPTIONS= npx vitest run tests/api-v1-recipient-affiliations.test.ts`;
  verify failures concern the missing route/behavior.
- [ ] Implement the four-value SQL enum/check and unique `(deal_id, normalized_email)`.
  Add tenant/deal/company/user/invite references and revision. Enforce advisor
  represented-party presence and non-advisor absence. Validate cross-table tenant,
  deal, company and normalized email matches in the transaction, not only UUID FKs.
  Normalize email using the existing invite normalization contract.
- [ ] Implement a service-only RPC that checks the actor's existing member-management
  authority and bank-side identity, locks the prior row, compares revision and writes
  affiliation plus administrative audit atomically. No anonymous/authenticated EXECUTE
  grant, no broad RLS select. The route uses authenticated actor identity and current
  `canManageDealMembersChecked`; unreadable authorization denies explicitly.
- [ ] Add SQL cases proving a cross-deal invite reference, cross-tenant company,
  advisor without represented party and invalid enum are rejected. Update of an
  existing row must increment revision; an audit failure must roll back the mutation.
  Run only against isolated migrated Supabase.
- [ ] Run API tests green; update data/API contracts and commit
  `feat(team): record explicit deal recipient affiliations`.

## Task 2: Authoritative recipient classification and advisory endpoint

**Files:** new `src/lib/mail/recipientReview.ts`, `src/lib/api/v1/recipientReview.ts`,
`src/app/api/v1/deals/[dealId]/recipient-check/route.ts`,
`tests/mail-recipient-review.test.ts`, `tests/api-v1-recipient-check.test.ts`.
Reuse the #171 organization-boundary classifier; do not change its saved enum.

**Interfaces:**
```ts
export type RecipientField = 'to' | 'cc' | 'bcc';
export type RecipientRelationship = 'bank_team' | 'client' | 'client_advisor'
  | 'counterparty' | 'counterparty_advisor' | 'unassociated' | 'unverified';
export type RecipientEntry = {
  field: RecipientField; email: string; relationship: RecipientRelationship;
  boundary: 'internal' | 'external' | 'unverified';
};
export type RecipientDecision = RecipientEntry & {
  requiresConfirmation: boolean;
  reason: 'counterparty' | 'not_on_deal' | 'relationship_unverified' | null;
};
export function reviewRecipients(entries: readonly RecipientEntry[]): RecipientDecision[];
// Server loadRecipientReview(admin, actorId, dealId, {to,cc,bcc}) returns
// {recipients: RecipientDecision[], policyFingerprint: string} or a typed
// forbidden/unavailable/invalid-input error. No client-provided affiliation.
```

- [ ] Add the pure table test before code:
```ts
it.each([
  ['bank_team', false], ['client', false], ['client_advisor', false],
  ['counterparty', true], ['counterparty_advisor', true],
  ['unassociated', true], ['unverified', true],
] as const)('%s has explicit confirmation=%s', (relationship, expected) => {
  expect(reviewRecipients([{field:'bcc', email:'zz-test@example.test',
    boundary:'external', relationship}])[0].requiresConfirmation).toBe(expected);
});
```
- [ ] Run `NODE_OPTIONS= npx vitest run tests/mail-recipient-review.test.ts` red,
  implement exhaustive deterministic classification, then run green.
- [ ] Write server tests for every recipient field, mixed lists, same-domain
  strangers, active bank member versus off-deal colleague, active/pending/revoked/
  expired invitations, removed members, changed company/email, missing affiliation
  and conflicting advisor representation. No fixture roster import is permitted.
- [ ] Load only current tenant/deal memberships, corresponding users, valid delivered pending invites or current accepted memberships,
  explicit affiliations and sender-company domains. An ordinary party employee is
  never trusted from company membership alone. Check all read errors and bound input
  counts to the existing outbox limits. Resolve matches deterministically; conflicting
  records yield unverified. Build fingerprint from sorted effective records and
  relevant current membership/invite state, not from unrelated roster mutations.
- [ ] Add authenticated mail-flag/deal-mail-access endpoint returning only submitted
  recipients and a fingerprint, private/no-store. Do not return an organization-wide
  contact list, write records or call AI. Test errors cannot become an empty trusted set.
- [ ] Run both suites green and commit `feat(mail): classify recipients by deal relationship`.

## Task 3: Message-bound recipient confirmation in outbox

**Files:** new `src/lib/compliance/recipientToken.ts`,
`tests/recipient-token.test.ts`; update `src/app/api/v1/outbox/route.ts`,
`tests/api-v1-outbox.test.ts` and API documentation.

**Interfaces:**
```ts
export type RecipientApprovalSubject = {
  actorId: string; tenantId: string; dealId: string;
  messageDigest: string; policyFingerprint: string;
};
export function mintRecipientToken(subject: RecipientApprovalSubject, now?: number): string;
export function verifyRecipientToken(token: unknown, subject: RecipientApprovalSubject,
  now?: number): boolean;
// POST accepts recipientApprovalToken?: string alongside existing risk fields.
// Review response: {recipientReviewRequired:{recipients, token}}; no message row.
```

- [ ] Write failing token tests: altered To/CC/BCC including field movement, actor,
  tenant, deal, effective Confidential subject, body/HTML, attachment bytes,
  fingerprint, tampered signature, malformed payload, future issue time, age >10min.
  Valid identical subject passes; no risk score/body/email plaintext appears in token.
- [ ] Run token suite red. Implement purpose-separated HMAC derived from the existing
  configured signing secret, strict payload parsing and timing-safe signature compare.
  Hash ordered JSON fields and attachment content identities, with normalized recipient
  lists kept separate by field. Fail key configuration before side effects.
- [ ] Add failing outbox tests for counterparty on roster requiring review, trusted
  client sending normally, unknown BCC requiring review, forged boolean ignored,
  changed affiliation invalidating a token and lookup failure causing no transport.
- [ ] After existing auth/deal checks and effective-subject transformation, re-load
  authoritative recipient state. Return HTTP 200 recipientReviewRequired when needed;
  no outbound insert, recipient audit, provider call or new screen call on that path.
  A valid recipient token permits continuing through existing screening, never sets
  sendAsIs or creates a risk override token.
- [ ] Test risk flow in both directions: recipient approval still returns riskIssues
  when required; risk approval without recipient approval still cannot send to an
  unapproved counterparty; unchanged valid tokens together send once through the normal
  committed-row/provider path. Repeat current authorization and recipient evaluation
  on every resubmit. Projectless sends preserve existing behavior without fake groups.
- [ ] Include recipient decisions and applicable policy revision in normal committed
  send evidence, not a separate abandoned-message history. Test cancel has no new
  recipient persistence. Preserve append-only audit, pending/error transport records,
  Confidential behavior and #171 saved boundary.
- [ ] Run token, classifier and outbox suites green; commit
  `feat(mail): enforce message-bound recipient approval`.

## Task 4: Composer recipient indicators and review dialog

**Files:** new `src/components/mail/RecipientReviewDialog.tsx`,
`src/components/mail/RecipientRelationshipList.tsx`,
`src/components/mail/useRecipientReview.ts`, `tests/recipient-review-dialog.test.tsx`;
update MailComposer and composer tests, using current Workbench components.

- [ ] Write failing UI tests for each relationship and To/CC/BCC field, including
  two recipients with different requirements. Assert accessible text in addition to
  color; counterparty warning remains after group membership. Confirm button is disabled
  while submitting. Removal changes only its original field and clears stale approval.
- [ ] Run focused UI tests red. Implement debounced advisory requests with abort and
  request identity protection; immediate edits invalidate approval. Loading/error is
  explicitly unverified; Retry repeats the current recipient snapshot. The server
  outbox response, not a cached advisory result, owns the approval requirement.
- [ ] Render client/advisor styling adjacent to the addresses, counterparty red copy
  and uppercase external non-deal warning with correct internal/unverified alternatives.
  Use one review dialog listing all applicable recipients and per-field Remove actions.
  Confirm resubmits the exact draft with the returned token; Cancel returns to editing.
  Preserve the single project compliance instrument.
- [ ] Test A→B→A edits, late response after unmount, changed attachments while review
  is open, keyboard escape/focus return, recipient-only versus content-risk review,
  invitation prompt only after successful transport response and retained BCC privacy.
- [ ] Run UI suites green, inspect actual desktop/mobile CSS and focus behavior with
  synthetic records, commit `feat(mail): show relationship-aware recipient review`.

## Task 5: Team affiliation editor and governed post-send addition

**Files:** update `src/components/team/LiveTeamRoster.tsx`,
`src/components/team/InviteModal.tsx`, `src/app/api/v1/invites/route.ts`, current
create/grant invite RPCs through the new migration, `src/lib/team/roster.ts` types;
new `src/components/team/RecipientAffiliationFields.tsx`; extend existing invite,
Team, phase and access tests plus new `tests/recipient-addition.test.tsx`.

- [ ] Write failing tests for manager-only edit, counterparty advisor requiring a
  represented party, version conflict and expired/revoked invite presentation.
  Ordinary senders and external directors cannot relabel to client via direct API.
- [ ] Implement Team-only editor backed by Task 1. Existing members lacking reliable
  affiliation display “Relationship needs review”; no silent batch backfill.
- [ ] Add invitation input fields `recipientAffiliation` and `representedCompanyId`;
  validate with the same permission rules as affiliation management. Integrate the
  write atomically with create_invite or existing-account membership grant. If the
  underlying invite/grant fails, no effective new affiliation is committed.
  Retain domain confirmation and the existing invitation verification lifecycle.
- [ ] Add failing invitation tests: default member/phase0/internal read_only, external
  party-derived seat, no director escalation, unauthorized grant, unknown advisor firm,
  duplicate existing account, delivery failure/resend, revoked invite and conflicting
  email/company identity. Assert company_requires_director leaves member selected.
- [ ] Prefill the governed Team form from the sent recipient context; explicitly pick
  affiliation/company/access and show perimeter. Block unsupported new advisor-company
  setup with accurate explanation, not fake party assignment or a contact-only fallback.
  Successful invitation appears pending until acceptance; failed delivery shows retry
  and cannot activate a new communications exemption.
- [ ] Run Team/invite/access tests green. Add a hermetic journey covering confirmed
  counterparty send, post-send eligible invitation, minimal default and subsequent
  counterparty confirmation. Commit `feat(team): link recipient additions to governed invitations`.

## Task 6: Verification and partial-scope handoff

- [ ] Reconcile decisions into the current decision log/ADR, API/data contracts and
  compliance docs; reserve a fresh decision number after checking current remote.
  Link Storm's source and explicitly supersede member-passes-silently acceptance.
- [ ] Run `NODE_OPTIONS= npm run lint`, `NODE_OPTIONS= npx tsc --noEmit`,
  `NODE_OPTIONS= npm test`, `NODE_OPTIONS= npm run build`, and
  `NODE_OPTIONS= npm audit --omit=dev --audit-level=moderate`. No concurrent Vitest.
- [ ] Run isolated SQL/integration and hermetic E2E; if Docker unavailable locally,
  require CI green. Test boundary/role constraints and transaction rollback in SQL,
  not only mocked handlers. No shared or production database setup.
- [ ] Independently review the whole branch, fix material findings with regression
  tests, refresh dependencies and test the combined current #191/#192 behavior.
- [ ] Open the appropriately based PR and attach it to the task. Name
  `20260922100000_deal_recipient_affiliations.sql`; Rob applies it before deployment.
  Describe new-advisor-company onboarding as unfinished, avoid `Closes #172`,
  update local memory with exact checks/head and leave merge/release to Rob.

## Plan review checklist

- [x] Counterparty membership never implies confirmation-free sending.
- [x] Advisor affiliation is independent of permissions and buyer/seller labels.
- [x] Signed review covers current message and effective affiliation state.
- [x] No new recipient preflight persistence; risk/retention slices stay separate.
- [x] Lowest default respects current first-director/party constraints.
- [x] Every review-focus failure has an owning task and explicit regression case.
- [x] New-advisor-company limitation is explicit; this plan cannot close all of #172.
- [x] Marcelo approved revised design and implementation plan before code execution.
