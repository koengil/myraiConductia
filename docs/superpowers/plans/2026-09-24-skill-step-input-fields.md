# Skill Step Input Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skills built in the skill builder declare typed input fields, and every skill-backed rail step run by `SkillStepRunner` renders those fields as a form and sends the values to the skill as named, validated inputs.

**Architecture:** Fields live in each skill version's SKILL.md frontmatter (`metadata.rtslabs.inputs`), so the content digest pins them. Ignatious parses them, reports them per version in the catalog versions listing and the publication lineage, and validates run values before any spend. Conductia never stores field lists: it reads them per version, renders a form, keeps values in the step's `work`, and sends `{ inputs, instructions }` for the version it rendered.

**Tech Stack:** Ignatious: TypeScript, Zod 4, Hono, Mastra, `yaml`, Vitest, pnpm workspace under `platform/`. Conductia: Next.js 16 App Router, TypeScript, Supabase (Postgres), Tailwind 4 tokens, Vitest + RTL, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-skill-step-input-fields-design.md` (Conductia repo). Read it before starting any task.

## Global Constraints

- Two repositories. Ignatious tasks (I1 to I6) run in an Ignatious worktree on branch `skill-step-input-fields` created from `origin/main` (the local `main` checkout is stale). Conductia tasks (C1 to C9) run on the current branch `create-steps-with-more-inputs` in `/Users/cwillian/orca/workspaces/conductia/create-steps-with-more-inputs`.
- Ignatious ships first. Conductia must keep sending the legacy `input` string for one release (C2).
- Field types: `string | textarea | number | date | enum | boolean`. `boolean` is accepted for existing skills only; the builder is never told to use it. `string` and `textarea` validate identically.
- Caps: at most 12 fields per skill, at most 20 `values` per `enum`, `label` at most 60 characters, `description` at most 300 characters, `instructions` at most 20,000 characters.
- `date` values are ISO calendar dates `YYYY-MM-DD` that exist.
- Field `name`: camelCase, `^[a-z][A-Za-z0-9]*$`, unique within a skill.
- Bench validation failure: HTTP 422, `apiError('validation', ..., { detail: { problems: [{ name, message }] } })`. No new error code.
- Run message template (bench), each block omitted when empty; a run with neither sends `Run this skill on the deal's current information.`:
  ```
  Inputs:
  - <label>: <value>

  Additional instructions:
  <instructions>
  ```
- No code comments in either repository, including JSDoc and "why" comments, even where surrounding code has them. Test files keep existing Arrange/Act markers only where a file already uses them.
- Visible copy: statements, no em-dashes. Labels: "Additional instructions", "No inputs. Runs on deal context and instructions.", kind names "Short text", "Long text", "Number", "Date", "Choice".
- MD Briefing, Teaser and Presearch runners are not touched.
- Environment safety: never run anything against a hosted Supabase project or a hosted Ignatious service. Before any command that talks to a database, confirm the configured URL is `localhost` or `127.0.0.1`; if not, stop. `supabase db reset` only against the local stack, and say so before running it. Pass this constraint verbatim to every subagent.
- Stage explicit file paths only; never `git add -A` or `git add .`.
- Implementer subagents run on Sonnet 5.
- Before any push, run the CI jobs locally and get them green: Conductia `npm run lint`, `npm run check:migrations`, `npx tsc --noEmit`, `npm test`, `npm run build`, the schema snapshot check, `npm run test:integration` against the local stack, `npm run test:e2e`. Ignatious from `platform/`: `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.

## Review Focus

1. A step whose saved `work.inputs` holds a key the running version no longer declares (after switching version or enhancing). Expected: the form ignores it and the run does not send it, so the bench never answers "not declared". Pinned in C1 (`collectRunInputs` drops undeclared keys) and C7 (switching version keeps shared values only).
2. A `number` field left empty, or holding text the browser accepted like `1e3` or `-`. Expected: empty is "no value" (dropped, and blocks Draft only if required); a non-finite parse is never sent as `NaN`. Pinned in C1 (`coerceFieldValue`).
3. An old step created before this change, whose only input is `work.primary`. Expected: it opens with that text in Additional instructions, runs without any field, and its history still shows the old input. Pinned in C7 and C9.
4. An enhancement agent that copies the ancestor's `metadata` block into its new SKILL.md. Expected: the candidate tool rejects the call instead of producing a package with two field lists or none. Pinned in I5 and I6.
5. A bench `422` with a problem whose `name` is not a rendered field (for example `null`, or a field of another version). Expected: shown above the Draft button, never dropped silently. Pinned in C7.

---

## Ignatious

### Task I0: Worktree

- [ ] **Step 1: Create the worktree from the remote tip**

```bash
cd /Users/cwillian/Documents/personal/learning/ignatious
git fetch origin
git worktree add ../ignatious-skill-step-inputs -b skill-step-input-fields origin/main
cd ../ignatious-skill-step-inputs/platform
pnpm install --frozen-lockfile
pnpm test --filter @ignatious/skill-runtime --filter @ignatious/skill-bench
```

Expected: install succeeds and the baseline suites pass. Every Ignatious path below is relative to `/Users/cwillian/Documents/personal/learning/ignatious-skill-step-inputs/platform`.

### Task I1: Runtime input schema and a list-based validator

**Files:**
- Modify: `packages/skill-runtime/src/types.ts` (`ManifestInput`, around line 94)
- Modify: `packages/skill-runtime/src/manifest.ts` (`ManifestInputSchema`, around line 147; `RawManifestSchema` key `rtslabs.inputs`, around line 253)
- Modify: `packages/skill-runtime/src/execute.ts` (`typeProblem`, `validateSkillInputs`, around lines 561 to 657)
- Modify: `packages/skill-runtime/src/index.ts` (exports)
- Modify: `apps/conductia-prototype/web/src/lead/SkillPicker.tsx` (field control, around lines 75 to 100)
- Test: `packages/skill-runtime/src/manifest.test.ts`, `packages/skill-runtime/src/execute.test.ts`

**Interfaces:**
- Produces:
  - `interface ManifestInput { name: string; type: 'string' | 'textarea' | 'number' | 'date' | 'enum' | 'boolean'; label?: string; description?: string; values?: readonly string[]; required?: boolean; default?: string | number | boolean }`
  - `export const ManifestInputSchema` and `export const ManifestInputsSchema` (array, max 12, unique names) from `@ignatious/skill-runtime`
  - `export interface InputProblem { readonly name: string | null; readonly message: string }`
  - `export function validateInputs(declared: readonly ManifestInput[], provided: Record<string, unknown>): { ok: true; values: Record<string, SkillInputValue> } | { ok: false; problems: readonly InputProblem[] }`
  - `validateSkillInputs(skill, provided)` unchanged in signature and messages.

- [ ] **Step 1: Write the failing schema tests** in `manifest.test.ts`

```ts
import { ManifestInputsSchema } from './manifest.js';

describe('ManifestInputsSchema', () => {
  it('accepts textarea and date fields with labels and descriptions', () => {
    const parsed = ManifestInputsSchema.parse([
      { name: 'notes', type: 'textarea', label: 'Notes', description: 'Anything else' },
      { name: 'asOf', type: 'date', required: true },
    ]);
    expect(parsed).toEqual([
      { name: 'notes', type: 'textarea', label: 'Notes', description: 'Anything else' },
      { name: 'asOf', type: 'date', required: true },
    ]);
  });

  it('refuses more than twelve fields', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `f${i}`, type: 'string' }));
    expect(ManifestInputsSchema.safeParse(many).success).toBe(false);
  });

  it('refuses duplicate names', () => {
    const dup = [
      { name: 'a', type: 'string' },
      { name: 'a', type: 'number' },
    ];
    expect(ManifestInputsSchema.safeParse(dup).success).toBe(false);
  });

  it('refuses a label over sixty characters', () => {
    expect(
      ManifestInputsSchema.safeParse([{ name: 'a', type: 'string', label: 'x'.repeat(61) }]).success,
    ).toBe(false);
  });

  it('refuses an enum with more than twenty values or none', () => {
    const values = Array.from({ length: 21 }, (_, i) => `v${i}`);
    expect(ManifestInputsSchema.safeParse([{ name: 'a', type: 'enum', values }]).success).toBe(false);
    expect(ManifestInputsSchema.safeParse([{ name: 'a', type: 'enum' }]).success).toBe(false);
  });

  it('refuses a name that is not camelCase', () => {
    expect(ManifestInputsSchema.safeParse([{ name: 'Meeting type', type: 'string' }]).success).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing validator tests** in `execute.test.ts`

```ts
import { validateInputs } from './execute.js';

describe('validateInputs', () => {
  const declared = [
    { name: 'asOf', type: 'date' as const, required: true },
    { name: 'notes', type: 'textarea' as const },
    { name: 'audience', type: 'enum' as const, values: ['Board', 'Buyer'], default: 'Board' },
  ];

  it('accepts a real date and fills the enum default', () => {
    expect(validateInputs(declared, { asOf: '2026-02-28', notes: 'hi' })).toEqual({
      ok: true,
      values: { asOf: '2026-02-28', notes: 'hi', audience: 'Board' },
    });
  });

  it('refuses an impossible date, naming the field', () => {
    const result = validateInputs(declared, { asOf: '2026-02-30' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toEqual([
      { name: 'asOf', message: 'expected a date as YYYY-MM-DD, got "2026-02-30"' },
    ]);
  });

  it('names an undeclared input and a missing required one', () => {
    const result = validateInputs(declared, { stray: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContainEqual({
        name: 'stray',
        message: 'not declared by this skill, expected one of asOf, notes, audience',
      });
      expect(result.problems).toContainEqual({
        name: 'asOf',
        message: 'required, and no value was supplied',
      });
    }
  });

  it('treats textarea like string', () => {
    const result = validateInputs(declared, { asOf: '2026-01-01', notes: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toEqual([{ name: 'notes', message: 'expected a string, got number' }]);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm --filter @ignatious/skill-runtime exec vitest run src/manifest.test.ts src/execute.test.ts`
Expected: FAIL, `ManifestInputsSchema` and `validateInputs` are not exported.

- [ ] **Step 4: Widen the type** in `types.ts`

```ts
export interface ManifestInput {
  readonly name: string;
  readonly type: 'string' | 'textarea' | 'number' | 'date' | 'enum' | 'boolean';
  readonly label?: string;
  readonly description?: string;
  readonly values?: readonly string[];
  readonly required?: boolean;
  readonly default?: string | number | boolean;
}
```

- [ ] **Step 5: Replace the schema** in `manifest.ts`

```ts
export const MAX_MANIFEST_INPUTS = 12;

export const ManifestInputSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
    type: z.enum(['string', 'textarea', 'number', 'date', 'enum', 'boolean']),
    label: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    values: z.array(nonEmptyString).max(20).optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .refine(raw => raw.type !== 'enum' || (raw.values !== undefined && raw.values.length > 0), {
    message: 'an enum input must list its values, otherwise nothing can satisfy it',
  })
  .transform((raw): ManifestInput => ({
    name: raw.name,
    type: raw.type,
    ...(raw.label === undefined ? {} : { label: raw.label }),
    ...(raw.description === undefined ? {} : { description: raw.description }),
    ...(raw.values === undefined ? {} : { values: raw.values }),
    ...(raw.required === undefined ? {} : { required: raw.required }),
    ...(raw.default === undefined ? {} : { default: raw.default }),
  }));

export const ManifestInputsSchema = z
  .array(ManifestInputSchema)
  .max(MAX_MANIFEST_INPUTS)
  .refine(inputs => new Set(inputs.map(input => input.name)).size === inputs.length, {
    message: 'input names must be unique',
  });
```

In `RawManifestSchema`, change `'rtslabs.inputs': z.array(ManifestInputSchema).optional()` to `'rtslabs.inputs': ManifestInputsSchema.optional()`.

- [ ] **Step 6: Split the validator** in `execute.ts`

Add the `date` and `textarea` cases to `typeProblem`:

```ts
    case 'string':
    case 'textarea':
      return typeof value === 'string' ? null : `expected a string, got ${typeName(value)}`;
    case 'date':
      return isIsoDate(value)
        ? null
        : `expected a date as YYYY-MM-DD, got ${typeof value === 'string' ? JSON.stringify(value) : typeName(value)}`;
```

```ts
function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
```

Replace the body of `validateSkillInputs` with a delegation, and add `validateInputs` holding the existing four rules. Keep every existing message text; the problem's `message` is the part after `name: `.

```ts
export interface InputProblem {
  readonly name: string | null;
  readonly message: string;
}

export function validateInputs(
  declaredInputs: readonly ManifestInput[],
  provided: Record<string, unknown>,
):
  | { readonly ok: true; readonly values: Record<string, SkillInputValue> }
  | { readonly ok: false; readonly problems: readonly InputProblem[] } {
  const declared = new Map(declaredInputs.map(input => [input.name, input]));
  const problems: InputProblem[] = [];
  const resolved: Record<string, SkillInputValue> = {};

  for (const name of Object.keys(provided)) {
    if (declared.has(name)) continue;
    problems.push({
      name,
      message: `not declared by this skill, expected ${
        declared.size === 0 ? 'no inputs at all' : `one of ${[...declared.keys()].join(', ')}`
      }`,
    });
  }

  for (const input of declaredInputs) {
    if (input.default !== undefined) {
      const bad = typeProblem(input, input.default);
      if (bad !== null)
        problems.push({ name: input.name, message: `the manifest's own default is invalid, ${bad}` });
    }
    const supplied = Object.prototype.hasOwnProperty.call(provided, input.name)
      ? provided[input.name]
      : undefined;
    if (supplied === undefined) {
      if (input.default !== undefined) resolved[input.name] = input.default;
      else if (input.required === true)
        problems.push({ name: input.name, message: 'required, and no value was supplied' });
      continue;
    }
    const bad = typeProblem(input, supplied);
    if (bad === null) resolved[input.name] = supplied as SkillInputValue;
    else problems.push({ name: input.name, message: bad });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, values: resolved };
}

