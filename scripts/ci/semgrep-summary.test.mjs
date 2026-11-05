import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The Static analysis job hands every Semgrep report to this script before it trusts it:
// findings are advisory, but a missing or malformed report means the scanner failed and
// must not read as a clean run. Python is what the job already has (setup-python), so the
// summary needs no jq on the runner.
const script = fileURLToPath(new URL('../../.github/semgrep/summarize.py', import.meta.url));
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0);
const skip = !python && 'no python on this host';

function summarize(t, mode, report) {
  const dir = mkdtempSync(path.join(tmpdir(), 'semgrep-summary-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.json');
  if (report !== undefined) writeFileSync(file, typeof report === 'string' ? report : JSON.stringify(report));
  return spawnSync(python, [script, mode, file], { encoding: 'utf8' });
}

const finding = (severity, line = 3) => ({
  check_id: `rules.${severity.toLowerCase()}`,
  path: 'src/a.ts',
  start: { line },
  extra: { severity, message: 'First line.\nSecond line.' },
});

test('a pull request summary lists each new ERROR finding by file, line and rule', { skip }, (t) => {
  const out = summarize(t, 'pr', { results: [finding('ERROR', 7)], errors: [] });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^### Semgrep: ERROR findings this pull request adds\n/);
  assert.match(out.stdout, /\nNew ERROR findings: 1\n/);
  assert.match(out.stdout, /\n- `src\/a\.ts:7` rules\.error: First line\.\n/);
  assert.doesNotMatch(out.stdout, /Second line/);
});

test('a develop summary counts findings by severity and reports scanner errors', { skip }, (t) => {
  const out = summarize(t, 'full', { results: [finding('ERROR'), finding('WARNING'), finding('WARNING')], errors: [{}] });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^### Semgrep: full scan of develop\n/);
  assert.match(out.stdout, /\n\| ERROR \| 1 \|\n\| WARNING \| 2 \|\n/);
  assert.match(out.stdout, /\nScanner errors: 1\.\n/);
});

test('a missing, malformed or incomplete report fails, so a scanner crash never reads as clean', { skip }, (t) => {
  for (const [name, report] of [
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', '{"results": ['],
    ['no results', { errors: [] }],
    ['results not a list', { results: {}, errors: [] }],
    ['no errors list', { results: [] }],
    ['not an object', [1, 2]],
  ]) {
    for (const mode of ['pr', 'full']) {
      const out = summarize(t, mode, report);
      assert.equal(out.status, 1, `${name} (${mode}): ${out.stdout}${out.stderr}`);
      assert.equal(out.stdout, '', `${name} (${mode}): no summary is printed`);
    }
  }
});

test('an unknown mode is a usage error', { skip }, (t) => {
  const out = summarize(t, 'everything', { results: [], errors: [] });
  assert.equal(out.status, 2);
});
