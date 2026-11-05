import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { ANSWER_KEY_ENV, defaultRepoRoot } from '../src/answerKey.ts';
import { harnessProvenance, parseScoreArgs, resolveOutDir, runCheckKey, runLabelFor, runScore } from '../src/cli.ts';
import { readExport } from '../src/exportData.ts';
import { removeTempDirs, scenario, tempDir, writeExport, writeKey } from './synthetic.ts';

after(removeTempDirs);

// The compiled command, next to this compiled test in dist/.
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function fakeRepo(): string {
  const repo = tempDir('dd-repo-');
  mkdirSync(join(repo, 'evals', 'deal-discovery'), { recursive: true });
  return repo;
}

describe('arguments', () => {
  it('requires --export and validates --run', () => {
    assert.deepEqual(parseScoreArgs(['--export', '/tmp/x']), { exportDir: '/tmp/x', outDir: null, run: null, redact: false });
    assert.equal(parseScoreArgs(['--export', '/tmp/x', '--redact']).redact, true);
    assert.throws(() => parseScoreArgs([]), /--export <dir> is required/);
    assert.throws(() => parseScoreArgs(['--export']), /--export needs a value/);
    assert.throws(() => parseScoreArgs(['--export', 'x', '--run', '../../etc']), /--run takes/);
    assert.throws(() => parseScoreArgs(['--export', 'x', '--key', 'k.json']), /unknown argument --key/);
  });

  it('labels a run by the export timestamp', () => {
    assert.equal(runLabelFor('2026-09-26T10:15:00.123Z'), '20260926T101500Z');
    assert.equal(runLabelFor('not a date'), 'export');
  });
});

describe('where the scorecard goes', () => {
  it('defaults to evals/out, and allows it or a directory outside the repo', () => {
    const repo = fakeRepo();
    assert.deepEqual(resolveOutDir(null, repo), { dir: join(repo, 'evals', 'out'), insideRepo: true });
    assert.deepEqual(resolveOutDir(join(repo, 'evals', 'out', 'week2'), repo), { dir: join(repo, 'evals', 'out', 'week2'), insideRepo: true });
    const outside = tempDir();
    assert.deepEqual(resolveOutDir(outside, repo), { dir: outside, insideRepo: false });
  });

  it('refuses anywhere else inside the repo, before creating it', () => {
    const repo = fakeRepo();
    const target = join(repo, 'docs', 'scorecards');
    assert.throws(() => resolveOutDir(target, repo), /--out points inside the repository/);
    assert.equal(existsSync(target), false);
  });

  it('refuses the main checkout when this is a linked worktree', () => {
    const worktree = fakeRepo();
    const main = tempDir('dd-main-');
    const target = join(main, 'scorecards');
    assert.throws(() => resolveOutDir(target, [worktree, main]), /--out points inside the repository/);
    assert.equal(existsSync(target), false);
  });
});

