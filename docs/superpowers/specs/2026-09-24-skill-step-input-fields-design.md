# Skill step input fields: design

**Status:** Approved design on 2026-09-24, revised the same day after a code-grounded review

**Repositories:** Conductia and Ignatious

**Depends on:** Part C skill publication and rail insertion, Part D skill run execution and results, and Part E skill enhancement and version selection, all merged.

**Source decisions:** [Part C design](./2026-09-09-skill-publication-and-rail-insertion-design.md), which deferred "configurable multi-field execution forms" and kept a versioned `inputs` array for this purpose; [Part D design](./2026-09-14-skill-run-execution-and-results-design.md); [Part E design](./2026-09-14-skill-enhancement-and-version-selection-design.md); and the brainstorming session of 2026-09-24 recorded under "Decisions this design implements".

## Objective

When a managing director builds a skill, the builder infers the inputs the skill needs from the conversation. When the skill is saved to the rail, the step renders those inputs as typed form fields instead of the single `Input` textarea, and a run sends the values to the skill as named, validated inputs.

The fields are part of the skill version, declared in its SKILL.md and pinned by its content digest. Changing a step's version changes its form.

Which steps this reaches: every step rendered by `SkillStepRunner`, meaning builder publications and tagged catalog steps run on the skill-bench. No bench catalog skill (`platform/claude-skills/skills/*`) declares inputs today, so those steps read as having no fields and show only the Additional instructions box, which holds their existing text. A catalog skill that declares `rtslabs.inputs` later gets its form with no further work. MD Briefing (seq 9, `MdBriefingRunner` through the control plane), Teaser (seq 36, `TeaserRunner` in the in-process spine) and Presearch (the lead page, `PresearchRunner`) run on dedicated paths that this work does not touch; MD Briefing and Presearch already have hand-built forms validated by the runtime against their own `rtslabs.inputs`.

Ignatious owns the field declaration, its validation at authoring time and at run time, how values reach the model, and serving each version's field list. Conductia owns the form, the stored values, the run snapshot and every browser-facing route. Conductia never stores a version's field list; it reads it from Ignatious.

## Decisions this design implements

1. Field kinds in the first release: single-line text, multi-line text, number, date and single choice. No document picker, no boolean for new skills.
2. The builder agent proposes the fields. The banker changes them by asking in chat, which produces a new candidate. There is no inline field editor.
3. Every skill step also has an optional free-text "Additional instructions" box.
4. Any skill run by `SkillStepRunner` that declares fields gets a form, whatever its origin: builder publications and bench catalog skills alike. The dedicated MD Briefing, Teaser and Presearch runners are unchanged.
5. Approach A, manifest first: fields live in the skill's SKILL.md frontmatter, not on the step definition and not in Conductia's publication records.
6. `string` keeps its existing meaning (single line). The multi-line kind is `textarea`. There is no separate `text` type.
7. Caps: at most 12 fields per skill, 20 values per choice, 60 characters per label.
8. The browser sends the values for the version it rendered; the server does not look up field lists on the run path.

## Current state

Conductia:

