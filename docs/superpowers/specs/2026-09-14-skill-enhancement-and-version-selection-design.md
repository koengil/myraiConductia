# Skill enhancement and version selection: design

**Status:** Approved design for sub-project E on 2026-09-14

**Repositories:** Conductia and Ignatious

**Depends on:** Part A project rail model, the Part B authoring slimdown, Part C skill publication and rail insertion, and Part D skill run execution and results. This work stacks on the Part D implementation branch (`skill-run-execution` in both repositories), not on Part C.

**Source decisions:** [project rail skill authoring map](../../../.scratch/project-rail-skill-authoring/map.md), [Part C design](./2026-09-09-skill-publication-and-rail-insertion-design.md), [Part D design](./2026-09-14-skill-run-execution-and-results-design.md), and the brainstorming session of 2026-09-14 recorded under "Decisions this design implements".

## Objective

Let a managing director change the skill behind a step without leaving the rail, and let a step run a version other than the one it was created with.

Two capabilities, one mechanism. **Enhancement** takes an existing skill version, a conversation in the shipped skill builder, and an optional failing run, and publishes a new version onto that skill's lineage. **Version selection** lets a step run any version available to it, either once or as the step's standing choice. Both apply to custom steps and to catalog steps.

Conductia owns the binding, the picker, the draft basis, the run history and every browser-facing route. Ignatious owns the ancestor's bytes, the conversation that produces a candidate, the immutable published versions, and execution of an exact version.

This design is deliberately the smallest thing that satisfies the decisions. It adds one table, one function, three relaxed constraints and one new arm on an existing discriminated union. It creates no second authoring pipeline and no second publication state machine.

## Evidence from the implemented systems

Written against the code as merged on the Part D branches, not against superseded designs.

What exists and is reused:

- The skill builder dialog is shipped and is the authoring surface to reuse: `SkillBuilderDialog.tsx`, `SkillAuthoringConversation.tsx`, `SkillCandidatePreview.tsx`, `SkillBuilderLauncher.tsx`, and the hooks in `src/lib/skillAuthoring/`. Its layout is a metadata row (step name, phase, position), a Conversation pane with composer, a Skill preview pane with a readiness chip, and a footer of `Discard draft`, `Close` and `Save skill and add step`.
- The authoring turn is a direct call from Conductia to Ignatious with no worker: `src/lib/skillAuthoring/runTurn.ts` posting to `POST /v1/bench/authoring/turns` (`platform/apps/skill-bench/src/authoring/turn-route.ts`). The turn request carries `attemptId`, `history`, `message` and `currentCandidate`, where `currentCandidate` is only the four-field preview (`name`, `purpose`, `expectedInput`, `expectedOutput`). Conductia never holds skill text.
- Candidate bytes are validated and stored immutably on the Ignatious side by `authoring/candidate-package.ts`. Conductia holds only the preview and the content digest.
- The publication processor states are `preparing`, `confirmation_required`, `publishing`, `attaching`, `reconciling`, `needs_placement`, `published`, `failed` (`src/lib/skillPublication/`), with the Ignatious prepare, publish and lookup routes under `platform/apps/skill-bench/src/authoring/publication/`.
- Part D's execution route (`platform/apps/skill-bench/src/authoring/execution/execution-route.ts`) already takes a discriminated union for its skill reference, with `kind: "publication"` as the only arm and a stated intention that a second arm is an addition rather than a change.
- `openRunRoot` (`execution/run-root.ts`) takes `{ packageBytes, digest }`, verifies the sha256 before writing anything, unpacks into a per-run skill root, and points `skillsRoot` and `skillsBase` at it. It does not care where the bytes came from.
- `runTurn` already accepts a model alias (`session.ts`, `request.model`). `resolveTurnModel` (`model-choice.ts:391`) returns a requested alias outright, from `request`. The skill-declared ceiling is applied by `clampModel` inside `buildExecutionProfile` (`profile.ts:180`), which bounds a skill routing itself, not a human choosing from a dropdown.
- The firm catalog already has an immutable per-version identity. `versions.ts` stores `versions/<name>/<n>.json` and `<n>.skill`, and `VersionRecord` carries `sha256`, `contentHash`, `bytesRetained`, `updatedBy` and `updatedAt`. `KEEP_VERSION_BYTES` is 10.
- Conductia already lists those versions: `GET /api/v1/bench/skills/{name}/versions` calls `createSkillBench(config).listVersions(name)`.
- Ignatious already merges a partial edit onto a live skill folder: `commit-skill-version.ts` reads the current folder, overlays exactly the named files, and zips the result, so untouched `references/` files survive.
- The firm's improvement methodology exists as a mount skill: `platform/claude-skills/skills/skillbuilder/SKILL.md`. Interview before drafting, establish one-off versus pattern, preserve everything unrelated to the complaint, show the full revised text, and commit only on the banker's own words.
- Part D's run record already keys on `deal_steps.id` and stores `skill_id`, `version_id` and `digest` per run rather than deriving them from the step, so history stays truthful once a step can run more than one version.

