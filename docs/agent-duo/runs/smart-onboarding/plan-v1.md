---
run_id: smart-onboarding
type: plan
round: 1
---

# Plan v1 — Smart onboarding demo experience

Implements the frozen spec `spec-v2.md`. Criterion references (A1-A19, B1-B13, C1-C11, D1-D10) are to `spec-v2.md` §6.

## 0. Governing idea

The repository already splits *who a viewer is* from *what that viewer may see*. `getDocumentViewer()` does the identity lookup; `userCanSeeDocument()` and `userCanUploadDocument()` are pure predicates over the resulting value. **B2 is therefore satisfied by construction, not by a parallel implementation:** the preview feeds those same pure predicates a *proposed* subject instead of a real one. There is one decision path, exercised twice.

The welcome brief uses the same module against the *real* viewer. So "what they'll see" and what they actually see are the same computation, which is the product claim and also the cheapest way to keep them true.

No new persistence. Every part reads state the platform already holds, so **no migration** (spec Q12). No new external dependency (A10).

## 1. New and changed surfaces

| # | Path | Kind | Purpose |
|---|---|---|---|
| M1 | `src/lib/api/v1/documentAccess.ts` | edit | Split `DocumentViewer` into a policy-relevant `DocumentSubject` + identity. Pure predicates take `DocumentSubject`. |
| M2 | `src/lib/api/v1/perimeter.ts` | new | The single perimeter policy module. Pure. |
| M3 | `src/lib/api/v1/access.ts` | edit | Extract the pure core of `userCanInvite`'s external branch so a prospective subject can be evaluated. |
| M4 | `src/lib/api/v1/inviteLookup.ts` | new | Pure lookup reasoning: company-label proposal, recommendation, warning assembly. |
| M5 | `src/app/api/v1/invites/lookup/route.ts` | new | `POST /api/v1/invites/lookup`. |
| M6 | `src/app/api/v1/deals/[dealId]/perimeter-preview/route.ts` | new | `POST` perimeter preview (prospective invitee or existing member). |
| M7 | `src/lib/onboarding/boundInputs.ts` | new | Pure bound-input key + supersession helper (A13/A14/B8). |
| M8 | `src/components/onboarding/SmartLookupCard.tsx` | new | The intelligence card. |
| M9 | `src/components/onboarding/PerimeterPreview.tsx` | new | "What they'll see" panel. |
| M10 | `src/components/onboarding/WelcomeBrief.tsx` | new | Server component for the external deal home. |
| M11 | `src/components/team/InviteModal.tsx` | edit | Mount M8 + M9. |
| M12 | `src/components/wizard/Gate0Wizard.tsx` | edit | Mount M8 on the Team step. |
| M13 | `src/components/team/MemberDrawer.tsx` | edit | Mount M9 for a proposed phase raise. |
| M14 | `src/app/(authed)/projects/[projectId]/page.tsx` | edit | Render M10 in `externalDealHome()`. |
| M15 | `openapi/phase1.json` | edit | Document M5 + M6. |
| M16 | `docs/03-engineering/api-v1.md` | edit | Document M5 + M6 under "Onboarding & data room". |
| M17 | `docs/03-engineering/onboarding-demo-runbook.md` | edit | The D7 demo path. |
| M18 | `scripts/` seed | edit | Deterministic demo fixture (D7). |
| M19 | `tests/*.test.ts(x)` | new | The D8 matrix. |

## 2. M1 — the policy seam (enables B2)

`DocumentViewer` currently carries `userId` alongside the four policy-relevant fields. `userCanSeeDocument` and `userCanUploadDocument` read only the latter four. Split the type:

```ts
export type DocumentSubject = {
  isExternal: boolean;
  hasOversight: boolean;
  dealRole: string | null;
  phase: number;
};
export type DocumentViewer = DocumentSubject & { userId: string };
```

Change the two predicates to accept `DocumentSubject`. Every existing call site passes a `DocumentViewer`, which structurally satisfies `DocumentSubject`, so **no call site changes**. This is the whole refactor: it makes the existing seam nameable so a *hypothetical* subject can enter the same predicates without inventing a fake user id.

