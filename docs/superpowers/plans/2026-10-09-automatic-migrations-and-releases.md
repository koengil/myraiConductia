# Automatic Migrations and Tagged Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosted databases are migrated by a GitHub Action of their own, on every push to `develop` and inside the production promotion, and a production promotion tags the release and publishes its notes.

**Architecture:** One reusable workflow, `migrate.yml`, runs `supabase db push --include-all` against the database a GitHub environment names. Pushes trigger it, the Promote workflows call it before they move a branch, and it can be run by hand. Its first steps refuse a missing secret, an unlisted production approver and a database that was never baselined. `check:migrations` gains the rule that makes a ledger safe: a migration file on `main` never changes.

**Tech Stack:** GitHub Actions (reusable workflows, environments), Supabase CLI 2.116.0, bash, `node:test` for the workflow shell, Vitest for the TypeScript rule.

**Spec:** `docs/superpowers/specs/2026-10-08-automatic-migrations-and-releases-design.md`. Read it first; this plan argues from it.

## Execution notes (2026-10-09)

Tasks 1 to 6 were executed. The final whole-branch review changed the code after the blocks below were written, so where they differ the files in the repository are authoritative:

- `promote-staging-to-main.yml`: the `migrate` job passes `secrets: inherit`. Without it GitHub resolves an environment secret to an empty string inside a called workflow.
- `migrate.yml`: the apply step probes for the ledger table and no longer swallows read errors; a ledger it cannot read after the push reports `applied=unknown`, so the preflight still runs. The empty-secret message names the missing `secrets: inherit` as a cause. The guard also refuses a connection string that belongs to another environment: only `db-production` may hold the production project's.
- `scripts/check-migration-prefixes.ts`: released files that are not `.sql` are ignored. The script is listed in `tests/fixtures/mailboxReaderFence/nodeProcessModules.json`.
- `scripts/preflight-db.ts`: a red preflight no longer tells the operator to apply SQL by hand.
- After the human review of PR #445 (2026-10-13): `migrate.yml` refuses to migrate production from a commit that is on neither `staging` nor `main`; `promote-staging-to-main.yml` takes the highest `vX.Y.Z` tag on `main` and ignores other tag shapes, labels its migration list as the files the release adds, and heads the release notes "Migrations in this release"; the plan step now has an executing test.
- Task 7 (2026-10-13, its own PR): the target expression occurs four times, not three, and `promote.test.mjs` ends with 8 tests. The documentation differs from Step 5, because the staging database was built before the staging deployment moved to it: the docs say the deployment still reads Conductia-dev, and `production-bootstrap.md` gains The staging database, the hand-shipped first release, and a corrected baseline for a ledger that holds another tool's rows.

## Global Constraints

- Branch `improve-git-process`, based on `origin/develop`. Never commit to `develop`, `staging` or `main`.
- Nothing in this plan connects to a hosted database, creates a GitHub environment, secret, variable, tag or release, or runs a Promote Action. Those are the owner's steps, listed under [Owner setup](#owner-setup-not-agent-work). The one exception is Task 6, which creates the empty staging Supabase project through the connector after Charles confirms the cost. No task ever calls a connector tool against the dev or production project.
- The Supabase CLI version is `2.116.0` wherever it appears, the version `ci.yml` pins.
- Exact names: workflow and job `Migrate database`; environments `db-dev`, `db-staging`, `db-production`; secret `MIGRATION_DATABASE_URL`; variable `MIGRATION_APPROVERS`.
- The only command that writes to a database is `supabase db push --include-all --skip-vault --yes --db-url "${MIGRATION_DATABASE_URL}"`.
- No `${{ }}` expression inside a `run:` script. Values reach the shell through `env:`.
- No code comments in new code (project rule). An existing comment is edited only where this change makes it false.
- **Never run `git fetch --depth` on your machine.** The fetch line in Task 1's CI step is for the CI checkout, which is already depth 1. On a full clone it marks the repository shallow and truncates history for every worktree that shares it. Locally, use `git fetch origin`.
- Stage explicit paths. Never `git add -A` or `git add .`.
- The decision log gets one new row at the end. Do not edit neighbouring rows.
- Before pushing: `git fetch origin && git rebase origin/develop`, then the checks in Task 5. Push with `--force-with-lease`.
- actionlint runs through Docker. If Docker is not running, skip it and say so in the PR.

## Review Focus

1. **A database that was never baselined.** Schema present, ledger empty: the job must refuse before any push, because a push would replay every file over it (Task 2, `apply: a schema with an empty ledger is refused before any push`).
2. **An approver list typed by a person.** Spaces, capitals, a trailing comma, an empty actor, a bot login with brackets such as `cursor[bot]`: the listed approver passes and nobody else does (Task 2, the two `guard:` tests).
3. **A connection string with a quote or a line break.** Refused before it is masked or written to an env file (Task 2, `guard: the database URL must be set and safe to write to an env file`).
4. **A promotion that should not tag.** `staging` equal to `main`, a previous tag that is not `vX.Y.Z`, or a version that already exists: it stops in `plan`, before production is touched (Task 3).
5. **A push that fails partway.** The run stays red and its summary still lists the files that did apply (Task 2, `apply: a push that fails partway stays red and still reports what it applied`).

## Already proven