export function validateSkillInputs(
  skill: ValidatedSkill,
  provided: Record<string, unknown>,
): Record<string, SkillInputValue> {
  const result = validateInputs(skill.manifest.inputs, provided);
  if (!result.ok) {
    throw new SkillInputError(
      skill.name,
      result.problems.map(problem =>
        problem.name === null ? problem.message : `${problem.name}: ${problem.message}`,
      ),
    );
  }
  return result.values;
}
```

Delete the old doc comment above `validateSkillInputs` along with the old body.

- [ ] **Step 7: Export** from `index.ts`: add `ManifestInputSchema`, `ManifestInputsSchema`, `MAX_MANIFEST_INPUTS` to the `./manifest.js` export list, and `validateInputs`, `type InputProblem` to the `./execute.js` export list.

- [ ] **Step 8: Render the new types in the prototype** `SkillPicker.tsx`: in the final `else` branch, render a `<textarea>` when `input.type === 'textarea'`, and set the `<input>` `type` to `'number'` for `number`, `'date'` for `date`, otherwise `'text'`. Use `input.label ?? humanizeInputName(input.name)` for the label.

- [ ] **Step 9: Run the runtime and prototype suites**

Run: `pnpm --filter @ignatious/skill-runtime test && pnpm --filter @ignatious/conductia-prototype test && pnpm run typecheck`
Expected: PASS, including every pre-existing md-briefing and presearch validation test with unchanged messages.

- [ ] **Step 10: Commit**

```bash
git add packages/skill-runtime/src/types.ts packages/skill-runtime/src/manifest.ts packages/skill-runtime/src/execute.ts packages/skill-runtime/src/index.ts packages/skill-runtime/src/manifest.test.ts packages/skill-runtime/src/execute.test.ts apps/conductia-prototype/web/src/lead/SkillPicker.tsx
git commit -m "feat(skill-runtime): textarea and date inputs, labels, caps, list-based validator"
```

### Task I2: Bench frontmatter, skill store and catalog version records carry inputs

**Files:**
- Modify: `apps/skill-bench/src/frontmatter.ts` (`Frontmatter`, `readFrontmatter`, `statusOf`)
- Modify: `apps/skill-bench/src/skill-store.ts` (`Skill` type near line 196; `skillFor` near line 912; the two `mintVersion` calls near lines 1324 and 1436)
- Modify: `apps/skill-bench/src/versions.ts` (`VersionRecord`, `readVersion`)
- Modify: `apps/skill-bench/src/skills.ts` (`MountedSkill`, `mountedSkills`)
- Test: `apps/skill-bench/src/frontmatter.test.ts`, `apps/skill-bench/src/versions.test.ts`

**Interfaces:**
- Consumes: `ManifestInputsSchema`, `ManifestInput` from `@ignatious/skill-runtime` (I1).
- Produces:
  - `Frontmatter.inputs: readonly ManifestInput[]` and `Frontmatter.inputsError: string | null`
  - `Skill.inputs`, `MountedSkill.inputs`, `VersionRecord.inputs`, all `readonly ManifestInput[]`
  - `GET /skills/:name/versions` rows include `inputs` (the route spreads the record; no route change).

- [ ] **Step 1: Write the failing frontmatter tests** in `frontmatter.test.ts`

```ts
const WITH_INPUTS = [
  '---',
  'name: weekly-update',
  'description: Weekly update.',
  'metadata:',
  '  rtslabs.inputs:',
  '    - { name: meetingType, type: enum, values: [first_call, closing] }',
  '    - { name: attendees, type: string, required: false }',
  '---',
  'Body.',
].join('\n');

it('reads inputs declared in the inline flow format', () => {
  const frontmatter = readFrontmatter(WITH_INPUTS);
  expect(frontmatter.inputs).toEqual([
    { name: 'meetingType', type: 'enum', values: ['first_call', 'closing'] },
    { name: 'attendees', type: 'string', required: false },
  ]);
  expect(statusOf(frontmatter, 'weekly-update')).toEqual({ status: 'ok', reason: null });
});

it('reads no inputs from a skill that declares none', () => {
  expect(readFrontmatter('---\nname: a\ndescription: b\n---\n').inputs).toEqual([]);
});

it('keeps max-model parsing unchanged', () => {
  expect(readFrontmatter('---\nname: a\ndescription: b\nmax-model: sonnet\n---\n').maxModel).toBe('sonnet');
});

it('marks an invalid declaration not loadable with the reason', () => {
  const text = '---\nname: a\ndescription: b\nmetadata:\n  rtslabs.inputs:\n    - { name: x, type: enum }\n---\n';
  const status = statusOf(readFrontmatter(text), 'a');
  expect(status.status).toBe('not_loadable');
  expect(status.reason).toMatch(/^declared inputs are invalid: /);
});
```

Check the alias: if `sonnet` is not a valid `ModelAlias`, use the first value of `MODEL_ALIASES` from `model-choice.ts`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/frontmatter.test.ts`
Expected: FAIL, `inputs` is undefined.

- [ ] **Step 3: Implement** in `frontmatter.ts`

Add to `Frontmatter`:

```ts
  readonly inputs: readonly ManifestInput[];
  readonly inputsError: string | null;
```

Replace `frontmatterParses` with a function that returns the parsed document:

```ts
function parseBlock(block: string): { readonly valid: boolean; readonly document: unknown } {
  try {
    return { valid: true, document: parseYaml(block) };
  } catch {
    return { valid: false, document: null };
  }
}

function declaredInputs(document: unknown): {
  readonly inputs: readonly ManifestInput[];
  readonly inputsError: string | null;
} {
  const metadata =
    document !== null && typeof document === 'object'
      ? (document as Record<string, unknown>)['metadata']
      : undefined;
  const raw =
    metadata !== null && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>)['rtslabs.inputs']
      : undefined;
  if (raw === undefined) return { inputs: [], inputsError: null };
  const parsed = ManifestInputsSchema.safeParse(raw);
  return parsed.success
    ? { inputs: parsed.data, inputsError: null }
    : { inputs: [], inputsError: parsed.error.issues.map(issue => issue.message).join('; ') };
}
```

In the closing-`---` branch of `readFrontmatter`:

```ts
      const block = parseBlock(lines.slice(1, index).join('\n'));
      return {
        present: true,
        name,
        description,
        maxModel,
        valid: block.valid,
        ...declaredInputs(block.document),
      };
```

Both early `present: false` returns add `inputs: [], inputsError: null`. In `statusOf`, after the `!frontmatter.valid` check and before the name/folder check:

```ts
  if (frontmatter.inputsError !== null) {
    return { status: 'not_loadable', reason: `declared inputs are invalid: ${frontmatter.inputsError}` };
  }
```

Import `ManifestInputsSchema` and `type ManifestInput` from `@ignatious/skill-runtime`.

- [ ] **Step 4: Carry inputs through the store and mount**
  - `skill-store.ts`: add `readonly inputs: readonly ManifestInput[];` to `Skill`; in `skillFor` add `inputs: frontmatter.inputs,`; in both `mintVersion` record literals add `inputs: staged.inputs,` and `inputs: seeded.inputs,` respectively. Find any other object literal typed `Skill` with `pnpm run typecheck` and add `inputs: []` where there is no frontmatter (for example the literal near `server.ts:1587`).
  - `versions.ts`: add `readonly inputs: readonly ManifestInput[];` to `VersionRecord`; in `readVersion` add:

```ts
    inputs: ManifestInputsSchema.safeParse(raw['inputs']).data ?? [],
```

  - `skills.ts`: add `readonly inputs: readonly ManifestInput[];` to `MountedSkill` and `inputs: skill.inputs,` in `mountedSkills`.

- [ ] **Step 5: Write the failing version test** in `versions.test.ts`: mint a version whose record carries `inputs: [{ name: 'asOf', type: 'date' }]`, then assert `readVersion(...)?.inputs` equals it; write a record JSON without `inputs` and assert it reads as `[]`.

- [ ] **Step 6: Run the bench suite and typecheck**

Run: `pnpm --filter @ignatious/skill-bench test && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/skill-bench/src/frontmatter.ts apps/skill-bench/src/frontmatter.test.ts apps/skill-bench/src/skill-store.ts apps/skill-bench/src/versions.ts apps/skill-bench/src/versions.test.ts apps/skill-bench/src/skills.ts
git commit -m "feat(skill-bench): read declared inputs from frontmatter into skills and version records"
```

Add any other file the typecheck step touched, by explicit path.

### Task I3: Publication lineage reports each version's inputs

