# ADR-0009 — Box-backed datarooms (one folder per deal step)

- **Status:** Proposed
- **Date:** 2026-07-31
- **Deciders:** Cloud agent (implementation); Lance / Storm acknowledgement pending

## Context

Sell-side diligence is staged: mandate intake, teaser, preliminary data room,
confirmatory diligence. The permissions model already anticipates buyer phase
gates and document classification (`permissions_schema_v3-full.md`). Phase 1
delivered deal-scoped documents and view auditing via `/api/v1`, but documents
were metadata-only rows with no external storage or step scoping.

Box is the chosen dataroom provider. Each workflow step should own a dedicated
folder so uploads requested at a given step land in the correct room, and buyer
phase gates can align to step `min_phase`.

## Decision

1. **Extend the platform schema** with `deal_steps` (workflow steps per deal)
   and `datarooms` (one Box folder binding per step). Documents gain optional
   `dataroom_id`, `box_file_id`, and `storage_provider` columns
   (`supabase/migrations/20260731100000_dataroom_steps.sql`).

2. **Canonical sell-side steps** live in `src/lib/constants/dealSteps.ts`:
   intake (requires upload), teaser, preliminary data room (requires upload),
   confirmatory (requires upload). Steps are seeded when a deal is created and
   during dev seed.

3. **Box integration sits beside the seam**, like other `/api/v1` platform
   concerns (ADR-0008). New routes:
   - `GET /api/v1/deals/{dealId}/steps`
   - `GET /api/v1/deals/{dealId}/steps/{stepSlug}/dataroom` (lazy-provisions Box folder)
   - `POST /api/v1/deals/{dealId}/steps/{stepSlug}/dataroom/upload`

4. **`src/lib/box/`** wraps the Box Content API (Client Credentials Grant).
   When `BOX_*` env vars are unset, a deterministic in-memory mock client runs
   so local dev and tests work without credentials.

5. **MD-facing UI** adds a **Data Room** rail destination at
   `/projects/[projectId]/dataroom`: step tabs, upload panel on steps that
   `requires_upload`, file list, audit on upload.

6. **Upload authorization** follows the permissions matrix: MD, deal team,
   legal, seller, CCO, and admin may upload; buyers and read-only observers may
   not (app-layer predicate in `userCanUploadToDataroom`).

## Consequences

- New migration, constants, Box module, dataroom service, three API handlers,
  UI destination, and tests enter the tree.
- Real Box requires `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_ENTERPRISE_ID`,
  and `BOX_ROOT_FOLDER_ID` in `.env.local` (documented in `.env.example`).
- Buyer phase enforcement on step visibility is not yet wired in the UI; the
  schema carries `min_phase` for the follow-up that connects membership phase
  to step access.
- NDAs, engagement letters, and RLS suspenders remain deferred per ADR-0008.

## Open questions

1. Should step activation advance automatically when required uploads complete?
2. Do external buyers browse via Box shared links or an in-app viewer only?
3. When should class-4 / MNPI documents be blocked at upload time vs. routed to
   compliance review?
