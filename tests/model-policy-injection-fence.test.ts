// @vitest-environment node
// The verified-path policy is a test seam. No file outside tests/ may pass one, so production always runs on
// the shipped constants (design Q1, m4). Two shapes are fenced: runExtractOnce({ policy }) and a fourth
// argument to assertProcessorAllowed. The one forwarding call in run.ts is the single exception. So that no
// call escapes the scan, runExtractOnce may only be imported under its own name and called directly.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src', 'worker', 'scripts'];
/** runExtractOnce receives the policy as an option and hands it to the gate; that one call site may take four arguments. */
const FORWARDING_FILE = 'src/lib/discovery/extract/run.ts';
const FORWARDING_FUNCTION = 'runExtractOnce';
/** The module that declares runExtractOnce, as an import specifier names it (alias or relative path). */
const RUN_MODULE = /(^|\/)extract\/run$|^\.\/run$/;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : /\.(ts|tsx|mts)$/.test(n) ? [p] : [];
  });

const calleeName = (call: ts.CallExpression): string =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';

/** The name of the nearest enclosing function declaration, or '' when there is none. */
function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n)) return n.name?.text ?? '';
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) return '';
  }
  return '';
}

/** `opts.policy`, exactly: the expression run.ts forwards. */
const isOptsPolicy = (arg: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'opts' && arg.name.text === 'policy';

/** The key of an object literal member, or null when it cannot be known statically (computed, method, accessor). */
function memberKey(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
  const { name } = p;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : null;
}

const isRunModule = (spec: ts.Expression) => ts.isStringLiteralLike(spec) && RUN_MODULE.test(spec.text);

/** A runExtractOnce identifier that is its declaration, a same-name import, or the callee of a call (bare or as a property). */
function isAllowedReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isFunctionDeclaration(parent) && parent.name === id) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true; // judged as specifiers above
  const callee = ts.isPropertyAccessExpression(parent) && parent.name === id ? parent : id;
  return ts.isCallExpression(callee.parent) && callee.parent.expression === callee;
}