What exists and is deliberately not reused:

- `commit_skill_version` writes to the shared mount, firm wide, with rewindable numbering. Enhancement never writes to the mount. Only its overlay merge rule is reused.
- The catalog-step runner `BenchStepRunner` resolves a skill by taking the first mount skill whose process tag matches the step's tag (`BenchStepRunner.tsx:161`, `skillMatchesProcessTag`). It is replaced, not extended. See "The converged runner".
- `deal_steps.bench_conversation_id`, `bench_run_id`, `bench_run_status` and `bench_run_started_at` hold one in-flight run identity. They stop being written. They are not dropped on this branch.

What blocks this work today, exactly:

- `unique (reserved_skill_id)` on `skill_publication_operations` admits one publication operation per skill identity (`supabase/migrations/20260910200000_skill_publication_schema.sql`).
- `resulting_deal_step_id uuid unique` on the same table admits one publication operation per resulting step. An enhancement targets a step that already has one.
- `skill_id uuid not null unique` on `skill_publications` (`platform/apps/skill-bench/src/authoring/postgres/migrations/002_skill_publication.sql`) admits one publication row per skill identity.
- The partial unique index `skill_authoring_drafts(deal_id, author_id) where status = 'active'` admits one active draft per author per deal, which an enhancement draft would collide with.
- Publication duplicate detection treats "the same skill identity already bound to an active step" as a hard block, which an enhancement trips against its own step by definition.
- The rail migration states that only custom steps carry `definition` (`supabase/migrations/20260909124000_project_rail_model.sql`). A catalog step has `origin = 'catalog'` and a null `definition`, so a binding cannot live there if version selection is to work on catalog steps.

## Decisions this design implements

1. **Enhancing a catalog step's skill forks to a project copy.** A new project-scoped skill identity is seeded from the chosen firm-catalog version and the step rebinds to it. The firm catalog is read only from inside a deal. One enhancement mechanism for both step kinds, no cross-deal blast radius.
2. **Version selection is both a standing choice and a one-off.** A step has a bound default version that everyone on the deal gets, a run can be made once against a different version without changing the step, and an explicit action promotes a version to the step's default.
3. **An enhancement conversation is seeded with the skill plus the run it was opened from**, matching the skillbuilder methodology, which is built around the exact instructions, input and output that produced the problem.
4. **Once forked, the picker still shows both lists, grouped**, firm catalog and this project, and every version row names who made it and when, so an MD has a reference for the change.
5. **Enhancement starts from a run result, and is also available on a step with no runs**, where the conversation opens with the skill alone.
6. **Permission is the gate that already guards running the step.** Whoever can run it can enhance it, select a version and rebind it, behind the `skill_authoring` flag and the existing internal wall.
7. **A binding that no longer resolves refuses the run and says why.** Nothing substitutes silently.
8. **The runner converges on `SkillStepRunner`, which gains a model choice.** In-flight run resumability is accepted as lost. Existing bench replies on catalog steps are migrated into the run history.

## Scope

