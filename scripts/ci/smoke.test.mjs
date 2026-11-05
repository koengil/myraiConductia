import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// #639: the live smoke runs with the e2e-staging secrets, so it checks out only a commit already on
// staging or main, resolved to a SHA before anything else runs.
const smoke = readFileSync(new URL('../../.github/workflows/e2e-live-smoke.yml', import.meta.url), 'utf8');
const PIN = 'Pin the ref to a release-branch commit';

const job = smoke.split('\n  smoke:\n')[1];
const steps = job.split('\n    steps:\n')[1].split(/\n(?=      - name: )/);
const stepNamed = (name) => steps.find((s) => s.startsWith(`      - name: ${name}\n`));
const pinStep = stepNamed(PIN);
const pinShell = pinStep.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');

const REPO = 'Conductia/Conductia';
const COMMIT = 'c'.repeat(40);
const STAGING_TIP = 'a'.repeat(40);
const MAIN_TIP = 'b'.repeat(40);

// The stub answers only the calls the step should make. behind: commits the branch lacks from the
// resolved commit; '0' means the commit is on it. bareName answers a compare against the bare
// branch name, the way a same-named tag would resolve, so a step that skips heads/ passes wrongly.
// The commits endpoint answers only commitPath (the ref, slashes encoded, unless a test names it);
// compareFails makes a branch's compare print its answer and then exit non-zero.
const runPin = (t, { ref = 'staging', commit = COMMIT, commitPath = ref.replaceAll('/', '%2F'), behind = {}, bareName = '9', tips = {}, compareFails = {} } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-pin-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    REF: ref,
    REPO,
    GH_TOKEN: 'token',
    GITHUB_OUTPUT: path.join(dir, 'output'),
    CALLS: path.join(dir, 'calls'),
    COMMIT: commit,
    COMMIT_PATH: commitPath,
    FAIL_STAGING: compareFails.staging ? '1' : '',
    FAIL_MAIN: compareFails.main ? '1' : '',
    STAGING_TIP: tips.staging ?? STAGING_TIP,
    MAIN_TIP: tips.main ?? MAIN_TIP,
    BEHIND_STAGING: behind.staging ?? '9',
    BEHIND_MAIN: behind.main ?? '9',
    BEHIND_BARE: bareName,
  };
  const run = spawnSync('bash', ['-c', `
    gh() {
      printf '%s\\n' "$*" >> "$CALLS"
      case "$2" in
        "repos/${REPO}/commits/$COMMIT_PATH") [ -n "$COMMIT" ] || { echo 'gh: No commit found for SHA (HTTP 422)' >&2; return 1; }; echo "$COMMIT" ;;
        repos/${REPO}/commits/*) echo 'gh: No commit found for SHA (HTTP 422)' >&2; return 1 ;;
        repos/${REPO}/git/ref/heads/staging) echo "$STAGING_TIP" ;;
        repos/${REPO}/git/ref/heads/main) echo "$MAIN_TIP" ;;
        "repos/${REPO}/compare/$COMMIT...$STAGING_TIP") echo "$BEHIND_STAGING"; [ -z "$FAIL_STAGING" ] ;;
        "repos/${REPO}/compare/$COMMIT...$MAIN_TIP") echo "$BEHIND_MAIN"; [ -z "$FAIL_MAIN" ] ;;
        "repos/${REPO}/compare/$COMMIT...staging" | "repos/${REPO}/compare/$COMMIT...main") echo "$BEHIND_BARE" ;;
        *) echo "unexpected gh call: $*" >&2; return 1 ;;
      esac
    }
    ${pinShell}
  `], { encoding: 'utf8', env });
  const file = (name) => {
    try {
      return readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, output: file('output'), calls: file('calls') };
};

test('the pin step is the first step, ahead of every step that reads a secret, and Checkout', () => {
  assert.ok(steps[0].startsWith(`      - name: ${PIN}\n        id: pin\n`));
  assert.doesNotMatch(pinStep, /secrets\./);
  const firstSecret = steps.findIndex((s) => /secrets\./.test(s));
  assert.ok(firstSecret > 0, 'some later step reads the staging secrets');
  assert.equal(steps[1].split('\n')[0], '      - name: Require the staging secrets');
  assert.ok(steps.indexOf(stepNamed('Checkout')) > 0);
});

test('Checkout takes the pinned SHA, never the ref input', () => {
  const checkout = stepNamed('Checkout');
  assert.match(checkout, /\n          ref: \$\{\{ steps\.pin\.outputs\.sha \}\}\n/);
  assert.doesNotMatch(job, /\n          ref: \$\{\{ inputs\.ref \}\}\n/);
  assert.equal(job.split('inputs.ref').length - 1, 1, 'the ref input is read once, by the pin step');
});

