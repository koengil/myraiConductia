// @vitest-environment node
// The rule detector (src/lib/discovery/detect/**, #173 G-07 design R7) reads mail text in the worker, so it must
// never hand that text to a model or write it anywhere. Like tests/model-egress-fence.test.ts this is plain text
// matching (comments count), so a quoted path or a renamed import cannot slip past:
// - no file in the directory names the model gateway, or calls console, a process stream or a logger;
// - the pure detector (rules.v1.ts) also has a whole import closure that stays inside the repo's own source and
//   outside src/lib/modelGateway/, so a module that re-exports the gateway cannot carry it in either.
// Each check also asserts it scanned something, so an emptied or renamed directory fails instead of passing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { moduleReferencesOf, resolveSpecifier } from './helpers/importGraph';

const DETECT_DIR = 'src/lib/discovery/detect';
const DETECTOR = `${DETECT_DIR}/rules.v1.ts`;
const MODEL_DIR = 'src/lib/modelGateway/';

interface Rule {
  /** What the text does, for the failure message. Never the matched text itself. */
  readonly what: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  { what: 'names the model gateway', pattern: /modelGateway/i },
  { what: 'uses console', pattern: /\bconsole\b/ },
  { what: 'writes to a process stream', pattern: /\bprocess\s*\.\s*(?:stdout|stderr)\b/ },
  // A logger, and the repo's log helpers (logAudit, logSafe, logProcessorEvent, warnOnce and their kin).
  { what: 'names a logger', pattern: /\b(?:[Ll]ogger|warnOnce|log[A-Z]\w*)\b/ },
  { what: 'calls a log method', pattern: /\.\s*(?:log|info|warn|error|debug|trace|fatal)\s*\(/ },
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(n) ? [p] : [];
  });

const asRepoPath = (p: string) => relative(process.cwd(), p).split(sep).join('/');

/** `path` is repo-relative with forward slashes; `text` is the source. */
function offences(path: string, text: string): string[] {
  return RULES.filter((r) => r.pattern.test(text)).map((r) => `${path}: ${r.what}`);
}

/** Every module the file reaches through literal specifiers, type-only ones included, and every package it names. */
function closure(entry: string): { modules: string[]; packages: string[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const ref of moduleReferencesOf(file, readFileSync(join(process.cwd(), file), 'utf8'))) {
      const next = resolveSpecifier(file, ref.specifier);
      if (next) queue.push(next.split(sep).join('/'));
      else packages.add(ref.specifier);
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

describe('the rule detector neither reaches a model nor writes output', () => {
  const sources = files(join(process.cwd(), DETECT_DIR)).map((p) => ({ path: asRepoPath(p), text: readFileSync(p, 'utf8') }));

  it('scans the detector and the directory index', () => {
    expect(sources.map((s) => s.path)).toEqual(expect.arrayContaining([DETECTOR, `${DETECT_DIR}/index.ts`]));
  });

  it('no file under detect/ names the model gateway, or calls console, a process stream or a logger', () => {
    expect(sources.flatMap((s) => offences(s.path, s.text))).toEqual([]);
  });

  it('no module reference under detect/ resolves into the model gateway', () => {
    const hits = sources.flatMap((s) =>
      moduleReferencesOf(s.path, s.text)
        .filter((ref) => (resolveSpecifier(s.path, ref.specifier) ?? '').split(sep).join('/').startsWith(MODEL_DIR))
        .map((ref) => `${s.path}:${ref.line}`),
    );
    expect(hits).toEqual([]);
  });

  it("the pure detector's whole import closure is own source, outside the model gateway", () => {
    const { modules, packages } = closure(DETECTOR);
    expect(modules).toEqual(expect.arrayContaining([DETECTOR, 'src/lib/discovery/milestones.ts']));
    expect(modules.filter((m) => m.startsWith(MODEL_DIR))).toEqual([]);
    // No package and no node: builtin: the detector is plain string work.
    expect(packages).toEqual([]);
  });

  it('flags each forbidden use in a file under detect/', () => {
    for (const sample of [
      "import { callModel } from '@/lib/modelGateway';",
      "const m = await import('../../modelGateway/index');",
      'console.log(sentence);',
      "console['warn'](n);",
      'process.stdout.write(span);',
      'process.stderr.write(span);',
      'logger.info({ n });',
      "warnOnce('detect', text);",
      'logSafe(text);',
      'logAudit(db, row);',
      'pino.warn(text);',
      'log.debug (text);',
    ]) {
      expect(offences('src/lib/discovery/detect/example.ts', sample), sample).not.toEqual([]);
    }
  });

  it('accepts plain string work', () => {
    expect(
      offences(
        DETECTOR,
        "import type { MilestoneType } from '@/lib/discovery/milestones';\nconst catalog = /signed/.test(s) ? s.trim().split(' ') : [];\nthrow new RangeError('bad');",
      ),
    ).toEqual([]);
  });
});
