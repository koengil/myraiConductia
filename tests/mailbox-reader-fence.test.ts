// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import allowlist from './fixtures/mailboxReaderFence/allowlist.json';
import dynamicImportAllowlist from './fixtures/mailboxReaderFence/dynamicImports.json';
import nodeProcessModuleAllowlist from './fixtures/mailboxReaderFence/nodeProcessModules.json';
import supabaseClientAllowlist from './fixtures/mailboxReaderFence/supabaseClients.json';
import { productionFiles } from './helpers/fenceAst';
import { isReaderTargetFile, readerTargetPaths, resolveFrom } from './helpers/fenceResolve';
import { moduleReferencesOf } from './helpers/importGraph';
import { walk } from './helpers/walkRepo';

/**
 * Backstop for the reader fence in eslint.config.mjs (#262). ESLint sees
 * static imports only. This walks every top-level folder except tests, e2e,
 * node_modules and .next (not a fixed list, so a new folder is scanned on
 * arrival) and flags:
 * - a dynamic import(), require() or bare string path to a reader or provider
 *   SDK outside src/lib/mailboxAccess/;
 * - any import() or require() whose specifier is not a literal, unless the file
 *   is listed with a reason (a computed specifier hides its target);
 * - a bare `eslint-disable`, a disable of the fence rules that is not listed,
 *   and any inline `/* eslint ... *\/` config comment, so a comment cannot
 *   switch a fence off (ratchet: disables of named, other rules stay legal);
 * - a value import of createClient from @supabase/supabase-js outside the admin
 *   client module and the listed scripts (the raw constructor builds a
 *   service-role client that fence A cannot see);
 * - a production import of anything under tests/ or e2e/;
 * - a require built at run time without a load call: any import of node:module,
 *   `.createRequire`, `process.getBuiltinModule`, `Function(`, `new Function(`,
 *   `eval(`, and a `require` reached through a property or an alias.
 * - any static specifier (import, export-from, `import x = require()`, and a
 *   literal import() or require()) that the TypeScript resolver, with the repo
 *   tsconfig, resolves to a reader or the capability file, outside the reader
 *   zone. `source/./capability` and `graph//reader` name the same file as the
 *   plain path, so the text patterns above cannot be the whole check (round 3);
 * - the loader and eval reached as values: `_load`, `.constructor` of `module`,
 *   `require.main` or `process.mainModule`, `eval` and `Function` read as values
 *   (`const run = eval`, `Reflect.construct(Function, ...)`);
 * - node:vm, node:worker_threads and node:child_process (with or without
 *   `node:`), unless the file is listed with a reason (nodeProcessModules.json;
 *   test files are exempt);
 * - an eslint.config.* below the repo root (it would replace the root config).
 * The comment checks above read one line at a time, so a multi-line comment
 * walks around them. A second check runs ESLint itself over every production
 * file with inline comments switched off (allowInlineConfig: false), only the
 * fence rules on, and only the root eslint.config.mjs (overrideConfigFile, so a
 * nested config never applies); whatever a comment was hiding shows as an error
 * there. It also asserts that no production file is ignored and that each fence
 * rule is an error for every file it covers, so a downgraded rule or a widened
 * ignore cannot make the run look clean.
 *
 * THREAT MODEL (audit round 1, item 12). These static fences stop accidental
 * and casual bypasses. They read syntax and text, so a determined author can
 * still write something they do not see. The hard backstops are run time, not
 * lint: the reader factories demand a one-time capability held only by
 * src/lib/mailboxAccess/readers.ts (a reader reached by any route around the
 * guard throws no_capability), the guard builds its own service client, and RLS
 * answers the signed-in reads. Limit of the capability: it is claimed once per
 * module instance, so a hostile module that loads first gets it and the
 * legitimate load then throws on the second claim. That throw is loud only where
 * readers.ts loads at boot (src/instrumentation.ts, worker/classify.ts and each
 * script that can reach a reader; tests/mailbox-access/boot-claim.test.ts pins
 * them). Elsewhere it is neither prevented nor noticed by code. Deliberate
 * evasion is caught by CODEOWNERS review of src/lib/mailboxAccess/,
 * src/lib/graph/reader/, src/lib/discovery/source/, eslint.config.mjs and the fence tests. The same model
 * is at the head of tests/agent-surfaces.test.ts and in D68 of the decision log.
 */

const ALLOWED_DIRS = ['src/lib/mailboxAccess/', 'src/lib/graph/reader/', 'src/lib/google/reader/'];
// eslint.config.mjs names the provider SDKs and reader paths to fence them.
const DEFINES_THE_FENCE = ['eslint.config.mjs'];
// The reader capability (src/lib/discovery/source/capability.ts) is fenced like a reader: claiming it elsewhere would steal it.
const TARGET = /(?:^|\/)(?:graph|google)\/reader(?:\/|$)|(?:^|\/)source\/capability(?:\.[cm]?[jt]sx?)?$|^@azure\/msal-node|^google-auth-library|^googleapis|^@googleapis\//;
// Disabling either fence rule inline: the TypeScript rule (reader fence) or core no-restricted-imports (fences A, B, C).
const DISABLE = /eslint-disable(?:-next-line|-line)?\b[^\n]*(?<![\w/-])(?:@typescript-eslint\/)?no-restricted-imports/;
// eslint-disable with no rule list: it switches every rule off, the fences included.
const BARE_DISABLE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\s*(?:$|\*\/|--)/;
// /* eslint rule: "off" */, /* eslint-env ... */: inline configuration.
const INLINE_CONFIG = /\/\*\s*eslint(?:-env)?\s+[^\s*]/;
const TEST_SPECIFIER = /(?:^|\/)(?:tests|e2e)(?:\/|$)/;
// Test files, and the runner configs that load them.
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|^src\/test\/|^(?:playwright|vitest)[\w.]*\.config\.[cm]?[jt]s$/;

export type Finding = {
  file: string;
  line: number;
  kind:
    | 'dynamic-import'
    | 'require'
    | 'string-path'
    | 'js-static-import'
    | 'unlisted-disable'
    | 'non-literal-import'
    | 'non-literal-require'
    | 'create-require'
    | 'dynamic-code'
    | 'indirect-require'
    | 'bare-disable'
    | 'inline-config'
    | 'supabase-client'
    | 'test-import'
    | 'resolved-reader-import'
    | 'loader-alias'
    | 'process-module'
    | 'nested-eslint-config';
};

export type Allowances = {
  /** Files that may have an import()/require() with a non-literal specifier. */
  dynamicImports: ReadonlySet<string>;
  /** Files that may import createClient from @supabase/supabase-js. */
  supabaseClients: ReadonlySet<string>;
  /** Files that may import node:vm, node:worker_threads or node:child_process. Absent means none. */
  nodeProcessModules?: ReadonlySet<string>;
};

const files = (list: Array<{ file: string }>) => new Set(list.map((entry) => entry.file));
const ALLOW: Allowances = {
  dynamicImports: files(dynamicImportAllowlist as Array<{ file: string }>),
  supabaseClients: files(supabaseClientAllowlist as Array<{ file: string }>),
  nodeProcessModules: files(nodeProcessModuleAllowlist as Array<{ file: string }>),
};
const NO_ALLOWANCES: Allowances = { dynamicImports: new Set(), supabaseClients: new Set() };