test('the pin step reads the ref from env and never interpolates an expression into its script', () => {
  assert.ok(pinStep.includes('\n          REF: ${{ inputs.ref }}\n'));
  assert.ok(pinStep.includes('\n          GH_TOKEN: ${{ github.token }}\n'));
  assert.ok(pinStep.includes('\n          REPO: ${{ github.repository }}\n'));
  assert.doesNotMatch(pinShell, /\$\{\{/);
  for (const block of smoke.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)) assert.doesNotMatch(block[1], /\$\{\{/);
});

test('a ref on staging passes and pins its SHA', (t) => {
  const out = runPin(t, { behind: { staging: '0' } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.output, `sha=${COMMIT}\n`);
});

test('a ref on main passes and pins its SHA', (t) => {
  const out = runPin(t, { ref: 'main', behind: { staging: '3', main: '0' } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.output, `sha=${COMMIT}\n`);
});

test('a ref on neither staging nor main fails and pins nothing', (t) => {
  const out = runPin(t, { ref: 'marcelo/cco-thresholds-send-friction', behind: { staging: '2', main: '5' } });
  assert.equal(out.status, 1);
  assert.equal(out.output, '');
  assert.match(out.stdout, /marcelo\/cco-thresholds-send-friction @ ccccccc is on neither staging nor main/);
  assert.ok(out.calls.includes(`repos/${REPO}/commits/marcelo%2Fcco-thresholds-send-friction `), 'a slash in the ref is encoded');
});

test('an unknown ref fails before any comparison', (t) => {
  const out = runPin(t, { ref: 'no-such-branch', commit: '' });
  assert.equal(out.status, 1);
  assert.equal(out.output, '');
  assert.match(out.stdout, /no-such-branch does not name a commit/);
  assert.doesNotMatch(out.calls, /compare\//);
});

test('a commit reachable only from a tag named staging fails', (t) => {
  // The bare name would resolve to the tag and report the commit as on it; heads/staging is the real branch.
  const out = runPin(t, { behind: { staging: '4', main: '6' }, bareName: '0' });
  assert.equal(out.status, 1, out.stdout);
  assert.equal(out.output, '');
});

test('compare is always made against the tip SHA read from refs/heads, never the bare branch name', (t) => {
  const out = runPin(t, { behind: { staging: '4', main: '0' } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const compares = out.calls.split('\n').filter((line) => line.includes('/compare/'));
  assert.deepEqual(compares, [
    `api repos/${REPO}/compare/${COMMIT}...${STAGING_TIP} --jq .behind_by`,
    `api repos/${REPO}/compare/${COMMIT}...${MAIN_TIP} --jq .behind_by`,
  ]);
  assert.ok(out.calls.includes(`api repos/${REPO}/git/ref/heads/staging --jq .object.sha\n`));
  assert.ok(out.calls.includes(`api repos/${REPO}/git/ref/heads/main --jq .object.sha\n`));
});

test('an unreadable comparison or tip is not a pass', (t) => {
  assert.equal(runPin(t, { behind: { staging: '', main: '' } }).status, 1);
  assert.equal(runPin(t, { tips: { staging: 'not-a-sha' }, behind: { staging: '0' } }).status, 1);
  assert.equal(runPin(t, { commit: 'deadbeef' }).status, 1, 'a resolved SHA must be a full commit SHA');
});

test('a comparison that prints 0 and then fails is refused, and the next branch is still tried', (t) => {
  const failed = runPin(t, { behind: { staging: '0', main: '6' }, compareFails: { staging: true } });
  assert.equal(failed.status, 1, failed.stdout);
  assert.equal(failed.output, '');
  const both = runPin(t, { behind: { staging: '0', main: '0' }, compareFails: { staging: true, main: true } });
  assert.equal(both.status, 1, both.stdout);
  assert.equal(both.output, '');
  const onMain = runPin(t, { behind: { staging: '0', main: '0' }, compareFails: { staging: true } });
  assert.equal(onMain.status, 0, onMain.stdout + onMain.stderr);
  assert.equal(onMain.output, `sha=${COMMIT}\n`);
  assert.match(onMain.stdout, /is on main/);
});

for (const [form, ref, endpoint] of [
  ['a full SHA', COMMIT, COMMIT],
  ['a short SHA', 'ccccccc', 'ccccccc'],
  ['a branch name with a slash', 'release/2026-10', 'release%2F2026-10'],
  ['a tag name', 'v1.4.0', 'v1.4.0'],
]) {
  test(`${form} is resolved through its own commits endpoint and pins the full SHA`, (t) => {
    const out = runPin(t, { ref, commitPath: endpoint, behind: { staging: '0' } });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(out.calls.split('\n')[0], `api repos/${REPO}/commits/${endpoint} --jq .sha`);
    assert.equal(out.output, `sha=${COMMIT}\n`);
    assert.match(out.output, /^sha=[0-9a-f]{40}\n$/);
  });
}

test('a ref with characters no branch, tag or SHA needs is refused before any API call', (t) => {
  for (const ref of ['', '::stop-commands::x', '-x', '/staging', 'staging/', 'a..b', 'a//b', 'staging?x=1', 'staging#x', 'a b', '$(id)']) {
    const out = runPin(t, { ref, behind: { staging: '0' } });
    assert.equal(out.status, 1, JSON.stringify(ref));
    assert.equal(out.calls, '', JSON.stringify(ref));
    assert.equal(out.output, '', JSON.stringify(ref));
  }
});
