import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./docs-only.mjs', import.meta.url));

function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ci-diff-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI Test');
  function commit(file, text = file) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
    git('add', '.');
    git('commit', '-qm', 'test change');
    return git('rev-parse', 'HEAD');
  }
  const base = commit('README.md', 'base');
  return { cwd, git, commit, base };
}

function classify(repo, eventName, event) {
  const eventPath = path.join(repo.cwd, '.git', 'event.json');
  const outputPath = path.join(repo.cwd, '.git', 'output');
  writeFileSync(eventPath, typeof event === 'string' ? event : JSON.stringify(event));
  writeFileSync(outputPath, '');
  const result = spawnSync(process.execPath, [script], {
    cwd: repo.cwd, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(outputPath, 'utf8').trim();
}

for (const file of ['README.md', 'docs/README.md', 'docs/06-research/cost.md', 'docs/03-engineering/ci.md']) {
  test(`documentation can skip: ${file}`, (t) => {
    const repo = repository(t);
    const after = repo.commit(file, 'documentation update');
    assert.equal(classify(repo, 'push', { before: repo.base, after }), 'docs_only=true');
  });
}

for (const file of ['src/app/page.tsx', 'tests/fixtures/memo.md', '.claude/skills/example/SKILL.md', 'skills/example.md', '.github/workflows/ci.yml', 'package-lock.json', 'docs/design/workbench/tokens.css', 'docs/06-research/hv-extraction/ledger/data.json', 'docs/06-research/nested/skill.md', 'docs/06-research/odd\nname.md']) {
  test(`source or unknown path runs CI: ${file}`, (t) => {
    const repo = repository(t);
    const after = repo.commit(file);
    assert.equal(classify(repo, 'push', { before: repo.base, after }), 'docs_only=false');
  });
}

test('PR diff includes earlier source commits and excludes base-only changes', (t) => {
  const repo = repository(t);
  repo.git('checkout', '-qb', 'feature');
  repo.commit('src/code.ts');
  const head = repo.commit('docs/06-research/note.md');
  repo.git('checkout', '-q', '--detach', repo.base);
  const base = repo.commit('src/base-only.ts');
  assert.equal(classify(repo, 'pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }), 'docs_only=false');
  repo.git('checkout', '-qb', 'docs', repo.base);
  const docsHead = repo.commit('README.md', 'docs');
  assert.equal(classify(repo, 'pull_request', { pull_request: { base: { sha: base }, head: { sha: docsHead } } }), 'docs_only=true');
});

test('push range includes all commits, not just HEAD parent', (t) => {
  const repo = repository(t);
  repo.commit('src/code.ts');
  const after = repo.commit('README.md', 'docs');
  assert.equal(classify(repo, 'push', { before: repo.base, after }), 'docs_only=false');
});

test('rename from a source fixture into docs cannot hide source deletion', (t) => {
  const repo = repository(t);
  const before = repo.commit('tests/fixture.md');
  repo.git('mv', '-f', 'tests/fixture.md', 'README.md');
  repo.git('commit', '-qm', 'move fixture');
  assert.equal(classify(repo, 'push', { before, after: repo.git('rev-parse', 'HEAD') }), 'docs_only=false');
});

test('deleted documentation remains documentation', (t) => {
  const repo = repository(t);
  repo.git('rm', 'README.md');
  repo.git('commit', '-qm', 'remove docs');
  assert.equal(classify(repo, 'push', { before: repo.base, after: repo.git('rev-parse', 'HEAD') }), 'docs_only=true');
});

test('unknown, incomplete, empty, forced and invalid events run full CI', (t) => {
  const repo = repository(t);
  const after = repo.commit('README.md', 'docs');
  const cases = [
    ['workflow_dispatch', {}], ['push', {}], ['push', '{'],
    ['push', { before: '0'.repeat(40), after }],
    ['push', { before: 'f'.repeat(40), after }],
    ['push', { before: repo.base, after: repo.base }],
    ['push', { before: repo.base, after, forced: true }],
    ['pull_request', { pull_request: { base: { sha: '--help' }, head: { sha: after } } }],
  ];
  for (const [name, event] of cases) assert.equal(classify(repo, name, event), 'docs_only=false');
});

test('non-ancestor push and shallow history run full CI', (t) => {
  const repo = repository(t);
  const before = repo.commit('README.md', 'old');
  repo.git('checkout', '-q', '--detach', repo.base);
  const after = repo.commit('README.md', 'replacement');
  assert.equal(classify(repo, 'push', { before, after }), 'docs_only=false');
  writeFileSync(path.join(repo.cwd, '.git/shallow'), `${repo.base}\n`);
  assert.equal(classify(repo, 'push', { before: repo.base, after }), 'docs_only=false');
});
