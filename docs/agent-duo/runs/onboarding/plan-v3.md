---
run_id: onboarding
type: plan
round: 3
spec: spec-v3.md
---

# Plan: Onboarding — Buyer/Seller Invites + Box Data Room (v3)

Implements frozen `spec-v3.md`. Architecture per `brief.md`. Branch
`duo/onboarding` off `origin/develop`; PR base `develop`; remote
`git@github.com-fp:FutureProofingDev/intelibank.git`. Gate after every
milestone: `npm run test && npm run lint`; full gate incl. `npm run build`
before PR. `.env.local` (Resend + Box keys) copied from the main checkout,
never committed. One commit per milestone, conventional style.

## M1 — Schema, constants, flag

Files:
- `supabase/migrations/20260731120000_onboarding_invites.sql`:
  - `invites` table: `tenant_id`, `email` (stored lowercased), `invited_by`,
    `company_id`, `company_role` CHECK (`director|member`), nullable
    `deal_id` + `deal_role` CHECK mirroring `deal_memberships`, `status`
    CHECK (`pending|accepted|revoked|expired`), `delivery_status` CHECK
    (`unsent|sent`) default `unsent` (truthful-delivery state — review
    5.2), `credential_nonce uuid`, `expires_at` default now()+7d,
    `accepted_at`, `accepted_user_id`. Partial unique index on (`email`)
    where `status='pending'` — **global**, not tenant-scoped, because one
    email means one account and `users.email` is globally unique (review
    3.1). Tenant coherence is enforced at acceptance instead.
  - State machine (migration comment): `pending → accepted` (accept RPC,
    conditional), `pending → revoked` (revoke RPC, conditional),
    `pending → expired` (lazy locked transition inside create/resend/
    accept). Terminal states never revive; "resend" of a terminal invite =
    fresh row (global index only blocks `pending`). Resend of a `pending`
    invite rotates `credential_nonce` + extends `expires_at`, killing
    previously mailed links.
  - `users.status` CHECK widened with `invited`
    (`active|suspended|invited`; constants mirror updated). The auth
    trigger `handle_new_auth_user` reads `status` from
    `raw_user_meta_data` (default remains `active` for legacy/seed paths);
    the invite flow always passes `status='invited'`. This is the
    authoritative pre-acceptance containment state (review 5.1) and what
    the active-account check keys on: "active account" = users row with
    status ≠ `invited` (see M3).
  - Widen `audit_log.action` CHECK with
    `invite_sent|invite_accepted|invite_revoked` (drop-and-re-add).
  - `documents` room migration, staged fail-closed (unchanged from v2):
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
(legacy docs end `internal`); concurrent cross-tenant invite test — two
tenants inviting the same email: exactly one live pending survives (review
3.1); gate.

## M2 — Storage seam (room-aware) — unchanged from v2

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
  - `userCanInvite(actor, target)` (unchanged from v2): bank MD/deal-team
    with member-management → internal roles or external
    company+director|member with party-derived seller/buyer dealRole;
    external director → own company, `member` only, party-derived role,
    party deal only; internal roles server-rejected for external invitees.
  - `userIsOnboarded(user)` — status ≠ `invited` (review 5.1). Wired into
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
    (409); duplicate-pending check via the global partial index (409
    returning existing invite id + delivery_status — review 4.2); insert
    row `pending/unsent` + nonce. **No `invite_sent` audit here** (review
    5.2). Returns row.
  - `finalize_invite_delivery(p_invite_id)`: conditional
    `UPDATE … SET delivery_status='sent' WHERE status='pending'`;
    writes `invite_sent` audit in the same transaction, only on
    transition `unsent→sent` (idempotent — a repeat call is a no-op with
    no duplicate audit).
  - `rotate_invite_credential(p_invite_id)`: conditional on `pending`;
    rotates nonce, extends expiry, resets `delivery_status='unsent'`;
    returns new nonce. (Resend then follows the same
    link→send→finalize sequence; `invite_sent` is audited again on the
    new delivery — each delivered credential leaves an audit event.)
  - `revoke_invite(p_invite_id)`: conditional `pending→revoked` +
    `invite_revoked` audit, one transaction (review 5.2).
  - `accept_invite(p_invite_id, p_nonce)`: derives the accepting user
    from `auth.uid()`; **invoked with the session-bound Supabase server
    client (user JWT), never the service-role client, so `auth.uid()` is
    non-null** (review 5.1); conditional single-winner update (`WHERE
    status='pending' AND expires_at>now() AND credential_nonce=p_nonce`);
    validates normalized invite email = auth email AND
    invite.tenant_id coherence with the deal/company rows (tenant
    enforcement lives here, complementing the global index — review 3.1);
    sets `users.company_id`, `company_role`, `is_external`, `tenant_id`,
    `status='active'` in-transaction; inserts deal_membership (phase 0);
    audits `invite_accepted` + `grant`. All-or-nothing.
