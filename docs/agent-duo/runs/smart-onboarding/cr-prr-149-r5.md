---
run_id: smart-onboarding
type: review
status: changes_requested
round: 5
source: prr-149-r5.md
---

# Review — prr-149-r5.md

## 1. Coverage of the frozen criteria

I reviewed code commit `95391d29a7d6b917c6aa8e1985727e21f1967bc1` against `develop` at `8c2090192fbc25996df6a5ffa8be5913c40f62dc`, with prior reviewer artifact commit `3a9036b0d6faadff253c6fd39351a5c010e0a90d` and planner account `prr-149-r5.md` at docs-only head `c01a539b737b6998ddf35e31a033bb22c133f440`. I rechecked every round-four blocker in source and tests, both open advisory items, and the complete feature invariants. The frozen brief/spec were not edited.

Round-four selected-company finding **1.3 is closed**. An internal Team invitation now starts with an actually unset company, renders the unset option, and cannot submit until a company exists (`src/components/team/InviteModal.tsx:115-125,439-457`). `SmartLookupCard` receives `companyId || null`, so the first domain lookup honestly asks for a candidate recommendation; once the recommendation or inviter selects a company, the request is rebound to that rendered value (`InviteModal.tsx:371-379`; `tests/invite-modal-lookup.test.tsx:377-410`). The authoritative preflight/send still binds the real company, deal, role and phase, and the existing mismatch confirmation remains intact. This restores A5(b), A9, A13/A14 and the related D8.1/D8.6 evidence without treating a hidden default as a selection.

Round-four invitation-authority finding **4.1 is closed for the verdict**. `userCanManageInvite` now resolves the target company tenant and compares it to the actor tenant before its firm-admin branch, while preserving external/company/deal authority rules (`src/lib/api/v1/access.ts:416-453`). Direct tests prove same-tenant firm-admin authority, cross-tenant denial, and missing-company denial (`tests/access-invites.test.ts:192-220`). Lookup evaluates both invitation shapes and selects the shape of the actual stored invitation (`src/app/api/v1/invites/lookup/route.ts:353-369`). That satisfies A6/Q6; the remaining A19 work-shape problem is separately blocking in section 4.

Round-four D7 finding **3.1 is improved but not closed**. The in-memory invitation now stores the composed email, company, deal, company role, deal role and phase, and its acceptance response derives company/deal context from that stored row (`tests/onboarding-e2e.test.ts:120-169,355-448`). That is useful typed-address-to-acceptance continuity. It still does not automate the required acceptance-to-real-2FA-to-protected-welcome transition; see blocking finding 3.1 below.

## 2. Scope and reuse of approved surfaces

Team is a valid D7 seller-invitation surface. The frozen design names both Gate 0 and Team, while Gate 0 is the pre-deal bank-colleague surface and Team is the existing seller/buyer invitation surface after a deal exists. The round-five walk therefore starts in an approved place; changing it to Gate 0 is not required.

The delta remains limited to lookup authority, the existing Team modal, shared access predicates, and their tests. It introduces no crawler, paid enrichment, new invitation state machine, automatic send/grant, replacement destination, or new persisted lookup/perimeter state. Recommendations remain advisory and the real preflight/send path remains authoritative. Round five does not touch Gate 0 preview pairing, member preview, welcome UI, document handlers, storage/Box, acceptance, or the MFA implementation.

The company-control change is also within approved scope. “Unset” is now a real UI/form state rather than a value shown only on screen, so the initial lookup may identify a candidate company from one work email without misrepresenting A5(b)'s selected-company comparison. After recommendation or a manual selection, the visible value and lookup body agree in both directions.

## 3. Data lifecycle, acceptance continuity, rollback, flags, and audit semantics

**3.1 — The claimed E2E still skips the real 2FA/AAL2 transition and manufactures the membership side of continuity. (Blocking: D7, D8.16; preserved D4 sequencing.)** The expanded store correctly records the sent invitation fields, but the test constructs the invitee's `deal_memberships` fixture before acceptance rather than having acceptance create it, then invokes acceptance against the store (`tests/onboarding-e2e.test.ts:339-448`). Its “second factor” step directly POSTs to `/api/v1/auth/mfa/complete` (`tests/onboarding-e2e.test.ts:450-467`). That endpoint only validates an event and writes an audit row; it neither challenges nor verifies a factor nor confirms AAL2 (`src/app/api/v1/auth/mfa/complete/route.ts:11-39`). The real existing 2FA client calls `mfa.challenge`, `mfa.verify`, and `getAuthenticatorAssuranceLevel`, requires `aal2`, and only then calls the audit endpoint (`src/app/two-factor/page.client.tsx:145-188`). The E2E never executes those operations or reaches the protected project route; it directly calls `perimeterForViewer` and renders `WelcomeBrief` (`tests/onboarding-e2e.test.ts:469-507`). Separate `two-factor-page` and SQL tests are valuable component proofs, but they do not make this clean-state invitation walk continuous. Satisfy D7/D8.16 by driving the existing 2FA client (including challenge, verification and AAL2 confirmation) between acceptance and the resulting protected welcome, with membership/phase derived by the acceptance transition rather than preinstalled fixture state. This requires test coverage, not a D4 production-flow change.

