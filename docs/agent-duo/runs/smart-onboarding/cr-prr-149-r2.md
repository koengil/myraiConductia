---
run_id: smart-onboarding
type: review
status: changes_requested
round: 2
source: prr-149-r2.md
---

# Review — prr-149-r2.md

## 1. Coverage of the frozen criteria

The round-two head reviewed is `154dbe8098f8cf8e97c311906ba42efa58f0bf22` against `develop` at `8c2090192fbc25996df6a5ffa8be5913c40f62dc`. The delta substantially improves all five accepted findings, but three remain behaviorally incomplete and D8.16 remains absent.

**1.1 — Bound lookup and exact withdrawal remain incomplete. (Blocking.)** `SmartLookupCard` now keys requests by normalized email, deal, selected company, and surface. It sends the company to the route, which uses only that authorized company's verified domains for `classifyInviteDomain`; an out-of-scope `companyId` is ignored. Omitting `surface` from the POST body is acceptable because surface changes neither the endpoint's authority nor its result, while it still invalidates the client-bound request. The `onResult` ref/effect arrangement is a sound render-loop fix, and preserving `previousCompanyId` across repeat delivery correctly prevents the card from losing the value it must later restore.

The parent behavior still violates A14. `InviteModal` withdraws applied values only when the result becomes `unavailable` or the email changes (`src/components/team/InviteModal.tsx:379-394`); a company, deal, or surface key change leaves the previous recommendation's company/phase in the send form while the new request is loading or stale. The parent also tracks user interaction for company but not phase, and every new ready delivery unconditionally calls `setPhase(nextPhase)` (`InviteModal.tsx:404-418`), so a later recommendation can overwrite a phase the inviter selected. Withdraw immediately on every bound-key change, but only when the current control still equals the lookup-applied value, and separately preserve a user-touched phase. Add assertions for company/deal/surface changes and for a user-chosen phase; the new tests exercise only an email change followed by a 503.

**1.2 — Live invitation authority is used, but its failure state is not reliable. (Blocking.)** Proposal preview can safely derive the external-Director action from successful `assessProposal`, because that verdict already proves invitation authority and the party relationship. Member and viewer paths now call the real `userCanInvite`, so the party-removed negative and the actual authority tiers are represented rather than inferred from role names.

However, `realInvitationAuthority` treats only a thrown exception as unavailable. The real Supabase access helpers destructure `data` and ignore returned `{ error }` values (`src/lib/api/v1/access.ts`); ordinary query failures therefore resolve as `false` rather than throw. `perimeterForMember`/`perimeterForViewer` then return an apparently available perimeter with `canInviteTeammate: false`, contrary to the frozen fail-closed requirement that a failed authority read make the preview unavailable. Use an error-aware/tri-state authority read at this boundary and test resolved Supabase errors, not only rejected promises.

## 2. Scope and reuse of approved surfaces

The delta remains within the frozen Gate 0, Team, Member Drawer, external deal-home, invitation, and shared policy surfaces. It adds no persistence for lookup/preview results, automatic grants, new invitation path, destination, chatbot, or research behavior. Proposal results remain editable and the existing preflight/send path remains authoritative.

The private perimeter core remains unreachable outside its three approved exports. Candidate-company derivation continues to mirror real invitation tiers, including delegated own-company `can_invite`, external-party confinement, internal deal management, and tenant overseer scope. The selected-company domain change uses the existing classifier rather than duplicating domain semantics. These scope/reuse decisions are sound; the remaining issues are state withdrawal, error semantics, and hidden-invitation authorization/query parity.

## 3. Data lifecycle, rollback, flags, stale inputs, and audit semantics

The round-two delta does not modify `documentAccess.ts`, `proposalFeasibility.ts`, the invite send route, the phase migration, or the rollback script. The previously verified Internal wall → MNPI → external phase ordering and `DocumentSubject`/`DocumentViewer` call-site semantics are unchanged. TS/SQL authority and role/phase parity are unchanged, including nullable-Boolean coalescing and authority-row lock ordering. Send, accept, grant, view, and download behavior is otherwise unchanged; lookup/preview remain read-only and audit-neutral, and no new secret-bearing field or log was found. Flag-off tests and the complete local suite pass.

