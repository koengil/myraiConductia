import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The seal on a Graph cassette (CDT-277). digest.json lists every other file of the cassette
// directory with its path, sha256 and size: paths and hashes only, never content. The recorder
// writes it last and the loader verifies it first, so a missing, extra or altered file is refused
// before the lint or a replay sees it. The cassette id is the sha256 of digest.json itself: the PR
// records it, so the demo counts are tied to one specific cassette and a backup copy can be checked.
//
// Every message names a path and never any content.

export const DIGEST_FORMAT = 'conductia.graph-cassette-digest/v1';
export const DIGEST_FILE = 'digest.json';

export type CassetteDigest = { format: typeof DIGEST_FORMAT; files: Array<{ path: string; sha256: string; bytes: number }> };

export class CassetteDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteDigestError';
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Every file except digest.json, posix-relative, sorted by plain string order. A symlink, or anything
 * that is not a regular file, is refused. The only directory a cassette has is bodies/.
 */
export function listCassetteFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new CassetteDigestError(`cassette file ${path} is a symlink`);
      if (entry.isDirectory()) {
        if (path !== 'bodies') throw new CassetteDigestError(`cassette directory ${path} is not part of a cassette`);
        walk(path);
      } else if (entry.isFile()) {
        if (path !== DIGEST_FILE) out.push(path);
      } else {
        throw new CassetteDigestError(`cassette file ${path} is not a regular file`);
      }
    }
  };
  walk('');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Writes digest.json (wx, 0600) over every other file. Returns the cassette id: the sha256 of digest.json. */
export function writeDigest(dir: string): { digestSha256: string } {
  const files = listCassetteFiles(dir).map((path) => {
    const bytes = readFileSync(join(dir, path));
    return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
  });
  const text = `${JSON.stringify({ format: DIGEST_FORMAT, files } satisfies CassetteDigest, null, 2)}\n`;
  writeFileSync(join(dir, DIGEST_FILE), text, { flag: 'wx', mode: 0o600 });
  return { digestSha256: sha256(Buffer.from(text)) };
}

function parseDigest(bytes: Buffer): CassetteDigest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new CassetteDigestError(`cassette ${DIGEST_FILE} is not valid JSON`);
  }
  const digest = parsed as Partial<CassetteDigest> | null;
  const malformed = () => new CassetteDigestError(`cassette ${DIGEST_FILE} is malformed`);
  if (!digest || digest.format !== DIGEST_FORMAT || !Array.isArray(digest.files)) throw malformed();
  for (const file of digest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw malformed();
    }
  }
  return digest as CassetteDigest;
}

/**
 * Throws on: digest.json missing or malformed; a listed file missing; an unlisted file present;
 * a size or sha256 mismatch; a symlink. Returns the cassette id.
 */
export function verifyDigest(dir: string): { digestSha256: string } {
  const digestPath = join(dir, DIGEST_FILE);
  let digestBytes: Buffer;
  try {
    if (!lstatSync(digestPath).isFile()) throw new CassetteDigestError(`cassette ${DIGEST_FILE} is not a regular file`);
    digestBytes = readFileSync(digestPath);
  } catch (error) {
    if (error instanceof CassetteDigestError) throw error;
    throw new CassetteDigestError(`cassette ${DIGEST_FILE} is missing`);
  }
  const digest = parseDigest(digestBytes);

  const present = new Set(listCassetteFiles(dir));
  const listed = new Set<string>();
  for (const file of digest.files) {
    if (listed.has(file.path)) throw new CassetteDigestError(`cassette ${DIGEST_FILE} lists ${file.path} twice`);
    listed.add(file.path);
  }
  for (const path of [...listed].sort()) {
    if (!present.has(path)) throw new CassetteDigestError(`cassette file ${path} listed in ${DIGEST_FILE} is missing`);
  }
  for (const path of present) {
    if (!listed.has(path)) throw new CassetteDigestError(`cassette file ${path} is not in ${DIGEST_FILE}`);
  }
  for (const file of digest.files) {
    const bytes = readFileSync(join(dir, file.path));
    if (bytes.byteLength !== file.bytes) {
      throw new CassetteDigestError(`cassette file ${file.path} is not the size ${DIGEST_FILE} lists`);
    }
    if (sha256(bytes) !== file.sha256) throw new CassetteDigestError(`cassette file ${file.path} does not match ${DIGEST_FILE}`);
  }
  return { digestSha256: sha256(digestBytes) };
}
