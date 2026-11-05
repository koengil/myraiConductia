# External Recipient Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Storm Q3 A and Conductia #171: warn on external To/CC/BCC recipients without requiring confirmation solely for leaving the firm, and retain the classification on sent mail.

**Architecture:** An authenticated endpoint returns only the signed-in sender’s verified-domain policy. A shared pure classifier provides immediate composer feedback and server-side classification. The outbox independently obtains the same authoritative policy before sending and stores a nullable classification in the existing message record. No working-group membership is inferred or changed.

**Tech Stack:** Next.js 16, React 19, strict TypeScript, Supabase/PostgreSQL, Vitest, Playwright, Node >=22.12.0.

**Spec:** [Approved Storm email policy design](../specs/2026-09-21-storm-email-policy-design.md), section 1 (external warning), Q3 ledger and #171. This is the second independent implementation plan. Written plan approved by Marcelo on September 21; preserve the previously selected inline execution method with independent final review.

## Global Constraints

- Q3 says warning and send; external status alone must never require another confirmation.
- Do not import invitation confirmation behavior into email sending.
- Use the signed-in sender’s organization, never the recipient’s company or the deal’s bank as a substitute. Do not accept a client-supplied organization ID.
- Verified domains come from `company_verified_domains`; never infer them from email addresses. Domain configuration management (#157) is separate.
- Empty verified domains means unverified, not internal and not proven external.
- Preserve tenant isolation, access gates, Risk Patcher and numeric-score non-retention.
- Team/working-group authority (#172) and retention Q1/Q7 are separate work.
- Keep platform APIs beside the typed M&A content seam; preserve Workbench and the single compliance instrument.
- Read required project docs and the approved spec before code. Use an isolated `codex/` worktree; no changes on main.
- Prefix node/npm/npx with `NODE_OPTIONS=`; never run concurrent Vitest processes.
- No production secret/account changes, no migration execution on shared databases. Rob handles merge and environment migrations.

## Baseline and integration

Verified September 21: #171 is open, without comments; develop is
`e1d97376e9ef8a10343ca6f64c4fe0204813ba55`. #191 is open with all checks green,
head `c30f93d30341007ee12ee2d8025e88ff0896e5ad`; it is not merged.

Implement on a separate branch from refreshed develop. Keep #171 independent:
do not copy the entire #191 branch or mix its commits into this PR. Record that
both edit the mail route/composer; before handoff, verify composition against
#191 in an isolated integration check or rebase if Rob has merged it. Never
remove Confidential behavior when resolving eventual conflicts.

## Review Focus

1. BCC-only external recipient and mixed lists: warning and stored external flag must include every address field (both tasks).
2. Suffix lookalikes and subdomains: `bank.example.evil.test` is external; `dept.bank.example` follows the existing verified-domain boundary rule (Task 1).
3. Missing domains versus failed lookup: unverified may send; database failure cannot be misrepresented as a reliable classification (both tasks).
4. Client forgery and cross-tenant organizations: request values cannot choose domains or stored flags (Task 1).
5. Editing recipients and late policy responses: removing the last outsider clears the warning immediately; no stale internal assertion before policy arrives (Task 2).

## File responsibilities and contracts

| File | Responsibility |
| --- | --- |
| `src/lib/mail/recipientBoundary.ts` (new) | Browser-safe address/domain normalization and pure classification |
| `src/lib/api/v1/mailDomainPolicy.ts` (new) | Authenticated sender organization lookup and tenant-scoped verified domains |
| `src/app/api/v1/mail-domain-policy/route.ts` (new) | GET sender policy; mail flag/auth gates, no persistence or company-ID input |
| `src/app/api/v1/outbox/route.ts` | Authoritative send-time classification, insertion and API serialization |
| `src/components/mail/MailComposer.tsx` | Immediate warning from current To/CC/BCC and loaded policy |
| `src/components/mail/MailClient.tsx` | Sent-record boundary marker; historical null remains unknown |
| `supabase/migrations/20260921160000_outbound_recipient_boundary.sql` (new) | Nullable historical-compatible classification column |
| `tests/mail-recipient-boundary.test.ts` (new) | Classification, IDNA and spoofing cases |
| `tests/api-v1-mail-domain-policy.test.ts` (new) | Server identity/tenant/error contract |
| `tests/api-v1-outbox.test.ts` | Client forgery, stored marker, all recipient fields, one-click send |
| `tests/mail-composer.test.tsx`, `tests/mail-client.test.tsx` | UI warning transitions and record marker |
| `supabase/tests/outbound_recipient_boundary.sql` (new) | Column constraint and legacy compatibility in isolated database |

Use these interfaces consistently:

```ts
export type RecipientBoundary = 'internal' | 'external' | 'unverified';
export type MailDomainPolicy = { verifiedDomains: string[] };
export function recipientBoundary(
  recipients: readonly string[],
  verifiedDomains: readonly string[],
): RecipientBoundary;
```

Recipient syntax validity remains the existing send validator’s responsibility.
The classifier must not assert internal for incomplete/malformed addresses;
return unverified when there is no proven outsider and some addresses cannot
be classified. Any proven outsider takes precedence over unverified entries.
An empty recipient list is unverified, but the UI shows no warning until input.

## Task 1: Authoritative policy and retained external marker

- [ ] Refresh branch/issues, create the isolated worktree, read architecture,
  API, data contracts, permissions and migration conventions, and run baseline tests.
- [ ] Write `tests/mail-recipient-boundary.test.ts` using literal expectations:

```ts
import { expect, it } from 'vitest';
import { recipientBoundary } from '@/lib/mail/recipientBoundary';

it.each([
  [['a@bank.example'], ['bank.example'], 'internal'],
  [['a@dept.bank.example'], ['bank.example'], 'internal'],
  [['a@bank.example.evil.test'], ['bank.example'], 'external'],
  [['a@BANK.EXAMPLE', 'b@outside.test'], ['bank.example'], 'external'],
  [['a@bank.example'], [], 'unverified'],
  [['unfinished@'], ['bank.example'], 'unverified'],
] as const)('classifies %j with %j', (emails, domains, expected) => {
  expect(recipientBoundary(emails, domains)).toBe(expected);
});
```

- [ ] Run `NODE_OPTIONS= npx vitest run tests/mail-recipient-boundary.test.ts`
  and observe the expected missing implementation failure.
- [ ] Implement browser-safe normalization with the URL parser for ASCII/IDNA
  hostnames; reject URL syntax such as slash, port, credentials or fragments
  in the email domain. Mirror the existing invite-domain syntax rules and
  exact-or-dot-suffix boundary. Do not import `node:url` into client code.
  Extend the tests with Unicode/punycode pairs, whitespace, invalid delimiters
  and suffix lookalikes before implementing those branches.
- [ ] Add server tests using the existing authenticated-route mock patterns:
  signed-in user company A sees only domains for company A and their tenant;
  a supplied company B query is rejected or ignored; external/no-company users
  do not inherit the deal bank’s domains; query errors return 500; auth and
  `mail_channel` flag failures preserve existing 401/403/404 behavior.
- [ ] Run the new route tests red. Implement a shared server policy loader
  using user profile `company_id, tenant_id`, validate company/tenant identity,
  then read `company_verified_domains` with both IDs. Missing company or zero
  domains yields an empty domain list; any database error is explicit.
  GET exposes `{ verifiedDomains }` with private no-store caching, never a
  cross-company directory or mutation capability.
- [ ] Add a nullable column without a default/backfill:

```sql
alter table outbound_messages
  add column if not exists recipient_boundary text;
alter table outbound_messages
  add constraint outbound_messages_recipient_boundary_check
  check (recipient_boundary in ('internal', 'external', 'unverified'));
```

  Follow repository re-runnable migration conventions by checking for the
  constraint or dropping/recreating it safely. Historical rows stay NULL.
  The SQL verification transaction must accept NULL and all three values,
  reject an invalid value and roll back its own synthetic fixtures.
- [ ] Add failing outbox tests for external recipients in each of To/CC/BCC,
  mixed recipients, internal-only, unverified configuration, forged posted
  boundary/company, and policy lookup failure before transport. Assert a
  compliant external email still sends on the first request with no new modal
  token/confirmation response and no provider call on a database lookup error.
- [ ] Derive the boundary independently from all three validated recipient
  lists and the server-loaded policy. Persist it when the normal record-first
  committed send path inserts `outbound_messages`; do not persist anything
  new when Risk Patcher returns findings. Add `recipient_boundary` to row
  selection/type and serialize `recipientBoundary` in POST/GET responses.
  Leave old held-message review semantics intact and historical NULL unclassified.
- [ ] Run focused classifier, policy route, outbox and existing invite-domain
  tests together. Document schema/API changes and the required migration.
  Commit with `feat(mail): classify outbound recipient boundaries`.

## Task 2: Immediate warning and sent-record indicator

- [ ] Add failing composer tests with server-policy responses and realistic
  screening responses. Internal-only drafts show no boundary warning. Adding
  an outside address to any field shows “External recipient” with red semantic
  styling; removing the last outside address clears it without a network call.
  Ordinary external sending remains one click.
- [ ] Test missing domains, loading, network/server failure, retry and late
  responses after unmount. Show “Recipient boundary unverified” rather than
  falsely claiming external or internal. This advisory UI adds no confirmation;
  send-time server lookup remains authoritative and may report an infrastructure
  failure through the existing error flow.
- [ ] Load the sender policy on composer mount using AbortController and a
  stale-response guard. Derive classification from current parsed To/CC/BCC
  on every edit, with no per-keystroke server writes or AI calls. Display a
  Workbench warning region with accessible text and retry for policy failure.
  Do not mount a second compliance instrument or add company configuration UI.
- [ ] Add sent-record tests: external marker is visible on external records,
  internal state is represented accurately, unverified is explicit, and legacy
  NULL never appears as internal. Extend the existing outbox message type with
  `recipientBoundary?: RecipientBoundary | null` and render semantic markers.
- [ ] Run focused UI/server suites and TypeScript, then full tests, lint,
  build and dependency audit. Run isolated SQL/integration and hermetic E2E
  through CI when local Docker is unavailable. Browser-check actual component
  and styles with synthetic internal/external/unverified data and keyboard focus.
- [ ] Update API/compliance living docs and the sourced decision log. Name
  `20260921160000_outbound_recipient_boundary.sql` explicitly in the PR and
  require Rob’s normal migration deployment sequence. No historical backfill.
- [ ] Obtain an independent whole-branch review, fix material findings with
  regression tests, open the focused PR targeting develop, and verify checks.
  Do not merge. Preserve #191 behavior in any integration/rebase resolution.

## Self-review and execution ledger

- [x] Scope matches Q3/#171 and does not depend on the unanswered Q4 group model.
- [x] All five review-focus cases have owning tests.
- [x] Type/signature and persistence/API names are consistent across tasks.
- [x] Unknown configuration is distinct from external; client values are not trusted.
- [x] Written plan reviewed by Marcelo (inline method already selected).
- [ ] Task 1 red/green, migration proof and commit recorded.
- [ ] Task 2 red/green, browser/CI results and independent review recorded.

## Execution evidence (September 21)

- Inline implementation approved by Marcelo; isolated branch `codex/171-external-recipient`.
- Task 1: missing-module/behavior failures observed, then 61 server tests passed.
- Task 2: missing-warning failures observed, then 61 focused UI tests passed,
  including delayed policy response, abort on unmount and all saved marker states.
- Full regression suite: 1,875 passed / 9 skipped before the final two asynchronous
  lifecycle tests; those passed in the focused rerun. TypeScript and build passed.
  Lint: zero errors, 32 existing warnings. Production dependency audit: zero vulnerabilities.
- Actual composer browser checks passed at 1280px and 390px: external warning,
  immediate removal, BCC-only outsider, unverified configuration and visible focus.
- Independent whole-change review: no material findings (static review).
- Local Docker daemon is unavailable. SQL constraint proof is wired into isolated
  CI integration; database/integration and hermetic E2E results are pending CI.
- Implementation uses a focused `RecipientBoundaryWarning` component rather than
  adding policy loading logic to the composer. Both tasks ship in one focused commit.
- No production migration, merge, issue closure or delivery claim has been made.