**Files:**
- Modify: `apps/skill-bench/src/authoring/execution/ancestor.ts` (extract the SKILL.md reader)
- Modify: `apps/skill-bench/src/authoring/publication/store.ts` (`LineageEntry`)
- Modify: `apps/skill-bench/src/authoring/publication/postgres-publication-store.ts` (`LineageRow`, `selectLineageSql`, `lineageEntryFrom`)
- Test: `apps/skill-bench/src/authoring/publication/postgres-publication-store.test.ts` (or the existing lineage test file; find it with `git grep -l readPublicationLineage -- '*.test.ts'`)

**Interfaces:**
- Consumes: `readFrontmatter` (I2).
- Produces: `export function skillMdFromPackage(packageBytes: Buffer): string | null` in `ancestor.ts`; `LineageEntry.inputs: readonly ManifestInput[]`. `GET /skills/:skillId/lineage` already returns `{ lineage }`, so entries gain `inputs` with no route change.

- [ ] **Step 1: Write the failing test**: store a publication whose package SKILL.md declares `rtslabs.inputs: [{ name: asOf, type: date }]`, call `readPublicationLineage`, expect the entry's `inputs` to be `[{ name: 'asOf', type: 'date' }]`; a publication without a declaration yields `[]`. Build packages with the same helper the existing lineage tests use.

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/publication`
Expected: FAIL, `inputs` undefined.

- [ ] **Step 3: Extract the reader** in `ancestor.ts`

```ts
export function skillMdFromPackage(packageBytes: Buffer): string | null {
  try {
    const files = readPackage(packageBytes);
    const prefix = skillPrefix(files);
    const skillMd = files.find(file => file.path === `${prefix}SKILL.md`);
    return skillMd === undefined ? null : Buffer.from(skillMd.bytes).toString('utf8');
  } catch {
    return null;
  }
}
```

Use it inside `ancestorFromPackageBytes` for the `skillMdText` field.

- [ ] **Step 4: Return inputs from the lineage query**
  - `store.ts`: `LineageEntry` gains `readonly inputs: readonly ManifestInput[];`.
  - `postgres-publication-store.ts`: `LineageRow` gains `readonly package_bytes: Buffer;`; `selectLineageSql` selects `version_id, digest, published_at, package_bytes`; `lineageEntryFrom` adds:

```ts
    inputs: readFrontmatter(skillMdFromPackage(Buffer.from(row.package_bytes)) ?? '').inputs,
```

  Any in-memory `PublicationStore` used by tests must return `inputs` too; `pnpm run typecheck` finds it.

- [ ] **Step 5: Run the suite**

Run: `pnpm --filter @ignatious/skill-bench test && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/skill-bench/src/authoring/execution/ancestor.ts apps/skill-bench/src/authoring/publication/store.ts apps/skill-bench/src/authoring/publication/postgres-publication-store.ts <the lineage test file>
git commit -m "feat(skill-bench): report each published version's declared inputs in the lineage"
```

### Task I4: Execution route accepts inputs and instructions

**Files:**
- Create: `apps/skill-bench/src/authoring/execution/run-message.ts` (a pure message builder, split out so the template is testable without a stream)
- Modify: `apps/skill-bench/src/authoring/execution/execution-route.ts`
- Test: `apps/skill-bench/src/authoring/execution/run-message.test.ts`, `apps/skill-bench/src/authoring/execution/execution-route.test.ts`

**Interfaces:**
- Consumes: `validateInputs`, `ManifestInput`, `SkillInputValue` (I1); `MountedSkill.inputs` (I2).
- Produces:
  - `export function buildRunMessage(declared: readonly ManifestInput[], values: Readonly<Record<string, SkillInputValue>>, instructions: string | null): string`
  - Request body: `{ runId, skill, inputs?: Record<string, string | number | boolean>, instructions?: string | null, input?: string, tenantId, leadId, token?, conductiaBaseUrl?, model? }`
  - 422 body: `{ error: { code: 'validation', message, detail: { problems: [{ name: string | null, message: string }] } } }`

- [ ] **Step 1: Write the failing message tests** in `run-message.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { buildRunMessage } from './run-message.js';

const declared = [
  { name: 'asOf', type: 'date' as const, label: 'As of' },
  { name: 'audience', type: 'enum' as const, values: ['Board'] },
];

describe('buildRunMessage', () => {
  it('lists inputs by label in declared order, then the instructions', () => {
    expect(buildRunMessage(declared, { audience: 'Board', asOf: '2026-09-30' }, 'Keep it short')).toBe(
      'Inputs:\n- As of: 2026-09-30\n- audience: Board\n\nAdditional instructions:\nKeep it short',
    );
  });

  it('omits an empty block', () => {
    expect(buildRunMessage(declared, {}, 'Only this')).toBe('Additional instructions:\nOnly this');
    expect(buildRunMessage(declared, { asOf: '2026-09-30' }, null)).toBe('Inputs:\n- As of: 2026-09-30');
  });

  it('asks for a run on deal context when there is nothing', () => {
    expect(buildRunMessage([], {}, '  ')).toBe("Run this skill on the deal's current information.");
  });
});
```

- [ ] **Step 2: Implement** `run-message.ts`

```ts
import type { ManifestInput, SkillInputValue } from '@ignatious/skill-runtime';

export const EMPTY_RUN_MESSAGE = "Run this skill on the deal's current information.";

export function buildRunMessage(
  declared: readonly ManifestInput[],
  values: Readonly<Record<string, SkillInputValue>>,
  instructions: string | null,
): string {
  const lines = declared
    .filter(input => values[input.name] !== undefined)
    .map(input => `- ${input.label ?? input.name}: ${String(values[input.name])}`);
  const blocks: string[] = [];
  if (lines.length > 0) blocks.push(['Inputs:', ...lines].join('\n'));
  const trimmed = instructions?.trim() ?? '';
  if (trimmed !== '') blocks.push(`Additional instructions:\n${trimmed}`);
  return blocks.length === 0 ? EMPTY_RUN_MESSAGE : blocks.join('\n\n');
}
```

- [ ] **Step 3: Write the failing route tests** in `execution-route.test.ts`, following the existing fixtures in that file (fake `runTurn` capturing its `message`, a published package fixture). Four cases:
  1. A publication declaring `asOf: date required` and a request with `inputs: {}` answers 422 with `body.error.code === 'validation'` and `body.error.detail.problems` equal to `[{ name: 'asOf', message: 'required, and no value was supplied' }]`, and `runTurn` is never called.
  2. The same publication with `inputs: { asOf: '2026-09-30' }, instructions: 'Short'` calls `runTurn` with `message === 'Inputs:\n- asOf: 2026-09-30\n\nAdditional instructions:\nShort'`.
  3. A skill declaring nothing, with legacy `input: 'Do it'` and no `instructions`, calls `runTurn` with `message === 'Additional instructions:\nDo it'`.
  4. A package whose SKILL.md declares an invalid inputs block (`- { name: x, type: enum }`) answers 404 `not_found` and never calls `runTurn`.

- [ ] **Step 4: Run to see them fail**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/execution`
Expected: FAIL.

- [ ] **Step 5: Change the request schema** in `execution-route.ts`

```ts
const InputValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const SkillRunRequestSchema = z
  .object({
    runId: UuidSchema,
    skill: SkillReferenceSchema,
    inputs: z.record(z.string(), InputValueSchema).default({}),
    instructions: z.string().max(20_000).nullable().optional(),
    input: z.string().max(20_000).optional(),
    tenantId: z.string().min(1),
    leadId: z.string().min(1),
    token: z.string().nullable().optional(),
    conductiaBaseUrl: z.string().nullable().optional(),
    model: z.enum(MODEL_ALIASES).nullable().optional(),
  })
  .strict();
```

- [ ] **Step 6: Validate after the package is opened.** Replace the block from `const declared = mountedSkills(...)` down to the `runTurn` call's `message` so that:

```ts
    const declared = mountedSkills(
      { ...deps.config, skillsRoot: opened.directory, skillsBase: opened.directory },
      'execution',
    ).skills.find(skill => skill.name === opened.skillName);
    if (declared === undefined) {
      await closeRunRoot(opened.directory).catch(() => undefined);
      return fail(c, 'not_found', 'that skill version does not load');
    }

    const checked = validateInputs(declared.inputs, request.inputs);
    if (!checked.ok) {
      await closeRunRoot(opened.directory).catch(() => undefined);
      return c.json(
        apiError('validation', 'the inputs do not satisfy this skill', {
          detail: { problems: checked.problems },
        }),
        422,
      );
    }
    const instructions = request.instructions ?? request.input ?? null;
    const message = buildRunMessage(declared.inputs, checked.values, instructions);

    const asked = request.model ?? aliasOfModelId(deps.config.model);
    const clamped = clampModel(asked, declared.maxModel);
```

and pass `message` to `runTurn` instead of `request.input`. Import `validateInputs` from `@ignatious/skill-runtime` and `buildRunMessage` from `./run-message.js`. Delete the explanatory block comment the old code had above the ceiling read.

- [ ] **Step 7: Run the suite**

Run: `pnpm --filter @ignatious/skill-bench test && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/skill-bench/src/authoring/execution/run-message.ts apps/skill-bench/src/authoring/execution/run-message.test.ts apps/skill-bench/src/authoring/execution/execution-route.ts apps/skill-bench/src/authoring/execution/execution-route.test.ts
git commit -m "feat(skill-bench): run a skill with validated named inputs and instructions"
```

### Task I5: The builder proposes inputs and the package declares them

**Files:**
- Modify: `apps/skill-bench/src/authoring/candidate-tool.ts` (`SKILL_MD_RULE`, `InputSchema`, tool description)
- Modify: `apps/skill-bench/src/authoring/candidate-package.ts` (`PrivateCandidateInput`, `PrivateCandidate`, `validateInput`, `writePackage` call, `candidateFor`)
- Modify: `apps/skill-bench/src/authoring/generator.ts` (`candidatePayload`)
- Modify: `apps/skill-bench/src/authoring/turn-lines.ts` (`CandidatePreview`)
- Modify: `apps/skill-bench/src/authoring/turn-route.ts` (`PreviewSchema`)
- Test: `apps/skill-bench/src/authoring/candidate-package.test.ts`, `apps/skill-bench/src/authoring/candidate-tool.test.ts`, `apps/skill-bench/src/authoring/turn-route.test.ts`

**Interfaces:**
- Consumes: `ManifestInputsSchema`, `ManifestInput` (I1); `readFrontmatter` (I2).
- Produces:
  - `export function withDeclaredInputs(skillMdText: string, inputs: readonly ManifestInput[]): string`
  - `PrivateCandidateInput.inputs`, `PrivateCandidate.inputs`, `CandidatePreview.inputs`, all `readonly ManifestInput[]`
  - Turn stream `candidate` line `preview.inputs`; `currentCandidate.inputs` accepted on the turn request (optional, default `[]`).

- [ ] **Step 1: Write the failing package tests** in `candidate-package.test.ts`

