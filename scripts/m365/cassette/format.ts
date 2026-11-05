import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SourceKind } from '../../../src/lib/constants/discovery';
import { writeDigest } from './digest';
import { CassetteLintError, lintCassette } from './lint';

// A Graph cassette (CDT-277): the Graph HTTP interactions of one recording,
// scrubbed, so the real readers can replay them offline. A directory:
//
//   manifest.json       what was recorded (no tenant id, client id or thumbprint)
//   interactions.jsonl  one response per `METHOD url`, final attempt only
//   bodies/<sha256>     download bytes, content-addressed
//   digest.json         every other file's path, sha256 and size, written last (digest.ts)
//
// Request headers are never stored: the Authorization header lives only there.

export const CASSETTE_FORMAT = 'conductia.graph-cassette/v1';
export const ALLOWED_RESPONSE_HEADERS = ['content-type', 'content-length', 'location'] as const;
export type AllowedHeader = (typeof ALLOWED_RESPONSE_HEADERS)[number];

export type Interaction = {
  method: 'GET';
  /** Scrubbed. The replay key is `${method} ${url}`. */
  url: string;
  status: number;
  headers: Partial<Record<AllowedHeader, string>>;
  /** JSON responses, as text. */
  body?: string;
  /** Anything else: the sha256 of a file under bodies/. */
  bodyRef?: string;
};

export type CassetteSource = { kind: SourceKind; address: string };

export type CassetteManifest = {
  format: typeof CASSETTE_FORMAT;
  recordedAt: string;
  sources: CassetteSource[];
  interactions: number;
  /** sha256 → bytes, sorted by key. */
  bodies: Record<string, number>;
  /**
   * `git rev-parse HEAD` of the checkout that recorded it, so a replay that misses after a reader change can
   * name the commit to check out (design Q11). A live recording sets it; the synthetic generator never does,
   * which keeps the committed cassette byte-stable.
   */
  readerCommit?: string;
};

export type CassetteData = {
  manifest: CassetteManifest;
  interactions: Interaction[];
  bodies: Map<string, Uint8Array>;
};

const BODY_KEY = /^[0-9a-f]{64}$/;

export const interactionKey = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

/** Throws CassetteLintError (rule and location only) unless the cassette is free of credentials and tenant correlation. */
export function assertCassetteClean(data: CassetteData): void {
  const findings = lintCassette(data);
  if (findings.length > 0) throw new CassetteLintError(findings);
}

/** Writes a new cassette directory. Never overwrites: the directory must not exist. A dirty cassette writes nothing.
 * Returns the cassette id: the sha256 of digest.json, which is written last. */
export function saveCassette(dir: string, data: CassetteData): { digestSha256: string } {
  assertCassetteClean(data); // before mkdir: a refusal leaves no directory
  mkdirSync(dir, { mode: 0o700 }); // EEXIST when it exists; the parent must exist
  const write = (path: string, content: string | Uint8Array) =>
    writeFileSync(join(dir, path), content, { flag: 'wx', mode: 0o600 });
  write('manifest.json', `${JSON.stringify(data.manifest, null, 2)}\n`);
  write('interactions.jsonl', data.interactions.map((i) => JSON.stringify(i)).join('\n') + '\n');
  if (data.bodies.size > 0) {
    mkdirSync(join(dir, 'bodies'), { mode: 0o700 });
    for (const [sha, bytes] of [...data.bodies].sort(([a], [b]) => (a < b ? -1 : 1))) write(join('bodies', sha), bytes);
  }
  return writeDigest(dir);
}

/** Reads a cassette directory as data. loadCassette (replayFetch.ts) adds the checks and the fetch. */
export function readCassette(dir: string): CassetteData {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as CassetteManifest;
  if (manifest.format !== CASSETTE_FORMAT) throw new Error(`Not a ${CASSETTE_FORMAT} cassette: ${dir}`);
  const interactions = readFileSync(join(dir, 'interactions.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Interaction);
  const bodies = new Map<string, Uint8Array>();
  for (const [sha, bytes] of Object.entries(manifest.bodies)) {
    // The key becomes a path under bodies/: a key that is not a sha256 (`../manifest.json`) is refused, not joined.
    if (!BODY_KEY.test(sha)) throw new Error('cassette manifest.json lists a body whose key is not a sha256');
    const path = join(dir, 'bodies', sha);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new Error(`cassette body bodies/${sha} listed in manifest.json is missing`);
    }
    if (size !== bytes) throw new Error(`cassette body bodies/${sha} is ${size} bytes, manifest.json says ${bytes}`);
    bodies.set(sha, readFileSync(path));
  }
  return { manifest, interactions, bodies };
}
