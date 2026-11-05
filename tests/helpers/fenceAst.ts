import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import { MAILBOX_DERIVED_TABLES } from '@/lib/constants/discovery';

import mailboxSqlFunctions from '../fixtures/mailboxSqlFunctions.json';
import { walk } from './walkRepo';

/**
 * TypeScript-compiler-API detectors for the mailbox fences (#262, audit round
 * 1, items 4, 5, 11). They replace regexes over source text, which a computed
 * name, `TABLE['X']`, a destructured constant or a string concatenation walk
 * around. The threat model is in the header of tests/agent-surfaces.test.ts.
 *
 * Trade-off: one ts.Program over the whole repo (about 4 s to build, plus a
 * second or two of checking the nodes we ask about; tsc itself takes longer
 * because it checks everything). The program is built lazily, once per test
 * file that needs types, so the unit suite pays it in only the files that use
 * this helper. A per-file Program would break `TABLE.X` and re-exported
 * constants, which only resolve with the whole module graph.
 */

export const ROOT = process.cwd();
export const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/** The mailbox-derived tables and the RPCs that read them (mailboxSqlFunctions.json is the SQL classification). */
export const RPC_NAMES = (mailboxSqlFunctions as Array<{ name: string }>).map((f) => f.name);
export const DERIVED_NAMES: ReadonlySet<string> = new Set<string>([...MAILBOX_DERIVED_TABLES, ...RPC_NAMES]);
const TABLE_NAMES: ReadonlySet<string> = new Set<string>(MAILBOX_DERIVED_TABLES);
const kindOfName = (name: string): 'table' | 'rpc' => (TABLE_NAMES.has(name) ? 'table' : 'rpc');

/** The only constants files that name mailbox-derived tables. Every other file under constants/ is scanned. */
export const CONSTANT_HOMES = ['src/lib/constants/tables.ts', 'src/lib/constants/discovery.ts'];

// evals/ is its own package (evals/deal-discovery, with its own package.json, tsconfig and tests), fenced off
// from the app by EVALS_FENCE in eslint.config.mjs and reading a discovery:export rather than app code. dist/
// is build output (the worker image's compiled entry points).
const EXCLUDED_TOP_LEVEL = new Set(['tests', 'e2e', 'node_modules', '.next', 'evals', 'dist']);

/**
 * Every source file of every top-level folder except tests, e2e, node_modules,
 * .next, evals and dist (dot folders are skipped by walk), plus the source files
 * at the repo root. Not a fixed list: a new top-level folder is scanned on arrival.
 */
export function productionFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walk(entry.name));
    else if (SOURCE_EXT.test(entry.name)) out.push(entry.name);
  }
  return out.filter((f) => SOURCE_EXT.test(f)).sort();
}

let cachedProgram: ts.Program | undefined;
export function fenceProgram(): ts.Program {
  if (!cachedProgram) {
    const config = ts.parseJsonConfigFileContent(
      ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config,
      ts.sys,
      ROOT,
    );
    const rootNames = new Set([...config.fileNames, ...productionFiles().map((f) => join(ROOT, f))]);
    cachedProgram = ts.createProgram({
      rootNames: [...rootNames],
      options: { ...config.options, incremental: false, noEmit: true },
    });
  }
  return cachedProgram;
}

/**
 * `table`: names a mailbox-derived table or view. `rpc`: names an RPC that reads
 * mailbox data (legal outside the homes, judged by the surface analysis).
 * `dynamic`: a from/rpc whose name is not a compile-time literal, or is reached
 * around the call rule. `cast`: a forgery of the ActingUser brand.
 */
export type AstHit = { file: string; line: number; what: string; kind: 'table' | 'rpc' | 'dynamic' | 'cast' };

/** Per-file allowances, each with a reason in a fixture JSON next to the tests. */
export type NameAllowances = {
  /** Files whose `.from(x)` / `.rpc(x)` may take a `string`-typed name. */
  nonLiteral?: ReadonlySet<string>;
  /** file -> derived names that file may contain because they are not tables (a notification kind that shares a name). */
  namesOk?: ReadonlyMap<string, ReadonlySet<string>>;
};

function sourceOf(program: ts.Program, file: string): ts.SourceFile {
  const sf = program.getSourceFile(join(ROOT, file));
  if (!sf) throw new Error(`${file} is not in the fence program`);
  return sf;
}

const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** The string literal values a type can take, or null when it is not purely literal (string, any, an object...). */
export function literalValues(type: ts.Type): string[] | null {
  if (type.isStringLiteral()) return [type.value];
  if (type.isUnion()) {
    const all = type.types.map(literalValues);
    return all.every((v) => v !== null) ? all.flat() as string[] : null;
  }
  return null;
}

/** Any string literal in the type's union that names a mailbox-derived table or RPC. */
function derivedIn(type: ts.Type): string[] {
  const values = type.isUnion() ? type.types.flatMap((t) => (t.isStringLiteral() ? [t.value] : [])) : type.isStringLiteral() ? [type.value] : [];
  return values.filter((v) => DERIVED_NAMES.has(v));
}

