---
run_id: onboarding
type: plan
round: 1
spec: spec-v3.md
---

# Plan: Onboarding — Buyer/Seller Invites + Box Data Room

Implements frozen `spec-v3.md`. Architecture per `brief.md` (approved design
doc). Branch `duo/onboarding` off `origin/develop`; PR base `develop`; remote
`git@github.com-fp:FutureProofingDev/intelibank.git`. Gate after every
milestone: `npm run test && npm run lint`; full gate incl. `npm run build`
before PR. `.env.local` (Resend + Box keys) is copied from the main checkout
and never committed. Each milestone is a commit; commits follow the repo's
conventional style (`feat(onboarding): …`).

## M1 — Schema, constants, flag

Files:
- `supabase/migrations/20260731120000_onboarding_invites.sql` — new `invites`
  table per brief (tenant_id, email lowercased, invited_by, company_id,
  company_role CHECK director|member, nullable deal_id + deal_role CHECK
  mirroring deal_memberships, status CHECK pending|accepted|revoked|expired,
  expires_at default now()+7d, accepted_at, accepted_user_id; partial unique
  index on (email) where status='pending'). Widen `audit_log.action` CHECK
  with `invite_sent|invite_accepted|invite_revoked` using the established
  drop-and-re-add pattern. Add to `documents`: `storage_provider text`,
  `storage_file_id text`, `size_bytes bigint`, `content_type text`,
  `room text CHECK (room in ('internal','deal')) default 'deal'`.
- `src/lib/constants/invites.ts` — INVITE_STATUS, COMPANY_ROLE reuse; mirror
  CHECK enums exactly (migration is source of truth).
- `src/lib/constants/audit.ts`, `documents.ts` — extend mirrors.
- `scripts/seed-flags.ts` — add `platform_onboarding` flag (default off),
  same shape as `gate0_api_create`.

Verify: `npm run db:migrate` clean on local stack; `npm run check:db`;
constants typecheck; gate.

## M2 — Storage seam

Files:
- `src/lib/storage/types.ts` — `DataRoomStorage`: `ensureDealFolder(dealCode)`,
  `upload(folderId, name, contentType, stream|buffer) → {fileId, sizeBytes}`,
  `downloadStream(fileId) → ReadableStream`. Bytes only; no access decisions.
- `src/lib/storage/local.ts` — `LocalStorage` over Supabase Storage bucket
  `dataroom` (dev/CI default; CI needs no Box creds).
- `src/lib/storage/box.ts` — `BoxStorage` via Box client-credentials grant
  (`BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_SUBJECT_ID` from env); folder
  tree `/Conductia/{dealCode}/{internal|dealroom}` as defense-in-depth.
- `src/lib/storage/index.ts` — provider picked by `STORAGE_PROVIDER` env
  (`box`|`local`, default `local`).
- `scripts/smoke-box.ts` — manual round-trip (ensureFolder→upload→download),
  run locally only (CI has no creds).

Verify: unit test on LocalStorage round-trip; `npx tsx scripts/smoke-box.ts`
against real tenant once; gate.

## M3 — Invite API + email

Files:
- `src/lib/api/v1/access.ts` — add `userCanInvite(user, {companyId, dealId,
  companyRole, dealRole})`: bank MD/deal-team with member-management → any;
  external director → own company + member role only, deal must be one their
  company is party to (deal_parties join). Server-side; this is spec c.5.
- `src/lib/email/resend.ts` — thin sender (RESEND_API_KEY), branded invite
  template (inviter, company, deal codename, accept URL). No queue.
- `supabase/migrations/20260731130000_accept_invite_rpc.sql` —
  `accept_invite(invite_id, user_id)` transactional RPC modeled on
  `create_deal_gate0`: validates pending+unexpired, marks accepted, links
  user→company(+company_role), inserts deal_membership phase 0, audits
  `invite_accepted` + `grant`. All-or-nothing (spec c.4).
- Routes under `src/app/api/v1/invites/`:
  - `route.ts` POST (create: predicate check, active-account 409 w/ guidance,
    duplicate-pending 409 w/ resend hint, `generateLink({type:'invite'})`,
    Resend send, audit `invite_sent`), GET (list by dealId/companyId, scoped
    by predicates).
  - `[inviteId]/resend/route.ts` POST (regenerate link, re-send, audit).
  - `[inviteId]/route.ts` DELETE (revoke → status, audit `invite_revoked`).
  - `accept/route.ts` POST (called by accept page after Supabase auth
    completes; executes RPC; 410 for expired/revoked).
- `openapi/phase1.json` — add the five operations.

Verify: route tests (Vitest, following existing v1 route-test conventions):
who-may-invite matrix incl. director cross-company + non-party-deal
rejections; 409/409/410 paths; lifecycle state machine. Gate.

## M4 — Accept page

Files:
- `src/app/accept-invite/page.tsx` (+ client component) — Tier 1 unguarded:
  reads Supabase invite token from URL, shows inviter/company/deal codename
  (from invite row via a minimal public lookup keyed by the token flow),
  collects display name + password, completes Supabase verification, calls
  `POST /api/v1/invites/accept`, redirects into the app. Dead-end states for
  expired/revoked (spec c.3).
