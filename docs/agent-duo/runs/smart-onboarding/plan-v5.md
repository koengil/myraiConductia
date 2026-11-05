---
run_id: smart-onboarding
type: plan
round: 5
---

# Plan v5 — smart lookup, live perimeter preview, personalized welcome brief

**Complete and standalone. `plan-v1` … `plan-v4` are superseded and non-normative; nothing in this document depends on them.** Frozen spec: `spec-v2.md`. Written under the user's Option C decision after `escalation-2.md`: fix the substantive findings, execute without a further plan-review cycle, and let the reviewer's next gate be the PR, where tests are runnable evidence rather than prose promises.

## 0. Resolution of cr-plan-v4.md

| Finding | Resolution | Section |
|---|---|---|
| 5.1 Fake module boundary | One module, only three entry points exported, plus a lint boundary and a test that asserts no subject-accepting export exists | §3 |
| 1.2 / 4.2 Not standalone | Full D8.1–D8.16 ownership and the complete criterion map transcribed into this document | §12.1, §13 |
| 2.1 Missing parity case | Same-company Director → Director permitted, plus different-company Director negative, comparing resolved company role not just success | §12.2 |
| 5.3 Ambiguous candidate algorithm | Exact per-tier algorithm and named positive/negative tests | §7.1, §7.3, §12.2 |

## 1. Governing idea

The repo already separates **identity resolution** from **policy**: `getDocumentViewer` does the DB lookup; `userCanSeeDocument` / `userCanUploadDocument` are pure predicates over a subject. The preview feeds those predicates a *proposed* subject; the welcome brief feeds them the *real* viewer. One decision path, three uses — B2 holds by construction, not by discipline.

## 2. M1 — policy seam

`src/lib/api/v1/documentAccess.ts`:

- Split `DocumentViewer` into `DocumentSubject { isExternal, hasOversight, dealRole, phase }` and `DocumentViewer = DocumentSubject & { userId }`. Predicates take `DocumentSubject`.
- Narrow `DocumentGate.room` from `string` to the `DocumentRoom` union.
- Add `parseDocumentRoom(value: string): DocumentRoom | null`, applied at decode. An unrecognized room is never passed to a predicate, never counted, and forces an opaque unavailable result (§8).
- **Predicate semantics unchanged.** Internal → MNPI → phase order stands. The unknown-room guarantee lives at the decode boundary.

## 3. M2 — perimeter module (resolves 5.1)

**One module: `src/lib/perimeter/perimeter.ts`.** No `index.ts`, no cross-file "private" core.

```
// not exported
function computePerimeterInternal(subject: DocumentSubject, gates: DocumentGate[], ctx): Perimeter

// the only exports
export async function perimeterForProposal(admin, actorId, proposal): Promise<PerimeterResult>
export async function perimeterForMember(admin, actorId, dealId, userId, phase): Promise<PerimeterResult>
export async function perimeterForViewer(admin, userId, dealId): Promise<PerimeterResult>
```

Each entry point constructs its own subject from its own authorization: `assessProposal` (§5), `userIsDealMd` + 409 on downgrade, and `getDocumentViewer`'s membership wall respectively. **No exported function accepts a subject**, so there is nothing to forge — the guarantee is the absence of a door, not a lock on one.

Belt and braces, since this seam has been wrong twice:
- `eslint no-restricted-imports` forbids importing anything but the three entry points from `@/lib/perimeter/*`.
- `perimeter-boundary.test.ts` asserts the module's export surface is exactly those three names (§12.3).

`computePerimeterInternal` performs no IO, so B9 holds structurally. Counts are computed only over rows where `userCanSeeDocument` returns true (B4/B6/B13).

## 4. M20 — `invites.phase` migration

