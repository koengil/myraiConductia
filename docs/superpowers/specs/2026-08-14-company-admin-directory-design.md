# Company admin Phase A: preferred deal role + colleague directory (#160 partial)

**Date:** 2026-08-14
**Status:** Implemented (see `docs/superpowers/plans/2026-08-14-preferred-deal-role.md`)
**Issue:** [#160](https://github.com/FutureProofingDev/intelibank/issues/160) — this is **Phase A of #160, not its completion**. It delivers preferred deal-role defaults and a searchable employee roster; the issue's roles CRUD and permission-management requirements are deliberately deferred (see Deferred).

## Context

Issue #160 asks for company-admin roles CRUD, permission sets, and an employee directory. Exploration showed the issue's "primarily UI + API wiring" note is wrong on one point: the `roles` table (`supabase/migrations/20260604100000_permissions_schema.sql`) is a closed CHECK-constrained enum of 8 seeded platform roles with no company scoping, no user-to-role assignment table, and a `permissions` jsonb with one display consumer (Gate 0 fetches `/api/v1/roles` and renders permission blurbs) and zero authorization/enforcement consumers. Real enforcement lives entirely in hand-written predicates (`src/lib/api/v1/access.ts`). The member-management plumbing is solid: `canManageCompanyMembers`, add/re-role/remove APIs with audit rows, the >=1-director DB invariant, the invite pipeline, a working page at `/companies/[companyId]/members`, and an AppRail "Company members" link already shipped (`src/components/shell/AppRail.tsx`).

An external review (Codex) proposed the full company-capability layer: `company_roles`, `company_role_permissions`, `company_member_roles`, `company_member_permissions`, a permission catalogue, and effective-permission resolution. Verified against the codebase: zero authorization/enforcement consumers exist for any permission string; the only two live company-level capabilities (manage members, invite) already have dedicated enforced columns (`company_role`, `can_invite`). Building the catalogue now would recreate the decorative-jsonb problem with more machinery. That model is recorded below as the v2 target and is not part of this design.

## Framing

A safe company-managed **preference that accelerates later deal assignment** — not a new role or permission system. `preferred_deal_role` grants nothing, never creates or modifies a deal membership, and administrators still confirm the role when adding the person to a deal. Product copy: "Preferred role for future deal assignments. Administrators still confirm it when adding this person to a deal."

## Decisions

1. **Curated roles, real preference.** The 8 platform roles stay fixed. What ships is a per-person preferred deal role.
2. **Assignable set is `deal_team | legal | read_only` only** — the existing server-side rule for internal invitations (`INTERNAL_PROPOSAL_DEAL_ROLES`, `src/lib/api/v1/proposalFeasibility.ts`). Never `md` (protected seat), never `seller`/`buyer` (external), never `admin`/`cco` (firm roles). A shared constant `INTERNAL_ASSIGNABLE_DEAL_ROLES` is added to `src/lib/constants/roles.ts` and `proposalFeasibility.ts` reuses it.
3. **No HR actor.** Governance actors are the existing `canManageCompanyMembers` set. HR modeling is a follow-up.
4. **One surface.** Extend the existing members page; no new routes.
5. **Flag:** the new preferred-role control and its API branch sit behind `platform_onboarding`. The page, the existing AppRail link, and existing capabilities are already live unflagged and stay that way.
6. **Roster visibility (from review), opt-in.** The wall filter in `GET /companies/{id}/members` hides research/trading from everyone, so today the page is a deal-eligible colleague roster, not a full employee directory. Amended: walled rows are returned only for `GET /members?includeWalled=true`, honored only when the viewer passes `canManageCompanyMembers` (silently ignored otherwise), each row marked `is_walled`. The members page passes the parameter; Gate 0 keeps calling the bare endpoint and stays wall-safe by default. Predicate-gated only, not flag-gated (visibility is an access question, not an onboarding feature).
7. **Walled rows cannot receive preferred roles or director promotion through this surface.** A company director can manage seats on every deal the bank owns (`access.ts` `directorOf`), so promoting a research/trading user to director would bypass the wall. Scope note: the existing email-invite pipeline does not inspect an existing invitee's department, so a walled account can still be assigned a deal seat through that separate path; the stronger platform-wide invariant is a deferred follow-up (see Deferred). The "Make director" action is hidden on `is_walled` rows and `POST /members` rejects promoting a walled user to director server-side. The preferred-role PATCH likewise rejects walled targets server-side, not just via the disabled selector. Removal/demotion of walled users remains available.
8. **Permission management is not delivered here.** Existing `can_invite` delegation remains available; arbitrary individual permission grants are deferred.
9. **Shared allowlist everywhere.** `INTERNAL_ASSIGNABLE_DEAL_ROLES` replaces the applicable local role lists in Gate 0, InviteModal, the invite queue, and `proposalFeasibility`. Note this fixes a live Gate 0 bug: its local `ASSIGNABLE_DEAL_ROLES` offers `seller`/`buyer` for internal colleagues, which the invite pipeline's own rule forbids.
10. **API field naming.** Response fields stay snake_case like their neighbors (`preferred_deal_role`, `is_walled`, beside `company_role`, `can_invite`); the PATCH request body field is camelCase (`preferredDealRole`, beside `canInvite`). The endpoint is not being normalized.

## Schema

One migration:

```sql
ALTER TABLE users ADD COLUMN preferred_deal_role text NULL REFERENCES roles(slug);
ALTER TABLE users ADD CONSTRAINT users_preferred_deal_role_internal_check
  CHECK (
    preferred_deal_role IS NULL
    OR preferred_deal_role IN ('deal_team', 'legal', 'read_only')
  );
-- comment records proposal-only semantics + the roles-CRUD deferral
```

The DB CHECK enforces the same allowlist as the API; the constants test asserts DB and `INTERNAL_ASSIGNABLE_DEAL_ROLES` stay synchronized.

## API

No new endpoints. Extensions, documented in `docs/03-engineering/api-v1.md` tables:

**`PATCH /api/v1/companies/{companyId}/members/{userId}`** — stays a single-field compare-and-swap operation. A request must change exactly one of `{ canInvite: boolean }` or `{ preferredDealRole: InternalAssignableDealRole | null }`; neither or both → 400. The new branch mirrors the existing `canInvite` branch exactly:

- `canManageCompanyMembers` gate; branch active only when `platform_onboarding` is enabled (`isFlagEnabled`).
- Validates against `INTERNAL_ASSIGNABLE_DEAL_ROLES` (400 on anything else, including `md`, `seller`, `buyer`, `admin`, `cco`).
- Confirms the target is still a member of the company (404 otherwise); rejects external users and walled (research/trading) targets.
- Idempotent write short-circuits with no audit row.
- Compare-and-swap on the previously read value; concurrent change → 409.
- Audit: `AUDIT_ACTION.GRANT` for set/change, `AUDIT_ACTION.REVOKE` for clearing (no generic update action exists), `reason: 'company_preferred_deal_role_changed'`, detail carries `old_preferred_deal_role` and `new_preferred_deal_role`. Audit-insert failure restores the previous value over our own write only (same rollback pattern and transactional-RPC caveat as `canInvite`).

**`GET /api/v1/companies/{companyId}/members`** — returns `preferred_deal_role` per member. With `?includeWalled=true`, and only when the viewer passes `canManageCompanyMembers`, walled departments (research/trading) are included with `is_walled: true`; without the parameter (or for other viewers) the response is unchanged, so existing consumers (Gate 0) stay wall-safe.

**`POST /api/v1/companies/{companyId}/members`** — additionally rejects promoting a walled user to director (see decision 7).

**`GET /api/v1/invites/lookup`** — its existing constant-schedule user query additionally selects `preferred_deal_role`. When the existing user may be disclosed, belongs to the matched bank company (`existingUser.company_id === matchedCompany.id`), and holds a valid preferred role, it becomes `recommendation.dealRole` with a distinct reason `employee_default` (falling back to the current `bank_internal_seat` default otherwise). Anti-enumeration shape unchanged — no new lookup endpoint.

## UI

**Members page** (`src/app/(authed)/companies/[companyId]/members/page.tsx`):

- Preferred-role `<select>` per member row using `DEAL_ROLE_LABELS` over `INTERNAL_ASSIGNABLE_DEAL_ROLES` plus a "No preference" option; rendered only when `useFlag('platform_onboarding')`; disabled with a wall note on `is_walled` rows, whose "Make director" action is also hidden. The page fetches the roster with `?includeWalled=true`. Helper copy uses the proposal-only phrasing above.
- Client-side name/email filter input above the roster (single company's roster; no server search).
- Existing sections (pending invites, invite form, director toggle, can-invite toggle, remove) untouched.

**Prefill consumers:**

- `Gate0Wizard` (`src/components/wizard/Gate0Wizard.tsx`): `RosterMember` gains the field; `toggleRealMember` initializes the selection from `member.preferred_deal_role ?? DEAL_TEAM`, applied only when `platform_onboarding` is enabled. Its local `ASSIGNABLE_DEAL_ROLES` is replaced by `INTERNAL_ASSIGNABLE_DEAL_ROLES` (drops the wrongly offered `seller`/`buyer`).
- `InviteModal` (`src/components/team/InviteModal.tsx`): **extends** the existing recommendation machinery, which today applies `recommendation.phase` (with `phaseTouched`) but not `recommendation.dealRole`. Added symmetrically: role application from the recommendation, a `roleTouched` guard, previous-role capture on apply, and stale-result retraction — mirroring the phase pattern (A9 pre-fill / A14 safeguards).

## Navigation

The AppRail "Company members" entry already exists and shows for **every internal user with a company** (`!is_external && company_id`) — not only managers/delegates. Decision: preserve that behavior unchanged (non-qualifying viewers already land on a closed panel; tightening to `canManage || can_invite` would be a behavioral change with no safety gain). Mobile: AppRail is desktop-only; a mobile path is out of scope and noted as a known limitation.

## Errors and audit

Covered in the API section: 400 (bad/both/neither field, disallowed slug), 403 (non-manager), 404 (not a member), 409 (concurrent change), audit rows on every effective change with rollback on audit failure.

## Testing

Extend `tests/api-v1-members-patch.test.ts` and friends:

- Sets, changes, and clears the preferred role; audit rows use GRANT/REVOKE with old/new detail.
- Rejects `md`, `seller`, `buyer`, `admin`, `cco`, and unknown slugs.
- Rejects an external target; rejects a walled target; rejects a non-member target; rejects a non-manager actor.
- POST rejects promoting a walled user to director.
- Rejects a request carrying both `canInvite` and `preferredDealRole`, and one carrying neither.
- Rejects when `platform_onboarding` is off.
- Idempotent change produces no audit row; concurrent change returns 409; audit-insert failure restores the old value.
- GET: manager with `?includeWalled=true` sees walled rows with `is_walled`; without the parameter, and for non-managers with it, the response is unchanged.
- Gate 0 initializes a selected colleague from their preferred role only when the flag is on, and its selector no longer offers `seller`/`buyer`.
- Invite lookup returns `employee_default` recommendation for a disclosable colleague and never leaks it cross-company.
- InviteModal applies the recommendation, permits user override, and retracts a stale one (existing safeguard tests extended).
- Constants test: DB CHECK allowlist and `INTERNAL_ASSIGNABLE_DEAL_ROLES` stay synchronized.

## Deferred (recorded on #160)

- Company-defined roles CRUD and permission bundles are specified in the [Phase B company access management draft](./2026-08-14-company-access-management-phase-b-design.md). The target uses company-scoped roles, additive direct grants, a protected director/admin control plane, and real enforcement consumers. Roles never imply deal seats.
- Arbitrary per-person permission grants beyond `can_invite`.
- HR actor modeling (department value vs delegation flag).
- Suspend-vs-remove offboarding action (schema already has `users.status='suspended'`).
- Platform-wide wall invariant: make the invite pipeline (`/api/v1/invites`, proposal feasibility) reject deal seats for existing walled users, closing the path this surface's checks do not cover.
- Mobile navigation path to the members page.