- `parseSkillStepDefinitionV1` (`src/lib/skillPublication/parse.ts`) accepts exactly one input, `{ key: "primary", kind: "text", required: true }`. The candidate's `expectedInput` prose becomes its helper text.
- `resolveRunnableStep` (`src/lib/skillRun/step.ts`) reads `work.primary` and refuses an empty value with `empty_input`. Only `skill-runs/stream/route.ts` calls the bench, through `startSkillRun` (`src/lib/ignatious/bench.ts`), sending `input: string`. `skill-runs/route.ts` records a finished run: it recomputes `input` from the current `work` and compares it in its duplicate-replay check.
- Runs are recorded in `deal_step_skill_runs` (`supabase/migrations/20260916130000_deal_step_skill_runs.sql`) with `input text not null`. `SkillRunSummary.input`, `RunnableStep` and `StepResolution` (`src/lib/skillRun/types.ts`) and `decorate` in `skill-runs/route.ts` assume a string.
- `readStepVersions` (`src/lib/skillRun/versions.ts`) builds catalog options from the bench's `listVersions` records (`CatalogVersionRecord`, `normalizeVersion`) and project options from `listPublicationLineage` entries (`PublicationLineageEntry`, `LineageAuthorEntry`).
- `capability_contract` on `skill_publication_operations` is written at admission, frozen by a trigger, parsed with exactly three keys by `parseCapabilityContract`, and compared whole in the SQL duplicate check. The publication receipt is parsed with an exact key set by `parsePublicationReceipt`. This design changes neither.
- The step PATCH (`steps/[stepId]/route.ts`) merges `work` one level deep.
- The builder's candidate preview reaches the browser through `skill_authoring_browser_candidate` (`supabase/migrations/20260916110000_skill_authoring.sql`), which builds the preview from four named keys, and `browserRoute.ts`. `TurnCandidatePreview` (`src/lib/skillAuthoring/ignatiousAuthoring.ts`) has the same four fields.
- `readSeedRun` (`src/app/api/v1/deals/[dealId]/skill-drafts/route.ts`) seeds an enhancement from a run as `{ input, output }`.

Ignatious (`origin/main`):

- The candidate tool (`apps/skill-bench/src/authoring/candidate-tool.ts`) takes `skillMdText` whose frontmatter `SKILL_MD_RULE` limits to `name` and `description`, plus four prose preview fields. `candidatePayload` and `PrivateCandidate` (`generator.ts`) carry those four. The turn request's `currentCandidate` (`turn-route.ts`) uses the same preview schema, and the seed run schema is strict `{ input, output }`. The agent is shown the ancestor's full SKILL.md when enhancing.
- Bench frontmatter is read by `readFrontmatter` and `statusOf` (`apps/skill-bench/src/frontmatter.ts`), line by line, top-level keys only (for example `max-model`). `mountedSkills` (`apps/skill-bench/src/skills.ts`) parses none itself.
- `/v1/bench/skill-runs` (`execution/execution-route.ts`) validates a strict `SkillRunRequestSchema` with required `input: z.string().trim().min(1).max(20_000)` and passes it to `runTurn` verbatim as `message`. For a publication it looks the skill up in `mountedSkills` only to read its model ceiling and carries on if it is not found.
- `packages/skill-runtime` declares `ManifestInputSchema` (`string | number | boolean | enum`, not exported), `typeProblem`, and `validateSkillInputs`, which takes a full `ValidatedSkill` and refuses undeclared names. md-briefing, presearch and the conductia-prototype `SkillPicker.tsx` form consume these types.
- Bench errors use the `apiError` envelope (`packages/http-envelope/src/errors.ts`); a malformed request already answers `422`.

## Out of scope

- A deal document picker or any reference-typed input.
- An inline field editor in the builder.
- Conditional fields, multi-select choices, and field groups.
- Boolean fields for newly built skills.
- A per-field length rule that distinguishes `string` from `textarea`.
- Moving MD Briefing, Teaser or Presearch onto the generic runner. MD Briefing would need its SKILL.md mounted on the bench and labels added to its fields, and it is a live production step.
- Including fields in duplicate detection. `capability_contract`, `capabilityFingerprint` and the duplicate comparison stay prose-only; `expectedInput` summarizes the fields. The package digest covers the fields, so two versions with different fields are still different versions.

## Field contract (Ignatious)

### Declaration

A skill declares its fields in SKILL.md frontmatter under `metadata.rtslabs.inputs`, the key md-briefing already uses:

```yaml
metadata:
  rtslabs.inputs:
    - name: reportingPeriod
      label: Reporting period
      description: Quarter or date range to cover
      type: date
      required: true
    - name: audience
      label: Audience
      type: enum
      values: [Board, Buyer, Internal]
      default: Internal
```

`ManifestInputSchema` in `packages/skill-runtime` is exported and changes as follows. Existing keys keep their meaning.

