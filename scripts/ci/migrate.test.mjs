import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const migrate = read('migrate.yml');
const ci = read('ci.yml');
const preflight = readFileSync(new URL('../preflight-db.ts', import.meta.url), 'utf8');

const TARGET = "${{ inputs.environment || (github.ref_name == 'main' && 'db-production') || (github.ref_name == 'staging' && 'db-staging') || 'db-dev' }}";
const DATABASE_URL = 'postgresql://postgres:pw@db.example:5432/postgres';
const PRODUCTION_URL = 'postgresql://postgres.fsaucpwponmzajupvsey:pw@pooler.example:5432/postgres';

const stepShell = (workflow, name) => {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  assert.ok(step, `step "${name}" exists`);
  return step.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
};
const bash = (script, env) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('migrate runs on develop, staging and main pushes, by call and by hand', () => {
  const triggers = migrate.split('\npermissions:')[0];
  assert.match(triggers, /\n  push:\n    branches:\n      - develop\n      - staging\n      - main\n  workflow_call:\n/);
  assert.doesNotMatch(triggers, /paths(-ignore)?:/);
  assert.match(triggers, /\n  workflow_call:\n    inputs:\n      environment:\n        required: true\n        type: string\n      ref:\n        required: true\n        type: string\n/);
  const dispatch = triggers.split('\n  workflow_dispatch:\n')[1];
  for (const environment of ['db-dev', 'db-staging', 'db-production']) assert.ok(dispatch.includes(`\n          - ${environment}\n`), environment);
  assert.match(migrate, /\npermissions:\n  contents: read\n/);
});

test('one job, one target expression, one queue per database', () => {
  assert.match(migrate, /\njobs:\n  migrate:\n    name: Migrate database\n/);
  assert.equal(migrate.split(TARGET).length - 1, 4);
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
  assert.match(runGuard({ MIGRATION_DATABASE_URL: '' }).stdout, /secrets: inherit/, 'an empty secret also names the calling workflow as a cause');
});

test('guard: production needs a listed approver, other databases take anyone when no list is set', () => {
  const production = (approvers, actor) => runGuard({ TARGET: 'db-production', MIGRATION_DATABASE_URL: PRODUCTION_URL, MIGRATION_APPROVERS: approvers, TRIGGERING_ACTOR: actor }).status;
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
  const refused = runGuard({ TARGET: 'db-production', MIGRATION_DATABASE_URL: PRODUCTION_URL, MIGRATION_APPROVERS: 'approver-one', TRIGGERING_ACTOR: 'someone-else' });
  assert.match(refused.stdout, /someone-else is not in MIGRATION_APPROVERS for db-production/);
});