Order of checks inside the predicates is untouched. The internal-room exclusion stays first.

## 3. M2 — `perimeter.ts`, the one policy module

```ts
export type PerimeterSubject = DocumentSubject & {
  companyId: string;
  companyRole: string;      // COMPANY_ROLE
  companyIsPartyToDeal: boolean;
};

export type DocumentGateRow = { room: string; classification: number; min_phase: number };

export type PerimeterBand = { room: DocumentRoom; minPhase: number; count: number };

export type Perimeter = {
  destinations: DestinationId[];
  documents: { total: number; bands: PerimeterBand[] };
  capabilities: { canUpload: boolean; canSeeTeam: boolean; canInviteTeammate: boolean };
  invariants: PerimeterInvariantId[];
};

export function computePerimeter(subject: PerimeterSubject, docs: DocumentGateRow[]): Perimeter;
```

Behavior:

- **Documents (B3, B4, B6, B13).** Filter `docs` with `userCanSeeDocument(subject, doc)`. `total` is the length of the survivors. `bands` groups **only the survivors** by `(room, min_phase)`. A room or band with no survivor produces **no band entry at all**, so no count is ever emitted for an unreachable room or band (B4), and no count of inaccessible documents can exist (B6). `total: 0` with `bands: []` is the honest zero state (B13).
- **Leakage (B6).** The function's input is already reduced to `{room, classification, min_phase}` at the query layer (§5), so titles, filenames, storage ids, uploader, and timestamps are not merely omitted from the response, they never enter the computation.
- **Destinations (B3).** `canAccessDestination(subject.isExternal ? 'external' : 'storm', d)` over the destination set. For an external subject this yields exactly `mandate`, `dataRoom`, `team`.
- **Upload (B3).** `userCanUploadDocument(subject, DOCUMENT_ROOM.DEAL, SELLER_MAX_CLASSIFICATION)` — "could this subject upload anything at all".
- **Teammate invite (B3).** `externalSubjectCanInvite(subject)` from M3.
- **Invariants (B5).** A constant list of stable ids, always present for an external subject: `external_never_internal_room`, `external_never_mnpi`. Ids, not prose, so copy lives in the component and the API stays a contract. They are unconditional and independent of phase.

`computePerimeter` is pure and synchronous. It performs no IO, so it can never write an audit row (B9) — the absence of grant/view side effects is structural, not a discipline.

## 4. M3 — prospective invite authority

`userCanInvite`'s external branch is: company director, of their own company, on a deal their company is a party to. Extract that shape decision:

```ts
export function externalSubjectCanInvite(subject: {
  isExternal: boolean; companyRole: string; companyIsPartyToDeal: boolean;
}): boolean;
```

`userCanInvite` calls it after its DB reads (actor profile + `deal_parties` probe), so the rule has one definition and the existing predicate keeps its exact current behavior, including the firm-admin short circuit and the internal-staff branch, which are identity-dependent and stay in the async function.

## 5. M6 — `POST /api/v1/deals/{dealId}/perimeter-preview`

Deal-scoped, matching the rest of the deal API. One endpoint serves both preview modes (B11).

Handler order, following the established pattern: `requireFlag('platform_onboarding')` → `requireApiUser()` → `resolveDealRef()` → authorize → compute.

**Request**

```jsonc
// prospective invitee
{ "subject": { "kind": "prospective", "companyId": "…", "dealRole": "seller",
               "companyRole": "member", "phase": 0 } }
// existing member at a proposed phase
{ "subject": { "kind": "member", "userId": "…", "phase": 2 } }
```

**Authorization (B12)**

- `kind: "prospective"` → `userCanInvite(admin, actor, { companyId, dealId })`. Exactly the authority to create the invitation being previewed.
- `kind: "member"` → `userIsDealMd(admin, actor, dealId)`. Deliberately the *same* predicate the phase-raise `PATCH` already requires, so the preview never shows a consequence the actor could not bring about.

Failure is `403` with the standard opaque body.

**Subject assembly**