- One Conductia table for step bindings, and one function that rebinds a step.
- Draft basis on `skill_authoring_drafts`, and the browser and service routes that create and resume an enhancement draft.
- The turn contract carrying a basis and a seed run, and the Ignatious generator seeding from the ancestor's bytes.
- Candidate packaging by overlay onto the ancestor's package.
- The three relaxed constraints, and the duplicate-detection exemption.
- A `mount` arm on the Ignatious execution reference, and the stale-binding checks behind it.
- Version listing for a project lineage, reusing the existing listing for the firm catalog.
- The converged step surface: version control, one-off runs, promote, model choice, enhancement entry points, run history.
- Migration of existing catalog-step replies into `deal_step_skill_runs`.
- Authorization, audit, verification and rollout gates.

## Out of scope

- Deleting a published version, or any write to the firm-catalog mount from inside a deal.
- Sharing a project skill across projects, or promoting a project skill into the firm catalog.
- In-flight run resumability, in either runner. A run interrupted mid-flight is lost and re-run.
- Dropping the unused `deal_steps.bench_*` columns. They stop being written; removing them is a separate cleanup.
- Multi-turn follow-up on a run. Part D excluded it and this design does not reopen it.
- Effort selection. Only the model alias is offered.

## Architecture: one binding, two version sources

A step resolves to exactly one skill reference, through one function, in three layers:

1. a `deal_step_skill_bindings` row, when there is one;
2. otherwise `definition.skillBinding`, for a custom step, which is what Part C wrote at publication;
3. otherwise, for a catalog step, the mount skill whose process tag matches the step's tag, at its current version.

Absence is meaningful, so nothing needs backfilling and every step behaves today as it does now until someone acts on it.

The reference is a discriminated union with two arms:

- `{ kind: "publication", skillId, versionId, digest }`, an immutable project-scoped package in `skill_publications`.
- `{ kind: "mount", name, version, digest }`, a firm-catalog version identified by name, number and the `sha256` recorded on its `VersionRecord`.

The digest is what makes the mount arm safe. Mount numbering is rewindable, so a number alone can name different bytes over time. Pinning the recorded `sha256` turns that from a silent substitution into a detectable mismatch.

A useful side effect: the first time anyone selects a version on a catalog step, a binding row is written that names the skill explicitly, so that step stops depending on first-match-wins tag resolution.

## Conductia persistence

### New table `deal_step_skill_bindings`

One row per step, replaced on every rebind, identical in shape for catalog and custom steps. Explicit columns rather than a jsonb blob, because the stale-binding check and the picker both query it.

```
deal_step_id   uuid primary key references deal_steps(id)
deal_id        uuid not null references deals(id) on delete cascade
kind           text not null check (kind in ('publication','mount'))
skill_id       uuid
version_id     uuid
mount_name     text
mount_version  integer
digest         text not null check (digest ~ '^[0-9a-f]{64}$')
bound_by       uuid not null references users(id)
bound_at       timestamptz not null default now()
source         text not null check (source in ('publication','selection'))
```

Paired checks in both directions: `kind = 'publication'` requires `skill_id` and `version_id` and forbids the mount columns, and `kind = 'mount'` requires `mount_name` and `mount_version` and forbids the publication columns.

Row level security mirrors `deal_steps_select`: visible to a deal member or a same-tenant overseer, writes service-role only.

### `skill_authoring_drafts` gains a basis

```
basis              jsonb
basis_deal_step_id uuid references deal_steps(id)
seed_run_id        uuid references deal_step_skill_runs(id)
```

`basis` holds the resolved skill reference in the same union shape. A creation draft leaves all three null and behaves exactly as it does today. The existing placement columns are already nullable and stay null on an enhancement draft. A check enforces that `basis` and `basis_deal_step_id` are either both present or both absent, and that a draft with a basis has no placement.

### `deal_step_skill_runs` widens

`skill_id` and `version_id` become nullable, joined by `mount_name` and `mount_version`, so a firm-catalog run names what it ran. `digest` and `actor_id` also drop their `not null`, for imported rows alone. Two further columns:

