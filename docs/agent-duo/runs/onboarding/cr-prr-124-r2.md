---
run_id: onboarding
type: review
status: changes_requested
round: 2
source: prr-124.md
---

# Review: PR #124, round 2

PR: `FutureProofingDev/intelibank#124`, `duo/onboarding` → `develop`  
Reviewed range: `2c2eb75b0d0967839a18a9c021a0d4133d64acc9..2b8de9cd920f6affd711f7e4a559c83f6687ed15`  
Frozen requirements: `spec-v3.md` and approved `plan-v5.md`

## 1. Frozen-spec and approved-plan coverage

Only the round-two range and the six round-one findings were re-reviewed. Finding 1.2 is resolved: the changed project-root page now renders a membership-checked external Deal home while preserving the internal and flag-off `/rail` redirect, and the new routing tests cover the single-membership landing. Finding 1.3 is resolved for the normal resend path: the delivery helper now falls back from a fresh `invite` link to a nonce-rotated `magiclink` for a still-invited, unprovisioned existing identity, with provider-interaction tests.

1.1 **The new invite-context read is not scope-safe, so round-one finding 1.1 remains open.** `spec-v3.md:117-118` requires the accept page to show inviter, company, and optional deal codename, and the changed client does render those fields when its request succeeds. But `src/app/api/v1/invites/context/route.ts:19-35` accepts any authenticated user, takes `invite_id` solely from client-mutable `user_metadata`, and uses the admin client to fetch that invite without binding it to the authenticated email, tenant, current credential nonce, or invited profile. The same accept client demonstrates that user metadata can be changed through `auth.updateUser` (`src/app/accept-invite/page.client.tsx:117-120`), and no route-level authorization test covers this endpoint. Bind the invite to authoritative authenticated identity and current invite credential/scope before returning context, add cross-account/cross-tenant tests, and fail to a dead-end rather than the bare acceptance form when trusted context cannot be established (`tests/accept-invite-page.test.tsx:95` currently expects silent degradation).

## 2. Authorization, identity containment, and document security

The changed delivery helper now proves that the fresh identity has exactly one unprovisioned mirror row updated to `invited` before Resend; update errors, missing auth IDs, and zero-row results abort before credential delivery. The previously approved server-side document predicate and direct-ID handlers are unchanged and continue to deny external users every Internal-room and classification-4 MNPI document regardless of phase.

2.1 **Containment failure is fail-closed but not retryable as the approved plan requires, so round-one finding 2.1 is only partially resolved.** `plan-v5.md:155-164` says a step-3b failure leaves `pending/unsent` and recovery is the resend endpoint, which must re-assert containment. In the changed code, a fresh `generateLink({type:'invite'})` can create an auth identity and active/unprovisioned mirror before the guarded update fails (`src/lib/api/v1/inviteDelivery.ts:78-96`). On resend, the provider reports the existing identity, but `deliverToExistingIdentity` rejects any mirror whose status is not already `invited` as `active_account_no_credential` (`src/lib/api/v1/inviteDelivery.ts:145-153`), leaving that pending invite permanently unrecoverable. Preserve the no-credential fail-closed rule while adding an ownership- and scope-proven recovery transition for the exact pending invite, plus a test covering initial containment failure followed by successful resend; never weaken the active/provisioned-account denial.

## 3. Transactional integrity, audit, and failure recovery

Round-one finding 3.1 is resolved. The changed document upload route stores bytes, calls `create_document_with_audit`, and removes the stored object when that transaction fails; `20260801120000_document_upload_rpc.sql` atomically creates the document and attributed `upload` audit and grants execution only to `service_role`. The changed failure-injection test confirms storage compensation, so no unaudited document row or orphaned object survives the reviewed failure path.

## 4. Deliberate deviations and scope control

The round-two commit is confined to the six requested fixes, their schema/package support, API documentation, and targeted tests. The five deliberate deviations accepted in round one are unchanged and remain nonblocking. Package overrides are bounded to the dependency-audit repair, the document RPC is a surgical transactional correction, and the external Deal home and accept-context surface do not introduce a new product destination. `git diff --check 2c2eb75..2b8de9c` reports only two trailing-whitespace lines in the copied historical round-one review Markdown; optional cleanup only.

## 5. Verification, checks, and verdict

At reviewed head `2b8de9cd920f6affd711f7e4a559c83f6687ed15`, GitHub reports PR #124 open, non-draft, mergeable, and `CLEAN`; main CI, dependency audit, Vercel, and preview-comment checks all pass. Local changed-area verification passed five files / 33 tests, and both `npm audit --omit=dev --audit-level=moderate` and full `npm audit --audit-level=moderate` report zero vulnerabilities. GitHub connector reads still return repository-not-found for this installation, so the review used the GitHub-skill-authorized authenticated `gh` fallback after verifying canonical repo, PR, head, and base.

Round-one finding 5.1 is resolved by the green required audit and zero-vulnerability local checks. Findings 1.2, 1.3, 3.1, and 5.1 are resolved; findings 1.1 and 2.1 remain actionable on changed material.

**Verdict: changes requested.** No `PR APPROVED` comment was posted.
