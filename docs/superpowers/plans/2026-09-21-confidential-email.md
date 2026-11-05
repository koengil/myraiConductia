# Automatic Confidential Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark live-deal and pitch email Confidential in the composer, screening, transport and sent record, implementing Storm Q2 and Conductia #170.

**Architecture:** A shared pure subject transformation is driven by authoritative deal lifecycle. The composer previews the transformation using the existing authenticated deal-detail endpoint; the outbox independently reads lifecycle and transforms the subject before screening and storage. The subject itself is the retained marking, so this slice needs no schema migration.

**Tech Stack:** Next.js 16, React 19, strict TypeScript, Supabase, Vitest and Testing Library. Node >=22.12.0.

**Spec:** [Approved Storm policy design](../specs/2026-09-21-storm-email-policy-design.md), section 1 and delivery sequence item 1. Design approved September 21, 2026. Plan approved by Marcelo; executed inline with independent review.

## Global Constraints

- Build from freshly verified `origin/develop` in an isolated `codex/` branch. Preserve the main checkout and its untracked files.
- Product AI agents propose; humans and deterministic code own gates and authorization.
- Platform persistence stays under `/api/v1`, beside the M&A content seam.
- Project identity comes from the project URL, not session state.
- Use Workbench components/tokens, accessible status messages and existing single compliance instrument.
- Never infer trust, lifecycle or permission from client claims.
- Numeric message risk remains ephemeral. This slice does not change retention or Risk Patcher behavior.
- Prefix node/npm/npx with `NODE_OPTIONS=`; never run concurrent Vitest processes.
- No production secrets/accounts or shared-database test setup. Test records use `ZZ TEST`.
- Rob handles merges and manual migrations. Independently review before PR handoff; ignore minor/style findings.
- Update living API/compliance docs with the change; preserve historical sources.

## Review Focus

1. Lifecycle changes after preview: send-time lookup remains authoritative (Task 1).
2. Existing labels and forwarded/reopened subjects: never double-prefix a leading label or strip user-authored content (Tasks 1/2).
3. Subject length: adding the label cannot bypass the existing 1,000-character maximum or truncate text silently (Tasks 1/2).
4. Slow or failed preview lookup: no stale result from another project, no silent “not Confidential” on a server/access error (Task 2).
5. Risk Patcher replay: subject hashing uses the actual transformed subject and changing lifecycle cannot reuse an incompatible screen token (Task 1).

## Scope coverage and later slices