describe('runScore', () => {
  it('scores an export against a key held outside the repo and writes both scorecards', () => {
    const repo = fakeRepo();
    const secure = tempDir('dd-secure-');
    const { data, key } = scenario();
    const exportDir = writeExport(join(tempDir(), 'export'), data);
    const keyPath = writeKey(secure, key);
    const out = tempDir('dd-out-');

    const result = runScore(['--export', exportDir, '--out', out], {
      env: { [ANSWER_KEY_ENV]: keyPath },
      repoRoot: repo,
      provenance: { commit: 'abc1234', dirty: false },
    });
    assert.equal(result.markdownPath, join(out, 'scorecard-20260926T101500Z.md'));
    assert.equal(result.htmlPath, join(out, 'scorecard-20260926T101500Z.html'));
    const md = readFileSync(result.markdownPath, 'utf8');
    assert.match(md, /Discovery precision \(one-to-one\) \| 60\.0% \(3\/5\) \| 50\.0% \(3\/6\)/);
    assert.match(md, /Harness 1\.0\.0 at commit abc1234\. Tuning [0-9a-f]{12} \(frozen, src\/tuning\.ts\)\./);
    assert.ok(md.includes('Project Falcon'), 'a scorecard outside the repo is not redacted');
    assert.equal(result.redacted, false);
    assert.match(readFileSync(result.htmlPath, 'utf8'), /<h1>Deal discovery scorecard<\/h1>/);
    assert.equal(statSync(result.markdownPath).mode & 0o777, 0o600);
    assert.equal(result.headline[0], 'Discovery precision (one-to-one) post-rejection 60.0% (3/5), pre-rejection 50.0% (3/6)');
  });

  it('redacts a scorecard written inside the repository, and on --redact (review item 11)', () => {
    // The degenerate case: a real tenant's full scorecard in evals/out, inside the working copy.
    const repo = fakeRepo();
    const { data, key } = scenario();
    const exportDir = writeExport(join(tempDir(), 'export'), data);
    const env = { [ANSWER_KEY_ENV]: writeKey(tempDir('dd-secure-'), key) };
    const inRepo = runScore(['--export', exportDir], { env, repoRoot: repo });
    assert.equal(inRepo.redacted, true);
    assert.equal(inRepo.markdownPath, join(repo, 'evals', 'out', 'scorecard-20260926T101500Z.md'));
    const md = readFileSync(inRepo.markdownPath, 'utf8');
    assert.ok(!/Falcon|@bank\.example|CIM\.pdf/.test(md));
    assert.match(inRepo.headline.at(-1)!, /^Redacted: the scorecard is inside the repository/);
    const flagged = runScore(['--export', exportDir, '--out', tempDir('dd-out-'), '--redact'], { env, repoRoot: repo });
    assert.equal(flagged.redacted, true);
    assert.ok(!readFileSync(flagged.markdownPath, 'utf8').includes('Falcon'));
  });

  it('never overwrites a scorecard (review item 9)', () => {
    // The degenerate case: a second score of the same export replaced the first scorecard.
    const repo = fakeRepo();
    const { data, key } = scenario();
    const exportDir = writeExport(join(tempDir(), 'export'), data);
    const env = { [ANSWER_KEY_ENV]: writeKey(tempDir('dd-secure-'), key) };
    const out = tempDir('dd-out-');
    const first = runScore(['--export', exportDir, '--out', out], { env, repoRoot: repo });
    const before = readFileSync(first.markdownPath, 'utf8');
    assert.throws(() => runScore(['--export', exportDir, '--out', out], { env, repoRoot: repo }), /already exists\. A scorecard is never overwritten/);
    assert.equal(readFileSync(first.markdownPath, 'utf8'), before);
    // With only the HTML left from an earlier run, the Markdown is not written either.
    const lone = tempDir('dd-out-');
    writeFileSync(join(lone, 'scorecard-r.html'), 'earlier');
    assert.throws(() => runScore(['--export', exportDir, '--out', lone, '--run', 'r'], { env, repoRoot: repo }), /already exists/);
    assert.equal(existsSync(join(lone, 'scorecard-r.md')), false);
  });

  it('prints the harness commit on the scorecard', () => {
    const p = harnessProvenance();
    assert.match(p.commit, /^[0-9a-f]{40}$/);
    assert.equal(typeof p.dirty, 'boolean');
  });

  it('refuses a key inside the repository before reading the export', () => {
    const repo = fakeRepo();
    const keyPath = writeKey(join(repo, 'evals'), scenario().key);
    assert.throws(
      () => runScore(['--export', '/nonexistent'], { env: { [ANSWER_KEY_ENV]: keyPath }, repoRoot: repo }),
      /points inside the repository/,
    );
  });

  it('refuses an export whose files disagree with its manifest, or another format', () => {
    const { data } = scenario();
    const dir = writeExport(join(tempDir(), 'export'), data);
    assert.equal(readExport(dir).items.length, data.items.length);

    const short = writeExport(join(tempDir(), 'export'), data);
    writeExport(short, { ...data, links: [] });
    const manifest = JSON.parse(readFileSync(join(short, 'manifest.json'), 'utf8'));
    manifest.counts['links.jsonl'] = 99;
    writeKey(short, manifest, 'manifest.json');
    assert.throws(() => readExport(short), /links\.jsonl holds 0 rows but the manifest says 99/);

    const other = writeExport(join(tempDir(), 'export'), { ...data, manifest: { ...data.manifest, format: 'x/v9' as never } });
    assert.throws(() => readExport(other), /this harness reads conductia\.discovery-export\/v2/);
  });

  it('checks a key and prints counts only', () => {
    const keyPath = writeKey(tempDir('dd-secure-'), scenario().key);
    const line = runCheckKey({ env: { [ANSWER_KEY_ENV]: keyPath }, repoRoot: fakeRepo() });
    assert.equal(
      line,
      'The answer key is valid: 4 deals; 11 messages and 4 documents (1 attachment-only, 1 with no deal); coverage complete.',
    );
    assert.ok(!line.includes('Falcon'));
  });
});

describe('the command', () => {
  function run(args: string[], env: Record<string, string>) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
  }

  it('prints headline numbers and paths, and no item or deal name', () => {
    const { data, key } = scenario();
    const exportDir = writeExport(join(tempDir(), 'export'), data);
    const keyPath = writeKey(tempDir('dd-secure-'), key);
    const out = tempDir('dd-out-');
    const result = run(['score', '--export', exportDir, '--out', out, '--run', 'ci'], { [ANSWER_KEY_ENV]: keyPath });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Discovery precision \(one-to-one\) post-rejection 60\.0% \(3\/5\), pre-rejection 50\.0% \(3\/6\)$/m);
    assert.match(result.stdout, /^Harness 1\.0\.0 at commit [0-9a-f]{40}/m);
    assert.match(result.stdout, /scorecard-ci\.md$/m);
    assert.ok(!/Falcon|@bank\.example/.test(result.stdout));
    assert.ok(existsSync(join(out, 'scorecard-ci.html')));
  });

  it('exits 1 with a plain message when the key sits inside this repository', () => {
    const inRepo = join(defaultRepoRoot(), 'evals', 'deal-discovery', 'package.json');
    const result = run(['check-key'], { [ANSWER_KEY_ENV]: inRepo });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /points inside the repository/);
  });

  it('exits 2 on a usage error', () => {
    const result = run(['score'], {});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--export <dir> is required/);
  });
});