```ts
it('writes declared inputs into the SKILL.md frontmatter', () => {
  const text = withDeclaredInputs('---\nname: a\ndescription: b\n---\nBody\n', [
    { name: 'asOf', type: 'date', label: 'As of', required: true },
  ]);
  expect(readFrontmatter(text).inputs).toEqual([{ name: 'asOf', type: 'date', label: 'As of', required: true }]);
  expect(text.endsWith('---\nBody\n')).toBe(true);
});

it('leaves the SKILL.md untouched when there are no inputs', () => {
  const original = '---\nname: a\ndescription: b\n---\nBody\n';
  expect(withDeclaredInputs(original, [])).toBe(original);
});

it('produces the same digest for the same inputs', async () => {
  const first = await prepareWith({ inputs: [{ name: 'asOf', type: 'date' }] });
  const second = await prepareWith({ inputs: [{ name: 'asOf', type: 'date' }], providerCandidateId: OTHER_ID });
  expect(first.digest).toBe(second.digest);
});

it('rejects a SKILL.md that writes its own metadata', async () => {
  await expect(
    prepareWith({ skillMdText: '---\nname: a\ndescription: b\nmetadata:\n  x: 1\n---\n' }),
  ).rejects.toThrow('the platform writes metadata; leave it out of SKILL.md');
});
```

`prepareWith` is a local helper calling `preparePrivateCandidate(store).prepareCandidate({...defaults, ...overrides})` with the in-memory store the existing tests use.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring/candidate-package.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `candidate-package.ts`

```ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ManifestInputsSchema, type ManifestInput } from '@ignatious/skill-runtime';

export function withDeclaredInputs(skillMdText: string, inputs: readonly ManifestInput[]): string {
  if (inputs.length === 0) return skillMdText;
  const lines = skillMdText.replace(/^﻿/, '').split('\n');
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close < 0) throw new CandidateRejected('candidate SKILL.md has no closing frontmatter line');
  const block = stringifyYaml({ metadata: { 'rtslabs.inputs': inputs } }).trimEnd();
  return [...lines.slice(0, close), block, ...lines.slice(close)].join('\n');
}

function writesOwnMetadata(skillMdText: string): boolean {
  const lines = skillMdText.replace(/^﻿/, '').split(/\r?\n/);
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close < 0) return false;
  try {
    const document = parseYaml(lines.slice(1, close).join('\n')) as unknown;
    return document !== null && typeof document === 'object' && 'metadata' in document;
  } catch {
    return false;
  }
}
```

- `PrivateCandidateInput` and `PrivateCandidate` gain `readonly inputs: readonly ManifestInput[];`.
- `validateInput`: before the `statusOf` check, add `if (writesOwnMetadata(input.skillMdText)) throw new CandidateRejected('the platform writes metadata; leave it out of SKILL.md');` and `if (!ManifestInputsSchema.safeParse(input.inputs).success) throw new CandidateRejected('declared inputs are invalid');`.
- `prepareCandidate`: call `writePackage(scratch, withDeclaredInputs(input.skillMdText, input.inputs), merged, references)`.
- `candidateFor`: add `inputs: input.inputs,`.
- `capabilityFingerprint` and `contentFingerprint` are unchanged.

- [ ] **Step 4: Add the tool argument** in `candidate-tool.ts`

```ts
export const SKILL_MD_RULE =
  'The whole SKILL.md. It opens with a YAML frontmatter block fenced by --- lines that carries ' +
  'exactly two keys, name and description. Never write a metadata key: the platform adds the ' +
  'declared inputs itself. The name must be byte-identical to the name argument. ' +
  'The block is parsed as strict YAML and is rejected if it does not parse, so any value ' +
  'containing a colon followed by a space has to be quoted or written as a folded block:\n' +
  '---\nname: data-room-gap-review\ndescription: >\n  Use when comparing a data room index ' +
  'against a buyer request list. Lists only the documents that are absent.\n---\n' +
  'The prose instructions follow the closing --- line.';

export const INPUTS_RULE =
  'The fields a banker fills in before each run, inferred from the conversation. Prefer few ' +
  'fields; ask nothing the deal data already answers. Each field has a camelCase name, a short ' +
  'label, an optional one-line description, and a type: string for a short answer, textarea for ' +
  'a paragraph, number, date (YYYY-MM-DD), or enum with the list of values when the answer is ' +
  'one of a small known set. Mark a field required only when the skill cannot run without it. ' +
  'At most 12 fields. Change the fields only when the banker asks. Use an empty list when the ' +
  'skill needs nothing but the deal and optional instructions.';
```

In `InputSchema` add `inputs: ManifestInputsSchema.describe(INPUTS_RULE),`. The destructuring in `execute` already spreads `...input` into `prepareCandidate`, so `inputs` flows through.

- [ ] **Step 5: Carry inputs in the preview**
  - `turn-lines.ts`: `CandidatePreview` gains `readonly inputs: readonly ManifestInput[];`.
  - `generator.ts` `candidatePayload`: `preview` gains `inputs: candidate.inputs,`.
  - `turn-route.ts` `PreviewSchema` gains `inputs: ManifestInputsSchema.default([]),`.

- [ ] **Step 6: Write the failing turn test** in `turn-route.test.ts`: a turn whose fake agent calls the candidate tool with `inputs: [{ name: 'asOf', type: 'date' }]` emits a `candidate` line whose `preview.inputs` equals that list; a turn request whose `currentCandidate` omits `inputs` is accepted (200, not 400).

- [ ] **Step 7: Run the suite**

Run: `pnpm --filter @ignatious/skill-bench test && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/skill-bench/src/authoring/candidate-tool.ts apps/skill-bench/src/authoring/candidate-package.ts apps/skill-bench/src/authoring/generator.ts apps/skill-bench/src/authoring/turn-lines.ts apps/skill-bench/src/authoring/turn-route.ts apps/skill-bench/src/authoring/candidate-package.test.ts apps/skill-bench/src/authoring/candidate-tool.test.ts apps/skill-bench/src/authoring/turn-route.test.ts
git commit -m "feat(skill-bench): the builder proposes typed inputs and the package declares them"
```

### Task I6: Enhancement sees the ancestor's inputs and the seed run's values

**Files:**
- Modify: `apps/skill-bench/src/authoring/generator.ts` (`SkillAncestor`, `AuthoringGenerateInput.seedRun`, `basisMessages`)
- Modify: `apps/skill-bench/src/authoring/execution/ancestor.ts` (`ancestorFromPackageBytes`)
- Modify: `apps/skill-bench/src/authoring/turn-route.ts` (`SeedRunSchema`)
- Test: `apps/skill-bench/src/authoring/generator.test.ts` (or wherever `basisMessages` is covered; find with `git grep -l "The skill as it stands" -- '*.test.ts'`)

**Interfaces:**
- Consumes: `withDeclaredInputs` is not used here; `readFrontmatter` (I2).
- Produces:
  - `SkillAncestor { skillMdText: string /* without the inputs block */; inputs: readonly ManifestInput[]; referenceFiles }`
  - `seedRun?: { input: string; inputs: Record<string, string | number | boolean>; output: string } | null`
  - `export function withoutDeclaredInputs(skillMdText: string): string` in `candidate-package.ts`

- [ ] **Step 1: Write the failing tests**
  1. `withoutDeclaredInputs(withDeclaredInputs(original, [{ name: 'asOf', type: 'date' }]))` returns `original` exactly.
  2. With an ancestor whose inputs are `[{ name: 'asOf', type: 'date', label: 'As of' }]`, the basis message contains `The skill as it stands:` followed by SKILL.md text containing no `metadata:` line, and contains `Its current inputs: [{"name":"asOf","type":"date","label":"As of"}]`.
  3. With `seedRun: { input: '', inputs: { asOf: '2026-09-30' }, output: 'x' }`, the message contains `Inputs:\n- asOf: 2026-09-30` and does not contain `Its input was not recorded.`
  4. The turn route accepts a `seedRun` without `inputs` (defaults to `{}`).

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @ignatious/skill-bench exec vitest run src/authoring`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `candidate-package.ts`:

```ts
export function withoutDeclaredInputs(skillMdText: string): string {
  const lines = skillMdText.split('\n');
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  const start = lines.findIndex((line, index) => index > 0 && index < close && line === 'metadata:');
  if (close < 0 || start < 0) return skillMdText;
  let end = start + 1;
  while (end < close && /^\s/.test(lines[end] ?? '')) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}
```

  - `ancestor.ts` `ancestorFromPackageBytes`: read `const text = ...` as today, then return `{ skillMdText: withoutDeclaredInputs(text), inputs: readFrontmatter(text).inputs, referenceFiles }`.
  - `generator.ts`: `SkillAncestor` gains `readonly inputs: readonly ManifestInput[];`. `seedRun` type becomes `{ readonly input: string; readonly inputs: Readonly<Record<string, string | number | boolean>>; readonly output: string }`. In `basisMessages`, after `The skill as it stands:` push `` `Its current inputs: ${JSON.stringify(ancestor.inputs)}. Pass them as the inputs argument unless the banker asks to change them.` ``. Build the stimulus from both halves:

```ts
    const values = Object.entries(seedRun.inputs);
    const stimulusParts = [
      ...(values.length > 0
        ? [['Inputs:', ...values.map(([name, value]) => `- ${name}: ${String(value)}`)].join('\n')]
        : []),
      ...(seedRun.input === '' ? [] : [`Instructions:\n${seedRun.input}`]),
    ];
    const stimulus =
      stimulusParts.length === 0 ? 'Its input was not recorded.' : stimulusParts.join('\n\n');
```

  - `turn-route.ts` `SeedRunSchema`: add `inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),`.

- [ ] **Step 4: Run the whole platform check**

Run: `pnpm run typecheck && pnpm run lint && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/skill-bench/src/authoring/candidate-package.ts apps/skill-bench/src/authoring/execution/ancestor.ts apps/skill-bench/src/authoring/generator.ts apps/skill-bench/src/authoring/turn-route.ts <the test files touched>
git commit -m "feat(skill-bench): enhancement carries the ancestor's inputs and the seed run's values"
```

---

## Conductia

All Conductia paths are relative to `/Users/cwillian/orca/workspaces/conductia/create-steps-with-more-inputs`.

### Task C1: The input field model

**Files:**
- Create: `src/lib/skillRun/inputs.ts` (one shared parser and value helpers; it is consumed by the bench client, the routes, the runner and the builder, so it cannot live in any one of them)
- Test: `tests/skill-run-inputs.test.ts`

**Interfaces:**
- Produces:

```ts
export type SkillInputType = "string" | "textarea" | "number" | "date" | "enum" | "boolean";
export type SkillInputValue = string | number | boolean;
export type SkillInputField = {
  name: string;
  label: string;
  description: string | null;
  type: SkillInputType;
  values: string[];
  required: boolean;
  default: SkillInputValue | null;
};
export type SkillInputValues = Record<string, SkillInputValue>;
export type InputProblem = { name: string | null; message: string };
export const MAX_INSTRUCTIONS = 20_000;
export function parseSkillInputFields(value: unknown): SkillInputField[];
export function parseInputValues(value: unknown): SkillInputValues | null;
export function coerceFieldValue(field: SkillInputField, raw: string | boolean): SkillInputValue | undefined;
export function collectRunInputs(fields: SkillInputField[], values: SkillInputValues): SkillInputValues;
export function missingRequired(fields: SkillInputField[], values: SkillInputValues): SkillInputField | null;
export function sameInputValues(a: SkillInputValues, b: SkillInputValues): boolean;
export function parseInputProblems(body: unknown): InputProblem[] | null;
```

- [ ] **Step 1: Write the failing tests** in `tests/skill-run-inputs.test.ts`

```ts
import { describe, expect, it } from "vitest";

