// The build stamp (second review). dist/ is gitignored, so the harness commit
// and the dirty check cannot tell which sources a compiled cli.js came from:
// `node dist/src/cli.js score` could run a stale build under a clean-looking
// commit. The build's last step writes dist/build-stamp.json, a digest of
// every file the build reads; the command refuses to run when the sources no
// longer match it. `npm run score` (and check-key, convert) builds first, so
// it always passes.
//
//   node dist/src/buildStamp.js      the last step of npm run build

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP_FILE = 'build-stamp.json';

/** This package's root, from dist/src/ where this file runs. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export class StaleBuildError extends Error {}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** A digest of src/**\/*.ts, tsconfig.json and package.json, by path and content. */
export function sourceDigest(packageRoot: string): string {
  const files = [...sourceFiles(join(packageRoot, 'src')), join(packageRoot, 'tsconfig.json'), join(packageRoot, 'package.json')]
    .map((path) => ({ path, name: relative(packageRoot, path).split(sep).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.name).update('\u0000').update(readFileSync(file.path)).update('\u0000');
  return hash.digest('hex');
}

export function writeStamp(packageRoot: string): void {
  writeFileSync(join(packageRoot, 'dist', STAMP_FILE), `${JSON.stringify({ sourceDigest: sourceDigest(packageRoot) })}\n`);
}

/** Throws unless dist/ was built from the sources as they are now. */
export function assertFreshBuild(packageRoot: string): void {
  let stamped: unknown;
  try {
    stamped = (JSON.parse(readFileSync(join(packageRoot, 'dist', STAMP_FILE), 'utf8')) as { sourceDigest?: unknown }).sourceDigest;
  } catch {
    stamped = null;
  }
  if (stamped !== sourceDigest(packageRoot)) {
    throw new StaleBuildError(
      'dist/ was not built from the sources in src/ as they are now. Run the harness through npm run score, check-key or convert, which build first.',
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeStamp(PACKAGE_ROOT);
}