| Key | Rule |
|---|---|
| `name` | Required. camelCase, unique within the skill. The key values are stored and sent under. |
| `label` | New, optional, at most 60 characters. Defaults to `name` on the form and in the run message. |
| `description` | New, optional, at most 300 characters. Helper text on the form. |
| `type` | `string`, `textarea`, `number`, `date`, `enum`, or `boolean`. `textarea` and `date` are new. `boolean` remains valid for existing skills; the builder is not told to use it. |
| `values` | Required for `enum`, 1 to 20 non-empty strings. |
| `required` | Optional boolean. |
| `default` | Optional, checked against its own declaration as today. |

A skill declares at most 12 fields, as an array-level rule in a new exported `ManifestInputsSchema`.

`string` and `textarea` validate identically: both accept any string. The difference is rendering only, and no rule may treat them differently. `date` accepts an ISO calendar date, `YYYY-MM-DD`, that is a real date. `typeProblem` gains the `textarea` and `date` cases.

`validateSkillInputs` is split: a new exported `validateInputs(declared: ManifestInput[], provided)` holds the logic, and the existing `validateSkillInputs(skill, provided)` delegates to it, so md-briefing and presearch behave as before.

Other consumers of the widened `ManifestInput` type are updated in the same change: the `typeProblem` switch, and the conductia-prototype `SkillPicker.tsx` form, which renders `textarea` as a textarea and `date` as a date input.

### Authoring

The candidate tool gains a structured `inputs` argument validated by `ManifestInputsSchema`. The agent does not write the field list as YAML: `candidate-tool` rejects a `skillMdText` whose frontmatter contains a `metadata` key, and the agent retries. `candidate-package` inserts the validated list into the SKILL.md frontmatter as `metadata.rtslabs.inputs` before the package digest is computed, so the digest covers the fields. An empty list inserts nothing. `SKILL_MD_RULE` keeps "exactly two keys" for what the agent writes and says the platform adds the inputs block.

`inputs` travels with every candidate preview: `candidatePayload`, `PrivateCandidate`, the stored candidate, the turn stream's candidate event, and `currentCandidate` on the next turn request, so the agent sees the current fields when asked to change them.

The builder has no separate authoring prompt: its guidance is the candidate tool's description and argument descriptions. The `inputs` argument's description tells the agent to infer the inputs the skill needs from the conversation, to prefer few fields, to use `enum` when the answer is one of a small known set, and to change fields only when the banker asks.

Enhancement: the agent is shown the ancestor's SKILL.md with the `metadata.rtslabs.inputs` block removed, and the ancestor's `inputs` as the current candidate's fields. The seed run schema becomes `{ input, inputs, output }`, where `input` is the instructions text or empty and `inputs` is the recorded values; the agent sees both.

`expectedInput` stays a one-line prose summary.

### Reading it back

`readFrontmatter` parses the frontmatter block as YAML once it has found it, and reads `metadata['rtslabs.inputs']` with `ManifestInputsSchema`. The result, `[]` when nothing is declared, is carried on `Frontmatter`, `Skill` and `MountedSkill`. A declaration that fails to parse makes `statusOf` return `not_loadable` with the reason. The existing top-level keys keep their current parsing.

Two listings carry `inputs` per version:

- the catalog versions listing behind Conductia's `listVersions`, one list per version record;
- the publication lineage behind `listPublicationLineage`, one list per published version.

Each reports the list of that version, not of the current one. A catalog `VersionRecord` copies `inputs` off the skill when the version is minted, as it already copies `description` and `status`; a record minted before this change reads as `[]`, which is accurate because no catalog skill declared inputs then. A publication lineage entry reads the list from that version's stored package bytes, so it needs no new column. The publication receipt and the capability contract do not change.

### Execution

`SkillRunRequestSchema` on `/v1/bench/skill-runs` becomes:

| Field | Rule |
|---|---|
| `inputs` | Optional object keyed by declared `name`, default `{}`. Validated by `validateInputs` against the mounted version's declaration before any spend. |
| `instructions` | Optional string, at most 20,000 characters. |
| `input` | Optional legacy string, at most 20,000 characters. Used as the instructions when `instructions` is absent. Accepted for one release, then removed. |

The route refuses a publication or mount that `mountedSkills` does not return as loadable, with the existing not-found error, instead of carrying on without a declaration.