Rehearsed on 2026-10-09 with CLI 2.116.0 against a throwaway local database (results are in the spec's Testing section): a full build by `db push` alone matches `supabase/schema-snapshot.txt`; `migration repair --status applied` baselines an emptied ledger; an older-timestamp file needs `--include-all`; a failing file leaves nothing behind; a deleted applied file blocks the push until its ledger row is reverted.

Every code block in Tasks 1 to 3 and 7 was run the same day in a scratch copy of `develop` at `3a527442a`: 14 Vitest tests, 12 + 6 + 17 `node:test` tests, and actionlint clean on the four workflows. If a step's output differs from what is written here, the repository has moved: stop and compare before changing code.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/check-migration-prefixes.ts` | Existing naming check, plus the released-file rule and its git reads |
| `tests/check-migration-prefixes.test.ts` | Vitest for both rules |
| `.github/workflows/ci.yml` | The lint job fetches `main`'s tip before `check:migrations` |
| `tests/fixtures/mailboxReaderFence/nodeProcessModules.json` | Lists `scripts/check-migration-prefixes.ts` as a script that may run `git` |
| `.github/workflows/migrate.yml` | New. The one place a hosted database is migrated |
| `scripts/ci/migrate.test.mjs` | New. Runs `migrate.yml`'s own shell and pins its wiring |
| `.github/workflows/promote-staging-to-main.yml` | Calls `migrate.yml` before the fast-forward; tags and publishes after it |
| `.github/workflows/promote-develop-to-staging.yml` | Its summary lists the migration files a promotion adds |
| `scripts/ci/promote.test.mjs` | New. Runs the promotion shell and pins the job order |
| `scripts/ci/gates.test.mjs` | One assertion names the migrate job in place of `production-db` |
| `docs/03-engineering/delivery-model.md`, `docs/04-operations/production-bootstrap.md` | The flow and the one-time setup |
| `scripts/migrate.sh` | Header comment only |
| `docs/07-decisions/decision-log.md` | Row D84 |

## Owner setup (not agent work)

These need rights no session has. Charles is requesting them. The exact commands land in `docs/04-operations/production-bootstrap.md` with Task 4.

| # | Step | When |
|---|---|---|
| 1 | GitHub: create environments `db-dev` (branch `develop`) and `db-production` (branch `main`). Set `MIGRATION_APPROVERS` on `db-production`. No secrets yet | Before the PR merges |
| 2 | Baseline the dev ledger, then add `db-dev`'s `MIGRATION_DATABASE_URL` | Before the PR merges, or every `develop` push shows a red **Migrate database** run |
| 3 | Baseline the production ledger at `main`'s tip, then add `db-production`'s secret | Before the first automated release |
| 4 | Tag `v0.7.0` at `22cf73bfc0c6727d7e10347e2dcd8d8b081c1790` and publish its release | Before the first automated release |
| 5 | Ship the release that carries this change the old way once, with one `supabase db push` from the releaser's machine | The Promote Actions run from `main`, which does not hold the new files until then |
| 6 | After Task 6 has created the staging project: reset its database password, create `db-staging` (branches `staging` and `main`) with its secret, build the schema once with **Migrate database**, and configure auth and the Vercel variables | Before Task 7 |

---

### Task 1: A migration file on `main` can never change

**Files:**
- Modify: `scripts/check-migration-prefixes.ts`
- Modify: `tests/check-migration-prefixes.test.ts`
- Modify: `.github/workflows/ci.yml` (the `lint` job's `Migration prefixes` step)
- Modify: `tests/fixtures/mailboxReaderFence/nodeProcessModules.json` (added during execution: the script now imports `node:child_process`, which `tests/mailbox-reader-fence.test.ts` allows only for files listed there with a reason)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `parseLsTree(stdout: string): Map<string, string>` and `findReleasedFileProblems(released: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[]`, both exported from `scripts/check-migration-prefixes.ts`. Maps are file name to git blob id. `npm run check:migrations` now also needs `origin/main` to exist locally.

- [ ] **Step 1: Prepare the branch and commit the spec and this plan**

```bash
git fetch origin
git rebase origin/develop
node --version
npm ci
git add docs/superpowers/specs/2026-10-08-automatic-migrations-and-releases-design.md docs/superpowers/plans/2026-10-09-automatic-migrations-and-releases.md
git commit -m "$(cat <<'MSG'
docs: spec and plan for automatic migrations and tagged releases

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
)"
```

Expected: `node --version` prints `v22.x` (`.nvmrc`; run `nvm use` if it does not), and one commit holds the two files.

- [ ] **Step 2: Write the failing tests**

Replace `tests/check-migration-prefixes.test.ts` with this. The first `describe` is the existing one, unchanged apart from the import.

````ts
import { describe, expect, it } from 'vitest';
import {
  findPrefixProblems,
  findReleasedFileProblems,
  parseLsTree,
} from '../scripts/check-migration-prefixes';

describe('migration prefix check', () => {
  it('passes a clean chain', () => {
    expect(
      findPrefixProblems([
        '20260603000000_feature_flags.sql',
        '20260604100000_permissions_schema.sql',
        '20260903130000_deal_step_bench_session.sql',
      ]),
    ).toEqual([]);
  });

  it('names both files of the in-flight 20260919120000 collision', () => {
    expect(
      findPrefixProblems([
        '20260919120000_pending_agent_runs.sql',
        '20260903130000_deal_step_bench_session.sql',
        '20260919120000_lead_personas_conductia_tenant.sql',
      ]),
    ).toEqual([
      'duplicate 20260919120000: 20260919120000_lead_personas_conductia_tenant.sql, 20260919120000_pending_agent_runs.sql',
    ]);
  });

  it('reports every file sharing a prefix, and each colliding prefix once', () => {
    expect(
      findPrefixProblems([
        '20260101000000_a.sql',
        '20260101000000_b.sql',
        '20260101000000_c.sql',
        '20260202000000_d.sql',
        '20260202000000_e.sql',
      ]),
    ).toEqual([
      'duplicate 20260101000000: 20260101000000_a.sql, 20260101000000_b.sql, 20260101000000_c.sql',
      'duplicate 20260202000000: 20260202000000_d.sql, 20260202000000_e.sql',
    ]);
  });

  it('flags malformed names', () => {
    expect(
      findPrefixProblems([
        '2026091912000_short_prefix.sql',
        '20260919120000-dash_separator.sql',
        '20260919120000_Upper_Case.sql',
        'feature_flags.sql',
        '20260919120000_.sql',
      ]),
    ).toEqual([
      'malformed: 20260919120000-dash_separator.sql',
      'malformed: 20260919120000_.sql',
      'malformed: 20260919120000_Upper_Case.sql',
      'malformed: 2026091912000_short_prefix.sql',
      'malformed: feature_flags.sql',
    ]);
  });

  it('ignores files that are not .sql', () => {
    expect(
      findPrefixProblems(['README.md', '.gitkeep', '20260603000000_feature_flags.sql']),
    ).toEqual([]);
  });

  it('does not count a malformed name toward a duplicate', () => {
    expect(
      findPrefixProblems(['20260603000000_feature_flags.sql', '20260603000000_Feature.sql']),
    ).toEqual(['malformed: 20260603000000_Feature.sql']);
  });
});

describe('released migration file check', () => {
  const released = new Map([
    ['20260603000000_feature_flags.sql', 'aaa1'],
    ['20260604100000_permissions_schema.sql', 'bbb2'],
  ]);

  it('passes when every released file is unchanged and new files are added', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([...released, ['20261008120000_new_table.sql', 'ccc3']]),
      ),
    ).toEqual([]);
  });

  it('names a released file whose content changed', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([
          ['20260603000000_feature_flags.sql', 'aaa1'],
          ['20260604100000_permissions_schema.sql', 'eee5'],
        ]),
      ),
    ).toEqual(['changed after release: 20260604100000_permissions_schema.sql']);
  });

  it('names a released file that was removed', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([['20260604100000_permissions_schema.sql', 'bbb2']]),
      ),
    ).toEqual(['removed after release: 20260603000000_feature_flags.sql']);
  });

  it('reports a renamed released file as removed, even with identical content', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([
          ['20260603000000_feature_flags.sql', 'aaa1'],
          ['20261008120000_permissions_schema.sql', 'bbb2'],
        ]),
      ),
    ).toEqual(['removed after release: 20260604100000_permissions_schema.sql']);
  });

  it('reports every problem, in filename order', () => {
    expect(
      findReleasedFileProblems(
        new Map([
          ['20260604100000_permissions_schema.sql', 'bbb2'],
          ['20260603000000_feature_flags.sql', 'aaa1'],
        ]),
        new Map([['20260603000000_feature_flags.sql', 'fff6']]),
      ),
    ).toEqual([
      'changed after release: 20260603000000_feature_flags.sql',
      'removed after release: 20260604100000_permissions_schema.sql',
    ]);
  });

  it('passes when nothing is released yet', () => {
    expect(
      findReleasedFileProblems(new Map(), new Map([['20260603000000_feature_flags.sql', 'aaa1']])),
    ).toEqual([]);
  });
});

describe('git ls-tree parsing', () => {
  it('maps each file name to its blob id and skips entries that are not files', () => {
    expect(
      parseLsTree(
        [
          '100644 blob aaa1\tsupabase/migrations/20260603000000_feature_flags.sql',
          '040000 tree ddd4\tsupabase/migrations/archive',
          '100644 blob bbb2\tsupabase/migrations/20260604100000_permissions_schema.sql',
          '',
        ].join('\n'),
      ),
    ).toEqual(
      new Map([
        ['20260603000000_feature_flags.sql', 'aaa1'],
        ['20260604100000_permissions_schema.sql', 'bbb2'],
      ]),
    );
  });

  it('returns nothing for empty output', () => {
    expect(parseLsTree('')).toEqual(new Map());
  });
});
````

- [ ] **Step 3: Run the tests and see them fail**

Run: `npx vitest run tests/check-migration-prefixes.test.ts`

Expected: `Tests  8 failed | 6 passed (14)`, with `TypeError: (0 , findReleasedFileProblems) is not a function` and the same for `parseLsTree`.

- [ ] **Step 4: Implement the rule**

Replace `scripts/check-migration-prefixes.ts` with this. `findPrefixProblems` and its comment are unchanged.

````ts
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const MIGRATIONS_DIR = 'supabase/migrations';
const MIGRATION_NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;
const RELEASED_REF = 'origin/main';

// Two branches can pick the same YYYYMMDDHHMMSS prefix and nothing else
// notices: migrate.sh replays in filename order, so the pair would run in an
// order neither author tested. Non-.sql files are ignored.
export function findPrefixProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  const byPrefix = new Map<string, string[]>();

  for (const name of [...names].sort()) {
    if (!name.endsWith('.sql')) continue;
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      problems.push(`malformed: ${name}`);
      continue;
    }
    const group = byPrefix.get(match[1]) ?? [];
    group.push(name);
    byPrefix.set(match[1], group);
  }

  for (const [prefix, files] of byPrefix) {
    if (files.length > 1) problems.push(`duplicate ${prefix}: ${files.join(', ')}`);
  }

  return problems;
}

export function parseLsTree(stdout: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) blobs.set(match[2].slice(match[2].lastIndexOf('/') + 1), match[1]);
  }
  return blobs;
}

export function findReleasedFileProblems(
  released: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  for (const name of [...released.keys()].sort()) {
    const blob = current.get(name);
    if (blob === undefined) problems.push(`removed after release: ${name}`);
    else if (blob !== released.get(name)) problems.push(`changed after release: ${name}`);
  }
  return problems;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readReleased(): Map<string, string> {
  return parseLsTree(git(['ls-tree', RELEASED_REF, `${MIGRATIONS_DIR}/`]));
}

function readCurrent(names: readonly string[]): Map<string, string> {
  const files = names.filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) return new Map();
  const blobs = git(['hash-object', '--', ...files.map((name) => `${MIGRATIONS_DIR}/${name}`)])
    .trim()
    .split('\n');
  return new Map(files.map((name, index) => [name, blobs[index]]));
}

function main(): void {
  const names = readdirSync(MIGRATIONS_DIR);
  const naming = findPrefixProblems(names);

  let released: Map<string, string>;
  try {
    released = readReleased();
  } catch {
    console.log(
      `❌ ${RELEASED_REF} is not available, so released migration files cannot be compared. Run: git fetch origin main`,
    );
    process.exitCode = 1;
    return;
  }
  const changed = findReleasedFileProblems(released, readCurrent(names));

  if (naming.length === 0 && changed.length === 0) {
    const count = names.filter((n) => n.endsWith('.sql')).length;
    console.log(
      `✅ ${count} migration files in ${MIGRATIONS_DIR}, one timestamp prefix each; the ${released.size} on ${RELEASED_REF} are unchanged.`,
    );
    return;
  }

  if (naming.length > 0) {
    console.log(`❌ ${MIGRATIONS_DIR} has ${naming.length} naming problem(s):\n`);
    for (const p of naming) console.log(`   - ${p}`);
    console.log(
      '\nEach file needs its own YYYYMMDDHHMMSS prefix and a name matching ^\\d{14}_[a-z0-9_]+\\.sql$. Rename the newer file to a later, unused timestamp.',
    );
  }
  if (changed.length > 0) {
    console.log(`❌ ${changed.length} migration file(s) already on ${RELEASED_REF} differ here:\n`);
    for (const p of changed) console.log(`   - ${p}`);
    console.log(
      '\nA file on main is applied to production and is never applied again, so an edit would only reach databases built later. Restore the file and put the change in a new migration.',
    );
  }
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('check-migration-prefixes.ts')) main();
````

- [ ] **Step 5: Run the tests and see them pass**

Run: `npx vitest run tests/check-migration-prefixes.test.ts`

Expected: `Tests  14 passed (14)`.

- [ ] **Step 6: Run the check against the real tree, clean and broken**

```bash
npm run check:migrations
echo "-- probe" >> supabase/migrations/20260603000000_feature_flags.sql
npm run check:migrations; echo "exit=$?"
git checkout -- supabase/migrations/20260603000000_feature_flags.sql
git status --porcelain
```

