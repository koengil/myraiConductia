// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { FREE_TEXT_KEYS } from '@/lib/url/freeTextKeys';

import allowlistJson from './fixtures/contentEgressGuard/allowlist.json';
import { fenceProgram, literalValues, productionFiles, ROOT } from './helpers/fenceAst';

/**
 * Content egress guard (#331, ADR-0017 O3): free text typed or produced by a
 * user must not ride in a URL, because the URL lands in browser history,
 * Vercel request logs and referrers. The same holds for server logs: an error
 * object, a provider body or a header value in a console line lands in Vercel's
 * log store. This file holds the URL rules (U1, U2) and the log rules (L1, L2).
 * Later phases add the throw and response rules to the same file and the same
 * allowlist.
 *
 *   U1  an app-relative string, template, concatenation or array-literal
 *       .join(sep) containing `?k=` or `&k=` (adjacent literals are read
 *       together, so `'/x?' + 'q='` counts), or a URLSearchParams (by type)
 *       .set / .append / init that carries k (a string init may start with `?`).
 *   U2  URLSearchParams .get(k) / .getAll(k) (by type: searchParams, a
 *       ReadonlyURLSearchParams, `new URL(u).searchParams`) in any production
 *       file. `.has(k)` is allowed: the 400 refusals of `?query=` use it.
 *
 * where k is a FREE_TEXT_KEY (src/lib/url/freeTextKeys.ts), in any case. Both rules are syntactic plus the type checker:
 * `FormData.append('name', file)` is not a hit because FormData is not a
 * URLSearchParams, and only app-relative URLs (starting with `/`) are judged,
 * so a third-party image URL such as `...photo.jpg?q=80` is outside U1. A
 * template that begins with an interpolation (`${base}/x?q=`) has no known
 * prefix and is not judged, unless `base` is a const holding a literal. A
 * fragment (`#q=...`) never leaves the browser and is not a hit: only the part
 * before the first `#` is read, and the fragment is parsed without .get(k).
 *
 *   L1  a log sink argument (a console.* call or a /^log[A-Z]/ helper, as in
 *       L2; #474) that is an error-named identifier (err, error, e,
 *       cause, *Error), a .message / .details / .hint / .stack member, a
 *       .text() / .json() result, an identifier bound (one hop) from any of
 *       those or destructured as one of those members from an error value
 *       (`const { message } = err`), a shorthand property named message /
 *       detail / details / hint, or an object literal, template, conditional
 *       or String(...) / JSON.stringify wrapping any of those. A code is
 *       logged through errorCodeOf(err). `X instanceof OperatorCopyError ?
 *       X.message : <else>` judges only <else>: that message is first-party copy.
 *   L2  a value bound from headers.get(...), searchParams.get(...) or a route
 *       `params` field reaches a log sink without passing through
 *       safeLogId(...). A log sink is a console.* call or a call to a function
 *       named /^log[A-Z]/ (logSeamAuth, logProcessorEvent, ...). "Reaches"
 *       covers the value used directly, inside an object literal or array,
 *       inside a template, and inside JSON.stringify or encodeURIComponent.
 *
 *   L1 and L2 run over src/** and worker/** files with no 'use client'
 *   prologue (scripts/ is CLI output, not Vercel; client files log to the
 *   user's own browser console).
 *
 *   T1  `throw new X(args)` or `throw f(args)` (a thrown error-factory call)
 *       where any argument is, or is a template or concatenation interpolating,
 *       a tainted value: a .message / .details / .hint member, a .text() call
 *       (or an identifier bound from `await ....text()` in the same function),
 *       an identifier or member named checkpoint, internetMessageId, messageId,
 *       folderName or fileName (case-insensitive), or a headers.get(...) call.
 *   T2  `throw x` where x is bound in the same function by destructuring
 *       `{ error }` (or `{ error: name }`) from an awaited call: a raw
 *       Supabase / PostgREST error rethrown, whose message and details Next
 *       prints on an uncaught throw.
 *   R1  a response sink (jsonError(arg), conductiaError(_, arg),
 *       NextResponse.json(arg), new Response(arg)) that receives, directly or
 *       inside an object literal or template, a .text() call or an identifier
 *       bound from `await ....text()` in the same function: a provider body
 *       passed through to a caller.
 *
 *   T1, T2 and R1 run over src/** and worker/** files with no 'use client'
 *   prologue (a client component's throw lands in the user's own browser).
 *   Direct `jsonError(error.message)`
 *   over a PostgREST error is out of scope (thread T2): the caller made the
 *   request, and no log store keeps it.
 *
 *   T1 also flags `new OperatorCopyError(arg)` (anywhere, not only in a throw)
 *   unless arg is provably fixed copy: string or number literals, templates
 *   and `+` chains of those, or a const bound to one. The L1 exemption for
 *   `X instanceof OperatorCopyError ? X.message : <else>` holds only for the
 *   class imported from src/lib/errors/upstream.ts. Hits are kept per AST
 *   node, so two identical sinks on one line are two sites.
 *
 * Known limits. L1 is name-based: an error held under another name is not
 * traced (`const summary = String(err); console.error(summary)` passes, as
 * does an error passed through a function before it is logged). U1 reads
 * literals, templates, `+` chains, array-literal .join and one-hop const
 * literals; it does not trace String.prototype.concat, a non-literal array, or
 * a prefix built in another function.
 *
 * Like the other fences this stops accidental and casual additions; it is not
 * data-flow analysis. Entries in fixtures/contentEgressGuard/allowlist.json
 * need { file, rule, match, reason }: `match` is a substring of the hit's
 * description, and the entry must anchor exactly one site, so a second site in
 * an allowlisted file fails the run. A stale entry fails the run.
 */

export { FREE_TEXT_KEYS };

export type EgressRule = 'U1' | 'U2' | 'L1' | 'L2' | 'T1' | 'T2' | 'R1';
export type EgressHit = { file: string; line: number; rule: EgressRule; what: string };

const KEY_ALTERNATION = [...FREE_TEXT_KEYS].join('|');
const QUERY_KEY = new RegExp(`[?&](${KEY_ALTERNATION})=`, 'gi');
// URLSearchParams drops one leading `?` from a string init, so `?q=` is as bare as `q=`.
const BARE_KEY = new RegExp(`(?:^\\??|&)(${KEY_ALTERNATION})=`, 'i');
const isFreeTextKey = (key: string) => FREE_TEXT_KEYS.has(key.toLowerCase());
// Stands for a non-literal operand when the literal pieces are joined, so `'?a=' + x + 'q='` never reads as `?a=q=`.
const GAP = '\u0000';
const URL_PARAMS_TYPES = new Set(['URLSearchParams', 'ReadonlyURLSearchParams']);

const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** URLSearchParams itself, Next's ReadonlyURLSearchParams, or anything that extends one of them. */
function isUrlSearchParams(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (depth > 4) return false;
  const name = type.getSymbol()?.getName();
  if (name && URL_PARAMS_TYPES.has(name)) return true;
  if (type.isUnion()) return type.types.some((t) => isUrlSearchParams(checker, t, depth + 1));
  const bases = type.isClassOrInterface() ? checker.getBaseTypes(type) : [];
  return bases.some((b) => isUrlSearchParams(checker, b, depth + 1));
}

/** The free-text keys a key expression can take (a literal, or a const that resolves to literals). */
function freeTextKeysOf(checker: ts.TypeChecker, key: ts.Expression | undefined): string[] {
  if (!key || ts.isSpreadElement(key)) return [];
  const values = literalValues(checker.getTypeAtLocation(key));
  return (values ?? []).filter(isFreeTextKey);
}

type StringParts = { joined: string; appRelative: boolean };

/** The string a `const x = '<literal>'` holds, one hop, or null. */
function constLiteralText(checker: ts.TypeChecker, id: ts.Identifier): string | null {
  const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return null;
  if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
  return ts.isStringLiteralLike(decl.initializer) ? decl.initializer.text : null;
}

/**
 * True when the expression is fixed text written in the source: a string or number literal, a template or `+`
 * chain of those, or a const bound (one hop) to one.
 */
function provablyLiteral(checker: ts.TypeChecker, node: ts.Expression, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const next = (n: ts.Expression) => provablyLiteral(checker, n, depth + 1);
  if (ts.isParenthesizedExpression(node)) return next(node.expression);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true;
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => next(span.expression));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return next(node.left) && next(node.right);
  if (ts.isIdentifier(node)) {
    const decl = checker.getSymbolAtLocation(node)?.valueDeclaration;
    return (
      !!decl &&
      ts.isVariableDeclaration(decl) &&
      !!decl.initializer &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
      depth < 2 &&
      next(decl.initializer)
    );
  }
  return false;
}

/**
 * The literal text of a string literal, template or `+` chain, adjacent literals joined (so `'/x?' + 'q='` reads
 * `/x?q=`) and each non-literal operand or interpolation standing as GAP, and whether the whole starts with `/`.
 */