The rollback implementation's containment transaction remains truthful under PostgreSQL row locking: containment-first expires/audits the pending nonzero invite, while acceptance-first grants the confirmed phase and leaves no pending row to contain. The new `supabase/tests/invite_phase_rollback.sql` provides useful single-session assertions for expiry, audit phase, phase-0/accepted preservation, and contained acceptance failure. It does not execute the two-session interleavings, does not prove acceptance-first, and does not exercise the actual down script's post-commit restoration of the old `create_invite` RPC; the two-session safety conclusion therefore still rests on source/lock reasoning rather than the claimed automated evidence.

I confirmed the database-environment notes. The configured database did not yet have `invites.phase`, so the new probe fails until the migration is applied. `supabase/tests/legal_hold.sql` independently fails because its old fixture omits the now-`NOT NULL` `documents.room`; blame and base-state inspection confirm that stale fixture predates this PR rather than being introduced by round two.

## 4. Edge cases and verification quality

**4.1 — A19 and pending-invitation authority are still not fixed for all worlds. (Blocking.)** User and seat lookups now have a fixed request-dependent schedule, and response bodies/status/warning order are indistinguishable in the added cases. The planner's retraction is correct for the exact fixture it measured, but it does not establish the general claim.

The pending-invite call still derives an authority input from the hidden row: `pending?.deal_id ?? dealId` (`src/app/api/v1/invites/lookup/route.ts:320-342`). A hidden invite whose non-null deal differs from the request causes authority queries against a different deal than the no-row world, so predicates, cardinality, and timing still depend on the hidden fact even if the ordered table names match. More seriously, a real no-deal invite has `deal_id = null`, so a deal-context lookup substitutes the request deal and may authorize disclosure through `canManageDealMembers` even when the actor cannot manage the invite's company. Preserve the real distinction between “row with null deal” and “no row,” and run a constant padded company/deal authority schedule whose selection is made only after all reads. Assert complete query predicates/arguments and response equality for null-deal and different-deal hidden invites. The current test uses only a null-deal invite with no request deal and records table names; lack of mutation confirmation is not itself fatal, but here it allowed the real branch/input defect to survive.

**4.2 — D8 coverage remains incomplete. (Blocking.)** The new A14 test now verifies eventual form reversion after an email change and failure, but it does not prove immediate withdrawal on every bound input or user-phase preservation. D8.4 now includes hidden seats and invitations at the response layer, but its schedule assertion is too coarse to catch finding 4.1. The rollback probe is useful but single-session only, as accurately disclosed.

Most importantly, the planner explicitly confirms there is still no automated D8.16 test of the full D7 end-to-end demo path. D8.16 is a frozen mandatory automated-coverage criterion, so its absence is blocking, not advisory. Add an automated path that composes/sends the invite, accepts it through the existing verification/TOS/2FA sequence, confirms stored-phase grant, and verifies the resulting welcome/perimeter behavior without persistence or audit leakage.

Reviewer verification passed 113 targeted tests across 10 lookup/perimeter/welcome/flag/phase suites and the full Vitest run (`128` files passed, `4` skipped; `881` tests passed, `6` skipped). `npx eslint .` exited zero with eight pre-existing warnings, `npx tsc --noEmit` passed, `npm run build` passed, and GitHub's lint/typecheck/test/build and Vercel checks are green. Database probes remain opt-in and could not be validly run on the configured schema before applying the feature migration.

## 5. Technical security, authorization parity, and delivery quality

**5.1 — Resolved.** The `nanoid` override is acceptable under this repository's existing transitive-override policy (which already covers `postcss` and `sharp`). The lockfile resolves the only installed copy to `nanoid@3.3.18`; local `npm audit --omit=dev --audit-level=moderate` reports zero vulnerabilities, and GitHub's blocking dependency audit is green.

The implementation retains opaque mapped invite authority failures, fail-closed unknown document rooms, private perimeter subject construction, and unchanged document/grant/download walls. The round-two PR request is accurate about the remaining lack of a two-session rollback probe and D8.16, but overstates A14 completion and A19 schedule parity. Those claims should be corrected together with the code/tests.

## Decision

`changes_requested`. Finding **5.1** is fully resolved; **1.1**, **1.2**, **4.1**, and **4.2** remain blocking for the concrete reasons above. No `PR APPROVED` comment was posted.
