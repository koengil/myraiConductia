// Provenance (second review): a stale dist/ must not score, and a score with
// no provenance must say so rather than print a clean-looking commit.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseAnswerKey, type AnswerKey } from '../src/answerKey.ts';
import { assertFreshBuild, PACKAGE_ROOT, StaleBuildError } from '../src/buildStamp.ts';
import { provenanceLine, renderMarkdown } from '../src/report.ts';
import { score } from '../src/score.ts';
import { removeTempDirs, scenario, tempDir } from './synthetic.ts';

after(removeTempDirs);

function keyOf(raw: unknown): AnswerKey {
  const result = parseAnswerKey(raw);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.key;
}

/** A copy of this package as built: sources, configs and dist/ with its stamp. */
function copyOfPackage(): string {
  const root = join(tempDir('dd-pkg-'), 'deal-discovery');
  for (const entry of ['src', 'dist', 'package.json', 'tsconfig.json']) {
    cpSync(join(PACKAGE_ROOT, entry), join(root, entry), { recursive: true });
  }
  return root;
}

describe('the build stamp', () => {
  it('passes for the build npm just made', () => {
    assertFreshBuild(PACKAGE_ROOT);
  });

  it('refuses a dist/ built from other sources, or with no stamp', () => {
    const pkg = copyOfPackage();
    assertFreshBuild(pkg);
    appendFileSync(join(pkg, 'src', 'tuning.ts'), '\n// edited after the build\n');
    assert.throws(() => assertFreshBuild(pkg), StaleBuildError);
    const bare = copyOfPackage();
    rmSync(join(bare, 'dist', 'build-stamp.json'));
    assert.throws(() => assertFreshBuild(bare), /dist\/ was not built from the sources in src\/ as they are now/);
  });

  it('stops the command before it scores, when run as node dist/src/cli.js', () => {
    // The degenerate case: a stale build ran under a clean-looking commit.
    const pkg = copyOfPackage();
    appendFileSync(join(pkg, 'src', 'score.ts'), '\n// edited after the build\n');
    for (const command of [['score', '--export', '/nonexistent'], ['check-key'], ['convert', '--ground-truth', '/nonexistent', '--describe']]) {
      const result = spawnSync(process.execPath, [join(pkg, 'dist', 'src', 'cli.js'), ...command], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      assert.equal(result.status, 2, command[0]);
      assert.match(result.stderr, /dist\/ was not built from the sources in src\/ as they are now\. Run the harness through npm run score/);
    }
  });
});

describe('a score with no provenance', () => {
  it('warns on the scorecard instead of printing an unknown, clean commit', () => {
    const { data, key } = scenario();
    const card = score(keyOf(key), data);
    assert.equal(card.meta.harnessCommit, null);
    assert.equal(card.meta.harnessDirty, null);
    assert.match(provenanceLine(card), /^Warning: harness 1\.0\.0 was run without provenance, so this score cannot be tied to a commit\. Score through npm run score\./);
    const md = renderMarkdown(card);
    assert.ok(!md.includes('commit unknown'));
    assert.match(md, /Warning: harness 1\.0\.0 was run without provenance/);
    const given = score(keyOf(key), data, { provenance: { commit: 'abc1234', dirty: false } });
    assert.match(provenanceLine(given), /^Harness 1\.0\.0 at commit abc1234\. Tuning/);
  });
});
