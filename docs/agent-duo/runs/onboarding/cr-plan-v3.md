---
run_id: onboarding
type: review
status: changes_requested
round: 3
source: plan-v3.md
---

# Review: `plan-v3.md`

## 1. Coverage of every frozen-spec acceptance criterion

I re-reviewed only the v2→v3 changes and their interaction with the frozen
plan. The revision now covers the previously missing flag branches, restores
global pending-email uniqueness, creates the invite row before link generation,
tracks delivery state for Gate 0 recovery, contains invited identities across
the app, invokes acceptance with a session-bound client, and moves delivery and
revoke audit writes into named RPC transitions (`plan-v3.md:27-45,86-153,
155-172,182-245`). Criteria 1–17 otherwise remain mapped, including the
server-side Internal-room/class-4 MNPI wall and its direct-ID matrix tests
(`plan-v3.md:174-192`). The remaining changed-flow blockers are below.

## 2. Scope discipline

Role, phase, shell, storage, and document behavior remain within the frozen
scope. One new mechanism contradicts an approved architectural boundary.

2.1. Keep `handle_new_auth_user` untouched. The approved brief explicitly
freezes that trigger as untouched and assigns company/deal provisioning to the
accept RPC (`brief.md:62-64`), but v3 changes the trigger to read `status` from
raw metadata (`plan-v3.md:38-45,255-260`). Preserve the trigger and establish
the authoritative pre-accept state outside it—for example, set a server-owned
onboarding marker immediately after admin link generation, before any
credential is delivered, or derive containment from a server-owned invite/user
association. Keep the same whole-app containment tests; do not trust client-
controlled signup metadata as the access-state authority.

## 3. Migration and rollback

The v3 migration restores the frozen global `(email) WHERE status='pending'`
index, keeps the fail-closed legacy-room backfill, provisions a private bucket,
registers the typed flag, and retains explicit forward/rollback order
(`plan-v3.md:20-64,247-252`). Subject to removing the trigger mutation in 2.1,
no migration or rollback blocker remains.

## 4. Edge cases

The row-first creation order, authoritative delivery chip state, retry-via-
resend path, nonce rotation, lazy expiry, conditional acceptance, and fan-out
recovery now address the prior round's edge cases. The global duplicate path
needs one security-sensitive distinction.

4.1. Scope duplicate-pending recovery before returning an invite ID or enabling
resend. `create_invite` now returns the existing invite ID and delivery status
for any global email collision, and Gate 0 uses that ID to call resend
(`plan-v3.md:96-101,138-142,220-225`). With a global index, the winning pending
invite may belong to another tenant/company/deal. Return ID/delivery state only
when the actor is authorized for that same invite scope; make a cross-tenant or
otherwise out-of-scope collision an opaque 409 that cannot drive resend. Add a
concurrent cross-tenant test proving the losing actor learns no invite ID/state
and cannot rotate or resend the other tenant's credential.

## 5. Technical and security soundness

The document boundary remains technically sound: every list/upload/view/
download path uses server-side actor/membership/document predicates plus
tenant/deal/document coherence, and tests prove external users cannot retrieve
Internal-room or class-4 MNPI documents at any phase (`plan-v3.md:174-192`).
Session-bound `auth.uid()` acceptance and whole-app pre-accept containment are
also correctly named. One delivery/audit race remains.

5.1. Require a finalized delivered credential before acceptance. V3 records
`invite_sent` only when `finalize_invite_delivery` changes `unsent→sent`, but
`accept_invite` conditions only on pending status, expiry, and nonce
(`plan-v3.md:102-124`). The plan explicitly permits Resend success followed by
finalize failure (`plan-v3.md:131-136`), so the recipient can use the already
delivered link and complete acceptance while `delivery_status` is still
`unsent` and no `invite_sent` audit exists, contradicting the complete audit
criterion (`spec-v3.md:149-151`). Make acceptance require
`delivery_status='sent'`; define a durable/idempotent finalize retry or
reconciliation path for send-success/finalize-failure, and test that the
delivered-but-unfinalized link cannot accept until recovery records the single
delivery audit.