The underlying lifecycle remains unchanged and sound from the prior full review. The migration still persists nonnegative phase, uses the established authority/lock order, and grants/audits the stored phase only after credential, identity, tenant and verification gates (`supabase/migrations/20260808120000_invite_phase.sql:63-125,315-381`). Send, accept, verification, TOS, MFA, member, view/download and storage/Box implementation paths are untouched in round five. Rollback containment and the separately documented old-RPC restoration caveat are unchanged.

The configured database still lacks both `invites.phase` and the nine-argument `create_invite`; ordinary `npm test`/CI still skips the SQL authority, acceptance and rollback probes unless `RUN_DB_TESTS=1` (`tests/db/invite-authority-parity.test.ts:19-70`). I did not mutate that database or claim a SQL pass. This remains **advisory evidence/deployment debt**, not a new implementation failure: the SQL tests exist, the migration/source parity is unchanged, and all required local/hosted gates pass. A disposable migrated CI database should run them before deployment.

Flag and audit semantics remain stable. Lookup, preview and UI/welcome remain behind `platform_onboarding`; read paths remain read-only and audit-neutral; acceptance TOS, MFA and grant audit meanings are unchanged. No verification code, nonce, credential, token, environment secret, storage key, or other real secret material was introduced.

## 4. Edge cases and verification quality

**4.1 — An invisible pending row still changes the authority work relative to absence. (Blocking: A19, D8.4.)** Lookup reads a pending invitation globally, then passes its hidden `company_id` and `deal_id` into both `userCanManageInvite` calls (`src/app/api/v1/invites/lookup/route.ts:320-369`). The source comment itself acknowledges that predicate queries depend on those hidden values (`lookup/route.ts:339-349`). Against a real database, an absent sentinel stops when the company is missing, while a same-tenant hidden invitation reaches additional company/deal authority reads in `userCanManageInvite` (`src/lib/api/v1/access.ts:421-453`). That is a row-dependent query-depth/timing oracle even when bytes and top-level call count match.

The existing indistinguishability test cannot detect it: it records only `.from()` table names and its query stub ignores filter arguments, so the sentinel company can receive the same canned company row as a real ID (`tests/lookup-indistinguishable.test.ts:218-253`). This preserves the appearance of a fixed schedule under the mock while production work differs. A19's invisible-versus-unknown guarantee remains blocking after prior rounds explicitly identified this channel. Make pending disclosure use an input-independent schedule that does not feed hidden row values into branching reads, and add a mutation-sensitive test that distinguishes predicate arguments/query depth for attached and unattached hidden invitations versus absence.

The composed perimeter failure test remains **advisory**. Checked nested predicates now propagate `unreadable`, `userCanInvite` still denies unless literal true, and perimeter maps unreadable/throws to unavailable; unit tests prove the first two pieces (`src/lib/api/v1/access.ts:301-408`; `src/lib/perimeter/perimeter.ts:252-275`). A member/viewer route-level composed assertion would harden B10/D8.11, but the direct composition is inspectable and no contradictory path remains.

The malformed-email preview asymmetry also remains **advisory**. `SmartLookupCard` correctly suppresses malformed requests under A12, while proposal preview may POST an implausible email and render the route's 400 as unavailable (`src/components/onboarding/PerimeterPreview.tsx:49-90`). Gating preview on the same plausibility condition would avoid needless traffic and a confusing unavailable flash, but A12 governs lookup and this does not widen access or expose data.

Focused verification passed 16 files/135 tests. The full suite passed 129 files with four skipped and 895 tests with six skipped. Production audit reported zero vulnerabilities with only overridden `nanoid@3.3.18`. `npx eslint .` exited zero with eight pre-existing unused-variable warnings, `npx tsc --noEmit` passed, and the Next.js production build compiled, typechecked and generated all 38 static pages. GitHub dependency audit, lint/typecheck/test/build and Vercel checks were green at exact docs head `c01a539`.

## 5. Technical security, authorization parity, and delivery quality

The full-delta re-audit found no document-wall regression: Internal exclusion still precedes MNPI, which precedes external phase (`src/lib/api/v1/documentAccess.ts:85-100`). Shared view/upload predicates, fail-closed room decoding, proposal subject boundaries, stored-phase SQL/TypeScript decisions, send/accept/grant/view/download behavior, flag-off parity, audit neutrality, and secret/storage boundaries remain intact. Round five touches none of those implementation paths.

Tenant-coherent actual-invitation authorization is fixed, and the company-control correction restores exact visible/input binding. Security approval is nevertheless blocked by 4.1's remaining hidden-row-dependent work oracle. Contract approval is also blocked by 3.1's missing real challenge→verify→AAL2→protected-welcome continuity. Both are frozen-spec failures supported by executable source paths, not requests for optional polish.

Advisory follow-up is limited to a composed unreadable-to-unavailable perimeter test, a hermetic migrated SQL harness wired into CI, and plausible-email gating for proposal preview. The missing route-level cross-tenant lookup test is also a test-quality improvement: the direct predicate test and route call path establish the fixed verdict, but an end-to-end negative would better protect it.

## Decision

`changes_requested`.

Blocking findings are **3.1** (the E2E calls only the post-verification audit endpoint and does not automate the real AAL2/2FA-to-protected-welcome path required by D7/D8.16) and **4.1** (pending-invite authority still performs hidden-row-dependent work, violating A19/D8.4). Round-four selected-company binding and tenant-coherent actual-invitation authorization are closed. Advisory findings are composed perimeter-error coverage, a migrated CI SQL harness, plausible-email preview gating, and a route-level cross-tenant regression test. No `PR APPROVED` comment was posted.