```
model   text
source  text not null default 'execution' check (source in ('execution','imported'))
```

The nullability that is dropped is restored by a check rather than left open: an `execution` row must carry a digest, an actor and exactly one complete reference, in both directions. An `imported` row, written only by the migration below, carries none of them, because the bench path recorded neither a version nor who ran it. The immutability triggers and the append-only posture are unchanged.

### Relaxed constraints

- `unique (reserved_skill_id)` becomes a partial unique index `where state not in ('published','failed')`. At most one publication in flight per skill identity, any number published.
- `resulting_deal_step_id uuid unique` is dropped and replaced by a partial unique index over the same column `where state not in ('published','failed')`, for the same reason.
- The active-draft index becomes `(deal_id, author_id, coalesce(basis_deal_step_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'active'`, admitting one creation draft plus one enhancement draft per step, per author.

### New function `rail_rebind_step`

`rail_rebind_step(p_deal_id, p_actor_id, p_deal_step_id, p_reference jsonb, p_source text)` locks the deal, refuses a removed step, upserts the binding row, writes a `rail.step_rebound` audit event carrying the previous and new references, and returns the rail view. Service-role only, consistent with `rail_insert_step`.

`skill_publication_attach` branches on the operation's basis: without one it calls `rail_insert_step` exactly as it does today, with one it calls `rail_rebind_step` against the draft's `basis_deal_step_id`. Title, phase and position never move, and a catalog step stays `origin = 'catalog'` and keeps its contract, receipts and value line from `MVP_DEAL_RAIL`.

## Conductia browser API

- `POST /api/v1/deals/{dealId}/skill-drafts` gains an optional body `{ basisStepId, seedRunId? }`. The route resolves the step's current reference, refuses with 409 when the step has no resolvable skill, and writes the draft with `basis`, `basis_deal_step_id` and `seed_run_id`. Resuming keys on `(deal, author, basis_deal_step_id)`.
- `GET /api/v1/deals/{dealId}/steps/{stepId}/skill-versions` returns the grouped picker payload: the project lineage for the step's skill identity, each entry with version id, digest, published time and author name; and the firm-catalog versions for the resolved mount name, each with number, sha256, `bytesRetained`, `updatedAt` and `updatedBy`. It also names the step's current binding so the control has a value.
- `PUT /api/v1/deals/{dealId}/steps/{stepId}/skill-binding` promotes a version to the step's default. It validates the reference against that step's available set, calls `rail_rebind_step` with source `selection`, and returns the new binding.
- `POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/stream` gains an optional `version` in its body. When absent the run uses the binding. When present it is validated against the step's available set and used for this run only. Either way, the reference actually used is recorded on the run row.
- `POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs` records the model alias alongside the existing outcome fields.

## Ignatious API changes

- `SkillReferenceSchema` on the execution route gains `MountReferenceSchema`: `{ kind: 'mount', name, version, digest }`. Resolution reads `versionZipPath(config.skillsRoot, name, version)` and its `VersionRecord`, and hands `{ packageBytes, digest }` to the unchanged `openRunRoot`, which verifies the sha256 before writing anything. Three misses answer one 404, matching the publication arm: no such skill, no such version, and a version whose recorded hash is not the one asked for. A record that exists with `bytesRetained` false answers a distinct 409 naming pruning, because that is a recoverable state an MD can act on rather than a guessed identity.
- `SkillRunRequestSchema` gains a nullable model alias, clamped server side against the unpacked skill's declared `maxModel` using the existing `clampModel`, then passed to `runTurn`. The clamp moves server side because a published skill's frontmatter is not visible to Conductia.
- `TurnRequestSchema` on the authoring route gains `basis` (the same union, nullable) and `seedRun` (`{ input, output }`, nullable). The generator loads the ancestor's instructions from its own side, `skill_publications.package_bytes` for a publication and the mount folder for a mount reference, presents them as the skill being changed, includes the seed run when present, and follows the `skillbuilder` methodology for the conversation.
- Candidate packaging for a turn with a basis overlays the changed files onto the ancestor's package rather than building from nothing, so untouched `references/` files survive. This is the `commit-skill-version.ts` merge rule applied to a candidate.
- Publication duplicate detection exempts the draft's own ancestor identity. Matches against other project skills surface unchanged.
- A lookup returns the published lineage for one `skill_id`, ordered newest first.
- `skill_publications.skill_id` drops its `unique`, keeps `version_id unique`, and gains an index on `skill_id`. Rows stay immutable under their existing triggers.

