// @vitest-environment node
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildSyntheticCassette } from '../../scripts/m365/build-synthetic-cassette';
import { CassetteDigestError, listCassetteFiles, verifyDigest, writeDigest } from '../../scripts/m365/cassette/digest';
import { createFakeTenant, fakeTenantSources } from '../../scripts/m365/cassette/fakeTenant';
import { saveCassette } from '../../scripts/m365/cassette/format';
import { recordSources } from '../../scripts/m365/cassette/record';
import { loadCassette } from '../../scripts/m365/cassette/replayFetch';

const roots: string[] = [];
const newDir = () => {
  const root = mkdtempSync(join(tmpdir(), 'cassette-digest-'));
  roots.push(root);
  return join(root, 'c');
};
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A freshly generated cassette (three mailboxes and a site, so it has bodies/), in a temp dir. */
const fresh = async () => {
  const dir = newDir();
  const { digestSha256 } = await buildSyntheticCassette(dir);
  return { dir, digestSha256 };
};

/** The refusal, with its message: every one must name the path and hold no content. */
const refusal = (dir: string): string => {
  try {
    verifyDigest(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(CassetteDigestError);
    return (error as Error).message;
  }
  throw new Error('verifyDigest accepted a tampered cassette');
};

const CONTENT = ['Falcon', 'bank.example', 'Soup of the day', 'graph.microsoft.com', 'eyJ'];
const noContent = (message: string) => CONTENT.forEach((word) => expect(message).not.toContain(word));

describe('cassette digest', () => {
  it('seals a fresh cassette and verifies it, listing every other file sorted by path', async () => {
    const { dir, digestSha256 } = await fresh();
    expect(verifyDigest(dir)).toEqual({ digestSha256 });
    const digest = JSON.parse(readFileSync(join(dir, 'digest.json'), 'utf8')) as { files: Array<{ path: string }> };
    const paths = digest.files.map((f) => f.path);
    expect(paths).toEqual(listCassetteFiles(dir));
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(expect.arrayContaining(['interactions.jsonl', 'manifest.json']));
    expect(paths.some((p) => p.startsWith('bodies/'))).toBe(true);
    expect(paths).not.toContain('digest.json');
    expect(loadCassette(dir).digestSha256).toBe(digestSha256);
  });

  it('gives the same id for two writes of the same data, and never overwrites a digest', async () => {
    const recorded = await recordSources({
      http: { getToken: async () => 'token', fetchImpl: createFakeTenant().fetch, sleep: async () => undefined },
      sources: fakeTenantSources(),
      recordedAt: '2026-09-29T00:00:00.000Z',
    });
    const a = newDir();
    const b = newDir();
    const first = saveCassette(a, recorded.cassette);
    const second = saveCassette(b, recorded.cassette);
    expect(first.digestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
    expect(() => writeDigest(a)).toThrow(/EEXIST/);
  });

  it('refuses a deleted manifest.json, naming it', async () => {
    const { dir } = await fresh();
    rmSync(join(dir, 'manifest.json'));
    const message = refusal(dir);
    expect(message).toContain('manifest.json listed in digest.json is missing');
    noContent(message);
    expect(() => loadCassette(dir)).toThrow(/manifest\.json/);
  });

  it('refuses an extra file, naming it', async () => {
    const { dir } = await fresh();
    writeFileSync(join(dir, 'notes.txt'), 'Project Falcon notes');
    const message = refusal(dir);
    expect(message).toBe('cassette file notes.txt is not in digest.json');
    noContent(message);
  });

  it('refuses an extra body, naming it', async () => {
    const { dir } = await fresh();
    writeFileSync(join(dir, 'bodies', 'ab12'), 'x');
    expect(refusal(dir)).toBe('cassette file bodies/ab12 is not in digest.json');
  });

  it('refuses one flipped byte in interactions.jsonl (same size: the sha256 fires)', async () => {
    const { dir } = await fresh();
    const path = join(dir, 'interactions.jsonl');
    const bytes = readFileSync(path);
    bytes[10] = bytes[10] ^ 0x01;
    writeFileSync(path, bytes);
    const message = refusal(dir);
    expect(message).toBe('cassette file interactions.jsonl does not match digest.json');
    noContent(message);
    expect(() => loadCassette(dir)).toThrow(/interactions\.jsonl/);
  });

  it('refuses an appended byte (the size fires)', async () => {
    const { dir } = await fresh();
    appendFileSync(join(dir, 'interactions.jsonl'), '\n');
    const message = refusal(dir);
    expect(message).toBe('cassette file interactions.jsonl is not the size digest.json lists');
    noContent(message);
  });

  it('refuses an altered body, naming it', async () => {
    const { dir } = await fresh();
    const [name] = readdirSync(join(dir, 'bodies'));
    const path = join(dir, 'bodies', name);
    const bytes = readFileSync(path);
    bytes[0] = bytes[0] ^ 0x01;
    writeFileSync(path, bytes);
    expect(refusal(dir)).toBe(`cassette file bodies/${name} does not match digest.json`);
  });

  it('refuses a deleted digest.json', async () => {
    const { dir } = await fresh();
    rmSync(join(dir, 'digest.json'));
    expect(refusal(dir)).toBe('cassette digest.json is missing');
    expect(() => loadCassette(dir)).toThrow('cassette digest.json is missing');
  });

  it('refuses a malformed digest.json', async () => {
    const { dir } = await fresh();
    rmSync(join(dir, 'digest.json'));
    writeFileSync(join(dir, 'digest.json'), '{"format":"other","files":[]}');
    expect(refusal(dir)).toBe('cassette digest.json is malformed');
    writeFileSync(join(dir, 'digest.json'), 'not json');
    expect(refusal(dir)).toBe('cassette digest.json is not valid JSON');
  });

  it('refuses a symlinked body, even one with the same bytes', async () => {
    const { dir } = await fresh();
    const [name] = readdirSync(join(dir, 'bodies'));
    const path = join(dir, 'bodies', name);
    const real = join(dir, '..', 'real-body');
    writeFileSync(real, readFileSync(path));
    rmSync(path);
    symlinkSync(real, path);
    const message = refusal(dir);
    expect(message).toBe(`cassette file bodies/${name} is a symlink`);
    noContent(message);
  });

  it('refuses a symlinked digest.json and an unexpected directory', async () => {
    const { dir } = await fresh();
    const copy = join(dir, '..', 'digest-copy');
    writeFileSync(copy, readFileSync(join(dir, 'digest.json')));
    rmSync(join(dir, 'digest.json'));
    symlinkSync(copy, join(dir, 'digest.json'));
    expect(refusal(dir)).toMatch(/digest\.json/);

    const other = await fresh();
    writeFileSync(join(other.dir, '..', 'x'), 'x');
    symlinkSync(join(other.dir, '..', 'x'), join(other.dir, 'extra-link'));
    expect(refusal(other.dir)).toBe('cassette file extra-link is a symlink');
  });
});
