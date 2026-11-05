import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REQUIRED_CHECKS } from './required-checks.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
// The opt-in Gmail-replay journey: ci.yml's e2e_gmail job calls it (owner decision 2026-10-08).
const gmailWorkflow = readFileSync(new URL('../../.github/workflows/e2e-gmail.yml', import.meta.url), 'utf8');
const required = ['Lint, typecheck, test, build', 'Phase 1 integration test (local Supabase)', 'E2E (hermetic)'];

for (const [id, text] of [['integration', workflow], ['e2e', workflow], ['journey', gmailWorkflow]]) {
  test(`${id}: Supabase startup restores registry fallback after setup-cli`, () => {
    const job = text.split(`\n  ${id}:\n`)[1].split(/\n  \w+:\n/)[0];
    const step = job.split('      - name: Start local Supabase and apply migrations\n')[1];
    const shell = step.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
    // setup-cli exports GHCR to subsequent steps. Exercise the actual startup
    // shell with that inherited environment, without touching a real database.
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
      supabase() {
        test -z "\${SUPABASE_INTERNAL_IMAGE_REGISTRY:-}" || return 1
        printf '%s\\n' "$*"
      }
      ${shell}
    `], {
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_INTERNAL_IMAGE_REGISTRY: 'ghcr.io' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'start --exclude studio,postgres-meta,edge-runtime,realtime,logflare,vector',
    ]);
  });
}

for (const name of required) {
  test(`${name}: docs, source and unsuccessful detection gates`, (t) => {
    const job = workflow.split(/\n  \w+:\n/).find((block) => block.includes(`name: ${name}\n`));
    assert.ok(job);
    // needs: changes, or a list that includes it (the verify aggregate).
    assert.match(job, /\n    needs: (changes|\[changes(, \w+)+\])\n/);
    // Job level, not just some step's if.
    assert.match(job, /\n    if: \$\{\{ always\(\) \}\}\n/);
    // Execute the actual workflow shell, including its decision output. This
    // catches failed/cancelled/missing detector results becoming green skips.
    const gate = job.match(/id: gate\n[\s\S]*?        run: \|\n((?:          .*\n|\n)+)/);
    assert.ok(gate, 'required check needs an explicit gate');
    const shell = gate[1].replace(/^          /gm, '');
    const dir = mkdtempSync(path.join(tmpdir(), 'ci-gate-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [result, docs, exit, output] of [
      ['success', 'true', 0, 'run=false\n'],
      ['success', 'false', 0, 'run=true\n'],
      ['failure', 'true', 1, ''], ['cancelled', 'true', 1, ''],
      ['skipped', 'true', 1, ''], ['', '', 1, ''],
      ['success', '', 1, ''], ['success', 'unexpected', 1, ''],
    ]) {
      const outputFile = path.join(dir, `${result}-${docs}`);
      const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
        encoding: 'utf8',
        env: { ...process.env, DETECTION_RESULT: result, DOCS_ONLY: docs, GITHUB_OUTPUT: outputFile },
      });
      assert.equal(run.status, exit, `${result}/${docs}: ${run.stderr}`);
      if (exit === 0) assert.equal(readFileSync(outputFile, 'utf8'), output);
    }
    const steps = job.split('      - name: ').slice(2);
    assert.ok(steps.length > 0);
    for (const step of steps) assert.match(step, /if: .*steps\.gate\.outputs\.run == 'true'/, step.split('\n')[0]);
  });
}

test('security always runs, retaining audit thresholds without installation', () => {
  // Sliced to its own block, so a job added after it cannot fall inside these pins.
  const job = workflow.split('\n  security:\n')[1].split(/\n  \w+:\n/)[0];
  assert.ok(job);
  assert.match(job, /name: Dependency vulnerability audit/);
  assert.doesNotMatch(job, /needs:|npm ci|cache: npm/);
  assert.match(job, /run: npm audit --package-lock-only --omit=dev --audit-level=moderate/);
  assert.match(job, /continue-on-error: true\n        run: npm audit --package-lock-only --audit-level=moderate/);
});

// The Secret scan is a required check that runs on every pull request and push,
// docs-only ones included. It runs on persistent runners, so the scanner is
// fetched fresh, verified against a pinned digest and called by absolute path.
// The shell behaviour of the range step is exercised in secret-scan.test.mjs.
test('secret scan always runs, read-only, with a verified binary called by absolute path', () => {
  // Not jobBlock(): that helper is defined further down this file. The leading newline matches its shape.
  const body = workflow.split('\n  secrets:\n')[1]?.split(/\n  \w+:\n/)[0];
  assert.ok(body, 'the secrets job exists');
  const job = `\n${body}`;
  assert.match(job, /\n    name: Secret scan\n/);
  assert.match(job, /\n    timeout-minutes: 10\n/);
  assert.equal(job.match(/\n    permissions:/g)?.length, 1, 'one job-level permissions block');
  assert.match(job, /\n    permissions:\n      contents: read\n(?! {6})/, 'permissions are exactly contents: read');
  assert.doesNotMatch(job, /\n    (needs|if):/, 'no needs and no job-level if: it always reports');
  assert.doesNotMatch(job, /npm ci|setup-node|pull_request_target/);
  assert.doesNotMatch(job, /\$\{\{[^}]*\bsecrets\./, 'no repository secret is read');

  const steps = job.split('      - name: ').slice(1);
  const runOf = (step) => step.match(/\n        run: \|\n((?:          .*\n|\n)+)/)?.[1].replace(/^          /gm, '') ?? '';
  const stepNamed = (text) => steps.find((step) => step.startsWith(text));
  const runs = steps.map(runOf).join('\n');
  assert.doesNotMatch(runs, /\$\{\{/, 'expressions reach a script through env, never inline');

  const checkout = stepNamed('Checkout');
  assert.match(checkout, /uses: actions\/checkout@v4/);
  assert.match(checkout, /\n          fetch-depth: 0\n/);
  assert.match(checkout, /\n          persist-credentials: false\n/);

  // Integrity: a fresh temp dir under RUNNER_TEMP, a pinned 64-hex digest checked by sha256sum, an absolute path.
  const install = stepNamed('Install');
  assert.match(install, /\n        id: tool\n/);
  assert.match(runOf(install), /mktemp -d "\$RUNNER_TEMP\/gitleaks\.XXXXXX"/);
  assert.match(runOf(install), /GITLEAKS_VERSION=\d+\.\d+\.\d+\n/);
  assert.match(runOf(install), /\nGITLEAKS_SHA256=[0-9a-f]{64}\n/);
  assert.match(runOf(install), /echo "\$GITLEAKS_SHA256 {2}\$dir\/\$file" \| sha256sum -c -\n/);
  assert.match(runOf(install), /echo "bin=\$dir\/gitleaks" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(runs, /(?<![\w"$./-])gitleaks\s+(dir|git|detect|protect|version)\b/, 'no bare gitleaks command: only "$GITLEAKS"');
  const invoked = [...runs.matchAll(/^\s*"\$GITLEAKS" (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(invoked, ['dir', 'dir', 'git', 'dir'], 'self-test probe, self-test, commit range, merge tree');
  // Each invocation, continuation lines included, redacts and ignores inline gitleaks:allow.
  for (const call of runs.match(/^\s*"\$GITLEAKS" \w+(?:[^\n]*\\\n)*[^\n]*/gm)) {
    assert.match(call, /--redact/, `${call.trim().split('\n')[0]}: no secret value reaches the log`);
    assert.match(call, /--ignore-gitleaks-allow/, `${call.trim().split('\n')[0]}: inline gitleaks:allow is ignored`);
  }
  for (const step of steps.filter((text) => runOf(text).includes('"$GITLEAKS"'))) {
    assert.match(runOf(step), /--redact/, `${step.split('\n')[0]}: no secret value reaches the log`);
    assert.match(step, /\n          GITLEAKS: \$\{\{ steps\.tool\.outputs\.bin \}\}\n/, `${step.split('\n')[0]}: the absolute path comes from the install step`);
    // An inline gitleaks:allow comment is a suppression the PR writes itself, so no scan honours it.
    assert.match(runOf(step), /--ignore-gitleaks-allow/, `${step.split('\n')[0]}: inline gitleaks:allow is ignored`);
  }

  // A pull request reads the config and ignore file from the base commit, so it cannot allowlist itself.
  const cfg = stepNamed('Resolve the config');
  assert.match(cfg, /\n          BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n/);
  assert.match(runOf(cfg), /git show "\$\{BASE_SHA\}:\.gitleaks\.toml"/);
  assert.match(runOf(cfg), /git show "\$\{BASE_SHA\}:\.gitleaksignore"/);

  // The self-test seeds runtime-random canaries (never a committed literal) that must be detected:
  // one behind a gitleaks:allow marker, and a new credential in every allowlisted path.
  // Its shell is exercised against a stub scanner in secret-scan.test.mjs.
  const selfTest = stepNamed('Self-test');
  assert.match(runOf(selfTest), /\/dev\/urandom/);
  assert.match(runOf(selfTest), /tr -dc 'A-Za-z0-9'/);
  assert.match(runOf(selfTest), /ghp_\$\{pool:0:36\}/);
  assert.match(runOf(selfTest), /gitleaks:allow/);
  assert.match(runOf(selfTest), /"\$CONFIG"/, 'the allowlisted paths are read from the effective config');
  for (const rule of ['github-pat', 'generic-api-key', 'jwt', 'curl-auth-header']) assert.match(runOf(selfTest), new RegExp(rule), rule);
  assert.match(runOf(selfTest), /"\$code" -ne 1/);

  const range = stepNamed('Scan the commit range');
  for (const name of ['EVENT', 'PR_BASE', 'PR_HEAD', 'BEFORE', 'AFTER']) assert.match(range, new RegExp(`\\n          ${name}: \\$\\{\\{ `), name);
  assert.match(runOf(range), /git merge-base "\$PR_BASE" "\$range_head"/);
  assert.match(runOf(range), /--log-opts="\$range_base\.\.\$range_head"/);
  assert.match(runOf(range), /--config "\$CONFIG" --gitleaks-ignore-path "\$IGNORE"/);

  const tree = stepNamed('Scan the merge tree');
  assert.match(runOf(tree), /"\$GITLEAKS" dir \. --config "\$CONFIG" --gitleaks-ignore-path "\$IGNORE" --ignore-gitleaks-allow --redact/);
  for (const step of [range, tree]) assert.match(runOf(step), /--exit-code 1/);

  // Persistent runners keep RUNNER_TEMP between jobs: the binary and the canaries go, pass or fail.
  const cleanup = steps.at(-1);
  assert.match(cleanup, /^Remove the scanner and its canaries\n/);
  assert.match(cleanup, /\n        if: always\(\)\n/);
  assert.match(runOf(cleanup), /rm -rf -- "\$RUNNER_TEMP"\/gitleaks\.\*/);
});

// The scanner config keeps the default rules: a custom config otherwise replaces them.
test('the gitleaks config extends the defaults', () => {
  const config = readFileSync(new URL('../../.gitleaks.toml', import.meta.url), 'utf8');
  // Section-anchored, so a commented line or the wrong table does not satisfy it.
  assert.match(config, /^\[extend\]\s*\n(?:[^[\n].*\n)*?useDefault\s*=\s*true/m);
});

// An allowlist names one reviewed value, never a whole file or rule: path, rule and an
// anchored value regex must all match. The self-test seeds every path written here, so
// each path keeps the one shape its reader understands.
test('every gitleaks allowlist is narrowed to exact values in named files', () => {
  const config = readFileSync(new URL('../../.gitleaks.toml', import.meta.url), 'utf8')
    .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(config, /^\[allowlist\]/m, 'no global allowlist');
  const blocks = config.split(/^\[\[allowlists\]\]\n/m).slice(1).map((block) => block.split(/^\[/m)[0]);
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    const name = block.match(/description = "(.*)"/)?.[1] ?? block;
    assert.match(block, /^condition = "AND"$/m, `${name}: condition AND`);
    assert.match(block, /^targetRules = \[.+\]$/m, `${name}: scoped to rules`);
    assert.doesNotMatch(block, /^(commits|stopwords|regexTarget) =/m, `${name}: no broader matcher`);
    const array = (key) => block.match(new RegExp(`^${key} = \\[([\\s\\S]*?)\\]$`, 'm'))?.[1].match(/'''.*?'''/g) ?? [];
    const paths = array('paths');
    const regexes = array('regexes');
    assert.ok(paths.length > 0, `${name}: names its files`);
    assert.ok(regexes.length > 0, `${name}: names its values`);
    for (const p of paths) assert.match(p, /^'''\(\^\|\/\)(?:[A-Za-z0-9_/-]|\\\.)+\$'''$/, `${name}: ${p}`);
    for (const r of regexes) assert.match(r, /^'''\^/, `${name}: ${r} is anchored at the value's start`);
  }
});

// The self-test builds its canary at run time. A literal in the tree would be a finding
// and would let the self-test pass on a committed value.
test('no tracked file holds a github-pat-shaped literal', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const found = spawnSync('git', ['grep', '-I', '-l', '-E', 'ghp_[0-9A-Za-z]{36}'], { cwd: root, encoding: 'utf8' });
  assert.equal(found.status, 1, `git grep exit ${found.status}: ${found.stdout}${found.stderr}`);
});

test('every check the staging promotion requires is a job in this workflow', () => {
  for (const name of REQUIRED_CHECKS) assert.match(workflow, new RegExp(`\n    name: ${name.replace(/[()]/g, '\\$&')}\n`), name);
});

test('the develop alert fires only on a failed push to develop and gates nothing', () => {
  const job = workflow.split('\n  alert:\n')[1].split(/\n  \w+:\n/)[0];
  assert.match(job, /needs: \[verify, integration, e2e, security, secrets\]/);
  // failure() excludes cancelled: a newer merge cancels an older run on purpose.
  // !cancelled(): verify runs under always(), so a cancelled run turns it red.
  assert.match(job, /if: \$\{\{ failure\(\) && !cancelled\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/develop' \}\}/);
  // The commit message is attacker-controlled: env only, never in the script.
  assert.doesNotMatch(job.split('        run: |\n')[1], /\$\{\{/);
  assert.ok(!REQUIRED_CHECKS.includes('Alert when develop is red'));
});

test('staging promotion requires develop checks on the pinned commit, then fast-forwards', () => {
  const promote = readFileSync(new URL('../../.github/workflows/promote-develop-to-staging.yml', import.meta.url), 'utf8');
  assert.match(promote, /workflow_dispatch:/);
  assert.match(promote, /commits\/\$\{SHA\}\/check-runs/);
  assert.match(promote, /node scripts\/ci\/required-checks\.mjs/);
  assert.match(promote, /git merge --ff-only "\$\{SHA\}"\n\s+git push origin staging/);
  const release = readFileSync(new URL('../../.github/workflows/promote-staging-to-main.yml', import.meta.url), 'utf8');
  assert.match(release, /ref: staging/);
  assert.match(release, /uses: \.\/\.github\/workflows\/migrate\.yml\n    with:\n      environment: db-production\n/);
});

test('workflow keeps PR and develop/main triggers without top-level path filtering', () => {
  const triggers = workflow.split('\nconcurrency:')[0];
  assert.match(triggers, /\n  pull_request:\n(?:    #.*\n)*    types: \[opened, synchronize, reopened, ready_for_review\]\n/, 'marking a draft ready re-runs CI');
  assert.match(triggers, /- develop/);
  assert.match(triggers, /- main/);
  assert.doesNotMatch(triggers, /paths(-ignore)?:/);
  assert.match(workflow, /fetch-depth: 0/);
});

// The verify aggregate: the required "Lint, typecheck, test, build" does no
// work itself; the workers it needs do. These pin the wiring, so a worker that
// is added, renamed or mis-gated cannot drop out of the required check.
// Each block starts with a newline, so a job's first line matches /\n    key: /.
const jobBlock = (id) => {
  const block = workflow.split(`\n  ${id}:\n`)[1]?.split(/\n  \w+:\n/)[0];
  return block === undefined ? undefined : `\n${block}`;
};
const jobIds = [...workflow.split('\njobs:\n')[1].matchAll(/(?:^|\n)  (\w+):\n    /g)].map((m) => m[1]);
const verifyJob = jobBlock('verify');
// A job's needs, scalar (needs: changes) or list (needs: [changes, x]).
const jobNeeds = (id) => {
  const m = jobBlock(id).match(/\n    needs: (?:\[([^\]]+)\]|(\w+))\n/);
  return m ? (m[1] ?? m[2]).split(/,\s*/) : [];
};
const verifyNeeds = jobNeeds('verify');
const workers = verifyNeeds.filter((id) => id !== 'changes');
const workerGate = "if: ${{ needs.changes.result == 'success' && needs.changes.outputs.docs_only == 'false' }}";

test('verify aggregates every worker that hangs off change detection', () => {
  assert.ok(verifyJob.includes('\n    name: Lint, typecheck, test, build\n'));
  assert.ok(verifyNeeds.includes('changes'));
  assert.ok(workers.length >= 2, workers.join());
  const requiredJobs = jobIds.filter((id) => REQUIRED_CHECKS.some((name) => jobBlock(id).includes(`\n    name: ${name}\n`)));
  // e2e_gmail is advisory and opt-in by label (owner decision 2026-10-08),
  // infra_validate is advisory and path-gated, e2e_work_identity is advisory
  // and path-gated (#316), and sast is advisory static analysis: none of them is a verify worker.
  const advisory = ['alert', 'e2e_gmail', 'infra_validate', 'e2e_work_identity', 'sast'];
  const hangsOffChanges = jobIds.filter((id) => !requiredJobs.includes(id) && !advisory.includes(id) && jobNeeds(id).includes('changes'));
  assert.ok(!verifyNeeds.includes('e2e_gmail'), 'e2e_gmail is not in verify\'s needs');
  assert.deepEqual([...hangsOffChanges].sort(), [...workers].sort(), 'every non-required job that needs changes is a verify worker');
  for (const id of workers) {
    const job = jobBlock(id);
    assert.ok(job, id);
    assert.ok(job.includes(`\n    ${workerGate}\n`), `${id}: job-level gate on successful, non-docs detection`);
    assert.doesNotMatch(job, /always\(\)/, `${id}: a worker never runs on failed detection`);
    assert.match(job, /run: npm ci --no-audit/, id);
    const name = job.match(/\n    name: (.*)\n/)[1];
    assert.ok(!REQUIRED_CHECKS.some((required) => name.includes(required)), `${id}: a worker must not carry a required name`);
  }
  // The verdict reads exactly the workers' results, through env only.
  const verdictStep = verifyJob.split('      - name: ').find((step) => step.includes('id: verdict'));
  const results = [...verdictStep.matchAll(/\n          (\w+)_RESULT: \$\{\{ needs\.(\w+)\.result \}\}/g)].map((m) => m[2]);
  assert.deepEqual([...results].sort(), [...workers].sort());
  // Both steps run under always(): a cancelled run is red, never a skipped pass.
  const steps = verifyJob.split('      - name: ').slice(1);
  assert.equal(steps.length, 2);
  for (const step of steps) assert.match(step, /\n        if: \$\{\{ always\(\)/, step.split('\n')[0]);
});

test('verify verdict: only all-success is green', () => {
  const verdict = verifyJob.match(/id: verdict\n[\s\S]*?        run: \|\n((?:          .*\n|\n)+)/);
  assert.ok(verdict, 'verify needs an explicit verdict step');
  const shell = verdict[1].replace(/^          /gm, '');
  // The env names the step declares, and the job each one reads; the shell must read every one.
  const step = verifyJob.split('      - name: ').find((text) => text.includes('id: verdict'));
  const jobOf = Object.fromEntries([...step.matchAll(/\n          (\w+): \$\{\{ needs\.(\w+)\.result \}\}/g)].map((m) => [m[1], m[2]]));
  const vars = Object.keys(jobOf);
  assert.deepEqual(Object.values(jobOf).sort(), [...workers].sort());
  for (const v of vars) assert.ok(shell.includes(`\${${v}`), `the verdict shell reads ${v}`);
  const run = (env) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], { encoding: 'utf8', env: { ...process.env, ...env } });
  const allSuccess = Object.fromEntries(vars.map((v) => [v, 'success']));
  assert.equal(run(allSuccess).status, 0);
  for (const v of vars) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      const out = run({ ...allSuccess, [v]: result });
      assert.equal(out.status, 1, `${v}=${result}`);
      assert.match(out.stdout, new RegExp(`::error::${jobOf[v]} concluded '${result}'`), `${v}=${result}`);
    }
  }
  // Workers skipped on a source change (say, a typo in their gate) is red.
  assert.equal(run(Object.fromEntries(vars.map((v) => [v, 'skipped']))).status, 1);
});

test('the split dropped no former step, and the shards cover 1..N', () => {
  for (const command of [
    'node --test scripts/ci/*.test.mjs',
    'npm run lint',
    'npm run check:migrations',
    'npx tsc --noEmit',
    'npm --prefix evals/deal-discovery ci --no-audit',
    'npm --prefix evals/deal-discovery test',
    'npm run build',
  ]) {
    assert.ok(workers.some((id) => jobBlock(id).includes(`run: ${command}`) || jobBlock(id).includes(`\n          ${command}\n`)), command);
  }
  const unit = jobBlock('unit');
  const shards = unit.match(/\n        shard: \[([^\]]+)\]\n/)[1].split(/,\s*/).map(Number);
  assert.deepEqual(shards, shards.map((_, i) => i + 1));
  assert.ok(unit.includes(`run: npm test -- --shard=\${{ matrix.shard }}/${shards.length}`));
  assert.ok(unit.includes(`name: Vitest (shard \${{ matrix.shard }}/${shards.length})`));
  // Workers have no gate step; it lives in verify. A step condition on
  // steps.gate (or steps.verdict) inside a worker is always false, so the step
  // would be skipped on every run without failing anything. Workers are gated
  // at job level instead.
  for (const id of workers) assert.doesNotMatch(jobBlock(id), /steps\.(gate|verdict)\./, `${id}: a worker step must not read another job's step outputs`);
  // tests/ci-db-tests.test.ts reads the first RUN_DB_TESTS line; workers never carry one.
  for (const id of workers) assert.doesNotMatch(jobBlock(id), /RUN_DB_TESTS/, id);
});

// E2E's steps carry an implicit success(), so a run cancelled on a source
// change would skip the suite and leave the required check green or skipped.
// Its gate runs under always(), and its last step fails exactly that case.
test('E2E reports a run cancelled on a source change as red, and only that', () => {
  const job = jobBlock('e2e');
  const steps = job.split('      - name: ').slice(1);
  assert.match(steps[0], /^Validate change detection\n        id: gate\n        if: \$\{\{ always\(\) \}\}\n/);
  const guard = steps.at(-1);
  assert.match(guard, /\n        if: \$\{\{ cancelled\(\) && steps\.gate\.outputs\.run == 'true' && steps\.suite\.outcome != 'success' \}\}\n/, 'the guard is the last step');
  // A suite that already passed is never reported red by a late cancel: the guard reads the suite step's outcome.
  assert.equal(steps.filter((step) => /\n        id: suite\n/.test(step)).length, 1);
  assert.match(steps.find((step) => /\n        id: suite\n/.test(step)), /\n          npm run test:e2e\n/, 'id: suite is the step that runs the suite');
  const shell = guard.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
  const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /::error::/);
  // Only one step may run on a cancelled run: no other step may reach for cancelled() or always().
  // Comment lines are dropped: the guard's own comment sits above its `- name:`.
  for (const step of steps.slice(1, -1)) assert.doesNotMatch(step.replace(/^ *#.*$/gm, ''), /cancelled\(\)|always\(\)/, step.split('\n')[0]);
});

for (const id of ['integration', 'e2e']) {
  test(`${id}: skips its suite on a draft pull request, and only there`, (t) => {
    const gateStep = jobBlock(id).split('      - name: ')[1];
    assert.match(gateStep, /\n          PR_DRAFT: \$\{\{ github\.event\.pull_request\.draft \}\}\n/);
    const shell = gateStep.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
    const dir = mkdtempSync(path.join(tmpdir(), 'ci-draft-gate-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [result, docs, draft, exit, output] of [
      ['success', 'false', 'true', 0, 'run=false\n'],
      ['success', 'false', 'false', 0, 'run=true\n'],
      ['success', 'false', '', 0, 'run=true\n'],
      ['success', 'true', 'false', 0, 'run=false\n'],
      ['failure', 'false', 'true', 1, ''],
      ['cancelled', 'true', 'true', 1, ''],
    ]) {
      const outputFile = path.join(dir, `${result}-${docs}-${draft}`);
      const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
        encoding: 'utf8',
        env: { ...process.env, DETECTION_RESULT: result, DOCS_ONLY: docs, PR_DRAFT: draft, GITHUB_OUTPUT: outputFile },
      });
      assert.equal(run.status, exit, `${result}/${docs}/draft=${draft}: ${run.stderr}`);
      if (exit === 0) assert.equal(readFileSync(outputFile, 'utf8'), output, `${result}/${docs}/draft=${draft}`);
    }
  });
}

// The Gmail-replay journey is advisory and opt-in (owner decision 2026-10-08):
// ci.yml's e2e_gmail runs it on a push to develop or for a labelled PR, never
// as a verify worker; its own workflow adds the label trigger and the nightly.
// When it runs, a failing journey must fail its job: no continue-on-error, a
// bounded runtime, the suite on the default success() condition, read-only.
test('e2e_gmail: opt-in by label, on develop and nightly; never a required worker', () => {
  const caller = jobBlock('e2e_gmail');
  assert.ok(caller, 'the e2e_gmail job exists');
  assert.ok(!verifyNeeds.includes('e2e_gmail'), 'not in verify needs');
  assert.doesNotMatch(verifyJob, /e2e_gmail|E2E_GMAIL/, 'verify reads nothing from it');
  assert.match(caller, /\n    uses: \.\/\.github\/workflows\/e2e-gmail\.yml\n/);
  const gate = caller.match(/\n    if: \$\{\{ (.*) \}\}\n/)[1];
  assert.ok(gate.startsWith(`needs.changes.result == 'success' && needs.changes.outputs.docs_only == 'false' && `), gate);
  assert.ok(gate.includes("(contains(github.event.pull_request.labels.*.name, 'e2e-gmail') && !github.event.pull_request.draft)"), 'a pull request runs it only with the label, and never as a draft');
  assert.ok(gate.includes("(github.event_name == 'push' && github.ref == 'refs/heads/develop')"), 'every push to develop runs it');
  assert.doesNotMatch(caller, /always\(\)|continue-on-error/);
  assert.match(caller, /\n    permissions:\n      contents: read\n(?! {6})/);

  const triggers = gmailWorkflow.split('\njobs:\n')[0];
  assert.match(triggers, /\n  workflow_call:\n/);
  assert.match(triggers, /\n  pull_request:\n    types: \[labeled\]\n/, 'labelling starts it, and nothing else on a pull request');
  assert.match(triggers, /\n  schedule:\n(?:    #.*\n)*    - cron: '[^']+'\n/, 'a nightly');
  // The schedule lives in this workflow only: ci.yml must never start every job on a cron.
  assert.doesNotMatch(workflow.split('\njobs:\n')[0], /schedule:/);
});

test('the Gmail journey job fails on a failing journey, and only reads the repo', () => {
  const job = `\n${gmailWorkflow.split('\n  journey:\n')[1]}`;
  assert.match(job, /\n    if: \$\{\{ github\.event\.action != 'labeled' \|\| \(github\.event\.label\.name == 'e2e-gmail' && !github\.event\.pull_request\.draft\) \}\}\n/, 'a label event runs it for e2e-gmail only, never on a draft');
  assert.equal(job.match(/\n    permissions:/g)?.length, 1, 'one job-level permissions block');
  assert.match(job, /\n    permissions:\n      contents: read\n(?! {6})/, 'permissions are exactly contents: read');
  assert.match(gmailWorkflow, /\npermissions:\n  contents: read\n/, 'workflow permissions are exactly contents: read');
  assert.doesNotMatch(gmailWorkflow, /continue-on-error|always\(\)/, 'no job or step may swallow a failure');
  assert.match(job, /run: npm ci --no-audit/);
  const timeout = job.match(/\n    timeout-minutes: (\d+)\n/);
  assert.ok(timeout, 'a job-level timeout-minutes');
  assert.ok(Number(timeout[1]) > 0 && Number(timeout[1]) <= 60, `timeout-minutes ${timeout[1]} is bounded`);
  const steps = job.split('      - name: ').slice(1);
  const suite = steps.filter((step) => /\n {10}npm run test:e2e:discovery-gmail\n/.test(step));
  assert.equal(suite.length, 1, 'one step runs npm run test:e2e:discovery-gmail');
  assert.doesNotMatch(suite[0], /\n {8}if: /, 'the suite step runs on the default success() condition');
  const uploads = steps.filter((step) => step.includes('uses: actions/upload-artifact'));
  assert.equal(uploads.length, 1, 'one upload step');
  assert.match(uploads[0], /\n {8}if: failure\(\)\n/, 'the report uploads only on failure');
  assert.match(uploads[0], /\n {10}name: e2e-gmail-report\n/, 'the artifact is e2e-gmail-report');
});

// The Microsoft work-identity journey (#316) is advisory like e2e_gmail: it runs on
// a push to develop and on a pull request that touches the sign-in path, and it
// blocks no merge. Its workflow edits the checkout's Supabase config, never a hosted project.
test('e2e_work_identity: advisory, path-gated, develop pushes; never a required worker', () => {
  const caller = jobBlock('e2e_work_identity');
  assert.ok(caller, 'the e2e_work_identity job exists');
  assert.ok(!verifyNeeds.includes('e2e_work_identity'), 'not in verify needs');
  assert.doesNotMatch(verifyJob, /e2e_work_identity|work_identity/, 'verify reads nothing from it');
  assert.match(caller, /\n    uses: \.\/\.github\/workflows\/e2e-work-identity\.yml\n/);
  assert.match(caller, /\n    needs: changes\n/);
  const gate = caller.match(/\n    if: \$\{\{ (.*) \}\}\n/)[1];
  assert.ok(gate.startsWith(`needs.changes.result == 'success' && (`), gate);
  // Every push to develop runs it, a docs-only one too: docs_only gates pull requests only.
  assert.ok(gate.includes("(github.event_name == 'push' && github.ref == 'refs/heads/develop')"), 'every push to develop runs it');
  assert.doesNotMatch(gate.split('||')[0], /docs_only/, 'a docs-only develop push still runs it');
  assert.ok(
    gate.includes("(github.event_name == 'pull_request' && needs.changes.outputs.docs_only == 'false' && needs.changes.outputs.work_identity == 'true')"),
    'a pull request runs it only when the sign-in path changed and it is not docs-only',
  );
  assert.doesNotMatch(caller, /always\(\)|continue-on-error/);
  assert.match(caller, /\n    permissions:\n      contents: read\n/);
  assert.match(caller, /\n    with:\n      provider: \$\{\{ vars\.WORK_IDENTITY_E2E_PROVIDER \|\| 'azure' \}\}\n/, 'the keycloak fallback is selectable without a code change');
  assert.match(jobBlock('changes'), /\n      work_identity: \$\{\{ steps\.work_identity\.outputs\.run \}\}\n/);

  const reusable = readFileSync(new URL('../../.github/workflows/e2e-work-identity.yml', import.meta.url), 'utf8');
  assert.match(reusable, /\n  workflow_call:\n/);
  assert.doesNotMatch(reusable.split('\njobs:\n')[0], /schedule:|pull_request:/, 'it starts from ci.yml or by hand, never on its own events');
  assert.match(reusable, /\npermissions:\n  contents: read\n/);
  assert.doesNotMatch(reusable, /continue-on-error: false|always\(\)/);
  assert.match(reusable, /scripts\/ci\/enable-work-identity-broker\.sh "\$PROVIDER"/);
  assert.match(reusable, /azure provider/);
  assert.match(reusable, /keycloak fallback/);
});

test('infra_validate allocates a runner only when the module, its runbook or this workflow changed', (t) => {
  const changes = jobBlock('changes');
  assert.match(changes, /\n      infra: \$\{\{ steps\.infra\.outputs\.run \}\}\n/);
  const job = jobBlock('infra_validate');
  assert.match(job, /\n    needs: changes\n/);
  assert.match(job, /\n    if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.infra != 'false' \}\}\n/, 'a failed detection still runs it');
  assert.doesNotMatch(job, /steps\.paths|fetch-depth/);

  const step = changes.split('      - name: ').find((text) => text.includes('id: infra'));
  const shell = step.match(/        run: \|\n((?:          .*\n|\n)+)/)[1].replace(/^          /gm, '');
  const cwd = mkdtempSync(path.join(tmpdir(), 'ci-infra-gate-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (file) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), `${file} ${Math.random()}`);
    git('add', '.');
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI Test');
  const root = commit('README.md');
  const decide = (event, base, head) => {
    const output = path.join(cwd, '.git', 'output');
    writeFileSync(output, '');
    const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
      cwd, encoding: 'utf8', env: { ...process.env, EVENT: event, BASE: base, HEAD: head, GITHUB_OUTPUT: output },
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(output, 'utf8');
  };

  git('checkout', '-qb', 'feature');
  const source = commit('src/app/page.tsx');
  assert.equal(decide('pull_request', root, source), 'run=false\n', 'a source-only pull request');
  const moduleChange = commit('infra/discovery-worker/main.tf');
  assert.equal(decide('pull_request', root, moduleChange), 'run=true\n', 'a pull request that touches the module');
  git('checkout', '-q', '-');
  const baseOnly = commit('worker/jobLog.ts');
  assert.equal(decide('pull_request', baseOnly, source), 'run=false\n', 'a change only on the base branch');
  assert.equal(decide('push', root, baseOnly), 'run=true\n', 'a push that touches the alarm log lines');
  assert.equal(decide('push', root, commit('.github/workflows/ci.yml')), 'run=true\n', 'a push that changes this workflow');
  assert.equal(decide('push', '0'.repeat(40), source), 'run=true\n', 'an unknown base runs it');
  assert.equal(decide('push', '', source), 'run=true\n', 'a missing base runs it');
});

test('a Next.js build cache is written only by a push to develop, one key per build environment', () => {
  const prefixes = [];
  for (const id of ['lint', 'e2e']) {
    const steps = jobBlock(id).split('      - name: ');
    const restore = steps.filter((step) => step.includes('uses: actions/cache/restore@'));
    const save = steps.filter((step) => step.includes('uses: actions/cache/save@'));
    assert.equal(restore.length, 1, id);
    assert.equal(save.length, 1, id);
    assert.match(save[0], /\n        if: .*github\.event_name == 'push' && github\.ref == 'refs\/heads\/develop'/, `${id}: only develop saves`);
    const key = (step) => step.match(/\n          key: (.*)\n/)[1];
    assert.equal(key(save[0]), key(restore[0]), `${id}: save writes the key restore looks for`);
    assert.match(restore[0], /\n          path: \.next\/cache\n/);
    assert.ok(key(restore[0]).endsWith('-${{ github.sha }}'), id);
    const prefix = key(restore[0]).replace('${{ github.sha }}', '');
    assert.ok(restore[0].includes(`restore-keys: |\n            ${prefix}\n`), `${id}: falls back to the newest cache for the same lockfile`);
    prefixes.push(prefix);
  }
  assert.notEqual(prefixes[0], prefixes[1], 'the hermetic build inlines other NEXT_PUBLIC_* values');
});

test('single-CPU runners carry only short jobs that need no Docker or browser', () => {
  // ADR-0027: the fleet variable may move a slim job, but its GitHub-hosted fallback stays ubuntu-slim.
  const slim = jobIds.filter((id) => /\n    runs-on: \$\{\{ vars\.CI_RUNNER_LIGHT \|\| 'ubuntu-slim' \}\}\n/.test(jobBlock(id)));
  assert.deepEqual([...slim].sort(), ['alert', 'changes', 'sast', 'secrets', 'security', 'verify']);
  for (const id of slim) {
    const minutes = Number(jobBlock(id).match(/\n    timeout-minutes: (\d+)\n/)[1]);
    assert.ok(minutes <= 15, `${id}: ubuntu-slim caps a job at 15 minutes`);
    assert.doesNotMatch(jobBlock(id), /supabase|docker|playwright|npm ci/, id);
  }
});

// Static analysis is advisory: it reports, but no ruleset requires it and verify never reads it.
// It installs from a hash lock into a fresh venv, runs only the free registry rulesets with
// metrics off, and on a pull request compares against the merge commit's first parent.
test('static analysis is advisory, read-only, hash-locked and baselined on the merge ref parent', () => {
  const body = jobBlock('sast');
  assert.ok(body, 'the sast job exists');
  assert.ok(!REQUIRED_CHECKS.includes('Static analysis'), 'not a required check');
  assert.ok(!verifyNeeds.includes('sast'), 'not a verify worker');
  assert.doesNotMatch(verifyJob, /sast/, 'verify reads nothing from it');

  // Comments describe the job; the pins below are about what it runs.
  const job = body.replace(/^ *#.*$/gm, '');
  assert.match(job, /\n    name: Static analysis\n/);
  assert.match(job, /\n    needs: changes\n/);
  const gate = job.match(/\n    if: \$\{\{ (.*) \}\}\n/)[1];
  assert.ok(gate.startsWith(`needs.changes.result == 'success' && needs.changes.outputs.docs_only == 'false'`), 'skipped on a docs-only or undetected change');
  assert.ok(gate.includes("(github.event_name == 'pull_request' || github.ref == 'refs/heads/develop')"), 'pull requests and develop only');
  assert.match(job, /\n    runs-on: \$\{\{ vars\.CI_RUNNER_LIGHT \|\| 'ubuntu-slim' \}\}\n/, 'the light pool, with the slim fallback the other light jobs use');
  assert.match(job, /\n    timeout-minutes: 15\n/);
  assert.equal(job.match(/\n    permissions:/g)?.length, 1, 'one job-level permissions block');
  assert.match(job, /\n    permissions:\n      contents: read\n(?! {6})/, 'permissions are exactly contents: read');
  assert.match(job, /\n    env:\n      SEMGREP_SEND_METRICS: 'off'\n/);
  assert.doesNotMatch(job, /pull_request_target|npm ci|setup-node|docker |always\(\)|continue-on-error/);
  assert.doesNotMatch(job, /\$\{\{[^}]*\bsecrets\./, 'no repository secret is read');
  assert.doesNotMatch(job, /--config auto|p\/default|semgrep ci/, 'no login-gated or AGPL-carrying ruleset');

  const steps = job.split('      - name: ').slice(1);
  const runOf = (step) => step.match(/\n        run: \|\n((?:          .*\n|\n)+)/)?.[1].replace(/^          /gm, '') ?? '';
  const stepNamed = (text) => steps.find((step) => step.startsWith(text));
  const runs = steps.map(runOf).join('\n');
  assert.doesNotMatch(runs, /\$\{\{/, 'expressions reach a script through env, never inline');
  assert.doesNotMatch(runs, /\bjq\b/, 'no jq: the report is read by the venv Python');

  // The merge commit's first parent is the base tip only with the full history checked out.
  const checkout = stepNamed('Checkout');
  assert.match(checkout, /uses: actions\/checkout@v4/);
  assert.match(checkout, /\n          fetch-depth: 0\n/);
  assert.match(checkout, /\n          persist-credentials: false\n/);

  const python = stepNamed('Setup Python');
  assert.match(python, /uses: actions\/setup-python@v5\n/);
  assert.match(python, /\n          python-version: '3\.12'\n/, 'the lock targets Python 3.12');

  // Integrity: a fresh venv under RUNNER_TEMP, hashes required, the engine called by absolute path.
  const install = stepNamed('Install');
  assert.match(install, /\n        id: tool\n/);
  assert.match(runOf(install), /mktemp -d "\$RUNNER_TEMP\/semgrep\.XXXXXX"/);
  // Wheels only: no source distribution is built (and its setup code run) on a persistent runner.
  assert.match(runOf(install), /"\$venv\/bin\/pip" install --no-cache-dir --only-binary=:all: --require-hashes -r \.github\/semgrep\/requirements\.txt\n/);
  assert.match(runOf(install), /echo "bin=\$venv\/bin\/semgrep" >> "\$GITHUB_OUTPUT"/);
  assert.match(runOf(install), /echo "python=\$venv\/bin\/python" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(runs, /(?<![\w"$./-])semgrep\s+(scan|ci|login|--)/, 'no bare semgrep command: only "$SEMGREP"');
  const invoked = [...runs.matchAll(/^\s*"\$SEMGREP" (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(invoked, ['scan', 'scan'], 'pull request scan, develop scan');
  const scans = steps.filter((step) => runOf(step).includes('"$SEMGREP"'));
  assert.equal(scans.length, 2);
  for (const step of scans) {
    const label = step.split('\n')[0];
    assert.match(step, /\n          SEMGREP: \$\{\{ steps\.tool\.outputs\.bin \}\}\n/, `${label}: the absolute path comes from the install step`);
    assert.ok(runOf(step).includes('--config p/javascript --config p/typescript --config p/react --config p/nodejs --config p/owasp-top-ten'), `${label}: the five registry rulesets`);
    for (const flag of ['--metrics=off', '--jobs 1', '--max-memory 3000', '--timeout 30']) assert.ok(runOf(step).includes(flag), `${label}: ${flag}`);
    // The report is trusted only after summarize.py has read it (semgrep-summary.test.mjs).
    assert.match(step, /\n          PYTHON: \$\{\{ steps\.tool\.outputs\.python \}\}\n/, `${label}: the venv Python`);
    assert.match(runOf(step), /if ! "\$PYTHON" \.github\/semgrep\/summarize\.py (pr|full) "\$report" > "\$summary"; then\n\s+echo "::error::/, `${label}: a missing or invalid report fails`);
  }

  // A pull request: red only for ERROR findings it adds, against the merge ref's first parent.
  const pr = stepNamed('Scan for findings the pull request adds');
  assert.match(pr, /\n        if: github\.event_name == 'pull_request'\n/);
  assert.match(runOf(pr), /--baseline-commit HEAD\^1 /);
  assert.match(runOf(pr), /--severity ERROR --error/);
  assert.match(runOf(pr), /git rev-parse --verify --quiet 'HEAD\^2'/, 'fails closed when the checkout is not the merge commit');
  assert.match(runOf(pr), /GITHUB_STEP_SUMMARY/);
  // 0 is clean and 1 is new findings; anything higher is the scanner failing.
  assert.match(runOf(pr), /if \[ "\$code" -gt 1 \]; then\n\s+echo "::error::[^\n]*"\n\s+exit "\$code"/);
  assert.match(runOf(pr), /\nexit "\$code"\n\s*$/, 'the last line exits with the scan code');

  // A push to develop: a full scan that records JSON. Findings never fail it (no --error), so
  // any non-zero exit is the scanner failing, and that is red.
  const push = stepNamed('Scan the whole tree');
  assert.match(push, /\n        if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/develop'\n/);
  assert.match(runOf(push), /report="\$RUNNER_TEMP\/semgrep\.json"/);
  assert.match(runOf(push), /--json -o "\$report"/);
  assert.doesNotMatch(runOf(push), /--error|--baseline-commit|--severity/);
  assert.match(runOf(push), /if \[ "\$code" -ne 0 \]; then\n\s+echo "::error::[^\n]*"\n\s+exit "\$code"/);
  assert.match(runOf(push), /GITHUB_STEP_SUMMARY/);

  const uploads = steps.filter((step) => step.includes('uses: actions/upload-artifact'));
  assert.equal(uploads.length, 1, 'one upload step');
  assert.match(uploads[0], /uses: actions\/upload-artifact@v4\n/);
  assert.match(uploads[0], /\n        if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/develop'\n/, 'only a push to develop keeps a record');
  assert.match(uploads[0], /\n          path: \$\{\{ runner\.temp \}\}\/semgrep\.json\n/);
  assert.match(uploads[0], /\n          retention-days: 90\n/);
  assert.match(uploads[0], /\n          if-no-files-found: error\n/, 'a missing report is red, not a warning');
});

// pip --require-hashes refuses a requirement without a hash, so a complete lock is also a pinned one.
test('the semgrep lock pins the engine and hashes every requirement', () => {
  const read = (name) => readFileSync(new URL(`../../.github/semgrep/${name}`, import.meta.url), 'utf8');
  const pinned = read('requirements.in').match(/^semgrep==(\S+)$/m)?.[1];
  assert.ok(pinned, 'requirements.in pins semgrep');
  const lock = read('requirements.txt');
  assert.ok(lock.includes(`\nsemgrep==${pinned} \\\n`), 'the lock holds the pinned engine version');
  // A requirement is a line at column 0 that is not a comment; its hashes follow, indented.
  const entries = lock.split(/\n(?=[^\s#])/).filter((text) => !text.startsWith('#'));
  assert.ok(entries.length > 1, 'semgrep and its transitive dependencies');
  for (const entry of entries) {
    assert.match(entry, /^[A-Za-z0-9_.-]+(\[[^\]]*\])?==\S+ \\\n/, entry.split('\n')[0]);
    assert.match(entry, /\n {4}--hash=sha256:[0-9a-f]{64}/, `${entry.split('\n')[0]}: at least one hash`);
  }
});