const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS,
};

const MODULE_BUILTIN = /^(?:node:)?module$/;
// Reaching a require built at run time without importing it: createRequire, or
// process.getBuiltinModule('module'), which hands out the same module.
const REQUIRE_FACTORY_NAMES = new Set(['createRequire', 'getBuiltinModule']);
const REQUIRE_METHODS = new Set(['call', 'apply', 'bind']);
// Ways to run code or reach a loader that is not a load call (audit round 3, item 2).
const PROCESS_MODULE = /^(?:node:)?(?:vm|worker_threads|child_process)$/;
const CODE_BUILDERS = new Set(['eval', 'Function']);
// A config below the root replaces the root config for the files under it (ESLint looks it up per file).
const NESTED_CONFIG_NAME = /^eslint\.config\.[cm]?[jt]s$/;

/** Strips parentheses, `as` casts, `!` and `<T>` assertions: `(module as any)` is `module`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** `module`, `require.main` or `process.mainModule`: the objects whose `.constructor` is the Module class and its `_load`. */
function isModuleObject(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text === 'module';
  const name = memberName(e);
  if (!name || !(ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))) return false;
  if (name === 'mainModule') return true;
  const base = unwrap(e.expression);
  return name === 'main' && ts.isIdentifier(base) && base.text === 'require';
}

/** The name a member access or element access selects, when it is a literal. */
function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

/**
 * An identifier (`require`, `eval`, `Function`) that is read as a value:
 * aliased, passed on, or stored, not called or probed. A call or `new` of it is
 * judged by the load rules (require) or the dynamic-code rule (eval, Function).
 */
function isRequireValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return false; // require('x'): the load rules judge it
  if (ts.isNewExpression(parent) && parent.expression === node) return false;
  if (ts.isTypeOfExpression(parent)) return false;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node) return false; // x instanceof Function
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.name === node) return false; // x.require is the property rule's
    return REQUIRE_METHODS.has(parent.name.text); // require.main / .resolve / .cache are harmless
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) return false;
  if (ts.isTypeNode(parent) || ts.isTypeQueryNode(parent)) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionLike(parent) ||
      ts.isClassLike(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    (parent as { name?: ts.Node }).name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

/** Syntax rules: non-literal loads, the raw supabase constructor, and production imports of tests. */
function scanSyntax(file: string, text: string, allow: Allowances): Finding[] {
  const ext = file.slice(file.lastIndexOf('.'));
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KIND[ext] ?? ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (node: ts.Node, kind: Finding['kind']) => findings.push({ file, line: at(node), kind });
  const isTestFile = TEST_FILE.test(file);

  const checkSpecifier = (node: ts.Node, specifier: string, typeOnly = false) => {
    if (!isTestFile && TEST_SPECIFIER.test(specifier)) add(node, 'test-import');
    // vm, worker_threads and child_process run code the fences cannot read (a type-only import runs nothing).
    // Test files (scripts/ci/*.test.mjs spawn node) never ship, like the test-import rule above.
    if (!typeOnly && !isTestFile && PROCESS_MODULE.test(specifier) && !allow.nodeProcessModules?.has(file)) add(node, 'process-module');
  };
  const supabase = (specifier: string) => specifier === '@supabase/supabase-js' || specifier.startsWith('@supabase/supabase-js/');

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      const namedImports = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      checkSpecifier(node, spec, !!clause?.isTypeOnly || (!clause?.name && namedImports.length > 0 && namedImports.every((e) => e.isTypeOnly)));
      if (MODULE_BUILTIN.test(spec) && !clause?.isTypeOnly && !allow.dynamicImports.has(file)) add(node, 'create-require');
      if (supabase(spec) && !clause?.isTypeOnly && !allow.supabaseClients.has(file)) {
        const bindings = clause?.namedBindings;
        const valueNames = bindings && ts.isNamedImports(bindings)
          ? bindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text)
          : [];
        if (!clause || clause.name || (bindings && ts.isNamespaceImport(bindings)) || valueNames.includes('createClient')) {
          add(node, 'supabase-client');
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const exported = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [];
      checkSpecifier(node, spec, node.isTypeOnly || (exported.length > 0 && exported.every((e) => e.isTypeOnly)));
      if (MODULE_BUILTIN.test(spec) && !node.isTypeOnly && !allow.dynamicImports.has(file)) add(node, 'create-require');
      const names = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text)
        : null; // export * from ...
      if (supabase(spec) && !node.isTypeOnly && !allow.supabaseClients.has(file) && (names === null || names.includes('createClient'))) {
        add(node, 'supabase-client');
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      const spec = node.moduleReference.expression.text;
      checkSpecifier(node, spec, node.isTypeOnly);
      if (MODULE_BUILTIN.test(spec) && !node.isTypeOnly && !allow.dynamicImports.has(file)) add(node, 'create-require');
      if (supabase(spec) && !node.isTypeOnly && !allow.supabaseClients.has(file)) add(node, 'supabase-client');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isCreateRequire = ts.isIdentifier(callee) && callee.text === 'createRequire';
      if (isImport || isRequire) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          checkSpecifier(node, arg.text);
          if (MODULE_BUILTIN.test(arg.text) && !allow.dynamicImports.has(file)) add(node, 'create-require');
          if (supabase(arg.text) && !allow.supabaseClients.has(file)) add(node, 'supabase-client');
        } else if (!allow.dynamicImports.has(file)) {
          add(node, isImport ? 'non-literal-import' : 'non-literal-require');
        }
      } else if (isCreateRequire && !allow.dynamicImports.has(file)) {
        add(node, 'non-literal-require'); // a require built at run time, its specifiers unreadable here
      }
    }

    // Ways to a require or to code built at run time that no specifier check sees
    // (audit round 2, item 2). Listed files (dynamicImports.json) may use them.
    if (!allow.dynamicImports.has(file)) {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : memberName(callee);
        if (name === 'Function' || (ts.isIdentifier(callee) && callee.text === 'eval')) add(node, 'dynamic-code');
      }
      const selected = memberName(node);
      if (selected && REQUIRE_FACTORY_NAMES.has(selected)) add(node, 'create-require'); // m.createRequire, process.getBuiltinModule
      else if (selected === 'require') add(node, 'indirect-require'); // globalThis.require, module.require
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        const bound = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
        if (bound && REQUIRE_FACTORY_NAMES.has(bound)) add(node, 'create-require');
        else if (bound === 'require') add(node, 'indirect-require'); // const { require } = module
      }
      if (ts.isIdentifier(node) && node.text === 'require' && isRequireValueReference(node)) add(node, 'indirect-require'); // const r = require

      // Aliases of the loader and of code built at run time (audit round 3, item 2).
      // A computed key, Reflect.get(globalThis, 'require') and the constructor of a
      // function value (`(() => {}).constructor(...)`) still walk around these.
      if (ts.isIdentifier(node) && CODE_BUILDERS.has(node.text) && isRequireValueReference(node)) add(node, 'loader-alias'); // const run = eval, Reflect.construct(Function, ...)
      if (selected === '_load') add(node, 'loader-alias'); // Module._load
      else if (selected && CODE_BUILDERS.has(selected) && !((ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node)) add(node, 'loader-alias'); // const F = globalThis.Function
      else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && selected === 'constructor' && isModuleObject(node.expression)) add(node, 'loader-alias'); // module.constructor
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        const bound = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
        const source = node.parent.parent;
        if (bound === '_load' || (bound && CODE_BUILDERS.has(bound))) add(node, 'loader-alias'); // const { _load } = m, const { Function: F } = globalThis
        else if (bound === 'constructor' && ts.isVariableDeclaration(source) && source.initializer && isModuleObject(source.initializer)) add(node, 'loader-alias'); // const { constructor } = module
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function scanSource(file: string, text: string, listed: ReadonlySet<string>, allow: Allowances = ALLOW): Finding[] {
  const findings: Finding[] = scanSyntax(file, text, allow);
  const readerZone = ALLOWED_DIRS.some((dir) => file.startsWith(dir)) || DEFINES_THE_FENCE.includes(file);
  const resolved: Finding[] = [];
  if (!readerZone) {
    // Every static specifier, resolved as tsc resolves it, so `source/./capability`,
    // `source//capability` and `graph/./reader` are the files they name (audit round 3, item 1).
    // Type-only references stay legal, as in the ESLint fence.
    const targets = readerTargetPaths();
    for (const ref of moduleReferencesOf(file, text)) {
      if (ref.typeOnly) continue;
      const target = resolveFrom(file, ref.specifier);
      if (target && targets.has(target)) resolved.push({ file, line: ref.line, kind: 'resolved-reader-import' });
    }
  }
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (NESTED_CONFIG_NAME.test(base) && file !== 'eslint.config.mjs') resolved.push({ file, line: 1, kind: 'nested-eslint-config' });
  // ESLint's reader fence also spans JS files, but this test stays a backstop
  // there: a static import in a JS file is flagged here too (review round 3).
  const jsFile = /\.[cm]?jsx?$/.test(file);
  text.split('\n').forEach((line, index) => {
    const at = index + 1;
    if (!readerZone) {
      for (const m of line.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g)) if (TARGET.test(m[1])) findings.push({ file, line: at, kind: 'dynamic-import' });
      for (const m of line.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]/g)) if (TARGET.test(m[1])) findings.push({ file, line: at, kind: 'require' });
      const staticLine = /^\s*(?:import|export)\b/.test(line) || /^\s*\}?\s*from\s+['"`]/.test(line);
      if (jsFile && staticLine) {
        for (const m of line.matchAll(/['"`]([^'"`\s]+)['"`]/g)) if (TARGET.test(m[1])) findings.push({ file, line: at, kind: 'js-static-import' });
      }
      // A bare string path (e.g. a computed import's operand) that is not a
      // static import line; in TS files ESLint judges those.
      if (!staticLine) {
        for (const m of line.matchAll(/['"`]([^'"`\s]+)['"`]/g)) if (TARGET.test(m[1])) findings.push({ file, line: at, kind: 'string-path' });
      }
    }
    // Comments apply everywhere, the guard folder and the readers included.
    if (BARE_DISABLE.test(line)) findings.push({ file, line: at, kind: 'bare-disable' });
    if (INLINE_CONFIG.test(line)) findings.push({ file, line: at, kind: 'inline-config' });
    if (DISABLE.test(line) && !listed.has(file)) findings.push({ file, line: at, kind: 'unlisted-disable' });
  });
  return [...findings, ...resolved];
}

const listed = new Set((allowlist as Array<{ file: string; reason: string }>).map((entry) => entry.file));

const kinds = (file: string, text: string, allow: Allowances = NO_ALLOWANCES) =>
  scanSource(file, text, listed, allow).map((f) => f.kind);

describe('mailbox reader fence backstop (#262)', () => {
  it('finds no reader reference, unreadable load, bare disable, raw client or test import in any production folder', () => {
    const findings = productionFiles().flatMap((path) => scanSource(path, readFileSync(join(process.cwd(), path), 'utf8'), listed));
    expect(findings).toEqual([]);
  }, 60_000);

  it('scans every top-level folder but tests, e2e, node_modules and .next, not a fixed list', () => {
    const scanned = productionFiles();
    expect(scanned.some((f) => f.startsWith('src/'))).toBe(true);
    expect(scanned.some((f) => f.startsWith('worker/'))).toBe(true);
    expect(scanned.some((f) => f.startsWith('scripts/'))).toBe(true);
    // Folders the old fixed list (src, worker, scripts, evals) never reached.
    expect(scanned.some((f) => f.startsWith('docs/'))).toBe(true);
    expect(scanned).toContain('eslint.config.mjs');
    expect(scanned.some((f) => f.startsWith('tests/') || f.startsWith('e2e/') || f.includes('node_modules/'))).toBe(false);
    // evals/ is its own package with its own fence (EVALS_FENCE), and dist/ is build output.
    expect(scanned.some((f) => f.startsWith('evals/') || f.startsWith('dist/'))).toBe(false);
  });

  it('flags a dynamic import, a require, a string path and an unlisted disable', () => {
    expect(scanSource('src/lib/search/x.ts', "const r = await import('@/lib/graph/reader');", listed)[0]?.kind).toBe('dynamic-import');
    expect(scanSource('scripts/x.cjs', "const r = require('../src/lib/google/reader/mail');", listed)[0]?.kind).toBe('require');
    expect(scanSource('worker/x.ts', "const target = '@azure/msal-node';", listed)[0]?.kind).toBe('string-path');
    expect(
      scanSource('scripts/x.ts', '// eslint-disable-next-line @typescript-eslint/no-restricted-imports', listed)[0]?.kind,
    ).toBe('unlisted-disable');
  });

  it('flags a static import in a JS file, which this test backs up alongside ESLint', () => {
    expect(scanSource('scripts/x.mjs', "import { getContentSource } from '../src/lib/graph/reader/index.ts';", listed)[0]?.kind).toBe('js-static-import');
    expect(scanSource('scripts/x.mjs', "} from 'google-auth-library';", listed)[0]?.kind).toBe('js-static-import');
    // A TS static import is ESLint's; the resolver check backs it up (audit round 3, item 1).
    expect(kinds('scripts/x.ts', "import { getContentSource } from '../src/lib/graph/reader';")).toEqual(['resolved-reader-import']);
  });

  it('flags the reader capability module reached from outside the reader zone', () => {
    expect(scanSource('src/lib/search/x.ts', "const r = await import('@/lib/discovery/source/capability');", listed)[0]?.kind).toBe('dynamic-import');
    expect(scanSource('scripts/x.cjs', "const r = require('../src/lib/discovery/source/capability.ts');", listed)[0]?.kind).toBe('require');
    expect(scanSource('scripts/x.mjs', "import { claimReaderCapability } from '../src/lib/discovery/source/capability.ts';", listed)[0]?.kind).toBe('js-static-import');
    expect(scanSource('worker/x.ts', "const target = '@/lib/graph/reader/capability';", listed)[0]?.kind).toBe('string-path');
    expect(scanSource('src/lib/mailboxAccess/readers.ts', "await import('@/lib/discovery/source/capability')", listed)).toEqual([]);
  });

  it('ignores the guard module and the reader itself for reader references', () => {
    expect(scanSource('src/lib/mailboxAccess/readers.ts', "await import('@/lib/graph/reader')", listed)).toEqual([]);
  });

  it('lists every allowlisted exception with a reason', () => {
    for (const entry of [...(allowlist as Array<{ file: string; reason: string }>), ...(dynamicImportAllowlist as Array<{ file: string; reason: string }>), ...(supabaseClientAllowlist as Array<{ file: string; reason: string }>)]) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
    }
  });
});

