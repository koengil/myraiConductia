// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { productionFiles } from '../helpers/fenceAst';
import { importsOf, reaches, resolveSpecifier } from '../helpers/importGraph';
import { judgeEntry, judgeRepoEntry, resolvedImportsOf } from '../helpers/readerReach';
import { isReaderTargetFile, resolveFrom } from '../helpers/fenceResolve';

/*
 * The capability is claimed at boot, by every process that can read (#262,
 * audit round 2, item 1). The claim is once per module instance, so a hostile
 * module that loads before src/lib/mailboxAccess/readers.ts would take it and
 * the legitimate load would then throw. That throw is loud only if the readers
 * module loads at boot, before any request or job. So every entry point that
 * can reach the readers module imports it first: Next through
 * src/instrumentation.ts (Node runtime only), the worker and each script that
 * reaches a reader through the file itself.
 */

const READERS = 'src/lib/mailboxAccess/readers.ts';
const READERS_SPECIFIER = '@/lib/mailboxAccess/readers';
const ROOT = process.cwd();
const ALL = new Set(['static', 'dynamic'] as const);
const STATIC_ONLY = new Set(['static'] as const);

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** Entry points of a process that is not the Next server: the worker and every script. */
const processEntries = () => productionFiles().filter((f) => /^(?:worker|scripts)\//.test(f) && /\.[cm]?[jt]sx?$/.test(f));

describe('every entry point that can reach a reader imports the readers module first', () => {
  it('finds at least the worker as a reader-reaching entry point (the walk itself works)', () => {
    expect(reaches('worker/classify.ts', READERS, ALL)).toBe(true);
    expect(reaches('scripts/seed-discovery.ts', READERS, ALL)).toBe(true);
  });

  it('puts the readers module first in each worker and script that can reach it', () => {
    const reaching = processEntries().filter((f) => reaches(f, READERS, ALL));
    expect(reaching).toContain('worker/classify.ts');
    for (const file of reaching) {
      const [first] = importsOf(file, read(file)).filter((edge) => edge.kind === 'static');
      const target = first && resolveSpecifier(file, first.specifier);
      expect({ file, firstImport: target }).toEqual({ file, firstImport: READERS });
    }
  });

  it('keeps Next route, page and library code from reaching the readers module', () => {
    // Next would claim once per bundle it compiles the module into; the boot
    // claim in instrumentation covers one. Nothing in src/app may load readers.
    const app = productionFiles().filter((f) => f.startsWith('src/app/'));
    expect(app.filter((f) => reaches(f, READERS, ALL))).toEqual([]);
    expect(reaches('src/middleware.ts', READERS, ALL)).toBe(false);
  });
});

describe("the worker's modules and the worker image (#243)", () => {
  const workerFiles = () => productionFiles().filter((f) => /^worker\/.*\.[cm]?[jt]sx?$/.test(f));
  const firstImport = (file: string) => {
    const [first] = importsOf(file, read(file)).filter((edge) => edge.kind === 'static');
    return first && resolveSpecifier(file, first.specifier);
  };
  // "Reaches a reader" is decided by tests/helpers/readerReach.ts: the reader fence's own
  // graph (the TypeScript resolver over the repo's tsconfig, and the fence's path rule for
  // what a reader file is), not a list written here.

  it('covers the sync pipeline and the pg-boss queue module as well as the entry point', () => {
    expect(workerFiles()).toEqual(expect.arrayContaining(['worker/classify.ts', 'worker/sync.ts', 'worker/boss.ts']));
  });

  it('lets a worker file reach a reader only by importing the readers module first', () => {
    // sync.ts is handed a reader (always a guarded one, from classify.ts) and boss.ts
    // holds the queue: neither may load a reader, the capability or the readers module
    // on its own, so neither is a way to read without the boot claim.
    for (const file of workerFiles()) {
      const { claimsFirst, reached } = judgeRepoEntry(file);
      expect({ file, ok: claimsFirst || reached.length === 0, reached }).toEqual({ file, ok: true, reached: [] });
    }
    expect(firstImport('worker/classify.ts')).toBe(READERS);
  });

  it('runs only entry points that import the readers module first (worker/entrypoint.sh)', () => {
    const script = read('worker/entrypoint.sh');
    // The Dockerfile names each bundle's source as name=path (the probe's lives under scripts/google, #344).
    const sources = new Map(
      [...read('worker/Dockerfile').matchAll(/\b([\w-]+)=((?:worker|scripts)\/[\w./-]+\.ts)\b/g)].map((m) => [m[1], m[2]] as const),
    );
    expect(sources.get('probe')).toBe('scripts/google/probe-connections.ts');
    const entries = [...script.matchAll(/dist\/worker\/([\w-]+)\.mjs/g)].map((m) => sources.get(m[1]) ?? `worker/${m[1]}.ts`);
    expect(entries).toContain('worker/classify.ts');
    expect(entries).toContain('scripts/google/probe-connections.ts');
    // An entry the image names before its source exists (extract, phase 6) is judged when it arrives.
    // An entry either claims the capability first, or reaches no reader at all: the deal-zone
    // extractor reads stored text through one RPC, never a mailbox, so it must not hold the claim.
    for (const file of new Set(entries.filter((f) => productionFiles().includes(f)))) {
      const { claimsFirst, reached } = judgeRepoEntry(file);
      expect({ file, ok: claimsFirst || reached.length === 0, reached }).toEqual({ file, ok: true, reached: [] });
    }
  });

  it('judges the deal-zone extractor as reaching no reader, and the ingest worker as claiming first', () => {
    expect(judgeRepoEntry('worker/extract.ts')).toEqual({ file: 'worker/extract.ts', claimsFirst: false, reached: [] });
    expect(judgeRepoEntry('worker/classify.ts')).toEqual({ file: 'worker/classify.ts', claimsFirst: true, reached: [] });
  });
});

describe('the worker-entry judge (a worker entry that reaches a reader without claiming still fails)', () => {
  // A synthetic graph: file -> what it loads.
  const graph: Record<string, string[]> = {
    'worker/bad-direct.ts': ['src/lib/graph/reader/index.ts'],
    'worker/bad-deep.ts': ['src/lib/util/a.ts'],
    'src/lib/util/a.ts': ['src/lib/util/b.ts'],
    'src/lib/util/b.ts': ['src/lib/graph/reader/mail.ts'],
    'worker/bad-capability.ts': ['src/lib/discovery/source/capability.ts'],
    'worker/bad-gmail.ts': ['src/lib/google/reader/gmail.ts'],
    'worker/bad-readers-module.ts': ['src/lib/mailboxAccess/readers.ts'],
    'worker/bad-late-claim.ts': ['src/lib/util/a.ts', 'src/lib/mailboxAccess/readers.ts'],
    'worker/good-claims.ts': ['src/lib/mailboxAccess/readers.ts', 'src/lib/graph/reader/index.ts'],
    'worker/good-none.ts': ['src/lib/util/c.ts'],
    'src/lib/util/c.ts': ['src/lib/discovery/extract/store.ts'],
    'src/lib/discovery/extract/store.ts': [],
  };
  const imports = (file: string) => graph[file] ?? [];
  const judge = (entry: string, first: string | null = graph[entry]?.[0] ?? null) => judgeEntry(entry, first, imports);
  const passes = (j: { claimsFirst: boolean; reached: string[] }) => j.claimsFirst || j.reached.length === 0;

  it('fails an entry that reaches a reader without claiming the capability first', () => {
    for (const entry of ['worker/bad-direct.ts', 'worker/bad-deep.ts', 'worker/bad-capability.ts', 'worker/bad-gmail.ts', 'worker/bad-readers-module.ts']) {
      const judged = judge(entry, 'src/lib/util/not-the-readers-module.ts');
      expect(passes(judged), entry).toBe(false);
      expect(judged.reached.length, entry).toBeGreaterThan(0);
    }
    expect(judge('worker/bad-deep.ts', 'src/lib/util/a.ts').reached).toEqual(['src/lib/graph/reader/mail.ts']);
  });

  it('fails an entry that loads the readers module, but not first', () => {
    const judged = judge('worker/bad-late-claim.ts');
    expect(judged.claimsFirst).toBe(false);
    expect(passes(judged)).toBe(false);
  });

  it('passes an entry that claims the capability first, and one that reaches no reader at all', () => {
    expect(passes(judge('worker/good-claims.ts'))).toBe(true);
    expect(judge('worker/good-none.ts')).toEqual({ file: 'worker/good-none.ts', claimsFirst: false, reached: [] });
  });

  it('uses the fence\'s own reader rule and the TypeScript resolver, not a list of names', () => {
    expect(isReaderTargetFile('src/lib/graph/reader/anything/deep.tsx')).toBe(true);
    expect(isReaderTargetFile('src/lib/google/reader/gmail.ts')).toBe(true);
    expect(isReaderTargetFile('src/lib/discovery/source/capability.ts')).toBe(true);
    expect(isReaderTargetFile('src/lib/discovery/extract/store.ts')).toBe(false);
    // Other spellings of the same module resolve to the file the fence compares against.
    const spellings = ['@/lib/graph/reader', '@/lib/graph/./reader', '@/lib/graph/reader/index.ts', '../src/lib/graph/reader'];
    const resolved = new Set(spellings.map((s) => resolveFrom('worker/x.ts', s)));
    expect(resolved.size).toBe(1);
    expect([...resolved][0]).toMatch(/src\/lib\/graph\/reader\/index\.ts$/);
  });

  it('follows real edges: the ingest worker reaches the readers module, and the extractor imports nothing under a reader directory', () => {
    expect(resolvedImportsOf('worker/classify.ts')).toContain(READERS);
    expect(resolvedImportsOf('worker/extract.ts').filter(isReaderTargetFile)).toEqual([]);
  });
});

describe('src/instrumentation.ts (Next server boot)', () => {
  const file = 'src/instrumentation.ts';
  const text = () => read(file);

  it('exists at the path Next reads when src/app exists', () => {
    expect(() => text()).not.toThrow();
  });

  it('exports register, which loads the readers module only in the Node runtime', () => {
    const sf = ts.createSourceFile(file, text(), ts.ScriptTarget.Latest, true);
    const register = sf.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'register',
    );
    expect(register, 'export function register').toBeDefined();
    expect(register?.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    // The import() of the readers module sits inside an if on NEXT_RUNTIME === 'nodejs'.
    let guarded = false;
    const visit = (node: ts.Node, inNodejsBranch: boolean): void => {
      if (ts.isIfStatement(node)) {
        const cond = node.expression.getText(sf).replace(/\s+/g, '');
        const nodejs = /process\.env\.NEXT_RUNTIME===['"]nodejs['"]/.test(cond);
        visit(node.thenStatement, inNodejsBranch || nodejs);
        if (node.elseStatement) visit(node.elseStatement, inNodejsBranch);
        return;
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text === READERS_SPECIFIER
      ) {
        guarded = inNodejsBranch;
      }
      ts.forEachChild(node, (child) => visit(child, inNodejsBranch));
    };
    visit(register as ts.Node, false);
    expect(guarded).toBe(true);
  });

  it('never imports the readers module statically, so the edge bundle cannot pull it in', () => {
    expect(reaches(file, READERS, STATIC_ONLY)).toBe(false);
    expect(reaches(file, READERS, ALL)).toBe(true);
  });
});

describe('a hostile earlier claim fails the boot loudly', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('register() rejects in the Node runtime when the capability is already claimed', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { claimReaderCapability } = await import('@/lib/discovery/source/capability');
    claimReaderCapability(); // the hostile module, loaded first
    const { register } = await import('@/instrumentation');
    await expect(register()).rejects.toThrow(/already claimed/);
  });

  it('register() claims the capability in the Node runtime, so a later claim throws', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('@/instrumentation');
    await register();
    const { claimReaderCapability } = await import('@/lib/discovery/source/capability');
    expect(() => claimReaderCapability()).toThrow(/already claimed/);
  });

  it('register() does not load the readers module in the edge runtime', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await import('@/instrumentation');
    await register();
    const { claimReaderCapability } = await import('@/lib/discovery/source/capability');
    expect(() => claimReaderCapability()).not.toThrow();
  });
});
