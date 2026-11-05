---
run_id: smart-onboarding
type: plan
round: 4
---

# Plan v4 — smart lookup, live perimeter preview, personalized welcome brief

**This is the complete operative plan. `plan-v1.md`, `plan-v2.md`, and `plan-v3.md` are superseded and non-normative.** Frozen spec: `spec-v2.md`. User authorized this fourth round in response to `escalation.md` (Option A: proceed, TOCTOU closure retained).

## 0. Resolution of cr-plan-v3.md

| Finding | Resolution | Section |
|---|---|---|
| 1.1 A7 bank-side recommendation, D6 mismap, A1 sites | Internal recommendation defined deterministically; D6 bound to copy sites with a mechanical assertion; A1 maps M11/M12 | §7.2.1, §12.3, §13 |
| 2.1 Silent Director-authority narrowing | Actor-specific rule restored verbatim from the shipped route, in TS and SQL, with parity cases | §5.1, §5.3, §12.2 |
| 3.1 Non-atomic rollback containment | Single-transaction `UPDATE … RETURNING`, audit built only from returned rows, revert after commit | §4.3 |
| 4.1 Cross-cutting assertions too narrow | Error-response secrets, phase-change audit, TOS/2FA/verification fixtures, named Box suites, D6 | §12.3 |
| 5.1 Branded subject blocks member + welcome | Private pure core behind three entry points, each with its own constructor | §3.2 |
| 5.2 Unlocked authority rows; parity too narrow | Deterministic `FOR SHARE` order inside the RPC; parity compares the full verdict | §5.3, §12.2 |
| 5.3 Missing `can_invite` and A17 branch (b) | Both restored with positive and negative tests | §7.1, §7.3 |

## 1. Governing idea (unchanged, and affirmed in review)

The repo already separates **identity resolution** from **policy**. `getDocumentViewer` does the DB lookup; `userCanSeeDocument` and `userCanUploadDocument` are pure predicates over a subject. The preview feeds those predicates a *proposed* subject; the welcome brief feeds them the *real* viewer. One decision path, three uses — so "what they'll see" cannot drift from what they see.

## 2. M1 — policy seam

`src/lib/api/v1/documentAccess.ts`:

- Split `DocumentViewer` into `DocumentSubject { isExternal, hasOversight, dealRole, phase }` and `DocumentViewer = DocumentSubject & { userId }`. Predicates take `DocumentSubject`; nothing else changes.
- Narrow `DocumentGate.room` from `string` to the `DocumentRoom` union.
- Add `parseDocumentRoom(value: string): DocumentRoom | null`, applied at decode. An unrecognized room is never passed to a predicate, never counted, and forces an opaque unavailable result (§8).
- **Predicate semantics are deliberately unchanged.** The Internal → MNPI → phase order stands. The unknown-room guarantee lives at the decode boundary, not inside the predicate.

## 3. M2 — the pure core and its three entry points

### 3.1 `src/lib/perimeter/perimeter.ts` (pure, not exported publicly)

`computePerimeterInternal(subject: DocumentSubject, gates: DocumentGate[], ctx): Perimeter`

Returns destinations (via `canAccessDestination`), survivor-only document bands, capabilities (`userCanUploadDocument`, `externalSubjectCanInvite`), and invariant ids `external_never_internal_room` / `external_never_mnpi`. Counts are computed **only** over rows where `userCanSeeDocument` returns true (B4/B6/B13). It performs no IO, so B9 (preview grants nothing, writes no audit) holds structurally.

### 3.2 Three authorized entry points (resolves 5.1)

The pure core is module-private. `src/lib/perimeter/index.ts` exports exactly three functions, each constructing its own subject from its own authorization:

| Entry point | Authorization | Used by |
|---|---|---|
| `perimeterForProposal(admin, actorId, proposal)` | `assessProposal` (§5) | Lookup, proposal preview |
| `perimeterForMember(admin, actorId, dealId, userId, phase)` | `userIsDealMd` + 409 on downgrade | Member Drawer preview (B11) |
| `perimeterForViewer(admin, userId, dealId)` | `getDocumentViewer` membership wall | Welcome brief (C1–C11) |

No exported type lets a caller hand in a subject. The forging concern is closed by **not exposing a subject-accepting function at all**, which is stronger than a brand and leaves member and welcome paths usable. `AuthorizedSubject` and its brand are dropped as unnecessary.

## 4. M20 — `invites.phase` migration

### 4.1 Forward

`supabase/migrations/<ts>_invite_phase.sql`:

- `alter table invites add column phase int not null default 0 check (phase >= 0);` — `default 0` makes the backfill exact and preserves every existing row's real meaning.
- `create_invite` gains `p_phase int default 0` as the **final** argument, via the drop-and-recreate precedent at `20260804160000_invite_safeguard_2fa.sql:328-330`, re-issuing the identical revoke/grant. A defaulted final argument keeps old callers working unchanged.
- `accept_invite` keeps its `(uuid, uuid)` signature. Body swaps the literal `0` for `v_invite.phase` in the `deal_memberships` insert and in the `'phase'` key of the grant audit detail.

Carry path: form state → preflight snapshot (phase joins the snapshot, so changing it invalidates a stale confirmation) → POST body → in-transaction validation (§5.3) → `invites.phase` → `accept_invite` → `deal_memberships.phase` → grant audit.

### 4.2 Gate 0 boundary

Gate 0 invites the creator's **bank** company (`Gate0Wizard.tsx:615-638`). Phase gates external users only, so internal invitees are coerced to phase 0 server-side. This is stated, not silently dropped, and tested (§12.2).

### 4.3 Rollback (resolves 3.1)

Dropping a confirmed nonzero pending phase destroys a real access decision. **This is not lossless.** Ordered, with containment atomic against `accept_invite`'s `for update` on the invite row (`invite_safeguard_2fa.sql:673-695`):

1. Revert application code (stops new nonzero phases).
2. **One transaction:** `update invites set status='expired' where status='pending' and phase>0 returning id, email, phase, company_id, deal_id;` Contends on the same row lock `accept_invite` takes, so each invite is either contained or accepted, never both. Write withdrawal audit rows **only from the returned rows**, so the audit never claims to have contained an invite that was accepted.
3. Revert the RPC bodies.
4. Drop the column — only after containment commits.

Tested in both interleavings: containment wins and acceptance raises `invite_not_pending` without a grant; or acceptance wins and the already-granted phase remains truthful. No silent phase-0 fallback.

## 5. M21 — `src/lib/api/v1/proposalFeasibility.ts`

### 5.1 `assessProposal(admin, actorId, proposal)`

Order is load-bearing:

1. **Tenant coherence, first and unconditional.** Actor tenant vs company tenant vs deal tenant. This runs *before* `userCanInvite`, whose first line is `if (actor.firm_role === FIRM_ROLE.ADMIN) return true` (`access.ts:304`) — the short-circuit that would otherwise let a firm admin probe another tenant.
2. `userCanInvite` — necessary, **not sufficient**. Its own docblock states shape is enforced in the route.
3. **Company role authority (restores 2.1), mirroring `invites/route.ts:126-145` exactly:**
   - `actorIsExternal = is_external && firm_role !== ADMIN` → coerce `companyRole = member`.
   - `companyRole` must be `director | member`.
   - `companyRole === director` requires `canManageCompanyMembers(actor, targetCompanyId)` — which is admin-within-tenant, or director **of that same company**. A delegated `can_invite` member fails it (that predicate requires `company_role === DIRECTOR`), matching the route's "delegated can_invite is send-only for member seats".
   - **Not** a blanket coercion of external-company invitees. The v3 rule wrongly denied the firm-admin Director path the server permits.
4. Deal-role shape: company type; `INTERNAL_INVITE_DEAL_ROLES` / `EXTERNAL_INVITE_DEAL_ROLES`; `md` never invitable; external deal role derived from `deal_parties.party_role` (`target`/`co_seller` → seller, `acquirer_shortlist`/`counterparty` → buyer).
5. Phase bounds; coerced to 0 for bank-company invitees.

Returns `{ ok: true, subject, isExternalCompany, companyRole, dealRole, phase }` or `{ ok: false, reason: 'forbidden' | 'invalid' | 'unavailable' }`. The subject is consumed only inside `perimeterForProposal`; it is not exported.

### 5.3 In-transaction enforcement (resolves 5.2)

The route check stays for early UX. The authoritative check moves inside `create_invite`, which already runs `security definer` and already takes `pg_advisory_xact_lock(hashtextextended(v_email,0))`.

That advisory lock serializes competing sends to the same email. It does **not** serialize revocation of the rows the decision depends on. So after the advisory lock and before the insert, in this deterministic order (fixed to avoid deadlock):