function stringParts(checker: ts.TypeChecker, node: ts.Expression): StringParts | null {
  let joined = '';
  let first: string | null | undefined;
  const take = (n: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(n)) return take(n.expression);
    // A const holding a literal reads as that literal: `const base = '/api/v1/search?'; base + 'q=' + x`.
    const text = ts.isStringLiteralLike(n) ? n.text : ts.isIdentifier(n) ? constLiteralText(checker, n) : null;
    if (text !== null) {
      joined += text;
      if (first === undefined) first = text;
      return true;
    }
    if (ts.isTemplateExpression(n)) {
      joined += [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(GAP);
      if (first === undefined) first = n.head.text;
      return true;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = take(n.left);
      const right = take(n.right);
      return left || right;
    }
    joined += GAP;
    if (first === undefined) first = null; // starts with a non-literal: no known prefix
    return false;
  };
  if (!take(node)) return null;
  return { joined, appRelative: typeof first === 'string' && first.startsWith('/') };
}

/**
 * `[a, b, c].join(sep)` over an array literal: the same shape as stringParts, the separator between elements.
 * Null unless the separator is a literal (or absent) and some element is a literal.
 */
function joinParts(checker: ts.TypeChecker, call: ts.CallExpression): StringParts | null {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'join') return null;
  const array = call.expression.expression;
  if (!ts.isArrayLiteralExpression(array) || array.elements.length === 0) return null;
  const sepArg = call.arguments[0];
  if (sepArg && !ts.isStringLiteralLike(sepArg)) return null;
  const sep = sepArg ? sepArg.text : ',';
  const pieces = array.elements.map((el) => (ts.isExpression(el) ? stringParts(checker, el) : null));
  if (!pieces.some(Boolean)) return null;
  return {
    joined: pieces.map((p) => p?.joined ?? GAP).join(sep),
    appRelative: pieces[0]?.appRelative ?? false,
  };
}

const isPlusChain = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** The U1 and U2 sites of one source file. */
export function urlRuleHits(program: ts.Program, sf: ts.SourceFile, file: string): EgressHit[] {
  const checker = program.getTypeChecker();
  const hits: EgressHit[] = [];
  const seen = new Set<string>();
  const add = (node: ts.Node, rule: EgressRule, what: string) => {
    const line = lineOf(sf, node);
    const id = `${node.getStart(sf)}:${rule}:${what}`; // per node: two identical sinks on one line are two sites
    if (seen.has(id)) return;
    seen.add(id);
    hits.push({ file, line, rule, what });
  };

  const checkString = (node: ts.Expression, s: StringParts | null = stringParts(checker, node)) => {
    if (!s || !s.appRelative) return;
    // A fragment never leaves the browser: only the part before the first `#` is a URL query.
    const beforeFragment = s.joined.split('#')[0];
    for (const m of beforeFragment.matchAll(QUERY_KEY)) add(node, 'U1', `app URL carries free text in ?${m[1].toLowerCase()}=`);
  };

  const checkInit = (init: ts.Expression) => {
    if (ts.isParenthesizedExpression(init)) return checkInit(init.expression);
    if (ts.isObjectLiteralExpression(init)) {
      for (const prop of init.properties) {
        const name = prop.name;
        const key =
          name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
            ? name.text
            : name && ts.isComputedPropertyName(name)
              ? freeTextKeysOf(checker, name.expression)[0]
              : undefined;
        if (key && isFreeTextKey(key)) add(prop, 'U1', `URLSearchParams init carries '${key}'`);
      }
    } else if (ts.isArrayLiteralExpression(init)) {
      for (const pair of init.elements) {
        if (ts.isArrayLiteralExpression(pair)) {
          const k = freeTextKeysOf(checker, pair.elements[0]);
          if (k.length) add(pair, 'U1', `URLSearchParams init carries '${k[0]}'`);
        }
      }
    } else {
      const s = stringParts(checker, init);
      if (s && BARE_KEY.test(s.joined)) add(init, 'U1', 'URLSearchParams string init carries free text');
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;

    // U1, strings. A `+` chain is judged as a whole from its top node; a literal inside one is not judged alone.
    const insideChain = node.parent && isPlusChain(node.parent);
    if (
      !insideChain &&
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || isPlusChain(node)) &&
      !(ts.isStringLiteralLike(node) && ts.isLiteralTypeNode(node.parent))
    ) {
      checkString(node as ts.Expression);
    }

    if (ts.isCallExpression(node)) {
      const joined = joinParts(checker, node);
      if (joined) checkString(node, joined);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['set', 'append', 'get', 'getAll'].includes(method)) {
        const receiver = checker.getTypeAtLocation(node.expression.expression);
        if (isUrlSearchParams(checker, receiver)) {
          const keys = freeTextKeysOf(checker, node.arguments[0]);
          if (keys.length) {
            if (method === 'set' || method === 'append') add(node, 'U1', `URLSearchParams.${method}('${keys[0]}')`);
            else add(node, 'U2', `URLSearchParams.${method}('${keys[0]}')`);
          }
        }
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URLSearchParams') {
      const init = node.arguments?.[0];
      if (init) checkInit(init);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

// ---------------------------------------------------------------------------
// L1 and L2: server logs carry codes and ids only.
// ---------------------------------------------------------------------------

const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);
const ERROR_NAME = /^(?:err|error|e|cause|[A-Za-z0-9_$]*Error)$/;
const ERROR_MEMBERS = new Set(['message', 'details', 'hint', 'stack']);
// A shorthand property with one of these names logs error text whatever it was bound from: `{ code, message }`.
const ERROR_TEXT_KEYS = new Set(['message', 'detail', 'details', 'hint']);
// The class whose message is first-party copy (src/lib/errors/upstream.ts): `e instanceof OperatorCopyError ? e.message : …`.
const OPERATOR_COPY_ERROR = 'OperatorCopyError';
const UPSTREAM_MODULE = '@/lib/errors/upstream';
const BODY_METHODS = new Set(['text', 'json']);
const LOG_HELPER_NAME = /^log[A-Z]/;
const STRING_METHODS = new Set([
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'slice', 'substring', 'substr',
  'replace', 'replaceAll', 'normalize', 'toString', 'split', 'at', 'concat', 'padStart', 'padEnd',
]);
const HEADER_OR_QUERY_TYPES = new Set(['Headers', 'ReadonlyHeaders', 'URLSearchParams', 'ReadonlyURLSearchParams']);
const SAFE_LOG_ID = 'safeLogId';
const MAX_DEPTH = 6;

type Wrapper = ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.AwaitExpression | ts.TypeAssertion | ts.SatisfiesExpression;
const isWrapper = (n: ts.Node): n is Wrapper =>
  ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isAwaitExpression(n) ||
  ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n);

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

const isConsoleCall = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === 'console' &&
  CONSOLE_METHODS.has(call.expression.name.text);

/** True for the whole-value wrappers a log argument is typically passed through: String(x), x.toString(), JSON.stringify(x), inspect(x). */
const isStringifier = (call: ts.CallExpression): boolean => {
  const name = calleeName(call);
  return name === 'String' || name === 'stringify' || name === 'inspect' || name === 'toString';
};

/** The declaration initializer of an identifier, when it is a plain `const x = <init>`. */
function initializerOf(checker: ts.TypeChecker, id: ts.Identifier): ts.Expression | null {
  const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
  return decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer ? decl.initializer : null;
}

/** `await res.text()`, `res.json()`, `res.text().catch(() => '')`: the response body read, or null. */
function bodyRead(node: ts.Node, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  if (isWrapper(node)) return bodyRead(node.expression, depth + 1);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    if (BODY_METHODS.has(name)) return `.${name}() result`;
    if (name === 'catch' || name === 'then' || name === 'finally') return bodyRead(node.expression.expression, depth + 1);
  }
  return null;
}

/**
 * True when `id` names the OperatorCopyError imported from src/lib/errors/upstream.ts (under any local name). A
 * local class of the same name is not it.
 */
function isUpstreamOperatorCopyError(checker: ts.TypeChecker, id: ts.Identifier): boolean {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (!decl || !ts.isImportSpecifier(decl)) return false;
  const from = decl.parent.parent.parent.moduleSpecifier;
  return (
    (decl.propertyName ?? decl.name).text === OPERATOR_COPY_ERROR &&
    ts.isStringLiteral(from) &&
    (from.text === UPSTREAM_MODULE || (from.text.startsWith('.') && /(?:^|\/)errors\/upstream$/.test(from.text)))
  );
}

/** `X instanceof OperatorCopyError ? X.message : <else>`: the true branch is first-party copy, so only <else> is judged. */
function operatorCopyElse(checker: ts.TypeChecker, node: ts.ConditionalExpression): ts.Expression | null {
  let cond: ts.Expression = node.condition;
  while (isWrapper(cond)) cond = cond.expression;
  if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return null;
  if (!ts.isIdentifier(cond.left) || !ts.isIdentifier(cond.right) || !isUpstreamOperatorCopyError(checker, cond.right)) return null;
  let whenTrue: ts.Expression = node.whenTrue;
  while (isWrapper(whenTrue)) whenTrue = whenTrue.expression;
  const copy =
    ts.isPropertyAccessExpression(whenTrue) &&
    whenTrue.name.text === 'message' &&
    ts.isIdentifier(whenTrue.expression) &&
    whenTrue.expression.text === cond.left.text;
  return copy ? node.whenFalse : null;
}