- `src/middleware.ts` — add `accept-invite` to the exclusion matcher.

Verify: RTL test for the three page states; manual flow against local stack;
gate.

## M5 — Documents API over the seam (the wall)

Files:
- `src/lib/api/v1/access.ts` — `userCanSeeDocument(user, membership, doc)`:
  order of walls: (1) external + `room='internal'` → never; (2) external +
  `classification=4` → never; (3) `phase >= min_phase`; plus
  `userCanUploadDocument` (MD/deal-team both rooms; seller deal-room class
  1–3; buyer never).
- `src/app/api/v1/deals/[dealId]/documents/route.ts` — extend GET list to
  filter through `userCanSeeDocument`; add POST upload (multipart →
  `storage.upload`, insert row, audit `upload`; Box failure → 502 with
  retryable error body, no row inserted).
- `src/app/api/v1/deals/[dealId]/documents/[documentId]/download/route.ts` —
  GET: predicate → `downloadStream` → stream response, audit `download`; Box
  failure → explicit 502 error state.

Verify: predicate unit tests are the core deliverable — full matrix (external
× room × classification × phase; seller/buyer upload rights). Spec c.12/13
tests named explicitly: external user can NEVER retrieve internal-room or
class-4 docs. Route tests with LocalStorage. Gate.

## M6 — Phase control

Files:
- `src/app/api/v1/deals/[dealId]/members/[userId]/route.ts` — add PATCH
  (MD/deal-team-managed): set `phase`, audit `grant` with detail. Team-wide
  fan-out is client-side (N PATCHes), no new endpoint.

Verify: route test (authz + audit row); gate.

## M7 — MD surfaces (flag-gated)

Files:
- `src/app/(authed)/projects/[projectId]/data-room/page.tsx` + components —
  Data Room destination: Internal/Deal Room split, classification + min-phase
  badges, upload control, download links (v1 API); Box-outage error states
  surfaced honestly. Rail entry added to the shell nav (flag-gated).
- Working Group goes real: `src/lib/wgl/workingGroup.ts` gains a v1-backed
  loader (flag on → `/api/v1` members + invites; off → existing fixtures);
  `src/components/wgl/WorkingGroupList.tsx` — live invite modal (replaces
  `[Later]` stub), per-member drawer: phase control (PATCH), pending-invite
  resend/revoke.
- Gate 0 Team step (`src/components/gate0/Gate0Wizard.tsx`) — "Invite by
  email" button → inline mini-form; queued invite chips in wizard state;
  after successful create, client fires POST /invites per chip; step copy
  updated (drop "Invite by email comes later").

Verify: RTL for WGL invite modal + drawer states and Gate 0 queue behavior;
flag-off snapshot unchanged (spec c.16); gate.

## M8 — External scoped shell

Files:
- `src/lib/api/v1/me` already returns user; ensure `is_external`,
  `company_id`, `company_role` are included.
- `src/app/(authed)/layout.tsx` / shell nav — external users: rail renders
  exactly Deal / Data Room / Team; no command console mount.
- Sign-in landing: project picker route (`/`) — external users with one
  membership → redirect `/projects/[dealId]`; multiple → minimal picker
  (reuse picker list, scoped to memberships).
- `src/app/(authed)/projects/[projectId]/page.tsx` — external variant: scoped
  deal home (existing dashboard hidden for external).
- Team destination for external users: directors → roster + invite/manage own
  company (v1); members → read-only roster.

Verify: RTL nav-gating tests (external vs internal render matrix); manual
walkthrough; gate.

## M9 — Seed, demo, docs, PR

Files:
- `scripts/seed-users.ts` — extend with demo scenario (buyer company +
  director invite pending).
- `docs/03-engineering/api-v1.md` — document invites/documents/phase APIs.
- `docs/07-decisions/decision-log.md` — D41 (invite system, two-tier
  delegation), D42 (Conductia-mediated Box + storage seam; resolves D31 for
  this arc), D43 (external scoped shell). ADR-0011 (onboarding + data room
  architecture) in `docs/07-decisions/`.
- Demo script from brief final section validated end-to-end manually (real
  Box + Resend), results noted in PR body.

Verify: full gate `npm run test && npm run lint && npm run build`; then PR
to `develop` with spec/plan links; reviewer PR review → "PR APPROVED".

## Risks

- Supabase `generateLink` invite flow + custom accept page interplay (token
  redemption semantics) — de-risked early in M3/M4 by a manual spike before
  building the full page.
- Box client-credentials setup (enterprise subject ID) — de-risked by
  `smoke-box.ts` in M2 before anything depends on it.
- Flag-off regression — every UI change is behind `platform_onboarding`;
  c.16 verified by flag-off tests in M7/M8.

## Out of plan

Everything in spec non-goals; also no RLS policy work beyond existing
patterns (app-layer predicates are the enforcement per ADR-0008; RLS
tightening tracked separately in permissions-enforcement-gaps.md).
