---
run_id: onboarding
type: plan
round: 5
spec: spec-v3.md
---

# Plan: Onboarding — Buyer/Seller Invites + Box Data Room (v5)

Implements frozen `spec-v3.md`. Architecture per `brief.md`. Branch
`duo/onboarding` off `origin/develop`; PR base `develop`; remote
`git@github.com-fp:FutureProofingDev/intelibank.git`. Gate after every
milestone: `npm run test && npm run lint`; full gate incl. `npm run build`
before PR. `.env.local` (Resend + Box keys) copied from the main checkout,
never committed. One commit per milestone, conventional style.

Round 4 is human-authorized past the 3-round cap (escalation resolved:
"one more round with the 3 fixes" — see `log-planner.md`). Round 5
repairs a regression the v4 edit itself introduced (metadata dropped the
brief-mandated `is_external`), per cr-plan-v4.md finding 1.1.

## M1 — Schema, constants, flag

Files:
- `supabase/migrations/20260731120000_onboarding_invites.sql`:
  - `invites` table: `tenant_id`, `email` (stored lowercased), `invited_by`,
    `company_id`, `company_role` CHECK (`director|member`), nullable
    `deal_id` + `deal_role` CHECK mirroring `deal_memberships`, `status`
    CHECK (`pending|accepted|revoked|expired`), `delivery_status` CHECK
    (`unsent|sent`) default `unsent` (truthful-delivery state), 
    `credential_nonce uuid`, `expires_at` default now()+7d,
    `accepted_at`, `accepted_user_id`. Partial unique index on (`email`)
    where `status='pending'` — **global**, not tenant-scoped, because one
    email means one account and `users.email` is globally unique. Tenant
    coherence is enforced at acceptance instead.
  - State machine (migration comment): `pending → accepted` (accept RPC,
    conditional), `pending → revoked` (revoke RPC, conditional),
    `pending → expired` (lazy locked transition inside create/resend/
    accept). Terminal states never revive; "resend" of a terminal invite =
    fresh row (global index only blocks `pending`). Resend of a `pending`
    invite rotates `credential_nonce` + extends `expires_at`, killing
    previously mailed links.
  - `users.status` CHECK widened with `invited`
    (`active|suspended|invited`; constants mirror updated).
    **`handle_new_auth_user` is NOT touched** (frozen per `brief.md`): the
    trigger keeps mirroring rows exactly as today. The `invited`
    containment state is set by a server-owned service-role update in the
    invite create route immediately after auth-identity generation and
    strictly before any credential is delivered (M3, review-r3 2.1).
    Containment authority is therefore server-owned row state, never
    client-controlled signup metadata. "Active account" = users row with
    status ≠ `invited` (see M3).
  - Widen `audit_log.action` CHECK with
    `invite_sent|invite_accepted|invite_revoked` (drop-and-re-add).
  - `documents` room migration, staged fail-closed (unchanged):
    add nullable `room` → backfill all rows `internal` → verify zero nulls
    → SET NOT NULL + CHECK (`internal|deal`), no default. Plus nullable
    `storage_provider`, `storage_file_id`, `size_bytes`, `content_type`.
- `supabase/migrations/20260731121000_dataroom_bucket.sql` — private
  Supabase Storage bucket `dataroom`, no anon/authenticated policies
  (service-role only).
- `src/lib/flags/keys.ts` — `platform_onboarding` in the typed
  FLAG_REGISTRY (source of truth); `scripts/seed-flags.ts` materializes.
  Default off.
- `src/lib/constants/invites.ts` (INVITE_STATUS, DELIVERY_STATUS), extend
  `audit.ts`, `documents.ts` (ROOM), `users.ts` (USER_STATUS + `invited`).

Verify: `npm run db:migrate` clean; `npm run check:db`; staged-backfill test
(legacy docs end `internal`); trigger-untouched test (auth insert mirrors
exactly as on develop — no behavior delta; external and internal invite
identities are mirrored with correct `is_external` classification before
delivery — review-r4 1.1); concurrent cross-tenant invite
test — two tenants inviting the same email: exactly one live pending
survives; gate.

## M2 — Storage seam (room-aware) — unchanged

`DataRoomStorage`: `upload(dealCode, room, name, contentType, bytes)`,
`downloadStream(fileId)`, `delete(fileId)` (compensation). `LocalStorage`
(bucket path `{dealCode}/{room}/…`), `BoxStorage` (client-credentials;
`/Conductia/{dealCode}/{internal|dealroom}`), `STORAGE_PROVIDER` env with
startup validation, `scripts/smoke-box.ts` (both rooms + delete).