A validation failure answers `422` in the `apiError` envelope with the existing code `validation` and `detail.problems: [{ name, message }]`, where `name` is `null` for a problem not tied to one field. A malformed request also answers `validation`, without `detail.problems`; the presence of `problems` is what tells the two apart. No new error code is added to `@ignatious/http-envelope`.

The bench builds the run message, the `message` given to `runTurn`, from this template:

```
Inputs:
- <label>: <value>
...

Additional instructions:
<instructions>
```

Each block is omitted when empty. A run with neither sends `Run this skill on the deal's current information.` Values are rendered as text; `number` without formatting, `date` as `YYYY-MM-DD`.

## Conductia

### Field definitions per version

`CatalogVersionRecord` (via `normalizeVersion`) and `PublicationLineageEntry` / `LineageAuthorEntry` (via `normalizeLineageEntry`) gain `inputs: SkillInputField[]`, and each `VersionOption` returned by `readStepVersions` carries them. One parser, `parseSkillInputFields`, mirrors the Ignatious schema. A missing key reads as `[]`; an invalid list reads as `[]` and is logged, and the bench's run-time check stays the authority. Conductia does not persist field lists.

The runner renders the fields of the version that will run: the step's default, or the version chosen for a single run.

### Stored values

Values live in the step's existing `work` jsonb:

- `work.inputs`: object keyed by field `name`. Strings for `string`, `textarea`, `enum` and `date`; a number for `number`; a boolean for a legacy `boolean`.
- `work.primary`: the Additional instructions text. Steps created before this change already hold their typed input here, so they open with it in the instructions box. Nothing is migrated.

The step PATCH merges `work` one level deep, so autosave always sends the whole `work.inputs` object. Values are keyed by name, so they carry across version changes. A stored value for a field the running version does not declare stays in `work` and is not sent.

### Run path

