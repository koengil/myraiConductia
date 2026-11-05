---
run_id: smart-onboarding
type: plan
round: 3
---

# Plan v3 — Smart onboarding demo experience

**This is the complete operative plan.** It supersedes `plan-v1.md` and `plan-v2.md` entirely; neither is normative. Every frozen criterion of `spec-v2.md` §6 is mapped to code and verification here (§13). Criterion references are to `spec-v2.md`.

## 0. Resolution of `cr-plan-v2.md`

| Finding | Verdict | Resolution |
|---|---|---|
| 1.3 v2 claimed supersession while deleting design | Accepted, my error | This document restores every unchanged v1 section and adds the §13 criterion map |
| 3.3 rollback destroys confirmed nonzero pending phases | Accepted, my error — "no data loss" was false | §4.4 ordered rollback with containment |
| 4.1 cross-cutting tests unowned | Accepted | §12 gives each a file, fixture, and assertion |
| 5.1a "unskippable" overclaimed | Accepted — structural typing defeats it | §5.2 branded type + single entry point |
| 5.1b send-time TOCTOU | Accepted on merit, though pre-existing | §5.3 authority and shape move **inside** the write transaction, with mandatory parity tests |
| 5.2 lookup candidates overbroad | Accepted | §7.1 candidate set derived from invite authority, incl. the no-company first keystroke |

**On 5.1b.** The TOCTOU predates this work: `POST /api/v1/invites` checks authority in the route, then calls `create_invite`, which today enforces tenant equality in-transaction but not actor authority, party relationship, company type, or role derivation. I could have argued scope. I am closing it because this change adds a new authority-bearing input (`phase`) that flows into that exact write, and because the RPC already performs security-definer validation in-transaction, so the pattern exists rather than being invented. The real risk is not effort but **divergence**: SQL re-derivation that disagrees with the TypeScript predicate would silently break shipped Gate 0 and Team invitations. §12 therefore makes TS/SQL parity a mandatory test, not a hope.

## 1. Governing idea

`getDocumentViewer()` resolves identity; `userCanSeeDocument()` and `userCanUploadDocument()` are pure predicates over the policy-relevant fields. The preview feeds them a **proposed** subject; the welcome brief feeds them the **real** viewer. One decision path, three uses, so the preview and lived access cannot drift. §12's generated parity matrix fails the build if they ever do.

## 2. M1 — the policy seam

```ts
export type DocumentSubject = { isExternal: boolean; hasOversight: boolean; dealRole: string | null; phase: number };
export type DocumentViewer = DocumentSubject & { userId: string };
export type DocumentGate = { room: DocumentRoom; classification: number; min_phase: number };
export function parseDocumentRoom(value: unknown): DocumentRoom | null;
```

`userCanSeeDocument` / `userCanUploadDocument` take `DocumentSubject`. Existing call sites pass a `DocumentViewer`, which structurally satisfies it, so **no call site changes** and Wall 1 (internal room) / Wall 2 (MNPI) / Wall 3 (phase) ordering is untouched.

`DocumentGate.room` is the `DocumentRoom` union, not `string`. Every decoded row passes through `parseDocumentRoom`; an unrecognized value is **never passed to the predicate and never counted**, and makes the whole response an opaque unavailable result (§8). I did not change the predicate's real-access semantics to rescue plan-v1's false claim that it denies unknown rooms — it does not. The guarantee lives at the decode boundary, where it is true, and §12 tests it.

## 3. M2 — `perimeter.ts`, pure

```ts
export type PerimeterSubject = DocumentSubject & { companyId: string; companyRole: string; companyIsPartyToDeal: boolean };
export type PerimeterBand = { room: DocumentRoom; minPhase: number; count: number };
export type Perimeter = {
  destinations: DestinationId[];
  documents: { total: number; bands: PerimeterBand[] };
  capabilities: { canUpload: boolean; canSeeTeam: boolean; canInviteTeammate: boolean };
  invariants: PerimeterInvariantId[];
};
export function computePerimeter(subject: AuthorizedSubject, docs: DocumentGate[]): Perimeter;
```

