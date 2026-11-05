// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveFrom } from './helpers/fenceResolve';
import { walk } from './helpers/walkRepo';

/**
 * Pins the guard folder (#262, audit round 1, item 10). The static fences can
 * be walked around by a deliberate author (see the threat model in
 * tests/agent-surfaces.test.ts), so the surface that matters most is kept small
 * and reviewed: the value exports of the guard's public modules are pinned
 * here, and the paths that hold or fence the guard need code-owner review
 * (.github/CODEOWNERS). Adding a door to the guard, such as re-exporting a raw
 * reader from index.ts, means changing this list, which CODEOWNERS routes to a
 * reviewer. Type exports are not pinned; they carry no run-time reach.
 */

const ROOT = process.cwd();

/** Names of the value exports of a module, read from syntax. `export *` shows as `*` (never pinned). */
export function valueExports(text: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const node of sf.statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) continue;
      if (!node.exportClause) names.add(`* from ${(node.moduleSpecifier as ts.StringLiteral).text}`);
      else if (ts.isNamespaceExport(node.exportClause)) names.add(node.exportClause.name.text);
      else for (const e of node.exportClause.elements) if (!e.isTypeOnly) names.add(e.name.text);
    } else if (ts.isExportAssignment(node)) {
      names.add('default');
    } else if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) continue;
      const isDefault = ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault) names.add('default');
      else if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.add(d.name.text);
          else names.add('{destructured}');
        }
      } else if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
        names.add((node.name as ts.Identifier).text);
      } else names.add('{unnamed}');
    }
  }
  return [...names].sort();
}

/** The pinned value exports. Changing a list changes the guard's door, and needs a code-owner review. */
export const PINNED_EXPORTS: Record<string, string[]> = {
  'src/lib/mailboxAccess/index.ts': [
    'MailboxAccessRefusedError',
    'UnsupportedSourceError',
    'assertMailboxAllowed',
    'assertSourceAllowed',
    'createFixtureAllowlistMirror',
    // The fixture Directory check of a team inbox address (#581): the replay folder answers, a verdict like the live one. No reader.
    'createFixtureTeamMailboxVerifier',
    'createGuardedContentSource',
    // The live group mirror (#259): it exposes a mirror, not a reader.
    'createLiveAllowlistMirror',
    // The live Directory check of a team inbox address (#581): a verdict about an address, like the mirror. No reader.
    'createLiveTeamMailboxVerifier',
    'guardedContentSource',
    'readableMailboxes',
    'readerProviderFromEnv',
  ],
  // UnsupportedSourceError (C8, C28): a typed answer for a source no reader serves in this mode, so the worker
  // skips that one source. An Error class carrying a kind, provider and mode: no data, no reader, no reach.
  // probeReaderScope (#243): the operator's scope probe. It returns HTTP statuses only, never a body,
  // id or token, so it is a door to Graph's answer about scope, not to mailbox data.
  // graphContentSourceOver and loadFixtureCorpus (CDT-277 cassette, reconciled with #262): the Graph reader over
  // a transport the caller holds (replay, the recorder's test double; no registration credential, no
  // default network), and the synthetic bank.example corpus the fake Graph tenant serves.
  // createGuardedRecording (#318): the owner's live Microsoft capture. Every source it hands out is the worker's own
  // guarded read, with the responses shown to an observer that never sees a token, a download URL or the binding
  // check. It has a short importer list of its own (RECORDING_IMPORTERS_ALLOWED): not the worker.
  // googleOperatorKit (#259): the Google token and HTTP primitives the Gmail trial scripts (scripts/google/) use.
  // Unlike the doors above it does reach Google, with a keyless operator credential and a token for any subject
  // the caller names, so it is operator-only (see GOOGLE_KIT_IMPORTERS_ALLOWED) and carries no reader capability.
  'src/lib/mailboxAccess/readers.ts': [
    'UnsupportedSourceError',
    'createFixtureTeamMailboxVerifier',
    'createGuardedContentSource',
    'createGuardedRecording',
    'createLiveAllowlistMirror',
    'createLiveTeamMailboxVerifier',
    'googleOperatorKit',
    'graphContentSourceOver',
    'guardedContentSource',
    'loadFixtureCorpus',
    'probeReaderScope',
    'readerProviderFromEnv',
  ],
  // The acting-user mint and its check (round 2, item 5). The minted set stays private: there is no
  // export that adds to it, so a new value export here means a new way to obtain or vouch for a principal.
  'src/lib/mailboxAccess/principal.ts': ['assertActingUser', 'currentActingUser'],
  // The capability the readers demand: one claim, one check. Provider-neutral (C3).
  'src/lib/discovery/source/capability.ts': ['claimReaderCapability', 'requireReaderCapability'],
  // The old path is a compatibility re-export: same names, and (checked below) no instance of its own.
  'src/lib/graph/reader/capability.ts': ['claimReaderCapability', 'requireReaderCapability'],
};

