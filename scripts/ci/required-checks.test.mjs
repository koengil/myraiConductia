import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { REQUIRED_CHECKS, evaluate } from './required-checks.mjs';

const script = fileURLToPath(new URL('./required-checks.mjs', import.meta.url));
const green = (id = 1) => REQUIRED_CHECKS.map((name, i) => ({ id: id + i, name, status: 'completed', conclusion: 'success' }));

test('all required checks green on the commit', () => {
  assert.deepEqual(evaluate(green()), []);
});

test('unrelated checks do not count toward or against promotion', () => {
  const runs = [...green(), { id: 99, name: 'Vercel', status: 'completed', conclusion: 'failure' }];
  assert.deepEqual(evaluate(runs), []);
});

test('missing, pending, failed, cancelled and skipped checks refuse promotion', () => {
  const [lint, integration, e2e, audit, secrets] = green();
  assert.deepEqual(evaluate([integration, e2e, audit, secrets]), [`${lint.name}: missing`]);
  assert.deepEqual(evaluate([lint, integration, { ...e2e, status: 'in_progress', conclusion: null }, audit, secrets]),
    [`${e2e.name}: in_progress`]);
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out']) {
    assert.deepEqual(evaluate([lint, integration, e2e, { ...audit, conclusion }, secrets]), [`${audit.name}: ${conclusion}`]);
    assert.deepEqual(evaluate([lint, integration, e2e, audit, { ...secrets, conclusion }]), [`${secrets.name}: ${conclusion}`]);
  }
});

test('the latest attempt of a re-run check decides', () => {
  const runs = green(10);
  const e2e = runs[2];
  assert.deepEqual(evaluate([...runs, { ...e2e, id: 1, conclusion: 'failure' }]), []);
  assert.deepEqual(evaluate([...runs, { ...e2e, id: 100, conclusion: 'failure' }]), [`${e2e.name}: failure`]);
});

test('CLI exits non-zero and names each problem', () => {
  const input = green().slice(1).map((run) => JSON.stringify(run)).join('\n');
  const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /❌ Lint, typecheck, test, build: missing/);
  const ok = spawnSync(process.execPath, [script], { input: green().map((r) => JSON.stringify(r)).join('\n'), encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
});