## The enhancement flow

1. The MD reads a recorded run on a step and chooses `Improve this skill`, or chooses the same action on a step with no runs.
2. Conductia resolves the step's current reference and opens an enhancement draft carrying it, the target step, and the seed run when there is one. For a catalog step the basis records a `mount` reference. The fork happens at publication, not at opening, so an abandoned enhancement leaves no orphan project skill.
3. The conversation runs through the shipped builder. Ignatious seeds it with the ancestor's instructions and, when present, the failing run's input and output.
4. The MD iterates. The preview pane shows each of the four contract fields with the ancestor's value alongside the candidate's.
5. The MD publishes. The pipeline is unchanged through `preparing`, duplicate handling, `publishing` and `attaching`. A publication basis publishes onto the same `reserved_skill_id`, extending the lineage. A mount basis mints a fresh skill identity, which is the catalog fork.
6. `attaching` calls `rail_rebind_step`. The step now runs the new version, and the previous version remains selectable in the picker.

Conductia sends a reference plus run text it already owns, and receives the same four-field preview it receives today. The seam is unchanged.

## The converged runner

`SkillStepRunner` becomes the single runner for every skill-backed step, catalog and custom. `BenchStepRunner` is removed. An unbound catalog step resolves through layer 3 to a `mount` reference at the mount's current version, so it runs through the same execution route as everything else.

The step surface gains one control, placed next to the input rather than on the Array card, which is a structural summary:

- Its value is the step's bound version, labelled with its author and date.
- Its list is grouped `This project` (the lineage, newest first) and `Firm catalog` (mount versions, newest first). Each row shows the version, who made it and when. A mount version whose bytes have been pruned is listed and disabled with the reason rather than hidden.
- Choosing a version applies to the next run only. The control then states plainly that it differs from the step's version and offers `Use on this step`, which rebinds and is audited.
- `Improve this skill` sits on each recorded run in the history, and on this control when the step has no runs.

A model select sits beside it, carrying the aliases `modelsWithinCeiling` returns. For a mount-bound step the ceiling is known from the bench listing and narrows the list client side. For a publication the list is unnarrowed and Ignatious clamps. The alias actually used is recorded on the run.

## The dialog in enhancement mode

The shell, both panes and the Conversation component are unchanged. Four differences:

- The header reads `Enhance skill`.
- The metadata row is replaced. Step name, phase and position are all fixed for an enhancement, so the row instead states the basis: which step this belongs to, which version is being changed with its author and date, and the seed run when there is one, with a control to attach a different run from the step's history. Read only apart from that selector.
- The Skill preview shows each of the four fields with the ancestor's value alongside the candidate's. The readiness chip reads `Ready to publish`.
- The footer primary reads `Publish and use on this step`. `Discard draft` and `Close` are unchanged.

## Migrating existing bench replies

One migration reads catalog steps that hold a bench reply in `deal_steps.work` with a `bench_run_id`, and writes one `deal_step_skill_runs` row each with `source = 'imported'`, the stored input, the reply as `result_text`, outcome `succeeded`, `created_at` from `bench_run_started_at` where present, and null references, digest, actor and model.

An imported row cannot be re-run, because it names no version. It is a valid enhancement seed, because a seed is the run's input and output text while the basis comes from the step's current binding. That is most of the value of migrating.

## Authorization

One rule for every new capability: whoever can run the step can enhance it, select a version for one run, and rebind it. That is the `skill_authoring` flag, the internal wall (`classifyInternalUser`), and `resolveDealStepCapabilities(...).canEditWork`, exactly as the Part D stream route already enforces. No new permission key.

## Audit

