---
run_id: onboarding
type: brief
round: 0
---

# Onboarding: Buyer/Seller Invites + Box Data Room

**Date:** 2026-07-31
**Status:** Approved design, pending implementation plan
**Owner:** Martin (onboarding workstream, per 2026-07-28 build sync)
**Source inputs:** 2026-07-28 "Conductia // Weekly Build Sync" and "Workflow Demo Progress" notes; decisions D29-D33, D37; ADR-0008/0009/0010.

## One line

A true platform experience for every party on a deal: sellers and buyers join through a clean invite flow (email, accept, create account, as standard user or company director who brings their own team), and data room access runs through Box with every action captured in the audit log from day one.

## Decisions made in this design

1. **Scope:** invite flow + Box data room ship together as one arc (the "first 30 days"). Bank/user-level setup (email connect, supporting tools) and training walkthroughs are the "next 30 days", out of scope here.
2. **Invite model: two-tier delegation.** Bank MD/deal team invites company directors (or standard users) for buyer/seller companies; directors invite and manage their own company's members. The bank can also invite bank-internal colleagues by email (Gate 0 Team step).
3. **Box access is Conductia-mediated.** Users never touch Box. A service account owns the folder tree; all list/view/upload/download flows through `/api/v1` to the Box API. Permissions live 100% in `deal_memberships` + app predicates; audit is synchronous and complete by construction.
4. **Invite plumbing: Supabase auth mechanics + Resend delivery.** `supabase.auth.admin.generateLink({ type: 'invite' })` produces the accept credential; we email it ourselves via Resend with a branded template (Supabase built-in SMTP is rate-limited and undeliverable enough to kill a demo). Keys already in `.env.local`.
5. **External UX: scoped deal home.** External users get the same `(authed)` shell gated to exactly Deal / Data Room / Team. No command console, no MD destinations.
6. **Success bar: live end-to-end demo** at a weekly sync. Real invite email, real accept, real account, phase-gated Box files, director invites a teammate, every step visible in the real per-deal audit view.
7. **Storage seam:** routes never import the Box SDK. A minimal `DataRoomStorage` interface with `BoxStorage` (prod/demo) and `LocalStorage` (dev/CI) implementations, selected by env. The seam moves bytes; it never decides access. Keeps CI green without Box creds and keeps D31's vendor escape hatch honest.

## Data model

### New table: `invites`

Migration follows existing patterns (CHECK enums, mirrored TS constants in `src/lib/constants/invites.ts`).

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `tenant_id` | per-tenant isolation, as elsewhere |
| `email` | lowercased |
| `invited_by` | FK users |
| `company_id` | FK companies; the company the invitee will belong to (bank for internal invites) |
| `company_role` | CHECK `director \| member` (D33 axis) |
| `deal_id`, `deal_role` | nullable pair; external director invites always carry the deal |
| `status` | CHECK `pending \| accepted \| revoked \| expired` |
| `expires_at` | default now() + 7 days |
| `accepted_at`, `accepted_user_id` | set by accept RPC |

- Partial unique index on `(email) WHERE status = 'pending'`: one live invite per email (D33: 1 email = 1 account).
- No token column. The Supabase-generated invite link is the credential; the row tracks lifecycle for UI (resend/revoke) and audit.

### `documents` additions

`storage_provider`, `storage_file_id`, `size_bytes`, `content_type`, and `room` CHECK (`internal \| deal`).

- **Internal bank room** = `room = 'internal'`. The access predicate hard-excludes any `is_external` user before phase/classification are consulted. Never shared externally, no exceptions.
- **Deal room** = `room = 'deal'`. Existing `classification` (1-4) + `min_phase` vs `deal_memberships.phase` gates apply.
- Box folder tree mirrors the split (`/Conductia/{dealCode}/internal`, `/Conductia/{dealCode}/dealroom`) as defense-in-depth only; folders are not the access mechanism.

### Audit enum

Widen `audit_log.action` with `invite_sent`, `invite_accepted`, `invite_revoked` via the established drop-and-re-add CHECK pattern (mirrored in `src/lib/constants/audit.ts`). Invites are first-class compliance vocabulary in the per-deal audit view; membership grants continue to audit as `grant`.

### `handle_new_auth_user` trigger

Untouched. Metadata carries `is_external`; company linkage and deal membership are provisioned by the accept RPC, not the trigger.

## Invite lifecycle

1. **Create:** MD/deal-team (or external director, for own-company members) submits email + role. Row inserted `pending`, `generateLink` called, Resend sends branded email, audit `invite_sent`.
2. **Accept:** recipient lands on `/accept-invite` (Tier 1, unguarded), sees inviter/company/deal codename, sets display name + password. Supabase creates the auth user; trigger mirrors to `public.users`; the client then calls the accept endpoint.
3. **Finalize (transactional RPC, modeled on `create_deal_gate0`):** mark invite `accepted`, link user to company with `company_role`, grant `deal_memberships` at phase 0, audit `invite_accepted` + `grant`. No half-provisioned users possible.
4. **Resend:** regenerates the link on the same row, re-emails.
5. **Revoke:** flips status; accept endpoint rejects revoked/expired with 410.

### Who may invite (server-enforced in `src/lib/api/v1/access.ts`)

| Actor | May invite |
|---|---|
| Bank MD / deal team with `can_manage_members` | anyone: internal roles, or external director/member for a deal-party company |
| External director | members of their own company only, onto deals their company is party to |
| Everyone else | nobody |

