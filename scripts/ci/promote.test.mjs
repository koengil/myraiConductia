import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const promote = read('promote-staging-to-main.yml');
const staging = read('promote-develop-to-staging.yml');
const smoke = read('e2e-live-smoke.yml');

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
const bash = (script, env, cwd) => spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH, ...env } });

test('production promotion runs the live smoke, migrates, then moves main, then tags', () => {
  assert.deepEqual(jobNeeds(promote, 'live_smoke'), ['plan']);
  assert.ok(jobBlock(promote, 'live_smoke').includes('    uses: ./.github/workflows/e2e-live-smoke.yml\n    with:\n      ref: ${{ needs.plan.outputs.sha }}\n    secrets: inherit\n'));
  assert.deepEqual(jobNeeds(promote, 'migrate'), ['plan', 'live_smoke']);
  assert.deepEqual(jobNeeds(promote, 'fast-forward'), ['plan', 'migrate']);
  assert.deepEqual(jobNeeds(promote, 'release'), ['plan', 'fast-forward']);
  assert.ok(jobBlock(promote, 'migrate').includes('    uses: ./.github/workflows/migrate.yml\n    with:\n      environment: db-production\n      ref: ${{ needs.plan.outputs.sha }}\n    secrets: inherit\n'));
  assert.doesNotMatch(promote, /production-db|PRODUCTION_DATABASE_URL/);
  assert.match(promote, /\n      bump:\n[\s\S]*?\n        default: minor\n        options:\n          - minor\n          - patch\n/);
});

test('the live smoke runs the MD spine from the pinned commit against e2e-staging, and nothing lets it pass red', () => {
  const job = jobBlock(smoke, 'smoke');
  assert.match(job, /\n    environment: e2e-staging\n/);
  assert.match(job, /\n          ref: \$\{\{ steps\.pin\.outputs\.sha \}\}\n/);
  assert.match(job, /\n        run: npx playwright test --project=live e2e\/journeys\/md-spine\.spec\.ts\n/);
  assert.doesNotMatch(smoke, /continue-on-error/);
  assert.match(smoke, /\n  workflow_call:\n/);
});

test('the live smoke fails, naming them, when the staging secrets are missing', () => {
  const shell = stepShell(smoke, 'Require the staging secrets');
  const all = { E2E_BASE_URL: 'https://staging.example', E2E_SUPABASE_URL: 'https://x.supabase.co', E2E_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', E2E_SEED_PASSWORD: 'pw' };
  assert.equal(bash(shell, all).status, 0);
  const none = bash(shell, {});
  assert.equal(none.status, 1);
  assert.match(none.stdout, /Set E2E_BASE_URL E2E_SUPABASE_URL E2E_SUPABASE_PUBLISHABLE_KEY E2E_SEED_PASSWORD on the e2e-staging environment/);
  const one = bash(shell, { ...all, E2E_SEED_PASSWORD: '' });
  assert.equal(one.status, 1);
  assert.match(one.stdout, /Set E2E_SEED_PASSWORD on/);
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
  assert.ok(withFiles.stdout.includes('[## Migrations in this release\n\n- `supabase/migrations/20261008120000_a.sql`\n- `supabase/migrations/20261008130000_b.sql`]\n[--generate-notes]\n[--notes-start-tag]\n[v0.7.0]\n'));
  assert.ok(run('').stdout.includes('[## Migrations in this release\n\nNone.]\n'));
});

test('plan pins staging, takes the newest vX.Y.Z tag on main and lists what the release adds', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'promote-plan-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8', env: gitEnv });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const commit = (file, subject) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), `${subject}\n`);
    git('add', file);
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'work');
  commit('supabase/migrations/20260101000000_a.sql', 'feat: a (#1)');
  git('tag', 'v0.6.0');
  git('tag', 'v0.1-sandbox-baseline');
  commit('notes.md', 'docs: notes (#2)');
  git('tag', 'v0.7.0');
  const main = commit('more.md', 'docs: more (#3)');
  git('tag', 'v0.7.1-rc1');
  git('update-ref', 'refs/remotes/origin/main', main);
  const staging = commit('supabase/migrations/20260102000000_b.sql', 'feat: b (#12)');
  git('update-ref', 'refs/remotes/origin/staging', staging);
  git('update-ref', 'refs/remotes/origin/develop', commit('later.md', 'feat: later (#13)'));

  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  const run = bash(stepShell(promote, 'Pin staging and list what it adds'), { ...gitEnv, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, dir);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const out = readFileSync(output, 'utf8');
  assert.ok(out.includes(`sha=${staging}\n`));
  assert.ok(out.includes(`main_sha=${main}\n`));
  assert.ok(out.includes('previous=v0.7.0\n'), out);
  assert.ok(out.includes(`migrations<<migrations-${staging}\nsupabase/migrations/20260102000000_b.sql\nmigrations-${staging}\n`));
  const text = readFileSync(summary, 'utf8');
  assert.ok(text.includes('- feat: b (#12)\n'));
  assert.ok(text.includes('- `supabase/migrations/20260102000000_b.sql`\n'));
  assert.match(text, /The ledger decides what is applied/);
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

test('staging promotion migrates the staging database before staging moves', () => {
  assert.deepEqual(jobNeeds(staging, 'migrate'), ['plan']);
  assert.deepEqual(jobNeeds(staging, 'fast-forward'), ['plan', 'migrate']);
  assert.ok(jobBlock(staging, 'migrate').includes('    uses: ./.github/workflows/migrate.yml\n    with:\n      environment: db-staging\n      ref: ${{ needs.plan.outputs.sha }}\n    secrets: inherit\n'));
});