import {
  coerceFieldValue,
  collectRunInputs,
  missingRequired,
  parseInputProblems,
  parseInputValues,
  parseSkillInputFields,
  sameInputValues,
  type SkillInputField,
} from "@/lib/skillRun/inputs";

const AS_OF: SkillInputField = {
  name: "asOf", label: "As of", description: null, type: "date", values: [], required: true, default: null,
};
const COUNT: SkillInputField = {
  name: "count", label: "count", description: null, type: "number", values: [], required: false, default: null,
};

describe("parseSkillInputFields", () => {
  it("normalizes a bench list and defaults the label to the name", () => {
    expect(parseSkillInputFields([{ name: "count", type: "number" }, { name: "asOf", type: "date", label: "As of", required: true }]))
      .toEqual([COUNT, AS_OF]);
  });
  it("reads a missing or invalid list as no fields", () => {
    expect(parseSkillInputFields(undefined)).toEqual([]);
    expect(parseSkillInputFields([{ name: "x", type: "enum" }])).toEqual([]);
    expect(parseSkillInputFields([{ name: "x", type: "file" }])).toEqual([]);
  });
});

describe("coerceFieldValue", () => {
  it("drops an empty or non-finite number instead of sending NaN", () => {
    expect(coerceFieldValue(COUNT, "")).toBeUndefined();
    expect(coerceFieldValue(COUNT, "-")).toBeUndefined();
    expect(coerceFieldValue(COUNT, "1e3")).toBe(1000);
  });
  it("drops a blank string", () => {
    expect(coerceFieldValue(AS_OF, "   ")).toBeUndefined();
  });
});

describe("collectRunInputs", () => {
  it("sends only declared, non-empty values", () => {
    expect(collectRunInputs([AS_OF], { asOf: "2026-09-30", stale: "x", })).toEqual({ asOf: "2026-09-30" });
  });
});

describe("missingRequired", () => {
  it("names the first required field without a value", () => {
    expect(missingRequired([COUNT, AS_OF], {})).toEqual(AS_OF);
    expect(missingRequired([COUNT, AS_OF], { asOf: "2026-09-30" })).toBeNull();
  });
});

describe("parseInputValues", () => {
  it("accepts scalars and refuses anything else", () => {
    expect(parseInputValues({ a: "x", b: 2, c: true })).toEqual({ a: "x", b: 2, c: true });
    expect(parseInputValues({ a: { nested: 1 } })).toBeNull();
    expect(parseInputValues("x")).toBeNull();
  });
});