This plan produces a complete Q2 slice, not completion of all seven answers.
Q3/Q4 (#171/#172), Q5/Q6 (#94/#95), and Q1/Q7 retention require separate plans
against the approved umbrella design. Do not mark those requirements complete
or infer approval of unspecified risk thresholds or accounting exceptions.

The Q2 representation proposed in the approved design is `[Confidential]` in the
subject. A manually entered leading label remains unchanged on all lifecycle
categories; automatic marking applies only to `live` and `pitch`. Follow the
authoritative `lifecycle_category`, not the older `status` field. Missing or
invalid lifecycle on a resolved deal fails explicitly instead of guessing.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `src/lib/mail/confidential.ts` (new) | Pure lifecycle predicate and idempotent subject transformation |
| `src/app/api/v1/outbox/route.ts` | Authorized lifecycle lookup and final subject before screening/token/storage/transport |
| `src/components/mail/MailComposer.tsx` | Authenticated lifecycle preview, loading/error/retry state and visible final subject |
| `tests/mail-confidential.test.ts` (new) | Transformation/category cases |
| `tests/api-v1-outbox.test.ts` | Authoritative server behavior and Risk Patcher regression |
| `tests/mail-composer.test.tsx` | Preview, editing, lookup races/failures and final send payload |
| `docs/03-engineering/api-v1.md` | Outbox automatic marking and failure behavior |
| `docs/03-engineering/compliance-rules.md` | Current marking addendum, without restoring historical hold routing |
| `docs/07-decisions/decision-log.md` | Source-backed Q2 decision with next available ID, checked at execution |

## Task 1: Enforce Confidential on the actual server send

**Interfaces:** Create `requiresConfidential(category: LifecycleCategory): boolean`
and `confidentialSubject(subject: string, required: boolean): string` in the
pure module. The route consumes these after its existing authorization check.
The same final subject must reach screening, token digest, outbox insert and
both transport choices. API request shape remains compatible.

- [ ] Read the project router and current memory, then the approved spec. Load
  the worktree and TDD skills at execution; read applicable architecture,
  contracts, permissions and Workbench docs before code changes.
- [ ] Refresh develop and issue #170, create isolated `codex/170-confidential-email`,
  and record base SHA in this ledger. Keep the approved spec/plan accessible in
  the worktree without copying environment files or unrelated local changes.
- [ ] Add `tests/mail-confidential.test.ts` with this executable core:

```ts
import { describe, expect, it } from 'vitest';
import { LIFECYCLE_CATEGORIES } from '@/lib/constants/deals';
import { confidentialSubject, requiresConfidential } from '@/lib/mail/confidential';

describe('Confidential subject', () => {
  it.each(LIFECYCLE_CATEGORIES)('uses lifecycle %s', (category) => {
    expect(requiresConfidential(category)).toBe(['live', 'pitch'].includes(category));
  });
  it('marks once and preserves a manual label', () => {
    expect(confidentialSubject('Process update', true)).toBe('[Confidential] Process update');
    expect(confidentialSubject('[Confidential] Process update', true)).toBe('[Confidential] Process update');
    expect(confidentialSubject('[confidential] Process update', false)).toBe('[confidential] Process update');
    expect(confidentialSubject('Re: Process update', true)).toBe('[Confidential] Re: Process update');
  });
});
```

- [ ] Run `NODE_OPTIONS= npx vitest run tests/mail-confidential.test.ts` and
  confirm the intended missing-module failure.
- [ ] Implement the pure module with the existing `LifecycleCategory` type:

```ts
import type { LifecycleCategory } from '@/lib/constants/deals';
export function requiresConfidential(category: LifecycleCategory): boolean {
  return category === 'live' || category === 'pitch';
}
export function confidentialSubject(subject: string, required: boolean): string {
  if (!required || /^\[confidential\](?:\s|$)/i.test(subject)) return subject;
  return `[Confidential] ${subject}`;
}
```

- [ ] Extend existing outbox test fixtures to supply `lifecycle_category` for
  resolved deals. Use the existing `makeAdmin`, `signedIn`, `post`,
  `compliantDraft` and `sendMock` helpers. Add parameterized tests for all seven
  categories. Assert both actual provider input and inserted subject:

```ts
expect(sendMock.mock.calls[0][0].subject).toBe('[Confidential] Process update');
expect(inserts.find((entry) => entry.table === 'outbound_messages')?.payload.subject)
  .toBe('[Confidential] Process update');
```

- [ ] Add route regressions: a forged client category cannot suppress marking;
  unauthorized deal never reaches transport; database errors/missing lifecycle
  return errors without sending; untagged mail keeps the existing subject;
  a subject exceeding 1,000 after prefix returns 400; a risk token minted before
  a lifecycle-driven subject change cannot authorize the changed subject.
  Assert existing manual labels remain in closed/lost messages too.
- [ ] Run `NODE_OPTIONS= npx vitest run tests/api-v1-outbox.test.ts` and verify
  new assertions fail on behavior rather than broken mocks.
- [ ] After resolving/authorizing the real deal ID, query
  `deals.select('lifecycle_category').eq('id', dealId).maybeSingle()` and check
  error, missing row and membership in `LIFECYCLE_CATEGORIES`. Return explicit
  500/404 errors on failure; never continue with an assumed category. Untagged
  legacy/sandbox sends retain the existing lenient resolution behavior.
- [ ] Retain a validated `rawSubject`, derive the final `subject` before
  `screenedFields`, and reject a final subject longer than `MAX_SUBJECT`.
  Do not trust a posted lifecycle or confidentiality boolean. Route all
  downstream uses through this final value; no unscreened subject alteration
  may happen after token construction.
- [ ] Run `NODE_OPTIONS= npx vitest run tests/mail-confidential.test.ts tests/api-v1-outbox.test.ts tests/screen-token.test.ts`.
- [ ] Record outcome and commit only the focused server change with a
  conventional subject: `feat(mail): enforce Confidential on live deal email`.

## Task 2: Preview the final subject in the composer

**Interfaces:** Existing `GET /api/v1/deals/{dealRef}` returns
`{ deal: { lifecycleCategory: LifecycleCategory } }`. `MailComposer` continues
accepting `dealRef`; its draft subject remains user-authored. Derived final
subject uses Task 1’s `confidentialSubject`, but server enforcement remains
independent. No new API endpoint or database migration is required.

- [ ] Extend `stubFetch` in `tests/mail-composer.test.tsx` to recognize the
  existing deal-detail URL without swallowing screen/outbox calls. Default
  tests without a `dealRef` remain untagged. Add delayed response controls.
- [ ] Add failing UI cases for live/pitch visible `[Confidential]` preview,
  all other categories without automatic marking, seeded/manual labels,
  subject editing, effective maximum length and one-click ordinary Send.
  Assertions target the visible final subject and the existing outbox payload:

```ts
expect(screen.getByLabelText('Email subject preview')).toHaveTextContent('[Confidential] Process update');
expect(calls.find((call) => call.url === '/api/v1/outbox')?.body.subject)
  .toBe('[Confidential] Process update');
```

- [ ] Add delayed-lookup tests: switching from deal A to B cannot apply A’s
  late result; loading/error prevents Send with a readable explanation;
  retry loads a fresh result; discard remains usable. An explicit deal-detail
  404 is shown as an untagged context under existing lenient sandbox behavior,
  while 401/403/network/500 must never downgrade to untagged.
- [ ] Run `NODE_OPTIONS= npx vitest run tests/mail-composer.test.tsx` and check
  failures correspond to absent policy preview behavior.
- [ ] Add lifecycle lookup state keyed by `dealRef`, use `AbortController` and
  an effect cleanup guard, and validate the response category against existing
  constants. Fetch `/api/v1/deals/${encodeURIComponent(dealRef)}`. On a context
  change clear the prior result immediately. Provide explicit retry on error.
- [ ] Derive `effectiveSubject` from raw subject and loaded category. Display
  it in a Workbench-styled element with `aria-label="Email subject preview"`.
  Keep the editable/raw subject separate so reopening or switching lifecycle
  does not permanently bake an automatic prefix into a saved draft.
- [ ] Use effective subject consistently for advisory screening and outbox
  submission; include it and readiness state in callback dependencies. Require
  nonempty raw subject and valid effective length in `canSend` and `doSend`.
  Do not use the prefix alone to turn an empty subject into a sendable message.
- [ ] Update outbox/compliance docs and append the sourced Q2 decision, naming
  the approved subject-prefix representation. Do not claim Q1/Q3–Q7 delivery.
- [ ] Run `NODE_OPTIONS= npx vitest run tests/mail-composer.test.tsx tests/mail-client.test.tsx tests/api-v1-outbox.test.ts tests/mail-confidential.test.ts tests/screen-token.test.ts`.
- [ ] Run lint, TypeScript, full tests and build sequentially using `NODE_OPTIONS=`.
  Inspect CI/E2E configuration and run relevant isolated hermetic checks if the
  environment is available. Record any unavailable checks instead of claiming
  they passed. Never connect tests to a shared/production database.
- [ ] Verify composer layout, focus, retry and preview in a browser using
  synthetic data. Have an independent reviewer inspect the whole branch and
  fix material findings. No code-review skill, per project agreement.
- [ ] Commit the UI/docs change with `feat(mail): preview automatic Confidential marking`.
  Prepare the PR targeting develop, state “No migrations”, report exact checks
  and scope, attach the PR artifact if created. Do not merge or close the issue
  before the documented delivery bar is met.

## Plan self-review

- Q2 coverage: authoritative category, preview, screen, token, actual transport
  and retained subject are assigned above; legacy held rows remain historical.
- All five review-focus cases have regression tasks. No risk threshold or
  retention interpretation is introduced by this first slice.
- Module/function names are consistent across both tasks. Existing fixture
  helpers are named explicitly; integration tests must use their real current
  signatures when extending fixtures.
- Q1/Q3–Q7 remain tracked in the approved umbrella spec and current-state memory.
  Their unresolved decisions do not block this isolated Q2 implementation.

## Execution ledger

- [x] Umbrella design approved by Marcelo.
- [x] First-slice implementation plan prepared and self-reviewed.
- [x] Plan reviewed; execution method selected.
- [x] Task 1 implemented and verified.
- [x] Task 2 implemented and verified.
- [x] Independent review and handoff completed: [PR #191](https://github.com/Conductia/Conductia/pull/191), remote CI pending.


### September 21 execution evidence

Base: `e1d97376e9ef8a10343ca6f64c4fe0204813ba55`; branch
`codex/170-confidential-email`. Both implementation tasks are complete locally.
Baseline: 1,834 tests passed. New server failures were observed before the fix;
67 focused server/helper/token tests then passed. UI behavior failures were
observed before implementation; integrated focused run passed 127 tests.

Independent review found one material A→B→A navigation race. The new regression
failed before the fix and passed afterward; composer suite: 41 passing tests.
Final full suite: 1,873 passed, 9 skipped. TypeScript passed. Lint: zero errors,
32 pre-existing warnings. Production build passed after replacing an external
node_modules symlink with a worktree-local copy (Turbopack rejects that symlink).

Browser verification used the actual composer and stylesheet with synthetic
fetch responses in Chrome at 1280×900 and 390×844: correct Confidential preview,
Send enabled after lookup, no mobile document overflow. This was a component
check, not production verification. Docker daemon is unavailable locally;
Supabase integration and hermetic E2E require CI. No migration, secrets or
production account changes. No merge performed.

Ruling: the existing scoped-send tests now await the approved lifecycle lookup
and supply deal-detail fixtures. Sending while that lookup is pending is
intentionally disabled. No product-scope deviation or deferred minor finding.


CI follow-up: the first full E2E run passed 20 scenarios and failed MD spine
because `composeAndSendMail` still matched the unprefixed subject exactly.
Updated that journey to type the raw subject, assert the automatic Confidential
preview, and require the exact prefixed subject in the sent list/outbox. The
unit/type/lint/build, dependency audit and Supabase integration gates passed on
that run. This is a test-contract update, not a weakening to substring matching.
