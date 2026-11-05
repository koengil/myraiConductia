import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The Secret scan's commit-range step decides what the scanner is asked to read. A wrong
// range silently scans nothing, so this runs the real shell from ci.yml in temp git
// repos, with a stub in place of the scanner that records its arguments.
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const job = workflow.split('\n  secrets:\n')[1].split(/\n  \w+:\n/)[0];
const step = job.split('      - name: ').find((text) => text.startsWith('Scan the commit range'));
assert.ok(step, 'the secrets job has a commit range step');
const shell = step.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');

const ZERO = '0'.repeat(40);
const UNKNOWN = 'f'.repeat(40);

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'secret-scan-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI Test');
  const commit = (file) => {
    writeFileSync(path.join(cwd, file), `${file} ${Math.random()}`);
    git('add', '.');
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  const stub = path.join(root, 'scanner-stub.sh');
  const log = path.join(root, 'scanner-args.txt');
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STUB_LOG"\n');
  chmodSync(stub, 0o755);
  const run = (env) => {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITLEAKS: stub, CONFIG: 'base-config.toml', IGNORE: 'ignore-dir', STUB_LOG: log,
        EVENT: '', PR_BASE: '', PR_HEAD: '', BEFORE: '', AFTER: '',
        ...env,
      },
    });
    return { ...result, args: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : null };
  };
  return { git, commit, run };
}

// A feature branch of two commits, and a base branch that moved on after it forked.
function forkedPullRequest(repo) {
  const fork = repo.commit('README.md');
  repo.git('checkout', '-qb', 'feature');
  repo.commit('feature-one.txt');
  const head = repo.commit('feature-two.txt');
  repo.git('checkout', '-q', '--detach', fork);
  const baseTip = repo.commit('base-only.txt');
  return { fork, head, baseTip };
}

test('pull request: scans merge-base..head, not base..head', (t) => {
  const repo = fixture(t);
  const { fork, head, baseTip } = forkedPullRequest(repo);
  const out = repo.run({ EVENT: 'pull_request', PR_BASE: baseTip, PR_HEAD: head });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.args.slice(0, 2), ['git', `--log-opts=${fork}..${head}`]);
  for (const arg of ['--config', 'base-config.toml', '--gitleaks-ignore-path', 'ignore-dir', '--redact']) assert.ok(out.args.includes(arg), arg);
});

test('pull request: an unresolvable base or head fails closed and never calls the scanner', (t) => {
  const repo = fixture(t);
  const { head, baseTip } = forkedPullRequest(repo);
  for (const [name, env] of [
    ['unknown base', { PR_BASE: UNKNOWN, PR_HEAD: head }],
    ['unknown head', { PR_BASE: baseTip, PR_HEAD: UNKNOWN }],
    ['empty base', { PR_BASE: '', PR_HEAD: head }],
    ['empty head', { PR_BASE: baseTip, PR_HEAD: '' }],
  ]) {
    const out = repo.run({ EVENT: 'pull_request', ...env });
    assert.notEqual(out.status, 0, name);
    assert.match(out.stdout, /::error::/, name);
    assert.equal(out.args, null, `${name}: the scanner is never called`);
  }
});

test('pull request: unrelated histories have no merge base and fail closed', (t) => {
  const repo = fixture(t);
  const { head } = forkedPullRequest(repo);
  repo.git('checkout', '-q', '--orphan', 'unrelated');
  const root = repo.commit('unrelated.txt');
  const out = repo.run({ EVENT: 'pull_request', PR_BASE: root, PR_HEAD: head });
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /::error::/);
  assert.equal(out.args, null);
});

test('push: scans before..after', (t) => {
  const repo = fixture(t);
  const before = repo.commit('README.md');
  repo.commit('middle.txt');
  const after = repo.commit('last.txt');
  const out = repo.run({ EVENT: 'push', BEFORE: before, AFTER: after });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.args.slice(0, 2), ['git', `--log-opts=${before}..${after}`]);
});

test('push: a new branch (zero or empty before) skips the range scan with a notice', (t) => {
  const repo = fixture(t);
  const after = repo.commit('README.md');
  for (const before of [ZERO, '']) {
    const out = repo.run({ EVENT: 'push', BEFORE: before, AFTER: after });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /::notice::/);
    assert.equal(out.args, null, 'the scanner is never called');
  }
});

test('push: a before commit missing from the clone fails closed', (t) => {
  const repo = fixture(t);
  const after = repo.commit('README.md');
  const out = repo.run({ EVENT: 'push', BEFORE: UNKNOWN, AFTER: after });
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /::error::/);
  assert.equal(out.args, null);
});