describe('non-literal import() and require() outside an allowlist (item 6)', () => {
  it.each([
    ['a computed import()', "const r = await import(['@/lib/graph', 'reader'].join('/'));", 'non-literal-import'],
    ['an import() of a variable', 'export const load = (p: string) => import(p);', 'non-literal-import'],
    ['an import() of a template', 'export const load = (p: string) => import(`@/lib/${p}`);', 'non-literal-import'],
    ['a computed require()', "const r = require(['../graph', 'reader'].join('/'));", 'non-literal-require'],
    ['createRequire', "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);", 'non-literal-require'],
  ])('flags %s in an unscanned-before top-level folder', (_name, code, kind) => {
    for (const file of ['supabase/functions/x/index.ts', 'skills-library/x.ts', 'next.config.ts', 'docs/x.mjs', 'evals/x.ts']) {
      expect(kinds(file, code), file).toContain(kind);
    }
  });

  it('lets a literal import() of another module through', () => {
    expect(kinds('src/lib/x.ts', "export const load = () => import('@/lib/other');")).toEqual([]);
    expect(kinds('scripts/x.cjs', "const fs = require('node:fs');")).toEqual([]);
  });

  it('honours an allowlisted file, and only that file', () => {
    const allow: Allowances = { dynamicImports: new Set(['scripts/generic.ts']), supabaseClients: new Set() };
    const code = 'export const load = (p: string) => import(p);';
    expect(kinds('scripts/generic.ts', code, allow)).toEqual([]);
    expect(kinds('scripts/other.ts', code, allow)).toEqual(['non-literal-import']);
  });

  it('applies inside the guard folder too', () => {
    expect(kinds('src/lib/mailboxAccess/x.ts', 'export const load = (p: string) => import(p);')).toEqual(['non-literal-import']);
  });
});

describe('a require or code built at run time, reached without a load call (audit round 2, item 2)', () => {
  it.each([
    ['a named createRequire import', "import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);", 'create-require'],
    ['an aliased createRequire import', "import { createRequire as cr } from 'module';\nexport const r = cr(import.meta.url);", 'create-require'],
    ['a namespace import of node:module', "import * as m from 'node:module';\nexport const r = m.createRequire(import.meta.url);", 'create-require'],
    ['a default import of module', "import m from 'node:module';\nexport const r = m.createRequire(import.meta.url);", 'create-require'],
    ['a bare import of module', "import 'node:module';", 'create-require'],
    ['a re-export of module', "export { createRequire } from 'node:module';", 'create-require'],
    ['a require of module', "const m = require('node:module');", 'create-require'],
    ['a dynamic import of module', "const m = await import('module');", 'create-require'],
    ['an import-equals of module', "import m = require('node:module');\nexport { m };", 'create-require'],
    ['a .createRequire access', 'declare const m: { createRequire(u: string): unknown };\nexport const r = m.createRequire(import.meta.url);', 'create-require'],
    ['a [createRequire] access', "declare const m: any;\nexport const r = m['createRequire'](import.meta.url);", 'create-require'],
    ['a destructured createRequire', 'declare const m: any;\nexport const { createRequire } = m;', 'create-require'],
    ['process.getBuiltinModule', "export const r = process.getBuiltinModule('module');", 'create-require'],
    ['Function()', "export const f = Function('return require')();", 'dynamic-code'],
    ['new Function()', "export const f = new Function('return require')();", 'dynamic-code'],
    ['globalThis.Function()', "export const f = globalThis.Function('return 1');", 'dynamic-code'],
    ["globalThis['Function']()", "export const f = globalThis['Function']('return 1');", 'dynamic-code'],
    ['eval()', "eval('1');", 'dynamic-code'],
    ['globalThis.require', "export const r = (globalThis as any).require('x');", 'indirect-require'],
    ["globalThis['require']", "export const r = (globalThis as any)['require']('x');", 'indirect-require'],
    ['module.require', "export const r = module.require('x');", 'indirect-require'],
    ['process.mainModule.require', "export const r = (process as any).mainModule.require('x');", 'indirect-require'],
    ['a destructured require', 'declare const m: any;\nexport const { require } = m;', 'indirect-require'],
    ['an alias of require', "const r = require;\nexport const x = r('x');", 'indirect-require'],
    ['require passed on', 'export const x = [1].map(require);', 'indirect-require'],
    ['require.call', "export const x = require.call(null, 'x');", 'indirect-require'],
  ])('flags %s', (_name, code, kind) => {
    for (const file of ['worker/x.ts', 'src/lib/search/x.ts', 'scripts/x.mts', 'supabase/functions/x/index.ts', 'src/lib/mailboxAccess/x.ts']) {
      expect(kinds(file, code), file).toContain(kind);
    }
  });

  it('leaves ordinary use of require and modules legal', () => {
    expect(kinds('scripts/x.cjs', "const fs = require('node:fs');\nif (require.main === module) fs.readFileSync('x');")).toEqual([]);
    expect(kinds('scripts/x.cjs', "const p = require.resolve('typescript');\nexport const ok = typeof require !== 'undefined';")).toEqual([]);
    expect(kinds('src/lib/x.ts', "import type { Module } from 'node:module';\nexport type M = Module;")).toEqual([]);
    expect(kinds('src/lib/x.ts', 'export const r = { require: 1 };\nexport const s = r.function;')).toEqual([]);
    expect(kinds('src/lib/x.ts', 'export function f(require: string) { return require.length; }')).toEqual([]);
  });

  it('honours an allowlisted file, and only that file', () => {
    const allow: Allowances = { dynamicImports: new Set(['scripts/generic.ts']), supabaseClients: new Set() };
    const code = "import { createRequire } from 'node:module';\nexport const f = new Function('x')(createRequire);";
    expect(kinds('scripts/generic.ts', code, allow)).toEqual([]);
    expect(kinds('scripts/other.ts', code, allow)).toContain('create-require');
  });
});