test('guard: an environment only migrates its own database', () => {
  const directHost = 'postgresql://postgres:pw@db.fsaucpwponmzajupvsey.supabase.co:5432/postgres';
  for (const target of ['db-dev', 'db-staging']) {
    for (const url of [PRODUCTION_URL, directHost]) {
      const out = runGuard({ TARGET: target, MIGRATION_DATABASE_URL: url });
      assert.equal(out.status, 1, `${target} ${url}`);
      assert.match(out.stdout, /points at the production project/);
    }
  }
  const wrong = runGuard({ TARGET: 'db-production', MIGRATION_DATABASE_URL: DATABASE_URL, MIGRATION_APPROVERS: 'approver-one', TRIGGERING_ACTOR: 'approver-one' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /does not point at the production project/);
  assert.equal(runGuard({ TARGET: 'db-production', MIGRATION_DATABASE_URL: PRODUCTION_URL, MIGRATION_APPROVERS: 'approver-one', TRIGGERING_ACTOR: 'approver-one' }).status, 0);
});

const refShell = stepShell(migrate, 'Check the commit belongs to a release branch');
const PROMOTE_CALLER = 'Conductia/Conductia/.github/workflows/promote-develop-to-staging.yml@refs/heads/main';
const DISPATCH = 'Conductia/Conductia/.github/workflows/migrate.yml@refs/heads/develop';
const TIPS = { develop: 'd'.repeat(40), staging: 'a'.repeat(40), main: 'b'.repeat(40) };
// behind: commits the branch lacks from the checked-out commit; '0' means the commit is on it.
// bare answers a compare against the bare branch name, the way a same-named tag would resolve,
// so a check that skips refs/heads passes wrongly.
const runRef = (target, behind, { ref = 'develop', caller = DISPATCH, bare = '9', tips = {} } = {}) => bash(`
    git() { echo 1234567890abcdef; }
    gh() {
      case "$2" in
        */git/ref/heads/develop) echo "$DEVELOP_TIP" ;;
        */git/ref/heads/staging) echo "$STAGING_TIP" ;;
        */git/ref/heads/main) echo "$MAIN_TIP" ;;
        "repos/$REPO/compare/1234567890abcdef...$DEVELOP_TIP") echo "$BEHIND_DEVELOP" ;;
        "repos/$REPO/compare/1234567890abcdef...$STAGING_TIP") echo "$BEHIND_STAGING" ;;
        "repos/$REPO/compare/1234567890abcdef...$MAIN_TIP") echo "$BEHIND_MAIN" ;;
        */compare/1234567890abcdef...develop | */compare/1234567890abcdef...staging | */compare/1234567890abcdef...main) echo "$BEHIND_BARE" ;;
        *) echo "unexpected gh call: $*" >&2; return 1 ;;
      esac
    }
    ${refShell}
  `, {
  TARGET: target, REF: ref, CALLER: caller, REPO: 'Conductia/Conductia',
  BEHIND_DEVELOP: behind.develop ?? '9', BEHIND_STAGING: behind.staging ?? '9', BEHIND_MAIN: behind.main ?? '9', BEHIND_BARE: bare,
  DEVELOP_TIP: tips.develop ?? TIPS.develop, STAGING_TIP: tips.staging ?? TIPS.staging, MAIN_TIP: tips.main ?? TIPS.main,
});

test('the ref check reads the target, the ref and the caller from env, before any write', () => {
  const step = migrate.split('      - name: Check the commit belongs to a release branch\n')[1].split('\n      - name: ')[0];
  assert.ok(step.includes(`\n          TARGET: ${TARGET}\n`));
  assert.ok(step.includes('\n          REF: ${{ inputs.ref || github.ref_name }}\n'));
  assert.ok(step.includes('\n          CALLER: ${{ github.workflow_ref }}\n'));
  assert.ok(migrate.indexOf('- name: Check the commit belongs to a release branch') < migrate.indexOf('- name: Apply pending migrations'));
});

test('production is only migrated from a commit that is on staging or main', () => {
  assert.equal(runRef('db-production', { staging: '0', main: '3' }).status, 0);
  assert.equal(runRef('db-production', { staging: '2', main: '0' }).status, 0);
  assert.equal(runRef('db-production', { develop: '0', staging: '2', main: '5' }).status, 1, 'develop alone is not enough');
  const off = runRef('db-production', { staging: '2', main: '5' });
  assert.equal(off.status, 1);
  assert.match(off.stdout, /1234567 is on neither staging nor main/);
  assert.notEqual(runRef('db-production', { staging: '', main: '' }).status, 0, 'an unreadable comparison is not a pass');
});

test('dev is only migrated from a commit on develop', () => {
  assert.equal(runRef('db-dev', { develop: '0' }).status, 0);
  const feature = runRef('db-dev', { develop: '2', staging: '0', main: '0' }, { ref: 'marcelo/cco-thresholds-send-friction' });
  assert.equal(feature.status, 1, 'an open PR branch is refused even when it is behind nothing else');
  assert.match(feature.stdout, /marcelo\/cco-thresholds-send-friction @ 1234567 is not on develop/);
  assert.ok(feature.stdout.includes('gh workflow run migrate.yml --ref develop -f environment=db-dev -f ref=develop'));
  assert.notEqual(runRef('db-dev', { develop: '' }).status, 0, 'an unreadable comparison is not a pass');
});

test('staging takes a commit on staging, or on develop only when Promote develop to staging calls', () => {
  assert.equal(runRef('db-staging', { staging: '0' }, { ref: 'staging' }).status, 0);
  assert.equal(runRef('db-staging', { develop: '0', staging: '4' }, { ref: 'abc123', caller: PROMOTE_CALLER }).status, 0);
  const handDevelop = runRef('db-staging', { develop: '0', staging: '4' }, { ref: 'develop', caller: 'Conductia/Conductia/.github/workflows/migrate.yml@refs/heads/main' });
  assert.equal(handDevelop.status, 1, 'by hand, develop is not staging');
  assert.ok(handDevelop.stdout.includes('gh workflow run migrate.yml --ref staging -f environment=db-staging -f ref=staging'));
  const feature = runRef('db-staging', { develop: '3', staging: '4' }, { ref: 'some/feature', caller: PROMOTE_CALLER });
  assert.equal(feature.status, 1, 'the promote path still needs the commit on develop');
  assert.match(feature.stdout, /some\/feature @ 1234567 is not on develop/);
  const forged = runRef('db-staging', { develop: '0', staging: '4' }, { caller: 'Other/Repo/.github/workflows/promote-develop-to-staging.yml@refs/heads/main' });
  assert.equal(forged.status, 1, 'only this repository\'s promote workflow counts');
});

test('a commit reachable only from a tag named like an allowed branch is refused', () => {
  // The bare name would resolve to the tag and report the commit as on it; refs/heads is the real branch.
  assert.equal(runRef('db-production', { staging: '4', main: '6' }, { bare: '0' }).status, 1);
  assert.equal(runRef('db-staging', { staging: '4' }, { ref: 'staging', bare: '0' }).status, 1);
  assert.equal(runRef('db-dev', { develop: '2' }, { bare: '0' }).status, 1);
});

test('a branch tip that cannot be read, or is not a full SHA, is not a pass', () => {
  const unread = runRef('db-production', { staging: '0' }, { tips: { staging: '' } });
  assert.equal(unread.status, 1);
  assert.match(unread.stdout, /The tip of staging could not be read/);
  assert.equal(runRef('db-dev', { develop: '0' }, { tips: { develop: 'develop' } }).status, 1);
});

test('an unknown environment is refused', () => {
  assert.equal(runRef('db-other', { develop: '0', staging: '0', main: '0' }).status, 1);
});

test('Promote develop to staging is the caller the staging rule names', () => {
  const promote = read('promote-develop-to-staging.yml');
  assert.match(promote, /\n  migrate:\n    name: Migrate staging\n    needs: plan\n    uses: \.\/\.github\/workflows\/migrate\.yml\n    with:\n      environment: db-staging\n      ref: \$\{\{ needs\.plan\.outputs\.sha \}\}\n/);
  assert.ok(refShell.includes('"${REPO}/.github/workflows/promote-develop-to-staging.yml@"*'));
});

const apply = stepShell(migrate, 'Apply pending migrations');
const runApply = (t, { before = '', after = '', tables = '0', pushExit = 0, ledgerExists = before === '' ? 'f' : 't', beforeFails = false, afterFails = false }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-apply-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = bash(`
    unreadable() { echo "psql: could not read the ledger" >&2; return 2; }
    psql() {
      case "$*" in
        *to_regclass*) printf '%s\\n' "$LEDGER_EXISTS" ;;
        *pg_tables*) printf '%s\\n' "$TABLES" ;;
        *)
          if [ -f "$RUNNER_TEMP/pushed" ]; then
            if [ "$AFTER_FAILS" = "1" ]; then unreadable; else printf '%s' "$AFTER"; fi
          else
            if [ "$BEFORE_FAILS" = "1" ]; then unreadable; else printf '%s' "$BEFORE"; fi
          fi
          ;;
      esac
    }
    supabase() { : > "$RUNNER_TEMP/pushed"; printf 'supabase %s\\n' "$*"; return "$PUSH_EXIT"; }
    ${apply}
  `, {
    MIGRATION_DATABASE_URL: DATABASE_URL,
    BEFORE: before,
    AFTER: after,
    TABLES: tables,
    LEDGER_EXISTS: ledgerExists,
    BEFORE_FAILS: beforeFails ? '1' : '0',
    AFTER_FAILS: afterFails ? '1' : '0',
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
  for (const ledgerExists of ['f', 't']) {
    const out = runApply(t, { before: '', tables: '80', ledgerExists });
    assert.equal(out.status, 1, ledgerExists);
    assert.match(out.stdout, /80 tables in public and an empty migration ledger/);
    assert.doesNotMatch(out.stdout, /supabase db push/);
  }
});

test('apply: a ledger that cannot be read stops the run and is never called empty', (t) => {
  const out = runApply(t, { ledgerExists: 't', beforeFails: true, tables: '80' });
  assert.notEqual(out.status, 0);
  assert.doesNotMatch(out.stdout, /empty migration ledger|supabase db push/);
});

test('apply: when the ledger cannot be read after the push, the count is unknown and preflight still runs', (t) => {
  const out = runApply(t, { before: '20260101000000_a', afterFails: true });
  assert.equal(out.status, 0);
  assert.equal(out.output, 'applied=unknown\n');
  assert.match(out.summary, /Migrations applied: unknown/);
});

test('a red preflight never tells the operator to apply SQL by hand', () => {
  assert.doesNotMatch(preflight, /psql -X|one transaction each/);
  assert.match(preflight, /Migrate database workflow/);
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