describe("sameInputValues", () => {
  it("ignores key order", () => {
    expect(sameInputValues({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(true);
    expect(sameInputValues({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("parseInputProblems", () => {
  it("reads problems from a bench 422 envelope", () => {
    expect(parseInputProblems({ error: { code: "validation", detail: { problems: [{ name: "asOf", message: "required" }, { name: null, message: "x" }] } } }))
      .toEqual([{ name: "asOf", message: "required" }, { name: null, message: "x" }]);
    expect(parseInputProblems({ error: { code: "validation", detail: {} } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/skill-run-inputs.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/lib/skillRun/inputs.ts`

```ts
import { isRecord } from "@/lib/skillPublication/parse";

export type SkillInputType = "string" | "textarea" | "number" | "date" | "enum" | "boolean";
export type SkillInputValue = string | number | boolean;
export type SkillInputField = {
  name: string;
  label: string;
  description: string | null;
  type: SkillInputType;
  values: string[];
  required: boolean;
  default: SkillInputValue | null;
};
export type SkillInputValues = Record<string, SkillInputValue>;
export type InputProblem = { name: string | null; message: string };

export const MAX_INSTRUCTIONS = 20_000;
const MAX_FIELDS = 12;
const TYPES: readonly SkillInputType[] = ["string", "textarea", "number", "date", "enum", "boolean"];

function isScalar(value: unknown): value is SkillInputValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function parseField(raw: unknown): SkillInputField | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") return null;
  if (!TYPES.includes(raw.type as SkillInputType)) return null;
  const type = raw.type as SkillInputType;
  const values = Array.isArray(raw.values) ? raw.values.filter((v): v is string => typeof v === "string") : [];
  if (type === "enum" && values.length === 0) return null;
  return {
    name: raw.name,
    label: typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : raw.name,
    description: typeof raw.description === "string" && raw.description.trim() !== "" ? raw.description : null,
    type,
    values,
    required: raw.required === true,
    default: isScalar(raw.default) ? raw.default : null,
  };
}

export function parseSkillInputFields(value: unknown): SkillInputField[] {
  if (!Array.isArray(value) || value.length > MAX_FIELDS) return [];
  const fields = value.map(parseField);
  if (fields.some((field) => field === null)) return [];
  return fields as SkillInputField[];
}

export function parseInputValues(value: unknown): SkillInputValues | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS * 4 || !entries.every(([, v]) => isScalar(v))) return null;
  return Object.fromEntries(entries) as SkillInputValues;
}

export function coerceFieldValue(field: SkillInputField, raw: string | boolean): SkillInputValue | undefined {
  if (typeof raw === "boolean") return raw;
  if (raw.trim() === "") return undefined;
  if (field.type === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return raw;
}

export function collectRunInputs(fields: SkillInputField[], values: SkillInputValues): SkillInputValues {
  const out: SkillInputValues = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || (typeof value === "string" && value.trim() === "")) continue;
    out[field.name] = value;
  }
  return out;
}

export function missingRequired(fields: SkillInputField[], values: SkillInputValues): SkillInputField | null {
  const sent = collectRunInputs(fields, values);
  return fields.find((field) => field.required && field.default === null && sent[field.name] === undefined) ?? null;
}

export function sameInputValues(a: SkillInputValues, b: SkillInputValues): boolean {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && a[key] === b[key]);
}

export function parseInputProblems(body: unknown): InputProblem[] | null {
  if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.detail)) return null;
  const problems = body.error.detail.problems;
  if (!Array.isArray(problems)) return null;
  return problems.flatMap((problem) =>
    isRecord(problem) && typeof problem.message === "string"
      ? [{ name: typeof problem.name === "string" ? problem.name : null, message: problem.message }]
      : [],
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/skill-run-inputs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillRun/inputs.ts tests/skill-run-inputs.test.ts
git commit -m "feat(skill-runs): input field model shared by the bench client, routes and runner"
```

### Task C2: Bench client and version options carry fields; the run body sends inputs

**Files:**
- Modify: `src/lib/ignatious/bench.ts` (`BenchSkillVersion`, `normalizeVersion`, `PublicationLineageEntry`, `normalizeLineageEntry`, `BenchSkillRunBody`, `startSkillRun`)
- Modify: `src/lib/skillRun/versions.ts` (`CatalogVersionRecord`, `LineageAuthorEntry`, `VersionOption`, `catalogOptions`, `projectOptions`)
- Test: `tests/skill-run-bench-client.test.ts`, `tests/skill-run-versions.test.ts`

**Interfaces:**
- Consumes: `SkillInputField`, `SkillInputValues`, `parseSkillInputFields` (C1).
- Produces:
  - `BenchSkillVersion.inputs`, `PublicationLineageEntry.inputs`, `CatalogVersionRecord.inputs`, `LineageAuthorEntry.inputs`, `VersionOption.inputs`, all `SkillInputField[]`
  - `BenchSkillRunBody { runId; skill; inputs: SkillInputValues; instructions: string | null; tenantId; leadId; model?; token }`
  - `startSkillRun` posts `{ runId, skill, inputs, instructions, ...(instructions ? { input: instructions } : {}), tenantId, leadId, model, conductiaBaseUrl? }`

- [ ] **Step 1: Write the failing tests**
  - In `tests/skill-run-bench-client.test.ts`: (a) `listVersions` over a body whose version row has `inputs: [{ name: "asOf", type: "date" }]` yields `inputs[0].name === "asOf"` and a row without `inputs` yields `[]`; (b) `listPublicationLineage` likewise; (c) `startSkillRun({ ..., inputs: { asOf: "2026-09-30" }, instructions: "Short" })` posts a JSON body equal to `{ runId, skill, inputs: { asOf: "2026-09-30" }, instructions: "Short", input: "Short", tenantId, leadId, model: null }`; with `instructions: null` the body has no `input` key. Use the fetch stub pattern already in that file.
  - In `tests/skill-run-versions.test.ts`: `catalogOptions` and `projectOptions` copy `inputs` from each record onto its option.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/skill-run-bench-client.test.ts tests/skill-run-versions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `bench.ts`: add `inputs: SkillInputField[]` to `BenchSkillVersion` and `PublicationLineageEntry`; `normalizeVersion` adds `inputs: parseSkillInputFields(raw.inputs),`; `normalizeLineageEntry` returns `{ versionId, digest, publishedAt, inputs: parseSkillInputFields(raw.inputs) }`. Replace `BenchSkillRunBody.input: string` with `inputs: SkillInputValues; instructions: string | null;`. In `startSkillRun` build the body:

```ts
        body: JSON.stringify({
          runId: body.runId,
          skill: body.skill,
          inputs: body.inputs,
          instructions: body.instructions,
          ...(body.instructions ? { input: body.instructions } : {}),
          tenantId: body.tenantId,
          leadId: body.leadId,
          model: body.model ?? null,
          ...(config.conductiaBaseUrl ? { conductiaBaseUrl: config.conductiaBaseUrl } : {}),
        }),
```

  Delete the legacy `input` spread in a follow-up once Ignatious removes `input`; add no comment about it.
  - `versions.ts`: add `inputs: SkillInputField[]` to `CatalogVersionRecord`, `LineageAuthorEntry` and `VersionOption`; `catalogOptions` and `projectOptions` set `inputs: record.inputs` and `inputs: entry.inputs`. `readProjectOptions` already spreads `...entry`, so `inputs` carries. If `CatalogVersionRecord` is built from `BenchSkillVersion` anywhere by picking fields, add `inputs` there (`npx tsc --noEmit` shows it).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/skill-run-bench-client.test.ts tests/skill-run-versions.test.ts && npx tsc --noEmit`
Expected: tests PASS; typecheck fails only in the two `skill-runs` routes that still pass `input` (fixed in C4). Note the failures and continue.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ignatious/bench.ts src/lib/skillRun/versions.ts tests/skill-run-bench-client.test.ts tests/skill-run-versions.test.ts
git commit -m "feat(skill-runs): read each version's declared fields and send named inputs to the bench"
```

### Task C3: Run records snapshot inputs

**Files:**
- Create: `supabase/migrations/20260924120000_skill_step_input_fields.sql` (the column change here, the builder function in C5; one migration for the feature)
- Modify: `supabase/schema-snapshot.txt` (regenerated)
- Modify: `src/lib/skillRun/types.ts` (`RunRecordBody`, `SkillRunSummary`, remove `RunnableStep`, `StepResolution`, `empty_input`)
- Modify: `src/lib/skillRun/parse.ts` (`parseRunRecord`)
- Test: `tests/skill-run-step.test.ts` (the `parseRunRecord` cases)

**Interfaces:**
- Consumes: `parseInputValues`, `MAX_INSTRUCTIONS`, `SkillInputValues` (C1).
- Produces:
  - `RunRecordBody` gains `inputs: SkillInputValues; instructions: string | null`
  - `SkillRunSummary.input: string | null`, `SkillRunSummary.inputs: SkillInputValues`
  - `StepResolutionFailure.code: "not_found" | "removed" | "not_skill_backed"`; `RunnableStep` and `StepResolution` deleted

- [ ] **Step 1: Write the migration**

```sql
alter table deal_step_skill_runs
  add column if not exists inputs jsonb not null default '{}'::jsonb;

alter table deal_step_skill_runs
  alter column input drop not null;

alter table deal_step_skill_runs
  add constraint deal_step_skill_runs_inputs_object check (jsonb_typeof(inputs) = 'object');
```

- [ ] **Step 2: Apply locally and regenerate the snapshot.** First confirm the target is local: `supabase status -o env | grep -E '^(API_URL|DB_URL)='` must show `127.0.0.1` or `localhost`. Then:

```bash
supabase migration up --local
eval "$(supabase status -o env)"
umask 077; env_file="$(mktemp)"; printf "DATABASE_URL='%s'\n" "$DB_URL" > "$env_file"
npm run schema:snapshot -- "$env_file"; rm -f "$env_file"
npm run check:migrations
```

Expected: the migration applies, `supabase/schema-snapshot.txt` changes, prefix check passes.

- [ ] **Step 3: Write the failing parser tests** in `tests/skill-run-step.test.ts`

```ts
describe("parseRunRecord inputs", () => {
  const base = { runId: "3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11", outcome: "failed", errorMessage: "x" };
  it("reads inputs and instructions", () => {
    expect(parseRunRecord({ ...base, inputs: { asOf: "2026-09-30" }, instructions: " Short " }))
      .toMatchObject({ inputs: { asOf: "2026-09-30" }, instructions: "Short" });
  });
  it("defaults to no inputs and no instructions", () => {
    expect(parseRunRecord(base)).toMatchObject({ inputs: {}, instructions: null });
  });
  it("refuses nested input values", () => {
    expect(parseRunRecord({ ...base, inputs: { a: { b: 1 } } })).toEqual({ error: "inputs must map names to text, numbers or booleans" });
  });
  it("refuses instructions over the limit", () => {
    expect(parseRunRecord({ ...base, instructions: "x".repeat(20_001) })).toEqual({ error: "instructions are too long" });
  });
});
```

Delete the existing `resolveRunnableStep` tests in that file; C4 replaces the function.

- [ ] **Step 4: Implement**
  - `types.ts`: edit as listed in Interfaces. Import `SkillInputValues` from `./inputs`.
  - `parse.ts`, before the `return`:

```ts
  const inputs = rec.inputs === undefined || rec.inputs === null ? {} : parseInputValues(rec.inputs);
  if (inputs === null) return { error: "inputs must map names to text, numbers or booleans" };
  const rawInstructions = typeof rec.instructions === "string" ? rec.instructions.trim() : "";
  if (rawInstructions.length > MAX_INSTRUCTIONS) return { error: "instructions are too long" };
  const instructions = rawInstructions === "" ? null : rawInstructions;
```

  and add `inputs, instructions,` to the returned object.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/skill-run-step.test.ts`
Expected: PASS for the parser cases.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260924120000_skill_step_input_fields.sql supabase/schema-snapshot.txt src/lib/skillRun/types.ts src/lib/skillRun/parse.ts tests/skill-run-step.test.ts
git commit -m "feat(skill-runs): record the inputs a run sent and allow runs without instructions"
```

### Task C4: Run routes forward and record what the browser rendered

**Files:**
- Modify: `src/lib/skillRun/step.ts` (delete `resolveRunnableStep`)
- Modify: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts`
- Modify: `src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts` (POST insert and replay, `RUN_COLUMNS`, `decorate`)
- Test: `tests/skill-run-routes.test.ts` (find the existing route tests with `grep -rl "skill-runs/stream/route" tests`; extend that file rather than creating one)

**Interfaces:**
- Consumes: `resolveStepBinding` (existing), `parseInputValues`, `MAX_INSTRUCTIONS`, `sameInputValues` (C1), `startSkillRun` body (C2), `RunRecordBody.inputs/instructions` (C3).
- Produces:
  - Stream request body: `{ runId, version?, model?, inputs?: SkillInputValues, instructions?: string | null }`
  - Record request body: existing fields plus `inputs`, `instructions`
  - Summary rows: `input: string | null`, `inputs: SkillInputValues`

- [ ] **Step 1: Write the failing route tests**
  1. Stream: a body with `inputs: { asOf: "2026-09-30" }, instructions: "Short"` makes `startSkillRun` receive `inputs: { asOf: "2026-09-30" }, instructions: "Short"`; a step whose `work.primary` is empty is no longer refused with 422.
  2. Stream: `inputs: { a: { b: 1 } }` answers 422 `inputs must map names to text, numbers or booleans`.
  3. Stream: a bench 422 whose body is `{ error: { code: "validation", message: "m", detail: { problems: [{ name: "asOf", message: "required" }] } } }` reaches the client with status 422 and the same body.
  4. Record: inserts `input: "Short"` and `inputs: { asOf: "2026-09-30" }`; a second POST with the same `runId` and the same content answers 200 with the stored run; the same `runId` with different `inputs` answers 409.
  5. GET: a row with `input: null, inputs: { asOf: "2026-09-30" }` is returned as `input: null, inputs: { asOf: "2026-09-30" }`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run <the route test file>`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `step.ts`: delete `resolveRunnableStep` and its `StepResolution` import.
  - Stream route: widen the body type to include `inputs` and `instructions`; after the `runId` check:

```ts
  const inputs = body.inputs === undefined || body.inputs === null ? {} : parseInputValues(body.inputs);
  if (inputs === null) return jsonError('inputs must map names to text, numbers or booleans', 422);
  const instructionsText = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructionsText.length > MAX_INSTRUCTIONS) return jsonError('instructions are too long', 422);
  const instructions = instructionsText === '' ? null : instructionsText;
```

  Replace `resolveRunnableStep(...)` with `resolveStepBinding(...)` and delete the `empty_input` branch. In `startSkillRun`, replace `input: resolved.step.input` with `inputs, instructions`.
  - Record route: replace both `resolveRunnableStep` calls with `resolveStepBinding` and delete the `empty_input` branch. In `insert`, replace `input: resolved.step.input` with `input: parsed.instructions, inputs: parsed.inputs`. The replay check becomes:

```ts
    const same =
      match.input === parsed.instructions &&
      sameInputValues(match.inputs, parsed.inputs) &&
      match.outcome === parsed.outcome &&
      match.resultText === parsed.resultText;
```

  Add `inputs` to `RUN_COLUMNS`. In `decorate`: `input: (row.input as string | null) ?? null, inputs: parseInputValues(row.inputs) ?? {},`.

- [ ] **Step 4: Run tests, typecheck and lint**

Run: `npx vitest run tests/skill-run-step.test.ts <the route test file> && npx tsc --noEmit && npm run lint`
Expected: PASS except `SkillStepRunner.tsx` and any seed-run code reading `SkillRunSummary.input` as `string` (fixed in C5 and C7). If other callers break, fix them in this task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillRun/step.ts "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts" "src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route.ts" <the route test file>
git commit -m "feat(skill-runs): forward rendered inputs to the bench and record them per run"
```

### Task C5: Builder plumbing carries inputs

**Files:**
- Modify: `supabase/migrations/20260924120000_skill_step_input_fields.sql` (append the replaced function)
- Modify: `supabase/schema-snapshot.txt` (regenerated)
- Modify: `src/lib/skillAuthoring/ignatiousAuthoring.ts` (`TurnCandidatePreview`, `TurnSeedRun`)
- Modify: `src/lib/skillAuthoring/types.ts` (`CandidatePreview`)
- Modify: `src/lib/skillAuthoring/browserRoute.ts` (`normalizeCandidate`)
- Modify: `src/app/api/v1/deals/[dealId]/skill-drafts/route.ts` (`readSeedRun`)
- Test: `tests/skill-authoring-browser-routes.test.ts`, `tests/skill-authoring-ignatious-authoring.test.ts`, `tests/skill-authoring-enhancement-basis.test.ts`

**Interfaces:**
- Consumes: `SkillInputField`, `SkillInputValues`, `parseSkillInputFields`, `parseInputValues` (C1).
- Produces: `CandidatePreview.inputs: SkillInputField[]`; `TurnCandidatePreview.inputs: SkillInputField[]`; `TurnSeedRun { input: string; inputs: SkillInputValues; output: string }`.

- [ ] **Step 1: Append the function replacement** to the C3 migration. Copy the current body from `20260916110000_skill_authoring.sql` (lines 153 to 162) and add one key:

```sql
create or replace function skill_authoring_browser_candidate(p_candidate_id uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', candidate.id, 'content_digest', candidate.content_digest, 'schema_version', candidate.schema_version,
    'preview', jsonb_build_object(
      'name', candidate.preview ->> 'name', 'purpose', candidate.preview ->> 'purpose',
      'expected_input', candidate.preview ->> 'expectedInput', 'expected_output', candidate.preview ->> 'expectedOutput',
      'inputs', coalesce(candidate.preview -> 'inputs', '[]'::jsonb)
    )
  )
  from skill_authoring_candidates candidate where candidate.id = p_candidate_id;
$$;
```

Check whether a later migration already replaced this function (`grep -l "skill_authoring_browser_candidate" supabase/migrations/*`); if so, copy from the latest one instead. Keep the grants the latest definition has. Re-apply locally only after confirming the target is local, as in C3 Step 2: `supabase db reset --local` (say so before running it), then regenerate the snapshot.

- [ ] **Step 2: Write the failing tests**
  1. `normalizeCandidate` over `{ id, content_digest, preview: { name, purpose, expected_input, expected_output, inputs: [{ name: "asOf", type: "date" }] } }` yields `inputs[0].name === "asOf"`; without `inputs` it yields `[]`.
  2. `readSeedRun` over a row `{ input: null, inputs: { asOf: "2026-09-30" }, result_text: "x" }` returns `{ input: "", inputs: { asOf: "2026-09-30" }, output: "x" }` (extend the enhancement-basis test's Supabase stub to include `inputs`).
  3. The turn request built for Ignatious carries `seedRun.inputs` and `currentCandidate.inputs` through unchanged (`streamAuthoringTurn` fetch body).

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run tests/skill-authoring-browser-routes.test.ts tests/skill-authoring-ignatious-authoring.test.ts tests/skill-authoring-enhancement-basis.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**
  - `ignatiousAuthoring.ts`: `TurnCandidatePreview` gains `inputs: SkillInputField[]`; `TurnSeedRun` becomes `{ input: string; inputs: SkillInputValues; output: string }`.
  - `types.ts`: `CandidatePreview` gains `inputs: SkillInputField[]`.
  - `browserRoute.ts` `normalizeCandidate`: add `inputs: parseSkillInputFields(preview.inputs),`.
  - `readSeedRun`: select `"input, inputs, result_text, error_message"`; return type `TurnSeedRun | null`; add `inputs: parseInputValues(row.inputs) ?? {},`.

- [ ] **Step 5: Run the tests and typecheck**

Run: the three test files, then `npx tsc --noEmit`
Expected: tests PASS; typecheck errors only in `SkillStepRunner.tsx` (C7).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260924120000_skill_step_input_fields.sql supabase/schema-snapshot.txt src/lib/skillAuthoring/ignatiousAuthoring.ts src/lib/skillAuthoring/types.ts src/lib/skillAuthoring/browserRoute.ts "src/app/api/v1/deals/[dealId]/skill-drafts/route.ts" tests/skill-authoring-browser-routes.test.ts tests/skill-authoring-ignatious-authoring.test.ts tests/skill-authoring-enhancement-basis.test.ts
git commit -m "feat(authoring): carry declared inputs through the builder and seed runs"
```

### Task C6: The field controls

**Files:**
- Create: `src/components/rail/SkillInputFields.tsx` (the form body; `SkillStepRunner.tsx` is already 487 lines, and the controls are independently testable)
- Test: `tests/skill-input-fields.test.tsx`

**Interfaces:**
- Consumes: `SkillInputField`, `SkillInputValues`, `coerceFieldValue` (C1).
- Produces:

```ts
export function SkillInputFields(props: {
  fields: SkillInputField[];
  values: SkillInputValues;
  problems: Record<string, string>;
  missing: string | null;
  disabled: boolean;
  onChange: (next: SkillInputValues) => void;
  onCommit: (next: SkillInputValues) => void;
}): React.ReactElement | null;
```

`onChange` fires on every edit with the whole next object; `onCommit` fires on blur (text, textarea, number, date) or change (select, checkbox) with the whole next object, for autosave.

- [ ] **Step 1: Write the failing tests** in `tests/skill-input-fields.test.tsx`

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SkillInputFields } from "@/components/rail/SkillInputFields";
import type { SkillInputField } from "@/lib/skillRun/inputs";

const f = (over: Partial<SkillInputField>): SkillInputField => ({
  name: "x", label: "X", description: null, type: "string", values: [], required: false, default: null, ...over,
});

const FIELDS = [
  f({ name: "title", label: "Title", type: "string", required: true, description: "Shown on the cover" }),
  f({ name: "notes", label: "Notes", type: "textarea" }),
  f({ name: "count", label: "Count", type: "number" }),
  f({ name: "asOf", label: "As of", type: "date" }),
  f({ name: "audience", label: "Audience", type: "enum", values: ["Board", "Buyer"], default: "Board" }),
];

function setup(values = {}, extra = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<SkillInputFields fields={FIELDS} values={values} problems={{}} missing={null} disabled={false} onChange={onChange} onCommit={onCommit} {...extra} />);
  return { onChange, onCommit };
}

describe("SkillInputFields", () => {
  it("renders one labelled control per type", () => {
    setup();
    expect(screen.getByLabelText(/^Title/)).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Count")).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("As of")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Audience").tagName).toBe("SELECT");
  });

  it("marks required fields and links helper text", () => {
    setup();
    const title = screen.getByLabelText(/^Title/);
    expect(title).toHaveAttribute("aria-required", "true");
    expect(title.getAttribute("aria-describedby")).toContain("skill-input-title-help");
    expect(screen.getByText("Shown on the cover")).toHaveAttribute("id", "skill-input-title-help");
  });

  it("preselects the declared default for a choice", () => {
    setup();
    expect(screen.getByLabelText("Audience")).toHaveValue("Board");
  });

  it("sends numbers as numbers and drops an empty number", () => {
    const { onChange } = setup({ count: 3 });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith({ count: 12 });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("commits the whole object on blur", () => {
    const { onCommit } = setup({ title: "Q3", count: 2 });
    fireEvent.blur(screen.getByLabelText(/^Title/));
    expect(onCommit).toHaveBeenCalledWith({ title: "Q3", count: 2 });
  });

  it("shows a field's problem and links it", () => {
    setup({}, { problems: { asOf: "expected a date" } });
    const asOf = screen.getByLabelText("As of");
    expect(asOf).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("expected a date")).toHaveAttribute("id", "skill-input-asOf-error");
    expect(asOf.getAttribute("aria-describedby")).toContain("skill-input-asOf-error");
  });

  it("names the missing required field", () => {
    setup({}, { missing: "title" });
    expect(screen.getByText("Title is required.")).toBeInTheDocument();
  });

  it("renders nothing when there are no fields", () => {
    const { container } = render(<SkillInputFields fields={[]} values={{}} problems={{}} missing={null} disabled={false} onChange={() => undefined} onCommit={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/skill-input-fields.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/components/rail/SkillInputFields.tsx`. Reuse the class strings `SkillStepRunner.tsx` already uses for its textarea (`w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)]`) and its select, so the form matches the Workbench register already on screen.

```tsx
'use client';

import * as React from 'react';

import {
  coerceFieldValue,
  type SkillInputField,
  type SkillInputValue,
  type SkillInputValues,
} from '@/lib/skillRun/inputs';

const CONTROL =
  'w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)]';

function withValue(values: SkillInputValues, name: string, value: SkillInputValue | undefined): SkillInputValues {
  const next = { ...values };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}

function shown(field: SkillInputField, values: SkillInputValues): string {
  const value = values[field.name] ?? field.default;
  return value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
}

export function SkillInputFields({
  fields,
  values,
  problems,
  missing,
  disabled,
  onChange,
  onCommit,
}: {
  fields: SkillInputField[];
  values: SkillInputValues;
  problems: Record<string, string>;
  missing: string | null;
  disabled: boolean;
  onChange: (next: SkillInputValues) => void;
  onCommit: (next: SkillInputValues) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="space-y-[var(--space-3)]">
      {fields.map((field) => {
        const id = `skill-input-${field.name}`;
        const helpId = `${id}-help`;
        const errorId = `${id}-error`;
        const problem =
          problems[field.name] ?? (missing === field.name ? `${field.label} is required.` : null);
        const describedBy = [field.description ? helpId : null, problem ? errorId : null]
          .filter(Boolean)
          .join(' ');
        const common = {
          id,
          disabled,
          'aria-required': field.required || undefined,
          'aria-invalid': problem ? true : undefined,
          'aria-describedby': describedBy || undefined,
        };
        const update = (raw: string | boolean) => {
          const next = withValue(values, field.name, coerceFieldValue(field, raw));
          onChange(next);
          return next;
        };
        return (
          <div key={field.name} className="space-y-[var(--space-1)]">
            <label htmlFor={id} className="block text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
              {field.label}
              {field.required ? <span className="text-[var(--ink-tertiary)]"> required</span> : null}
            </label>
            {field.type === 'textarea' ? (
              <textarea {...common} rows={4} value={shown(field, values)} className={CONTROL}
                onChange={(e) => update(e.target.value)} onBlur={() => onCommit(values)} />
            ) : field.type === 'enum' ? (
              <select {...common} value={shown(field, values)} className={CONTROL}
                onChange={(e) => onCommit(update(e.target.value))}>
                <option value="">Not specified</option>
                {field.values.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            ) : field.type === 'boolean' ? (
              <input {...common} type="checkbox" checked={values[field.name] === true}
                onChange={(e) => onCommit(update(e.target.checked))} />
            ) : (
              <input {...common} value={shown(field, values)} className={CONTROL}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                onChange={(e) => update(e.target.value)} onBlur={() => onCommit(values)} />
            )}
            {field.description ? (
              <p id={helpId} className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{field.description}</p>
            ) : null}
            {problem ? (
              <p id={errorId} className="text-[length:var(--text-xs)] text-[var(--negative-deep)]">{problem}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
```

The "required" marker text makes the accessible label "Title required"; the tests match with `/^Title/`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/skill-input-fields.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/SkillInputFields.tsx tests/skill-input-fields.test.tsx
git commit -m "feat(rail): typed input controls for skill-backed steps"
```

### Task C7: The runner renders the running version's form

**Files:**
- Modify: `src/components/rail/StepVersionControl.tsx` (`onSelectionChange` passes fields)
- Modify: `src/components/rail/SkillStepRunner.tsx`
- Test: `tests/skill-step-runner.test.tsx`, `tests/skill-step-runner-versions.test.tsx`

**Interfaces:**
- Consumes: `SkillInputFields` (C6); `collectRunInputs`, `missingRequired`, `parseInputValues`, `parseInputProblems`, `SkillInputField`, `SkillInputValues` (C1); `VersionOption.inputs` (C2); `SkillRunSummary.inputs/input` (C3); stream and record bodies (C4).
- Produces: `StepVersionControlProps.onSelectionChange: (reference: SkillReference | null, fields: SkillInputField[]) => void`; exported `INSTRUCTIONS_LABEL = 'Additional instructions'`.

- [ ] **Step 1: Write the failing runner tests** in `tests/skill-step-runner.test.tsx`, using the file's existing fetch stubs and extending the `skill-versions` stub so the current option carries `inputs: [{ name: "asOf", type: "date", label: "As of", required: true }]`:
  1. The form shows "As of" and "Additional instructions"; "Draft this step" is disabled and `As of is required.` is shown under the field; after filling `2026-09-30` the button is enabled and the message is gone.
  2. Pressing Draft posts to `/stream` a body containing `inputs: { asOf: "2026-09-30" }` and `instructions: null`, and the record POST contains the same `inputs`.
  3. A step whose `work` is `{ primary: "Old text" }` and whose version declares nothing shows "Old text" in Additional instructions, Draft is enabled, and the stream body is `inputs: {}, instructions: "Old text"`.
  4. Editing the date and blurring calls `PATCH` with `work: { inputs: { asOf: "2026-09-30" } }` (the whole object, never a single key).
  5. A stream 422 whose body carries `detail.problems: [{ name: "asOf", message: "expected a date" }, { name: null, message: "bad" }]` shows "expected a date" under the field and "bad" in the alert above the button.
  6. A history run with `inputs: { asOf: "2026-09-30" }, input: "Short"` shows "As of" and "2026-09-30" and "Short" when selected; a run with `input: null` and `inputs: {}` shows neither block.

In `tests/skill-step-runner-versions.test.tsx`: choosing another version whose fields are `[asOf, audience]` keeps the typed `asOf` value, shows `audience` at its default, and a stored value for a field the new version lacks is not sent.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/skill-step-runner.test.tsx tests/skill-step-runner-versions.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Pass fields from the version control.** In `StepVersionControl.tsx`, change the prop type as in Interfaces, and add:

```ts
function fieldsFor(versions: LoadedStepVersions, reference: SkillReference | null): SkillInputField[] {
  if (!reference) return [];
  const key = referenceKey(reference);
  const option = [...versions.project, ...versions.catalog].find((o) => referenceKey(o.reference) === key);
  return option ? parseSkillInputFields(option.inputs) : [];
}
```

Every `onSelectionChange(x)` call becomes `onSelectionChange(x, fieldsFor(<the versions in scope>, x))`: the load effect and `applyToStep` pass `data`, `handleChange` passes `versions`.

- [ ] **Step 4: Rework the runner** in `SkillStepRunner.tsx`
  - State: rename `input` to `instructions`; add `const [values, setValues] = React.useState<SkillInputValues>({});`, `const [fields, setFields] = React.useState<SkillInputField[]>([]);`, `const [problems, setProblems] = React.useState<Record<string, string>>({});`. Derive `const lacking = missingRequired(fields, values);` on every render; it is not state.
  - Loading: where it reads `state.work.primary`, also `setValues(parseInputValues(state.work.inputs) ?? {})`.
  - Selection: replace `onSelectionChange={setSelectedVersion}` with a stable callback:

```ts
  const handleSelection = React.useCallback((reference: SkillReference | null, next: SkillInputField[]) => {
    setSelectedVersion(reference);
    setFields(next);
    setProblems({});
  }, []);
```

  - Autosave: `const saveValues = (next: SkillInputValues) => { setSaving('saving'); void patchStep(projectId, step.stepId, { work: { inputs: next } }).then(() => setSaving('saved')); };`. The instructions textarea keeps its blur save of `{ work: { primary: instructions } }`.
  - `run()`: replace the `input.trim() === ''` guard with `if (pending || lacking) return;`. Then:

```ts
    setProblems({});
    const runInputs = collectRunInputs(fields, values);
    const runInstructions = instructions.trim() === '' ? null : instructions.trim();
```

  Save both before streaming: `await patchStep(projectId, step.stepId, { work: { primary: instructions, inputs: values } });`. Add `inputs: runInputs, instructions: runInstructions` to `streamRequest` and to both `record({...})` calls.
  - 422 handling: before throwing `IgnatiousClientError` on a non-ok stream response, if `response.status === 422`, read the body once and:

```ts
        const found = parseInputProblems(await response.clone().json().catch(() => null));
        if (found) {
          const byField: Record<string, string> = {};
          const loose: string[] = [];
          for (const problem of found) {
            if (problem.name && fields.some((f) => f.name === problem.name)) byField[problem.name] = problem.message;
            else loose.push(problem.message);
          }
          setProblems(byField);
          setStreamed(null);
          setPending(false);
          setError(loose.length > 0 ? loose.join(' ') : null);
          return;
        }
```

  No run is recorded for a 422, matching the spec's "No run record, no spend". Place this so `abort.current = null` in `finally` still runs.
  - Draft button: `disabled={pending || lacking !== null}`. The missing field is named under the field itself through `missing={lacking?.name ?? null}`, so a disabled button never leaves the banker guessing.
  - Render: replace the single `Input` block with:

```tsx
      <SkillInputFields
        fields={fields}
        values={values}
        problems={problems}
        missing={lacking?.name ?? null}
        disabled={pending}
        onChange={setValues}
        onCommit={saveValues}
      />
      <div className="space-y-[var(--space-2)]">
        <label htmlFor="skill-step-instructions" className="block text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
          {INSTRUCTIONS_LABEL}
        </label>
        <textarea id="skill-step-instructions" value={instructions} rows={4} disabled={pending}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => { setSaving('saving'); void patchStep(projectId, step.stepId, { work: { primary: instructions } }).then(() => setSaving('saved')); }}
          className="w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)]" />
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {fields.length === 0 ? (definition ? definition.inputs[0].helperText : stepSkillCopy(step.stepId).uses) : 'Optional.'}
          {saving === 'saving' ? ' · Saving' : saving === 'saved' ? ' · Saved' : ''}
        </p>
      </div>
```

  - History: add a `RunInputsSummary` inside `SkillStepRunner.tsx` (no new file; it is a few lines) rendered above `RunResult` when a past run is selected and nothing is streaming:

```tsx
function RunInputsSummary({ run, fields }: { run: SkillRunSummary; fields: SkillInputField[] }) {
  const entries = Object.entries(run.inputs);
  if (entries.length === 0 && !run.input) return null;
  const labelFor = (name: string) => fields.find((f) => f.name === name)?.label ?? name;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-[var(--space-3)] gap-y-[var(--space-1)] text-[length:var(--text-xs)]" aria-label="Run inputs">
      {entries.map(([name, value]) => (
        <React.Fragment key={name}>
          <dt className="text-[var(--ink-secondary)]">{labelFor(name)}</dt>
          <dd className="text-[var(--ink)]">{String(value)}</dd>
        </React.Fragment>
      ))}
      {run.input ? (
        <>
          <dt className="text-[var(--ink-secondary)]">{INSTRUCTIONS_LABEL}</dt>
          <dd className="whitespace-pre-wrap text-[var(--ink)]">{run.input}</dd>
        </>
      ) : null}
    </dl>
  );
}
```

- [ ] **Step 5: Run the runner tests, typecheck and lint**

Run: `npx vitest run tests/skill-step-runner.test.tsx tests/skill-step-runner-versions.test.tsx tests/skill-input-fields.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS. Update any existing runner assertion that looked for the `Input` label to `Additional instructions`; do not loosen any other assertion.

- [ ] **Step 6: Commit**

```bash
git add src/components/rail/StepVersionControl.tsx src/components/rail/SkillStepRunner.tsx tests/skill-step-runner.test.tsx tests/skill-step-runner-versions.test.tsx
git commit -m "feat(rail): render the running version's input form and send its values"
```

### Task C8: The builder preview lists inputs

**Files:**
- Modify: `src/components/rail/SkillCandidatePreview.tsx`
- Test: `tests/skill-builder-dialog.test.tsx` (or the existing preview test; `grep -rl SkillCandidatePreview tests`)

**Interfaces:**
- Consumes: `CandidatePreview.inputs` (C5).

- [ ] **Step 1: Write the failing tests**: a candidate with `inputs: [{ name: "asOf", label: "As of", type: "date", required: true, ... }, { name: "audience", label: "Audience", type: "enum", values: ["Board", "Buyer"], required: false, ... }]` renders an "Inputs" term, rows "As of", "Date", "Required", and "Audience", "Choice", "Board, Buyer"; a candidate with `inputs: []` renders "No inputs. Runs on deal context and instructions."

- [ ] **Step 2: Run to see them fail**, then **implement**: below the expected output row, add a `dt` "Inputs" and a `dd` holding either the empty sentence or a `ul` with one `li` per field: label, then kind from

```ts
const KIND_LABEL: Record<SkillInputType, string> = {
  string: 'Short text', textarea: 'Long text', number: 'Number', date: 'Date', enum: 'Choice', boolean: 'Yes or no',
};
```

then "Required" when required, then `values.join(', ')` for an enum. Use the same `bank-label` and text classes as the neighbouring rows.

- [ ] **Step 3: Run tests**

Run: `npx vitest run <the preview test file>`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/rail/SkillCandidatePreview.tsx <the preview test file>
git commit -m "feat(authoring): show the candidate's inputs in the builder preview"
```

### Task C9: Browser journey and full local verification

**Files:**
- Modify: `e2e/support/ignatiousPublicationStub.ts` (answer lineage for one fixture skill)
- Modify: `e2e/journeys/skill-run.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Teach the stub one lineage.** Export constants from the stub file and answer `GET /v1/conductia/skill-publications/skills/<FIELDS_SKILL_ID>/lineage` before the existing `operationId === null` branch:

```ts
export const FIELDS_SKILL = {
  skillId: '6a1c0f3e-2b4d-4e5f-9a8b-7c6d5e4f3a2b',
  versionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  digest: 'b'.repeat(64),
};
export const FIELDS_SKILL_INPUTS = [
  { name: 'asOf', type: 'date', label: 'As of', required: true },
  { name: 'audience', type: 'enum', label: 'Audience', values: ['Board', 'Buyer'], default: 'Board' },
];
```

```ts
      if (request.method === 'GET' && pathname === `/v1/conductia/skill-publications/skills/${FIELDS_SKILL.skillId}/lineage`) {
        sendJson(response, 200, {
          lineage: [{ versionId: FIELDS_SKILL.versionId, digest: FIELDS_SKILL.digest, publishedAt: '2026-09-24T12:00:00.000Z', inputs: FIELDS_SKILL_INPUTS }],
        });
        return;
      }
```

Match the stub's existing auth-header check if lineage requests carry the publication token.

- [ ] **Step 2: Update the existing journeys.** In both existing tests, replace `getByLabel('Input')` with `getByLabel('Additional instructions')` and `run.input` expectations stay as they are (the instructions text is still stored in `input`).

- [ ] **Step 3: Add the journey**

```ts
  test('an MD fills the fields a skill declares and the run records them', async ({ page, evidence, runId }) => {
    const title = `Board pack ${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId: `custom:${runId}`,
      title,
      description: 'Prepare the board pack.',
      helperText: HELPER_TEXT,
      binding: FIELDS_SKILL,
      phaseIndex: 1,
      displayOrder: 0,
    });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    const runner = focus.getByRole('region', { name: 'Skill run' });

    await expect(runner.getByLabel(/^As of/)).toBeVisible();
    await expect(runner.getByLabel('Audience')).toHaveValue('Board');

    await expect(runner.getByRole('button', { name: 'Draft this step' })).toBeDisabled();
    await expect(runner.getByText('As of is required.')).toBeVisible();

    await runner.getByLabel(/^As of/).fill('2026-09-30');
    await runner.getByLabel('Additional instructions').fill('Keep it to one page');
    await runner.getByRole('button', { name: 'Draft this step' }).click();
    await expect(runner.getByRole('alert')).toBeVisible({ timeout: 60_000 });

    const [recorded] = await readSkillRuns(deal.id);
    expect(recorded.inputs).toEqual({ asOf: '2026-09-30' });
    expect(recorded.input).toBe('Keep it to one page');

    await page.reload();
    const again = (await openTheSkillStep(page, title)).getByRole('region', { name: 'Skill run' });
    await expect(again.getByLabel(/^As of/)).toHaveValue('2026-09-30');
  });
```

The hermetic tier has no skill service, so the run ends failed, as the file's header explains; the form, the saved values and the recorded snapshot are what this proves. If `readSkillRuns` selects explicit columns, add `inputs`.

- [ ] **Step 4: Run the full local CI.** Confirm local targets first (`supabase status -o env`, and `.env.local` Supabase URL must be localhost). Then:

```bash
npm run lint
npm run check:migrations
npx tsc --noEmit
npm test
npm run build
eval "$(supabase status -o env)"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" DATABASE_URL="$DB_URL" npm run test:integration
npm run test:e2e -- e2e/journeys/skill-run.spec.ts e2e/journeys/skill-publication.spec.ts e2e/journeys/skill-enhancement.spec.ts
```

Expected: all green. Also confirm `supabase/schema-snapshot.txt` has no uncommitted diff.

- [ ] **Step 5: Real-browser walk on the local stack** with a seeded user and programmatic sign-in (not the sign-in form): open a deal, open a skill-backed step bound to `FIELDS_SKILL` via the stub, fill both fields, switch version if more than one is listed, run, and select the history row. Record what was and was not exercised; a real streamed run against a live bench is not part of this walk.

- [ ] **Step 6: Commit**

```bash
git add e2e/support/ignatiousPublicationStub.ts e2e/journeys/skill-run.spec.ts
git commit -m "test(e2e): a skill step renders declared fields and records their values"
```

---

## Spec coverage map

| Spec section | Tasks |
|---|---|
| Declaration, caps, types, `validateInputs` | I1 |
| Authoring (tool argument, metadata rejection, package insertion, preview plumbing) | I5, C5, C8 |
| Enhancement (ancestor without block, ancestor inputs, seed run values) | I6, C5 |
| Reading it back (frontmatter, not_loadable, version records, lineage) | I2, I3 |
| Execution (schema, 422 envelope, legacy input, message template, not-loadable refusal) | I4 |
| Field definitions per version, parser | C1, C2 |
| Stored values, whole-object autosave | C7 |
| Run path (client sends values, stream forwards, record snapshots, replay) | C4, C7 |
| Run history (column, nullable input, summary, seed run) | C3, C4, C5, C7 |
| Builder plumbing (SQL function, types) | C5 |
| UI: preview, step form, history, accessibility | C6, C7, C8 |
| Rollout (Ignatious first, transitional `input`) | I4, C2 |
| Testing, browser E2E | every task, C9 |