// The self-test is what proves, on every run, that the effective config still catches a
// new credential. It seeds a gitleaks:allow-marked canary and a new credential in every
// allowlisted path, then requires each one in the scanner's report. A stub stands in for
// the scanner: it reports every seeded file under every rule, minus what STUB_DROP names.
const selfTestStep = job.split('      - name: ').find((text) => text.startsWith('Self-test'));
assert.ok(selfTestStep, 'the secrets job has a self-test step');
const selfTestShell = selfTestStep.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
const configPath = new URL('../../.gitleaks.toml', import.meta.url);
const allowlistedPaths = readFileSync(configPath, 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .flatMap((line) => [...line.matchAll(/'''\(\^\|\/\)(.+?)\$'''/g)].map((m) => m[1].replaceAll('\\.', '.')));
const SEEDED_RULES = ['generic-api-key', 'jwt', 'curl-auth-header'];

function selfTestFixture(t, scanner) {
  const root = mkdtempSync(path.join(tmpdir(), 'secret-scan-selftest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolDir = path.join(root, 'tool');
  mkdirSync(toolDir);
  const log = path.join(root, 'scanner-args.txt');
  const stub = path.join(root, 'scanner-stub.sh');
  writeFileSync(stub, [
    '#!/bin/bash',
    'printf \'%s\\n\' "$@" > "$STUB_LOG"',
    'target=$2; report=',
    'while [ $# -gt 0 ]; do [ "$1" = --report-path ] && report=$2; shift; done',
    'n=$(( $(cat "$STUB_LOG.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_LOG.n"',
    'if [ "${target##*/}" = probe ] && [ "$n" -le "${STUB_PROBE_MISSES:-0}" ]; then : > "$report"; exit 0; fi',
    'find "$target" -type f | while read -r f; do',
    `  case "$f" in */canary.txt) echo "github-pat $f" ;; *) for r in ${SEEDED_RULES.join(' ')}; do echo "$r $f"; done ;; esac`,
    'done | grep -v -e "${STUB_DROP:-^$}" > "$report" || true',
    'exit "${STUB_EXIT:-1}"',
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);
  const run = (env = {}, config = fileURLToPath(configPath)) => {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', selfTestShell], {
      encoding: 'utf8',
      env: { ...process.env, GITLEAKS: scanner ?? stub, CONFIG: config, TOOL_DIR: toolDir, STUB_LOG: log, ...env },
    });
    return { ...result, args: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : null };
  };
  const seeded = () => execFileSync('find', ['.', '-type', 'f'], { cwd: path.join(toolDir, 'canary'), encoding: 'utf8' })
    .split('\n').filter(Boolean).map((f) => f.slice(2)).sort();
  return { root, toolDir, run, seeded };
}

test('self-test: seeds every allowlisted path and the marked canary, and passes when all are reported', (t) => {
  assert.ok(allowlistedPaths.length >= 10, `the config names its allowlisted paths: ${allowlistedPaths}`);
  const fx = selfTestFixture(t);
  const out = fx.run();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(fx.seeded(), ['canary.txt', ...allowlistedPaths].sort());
  assert.ok(out.args.includes('--ignore-gitleaks-allow'), 'the scanner is told to ignore gitleaks:allow');
  const canary = readFileSync(path.join(fx.toolDir, 'canary', 'canary.txt'), 'utf8');
  assert.match(canary, /^ghp_[A-Za-z0-9]{36} \/\/ gitleaks:allow\n$/);
});

test('self-test: fails, naming the file, when an allowlisted path hides a new credential', (t) => {
  const fx = selfTestFixture(t);
  for (const [rule, file] of [['generic-api-key', 'tests/e2e-totp.test.ts'], ['curl-auth-header', 'docs/04-operations/agent-seam-edge-and-rollout.md']]) {
    const out = fx.run({ STUB_DROP: `^${rule} .*/${file.replaceAll('.', '\\.')}$` });
    assert.notEqual(out.status, 0, `${rule} in ${file}`);
    assert.match(out.stdout, new RegExp(`::error::Rule ${rule} missed the seeded canary in ${file.replaceAll('.', '\\.')}\\.`));
  }
});

test('self-test: fails when the marked canary is suppressed or the scanner reports nothing', (t) => {
  const fx = selfTestFixture(t);
  const hidden = fx.run({ STUB_DROP: '^github-pat ' });
  assert.notEqual(hidden.status, 0);
  assert.match(hidden.stdout, /::error::Rule github-pat missed the seeded canary in canary\.txt\./);
  const silent = fx.run({ STUB_EXIT: '0' });
  assert.notEqual(silent.status, 0);
  assert.match(silent.stdout, /::error::The scanner did not report the seeded canaries \(exit 0\)\./);
});

// A drawn credential can fall under a rule's own filters (no digit, a stopword), so the
// self-test redraws until all three rules catch it at a path no allowlist names.
test('self-test: redraws a credential the rules miss at a neutral path', (t) => {
  const fx = selfTestFixture(t);
  const out = fx.run({ STUB_PROBE_MISSES: '3' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(fx.seeded(), ['canary.txt', ...allowlistedPaths].sort());
});

test('self-test: fails when no draw is caught by all three rules at a neutral path', (t) => {
  const fx = selfTestFixture(t);
  const out = fx.run({ STUB_DROP: '^jwt .*/probe/' });
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /::error::No drawn credential was caught by all three rules at a neutral path\./);
});

// The real scanner, when one is supplied (GITLEAKS_TEST_BIN, the pinned 8.30.1 binary):
// the committed config passes, and the same allowlists widened to whole files fail.
test('self-test with the real scanner: exact-value allowlists pass, file-wide ones fail', { skip: !process.env.GITLEAKS_TEST_BIN && 'set GITLEAKS_TEST_BIN to the pinned gitleaks binary' }, (t) => {
  const fx = selfTestFixture(t, process.env.GITLEAKS_TEST_BIN);
  const committed = fx.run();
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  const wide = path.join(fx.root, 'file-wide.toml');
  writeFileSync(wide, readFileSync(configPath, 'utf8').replace(/^condition = "AND"\n/gm, '').replace(/^regexes = \[\n[\s\S]*?\n\]\n/gm, '').replace(/^regexes = \['''.*'''\]\n/gm, ''));
  const widened = fx.run({}, wide);
  assert.notEqual(widened.status, 0, widened.stdout);
  assert.match(widened.stdout, /::error::Rule generic-api-key missed the seeded canary in tests\/e2e-totp\.test\.ts\./);
});