- **Documents (B3, B4, B6, B13).** Filter `docs` with `userCanSeeDocument`. `total` = survivors. `bands` groups **only survivors** by `(room, min_phase)`, so a room or band with no survivor yields **no entry** — a count for an unreachable band is inexpressible (B4), and no count of inaccessible documents can exist (B6). `total: 0` + `bands: []` is the honest zero state (B13).
- **Destinations (B3).** `canAccessDestination(subject.isExternal ? 'external' : 'storm', d)`. External yields exactly `mandate`, `dataRoom`, `team` (C9).
- **Upload (B3).** `userCanUploadDocument(subject, DOCUMENT_ROOM.DEAL, SELLER_MAX_CLASSIFICATION)`.
- **Teammate invite (B3).** `externalSubjectCanInvite(subject)` (M3).
- **Invariants (B5).** Stable ids, always present for an external subject: `external_never_internal_room`, `external_never_mnpi`. Ids not prose, so copy lives in the component and no free text ships from the API. Unconditional and phase-independent.

Pure and synchronous: it performs no IO, so it **cannot** write an audit row. B9 holds structurally (D4).

## 4. M20 — migration: the confirmed phase must survive send

### 4.1 Why (A9)

`accept_invite` inserts `phase, 0` as a literal and audits `'phase', 0`; `invites` has no `phase` column; the send route never mentions phase. Frozen A9 requires the inviter to confirm company, role, **and phase** before sending. Without persistence, a confirmed phase 2 previews phase-2 access and grants phase 0 — the preview becomes a lie at the only moment that matters. Spec Q12 admits a migration when persistence proves necessary.

### 4.2 Forward

`supabase/migrations/<ts>_invite_phase.sql`:

```sql
alter table invites add column phase int not null default 0 check (phase >= 0);
```

`default 0` makes the backfill exact — every existing pending invite keeps today's behavior, so the migration is safe to apply ahead of the code (forward compatibility: old callers omit `p_phase`, get 0, behave identically).

`create_invite` gains `p_phase int default 0` as its final argument. This follows the repo's own precedent: `20260804160000…sql:328-330` already dropped and recreated this function with a changed signature. The plan drops the current 8-arg signature, creates the 9-arg version, and re-issues the identical `revoke`/`grant` pair.

`accept_invite` keeps `(uuid, uuid)`; its body changes `phase, 0` → `phase, v_invite.phase` in the `deal_memberships` insert and `'phase', 0` → `'phase', v_invite.phase` in the grant audit, so the audit states the phase actually granted.

**Carry path:** form state → preflight snapshot (phase joins the snapshot, so changing it invalidates a stale confirmation) → `POST /api/v1/invites` → in-transaction validation (§5.3) → `invites.phase` → `accept_invite` → `deal_memberships.phase` → grant audit.

**Gate 0 boundary, stated not dropped.** Gate 0 invitees are internal (`deal_team`/`legal`/`read_only`) and phase gates external users only (`spec-v2.md:51`). Gate 0 exposes no phase control; the transaction coerces phase to 0 for a bank-company invitee. §12 tests that boundary.

### 4.3 Rollback is ordered, and it is not lossless (3.3)

Plan-v2 said dropping the column causes "no data loss." **That was false.** A pending invite whose inviter explicitly confirmed phase 2 carries a real access decision; dropping the column destroys it, and acceptance afterwards would silently grant and audit phase 0 — the same lie the migration exists to prevent, arriving through the back door.

Ordered rollback:

1. **Revert app code first** so no new nonzero invite can be created.
2. **Contain existing nonzero pending rows** before touching the column. `select` pending invites with `phase > 0`; set them `status = 'expired'` and record an `audit_log` row per invite naming the confirmed phase being withdrawn. Those recipients must be re-invited under the reverted (phase-0) semantics. This makes the loss **explicit and recoverable** rather than silent.
3. Revert `accept_invite` and `create_invite` bodies/signatures.
4. `alter table invites drop column phase;`

**Containment if the migration is applied without the app:** the `default 0` means every path behaves exactly as today, so a partial deploy is inert.

