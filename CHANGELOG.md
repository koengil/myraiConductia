# Changelog

Dated project history: what shipped, proposed scopes and open items, as recorded at the time. Releases are tagged `vX.Y.Z` on `main` (see `git tag`); decisions live in `docs/07-decisions/decision-log.md` and the ADRs.

The entries below moved here from `CLAUDE.md` on 2026-10-20, unchanged, newest first. They describe the state at their date: check the code before relying on one. The release entries summarize each tag's GitHub release notes (`gh release view vX.Y.Z`), which carry the full PR list; decisions are in the decision log.

## 2026-10-15 `v0.8.0`, released to production

The first release after the migration workflows (#445, #489), shipped by hand as `docs/04-operations/production-bootstrap.md` ("Before the first automated release") describes, because `main` did not yet hold the new Promote workflows. Production migrations `20261003100000` to `20261010120000` (17 files) were applied with `supabase db push --include-all` from `staging` at `39c7d05a6`, and `main` was fast-forwarded by hand. Carried: rail template catalog versions, template change review and saving a deal's rail to the catalog; deal discovery's exclusion policy, the Gmail replay demo, reader-pass health, source restart and the AWS discovery worker; Google Workspace connect from the profile menu; every AI call on the cost ledger with monthly budget alerts (D83); keeping bank content out of URLs, logs and responses (#331).

## 2026-10-07 `v0.7.0`, shipped

Shipped untagged on Oct 7 (`docs/04-operations/production-bootstrap.md`); the tag and release notes were created on Oct 13. Carried: the project-owned rail model and step removal (#147), durable skill authoring (#151), skill publication and rail insertion (#180), skill runs with recorded results (#183), skill enhancement and version selection (#184), saved rail templates and typed step inputs; the email safety stack (#192 to #194, #221); the per-tenant hash-chained audit log (D62); deal-scoped RLS and the room wall (#78, #79); the signed agent-seam trigger token (#188); the discovery tracer bullet; and the hardening fixes from #248 to #250.

## 2026-09-14 Skill enhancement and version selection, shipped behind `skill_authoring`

A rail step resolves to exactly one skill reference through `deal_step_skill_bindings`, a custom step's `definition.skillBinding`, or a catalog step's tag-matched mount skill, in that order. The reference names either an immutable project publication or a firm-catalog version, both pinned by content digest. A version can be run once without changing the step, or promoted to the step's default (audited as `rail.step_rebound`). Skills are enhanced in place through the shipped skill builder, seeded from the ancestor skill and, when opened from a run, that run's input and output; enhancing a catalog step's skill forks a project-scoped copy, since the firm catalog is never written to from inside a deal. Every skill-backed step now uses one runner, `SkillStepRunner`; `BenchStepRunner` is removed. The Ignatious model clamp, not a client-side ceiling, bounds a chosen model that exceeds a skill's declared ceiling. Not yet exercised end to end against a live Ignatious service; the migration of pre-existing bench replies into run history covers only step `p1-s10`, because every other step's reply key is computed in TypeScript and cannot be named in SQL with certainty.

## 2026-09-08 MVP 2 — proposed scope, ships Oct 30, 2026 (as recorded 2026-09-08)

*Later: PR #146 closed unmerged on 2026-09-30, so the scope document below is not on `develop`.*

`docs/02-product/mvp-2-2026-09-08.md` (PR #146, awaiting Storm's approval; then ADR + decision-log entry). Thesis: bankers shape the workflow, Conductia does the drafting. Eight release-gate items in priority order: custom rails, skill builder, email safety, beta hardening, AI cost tracking (shipped, #153), first skills wave + twins, compliance controls + Outlook, buyer/seller invitations (cut line). Weekly gates W2–W7 are the repo **milestones**; every issue and PR is on the [delivery board](https://github.com/orgs/Conductia/projects/1). In flight for items 1 and 2: the project-owned rail model (#147, flag `project_rail_model`), durable skill authoring (#151, flag `skill_authoring`) and skill publication + rail insertion (#180), with the engine side in `Conductia/conductia-agents-backend` (#126, #137).

## 2026-08-06 Team consolidation — shipped (D46)

`/projects/[projectId]/team` is the single team destination. With `platform_onboarding` enabled it owns the authoritative cross-party roster, invitations, resend/revoke, and member access controls; with the flag off it retains the ConductiaAPI-backed compliant-conversation demo. Navigation and external deal-home links point only to Team. `/projects/[projectId]/working-group` is a compatibility redirect to Team, never a second product surface. There is no top-level `/working-group` route: a working-group link is always project-scoped, so a bare path has no deal to resolve.

## 2026-08-03 Labor Day MVP — delivered (ADR-0013 / D45)

**Shipped Sep 7, 2026 as `v0.5.6`** (production at app.conductia.com; `v0.6.0` on Sep 15). Four launch priorities: workflow + evidence, onboarding + Box, compliant in-platform comms, narrow person-brief digital twin. Explicit deferrals: buyer/seller onboarding, Outlook/SMS, full automation, presentation gen. Scope doc is historical: `docs/02-product/labor-day-mvp-2026-08-03.md`.

## 2026-06-05 routing reframe — shipped

Three-tier routing. Tier 1 (unguarded): `sign-in` + dev tools at the top of `src/app/`, excluded from the middleware matcher. Tier 2 (authenticated, project-less): the project picker at `/`, rendered inside the shell so sign-out is reachable. Tier 3 (project-scoped): the dashboard and destinations under `/projects/[projectId]` (`acquirers`, `acquirers/[id]`, `team`, `skills`). The former `(app)` route group was renamed `(authed)`; the full-screen `MandateOnboarding` intake was replaced by the in-shell picker; the active project is now the URL segment rather than `state.mandateCompany`. The floating command console is scoped to project routes. Formalized in **ADR-0008** (D28), together with the Phase 1 backend below.

## 2026-06-05 Phase 1 backend — shipped (ADR-0008)

The first product-shaped backend slice. The minimal permissions schema is migrated (`companies`, `users`, `roles`, `deals`, `deal_parties`, `deal_memberships`, `documents`, `audit_log`); identity is Supabase Auth mirrored into `public.users` by a `security definer` trigger (Option A: `users.id = auth.users.id`). The deal/membership/document/audit transport is versioned REST at **`/api/v1/*`, BESIDE the `ConductiaAPI` seam** — never inside it (the seam stays the M&A content contract; this is the platform contract). Handlers self-authenticate (`requireApiUser`), access is enforced with app-layer predicates (`src/lib/api/v1/access.ts`) with deal-scoped RLS to follow, and request-context events (deal create / membership grant / document view) are audited inline. TS constants in `src/lib/constants/*` mirror the SQL `CHECK` enums (the migration is the source of truth). Self-describing via `openapi/phase1.json` → `/api/v1/openapi.json`, explorable at `/dev-api` (dev-only), seeded per role by `npm run seed:users`. Reference: `docs/03-engineering/api-v1.md`. **Closes #20/#21/#23/#24/#25/#29/#30.** The MD-facing surfaces were wired onto these APIs afterwards: Gate 0 (D38), documents and the data room (D43), Team (D46). Legacy issue numbers in this section are `intelibank#N`.

## 2026-05-24 AI-native redesign — open items

Shipped: fixed-viewport rail shell, mandate intake, floating command console (with minimize), Storm Duncan persona, deep-dive segmented analysis, per-recipient team threads, contrast layer-fix, rounded/floating aesthetic. **Pending formal ADRs:** AI-native shell + intake, keep-custom-over-shadcn, persona reposition. **Pending Storm decisions:** gold→teal accent demotion, "Compliance theatre" rename. **Still stubbed (honest):** real AI answers in the command bar.
