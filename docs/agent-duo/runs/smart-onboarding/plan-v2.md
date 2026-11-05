---
run_id: smart-onboarding
type: plan
round: 2
---

# Plan v2 — Smart onboarding demo experience

Supersedes `plan-v1.md`. Implements the frozen spec `spec-v2.md`. Criterion references are to `spec-v2.md` §6.

## 0. Resolution of `cr-plan-v1.md`

Every finding was verified against source before accepting it. All eight stand; three were security defects in v1 and one was a false guarantee I had written.

| Finding | Verified against | Resolution |
|---|---|---|
| 1.1 confirmed phase not persisted | `20260804160000…sql:707-711` inserts `phase, 0` literal; `invites` has no `phase` column; send route has no `phase` | §3 migration + phase carried end to end |
| 1.2 no Gate 0 pre-send preview | `brief.md:29` requires both existing flows; Gate 0 has no deal yet | §5 preview endpoint de-scoped from `/deals/{id}`, optional deal context |
| 3.1 reads not fail-closed | v1 did not separate query error from missing row | §7 explicit error/absent split on every policy read |
| 3.2 member preview race key | v1 `PreviewBoundInputs` had no `kind`/`userId` | §8 discriminated bound-input union |
| 4.1 D8 coverage misassigned | deep-equality across different addresses cannot hold: `normalizedEmail` differs | §10 same-input/alternate-state design + parent-surface tests |
| 5.1 `userCanInvite` ≠ feasible invitation | `access.ts:304` admin returns true before any tenant check; docblock: shape "enforced in the route" | §4 shared proposal-feasibility path |
| 5.2 company match / A17 scope | `userCanViewCompany` returns true for any cco/admin with no target-tenant load | §6 tenant-explicit scoping; one canonical schema |
| 5.3 unknown-room claim false | `documentAccess.ts:63` special-cases only `internal`; unknown room returns true | §2 narrow + validate `DocumentRoom` |

## 1. Governing idea (unchanged)

`getDocumentViewer()` does identity; `userCanSeeDocument()` / `userCanUploadDocument()` are pure predicates. The preview feeds them a *proposed* subject, the welcome brief the *real* viewer. One decision path, three uses, so preview and reality cannot drift.

What v1 got wrong was the boundary *around* that core: authorization, tenancy, read failure, and the fact that a confirmed phase had nowhere to live.

## 2. M1 — policy seam, with the room narrowed (5.3)

Split the type so a hypothetical subject can enter the predicates:

```ts
export type DocumentSubject = { isExternal: boolean; hasOversight: boolean; dealRole: string | null; phase: number };
export type DocumentViewer = DocumentSubject & { userId: string };
export type DocumentGate = { room: DocumentRoom; classification: number; min_phase: number };
```

`DocumentGate.room` becomes the `DocumentRoom` union, **not** `string`. Predicates take `DocumentSubject`; existing call sites pass a `DocumentViewer`, which structurally satisfies it, so no call site changes and Wall 1 / Wall 2 / Wall 3 ordering is untouched.

Decoding is where the guarantee is earned. `parseDocumentRoom(value): DocumentRoom | null` is applied to every decoded row. **A row whose room is unrecognized is not passed to the predicate and is not counted; it makes the whole response an opaque unavailable result** (§7). v1 claimed the predicate denied unknown rooms; it does not, and I am not changing the predicate's real-access semantics to make the claim true. The guarantee moves to the decode boundary, where it is honest, and §10 tests it directly.

## 3. M20 — migration: the confirmed phase must survive send (1.1)

**Why this is in scope.** Frozen **A9** requires the inviter to confirm company, role, *and phase* before sending. Today the accepted seat is granted `phase 0` unconditionally. Without persistence a confirmed phase 2 would preview phase-2 access and grant phase 0 — the preview becomes a lie, and B2 parity fails at the only moment that matters. Spec Q12 explicitly admits a migration when persistence proves necessary.

`supabase/migrations/<ts>_invite_phase.sql`:

```sql
alter table invites add column phase int not null default 0 check (phase >= 0);
```

`default 0` makes the backfill exact: every existing pending invite keeps today's behavior, so the migration is safe to apply ahead of the code.

**`create_invite`** gains `p_phase int default 0`, following this repo's own precedent — the safeguard migration already dropped and recreated this function with a changed signature (`20260804160000…sql:328-330`), so the plan drops the current 8-arg signature, creates the 9-arg version, and re-issues the identical `revoke`/`grant` pair. It validates `p_phase >= 0` and, for an internal (bank) invitee, coerces to `0`, inside the same transaction that already enforces tenant coherence.