UI affordances mirror these predicates; hiding is presentation only (ADR-0009: no client-only gating).

## API surface (`/api/v1`, Phase 1 pattern: `requireApiUser` + predicates + inline audit)

```
POST   /api/v1/invites                                   create + send
GET    /api/v1/invites?dealId=...&companyId=...          list for management UI
POST   /api/v1/invites/[inviteId]/resend                 regenerate + re-email
DELETE /api/v1/invites/[inviteId]                        revoke
POST   /api/v1/invites/accept                            finalize after password set
POST   /api/v1/deals/[dealId]/documents                  upload (multipart -> storage seam)
GET    /api/v1/deals/[dealId]/documents/[id]/download    stream through, audited
PATCH  /api/v1/deals/[dealId]/members/[userId]           set phase / access controls
```

Existing `documents` GET list and `/view` audit route stay. The members POST 404 branch ("invitee must sign up first") stays for on-platform grants; invites are the path for everyone else. OpenAPI (`openapi/phase1.json`) is extended accordingly.

`PATCH members` is the backend for the permission-control UI from the sync ("backend already built, just needs UI"): per-user phase bumps, audited as `grant`; the UI's "set for whole team" fans out to per-user PATCHes.

## Storage seam (`src/lib/storage/`)

```ts
interface DataRoomStorage {
  ensureDealFolder(dealCode: string): Promise<FolderRef>;
  upload(folder: FolderRef, name: string, stream: ReadableStream): Promise<StoredFile>;
  downloadStream(fileId: string): Promise<ReadableStream>;
}
```

- `BoxStorage`: client-credentials grant with the service-account keys in `.env.local`.
- `LocalStorage`: Supabase Storage (or disk) for dev/CI.
- `STORAGE_PROVIDER` env selects. Nothing else goes in the interface until something needs it.

**Upload rights:** MD/deal team upload to either room; sellers upload to the deal room (role seed already carries `document:upload:class1-3`); buyers are read-only.

## Surfaces

### `/accept-invite` (Tier 1)

Added to middleware exclusions. Branded page: inviter, company, deal codename; display name + password; expired/revoked shows an honest dead-end ("Ask [inviter] to resend"). No terms/attestation screen this cycle.

### Gate 0 Team step

New "Invite by email" button opens an inline mini-form (email, role: Deal Team/Legal internal, or external company + Seller/Buyer + director flag). Because the deal does not exist until the wizard finishes, invites queue as chips in wizard state; on successful create the client fires `POST /invites` per chip against the new deal. Step copy drops "Invite by email comes later."

### MD side (project routes)

- **New rail destination: Data Room** (`/projects/[projectId]/data-room`): file list split Internal / Deal Room, classification + min-phase badges, upload, download.
- **Working Group goes real:** the WGL surface swaps fixtures for `/api/v1` data; the stubbed `[Later]` invite affordance becomes a live invite modal; per-member drawer adds phase control (`PATCH members`) and invite status (pending/resend/revoke). The compliance-theatre Team page is untouched.

### External scoped shell

Gated by `me.is_external`: rail shows Deal / Data Room / Team only; no command console. Sign-in redirects external users to their deal (single membership) or a minimal picker (multiple). Data Room lists only `room='deal'` files passing their phase gate. Team page: directors get roster + invite + own-team management; members get roster view.

### Seams and flags

These surfaces call `/api/v1` directly (the platform contract), like the Gate 0 wizard. `MockConductiaAPI` (the M&A content seam) is untouched. Everything ships behind one feature flag, `platform_onboarding`, following the `gate0_api_create` cutover pattern.

## Error handling

- Invite to an email with an active account: 409, pointing at the direct-grant path.
- Duplicate pending invite: 409 with resend hint.
- Accept with expired/revoked invite: 410.
- Box outage: uploads fail with retryable 502; downloads show an error state. No silent degradation.
- Accept RPC is transactional; partial provisioning cannot occur.

## Testing

- Vitest predicate matrices: who-may-invite; room/phase/classification gates. The critical wall: an external user must never see the `internal` room or MNPI (`classification 4`) regardless of phase.
- Invite lifecycle state machine and accept RPC covered per existing route-test conventions, running against `LocalStorage`.
- One live Box smoke script (`scripts/smoke-box.ts`), run manually; CI has no Box creds.
- Demo seed: extend `seed-users` with a buyer-director invite scenario.

## Out of scope (explicit)

Email/tools connection (next 30 days), training walkthroughs (user + admin FINRA/security/screening content from the sync), text prescreening, Box events sync, per-document ACLs beyond room/phase/classification (D37 holds), terms-of-service acceptance screen.

## Demo script (the success bar, verbatim)

1. MD runs Gate 0, invites a colleague by email from the Team step.
2. From Working Group, MD invites `buyer-director@example.com` as Buyer director.
3. Director receives Resend email, accepts, sets password, lands on the scoped deal home.
4. Director sees only phase-gated deal-room files served from Box; the internal room does not exist for them.
5. Director invites a teammate; teammate accepts and appears in the roster.
6. MD bumps the buyer team's phase; a previously hidden file appears for the director.
7. The per-deal audit view shows every step: `invite_sent`, `invite_accepted`, `grant`, `upload`, `view`, `download`.
