---
run_id: onboarding
type: review
status: changes_requested
round: 1
source: prr-124.md
---

# Review: PR #124

PR: `FutureProofingDev/intelibank#124`, `duo/onboarding` → `develop`  
Reviewed head: `2c2eb75b0d0967839a18a9c021a0d4133d64acc9`  
Frozen requirements: `spec-v3.md` and approved `plan-v5.md`

## 1. Frozen-spec and approved-plan coverage

The implementation covers the principal invite, Working Group, Data Room, phase, feature-flag, storage, and demo surfaces. The flag-on document handlers apply `userCanSeeDocument` to list, view, and download, and `userCanUploadDocument` restricts external writes; the predicate denies external Internal-room and class-4 MNPI documents before phase evaluation. The global pending-email index, scoped invite-management predicates, session-bound acceptance RPC, room-aware storage seam, monotonic phase controls, and flag-off branches also match the approved design.

1.1 **Acceptance criterion 3 is incomplete: render the inviter, company, and optional deal codename on the acceptance page.** `spec-v3.md:117-118` requires all three. `src/app/accept-invite/page.client.tsx:39-73,121-193` reads only auth-user metadata and renders the invitee email plus name/password fields; it never fetches or displays inviter, company, or deal context. Add a flag-gated, scope-safe invite-context read (or equivalently trusted context) and page tests for deal and company-only invitations, revoked links, and expired links.

1.2 **Acceptance criterion 11 is broken by an external-route redirect cycle.** A single-membership external user is sent to `/projects/{dealId}`, whose page unconditionally redirects to `/rail` (`src/app/(authed)/projects/[projectId]/page.tsx:16-23`). The external destination set explicitly rejects `rail` (`src/lib/perspective/access.ts:54-61,71-83`), so `AppShell` redirects that URL back to `/projects/{dealId}` (`src/components/shell/AppShell.tsx:86-93`), repeating the cycle instead of showing the required Deal surface. Provide a real external Deal destination and cover single-membership landing plus direct navigation in a routing test.

1.3 **Implement and prove the approved resend link flow for an already-created invited auth identity.** `plan-v5.md:126-131` deliberately requires resend to use a link type appropriate to the pre-existing invited identity. `src/lib/api/v1/inviteDelivery.ts:27-42` hard-codes `type: 'invite'`, and the resend handler calls the same helper after rotating the nonce (`src/app/api/v1/invites/[inviteId]/resend/route.ts:39-66`); current invite-route tests mock `deliverInvite` rather than exercising this provider interaction. Use the approved existing-identity link flow and add an integration test proving initial send, resend, old-link rejection, and new-link redemption.

## 2. Authorization, identity containment, and document security

The server-side document predicate is correctly fail-closed for the central requirement: external actors cannot retrieve Internal-room or classification-4 documents, regardless of phase, and direct-ID handlers check deal/document coherence. External directors are restricted to their own company on deals where that company is a party; out-of-scope duplicate invites do not disclose invite IDs. These are sound and should remain unchanged.

2.1 **Abort delivery unless the server-owned pre-accept containment transition is proven successful.** Approved `plan-v5.md:147-164` requires step 3b to update the mirrored user to `status='invited'` and explicitly says a 3b failure aborts before Resend. `src/lib/api/v1/inviteDelivery.ts:55-74` ignores the update result, does not require an auth user ID, and sends the credential even if the update errors or matches no user. Check both the update error and affected row, return `unsent` before email on failure, and add failure-injection tests proving an uncontained identity is never sent a credential.

## 3. Transactional integrity, audit, and failure recovery

Invite lifecycle writes and their invite/grant audit events are transactionally grouped in security-definer RPCs. Download and view audit before completing their user-facing operations, and storage-upload failure returns the required retryable HTTP 502.

3.1 **Make upload metadata plus `upload` audit atomic, with storage compensation on either failure.** Approved `plan-v5.md:220-226` specifies `bytes → row+audit transaction → compensating delete`. The upload handler inserts the document row first and then separately inserts the audit (`src/app/api/v1/deals/[dealId]/documents/route.ts:138-167`); when the audit fails, it returns 500 but leaves both the document row and storage object committed. Move row+audit into one transaction/RPC and delete the stored object if that transaction fails; add failure-injection coverage asserting no document, object, or unaudited partial state survives.

## 4. Deliberate deviations and scope control

The five declared deviations in `prr-124.md:16-22` are acceptable and do not independently block approval:

- Full camelCase serialization is confined to the flag-on document response and follows the filtered visibility set; flag-off output remains unchanged.
- The `external` sandbox fallback completes the typed perspective map while real identities still resolve through `/api/v1/me`; it should remain visibly sandbox-only.
- Widening the audit CHECK to the observed 18-action superset preserves legacy rows while adding the three required invite actions.
- The idempotent buyer-party demo seed is a bounded demo enabler for the approved real buyer flow; it does not add an acquirer-management product surface.
- The Gate 0 receipt reports partial invitation outcomes after mandate creation and therefore avoids falsely reporting partial delivery as complete.

No unrelated product feature was added. The two trailing-whitespace findings from `git diff --check` are limited to plan-review Markdown and are optional cleanup, not blockers.

## 5. Verification, checks, and verdict

Local targeted verification passed: 10 onboarding/security test files, 91 tests total. GitHub at head `2c2eb75` reports the main `Lint, typecheck, test, build` job successful and both Vercel checks successful. GitHub MCP reads returned repository-not-found for this installation, so the review used the GitHub-skill-authorized authenticated `gh` fallback after confirming the canonical remote, PR number, head, and base.

5.1 **Restore a green required dependency-audit check before approval.** `Dependency vulnerability audit` is failed on Actions run `30701336200` / job `91372755316`, leaving the PR `UNSTABLE`. The log reports high-severity PostCSS advisory `GHSA-r28c-9q8g-f849` and brace-expansion advisory `GHSA-mh99-v99m-4gvg`; the lockfile is unchanged from `develop`, so this appears pre-existing rather than introduced by this patch, but the current head is not merge-ready. Resolve or explicitly waive it through repository policy, then re-run the check.

**Verdict: changes requested.** Findings 1.1-1.3, 2.1, 3.1, and 5.1 must be resolved. No `PR APPROVED` comment was posted.