**`accept_invite`** keeps its `(uuid, uuid)` signature; its body changes `phase, 0` → `phase, v_invite.phase` in the `deal_memberships` insert and `'phase', 0` → `'phase', v_invite.phase` in the grant audit detail, so the audit record states the phase actually granted.

**Carry path.** Form state → preflight snapshot (phase joins the snapshot so changing it invalidates a stale confirmation) → `POST /api/v1/invites` body → feasibility re-check at send (§4) → `invites.phase` → `accept_invite` → `deal_memberships.phase` → grant audit.

**Non-applicable boundary, stated rather than dropped.** Gate 0 invitations are internal (`deal_team`/`legal`/`read_only`) and phase gates external users only (`spec-v2.md:51`). Gate 0 therefore has no phase control; the server coerces phase to 0 for a bank-company invitee. §10 tests that boundary explicitly instead of leaving it implicit.

**Rollback.** Revert the RPC bodies and `drop column invites.phase`. No data loss: the column only ever holds a value the inviter confirmed, and dropping it returns the system to unconditional phase 0. Containment if applied without the app: the default keeps every path at today's behavior.

## 4. M21 — one proposal-feasibility path (5.1)

`src/lib/api/v1/proposalFeasibility.ts`. This is the security core of the round.

```ts
export type Proposal = { email: string; companyId: string; companyRole: string; dealId: string | null; dealRole: string | null; phase: number };
export type Feasibility =
  | { ok: true; subject: PerimeterSubject; isExternalCompany: boolean }
  | { ok: false; reason: 'forbidden' | 'invalid' | 'unavailable' };

export async function assessProposal(admin, actorId, proposal): Promise<Feasibility>;
```

It answers one question: **could this actor actually send this exact invitation right now?** Checks, all fail-closed:

1. **Tenant coherence, first and unconditionally.** Actor tenant, target company tenant, and deal tenant must match. This closes the hole v1 opened: `userCanInvite` returns `true` for a firm admin *before* any tenant check, so v1's preview would have disclosed cross-tenant document counts — regressing the invariant #116/#141/#144 hardened. Feasibility never inherits that short circuit.
2. `userCanInvite(admin, actorId, { companyId, dealId })` — necessary, not sufficient.
3. **Shape**, which `userCanInvite` documents as the route's job: company type → internal/external; `INTERNAL_INVITE_DEAL_ROLES` / `EXTERNAL_INVITE_DEAL_ROLES` allowlist; `md` never invitable; external invitee coerced to `company_role: member`; deal role must match the company's `deal_parties.party_role` (target/co_seller → seller, acquirer_shortlist/counterparty → buyer).
4. **Phase bounds**: non-negative; coerced to 0 for a bank-company invitee.

`ok: true` returns the assembled `PerimeterSubject`, so a caller cannot compute a perimeter for a proposal it did not first prove feasible — the type makes the ordering unskippable.

Callers: lookup (M5), preview (M6), and the send route (M11a), which re-runs it so authority lost between compose and send is caught at the write. `POST /api/v1/invites` keeps every check it has today; feasibility is layered in front, never a replacement.

## 5. M6 — `POST /api/v1/invites/perimeter-preview` (1.2)

**Moved off `/deals/{dealId}/`.** Gate 0 has no deal yet, so a deal-scoped route could not serve it and would have forced the third invitation flow `brief.md:29` prohibits. One endpoint, an optional deal context, both surfaces.

```jsonc
{ "proposal": { "email": "…", "companyId": "…", "companyRole": "member",
                "dealId": "…|null", "dealRole": "seller|null", "phase": 0 } }
{ "member": { "dealId": "…", "userId": "…", "phase": 2 } }
```

- `proposal` → `assessProposal` (§4). `403` on `forbidden`.
- `member` → `userIsDealMd`, the same predicate the phase-raise PATCH requires, and the same `409` on a downgrade, so the preview can never depict a consequence the actor could not bring about.
- **No `dealId` (Gate 0)**: feasibility runs without a deal; the document set is empty by construction because the deal does not exist. The response carries `dealContext: "proposed"` and the UI states plainly that the new deal has no documents yet. This is honest rather than hypothetical: it shows destinations, capabilities, and invariants, which is exactly what a Gate 0 inviter can act on.

