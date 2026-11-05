# ADR-0009 — Data-room document-level gating deferred to the backend swap

- **Status:** Proposal; *later:* the deferral ended with D43, which enforces document gating server-side.
- **Date:** 2026-07-14
- **Source:** legacy PR [intelibank#65](https://github.com/FutureProofingDev/intelibank/pull/65) review (Martín, null-safety + security pass); the data-room rewrite (`src/components/dataroom/DataRoom.tsx`, `src/lib/dataroom/tree.ts`); extends D8 (the seam) / D28 (ADR-0008, `/api/v1` platform contract) and the D30/D31 data-room priority; reverses none.

## Context

The develop-design rewrite replaced the previous `DataRoom` with a single, per-`(manifest, kind)` file explorer. In doing so it dropped three document-level controls the previous implementation carried:

1. **MNPI-classified documents hidden from non-MD roles.**
2. **`minPhase` gating for the buyer** — gated documents were not even listed.
3. **A fail-closed default role.**

The current explorer renders **every** manifest entry with a working download link, regardless of perspective, and `src/lib/perspective/access.ts` still described the buyer's room as "phase-gated" (now corrected to point here). Separately, the `deal-folder` route comment claimed `middleware.ts` enforced the internal/external split; in fact `middleware.ts` enforces **authentication only** (and is a no-op when Supabase env is unset), the shell hard-codes `perspective = 'storm'`, and the underlying assets are static files under `public/data-room*` whose paths are enumerable from the manifest JSON shipped in the client bundle.

Net effect **today** is latent: because the shell hard-codes the MD perspective, the missing filter changes nothing a user can see in the demo. But it removes the enforcement point the seam was designed to keep for the future backend swap, and it made two in-repo comments overclaim.

## Decision

**Defer document-level gating (MNPI classification + `minPhase` filtering + fail-closed default) and real server-side document access control to the backend swap. Do not reintroduce it as a client-only filter now.** Keep the current explorer as a nav-gated, MD-perspective sandbox surface, and make the deferral explicit in code and here so the compliance invariant is visibly parked, not silently lost.

Concretely, shipped with this ADR:

1. **The stale "phase-gated" comment in `access.ts` is corrected** to state that per-document gating is not yet reintroduced and to point here.
2. **The `deal-folder` route comment is softened** so it no longer promises middleware/perspective enforcement it does not have; it now states the internal-only guarantee is nav-level only, with real enforcement deferred here.
3. **No client-only re-gating is added.** A client-side filter over a manifest that still ships every path in the bundle (with statically-served assets behind it) would be security theatre; the honest control is server-side and lands with the backend.

## Consequences

- **When the backend lands:** serve data-room / deal-folder documents through a perspective-checked route handler (beside the `/api/v1` platform contract, ADR-0008) rather than static `public/` assets, and filter the manifest by perspective server-side before it reaches `DataRoom`. Reintroduce MNPI classification, `minPhase` gating, and a fail-closed default at that layer. This is the "belt (app-layer predicate) then suspenders (deal-scoped RLS)" pattern D28/D33 already established.
- **Until then:** the internal Deal Folder is internal-by-convention (nav affordance), not by enforcement. This is an accepted sandbox trade-off, recorded here so a future maintainer does not mistake the nav guard for access control.
- **Compliance invariant:** unchanged in spirit (every intent/message still routes through compliance); this ADR only scopes *document-object* access control to the backend phase.