§12 covers forward-compatibility (old caller, phase-0 rows), the nonzero-pending rollback path, and the acceptance boundary in both directions.

## 5. M21 — authorization: one path, branded, atomic

### 5.1 `assessProposal`

`src/lib/api/v1/proposalFeasibility.ts` answers one question: **could this actor send this exact invitation right now?**

```ts
export type Proposal = { email: string; companyId: string; companyRole: string; dealId: string | null; dealRole: string | null; phase: number };
export type Feasibility = { ok: true; subject: AuthorizedSubject; isExternalCompany: boolean } | { ok: false; reason: 'forbidden' | 'invalid' | 'unavailable' };
export async function assessProposal(admin, actorId, proposal): Promise<Feasibility>;
```

Checks, all fail-closed, in order:

1. **Tenant coherence, first and unconditionally** — actor, target company, and deal tenants must match. This closes the hole plan-v1 opened: `userCanInvite` returns `true` for a firm admin *before* any tenant check (`access.ts:304`), so v1's preview would have disclosed cross-tenant document counts, regressing the invariant #116/#141/#144 hardened. Feasibility never inherits that short circuit.
2. `userCanInvite(admin, actorId, { companyId, dealId })` — necessary, not sufficient. Its own docblock says shape is "enforced in the route."
3. **Shape** — company type → internal/external; `INTERNAL_INVITE_DEAL_ROLES` / `EXTERNAL_INVITE_DEAL_ROLES` allowlist; `md` never invitable; external invitee coerced to `company_role: member`; deal role must match the company's `deal_parties.party_role` (target/co_seller → seller, acquirer_shortlist/counterparty → buyer).
4. **Phase bounds** — non-negative; coerced to 0 for a bank-company invitee.

### 5.2 The subject is branded (5.1a)

Plan-v2 claimed returning the subject only on `ok: true` made ordering "unskippable." It does not: structural typing lets any caller build the object literal. Fixed properly:

```ts
declare const authorized: unique symbol;
export type AuthorizedSubject = PerimeterSubject & { readonly [authorized]: true };
```

The brand is a module-private symbol, so `AuthorizedSubject` is constructible **only** inside `proposalFeasibility.ts`. `computePerimeter` accepts only `AuthorizedSubject`. A caller cannot compute a perimeter for a proposal it did not first prove feasible — enforced by the compiler, not by convention.

### 5.3 Authority and shape move inside the write transaction (5.1b)

The route keeps calling `assessProposal` before `create_invite` for early, friendly failure. That is **UX, not the wall.** The wall moves into the transaction.

`create_invite` already loads actor tenant, validates email shape, validates company and deal tenant, and takes `pg_advisory_xact_lock(hashtextextended(v_email, 0))` — which already serializes concurrent sends for the same address. The new checks slot into that existing structure, after the tenant checks and under the same lock:

- Load the actor's `firm_role`, `is_external`, `company_id`, `company_role`, `can_invite` **inside** the transaction and re-derive invitation authority (the three `userCanInvite` tiers).
- Load the target company's `type`; re-derive internal/external and enforce the deal-role allowlist; reject `md`.
- For an external invitee, re-check the `deal_parties` row and re-derive the seller/buyer deal role from `party_role`, rejecting a mismatch.
- Coerce `company_role` to `member` for an external invitee; require director privilege where the tier demands it.
- Validate `p_phase >= 0` and coerce to 0 for a bank-company invitee.

Each failure raises a distinct exception mapped to an opaque `403` by the route, so no invite row, credential nonce, delivery, or audit entry is produced. Authority lost, party relationship changed, company type changed, or role privilege revoked between compose and send now fails **at the write**, atomically, rather than in a window.

**The divergence risk is the real one.** SQL re-derivation that disagrees with the TS predicate would break shipped Gate 0 and Team invitations. §12 makes TS/SQL parity a mandatory test across every tier — firm admin, internal staff with and without `canManageDealMembers`, internal via `can_invite`, external director, external member — asserting that `userCanInvite` and the transaction agree on every case.

## 6. M6 — `POST /api/v1/invites/perimeter-preview`