**Gate 0 confirmation boundary.** The wizard keeps queueing chips locally and keeps its existing create-then-send ordering; nothing about the flow changes. The preview attaches to the queued chip *before* create, and the wizard's existing final confirm is the explicit human confirmation A9 requires. No new invitation path.

Document query projects `room, classification, min_phase` only — titles and storage ids never enter the computation.

## 6. M5 — lookup, with scoping fixed (5.2)

**Candidate companies are actor-scoped before matching, not filtered after.** v1 searched `company_verified_domains` across the whole tenant, which could name an unrelated company to an external inviter. v2 builds the candidate set first: the actor's own company, plus the parties to the deal in context, plus (for internal staff only) companies in the actor's tenant. The domain match runs only within that set.

**A17 no longer uses `userCanViewCompany`.** That helper returns `true` for any cco/admin *without loading the target's tenant at all*, so it cannot scope a cross-tenant fact. The A17 branch requires explicit actor/target tenant equality, then company membership or in-tenant oversight.

**One canonical response schema.** v1 contradicted itself (prose said a flat array of ids, the example showed objects). Canonical, fixed field order, static reason copy keyed by id, no metadata:

```jsonc
{ "normalizedEmail": "…", "domain": "…",
  "companyMatch": null,
  "proposedCompany": { "label": "Vista Equity", "unverified": true },
  "warnings": [ { "id": "domain_mismatch" } ],
  "recommendation": { "dealRole": "seller", "companyRole": "member", "phase": 0,
                      "reasons": { "dealRole": "party_role_target", "phase": "least_privilege" } } }
```

`reasons` are **stable ids**, resolved to copy in the component, so prose never ships from the API and no free text can leak a fact.

**A19 by shape.** `warnings` is a fixed-order array; an undisclosed condition contributes no element. There is no per-check status map, no count, no suppression-varying order. A field such as `checks: { existingUser: 'not_permitted' }` is a regression a reviewer should reject on sight.

## 7. Fail-closed reads (3.1)

Every policy or scoping read distinguishes three outcomes: **error**, **absent**, **present**. v1 collapsed the first two.

- Error on any read → the whole response is an opaque unavailable result (`503`). Never a partial warning set, never a company match, never a recommendation, and specifically **never `total: 0` from a failed document query** — a failed read must not be indistinguishable from an empty data room.
- Absent → `404` only for a genuinely missing resource proven absent.
- Welcome brief (M10): a failed read renders the unavailable state, not an empty brief.

An unrecognized `room` value (§2) takes the same unavailable path.

## 8. Bound inputs, discriminated (3.2)

```ts
export type BoundInputs =
  | { kind: 'lookup'; surface: 'gate0' | 'team'; email: string; companyId: string | null; dealId: string | null }
  | { kind: 'proposal'; surface: 'gate0' | 'team'; email: string; companyId: string | null; dealId: string | null;
      dealRole: string | null; companyRole: string; phase: number }
  | { kind: 'member'; surface: 'memberDrawer'; dealId: string; userId: string; phase: number };
export function boundInputKey(inputs: BoundInputs): string;
```

The `member` variant carries `dealId`, target `userId`, proposed phase, and its own surface, so a late response for member A can never share a key with member B. `kind` is part of the key, so a lookup response can never satisfy a preview request.

Client rule, one pattern on all three surfaces: `currentKeyRef` holds the key on screen; a response whose key differs is **discarded** regardless of arrival order. `AbortController` is an optimization; correctness rests on the key comparison. Status is `idle | loading | ready | stale | unavailable`; `stale` is entered synchronously with the input change that clears any derived pre-fill, so a control never retains a value recommended for a different address, company, or member.

## 9. Surfaces

