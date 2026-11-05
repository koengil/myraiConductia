---
run_id: smart-onboarding
type: review
status: approved
round: 2
source: spec-v2.md
---

# Review: spec-v2.md

## 1. Faithfulness to the brief

Approved. The document remains centered on exactly the three connected outcomes in `brief.md`: smart lookup on the two existing invitation surfaces, a server-authoritative live perimeter preview, and a current-data welcome brief after the existing verification, acceptance, TOS, and 2FA gates (`spec-v2.md:27-43`, `spec-v2.md:59-89`). It preserves explicit human confirmation and least-privilege recommendations (`spec-v2.md:29-33`, A7-A9), and it introduces neither a fourth workflow nor an adjacent research, chatbot, autonomy, or request-management product (`spec-v2.md:35-43`, `spec-v2.md:226-237`).

Prior finding **1.1 is resolved**. B13 now specifies an explicit zero-document preview that still reports applicable destinations and capabilities, states the invariant denials, and reveals no inaccessible totals (`spec-v2.md:161`); D8.10 requires automated coverage (`spec-v2.md:214`). This matches the brief's required empty state without weakening its loading, stale, unavailable, or no-leakage behavior (`brief.md:40-46`).

## 2. Concrete and testable behavior

Approved. Prior finding **2.1 is resolved**. The spec defines the lookup's bound-input tuple (`spec-v2.md:56`), binds both results and derived pre-fills to that tuple (A13), immediately withdraws stale results and pre-fills, discards out-of-order responses (A14), exposes an accessible loading state (A15), and defines a neutral failure state that cannot satisfy or weaken confirmation (A16) (`spec-v2.md:121-127`). D8.5-D8.6 require failure and race tests, including both invitation surfaces (`spec-v2.md:209-210`).

The remainder is also expressed as independently verifiable criteria: actor- and fact-scoped lookup results (A1-A19), shared-policy preview parity and stale/failure behavior (B1-B13), current-data welcome content and actions (C1-C11), and cross-cutting flag, accessibility, deterministic-demo, documentation, and repository-gate requirements (D1-D10). D8 explicitly exercises authorized and unauthorized disclosure, indistinguishability, preview parity and leakage, phase-raise and zero states, personalized action selection, later-visit refresh, cross-company roster exclusion, flag-off parity, and the end-to-end demo (`spec-v2.md:203-224`).

## 3. Scope control

Approved. The non-goals and delivery boundaries remain strong enough to prevent scope drift: no conversational surface, autonomous grants or phase raises, external enrichment, mandatory LLM, invented workflow state, replacement invitation flow, authority expansion, persisted preview history, or task-system welcome brief (`spec-v2.md:35-43`, `spec-v2.md:226-237`). The feature reuses Gate 0, Team, Data Room, and the scoped external shell, and preserves the existing verification, TOS, 2FA, Box, and audit contracts (A1, C1, C9, D4).

No optional implementation preference has been elevated into a blocker. Q12 correctly leaves a genuinely necessary persistence discovery to plan review while requiring forward migration and rollback treatment if that discovery occurs (`spec-v2.md:263`).

## 4. Resolved product decisions

Approved. Prior finding **4.1 is resolved**. C1 now distinguishes a stable brief structure from values, capabilities, and actions recomputed from current trusted server data on every render; C3 requires phase, release, and permission changes to appear on the next render (`spec-v2.md:165-169`). D8.13 tests that later-visit contract (`spec-v2.md:217`), and Q14 explains the same stable-structure/live-values decision without contradiction (`spec-v2.md:267`).

The document also resolves the important ambiguous and failure states: unknown business domains remain unverified proposals (A4); lookup loading, failure, supersession, and malformed inputs are neutral and non-authoritative (A12-A16); recommendations remain overridable proposals with explicit confirmation (A7-A9); preview loading, stale, unavailable, zero-access, and phase-raise states are explicit (B7-B13); and first and later welcome visits read current trusted data without one-time client state (C1-C3).

## 5. Consistency and safety

Approved. Prior finding **5.1 is resolved**. C10 now unconditionally prohibits the brief from returning, rendering, or deriving content from another company's roster; an authorized Team link remains subject to Team's own boundary and is not a roster channel into the brief (`spec-v2.md:183`). D8.14 requires the cross-company negative test (`spec-v2.md:218`). This now matches the brief's unconditional another-company-roster prohibition (`brief.md:48-55`).

Prior finding **5.2 is resolved**. A2 makes invitation authority necessary but not sufficient for per-fact disclosure; A17 limits existing-user disclosure to facts already visible through roster, deal-membership, or tenant-overseer authority; A18 separately scopes current-deal-seat disclosure; and A19 returns only the bare fact while making an invisible user, seat, or invitation indistinguishable from an unknown address (`spec-v2.md:99`, `spec-v2.md:129-133`). D8.2-D8.4 require authorized, unauthorized, cross-company, cross-tenant, and indistinguishability coverage (`spec-v2.md:206-208`).

The fresh safety pass found no contradictory authority or leakage path. Preview remains server-computed through the real access decision path, excludes inaccessible counts and metadata, is read-only, and fails closed (B1-B12). The welcome brief validates deal membership before rendering, offers only server-permitted actions, retains the external Internal-room and classification-4 walls, and exposes no hidden or unaccepted-invitation context (C2-C10). D1-D4 preserve server-side fail-closed authorization, feature-flag parity, credential secrecy, and the existing verification, TOS, 2FA, Box, and audit contracts.

## Decision

`spec-v2.md` is approved. Findings 1.1, 2.1, 4.1, 5.1, and 5.2 from `cr-spec-v1.md` are closed, and the full superseding document satisfies all five review dimensions. Blocking changes: none.
