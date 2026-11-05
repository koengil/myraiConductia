# ADR-0010 — Gate 0 "New deal" wizard: fixture → real backend

- **Status:** Proposal
- **Date:** 2026-07-16
- **Source:** the Gate 0 epic (#66 decision issue; issues #67–#84 G1–G18, plus the
  post-review hardening #90/#100–#104). Extends D8 (the `ConductiaAPI` seam),
  ADR-0007 (feature flags / Supabase), ADR-0008 (the `/api/v1` platform spine),
  D33 (company membership), D36 (legal hold — audit-enum-widening template).
  Reverses none.

## Context

The Gate 0 "New deal" wizard (`Gate0Wizard`, 4 steps) created deals in
`localStorage` via `createDeal()`. It looked real but wrote nothing to the
platform: no deal row, no memberships, no compliance notification, no audit. The
step-2 team selection was discarded, step 3 showed fabricated `KYC ✓ FINRA ✓
MNPI ✓` checkmarks, and the deal list surfaces were hardcoded off the two seed
fixtures. This ADR records the decisions taken to move Gate 0 onto the real
`/api/v1` spine behind a feature flag, without breaking the fixture demo.

## Decisions

1. **Single transactional create.** The wizard makes ONE call — `POST
   /api/v1/deals` with the full Gate 0 payload — and all writes happen inside a
   Postgres function `create_deal_gate0` (RPC): target dedupe, deal insert (with
   code-collision retry), `deal_parties`, creator MD seat + member seats, CCO
   notification fan-out, and audit rows — all-or-nothing. No client-side
   orchestration loop; partial failure is impossible (a wall breach or invalid
   role rolls the whole create back). Rationale: on a compliance product,
   partial state is the failure mode we sell against.

2. **Notifications shipped in the schema phase, not last.** The `notifications`
   table (permissions_schema_v3 §6) landed in Phase A so the create fans out a
   real `deal_created` alert to every tenant CCO immediately. `screenMessage()`
   (the MNPI rule pack) runs server-side over the notice text; its verdict is
   stored in the payload and returned.

3. **URL segment = deal code** (e.g. `SUM-2026-014`), not the codename slug and
   not the UUID. Unique by construction, masked (the compliance invariant holds
   in every URL), human-readable. `GET /api/v1/deals/{idOrCode}` resolves a code
   OR a UUID; `resolveProjectId` keeps the sandbox fallback for fixture slugs.

4. **Role vs title split.** The 6 schema `deal_roles` are the permission surface;
   banking titles are display attributes. The wizard's step-2 role selector uses
   `DEAL_ROLE_LABELS`, default `deal_team`; the locked seat is the authenticated
   creator (MD), not a fixture persona.

5. **Feature-flagged cutover.** A single flag `gate0_api_create` (ADR-0007,
   fail-closed) gates the whole real path: on → the wizard POSTs, the read side
   (`useDeals`) fetches `GET /api/v1/deals`, and the rail hydrates/persists from
   the API; off → the unchanged localStorage fixture demo. `FlagsProvider` is
   mounted in the `(authed)` layout (server-resolved snapshot → `useFlag`).

6. **Honest receipts.** Step 3 is a preview (who WILL be notified) with no
   fabricated checkmarks; the real receipt (recipients + timestamps + the MNPI
   verdict) renders once on the rail landing (`?new=1`), and the shell compliance
   ribbon reflects the verdict the server actually returned. Only what ran is
   claimed — the MNPI screen and the notification log; no KYC/FINRA.

7. **Read side mirrors `useCurrentUser`.** `useDeals()` is a hook (API-first,
   fixture fallback, flagged); a created deal appears in the sidebar / Command
   Center without a reload (refetch on `DEALS_EVENT`). Flag-on never falls back
   to a seed deal for a real code — an unresolved real deal shows an honest
   pending placeholder (its code), never another deal's content.

8. **Rail position persists.** `current_step_seq` on `deals` is the cursor;
   `PATCH /api/v1/deals/{id}/progress` writes advances (forward = any member,
   regress = MD-gated), each audited as `advance`.

9. **Audit-enum growth.** `audit_log.action` was widened (drop-and-re-add CHECK,
   the legal-hold template): `create`, `notify` (Gate 0 create), `advance` (rail
   progress). Mirrored in `src/lib/constants/audit.ts` + the constants-sync test.

10. **Chinese wall is a DB invariant.** A trigger on `deal_memberships` rejects
    `research`/`trading` users on insert/update (v3 §5) — real now that the
    wizard grants seats. Shipped with the RPC.

### Post-review hardening (same epic)

- **Tenant-scope the target** (G19/#90): `POST /deals` and the RPC reject a
  `targetCompanyId` from another tenant (was a cross-tenant 201).
- **Honest rail fallback + no fixture flash** (G22/G24): real deals never render
  Summit; the list shows nothing (not the seeds) while flag-on loading.
- **Mnemonic deal codes** (G21): the prefix comes from the distinctive word
  ("Project Falcon" → `FALCO`), not always `PROJE`.
- **Companies name uniqueness** (G23): a `(tenant_id, lower(name))` unique index
  makes the target dedupe a DB invariant.
- **CCO notifications UI** (G17): a shell bell + list surfaces the fan-out.

## Consequences

- Gate 0 is real end-to-end behind the flag: create → sidebar/Command Center →
  code URL → rail hydrate/persist → honest receipt + CCO notification + audit.
- The fixture demo is untouched with the flag off; every PR kept it working.
- **Still mock-backed by design:** the `ConductiaAPI` M&A *content* (acquirers,
  valuation, team, scoring) stays fixtures (D8), so a created deal's rail body is
  an honest empty/pending surface, not real analysis.
- **Follow-ups:** deal-scoped RLS (the suspenders to the app-layer belt), the
  `deal_steps` step-state table (G16/#82, coordinated with schema-phase-2), and
  real KYC/FINRA integrations before those receipts may claim them.
