---
run_id: smart-onboarding
type: review
status: approved
round: 6
source: prr-149-r6.md
---

# Review — prr-149-r6.md

## 1. Frozen scope and completeness

I reviewed implementation commit `0c5f7605efc4cf8cb411e6eabfc7963bb0889ae1` and the complete PR diff against `develop` at `8c2090192fbc25996df6a5ffa8be5913c40f62dc`, using the frozen `brief.md` and `spec-v2.md` as authority. The two blocking findings from round five are closed in shipped code rather than only described as closed. The frozen artifacts were not changed.

Round-five finding **4.1 is closed**. `userCanManageInvite` now starts all four reads before making any decision: actor, invited company, deal, and actor seat on that deal (`src/lib/api/v1/access.ts:444-464`). A company-scoped or absent invitation substitutes the valid zero UUID for the deal and still performs real `deals` and `deal_memberships` queries (`access.ts:5-6,449-463`). Only after every result resolves does the function apply tenant coherence and the established administrator, external director, deal MD, bank director, delegated-seat, and company-director rules (`access.ts:466-484`). Hidden row values now affect lookup values only, not the number, order, filter shape, or branching depth of the reads. This closes A19/D8.4's hidden-versus-absent work oracle without authorizing against a substitute resource.

Round-five finding **3.1 is closed**. The deterministic D7 walk now begins with the real Team invitation surface, carries one composed invitation through lookup, preview, send, verification, TOS-gated acceptance, acceptance-created membership, the real two-factor client, the protected AAL boundary, and the matching welcome brief (`tests/onboarding-e2e.test.ts:130-186,435-573`). Team remains the correct seller-email surface after a deal exists; Gate 0 remains separately covered for its bank-colleague flow. This is sufficient automated coverage for D7/D8.16 and does not change the frozen D4 acceptance or 2FA implementation.

The round-six production delta is confined to the shared invitation-authority predicate and lookup caller. It adds no crawler, external intelligence source, autonomous grant, new invitation state, persisted preview, new destination, or adjacent workflow. The approved three-part experience remains lookup, server-authoritative perimeter preview, and the post-acceptance welcome brief.

## 2. Correctness and approved-surface behavior

The authority refactor preserves the previous verdicts. The extracted `inTenant`, `directorOf`, `holdsMdSeat`, and `holdsDelegatedSeat` predicates are direct row-level forms of the rules the branching helpers already applied (`src/lib/api/v1/access.ts:8-27`). The ordinary company/deal helpers retain their existing read schedules and fail-closed wrappers; the new constant-shape behavior is limited to `userCanManageInvite`, where A19 requires it. The complete authority suite remains green, including the same-tenant admin, cross-tenant admin, external director, company director, deal MD, bank director, delegated seat, missing row, and read-failure cases.

Collapsing lookup from dual-shape evaluation to one call is correct now. The route passes the actual pending invitation's company/deal shape, or a sentinel company plus null deal when no invitation exists, and discloses the warning only when both the row and its real-resource verdict exist (`src/app/api/v1/invites/lookup/route.ts:320-356`). It no longer authorizes a hidden invitation by asking about a different company-scoped resource, the defect identified in round three. Tenant coherence remains inside the predicate before the administrator branch (`src/lib/api/v1/access.ts:466-475`), so cross-tenant pending invitations stay invisible.

The end-to-end membership is no longer preinstalled. The test store begins with `membership: null`; mocked `accept_invite` constructs it from the exact invitation fields written by `create_invite` (`tests/onboarding-e2e.test.ts:130-183`). The walk reads the real perimeter before acceptance and observes denial, then verifies the email code, proves the TOS refusal occurs before the RPC, accepts, and observes the resulting stored seat (`tests/onboarding-e2e.test.ts:435-482`). A wrong sent company, role, or phase therefore changes or breaks the ending instead of being masked by an agreeing fixture.

The second-factor portion is also substantive. The test renders `TwoFactorPageClient`, asserts the real challenge id and entered code reach `mfa.verify`, permits navigation only after assurance becomes AAL2, and verifies the existing MFA audit endpoint (`tests/onboarding-e2e.test.ts:484-544`). `vi.importActual('@/lib/api/v1/http')` obtains the real `requireApiUser` implementation; the partial mock supplies only its external Supabase factories, allowing the test to prove that the same valid invitee session is refused at AAL1 and admitted at AAL2 (`tests/onboarding-e2e.test.ts:546-573`). That assertion is not hollow and production D4 behavior is walked, not modified.

## 3. Security, lifecycle, flags, and audit semantics

The four-query authority schedule is input-independent at the application-policy level. `Promise.all` starts the same query builders on every call, `NO_SUCH_ROW` is a syntactically valid UUID that reaches the real database rather than skipping a read, and no return or policy branch occurs until all four promises resolve (`src/lib/api/v1/access.ts:449-466`). Real database cache and index effects can never be made mathematically identical for arbitrary values, but the prior exploitable code-path difference is gone: hidden invitation existence no longer determines whether a query is issued or a deeper branch is entered. A19 requires indistinguishability of invisible and absent facts, and this implementation provides a constant application query shape while preserving the correct real-resource verdict.