| # | Path | Kind |
|---|---|---|
| M1 | `src/lib/api/v1/documentAccess.ts` | edit — `DocumentSubject`, `DocumentRoom` narrowing, `parseDocumentRoom` |
| M2 | `src/lib/api/v1/perimeter.ts` | new — pure `computePerimeter` |
| M3 | `src/lib/api/v1/access.ts` | edit — extract `externalSubjectCanInvite` pure core |
| M4 | `src/lib/api/v1/inviteLookup.ts` | new — pure label proposal, recommendation, warning assembly |
| M5 | `src/app/api/v1/invites/lookup/route.ts` | new |
| M6 | `src/app/api/v1/invites/perimeter-preview/route.ts` | new |
| M7 | `src/lib/onboarding/boundInputs.ts` | new |
| M8-M10 | `src/components/onboarding/{SmartLookupCard,PerimeterPreview,WelcomeBrief}.tsx` | new |
| M11 | `src/components/team/InviteModal.tsx` | edit — card + preview + phase control |
| M11a | `src/app/api/v1/invites/route.ts` | edit — accept `phase`, re-run feasibility, pass to RPC |
| M12 | `src/components/wizard/Gate0Wizard.tsx` | edit — card + preview on queued chips |
| M13 | `src/components/team/MemberDrawer.tsx` | edit — preview for proposed phase |
| M14 | `src/app/(authed)/projects/[projectId]/page.tsx` | edit — welcome brief |
| M15-M17 | `openapi/phase1.json`, `docs/03-engineering/api-v1.md`, `…/onboarding-demo-runbook.md` | edit |
| M18 | seed script | edit — demo fixture |
| M20 | `supabase/migrations/<ts>_invite_phase.sql` | new |
| M21 | `src/lib/api/v1/proposalFeasibility.ts` | new |

`computePerimeter` stays pure and synchronous, so it performs no IO and **cannot** write an audit row — B9 holds structurally, not by discipline.

## 10. Tests (D8, all sixteen) — 4.1

| File | D8 | Covers |
|---|---|---|
| `api-v1-invite-lookup.test.ts` | 1-4 | Warnings positive/negative. **Indistinguishability done correctly: the same normalized request against two states differing only in the hidden fact must return byte-identical responses** (v1's cross-address deep-equality was impossible, `normalizedEmail` differs). Ordinary cross-company, cross-tenant, and cross-tenant cco/admin actors |
| `api-v1-proposal-feasibility.test.ts` | 3, 4 | Cross-tenant admin UUID probe rejected; external own-company constraint; impossible role/company-role pairs; party relationship changed; authority lost between compose and send |
| `api-v1-perimeter-preview.test.ts` | 7-11 | Parity; no inaccessible metadata or counts; role/phase deltas; member mode `403`/`409`; Gate 0 no-deal mode; zero state |
| `perimeter-policy.test.ts` | 7, 8, 10 | Pure: internal-room and MNPI invariants at every phase; bands omit unreachable rooms; **unrecognized room never counted and forces unavailable** |
| `onboarding-bound-inputs.test.ts` | 6 | Key stability/supersession across all three variants, unmounted |
| `invite-phase-carry.test.ts` | — (1.1) | Override previewed → persisted → re-authorized at send → granted exactly as confirmed; audit detail states the granted phase; Gate 0 internal coercion to 0 |
| `invite-modal-lookup.test.tsx` | 5, 6, 11 | **Parent-surface**: failure and supersession withdraw real form pre-fills; preflight confirmation gate cannot be bypassed |
| `gate0-lookup-preview.test.tsx` | 5, 6, 11 | **Parent-surface**: queued-chip preview before send; queue and create-then-send ordering unchanged |
| `member-drawer-preview.test.tsx` | 11 | Target change and out-of-order response never render a stale perimeter |
| `onboarding-fail-closed.test.ts` | — (3.1) | Injected read errors on lookup, both preview modes, welcome: opaque unavailable, no partial answer, no `total: 0` from a failed query, no write side effects |
| `onboarding-flag-off.test.ts` | 15 | **Every affected surface**: both routes (non-disclosure before auth), Gate 0, Team invite, Member Drawer, welcome |
| `welcome-brief.test.tsx` | 12-14 | Action selection per archetype; re-render after phase/permission change; cross-company roster negative |
| `onboarding-e2e-demo.test.ts` | 16 | D7 path against seeded state |

Additional obligations named by 4.1(5): A11/D3 secret absence; B9/D4 audit neutrality with send/accept/grant/view/download unchanged; Box/fallback non-regression; D5 keyboard/AT/narrow-width.

Parity is a generated matrix: `computePerimeter(...).documents.total` must equal the count of rows for which `userCanSeeDocument` returns true, so any future divergence fails the build.

## 11. Verification order

1. `npx tsc --noEmit` after M1-M4, M21 (the refactor and the room narrowing are the riskiest for call sites).
2. `npm run db:migrate` + `npm run check:db` for M20, then the phase-carry test.
3. Targeted vitest during development.
4. Mandatory gates before the PR: `npx eslint .`, `npx tsc --noEmit`, `npm test`, `npm run build` (D10).
