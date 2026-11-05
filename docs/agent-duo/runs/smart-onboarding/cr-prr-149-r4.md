---
run_id: smart-onboarding
type: review
status: changes_requested
round: 4
source: prr-149-r4.md
---

# Review — prr-149-r4.md

## 1. Coverage of the frozen criteria

I reviewed implementation commits `f6cbca61816085d6f352491d96ec2b63f111b792` and `eecbbf41b79d8252244bb6aac17b2bb3a79145f6` against `develop` at `8c2090192fbc25996df6a5ffa8be5913c40f62dc`, with planner account `prr-149-r4.md` at docs-only head `83c81d1616480dc0a60337a63dfc5e75d6a99865`. I rechecked every round-three blocker in source and tests, the disputed D7 interpretation, the new company-binding behavior, and the complete feature delta. The frozen brief/spec were not edited.

Round-three finding **1.1 is closed**. `InviteModal` now withdraws a card-applied phase when the company-bound key changes and preserves an inviter-touched phase (`src/components/team/InviteModal.tsx:388-424`). The restored mutation-sensitive tests hold the replacement lookup in flight, proving withdrawal comes from the changed-input branch rather than failure, and prove a later recommendation does not overwrite phase 3 (`tests/invite-modal-lookup.test.tsx:265-339`). This satisfies the Team-side A9/A13/A14 and D8.6 cases that were missing in round three; all nine modal tests passed five consecutive runs.

Round-three finding **1.2 is closed in the decision path**. The nested company/deal predicates now return `boolean | 'unreadable'`, and `userCanInviteChecked` propagates that state while `userCanInvite` continues to permit only literal true (`src/lib/api/v1/access.ts:84-187,360-407`). Perimeter maps unreadable and thrown failures to unavailable (`src/lib/perimeter/perimeter.ts:252-275`). The same error fixtures assert tri-state behavior and enforcement denial (`tests/access-invites.test.ts:242-304`). This is the required B10/D2 split. A composed member/viewer-to-unavailable integration test would improve regression quality, but source composition is direct and is not a blocker.

**1.3 — Team's untouched company is not the selected company bound into lookup. (Blocking: A5(b), A13, A14; D8.1/D8.6.)** The form initializes `companyId` to the first visible company, renders that value in the selected `<select>`, and sends/preflights it if the inviter does nothing (`src/components/team/InviteModal.tsx:115-121,150-179,217-228,437-452`). Round four nevertheless passes `null` to lookup until the select's `onChange` sets `companyTouched`, even though `SmartLookupCard` documents `companyId` as the company currently selected and binds exactly the value it receives (`InviteModal.tsx:367-378`; `src/components/onboarding/SmartLookupCard.tsx:55-90`). The route then compares the email against every candidate rather than the company visibly selected on the form (`src/app/api/v1/invites/lookup/route.ts:221-253`). A domain belonging to another candidate can therefore render a match/recommendation while the current form selection is the bank; the selected company is absent from the result's bound inputs until a user gesture. That silently changes frozen “selected company” into “company the user has manually touched.” The later preflight remains correctly bound and does not auto-send, so A9 and the domain-confirmation boundary are preserved, but they do not repair A5(b)/A13/A14. Represent “unset” as an actually unset control state, or bind lookup to the value the form would send; add positive/negative coverage for the untouched visible selection and its mismatch withdrawal.

## 2. Scope and reuse of approved surfaces

Team is a valid D7 seller-invitation surface. The frozen vocabulary names both Gate 0 and Team, while current Gate 0 copy explicitly limits its queue to bank colleagues and directs buyer/seller invitations to Team after deal creation. Using Team for the seller-email walk is therefore not itself a spec deviation.

The implementation otherwise stays on the two existing invite surfaces, the existing preview/member drawer, the external deal home, and the shared invitation/document predicates. It introduces no crawler, enrichment provider, new invitation state machine, automatic grant/send, alternate destination, or persisted lookup/perimeter record. Every recommendation remains advisory; the normal domain-confirmation, proposal/preflight, and send paths still decide the real company, role, phase, and authority.

The Gate 0 defect from round three is closed. The wizard now submits `dealId: null` and `dealRole: null` together (`src/components/wizard/Gate0Wizard.tsx:1448-1474`), and a route-shaped integration test rejects mismatched pairs before asserting the ready zero-document state (`tests/gate0-wizard-api.test.tsx:649-707`). That satisfies B12/B13 for the pre-deal surface.

## 3. Data lifecycle, acceptance continuity, rollback, flags, and audit semantics

**3.1 — The claimed end-to-end test does not prove one invitation reaches the personalized post-2FA brief. (Blocking: D7, D8.16, and preserved D4 sequencing.)** `tests/onboarding-e2e.test.ts` stores only `{ id, phase, verified }`; `create_invite` discards the typed email, company, deal and roles, and `accept_invite` returns hard-coded context (`tests/onboarding-e2e.test.ts:104-137`). Before acceptance, the test manufactures `deal_memberships` directly from `invite.row.phase` (`tests/onboarding-e2e.test.ts:339-359`). After handler-level verification and TOS/acceptance, it never performs the existing AAL2/2FA flow; it directly calls `perimeterForViewer` and renders `WelcomeBrief` (`tests/onboarding-e2e.test.ts:363-444`). The separate SQL probe proves stored-phase grant/audit after verification, but is not connected to the TS invitation and does not cover TOS, 2FA, routing, or welcome. Team is the correct seller front door, but the three-field store and disconnected SQL proof restate the intended continuity rather than test it. Frozen D7 requires the same clean-state walk through accept, 2FA, and landing, and D8.16 requires that path to be automated.