**Deliberately not under `/deals/{dealId}/`.** Gate 0 has no deal yet, so a deal-scoped route could not serve it and would force the third invitation flow `brief.md:29` prohibits. One endpoint, optional deal context, both surfaces.

Handler order: `requireFlag('platform_onboarding')` → `requireApiUser()` → resolve → authorize → compute. The flag gate precedes authentication-dependent disclosure, so with the flag off the route reveals nothing about its existence beyond the standard flag error (D1).

```jsonc
{ "proposal": { "email": "…", "companyId": "…", "companyRole": "member",
                "dealId": "…|null", "dealRole": "seller|null", "phase": 0 } }
{ "member": { "dealId": "…", "userId": "…", "phase": 2 } }
```

- `proposal` → `assessProposal`; `403` on `forbidden`, `400` on `invalid`, `503` on `unavailable`.
- `member` → `userIsDealMd`, the same predicate the phase-raise PATCH requires, and the same `409` on a downgrade, so the preview never depicts a consequence the actor could not bring about.
- **No `dealId` (Gate 0)** → feasibility runs without a deal; the document set is empty by construction because the deal does not exist. Response carries `dealContext: "proposed"`; the UI states plainly that the new deal has no documents yet. Honest rather than hypothetical: destinations, capabilities, and invariants are exactly what a Gate 0 inviter can act on.

**Response** echoes the subject so the client can prove the answer matches the inputs on screen (B8):

```jsonc
{ "subject": { "kind": "proposal", "dealRole": "seller", "companyRole": "member", "phase": 0 },
  "dealContext": "existing",
  "destinations": ["mandate", "dataRoom", "team"],
  "documents": { "total": 3, "bands": [ { "room": "deal", "minPhase": 0, "count": 3 } ] },
  "capabilities": { "canUpload": true, "canSeeTeam": true, "canInviteTeammate": false },
  "invariants": ["external_never_internal_room", "external_never_mnpi"] }
```

Document query projects `room, classification, min_phase` **only** — titles, filenames, storage ids, uploader, and timestamps never enter the computation, so they cannot escape it (B6). Read-only on every path (B9).

**Gate 0 confirmation boundary.** The wizard keeps queueing chips locally and keeps its create-then-send ordering unchanged. The preview attaches to the queued chip before create; the wizard's existing final confirm is the explicit human confirmation A9 requires. No new invitation path (D6).

## 7. M5 — `POST /api/v1/invites/lookup`

Handler order identical to §6, flag first.

### 7.1 Candidate companies come from invitation authority (5.2)

Plan-v2 gave an external actor "own company plus every party to the deal" and internal staff "every company in the tenant." Neither is authority. `userCanInvite` permits an external director to invite **only their own company** (`access.ts:317-327`), and not every in-tenant company is a company an internal actor may invite into.

```ts
export async function candidateCompaniesFor(admin, actorId, dealId: string | null): Promise<CompanyRef[] | 'unavailable'>;
```

- **External director** → their own company only, and only when that company is a party to the deal in context. External member → empty.
- **Firm admin** → companies **in the actor's tenant** (never the bare short circuit).
- **Internal staff** → companies they could actually invite into for this deal context: the bank company, plus parties to the deal when they hold seat-management rights on it; otherwise companies they hold director/admin rights over.

The verified-domain match runs **only within this set**. A company the actor may not identify can never be named, so no match, evidence, or name leaks.

**First keystroke, no company selected (5.2).** `Proposal` requires a `companyId`, but lookup is trying to find one, so `assessProposal` cannot gate the first keystroke. Resolution: lookup requires **invitation-composition authority in the surface context** — the actor must be able to invite *somewhere* in this context (`candidateCompaniesFor` non-empty), else `403`. Identification is then scoped to that set. Once company and role inputs exist, exact feasibility applies via `assessProposal` before any recommendation is returned.

### 7.2 Computation

