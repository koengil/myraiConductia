// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildSyntheticCassette } from '../scripts/m365/build-synthetic-cassette';
import { verifyDigest } from '../scripts/m365/cassette/digest';
import { CASSETTE_FORMAT, readCassette } from '../scripts/m365/cassette/format';
import { lintCassette } from '../scripts/m365/cassette/lint';
import { loadCassette } from '../scripts/m365/cassette/replayFetch';

// Every cassette in the repository, wherever it lands: tracked, plus untracked and not ignored. A demo
// cassette dragged into the tree is found here and fails the allowlist (design Q1). If git itself fails,
// execFileSync throws and the file fails closed; it never reports "no cassettes".
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*manifest.json'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

const cassettes = files
  .filter((path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')).format === CASSETTE_FORMAT;
    } catch {
      return false;
    }
  })
  .map((path) => dirname(path))
  .sort();

const ALLOWED_CASSETTES = ['tests/fixtures/m365-replay/synthetic'];

// A cassette's own files, wherever they sit: a copy whose manifest.json was renamed or dropped is not found by
// the scan above, but its interactions.jsonl and digest.json still are. Only the allowed fixture may hold them.
const ALLOWED_CASSETTE_FILES = ALLOWED_CASSETTES.flatMap((dir) => [`${dir}/interactions.jsonl`, `${dir}/digest.json`]);
const CASSETTE_FILE_NAMES = /(^|\/)(interactions\.jsonl|digest\.json)$/;

/** Paths that look like a cassette file and are not in the allowed fixture. */
export const strayCassetteFiles = (paths: string[], allowed: string[] = ALLOWED_CASSETTE_FILES): string[] =>
  paths.filter((path) => CASSETTE_FILE_NAMES.test(path) && !allowed.includes(path)).sort();

const cassetteFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*interactions.jsonl', '*digest.json'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

describe('committed cassettes', () => {
  it('finds only the allowlisted cassettes', () => {
    expect(cassettes).toEqual(ALLOWED_CASSETTES);
  });

  it('finds no interactions.jsonl or digest.json outside the allowed fixture, manifest or not', () => {
    expect(strayCassetteFiles(cassetteFiles)).toEqual([]);
    expect(cassetteFiles.sort()).toEqual([...ALLOWED_CASSETTE_FILES].sort()); // and the fixture itself is there
  });

  it('the scan flags a stray file at any depth, and only a stray one', () => {
    expect(
      strayCassetteFiles([
        'tests/fixtures/m365-replay/synthetic/interactions.jsonl',
        'tests/fixtures/m365-replay/synthetic/digest.json',
        'interactions.jsonl',
        'tmp/copy/digest.json',
        'tests/fixtures/m365-replay/other/interactions.jsonl',
        'tests/fixtures/m365-replay/synthetic/nested/digest.json',
        'docs/not-a-digest.json.md',
        'src/mydigest.json',
      ]),
    ).toEqual([
      'interactions.jsonl',
      'tests/fixtures/m365-replay/other/interactions.jsonl',
      'tests/fixtures/m365-replay/synthetic/nested/digest.json',
      'tmp/copy/digest.json',
    ]);
  });

  it.each(cassettes)('%s carries no credential and no tenant correlation', (dir) => {
    expect(lintCassette(readCassette(dir))).toEqual([]);
    expect(() => loadCassette(dir)).not.toThrow();
  });

  // A hand edit that skips regeneration fails here, not only at the loader.
  it.each(cassettes)('%s matches its digest.json', (dir) => {
    expect(() => verifyDigest(dir)).not.toThrow();
  });
});

describe('the committed synthetic cassette', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

  // One in-memory recording of the fake tenant. A generator, fake-tenant or reader change that skips
  // `npm run m365:cassette:synthetic` fails here in verify, not only in a local `git status`.
  it('is not stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cassette-stale-'));
    roots.push(root);
    const built = await buildSyntheticCassette(join(root, 'c'));
    const committed = createHash('sha256')
      .update(readFileSync(join(ALLOWED_CASSETTES[0], 'digest.json')))
      .digest('hex');
    expect(
      built.digestSha256,
      'the committed synthetic cassette is stale: run npm run m365:cassette:synthetic',
    ).toBe(committed);
  });
});