The rest of the lifecycle remains intact. The phase migration continues to validate credential, identity, tenant, invitation shape, verification, and authority before granting the stored phase, with the established lock ordering and grant/audit behavior unchanged (`supabase/migrations/20260808120000_invite_phase.sql:63-135,315-395`). Send, verification, acceptance, TOS, phase grant, member management, document view/download, storage/Box, middleware, and production 2FA code are untouched by round six.

The document wall is unchanged and still evaluates the absolute Internal-room exclusion before classification-4 MNPI, then external phase (`src/lib/api/v1/documentAccess.ts:85-100`), preserving B5/B6/C10. Lookup and preview remain gated by `platform_onboarding`; flag-off behavior still returns before authentication/body work. Read-only lookup, preview, and welcome paths remain audit-neutral, while send, acceptance, TOS, MFA, phase change, view, and download retain their existing audit meanings. The secret scan found no verification code, invitation credential, session/storage token, private key, or real secret in the delta, satisfying D3/D4.

## 4. Evidence and edge-case quality

The repaired A19 test is capable of catching the historical defect. Its query harness records both table and filter-column shape (`tests/lookup-indistinguishable.test.ts:34-62`), and it compares the correct three worlds for the same request: no pending invitation, an invisible company-scoped invitation, and an invisible deal-scoped invitation (`tests/lookup-indistinguishable.test.ts:250-292`). It asserts byte-identical responses, identical schedules, and the presence of all four authority reads. Recording column shapes rather than values is appropriate: values must differ between worlds, while a regression in conditional deal/company work changes the recorded schedule. The positive disclosure controls and direct verdict tests prevent equality from passing merely because the route always suppresses every warning.

Independent local verification passed:

- `npx eslint .`: exit 0 with eight pre-existing warnings and no errors.
- `npx tsc --noEmit`: clean.
- `npx vitest run`: 129 files passed, four skipped; 895 tests passed, six skipped.
- `npm run build`: compiled, typechecked, and generated all 38 static pages.
- Focused authority, lookup, perimeter, flag, audit, secret, migration-carry, welcome, and E2E coverage: 19 files and 196 tests passed.
- The A19 and onboarding E2E files passed together five consecutive times, 10/10 each run.
- `npm audit --omit=dev`: zero vulnerabilities; the only override is the previously accepted `nanoid@3.3.18` pin.

GitHub reports PR 149 open, draft, merge-clean, and green for lint/typecheck/test/build, dependency audit, Vercel, and Vercel Preview Comments at exact docs head `65fd71b4898fab77d46cbb52d935cd3b6200b676`. `git diff --check` is clean.

Three evidence improvements remain **advisory, not blocking**. The composed member/viewer unreadable-to-unavailable path is still proven by source composition and lower-level assertions rather than one route-level test (`src/lib/perimeter/perimeter.ts:252-275`, B10/D8.11). The SQL authority, acceptance, and rollback probes exist but are not CI-wired to a disposable migrated database; the configured database still lacks `invites.phase` and the nine-argument `create_invite` (`tests/db/invite-authority-parity.test.ts:19-70`). The cross-tenant invitation verdict has direct predicate coverage but no duplicate route-level negative (`tests/access-invites.test.ts:192-221`, A6/A19/D8.2/D8.4). None is evidence of a contradictory shipped path, and the mandatory gates plus direct tests cover the implementation decisions they protect.

## 5. Delivery quality and consistency

The complete feature remains consistent with the frozen product model. Lookup recommendations are advisory; visible inputs and request bindings remain aligned; the authoritative preflight/send rechecks live role, company, deal, domain, and phase state. Preview remains server-authoritative, read-only, fail-closed, race-aware, and parity-tested against real access. Welcome content remains derived from the viewer's current server-side seat and limited to permitted external-shell destinations.

No API, OpenAPI, schema, feature-flag, rollback, UX, accessibility, or responsive contract was invalidated by round six. The refactor improves the security property at the authority boundary without widening who may invite, manage an invitation, accept, raise phase, upload, view, or download. The D7 test now joins the UI/handler continuity that can be tested hermetically, while the real SQL probe remains the appropriate proof for the database grant and stored-phase audit.

No blocking frozen-spec deviation, unresolved correctness defect, sensitive-metadata leak, audit mutation, secret exposure, or scope drift remains in the reviewed head.

## Decision

`approved`.

Both round-five blockers are closed: **4.1** now uses a constant four-read real-resource authority schedule satisfying A19/D8.4, and **3.1** now proves acceptance-derived membership plus real challenge→verify→AAL2→protected-welcome continuity satisfying D7/D8.16 while preserving D4. The composed perimeter-error integration test, migrated CI database, and route-level cross-tenant duplicate test remain advisory only. The exact `PR APPROVED` comment may be posted.