/** `const { message } = err`: a name destructured as an error member from an error-bearing value. */
function destructuredErrorText(checker: ts.TypeChecker, id: ts.Identifier, depth: number): string | null {
  const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
  if (!decl || !ts.isBindingElement(decl) || !ts.isObjectBindingPattern(decl.parent)) return null;
  const key = decl.propertyName ?? decl.name;
  if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) || !ERROR_MEMBERS.has(key.text)) return null;
  const root = decl.parent.parent;
  if (!ts.isVariableDeclaration(root) || !root.initializer) return null;
  const from = errorBearing(checker, root.initializer, depth + 1);
  return from ? `'${id.text}' destructured as .${key.text} from ${from}` : null;
}

/** `{ m }` where `const m = err.message` (or another error-bearing initializer): the shorthand's value, one hop. */
function shorthandBound(checker: ts.TypeChecker, prop: ts.ShorthandPropertyAssignment, depth: number): string | null {
  const decl = checker.getShorthandAssignmentValueSymbol(prop)?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
  const from = decl.initializer ? (bodyRead(decl.initializer) ?? errorBearing(checker, decl.initializer, depth + 1)) : null;
  return from ? `'${prop.name.text}' bound from ${from}` : null;
}

/** `{ message }` where `const message = 'fixed copy'`: provably first-party text. */
function shorthandIsLiteral(checker: ts.TypeChecker, prop: ts.ShorthandPropertyAssignment): boolean {
  const decl = checker.getShorthandAssignmentValueSymbol(prop)?.valueDeclaration;
  return (
    !!decl &&
    ts.isVariableDeclaration(decl) &&
    !!decl.initializer &&
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
    provablyLiteral(checker, decl.initializer)
  );
}

/** L1: what makes this expression carry an error, a message or a provider body. Null when it carries none. */
function errorBearing(checker: ts.TypeChecker, node: ts.Node, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  const next = (n: ts.Node) => errorBearing(checker, n, depth + 1);
  if (isWrapper(node)) return next(node.expression);
  if (ts.isIdentifier(node)) {
    if (ERROR_NAME.test(node.text)) return `error value '${node.text}'`;
    const init = initializerOf(checker, node);
    // One hop through `const m = <init>`: a body read, an error member (`const m = err.message`) or anything else
    // error-bearing.
    const bound = init ? (bodyRead(init) ?? next(init)) : null;
    if (bound) return `'${node.text}' bound from ${bound}`;
    return destructuredErrorText(checker, node, depth);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const name = node.name.text;
    return ERROR_MEMBERS.has(name) ? `.${name}` : null;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return ERROR_MEMBERS.has(node.argumentExpression.text) ? `.${node.argumentExpression.text}` : null;
  }
  if (ts.isCallExpression(node)) {
    const body = bodyRead(node);
    if (body) return body;
    if (ts.isPropertyAccessExpression(node.expression) && STRING_METHODS.has(node.expression.name.text)) {
      const viaReceiver = next(node.expression.expression);
      if (viaReceiver) return viaReceiver;
    }
    if (isStringifier(node)) {
      for (const arg of node.arguments) {
        const hit = next(arg);
        if (hit) return hit;
      }
      if (ts.isPropertyAccessExpression(node.expression)) return next(node.expression.expression);
    }
    return null;
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const hit = next(span.expression);
      if (hit) return hit;
    }
    return null;
  }
  if (ts.isBinaryExpression(node)) return next(node.left) ?? next(node.right);
  if (ts.isConditionalExpression(node)) {
    const otherwise = operatorCopyElse(checker, node);
    if (otherwise) return next(otherwise);
    return next(node.whenTrue) ?? next(node.whenFalse);
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      const hit = next(el);
      if (hit) return hit;
    }
    return null;
  }
  if (ts.isSpreadElement(node)) return next(node.expression);
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      let hit: string | null = null;
      if (ts.isPropertyAssignment(prop)) hit = next(prop.initializer);
      else if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text;
        hit = ERROR_NAME.test(name)
          ? `error value '${name}'`
          : ERROR_TEXT_KEYS.has(name)
            ? shorthandIsLiteral(checker, prop)
              ? null
              : `error text '${name}'`
            : shorthandBound(checker, prop, depth);
      }
      else if (ts.isSpreadAssignment(prop)) hit = next(prop.expression);
      if (hit) return `object property carrying ${hit}`;
    }
    return null;
  }
  return null;
}

/** The root declaration of a destructured binding, and whether any name on the way is `params`. */
function bindingRoot(decl: ts.Node): { root: ts.Node; viaParams: boolean } {
  let viaParams = false;
  let n: ts.Node = decl;
  while (ts.isBindingElement(n)) {
    const key = n.propertyName ?? n.name;
    if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'params') viaParams = true;
    n = n.parent.parent; // ObjectBindingPattern | ArrayBindingPattern -> BindingElement | VariableDeclaration | Parameter
  }
  return { root: n, viaParams };
}

/** L2: where this expression takes a value a caller chose (a header, a query parameter, a route param). Null when it does not. */
function untrustedSource(checker: ts.TypeChecker, node: ts.Node, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  const next = (n: ts.Node) => untrustedSource(checker, n, depth + 1);
  if (isWrapper(node)) return next(node.expression);
  if (ts.isIdentifier(node)) {
    if (node.text === 'params') return `route params '${node.text}'`;
    const decl = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (!decl) return null;
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      const src = decl.initializer ? next(decl.initializer) : null;
      return src && `'${node.text}' bound from ${src}`;
    }
    if (ts.isBindingElement(decl)) {
      const { root, viaParams } = bindingRoot(decl);
      if (viaParams) return `'${node.text}' destructured from route params`;
      if (ts.isVariableDeclaration(root) && root.initializer) {
        const src = next(root.initializer);
        return src && `'${node.text}' bound from ${src}`;
      }
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === 'params') return 'route params';
    if (node.name.text === 'length') return null;
    return next(node.expression);
  }
  if (ts.isElementAccessExpression(node)) return next(node.expression);
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name === SAFE_LOG_ID) return null;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      if (name === 'get' || name === 'getAll') {
        const typeName = checker.getTypeAtLocation(receiver).getSymbol()?.getName();
        const textual = /(?:^|\.)(?:headers|searchParams)$/i.test(receiver.getText());
        if ((typeName && HEADER_OR_QUERY_TYPES.has(typeName)) || textual) return `${receiver.getText()}.${name}(...)`;
        return null;
      }
      if (name && STRING_METHODS.has(name)) return next(receiver);
    }
    if (name === 'stringify' || name === 'String' || name === 'decodeURIComponent' || name === 'encodeURIComponent' || name === 'encodeURI') {
      for (const arg of node.arguments) {
        const hit = next(arg);
        if (hit) return hit;
      }
    }
    return null;
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const hit = next(span.expression);
      if (hit) return hit;
    }
    return null;
  }
  if (ts.isBinaryExpression(node)) return next(node.left) ?? next(node.right);
  if (ts.isConditionalExpression(node)) return next(node.whenTrue) ?? next(node.whenFalse);
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      const hit = next(el);
      if (hit) return hit;
    }
    return null;
  }
  if (ts.isSpreadElement(node)) return next(node.expression);
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      let hit: string | null = null;
      if (ts.isPropertyAssignment(prop)) hit = next(prop.initializer);
      else if (ts.isShorthandPropertyAssignment(prop)) {
        const sym = checker.getShorthandAssignmentValueSymbol(prop);
        const decl = sym?.valueDeclaration;
        if (prop.name.text === 'params') hit = `route params '${prop.name.text}'`;
        else if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          const src = next(decl.initializer);
          hit = src && `'${prop.name.text}' bound from ${src}`;
        } else if (decl && ts.isBindingElement(decl)) {
          const { root, viaParams } = bindingRoot(decl);
          if (viaParams) hit = `'${prop.name.text}' destructured from route params`;
          else if (ts.isVariableDeclaration(root) && root.initializer) {
            const src = next(root.initializer);
            hit = src && `'${prop.name.text}' bound from ${src}`;
          }
        }
      } else if (ts.isSpreadAssignment(prop)) hit = next(prop.expression);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