Expected, in order: a `✅` line ending `the N on origin/main are unchanged.`; then `❌ 1 migration file(s) already on origin/main differ here:` naming `changed after release: 20260603000000_feature_flags.sql` and `exit=1`; then an empty `git status`.

- [ ] **Step 7: Make CI fetch `main` before the check**

In `.github/workflows/ci.yml`, in the `lint` job, replace:

```yaml
      - name: Migration prefixes
        run: npm run check:migrations
```

with:

```yaml
      - name: Migration prefixes and released files
        run: |
          git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main
          npm run check:migrations
```

Do not run that fetch line yourself (Global Constraints).

- [ ] **Step 8: Run the CI gate tests**

Run: `node --test scripts/ci/gates.test.mjs 2>&1 | tail -8`

Expected: `# pass 17`, `# fail 0`. The test `the split dropped no former step` still finds `npm run check:migrations` in a worker.

- [ ] **Step 9: Commit**

```bash
git add scripts/check-migration-prefixes.ts tests/check-migration-prefixes.test.ts .github/workflows/ci.yml
git commit -m "$(cat <<'MSG'
ci(migrations): a migration file on main can never change

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: The `Migrate database` workflow

**Files:**
- Create: `.github/workflows/migrate.yml`
- Create: `scripts/ci/migrate.test.mjs`

**Interfaces:**
- Consumes: `npm run preflight:db -- <env file>` (existing), which reads `DATABASE_URL` from the file.
- Produces: a reusable workflow at `./.github/workflows/migrate.yml` with `workflow_call` inputs `environment` (string) and `ref` (string), both required. Its job id is `migrate` and its job name is `Migrate database`. The step with `id: push` sets the output `applied` to the number of files applied.

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/migrate.test.mjs`:

````js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const migrate = read('migrate.yml');
const ci = read('ci.yml');

const TARGET = "${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || 'db-dev' }}";
const DATABASE_URL = 'postgresql://postgres:pw@db.example:5432/postgres';

const stepShell = (workflow, name) => {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  assert.ok(step, `step "${name}" exists`);
  return step.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
};
const bash = (script, env) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('migrate runs on develop and main pushes, by call and by hand', () => {
  const triggers = migrate.split('\npermissions:')[0];
  assert.match(triggers, /\n  push:\n    branches:\n      - develop\n      - main\n  workflow_call:\n/);
  assert.doesNotMatch(triggers, /paths(-ignore)?:/);
  assert.match(triggers, /\n  workflow_call:\n    inputs:\n      environment:\n        required: true\n        type: string\n      ref:\n        required: true\n        type: string\n/);
  const dispatch = triggers.split('\n  workflow_dispatch:\n')[1];
  for (const environment of ['db-dev', 'db-staging', 'db-production']) assert.ok(dispatch.includes(`\n          - ${environment}\n`), environment);
  assert.match(migrate, /\npermissions:\n  contents: read\n/);
});

test('one job, one target expression, one queue per database', () => {
  assert.match(migrate, /\njobs:\n  migrate:\n    name: Migrate database\n/);
  assert.equal(migrate.split(TARGET).length - 1, 3);
  assert.ok(migrate.includes(`\n    environment: ${TARGET}\n`));
  assert.ok(migrate.includes(`\n      group: migrate-${TARGET}\n      cancel-in-progress: false\n`));
  assert.ok(migrate.includes(`\n          TARGET: ${TARGET}\n`));
});

test('the Supabase CLI version is the one CI applies migrations with', () => {
  const pins = (workflow) => [...workflow.matchAll(/supabase\/setup-cli@v1\n(?:.*\n){0,8}?\s+version: (\S+)\n/g)].map((m) => m[1]);
  assert.equal(pins(migrate).length, 1);
  assert.ok(pins(ci).length >= 1);
  assert.equal(new Set([...pins(ci), ...pins(migrate)]).size, 1, [...pins(ci), ...pins(migrate)].join());
});