/** `path` is repo-relative with forward slashes; `text` is the source. */
function offences(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  let forwarding = 0; // forwarding calls already allowed in this file: one, and no more
  const visit = (node: ts.Node) => {
    // runExtractOnce itself: imported under its own name, never re-exported, and only ever the direct callee.
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'runExtractOnce' && node.name.text !== 'runExtractOnce')
      found.push(`${path}: runExtractOnce imported under another name`);
    if (ts.isExportSpecifier(node) && (node.propertyName ?? node.name).text === 'runExtractOnce')
      found.push(`${path}: runExtractOnce re-exported`);
    if (ts.isNamespaceImport(node) && !node.parent.isTypeOnly && isRunModule(node.parent.parent.moduleSpecifier))
      found.push(`${path}: the run module imported as a namespace`);
    if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && isRunModule(node.moduleSpecifier))
      found.push(`${path}: the run module re-exported wholesale`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && isRunModule(node.arguments[0]))
      found.push(`${path}: the run module imported dynamically`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'runExtractOnce')
      found.push(`${path}: runExtractOnce reached by element access`);
    if (ts.isIdentifier(node) && node.text === 'runExtractOnce' && !isAllowedReference(node))
      found.push(`${path}: runExtractOnce used other than as a direct call`);
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === 'assertProcessorAllowed') {
        const args = node.arguments;
        const isForwardingCall =
          path === FORWARDING_FILE && args.length === 4 && isOptsPolicy(args[3]) && enclosingFunctionName(node) === FORWARDING_FUNCTION;
        if (args.some(ts.isSpreadElement)) found.push(`${path}: assertProcessorAllowed with a spread argument`);
        else if (isForwardingCall && forwarding === 0) forwarding++;
        else if (args.length > 3) found.push(`${path}: assertProcessorAllowed with a policy`);
      }
      if (name === 'runExtractOnce') {
        const [arg] = node.arguments;
        if (!arg || !ts.isObjectLiteralExpression(arg)) found.push(`${path}: runExtractOnce with a non-literal options object`);
        else if (arg.properties.some((p) => ts.isSpreadAssignment(p) || memberKey(p) === null || memberKey(p) === 'policy'))
          found.push(`${path}: runExtractOnce with a policy, a spread or a computed key`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const asRepoPath = (p: string) => relative(process.cwd(), p).split(sep).join('/');

describe('the processor policy is injected by tests only', () => {
  it('no source, worker or script file passes a policy', () => {
    const all = ROOTS.flatMap((r) => files(join(process.cwd(), r)));
    expect(all.flatMap((p) => offences(asRepoPath(p), readFileSync(p, 'utf8')))).toEqual([]);
  });

  it('still reads run.ts: its one forwarding call is the exception the scan relies on', () => {
    const text = readFileSync(join(process.cwd(), FORWARDING_FILE), 'utf8');
    expect(text).toContain('assertProcessorAllowed(opts.tenantId, opts.transport.kind, opts.env, opts.policy)');
    expect(offences(FORWARDING_FILE, text)).toEqual([]);
  });

  it('catches a policy handed to runExtractOnce, however the options object is built', () => {
    const planted = (call: string) => offences('src/lib/example.ts', `async function go() { await ${call}; }`);
    for (const call of [
      'runExtractOnce({ tenantId, transport, store, policy: OPEN })',
      'runExtractOnce({ tenantId, transport, store, policy })',
      "runExtractOnce({ tenantId, transport, store, 'policy': OPEN })",
      "runExtractOnce({ tenantId, transport, store, ['policy']: OPEN })",
      'runExtractOnce({ tenantId, transport, store, ...rest })',
      'runExtractOnce(opts)',
      'runExtractOnce()',
      'extract.runExtractOnce(opts)',
    ])
      expect(planted(call), call).toHaveLength(1);
    expect(planted('runExtractOnce({ tenantId, transport, store: supabaseExtractStore(db) })')).toEqual([]);
  });

  it('catches a fourth argument to assertProcessorAllowed outside run.ts, and a spread', () => {
    const planted = (path: string, call: string) => offences(path, `const x = ${call};`);
    expect(planted('src/lib/example.ts', 'assertProcessorAllowed(t, k, env, policy)')).toHaveLength(1);
    expect(planted('src/lib/example.ts', 'assertProcessorAllowed(t, k, env, opts.policy)')).toHaveLength(1);
    expect(planted('src/lib/example.ts', 'gate.assertProcessorAllowed(t, k, env, policy)')).toHaveLength(1);
    expect(planted('src/lib/example.ts', 'assertProcessorAllowed(...args)')).toHaveLength(1);
    expect(planted('worker/extract.ts', 'assertProcessorAllowed(t, k, env, policy)')).toHaveLength(1);
    expect(planted('src/lib/example.ts', 'assertProcessorAllowed(t, k, env)')).toEqual([]);
  });

  it('catches runExtractOnce reached any way but a direct call under its own name', () => {
    const planted = (text: string) => offences('worker/example.ts', text);
    for (const text of [
      "import { runExtractOnce as go } from '@/lib/discovery/extract/run';\nawait go({ tenantId, transport, store, policy: OPEN });",
      "import { runExtractOnce as go } from '@/lib/discovery/extract/run';",
      "import * as run from '@/lib/discovery/extract/run';",
      "const run = await import('@/lib/discovery/extract/run');",
      "export { runExtractOnce } from '@/lib/discovery/extract/run';",
      "export * from '@/lib/discovery/extract/run';",
      "await mod['runExtractOnce']({ tenantId, transport, store });",
      'await runExtractOnce.call(null, { tenantId, transport, store });',
      'await runExtractOnce.apply(null, [{ tenantId, transport, store }]);',
      'const go = runExtractOnce;',
      'schedule(runExtractOnce);',
    ])
      expect(planted(text), text).not.toEqual([]);
    // The worker's shape stays clean, and a type-only namespace import reads no value.
    expect(
      planted("import { runExtractOnce, type ExtractSummary } from '@/lib/discovery/extract/run';\nconst once = () => runExtractOnce({ tenantId, transport, store });"),
    ).toEqual([]);
    expect(planted("import type * as run from '@/lib/discovery/extract/run';")).toEqual([]);
  });

  it('exempts exactly the forwarding call in run.ts, and flags a second one', () => {
    const forward = 'assertProcessorAllowed(opts.tenantId, opts.transport.kind, opts.env, opts.policy)';
    const inRun = (body: string, path = FORWARDING_FILE) => offences(path, body);
    // The same text is an offence in any other file.
    expect(inRun(`async function runExtractOnce(opts: O) { ${forward}; }`, 'src/lib/discovery/extract/other.ts')).toHaveLength(1);
    // One forwarding call inside runExtractOnce is the exception.
    expect(inRun(`async function runExtractOnce(opts: O) { ${forward}; }`)).toEqual([]);
    // A second 4-argument call in run.ts is flagged, in the same function or another.
    expect(inRun(`async function runExtractOnce(opts: O) { ${forward}; ${forward}; }`)).toHaveLength(1);
    expect(inRun(`async function runExtractOnce(opts: O) { ${forward}; }\nfunction later(opts: O) { ${forward}; }`)).toHaveLength(1);
    // So are a different 4th argument, a call outside runExtractOnce and a call at the top level.
    expect(inRun('async function runExtractOnce(opts: O) { assertProcessorAllowed(opts.tenantId, opts.transport.kind, opts.env, OPEN); }')).toHaveLength(1);
    expect(inRun(`function other(opts: O) { ${forward}; }`)).toHaveLength(1);
    expect(inRun(`${forward};`)).toHaveLength(1);
    // runExtractOnce's own policy check still covers run.ts.
    expect(inRun('async function f() { await runExtractOnce({ tenantId, transport, store, policy: OPEN }); }')).toHaveLength(1);
  });
});