/** The L1 and L2 sites of one source file. */
export function logRuleHits(program: ts.Program, sf: ts.SourceFile, file: string): EgressHit[] {
  const checker = program.getTypeChecker();
  const hits: EgressHit[] = [];
  const seen = new Set<string>();
  const add = (node: ts.Node, rule: EgressRule, what: string) => {
    const line = lineOf(sf, node);
    const id = `${node.getStart(sf)}:${rule}:${what}`; // per node: two identical sinks on one line are two sites
    if (seen.has(id)) return;
    seen.add(id);
    hits.push({ file, line, rule, what });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (ts.isCallExpression(node)) {
      const consoleCall = isConsoleCall(node);
      const name = calleeName(node);
      const helperCall = !consoleCall && name !== null && LOG_HELPER_NAME.test(name);
      if (consoleCall || helperCall) {
        for (const arg of node.arguments) {
          // L1 judges every log sink (#474): logServerEvent({ err }) is as much a leak as console.error(err).
          const bearing = errorBearing(checker, arg);
          if (bearing) {
            const sink = consoleCall ? `console.${(node.expression as ts.PropertyAccessExpression).name.text}` : name;
            add(arg, 'L1', `${sink} logs ${bearing}`);
          }
          const source = untrustedSource(checker, arg);
          if (source) add(arg, 'L2', `${consoleCall ? 'console' : name} logs ${source} without safeLogId`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

// ---------------------------------------------------------------------------
// T1, T2 and R1: thrown messages and responses carry codes, never provider or database text.
// ---------------------------------------------------------------------------

const THROW_TAINT_MEMBERS = new Set(['message', 'details', 'hint']);
const THROW_TAINT_NAME = /^(?:checkpoint|internetmessageid|messageid|foldername|filename)$/i;
const RESPONSE_SINK_FUNCTIONS = new Set(['jsonError', 'conductiaError']);

/** `await res.text()`, `res.text().catch(() => '')`: a response body read as text, or null. */
function textRead(node: ts.Node, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  if (isWrapper(node)) return textRead(node.expression, depth + 1);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    if (name === 'text') return '.text() result';
    if (name === 'catch' || name === 'then' || name === 'finally') return textRead(node.expression.expression, depth + 1);
  }
  return null;
}

/** Calls that pass their argument through into the string they return. */
const isPassThrough = (call: ts.CallExpression): boolean => {
  const name = calleeName(call);
  return name !== null && (isStringifier(call) || name === 'encodeURIComponent' || name === 'decodeURIComponent');
};

/**
 * Generic walk shared by T1 and R1: descends through wrappers, templates, `+`
 * and `??` chains, conditionals, arrays, spreads, string methods, stringifiers
 * and object literals, and asks `leaf` about every identifier, member access and
 * call it reaches. `leaf` returns a reason or null.
 */
function reaches(
  checker: ts.TypeChecker,
  node: ts.Node,
  leaf: (n: ts.Node) => string | null,
  depth = 0,
): string | null {
  if (depth > MAX_DEPTH) return null;
  const next = (n: ts.Node) => reaches(checker, n, leaf, depth + 1);
  if (isWrapper(node)) return next(node.expression);
  const here = leaf(node);
  if (here) return here;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return null;
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression) && STRING_METHODS.has(node.expression.name.text)) {
      const viaReceiver = next(node.expression.expression);
      if (viaReceiver) return viaReceiver;
    }
    if (isPassThrough(node)) {
      for (const arg of node.arguments) {
        const hit = next(arg);
        if (hit) return hit;
      }
      if (ts.isPropertyAccessExpression(node.expression)) return next(node.expression.expression);
    }
    return null;
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const hit = next(span.expression);
      if (hit) return hit;
    }
    return null;
  }
  if (ts.isBinaryExpression(node)) return next(node.left) ?? next(node.right);
  if (ts.isConditionalExpression(node)) return next(node.whenTrue) ?? next(node.whenFalse);
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      const hit = next(el);
      if (hit) return hit;
    }
    return null;
  }
  if (ts.isSpreadElement(node)) return next(node.expression);
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      let hit: string | null = null;
      if (ts.isPropertyAssignment(prop)) hit = next(prop.initializer);
      else if (ts.isShorthandPropertyAssignment(prop)) hit = leaf(prop.name);
      else if (ts.isSpreadAssignment(prop)) hit = next(prop.expression);
      if (hit) return `object property carrying ${hit}`;
    }
    return null;
  }
  return null;
}

/** T1: a value that carries a database message, a provider body or a user-named source in a thrown message. */
function throwTaint(checker: ts.TypeChecker, node: ts.Node, depth = 0): string | null {
  return reaches(checker, node, (n) => {
    if (ts.isIdentifier(n)) {
      if (THROW_TAINT_NAME.test(n.text)) return `'${n.text}'`;
      const init = initializerOf(checker, n);
      if (!init) return null;
      // One hop: `const message = err instanceof Error ? err.message : '...'; throw new Error(message)`.
      const via = textRead(init) ?? (depth < 1 ? throwTaint(checker, init, depth + 1) : null);
      return via ? `'${n.text}' bound from ${via}` : null;
    }
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      if (THROW_TAINT_MEMBERS.has(name)) return `.${name}`;
      if (THROW_TAINT_NAME.test(name)) return `.${name}`;
      return null;
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      const name = n.argumentExpression.text;
      return THROW_TAINT_MEMBERS.has(name) || THROW_TAINT_NAME.test(name) ? `.${name}` : null;
    }
    if (ts.isCallExpression(n)) {
      const body = textRead(n);
      if (body) return body;
      // String(err): the error's own text, stringified into the message.
      if (calleeName(n) === 'String' && n.arguments.length === 1) {
        const arg = n.arguments[0];
        if (ts.isIdentifier(arg) && ERROR_NAME.test(arg.text)) return `String(${arg.text})`;
      }
      if (calleeName(n) === 'get' && ts.isPropertyAccessExpression(n.expression) && /(?:^|\.)headers$/i.test(n.expression.expression.getText())) {
        return 'headers.get(...)';
      }
    }
    return null;
  });
}

/** R1: a response body read as text, passed through to a response. */
function bodyPassthrough(checker: ts.TypeChecker, node: ts.Node): string | null {
  return reaches(checker, node, (n) => {
    if (ts.isIdentifier(n)) {
      const init = initializerOf(checker, n);
      const body = init ? textRead(init) : null;
      return body ? `'${n.text}' bound from ${body}` : null;
    }
    return ts.isCallExpression(n) ? textRead(n) : null;
  });
}

/** `const { error } = await ...` or `{ error: name }`: the identifier is a raw Supabase / PostgREST error. */
function isRawErrorBinding(checker: ts.TypeChecker, id: ts.Identifier): boolean {
  const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
  if (!decl || !ts.isBindingElement(decl) || !ts.isObjectBindingPattern(decl.parent)) return false;
  const key = decl.propertyName ?? decl.name;
  if (!((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'error')) return false;
  const root = decl.parent.parent;
  if (!ts.isVariableDeclaration(root) || !root.initializer) return false;
  let init: ts.Node = root.initializer;
  while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isNonNullExpression(init)) init = init.expression;
  return ts.isAwaitExpression(init);
}

/** The T1, T2 and R1 sites of one source file. */
export function throwRuleHits(program: ts.Program, sf: ts.SourceFile, file: string): EgressHit[] {
  const checker = program.getTypeChecker();
  const hits: EgressHit[] = [];
  const seen = new Set<string>();
  const add = (node: ts.Node, rule: EgressRule, what: string) => {
    const line = lineOf(sf, node);
    const id = `${node.getStart(sf)}:${rule}:${what}`; // per node: two identical sinks on one line are two sites
    if (seen.has(id)) return;
    seen.add(id);
    hits.push({ file, line, rule, what });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;

    if (ts.isThrowStatement(node) && node.expression) {
      let thrown: ts.Node = node.expression;
      while (isWrapper(thrown)) thrown = thrown.expression;
      if (ts.isNewExpression(thrown) || ts.isCallExpression(thrown)) {
        const callee = ts.isNewExpression(thrown) ? `new ${thrown.expression.getText()}` : thrown.expression.getText();
        for (const arg of thrown.arguments ?? []) {
          const taint = throwTaint(checker, arg);
          if (taint) {
            add(arg, 'T1', `throw ${callee}(...) carries ${taint}`);
            break;
          }
        }
      } else if (ts.isIdentifier(thrown) && isRawErrorBinding(checker, thrown)) {
        add(thrown, 'T2', `throw ${thrown.text}: a raw PostgREST error rethrown (throw dbFailure(step, ${thrown.text}))`);
      }
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const isJsonSink =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'json' &&
        node.expression.expression.getText() === 'NextResponse';
      if (name && (RESPONSE_SINK_FUNCTIONS.has(name) || isJsonSink)) {
        for (const arg of node.arguments) {
          const body = bodyPassthrough(checker, arg);
          if (body) add(arg, 'R1', `${isJsonSink ? 'NextResponse.json' : name} passes a provider body through (${body})`);
        }
      }
    }
    // OperatorCopyError's message is logged and shown as is, so it must be fixed copy written here.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === OPERATOR_COPY_ERROR || isUpstreamOperatorCopyError(checker, node.expression))
    ) {
      for (const arg of node.arguments ?? []) {
        if (!provablyLiteral(checker, arg)) {
          const source = arg.getText(sf).replace(/\s+/g, ' ').slice(0, 80);
          add(arg, 'T1', `new OperatorCopyError(...) is not fixed copy: ${source}`);
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Response') {
      for (const arg of node.arguments ?? []) {
        const body = bodyPassthrough(checker, arg);
        if (body) add(arg, 'R1', `new Response passes a provider body through (${body})`);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** 'use client' in the directive prologue: the file runs in the user's browser, so its console is theirs. */
export function hasUseClientPrologue(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!(ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression))) return false;
    if (stmt.expression.text === 'use client') return true;
  }
  return false;
}

/** Server-side production files: src/** and worker/**, excluding client components. */
export const isLogRuleFile = (file: string) => file.startsWith('src/') || file.startsWith('worker/');

/** One in-memory program over inline snippets (DOM lib, no node types), for the detector self-tests. */
export function probeProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2017,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const virtual = new Map(Object.entries(files).map(([name, text]) => [join('/probe', name), text]));
  const real = { getSourceFile: host.getSourceFile.bind(host), fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host) };
  host.fileExists = (f) => virtual.has(f) || real.fileExists(f);
  host.readFile = (f) => virtual.get(f) ?? real.readFile(f);
  host.getSourceFile = (f, lang, onError, shouldCreate) =>
    virtual.has(f)
      ? ts.createSourceFile(f, virtual.get(f) as string, lang, true)
      : real.getSourceFile(f, lang, onError, shouldCreate);
  return ts.createProgram({ rootNames: [...virtual.keys()], options, host });
}

