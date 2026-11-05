---
run_id: onboarding
type: review
status: changes_requested
round: 3
source: prr-124.md
---

# Review: PR #124, round 3

PR: `FutureProofingDev/intelibank#124`, `duo/onboarding` → `develop`
Reviewed range: `2b8de9cd920f6affd711f7e4a559c83f6687ed15..2d3574458c4da7717a94015f6448303e3efeb427`
Frozen requirements: `spec-v3.md` and approved `plan-v5.md`

## 1. Frozen-spec and approved-plan coverage

Only the round-three range and the two remaining round-two findings were re-reviewed. Finding 1.1 is resolved. The context route now treats `user_metadata.invite_id` only as a lookup hint and binds the selected invite to the authoritative authenticated email plus the caller's mirrored tenant before returning inviter, company, or deal data (`src/app/api/v1/invites/context/route.ts:21-57`). Cross-account and cross-tenant mismatches return the same opaque 404, with route-level coverage in `tests/api-v1-invite-context.test.ts:90-135`; the accept client now dead-ends on any untrusted or unavailable context instead of exposing the bare acceptance form (`src/app/accept-invite/page.client.tsx:76-107`). This satisfies `spec-v3.md` criterion 3 without creating a context oracle.

The reviewed diff otherwise stays within the two requested repairs. It does not alter the previously approved external Deal/Data Room/Team behavior, invite role boundaries, document visibility rules, phase gates, or feature-flag cutover.

## 2. Authorization, identity containment, and document security

2.1 **The resend containment repair is not tenant-scoped, so round-two finding 2.1 remains partially open.** `plan-v5.md:155-164` requires resend to re-assert containment for the exact pending invite, and the round-two review required an ownership- and scope-proven transition. The new repair selects only `id, status, company_id` by email and conditionally changes an `active`/unprovisioned mirror to `invited` by id, status, and null company (`src/lib/api/v1/inviteDelivery.ts:145-173`); it never reads or requires `mirror.tenant_id === invite.tenantId`. The untouched auth trigger derives the mirror tenant from invite metadata (`supabase/migrations/20260604100000_permissions_schema.sql:162-178`), so tenant equality is the exact invariant that distinguishes the intended orphan from an active unprovisioned identity in another tenant. The assertion that `create_invite` always prevents a genuine active account is insufficient across the row-first interval: an identity can appear after the pending invite row is reserved and before a later resend. Select and compare `tenant_id`, include it in the conditional repair predicate, fail closed on mismatch, and add a cross-tenant active/unprovisioned denial test while retaining the existing provisioned/suspended/no-row denials.

The repair still fails closed on update error or zero affected rows and does not issue a credential before successful containment. The server-side document predicate and direct-ID routes are unchanged in this range and continue to deny external users every Internal-room and classification-4 MNPI document regardless of phase.

## 3. Transactional integrity, audit, migration, and recovery

No schema, migration, document/audit, or storage path changed in round three. The repaired resend path retains nonce rotation, metadata update, magic-link creation, email delivery, and atomic delivery finalization after containment; a failed conditional repair returns `containment_failed` before credential creation. No new data-loss or audit divergence was found beyond the missing tenant predicate in finding 2.1.

The resolved round-two transactional document-upload fix and compensation behavior remain unchanged. No rollback addition is needed for this code-only incremental repair.

## 4. Edge cases, scope control, and deliberate deviations

The changed tests cover bound context, cross-account context denial, cross-tenant context denial, missing invite metadata, trusted-context client rendering, client dead-end behavior, active/unprovisioned repair success, zero-row repair failure, provisioned refusal, and suspended refusal. The missing edge case is the security boundary identified in finding 2.1: an active/unprovisioned mirror whose tenant differs from the pending invite.

The one-commit range is confined to the two review findings, their tests, and review/run documentation. The five deliberate deviations accepted in round one are unchanged and remain nonblocking. `git diff --check 2b8de9c..2d35744` reports only two trailing-space lines in the copied round-two review artifact; this is optional cleanup, not a merge blocker.

## 5. Verification, checks, and verdict

At reviewed head `2d3574458c4da7717a94015f6448303e3efeb427`, GitHub reports PR #124 open, non-draft, mergeable, and `CLEAN`; main CI, dependency audit, Vercel, and preview-comment checks all pass. Local changed-area verification passed three files / 20 tests. GitHub connector reads still return repository-not-found for this installation, so the review used the GitHub-skill-authorized authenticated `gh` fallback after verifying the canonical repository, PR, exact head, and `develop` base.

Finding 1.1 is resolved. Finding 2.1 remains actionable because the repair can change an active unprovisioned mirror without proving that it belongs to the invite's tenant.

**Verdict: changes requested.** No `PR APPROVED` comment was posted.