The browser sends what it rendered. The stream request body gains `inputs` (filtered to the rendered version's declared names, empty strings dropped) and `instructions` (trimmed `work.primary`, or `null`). This follows Part D's rule that the input comes from the request: a client can only misdescribe its own run.

- `resolveRunnableStep` no longer reads or checks the input. `empty_input` is removed from `StepResolution`, and `RunnableStep` drops `input`.
- `skill-runs/stream/route.ts` validates the body's shape and forwards `{ inputs, instructions }` through `startSkillRun`. For one release it also sends `input` equal to the instructions when they are non-empty, so a bench that has not yet shipped still runs steps with no fields. A bench `422` is returned to the browser unchanged.
- `skill-runs/route.ts`, the record POST, receives the same `inputs` and `instructions` from the client and stores them. Its duplicate-replay check compares `inputs` as well as instructions.
- Conductia enforces required fields in the form only. It adds no second validator.

### Run history

A migration changes `deal_step_skill_runs`:

- adds `inputs jsonb not null default '{}'`, the snapshot of the values sent;
- makes `input` nullable. It holds the instructions text, or null when there were none.

`SkillRunSummary` gains `inputs` and makes `input` `string | null`; `decorate` and the history API follow. `readSeedRun` returns `{ input, inputs, output }` for enhancement.

Audit is unchanged: ids and codes only, no input values.

### Builder plumbing

A migration replaces `skill_authoring_browser_candidate` so the preview includes `inputs` from `candidate.preview`. `TurnCandidatePreview`, the turn-stream candidate parser and `browserRoute.ts` carry `inputs`, defaulting to `[]` for candidates stored before this change.

## UI

### Builder candidate preview

`SkillCandidatePreview` shows an Inputs list below purpose and output. Each row shows the label, the kind (Short text, Long text, Number, Date, Choice), a Required tag when required, and the choices for an `enum`. The list is read-only. A candidate with no fields shows "No inputs. Runs on deal context and instructions."

### Step form

`SkillStepRunner` keeps its order: input, then result, then history. The input area contains:

| Type | Control |
|---|---|
| `string` | Text input |
| `textarea` | Textarea |
| `number` | Numeric input; the value is sent as a number |
| `date` | Date input |
| `enum` | Select, preselected to `default` when declared |
| `boolean` | Checkbox, for legacy skills only |

- Fields appear in declared order, each with its label, its `description` as helper text, and a required marker.
- Additional instructions, an optional textarea, is always last.
- Values autosave into `work` through the existing step PATCH, as the textarea does today.
- Draft this step is disabled until every required field has a value, and the first missing field is named inline.
- A bench `422` maps each `detail.problems` entry to its field; problems with no matching field are listed above the button.
- Changing the version, for one run or as the default, re-renders the form for that version. Shared values stay; new fields start empty or at their default.

Controls are composed from the Workbench register primitives. Every control has a visible `<label>`; required fields set `aria-required`; errors are linked with `aria-describedby`; tab order is fields, instructions, Draft. Copy follows the brand voice, with no em-dashes.

### History

A selected past run shows its field values as a compact label and value list above its result, then its instructions when present. Labels come from the version the run used when it is still listed, and fall back to the field name.

## Error handling

| Case | Behaviour |
|---|---|
| The agent proposes invalid fields, or writes a `metadata` key itself | The candidate tool rejects the call and the agent retries |
| A stored manifest's `inputs` fail to parse | `statusOf` marks the skill `not_loadable` with the reason; the execution route refuses it |
| A required field is missing or a value has the wrong type at run time | Bench `422` `validation` with `detail.problems`, shown on the form. No run record, no spend |
| A field list from a listing fails to parse in Conductia | The form shows no fields and the error is logged; a run that needs fields gets the bench `422` |
| The bench is unreachable | Unchanged from the Part D failure state |

## Rollout

- Behind the existing `skill_authoring` flag. No new flag.
- Ignatious ships first. It accepts the legacy `input` for one release, so the Conductia still in production keeps running.
- Conductia follows, and for the same release also sends `input` when instructions are present. Once both are live, a follow-up removes `input` from both sides.
- Schema changes: the `deal_step_skill_runs` column change and the replaced `skill_authoring_browser_candidate` function in Conductia. `capability_contract`, the publication receipt and older publications are untouched; older versions read as having no fields, and `work.primary` keeps its meaning.

## Testing

Test first in both repositories.

Ignatious:

- `ManifestInputSchema` and `ManifestInputsSchema` accept the new types and keys and reject over-cap lists, over-long labels, `enum` without values and duplicate names.
- `typeProblem` accepts valid `YYYY-MM-DD` dates and rejects invalid ones; `validateSkillInputs` still passes its existing md-briefing and presearch cases.
- The candidate tool rejects agent-written `metadata`; `candidate-package` writes `inputs` into the frontmatter, and the digest is identical for identical input.
- `readFrontmatter` parses a fixture in md-briefing's inline flow format (`- { name: meetingType, type: enum, values: [...] }`), returns `[]` for a skill that declares nothing, keeps `max-model` parsing unchanged, and `statusOf` marks an invalid declaration `not_loadable`.
- The versions listing and the publication lineage report each version's own fields.
- The execution route answers `422` `validation` with `detail.problems`, refuses a not-loadable publication, accepts the legacy `input`, and builds the run message from the template.
- Enhancement shows the ancestor SKILL.md without the inputs block, passes the ancestor's fields, and accepts a seed run with `inputs`.

Conductia:

- `parseSkillInputFields`, `normalizeVersion` and `normalizeLineageEntry` handle a present list, a missing key and an invalid list.
- The stream route forwards `{ inputs, instructions }` plus the transitional `input`, and passes a bench `422` through.
- The record POST stores `inputs`, accepts a null `input`, and its replay check distinguishes runs that differ only in `inputs`.
- `readSeedRun` returns `inputs`.
- The replaced `skill_authoring_browser_candidate` returns `inputs`, and `[]` for an old candidate.
- Component tests for each control type, required gating, whole-object autosave, version switching that keeps shared values, `422` mapping, the candidate preview Inputs list, and the history display.

Browser end to end, on the local stack only, with programmatic sign-in of a seeded user and the bench stubbed as in the existing hermetic tier: build a skill with two fields, save it to the rail, fill the form, run it, and see the history row show the values.

Not verified by this work: a real streamed run against a live bench with billed model calls. The pull requests say so.
