---
run_id: onboarding
type: plan
round: 2
spec: spec-v3.md
---

# Plan: Onboarding — Buyer/Seller Invites + Box Data Room (v2)

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
    CHECK (`pending|accepted|revoked|expired`), `credential_nonce uuid`
    (rotated on resend; embedded in accept URL), `expires_at` default
    now()+7d, `accepted_at`, `accepted_user_id`. Partial unique index on
    (`tenant_id`, `email`) where `status='pending'`.
  - State machine (documented in migration comment): `pending → accepted`
    (accept RPC, conditional update), `pending → revoked` (DELETE route,
    conditional update), `pending → expired` (lazy transition performed
    inside create/resend/accept, `UPDATE … WHERE status='pending' AND
    expires_at < now()`). `accepted|revoked|expired` are terminal; "resend"
    of a terminal invite = create a fresh row (uniqueness allows it since
    only `pending` blocks); resend of a `pending` invite rotates
    `credential_nonce` + extends `expires_at` on the same row, which kills
    previously mailed links (nonce mismatch).
  - Widen `audit_log.action` CHECK with
    `invite_sent|invite_accepted|invite_revoked` (drop-and-re-add pattern).
  - `documents` room migration, staged for legacy safety (review 3.1):
    (a) `ALTER TABLE documents ADD COLUMN room text` (nullable, NO default);
    (b) backfill `UPDATE documents SET room='internal'` — every pre-existing
    row is internal-only until deliberately reclassified (fail-closed);
    (c) verify `SELECT count(*) FROM documents WHERE room IS NULL` = 0;
    (d) `ALTER … SET NOT NULL`, add CHECK (`internal|deal`), no column
    default — every insert path states room explicitly.
    Rollback note: schema is additive; app rollback to pre-flag code ignores
    the column and existing behavior is unchanged.
  - Also add to `documents`: `storage_provider text`, `storage_file_id
    text`, `size_bytes bigint`, `content_type text` (all nullable — legacy
    rows have no bytes).
- `supabase/migrations/20260731121000_dataroom_bucket.sql` — provision
  private Supabase Storage bucket `dataroom` (insert into `storage.buckets`,
  `public=false`, no anon/authenticated policies: access is exclusively
  service-role via the app, consistent with app-layer enforcement)
  (review 3.2).
- `src/lib/flags/keys.ts` — add `platform_onboarding` to the typed
  FLAG_REGISTRY (source of truth); `scripts/seed-flags.ts` picks it up
  (review 1.3). Default off.
- `src/lib/constants/invites.ts` (INVITE_STATUS), extend
  `src/lib/constants/audit.ts` and `documents.ts` mirrors (ROOM).

Verify: `npm run db:migrate` clean; `npm run check:db`; migration-order test
of the staged room backfill against seeded data (legacy docs end up
`internal`); gate.

## M2 — Storage seam (room-aware)

Files:
- `src/lib/storage/types.ts` — `DataRoomStorage` (review 5.4: room-aware,
  server-derived, no client folder IDs):
  - `upload(dealCode, room: 'internal'|'deal', name, contentType, bytes)
    → {fileId, sizeBytes}` — provider resolves/creates the per-deal,
    per-room location internally.
  - `downloadStream(fileId) → ReadableStream`
  - `delete(fileId)` — compensation primitive (review 5.3).
  Bytes only; no access decisions.
- `src/lib/storage/local.ts` — Supabase Storage bucket `dataroom`, object
  path `{dealCode}/{room}/{uuid}-{name}`.
- `src/lib/storage/box.ts` — Box client-credentials grant (`BOX_CLIENT_ID`,
  `BOX_CLIENT_SECRET`, `BOX_SUBJECT_ID`); folder tree
  `/Conductia/{dealCode}/{internal|dealroom}` created on demand and cached.
- `src/lib/storage/index.ts` — `STORAGE_PROVIDER` env (`box|local`, default
  `local`); throws at startup on `box` with missing creds (env validation,
  review 3.2).
- `scripts/smoke-box.ts` — manual round-trip incl. both rooms + delete.

