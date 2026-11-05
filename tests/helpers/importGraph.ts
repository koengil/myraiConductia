import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

/**
 * A small module graph over the repo's own source (#262, audit round 2, item 1).
 * It reads import declarations, `export ... from`, `import x = require()`, and
 * literal import() and require() calls, and resolves `@/` and relative specifiers. Bare package
 * specifiers are not followed. Used to ask which entry points can reach a module.
 */

const ROOT = process.cwd();
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export type ImportEdge = { specifier: string; kind: 'static' | 'dynamic'; line: number };
export type ModuleReference = ImportEdge & {
  /** The reference loads nothing at run time: `import type`, `export type`, or an import whose every name is a `type` name. */
  typeOnly: boolean;
};

/**
 * Every module reference with a literal specifier, in source order: import
 * declarations, `export ... from`, `import x = require('...')` (also exported),
 * and literal import() and require() calls.
 */
export function moduleReferencesOf(file: string, text: string): ModuleReference[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const refs: ModuleReference[] = [];
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      // `import { type A, type B } from 'x'` is elided whole; `import {} from 'x'` and `import 'x'` are not.
      const allNamesType =
        !!clause && !clause.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      refs.push({ specifier: node.moduleSpecifier.text, kind: 'static', line: line(node), typeOnly: !!clause?.isTypeOnly || allNamesType });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const allNamesType = !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
      refs.push({ specifier: node.moduleSpecifier.text, kind: 'static', line: line(node), typeOnly: node.isTypeOnly || allNamesType });
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import x = require('...')` is a load that is neither an import declaration nor a call (audit round 3, item 4).
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) {
        refs.push({ specifier: ref.expression.text, kind: 'static', line: line(node), typeOnly: node.isTypeOnly });
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
      if (loads && arg && ts.isStringLiteralLike(arg)) refs.push({ specifier: arg.text, kind: 'dynamic', line: line(node), typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/** Every module reference that loads something, in source order. Type-only imports are skipped (they do not load the module). */
export function importsOf(file: string, text: string): ImportEdge[] {
  return moduleReferencesOf(file, text)
    .filter((ref) => !ref.typeOnly)
    .map(({ specifier, kind, line }) => ({ specifier, kind, line }));
}

/** Repo-relative path of an own-source specifier, or null for a package or an unresolvable path. */
export function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join('src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = join(dirname(from), specifier);
  else return null;
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => join(base, 'index' + e))];
  for (const candidate of candidates) {
    const abs = join(ROOT, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return relative(ROOT, abs);
  }
  return null;
}

const edgeCache = new Map<string, ImportEdge[]>();
const edgesOfFile = (file: string): ImportEdge[] => {
  let edges = edgeCache.get(file);
  if (!edges) edgeCache.set(file, (edges = importsOf(file, readFileSync(join(ROOT, file), 'utf8'))));
  return edges;
};

/** Whether `target` is reachable from `entry`. `follow` picks which kinds of edge count. */
export function reaches(entry: string, target: string, follow: ReadonlySet<ImportEdge['kind']>): boolean {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === target && file !== entry) return true;
    for (const edge of edgesOfFile(file)) {
      if (!follow.has(edge.kind)) continue;
      const next = resolveSpecifier(file, edge.specifier);
      if (next) queue.push(next);
    }
  }
  return false;
}