describe('inline ESLint config cannot switch a fence off (item 7)', () => {
  it.each([
    ['a bare line disable', '// eslint-disable', 'bare-disable'],
    ['a bare next-line disable', '// eslint-disable-next-line', 'bare-disable'],
    ['a bare block disable', '/* eslint-disable */', 'bare-disable'],
    ['a bare disable with a description only', '// eslint-disable-next-line -- because', 'bare-disable'],
    ['inline rule config', "/* eslint no-restricted-imports: 'off' */", 'inline-config'],
    ['inline env config', '/* eslint-env node */', 'inline-config'],
    ['a core fence-rule disable', '// eslint-disable-next-line no-restricted-imports', 'unlisted-disable'],
    ['a rule list that includes the fence rule', '// eslint-disable-next-line no-console, @typescript-eslint/no-restricted-imports', 'unlisted-disable'],
  ])('flags %s in any scanned folder', (_name, code, kind) => {
    for (const file of ['worker/x.ts', 'src/lib/search/x.ts', 'supabase/x.ts', 'src/lib/mailboxAccess/x.ts']) {
      expect(kinds(file, code), file).toContain(kind);
    }
  });

  it('keeps a justified disable of a named, other rule legal', () => {
    expect(kinds('src/lib/x.ts', '// eslint-disable-next-line @typescript-eslint/no-explicit-any')).toEqual([]);
    expect(kinds('src/lib/x.ts', '/* eslint-disable react-hooks/exhaustive-deps */')).toEqual([]);
    expect(kinds('src/lib/x.ts', '// eslint-disable-next-line no-console -- dev tool')).toEqual([]);
  });
});

describe('the raw supabase-js constructor stays in the admin client module (item 8)', () => {
  it.each([
    ['a named import', "import { createClient } from '@supabase/supabase-js';"],
    ['an aliased import', "import { createClient as make } from '@supabase/supabase-js';"],
    ['a mixed import', "import { createClient, type SupabaseClient } from '@supabase/supabase-js';"],
    ['a namespace import', "import * as supabase from '@supabase/supabase-js';"],
    ['a default-style import', "import supabase from '@supabase/supabase-js';"],
    ['a re-export', "export { createClient } from '@supabase/supabase-js';"],
    ['export star', "export * from '@supabase/supabase-js';"],
    ['a dynamic import', "const { createClient } = await import('@supabase/supabase-js');"],
    ['a require', "const { createClient } = require('@supabase/supabase-js');"],
  ])('flags %s outside the allowlist', (_name, code) => {
    for (const file of ['src/app/api/v1/x/route.ts', 'worker/other.ts', 'scripts/other.ts', 'src/lib/discovery/api.ts']) {
      expect(kinds(file, code), file).toContain('supabase-client');
    }
  });

  it('allows type-only use and the listed files', () => {
    expect(kinds('src/lib/x.ts', "import type { SupabaseClient } from '@supabase/supabase-js';")).toEqual([]);
    expect(kinds('src/lib/x.ts', "import { type SupabaseClient } from '@supabase/supabase-js';")).toEqual([]);
    expect(kinds('src/lib/x.ts', "export type { SupabaseClient } from '@supabase/supabase-js';")).toEqual([]);
    const allow: Allowances = { dynamicImports: new Set(), supabaseClients: new Set(['src/lib/supabase/server.ts']) };
    expect(kinds('src/lib/supabase/server.ts', "import { createClient } from '@supabase/supabase-js';", allow)).toEqual([]);
    expect(kinds('src/lib/supabase/other.ts', "import { createClient } from '@supabase/supabase-js';", allow)).toEqual(['supabase-client']);
  });

  it('names the admin client module in its allowlist', () => {
    expect((supabaseClientAllowlist as Array<{ file: string }>).map((e) => e.file)).toContain('src/lib/supabase/server.ts');
  });
});

describe('production code never imports tests or e2e (item 9)', () => {
  it.each([
    ['a relative import', "import { fixture } from '../../tests/helpers/fixture';"],
    ['a deep relative import', "import x from '../../../e2e/support/auth';"],
    ['an export from', "export { y } from '../tests/fixtures/y';"],
    ['a literal dynamic import', "const m = await import('../../tests/fixtures/y');"],
    ['a require', "const m = require('../tests/helpers/z');"],
    ['a type import', "import type { Fx } from '../../tests/fixtures/types';"],
  ])('flags %s from src, worker and scripts', (_name, code) => {
    for (const file of ['src/lib/x.ts', 'worker/x.ts', 'scripts/x.ts', 'src/app/api/v1/x/route.ts']) {
      expect(kinds(file, code), file).toContain('test-import');
    }
  });

  it('lets tests, test-only helpers and lookalike paths through', () => {
    expect(kinds('src/components/Foo.test.tsx', "import { fx } from '../../tests/helpers/fx';")).toEqual([]);
    expect(kinds('src/test/setup.ts', "import '../../tests/helpers/setup';")).toEqual([]);
    expect(kinds('src/lib/x.ts', "import { t } from '@/lib/test/thing';")).toEqual([]);
    expect(kinds('src/lib/x.ts', "import { t } from './contests/thing';")).toEqual([]);
  });
});

