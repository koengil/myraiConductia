---
run_id: onboarding
type: review
status: changes_requested
round: 4
source: prr-124.md
---

# Review: PR #124, round 4

PR: `FutureProofingDev/intelibank#124`, `duo/onboarding` → `develop`
Reviewed range: `2d3574458c4da7717a94015f6448303e3efeb427..45ecc1d2ae4bd452db28eb9cbe2ab766638ed4c7`
Frozen requirements: `spec-v3.md` and approved `plan-v5.md`

## 1. Frozen-spec and approved-plan coverage

Only the human-authorized round-four range and the sole remaining round-three finding were re-reviewed. The diff now selects `tenant_id` on the delivery mirror and returns `tenant_mismatch_no_credential` before containment repair, auth-metadata rotation, magic-link creation, or email when the observed tenant differs from the invite (`src/lib/api/v1/inviteDelivery.ts:145-156`). This resolves the direct cross-tenant path identified in round three.

The code change is confined to invite delivery and its targeted tests; the remaining files are review/run records. Previously approved spec/plan behavior—including invite authorization, acceptance, external navigation, document access walls, phase gates, audits, storage, and flag parity—is unchanged.

## 2. Authorization, identity containment, and document security

2.1 **The containment repair still does not enforce tenant equality in its conditional write.** Round-three finding 2.1 explicitly required selecting and comparing `tenant_id` *and including it in the conditional repair predicate* so the ownership/scope proof remains true at the state transition. The new pre-check reads `mirror.tenant_id` at `src/lib/api/v1/inviteDelivery.ts:145-156`, but the repair at lines 173-179 predicates only on mirror id, `status='active'`, and `company_id IS NULL`; it omits `.eq('tenant_id', invite.tenantId)`. That leaves a check-to-update race in which the observed tenant can cease to match before the row is reclassified as invited. Add tenant equality to the same conditional update and require exactly one affected row, then assert that predicate in the test builder or add a mutation/race failure test. The existing cross-tenant snapshot test is useful but does not exercise the missing write predicate.

The current code still fails closed on an initially observed tenant mismatch and emits no credential, and provisioned/suspended/no-row cases remain denied. Server-side document predicates and direct-ID routes are unchanged and continue to deny external users every Internal-room and classification-4 MNPI document regardless of phase.

## 3. Transactional integrity, audit, migration, and recovery

No migration, schema, audit, document, or storage path changed in this range, so there is no new deploy/rollback surface. The repaired flow still places containment before nonce rotation, magic-link generation, email, and delivery finalization.

The missing tenant condition is precisely a transaction-safety issue within the compare-and-update repair: the authorization invariant is checked outside the conditional state transition. Adding the predicate preserves the existing fail-closed `repaired.length === 1` recovery behavior without requiring a schema or rollback change.

## 4. Edge cases, scope control, and deliberate deviations

`tests/invite-delivery.test.ts:210-223` adds the requested static cross-tenant active/unprovisioned denial and confirms no email is sent. The 12-test suite also retains same-tenant repair success plus no-row, provisioned, suspended, metadata-error, and missing-mirror failures. What remains untested is the invariant on the repair update itself: the mock does not assert `.eq('tenant_id', invite.tenantId)`, so it cannot detect the missing conditional guard.

The one-commit range is narrowly scoped and `git diff --check 2d35744..45ecc1d` is clean. The five deliberate deviations accepted in round one are unchanged and remain nonblocking.

## 5. Verification, checks, and verdict

Local changed-area verification passed `tests/invite-delivery.test.ts` with 12/12 tests. At reviewed head `45ecc1d2ae4bd452db28eb9cbe2ab766638ed4c7`, GitHub reported the PR open, non-draft, and mergeable; dependency audit and both Vercel checks passed, while the main lint/typecheck/test/build job was still pending, so the merge state was `UNSTABLE`. GitHub connector reads continued to return repository-not-found for this installation, so the review used the GitHub-skill-authorized authenticated `gh` fallback after verifying the canonical repository, exact head, and `develop` base.

The direct tenant-mismatch path is fixed, but the exact-scope invariant is not enforced atomically at the containment repair. Finding 2.1 therefore remains actionable.

**Verdict: changes requested.** No `PR APPROVED` comment was posted.