The underlying lifecycle implementation remains sound from the prior full review. The migration still stores nonnegative default-0 phase, preserves transaction lock/authority/shape checks, and grants/audits the stored phase only after the existing verification, credential and tenant gates. Send, accept, verification, member, document view/download and storage/Box handlers are unchanged in round four. Rollback containment and the separate old-RPC restoration caveat are likewise unchanged.

The SQL probes are opt-in at `tests/db/invite-authority-parity.test.ts:18-70` and are not run by ordinary `npm test`/CI. The configured database still lacks `invites.phase` and the nine-argument `create_invite`, so I did not claim a local SQL pass or mutate that database. This is advisory evidence debt because source/previous migrated-run evidence supports the migration, but the D7/D8.16 blocker above cannot be satisfied by an unavailable SQL harness in any event.

Feature flags and audit meaning remain stable. Lookup/preview/UI/welcome stay behind `platform_onboarding`; reads remain read-only and audit-neutral; acceptance TOS and grant audits are unchanged. No verification code, nonce, credential, token, environment secret, storage key, or real secret material was added.

## 4. Edge cases and verification quality

**4.1 — Pending-invitation disclosure is still neither tenant-safe nor indistinguishable. (Blocking: A6, A19, D2, D8.2, D8.4.)** Round four correctly evaluates both company-scoped and deal-scoped invitation shapes and chooses the real invitation's shape. It does not, however, use a constant hidden/absent schedule: both authority calls receive `pending.company_id`, and the deal call receives `pending.deal_id` (`src/app/api/v1/invites/lookup/route.ts:320-370`), directly contradicting the adjacent request-only comment. Real versus sentinel deal IDs can take different early-return/query paths in `canManageDealMembersChecked` (`src/lib/api/v1/access.ts:137-179`), leaving a timing/work oracle for an invisible invitation.

There is also a direct disclosure bypass. `userCanManageInvite` reads no target tenant and returns true immediately for every firm admin (`src/lib/api/v1/access.ts:416-438`). Because lookup fetches a pending invitation globally by normalized email and then passes its hidden company/deal into that helper, an admin can receive `pending_invitation` for another tenant, contrary to Q6/A6/A19 and the helper's own tenant-safety contract. The existing warning tests cover only own-company/no-deal positive and negative cases; the indistinguishability test uses a no-deal outsider and asserts only response bytes plus `.from()` table names, not predicate values or a cross-tenant admin (`tests/lookup-indistinguishable.test.ts:206-253`). Authorize the actual invitation with tenant coherence while keeping hidden and absent worlds on one input-independent work shape; add authorized deal/company cases, a cross-tenant admin negative, and mutation-sensitive predicate/schedule assertions.

The disclosed malformed-email preview asymmetry is **advisory** under B8/B10/D5, not an A12 violation: A12 governs the lookup card, which correctly issues no malformed request. `PerimeterPreview` keys whenever `companyId` exists and therefore POSTs malformed/empty proposal emails before rendering unavailable (`src/components/onboarding/PerimeterPreview.tsx:49-108`). Gating proposal preview on the same plausible-email condition would remove needless 400s, React test warnings, and a confusing unavailable flash.

Focused verification passed 13 files/130 tests, and the Team lookup suite passed 9/9 in five consecutive runs. The full suite passed 129 files with four skipped and 891 tests with six skipped. Production audit reported zero vulnerabilities with only overridden `nanoid@3.3.18`. `npx eslint .` exited zero with eight pre-existing unused-variable warnings, `npx tsc --noEmit` passed, and the Next.js production build compiled, typechecked and generated all 38 static pages. GitHub dependency audit, lint/typecheck/test/build and Vercel checks were green at exact docs head `83c81d1`.

## 5. Technical security, authorization parity, and delivery quality

The full-delta re-audit found no regression in the document wall: Internal exclusion still precedes MNPI, which precedes external phase. The shared read/upload predicates, fail-closed room decoder, proposal subject boundary, stored-phase SQL/TypeScript role decisions, view/download behavior, flag-off parity, audit neutrality, and secret/storage boundaries remain intact. Round four does not touch those implementation paths.

Security approval is nevertheless blocked by 4.1's cross-tenant invitation disclosure and hidden-row-dependent authority work. Contract approval is also blocked by 1.3's mismatch between the form's actual selected company and lookup's bound company, and by 3.1's missing acceptance-to-AAL2-to-route continuity. These are frozen-spec failures, not advisory preferences, and each is supported by concrete source behavior rather than a missing-assertion claim alone.

Advisory follow-up is limited to a composed unreadable-to-unavailable perimeter test (`src/lib/perimeter/perimeter.ts:252-275`, B10/D8.11), a migrated disposable CI database for the opt-in SQL probes (`tests/db/invite-authority-parity.test.ts:18-70`, D8/D10), and plausible-email gating for proposal preview (`src/components/onboarding/PerimeterPreview.tsx:49-108`, B8/B10/D5).

## Decision

`changes_requested`.

Blocking findings are **1.3** (the visible selected company is omitted from untouched Team lookup binding, violating A5(b)/A13/A14), **3.1** (the three-field fixture does not automate D7/D8.16 through membership, 2FA and the real landing), and **4.1** (pending-invitation disclosure leaks across tenants and still derives observable authority work from hidden rows, violating A6/A19). Round-three findings 1.1 and 1.2 and the Gate 0 pairing defect are closed. Advisory findings are composed perimeter-error coverage, a hermetic migrated SQL harness, and malformed-email preview gating. No `PR APPROVED` comment was posted.
