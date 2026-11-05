import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecorderRefusal } from './refusal';

// A cassette is real tenant mail once it is recorded from a live tenant: it never goes into git. This is the
// same rule as the eval harness's answer key (evals/deal-discovery/src/answerKey.ts, gitRepoRoots, realRoots,
// isInside), reimplemented here because the EVALS_FENCE lint fence forbids importing it.

/** Where this file lives: inside the checkout that holds the recorder, whatever the working directory is. */
export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The roots of the checkout that holds THIS script: `--show-toplevel` and the main checkout (parent of
 * `--git-common-dir`). Resolved from the script's own location, never from the working directory, so the
 * answer is the same from `scripts/` or from an unrelated directory. Fails closed without git.
 */
export function repoRoots(from: string = SCRIPT_DIR): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['-C', from, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new RecorderRefusal('git rev-parse failed, so the repository root is unknown. Run the recorder from a git checkout of the repository.');
  }
  const [topLevel, commonDir] = output.trim().split('\n');
  if (!topLevel || !commonDir) throw new RecorderRefusal('git rev-parse returned no repository root.');
  // <main>/.git in a normal checkout or a linked worktree; a bare repository is its own root.
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  return [topLevel, mainRoot];
}

/** `git -C <root> <args>`, trimmed stdout: the same repository whatever the working directory is. */
export const gitIn =
  (root: string) =>
  (args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

/**
 * True when `path` is `root` or anything below it. Both must already be real paths. A sibling whose name merely
 * starts with two dots (`<root>/..x`) is inside; only a `..` path SEGMENT leaves the root.
 */
export const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Resolves `path` through symlinks even though it need not exist: the nearest existing ancestor is resolved
 * with realpathSync.native, then the remaining segments are re-appended.
 */
function realPathOf(path: string): string {
  const rest: string[] = [];
  let probe = resolve(path);
  for (;;) {
    let exists = true;
    try {
      lstatSync(probe);
    } catch {
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpathSync.native(probe);
      } catch {
        // A dangling symlink: it exists, but nothing says where it would land.
        throw new RecorderRefusal('--out is a symlink that does not resolve; a cassette is never written through one');
      }
      return join(real, ...rest);
    }
    const parent = dirname(probe);
    if (parent === probe) return join(probe, ...rest);
    rest.unshift(basename(probe));
    probe = parent;
  }
}

/**
 * Refuses `path` when it is inside any root. `path` need not exist yet: its nearest existing
 * ancestor is resolved with realpathSync.native, then the remaining segments are re-appended,
 * so a symlink into the repo is caught.
 */
export function assertOutsideRepo(path: string, roots: string[] = repoRoots()): void {
  if (roots.length === 0) throw new RecorderRefusal('No repository root to check --out against.');
  const real = realPathOf(path);
  const inside = [...new Set(roots.map((root) => realpathSync.native(root)))].some((root) => isInside(root, real));
  if (inside) {
    throw new RecorderRefusal('--out must be outside the repository (a path inside a git checkout): a cassette never goes into git');
  }
}