export function probeHits(program: ts.Program, name: string): EgressHit[] {
  const sf = program.getSourceFile(join('/probe', name));
  if (!sf) throw new Error(`${name} is not in the probe program`);
  return urlRuleHits(program, sf, name);
}

export function probeLogHits(program: ts.Program, name: string): EgressHit[] {
  const sf = program.getSourceFile(join('/probe', name));
  if (!sf) throw new Error(`${name} is not in the probe program`);
  return logRuleHits(program, sf, name);
}

export function probeThrowHits(program: ts.Program, name: string): EgressHit[] {
  const sf = program.getSourceFile(join('/probe', name));
  if (!sf) throw new Error(`${name} is not in the probe program`);
  return throwRuleHits(program, sf, name);
}

export type Allow = { file: string; rule: string; match: string; reason: string };
const ALLOW = allowlistJson as Allow[];

/**
 * An entry exempts one known site: same file and rule, and `match` is a substring of the hit's `what`. An entry
 * with no anchor, or one that anchors no hit (stale) or more than one hit (a second site), is a problem, so a new
 * site in an allowlisted file fails the run either as an offender or as a problem.
 */
export function applyAllowlist(hits: EgressHit[], allow: Allow[]): { offenders: EgressHit[]; problems: string[] } {
  const anchors = (a: Allow, h: EgressHit) =>
    a.file === h.file && a.rule === h.rule && typeof a.match === 'string' && a.match.length > 0 && h.what.includes(a.match);
  const problems: string[] = [];
  for (const a of allow) {
    const label = `${a.file} ${a.rule} '${a.match ?? ''}'`;
    if (typeof a.match !== 'string' || a.match.length === 0) {
      problems.push(`allowlist entry without a match anchor: ${label}`);
      continue;
    }
    const n = hits.filter((h) => anchors(a, h)).length;
    if (n === 0) problems.push(`stale allowlist entry: ${label}`);
    if (n > 1) problems.push(`allowlist entry anchors ${n} sites, not one: ${label}`);
  }
  return { offenders: hits.filter((h) => !allow.some((a) => anchors(a, h))), problems };
}

const SLOW = 120_000;

describe('content egress guard: detector self-tests (U1, U2)', () => {
  // Each snippet must be reported. The `rule` is the rule the snippet exercises.
  const POSITIVE: Array<{ name: string; rule: EgressRule; code: string }> = [
    { name: 'concat.ts', rule: 'U1', code: `declare const t: string; export const r = fetch('/api/v1/x?query=' + t);` },
    { name: 'concat-late.ts', rule: 'U1', code: `declare const t: string; export const r = fetch('/api/v1/x?a=1' + '&q=' + t);` },
    { name: 'template.ts', rule: 'U1', code: 'declare const id: string, t: string; export const r = `/projects/${id}/chat?q=${encodeURIComponent(t)}`;' },
    { name: 'init-shorthand.ts', rule: 'U1', code: `declare const person: string; export const p = new URLSearchParams({ person });` },
    { name: 'init-property.ts', rule: 'U1', code: `declare const x: string, p: string; export const u = new URLSearchParams({ executionId: x, path: p });` },
    { name: 'init-pairs.ts', rule: 'U1', code: `declare const n: string; export const u = new URLSearchParams([['name', n]]);` },
    { name: 'init-string.ts', rule: 'U1', code: `declare const t: string; export const u = new URLSearchParams('q=' + t);` },
    { name: 'set.ts', rule: 'U1', code: `declare const n: string; const p = new URLSearchParams(); p.set('person', n); export default p;` },
    { name: 'append.ts', rule: 'U1', code: `declare const u: URL, n: string; u.searchParams.append('q', n);` },
    { name: 'get.ts', rule: 'U2', code: `declare const searchParams: URLSearchParams; export const q = searchParams.get('q');` },
    { name: 'get-url.ts', rule: 'U2', code: `declare const raw: string; export const p = new URL(raw).searchParams.get('path');` },
    { name: 'get-all.ts', rule: 'U2', code: `declare const searchParams: URLSearchParams; export const q = searchParams.getAll('person');` },
    { name: 'get-const.ts', rule: 'U2', code: `declare const searchParams: URLSearchParams; const KEY = 'query'; export const q = searchParams.get(KEY);` },
    { name: 'get-subclass.ts', rule: 'U2', code: `class P extends URLSearchParams {}; declare const p: P; export const q = p.get('title');` },
    // Audit F7: a key split across literals, a leading `?` in a string init, a key in another case, an array join.
    { name: 'concat-split.ts', rule: 'U1', code: `declare const x: string; export const r = fetch('/api?' + 'q=' + x);` },
    { name: 'init-string-leading-q.ts', rule: 'U1', code: `declare const t: string; export const u = new URLSearchParams('?q=' + t);` },
    { name: 'set-upper.ts', rule: 'U1', code: `declare const n: string; const p = new URLSearchParams(); p.set('Q', n); export default p;` },
    { name: 'init-upper.ts', rule: 'U1', code: `declare const n: string; export const u = new URLSearchParams({ Name: n });` },
    { name: 'get-upper.ts', rule: 'U2', code: `declare const searchParams: URLSearchParams; export const q = searchParams.get('Person');` },
    // Audit G3: a const-held literal prefix.
    { name: 'concat-const-prefix.ts', rule: 'U1', code: `declare const x: string; const base = '/api/v1/search?'; export const r = fetch(base + 'q=' + x);` },
    { name: 'join.ts', rule: 'U1', code: `declare const x: string; export const r = fetch(['/api?', 'q=', x].join(''));` },
  ];
  const NEGATIVE: Array<{ name: string; code: string }> = [
    { name: 'ok-id-params.ts', code: `export const r = fetch('/api/v1/deals?status=open&limit=5');` },
    { name: 'ok-external.ts', code: 'export const r = `https://images.unsplash.com/photo-1?w=400&q=80`;' },
    { name: 'ok-external-literal.ts', code: `export const r = 'https://images.unsplash.com/photo-1?q=80';` },
    { name: 'ok-formdata.ts', code: `declare const f: File; const d = new FormData(); d.append('name', f); d.set('file', f); export default d;` },
    { name: 'ok-headers.ts', code: `const h = new Headers(); h.append('name', 'x'); export const v = h.get('name');` },
    { name: 'ok-has.ts', code: `declare const searchParams: URLSearchParams; export const refused = searchParams.has('query');` },
    { name: 'ok-get-id.ts', code: `declare const searchParams: URLSearchParams; export const a = searchParams.get('tab'), b = searchParams.get('executionId');` },
    { name: 'ok-init-id.ts', code: `declare const executionId: string, artifact: number; export const u = new URLSearchParams({ executionId, artifact: String(artifact) });` },
    { name: 'ok-fragment.ts', code: 'declare const id: string, t: string; export const r = `/projects/${id}/chat#q=${encodeURIComponent(t)}`;' },
    { name: 'ok-map-get.ts', code: `const m = new Map<string, string>(); export const v = m.get('q');` },
    // Audit G6: a query-looking key inside a fragment never leaves the browser.
    { name: 'ok-fragment-query.ts', code: `declare const x: string; export const r = '/projects/p1/chat#thread?q=' + x;` },
    { name: 'ok-gap.ts', code: `declare const x: string; export const r = fetch('/api/v1/x?a=' + x + 'q=');` },
    { name: 'ok-join-ids.ts', code: `declare const id: string; export const r = fetch(['/api/v1/deals', id].join('/') + '?limit=5');` },
  ];

  const program = probeProgram({
    ...Object.fromEntries(POSITIVE.map((p) => [p.name, p.code])),
    ...Object.fromEntries(NEGATIVE.map((p) => [p.name, p.code])),
  });

  it.each(POSITIVE)('reports $name as $rule', ({ name, rule }) => {
    const hits = probeHits(program, name);
    expect(hits.map((h) => h.rule), JSON.stringify(hits)).toContain(rule);
  });

  it.each(NEGATIVE)('does not report $name', ({ name }) => {
    expect(probeHits(program, name)).toEqual([]);
  });
});