| Order | Row | Lock | Re-derived |
|---|---|---|---|
| 1 | `users` (actor) | `for share` | firm_role, is_external, company_id, company_role, can_invite, tenant_id |
| 2 | `companies` (target) | `for share` | tenant_id, type |
| 3 | `deals` (if any) | `for share` | tenant_id, bank_id |
| 4 | `deal_memberships` (actor's controlling seat) | `for share` | deal_role, access_scope.can_manage_members |
| 5 | `deal_parties` (target company on deal) | `for share` | party_role |

`for share` blocks a concurrent `update`/`delete` of those rows until this transaction commits, so a revocation either lands before our read (and we see it) or waits until after our insert. The window closes.

Each failure raises a distinct exception mapped to an opaque 403, with **no** invite row, credential nonce, delivery, or audit side effect. `for share` on `users` adds contention only on invite creation, which is low-frequency; noted as an accepted cost.

## 6. M6 — `POST /api/v1/invites/perimeter-preview`

Deliberately **not** deal-scoped, so Gate 0 (where no deal exists yet) is served without a third invitation flow (`brief.md:29`). `requireFlag('platform_onboarding')` runs before auth. Two modes:

- `{ proposal: { email, companyId, companyRole, dealId | null, dealRole | null, phase } }` → `perimeterForProposal`. With `dealId: null`, `dealContext: 'proposed'` and the document set is empty by construction.
- `{ member: { dealId, userId, phase } }` → `perimeterForMember`; 409 on downgrade, matching `members/[userId]` semantics.

Response echoes the resolved subject so the client can prove correspondence (B7). The document query projects only `room, classification, min_phase` — titles and storage ids never enter the computation, so they cannot leave it (B6).

## 7. M5 — smart lookup

### 7.1 Candidate companies (resolves 5.3a)

`candidateCompaniesFor(admin, actorId, dealId | null)` mirrors real invite authority per tier:

| Actor | Candidates |
|---|---|
| External director | own company only (`access.ts:317-327`) |
| Internal, deal in context | companies whose seats they may manage via `canManageDealMembers` + deal parties |
| Internal, no deal, director/admin | companies they may manage via `canManageCompanyMembers` |
| **Internal member with `can_invite`, no deal** | **own company** (`access.ts:337`, delegated path from #145) |
| Anyone else | none — lookup returns the neutral unavailable state |

The no-company first keystroke is gated on the actor having invitation-composition authority *somewhere* in the surface context; `assessProposal` cannot gate it, since `Proposal` requires the `companyId` lookup is trying to find.

### 7.2 Computation

Normalize (`normalizeInviteEmail`) → personal-domain check → verified-domain match **restricted to the candidate set** → `classifyInviteDomain` contradiction → `proposeCompanyLabel` for an unknown domain → recommendation.

#### 7.2.1 Recommendation (resolves 1.1)

Frozen A7 reads "context-appropriate deal role and least-privilege starting phase" — least-privilege qualifies *phase*, not role.

- **External company (party-derived):** deal role from `party_role`; phase `0`; reasons `external_party_derived`, `phase_least_privilege`.
- **Bank company (Gate 0 and internal Team invites):** deal role `deal_team` — the ordinary bank-side working seat, with `legal` and `read_only` one click away; company role `member`; phase `0` and marked non-applicable. Reasons `internal_bank_team_seat`, `phase_internal_not_applicable`.

Every value is pre-filled where a control exists, visibly a proposal, and overridable (A9). Tested on both surfaces.

### 7.3 Scoped warnings (resolves 5.3b)

`A17` has three branches; all three are implemented:

1. actor may view the roster of a company the user belongs to;
2. **actor is authorized over the membership of a deal on which the user holds a seat** (was missing in v3);
3. actor is a firm overseer **within the user's tenant** — explicit tenant equality, replacing `userCanViewCompany`, which returns true for any CCO/admin without loading the target tenant (`access.ts:154-169`).

`A18` uses deal-membership authority; existing-invite disclosure uses `userCanManageInvite`.

**A19 by response shape.** One canonical fixed-order schema: `{ normalizedEmail, domain, companyMatch, proposedCompany, warnings: [{ id }], recommendation: { dealRole, companyRole, phase, reasons: { dealRole, phase } } }`. An undisclosed condition contributes **no element**. No per-check status map, no count, no suppression-varying order. Reasons are stable ids resolved to copy in the component, so no prose ships from the API. `checks: { existingUser: 'not_permitted' }` is named here as the regression to reject on sight.

## 8. Fail-closed reads

Three distinct outcomes, never conflated: **error** → opaque 503 unavailable (never a partial warning set, company match, recommendation, and specifically never `total: 0` from a failed document query); **absent** → 404 only for a proven missing resource; **present** → the real answer. The welcome brief renders unavailable rather than an empty brief. An unrecognized room takes the same path.

## 9. Bound inputs

Discriminated union: `lookup | proposal | member`. The `member` key includes canonical deal id, target `userId`, proposed phase, and surface `memberDrawer`, and `kind` is part of the key — so a late response for member A cannot satisfy member B. `currentKeyRef` discards any response whose key does not match, regardless of arrival order; `AbortController` is an optimization only. Status `idle | loading | ready | stale | unavailable`; `stale` is entered **synchronously** with the input change that clears derived pre-fill (A13/A14).

## 10. Components

- **M8 `SmartLookupCard`** — mounted in `InviteModal` (M11) and `Gate0Wizard` (M12). Never bypasses the existing preflight confirmation gate (A9/A16).
- **M9 `PerimeterPreview`** — proposal mode in both invite surfaces; member mode in `MemberDrawer` (M13).
- **M10 `WelcomeBrief`** — a server component inside `externalDealHome`, retaining that page's own membership wall. Own-company data only; C10's cross-company roster prohibition is unconditional and the Team link carries no roster content.

## 11. Flag-off parity

`requireFlag('platform_onboarding')` precedes auth on both new routes; UI mounts are flag-gated. With the flag off, every affected surface behaves exactly as today.

## 12. Verification

### 12.1 D8.1–D8.16

Thirteen files as in v3 §12.1, unchanged and affirmed in review. Indistinguishability is tested as the **same normalized request against two states differing only in the hidden fact** (a cross-address deep-equality can never pass, since `normalizedEmail` differs).

### 12.2 Authority, phase, and race suites

- `api-v1-proposal-feasibility.test.ts` — cross-tenant admin UUID probe; external director own-company constraint; impossible role/company-role combinations; changed party relationship; lost authority.
- `invite-authority-parity.test.ts` — **compares the full `assessProposal` verdict** (tenant, authority, company role, company type, deal role, party role, phase) against the SQL decision across every authority tier. Comparing only `userCanInvite` cannot detect shape divergence, since that helper deliberately excludes shape — and would have blessed the v3 Director coercion. **Runs before anything else touches the send path.**
- Director-authority cases, positive and negative, in TS and RPC: firm admin in tenant → Director permitted; internal non-admin non-director of target → 403; delegated `can_invite` member → Director refused, Member permitted; external director → coerced to Member.
- `invite-write-race.test.ts` — paused/interleaved revocation transactions committed *during* the RPC, not merely before entry; asserts no invite, nonce, delivery, or audit row on refusal.
- `invite-phase-carry.test.ts` — override previewed, persisted, re-authorized at send, granted as confirmed; Gate 0 internal coercion to 0.
- `invite-phase-rollback.test.ts` — both containment/acceptance interleavings; old callers against the defaulted argument; existing phase-0 rows.

### 12.3 Cross-cutting obligations (resolves 4.1)

| Obligation | File | Assertion |
|---|---|---|
| A11/D3 secrets | `onboarding-no-secrets.test.ts` | No credential nonce, challenge digest, or storage id in success payloads **or opaque error responses** |
| B9/D4 audit neutrality | `onboarding-audit-neutral.test.ts` | Preview and lookup write no audit row; send, accept, grant, **phase change** (`spec-v2.md:153`), view, download all retain current events |
| D4 acceptance gates | `invite-accept-gates.test.ts` | Fixtures proving verification, TOS, and 2FA sequencing survive the `accept_invite` change unchanged |
| Storage | `onboarding-storage-nonregression.test.ts` | Named Box and bucket **success, unavailable, and compensation/fallback** cases for the shared upload predicate refactor |
| D5 a11y | `onboarding-a11y.test.tsx` | Keyboard reachability, AT announcement of in-flight/stale/unavailable, narrow-width behavior |
| **D6 voice** | `onboarding-copy.test.ts` | No em-dash (U+2014) in the reason-copy map or the rendered strings of `SmartLookupCard`, `PerimeterPreview`, `WelcomeBrief`; runbook additions reviewed against the Conductia voice contract (`spec-v2.md:199`) |

### 12.4 Parity matrix

Generated over the subject × gate space, asserting `computePerimeterInternal` band totals equal the count of rows where `userCanSeeDocument` returns true. This is what makes preview/reality drift a build failure rather than a discipline.

## 13. Criterion map

Every A1–A19, B1–B13, C1–C11, D1–D10 criterion maps to an implementation site and a verifying test. A1 → M4/M5 **and the real integration sites M11 (`InviteModal`) and M12 (`Gate0Wizard`)**. D6 → §12.3 copy contract, **not** the Gate 0 flow boundary (the v3 mismap). A7 → §7.2.1 both branches. Full table maintained in this section during execution.

## 14. Demo, docs, gates

M15–M18: seeded demo path extending `onboarding-demo-runbook.md`; `openapi/phase1.json` and `docs/03-engineering/api-v1.md` updated for the new route; migration documented.

**Verification order:** `invite-authority-parity` → `tsc` after M1–M3/M21 → `db:migrate` + `check:db` + phase-carry/rollback → targeted vitest → mandatory `npx eslint .`, `npx tsc --noEmit`, `npm test`, `npm run build` (Node 22).

## 15. Surfaces

M1 policy seam · M2 perimeter core + 3 entry points · M4 lookup lib · M5 lookup route · M6 preview route · M8/M9/M10 components · M11 InviteModal · M12 Gate0Wizard · M13 MemberDrawer · M14 externalDealHome · M15–M18 demo/docs · M20 migration · M21 feasibility.