- Prospective: `isExternal` from the target company's `type !== COMPANY_TYPE.BANK`; `hasOversight: false` (a prospective invitee never carries firm oversight); `dealRole`, `phase` from the request after validation; `companyIsPartyToDeal` from a `deal_parties` existence probe.
- Member: read the existing seat (`deal_role`, `phase`) and the user's `is_external`/`firm_role`/`company_id`/`company_role`, then override `phase` with the proposed value. Reject a proposed phase below the current one with `409`, mirroring the PATCH's monotonic rule, so the preview cannot depict an impossible downgrade.

**Document query (B6)**

```ts
admin.from('documents').select('room, classification, min_phase').eq('deal_id', dealId)
```

The projection is the leak boundary. Titles and storage ids are never selected, so they cannot be returned by accident.

**Response**

```jsonc
{ "subject": { "kind": "prospective", "dealRole": "seller", "companyRole": "member", "phase": 0 },
  "destinations": ["mandate", "dataRoom", "team"],
  "documents": { "total": 3, "bands": [ { "room": "deal", "minPhase": 0, "count": 3 } ] },
  "capabilities": { "canUpload": true, "canSeeTeam": true, "canInviteTeammate": false },
  "invariants": ["external_never_internal_room", "external_never_mnpi"] }
```

The echoed `subject` is what lets the client prove the response matches the inputs on screen (B8).

**Read-only (B9).** No insert, no update, no `audit_log` write on any path.

## 6. M5 — `POST /api/v1/invites/lookup`

**Request:** `{ email, companyId?, dealId? }`.

**Authorization (A2):** `userCanInvite(admin, actor, { companyId, dealId })` when a company is selected. With no company yet selected the actor must still be able to invite somewhere in the deal's scope; absent that, `403`.

**Computation**

