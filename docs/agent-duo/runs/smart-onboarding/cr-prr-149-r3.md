---
run_id: smart-onboarding
type: review
status: changes_requested
round: 3
source: prr-149-r3.md
---

# Review — prr-149-r3.md

## 1. Coverage of the frozen criteria

I reviewed implementation commit `7a386b02e4b37d44c552f4c5d186ec09cb13b2d2` against `develop` at `8c2090192fbc25996df6a5ffa8be5913c40f62dc`, with planner account `prr-149-r3.md` at the docs-only branch head `8a248f8c89a6de869abb477b711b6ee8c2b79157`. I rechecked the four round-two blockers in source and tests rather than accepting the planner's closure claims, then re-audited the full feature delta and mandatory gates. No frozen-spec file was changed; the issues below are implementation and evidence deviations from that frozen contract, not an approved reinterpretation of it.

**1.1 — The code repair is plausible, but mandatory A14/D8.6 verification is still absent. (Blocking.)** `InviteModal` now stores a lookup-application key over normalized email, selected company and deal, withdraws only lookup-applied values when that key changes, and uses `phaseTouched` to avoid overwriting a later inviter choice (`src/components/team/InviteModal.tsx:136-143,382-420`). `SmartLookupCard` already binds the fourth input, surface, in its own request key. This is the right implementation shape.

The planner nevertheless removed the only two new tests for company-change withdrawal and manually selected phase preservation after they failed to work. `tests/invite-modal-lookup.test.tsx` still proves only eventual email-change withdrawal after a forced 503 and preservation of a manually selected company; it does not prove immediate company/deal/surface invalidation or `phaseTouched`. Frozen D8.6 explicitly requires automated changed-bound-input result/prefill withdrawal on both invite surfaces. A passing implementation review cannot substitute for that named test obligation, especially when the attempted assertions did not pass.

**1.2 — Existing enforcement callers are preserved, but preview failure semantics remain incomplete. (Blocking.)** The split itself is sound: `userCanInviteChecked` returns `boolean | 'unreadable'` for direct actor reads and the external-party read, while `userCanInvite` returns true only for literal true (`src/lib/api/v1/access.ts:319-364`). Existing proposal, preflight and send callers therefore retain their deny-on-error behavior. Member/viewer perimeter paths alone consume the tri-state and map direct unreadable results to unavailable (`src/lib/perimeter/perimeter.ts:262-278`).

The disclosed residue is not acceptable under frozen B10. The internal-deal branch still returns `canManageDealMembers(...)` directly and the no-deal branch still awaits `canManageCompanyMembers(...)` (`access.ts:348-350`); those nested predicates collapse ordinary resolved Supabase `{ error }` results to false. The preview can consequently report an available perimeter with `canInviteTeammate: false` when the authority data could not be read. Safe denial is appropriate for enforcement, but an apparently complete preview is false confidence; the frozen contract requires unavailable when the perimeter cannot be reliably computed. No test exercises these resolved nested-error cases.

## 2. Scope and reuse of approved surfaces

The implementation stays on the approved Gate 0, Team, Member Drawer, external deal-home, invitation and shared policy surfaces. It adds no new onboarding flow, persistence for lookup/preview output, automatic grant, research/enrichment path, destination, or alternate invitation state machine. Lookup results remain advisory and the existing preflight/send path remains authoritative.

The private perimeter core remains exposed only through proposal/member/viewer entry points, and document access still reuses the real predicates rather than a preview-only approximation. Candidate-company derivation continues to mirror admin, external-party, internal-deal and no-deal invitation tiers. Plan v5 was executed by the user's Option C decision without a plan-review cycle; its proposed test split is therefore implementation guidance, not pre-approved evidence that can relax frozen D8.

Round three's pending-invite change is not an acceptable least-privilege refinement. It narrows disclosure to the actor's own company even where real deal-scoped `userCanManageInvite` authority covers another company, silently dropping an authorized A6 warning. It also checks the wrong invitation resource in another case described in section 4.1. The planner disclosed the intended narrowing, so this is not a hidden edit to `spec-v2.md`, but the implementation still conflicts with the frozen authority-scoped disclosure rule.

## 3. Data lifecycle, rollback, flags, stale inputs, and audit semantics

The full delta preserves the document wall. `documentAccess.ts` still evaluates Internal-room exclusion first, MNPI second and external phase third; the `DocumentSubject`/`DocumentViewer` split and fail-closed room decoder do not change the predicates. View, download, document-list, member and acceptance handlers are unchanged from base. Upload continues to derive from the same document policy.

The phase migration preserves nonnegative default-0 storage, lock ordering, NULL-safe authority, company/deal/role/party validation and transactional invite/audit insertion. `accept_invite` keeps its existing row-lock, verification, credential and tenant checks and changes only the granted/audited phase from literal zero to the stored invitation phase. TypeScript and SQL retain the same actor-specific company-role and party-derived deal-role decisions. Send still performs its existing checks, forwards `p_phase`, opaquely maps the new authority/shape RPC failures, and preserves the pre-existing generic raw-error catch-all outside this feature's new mappings.

Lookup and preview are flag-gated, read-only and audit-neutral. Gate 0 and Team UI remain behind `platform_onboarding` in their existing flag combinations, and the welcome branch is likewise flag-on only. No secret, credential, nonce, verification value, signed URL, environment file or key material was added. Storage/Box behavior and audit meanings are unchanged.

