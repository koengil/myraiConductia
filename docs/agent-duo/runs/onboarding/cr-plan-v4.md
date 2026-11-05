---
run_id: onboarding
type: review
status: changes_requested
round: 4
source: plan-v4.md
---

# Review: `plan-v4.md`

## 1. Coverage of every frozen-spec acceptance criterion

I re-reviewed only the v3→v4 diff and its interaction with the frozen plan, as
authorized for round 4. The revision correctly adds scoped duplicate recovery
and finalized-delivery acceptance, and it preserves the previously reviewed
criteria, including the server-side Internal-room/class-4 MNPI wall
(`plan-v4.md:92-193,213-227`). The trigger correction is incomplete against one
explicit approved-brief requirement.

1.1. Keep `handle_new_auth_user` untouched **and** pass the brief-required
`is_external` metadata to `generateLink`. The brief freezes the trigger while
explicitly requiring that metadata carry `is_external` (`brief.md:62-64`), and
the existing untouched trigger consumes that field when it mirrors
`public.users` (`supabase/migrations/20260604100000_permissions_schema.sql:174-178`).
V4 instead sends metadata `{invite_id}` only (`plan-v4.md:143-148`), so an
external invite creates a temporarily misclassified internal profile. Retain
the sound server-owned step 3b for `status='invited'`, but pass at least
`{invite_id, is_external}` and add a trigger-untouched test proving external
and internal invite identities are mirrored with the correct classification
before delivery.

## 2. Scope discipline

The v4 changes remain within the frozen invite lifecycle and authorization
scope. Moving only the onboarding-status transition out of the trigger and
into a server-owned pre-delivery update is an appropriate response to prior
finding 2.1 (`plan-v4.md:41-50,143-162`); finding 1.1 above asks only that this
mechanism preserve the separate metadata behavior already mandated by the
brief.

## 3. Migration and rollback

The diff leaves the previously accepted fail-closed document backfill, private
bucket, typed feature flag, global pending-email index, and explicit
deployment/rollback order unchanged (`plan-v4.md:20-70,285-290`). Widening
`users.status` with `invited` still supports the server-owned containment step,
and the new trigger-parity test provides a concrete migration guard. No new
migration or rollback blocker was introduced.

## 4. Edge cases

Prior finding 4.1 is resolved. `userCanManageInvite` requires tenant coherence
and exact invite-scope authority before disclosing an ID/state or permitting
list, resend, or revoke; other collisions return an opaque 409, and the plan
adds both cross-tenant isolation tests and neutral Gate 0 handling
(`plan-v4.md:92-97,108-116,170-183,256-271`). The changed duplicate path no
longer leaks or operates on another tenant's pending invite.

## 5. Technical and security soundness

Prior finding 5.1 is resolved: acceptance now requires
`delivery_status='sent'`, while a valid presented nonce can idempotently
reconcile a send-success/finalize-failure by recording the single
`invite_sent` audit before acceptance; an invalid nonce cannot finalize
(`plan-v4.md:117-142,158-169,188-193`). The reviewed diff preserves whole-app
pre-accept containment and the server-side list/upload/view/download
predicates that absolutely deny external access to Internal-room and class-4
MNPI documents at every phase (`plan-v4.md:98-103,213-227`). Subject to finding
1.1, no additional race, access-control, audit, or data-loss blocker remains.