- Route sequencing for create (review 4.1 — row exists before credential):
  1. predicate check → 2. `create_invite` RPC (row + id + nonce reserved;
  no auth identity yet) → 3. `generateLink({type:'invite'})` with metadata
  `{status:'invited', is_external, tenant_id, invite_id}` (auth identity
  created here; trigger mirrors a `status='invited'` users row, which the
  active-account check deliberately ignores) → 4. Resend send → 5.
  `finalize_invite_delivery`. Failure semantics (review 5.2/4.2): failure
  at 3 or 4 → invite remains `pending/unsent`, response is an explicit
  error carrying the invite id and `delivery_status:'unsent'`, recovery =
  resend endpoint (rotate → link → send → finalize); failure at 5 after a
  successful send → retry finalize (idempotent); a rare double email from
  a subsequent resend is accepted and noted. No `invite_sent` audit ever
  exists without a delivered credential.
- Routes under `src/app/api/v1/invites/` (create/list/resend/revoke behind
  `requireFlag('platform_onboarding')`): POST (sequence above), GET (list,
  predicate-scoped), `[inviteId]/resend` POST, `[inviteId]` DELETE
  (revoke RPC), `accept/route.ts` POST (session-bound; flag-gated with the
  accept page — see M4; 410 expired/revoked/nonce-stale).
- `openapi/phase1.json` — the five operations.

Verify (route + RPC tests): who-may-invite matrix incl. all v2 negatives;
409 active-account (and: `invited`-status identity does NOT trip it); 409
duplicate-pending returns id + delivery state; lazy expiry re-invite;
concurrency double-accept / accept-vs-revoke; forged id, mismatched email,
cross-tenant id, `is_external` classification; failure injection per
boundary: link-gen failure, send failure (unsent state + resend recovery),
send-success-finalize-failure (idempotent retry, single audit),
revoke-audit atomicity (review 5.2); audit truthfulness: `invite_sent`
count equals delivered credentials. Gate.

## M4 — Accept page

Files:
- `src/app/accept-invite/page.tsx` (+ client) — Tier 1 unguarded route,
  but **flag-branched** (review 1.1): flag off → 404 (page and its lookup
  + accept endpoints), identical to today where the route does not exist.
  Flag on: Supabase invite-token verification → session; minimal
  no-auth lookup by invite id + nonce returning only inviter/company/
  codename display fields; collects display name + password; calls accept
  endpoint; redirects. Dead-ends for expired/revoked/nonce-stale.
- `src/middleware.ts` — exclude `accept-invite`; signed-in users with
  `status='invited'` are routed to the accept dead-end from any app route
  (containment — review 5.1).

Verify: RTL page states; flag-off 404 parity test; containment tests
before/after acceptance and after revocation across: `/api/v1/me`,
company/search APIs, deal APIs, shell routing (review 5.1); manual flow;
gate.

## M5 — Documents API over the seam (the wall, every path)

As v2 (predicates `userCanSeeDocument` — external+internal-room never,
external+class-4 never, phase gate — and `userCanUploadDocument`;
tenant/deal/document coherence on every handler; upload = bytes →
row+audit transaction → compensating delete; download = fail-closed audit
before stream; Box down → 502) with one addition (review 1.1):