describe('the guard folder value exports are pinned (item 10)', () => {
  it.each(Object.entries(PINNED_EXPORTS))('%s', (file, pinned) => {
    expect(valueExports(readFileSync(join(ROOT, file), 'utf8'), file)).toEqual([...pinned].sort());
  });

  it('keeps the old capability path a pure re-export, with no second capability', async () => {
    const text = readFileSync(join(ROOT, 'src/lib/graph/reader/capability.ts'), 'utf8');
    const sf = ts.createSourceFile('capability.ts', text, ts.ScriptTarget.Latest, true);
    // Only re-exports from the provider-neutral module: no declaration that could hold a second instance.
    for (const node of sf.statements) {
      expect(ts.isExportDeclaration(node), node.getText(sf)).toBe(true);
      expect((node as ts.ExportDeclaration).moduleSpecifier && ((node as ts.ExportDeclaration).moduleSpecifier as ts.StringLiteral).text).toBe(
        '@/lib/discovery/source/capability',
      );
    }
    const neutral = await import('@/lib/discovery/source/capability');
    const legacy = await import('@/lib/graph/reader/capability');
    expect(legacy.requireReaderCapability).toBe(neutral.requireReaderCapability);
    expect(legacy.claimReaderCapability).toBe(neutral.claimReaderCapability);
  });

  it('sees a raw reader re-exported through index.ts', () => {
    const leak = [
      "export { assertMailboxAllowed } from './guard';",
      "export { getContentSource } from '@/lib/graph/reader';",
    ].join('\n');
    expect(valueExports(leak)).toEqual(['assertMailboxAllowed', 'getContentSource']);
    expect(valueExports("export * from '@/lib/graph/reader';")).toEqual(['* from @/lib/graph/reader']);
    expect(valueExports("export * as reader from '@/lib/graph/reader';")).toEqual(['reader']);
    // A leak is a difference from the pinned list, whichever form it takes.
    for (const extra of [
      "export const getContentSource = () => null;",
      "export function readAll() {}",
      "export default function () {}",
      "export const { a } = { a: 1 };",
    ]) {
      const exported = valueExports(`export { assertMailboxAllowed } from './guard';\n${extra}`);
      expect(exported).not.toEqual(['assertMailboxAllowed']);
    }
  });

  it('ignores type-only exports, which carry no run-time reach', () => {
    const text = [
      "export type { ContentSource } from './readers';",
      "export { type SourceRow, guardedContentSource } from './readers';",
      'export type Ctx = { a: string };',
      'export interface Other { b: string }',
    ].join('\n');
    expect(valueExports(text)).toEqual(['guardedContentSource']);
  });
});

/**
 * Who may import the four doors that are not the guarded entry (defense in depth). They sit in readers.ts
 * because the operator tooling needs them, but each hands out reach that `guardedContentSource` never does:
 * graphContentSourceOver builds the Graph reader over a transport the caller holds, so it reads whatever that
 * transport answers with no mailbox guard in front; loadFixtureCorpus returns the synthetic corpus the fake
 * tenant serves; probeReaderScope asks Graph about scope with the registration's credential; googleOperatorKit
 * hands the Gmail trial's scripts the Google HTTP client and token mints (#259). The lint and
 * AST fences do not look at them, so this lists their importers: only the operator scripts, the tests, the
 * worker, the guard folder itself and the boot claim. An import from anywhere else, including the app, fails.
 */
const READERS_FILE = 'src/lib/mailboxAccess/readers.ts';
export const DOOR_NAMES = ['createGuardedRecording', 'googleOperatorKit', 'graphContentSourceOver', 'loadFixtureCorpus', 'probeReaderScope'];
export const DOOR_IMPORTERS_ALLOWED = [
  /^scripts\/m365\//,
  // The Gmail trial's operator scripts (#259) reach Google through googleOperatorKit, not through a reader
  // module, so the reader fence needs no exception for them. Nothing under src/ may import it.
  /^scripts\/google\//,
  // Pre-release sandbox Gmail generator (#658): same operator pattern as scripts/google/seed-gmail.ts.
  /^scripts\/sandbox\//,
  /^tests\//,
  /^worker\//,
  /^src\/lib\/mailboxAccess\//,
  /^src\/instrumentation\.ts$/,
];
/**
 * googleOperatorKit mints a delegated token for any subject the caller names, so it has a shorter list of its own
 * than the other doors: the Gmail trial's operator scripts, the tests and readers.ts itself. The worker, the m365
 * scripts, the boot claim and the rest of the guard folder may import the other doors but not this one.
 */