Verify: LocalStorage unit tests: round-trip per room, and an internal upload
is not retrievable via any deal-room path derivation (review 5.4); delete
removes; gate. Box smoke run once locally.

## M3 — Invite API + email

Files:
- `src/lib/api/v1/access.ts` — `userCanInvite(actor, target)` (review 2.1):
  - bank MD / deal-team with member-management (`canManageDealMembers`) →
    any internal deal role, or external company + director|member with
    dealRole derived from that company's `deal_parties.party_role`
    (target/co_seller → seller; acquirer_shortlist → buyer).
  - external director → own company only, `company_role='member'` only,
    dealRole forced to the company's party-derived seller/buyer role, deal
    must be one their company is party to. Internal roles (md, deal_team,
    legal, read_only) server-rejected for external invitees from any actor
    path.
- `src/lib/email/resend.ts` — invite email (inviter, company, deal
  codename, accept URL containing invite id + `credential_nonce`).
- `supabase/migrations/20260731130000_invite_rpcs.sql` (review 4.1/5.1/5.3):
  - `create_invite(...)` security-definer RPC: lazy-expire stale pendings
    for the email, enforce active-account/duplicate-pending rules, insert
    row + `invite_sent` audit in one transaction. Returns row.
  - `accept_invite(p_invite_id, p_nonce)` security-definer RPC: derives the
    accepting user from `auth.uid()` (never a parameter); conditional
    `UPDATE invites SET status='accepted' … WHERE id=… AND status='pending'
    AND expires_at>now() AND credential_nonce=p_nonce RETURNING` so exactly
    one redemption wins; validates normalized invite email = auth user
    email and tenant coherence; sets `users.company_id`, `company_role`,
    `is_external`, `tenant_id` inside the transaction (not trusting trigger
    defaults); inserts deal_membership (phase 0) + `invite_accepted` +
    `grant` audits. All-or-nothing.
