import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import { isReaderTargetFile, resolveFrom } from './fenceResolve';
import { importsOf } from './importGraph';

/**
 * Whether a worker entry reaches a reader without claiming the capability first
 * (#262, boot-claim relaxation). The graph is the reader fence's own: edges come
 * from the same import scan the fence uses (importsOf), each specifier is
 * resolved by the TypeScript resolver with the repo's tsconfig (resolveFrom, so
 * `@/lib/graph/./reader` and its kin resolve to the file they name), and a
 * "reader" is decided by the fence's own path rule (isReaderTargetFile: every
 * file under a reader directory, and the capability). Nothing here is a list
 * of files written by hand.
 */

const ROOT = process.cwd();
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

/** The readers module, which claims the capability once (src/lib/mailboxAccess/readers.ts). */
export const READERS_MODULE = 'src/lib/mailboxAccess/readers.ts';

/** Repo-relative files an own-source file loads (static and dynamic, type-only imports excluded), resolved as tsc resolves them. */
const importCache = new Map<string, string[]>();
export function resolvedImportsOf(file: string): string[] {
  const cached = importCache.get(file);
  if (cached) return cached;
  const realRoot = ts.sys.realpath?.(ROOT) ?? ROOT;
  const out: string[] = [];
  for (const edge of importsOf(file, readFileSync(join(ROOT, file), 'utf8'))) {
    const abs = resolveFrom(file, edge.specifier);
    if (!abs) continue;
    const rel = relative(realRoot, abs);
    if (rel.startsWith('..') || rel.startsWith('node_modules') || !SCRIPT_FILE.test(rel)) continue;
    out.push(rel);
  }
  importCache.set(file, out);
  return out;
}

export type EntryJudgement = { file: string; claimsFirst: boolean; reached: string[] };

/**
 * `imports(file)` lists what a file loads; `firstStaticImport` is what the entry
 * loads first. An entry passes when it claims the capability first (its first
 * static import is the readers module), or when nothing it can reach is a
 * reader file or the readers module. `reached` is empty for a pass.
 */
export function judgeEntry(
  entry: string,
  firstStaticImport: string | undefined | null,
  imports: (file: string) => readonly string[],
  isReader: (file: string) => boolean = isReaderTargetFile,
): EntryJudgement {
  if (firstStaticImport === READERS_MODULE) return { file: entry, claimsFirst: true, reached: [] };
  const seen = new Set<string>();
  const reached = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file !== entry && (file === READERS_MODULE || isReader(file))) reached.add(file);
    for (const next of imports(file)) queue.push(next);
  }
  return { file: entry, claimsFirst: false, reached: [...reached].sort() };
}

/** The real repo: judge a worker or script entry by the fence's resolver graph. */
export function judgeRepoEntry(entry: string): EntryJudgement {
  const [first] = importsOf(entry, readFileSync(join(ROOT, entry), 'utf8')).filter((edge) => edge.kind === 'static');
  const abs = first && resolveFrom(entry, first.specifier);
  const firstRel = abs ? relative(ts.sys.realpath?.(ROOT) ?? ROOT, abs) : null;
  return judgeEntry(entry, firstRel, resolvedImportsOf);
}
