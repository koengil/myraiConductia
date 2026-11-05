import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LENSES, type Lens } from './findings';

export type ChangedFile = { path: string; previousPath?: string; additions: number; deletions: number };

export type LensProfile = {
  always?: boolean;
  paths: string[];
  labels: string[];
  model: { trial: string; production: string };
};

export type Profiles = {
  small_pr_max_lines: number;
  lenses: Record<Lens, LensProfile>;
};

export type Fence = { paths: string[] };

export type Strictness = 'light' | 'standard' | 'strict';

export type Route = {
  lenses: Lens[];
  small: boolean;
  fenced: string[];
  runEvaluator: boolean;
  strictness: Strictness;
};

const regexCache = new Map<string, RegExp>();

/*
 * Minimal glob: `**` crosses directories, `*` stays inside one segment, every
 * other character is literal. No dependency exists for this in package.json.
 */
function globToRegExp(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached) return cached;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${out}$`);
  regexCache.set(glob, re);
  return re;
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

// A rename out of a fenced directory must still count as fenced, so both paths are checked.
function matchedPaths(f: ChangedFile, globs: string[]): string[] {
  const paths = [f.path, f.previousPath].filter((p): p is string => p !== undefined);
  return [...new Set(paths.filter((p) => matchesAny(p, globs)))];
}

export function route(
  pr: { files: ChangedFile[]; labels: string[] },
  profiles: Profiles,
  fence: Fence,
  requested: string[] = [],
): Route {
  // A requested lens (from an @ai-reviewer mention) is treated exactly like a label.
  const labels = new Set([...pr.labels, ...requested].map((l) => l.toLowerCase()));
  const fenced = pr.files.flatMap((f) => matchedPaths(f, fence.paths));
  const total = pr.files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const small = total < profiles.small_pr_max_lines && fenced.length === 0;

  const strict = fenced.length > 0;
  const lenses = LENSES.filter((lens) => {
    const p = profiles.lenses[lens];
    if (p.always || strict) return true;
    // A label is a person asking for this lens, so it applies even to a small PR.
    if (p.labels.some((l) => labels.has(l.toLowerCase()))) return true;
    return !small && pr.files.some((f) => matchedPaths(f, p.paths).length > 0);
  });

  const strictness: Strictness = strict ? 'strict' : small ? 'light' : 'standard';
  return { lenses, small, fenced, runEvaluator: strict || lenses.length > 1 || !small, strictness };
}

export function loadConfig(dir: string): { profiles: Profiles; fence: Fence } {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return { profiles: read('profiles.json') as Profiles, fence: read('fence.json') as Fence };
}