Verify: LocalStorage round-trip per room; internal upload unreachable via
any deal-room derivation; delete removes; gate. Box smoke run once locally.

## M3 — Invite API + email

Files:
- `src/lib/api/v1/access.ts`:
  - `userCanInvite(actor, target)` (unchanged): bank MD/deal-team
    with member-management → internal roles or external
    company+director|member with party-derived seller/buyer dealRole;
    external director → own company, `member` only, party-derived role,
    party deal only; internal roles server-rejected for external invitees.
  - `userCanManageInvite(actor, invite)` (NEW, review-r3 4.1): true iff
    the actor is tenant-coherent with the invite AND passes
    `userCanInvite` for the invite's exact (company, deal, role) scope.
    Required by list/resend/revoke handlers and by duplicate-pending
    disclosure (below). Cross-tenant or otherwise out-of-scope actors
    never learn an invite id, its state, or rotate/resend its credential.
  - `userIsOnboarded(user)` — status ≠ `invited`. Wired into
    `requireApiUser` as the default: every `/api/v1` entrypoint (me,
    companies, deals, documents, roles, notifications, …) rejects
    non-onboarded identities with 403 `onboarding_incomplete`; the ONLY
    exception is `POST /api/v1/invites/accept`. Middleware routes
    signed-in `invited` users to the accept dead-end, never the shell.
- `src/lib/email/resend.ts` — invite email (inviter, company, codename,
  accept URL with invite id + nonce).
- `supabase/migrations/20260731130000_invite_rpcs.sql` (all
  security-definer, all writes + their audits atomic per RPC):
  - `create_invite(...)`: lazy-expire stale pendings for the email;
    active-account check = users row exists with status ≠ `invited`
    (409); duplicate-pending handling is **scope-aware** (review-r3 4.1):
    if the existing pending invite passes `userCanManageInvite` for the
    caller, 409 returns the existing invite id + delivery_status
    (recovery path); otherwise an **opaque 409**
    (`code: duplicate_pending`, no id, no state, no tenant/company
    detail). Insert row `pending/unsent` + nonce. No `invite_sent` audit
    here. Returns row.
  - `finalize_invite_delivery(p_invite_id)`: conditional
    `UPDATE … SET delivery_status='sent' WHERE status='pending'`;
    writes `invite_sent` audit in the same transaction, only on
    transition `unsent→sent` (idempotent — a repeat call is a no-op with
    no duplicate audit).
  - `rotate_invite_credential(p_invite_id)`: conditional on `pending`;
    rotates nonce, extends expiry, resets `delivery_status='unsent'`;
    returns new nonce. (Resend then follows the same
    link→send→finalize sequence, using the link type appropriate to a
    pre-existing invited auth identity; `invite_sent` is audited again on
    the new delivery — each delivered credential leaves an audit event.)
  - `revoke_invite(p_invite_id)`: conditional `pending→revoked` +
    `invite_revoked` audit, one transaction.
  - `accept_invite(p_invite_id, p_nonce)`: derives the accepting user
    from `auth.uid()`; **invoked with the session-bound Supabase server
    client (user JWT), never the service-role client, so `auth.uid()` is
    non-null**; conditional single-winner update — `WHERE
    status='pending' AND expires_at>now() AND credential_nonce=p_nonce
    AND delivery_status='sent'` (review-r3 5.1: acceptance requires a
    finalized delivered credential; no acceptance can ever precede its
    `invite_sent` audit); validates normalized invite email = auth email
    AND invite.tenant_id coherence with the deal/company rows (tenant
    enforcement lives here, complementing the global index); sets
    `users.company_id`, `company_role`, `is_external`, `tenant_id`,
    `status='active'` in-transaction; inserts deal_membership (phase 0);
    audits `invite_accepted` + `grant`. All-or-nothing.
- Route sequencing for create (row exists before credential; trigger
  untouched — review-r3 2.1):
  1. predicate check → 2. `create_invite` RPC (row + id + nonce reserved;
  no auth identity yet) → 3. `generateLink({type:'invite'})` with metadata
  `{invite_id, is_external, tenant_id}` — server-owned values from the
  invite row, preserving the brief-mandated metadata contract the
  untouched trigger consumes, so an external invitee's mirror row is
  correctly classified from the first insert (review-r4 1.1) — (auth identity created here; the untouched trigger
  mirrors a users row exactly as today) → **3b. server-owned containment:
  service-role `UPDATE public.users SET status='invited' WHERE id=<new
  auth id>` — idempotent, and safe because no credential has been
  delivered yet: the identity cannot have a session before the email
  exists** → 4. Resend send → 5. `finalize_invite_delivery`. Failure
  semantics: failure at 3, 3b, or 4 → invite remains `pending/unsent`, no
  email is sent (a 3b failure aborts before send so an uncontained
  identity never receives a credential), response is an explicit error
  carrying the invite id and `delivery_status:'unsent'`, recovery = resend
  endpoint (rotate → link → re-assert 3b containment → send → finalize);
  failure at 5 after a successful send → the delivered link self-heals at
  redemption (accept-route reconciliation below) or via resend; a rare
  double email from a subsequent resend is accepted and noted. No
  `invite_sent` audit ever exists without a delivered credential, and no
  delivered credential's acceptance can proceed without that audit.