- **Flag branch on the existing routes.** `documents` GET list and
  `/view`: flag off → exactly today's behavior (current access check, no
  room/phase/classification wall, no room filtering; legacy rows are
  bank-visible metadata as now); flag on → the new wall. Upload/download
  routes are new and simply 404 off (M-flag). Because external users
  cannot exist while the flag is off (invites are the only external
  path and they're gated), the off-branch never exposes internal rows
  externally.

Verify: v2's full matrix + failure injection, plus flag-off parity tests
for list and `/view` against current behavior (review 1.1). Gate.

## M6 — Phase control — unchanged from v2

Extend the existing members PATCH (preserving current behavior): `phase`
accepted only from the deal MD, monotonic raise, same-value idempotent
no-op, `grant` audit with `{from,to}`. Flag off → `phase` field rejected
as today (unknown field), parity-tested.

Verify: MD raises / deal-team rejected / downgrade 422 / idempotent /
audit; single + whole-team visibility tests; gate.

## M-flag — server-side flag enforcement (lands with M3)

`src/lib/api/v1/requireFlag.ts`: flag off → 404 for all NEW routes
(invites CRUD/accept + accept page lookup, documents upload/download) and
rejection of the new `phase` field; flag-BRANCH (not 404) for CHANGED
existing surfaces (documents list, `/view`, `/me` additions, shell/picker
— review 1.1). Flag-off tests for every touched endpoint assert parity
with pre-branch behavior.

## M7 — MD surfaces (flag-gated UI)

As v2 (Data Room destination; Working Group real swap with invite modal,
phase drawer, resend/revoke; Gate 0 `src/components/wizard/Gate0Wizard.tsx`
mini-form + queued chips; sequential per-chip state; step copy updated)
with corrected chip semantics (review 4.2):

- Chip states map to authoritative server state: `queued → creating →
  sent | created-email-failed | failed`. A create response (or
  duplicate-pending 409) carrying `delivery_status:'unsent'` renders
  `created-email-failed`, and its retry action calls **resend** (by the
  returned invite id), never create again. Only `delivery_status:'sent'`
  renders as sent. Partial failure is never summarized as complete.
- Whole-team phase fan-out unchanged (idempotent by M6 semantics,
  per-item state, retry-failed-only).

Verify: RTL — modal, drawer, Gate 0 queue incl. the exact
create-succeeded/email-failed/retry-via-resend path (review 4.2) and
partial-failure surfacing; team fan-out partial failure; flag-off snapshot
parity (c.16). Gate.

## M8 — External scoped shell

As v2 (me exposes `is_external`/`company_id`/`company_role`; external rail
= Deal / Data Room / Team, no command console; picker routing single →
direct, multi → minimal picker; scoped deal home; external Team page) with
flag branch (review 1.1): flag off → `/me` payload, shell nav, picker, and
project routes behave exactly as today (external users cannot exist while
off; the branch guards the code path regardless).

Verify: RTL render matrix (internal / external / invited-unaccepted);
routing tests; flag-off parity tests for me/shell/picker; manual
walkthrough; gate.

## M9 — Seed, demo, docs, deploy runbook, PR — unchanged from v2

Seed scenario; `api-v1.md`; decision log D41/D42/D43 + ADR-0011 with the
deploy/rollback runbook (forward: schema → bucket → flag off → box smoke →
enable; rollback: disable flag → parity behavior, additive schema inert);
demo script validated end-to-end (real Box + Resend), noted in PR body.
Full gate + PR to `develop`; reviewer → "PR APPROVED".

## Risks

As v2, plus: `users.status='invited'` touches the auth trigger — the
trigger change is additive (metadata-driven with `active` default) and
covered by seed + trigger tests so existing seed/legacy paths are
unaffected.

## Changes from v2 (review round 2)

- 1.1 → flag branches specified for M4 accept surfaces, M5 existing
  list//view, M6 phase field, M8 me/shell/picker; M-flag distinguishes
  404-new vs branch-changed; parity tests everywhere.
- 3.1 → global `(email) WHERE status='pending'` index restored; global
  active-account check; tenant coherence enforced in accept RPC;
  concurrent cross-tenant test (M1/M3).
- 4.1 → create sequence reordered: RPC row-first, then generateLink with
  known id; `invited` users.status keeps the trigger-created identity out
  of the active-account check.
- 4.2 → `delivery_status` column; 409 returns id + delivery state; chips
  keyed to authoritative delivery state; retry via resend; exact
  email-failed path tested (M3/M7).
- 5.1 → `users.status='invited'` containment enforced in `requireApiUser`
  for ALL /api/v1 entrypoints + middleware; accept RPC runs on the
  session-bound client (auth.uid() non-null); before/after tests incl.
  revocation (M1/M3/M4).
- 5.2 → audit truthfulness: `invite_sent` only in `finalize_invite_delivery`
  on `unsent→sent`; rotate/revoke RPCs atomic with their audits;
  failure-injection suite (M3).