describe('content egress guard: detector self-tests (L1, L2)', () => {
  const PRELUDE = `declare function errorCodeOf(e: unknown): string;
declare function safeLogId(v: string | null | undefined): string;
declare function logSeamAuth(outcome: 'accept' | 'deny', event: Record<string, unknown>): void;
declare function logProcessorEvent(event: Record<string, unknown>): void;
declare function logServerEvent(line: Record<string, unknown>): void;
declare function errorClassOf(e: unknown): string;
declare const request: Request;
declare const res: Response;
declare const err: unknown;
declare const error: { code?: string; message: string };
declare const dealId: string;
`;
  const src = (body: string) => `${PRELUDE}${body}`;

  const POSITIVE: Array<{ name: string; rule: EgressRule; code: string }> = [
    { name: 'l1-bare.ts', rule: 'L1', code: src(`console.error('x', err);`) },
    { name: 'l1-e.ts', rule: 'L1', code: src(`try { dealId.trim(); } catch (e) { console.warn('x', e); }`) },
    { name: 'l1-cause.ts', rule: 'L1', code: src(`declare const cause: unknown; console.error('x', cause);`) },
    { name: 'l1-suffix.ts', rule: 'L1', code: src(`declare const dbError: unknown; console.error('x', dbError);`) },
    { name: 'l1-message.ts', rule: 'L1', code: src(`console.error(error.message);`) },
    { name: 'l1-message-template.ts', rule: 'L1', code: src('console.error(`failed: ${error.message}`);') },
    { name: 'l1-stack.ts', rule: 'L1', code: src(`console.error('x', (err as Error).stack);`) },
    { name: 'l1-details.ts', rule: 'L1', code: src(`declare const pg: { details: string; hint: string }; console.error('x', pg.details); console.error('y', pg.hint);`) },
    { name: 'l1-object.ts', rule: 'L1', code: src(`console.error('x', { dealId, err });`) },
    { name: 'l1-object-member.ts', rule: 'L1', code: src(`console.error('x', { dealId, detail: error.message });`) },
    { name: 'l1-object-spread.ts', rule: 'L1', code: src(`console.error('x', { dealId, ...{ err } });`) },
    { name: 'l1-conditional.ts', rule: 'L1', code: src(`console.error(err instanceof Error ? err.message : err);`) },
    { name: 'l1-string.ts', rule: 'L1', code: src(`console.error(String(err));`) },
    { name: 'l1-stringify.ts', rule: 'L1', code: src(`console.error(JSON.stringify({ a: err }));`) },
    { name: 'l1-text.ts', rule: 'L1', code: src(`async function f() { console.error(await res.text()); }`) },
    { name: 'l1-json.ts', rule: 'L1', code: src(`async function f() { console.error('x', await res.json()); }`) },
    { name: 'l1-text-bound.ts', rule: 'L1', code: src(`async function f() { const body = await res.text(); console.error('x', body); }`) },
    { name: 'l1-text-caught.ts', rule: 'L1', code: src(`async function f() { const detail = await res.text().catch(() => ''); console.error('x', res.status, detail.slice(0, 240)); }`) },
    { name: 'l1-text-sliced.ts', rule: 'L1', code: src(`async function f() { console.error('x', (await res.text()).slice(0, 10)); }`) },
    { name: 'l1-message-sliced.ts', rule: 'L1', code: src(`console.error('x', error.message.slice(0, 10));`) },
    { name: 'l1-concat.ts', rule: 'L1', code: src(`console.error('failed: ' + error.message);`) },
    // Audit F2: one hop, destructuring and shorthand.
    { name: 'l1-one-hop-message.ts', rule: 'L1', code: src(`const m = error.message; console.error(m); export {};`) },
    { name: 'l1-destructured-message.ts', rule: 'L1', code: src(`const { message } = error; console.error(message); export {};`) },
    { name: 'l1-shorthand-message.ts', rule: 'L1', code: src(`const { code, message } = error; console.error('x', { code, message }); export {};`) },
    { name: 'l1-shorthand-bound.ts', rule: 'L1', code: src(`const m = error.message; console.error('x', { m }); export {};`) },
    { name: 'l1-shorthand-details.ts', rule: 'L1', code: src(`declare const details: string; console.error('x', { details }); export {};`) },
    // Audit F1: the OperatorCopyError branch is exempt, the other branch is still judged.
    { name: 'l1-operator-copy-else.ts', rule: 'L1', code: src(`import { OperatorCopyError } from '@/lib/errors/upstream'; console.error(err instanceof OperatorCopyError ? err.message : err);`) },
    // Audit G1: only the OperatorCopyError from src/lib/errors/upstream.ts is exempt, not a local class of that name.
    { name: 'l1-operator-copy-local-class.ts', rule: 'L1', code: src(`class OperatorCopyError extends Error {} console.error(err instanceof OperatorCopyError ? err.message : 'x'); export {};`) },
    { name: 'l1-operator-copy-other-value.ts', rule: 'L1', code: src(`import { OperatorCopyError } from '@/lib/errors/upstream'; console.error(err instanceof OperatorCopyError ? error.message : 'x');`) },
    // #474: L1 judges a log[A-Z]* helper as it judges console.*.
    { name: 'l1-helper-err.ts', rule: 'L1', code: src(`logServerEvent({ evt: 'request_error', err });`) },
    { name: 'l1-helper-message.ts', rule: 'L1', code: src(`logServerEvent({ evt: 'request_error', errorClass: error.message });`) },
    { name: 'l1-helper-bare.ts', rule: 'L1', code: src(`logProcessorEvent(err as Record<string, unknown>);`) },
    // L2: the headers.get shape that reached logSeamAuth, and the other untrusted sources.
    {
      name: 'l2-seam-auth.ts',
      rule: 'L2',
      code: src(`const agentName = request.headers.get('x-conductia-agent-name')?.trim() ?? '';
logSeamAuth('deny', { agentName });`),
    },
    {
      name: 'l2-seam-auth-field.ts',
      rule: 'L2',
      code: src(`const runId = request.headers.get('x-conductia-run-id')?.trim() ?? '';
logSeamAuth('deny', { reason: 'authentication', runId, lead: null });`),
    },
    { name: 'l2-direct.ts', rule: 'L2', code: src(`console.log(request.headers.get('x-agent'));`) },
    { name: 'l2-template.ts', rule: 'L2', code: src('const h = request.headers.get("x"); console.warn(`[seam] ${h}`);') },
    { name: 'l2-stringify.ts', rule: 'L2', code: src(`const h = request.headers.get('x'); console.warn(JSON.stringify({ outcome: 'deny', h }));`) },
    { name: 'l2-helper-template.ts', rule: 'L2', code: src('const h = request.headers.get("x"); logProcessorEvent({ line: `${h}` });') },
    { name: 'l2-search-params.ts', rule: 'L2', code: src(`declare const searchParams: URLSearchParams; const tab = searchParams.get('tab'); console.info('tab', tab);`) },
    { name: 'l2-next-url.ts', rule: 'L2', code: src(`const u = new URL(request.url); const s = u.searchParams.get('executionId'); logProcessorEvent({ s });`) },
    { name: 'l2-transitive.ts', rule: 'L2', code: src(`const raw = request.headers.get('x'); const label = raw ?? 'none'; console.warn('x', label);`) },
    // Audit F7: encoding a value does not make it safe to log.
    { name: 'l2-encoded.ts', rule: 'L2', code: src(`const h = request.headers.get('x') ?? ''; console.warn('x', encodeURIComponent(h));`) },
    {
      name: 'l2-params-destructured.ts',
      rule: 'L2',
      code: src(`export async function GET(_r: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  console.warn('x', { leadId });
}`),
    },
    {
      name: 'l2-params-member.ts',
      rule: 'L2',
      code: src(`export async function GET(_r: Request, ctx: { params: { leadId: string } }) {
  console.warn('x', ctx.params.leadId);
}`),
    },
  ];
  const NEGATIVE: Array<{ name: string; code: string }> = [
    { name: 'ok-code.ts', code: src(`console.error('x', { dealId, code: errorCodeOf(err) });`) },
    { name: 'ok-code-only.ts', code: src(`console.error('x', errorCodeOf(err));`) },
    { name: 'ok-member-code.ts', code: src(`console.error('x', error.code); console.error('y', { code: error.code });`) },
    // A member merely named `error` is not judged: DeliveryResult.error is already a code. Destructured
    // `{ error }` from a Supabase call is an identifier, and is judged.
    { name: 'ok-member-named-error.ts', code: src(`declare const r: { error: string }; console.error('x', { code: r.error });`) },
    { name: 'ok-status.ts', code: src(`console.log('status', res.status, res.ok);`) },
    { name: 'ok-literal-keys.ts', code: src(`console.error('x', { err: 'literal', error: 500 });`) },
    { name: 'ok-plain-log.ts', code: src(`declare const signal: string; console.log('worker stopping', signal);`) },
    { name: 'ok-dealid.ts', code: src(`console.error('x', { dealId, stepId: 's1' });`) },
    { name: 'ok-errors-plural.ts', code: src(`declare const errors: string[]; console.error('x', errors.length);`) },
    { name: 'ok-not-console.ts', code: src(`const logger = { error: (...a: unknown[]) => a }; logger.error('x', err);`) },
    {
      name: 'ok-operator-copy.ts',
      code: src(`import { OperatorCopyError } from '@/lib/errors/upstream'; console.error(err instanceof OperatorCopyError ? err.message : \`x failed (\${errorCodeOf(err)})\`);`),
    },
    { name: 'ok-destructured-code.ts', code: src(`const { code } = error; console.error('x', code); export {};`) },
    // Audit G7: a shorthand named message that provably holds fixed copy.
    { name: 'ok-shorthand-literal.ts', code: src(`const message = 'Profile lookup failed'; console.error({ message }); export {};`) },
    { name: 'ok-bound-literal.ts', code: src(`const message = 'Profile lookup failed'; console.error(message); export {};`) },
    { name: 'ok-bound-code.ts', code: src(`const code = errorCodeOf(err); console.error('x', { code }); export {};`) },
    // L2 negatives
    {
      name: 'ok-safe-log-id.ts',
      code: src(`const agentName = request.headers.get('x-conductia-agent-name')?.trim() ?? '';
logSeamAuth('deny', { agentName: safeLogId(agentName) });`),
    },
    { name: 'ok-safe-log-id-direct.ts', code: src(`console.log(safeLogId(request.headers.get('x')));`) },
    { name: 'ok-header-not-logged.ts', code: src(`const h = request.headers.get('x'); if (h) console.log('has header');`) },
    { name: 'ok-header-length.ts', code: src(`const h = request.headers.get('x') ?? ''; logProcessorEvent({ n: h.length });`) },
    { name: 'ok-map-get.ts', code: src(`const m = new Map<string, string>(); const v = m.get('k'); console.log(v);`) },
    { name: 'ok-resolved-id.ts', code: src(`declare const deal: { id: string }; console.warn('x', { dealId: deal.id });`) },
    {
      name: 'ok-params-safe.ts',
      code: src(`export async function GET(_r: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  console.warn('x', { leadId: safeLogId(leadId) });
}`),
    },
    { name: 'ok-not-log-helper.ts', code: src(`declare function logout(v: string | null): void; logout(request.headers.get('x'));`) },
    { name: 'ok-helper-error-class.ts', code: src(`logServerEvent({ evt: 'request_error', errorClass: errorClassOf(err), status: 500 });`) },
    { name: 'ok-not-log-helper-err.ts', code: src(`declare function logout(v: unknown): void; logout(err);`) },
  ];

  const program = probeProgram({
    ...Object.fromEntries(POSITIVE.map((p) => [p.name, p.code])),
    ...Object.fromEntries(NEGATIVE.map((p) => [p.name, p.code])),
  });

  it.each(POSITIVE)('reports $name as $rule', ({ name, rule }) => {
    const hits = probeLogHits(program, name);
    expect(hits.map((h) => h.rule), JSON.stringify(hits)).toContain(rule);
  });

  it.each(NEGATIVE)('does not report $name', ({ name }) => {
    expect(probeLogHits(program, name)).toEqual([]);
  });

  it("recognises a 'use client' prologue and nothing else", () => {
    const parse = (text: string) => ts.createSourceFile('x.tsx', text, ts.ScriptTarget.ESNext, true);
    expect(hasUseClientPrologue(parse(`'use client';\nexport const a = 1;`))).toBe(true);
    expect(hasUseClientPrologue(parse(`// c\n"use client"\nimport x from 'y';`))).toBe(true);
    expect(hasUseClientPrologue(parse(`import x from 'y';\n'use client';`))).toBe(false);
    expect(hasUseClientPrologue(parse(`export const a = 'use client';`))).toBe(false);
  });
});