export const GOOGLE_KIT_IMPORTERS_ALLOWED = [
  /^scripts\/google\//,
  /^scripts\/sandbox\//,
  /^tests\//,
  /^src\/lib\/mailboxAccess\/readers\.ts$/,
];
/**
 * createGuardedRecording reads a live tenant for the owner's capture (#318), so it has the shortest list: the
 * recorder's one script, the tests and readers.ts itself. The worker, the rest of scripts/m365 and the app may not.
 */
export const RECORDING_IMPORTERS_ALLOWED = [/^scripts\/m365\/record-graph\.ts$/, /^tests\//, /^src\/lib\/mailboxAccess\/readers\.ts$/];
/**
 * The hits that reach one door: an import or re-export by name, or a form that takes the whole module in a file that
 * names the door. A whole-module load that never names it (the boot claim's side-effect import()) does not.
 */
const hitsReaching = (door: string, files: Array<{ file: string; text: string }>) =>
  files.flatMap(({ file, text }) =>
    doorImporters([{ file, text }]).filter(
      (hit) => hit.how.endsWith(door) || (text.includes(door) && /^(?:namespace import|export \*|import = require|dynamic load)/.test(hit.how)),
    ),
  );
const googleKitHits = (files: Array<{ file: string; text: string }>) => hitsReaching('googleOperatorKit', files);
const recordingHits = (files: Array<{ file: string; text: string }>) => hitsReaching('createGuardedRecording', files);
export type DoorHit = { file: string; line: number; how: string };

/**
 * The files that can reach one of the doors, found from syntax and resolved the way tsc resolves, so
 * `@/lib/mailboxAccess/./readers` and `../mailboxAccess/readers` are the same file. A named import or
 * re-export of a door counts, and so does anything that could name one without saying so: a namespace
 * import, `export *`, `import x = require()` and a literal import() or require(). A side-effect import
 * (`import '.../readers'`, which only claims the capability), a type-only import and any other name do not.
 */
export function doorImporters(files: Array<{ file: string; text: string }>): DoorHit[] {
  const readers = ts.sys.realpath?.(join(ROOT, READERS_FILE)) ?? join(ROOT, READERS_FILE);
  const hits: DoorHit[] = [];
  for (const { file, text } of files) {
    if (!/readers/.test(text)) continue; // every spelling that reaches readers.ts names it
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const reaches = (specifier: string) => resolveFrom(file, specifier) === readers;
    const named = (elements: ReadonlyArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
      elements.filter((e) => !e.isTypeOnly && DOOR_NAMES.includes((e.propertyName ?? e.name).text)).map((e) => (e.propertyName ?? e.name).text);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && reaches(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly && clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) hits.push({ file, line: line(node), how: 'namespace import' });
          else for (const name of named(clause.namedBindings.elements)) hits.push({ file, line: line(node), how: `imports ${name}` });
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly && reaches(node.moduleSpecifier.text)) {
        if (!node.exportClause) hits.push({ file, line: line(node), how: 'export *' });
        else if (ts.isNamespaceExport(node.exportClause)) hits.push({ file, line: line(node), how: 'export * as' });
        else for (const name of named(node.exportClause.elements)) hits.push({ file, line: line(node), how: `re-exports ${name}` });
      } else if (ts.isImportEqualsDeclaration(node)) {
        const ref = node.moduleReference;
        if (!node.isTypeOnly && ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression) && reaches(ref.expression.text)) {
          hits.push({ file, line: line(node), how: 'import = require' });
        }
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const arg = node.arguments[0];
        const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
        if (loads && arg && ts.isStringLiteralLike(arg) && reaches(arg.text)) hits.push({ file, line: line(node), how: 'dynamic load' });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

/**
 * The doors a module hands on, found from syntax (round 3, M7). doorImporters answers who may IMPORT a door; this
 * answers who EXPORTS one, and is run on the allowed importers, which doorImporters never reads. A door is handed
 * on by a named or aliased re-export, `export *`, `export * as`, importing it and exporting the binding (a list,
 * `export default`, `export =`, a constant or an object that carries it, a namespace or one of its doors), and by
 * exporting a dynamic load of readers.ts. Calling a door is not handing it on. A type-only import or export carries
 * no value, and a name from another module is not a door.
 */
export function doorReexports(files: Array<{ file: string; text: string }>): DoorHit[] {
  const readers = ts.sys.realpath?.(join(ROOT, READERS_FILE)) ?? join(ROOT, READERS_FILE);
  const hits: DoorHit[] = [];
  for (const { file, text } of files) {
    if (!/readers/.test(text)) continue;
    // The re-export forms are the importer scan's own: reuse them, so the two cannot disagree.
    for (const hit of doorImporters([{ file, text }])) if (/^(?:re-exports |export \*)/.test(hit.how)) hits.push(hit);

    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const reaches = (specifier: string) => resolveFrom(file, specifier) === readers;
    const hasExport = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

    // The local names that hold a door, or the whole module.
    const doors = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const node of sf.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && reaches(node.moduleSpecifier.text)) {
        const bindings = node.importClause && !node.importClause.isTypeOnly ? node.importClause.namedBindings : undefined;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        else if (bindings) {
          for (const e of bindings.elements) {
            const door = (e.propertyName ?? e.name).text;
            if (!e.isTypeOnly && DOOR_NAMES.includes(door)) doors.set(e.name.text, door);
          }
        }
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const ref = node.moduleReference.expression;
        if (ts.isStringLiteral(ref) && reaches(ref.text)) {
          namespaces.add(node.name.text);
          if (hasExport(node)) hits.push({ file, line: line(node), how: `exports namespace ${node.name.text}` });
        }
      }
    }
    if (doors.size === 0 && namespaces.size === 0 && !/import\s*\(|require\s*\(/.test(text)) continue;

    const named = (name: string): string[] =>
      doors.has(name) ? [`exports ${doors.get(name)}`] : namespaces.has(name) ? [`exports namespace ${name}`] : [];
    // What an exported expression carries: the binding itself, held in an object or array, or a dynamic load. Not a call of it.
    const carries = (expression: ts.Expression): string[] => {
      if (ts.isIdentifier(expression)) return named(expression.text);
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression)) {
        return carries(expression.expression);
      }
      if (ts.isPropertyAccessExpression(expression)) {
        const base = expression.expression;
        return ts.isIdentifier(base) && namespaces.has(base.text) && DOOR_NAMES.includes(expression.name.text) ? [`exports ${expression.name.text}`] : [];
      }
      if (ts.isObjectLiteralExpression(expression)) {
        return expression.properties.flatMap((p) =>
          ts.isShorthandPropertyAssignment(p) ? named(p.name.text) : ts.isPropertyAssignment(p) ? carries(p.initializer) : ts.isSpreadAssignment(p) ? carries(p.expression) : [],
        );
      }
      if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap((e) => (ts.isSpreadElement(e) ? carries(e.expression) : carries(e)));
      if (ts.isConditionalExpression(expression)) return [...carries(expression.whenTrue), ...carries(expression.whenFalse)];
      if (ts.isBinaryExpression(expression)) return [...carries(expression.left), ...carries(expression.right)];
      if (ts.isCallExpression(expression)) {
        const callee = expression.expression;
        const arg = expression.arguments[0];
        const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
        return loads && arg && ts.isStringLiteralLike(arg) && reaches(arg.text) ? ['exports a dynamic load'] : [];
      }
      return [];
    };
    for (const node of sf.statements) {
      const found: string[] = [];
      if (ts.isExportDeclaration(node) && !node.moduleSpecifier && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const e of node.exportClause.elements) if (!e.isTypeOnly) found.push(...named((e.propertyName ?? e.name).text));
      } else if (ts.isExportAssignment(node)) {
        found.push(...carries(node.expression));
      } else if (ts.isVariableStatement(node) && hasExport(node)) {
        for (const d of node.declarationList.declarations) if (d.initializer) found.push(...carries(d.initializer));
      }
      for (const how of found) hits.push({ file, line: line(node), how });
    }
  }
  return hits;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

describe('the readers.ts doors have a short list of importers', () => {
  it('still exports the four doors, so a rename cannot silently void the list', () => {
    const exported = valueExports(readFileSync(join(ROOT, READERS_FILE), 'utf8'), READERS_FILE);
    for (const name of DOOR_NAMES) expect(exported, name).toContain(name);
  });

  it('is imported, in the repo as it stands, only from scripts/m365, scripts/google, tests, worker, the guard folder and the boot claim', () => {
    const candidates = walk('.')
      .filter((f) => SOURCE_FILE.test(f) && !f.startsWith('dist/') && !DOOR_IMPORTERS_ALLOWED.some((re) => re.test(f)))
      .map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
    expect(doorImporters(candidates), 'move the read behind guardedContentSource, or put the importer in an allowed folder').toEqual([]);
  });

  it('imports googleOperatorKit, in the repo as it stands, only from scripts/google, tests and readers.ts (#259)', () => {
    const candidates = walk('.')
      .filter((f) => SOURCE_FILE.test(f) && !f.startsWith('dist/') && !GOOGLE_KIT_IMPORTERS_ALLOWED.some((re) => re.test(f)))
      .map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
    expect(googleKitHits(candidates), 'mint Google tokens only from the operator scripts').toEqual([]);
  });

  it('finds an importer outside the list, however the path is spelled', () => {
    const probes: Array<[string, string, string]> = [
      ['src/lib/discovery/probe.ts', "import { graphContentSourceOver } from '@/lib/mailboxAccess/readers';", 'imports graphContentSourceOver'],
      ['src/app/api/x/route.ts', "import { loadFixtureCorpus as corpus } from '../../../lib/mailboxAccess/readers';", 'imports loadFixtureCorpus'],
      ['scripts/seed-discovery.ts', "import { probeReaderScope } from '../src/lib/mailboxAccess/./readers';", 'imports probeReaderScope'],
      ['src/lib/a.ts', "import * as readers from '@/lib/mailboxAccess//readers';", 'namespace import'],
      ['src/lib/b.ts', "export { graphContentSourceOver as open } from '@/lib/mailboxAccess/readers';", 're-exports graphContentSourceOver'],
      ['src/lib/c.ts', "export * from '@/lib/mailboxAccess/readers';", 'export *'],
      ['src/lib/d.ts', "export * as readers from '@/lib/mailboxAccess/readers';", 'export * as'],
      ['src/lib/e.ts', "const r = await import('@/lib/mailboxAccess/readers');", 'dynamic load'],
      ['src/lib/f.ts', "const r = require('@/lib/mailboxAccess/readers');", 'dynamic load'],
      ['src/lib/g.ts', "import readers = require('@/lib/mailboxAccess/readers');", 'import = require'],
      ['src/lib/h.tsx', "import { type SourceRow, probeReaderScope } from '@/lib/mailboxAccess/readers';", 'imports probeReaderScope'],
      ['src/lib/foo.ts', "import { googleOperatorKit } from '@/lib/mailboxAccess/readers';", 'imports googleOperatorKit'],
      ['src/lib/google/foo.ts', "import { googleOperatorKit as kit } from '../mailboxAccess/readers';", 'imports googleOperatorKit'],
      ['src/lib/google/bar.ts', "export { googleOperatorKit } from '@/lib/mailboxAccess/readers';", 're-exports googleOperatorKit'],
    ];
    for (const [file, text, how] of probes) {
      expect(doorImporters([{ file, text }]), `${file}: ${text}`).toEqual([{ file, line: 1, how }]);
    }
  });

  it('allows only the Gmail operator scripts, the tests and readers.ts to import googleOperatorKit (#259)', () => {
    const allowedBy = (file: string) => GOOGLE_KIT_IMPORTERS_ALLOWED.some((re) => re.test(file));
    for (const file of [
      'scripts/google/seed-gmail.ts',
      'scripts/google/lib/probe.ts',
      'scripts/sandbox/generate-gmail.ts',
      'tests/google/probe.test.ts',
      'src/lib/mailboxAccess/readers.ts',
    ]) {
      expect(allowedBy(file), file).toBe(true);
    }
    // The kit scan reads every file this list does not allow, including the other doors' importers
    // (the worker, the m365 scripts, the boot claim, the guard folder), so each of them is flagged.
    const kit = "import { googleOperatorKit } from '@/lib/mailboxAccess/readers';";
    for (const file of [
      'worker/classify.ts',
      'scripts/m365/probe-out-of-scope.ts',
      'src/instrumentation.ts',
      'src/lib/mailboxAccess/guard.ts',
      'src/lib/foo.ts',
      'src/lib/google/reader/foo.ts',
      'src/app/api/x/route.ts',
      'scripts/other/tool.ts',
    ]) {
      expect(allowedBy(file), file).toBe(false);
      expect(googleKitHits([{ file, text: kit }]), file).toEqual([{ file, line: 1, how: 'imports googleOperatorKit' }]);
    }
    // A whole-module form that names the kit reaches it; a side-effect load or another door by name does not.
    const reaches = (text: string) => googleKitHits([{ file: 'worker/x.ts', text }]).map((h) => h.how);
    expect(reaches("import * as r from '@/lib/mailboxAccess/readers';\nr.googleOperatorKit();")).toEqual(['namespace import']);
    expect(reaches("const r = await import('@/lib/mailboxAccess/readers');\nr.googleOperatorKit();")).toEqual(['dynamic load']);
    expect(reaches("await import('@/lib/mailboxAccess/readers');")).toEqual([]);
    expect(reaches("import { probeReaderScope } from '@/lib/mailboxAccess/readers';")).toEqual([]);
  });

  it('imports createGuardedRecording, in the repo as it stands, only from record-graph.ts, tests and readers.ts (#318)', () => {
    const candidates = walk('.')
      .filter((f) => SOURCE_FILE.test(f) && !f.startsWith('dist/') && !RECORDING_IMPORTERS_ALLOWED.some((re) => re.test(f)))
      .map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
    expect(recordingHits(candidates), "a live capture is the owner's script; the worker never records").toEqual([]);
  });

  it('keeps the worker, the other m365 scripts and the app off createGuardedRecording, however it is imported (#318)', () => {
    const allowedBy = (file: string) => RECORDING_IMPORTERS_ALLOWED.some((re) => re.test(file));
    for (const file of ['scripts/m365/record-graph.ts', 'tests/mailbox-access/readers.test.ts', 'src/lib/mailboxAccess/readers.ts']) {
      expect(allowedBy(file), file).toBe(true);
    }
    // The other doors' importers (the worker, the m365 scripts, the boot claim, the guard folder) are not on the list.
    const named = "import { createGuardedRecording } from '@/lib/mailboxAccess/readers';";
    for (const file of [
      'worker/classify.ts',
      'worker/sync.ts',
      'scripts/m365/probe-out-of-scope.ts',
      'scripts/m365/cassette/record.ts',
      'src/instrumentation.ts',
      'src/lib/mailboxAccess/guard.ts',
      'src/lib/foo.ts',
      'src/app/api/x/route.ts',
    ]) {
      expect(allowedBy(file), file).toBe(false);
      expect(recordingHits([{ file, text: named }]), file).toEqual([{ file, line: 1, how: 'imports createGuardedRecording' }]);
    }
    // A whole-module form that names it reaches it; a side-effect load or another door by name does not.
    const reaches = (text: string) => recordingHits([{ file: 'worker/x.ts', text }]).map((h) => h.how);
    expect(reaches("import * as r from '@/lib/mailboxAccess/readers';\nr.createGuardedRecording({} as never);")).toEqual(['namespace import']);
    expect(reaches("const r = await import('@/lib/mailboxAccess/readers');\nr.createGuardedRecording({} as never);")).toEqual(['dynamic load']);
    expect(reaches("export { createGuardedRecording } from '@/lib/mailboxAccess/readers';")).toEqual(['re-exports createGuardedRecording']);
    expect(reaches("await import('@/lib/mailboxAccess/readers');")).toEqual([]);
    expect(reaches("import { probeReaderScope } from '@/lib/mailboxAccess/readers';")).toEqual([]);
  });

  it('flags an allowed module that hands createGuardedRecording on (#318)', () => {
    const probes: Array<[string, string, string[]]> = [
      ['named re-export', "export { createGuardedRecording } from '@/lib/mailboxAccess/readers';", ['re-exports createGuardedRecording']],
      [
        'import, then export the binding',
        "import { createGuardedRecording } from '@/lib/mailboxAccess/readers';\nexport { createGuardedRecording };",
        ['exports createGuardedRecording'],
      ],
    ];
    for (const [name, text, how] of probes) {
      expect(doorReexports([{ file: 'scripts/m365/record-graph.ts', text }]).map((h) => h.how), name).toEqual(how);
    }
  });

  it('leaves alone what reaches no door', () => {
    const fine: Array<[string, string]> = [
      ['src/lib/a.ts', "import '@/lib/mailboxAccess/readers';"], // a side-effect import only claims the capability
      ['src/lib/b.ts', "import { guardedContentSource, readerProviderFromEnv } from '@/lib/mailboxAccess/readers';"],
      ['src/lib/c.ts', "import type { graphContentSourceOver } from '@/lib/mailboxAccess/readers';"],
      ['src/lib/d.ts', "import { type loadFixtureCorpus } from '@/lib/mailboxAccess/readers';"],
      ['src/lib/e.ts', "export type { probeReaderScope } from '@/lib/mailboxAccess/readers';"],
      ['src/lib/f.ts', "import { probeReaderScope } from './readers'; // src/lib/readers.ts is another module"],
      ['src/lib/g.ts', "import { graphContentSourceOver } from 'some-package/readers';"],
    ];
    for (const [file, text] of fine) expect(doorImporters([{ file, text }]), `${file}: ${text}`).toEqual([]);
  });
});

/**
 * The allowlist above names who may IMPORT a door. It does not stop an allowed importer from handing one on: an
 * allowed scripts/m365/bridge.ts that re-exports graphContentSourceOver lets any app module import the bridge and
 * reach the unguarded reader, and doorImporters never looks at an allowed file (round 3, audit finding 7). So the
 * allowed importers are scanned for the other direction: a door they export, by any route.
 */
describe('an allowed importer does not hand a door on (round 3, M7)', () => {
  const allowed = () =>
    walk('.')
      .filter((f) => SOURCE_FILE.test(f) && !f.startsWith('dist/') && DOOR_IMPORTERS_ALLOWED.some((re) => re.test(f)))
      .map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));

  it('exports no door, in the repo as it stands', () => {
    const files = allowed();
    expect(files.length, 'the scan reads the allowed importers').toBeGreaterThan(20);
    expect(doorReexports(files), 'call the door where it is needed; never export it or an alias of it').toEqual([]);
  });

  it('flags the bridge fixture, which imports the doors and exports each of them', () => {
    const text = readFileSync(join(ROOT, 'tests/fixtures/fenceBypass/door-bridge.ts.txt'), 'utf8');
    const hits = doorReexports([{ file: 'scripts/m365/bridge.ts', text }]);
    expect(hits.map((h) => h.how).sort()).toEqual(
      ['exports googleOperatorKit', 'exports graphContentSourceOver', 'exports loadFixtureCorpus', 'exports probeReaderScope'].sort(),
    );
    expect(hits.every((h) => h.file === 'scripts/m365/bridge.ts')).toBe(true);
  });

  it('flags every way an allowed module can hand a door on', () => {
    const probes: Array<[string, string, string[]]> = [
      ['named re-export', "export { graphContentSourceOver } from '@/lib/mailboxAccess/readers';", ['re-exports graphContentSourceOver']],
      ['aliased re-export', "export { loadFixtureCorpus as corpus } from '@/lib/mailboxAccess/readers';", ['re-exports loadFixtureCorpus']],
      ['export *', "export * from '@/lib/mailboxAccess/readers';", ['export *']],
      ['export * as', "export * as readers from '@/lib/mailboxAccess/readers';", ['export * as']],
      [
        'import, then export the binding',
        "import { probeReaderScope } from '@/lib/mailboxAccess/readers';\nexport { probeReaderScope };",
        ['exports probeReaderScope'],
      ],
      [
        'import with an alias, then export under another name',
        "import { probeReaderScope as probe } from '@/lib/mailboxAccess/readers';\nexport { probe as scope };",
        ['exports probeReaderScope'],
      ],
      [
        'import, then export default',
        "import { graphContentSourceOver } from '@/lib/mailboxAccess/readers';\nexport default graphContentSourceOver;",
        ['exports graphContentSourceOver'],
      ],
      [
        'import, then export a constant that holds it',
        "import { loadFixtureCorpus } from '@/lib/mailboxAccess/readers';\nexport const corpus = loadFixtureCorpus;",
        ['exports loadFixtureCorpus'],
      ],
      [
        'import, then export an object that carries it',
        "import { graphContentSourceOver } from '@/lib/mailboxAccess/readers';\nexport const api = { graphContentSourceOver };",
        ['exports graphContentSourceOver'],
      ],
      [
        'namespace import, then export the namespace',
        "import * as readers from '@/lib/mailboxAccess/readers';\nexport { readers };",
        ['exports namespace readers'],
      ],
      [
        'namespace import, then export one of its doors',
        "import * as readers from '@/lib/mailboxAccess/readers';\nexport const open = readers.graphContentSourceOver;",
        ['exports graphContentSourceOver'],
      ],
      [
        'import = require, then export it',
        "import readers = require('@/lib/mailboxAccess/readers');\nexport = readers;",
        ['exports namespace readers'],
      ],
      [
        'import googleOperatorKit, then export it',
        "import { googleOperatorKit } from '@/lib/mailboxAccess/readers';\nexport { googleOperatorKit };",
        ['exports googleOperatorKit'],
      ],
      [
        'import googleOperatorKit, then export what it returns',
        "import { googleOperatorKit } from '@/lib/mailboxAccess/readers';\nexport const kit = googleOperatorKit;",
        ['exports googleOperatorKit'],
      ],
      ['export a dynamic load of the module', "export const readers = await import('@/lib/mailboxAccess/readers');", ['exports a dynamic load']],
    ];
    for (const [name, text, how] of probes) {
      expect(doorReexports([{ file: 'scripts/m365/bridge.ts', text }]).map((h) => h.how), name).toEqual(how);
    }
  });

  it('leaves alone an allowed module that only uses a door, or exports something else', () => {
    const fine: Array<[string, string]> = [
      ['import used and not exported', "import { graphContentSourceOver } from '@/lib/mailboxAccess/readers';\nexport const run = () => graphContentSourceOver({} as never);"],
      ['side-effect import', "import '@/lib/mailboxAccess/readers';\nexport const x = 1;"],
      ['a non-door re-export', "export { guardedContentSource, readerProviderFromEnv } from '@/lib/mailboxAccess/readers';"],
      ['a type-only re-export of a door name', "export type { probeReaderScope } from '@/lib/mailboxAccess/readers';"],
      ['a type-only import, exported as a type', "import type { loadFixtureCorpus } from '@/lib/mailboxAccess/readers';\nexport type { loadFixtureCorpus };"],
      ['a door name from another module', "import { probeReaderScope } from 'some-package/readers';\nexport { probeReaderScope };"],
      ['a script that calls googleOperatorKit and exports only what it computes', "import { googleOperatorKit } from '@/lib/mailboxAccess/readers';\nconst { googleFetch } = googleOperatorKit();\nexport const get = (u: string) => googleFetch(u, {}, {} as never);"],
      ['a local with a door name that is not the import', "import { guardedContentSource } from '@/lib/mailboxAccess/readers';\nconst probeReaderScope = 1;\nexport { probeReaderScope, guardedContentSource };"],
    ];
    for (const [name, text] of fine) expect(doorReexports([{ file: 'scripts/m365/bridge.ts', text }]), name).toEqual([]);
  });
});