- Accept-route reconciliation (review-r3 5.1): before invoking
  `accept_invite`, when the presented (id, nonce) matches a `pending`
  invite that is still `delivery_status='unsent'` (send succeeded,
  finalize failed), the route first calls `finalize_invite_delivery` —
  the valid presented nonce is proof of delivery — recording the single
  `invite_sent` audit, then proceeds to `accept_invite`. An invalid or
  stale nonce never triggers finalize.
- Routes under `src/app/api/v1/invites/` (create/list/resend/revoke behind
  `requireFlag('platform_onboarding')`): POST (sequence above), GET (list,
  predicate-scoped), `[inviteId]/resend` POST and `[inviteId]` DELETE
  (both guarded by `userCanManageInvite` — review-r3 4.1),
  `accept/route.ts` POST (session-bound; flag-gated with the
  accept page — see M4; 410 expired/revoked/nonce-stale).
- `openapi/phase1.json` — the five operations.

Verify (route + RPC tests): who-may-invite matrix incl. all negatives;
409 active-account (and: `invited`-status identity does NOT trip it);
duplicate-pending: in-scope actor gets id + delivery state, cross-tenant /
out-of-scope actor gets opaque 409 and cannot resend/rotate/revoke the
other invite (concurrent cross-tenant test proves the loser learns
nothing — review-r3 4.1); lazy expiry re-invite; concurrency
double-accept / accept-vs-revoke; forged id, mismatched email,
cross-tenant id, `is_external` classification; containment: post-3b the
users row is `invited` and every /api/v1 entrypoint 403s, and a simulated
3b failure aborts the sequence before send; failure injection per
boundary: link-gen failure, send failure (unsent state + resend recovery),
send-success-finalize-failure → accept attempt first records exactly one
`invite_sent` then accepts (reconciliation), while accept with
`delivery_status='unsent'` and an invalid nonce stays 410 with no finalize
(review-r3 5.1); revoke-audit atomicity; audit truthfulness: `invite_sent`
count equals delivered credentials. Gate.

## M4 — Accept page

Files:
- `src/app/accept-invite/page.tsx` (+ client) — Tier 1 unguarded route,
  but **flag-branched**: flag off → 404 (page and its lookup
  + accept endpoints), identical to today where the route does not exist.
  Flag on: Supabase invite-token verification → session; minimal
  no-auth lookup by invite id + nonce returning only inviter/company/
  codename display fields; collects display name + password; calls accept
  endpoint; redirects. Dead-ends for expired/revoked/nonce-stale.
- `src/middleware.ts` — exclude `accept-invite`; signed-in users with
  `status='invited'` are routed to the accept dead-end from any app route
  (containment).

Verify: RTL page states; flag-off 404 parity test; containment tests
before/after acceptance and after revocation across: `/api/v1/me`,
company/search APIs, deal APIs, shell routing; manual flow; gate.

## M5 — Documents API over the seam (the wall, every path) — unchanged