describe('content egress guard: detector self-tests (T1, T2, R1)', () => {
  const PRELUDE = `declare function jsonError(message: string, status?: number): Response;
declare function conductiaError(status: number, message: string): Response;
declare function resendFailure(op: string, detail: string): Error;
declare function dbFailure(step: string, err: { code?: string } | null): Error;
declare function errorCodeOf(e: unknown): string;
declare class GraphHttpError extends Error { constructor(status: number, code: string | null, requestId: string | null); }
declare const NextResponse: { json(body: unknown, init?: { status?: number }): Response };
declare const res: Response;
declare const err: Error;
declare const error: { code?: string; message: string; details?: string };
declare const dealId: string;
declare const code: string;
declare const step: string;
declare const q: Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
`;
  const src = (body: string) => `${PRELUDE}${body}`;

  const POSITIVE: Array<{ name: string; rule: EgressRule; code: string }> = [
    { name: 't1-template-message.ts', rule: 'T1', code: src('export function f() { throw new Error(`lookup failed: ${error.message}`); }') },
    { name: 't1-bare-message.ts', rule: 'T1', code: src(`export function f() { throw new Error(error.message); }`) },
    { name: 't1-optional-message.ts', rule: 'T1', code: src(`export function f() { throw new Error(error?.message ?? 'lookup failed'); }`) },
    { name: 't1-concat.ts', rule: 'T1', code: src(`export function f() { throw new Error('failed: ' + error.message); }`) },
    { name: 't1-details.ts', rule: 'T1', code: src('export function f() { throw new Error(`x ${error.details}`); }') },
    { name: 't1-sliced.ts', rule: 'T1', code: src('export function f() { throw new Error(`x ${err.message.slice(0, 80)}`); }') },
    { name: 't1-factory-body.ts', rule: 'T1', code: src('export async function f() { const body = await res.text(); throw resendFailure("send", `body ${body}`); }') },
    { name: 't1-inline-text.ts', rule: 'T1', code: src('export async function f() { throw new Error(`x ${await res.text()}`); }') },
    { name: 't1-checkpoint.ts', rule: 'T1', code: src('declare const checkpoint: string; export function f() { throw new Error(`unreadable ${checkpoint}`); }') },
    { name: 't1-internet-message-id.ts', rule: 'T1', code: src('declare const item: { internetMessageId: string }; export function f() { throw new Error(`no item ${item.internetMessageId}`); }') },
    { name: 't1-folder-name.ts', rule: 'T1', code: src('declare const folderName: string; export function f() { throw new Error(`conflict ${folderName}`); }') },
    { name: 't1-file-name.ts', rule: 'T1', code: src('declare const file: { fileName: string }; export function f() { throw new Error(`upload ${file.fileName}`); }') },
    { name: 't1-request-id-header.ts', rule: 'T1', code: src(`export function f() { throw new GraphHttpError(500, null, res.headers.get('request-id')); }`) },
    { name: 't1-string-of-error.ts', rule: 'T1', code: src('export function f() { throw new Error(`unreachable: ${String(err)}`); }') },
    { name: 't1-one-hop.ts', rule: 'T1', code: src(`export function f() { try { dealId.trim(); } catch (e) { const message = e instanceof Error ? e.message : 'Failed'; throw new Error(message); } }`) },
    // Audit G1: OperatorCopyError's message must be fixed copy.
    { name: 't1-operator-copy-label.ts', rule: 'T1', code: src(`import { OperatorCopyError } from '@/lib/errors/upstream'; declare const label: string; export function f() { throw new OperatorCopyError(label); }`) },
    { name: 't1-operator-copy-local-label.ts', rule: 'T1', code: src(`class OperatorCopyError extends Error {} declare const label: string; export const e = new OperatorCopyError(\`bad: \${label}\`);`) },
    { name: 't2-destructured.ts', rule: 'T2', code: src(`export async function f() { const { error } = await q; if (error) throw error; }`) },
    { name: 't2-renamed.ts', rule: 'T2', code: src(`export async function f() { const { data, error: dealError } = await q; if (dealError) throw dealError; return data; }`) },
    { name: 'r1-direct.ts', rule: 'R1', code: src(`export async function f() { return jsonError(await res.text(), 502); }`) },
    { name: 'r1-bound.ts', rule: 'R1', code: src(`export async function f() { const body = await res.text(); return jsonError(body, 502); }`) },
    { name: 'r1-conductia.ts', rule: 'R1', code: src(`export async function f() { const detail = await res.text().catch(() => ''); return conductiaError(502, detail); }`) },
    { name: 'r1-next-response.ts', rule: 'R1', code: src(`export async function f() { const body = await res.text(); return NextResponse.json({ error: body }, { status: 502 }); }`) },
    { name: 'r1-template.ts', rule: 'R1', code: src('export async function f() { const body = await res.text(); return jsonError(`upstream: ${body}`, 502); }') },
    { name: 'r1-new-response.ts', rule: 'R1', code: src(`export async function f() { const body = await res.text(); return new Response(body, { status: 502 }); }`) },
    { name: 'r1-new-response-direct.ts', rule: 'R1', code: src(`export async function f() { return new Response(await res.text()); }`) },
  ];
  const NEGATIVE: Array<{ name: string; code: string }> = [
    { name: 'ok-fixed.ts', code: src(`export function f() { throw new Error('Dataroom storage failed'); }`) },
    { name: 'ok-code.ts', code: src('export function f() { throw new Error(`lookup failed (${code})`); }') },
    { name: 'ok-step-code.ts', code: src('export function f() { throw new Error(`${step} failed (${errorCodeOf(err)})`); }') },
    { name: 'ok-db-failure.ts', code: src(`export function f() { throw dbFailure('lookup', error); }`) },
    { name: 'ok-id.ts', code: src('export function f() { throw new Error(`no deal ${dealId}`); }') },
    { name: 'ok-rethrow-catch.ts', code: src(`export function f() { try { dealId.trim(); } catch (e) { throw e; } }`) },
    { name: 'ok-rethrow-bare.ts', code: src(`export function f() { throw err; }`) },
    { name: 'ok-cause.ts', code: src(`export function f() { throw new Error('failed', { cause: err }); }`) },
    { name: 'ok-message-bound-to-literal.ts', code: src(`export function f() { const message = 'Failed to resolve deal'; throw new Error(message); }`) },
    { name: 'ok-header-not-passed.ts', code: src(`export function f() { const id = res.headers.get('request-id'); if (id) return id; throw new Error('no id'); }`) },
    { name: 'ok-destructured-not-awaited.ts', code: src(`declare const sync: { error: Error | null }; export function f() { const { error: failure } = sync; if (failure) throw failure; }`) },
    { name: 'ok-destructured-other.ts', code: src(`declare const r: Promise<{ failure: Error | null }>; export async function f() { const { failure } = await r; if (failure) throw failure; }`) },
    { name: 'ok-message-is-a-code.ts', code: src(`declare const reason: string; export function f() { throw new Error(\`stopped: \${reason}\`); }`) },
    { name: 'ok-response-fixed.ts', code: src(`export function f() { return jsonError('Storage is unavailable, try again', 502); }`) },
    { name: 'ok-response-json-body.ts', code: src(`export async function f() { const body = await res.json(); return NextResponse.json(body); }`) },
    { name: 'ok-response-stream.ts', code: src(`export function f() { return new Response(res.body, { status: res.status }); }`) },
    { name: 'ok-response-status-only.ts', code: src('export async function f() { await res.text(); return jsonError(`Ignatious ${res.status}`, 502); }') },
    {
      name: 'ok-operator-copy-fixed.ts',
      code: src(`import { OperatorCopyError } from '@/lib/errors/upstream'; const VARIABLE = 'RESEND_API_KEY'; export function f() { throw new OperatorCopyError(\`\${VARIABLE} is not set (\${3})\`); } export const g = () => new OperatorCopyError('Mailbox connection expired');`),
    },
    { name: 'ok-response-error-message.ts', code: src(`export function f() { return jsonError(error.message, 500); }`) },
  ];

  const program = probeProgram({
    ...Object.fromEntries(POSITIVE.map((p) => [p.name, p.code])),
    ...Object.fromEntries(NEGATIVE.map((p) => [p.name, p.code])),
  });

  it.each(POSITIVE)('reports $name as $rule', ({ name, rule }) => {
    const hits = probeThrowHits(program, name);
    expect(hits.map((h) => h.rule), JSON.stringify(hits)).toContain(rule);
  });

  it.each(NEGATIVE)('does not report $name', ({ name }) => {
    expect(probeThrowHits(program, name)).toEqual([]);
  });

  it('reports two identical sinks on one line as two sites (audit G2)', () => {
    const twin = probeProgram({
      'r1-twin.ts': src(`export async function f(c: boolean) { const body = await res.text(); return c ? jsonError(body, 502) : jsonError(body, 502); }`),
    });
    const hits = probeThrowHits(twin, 'r1-twin.ts').filter((h) => h.rule === 'R1');
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => `${h.line} ${h.what}`)).size).toBe(1);
  });
});

