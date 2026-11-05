import { join } from 'node:path';
import ts from 'typescript';

import { productionFiles } from './fenceAst';

/**
 * Resolves a module specifier the way tsc does (#262, audit round 3, item 1).
 * A pattern over the specifier text walks around `@/lib/graph/./reader`,
 * `.../source//capability` and their kin, which name the same file. The
 * TypeScript resolver, with the repo's own tsconfig (`paths`, `moduleResolution`),
 * turns every spelling into one absolute path, and the fence compares that path
 * with the reader and capability files.
 *
 * The tsconfig is parsed once and one module resolution cache is shared, so
 * resolving every specifier of every production file stays a few seconds.
 */

const ROOT = process.cwd();

let cached: { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache } | undefined;
function resolver() {
  if (!cached) {
    const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, ROOT);
    const cache = ts.createModuleResolutionCache(ROOT, (name) => name, config.options);
    cached = { options: config.options, cache };
  }
  return cached;
}

/**
 * A reader or the reader capability, by path: every file under a reader
 * directory (a new file is covered on arrival) and the capability module.
 * Derived from the repo-relative path, not from a list of files.
 */
export const isReaderTargetFile = (file: string) =>
  /^src\/lib\/(?:graph|google)\/reader\//.test(file) || /^src\/lib\/discovery\/source\/capability\.[cm]?[jt]sx?$/.test(file);

const realpath = (abs: string) => ts.sys.realpath?.(abs) ?? abs;

let targets: ReadonlySet<string> | undefined;
/** Absolute (real) paths of the reader and capability files that exist in the repo. */
export function readerTargetPaths(): ReadonlySet<string> {
  if (!targets) targets = new Set(productionFiles().filter(isReaderTargetFile).map((f) => realpath(join(ROOT, f))));
  return targets;
}

/** The absolute path a specifier resolves to from a repo-relative file, or undefined when tsc cannot resolve it. */
export function resolveFrom(file: string, specifier: string): string | undefined {
  const { options, cache } = resolver();
  const resolved = ts.resolveModuleName(specifier, join(ROOT, file), options, ts.sys, cache).resolvedModule;
  return resolved ? realpath(resolved.resolvedFileName) : undefined;
}