### 4.1 Forward
- `alter table invites add column phase int not null default 0 check (phase >= 0);` — `default 0` makes the backfill exact.
- `create_invite` gains `p_phase int default 0` as the **final** argument via the drop-and-recreate precedent at `20260804160000_invite_safeguard_2fa.sql:328-330`, re-issuing the identical revoke/grant. A defaulted final argument keeps old callers working.
- `accept_invite` keeps `(uuid, uuid)`; body swaps literal `0` for `v_invite.phase` in the `deal_memberships` insert and in the grant audit's `'phase'` key.

Carry path: form state → preflight snapshot (phase joins the snapshot, so changing it invalidates a stale confirmation) → POST body → in-transaction validation (§5.3) → `invites.phase` → `accept_invite` → `deal_memberships.phase` → grant audit.

### 4.2 Gate 0 boundary
Gate 0 invites the creator's **bank** company (`Gate0Wizard.tsx:615-638`). Phase gates external users only, so internal invitees are coerced to phase 0 server-side. Stated, not silently dropped; tested.

### 4.3 Rollback
Dropping a confirmed nonzero pending phase destroys a real access decision. **Not lossless.** Ordered, atomic against `accept_invite`'s `for update` (`invite_safeguard_2fa.sql:673-695`):

1. Revert application code.
2. **One transaction:** `update invites set status='expired' where status='pending' and phase>0 returning id, email, phase, company_id, deal_id;` — contends on the same row lock, so each invite is contained or accepted, never both. Withdrawal audit rows built **only from returned rows**.
3. Revert RPC bodies.
4. Drop the column, only after containment commits.

## 5. M21 — `src/lib/api/v1/proposalFeasibility.ts`

### 5.1 `assessProposal(admin, actorId, proposal)` — order is load-bearing

1. **Tenant coherence, first and unconditional** (actor / company / deal). Runs before `userCanInvite`, whose first line is `if (actor.firm_role === FIRM_ROLE.ADMIN) return true` (`access.ts:304`) — the short-circuit that would otherwise let a firm admin probe another tenant.
2. `userCanInvite` — necessary, **not sufficient**; its docblock states shape is enforced in the route.
3. **Company-role authority, mirroring `invites/route.ts:126-145` exactly:**
   - `actorIsExternal = is_external && firm_role !== ADMIN` → coerce `companyRole = member`.
   - `companyRole` ∈ {director, member}.
   - `director` requires `canManageCompanyMembers(actor, targetCompanyId)`, which is **admin-within-tenant OR director of that same company** (`access.ts`). A delegated `can_invite` member fails it (that predicate demands `company_role === DIRECTOR`), matching "delegated can_invite is send-only for member seats".
   - **Not** a blanket coercion of external-company invitees.
4. Deal-role shape: company type; `INTERNAL_INVITE_DEAL_ROLES` / `EXTERNAL_INVITE_DEAL_ROLES`; `md` never invitable; external deal role derived from `deal_parties.party_role` (`target`/`co_seller` → seller, `acquirer_shortlist`/`counterparty` → buyer).
5. Phase bounds; coerced to 0 for bank-company invitees.

Returns `{ ok: true, subject, isExternalCompany, companyRole, dealRole, phase }` or `{ ok: false, reason: 'forbidden' | 'invalid' | 'unavailable' }`. The subject is consumed only inside `perimeterForProposal` and is not exported.

### 5.3 In-transaction enforcement

Route check stays for early UX; the authoritative check is inside `create_invite`, after its existing `pg_advisory_xact_lock(hashtextextended(v_email,0))`, in this deterministic order (fixed to avoid deadlock):