1. `normalizeInviteEmail` → `400` on malformed (A12). The client also suppresses the request; this is the server's own wall.
2. `inviteEmailDomain` + `isPersonalInviteDomain` → warning `personal_domain` (A5a).
3. **Company match (A3)** — `company_verified_domains` restricted to the §7.1 candidate set, matched via `domainMatchesVerifiedDomain`. A hit yields `companyMatch: { companyId, name, evidence: { verifiedDomain } }` (known-domain evidence).
4. **Domain contradiction (A5b)** — with a company selected, `classifyInviteDomain(email, selectedCompanyDomains)`: `mismatch` → `domain_mismatch`; `unverified` → `company_domain_unverified`.
5. **Label proposal (A4)** — only when there is no match and the domain is not personal. `proposeCompanyLabel(domain)` takes the registrable label, splits on `-`, title-cases, returns `{ label, unverified: true }`. Pure and deterministic (A10).
6. **Recommendation (A7)** — `dealRole` derived from the selected company's `deal_parties.party_role`; `companyRole: member` always (Q5); `phase: 0` always, least privilege (Q3); never `md` (Q4). Each carries a stable reason id.

### 7.3 Scoped warnings (A5c-e, A6, A17-A19)

| Warning | Disclosed only when |
|---|---|
| `existing_user` | actor and target user tenants are **explicitly equal** AND (actor shares the user's company OR actor is a firm overseer in that tenant) |
| `existing_member` | `userCanAccessDeal(actor, dealId)` |
| `pending_invite` | `userCanManageInvite(actor, { companyId, dealId })` of the **existing invite's** scope, exactly as the duplicate-409 already does |

A17 no longer uses `userCanViewCompany`: that helper returns `true` for any cco/admin **without loading the target's tenant at all** (`access.ts:154-169`), so it cannot scope a cross-tenant fact.

**A19 by response shape.** Canonical fixed field order; `warnings` is a fixed-order array; an undisclosed condition contributes **no element**. No per-check status map, no count, no suppression-varying order. A field such as `checks: { existingUser: 'not_permitted' }` is a regression a reviewer should reject on sight. Warnings carry no name, identifier, company, role, phase, tenant, or invitation metadata.

```jsonc
{ "normalizedEmail": "…", "domain": "…",
  "companyMatch": null,
  "proposedCompany": { "label": "Vista Equity", "unverified": true },
  "warnings": [ { "id": "domain_mismatch" } ],
  "recommendation": { "dealRole": "seller", "companyRole": "member", "phase": 0,
                      "reasons": { "dealRole": "party_role_target", "phase": "least_privilege" } } }
```

`reasons` are stable ids resolved to copy in the component, so no prose ships from the API and no free text can leak a fact (A8, A11: no writes, no secret selected or returned; lookup creates **no** `invite_domain_confirmations` row, and the existing preflight gate still runs at send, A9).

## 8. Fail-closed reads (3.1)

Every policy or scoping read distinguishes **error**, **absent**, **present**.

- Error → the whole response is an opaque unavailable result (`503`). Never a partial warning set, never a company match, never a recommendation, and specifically **never `total: 0` from a failed document query**: a failed read must not be indistinguishable from an empty data room.
- Absent → `404` only for a resource proven missing.
- Welcome brief (M10) → renders the unavailable state, never an empty brief.
- An unrecognized `room` (§2) takes the same unavailable path.

## 9. Bound inputs (3.2)

```ts
export type BoundInputs =
  | { kind: 'lookup'; surface: 'gate0' | 'team'; email: string; companyId: string | null; dealId: string | null }
  | { kind: 'proposal'; surface: 'gate0' | 'team'; email: string; companyId: string | null; dealId: string | null;
      dealRole: string | null; companyRole: string; phase: number }
  | { kind: 'member'; surface: 'memberDrawer'; dealId: string; userId: string; phase: number };
export function boundInputKey(inputs: BoundInputs): string;
```

The `member` variant carries `dealId`, target `userId`, proposed phase, and its own surface, so a late response for member A can never share a key with member B. `kind` is part of the key, so a lookup response can never satisfy a preview request.

One client pattern on all three surfaces: `currentKeyRef` holds the key on screen; a response whose key differs is **discarded** regardless of arrival order (A14, B8). `AbortController` is an optimization; correctness rests on the key comparison. Status is `idle | loading | ready | stale | unavailable`. `stale` is entered synchronously with the input change that clears any derived pre-fill (A14), so a control never retains a value recommended for a different address, company, or member. `loading` is announced via `aria-live="polite"` + `aria-busy` (A15, D5). `unavailable` (A16, B10) holds no recommendation, pre-fills nothing, leaves the confirmation gate untouched, and never blocks Cancel or the normal send path.

## 10. Components

**M8 `SmartLookupCard`** — company match with evidence line, unverified proposal, warning list, recommendation with reasons. Warning and reason ids map to copy here, so the API ships no prose. Presentational only: derives no rule, re-checks nothing (D2).

**M9 `PerimeterPreview`** — destinations, band table, capability rows, invariant lines. Zero state (B13) renders "No documents would be available at this phase." and still shows destinations, capabilities, and invariants. It cannot render a hidden count because the API cannot express one.

**M10 `WelcomeBrief`** — a **server component** (C1, C3). `externalDealHome()` already runs `force-dynamic` and validates the seat before rendering, and **that membership check remains the page's own wall** (C2); nav gating is presentation (ADR-0009). Structure is fixed across visits (C1); values come from `computePerimeter` for the real viewer on every render, so a phase raise or new release appears on the next load with no client action (C3, C4).

Content: codename + code, the viewer's company, deal role, current phase (C5); document count and permitted actions (C6). Next actions are derived from the same `capabilities` object, in fixed order: Data Room always; Upload only when `canUpload`; Team always; Invite a teammate only when `canInviteTeammate` (C7, C8). Every href is one of the three permitted external destinations (C9). Zero documents renders the honest empty state (C11).

**C10.** The brief reads the deal, the viewer's own seat, the viewer's own company, and document gate rows — **own-company data only**. It performs no roster query of any kind, so no other company's roster can reach it, without exception. The Team link is a link, never a channel for roster content.

## 11. Flag-off parity (D1)

Both new routes call `requireFlag('platform_onboarding')` as their first statement, before authentication-dependent disclosure. M11/M12/M13 mount their new UI behind the same flag signal those surfaces already receive, so Team invite, Gate 0, and Member Drawer render exactly as today with the flag off. M14's brief sits inside the existing `isEnabled('platform_onboarding', …)` branch that is already the only path reaching `externalDealHome()`; with the flag off the deal home renders `ProjectDashboard` unchanged.

## 12. Tests

### 12.1 D8's sixteen obligations

| File | D8 | Covers |
|---|---|---|
| `api-v1-invite-lookup.test.ts` | 1-4 | Every warning positive/negative. **Indistinguishability done correctly: the same normalized request against two states differing only in the hidden fact must return byte-identical responses** (plan-v1's cross-address deep-equality was impossible — `normalizedEmail` differs). Ordinary cross-company, cross-tenant, and cross-tenant cco/admin actors |
| `api-v1-lookup-candidates.test.ts` | 3, 4 | External director entering another deal party's verified domain gets no match; internal actor with no authority over an unrelated in-tenant company gets no match; no-company first keystroke authorized and rejected |
| `api-v1-proposal-feasibility.test.ts` | 3, 4 | Cross-tenant admin UUID probe rejected; external own-company constraint; impossible role/company-role pairs; changed party relationship; authority lost between compose and send |
| `api-v1-perimeter-preview.test.ts` | 7-11 | Parity; no inaccessible metadata or counts in the serialized body; role/phase deltas; member mode `403`/`409`; Gate 0 no-deal mode; zero state |
| `perimeter-policy.test.ts` | 7, 8, 10 | Pure: internal-room and MNPI invariants at every phase; bands omit unreachable rooms; unrecognized room never counted and forces unavailable |
| `onboarding-bound-inputs.test.ts` | 6 | Key stability and supersession across all three variants, unmounted |
| `invite-modal-lookup.test.tsx` | 5, 6, 11 | **Parent surface**: failure and supersession withdraw real form pre-fills; preflight confirmation gate cannot be bypassed |
| `gate0-lookup-preview.test.tsx` | 5, 6, 11 | **Parent surface**: queued-chip preview before send; queue and create-then-send ordering unchanged |
| `member-drawer-preview.test.tsx` | 11 | Target change and out-of-order response never render a stale perimeter |
| `onboarding-fail-closed.test.ts` | — | Injected read errors on lookup, both preview modes, welcome: opaque unavailable, no partial answer, no `total: 0` from a failed query, no write side effects |
| `onboarding-flag-off.test.ts` | 15 | **Every affected surface**: both routes (non-disclosure before auth), Gate 0, Team invite, Member Drawer, welcome |
| `welcome-brief.test.tsx` | 12-14 | Action selection per archetype (seller-with-upload, buyer, observer, director-with-invite, member-without); re-render after phase/permission change; cross-company roster negative |
| `onboarding-e2e-demo.test.ts` | 16 | D7 path against seeded state |

### 12.2 Phase carry and TOCTOU

| File | Covers |
|---|---|
| `invite-phase-carry.test.ts` | Override previewed → persisted → re-validated at write → granted exactly as confirmed; grant audit states the granted phase; Gate 0 internal coercion to 0 |
| `invite-authority-parity.test.ts` | **Mandatory TS/SQL parity.** For every tier — firm admin, internal staff with and without `canManageDealMembers`, internal via `can_invite`, external director, external member — `userCanInvite` and the `create_invite` transaction must agree. Guards the §5.3 divergence risk |
| `invite-write-toctou.test.ts` | Authority lost, party relationship changed, company type changed, role privilege revoked, and concurrent send: each fails **at the write**, with no invite row, credential nonce, delivery, or audit side effect |
| `invite-phase-migration.test.ts` | Forward compatibility (old caller omitting `p_phase`, existing phase-0 rows); nonzero-pending rollback containment (expired + audited, not silently zeroed); acceptance boundary before and after |

### 12.3 Cross-cutting obligations, now owned (4.1)

| Obligation | File | Assertion |
|---|---|---|
| A11 / D3 secret absence | `onboarding-no-secrets.test.ts` | Serialized lookup, preview, and brief payloads contain no `credential_nonce`, invite token, storage id, or session value; asserted against the response body, not the query |
| B9 / D4 audit neutrality | `onboarding-audit-neutral.test.ts` | Snapshot `audit_log` before/after lookup, both preview modes, and brief render: **zero new rows**. Separately assert send / accept / grant / view / download still write exactly their current rows |
| Box / storage fallback non-regression | `onboarding-storage-nonregression.test.ts` | Preview and brief compute from `documents` metadata only and never call the storage seam; Box and Supabase-bucket paths unchanged |
| D5 keyboard / AT / narrow width | `onboarding-a11y.test.tsx` | Card and preview reachable and operable by keyboard; `loading` announced via `aria-live`; `unavailable` announced; layout has no horizontal overflow at 360px |

### 12.4 Parity matrix

`computePerimeter(...).documents.total` must equal the count of rows for which `userCanSeeDocument` returns true, over a generated matrix of subjects × document rows. Any future divergence between preview and real access fails the build.

## 13. Criterion map

| Criteria | Delivered by | Verified by |
|---|---|---|
| A1-A4, A7, A10, A12 | §7.2, M4, M5, M8 | `api-v1-invite-lookup`, `invite-modal-lookup`, `gate0-lookup-preview` |
| A5-A6, A17-A19 | §7.3 | `api-v1-invite-lookup` (indistinguishability), `api-v1-lookup-candidates` |
| A2 (authority), A3 (scope) | §7.1, §5.1 | `api-v1-lookup-candidates`, `api-v1-proposal-feasibility` |
| A8, A11 | §7.3, §3 | `onboarding-audit-neutral`, `onboarding-no-secrets` |
| A9 | §4.2 carry path, §5.3 write validation, preflight retained | `invite-phase-carry`, `invite-modal-lookup` |
| A13-A16 | §9, M8/M9 | `onboarding-bound-inputs`, three parent-surface tests |
| B1-B6, B13 | §3 `computePerimeter`, §6 response | `perimeter-policy`, `api-v1-perimeter-preview`, §12.4 |
| B7-B8, B10 | §6, §9 | `api-v1-perimeter-preview`, `member-drawer-preview` |
| B9 | §3 purity, §6 read-only | `onboarding-audit-neutral` |
| B11-B12 | §6 member mode, `userIsDealMd` | `api-v1-perimeter-preview` |
| C1-C11 | §10 M10 | `welcome-brief` |
| D1 | §11 | `onboarding-flag-off` |
| D2 | §10 (components derive no rules) | `perimeter-policy` + component tests |
| D3 | §7.3 | `onboarding-no-secrets` |
| D4 | §3, §8 | `onboarding-audit-neutral` |
| D5 | §9 | `onboarding-a11y` |
| D6 | §6 Gate 0 boundary, no third flow | `gate0-lookup-preview` |
| D7 | §14 fixture + runbook | `onboarding-e2e-demo` |
| D8 | §12.1 | all sixteen mapped |
| D9 | §14 docs | reviewed artifacts |
| D10 | §15 gates | CI |

## 14. Demo fixture and documentation

**M18 fixture (D7).** Extend `seed:onboarding-demo` to a deterministic state: a seller-side company with a verified domain; one internal-room file; two deal-room files at phase 0; one deal-room file at phase 2; one classification-4 row so the MNPI invariant is demonstrably load-bearing rather than theoretical.

**M17 runbook (D7).** Add the smart-onboarding path with the expected observation at each step, including the exact perimeter numbers the seeded state produces, so an operator can tell correct from merely plausible.

**M15/M16 (D9).** Add both routes to `openapi/phase1.json` with full request/response schemas so `/dev-api` can exercise them, and document them in `api-v1.md` under "Onboarding & data room", including the §7.3 disclosure-scoping table — that table is the security contract and belongs with the endpoint. `invites.phase` is documented alongside the invite schema. No constants change: every enum already exists in `src/lib/constants/*`.

## 15. Surfaces and verification order

| # | Path | Kind |
|---|---|---|
| M1 | `src/lib/api/v1/documentAccess.ts` | edit |
| M2 | `src/lib/api/v1/perimeter.ts` | new |
| M3 | `src/lib/api/v1/access.ts` | edit (`externalSubjectCanInvite`) |
| M4 | `src/lib/api/v1/inviteLookup.ts` | new |
| M5 | `src/app/api/v1/invites/lookup/route.ts` | new |
| M6 | `src/app/api/v1/invites/perimeter-preview/route.ts` | new |
| M7 | `src/lib/onboarding/boundInputs.ts` | new |
| M8-M10 | `src/components/onboarding/{SmartLookupCard,PerimeterPreview,WelcomeBrief}.tsx` | new |
| M11 | `src/components/team/InviteModal.tsx` | edit |
| M11a | `src/app/api/v1/invites/route.ts` | edit (phase, feasibility, RPC arg) |
| M12 | `src/components/wizard/Gate0Wizard.tsx` | edit |
| M13 | `src/components/team/MemberDrawer.tsx` | edit |
| M14 | `src/app/(authed)/projects/[projectId]/page.tsx` | edit |
| M15-M18 | `openapi/phase1.json`, `api-v1.md`, runbook, seed | edit |
| M20 | `supabase/migrations/<ts>_invite_phase.sql` | new |
| M21 | `src/lib/api/v1/proposalFeasibility.ts` | new |

Order:

1. `npx tsc --noEmit` after M1-M4, M21 — the refactor, room narrowing, and brand are riskiest for call sites.
2. `npm run db:migrate` + `npm run check:db` for M20, then `invite-authority-parity` **before** anything else touches the send path: if TS and SQL disagree, stop and reconcile rather than building on it.
3. `invite-phase-carry`, `invite-write-toctou`, `invite-phase-migration`.
4. Targeted vitest per surface during development.
5. Mandatory gates before the PR: `npx eslint .`, `npx tsc --noEmit`, `npm test`, `npm run build` (D10).