- Routes under `src/app/api/v1/invites/` (all behind
  `requireFlag('platform_onboarding')` — see M-flag below):
  - `route.ts` POST: predicate → `generateLink({type:'invite'})` carrying
    `{tenant_id, is_external, invite_id}` metadata → `create_invite` RPC →
    Resend send. Email-send failure: invite stays `pending`, response is an
    explicit 502-style error naming resend as recovery (credential state
    stays authoritative; no silent success — review 5.3). GET: list by
    dealId/companyId, predicate-scoped.
  - `[inviteId]/resend/route.ts` POST: pending → rotate nonce + extend
    expiry + regenerate link + re-send + audit; terminal → 410 (client
    creates a fresh invite).
  - `[inviteId]/route.ts` DELETE: conditional revoke (`WHERE
    status='pending'`), audit `invite_revoked`; already-terminal → 410.
  - `accept/route.ts` POST: authenticated (session established by the
    accept page's Supabase verification); calls `accept_invite`; 410 on
    expired/revoked/nonce-mismatch.
- `openapi/phase1.json` — the five operations.

Verify (route + RPC tests): who-may-invite matrix incl. negatives — director
cross-company, non-party deal, director granting director, any external
invite carrying an internal role (review 2.1); 409 active-account, 409
duplicate-pending, lazy-expiry allows re-invite after expiry; concurrency:
double-accept (exactly one wins), accept-vs-revoke race (review 4.1); forged
invite id, mismatched signed-in email, cross-tenant id, `is_external` set on
accepted external user (review 5.1); audit rows written atomically with
state. Gate.

## M4 — Accept page

Files:
- `src/app/accept-invite/page.tsx` (+ client) — Tier 1 unguarded: Supabase
  invite-token verification → session; shows inviter/company/codename
  (minimal lookup by invite id + nonce, no auth required, returns only those
  display fields); collects display name + password; calls accept endpoint;
  redirects into the app. Dead-ends for expired/revoked/nonce-stale.
- `src/middleware.ts` — exclude `accept-invite`.
- Unaccepted-user containment (review 5.1): a signed-in auth user whose
  invite was never accepted has no company/memberships; add explicit tests
  that such a user receives 403 from deal APIs and is routed to a "pending
  invite" dead-end rather than any shell surface.

Verify: RTL for the page states; containment tests; manual flow on local
stack; gate.

## M5 — Documents API over the seam (the wall, every path)

Files:
- `src/lib/api/v1/access.ts` — `userCanSeeDocument(actor, membership, doc)`
  wall order: (1) external + `room='internal'` → never; (2) external +
  `classification=4` → never; (3) `membership.phase >= doc.min_phase`.
  `userCanUploadDocument`: MD/deal-team both rooms any class; seller →
  deal room class 1–3; buyer → never. Every document handler additionally
  verifies tenant/deal/document coherence (`doc.deal_id === dealId`,
  same-tenant) because handlers run service-role (review 5.2).
- `src/app/api/v1/deals/[dealId]/documents/route.ts` — GET filtered by
  `userCanSeeDocument`; POST upload: predicate → `storage.upload` →
  `insert row + upload audit` in one transaction → on DB/audit failure,
  compensating `storage.delete(fileId)`; if compensation itself fails the
  orphan is logged (row-less objects are unreachable through the app)
  (review 5.3). Box unavailable → HTTP 502 retryable, no row.
- `src/app/api/v1/deals/[dealId]/documents/[documentId]/view/route.ts` —
  **existing route fixed**: apply `userCanSeeDocument` + coherence before
  writing the `view` audit (closes the current bypass — review 1.2/5.2).
- `…/[documentId]/download/route.ts` — predicate + coherence → write
  `download` audit (fail-closed: audit insert failure → 500, no stream) →
  stream via `downloadStream`; Box failure → explicit 502.

Verify: predicate matrix (external × room × classification × phase; upload
rights) — spec c.12/13 named tests: external can NEVER retrieve
internal-room or class-4 via list, view, download, or metadata, at every
phase; wrong-deal + cross-tenant document ids rejected on all four paths;
failure injection: storage-up/DB-down (compensation runs), audit-down
(request fails, no stream/no row), Box-down upload (502, no row). Gate.

## M6 — Phase control

Files:
- `src/app/api/v1/deals/[dealId]/members/[userId]/route.ts` — **extend the
  existing PATCH** (preserving its current `canManageMembers` behavior —
  review 1.1): new `phase` field accepted only from the deal's MD
  (`userIsDealMd` — spec authorizes the MD; deal-team not silently included,
  review 2.1); monotonic raise only (lower-than-current → 422); same-value
  PATCH is an idempotent no-op success (fan-out retry safety); audits
  `grant` with `{from, to}` detail.

Verify: route tests — MD raises, deal-team member rejected, downgrade 422,
idempotent same-value, audit row; single-member and whole-team visibility
tests: after raise, newly eligible docs appear via GET list (spec c.14).
Gate.

## M-flag — server-side flag enforcement (lands with M3, used by M3–M6)

- `src/lib/api/v1/requireFlag.ts` — helper: `platform_onboarding` off →
  404 for all new routes/mutations (invites CRUD+accept, documents
  upload/download, members PATCH `phase` field). Existing routes' current
  behavior is untouched when off (review 1.3).
- Flag-off route tests for each new endpoint.

## M7 — MD surfaces (flag-gated UI)

Files:
- `src/app/(authed)/projects/[projectId]/data-room/page.tsx` + components —
  Internal/Deal Room split, classification + min-phase badges, upload,
  download, honest Box-outage error states. Rail entry flag-gated.
- Working Group real swap: `src/lib/wgl/workingGroup.ts` v1-backed loader
  (flag on → members + invites; off → fixtures);
  `src/components/wgl/WorkingGroupList.tsx` — live invite modal, per-member
  drawer: phase raise (PATCH), pending-invite resend/revoke.
- Gate 0: `src/components/wizard/Gate0Wizard.tsx` (corrected path — review
  1.3) — "Invite by email" mini-form; queued chips; after create, client
  POSTs invites **sequentially with per-chip state** (queued/sent/failed);
  failures shown per chip with retry-failed-only; duplicate-pending 409 on
  retry is treated as success (idempotent); partial failure is never
  reported as complete (review 4.2). Same per-item pattern for the
  whole-team phase fan-out in WGL (N PATCHes; idempotent by M6 semantics).
  Step copy drops "Invite by email comes later".

Verify: RTL — invite modal, drawer, Gate 0 queue incl. partial-failure and
retry-only-failed; team fan-out partial failure surfaced; flag-off renders
identical to today (snapshot) (spec c.16). Gate.

## M8 — External scoped shell

Files:
- `/api/v1/me` — ensure `is_external`, `company_id`, `company_role` exposed.
- `src/app/(authed)/layout.tsx` / shell nav — external: rail = exactly
  Deal / Data Room / Team; no command console mount.
- `/` picker — external single-membership → redirect into the deal;
  multiple → minimal picker scoped to memberships.
- `src/app/(authed)/projects/[projectId]/page.tsx` — external scoped deal
  home variant.
- External Team destination: director → roster + invite/manage own company;
  member → read-only.

Verify: RTL render matrix (internal vs external vs unaccepted); routing
tests (single vs multi membership); manual walkthrough; gate.

## M9 — Seed, demo, docs, deploy runbook, PR

Files:
- `scripts/seed-users.ts` — buyer company + pending director invite demo
  scenario.
- `docs/03-engineering/api-v1.md` — invites/documents/phase APIs.
- `docs/07-decisions/decision-log.md` — D41 invite system (two-tier
  delegation), D42 Conductia-mediated Box + storage seam (resolves D31 for
  this arc), D43 external scoped shell. `ADR-0011` onboarding + data room.
- Deploy/rollback runbook in ADR-0011 (review 3.2): forward = (1) additive
  schema migrations, (2) bucket provisioning, (3) typed flag seeded off,
  (4) `smoke-box.ts` against prod tenant, (5) enable flag. Rollback =
  disable flag (all new routes 404, all new UI hidden, legacy behavior
  intact; additive schema and backfilled `room='internal'` rows are inert).
- Demo script from brief validated end-to-end (real Box + Resend), noted in
  PR body.

Verify: full gate `npm run test && npm run lint && npm run build`; PR to
`develop`; reviewer PR review → "PR APPROVED".

## Risks

- Supabase `generateLink` invite + custom accept page interplay — manual
  spike at the start of M3 before building on it.
- Box client-credentials (enterprise subject id) — `smoke-box.ts` in M2.
- Flag-off regression — server 404 helper + UI snapshots (c.16).
- Audit fail-closed semantics add failure modes to download — accepted
  deliberately: compliance beats availability here (spec: no silent
  degradation).

## Changes from v1 (review round 1)

- 1.1 → M6 rewritten: extend existing PATCH, MD-only, monotonic, idempotent,
  visibility tests.
- 1.2 → M5: existing `/view` route brought inside the wall; audit-view test
  covers all seven verbs (M5/M3 tests + c.15 assertion in M9 demo).
- 1.3 → M1 typed flag registry; M-flag server enforcement + flag-off tests;
  Gate0Wizard path corrected.
- 2.1 → M3 predicate: MD-only phase authority (M6); director constrained to
  member + party-derived role; internal-role injection rejected.
- 3.1 → M1 staged room migration, backfill `internal`, fail-closed.
- 3.2 → M1 bucket migration; M2 env validation; M9 deploy/rollback runbook.
- 4.1 → M1 state machine + nonce; M3 lazy expiry, conditional transitions,
  concurrency tests.
- 4.2 → M7 per-item fan-out state, retry-failed-only, idempotent semantics.
- 5.1 → M3 accept RPC derives auth.uid(), email/tenant coherence,
  is_external inside transaction; M4 unaccepted-user containment tests.
- 5.2 → M5 wall + tenant/deal coherence on list/view/upload/download.
- 5.3 → M3 create RPC transactional + email-failure semantics; M5 upload
  compensation + fail-closed audit.
- 5.4 → M2 room-aware seam, no client folder ids, delete primitive,
  cross-room isolation test.