One new event, `rail.step_rebound`, written inside `rail_rebind_step` and carrying deal, step, previous reference, new reference, actor and source. Publication and run events are unchanged. A rebind that arrives through publication and a rebind that arrives through selection are distinguished by `source`, not by two event names.

## Failure handling

Every failure refuses rather than substitutes.

- **Unresolvable binding.** A mount reference resolves through three checks: the record exists, `bytesRetained` is true, and the recorded sha256 matches. Any failure refuses the run with the reason named, pruned, renumbered, or missing, and the step offers the versions that do exist.
- **Basis step removed while a draft is open.** Publication refuses and the draft reports that its step is gone. The draft is discardable, not publishable.
- **Ancestor no longer bound.** If someone else rebound the step while a draft was open, `attaching` finds the step's binding is not the draft's ancestor and transitions to `reconciling` with `receipt_conflict`, which the processor already handles.
- **Model above the skill's ceiling.** Clamped server side and reported with the run, following the existing `clampedFrom` shape.

## Deliberate deferrals and accepted risks

- **A run interrupted mid-flight is lost.** Accepted, and a deliberate reversal of `BenchStepRunner`'s resumability. Part D records only terminal runs, and adding in-flight state is a larger change than this sub-project.
- **A forked project skill does not track later firm-catalog improvements.** The picker's `Firm catalog` group is the escape hatch: an MD can always rebind to a catalog version.
- **Firm-catalog bytes are retained for ten versions.** An older selection refuses rather than running something else. Accepted, and visible in the picker before it is selected.
- **Catalog steps change runner for every deal, not only enhanced ones.** Accepted, in exchange for one runner, one history, one gate and an explicit skill reference in place of first-match-wins.
- **The `bench_*` columns remain, unused.** A column drop is not folded into this branch.

## Verification

Unit and integration, in the existing shape:

- Binding resolution across all three layers, including a catalog step with no row, a custom step with no row, and a row of each kind.
- The relaxed constraints proving a second version publishes onto one skill identity, and a second operation resolves onto one step.
- The active-draft index proving a creation draft and an enhancement draft coexist, and two enhancement drafts on one step do not.
- The mount execution arm, including a digest mismatch, a pruned version, and a renumbered version whose sha256 no longer matches.
- The duplicate exemption proving an ancestor does not block while a genuine overlap still does.
- The overlay merge proving untouched reference files survive a candidate built from a basis.
- The model clamp proving a request above a skill's declared ceiling runs at the ceiling and reports it.
- The migration proving an imported row is written once, is not re-runnable, and is a usable enhancement seed.

End to end, authenticating through the API and skipping two-factor, per the repository convention: run a step, improve the skill from that result, publish, confirm the step runs the new version, then select the previous version for one run and confirm the run record names it, then promote it and confirm the binding changed.

Real-browser validation with seeded credentials against a local Supabase stack before the branch becomes a pull request. Never against a hosted project.

## Rollout gates

- Behind the existing `skill_authoring` flag. With the flag off, the version control, the enhancement entry points and the model select are absent, and a step runs its binding.
- The runner convergence ships with the migration, because an imported history is what makes the converged surface non-empty on a step that has already been run.
- Both repositories deploy together. The mount execution arm and the turn basis are additive and backward compatible, so Ignatious may lead.

## Repository responsibilities

**Conductia:** the binding table and its function, the draft basis, all browser routes, the picker payload, the converged runner and its model select, the dialog's enhancement mode, the migration, the audit event, and authorization.

**Ignatious:** the mount execution arm, the model parameter and its clamp, the turn basis and seed run, generator seeding from ancestor bytes, overlay candidate packaging, the duplicate exemption, the lineage lookup, and the `skill_publications` constraint change.

## Implementation-plan requirements

The plan must sequence Ignatious's additive changes before Conductia's consumers, keep the migration and the runner convergence in one step so no step is left with an empty history, and treat the three relaxed constraints as a single migration so no intermediate state admits a half-relaxed model. Parallel work must stay file disjoint. Every subagent prompt must restate that no command may point at a hosted Supabase project.
