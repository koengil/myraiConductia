# ADR-0011: Onboarding invites + room-split data room behind `platform_onboarding`

- **Status:** Proposed
- **Date:** 2026-07-31
- **Decisions:** D42 (invites), D43 (data room + storage seam), D44 (external shell)
- **Spec of record:** `docs/superpowers/specs/2026-07-31-onboarding-design.md`, frozen as
  `docs/agent-duo/runs/onboarding/spec-v3.md`; plan `plan-v5.md` (Codex-reviewed, 5 rounds)

## Context

The platform onboarded exactly one audience: bank staff seeded by script. The
2026-07-28 build syncs set the first-30-days goal — sellers and buyers join a
deal through a clean invite flow, data room access runs through Box, and every
action lands in the audit log from day one. Nothing existed for it: no sign-up
page, no invite plumbing, no email delivery, no storage columns on
`documents`, and the internal/external boundary lived only in `users.is_external`.

## Decision

One feature flag, `platform_onboarding`, gates the whole slice. New routes 404
when it is off; changed routes keep their pre-onboarding behavior exactly.

### Invites (D42)

- `invites` table: lifecycle `pending → accepted | revoked | expired`, a
  **global** one-live-invite-per-email partial unique index (D33:
  1 email = 1 account), `delivery_status` (`unsent`/`sent`) **separate from
  lifecycle**, and a rotating `credential_nonce`.
- Five `security definer` RPCs own every multi-write: `create_invite`
  (row-first, no audit), `finalize_invite_delivery` (conditional
  `unsent → sent` + `invite_sent` audit in one transaction),
  `rotate_invite_credential`, `revoke_invite` (+ `invite_revoked` audit),
  `accept_invite`.
- Delivery: `generateLink(type: 'invite')` for the Supabase credential, the
  email itself goes out via **Resend** (branded, deliverable — Supabase SMTP
  would rate-limit a live demo away).
- **Pre-accept containment:** the link's auth identity gets
  `users.status = 'invited'` set by the server *after* link generation — the
  `handle_new_auth_user` trigger is untouched, and the invite metadata carries
  only server-owned values (`invite_id`, `credential_nonce`, `is_external`,
  `tenant_id`). `requireApiUser` returns `403 onboarding_incomplete` for
  invited accounts everywhere except `POST /invites/accept`; the `(authed)`
  layout redirects them to `/accept-invite`.
- **Acceptance** runs the RPC on the session-bound client (`auth.uid()` = the
  invitee), requires a *delivered* credential (an undelivered link first
  reconciles delivery, recording the single `invite_sent` audit), validates
  email + tenant coherence, and is single-winner under concurrency (`FOR
  UPDATE` + conditional update on status **and** nonce).
- Authority: firm admin anywhere; internal staff per `canManageDealMembers` /
  `canManageCompanyMembers`; an **external director** only members of their own
  company, onto deals their company is party to (seat side derives from the
  party role — target/co-seller ⇒ `seller`, otherwise `buyer`). `md` is never
  invitable. Duplicate disclosure is scoped (opaque 409 across tenants).

### Data room (D43)

- `documents` gains `room` (`internal` | `deal`) + storage columns. The room
  migration is staged fail-closed: nullable add → backfill **all** legacy rows
  to `internal` → verify → NOT NULL + CHECK. Nothing pre-existing leaks.
- **Wall order** (`src/lib/api/v1/documentAccess.ts`), applied identically on
  list, view, download: internal room is never visible to an external user
  (checked first); MNPI (classification 4) is MD/CCO/admin only; external
  viewers need `min_phase ≤` their seat's `phase`. Walled rows 404
  identically to missing ones — no existence oracle, and no audit event can
  exist for a document the viewer cannot see.
- **Storage seam** (`src/lib/storage/`): `DataRoomStorage` moves bytes only.
  `local` (default — private Supabase bucket `dataroom`, so dev/CI need no Box
  credentials) or `box` (client-credentials,
  `/Conductia/{dealCode}/{internal|dealroom}`) selected by
  `STORAGE_PROVIDER`. Paths derive server-side; the provider never decides
  access. Upload compensation removes the stored object when the DB insert
  fails; storage outage is an honest retryable `502`.
- Upload rights: internal staff both rooms (MNPI authored by MD/oversight
  only); sellers deal room at classification ≤ 3; buyers read-only.

### External experience (D44)

- Perspective `external` (resolved server-side from `users.is_external` in the
  `(authed)` layout — identity, not a demo toggle) scopes the nav to **Deal ·
  Data Room · Team** (Working Group relabeled). Nav gating is presentation
  (ADR-0009); predicates are the wall.
- Member `phase` is monotonic: raises only, idempotent repeats, downgrades 409
  — disclosure to a counterparty cannot be undone.

## Consequences

- The audit `action` CHECK is now the 19-action superset: the legacy spine
  actions (`screen`, `send`, `release`) found live in the DB — the 20260721
  re-add had silently failed against those rows, so the constraint did not
  exist until this migration repaired it — plus `reject` from the compliance
  mail channel (D41), so the final validated CHECK is the union regardless of
  merge order.
- `requireApiUser` gained a per-request `users.status` probe; route tests
  stub one extra users read.
- Box smoke (`npm run smoke:box`) needs a fresh dev token or
  `BOX_ENTERPRISE_ID` at demo time; CI never touches Box.
- Deferred: per-document ACLs beyond room/phase/classification (D37's backend
  form now exists; finer grains still out), Box events sync (nothing to sync —
  access is Conductia-mediated), email/tools connection (next 30 days).
