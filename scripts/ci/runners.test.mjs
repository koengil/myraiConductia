import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// ADR-0027: repository variables move jobs to the self-hosted fleet; unset, every job stays GitHub-hosted.
// #639: the deploy jobs take their own variable, CI_RUNNER_DEPLOY, and never the shared fleet's.
const dir = new URL('../../.github/workflows/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
const runsOn = (workflow) => [...workflow.matchAll(/\n    runs-on: (.*)\n/g)].map((m) => m[1]);
const jobs = (workflow) =>
  workflow.split('\njobs:\n')[1].split(/\n(?=  [\w-]+:\n)/).map((block) => ({ id: block.match(/^\s*([\w-]+):\n/)[1], block }));

const DEPLOY = `\${{ fromJSON(vars.CI_RUNNER_DEPLOY || '"ubuntu-latest"') }}`;
const TARGET = "inputs.environment || (github.ref_name == 'main' && 'db-production') || (github.ref_name == 'staging' && 'db-staging') || 'db-dev'";
const MIGRATE = `\${{ ((${TARGET}) == 'db-dev' && (vars.CI_RUNNER_LIGHT || 'ubuntu-latest')) || fromJSON(vars.CI_RUNNER_DEPLOY || '"ubuntu-latest"') }}`;
const DEPLOY_WORKFLOWS = ['e2e-live-smoke.yml', 'migrate.yml', 'promote-develop-to-staging.yml', 'promote-staging-to-main.yml'];
const ALLOWED_TRIGGERS = new Set(['push', 'workflow_call', 'workflow_dispatch']);

// The trigger names under `on:`. Fails closed: a form this parser does not know yields a name no allow-set holds.
const triggers = (workflow) => {
  const on = workflow.match(/^on:(.*)$/m);
  if (!on) return ['<no top-level on: key>'];
  const inline = on[1].replace(/#.*$/, '').trim();
  if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const block = workflow.slice(on.index + on[0].length).split(/\n(?=[^\s#])/)[0];
  return [...block.matchAll(/\n  (?!#)([^\s:]+):/g)].map((m) => m[1]);
};

test('the deploy workflows are exactly the four that name CI_RUNNER_DEPLOY', () => {
  assert.deepEqual(workflows.filter((name) => read(name).includes('CI_RUNNER_DEPLOY')), DEPLOY_WORKFLOWS);
});

test('every job in both promotions and the live smoke runs on the deploy runner, or GitHub-hosted when unset', () => {
  for (const name of ['e2e-live-smoke.yml', 'promote-develop-to-staging.yml', 'promote-staging-to-main.yml']) {
    const own = jobs(read(name)).filter(({ block }) => !/\n    uses: /.test(block)); // a reusable call picks its runner in the callee
    assert.ok(own.length > 0, name);
    for (const { id, block } of own) assert.equal(block.match(/\n    runs-on: (.*)\n/)?.[1], DEPLOY, `${name} ${id}`);
    assert.deepEqual(runsOn(read(name)), own.map(() => DEPLOY), name);
  }
});

// #639 audit V3: on a deploy VM the job-started hook holds the first step for up to 10 minutes while
// the toolchain installs, and that wait counts against the job's timeout. So every job that can run there
// leaves room for the hook plus a few minutes of work.
test('every job that can run on the deploy runner allows at least 15 minutes', () => {
  for (const name of DEPLOY_WORKFLOWS) {
    for (const { id, block } of jobs(read(name)).filter(({ block }) => block.includes('CI_RUNNER_DEPLOY'))) {
      const minutes = Number(block.match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
      assert.ok(minutes >= 15, `${name} ${id}: timeout-minutes ${minutes} leaves no room for the 10-minute toolchain hook`);
    }
  }
});

test('migrate keeps db-dev on the light fleet and sends every other database to the deploy runner', () => {
  assert.deepEqual(runsOn(read('migrate.yml')), [MIGRATE]);
});

test('no deploy workflow selects the shared fleet, except migrate for db-dev', () => {
  for (const name of DEPLOY_WORKFLOWS) {
    const text = name === 'migrate.yml' ? read(name).replace(`\n    runs-on: ${MIGRATE}\n`, '\n') : read(name);
    assert.doesNotMatch(text, /CI_RUNNER_(LIGHT|HEAVY)/, name);
  }
});

test('a workflow that names CI_RUNNER_DEPLOY only runs on push, call or dispatch', () => {
  for (const name of workflows.filter((n) => read(n).includes('CI_RUNNER_DEPLOY'))) {
    const names = triggers(read(name));
    assert.ok(names.length > 0, `${name}: no triggers parsed`);
    for (const trigger of names) assert.ok(ALLOWED_TRIGGERS.has(trigger), `${name}: trigger ${trigger} is outside ${[...ALLOWED_TRIGGERS].join(', ')}`);
  }
});

test('only a deploy workflow calls a deploy workflow', () => {
  for (const name of workflows) {
    for (const m of read(name).matchAll(/\buses:\s*['"]?\S*\.github\/workflows\/([\w.-]+)/g)) {
      if (DEPLOY_WORKFLOWS.includes(m[1])) assert.ok(DEPLOY_WORKFLOWS.includes(name), `${name} calls ${m[1]} but is not a deploy workflow`);
    }
  }
});

// #639 design R8: the deploy launcher serves only the runs its allowlist names. Its steady-state
// rows (no expires) must cover exactly the workflows that select the deploy runner, each with
// events the workflow really has. Lives here, not in infra/, so a workflow change alone runs it.
const allowlist = () => {
  const tf = readFileSync(new URL('../../infra/deploy-runner/variables.tf', import.meta.url), 'utf8');
  const block = tf.split('variable "deploy_allowlist" {')[1].split('\n  validation {')[0];
  const rows = [...block.matchAll(/^\s*\{ workflow = "([^"]+)", branch = "([^"]+)", events = \[([^\]]*)\](?:, expires = "([^"]+)")? \},?$/gm)];
  const entries = block.split('\n').filter((line) => /^\s*\{ workflow = /.test(line));
  assert.equal(rows.length, entries.length, 'every allowlist entry is one line in the shape this test reads');
  return rows.map(([, workflow, branch, events, expires]) => ({ workflow, branch, events: [...events.matchAll(/"([^"]+)"/g)].map((m) => m[1]), expires }));
};

test('the deploy launcher allowlist steady state names exactly the workflows that select the deploy runner', () => {
  const rows = allowlist();
  const steady = rows.filter((r) => !r.expires);
  assert.deepEqual([...new Set(steady.map((r) => r.workflow))].sort(), DEPLOY_WORKFLOWS.map((name) => `.github/workflows/${name}`));
  for (const r of rows) {
    const name = r.workflow.replace('.github/workflows/', '');
    assert.ok(DEPLOY_WORKFLOWS.includes(name), `${r.workflow} is not a deploy workflow`);
    const on = triggers(read(name));
    for (const event of r.events) assert.ok(on.includes(event), `${r.workflow} on ${r.branch}: ${event} is not one of its triggers`);
  }
  for (const r of steady) assert.ok(['main', 'staging'].includes(r.branch), `${r.workflow}: steady state serves main or staging only, not ${r.branch}`);
  assert.deepEqual(steady.filter((r) => r.branch === 'staging').map((r) => r.workflow), ['.github/workflows/migrate.yml'], 'staging is served for migrate only');
});

test('ci.yml never selects the deploy runner', () => {
  assert.doesNotMatch(read('ci.yml'), /CI_RUNNER_DEPLOY/);
});

test('every ci.yml job falls back to a GitHub-hosted label, heavy jobs on the heavy pool', () => {
  const ci = read('ci.yml');
  const jobs = ci.split('\njobs:\n')[1].split(/\n(?=  \w+:\n)/);
  const pools = {};
  const code = {};
  for (const block of jobs) {
    const id = block.match(/^\s*(\w+):\n/)[1];
    if (/\n    uses: /.test(block)) continue; // a reusable-workflow call picks its runner in the callee
    const label = block.match(/\n    runs-on: (.*)\n/)?.[1];
    const m = label?.match(/^\$\{\{ vars\.(CI_RUNNER_HEAVY|CI_RUNNER_LIGHT) \|\| '(ubuntu-latest|ubuntu-slim)' \}\}$/);
    assert.ok(m, `${id}: runs-on ${label}`);
    pools[id] = m[1];
    code[id] = block.replace(/^ *#.*$/gm, '');
  }
  assert.equal(pools.integration, 'CI_RUNNER_HEAVY');
  assert.equal(pools.e2e, 'CI_RUNNER_HEAVY');
  for (const [id, pool] of Object.entries(pools)) {
    if (pool === 'CI_RUNNER_LIGHT') assert.doesNotMatch(code[id], /supabase start|docker |playwright/, `${id}: light pool, no Docker or browser`);
  }
});