| # | Row | Lock | Re-derived |
|---|---|---|---|
| 1 | `users` (actor) | `for share` | firm_role, is_external, company_id, company_role, can_invite, tenant_id |
| 2 | `companies` (target) | `for share` | tenant_id, type |
| 3 | `deals` (if any) | `for share` | tenant_id, bank_id |
| 4 | `deal_memberships` (actor's controlling seat) | `for share` | deal_role, access_scope.can_manage_members |
| 5 | `deal_parties` (target company on deal) | `for share` | party_role |

`for share` blocks concurrent update/delete until the invite insert commits, so a revocation either precedes our read or waits until after it. Each failure raises a distinct exception mapped to an opaque 403, with **no** invite row, credential nonce, delivery, or audit side effect. Contention on `users` is accepted: invite creation is low-frequency.

## 6. M6 — `POST /api/v1/invites/perimeter-preview`

Deliberately **not** deal-scoped, so Gate 0 (no deal yet) is served without a third invitation flow (`brief.md:29`). `requireFlag('platform_onboarding')` before auth. Modes:

- `{ proposal: { email, companyId, companyRole, dealId | null, dealRole | null, phase } }` → `perimeterForProposal`. With `dealId: null`, `dealContext: 'proposed'`, document set empty by construction.
- `{ member: { dealId, userId, phase } }` → `perimeterForMember`; 409 on downgrade, matching `members/[userId]`.

Response echoes the resolved subject so the client can prove correspondence (B7). The document query projects only `room, classification, min_phase` — titles and storage ids never enter the computation, so they cannot leave it (B6). B12: an unauthorized actor receives an opaque forbidden result with no perimeter.

## 7. M5 — smart lookup

### 7.1 Candidate companies (resolves 5.3, exact)

`candidateCompaniesFor(admin, actorId, dealId | null)`:

| Actor tier | Deal in context | Candidate set |
|---|---|---|
| External director | yes | **own company only, and only if it is a party to that deal** (`access.ts:317-327`) |
| External director | no | **empty** — `userCanInvite`'s external branch requires `target.dealId`, so no candidate exists |
| External member | any | empty (external members never invite) |
| Internal, `canManageDealMembers(deal)` true | yes | **the deal's bank company plus every company with a `deal_parties` row on that deal** |
| Internal director/admin | no | companies where `canManageCompanyMembers` holds (own company; for admin, companies within the actor's tenant) |
| Internal member with `can_invite` | no | **own company only** (`access.ts:337`, the #145 delegation path) |
| Anyone else | any | empty → lookup returns the neutral unavailable state |

The no-company first keystroke is gated on the candidate set being non-empty. `assessProposal` cannot gate it: `Proposal` requires the `companyId` lookup is trying to find.

### 7.2 Computation

Normalize (`normalizeInviteEmail`) → personal-domain check → verified-domain match **restricted to the candidate set** → `classifyInviteDomain` contradiction → `proposeCompanyLabel` for an unknown domain → recommendation.

#### 7.2.1 Recommendation

Frozen A7 reads "context-appropriate deal role and least-privilege starting phase" — least-privilege qualifies *phase*, not role.

- **External company:** deal role from `party_role`; phase `0`. Reasons `external_party_derived`, `phase_least_privilege`.
- **Bank company (Gate 0, internal Team invites):** deal role `deal_team` — the ordinary bank-side working seat, with `legal` and `read_only` one click away; company role `member`; phase `0`, marked non-applicable. Reasons `internal_bank_team_seat`, `phase_internal_not_applicable`.

Every value is pre-filled where a control exists, visibly a proposal, and overridable (A9).

### 7.3 Scoped warnings

A5 conditions (a) invalid/personal domain and (b) domain mismatch are always available to an authorized actor. Conditions (c) existing platform user, (d) existing deal seat, and (e) existing pending invitation are scoped:

| Condition | Predicate |
|---|---|
| A17 (c) | roster visibility over a company the user belongs to; **OR `canManageDealMembers(admin, actorId, dealId)` for a deal on which that user holds a `deal_memberships` seat** (branch b); **OR** `firm_role ∈ {cco, admin}` **with explicit `actor.tenant_id === targetUser.tenant_id`** — replacing `userCanViewCompany`, which returns true for any CCO/admin without loading the target tenant (`access.ts:154-169`) |
| A18 (d) | `canManageDealMembers` on this deal |
| A6 (e) | `userCanManageInvite` |

**A19 by response shape.** One canonical fixed-order schema:

```
{ normalizedEmail, domain, companyMatch, proposedCompany,
  warnings: [{ id }],
  recommendation: { dealRole, companyRole, phase, reasons: { dealRole, phase } } }
```

An undisclosed condition contributes **no element**. No per-check status map, no count, no suppression-varying order. Reasons are stable ids resolved to copy in the component, so no prose ships from the API. `checks: { existingUser: 'not_permitted' }` is the regression to reject on sight.

## 8. Fail-closed reads

Three outcomes, never conflated: **error** → opaque 503 unavailable (never a partial warning set, company match, or recommendation, and specifically never `total: 0` from a failed document query); **absent** → 404 only for a proven missing resource; **present** → the real answer. The welcome brief renders unavailable rather than an empty brief. Unrecognized rooms take the same path.

## 9. Bound inputs

Discriminated union `lookup | proposal | member`. The `member` key includes canonical deal id, target `userId`, proposed phase, and surface `memberDrawer`; `kind` is part of the key, so a late response for member A cannot satisfy member B. `currentKeyRef` discards any response whose key does not match, regardless of arrival order; `AbortController` is an optimization only. Status `idle | loading | ready | stale | unavailable`; `stale` is entered **synchronously** with the input change that clears derived pre-fill (A13/A14).

## 10. Components

- **M8 `SmartLookupCard`** — mounted in `InviteModal` (M11) and `Gate0Wizard` (M12). Never bypasses the existing preflight confirmation gate (A9/A16).
- **M9 `PerimeterPreview`** — proposal mode in both invite surfaces; member mode in `MemberDrawer` (M13).
- **M10 `WelcomeBrief`** — server component inside `externalDealHome` (M14), retaining that page's own membership wall (C2). Own-company data only; C10's cross-company roster prohibition is unconditional and the Team link carries no roster content.

## 11. Flag-off parity

`requireFlag('platform_onboarding')` precedes auth on both new routes; UI mounts are flag-gated. With the flag off every affected surface behaves exactly as today: Gate 0 Team step, Team `InviteModal`, `MemberDrawer`, external deal home, and both new routes (which must not disclose their existence before auth).

## 12. Verification

### 12.1 D8.1–D8.16 — file and assertion ownership

| # | Obligation | File | Assertion |
|---|---|---|---|
| 1 | A5 warnings, ±ve | `lookup-warnings.test.ts` | Each of (a)–(e) raised when true, absent when false |
| 2 | A6 invitation scoping | `lookup-disclosure.test.ts` | Authorized actor sees pending-invite warning; unauthorized does not |
| 3 | A17/A18 scoping | `lookup-disclosure.test.ts` | Authorized + unauthorized, **including another company and another tenant**; A17 branch (b) positive via `canManageDealMembers` |
| 4 | A19 indistinguishability | `lookup-indistinguishable.test.ts` | **Same normalized request** against two states differing only in the hidden fact → byte-identical responses |
| 5 | A16 failure | `lookup-failure.test.ts` | Injected read error → no recommendation, no pre-fill, no gate bypass |
| 6 | A13/A14 races | `invite-modal-lookup.test.tsx`, `gate0-lookup-preview.test.tsx` | Superseded response never renders or pre-fills; changed input withdraws prior result. **Both surfaces**, parent-level |
| 7 | B2 parity | `perimeter-parity.test.ts` | Generated matrix: band totals ≡ count where `userCanSeeDocument` is true |
| 8 | B6 leakage | `perimeter-preview-api.test.ts` | Response contains no title/filename/storage id/uploader/timestamp; no inaccessible counts |
| 9 | B7/B11 change + phase raise | `member-drawer-preview.test.tsx`, `perimeter-preview-api.test.ts` | Role/phase change alters perimeter with no grant; member preview matches post-raise reality |
| 10 | B13 zero state | `perimeter-preview-api.test.ts` | Explicit zero-access state; **no inaccessible count disclosed** |
| 11 | B10/B8 failure + supersession | `perimeter-preview-api.test.ts`, `member-drawer-preview.test.tsx` | Unavailable renders closed; stale response never renders, including member target change |
| 12 | C6–C8 archetypes | `welcome-brief.test.tsx` | Five archetypes: seller w/ upload, buyer w/o, observer, director w/ invite authority, member w/o |
| 13 | C1/C3 later visit | `welcome-brief.test.tsx` | After phase raise and after permission change, re-render shows new values and actions |
| 14 | C10 cross-company | `welcome-brief.test.tsx` | No roster content from another company on the deal |
| 15 | D1 flag-off parity | `onboarding-flag-off.test.ts` | Gate 0 Team step, Team invite, Member Drawer, external deal home, and **both new routes** unchanged / non-disclosing |
| 16 | D7 E2E | `onboarding-e2e.test.ts` | The seeded path of §14 end to end |

### 12.2 Authority, phase, and race suites

- `api-v1-proposal-feasibility.test.ts` — cross-tenant admin UUID probe; external director own-company constraint; impossible role/company-role combinations; changed party relationship; lost authority.
- `invite-authority-parity.test.ts` — compares the **full** `assessProposal` verdict (tenant, authority, company role, company type, deal role, party role, phase) against the SQL decision across every tier, asserting the **resolved company role**, not just success. Cases, each in **both** TS and RPC:
  - firm admin in tenant → Director permitted
  - **Director of that same target company → Director permitted** (second `canManageCompanyMembers` branch)
  - **Director of a different company → Director refused**
  - internal non-admin non-director → Director refused, Member permitted
  - delegated `can_invite` member → Director refused, Member permitted
  - external director → coerced to Member
  - firm admin cross-tenant → refused before `userCanInvite`
  
  **Runs before anything else touches the send path.**
- `lookup-candidates.test.ts` — delegated `can_invite` own-company first keystroke (positive); unrelated in-tenant company (negative); external director with no deal (negative); external director, other party's domain (negative); internal deal-context set = bank company + parties.
- `invite-write-race.test.ts` — revocation transactions committed **during** the RPC, not merely before entry; asserts no invite, nonce, delivery, or audit row on refusal.
- `invite-phase-carry.test.ts` — override previewed, persisted, re-authorized at send, granted as confirmed; Gate 0 internal coercion to 0.
- `invite-phase-rollback.test.ts` — both containment/acceptance interleavings; old callers against the defaulted argument; existing phase-0 rows.

### 12.3 Cross-cutting obligations

| Obligation | File | Assertion |
|---|---|---|
| A8 no-write | `lookup-readonly.test.ts` | Lookup creates no company, invitation, membership, or grant |
| A11/D3 secrets | `onboarding-no-secrets.test.ts` | No nonce, challenge digest, or storage id in success payloads **or opaque error responses** |
| B9/D4 audit neutrality | `onboarding-audit-neutral.test.ts` | Preview and lookup write no audit row; send, accept, grant, **phase change**, view, download retain current events |
| D4 acceptance gates | `invite-accept-gates.test.ts` | Verification, TOS, and 2FA sequencing survive the `accept_invite` change |
| D4 storage | `onboarding-storage-nonregression.test.ts` | Box and bucket **success, unavailable, compensation/fallback** cases for the shared upload predicate |
| D5 a11y | `onboarding-a11y.test.tsx` | Keyboard reachability; AT announcement of in-flight/stale/unavailable; narrow width |
| D6 voice | `onboarding-copy.test.ts` | No em-dash (U+2014) in the reason-copy map or rendered strings of the three components |
| **5.1 boundary** | `perimeter-boundary.test.ts` | `@/lib/perimeter/perimeter` exports exactly the three entry points; no subject-accepting export |
| D2 fail-closed | `onboarding-fail-closed.test.ts` | Injected read errors on lookup, both preview modes, welcome → opaque unavailable, no partial data |

### 12.4 Parity matrix
Generated over subject × gate space (§12.1 #7). This makes preview/reality drift a build failure rather than a discipline.

## 13. Criterion map

| Criterion | Implementation | Test |
|---|---|---|
| A1 | M8 mounted in **M11 `InviteModal`, M12 `Gate0Wizard`** | 12.1#6 |
| A2 | §5.1 `assessProposal`; §7.1 candidates | 12.2 parity, `lookup-candidates` |
| A3 | §7.2 candidate-scoped verified-domain match | 12.1#1 |
| A4 | §7.2 `proposeCompanyLabel` | 12.1#1 |
| A5 | §7.3 warnings | 12.1#1 |
| A6 | §7.3 `userCanManageInvite` | 12.1#2 |
| A7 | §7.2.1 both branches | 12.1#1, `lookup-candidates` |
| A8 | §7 read-only lib; no writes | 12.3 `lookup-readonly` |
| A9 | M11/M12 keep preflight gate; phase joins snapshot §4.1 | `invite-phase-carry` |
| A10 | No new dependency; deterministic helpers only | code review |
| A11 | §7.3 schema | 12.3 no-secrets |
| A12 | M8 guard before request | 12.1#5 |
| A13/A14 | §9 bound inputs | 12.1#6 |
| A15 | M8 in-flight state | 12.3 a11y |
| A16 | §8 | 12.1#5 |
| A17 | §7.3 three branches | 12.1#3 |
| A18 | §7.3 | 12.1#3 |
| A19 | §7.3 shape | 12.1#4 |
| B1 | M6 server route | 12.1#7 |
| B2 | §3 shared path | 12.1#7 |
| B3–B4 | §3 bands | 12.1#7,#10 |
| B5 | §3 invariant ids | 12.1#8 |
| B6 | §6 projection | 12.1#8 |
| B7 | §6 echo | 12.1#9 |
| B8 | §9 | 12.1#11 |
| B9 | §3 purity | 12.3 audit-neutral |
| B10 | §8 | 12.1#11 |
| B11 | `perimeterForMember` | 12.1#9 |
| B12 | §6 opaque forbidden | `proposal-feasibility` |
| B13 | §3 zero state | 12.1#10 |
| C1/C3 | M10 server component, recomputed per render | 12.1#13 |
| C2 | M14 existing membership wall | 12.1#12 |
| C4–C5 | M10 fields from `perimeterForViewer` | 12.1#12 |
| C6–C8 | M10 capability-ordered actions | 12.1#12 |
| C9 | `ALLOWED_DESTINATIONS.external` | 12.1#12 |
| C10 | M10 own-company only | 12.1#14 |
| C11 | M10 honest empty state | 12.1#10,#12 |
| D1 | §11 | 12.1#15 |
| D2 | §8 | 12.3 fail-closed |
| D3 | §7.3 | 12.3 no-secrets |
| D4 | §4.1 accept unchanged except phase | 12.3 accept-gates, storage |
| D5 | M8/M9/M10 | 12.3 a11y |
| D6 | copy map | 12.3 copy |
| D7 | §14 runbook | 12.1#16 |
| D8 | §12.1 | — |
| D9 | §14 `openapi/phase1.json`, `api-v1.md`, constants | build |
| D10 | §14 gates | CI |

## 14. Demo, docs, gates

M15–M18: extend `docs/03-engineering/onboarding-demo-runbook.md` with the D7 path; update `openapi/phase1.json` and `docs/03-engineering/api-v1.md` for both new routes; document the migration.

**Verification order:** `invite-authority-parity` → `tsc` after M1–M3/M21 → `db:migrate` + `check:db` + phase carry/rollback → targeted vitest → mandatory `npx eslint .`, `npx tsc --noEmit`, `npm test`, `npm run build` (Node 22).

## 15. Surfaces

M1 policy seam · M2 perimeter module · M4 lookup lib · M5 lookup route · M6 preview route · M8/M9/M10 components · M11 InviteModal · M12 Gate0Wizard · M13 MemberDrawer · M14 externalDealHome · M15–M18 demo/docs · M20 migration · M21 feasibility.