describe('every static specifier is resolved like tsc does (audit round 3, item 1)', () => {
  const CALLERS = ['src/lib/search/x.ts', 'src/app/api/v1/x/route.ts', 'worker/x.ts', 'scripts/x.mts', 'scripts/x.mjs', 'supabase/functions/x/index.ts'];
  // Each names a reader or the capability file by a spelling no text pattern anticipates.
  const ALIASED = [
    '@/lib/discovery/source/./capability',
    '@/lib/discovery/source//capability',
    '@/lib/graph/./reader',
    '@/lib/graph//reader',
    '@/lib/graph/reader/../reader',
    '@/lib/graph/reader/./index',
    '@/lib/graph/reader/index.ts',
    '@/lib/discovery/source/capability.js',
    '@/lib/graph/reader/capability',
  ];
  const relativeTo = (file: string, target: string) => {
    const rel = relative(dirname(file), target);
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
  // Relative spellings with a dot segment or a doubled slash, computed per caller.
  const relativeSpecs = (file: string) => [
    relativeTo(file, 'src/lib/graph/reader').replace(/reader$/, './reader'),
    relativeTo(file, 'src/lib/discovery/source/capability').replace(/source\//, 'source//'),
    relativeTo(file, 'src/lib/graph/reader/index.ts'),
  ];
  const forms = (spec: string): Array<[string, string]> => [
    ['a static import', `import { x } from '${spec}';\nexport const y = x;`],
    ['a side-effect import', `import '${spec}';`],
    ['an export-from', `export { x } from '${spec}';`],
    ['an export-star', `export * from '${spec}';`],
    ['an import-equals require', `import x = require('${spec}');\nexport { x };`],
    ['a literal import()', `export const load = () => import('${spec}');`],
    ['a literal require()', `const r = require('${spec}');`],
    ['a template-literal import()', `export const load = () => import(\`${spec}\`);`],
  ];

  it.each(ALIASED)('flags %s in every form, from every folder', (spec) => {
    for (const file of CALLERS) {
      for (const [name, code] of forms(spec)) expect(kinds(file, code), `${file}: ${name}`).toContain('resolved-reader-import');
    }
  });

  it('flags relative spellings with a dot segment or a doubled slash', () => {
    for (const file of CALLERS) {
      for (const spec of relativeSpecs(file)) {
        for (const [name, code] of forms(spec)) expect(kinds(file, code), `${file}: ${spec}: ${name}`).toContain('resolved-reader-import');
      }
    }
  });

  it('leaves type-only imports, the reader zone and other modules alone', () => {
    expect(kinds('src/lib/search/x.ts', "import type { GraphMessage } from '@/lib/graph/./reader';")).toEqual([]);
    expect(kinds('src/lib/search/x.ts', "import { type GraphMessage } from '@/lib/graph//reader';")).toEqual([]);
    expect(kinds('src/lib/search/x.ts', "export type { GraphMessage } from '@/lib/graph/./reader';")).toEqual([]);
    expect(kinds('src/lib/search/x.ts', "import type x = require('@/lib/graph/./reader');")).toEqual([]);
    expect(kinds('src/lib/mailboxAccess/readers.ts', "import { claimReaderCapability } from '@/lib/discovery/source/./capability';")).toEqual([]);
    expect(kinds('src/lib/graph/reader/capability.ts', "export { claimReaderCapability } from '@/lib/discovery/source//capability';")).toEqual([]);
    expect(kinds('src/lib/graph/reader/index.ts', "import { x } from './capability';")).toEqual([]);
    expect(kinds('src/lib/search/x.ts', "import { other } from '@/lib/discovery/./normalize';")).toEqual([]);
    expect(kinds('src/lib/search/x.ts', "import { nowhere } from '@/lib/does/not/./exist';")).toEqual([]);
    expect(kinds('src/lib/search/x.ts', "import { readFileSync } from 'node:fs';\nimport React from 'react';")).toEqual([]);
  });

  it('derives the target set from the tree, so a new reader file is covered on arrival', () => {
    expect(isReaderTargetFile('src/lib/google/reader/mail.ts')).toBe(true);
    expect(isReaderTargetFile('src/lib/graph/reader/anything/deep.tsx')).toBe(true);
    expect(isReaderTargetFile('src/lib/discovery/source/capability.ts')).toBe(true);
    expect(isReaderTargetFile('src/lib/discovery/source/other.ts')).toBe(false);
    expect(isReaderTargetFile('src/lib/mailboxAccess/readers.ts')).toBe(false);
    const abs = (f: string) => join(process.cwd(), f);
    const targets = readerTargetPaths();
    expect(targets.has(abs('src/lib/discovery/source/capability.ts'))).toBe(true);
    expect(targets.has(abs('src/lib/graph/reader/index.ts'))).toBe(true);
    expect(targets.has(abs('src/lib/graph/reader/capability.ts'))).toBe(true);
    expect(targets.has(abs('src/lib/mailboxAccess/readers.ts'))).toBe(false);
    expect(resolveFrom('src/lib/search/x.ts', '@/lib/graph/./reader')).toBe(abs('src/lib/graph/reader/index.ts'));
  });
});

describe('loader and eval aliases (audit round 3, item 2)', () => {
  const FILES = ['worker/x.ts', 'src/lib/search/x.ts', 'scripts/x.mts', 'supabase/functions/x/index.ts', 'src/lib/mailboxAccess/x.ts'];
  it.each([
    ['Module._load', 'declare const m: any;\nexport const l = m._load("x", null, false);'],
    ["m['_load']", "declare const m: any;\nexport const l = m['_load']('x');"],
    ['a destructured _load', 'declare const m: any;\nexport const { _load } = m;'],
    ['module.constructor', 'export const c = (module as any).constructor;'],
    ["module['constructor']", "export const c = (module as any)['constructor'];"],
    ['require.main.constructor', 'export const c = (require.main as any).constructor;'],
    ['require.main!.constructor._load', "export const l = require.main!.constructor._load('x');"],
    ['process.mainModule.constructor', 'export const c = (process as any).mainModule.constructor;'],
    ['a destructured constructor of module', 'export const { constructor: C } = module as any;'],
    ['an eval alias', 'export const run = eval;'],
    ['a Function alias', 'export const F = Function;'],
    ['Reflect.construct(Function, ...)', "export const f = Reflect.construct(Function, ['return require']);"],
    ['Reflect.apply(eval, ...)', "export const v = Reflect.apply(eval, null, ['1']);"],
    ['eval passed on', "export const v = ['1'].map(eval);"],
    ['a stored globalThis.Function', 'export const F = globalThis.Function;'],
    ['a stored globalThis.eval', 'export const e = (globalThis as any).eval;'],
    ["a stored globalThis['Function']", "export const F = (globalThis as any)['Function'];"],
    ['a destructured Function', 'export const { Function: F } = globalThis;'],
    ['Function.call', "export const f = Function.call(null, 'return 1');"],
  ])('flags %s', (_name, code) => {
    for (const file of FILES) expect(kinds(file, code), file).toContain('loader-alias');
  });

  it('leaves ordinary module and constructor use legal', () => {
    expect(kinds('scripts/x.cjs', "if (require.main === module) { process.exitCode = 0; }\nmodule.exports = { a: 1 };")).toEqual([]);
    expect(kinds('src/lib/x.ts', 'export const n = (v: object) => v.constructor.name;')).toEqual([]);
    expect(kinds('src/lib/x.ts', 'export class A { same(o: object) { return o.constructor === this.constructor; } }')).toEqual([]);
    expect(kinds('src/lib/x.ts', "export const is = (v: unknown) => v instanceof Function || typeof eval === 'function';")).toEqual([]);
    expect(kinds('src/lib/x.ts', 'export function f(fn: Function) { return fn; }\nexport type G = Function;')).toEqual([]);
    expect(kinds('src/lib/x.ts', 'export const o = { eval: 1, Function: 2, load: 3 };')).toEqual([]);
    expect(kinds('src/lib/x.ts', 'export const p = Function.prototype;')).toEqual([]);
  });

  it('honours an allowlisted file, and only that file', () => {
    const allow: Allowances = { dynamicImports: new Set(['scripts/generic.ts']), supabaseClients: new Set() };
    const code = 'export const run = eval;\nexport const F = Function;';
    expect(kinds('scripts/generic.ts', code, allow)).toEqual([]);
    expect(kinds('scripts/other.ts', code, allow)).toContain('loader-alias');
  });
});

describe('vm, worker_threads and child_process stay out of production code unless listed (audit round 3, item 2)', () => {
  const FILES = ['worker/x.ts', 'src/lib/search/x.ts', 'src/app/api/v1/x/route.ts', 'scripts/x.mts', 'src/lib/mailboxAccess/x.ts'];
  const SPECS = ['node:vm', 'vm', 'node:worker_threads', 'worker_threads', 'node:child_process', 'child_process'];
  const forms = (spec: string): Array<[string, string]> => [
    ['a named import', `import { run } from '${spec}';\nexport { run };`],
    ['a namespace import', `import * as m from '${spec}';\nexport { m };`],
    ['a default import', `import m from '${spec}';\nexport { m };`],
    ['a side-effect import', `import '${spec}';`],
    ['an export-from', `export { run } from '${spec}';`],
    ['an import-equals require', `import m = require('${spec}');\nexport { m };`],
    ['a require', `const m = require('${spec}');`],
    ['a dynamic import', `export const load = () => import('${spec}');`],
  ];

  it.each(SPECS)('flags %s in every form', (spec) => {
    for (const file of FILES) {
      for (const [name, code] of forms(spec)) expect(kinds(file, code), `${file}: ${name}`).toContain('process-module');
    }
  });

  it('leaves type-only imports and lookalike modules legal', () => {
    expect(kinds('src/lib/x.ts', "import type { ChildProcess } from 'node:child_process';\nexport type C = ChildProcess;")).toEqual([]);
    expect(kinds('src/lib/x.ts', "import { type Worker } from 'node:worker_threads';\nexport type W = Worker;")).toEqual([]);
    expect(kinds('src/lib/x.ts', "export type { Script } from 'node:vm';")).toEqual([]);
    expect(kinds('scripts/ci/x.test.mjs', "import { execFileSync } from 'node:child_process';")).toEqual([]);
    expect(kinds('src/lib/x.ts', "import { x } from 'vm2-lookalike';\nimport { y } from './vm';\nimport { z } from '@/lib/child_process';")).toEqual([]);
  });

  it('honours an allowlisted file, and only that file', () => {
    const allow: Allowances = { dynamicImports: new Set(), supabaseClients: new Set(), nodeProcessModules: new Set(['scripts/git.ts']) };
    const code = "import { execFileSync } from 'node:child_process';\nexport const v = execFileSync('git', ['--version']);";
    expect(kinds('scripts/git.ts', code, allow)).toEqual([]);
    expect(kinds('scripts/other.ts', code, allow)).toEqual(['process-module']);
  });

  it('lists only files that still import one of them, each with a reason', () => {
    const entries = nodeProcessModuleAllowlist as Array<{ file: string; reason: string }>;
    expect(entries.length).toBeGreaterThan(0);
    for (const { file, reason } of entries) {
      expect(reason.length, file).toBeGreaterThan(20);
      const own = scanSource(file, readFileSync(join(process.cwd(), file), 'utf8'), listed, NO_ALLOWANCES).map((f) => f.kind);
      expect(own, `${file} is listed but imports none of them: remove the entry`).toContain('process-module');
    }
  });
});

describe('an ESLint config below the repo root is flagged (audit round 3, item 3)', () => {
  it.each([
    'src/lib/search/eslint.config.mjs',
    'src/lib/discovery/eslint.config.js',
    'worker/eslint.config.ts',
    'scripts/eslint.config.cjs',
    'src/eslint.config.mts',
    'src/app/api/v1/discovery/eslint.config.cts',
    'docs/eslint.config.mjs',
  ])('flags %s', (file) => {
    expect(kinds(file, 'export default [];')).toContain('nested-eslint-config');
  });

  it('accepts the root config and lookalikes', () => {
    expect(kinds('eslint.config.mjs', 'export default [];')).toEqual([]);
    expect(kinds('src/lib/eslint-config.ts', 'export const x = 1;')).toEqual([]);
    expect(kinds('src/lib/my.eslint.config.notes.ts', 'export const x = 1;')).toEqual([]);
  });

  it('finds no nested config anywhere in the repo, tests and e2e included', () => {
    const nested = ['.', 'tests', 'e2e'].flatMap((dir) => (dir === '.' ? productionFiles() : walk(dir))).filter((f) => NESTED_CONFIG_NAME.test(f.slice(f.lastIndexOf('/') + 1)) && f !== 'eslint.config.mjs');
    expect(nested).toEqual([]);
  });
});

// The fence rules, and the one config that defines them (audit round 3, item 3).
const READER_RULE = '@typescript-eslint/no-restricted-imports';
const FENCE_RULES = new Set(['no-restricted-imports', READER_RULE]);
const ruleFilter = ({ ruleId }: { ruleId: string }) => FENCE_RULES.has(ruleId);
// Named explicitly, not with a glob: ESLint's own root config is the only config read. In ESLint 10 a
// nested eslint.config.* is found per file and replaces the root one for the files under it, so
// nothing but this file may configure a production file (and the backstop flags any other).
const ROOT_CONFIG = join(process.cwd(), 'eslint.config.mjs');
const strictEslint = (overrideConfig?: ESLint.Options['overrideConfig']) =>
  new ESLint({ cwd: process.cwd(), overrideConfigFile: ROOT_CONFIG, allowInlineConfig: false, ruleFilter, overrideConfig });

// Ignored by the root config on purpose: generated by `next dev` and rewritten on every run, with no imports.
const IGNORED_BY_DESIGN: ReadonlySet<string> = new Set(['next-env.d.ts']);
// Where the reader rule is intentionally off: the guard and the readers themselves (eslint.config.mjs `ignores`).
const READER_RULE_EXEMPT = (file: string) => ALLOWED_DIRS.some((dir) => file.startsWith(dir));
// Zones of the core no-restricted-imports fences A, B and C (each a `files` glob in eslint.config.mjs).
const CORE_FENCE_ZONE =
  /^(?:src\/app\/api\/v1\/discovery\/|src\/app\/\(authed\)\/discovery\/|src\/lib\/discovery\/api\.ts$|worker\/classify\.ts$|src\/lib\/graph\/|src\/lib\/discovery\/(?:normalize|route|discover)\/|src\/lib\/discovery\/persist\.ts$|src\/lib\/mailboxAccess\/|src\/lib\/ignatious\/|src\/lib\/orchestration\/|src\/lib\/skillRun\/|src\/lib\/conductia\/|src\/app\/v1\/)/;

const severityOf = (entry: unknown): number => {
  const level = Array.isArray(entry) ? entry[0] : entry;
  return level === 'error' || level === 2 ? 2 : level === 'warn' || level === 1 ? 1 : 0;
};

/**
 * Lints `files` and returns what is wrong with the ESLint run itself: a file the
 * config ignores (other than the by-design list), a file with no result, and a
 * fence rule whose effective severity is not `error` for a file it must cover.
 * A downgraded rule or a widened ignore would otherwise make the run report no
 * errors and look clean.
 */
async function lintProduction(eslint: ESLint, files: string[]) {
  const abs = (f: string) => join(process.cwd(), f);
  const problems: string[] = [];
  const ignored = new Set<string>();
  for (const f of files) if (await eslint.isPathIgnored(abs(f))) ignored.add(f);
  for (const f of ignored) if (!IGNORED_BY_DESIGN.has(f)) problems.push(`${f}: ignored by the ESLint config`);
  const linted = files.filter((f) => !ignored.has(f));
  const results = await eslint.lintFiles(linted.map(abs));
  const seen = new Set(results.map((r) => r.filePath));
  for (const f of linted) if (!seen.has(abs(f))) problems.push(`${f}: no ESLint result`);
  for (const f of linted) {
    const rules = (await eslint.calculateConfigForFile(abs(f)))?.rules ?? {};
    if (!READER_RULE_EXEMPT(f) && severityOf(rules[READER_RULE]) !== 2) problems.push(`${f}: ${READER_RULE} is not an error`);
    if (CORE_FENCE_ZONE.test(f) && severityOf(rules['no-restricted-imports']) !== 2) problems.push(`${f}: no-restricted-imports is not an error`);
  }
  return { results, problems };
}

/**
 * The line scan cannot read a comment that spans lines. `/*\n eslint-disable *\/`
 * and a multi-line `/* eslint\n rule: 'off' *\/` are honoured by ESLint and pass
 * both text checks above. So ESLint runs over the production files with inline
 * comments ignored and only the fence rules on: a fence error that a comment was
 * hiding shows up, and nothing outside the ratchet allowlist may have one.
 */
describe('ESLint with inline comments ignored (audit round 2, item 3)', () => {
  let strict: ESLint;
  let normal: ESLint;

  beforeAll(() => {
    strict = strictEslint();
    normal = new ESLint({ cwd: process.cwd(), overrideConfigFile: ROOT_CONFIG, ruleFilter });
  }, 60_000);

  it('reads only the root config: the config ESLint finds on its own for a production file is the one named here', async () => {
    // Compared with ESLint's own lookup (no overrideConfigFile), not with the expression that builds ROOT_CONFIG:
    // a nested eslint.config.* that took over a production file would make the two differ.
    // The flag makes ESLint 9 look up a config per file, as ESLint 10 does, so a nested config is found.
    const discovery = new ESLint({ cwd: process.cwd(), flags: ['v10_config_lookup_from_file'] });
    for (const file of ['src/lib/discovery/api.ts', 'worker/classify.ts', 'src/lib/mailboxAccess/guard.ts']) {
      expect(await discovery.findConfigFile(join(process.cwd(), file)), file).toBe(ROOT_CONFIG);
    }
  });

  const READER_IMPORT = "import { getContentSource } from '@/lib/graph/reader';\nexport const x = getContentSource;\n";
  const fenceErrors = async (eslint: ESLint, code: string, file: string) => {
    const [result] = await eslint.lintText(code, { filePath: join(process.cwd(), file) });
    return result.messages.filter((m) => m.ruleId && FENCE_RULES.has(m.ruleId) && m.severity === 2);
  };

  it.each([
    ['a multi-line block disable', `/*\n eslint-disable */\n${READER_IMPORT}`],
    ['a multi-line block disable of the fence rule', `/*\n eslint-disable @typescript-eslint/no-restricted-imports */\n${READER_IMPORT}`],
    ['a multi-line inline rule config', `/*\n eslint @typescript-eslint/no-restricted-imports: 'off'\n*/\n${READER_IMPORT}`],
    ['a multi-line inline rule config with the rule on the second line', `/* eslint\n   @typescript-eslint/no-restricted-imports: ["off"]\n*/\n${READER_IMPORT}`],
  ])('finds the reader import that %s hides', async (_name, code) => {
    const file = 'src/lib/search/probe.ts';
    // The probe is real: a normal lint honours the comment and reports nothing...
    expect(await fenceErrors(normal, code, file)).toEqual([]);
    // ...and the strict run reports the import the comment was hiding.
    expect(await fenceErrors(strict, code, file)).toHaveLength(1);
    // The unhidden import is an error in both.
    expect(await fenceErrors(normal, READER_IMPORT, file)).toHaveLength(1);
  }, 30_000);

  it('finds the same hidden import in a JS file and in the worker', async () => {
    const code = `/*\n eslint-disable */\n${READER_IMPORT}`;
    expect(await fenceErrors(strict, code, 'scripts/probe.mjs')).toHaveLength(1);
    expect(await fenceErrors(strict, code, 'worker/probe.ts')).toHaveLength(1);
  }, 30_000);

  it('finds no fence error in any production file, once inline comments are ignored, outside the allowlist', async () => {
    const files = productionFiles();
    const { results, problems } = await lintProduction(strict, files);
    // Every file is in the results, none is ignored, and each fence rule is an error for the files it covers.
    expect(problems).toEqual([]);
    expect(results.length).toBe(files.filter((f) => !IGNORED_BY_DESIGN.has(f)).length);
    const errors = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId && FENCE_RULES.has(m.ruleId) && m.severity === 2)
        .map((m) => ({ file: r.filePath.slice(process.cwd().length + 1), line: m.line, rule: m.ruleId })),
    );
    expect(errors.filter((e) => !listed.has(e.file))).toEqual([]);
  }, 240_000);

  describe('the config cannot be weakened unseen (audit round 3, item 3)', () => {
    // A few real production files stand in for the repo: the checks are per file.
    const sample = () => {
      const files = productionFiles();
      const pick = (prefix: string) => files.find((f) => f.startsWith(prefix)) as string;
      const sampled = [pick('src/lib/team/'), 'worker/classify.ts', pick('scripts/'), pick('src/lib/discovery/route/'), 'src/lib/discovery/api.ts'];
      expect(sampled.every((f) => f && files.includes(f)), sampled.join()).toBe(true);
      return sampled;
    };

    it('reports nothing for the real config', async () => {
      expect((await lintProduction(strict, sample())).problems).toEqual([]);
    }, 60_000);

    it('reports a file the config ignores', async () => {
      const [first] = sample();
      const weakened = strictEslint([{ ignores: [first] }]);
      // The old check linted the list and saw no error for the ignored file: it looked clean.
      expect((await lintProduction(weakened, sample())).problems).toEqual([`${first}: ignored by the ESLint config`]);
    }, 60_000);

    it('reports a downgraded reader rule', async () => {
      const [first] = sample();
      const downgraded = strictEslint([{ files: [first], rules: { [READER_RULE]: 'warn' } }]);
      expect((await lintProduction(downgraded, sample())).problems).toEqual([`${first}: ${READER_RULE} is not an error`]);
    }, 60_000);

    it('reports a switched-off reader rule and a downgraded core fence', async () => {
      const files = sample();
      const off = strictEslint([{ files: ['**/*.ts'], rules: { [READER_RULE]: 'off' } }]);
      expect((await lintProduction(off, files)).problems.length).toBeGreaterThan(0);
      const core = strictEslint([{ files: ['src/lib/discovery/api.ts'], rules: { 'no-restricted-imports': 'warn' } }]);
      expect((await lintProduction(core, files)).problems).toEqual(['src/lib/discovery/api.ts: no-restricted-imports is not an error']);
    }, 60_000);

    it('ignores only the generated next-env.d.ts, by name', async () => {
      // next-env.d.ts is generated by `next dev` / `next build` and gitignored, so a
      // fresh CI checkout has none; only the ignore rule itself is pinned here.
      // Asked of the loaded config: each by-design name is ignored there, and real source is not.
      for (const name of IGNORED_BY_DESIGN) expect(await strict.isPathIgnored(join(process.cwd(), name)), name).toBe(true);
      for (const real of ['src/lib/discovery/api.ts', 'worker/classify.ts']) {
        expect(await strict.isPathIgnored(join(process.cwd(), real)), real).toBe(false);
      }
    });
  });
});