describe('CODEOWNERS covers the guard and its fences (item 10)', () => {
  const lines = readFileSync(join(ROOT, '.github/CODEOWNERS'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));
  const entry = (pattern: string) => lines.find(([p]) => p === pattern);

  it.each([
    '/src/lib/mailboxAccess/',
    '/src/lib/graph/reader/',
    '/src/lib/google/reader/',
    '/src/lib/discovery/source/',
    '/eslint.config.mjs',
    '/tests/agent-surfaces.test.ts',
    '/tests/mailbox-reader-fence.test.ts',
    '/tests/eslint-fences.test.ts',
    '/tests/mailbox-access-pins.test.ts',
    '/tests/helpers/fenceAst.ts',
    '/src/instrumentation.ts',
    '/tests/mailbox-access/boot-claim.test.ts',
    '/tests/helpers/importGraph.ts',
    '/tests/helpers/fenceResolve.ts',
    '/tests/mailbox-access/import-graph.test.ts',
    '/tests/fixtures/agentSurfaces/',
    '/tests/fixtures/fenceBypass/',
    '/tests/fixtures/serverEntries/',
    '/tests/fixtures/mailboxReaderFence/',
    '/.github/CODEOWNERS',
  ])('%s has an explicit entry with owners', (pattern) => {
    const found = entry(pattern);
    expect(found, `add ${pattern} to .github/CODEOWNERS`).toBeDefined();
    const owners = found!.slice(1);
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) expect(owner).toMatch(/^@[\w-]+$/);
  });

  it('names only owners already on the default rule', () => {
    const defaults = new Set(entry('*')!.slice(1));
    for (const [pattern, ...owners] of lines) {
      if (pattern === '*') continue;
      for (const owner of owners) expect(defaults.has(owner), `${pattern} ${owner}`).toBe(true);
    }
  });
});