1. `normalizeInviteEmail` → `400` on malformed (A12; the client also suppresses the request, so this is the server's own wall).
2. `inviteEmailDomain` + `isPersonalInviteDomain` → warning `personal_domain` (A5a).
3. Company match (A3): query `company_verified_domains` for a domain matching the address via `domainMatchesVerifiedDomain`, scoped to the actor's tenant. A hit yields `companyMatch: { companyId, name, evidence: { verifiedDomain } }`.
4. Domain contradiction (A5b): when a company is selected, `classifyInviteDomain(email, selectedCompanyDomains)` → `mismatch` yields `domain_mismatch`, `unverified` yields `company_domain_unverified`.
5. Company-label proposal (A4): only when there is no match and the domain is not personal. `proposeCompanyLabel(domain)` in M4 takes the registrable label, splits on `-`, title-cases, and returns `{ label, unverified: true }`. Pure and deterministic (A10).
6. Recommendation (A7): `dealRole` from the selected company's `deal_parties.party_role` — `target`/`co_seller` → `seller`, `acquirer_shortlist`/`counterparty` → `buyer`, bank company → `deal_team`; `companyRole: member` always (Q5); `phase: 0` always (Q3). Each with a short `reason` string id. Never `md` (Q4).

**Scoped warnings (A6, A17, A18, A19)**

| Warning | Condition | Disclosed only when |
|---|---|---|
| `existing_user` | an active `users` row has this email | actor may view a company the user belongs to (`userCanViewCompany`), **or** the user holds a seat on a deal the actor can manage members of (`canManageDealMembers`), **or** actor is a firm overseer in the user's tenant |
| `existing_member` | that user holds a seat on **this** deal | `userCanAccessDeal(actor, dealId)` |
| `pending_invite` | a pending invite exists for this email | `userCanManageInvite(actor, { companyId, dealId })` of the **existing invite's** scope, exactly as the duplicate-409 already does |

**A19 is enforced by response shape, not by a filter applied late.** `warnings` is a flat array of ids. An undisclosed condition contributes no element, and there is no per-check status map, no `checked` list, no count, and no ordering that varies with suppression. The array for an existing-but-invisible user is therefore identical to the array for an unknown address. The plan explicitly forbids adding any field such as `checks: { existingUser: 'not_permitted' }`; a reviewer should treat such a field as a regression. Warnings carry **no** name, id, company, role, phase, tenant, or invite metadata — the id and its one-line reason only.

**Response**

```jsonc
{ "normalizedEmail": "…", "domain": "…",
  "companyMatch": { "companyId": "…", "name": "…", "evidence": { "verifiedDomain": "…" } },
  "proposedCompany": null,
  "warnings": [ { "id": "domain_mismatch", "reason": "…" } ],
  "recommendation": { "dealRole": "seller", "companyRole": "member", "phase": 0,
                      "reasons": { "dealRole": "…", "phase": "…" } } }
```

**A8/A11.** No writes on any path. Unlike `preflight`, lookup does **not** create an `invite_domain_confirmations` row; it is purely advisory and the existing preflight gate still runs at send time (A9). No secret is selected or returned (A11).

## 7. M7 + client race handling (A13-A16, B8)

`boundInputs.ts` is pure and unit-testable without mounting:

```ts
export type LookupBoundInputs = { email: string; companyId: string | null; dealId: string | null; surface: 'gate0' | 'team' };
export type PreviewBoundInputs = LookupBoundInputs & { dealRole: string; companyRole: string; phase: number };
export function boundInputKey(inputs: LookupBoundInputs | PreviewBoundInputs): string;
```

Both M8 and M9 use one pattern:

- A `currentKeyRef` holds the key of the inputs on screen. Every response carries the key it was issued for; on arrival, a response whose key differs from `currentKeyRef.current` is **discarded** — never rendered, never pre-filled, never allowed to overwrite a newer result, whatever the arrival order (A14, B8). An `AbortController` cancels the in-flight request as well, but correctness rests on the key comparison, not on the abort landing.
- Status is a discriminated union: `idle | loading | ready | stale | unavailable`. `stale` is entered synchronously when a bound input changes, in the same update that clears any pre-fill derived from the old result (A14). `loading` renders a busy state announced via `aria-live="polite"` and `aria-busy` (A15, D5).
- `unavailable` (A16, B10) renders the neutral copy, holds no recommendation, pre-fills nothing, and leaves the existing confirmation gate untouched. It never blocks Cancel or the normal send path.

**Pre-fill discipline (A13/A14).** The card writes a recommended value into a form control only on a `ready` result whose key matches. Leaving `ready` withdraws the pre-fill, so a control can never retain a value recommended for a different address or company.

## 8. M8/M9/M10 — the three components

**M8 `SmartLookupCard`** renders the company match with its evidence line, the unverified proposal, the warning list, and the recommendation with reasons. Warning ids map to copy in the component, so the API never ships prose. Presentational only: it derives no rule and re-checks nothing (D2).

**M9 `PerimeterPreview`** renders destinations, the band table, capability rows, and the invariant lines. Zero state (B13) renders "No documents would be available at this phase." and still shows destinations, capabilities, and invariants. It never renders a hidden count because the API cannot express one.

**M10 `WelcomeBrief`** is a **server component** (C1, C3). `externalDealHome()` already runs `force-dynamic` and validates the seat before rendering (C2), so the brief is recomputed from current data on every render with no client fetch and no one-time state. Structure is fixed across visits; values come from `computePerimeter` for the **real** viewer. Next actions (C6-C8) are derived from that same `capabilities` object: Data Room always; Upload only when `canUpload`; Team always (it is in the external destination set); Invite a teammate only when `canInviteTeammate`. Every href is built from the three permitted destinations (C9). Zero documents renders the honest empty state (C11).

**C10.** The brief reads the deal, the viewer's own seat, the viewer's own company, and document gate rows. It performs **no** roster query of any kind, so no other company's roster can reach it. The Team link is a link only.

## 9. Flag-off parity (D1)

Both new routes begin with `requireFlag('platform_onboarding')`, so with the flag off they return the standard flag error and nothing else changes. M11/M12/M13 mount their new UI behind the same flag signal those surfaces already receive. M14's welcome brief sits inside the existing `if (await isEnabled('platform_onboarding', …))` branch, which is already the only path that reaches `externalDealHome()`. With the flag off the deal home renders `ProjectDashboard` exactly as today.

## 10. Edge cases and races

| Case | Handling |
|---|---|
| Email edited while lookup in flight | Key mismatch → discard; status `stale`; pre-fill withdrawn (A14) |
| Two responses arrive out of order | Only the one matching `currentKeyRef` renders (A14) |
| Company changed after a match was shown | Bound input change → `stale`; match no longer presented as current (A13) |
| Proposed phase below current member phase | `409`, mirroring the PATCH monotonic rule |
| Deal has zero documents | `total: 0`, `bands: []`, zero state (B13) |
| Subject reaches no room | `bands: []`; no band for an unreachable room (B4) |
| Document row with an unknown room value | `userCanSeeDocument` denies unless it matches a known reachable room; unknown rooms fail closed |
| Actor loses invite authority between compose and send | Send still re-authorizes; preview grants nothing (B9) |
| Lookup 5xx | `unavailable`; confirmation gate intact (A16) |
| Preview 5xx | `unavailable`, fail closed, explicit "no access has been granted" (B10) |
| Personal-domain address | `personal_domain` warning; no company proposal (A4 guard) |

## 11. Tests (D8)

New files, following the flat `tests/` convention.

| File | D8 items | Covers |
|---|---|---|
| `tests/api-v1-invite-lookup.test.ts` | 1, 2, 3, 4, 5 | Every warning positive/negative; `existing_user`/`existing_member`/`pending_invite` scoping for authorized and unauthorized actors including another company and another tenant; **indistinguishability**: assert the unauthorized response deep-equals the unknown-address response |
| `tests/api-v1-perimeter-preview.test.ts` | 7, 8, 9, 10, 11 | Parity against `userCanSeeDocument`; no inaccessible metadata or counts in the serialized body; role/phase deltas; member phase-raise mode; zero state; `403`/`409` paths |
| `tests/perimeter-policy.test.ts` | 7, 8, 10 | Pure `computePerimeter`: internal-room and MNPI invariants at every phase; band grouping omits unreachable rooms |
| `tests/onboarding-bound-inputs.test.ts` | 6 | Key stability and supersession, without mounting |
| `tests/smart-lookup-card.test.tsx` | 5, 6 | Failure state offers no recommendation and no pre-fill; superseded response never renders; pre-fill withdrawn on input change. Rendered for both surfaces |
| `tests/welcome-brief.test.tsx` | 12, 13, 14 | Action selection per archetype (seller-with-upload, buyer, observer, director-with-invite, member-without); re-render after phase/permission change; cross-company roster negative |
| `tests/onboarding-flag-off.test.ts` | 15 | Both routes gated; deal home unchanged |
| `tests/onboarding-e2e-demo.test.ts` | 16 | The D7 path end to end against seeded state |

Parity (D8.7) is asserted structurally: for a generated matrix of subjects and document rows, `computePerimeter(...).documents.total` must equal the count of rows for which `userCanSeeDocument` returns true. A future divergence between preview and real access fails this test.

## 12. Demo fixture and runbook (D7)

Extend the existing `seed:onboarding-demo` script (M18) to produce a deterministic state: a seller-side company with a verified domain, a data room holding one internal-room file, two deal-room files at phase 0, and one deal-room file at phase 2, plus one classification-4 row so the MNPI invariant is demonstrably load-bearing rather than theoretical.

M17 adds a section to the runbook covering the D7 path with the expected observation at each step, including the exact perimeter numbers the seeded state produces so a demo operator can tell correct from plausible.

## 13. Documentation (D9)

M15 adds both routes to `openapi/phase1.json` with full request/response schemas, so `/dev-api` can exercise them. M16 documents them in `api-v1.md` under "Onboarding & data room", including the disclosure-scoping table from §6, because that table is the security contract and belongs where the endpoint is described.

No constants change: every enum used already exists in `src/lib/constants/*`.

## 14. Migration and rollback

**No migration.** No new table, column, index, or enum value. Rollback is reverting the branch; there is no durable state to unwind and no data written by any new path.

## 15. Verification order

1. `npx tsc --noEmit` after M1-M4 (the refactor is the riskiest step for call sites).
2. Targeted `npx vitest run tests/perimeter-policy.test.ts` etc. during development.
3. Full mandatory gates before the PR: `npx eslint .`, `npx tsc --noEmit`, `npm test`, `npm run build` (D10).