const FROM_RPC = new Set(['from', 'rpc']);

/**
 * Whether an expression is a value that is passed, stored or returned, the
 * only places a literal name can travel. A callee, the receiver of a member
 * access and a declaration's own name never carry a table name by themselves
 * (the access that yields the name is checked as a whole), and skipping them
 * halves the type queries, which dominate the run time.
 */
function isValuePosition(node: ts.Expression): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isNewExpression(parent) && parent.expression === node) return false;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return false;
  if (ts.isJsxOpeningLikeElement(parent) || ts.isJsxClosingElement(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) return false;
  if (
    (ts.isFunctionLike(parent) ||
      ts.isClassLike(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isParameter(parent) ||
      ts.isLabeledStatement(parent) ||
      ts.isBreakOrContinueStatement(parent)) &&
    (parent as { name?: ts.Node }).name === node
  ) {
    return false;
  }
  // `const x = <expr>`: the initializer is checked as a value on its own.
  if (ts.isVariableDeclaration(parent) && parent.name === node && parent.initializer) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  return true;
}

/** A `from`/`rpc` that belongs to the language or Node (Array.from, Buffer.from), not to a database client. */
function isBuiltinMember(program: ts.Program, checker: ts.TypeChecker, receiverType: ts.Type, name: string): boolean {
  const prop = checker.getPropertyOfType(receiverType, name);
  const decls = prop?.declarations ?? [];
  return (
    decls.length > 0 &&
    decls.every((d) => {
      const f = d.getSourceFile();
      return program.isSourceFileDefaultLibrary(f) || /node_modules\/@types\/node\//.test(f.fileName);
    })
  );
}

/**
 * Where a file names a mailbox-derived table or RPC, or could name one it
 * computes. Flags, by node and type:
 * - any expression whose type is a literal naming one (`'source_items'`,
 *   `TABLE.SOURCE_ITEMS`, `TABLE['SOURCE_ITEMS']`, a destructured or
 *   re-exported constant, a function returning the literal);
 * - a `.from(x)` / `.rpc(x)` (or bare `from(x)`) whose x is not a compile-time
 *   literal (concatenation, a computed name, a `string` parameter), unless the
 *   file is listed in `nonLiteralOk`;
 * - `from`/`rpc` reached indirectly (`const { from } = db`, `db.from.bind`,
 *   `db['from']`, `db[key]`), which would hide the argument from the call rule.
 */
export function mailboxNameHits(file: string, allow: NameAllowances = {}): AstHit[] {
  const program = fenceProgram();
  const checker = program.getTypeChecker();
  const sf = sourceOf(program, file);
  const hits: AstHit[] = [];
  const seen = new Set<string>();
  const nameOk = allow.namesOk?.get(file);
  const nonLiteralOk = allow.nonLiteral?.has(file) ?? false;
  const add = (node: ts.Node, what: string, kind: AstHit['kind'], name?: string) => {
    if (name && nameOk?.has(name)) return;
    const line = lineOf(sf, node);
    if (seen.has(`${line}:${kind}`)) return;
    seen.add(`${line}:${kind}`);
    hits.push({ file, line, what, kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;

    if (ts.isStringLiteralLike(node)) {
      if (DERIVED_NAMES.has(node.text)) add(node, `names mailbox-derived '${node.text}'`, kindOfName(node.text), node.text);
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) &&
      isValuePosition(node)
    ) {
      const names = derivedIn(checker.getTypeAtLocation(node));
      if (names.length) add(node, `expression of type '${names[0]}' (mailbox-derived)`, kindOfName(names[0]), names[0]);
    }

    if (ts.isCallExpression(node)) checkCall(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) checkIndirect(node);
    if (ts.isBindingElement(node)) checkBinding(node);
    ts.forEachChild(node, visit);
  };

  const calleeName = (callee: ts.Expression): { name?: string; receiver?: ts.Expression; computed?: boolean } => {
    if (ts.isPropertyAccessExpression(callee)) return { name: callee.name.text, receiver: callee.expression };
    if (ts.isElementAccessExpression(callee)) {
      const key = callee.argumentExpression;
      return ts.isStringLiteralLike(key)
        ? { name: key.text, receiver: callee.expression }
        : { receiver: callee.expression, computed: true };
    }
    if (ts.isIdentifier(callee)) return { name: callee.text };
    return {};
  };

  function checkCall(node: ts.CallExpression) {
    const { name, receiver, computed } = calleeName(node.expression);
    if (computed && receiver) {
      // db[key](x): only a concern when the receiver has a from or rpc to reach.
      const t = checker.getTypeAtLocation(receiver);
      const reaches = [...FROM_RPC].some((n) => checker.getPropertyOfType(t, n) && !isBuiltinMember(program, checker, t, n));
      if (reaches) add(node, 'computed member call on a database client (from/rpc reachable by a computed key)', 'dynamic');
      return;
    }
    if (!name || !FROM_RPC.has(name)) return;
    if (receiver && isBuiltinMember(program, checker, checker.getTypeAtLocation(receiver), name)) return;
    const arg = node.arguments[0];
    if (!arg || ts.isSpreadElement(arg)) {
      add(node, `.${name}() without a literal name`, 'dynamic');
      return;
    }
    const type = checker.getTypeAtLocation(arg);
    const derived = derivedIn(type);
    if (derived.length) add(arg, `.${name}(${derived[0]}) reaches a mailbox-derived name`, kindOfName(derived[0]), derived[0]);
    else if (literalValues(type) === null && !nonLiteralOk) add(arg, `.${name}() takes a name that is not a compile-time literal`, 'dynamic');
  }

  function checkIndirect(node: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    if (!name || !FROM_RPC.has(name)) return;
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) return; // the call rule judges it
    if (isBuiltinMember(program, checker, checker.getTypeAtLocation(node.expression), name)) return;
    // A data property that happens to be called from (an email's sender) is not a client method.
    const type = checker.getTypeAtLocation(node);
    if (!(type.flags & ts.TypeFlags.Any) && type.getCallSignatures().length === 0) return;
    add(node, `.${name} used without being called (bind, call, alias)`, 'dynamic');
  }

  function checkBinding(node: ts.BindingElement) {
    if (!ts.isObjectBindingPattern(node.parent)) return;
    const key = (node.propertyName ?? node.name) as ts.Node;
    const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
    if (!name || !FROM_RPC.has(name)) return;
    if (isBuiltinMember(program, checker, checker.getTypeAtLocation(node.parent), name)) return;
    if (!(checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any) && checker.getTypeAtLocation(node).getCallSignatures().length === 0) return;
    add(node, `destructured ${name} (hides the name argument from the call rule)`, 'dynamic');
  }

  visit(sf);
  return hits;
}

const BRAND_NAME = /\b(?:ActingUser|ScopedApiUser)\b/;

/**
 * Brand forgery of ActingUser and ScopedApiUser (item 11): `x as ActingUser`,
 * `<ActingUser>x`, `x as unknown as ActingUser`, an alias of either, and the
 * escape casts `as never` / `as any` where the contextual type is the brand.
 * `as never` anywhere else must be a direct call argument (the harmless
 * `list.includes(value as never)` idiom); a stored `as never` value could flow
 * into a brand parameter later, so it is flagged.
 */
export function brandCastHits(file: string): AstHit[] {
  const program = fenceProgram();
  const checker = program.getTypeChecker();
  const sf = sourceOf(program, file);
  const hits: AstHit[] = [];
  const add = (node: ts.Node, what: string) => hits.push({ file, line: lineOf(sf, node), what, kind: 'cast' });
  const involvesBrand = (type: ts.Type | undefined) => !!type && BRAND_NAME.test(checker.typeToString(type));

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (!(ts.isTypeReferenceNode(node.type) && ts.isConstTypeReference(node.type))) {
        const target = checker.getTypeFromTypeNode(node.type);
        if (involvesBrand(target) || BRAND_NAME.test(node.type.getText(sf))) {
          add(node, `cast to ${node.type.getText(sf)} forges the brand`);
        } else if (target.flags & (ts.TypeFlags.Never | ts.TypeFlags.Any)) {
          if (involvesBrand(checker.getContextualType(node))) add(node, `cast to ${node.type.getText(sf)} where the brand is expected`);
          else if (target.flags & ts.TypeFlags.Never) {
            let outer: ts.Node = node;
            while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
            if (!(ts.isCallExpression(outer.parent) && outer.parent.arguments.includes(outer as ts.Expression))) {
              add(node, 'as never outside a call argument (it can flow into a brand parameter)');
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const SERVER_ENTRY_NAME = /^(?:route|page|layout|default|template|not-found|error|global-error|loading|forbidden|unauthorized)\.[cm]?[jt]sx?$/;
const SERVER_ENTRY_METADATA = /^(?:opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$/;
const ROOT_ENTRY = /^(?:src\/)?(?:middleware|proxy|instrumentation)\.[cm]?[jt]sx?$/;

/** Path-based server entry points: every App Router special file, and the middleware/proxy/instrumentation hooks. */
export function isServerEntryPath(file: string): boolean {
  if (ROOT_ENTRY.test(file)) return true;
  if (!file.startsWith('src/app/')) return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  return SERVER_ENTRY_NAME.test(base) || SERVER_ENTRY_METADATA.test(base);
}

/** True when the text has a 'use server' directive at file level or at the top of any function body (inline server action). */
export function hasUseServerDirective(text: string, fileName = 'x.ts'): boolean {
  if (!text.includes('use server')) return false;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const isDirective = (s: ts.Statement) =>
    ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server';
  const prologue = (statements: ts.NodeArray<ts.Statement>) => {
    for (const s of statements) {
      if (!(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression))) return false;
      if (isDirective(s)) return true;
    }
    return false;
  };
  if (prologue(sf.statements)) return true;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body) && prologue(node.body.statements)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export const rel = (abs: string) => relative(ROOT, abs);
