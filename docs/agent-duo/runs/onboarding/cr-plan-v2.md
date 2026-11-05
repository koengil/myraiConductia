---
run_id: onboarding
type: review
status: changes_requested
round: 2
source: plan-v2.md
---

# Review: `plan-v2.md`

## 1. Coverage of every frozen-spec acceptance criterion

I re-reviewed the v1→v2 changes against every prior finding. The revised phase
flow, existing `/view` coverage, typed flag registration, role matrix, safe room
backfill, storage provisioning, document-wall matrix, and room-aware storage seam
substantively resolve prior findings 1.1, 1.2, 2.1, 3.1, 3.2, 5.2, and 5.4
(`plan-v2.md:39-89,94-103,163-207`). Criteria 1–15 and 17 now have milestone
coverage, subject to the invite correctness items in sections 3–5 below. The
feature-flag correction is still incomplete.

1.1. Put **every** changed behavior behind `platform_onboarding`, not only new
routes and mutations. M-flag gates invites, upload/download, and the phase field
(`plan-v2.md:209-215`), and M7 gates its UI, but M4's public accept page/lookup,
M5's changed behavior on the existing document-list and `/view` routes, and all
of M8's `/api/v1/me`, shell, picker, deal-home, and Team behavior have no stated
flag branch (`plan-v2.md:146-184,217-254`). This contradicts criterion 16's
requirement that flag-off behavior be unchanged (`spec-v3.md:152-153`) and the
rollback claim that “all new UI [is] hidden” (`plan-v2.md:265-269`). Specify the
off path for each of those existing/public surfaces and add route/render tests
that compare it with today's behavior.

## 2. Scope discipline

The changed role rules now stay within frozen scope. M3 constrains external
invitees to Seller/Buyer roles derived from their deal party, limits external
directors to own-company standard members, and server-rejects injected internal
roles; M6 restricts phase raises to the MD path (`plan-v2.md:94-103,193-206`).
The new nonce, fail-closed migration, compensation primitive, and deployment
runbook are supporting mechanics for approved behavior rather than product-scope
expansion. No additional round-two scope finding remains.

## 3. Migration and rollback

The room migration now fails closed, the private local-storage bucket is
provisioned, and the deploy/rollback ordering is explicit
(`plan-v2.md:39-64,256-269`). One new schema change deviates from the frozen
identity model.

3.1. Restore the global pending-email invariant. V2 changes the partial unique
index to `(tenant_id, email)` (`plan-v2.md:20-27`), but the approved data model
requires `(email) WHERE status='pending'` because one email means one account
(`brief.md:47`), and `public.users.email` is globally unique in the current
schema. The tenant-scoped index permits two tenants to issue simultaneous live
invites that cannot both become accounts. Keep the pending uniqueness and
active-account check global, while separately enforcing tenant coherence on the
chosen invite during acceptance; add a concurrent cross-tenant invite test.

## 4. Edge cases

The lazy expiry, nonce rotation, conditional accept, accept-versus-revoke tests,
monotonic phase retry, and per-item UI state are strong improvements. Two edited
flows still cannot recover correctly as written.

4.1. Reorder invite creation so the row exists before generating its Supabase
credential. The route currently calls `generateLink` with `invite_id` metadata
before `create_invite` returns that ID (`plan-v2.md:106-123`), which is
impossible. It would also let the auth-user trigger create an active
`public.users` row before the RPC performs its active-account check. Define a
recoverable sequence that first validates/reserves the invite and nonce, then
generates the Supabase link with the known ID and trusted metadata, sends it,
and finally records successful delivery; cover failures and retries at every
boundary.

4.2. Do not treat every duplicate-pending 409 as successful Gate 0 delivery.
M3 deliberately leaves an invite pending when Resend fails
(`plan-v2.md:121-125`), while M7 says a retry that receives duplicate-pending
409 is success (`plan-v2.md:227-233`). That can show a sent chip even though no
email was delivered. Give create attempts an idempotency/delivery identity, or
return enough authoritative state for the failed chip to invoke resend; test
the exact create-succeeded/email-failed/retry path.

## 5. Technical and security soundness

The most important document boundary is now sound on paper: the plan applies a
server-side predicate plus tenant/deal/document coherence to list, upload,
`/view`, and download, and explicitly tests direct-ID access to Internal and
class-4 MNPI documents at every phase (`plan-v2.md:163-191`). External users
cannot rely on client gating to cross that wall. Two invite-side security and
consistency gaps remain.

5.1. Make pre-acceptance containment authoritative across the whole app and
make the `auth.uid()` RPC call path executable. M4 promises only that an
unaccepted user gets 403 from “deal APIs” and no shell (`plan-v2.md:155-160`),
but `generateLink` creates an auth identity whose current trigger produces an
active profile; an invited internal colleague is also `is_external=false`.
Authentication alone therefore cannot distinguish that account from an
accepted user, and current middleware checks only for an auth user. Define a
server-side accepted/onboarding-state predicate used by middleware and every
relevant `/api/v1` entrypoint—not just deal routes—so unaccepted, expired, or
revoked internal and external invite identities cannot enter the platform.
Also state that `accept_invite`, which derives `auth.uid()`
(`plan-v2.md:110-118`), is invoked with the user's session-bound Supabase client
rather than the service-role client (where `auth.uid()` is null). Add tests for
company/search APIs, `/api/v1/me`, shell routing, and direct deal access before
and after acceptance and revocation.

5.2. Make invite delivery state and audit truthful under failures. The proposed
`create_invite` RPC writes `invite_sent` before Resend is called
(`plan-v2.md:106-125`), so a 502 email failure produces a false compliance
event. Resend and revoke also mutate status/nonce and write audit in route prose,
but no transactional RPC or equivalent protocol is named
(`plan-v2.md:127-143`). Define an idempotent delivery/finalization protocol so
`invite_sent` is recorded only for a delivered credential, and make nonce
rotation/revocation plus their required audit writes atomic. Failure-injection
tests must cover link generation failure, send success followed by finalize
failure, resend failure, and revoke-audit failure without losing recoverability
or producing a false audit trail.
