---
run_id: onboarding
type: review
status: changes_requested
round: 1
source: plan-v1.md
---

# Review: `plan-v1.md`

## 1. Coverage of every frozen-spec acceptance criterion

The milestone structure covers most of the frozen surface: M3–M4 cover criteria
1–5, M7 covers 6 and 10, M2/M5/M7 cover 7–9 and 12–13, M8 covers 11, and M9
covers 17 (`plan-v1.md:40-184`). Criteria 14–16 are only partially covered.

1.1. Complete criterion 14's phase-control plan. M6 proposes a per-user `set
phase` route and tests only “authz + audit row,” while M7 merely names the UI
control (`plan-v1.md:123-150`). Specify a monotonic raise (not an arbitrary set
or downgrade), preserve the existing `canManageMembers` PATCH behavior already
implemented in `src/app/api/v1/deals/[dealId]/members/[userId]/route.ts:67-112`,
define how the approved N-PATCH team fan-out reports partial success and supports
idempotent retry, and test both single-member and whole-team visibility changes.
Those are the behaviors frozen by `spec-v3.md:90-91,147-148`.

1.2. Complete criterion 15 rather than relying on the current audit route. M3,
M5, and M6 name invite/grant/upload/download writes, but the plan never updates
or tests the existing document `view` endpoint (`plan-v1.md:59-130`). Today that
endpoint checks only deal access and then writes a view event
(`src/app/api/v1/deals/[dealId]/documents/[documentId]/view/route.ts:12-38`); it
does not apply the new room/classification/phase predicate. Add the view path to
M5, require actor and document attribution for every frozen verb, and add a
per-deal audit-view test proving all seven required event types appear
(`spec-v3.md:149-151`).

1.3. Complete criterion 16 at both code and API boundaries. M1 says to add the
flag in `scripts/seed-flags.ts`, but that script only materializes
`FLAG_REGISTRY`; the typed source of truth is `src/lib/flags/keys.ts:15-26`
(`scripts/seed-flags.ts:1-32`). M7/M8 and the risk section promise only UI
flagging (`plan-v1.md:132-168,193-194`), leaving M3–M6 callable directly with the
flag off. Update the typed registry, enforce `platform_onboarding` on every new
server route/mutation as well as every surface, and add flag-off route plus UI
regression tests. Correct the Gate 0 target to the existing
`src/components/wizard/Gate0Wizard.tsx`; the planned
`src/components/gate0/Gate0Wizard.tsx` does not exist (`plan-v1.md:144-147`).

## 2. Scope discipline

Most planned work stays within the frozen spec, including the docs/ADR work and
the explicit preservation of the bank-internal Team page. Two predicate grants
are broader or less constrained than the approved behavior.

2.1. Align server mutation authority exactly with the frozen roles. M6 says
“MD/deal-team-managed” actors may set phase (`plan-v1.md:125-128`), but the
approved behavior authorizes the MD to raise phases (`spec-v3.md:90-91`); do not
silently extend that power to delegated deal-team users. Conversely, M3 limits
an external director by company and company-role but does not constrain the
requested `dealRole` (`plan-v1.md:62-65`). Require an external director's grant
to remain a standard member with the Seller/Buyer deal role appropriate to that
party, and server-reject internal roles such as MD, Deal Team, or Legal. Add
negative predicate tests for both boundaries.

## 3. Migration and rollback

The new tables/columns are generally additive and the flag is a useful cutover,
but the proposed data migration and environment provisioning do not yet make a
safe rollout or rollback.

3.1. Replace the unconditional `room default 'deal'` migration with a safe
legacy-document strategy. Adding that default as written (`plan-v1.md:28-30`)
classifies every existing metadata row as externally eligible Deal Room content;
the current seed contains documents explicitly described as internal, while the
frozen wall says external users must never see Internal material
(`spec-v3.md:83-88,141-144`). Add the column without an external-visible default,
backfill every existing row deliberately (safe default `internal` unless mapped),
verify the backfill, and only then add the final nullability/default constraint.
Document how app rollback remains safe after this migration.

3.2. Add an explicit deploy/rollback sequence for storage and the feature flag.
M2 assumes a Supabase Storage `dataroom` bucket (`plan-v1.md:46-57`), but the
current migration set provisions no storage bucket or policies. Name the bucket
provisioning and access model, provider/env validation, schema migration, typed
flag seeding, Box smoke gate, flag enablement order, and the reverse order for a
rollback. Disabling the flag must leave the old application behavior usable even
when the additive schema remains.

## 4. Edge cases

The plan names the basic 409/410 paths, but it does not close the state-machine
and multi-request failure cases that the chosen Supabase and client-fan-out
mechanics create.

4.1. Define and test the full one-time invite state machine. A timestamp passing
does not change a row from `pending` to `expired`, so the proposed partial unique
index continues blocking a new invite unless create/resend performs a lazy,
locked transition (`plan-v1.md:20-26,74-86`). Specify legal transitions for
pending/accepted/revoked/expired, whether resend reactivates or replaces an
expired/revoked credential, how expiry is extended and the old credential is
invalidated, and how simultaneous accept/resend/revoke requests are serialized.
The accept RPC must lock or conditionally update the row so exactly one
redemption wins; add concurrent double-accept and accept-versus-revoke tests.

4.2. Specify recoverable partial-success behavior for the two approved client
fan-outs. Gate 0 sends one POST per queued chip (`plan-v1.md:144-147`) and the
whole-team phase action sends N PATCHes (`plan-v1.md:126-128`), but neither plan
describes what the user sees if request k fails after earlier requests succeed.
Require stable idempotency/duplicate handling, per-item success/error state,
retry of only failed items, and tests showing that a partial failure is never
reported as complete or silently discarded.

## 5. Technical and security soundness

The intended document predicate order is correct and M5 explicitly calls for the
critical external × room × classification × phase matrix
(`plan-v1.md:102-121`). The invitation identity boundary, service-role tenant
boundary, storage room seam, and synchronous side effects still have exploitable
or data-consistency gaps.

5.1. Bind acceptance to the actual invited identity and create external accounts
as external. The plan passes `user_id` into a security-definer-style RPC and
only says to validate pending/unexpired (`plan-v1.md:68-72,80-81`). It never says
the route derives that ID from the authenticated session or that the RPC proves
the locked invite's normalized email and tenant match that auth user. It also
omits the approved `is_external` metadata (`brief.md:62-64`); the current auth
trigger otherwise defaults `is_external=false` and a fixed dev tenant
(`supabase/migrations/20260604100000_permissions_schema.sql:153-188`). Pass
trusted tenant/external metadata in the Supabase invite flow or set it inside the
transaction, derive rather than accept the caller's user ID, validate
email/tenant/company/deal coherence, and ensure an unaccepted or revoked auth
user cannot enter the internal shell or APIs. Test forged invite IDs, a different
signed-in email, cross-tenant IDs, and external-account classification.

5.2. Apply the wall to every document-specific server path, not just list and
download. Extend M5 so list, metadata/view, upload, and download all resolve the
actor and same-deal membership server-side before returning metadata, touching
storage, or writing audit; the existing `/view` route is currently an uncovered
bypass as noted in item 1.2. Because these handlers use the service-role client,
also require tenant/deal/document coherence rather than relying on RLS. Keep the
explicit tests for direct-ID attempts against Internal and class-4 documents at
every phase, plus wrong-deal and cross-tenant IDs.

5.3. Make business state, external side effects, and synchronous audit converge
under failure. The plan is transactional only for accept. Create/resend/revoke
combine database state, Supabase credentials, Resend, and audit; upload combines
Box bytes, a document row, and audit; download combines a stream and audit
(`plan-v1.md:66-81,110-121`). Define transactional RPCs where possible and
idempotency/compensation where they are not: no successful business mutation
without its required audit, no orphaned Box object after a database/audit
failure, no delivered credential without an authoritative invite state, and no
silent audit failure. Add failure-injection tests at every boundary, not only
“Box failed before row insert.”

5.4. Make the storage seam capable of preserving the room split it promises.
`ensureDealFolder(dealCode)` returns one folder and `upload(folderId, …)` has no
room input, yet Box is supposed to place bytes under distinct `internal` and
`dealroom` children (`plan-v1.md:43-50`). Use a server-derived, room-aware folder
reference (never a client-supplied Box folder ID), verify it belongs to the deal,
and add the delete/compensation capability required by item 5.3. Test that an
Internal upload cannot land in or be read from the Deal Room path in either Box
or LocalStorage.