Predicates `userCanSeeDocument` (external+internal-room never,
external+class-4 never, phase gate) and `userCanUploadDocument`;
tenant/deal/document coherence on every handler; upload = bytes →
row+audit transaction → compensating delete; download = fail-closed audit
before stream; Box down → 502. **Flag branch on the existing routes:**
`documents` GET list and `/view`: flag off → exactly today's behavior;
flag on → the new wall. Upload/download routes are new and simply 404 off
(M-flag). Because external users cannot exist while the flag is off
(invites are the only external path and they're gated), the off-branch
never exposes internal rows externally.

Verify: full matrix + failure injection, plus flag-off parity tests
for list and `/view` against current behavior. Gate.

## M6 — Phase control — unchanged

Extend the existing members PATCH (preserving current behavior): `phase`
accepted only from the deal MD, monotonic raise, same-value idempotent
no-op, `grant` audit with `{from,to}`. Flag off → `phase` field rejected
as today (unknown field), parity-tested.

Verify: MD raises / deal-team rejected / downgrade 422 / idempotent /
audit; single + whole-team visibility tests; gate.

## M-flag — server-side flag enforcement (lands with M3) — unchanged

`src/lib/api/v1/requireFlag.ts`: flag off → 404 for all NEW routes
(invites CRUD/accept + accept page lookup, documents upload/download) and
rejection of the new `phase` field; flag-BRANCH (not 404) for CHANGED
existing surfaces (documents list, `/view`, `/me` additions, shell/picker).
Flag-off tests for every touched endpoint assert parity with pre-branch
behavior.

## M7 — MD surfaces (flag-gated UI)

As before (Data Room destination; Working Group real swap with invite
modal, phase drawer, resend/revoke; Gate 0
`src/components/wizard/Gate0Wizard.tsx` mini-form + queued chips;
sequential per-chip state; step copy updated), with chip semantics keyed
to authoritative server state:

- Chip states: `queued → creating → sent | created-email-failed | failed`.
  A create response (or in-scope duplicate-pending 409) carrying
  `delivery_status:'unsent'` renders `created-email-failed`, and its retry
  action calls **resend** (by the returned invite id), never create again.
  An **opaque** duplicate-pending 409 (out-of-scope collision) renders
  `failed` with a neutral "email unavailable for invite" message and no
  retry-via-resend (there is no id to act on — review-r3 4.1). Only
  `delivery_status:'sent'` renders as sent. Partial failure is never
  summarized as complete.
- Whole-team phase fan-out unchanged (idempotent by M6 semantics,
  per-item state, retry-failed-only).

Verify: RTL — modal, drawer, Gate 0 queue incl. the exact
create-succeeded/email-failed/retry-via-resend path, the opaque-409
`failed` rendering, and partial-failure surfacing; team fan-out partial
failure; flag-off snapshot parity (c.16). Gate.

## M8 — External scoped shell — unchanged

`me` exposes `is_external`/`company_id`/`company_role`; external rail
= Deal / Data Room / Team, no command console; picker routing single →
direct, multi → minimal picker; scoped deal home; external Team page;
flag branch: flag off → `/me` payload, shell nav, picker, and project
routes behave exactly as today.

Verify: RTL render matrix (internal / external / invited-unaccepted);
routing tests; flag-off parity tests for me/shell/picker; manual
walkthrough; gate.

## M9 — Seed, demo, docs, deploy runbook, PR — unchanged

Seed scenario; `api-v1.md`; decision log D41/D42/D43 + ADR-0011 with the
deploy/rollback runbook (forward: schema → bucket → flag off → box smoke →
enable; rollback: disable flag → parity behavior, additive schema inert);
demo script validated end-to-end (real Box + Resend), noted in PR body.
Full gate + PR to `develop`; reviewer → "PR APPROVED".

## Risks

As before, minus the trigger risk (the trigger is no longer modified —
review-r3 2.1). New note: the 3b containment update introduces a
milliseconds-wide window where the mirrored row is `active` before being
set `invited`; it is not exploitable because the identity has no delivered
credential and no session until step 4, and a 3b failure aborts before
send. Covered by the abort-before-send test.

## Changes from v3 (review round 3, human-authorized round 4)

- 2.1 → `handle_new_auth_user` restored to untouched (brief freeze).
  Containment is a server-owned service-role update (step 3b) setting
  `users.status='invited'` after link generation and before send;
  metadata no longer carries onboarding status (it retains the
  brief-mandated `is_external`/`tenant_id` identity fields); abort-before-send on 3b
  failure; trigger-untouched test added (M1/M3).
- 4.1 → duplicate-pending disclosure is scope-checked via new
  `userCanManageInvite`: in-scope 409 carries id + delivery state,
  out-of-scope collision is an opaque 409; resend/revoke guarded by the
  same predicate; concurrent cross-tenant test proves no leak; Gate 0
  renders opaque 409 as `failed` without resend (M3/M7).
- 5.1 → `accept_invite` additionally requires `delivery_status='sent'`;
  accept-route reconciliation finalizes (single `invite_sent` audit)
  before acceptance when a validly-nonced delivered link arrives
  `unsent`; invalid nonce never finalizes; send-success/finalize-failure
  path tested end-to-end (M3).

## Changes from v4 (review round 4)

- 1.1 → `generateLink` metadata restored to the brief's contract:
  `{invite_id, is_external, tenant_id}` (server-owned, from the invite
  row). The untouched trigger therefore classifies external invitees
  correctly at first insert; step 3b still owns only the `invited`
  onboarding status. Trigger-parity test extended to assert correct
  `is_external` classification for external and internal invite
  identities before delivery.