The configured database was not migrated: the opt-in SQL wrapper failed before assertions because that schema lacks both `invites.phase` and the nine-argument `create_invite`. I did not mutate that database. The planner reports all three probes passing after applying the migration to a separate test database, and source review supports the authority/acceptance/rollback logic, but this repository still does not provide a hermetic or CI-wired migrated database run. The single-session rollback probe remains useful; two-session containment/acceptance interleavings and post-containment restoration of the old RPC remain source-reasoned rather than automated.

## 4. Edge cases and verification quality

**4.1 — Hidden-row-derived inputs are removed, but invitation disclosure is still authorized against the wrong resource. (Blocking.)** Round three genuinely fixes the query-input defect: lookup now calls `userCanManageInvite` with only actor/request-bound values `{ companyId: actor.company_id ?? NO_ROW, dealId }`; neither company nor deal authority input comes from `pending` (`src/app/api/v1/invites/lookup/route.ts:340-359`). This closes the specific hidden-row-dependent predicate/query-schedule channel from round two.

The replacement gate is not correct. Disclosure then checks only `pending.company_id === actor.company_id`. An actor who manages the request deal can therefore see the warning for a same-company pending invite attached to another deal or to no deal, even though applying `userCanManageInvite` to that invitation would deny it. Conversely, a deal manager who may manage a pending invitation for another deal party is suppressed because it is not the actor's own company. The first case violates A19/A6 by revealing an unauthorized hidden invitation; the second violates A6 and D8.2 by withholding an authorized one. Existing tests cover only an own-company/no-deal positive and a different-company hidden negative; they do not cover same-company/different-deal, no-deal-under-request-deal, or authorized cross-company deal invitations. The schedule assertion still records table names rather than full predicates/arguments, so it would not detect this resource mismatch.

**4.2 — The new test is not the frozen D7 path and does not satisfy D8.16. (Blocking.)** `tests/onboarding-e2e.test.ts` directly invokes mocked lookup, proposal-preview and send handlers for a Team-style, existing-deal invitation, checks `p_phase`, then manufactures an already-active viewer and calls `perimeterForViewer`. It never drives Gate 0, the acceptance route, TOS attestation, 2FA, the resulting membership, or `WelcomeBrief`. `supabase/tests/invite_phase_accept.sql` separately proves an unverified RPC acceptance refusal and, after directly marking verification, stored-phase membership/audit grant. It does not cover HTTP acceptance, TOS, 2FA, welcome rendering, or continuity from the invitation composed by the TypeScript test. Two disconnected partial probes do not automate frozen D7's clean-state lookup → preview → send → accept → 2FA → matching welcome path.

**Additional full-delta defect — Gate 0 preview always submits an invalid proposal. (Blocking.)** Gate 0 mounts `PerimeterPreview` with `dealId={null}` but `dealRole={inviteRole}` (`src/components/wizard/Gate0Wizard.tsx:1458-1466`). The preview route explicitly requires deal ID and deal role to be both present or both absent and returns 400 otherwise (`src/app/api/v1/invites/perimeter-preview/route.ts:98-103`). The actual Gate 0 surface therefore renders unavailable instead of the B12/B13 prospective zero-document perimeter. Preview API tests exercise paired values or paired nulls, and the claimed E2E uses a real deal, so neither catches the integration failure.

Focused verification passed 14 Vitest files and 125 tests. The full suite passed 129 files with four skipped and 883 tests with six skipped. `npx eslint .` exited zero with eight pre-existing warnings, `npx tsc --noEmit` passed, and `npm run build` passed. Local production audit found zero vulnerabilities with only overridden `nanoid@3.3.18`, and GitHub's dependency audit, lint/typecheck/test/build and Vercel checks are green.

## 5. Technical security, authorization parity, and delivery quality

The strongest round-three improvement is the removal of hidden-row fields from lookup's authority inputs. Existing invite enforcement remains fail-closed, document rooms remain fail-closed, proposal subject construction stays private, and no new state, secret or audit write crosses the lookup/preview boundary. The branch is draft/open at the exact implementation commit plus its docs-only planner commit, and all mandatory non-database gates are green.

Security approval is still blocked by the wrong-resource pending-invite disclosure in 4.1: it creates a concrete unauthorized existence leak, not merely a theoretical timing concern. Reliability approval is also blocked by the nested authority-error collapse in 1.2 and the broken Gate 0 preview integration. The planner's claims accurately disclose the removed tests and the split E2E approach, but those disclosures do not satisfy frozen mandatory coverage.

Advisory follow-up, after the blockers are corrected, is to strengthen A19 schedule assertions to include predicates/arguments or mutation confirmation; automate both rollback/accept lock-order interleavings and old-RPC restoration; wire the SQL probes to a disposable migrated database; and leave the unrelated pre-existing raw invite 500 for its own scoped cleanup.

## Decision

`changes_requested`.

Blocking findings are **1.1** (mandatory D8.6 tests removed), **1.2** (nested resolved authority errors still produce a confident perimeter), **4.1** (pending-invite disclosure uses request/actor authority but not the pending invitation's actual resource), **4.2** (the purported E2E does not automate D7/D8.16), and the additional Gate 0 preview mismatch (null deal with non-null deal role). Advisory findings are stronger A19 schedule/mutation evidence, two-session rollback and old-RPC-restoration automation, a hermetic migrated SQL harness, and the unrelated legacy raw-500 cleanup. No `PR APPROVED` comment was posted.