describe('content egress guard: allowlist anchors', () => {
  const FILE = 'worker/x.ts';
  const entry: Allow = { file: FILE, rule: 'L1', match: 'console.error logs .message', reason: 'probe entry for the anchor self-test' };
  const hit = (line: number, what: string): EgressHit => ({ file: FILE, line, rule: 'L1', what });

  it('exempts the anchored site', () => {
    expect(applyAllowlist([hit(10, 'console.error logs .message')], [entry])).toEqual({ offenders: [], problems: [] });
  });

  it('fails a second L1 site in an allowlisted file, whatever it logs', () => {
    const other = applyAllowlist([hit(10, 'console.error logs .message'), hit(20, "console.error logs error value 'err'")], [entry]);
    expect(other.offenders.map((h) => h.line)).toEqual([20]);
    const same = applyAllowlist([hit(10, 'console.error logs .message'), hit(20, 'console.error logs .message')], [entry]);
    expect(same.problems).toEqual([`allowlist entry anchors 2 sites, not one: ${FILE} L1 'console.error logs .message'`]);
  });

  it('fails an entry without an anchor, and a stale one', () => {
    const bare = { ...entry, match: '' };
    expect(applyAllowlist([hit(10, 'console.error logs .message')], [bare])).toEqual({
      offenders: [hit(10, 'console.error logs .message')],
      problems: [`allowlist entry without a match anchor: ${FILE} L1 ''`],
    });
    expect(applyAllowlist([], [entry]).problems).toEqual([`stale allowlist entry: ${FILE} L1 'console.error logs .message'`]);
  });

  it('passes the OperatorCopyError catch in worker/extract.ts and fails a console.error(err.message) planted beside it', () => {
    const real = readFileSync(join(ROOT, 'worker/extract.ts'), 'utf8');
    const CATCH = 'console.error(err instanceof OperatorCopyError ? err.message : `extract failed (${errorCodeOf(err)})`);';
    expect(real).toContain(CATCH);
    const l1 = (code: string) => {
      const program = probeProgram({ 'worker/extract.ts': code });
      return applyAllowlist(probeLogHits(program, 'worker/extract.ts'), ALLOW).offenders.filter((h) => h.rule === 'L1');
    };
    expect(l1(real)).toEqual([]);
    expect(l1(real.replace(CATCH, `${CATCH}\n    console.error(err.message);`)).map((h) => h.what)).toEqual(['console.error logs .message']);
  });
});

describe('content egress guard: production (U1, U2, L1, L2)', () => {
  beforeAll(() => {
    fenceProgram();
  }, SLOW);

  let cached: EgressHit[] | undefined;
  const productionHits = (): EgressHit[] => {
    if (cached) return cached;
    const program = fenceProgram();
    const hits: EgressHit[] = [];
    for (const file of productionFiles()) {
      const sf = program.getSourceFile(join(ROOT, file));
      if (!sf) throw new Error(`${file} is not in the fence program`);
      hits.push(...urlRuleHits(program, sf, file));
      if (isLogRuleFile(file) && !hasUseClientPrologue(sf)) hits.push(...logRuleHits(program, sf, file));
      if (isLogRuleFile(file) && !hasUseClientPrologue(sf)) hits.push(...throwRuleHits(program, sf, file));
    }
    cached = hits;
    return hits;
  };
  const offendersOf = (rules: EgressRule[]) =>
    applyAllowlist(productionHits(), ALLOW)
      .offenders.filter((h) => rules.includes(h.rule))
      .map((h) => `${h.file}:${h.line} ${h.rule} ${h.what}`);

  it('has no free text in an app URL or a read of one from the query string', () => {
    const offenders = offendersOf(['U1', 'U2']);
    expect(offenders, `free text in a URL (use a POST body, a fragment, or an opaque id):\n${offenders.join('\n')}`).toEqual([]);
  }, SLOW);

  it('logs codes and ids only: no error object, message or provider body, no unsanitised header, query or route value', () => {
    const offenders = offendersOf(['L1', 'L2']);
    expect(
      offenders,
      `server log carries content (log errorCodeOf(err) and ids; wrap a header, query or route value in safeLogId):\n${offenders.join('\n')}`,
    ).toEqual([]);
  }, SLOW);

  it('throws carry codes and ids: no database message, provider body, header, checkpoint or message id', () => {
    const offenders = offendersOf(['T1']);
    expect(
      offenders,
      `thrown message carries content (throw \`<step> failed (\${code})\`, or dbFailure / UpstreamHttpError):\n${offenders.join('\n')}`,
    ).toEqual([]);
  }, SLOW);

  it('does not rethrow a raw PostgREST error', () => {
    const offenders = offendersOf(['T2']);
    expect(offenders, `raw PostgREST error rethrown (throw dbFailure(step, error)):\n${offenders.join('\n')}`).toEqual([]);
  }, SLOW);

  it('does not pass a provider body through to a response', () => {
    const offenders = offendersOf(['R1']);
    expect(offenders, `provider body in a response (answer with fixed copy and a code):\n${offenders.join('\n')}`).toEqual([]);
  }, SLOW);

  it('lists every allowlisted exception with a reason and an anchor that matches exactly one site', () => {
    for (const entry of ALLOW) {
      expect(entry.reason.length, `${entry.file} ${entry.rule}`).toBeGreaterThanOrEqual(20);
    }
    expect(applyAllowlist(productionHits(), ALLOW).problems).toEqual([]);
  }, SLOW);
});