/**
 * The team inbox (#581, design R7, review round 2 M-A): how fresh a team inbox's Directory check is, is the guard's
 * question alone. The provider group mirror (and, in a later phase, RLS and visibility) read the timer-free view, so a
 * pause, a worker outage or a stale check can never move an address in or out of what is expected, flip drift or
 * hide a candidate. A source-text pin: nothing in the mirror reads a clock or the check's own columns.
 */
describe('the mirror reads the allowlist views and no clock (#581)', () => {
  const text = (file: string) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');

  it('asks both allowlist views, and only them, for what the group should hold', () => {
    const mirror = text('src/lib/mailboxAccess/mirror.ts');
    expect(mirror).toContain('TABLE.ALLOWED_MAILBOXES');
    expect(mirror).toContain('TABLE.ALLOWED_TEAM_MAILBOXES');
    expect(mirror).not.toContain('TABLE.TEAM_MAILBOXES');
    expect(mirror).not.toContain('TABLE.CONTENT_SOURCES');
  });

  it('reads no clock and none of the registry\'s check columns', () => {
    const mirror = text('src/lib/mailboxAccess/mirror.ts');
    expect(mirror).not.toMatch(/Date\.now|new Date|performance\.now|setTimeout|verified_at|checked_at|check_status/);
  });

  it('judges the 65 minute window nowhere in the TypeScript guard folder: the SQL verdict is the only place', () => {
    for (const file of ['guard.ts', 'mirror.ts', 'readers.ts', 'accessors.ts', 'index.ts']) {
      expect(text(`src/lib/mailboxAccess/${file}`), file).not.toMatch(/TEAM_MAILBOX_READ_WINDOW_MINUTES|team_mailbox_unverified|verified_at/);
    }
  });
});