test('no run script interpolates an expression, and only db push writes', () => {
  for (const block of migrate.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)) assert.doesNotMatch(block[1], /\$\{\{/);
  assert.doesNotMatch(migrate, /        run: [^|\n]*\$\{\{/);
  assert.doesNotMatch(migrate, /include-seed|include-roles|db reset|migration repair/);
});

const guard = stepShell(migrate, 'Check the target and the approver');
const runGuard = (env) => bash(guard, { TARGET: 'db-dev', MIGRATION_DATABASE_URL: DATABASE_URL, MIGRATION_APPROVERS: '', TRIGGERING_ACTOR: 'someone', ...env });

test('guard: the database URL must be set and safe to write to an env file', () => {
  assert.equal(runGuard({}).status, 0);
  for (const url of ['', "postgresql://u:p'w@h/db", 'postgresql://u:pw@h/db\nX=1', 'postgresql://u:pw@h/db\r']) {
    const out = runGuard({ MIGRATION_DATABASE_URL: url });
    assert.equal(out.status, 1, JSON.stringify(url));
    assert.match(out.stdout, /❌ MIGRATION_DATABASE_URL/);
    assert.doesNotMatch(out.stdout, /add-mask/, 'nothing is echoed for a value that failed validation');
  }
});

test('guard: production needs a listed approver, other databases take anyone when no list is set', () => {
  const production = (approvers, actor) => runGuard({ TARGET: 'db-production', MIGRATION_APPROVERS: approvers, TRIGGERING_ACTOR: actor }).status;
  assert.equal(production('', 'approver-one'), 1);
  assert.equal(production(',', ''), 1);
  assert.equal(production('approver-one', 'approver-one'), 0);
  assert.equal(production('approver-one', 'someone-else'), 1);
  assert.equal(production(' Approver-One , approver-two,', 'approver-one'), 0);
  assert.equal(production('approver-one,approver-two', 'Approver-Two'), 0);
  assert.equal(production('approver-one', 'approver'), 1);
  assert.equal(production('approver-one', ''), 1);
  assert.equal(production('cursorb,cursoro,cursort', 'cursor[bot]'), 1);
  assert.equal(production('cursor[bot]', 'cursor[bot]'), 0);
  assert.equal(runGuard({ TARGET: 'db-dev', MIGRATION_APPROVERS: '', TRIGGERING_ACTOR: 'anyone' }).status, 0);
  assert.equal(runGuard({ TARGET: 'db-dev', MIGRATION_APPROVERS: 'approver-one', TRIGGERING_ACTOR: 'anyone' }).status, 1);
  const refused = runGuard({ TARGET: 'db-production', MIGRATION_APPROVERS: 'approver-one', TRIGGERING_ACTOR: 'someone-else' });
  assert.match(refused.stdout, /someone-else is not in MIGRATION_APPROVERS for db-production/);
});

const apply = stepShell(migrate, 'Apply pending migrations');
const runApply = (t, { before = '', after = '', tables = '0', pushExit = 0 }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-apply-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = bash(`
    psql() {
      case "$*" in
        *pg_tables*) printf '%s\\n' "$TABLES" ;;
        *) if [ -f "$RUNNER_TEMP/called" ]; then printf '%s' "$AFTER"; else : > "$RUNNER_TEMP/called"; printf '%s' "$BEFORE"; fi ;;
      esac
    }
    supabase() { printf 'supabase %s\\n' "$*"; return "$PUSH_EXIT"; }
    ${apply}
  `, {
    MIGRATION_DATABASE_URL: DATABASE_URL,
    BEFORE: before,
    AFTER: after,
    TABLES: tables,
    PUSH_EXIT: String(pushExit),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    RUNNER_TEMP: dir,
  });
  const file = (name) => {
    try {
      return readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return { status: run.status, stdout: run.stdout, output: file('output'), summary: file('summary') };
};

test('apply: a schema with an empty ledger is refused before any push', (t) => {
  const out = runApply(t, { before: '', tables: '80' });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /80 tables in public and an empty migration ledger/);
  assert.doesNotMatch(out.stdout, /supabase db push/);
});

test('apply: an empty database is built from the first file', (t) => {
  const out = runApply(t, { before: '', tables: '0', after: '20260101000000_a\n20260102000000_b' });
  assert.equal(out.status, 0);
  assert.ok(out.stdout.includes(`supabase db push --include-all --skip-vault --yes --db-url ${DATABASE_URL}\n`));
  assert.equal(out.output, 'applied=2\n');
});

test('apply: reports exactly the files the push added, an older timestamp included', (t) => {
  const out = runApply(t, {
    before: '20260101000000_a\n20260103000000_c',
    after: '20260101000000_a\n20260102000000_b\n20260103000000_c\n20260104000000_d',
  });
  assert.equal(out.status, 0);
  assert.equal(out.output, 'applied=2\n');
  assert.equal(out.summary, '### Migrations applied: 2\n\n- `20260102000000_b.sql`\n- `20260104000000_d.sql`\n');
});

test('apply: nothing pending reports zero', (t) => {
  const ledger = '20260101000000_a\n20260102000000_b';
  const out = runApply(t, { before: ledger, after: ledger });
  assert.equal(out.status, 0);
  assert.equal(out.output, 'applied=0\n');
  assert.equal(out.summary, '### Migrations applied: 0\n\n');
});

test('apply: a push that fails partway stays red and still reports what it applied', (t) => {
  const out = runApply(t, { before: '20260101000000_a', after: '20260101000000_a\n20260102000000_b', pushExit: 1 });
  assert.equal(out.status, 1);
  assert.equal(out.output, 'applied=1\n');
  assert.ok(out.summary.includes('- `20260102000000_b.sql`\n'));
});

test('preflight runs when the ledger grew, and always outside a push', () => {
  const gate = "        if: ${{ steps.push.outputs.applied != '0' || github.event_name != 'push' }}\n";
  for (const name of ['Setup Node', 'Install dependencies (no install scripts)', 'preflight:db against the migrated database']) {
    assert.ok(migrate.split(`      - name: ${name}\n`)[1].startsWith(gate), name);
  }
  assert.match(migrate, /\n        id: push\n/);
});
````

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test scripts/ci/migrate.test.mjs 2>&1 | tail -12`

Expected: `# pass 0`, with `ENOENT: no such file or directory, open '.../.github/workflows/migrate.yml'`.

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/migrate.yml`:

````yaml
name: Migrate database

on:
  push:
    branches:
      - develop
      - main
  workflow_call:
    inputs:
      environment:
        required: true
        type: string
      ref:
        required: true
        type: string
  workflow_dispatch:
    inputs:
      environment:
        description: Database to migrate
        required: true
        type: choice
        options:
          - db-dev
          - db-staging
          - db-production
      ref:
        description: Branch, tag or commit whose migrations are applied
        required: true
        type: string

permissions:
  contents: read

jobs:
  migrate:
    name: Migrate database
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: ${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || 'db-dev' }}
    concurrency:
      group: migrate-${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || 'db-dev' }}
      cancel-in-progress: false
    steps:
      - name: Check the target and the approver
        env:
          TARGET: ${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || 'db-dev' }}
          MIGRATION_DATABASE_URL: ${{ secrets.MIGRATION_DATABASE_URL }}
          MIGRATION_APPROVERS: ${{ vars.MIGRATION_APPROVERS }}
          TRIGGERING_ACTOR: ${{ github.triggering_actor }}
        run: |
          set -euo pipefail
          if [ -z "${MIGRATION_DATABASE_URL}" ]; then
            echo "❌ MIGRATION_DATABASE_URL is not set on environment ${TARGET}."
            exit 1
          fi
          case "${MIGRATION_DATABASE_URL}" in
            *"'"*|*$'\n'*|*$'\r'*)
              echo "❌ MIGRATION_DATABASE_URL on ${TARGET} contains a quote or a line break. Percent-encode it."
              exit 1
              ;;
          esac
          echo "::add-mask::${MIGRATION_DATABASE_URL}"
          approvers="$(printf '%s' "${MIGRATION_APPROVERS}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
          actor="$(printf '%s' "${TRIGGERING_ACTOR}" | tr '[:upper:]' '[:lower:]')"
          if [ -z "${approvers//,/}" ]; then
            if [ "${TARGET}" = "db-production" ]; then
              echo "❌ MIGRATION_APPROVERS is not set on environment db-production."
              exit 1
            fi
            exit 0
          fi
          if [ -z "${actor}" ] || [[ ",${approvers}," != *",${actor},"* ]]; then
            echo "❌ ${TRIGGERING_ACTOR} is not in MIGRATION_APPROVERS for ${TARGET}. An approver takes this run over with Re-run failed jobs."
            exit 1
          fi

      - name: Checkout the commit to migrate from
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref || github.sha }}
          persist-credentials: false

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: 2.116.0

      - name: Apply pending migrations
        id: push
        env:
          MIGRATION_DATABASE_URL: ${{ secrets.MIGRATION_DATABASE_URL }}
        run: |
          set -euo pipefail
          ledger() {
            psql -X -At "${MIGRATION_DATABASE_URL}" -v ON_ERROR_STOP=1 \
              -c "select version || '_' || coalesce(name, '') from supabase_migrations.schema_migrations order by version" 2>/dev/null || true
          }
          before="$(ledger)"
          if [ -z "${before}" ]; then
            tables="$(psql -X -At "${MIGRATION_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "select count(*) from pg_tables where schemaname = 'public'")"
            if [ "${tables}" != "0" ]; then
              echo "❌ This database has ${tables} tables in public and an empty migration ledger. Baseline the ledger first: docs/04-operations/production-bootstrap.md."
              exit 1
            fi
          fi
          report() {
            local applied count
            applied="$(LC_ALL=C comm -13 <(printf '%s\n' "${before}") <(ledger) || true)"
            count="$(printf '%s\n' "${applied}" | grep -c . || true)"
            echo "applied=${count}" >> "$GITHUB_OUTPUT"
            {
              echo "### Migrations applied: ${count}"
              echo
              if [ "${count}" != "0" ]; then
                while IFS= read -r line; do echo "- \`${line}.sql\`"; done <<< "${applied}"
              fi
            } >> "$GITHUB_STEP_SUMMARY"
          }
          trap report EXIT
          supabase db push --include-all --skip-vault --yes --db-url "${MIGRATION_DATABASE_URL}"

      - name: Setup Node
        if: ${{ steps.push.outputs.applied != '0' || github.event_name != 'push' }}
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - name: Install dependencies (no install scripts)
        if: ${{ steps.push.outputs.applied != '0' || github.event_name != 'push' }}
        run: npm ci --no-audit --ignore-scripts

      - name: preflight:db against the migrated database
        if: ${{ steps.push.outputs.applied != '0' || github.event_name != 'push' }}
        env:
          MIGRATION_DATABASE_URL: ${{ secrets.MIGRATION_DATABASE_URL }}
        run: |
          set -euo pipefail
          umask 077
          env_file="$(mktemp "${RUNNER_TEMP}/migrate-db.XXXXXX")"
          trap 'rm -f "${env_file}"' EXIT
          printf "DATABASE_URL='%s'\n" "${MIGRATION_DATABASE_URL}" > "${env_file}"
          npm run preflight:db -- "${env_file}"
````

The target expression appears three times on purpose: `environment`, `concurrency` and `env` cannot read one another. The test `one job, one target expression, one queue per database` keeps the three identical.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test scripts/ci/migrate.test.mjs 2>&1 | tail -8`

Expected: `# pass 12`, `# fail 0`.

- [ ] **Step 5: Lint the workflow**

Run: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color=false .github/workflows/migrate.yml; echo "exit=$?"`

Expected: no findings and `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/migrate.yml scripts/ci/migrate.test.mjs
git commit -m "$(cat <<'MSG'
ci(migrate): migrate hosted databases from a ledger, in a workflow of its own

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: The production promotion migrates, moves `main`, then tags

**Files:**
- Modify: `.github/workflows/promote-staging-to-main.yml` (whole file)
- Modify: `.github/workflows/promote-develop-to-staging.yml` (header comment and the `Pin develop and list what it adds` step)
- Create: `scripts/ci/promote.test.mjs`
- Modify: `scripts/ci/gates.test.mjs` (one assertion in `staging promotion requires develop checks on the pinned commit, then fast-forwards`)

**Interfaces:**
- Consumes: `./.github/workflows/migrate.yml` with inputs `environment` and `ref` (Task 2).
- Produces: `Promote staging to main` takes a `bump` input (`minor` or `patch`, default `minor`). Its `plan` job outputs `sha`, `previous`, `migrations` and `version`. Jobs run in the order `plan`, `migrate`, `fast-forward`, `release`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/promote.test.mjs`:

````js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const promote = read('promote-staging-to-main.yml');
const staging = read('promote-develop-to-staging.yml');

const stepShell = (workflow, name) => {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  assert.ok(step, `step "${name}" exists`);
  return step.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
};
const jobBlock = (workflow, id) => workflow.split(`\n  ${id}:\n`)[1].split(/\n  [\w-]+:\n/)[0];
const jobNeeds = (workflow, id) => {
  const needs = `\n${jobBlock(workflow, id)}`.match(/\n    needs: (?:\[([^\]]+)\]|(\S+))\n/);
  return needs ? (needs[1] ?? needs[2]).split(/,\s*/) : [];
};
const bash = (script, env) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('production promotion migrates, then moves main, then tags', () => {
  assert.deepEqual(jobNeeds(promote, 'migrate'), ['plan']);
  assert.deepEqual(jobNeeds(promote, 'fast-forward'), ['plan', 'migrate']);
  assert.deepEqual(jobNeeds(promote, 'release'), ['plan', 'fast-forward']);
  assert.ok(jobBlock(promote, 'migrate').includes('    uses: ./.github/workflows/migrate.yml\n    with:\n      environment: db-production\n      ref: ${{ needs.plan.outputs.sha }}\n'));
  assert.doesNotMatch(promote, /production-db|PRODUCTION_DATABASE_URL/);
  assert.match(promote, /\n      bump:\n[\s\S]*?\n        default: minor\n        options:\n          - minor\n          - patch\n/);
});

test('an empty promotion stops in plan', () => {
  const shell = stepShell(promote, 'Refuse an empty promotion');
  assert.equal(bash(shell, { SHA: 'aaa', MAIN_SHA: 'bbb' }).status, 0);
  const same = bash(shell, { SHA: 'aaa', MAIN_SHA: 'aaa' });
  assert.equal(same.status, 1);
  assert.match(same.stdout, /nothing to promote/);
});

test('the next version is the previous tag bumped, and never a tag that exists', (t) => {
  const shell = stepShell(promote, 'Compute the next version');
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-version-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const next = (previous, bump, tagExists = false) => {
    const output = path.join(dir, `${previous}-${bump}-${tagExists}`);
    const run = bash(`git() { return ${tagExists ? 0 : 1}; }\n${shell}`, { PREVIOUS: previous, BUMP: bump, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(dir, 'summary') });
    return run.status === 0 ? readFileSync(output, 'utf8') : run.stdout;
  };
  assert.equal(next('v0.7.0', 'minor'), 'version=v0.8.0\n');
  assert.equal(next('v0.7.0', 'patch'), 'version=v0.7.1\n');
  assert.equal(next('v0.9.9', 'minor'), 'version=v0.10.0\n');
  assert.equal(next('v1.12.9', 'patch'), 'version=v1.12.10\n');
  for (const previous of ['', '0.7.0', 'v0.7', 'v0.7.0-rc1', 'v0.07.0', 'backup/pre-author-rewrite']) assert.match(next(previous, 'minor'), /is not vX\.Y\.Z/, previous);
  assert.match(next('v0.7.0', 'major'), /Unknown bump 'major'/);
  assert.match(next('v0.7.0', 'minor', true), /v0\.8\.0 already exists/);
});

test('the release is created at the promoted commit, migrations first, then the generated notes', () => {
  const shell = stepShell(promote, 'Tag the promoted commit and publish its notes');
  const run = (migrations) => bash(`gh() { printf '[%s]\\n' "$@"; }\n${shell}`, { REPO: 'Conductia/Conductia', SHA: 'abc123', VERSION: 'v0.8.0', PREVIOUS: 'v0.7.0', MIGRATIONS: migrations });
  const withFiles = run('supabase/migrations/20261008120000_a.sql\nsupabase/migrations/20261008130000_b.sql');
  assert.equal(withFiles.status, 0, withFiles.stderr);
  assert.ok(withFiles.stdout.startsWith('[release]\n[create]\n[v0.8.0]\n[--repo]\n[Conductia/Conductia]\n[--target]\n[abc123]\n[--title]\n[v0.8.0]\n[--notes]\n'));
  assert.ok(withFiles.stdout.includes('[## Migrations applied\n\n- `supabase/migrations/20261008120000_a.sql`\n- `supabase/migrations/20261008130000_b.sql`]\n[--generate-notes]\n[--notes-start-tag]\n[v0.7.0]\n'));
  assert.ok(run('').stdout.includes('[## Migrations applied\n\nNone.]\n'));
});

test('no run script in either promotion interpolates an expression', () => {
  for (const workflow of [promote, staging]) {
    for (const block of workflow.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)) assert.doesNotMatch(block[1], /\$\{\{/);
    assert.doesNotMatch(workflow, /        run: [^|\n]*\$\{\{/);
  }
});

test('both promotions list the migration files they add', () => {
  assert.ok(stepShell(promote, 'Pin staging and list what it adds').includes('git diff --name-only --diff-filter=AMR origin/main.."${sha}" -- supabase/migrations'));
  assert.ok(stepShell(staging, 'Pin develop and list what it adds').includes('git diff --name-only --diff-filter=AMR origin/staging.."${sha}" -- supabase/migrations'));
});
````

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test scripts/ci/promote.test.mjs 2>&1 | grep -E "^not ok|^ok|^# (pass|fail)"`

Expected: `# pass 1`, `# fail 5`. Only `no run script in either promotion interpolates an expression` passes.

- [ ] **Step 3: Replace the production promotion**

Replace `.github/workflows/promote-staging-to-main.yml` with:

````yaml
name: Promote staging to main

# main moves only after production's schema holds this build's migrations.
# plan pins the staging commit and prints what the release contains: commits,
# migration files and the version to tag. migrate applies the pending files to
# production from that commit and runs preflight:db; it goes ahead only for a
# person listed in MIGRATION_APPROVERS on environment db-production.
# fast-forward moves main to exactly that commit; release tags it and
# publishes the notes. A failed or refused migration leaves main where it is.
# staging only ever holds develop commits whose required checks passed on that
# exact commit (Promote develop to staging), so main inherits the same bar.
# Release procedure: docs/03-engineering/delivery-model.md.

on:
  workflow_dispatch:
    inputs:
      bump:
        description: Version bump for this release
        required: true
        type: choice
        default: minor
        options:
          - minor
          - patch

permissions:
  contents: read

concurrency:
  group: promote-main
  cancel-in-progress: false

jobs:
  plan:
    name: Pin the staging commit to promote
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      sha: ${{ steps.pin.outputs.sha }}
      previous: ${{ steps.pin.outputs.previous }}
      migrations: ${{ steps.pin.outputs.migrations }}
      version: ${{ steps.version.outputs.version }}
    steps:
      - name: Checkout staging
        uses: actions/checkout@v4
        with:
          ref: staging
          fetch-depth: 0
          fetch-tags: true
          persist-credentials: false

      - name: Pin staging and list what it adds
        id: pin
        run: |
          set -euo pipefail
          # checkout's fetch-depth: 0 already fetched every branch into
          # origin/*. No second fetch: persist-credentials is off, so it would
          # run unauthenticated and fail on this private repo.
          sha="$(git rev-parse origin/staging)"
          main_sha="$(git rev-parse origin/main)"
          git merge-base --is-ancestor origin/main "${sha}" \
            || { echo "❌ main is not an ancestor of staging. Land main's extra commits on develop and promote them through staging first."; exit 1; }
          git merge-base --is-ancestor "${sha}" origin/develop \
            || { echo "❌ staging is not an ancestor of develop. staging must only move by Promote develop to staging."; exit 1; }
          previous="$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)" \
            || { echo "❌ No vX.Y.Z tag is reachable from main. Tag the release main holds before promoting."; exit 1; }
          changed="$(git diff --name-only --diff-filter=AMR origin/main.."${sha}" -- supabase/migrations)"
          delimiter="migrations-${sha}"
          {
            echo "sha=${sha}"
            echo "main_sha=${main_sha}"
            echo "previous=${previous}"
            echo "migrations<<${delimiter}"
            echo "${changed}"
            echo "${delimiter}"
          } >> "$GITHUB_OUTPUT"
          {
            echo "### Promoting staging @ ${sha:0:7}"
            echo
            echo "Commits this adds to main, since ${previous}:"
            echo
            git log --no-decorate --format='- %s' origin/main.."${sha}"
            echo
            if [ -z "${changed}" ]; then
              echo "No migration files added or changed since main."
            else
              echo "Migrations this applies to production, in order:"
              echo
              while IFS= read -r file; do echo "- \`${file}\`"; done <<< "${changed}"
            fi
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Refuse an empty promotion
        env:
          SHA: ${{ steps.pin.outputs.sha }}
          MAIN_SHA: ${{ steps.pin.outputs.main_sha }}
        run: |
          set -euo pipefail
          if [ "${SHA}" = "${MAIN_SHA}" ]; then
            echo "❌ staging and main are the same commit. There is nothing to promote."
            exit 1
          fi

      - name: Compute the next version
        id: version
        env:
          PREVIOUS: ${{ steps.pin.outputs.previous }}
          BUMP: ${{ inputs.bump }}
        run: |
          set -euo pipefail
          if ! [[ "${PREVIOUS}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
            echo "❌ The previous tag '${PREVIOUS}' is not vX.Y.Z."
            exit 1
          fi
          major="${BASH_REMATCH[1]}"
          minor="${BASH_REMATCH[2]}"
          patch="${BASH_REMATCH[3]}"
          case "${BUMP}" in
            minor) version="v${major}.$((minor + 1)).0" ;;
            patch) version="v${major}.${minor}.$((patch + 1))" ;;
            *)
              echo "❌ Unknown bump '${BUMP}'. Use minor or patch."
              exit 1
              ;;
          esac
          if git rev-parse --quiet --verify "refs/tags/${version}" >/dev/null; then
            echo "❌ ${version} already exists. Check the tags before promoting again."
            exit 1
          fi
          echo "version=${version}" >> "$GITHUB_OUTPUT"
          echo "This promotion will be tagged **${version}** (previous: ${PREVIOUS})." >> "$GITHUB_STEP_SUMMARY"

  migrate:
    name: Migrate production
    needs: plan
    uses: ./.github/workflows/migrate.yml
    with:
      environment: db-production
      ref: ${{ needs.plan.outputs.sha }}

  fast-forward:
    name: Fast-forward main to staging
    needs: [plan, migrate]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: main

      - name: Fast-forward main to the pinned commit
        env:
          SHA: ${{ needs.plan.outputs.sha }}
        run: |
          set -euo pipefail
          git fetch --no-tags origin main staging
          git checkout main
          git merge --ff-only "${SHA}"
          git push origin main

  release:
    name: Tag and publish the release
    needs: [plan, fast-forward]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: write
    steps:
      - name: Tag the promoted commit and publish its notes
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          SHA: ${{ needs.plan.outputs.sha }}
          VERSION: ${{ needs.plan.outputs.version }}
          PREVIOUS: ${{ needs.plan.outputs.previous }}
          MIGRATIONS: ${{ needs.plan.outputs.migrations }}
        run: |
          set -euo pipefail
          notes="$(
            echo "## Migrations applied"
            echo
            if [ -z "${MIGRATIONS}" ]; then
              echo "None."
            else
              while IFS= read -r file; do echo "- \`${file}\`"; done <<< "${MIGRATIONS}"
            fi
          )"
          gh release create "${VERSION}" --repo "${REPO}" --target "${SHA}" --title "${VERSION}" \
            --notes "${notes}" --generate-notes --notes-start-tag "${PREVIOUS}"
````

`gh release create` creates the tag at `--target` when it does not exist, so no separate tag push is needed. The header comment and the comment inside `Pin staging and list what it adds` are the existing ones, corrected where the flow changed.

- [ ] **Step 4: List migrations in the staging promotion**

Replace `.github/workflows/promote-develop-to-staging.yml` with:

````yaml
name: Promote develop to staging

# staging moves only to a develop commit whose required checks all passed on
# that exact commit. develop merges without re-testing every open PR against
# the latest develop (its ruleset is not strict), so the push run on develop is
# the first test of the combined result; this is where that result gates.
# plan pins develop and requires the develop ruleset's checks green on it;
# fast-forward moves staging to exactly that commit. Anything missing, pending
# or red leaves staging where it is.
#
# staging uses the development database for now, which every push to develop
# already migrates (migrate.yml), so nothing is migrated here. When staging
# gets its own Supabase project, add a migrate job that calls migrate.yml with
# environment db-staging, and make fast-forward need it.
# Release procedure: docs/03-engineering/delivery-model.md.

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: promote-staging
  cancel-in-progress: false

jobs:
  plan:
    name: Pin a green develop commit
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      checks: read
    outputs:
      sha: ${{ steps.pin.outputs.sha }}
    steps:
      - name: Checkout develop
        uses: actions/checkout@v4
        with:
          ref: develop
          fetch-depth: 0
          persist-credentials: false

      - name: Pin develop and list what it adds
        id: pin
        run: |
          set -euo pipefail
          # checkout's fetch-depth: 0 already fetched every branch into
          # origin/*. No second fetch: persist-credentials is off, so it would
          # run unauthenticated and fail on this private repo.
          sha="$(git rev-parse origin/develop)"
          git merge-base --is-ancestor origin/staging "${sha}" \
            || { echo "❌ staging is not an ancestor of develop. staging must only move by this workflow."; exit 1; }
          changed="$(git diff --name-only --diff-filter=AMR origin/staging.."${sha}" -- supabase/migrations)"
          echo "sha=${sha}" >> "$GITHUB_OUTPUT"
          {
            echo "### Promoting develop @ ${sha:0:7} to staging"
            echo
            echo '```'
            git log --oneline --no-decorate origin/staging.."${sha}"
            echo '```'
            echo
            if [ -z "${changed}" ]; then
              echo "No migration files added or changed since staging."
            else
              echo "Migration files this adds:"
              echo
              while IFS= read -r file; do echo "- \`${file}\`"; done <<< "${changed}"
            fi
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Require the develop checks green on the pinned commit
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          SHA: ${{ steps.pin.outputs.sha }}
        run: |
          set -euo pipefail
          git checkout --quiet "${SHA}"
          gh api --paginate "repos/${REPO}/commits/${SHA}/check-runs?per_page=100" \
            --jq '.check_runs[] | {id, name, status, conclusion}' > "${RUNNER_TEMP}/check-runs.jsonl"
          if ! node scripts/ci/required-checks.mjs < "${RUNNER_TEMP}/check-runs.jsonl"; then
            echo "❌ develop @ ${SHA:0:7} is not green. Wait for CI on develop to finish, or revert the breaking merge, then re-run."
            exit 1
          fi

  fast-forward:
    name: Fast-forward staging to develop
    needs: plan
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: staging

      - name: Fast-forward staging to the pinned commit
        env:
          SHA: ${{ needs.plan.outputs.sha }}
        run: |
          set -euo pipefail
          git fetch --no-tags origin staging develop
          git checkout staging
          git merge --ff-only "${SHA}"
          git push origin staging
````

Two things changed from the current file: the header comment's last paragraph, and the `Pin develop and list what it adds` step, which now computes `changed` and prints it.

- [ ] **Step 5: Update the existing gate assertion**

In `scripts/ci/gates.test.mjs`, replace:

```js
  assert.match(release, /environment: production-db/);
```

with:

```js
  assert.match(release, /uses: \.\/\.github\/workflows\/migrate\.yml\n    with:\n      environment: db-production\n/);
```

- [ ] **Step 6: Run every workflow test and see it pass**

Run: `node --test scripts/ci/*.test.mjs 2>&1 | tail -8`

Expected: `# fail 0`. Per file: `promote.test.mjs` 6, `migrate.test.mjs` 12, `gates.test.mjs` 17, plus the existing `docs-only` and `required-checks` suites.

- [ ] **Step 7: Lint the workflows**

Run: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color=false .github/workflows/migrate.yml .github/workflows/promote-staging-to-main.yml .github/workflows/promote-develop-to-staging.yml .github/workflows/ci.yml; echo "exit=$?"`

Expected: no findings and `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/promote-staging-to-main.yml .github/workflows/promote-develop-to-staging.yml scripts/ci/promote.test.mjs scripts/ci/gates.test.mjs
git commit -m "$(cat <<'MSG'
ci(release): the production promotion migrates, moves main, then tags the release

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/03-engineering/delivery-model.md`
- Modify: `docs/04-operations/production-bootstrap.md`
- Modify: `scripts/migrate.sh` (header comment)
- Modify: `docs/07-decisions/decision-log.md` (append row D84)

**Interfaces:**
- Consumes: the names fixed in Global Constraints and the behaviour built in Tasks 1 to 3.
- Produces: nothing other tasks read.

Each edit below gives the exact text to find. Every "find" text occurs exactly once in its file at `3a527442a`.

- [ ] **Step 1: `delivery-model.md`, the merge policy row**

Find:

```markdown
| **`staging` → `main`** | **Fast-forward only**, with the **Promote staging to main** Action, which checks production's schema first; see [Releases and tags](#releases-and-tags). |
```

Replace with:

```markdown
| **`staging` → `main`** | **Fast-forward only**, with the **Promote staging to main** Action, which migrates production first and tags the release after; see [Releases and tags](#releases-and-tags). |
```

- [ ] **Step 2: `delivery-model.md`, the manual fast-forward**

Find:

```markdown
Before a manual fast-forward, apply the release's migrations as below, run `npm run preflight:db .env.production` and confirm it is green, and record in the release notes who bypassed the Action, why, and which migrations were applied.
```

Replace with:

```markdown
Before a manual fast-forward, run **Actions → Migrate database → Run workflow** from `main`, with `db-production` and the commit about to be promoted, and wait for it to go green: it applies that commit's pending migrations and runs `preflight:db`. Record in the release notes who bypassed the Action and why.
```

- [ ] **Step 3: `delivery-model.md`, migration rules**

Find the end of the "Migrations in a PR" list:

```markdown
`Phase 1 integration test (local Supabase)` rebuilds the file the same way and fails when the committed copy differs.

PRs targeting `main` are checked by
```

Insert three bullets between those two paragraphs, so it reads:

```markdown
`Phase 1 integration test (local Supabase)` rebuilds the file the same way and fails when the committed copy differs.
- Never edit or delete a migration file that is already on `main`. It is applied to production and never applied again, so the edit would only reach databases built later. `npm run check:migrations` compares every file on `origin/main` with the branch and fails on any difference. Put the change in a new file.
- A file that is on `develop` but not yet on `main` is edited only to repair one that failed on a hosted database. If it already applied to dev, the edit will not reach dev.
- A revert keeps the migration file the reverted PR added: `git revert -n <sha>`, then `git checkout HEAD -- supabase/migrations supabase/schema-snapshot.txt`, then commit. Deleting an applied file makes every later **Migrate database** run on that database refuse, until someone runs `supabase migration repair --status reverted <version>` against it.

PRs targeting `main` are checked by
```

- [ ] **Step 4: `delivery-model.md`, a section for dev**

Find the heading line `## Merge policy` and insert this section directly above it:

```markdown
### Migrations on `develop`

Every push to `develop` also runs **Migrate database** (`.github/workflows/migrate.yml`) against the dev database. It is a workflow of its own: it does not wait for CI and it is not part of the Vercel deployment. It applies the files the database's ledger (`supabase_migrations.schema_migrations`) does not hold yet, with the Supabase CLI version CI uses, and lists them in its run summary. A push with nothing to apply finishes in seconds.

A red run means dev is behind `develop`. Read the failing file in the log and fix it on a new PR. A file that fails leaves nothing behind, and the files before it stay applied.

Hosted schemas change only through this workflow. SQL applied to a hosted database by hand, in the SQL editor or through a connector, is not in the ledger, and the next run either refuses or applies it a second time.

```

- [ ] **Step 5: `delivery-model.md`, releases**

Replace everything between the heading `## Releases and tags` and the heading `## Schema changes: expand, then contract` with:

```markdown

`main` is promoted from `staging` by fast-forward, and the promotion tags it `vX.Y.Z` and publishes the GitHub release (`v0.5.0` MVP cut Sep 3, `v0.5.5` Sep 4, `v0.5.6` Labor Day beta Sep 7, `v0.6.0` one tenant per firm Sep 15). The tag is the version: `package.json` `version` is not bumped. Production deploys from `main` (Vercel), so a release's migrations reach the production database before `main` moves. A release is one Action run:

1. **Actions → Promote staging to main → Run workflow**, from `main`. Choose `patch` for a release of fixes only; the default is `minor`.
2. *Pin the staging commit to promote* pins the commit and writes to its summary the commits the release adds to `main`, the migration files it applies and the version it will tag. It stops here when `staging` and `main` are the same commit, or when that version already exists.
3. *Migrate database* applies the pending files to production from the pinned commit, with `supabase db push --include-all`, then runs `preflight:db`. It goes ahead only when the person who started or re-ran the run is listed in `MIGRATION_APPROVERS` on the `db-production` environment. For anyone else it stops before touching the database, and an approver who has read the summary takes it over with **Re-run failed jobs**.
4. Green: `main` fast-forwards to exactly the pinned commit and Vercel deploys it, then *Tag and publish the release* creates the tag and the release. Its notes list the migrations applied, then every PR since the previous tag. Red: `main` does not move. The file that failed left nothing behind and the files before it stay applied; fix forward on `develop` and promote again.

The approver list guards against accidents. It is not a security boundary: the `main` ruleset does not require a pull request, so anyone with write access can push to `main`. GitHub's required reviewers are not available for a private repository on the Team plan.

The one-time setup of the environments, their secrets, the approver list and the ledger baseline is in `../04-operations/production-bootstrap.md`.

```

- [ ] **Step 6: `production-bootstrap.md`, no more hand application**

Find:

````markdown
A replay stops at the first failure, and every file before it has been
re-applied. Against a live database, apply only the release's new files, one
transaction each, in the order the promotion lists them
(`../03-engineering/delivery-model.md`, Releases and tags):

```bash
psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/<file>.sql
```
````

Replace with:

```markdown
A replay stops at the first failure, and every file before it has been
re-applied. A live database is never replayed and never migrated by hand:
**Migrate database** applies only the files its ledger does not hold
(`../03-engineering/delivery-model.md`). A new empty database is built by the
same Action (A new database, below), which also writes the ledger.
`scripts/migrate.sh` writes none.
```

- [ ] **Step 7: `production-bootstrap.md`, the environments**

Replace everything from the heading `### The promotion gate` up to, but not including, the heading `## 2. What the migrations do and do not create` with:

````markdown
### The migration environments

Hosted databases are migrated only by the **Migrate database** Action
(`.github/workflows/migrate.yml`). It reaches each database through a GitHub
environment. Set them up once, as an owner of both the Supabase organization
and the GitHub repository.

| Environment | Database | Deployment branches | `MIGRATION_APPROVERS` |
|---|---|---|---|
| `db-dev` | Conductia-dev | `develop` | not set: anyone |
| `db-staging` | the staging project, once it exists | `staging`, `main` | not set: anyone |
| `db-production` | production | `main` | the GitHub logins allowed to migrate production, comma-separated |

1. **Create the environment** under **Settings → Environments**, with
   **Deployment branches and tags** set to *Selected branches and tags* and the
   branches above. `db-staging` allows `main` because the Promote Actions run
   from `main`. Do not name one `production`: names are case-insensitive and
   Vercel owns `Production`.
2. **Set `MIGRATION_APPROVERS`** as an environment variable on `db-production`
   before anything else. The Action refuses to migrate production while it is
   empty, and for any person not on it. Required reviewers are not available
   for a private repository on the Team plan, so this list is the gate. It
   guards against accidents; it is not a security boundary.
3. **Baseline the database's ledger** (below). Skip this for a database that
   is empty.
4. **Add the secret last.** `MIGRATION_DATABASE_URL` is the environment secret
   holding the **Connect → Session pooler (IPv4)** string for the `postgres`
   user (`postgres.<project-ref>`), with the password percent-encoded. GitHub
   runners have no IPv6. Never add it at repository or organization level.
   Until it exists the Action fails before it touches the database, so adding
   it last is what keeps an unbaselined database from being migrated.

Supabase network restrictions refuse GitHub runners, so every run fails closed
while they are on. In Vercel, the Preview environment must point at the dev
project; a preview on the production database would bypass the promotion.

Rotate by resetting the database password in Supabase and updating the secret.

#### Baselining a ledger

A database migrated by hand has the schema and no record of which files built
it. The Action refuses such a database, because a push would replay every file
over it. Record the files once, from a machine that holds the connection
string, never from CI:

```bash
git fetch origin
git checkout --detach origin/main        # production. For dev: origin/develop
npm ci
export DB_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres'

env_file="$(mktemp)" && printf "DATABASE_URL='%s'\n" "$DB_URL" > "$env_file"
npm run preflight:db -- "$env_file"; rm -f "$env_file"

npx supabase@2.116.0 migration list --db-url "$DB_URL"
npx supabase@2.116.0 migration repair --status applied --db-url "$DB_URL"
npx supabase@2.116.0 db push --include-all --dry-run --db-url "$DB_URL"
```

- `preflight:db` must be green first: it proves the database holds what this
  commit's migrations build. If it names missing objects, those files are not
  applied. Pass every other version to `migration repair --status applied`
  explicitly and leave the missing ones out; the Action's first run applies
  them.
- `migration list` shows what the ledger holds now. A remote version with no
  local file was recorded by another tool: remove it with
  `migration repair --status reverted <version>`.
- `migration repair --status applied` with no version records every local
  file. It writes ledger rows only and changes no schema.
- The dry run must answer `Remote database is up to date.` Only then add the
  secret.

Rehearsed on 2026-10-09 with CLI 2.116.0 against a local database whose ledger
had been emptied: every file was recorded and the dry run listed nothing.

#### A new database

An empty project needs no baseline. Create its environment and secret, then
run **Actions → Migrate database → Run workflow** from `main`, with that
environment and `develop` as the ref. The push builds the whole schema and
writes the ledger. Rehearsed locally, the result matches
`supabase/schema-snapshot.txt` exactly.

````

- [ ] **Step 8: `production-bootstrap.md`, the later reference**

Find:

```markdown
After go-live the promotion runs the schema preflight itself (step 1, The
promotion gate). Run it by hand before any manual fast-forward of `main`.
```

Replace with:

```markdown
After go-live **Migrate database** runs the schema preflight itself (step 1,
The migration environments). Before a manual fast-forward of `main`, run it by
hand against production (`../03-engineering/delivery-model.md`, Merge policy).
```

- [ ] **Step 9: `scripts/migrate.sh`, the header**

Find:

```bash
# A full replay fails partway and leaves the earlier files re-applied. For
# production, apply only the release's new files, one transaction each
# (docs/04-operations/production-bootstrap.md):
#
#   psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f <file>
```

Replace with:

```bash
# A full replay fails partway and leaves the earlier files re-applied, and it
# writes no ledger. Hosted databases are migrated by the Migrate database
# workflow (.github/workflows/migrate.yml), never by this script
# (docs/04-operations/production-bootstrap.md).
```

- [ ] **Step 10: The decision log**

Run `tail -1 docs/07-decisions/decision-log.md | cut -c1-8` and use the next free number in the row below and in the commit message. During execution `develop` took D82 and D83 first, so this row landed as D84.

Append this single line to the end of `docs/07-decisions/decision-log.md`:

```markdown
| D84 | 2026-10-09 | **Hosted migrations run from a ledger in a workflow of their own, and a release tags itself** (Proposed; spec `docs/superpowers/specs/2026-10-08-automatic-migrations-and-releases-design.md`). Hosted databases adopt the Supabase CLI ledger and change only through the *Migrate database* Action (`supabase db push --include-all`): on every push to `develop` for dev, and inside *Promote staging to main* for production, before `main` moves. Production goes ahead only for a login in `MIGRATION_APPROVERS` on the `db-production` environment, one person for now. The promotion then tags `vX.Y.Z` and publishes generated notes; `package.json` is no longer bumped. A migration file on `main` can never change. Staging gets its own Supabase project. Amends D64 (the production preflight behind a required reviewer). | v0.7.0 took 55 migrations applied by hand over about 90 minutes and shipped with no tag and no release (#379, #398). Neither Promote Action had ever run: the `production-db` gate needs required reviewers, which GitHub does not offer for a private repository on the Team plan. The CLI behaviours were rehearsed on a local database with CLI 2.116.0 before the design was fixed. |
```

- [ ] **Step 11: Check nothing stale is left**

Run:

```bash
grep -rnE "production-db|preflight_reader|release-approvers|PRODUCTION_DATABASE_URL" --exclude='*.test.mjs' .github scripts docs/03-engineering docs/04-operations
grep -nE "psql -X|by hand, in the listed order" docs/03-engineering/delivery-model.md docs/04-operations/production-bootstrap.md scripts/migrate.sh
node --test scripts/ci/docs-only.test.mjs 2>&1 | tail -4
```

Expected: both `grep` commands print nothing, and the docs-only suite reports `# fail 0`.

- [ ] **Step 12: Commit**

```bash
git add docs/03-engineering/delivery-model.md docs/04-operations/production-bootstrap.md scripts/migrate.sh docs/07-decisions/decision-log.md
git commit -m "$(cat <<'MSG'
docs(delivery): migrations by workflow, releases that tag themselves (D84)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: Verify the whole change and open the PR

**Files:** none changed, unless a check fails.

**Interfaces:**
- Consumes: everything above.
- Produces: a PR against `develop`.

- [ ] **Step 1: Rebase and run every local check**

```bash
git fetch origin
git rebase origin/develop
npm ci
npm run lint
npx tsc --noEmit
npm test
node --test scripts/ci/*.test.mjs
npm run check:migrations
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color=false .github/workflows/migrate.yml .github/workflows/promote-staging-to-main.yml .github/workflows/promote-develop-to-staging.yml .github/workflows/ci.yml
```

Expected: every command exits 0. `npm test` may show the known macOS-only failure in `tests/discovery-export.test.ts` (`/private/var`); nothing else may fail.

If the rebase brought in a change to a file this plan edits, re-run that task's tests before going on. The integration and hermetic e2e jobs are not reproduced locally: this change touches no application source and no migration. Say so in the PR.

- [ ] **Step 2: Push and open the PR**

Push with `git push --force-with-lease -u origin improve-git-process`. Write the body with the `pr` skill, from `.github/pull_request_template.md`, change type **chore**. Include:

- what changes for a developer, in three lines: dev migrates on merge, production migrates inside the promotion, the promotion tags and publishes;
- the rehearsal results from the spec's Testing section;
- the local checks run, and that integration and e2e were not run and why;
- a link to `docs/04-operations/production-bootstrap.md` for the owner setup. Do not paste a rollout sequence into the body.

Add the PR to the delivery board with Lane **Chore** and the current weekly milestone.

- [ ] **Step 3: Follow CI**

All four required checks must be green. `Migrate database` does not run on a pull request. After merge, the first `develop` push runs it: green when the owner has finished steps 1 and 2 of Owner setup, red with `MIGRATION_DATABASE_URL is empty for environment db-dev.` when they have not.

---

### Task 6: Create the staging Supabase project

Not code, and no commit. It uses the `supabase-conductia` connector, which Charles authorized for the `Conductia` organization on 2026-10-09. It does not depend on Tasks 1 to 5 and can run at any point.

Read on 2026-10-09:

| | |
|---|---|
| Organization | `Conductia`, id `ygmizxwodvfkxgcwgtdg`, Pro plan |
| Existing projects | `Conductia prod` (`fsaucpwponmzajupvsey`) and `conductia dev` (`sqyjqdjazefceixkjtdp`), both in `us-east-1` on Postgres 17 |
| Cost | Compute is billed by the hour. The Micro size is $0.01344 an hour, about $10 a month. The organization has one $10 compute credit a month in total, not one per project. A paused project is not charged for compute |

**Files:** none.

**Interfaces:**
- Consumes: nothing.
- Produces: the staging project ref. Task 7 writes it into ADR-0007, and the owner needs it for the `db-staging` secret.

Rules for this task:

- Use only these connector tools: `list_projects`, `create_project`, `get_project`, `list_tables`, `list_migrations`.
- Never pass the dev or production project id to any connector tool.
- Never call `apply_migration`, `execute_sql`, `deploy_edge_function` or a branch tool. `apply_migration` records versions of its own, so the ledger would stop matching the files and `supabase db push` would refuse the database.

- [ ] **Step 1: Confirm the project does not exist yet**

Call `list_projects`.

Expected: exactly two projects, `Conductia prod` and `conductia dev`. If a third exists, stop and report it; do not create a second staging project.

- [ ] **Step 2: Get an explicit yes on the cost**

The connector creates the project without asking about cost. Ask Charles in the session to confirm these four things, and wait for a yes:

- name `Conductia staging`
- organization `Conductia`
- region `us-east-1`
- about $10 a month for as long as it runs, at the Micro size a new project is expected to start on (the tool offers no choice of size)

- [ ] **Step 3: Create it**

Call `create_project` with:

```json
{ "name": "Conductia staging", "region": "us-east-1", "organization_id": "ygmizxwodvfkxgcwgtdg" }
```

Record the `id` it returns. That is the project ref.

- [ ] **Step 4: Wait for it to be healthy**

Call `get_project` with that id about once a minute until `status` is `ACTIVE_HEALTHY`. Initialising takes a few minutes. If it is not healthy after ten minutes, stop and report the status.

- [ ] **Step 5: Verify it is the empty database the design expects**

- `get_project`: `region` is `us-east-1` and `database.postgres_engine` is `17`.
- `list_tables` with `schemas: ["public"]`, `verbose: false`: no tables.
- `list_migrations`: an empty list.

An empty `public` schema and an empty ledger is the state **Migrate database** builds from. Anything else: stop and report.

- [ ] **Step 6: Report**

Give Charles the project ref and `https://supabase.com/dashboard/project/<ref>`. The connector does not expose the database password, so the rest is the admin's (Owner setup, row 6): reset the database password, create `db-staging` with the connection string, build the schema with **Migrate database** (`production-bootstrap.md`, A new database), then the auth settings and the Vercel variables for the `staging` branch.

---

### Task 7: Wire staging (a separate PR, once the staging database is built)

Blocked until Task 6 has created the project, an admin has created the `db-staging` environment with its secret, and **Migrate database** has built the schema once by hand (`production-bootstrap.md`, A new database). Needs one input: the staging project ref Task 6 reported.

**Files:**
- Modify: `.github/workflows/migrate.yml`
- Modify: `.github/workflows/promote-develop-to-staging.yml`
- Modify: `scripts/ci/migrate.test.mjs`, `scripts/ci/promote.test.mjs`
- Modify: `docs/03-engineering/delivery-model.md`, `docs/04-operations/production-bootstrap.md`, `docs/07-decisions/ADR-0007-supabase-backend-feature-flags.md`

**Interfaces:**
- Consumes: `migrate.yml`'s `workflow_call` inputs (Task 2), the helpers `jobBlock` and `jobNeeds` in `scripts/ci/promote.test.mjs` (Task 3), and the staging project ref (Task 6).
- Produces: a push to `staging` migrates `db-staging`; `Promote develop to staging` runs `plan`, `migrate`, `fast-forward`.

- [ ] **Step 1: Update the tests first**

In `scripts/ci/migrate.test.mjs`, replace the `TARGET` constant:

```js
const TARGET = "${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || (github.ref_name == 'staging' && 'db-staging') || 'db-dev' }}";
```

and in its first test replace the name and the push assertion:

```js
test('migrate runs on develop, staging and main pushes, by call and by hand', () => {
  const triggers = migrate.split('\npermissions:')[0];
  assert.match(triggers, /\n  push:\n    branches:\n      - develop\n      - staging\n      - main\n  workflow_call:\n/);
```

Append to `scripts/ci/promote.test.mjs`:

```js

test('staging promotion migrates the staging database before staging moves', () => {
  assert.deepEqual(jobNeeds(staging, 'migrate'), ['plan']);
  assert.deepEqual(jobNeeds(staging, 'fast-forward'), ['plan', 'migrate']);
  assert.ok(jobBlock(staging, 'migrate').includes('    uses: ./.github/workflows/migrate.yml\n    with:\n      environment: db-staging\n      ref: ${{ needs.plan.outputs.sha }}\n    secrets: inherit\n'));
});
```

Run: `node --test scripts/ci/migrate.test.mjs scripts/ci/promote.test.mjs 2>&1 | grep -E "^not ok|^# (pass|fail)"`

Expected: three failures: `migrate runs on develop, staging and main pushes, by call and by hand`, `one job, one target expression, one queue per database`, and the new staging promotion test.

- [ ] **Step 2: Add `staging` to `migrate.yml`**

Under `on.push.branches`, add `staging` between the two existing entries:

```yaml
      - develop
      - staging
      - main
```

Replace all three occurrences of:

```yaml
${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || 'db-dev' }}
```

with:

```yaml
${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || (github.ref_name == 'staging' && 'db-staging') || 'db-dev' }}
```

- [ ] **Step 3: Migrate inside the staging promotion**

In `.github/workflows/promote-develop-to-staging.yml`, replace the header comment's last paragraph:

```yaml
# staging uses the development database for now, which every push to develop
# already migrates (migrate.yml), so nothing is migrated here. When staging
# gets its own Supabase project, add a migrate job that calls migrate.yml with
# environment db-staging, and make fast-forward need it.
```

with:

```yaml
# migrate applies the pinned commit's pending migrations to the staging
# database (migrate.yml, environment db-staging) before staging moves.
```

and replace:

```yaml
  fast-forward:
    name: Fast-forward staging to develop
    needs: plan
```

with:

```yaml
  migrate:
    name: Migrate staging
    needs: plan
    uses: ./.github/workflows/migrate.yml
    with:
      environment: db-staging
      ref: ${{ needs.plan.outputs.sha }}
    secrets: inherit

  fast-forward:
    name: Fast-forward staging to develop
    needs: [plan, migrate]
```

`secrets: inherit` is required: without it GitHub resolves an environment secret to an empty string inside a called workflow (found in the final review of the first PR).

- [ ] **Step 4: Run the tests and the linter**

```bash
node --test scripts/ci/*.test.mjs 2>&1 | tail -8
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color=false .github/workflows/migrate.yml .github/workflows/promote-develop-to-staging.yml; echo "exit=$?"
```

Expected: `# fail 0` (`promote.test.mjs` now has 7 tests) and `exit=0`.

- [ ] **Step 5: Documentation**

In `docs/03-engineering/delivery-model.md`, in the branch table's `staging` row, replace `Uses the Conductia-dev database for now.` with `Has its own Supabase project, which the promotion migrates before \`staging\` moves.`

In the same file, in the merge policy's `develop` → `staging` row, replace `It pins \`develop\` and refuses unless all four required checks passed on that exact commit.` with `It pins \`develop\`, refuses unless all four required checks passed on that exact commit, and migrates the staging database before \`staging\` moves.`

In `docs/04-operations/production-bootstrap.md`, under `### A project shared by two deployments`, replace the first sentence, `Staging uses the Conductia-dev project, the same one as develop (see [delivery model](../03-engineering/delivery-model.md)).`, with `Staging has its own project, so this section no longer describes it. It applies to any further deployment that shares a project with another, as staging shared Conductia-dev until its own project existed.`

In `docs/07-decisions/ADR-0007-supabase-backend-feature-flags.md`, add this line directly below the `> **Update 2026-09-25:**` block, with today's date and the project ref from Task 6:

```markdown
> **Update YYYY-MM-DD:** staging has its own Supabase project again, `<staging-project-ref>`, migrated by *Promote develop to staging* (decision-log D84). The active projects are prod `fsaucpwponmzajupvsey`, staging `<staging-project-ref>` and dev `sqyjqdjazefceixkjtdp`.
```

- [ ] **Step 6: Commit, verify, open the PR**

```bash
git add .github/workflows/migrate.yml .github/workflows/promote-develop-to-staging.yml scripts/ci/migrate.test.mjs scripts/ci/promote.test.mjs docs/03-engineering/delivery-model.md docs/04-operations/production-bootstrap.md docs/07-decisions/ADR-0007-supabase-backend-feature-flags.md
git commit -m "$(cat <<'MSG'
ci(migrate): staging has its own database, migrated before staging moves

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
)"
```

Then repeat Task 5 for this branch.

---

## Not in this plan

- Deleting `scripts/migrate.sh` and `npm run db:migrate`. The spec defers it until **Migrate database** has run against dev and production at least once.
- #309 (re-checking open PRs when `develop` moves), Vercel Deployment Checks, and a `released:` label on PRs. The spec lists each as out of scope.
